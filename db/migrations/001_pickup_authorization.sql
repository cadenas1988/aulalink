CREATE TABLE school_students (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 200),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE school_contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name TEXT NOT NULL CHECK (length(trim(full_name)) BETWEEN 1 AND 200),
    phone_ciphertext BYTEA NOT NULL,
    phone_lookup_hmac BYTEA NOT NULL CHECK (octet_length(phone_lookup_hmac) = 32),
    phone_key_version TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE school_student_contacts (
    student_id UUID NOT NULL REFERENCES school_students(id) ON DELETE RESTRICT,
    contact_id UUID NOT NULL REFERENCES school_contacts(id) ON DELETE RESTRICT,
    contact_role TEXT NOT NULL
        CHECK (contact_role IN ('primary', 'secondary', 'registered_pickup')),
    relationship_to_student TEXT,
    PRIMARY KEY (student_id, contact_id)
);
CREATE UNIQUE INDEX school_student_primary_contact_idx
    ON school_student_contacts (student_id) WHERE contact_role = 'primary';
CREATE UNIQUE INDEX school_student_secondary_contact_idx
    ON school_student_contacts (student_id) WHERE contact_role = 'secondary';
CREATE INDEX school_student_registered_contacts_idx
    ON school_student_contacts (student_id) WHERE contact_role = 'registered_pickup';

CREATE TABLE pickup_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL REFERENCES school_students(id) ON DELETE RESTRICT,
    created_by_user_id UUID NOT NULL,
    pickup_person_name TEXT NOT NULL
        CHECK (length(trim(pickup_person_name)) BETWEEN 1 AND 200),
    relationship_to_student TEXT NOT NULL
        CHECK (length(trim(relationship_to_student)) BETWEEN 1 AND 100),
    photo_object_key TEXT NOT NULL UNIQUE,
    photo_mime_type TEXT NOT NULL
        CHECK (photo_mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
    photo_sha256 BYTEA NOT NULL CHECK (octet_length(photo_sha256) = 32),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'authorized', 'rejected', 'cancelled')),
    state_version BIGINT NOT NULL DEFAULT 1 CHECK (state_version > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    escalation_due_at TIMESTAMPTZ,
    escalation_enqueued_at TIMESTAMPTZ,
    decided_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    decision_token_hash BYTEA NOT NULL
        CHECK (octet_length(decision_token_hash) = 32),
    decision_token_ciphertext BYTEA NOT NULL,
    idempotency_key TEXT NOT NULL,
    input_sha256 BYTEA NOT NULL CHECK (octet_length(input_sha256) = 32),
    UNIQUE (created_by_user_id, idempotency_key),
    UNIQUE (decision_token_hash),
    CHECK (
        (status = 'pending' AND decided_at IS NULL)
        OR (status IN ('authorized', 'rejected')
            AND decided_at IS NOT NULL AND cancelled_at IS NULL)
        OR (status = 'cancelled' AND cancelled_at IS NOT NULL AND decided_at IS NULL)
    )
);

CREATE INDEX pickup_requests_student_created_idx
    ON pickup_requests (student_id, created_at DESC);
CREATE INDEX pickup_requests_pending_escalation_idx
    ON pickup_requests (escalation_due_at)
    WHERE status = 'pending' AND escalation_enqueued_at IS NULL;

CREATE TABLE pickup_request_recipients (
    request_id UUID NOT NULL
        REFERENCES pickup_requests(id) ON DELETE RESTRICT,
    contact_id UUID NOT NULL REFERENCES school_contacts(id) ON DELETE RESTRICT,
    recipient_role TEXT NOT NULL
        CHECK (recipient_role IN ('primary', 'secondary', 'registered_pickup')),
    phone_ciphertext BYTEA NOT NULL,
    phone_lookup_hmac BYTEA NOT NULL CHECK (octet_length(phone_lookup_hmac) = 32),
    phone_key_version TEXT NOT NULL,
    notification_status TEXT NOT NULL DEFAULT 'not_sent'
        CHECK (notification_status IN ('not_sent', 'accepted', 'delivered', 'failed')),
    whatsapp_message_id TEXT,
    submitted_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    PRIMARY KEY (request_id, contact_id)
);
CREATE UNIQUE INDEX pickup_request_primary_recipient_idx
    ON pickup_request_recipients (request_id) WHERE recipient_role = 'primary';
CREATE UNIQUE INDEX pickup_request_secondary_recipient_idx
    ON pickup_request_recipients (request_id) WHERE recipient_role = 'secondary';

CREATE UNIQUE INDEX pickup_request_whatsapp_message_idx
    ON pickup_request_recipients (whatsapp_message_id)
    WHERE whatsapp_message_id IS NOT NULL;

CREATE TABLE pickup_request_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL
        REFERENCES pickup_requests(id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL,
    source TEXT NOT NULL
        CHECK (source IN ('web', 'nest', 'n8n', 'whatsapp', 'email')),
    actor_type TEXT NOT NULL
        CHECK (actor_type IN ('staff', 'guardian', 'system', 'provider')),
    actor_user_id UUID,
    actor_contact_id UUID REFERENCES school_contacts(id) ON DELETE RESTRICT,
    decision TEXT CHECK (decision IN ('authorize', 'reject')),
    provider_message_id TEXT,
    context_provider_message_id TEXT,
    responder_phone_ciphertext BYTEA,
    responder_phone_lookup_hmac BYTEA,
    phone_key_version TEXT,
    occurred_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    idempotency_key TEXT NOT NULL,
    payload_sha256 BYTEA,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (source, idempotency_key),
    CHECK (
        (responder_phone_ciphertext IS NULL
         AND responder_phone_lookup_hmac IS NULL
         AND phone_key_version IS NULL)
        OR
        (responder_phone_ciphertext IS NOT NULL
         AND responder_phone_lookup_hmac IS NOT NULL
         AND phone_key_version IS NOT NULL)
    )
);

CREATE UNIQUE INDEX pickup_request_provider_message_idx
    ON pickup_request_events (source, provider_message_id)
    WHERE source = 'whatsapp' AND provider_message_id IS NOT NULL;
CREATE INDEX pickup_request_events_history_idx
    ON pickup_request_events (request_id, occurred_at, id);

CREATE TABLE pickup_request_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL
        REFERENCES pickup_requests(id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    locked_until TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    last_error_code TEXT
);

CREATE INDEX pickup_request_outbox_ready_idx
    ON pickup_request_outbox (next_attempt_at, created_at)
    WHERE status IN ('pending', 'failed');
CREATE UNIQUE INDEX pickup_request_outbox_escalation_idx
    ON pickup_request_outbox (request_id, event_type)
    WHERE event_type = 'pickup.escalation.requested';

REVOKE UPDATE, DELETE ON pickup_request_events FROM PUBLIC;
