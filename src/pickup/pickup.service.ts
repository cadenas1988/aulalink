import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { PhotoStorageService } from '../integrations/photo-storage.service';
import { OutboxService } from '../integrations/outbox.service';
import { SensitiveDataService } from '../integrations/sensitive-data.service';
import { CreatePickupRequestDto } from './create-pickup-request.dto';

const DECISION_TOKEN_PATTERN = /^(authorize|reject)\.([A-Za-z0-9_-]{32,64})$/;

interface RequestRow {
  id: string;
  student_id: string;
  pickup_person_name: string;
  relationship_to_student: string;
  status: string;
  created_at: Date;
  escalation_due_at: Date | null;
  decided_at: Date | null;
  cancelled_at?: Date | null;
  state_version: string;
  created_by_user_id?: string;
  input_sha256?: Buffer;
}

interface N8nEvent {
  eventId: string;
  eventType: string;
  schemaVersion: number;
  requestId: string;
  occurredAt: string;
  [key: string]: unknown;
}

@Injectable()
export class PickupService {
  private readonly logger = new Logger(PickupService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly photos: PhotoStorageService,
    private readonly sensitiveData: SensitiveDataService,
    private readonly outbox: OutboxService,
  ) {}

  async create(
    dto: CreatePickupRequestDto,
    actorId: string,
    idempotencyKey: string,
    photo: { buffer: Buffer; mimeType: string },
  ): Promise<Record<string, unknown>> {
    const cleanName = dto.pickupPerson.fullName.trim();
    const cleanRelationship = dto.pickupPerson.relationshipToStudent.trim();
    if (!cleanName || !cleanRelationship) {
      throw new BadRequestException('Los datos de la persona son obligatorios.');
    }

    const photoDigest = createHash('sha256').update(photo.buffer).digest();
    const inputDigest = createHash('sha256')
      .update(
        JSON.stringify({
          studentId: dto.studentId,
          pickupPerson: {
            fullName: cleanName,
            relationshipToStudent: cleanRelationship,
          },
        }),
      )
      .update(photoDigest)
      .digest();

    const prior = await this.database.query<RequestRow>(
      `SELECT id, student_id, pickup_person_name, relationship_to_student,
              status, created_at, escalation_due_at, decided_at, state_version,
              cancelled_at, created_by_user_id, input_sha256
       FROM pickup_requests
       WHERE created_by_user_id = $1 AND idempotency_key = $2`,
      [actorId, idempotencyKey],
    );
    if (prior.rows[0]) {
      if (!prior.rows[0].input_sha256?.equals(inputDigest)) {
        throw new ConflictException(
          'La clave de idempotencia ya se usó con otros datos.',
        );
      }
      return this.toResponse(prior.rows[0]);
    }

    const contacts = await this.database.query<{
      student_name: string;
      contact_id: string;
      recipient_role: 'primary' | 'secondary' | 'registered_pickup';
      phone_ciphertext: Buffer;
      phone_lookup_hmac: Buffer;
      phone_key_version: string;
    }>(
      `SELECT s.display_name AS student_name, c.id AS contact_id,
              sc.contact_role AS recipient_role, c.phone_ciphertext,
              c.phone_lookup_hmac, c.phone_key_version
       FROM school_students s
       JOIN school_student_contacts sc ON sc.student_id = s.id
       JOIN school_contacts c ON c.id = sc.contact_id
       WHERE s.id = $1 AND s.active AND c.active
       ORDER BY CASE sc.contact_role
         WHEN 'primary' THEN 0 WHEN 'secondary' THEN 1 ELSE 2 END`,
      [dto.studentId],
    );
    const primary = contacts.rows.find((row) => row.recipient_role === 'primary');
    if (!primary) {
      throw new NotFoundException(
        'No se encontró al alumno o no tiene tutor principal activo.',
      );
    }
    for (const contact of contacts.rows) {
      this.assertE164(this.sensitiveData.decrypt(contact.phone_ciphertext));
    }

    const photoKey = await this.photos.store(photo.buffer, photo.mimeType);
    const decisionToken = randomBytes(32).toString('base64url');
    const tokenHash = this.sensitiveData.hashDecisionToken(decisionToken);
    const tokenCiphertext = this.sensitiveData.encrypt(decisionToken);

    try {
      const { request, created } = await this.database.transaction(async (client) => {
        const inserted = await client.query<RequestRow>(
          `INSERT INTO pickup_requests (
             student_id, created_by_user_id, pickup_person_name,
             relationship_to_student, photo_object_key, photo_mime_type,
             photo_sha256, decision_token_hash, decision_token_ciphertext,
             idempotency_key, input_sha256
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (created_by_user_id, idempotency_key) DO NOTHING
           RETURNING id, student_id, pickup_person_name, relationship_to_student,
                     status, created_at, escalation_due_at, decided_at,
                     cancelled_at, state_version`,
          [
            dto.studentId,
            actorId,
            cleanName,
            cleanRelationship,
            photoKey,
            photo.mimeType,
            photoDigest,
            tokenHash,
            tokenCiphertext.ciphertext,
            idempotencyKey,
            inputDigest,
          ],
        );

        if (!inserted.rows[0]) {
          const existing = await client.query<RequestRow>(
            `SELECT id, student_id, pickup_person_name, relationship_to_student,
                    status, created_at, escalation_due_at, decided_at, cancelled_at,
                    state_version, input_sha256
             FROM pickup_requests
             WHERE created_by_user_id = $1 AND idempotency_key = $2`,
            [actorId, idempotencyKey],
          );
          const previous = existing.rows[0];
          if (!previous || !previous.input_sha256?.equals(inputDigest)) {
            throw new ConflictException(
              'La clave de idempotencia ya se usó con otros datos.',
            );
          }
          return { request: previous, created: false };
        }

        for (const contact of contacts.rows) {
          const encryptedPhone = this.sensitiveData.encrypt(
            this.sensitiveData.decrypt(contact.phone_ciphertext),
          );
          await client.query(
            `INSERT INTO pickup_request_recipients (
               request_id, contact_id, recipient_role, phone_ciphertext,
               phone_lookup_hmac, phone_key_version
             ) VALUES ($1,$2,$3,$4,$5,$6)`,
            [
              inserted.rows[0].id,
              contact.contact_id,
              contact.recipient_role,
              encryptedPhone.ciphertext,
              contact.phone_lookup_hmac,
              encryptedPhone.keyVersion,
            ],
          );
        }

        const outboxId = randomUUID();
        await client.query(
          `INSERT INTO pickup_request_outbox (id, request_id, event_type)
           VALUES ($1, $2, 'pickup.authorization.requested')`,
          [outboxId, inserted.rows[0].id],
        );
        await this.insertAuditEvent(client, {
          requestId: inserted.rows[0].id,
          eventType: 'pickup.request.created',
          source: 'web',
          actorType: 'staff',
          actorUserId: actorId,
          idempotencyKey: `${inserted.rows[0].id}:created`,
          occurredAt: new Date(),
        });
        return { request: inserted.rows[0], created: true };
      });

      if (!created) {
        try {
          await this.photos.remove(photoKey);
        } catch (cleanupError) {
          this.logger.error(
            `No se pudo limpiar el objeto duplicado ${photoKey}.`,
            cleanupError instanceof Error ? cleanupError.stack : undefined,
          );
        }
      }
      if (created) void this.outbox.dispatchBatch();
      return this.toResponse(request);
    } catch (error) {
      try {
        await this.photos.remove(photoKey);
      } catch (cleanupError) {
        this.logger.error(
          `No se pudo limpiar el objeto temporal ${photoKey}.`,
          cleanupError instanceof Error ? cleanupError.stack : undefined,
        );
      }
      throw error;
    }
  }

  async get(requestId: string): Promise<Record<string, unknown>> {
    const result = await this.database.query<RequestRow>(
      `SELECT id, student_id, pickup_person_name, relationship_to_student,
              status, created_at, escalation_due_at, decided_at, cancelled_at,
              state_version
       FROM pickup_requests WHERE id = $1`,
      [requestId],
    );
    if (!result.rows[0]) throw new NotFoundException('Solicitud no encontrada.');
    return this.toResponse(result.rows[0]);
  }

  async cancel(
    requestId: string,
    actorId: string,
  ): Promise<Record<string, unknown>> {
    const result = await this.database.transaction(async (client) => {
      const selected = await client.query<RequestRow>(
        `SELECT id, student_id, pickup_person_name, relationship_to_student,
                status, created_at, escalation_due_at, decided_at, cancelled_at,
                state_version
         FROM pickup_requests WHERE id = $1 FOR UPDATE`,
        [requestId],
      );
      const request = selected.rows[0];
      if (!request) throw new NotFoundException('Solicitud no encontrada.');
      if (request.status === 'cancelled') return request;
      if (request.status !== 'pending') {
        throw new ConflictException(
          'Solo se pueden cancelar solicitudes pendientes.',
        );
      }

      const updated = await client.query<RequestRow>(
        `UPDATE pickup_requests
         SET status = 'cancelled', cancelled_at = clock_timestamp(),
             updated_at = clock_timestamp(), state_version = state_version + 1
         WHERE id = $1 AND status = 'pending'
         RETURNING id, student_id, pickup_person_name, relationship_to_student,
                   status, created_at, escalation_due_at, decided_at, cancelled_at,
                   state_version`,
        [requestId],
      );
      await this.insertAuditEvent(client, {
        requestId,
        eventType: 'pickup.request.cancelled',
        source: 'web',
        actorType: 'staff',
        actorUserId: actorId,
        idempotencyKey: `${requestId}:cancelled`,
        occurredAt: updated.rows[0].cancelled_at ?? new Date(),
      });
      return updated.rows[0];
    });
    void this.outbox.dispatchBatch();
    return this.toResponse(result);
  }

  async recordN8nEvent(
    event: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<{ eventId: string; disposition: string }> {
    this.validateEvent(event, idempotencyKey);
    return this.database.transaction(async (client) => {
      const duplicate = await client.query(
        `SELECT 1 FROM pickup_request_events
         WHERE source = 'n8n' AND idempotency_key = $1`,
        [idempotencyKey],
      );
      if (duplicate.rowCount) {
        return { eventId: event.eventId, disposition: 'duplicate' };
      }

      const requestResult = await client.query<RequestRow>(
        `SELECT id, student_id, pickup_person_name, relationship_to_student,
                status, created_at, escalation_due_at, decided_at, cancelled_at,
                state_version
         FROM pickup_requests WHERE id = $1 FOR UPDATE`,
        [event.requestId],
      );
      const request = requestResult.rows[0];
      if (!request) throw new NotFoundException('Solicitud no encontrada.');

      switch (event.eventType) {
        case 'whatsapp.outbound.accepted':
          await this.recordOutboundAccepted(client, event, request);
          break;
        case 'whatsapp.delivery.status':
          await this.recordDeliveryStatus(client, event, request);
          break;
        case 'whatsapp.outbound.failed':
          await this.recordOutboundFailure(client, event, request);
          break;
        case 'pickup.decision.received':
          return this.recordDecision(client, event, request, idempotencyKey);
        case 'pickup.escalation.completed':
          this.validateEscalationResult(event);
          await this.insertAuditEvent(client, {
            requestId: request.id,
            eventType: 'pickup.escalation.completed',
            source: 'n8n',
            actorType: 'system',
            idempotencyKey,
            occurredAt: new Date(event.occurredAt),
            providerMessageId: this.optionalString(event.providerMessageId),
            details: {
              channel: event.channel,
              result: event.result,
              errorCode: event.errorCode ?? null,
            },
          });
          break;
        default:
          throw new BadRequestException('Tipo de evento n8n no reconocido.');
      }
      return { eventId: event.eventId, disposition: 'applied' };
    });
  }

  async getVersion(requestId: string): Promise<number> {
    const result = await this.database.query<{ state_version: string }>(
      'SELECT state_version FROM pickup_requests WHERE id = $1',
      [requestId],
    );
    if (!result.rows[0]) throw new NotFoundException('Solicitud no encontrada.');
    return Number(result.rows[0].state_version);
  }

  private async recordOutboundAccepted(
    client: PoolClient,
    event: N8nEvent,
    request: RequestRow,
  ): Promise<void> {
    const role = this.recipientRole(event.recipientRole);
    const phone = this.requiredPhone(event.recipientPhone, 'recipientPhone');
    const messageId = this.requiredString(event.whatsappMessageId, 'whatsappMessageId');
    const recipient = await client.query<{
      contact_id: string;
      phone_lookup_hmac: Buffer;
    }>(
      `SELECT contact_id, phone_lookup_hmac
       FROM pickup_request_recipients
       WHERE request_id = $1 AND recipient_role = $2 FOR UPDATE`,
      [request.id, role],
    );
    const matchedRecipient = recipient.rows.find((row) =>
      this.equalBuffers(
        row.phone_lookup_hmac,
        this.sensitiveData.phoneLookup(phone),
      ),
    );
    if (
      !matchedRecipient
    ) {
      throw new UnauthorizedException('El destinatario no coincide con la solicitud.');
    }

    await client.query(
      `UPDATE pickup_request_recipients
       SET notification_status = 'accepted', whatsapp_message_id = $3,
           submitted_at = $4
       WHERE request_id = $1 AND contact_id = $2`,
      [request.id, matchedRecipient.contact_id, messageId, new Date(event.occurredAt)],
    );
    if (role === 'primary' && request.status === 'pending') {
      await client.query(
        `UPDATE pickup_requests SET escalation_due_at = $2, updated_at = clock_timestamp()
         WHERE id = $1`,
        [request.id, new Date(new Date(event.occurredAt).getTime() + 5 * 60 * 1000)],
      );
    }
    await this.insertAuditEvent(client, {
      requestId: request.id,
      eventType: 'whatsapp.outbound.accepted',
      source: 'n8n',
      actorType: 'provider',
      actorContactId: matchedRecipient.contact_id,
      providerMessageId: messageId,
      idempotencyKey: event.eventId,
      occurredAt: new Date(event.occurredAt),
      details: { recipientRole: role },
    });
  }

  private async recordDeliveryStatus(
    client: PoolClient,
    event: N8nEvent,
    request: RequestRow,
  ): Promise<void> {
    const messageId = this.requiredString(event.whatsappMessageId, 'whatsappMessageId');
    const status = this.requiredString(event.deliveryStatus, 'deliveryStatus');
    if (!['sent', 'delivered', 'read', 'failed'].includes(status)) {
      throw new BadRequestException('Estado de entrega inválido.');
    }
    const result = await client.query<{ contact_id: string; recipient_role: string }>(
      `UPDATE pickup_request_recipients
       SET notification_status = CASE WHEN $3 = 'failed' THEN 'failed'
                                      WHEN $3 IN ('delivered', 'read') THEN 'delivered'
                                      ELSE notification_status END,
           delivered_at = CASE WHEN $3 IN ('delivered', 'read')
                               THEN $4 ELSE delivered_at END
       WHERE request_id = $1 AND whatsapp_message_id = $2
       RETURNING contact_id, recipient_role`,
      [request.id, messageId, status, new Date(event.occurredAt)],
    );
    if (!result.rows[0]) {
      throw new ConflictException('El mensaje de WhatsApp no pertenece a la solicitud.');
    }
    await this.insertAuditEvent(client, {
      requestId: request.id,
      eventType: 'whatsapp.delivery.status',
      source: 'n8n',
      actorType: 'provider',
      actorContactId: result.rows[0].contact_id,
      providerMessageId: messageId,
      idempotencyKey: event.eventId,
      occurredAt: new Date(event.occurredAt),
      details: { status, recipientRole: result.rows[0].recipient_role },
    });
  }

  private async recordOutboundFailure(
    client: PoolClient,
    event: N8nEvent,
    request: RequestRow,
  ): Promise<void> {
    const role = this.recipientRole(event.recipientRole);
    const errorCode = this.requiredString(event.errorCode, 'errorCode');
    const result = await client.query<{ contact_id: string }>(
      `UPDATE pickup_request_recipients SET notification_status = 'failed'
       WHERE request_id = $1 AND recipient_role = $2
       RETURNING contact_id`,
      [request.id, role],
    );
    if (!result.rows[0]) throw new NotFoundException('Destinatario no encontrado.');
    await this.insertAuditEvent(client, {
      requestId: request.id,
      eventType: 'whatsapp.outbound.failed',
      source: 'n8n',
      actorType: 'provider',
      actorContactId: result.rows[0].contact_id,
      idempotencyKey: event.eventId,
      occurredAt: new Date(event.occurredAt),
      details: { recipientRole: role, errorCode },
    });
    if (role === 'primary' && request.status === 'pending') {
      await client.query(
        `UPDATE pickup_requests SET escalation_due_at = clock_timestamp(),
                                    updated_at = clock_timestamp()
         WHERE id = $1 AND escalation_due_at IS NULL`,
        [request.id],
      );
    }
  }

  private async recordDecision(
    client: PoolClient,
    event: N8nEvent,
    request: RequestRow,
    idempotencyKey: string,
  ): Promise<{ eventId: string; disposition: string }> {
    const decision = this.requiredString(event.decision, 'decision');
    const phone = this.requiredPhone(event.responderPhone, 'responderPhone');
    const messageId = this.requiredString(event.incomingMessageId, 'incomingMessageId');
    const contextId = this.requiredString(event.contextMessageId, 'contextMessageId');
    const buttonId = this.requiredString(event.buttonId, 'buttonId');
    if (!['authorize', 'reject'].includes(decision)) {
      throw new BadRequestException('Decisión inválida.');
    }

    const button = DECISION_TOKEN_PATTERN.exec(buttonId);
    if (!button || button[1] !== decision) {
      throw new UnauthorizedException('La opción recibida no coincide con el token.');
    }
    const primary = await client.query<{
      contact_id: string;
      phone_lookup_hmac: Buffer;
      whatsapp_message_id: string | null;
    }>(
      `SELECT contact_id, phone_lookup_hmac, whatsapp_message_id
       FROM pickup_request_recipients
       WHERE request_id = $1 AND recipient_role = 'primary' FOR UPDATE`,
      [request.id],
    );
    const recipient = primary.rows[0];
    if (
      !recipient ||
      !this.equalBuffers(
        recipient.phone_lookup_hmac,
        this.sensitiveData.phoneLookup(phone),
      ) ||
      !this.equalBuffers(
        this.sensitiveData.hashDecisionToken(button[2]),
        await this.getDecisionTokenHash(client, request.id),
      ) ||
      recipient.whatsapp_message_id !== contextId
    ) {
      throw new UnauthorizedException('La respuesta no corresponde al tutor o mensaje esperado.');
    }

    const alreadySeen = await client.query(
      `SELECT 1 FROM pickup_request_events
       WHERE (source = 'n8n' AND idempotency_key = $1)
          OR (source = 'whatsapp' AND provider_message_id = $2)`,
      [idempotencyKey, messageId],
    );
    if (alreadySeen.rowCount) {
      return { eventId: event.eventId, disposition: 'duplicate' };
    }

    const applied = request.status === 'pending';
    const phoneEncrypted = this.sensitiveData.encrypt(phone);
    await this.insertAuditEvent(client, {
      requestId: request.id,
      eventType: applied ? 'pickup.decision.applied' : 'pickup.decision.late',
      source: 'whatsapp',
      actorType: 'guardian',
      actorContactId: recipient.contact_id,
      decision,
      providerMessageId: messageId,
      contextProviderMessageId: contextId,
      responderPhone: phoneEncrypted,
      idempotencyKey: event.eventId,
      occurredAt: new Date(event.occurredAt),
      details: { applied, priorStatus: request.status },
    });

    if (applied) {
      await client.query(
        `UPDATE pickup_requests
         SET status = $2, decided_at = $3, updated_at = clock_timestamp(),
             state_version = state_version + 1
         WHERE id = $1 AND status = 'pending'`,
        [
          request.id,
          decision === 'authorize' ? 'authorized' : 'rejected',
          new Date(event.occurredAt),
        ],
      );
      return { eventId: event.eventId, disposition: 'applied' };
    }
    return { eventId: event.eventId, disposition: 'ignored_late' };
  }

  private async getDecisionTokenHash(
    client: PoolClient,
    requestId: string,
  ): Promise<Buffer> {
    const result = await client.query<{ decision_token_hash: Buffer }>(
      'SELECT decision_token_hash FROM pickup_requests WHERE id = $1',
      [requestId],
    );
    return result.rows[0].decision_token_hash;
  }

  private async insertAuditEvent(
    client: PoolClient,
    input: {
      requestId: string;
      eventType: string;
      source: 'web' | 'nest' | 'n8n' | 'whatsapp' | 'email';
      actorType: 'staff' | 'guardian' | 'system' | 'provider';
      actorUserId?: string;
      actorContactId?: string;
      decision?: string;
      providerMessageId?: string;
      contextProviderMessageId?: string;
      responderPhone?: { ciphertext: Buffer; keyVersion: string };
      idempotencyKey: string;
      occurredAt: Date;
      details?: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO pickup_request_events (
         request_id, event_type, source, actor_type, actor_user_id,
         actor_contact_id, decision, provider_message_id,
         context_provider_message_id, responder_phone_ciphertext,
         responder_phone_lookup_hmac, phone_key_version, occurred_at,
         idempotency_key, details
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
      [
        input.requestId,
        input.eventType,
        input.source,
        input.actorType,
        input.actorUserId ?? null,
        input.actorContactId ?? null,
        input.decision ?? null,
        input.providerMessageId ?? null,
        input.contextProviderMessageId ?? null,
        input.responderPhone?.ciphertext ?? null,
        input.responderPhone
          ? this.sensitiveData.phoneLookup(
              this.sensitiveData.decrypt(input.responderPhone.ciphertext),
            )
          : null,
        input.responderPhone?.keyVersion ?? null,
        input.occurredAt,
        input.idempotencyKey,
        JSON.stringify(input.details ?? {}),
      ],
    );
  }

  private validateEvent(
    event: Record<string, unknown>,
    idempotencyKey: string,
  ): asserts event is N8nEvent {
    if (
      !event ||
      Array.isArray(event) ||
      typeof event.eventId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        event.eventId,
      ) ||
      event.eventId !== idempotencyKey ||
      typeof event.eventType !== 'string' ||
      event.schemaVersion !== 1 ||
      typeof event.requestId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        event.requestId,
      ) ||
      typeof event.occurredAt !== 'string' ||
      Number.isNaN(Date.parse(event.occurredAt))
    ) {
      throw new BadRequestException('Envolvente del evento inválida.');
    }
    if (
      ![
        'whatsapp.outbound.accepted',
        'whatsapp.delivery.status',
        'whatsapp.outbound.failed',
        'pickup.decision.received',
        'pickup.escalation.completed',
      ].includes(event.eventType)
    ) {
      throw new BadRequestException('Tipo de evento n8n no reconocido.');
    }
  }

  private validateEscalationResult(event: N8nEvent): void {
    if (
      ![
        'secondary_guardian_whatsapp',
        'registered_pickup_whatsapp',
        'email',
      ].includes(
        this.requiredString(event.channel, 'channel'),
      ) ||
      !['accepted', 'delivered', 'failed'].includes(
        this.requiredString(event.result, 'result'),
      )
    ) {
      throw new BadRequestException('Resultado de escalamiento inválido.');
    }
  }

  private requiredString(value: unknown, name: string): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 500) {
      throw new BadRequestException(`El campo ${name} es inválido.`);
    }
    return value;
  }

  private requiredPhone(value: unknown, name: string): string {
    const phone = this.requiredString(value, name);
    this.assertE164(phone);
    return phone;
  }

  private assertE164(phone: string): void {
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
      throw new BadRequestException('El teléfono debe estar en formato E.164.');
    }
  }

  private recipientRole(value: unknown): 'primary' | 'secondary' {
    if (value !== 'primary' && value !== 'secondary') {
      throw new BadRequestException('recipientRole debe ser primary o secondary.');
    }
    return value;
  }

  private optionalString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  private equalBuffers(left: Buffer, right: Buffer): boolean {
    return left.length === right.length && timingSafeEqual(left, right);
  }

  private toResponse(row: RequestRow): Record<string, unknown> {
    return {
      id: row.id,
      studentId: row.student_id,
      pickupPerson: {
        fullName: row.pickup_person_name,
        relationshipToStudent: row.relationship_to_student,
      },
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
      escalationDueAt: row.escalation_due_at?.toISOString() ?? null,
      decidedAt: row.decided_at?.toISOString() ?? null,
      cancelledAt: row.cancelled_at?.toISOString() ?? null,
      stateVersion: Number(row.state_version),
    };
  }

}
