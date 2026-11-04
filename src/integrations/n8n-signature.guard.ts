import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { verifyWebhookSignature } from './security';

@Injectable()
export class N8nSignatureGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<
      Request & { rawBody?: Buffer }
    >();
    verifyWebhookSignature(
      request.rawBody,
      request.header('x-webhook-timestamp'),
      request.header('x-webhook-signature'),
      this.config,
    );
    return true;
  }
}
