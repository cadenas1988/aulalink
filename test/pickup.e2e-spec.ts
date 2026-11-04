import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { AuthGuard } from '../src/auth/auth.guard';
import { RolesGuard } from '../src/auth/roles.guard';
import { N8nSignatureGuard } from '../src/integrations/n8n-signature.guard';
import { signWebhook } from '../src/integrations/security';
import { PickupController } from '../src/pickup/pickup.controller';
import { PickupService } from '../src/pickup/pickup.service';

describe('Pickup API (e2e)', () => {
  const jwtSecret = 'test-jwt-secret-at-least-32-characters';
  const callbackSecret = 'test-callback-secret-at-least-32-characters';
  const actorId = randomUUID();
  const requestId = randomUUID();
  const pickup = {
    create: jest.fn(),
    get: jest.fn(),
    cancel: jest.fn(),
    recordN8nEvent: jest.fn(),
  };
  let app: INestApplication;

  function token(roles: string[]): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
      'base64url',
    );
    const payload = Buffer.from(
      JSON.stringify({
        sub: actorId,
        roles,
        iss: 'https://identity.test/',
        aud: 'aulalink-test',
        exp: Math.floor(Date.now() / 1000) + 60,
      }),
    ).toString('base64url');
    const signature = createHmac('sha256', jwtSecret)
      .update(`${header}.${payload}`)
      .digest('base64url');
    return `${header}.${payload}.${signature}`;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PickupController],
      providers: [
        AuthGuard,
        RolesGuard,
        N8nSignatureGuard,
        { provide: PickupService, useValue: pickup },
        {
          provide: ConfigService,
          useValue: {
            get: (name: string) =>
              ({
                N8N_CALLBACK_SECRET: callbackSecret,
                WEBHOOK_MAX_AGE_SECONDS: '300',
              })[name],
            getOrThrow: (name: string) =>
              ({
                JWT_SECRET: jwtSecret,
                JWT_ISSUER: 'https://identity.test/',
                JWT_AUDIENCE: 'aulalink-test',
              })[name],
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requires an authenticated staff role to create a request', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/pickup-requests')
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/v1/pickup-requests')
      .set('Authorization', `Bearer ${token(['administrator'])}`)
      .expect(403);

    expect(pickup.create).not.toHaveBeenCalled();
  });

  it('accepts a valid photo and approved creation payload', async () => {
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l7sAAAAASUVORK5CYII=',
      'base64',
    );
    pickup.create.mockResolvedValue({
      id: requestId,
      studentId: randomUUID(),
      pickupPerson: {
        fullName: 'Familiar de prueba',
        relationshipToStudent: 'Abuela',
      },
      status: 'pending',
      createdAt: new Date().toISOString(),
      escalationDueAt: null,
      decidedAt: null,
      stateVersion: 1,
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/pickup-requests')
      .set('Authorization', `Bearer ${token(['security'])}`)
      .set('Idempotency-Key', 'test-idempotency-key-001')
      .field(
        'request',
        JSON.stringify({
          studentId: randomUUID(),
          pickupPerson: {
            fullName: 'Familiar de prueba',
            relationshipToStudent: 'Abuela',
          },
        }),
      )
      .attach('photo', image, {
        filename: 'person.png',
        contentType: 'image/png',
      })
      .expect(201);

    expect(response.body.status).toBe('pending');
    expect(pickup.create).toHaveBeenCalledWith(
      expect.objectContaining({
        pickupPerson: expect.objectContaining({ fullName: 'Familiar de prueba' }),
      }),
      actorId,
      'test-idempotency-key-001',
      expect.objectContaining({ mimeType: 'image/png' }),
    );
  });

  it('lets authorized staff cancel a pending request', async () => {
    pickup.cancel.mockResolvedValue({
      id: requestId,
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
      stateVersion: 2,
    });

    await request(app.getHttpServer())
      .post(`/api/v1/pickup-requests/${requestId}/cancel`)
      .set('Authorization', `Bearer ${token(['security'])}`)
      .expect(200)
      .expect(({ body }) => expect(body.status).toBe('cancelled'));

    expect(pickup.cancel).toHaveBeenCalledWith(requestId, actorId);
  });

  it('rejects unsigned callbacks and accepts a correctly signed event', async () => {
    const event = {
      eventId: randomUUID(),
      eventType: 'pickup.escalation.completed',
      schemaVersion: 1,
      requestId,
      occurredAt: new Date().toISOString(),
      channel: 'email',
      result: 'accepted',
    };
    const rawBody = JSON.stringify(event);

    await request(app.getHttpServer())
      .post('/api/v1/integrations/n8n/pickup-events')
      .set('content-type', 'application/json')
      .send(rawBody)
      .expect(401);

    const timestamp = Math.floor(Date.now() / 1000).toString();
    pickup.recordN8nEvent.mockResolvedValue({
      eventId: event.eventId,
      disposition: 'applied',
    });
    await request(app.getHttpServer())
      .post('/api/v1/integrations/n8n/pickup-events')
      .set('content-type', 'application/json')
      .set('X-Webhook-Timestamp', timestamp)
      .set('X-Webhook-Signature', signWebhook(Buffer.from(rawBody), timestamp, callbackSecret))
      .set('Idempotency-Key', event.eventId)
      .send(rawBody)
      .expect(202);

    expect(pickup.recordN8nEvent).toHaveBeenCalledWith(event, event.eventId);
  });
});
