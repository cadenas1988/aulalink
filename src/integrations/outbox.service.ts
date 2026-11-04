import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { PhotoStorageService } from './photo-storage.service';
import { SensitiveDataService } from './sensitive-data.service';
import { signWebhook } from './security';

interface OutboxRecord {
  id: string;
  request_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

@Injectable()
export class OutboxService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService,
    private readonly photos: PhotoStorageService,
    private readonly sensitiveData: SensitiveDataService,
  ) {}

  onModuleInit(): void {
    const webhookUrl = this.config.get<string>('N8N_WEBHOOK_URL');
    const nodeEnvironment = this.config.get<string>('NODE_ENV');
    const outboundSecret = this.config.get<string>('N8N_OUTBOUND_SECRET');
    const callbackSecret = this.config.get<string>('N8N_CALLBACK_SECRET');
    const escalationEmail = this.config.get<string>('ESCALATION_EMAIL_RECIPIENT');
    const missingConfiguration = [
      ['N8N_WEBHOOK_URL', webhookUrl],
      ['N8N_OUTBOUND_SECRET', outboundSecret],
      ['N8N_CALLBACK_SECRET', callbackSecret],
      ['ESCALATION_EMAIL_RECIPIENT', escalationEmail],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missingConfiguration.length > 0) {
      const message = `Falta configuración de integración: ${missingConfiguration.join(', ')}.`;
      if (nodeEnvironment === 'production') throw new Error(message);
      this.logger.error(
        `${message} Los eventos permanecerán pendientes hasta configurarla.`,
      );
    }
    if (
      [outboundSecret, callbackSecret]
        .filter((secret): secret is string => Boolean(secret))
        .some((secret) => Buffer.byteLength(secret, 'utf8') < 32)
    ) {
      throw new Error('Los secretos HMAC de n8n deben tener al menos 32 bytes.');
    }
    if (!webhookUrl) {
      return;
    } else if (
      nodeEnvironment === 'production' &&
      new URL(webhookUrl).protocol !== 'https:'
    ) {
      throw new Error('N8N_WEBHOOK_URL debe usar HTTPS en producción.');
    }
    const interval = Number(
      this.config.get<string>('OUTBOX_POLL_INTERVAL_MS') ?? 1000,
    );
    if (!Number.isInteger(interval) || interval < 250 || interval > 60000) {
      throw new Error('OUTBOX_POLL_INTERVAL_MS debe estar entre 250 y 60000.');
    }
    this.timer = setInterval(() => void this.dispatchBatch(), interval);
    this.timer.unref();
    void this.dispatchBatch();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async dispatchBatch(): Promise<void> {
    if (this.running || !this.config.get<string>('N8N_WEBHOOK_URL')) return;
    this.running = true;
    try {
      for (let count = 0; count < 10; count += 1) {
        const record = await this.claimOne();
        if (!record) break;
        await this.deliver(record);
      }
      await this.enqueueEscalations();
    } catch (error) {
      this.logger.error(
        'Falló el ciclo de despacho del outbox.',
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      this.running = false;
    }
  }

  private async claimOne(): Promise<OutboxRecord | null> {
    return this.database.transaction(async (client) => {
      const selected = await client.query<OutboxRecord>(
        `SELECT id, request_id, event_type, payload, attempts
         FROM pickup_request_outbox
         WHERE (status IN ('pending', 'failed')
                OR (status = 'processing' AND locked_until < clock_timestamp()))
           AND next_attempt_at <= clock_timestamp()
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
      );
      const row = selected.rows[0];
      if (!row) return null;
      await client.query(
        `UPDATE pickup_request_outbox
         SET status = 'processing', attempts = attempts + 1,
             locked_until = clock_timestamp() + interval '60 seconds'
         WHERE id = $1`,
        [row.id],
      );
      return { ...row, attempts: row.attempts + 1 };
    });
  }

  private async deliver(record: OutboxRecord): Promise<void> {
    try {
      const payload =
        record.event_type === 'pickup.authorization.requested'
          ? await this.buildNotificationPayload(record)
          : record.event_type === 'pickup.escalation.requested'
            ? await this.buildEscalationPayload(record)
            : {
                ...record.payload,
                eventId: record.id,
                eventType: record.event_type,
                schemaVersion: 1,
                occurredAt: new Date().toISOString(),
                requestId: record.request_id,
              };
      const body = Buffer.from(JSON.stringify(payload));
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const secret = this.config.getOrThrow<string>('N8N_OUTBOUND_SECRET');
      const response = await fetch(
        this.config.getOrThrow<string>('N8N_WEBHOOK_URL'),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-webhook-timestamp': timestamp,
            'x-webhook-signature': signWebhook(body, timestamp, secret),
            'idempotency-key': record.id,
          },
          body,
          signal: AbortSignal.timeout(8000),
        },
      );
      if (!response.ok) {
        throw new Error(`n8n respondió HTTP ${response.status}.`);
      }
      await this.database.query(
        `UPDATE pickup_request_outbox
         SET status = 'sent', sent_at = clock_timestamp(), locked_until = NULL,
             last_error_code = NULL
         WHERE id = $1`,
        [record.id],
      );
    } catch (error) {
      const delaySeconds = Math.min(300, 2 ** Math.min(record.attempts, 8));
      const errorCode = error instanceof Error ? error.name.slice(0, 80) : 'UNKNOWN';
      await this.database.query(
        `UPDATE pickup_request_outbox
         SET status = 'failed',
             next_attempt_at = clock_timestamp() + ($2 * interval '1 second'),
             locked_until = NULL, last_error_code = $3
         WHERE id = $1`,
        [record.id, delaySeconds, errorCode],
      );
      this.logger.warn(
        `No se entregó el evento ${record.id} a n8n; reintento en ${delaySeconds}s.`,
      );
    }
  }

  private async buildNotificationPayload(
    record: OutboxRecord,
  ): Promise<Record<string, unknown>> {
    const result = await this.database.query<{
      student_id: string;
      student_name: string;
      pickup_person_name: string;
      relationship_to_student: string;
      photo_object_key: string;
      photo_mime_type: string;
      decision_token_ciphertext: Buffer;
      primary_phone_ciphertext: Buffer;
    }>(
      `SELECT r.student_id, s.display_name AS student_name,
              r.pickup_person_name, r.relationship_to_student,
              r.photo_object_key, r.photo_mime_type,
              r.decision_token_ciphertext,
              primary_contact.phone_ciphertext AS primary_phone_ciphertext
       FROM pickup_requests r
       JOIN school_students s ON s.id = r.student_id
       JOIN pickup_request_recipients primary_contact
         ON primary_contact.request_id = r.id AND primary_contact.recipient_role = 'primary'
       WHERE r.id = $1 AND r.status = 'pending'`,
      [record.request_id],
    );
    const request = result.rows[0];
    if (!request) {
      return {
        eventId: record.id,
        eventType: record.event_type,
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        requestId: record.request_id,
        cancelled: true,
      };
    }

    return {
      eventId: record.id,
      eventType: record.event_type,
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      request: {
        id: record.request_id,
        studentId: request.student_id,
        studentName: request.student_name,
        pickupPerson: {
          fullName: request.pickup_person_name,
          relationshipToStudent: request.relationship_to_student,
        },
        photo: {
          temporaryUrl: await this.photos.temporaryUrl(request.photo_object_key),
          mimeType: request.photo_mime_type,
          expiresAt: new Date(
            Date.now() +
              Number(this.config.get<string>('PHOTO_URL_TTL_SECONDS') ?? 300) *
                1000,
          ).toISOString(),
        },
        decisionButtons: {
          authorize: `authorize.${this.sensitiveData.decrypt(request.decision_token_ciphertext)}`,
          reject: `reject.${this.sensitiveData.decrypt(request.decision_token_ciphertext)}`,
        },
      },
      primaryRecipient: {
        phoneE164: this.sensitiveData.decrypt(request.primary_phone_ciphertext),
      },
    };
  }

  private async enqueueEscalations(): Promise<void> {
    await this.database.transaction(async (client) => {
      const due = await client.query<{ id: string }>(
        `SELECT id FROM pickup_requests
         WHERE status = 'pending'
           AND escalation_due_at <= clock_timestamp()
           AND escalation_enqueued_at IS NULL
         ORDER BY escalation_due_at
         FOR UPDATE SKIP LOCKED
         LIMIT 25`,
      );
      for (const { id } of due.rows) {
        const eventId = randomUUID();
        await client.query(
          `INSERT INTO pickup_request_outbox
             (id, request_id, event_type, payload)
           VALUES ($1, $2, 'pickup.escalation.requested', $3::jsonb)`,
          [
            eventId,
            id,
            JSON.stringify({
              emailRecipient: this.config.getOrThrow<string>(
                'ESCALATION_EMAIL_RECIPIENT',
              ),
            }),
          ],
        );
        await client.query(
          `UPDATE pickup_requests SET escalation_enqueued_at = clock_timestamp()
           WHERE id = $1`,
          [id],
        );
      }
    });
  }

  private async buildEscalationPayload(
    record: OutboxRecord,
  ): Promise<Record<string, unknown>> {
    const result = await this.database.query<{
      student_id: string;
      student_name: string;
      pickup_person_name: string;
      relationship_to_student: string;
      secondary_phone_ciphertext: Buffer | null;
    }>(
      `SELECT r.student_id, s.display_name AS student_name,
              r.pickup_person_name, r.relationship_to_student,
              CASE WHEN secondary.active
                   THEN secondary_contact.phone_ciphertext END
                AS secondary_phone_ciphertext
       FROM pickup_requests r
       JOIN school_students s ON s.id = r.student_id
       LEFT JOIN pickup_request_recipients secondary_contact
         ON secondary_contact.request_id = r.id
        AND secondary_contact.recipient_role = 'secondary'
       LEFT JOIN school_contacts secondary
         ON secondary.id = secondary_contact.contact_id
       WHERE r.id = $1 AND r.status = 'pending'`,
      [record.request_id],
    );
    const request = result.rows[0];
    if (!request) {
      return {
        eventId: record.id,
        eventType: record.event_type,
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        requestId: record.request_id,
        cancelled: true,
      };
    }
    const registeredResult = await this.database.query<{
      phone_ciphertext: Buffer;
    }>(
      `SELECT recipient.phone_ciphertext
       FROM pickup_request_recipients recipient
       JOIN school_contacts contact ON contact.id = recipient.contact_id
       WHERE recipient.request_id = $1
         AND recipient.recipient_role = 'registered_pickup'
         AND contact.active
       ORDER BY recipient.contact_id`,
      [record.request_id],
    );

    return {
      eventId: record.id,
      eventType: record.event_type,
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      requestId: record.request_id,
      studentId: request.student_id,
      studentName: request.student_name,
      pickupPerson: {
        fullName: request.pickup_person_name,
        relationshipToStudent: request.relationship_to_student,
      },
      secondaryRecipient: request.secondary_phone_ciphertext
        ? {
            phoneE164: this.sensitiveData.decrypt(
              request.secondary_phone_ciphertext,
            ),
          }
        : null,
      registeredPickupRecipients: registeredResult.rows.map((recipient) => ({
        phoneE164: this.sensitiveData.decrypt(recipient.phone_ciphertext),
      })),
      emailRecipient:
        this.config.get<string>('ESCALATION_EMAIL_RECIPIENT') ?? null,
    };
  }
}
