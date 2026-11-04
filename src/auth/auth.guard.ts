import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Request } from 'express';

export interface AuthenticatedRequest extends Request {
  user?: { sub: string; roles: string[] };
}

interface JwtClaims {
  sub?: unknown;
  roles?: unknown;
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly secret: string;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(private readonly config: ConfigService) {
    this.secret = config.getOrThrow<string>('JWT_SECRET');
    this.issuer = config.getOrThrow<string>('JWT_ISSUER');
    this.audience = config.getOrThrow<string>('JWT_AUDIENCE');
    if (Buffer.byteLength(this.secret, 'utf8') < 32) {
      throw new Error('JWT_SECRET debe contener al menos 32 bytes.');
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const [scheme, token] = (request.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Se requiere autenticación.');
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new UnauthorizedException('Token inválido.');
    }
    const [encodedHeader, encodedPayload, signature] = parts;

    try {
      const header = JSON.parse(
        Buffer.from(encodedHeader, 'base64url').toString('utf8'),
      ) as { alg?: string };
      if (header.alg !== 'HS256') {
        throw new UnauthorizedException('Algoritmo de token no permitido.');
      }

      const expected = createHmac('sha256', this.secret)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest();
      const actual = Buffer.from(signature, 'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new UnauthorizedException('Firma de token inválida.');
      }

      const claims = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf8'),
      ) as JwtClaims;
      const now = Math.floor(Date.now() / 1000);
      if (
        typeof claims.sub !== 'string' ||
        !UUID_PATTERN.test(claims.sub) ||
        typeof claims.exp !== 'number' ||
        claims.exp <= now ||
        (typeof claims.nbf === 'number' && claims.nbf > now) ||
        claims.iss !== this.issuer ||
        claims.aud !== this.audience ||
        !Array.isArray(claims.roles) ||
        !claims.roles.every((role) => typeof role === 'string')
      ) {
        throw new UnauthorizedException('Claims de token inválidos o expirados.');
      }

      request.user = { sub: claims.sub, roles: claims.roles };
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Token inválido.');
    }
  }
}
