import { ConfigService } from '@nestjs/config';
import {
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';

export function verifyWebhookSignature(
  rawBody: Buffer | undefined,
  timestamp: string | undefined,
  signature: string | undefined,
  config: ConfigService,
  nowSeconds = Math.floor(Date.now() / 1000),
): void {
  const secret = config.get<string>('N8N_CALLBACK_SECRET');
  if (!rawBody || !timestamp || !signature || !secret) {
    throw new UnauthorizedException('Firma de webhook ausente o inválida.');
  }
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('N8N_CALLBACK_SECRET debe tener al menos 32 bytes.');
  }

  const parsedTimestamp = Number(timestamp);
  const maxAge = Number(config.get<string>('WEBHOOK_MAX_AGE_SECONDS') ?? 300);
  if (
    !Number.isInteger(maxAge) ||
    maxAge < 1 ||
    !Number.isInteger(parsedTimestamp) ||
    Math.abs(nowSeconds - parsedTimestamp) > maxAge
  ) {
    throw new UnauthorizedException('Webhook fuera de la ventana permitida.');
  }

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}\n`)
    .update(rawBody)
    .digest();
  const supplied = signature.startsWith('v1=')
    ? Buffer.from(signature.slice(3), 'hex')
    : Buffer.alloc(0);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new UnauthorizedException('Firma de webhook inválida.');
  }
}

export function signWebhook(
  body: Buffer,
  timestamp: string,
  secret: string,
): string {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('El secreto HMAC debe tener al menos 32 bytes.');
  }
  return `v1=${createHmac('sha256', secret)
    .update(`${timestamp}\n`)
    .update(body)
    .digest('hex')}`;
}
