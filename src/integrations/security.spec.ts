import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { signWebhook, verifyWebhookSignature } from './security';

describe('webhook signatures', () => {
  const secret = 'a-test-secret-long-enough-for-hmac';
  const config = {
    get: (name: string) =>
      name === 'N8N_CALLBACK_SECRET'
        ? secret
        : name === 'WEBHOOK_MAX_AGE_SECONDS'
          ? '300'
          : undefined,
  } as unknown as ConfigService;

  it('accepts a valid signature over the exact raw body and timestamp', () => {
    const body = Buffer.from('{"eventId":"test"}');
    const timestamp = '1762146000';
    const signature = signWebhook(body, timestamp, secret);

    expect(() =>
      verifyWebhookSignature(body, timestamp, signature, config, 1762146001),
    ).not.toThrow();
  });

  it('rejects a changed body', () => {
    const timestamp = '1762146000';
    const signature = signWebhook(
      Buffer.from('{"eventId":"test"}'),
      timestamp,
      secret,
    );

    expect(() =>
      verifyWebhookSignature(
        Buffer.from('{"eventId":"changed"}'),
        timestamp,
        signature,
        config,
        1762146001,
      ),
    ).toThrow(UnauthorizedException);
  });

  it('rejects stale timestamps to prevent replay', () => {
    const body = Buffer.from('{"eventId":"test"}');
    const timestamp = '1762146000';
    const signature = signWebhook(body, timestamp, secret);

    expect(() =>
      verifyWebhookSignature(body, timestamp, signature, config, 1762146400),
    ).toThrow(UnauthorizedException);
  });
});
