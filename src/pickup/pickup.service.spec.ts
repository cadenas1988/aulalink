import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { UnauthorizedException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { PhotoStorageService } from '../integrations/photo-storage.service';
import { SensitiveDataService } from '../integrations/sensitive-data.service';
import { PickupService } from './pickup.service';

describe('PickupService decision handling', () => {
  const encryptionKey = Buffer.alloc(32, 3).toString('base64');
  const lookupKey = Buffer.alloc(32, 4).toString('base64');
  const sensitiveData = new SensitiveDataService({
    getOrThrow: (name: string) =>
      name === 'PHONE_ENCRYPTION_KEY' ? encryptionKey : lookupKey,
  } as unknown as ConfigService);
  const phone = '+525500000000';
  const requestId = randomUUID();
  const contactId = randomUUID();
  const token = Buffer.alloc(32, 5).toString('base64url');
  const tokenHash = sensitiveData.hashDecisionToken(token);
  let currentStatus: 'pending' | 'authorized' | 'rejected' | 'cancelled';
  let insertedEventType: string | undefined;
  let clientQuery: jest.Mock;
  let service: PickupService;

  beforeEach(() => {
    currentStatus = 'pending';
    insertedEventType = undefined;
    clientQuery = jest.fn(async (sql: string) => {
      if (sql.includes("source = 'n8n' AND idempotency_key")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM pickup_requests WHERE id = $1 FOR UPDATE')) {
        return {
          rows: [
            {
              id: requestId,
              student_id: randomUUID(),
              pickup_person_name: 'Persona de prueba',
              relationship_to_student: 'Familiar',
              status: currentStatus,
              created_at: new Date('2026-11-02T10:00:00Z'),
              escalation_due_at: null,
              decided_at: null,
              state_version: currentStatus === 'pending' ? '1' : '2',
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("recipient_role = 'primary' FOR UPDATE")) {
        return {
          rows: [
            {
              contact_id: contactId,
              phone_lookup_hmac: sensitiveData.phoneLookup(phone),
              whatsapp_message_id: 'wamid.outbound',
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('SELECT decision_token_hash')) {
        return { rows: [{ decision_token_hash: tokenHash }], rowCount: 1 };
      }
      if (sql.includes('provider_message_id = $2')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith('INSERT INTO pickup_request_events')) {
        insertedEventType = String((clientQuery.mock.calls.at(-1)?.[1] as unknown[])[1]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SET status = 'cancelled'")) {
        currentStatus = 'cancelled';
        return {
          rows: [
            {
              id: requestId,
              student_id: randomUUID(),
              pickup_person_name: 'Persona de prueba',
              relationship_to_student: 'Familiar',
              status: 'cancelled',
              created_at: new Date('2026-11-02T10:00:00Z'),
              escalation_due_at: null,
              decided_at: null,
              cancelled_at: new Date('2026-11-02T10:05:00Z'),
              state_version: '2',
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.startsWith('UPDATE pickup_requests')) {
        currentStatus = String(
          (clientQuery.mock.calls.at(-1)?.[1] as unknown[])[1],
        ) as typeof currentStatus;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Consulta no esperada en prueba: ${sql}`);
    });

    const database = {
      transaction: (work: (client: PoolClient) => Promise<unknown>) =>
        work({ query: clientQuery } as unknown as PoolClient),
    } as unknown as DatabaseService;
    service = new PickupService(
      database,
      {} as PhotoStorageService,
      sensitiveData,
      { dispatchBatch: jest.fn() } as unknown as import('../integrations/outbox.service').OutboxService,
    );
  });

  it('aplica una decisión válida solo cuando teléfono, token y mensaje coinciden', async () => {
    const eventId = randomUUID();
    const result = await service.recordN8nEvent(
      {
        eventId,
        eventType: 'pickup.decision.received',
        schemaVersion: 1,
        requestId,
        occurredAt: '2026-11-02T10:01:00Z',
        decision: 'authorize',
        responderPhone: phone,
        incomingMessageId: 'wamid.inbound',
        contextMessageId: 'wamid.outbound',
        buttonId: `authorize.${token}`,
      },
      eventId,
    );

    expect(result.disposition).toBe('applied');
    expect(currentStatus).toBe('authorized');
    expect(insertedEventType).toBe('pickup.decision.applied');
  });

  it('audita una decisión contradictoria sin cambiar el estado terminal', async () => {
    currentStatus = 'authorized';
    const eventId = randomUUID();
    const result = await service.recordN8nEvent(
      {
        eventId,
        eventType: 'pickup.decision.received',
        schemaVersion: 1,
        requestId,
        occurredAt: '2026-11-02T10:02:00Z',
        decision: 'reject',
        responderPhone: phone,
        incomingMessageId: 'wamid.second',
        contextMessageId: 'wamid.outbound',
        buttonId: `reject.${token}`,
      },
      eventId,
    );

    expect(result.disposition).toBe('ignored_late');
    expect(currentStatus).toBe('authorized');
    expect(insertedEventType).toBe('pickup.decision.late');
  });

  it('no autoriza una respuesta con un token manipulado', async () => {
    const eventId = randomUUID();
    await expect(
      service.recordN8nEvent(
        {
          eventId,
          eventType: 'pickup.decision.received',
          schemaVersion: 1,
          requestId,
          occurredAt: '2026-11-02T10:01:00Z',
          decision: 'authorize',
          responderPhone: phone,
          incomingMessageId: 'wamid.inbound',
          contextMessageId: 'wamid.outbound',
          buttonId: `authorize.${Buffer.alloc(32, 99).toString('base64url')}`,
        },
        eventId,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(currentStatus).toBe('pending');
    expect(insertedEventType).toBeUndefined();
  });

  it('no autoriza a un teléfono distinto del tutor principal', async () => {
    const eventId = randomUUID();
    await expect(
      service.recordN8nEvent(
        {
          eventId,
          eventType: 'pickup.decision.received',
          schemaVersion: 1,
          requestId,
          occurredAt: '2026-11-02T10:01:00Z',
          decision: 'authorize',
          responderPhone: '+525500000001',
          incomingMessageId: 'wamid.inbound.alternate',
          contextMessageId: 'wamid.outbound',
          buttonId: `authorize.${token}`,
        },
        eventId,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(currentStatus).toBe('pending');
    expect(insertedEventType).toBeUndefined();
  });

  it('cancela una solicitud pendiente y registra la acción de personal', async () => {
    const result = await service.cancel(requestId, randomUUID());

    expect(result.status).toBe('cancelled');
    expect(result.cancelledAt).toBe('2026-11-02T10:05:00.000Z');
    expect(currentStatus).toBe('cancelled');
    expect(insertedEventType).toBe('pickup.request.cancelled');
  });

  it('no permite que una respuesta posterior a la cancelación autorice la entrega', async () => {
    currentStatus = 'cancelled';
    const eventId = randomUUID();

    const result = await service.recordN8nEvent(
      {
        eventId,
        eventType: 'pickup.decision.received',
        schemaVersion: 1,
        requestId,
        occurredAt: '2026-11-02T10:06:00Z',
        decision: 'authorize',
        responderPhone: phone,
        incomingMessageId: 'wamid.late',
        contextMessageId: 'wamid.outbound',
        buttonId: `authorize.${token}`,
      },
      eventId,
    );

    expect(result.disposition).toBe('ignored_late');
    expect(currentStatus).toBe('cancelled');
    expect(insertedEventType).toBe('pickup.decision.late');
  });
});
