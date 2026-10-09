BEGIN;

CREATE TABLE email_delivery_records (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    status              VARCHAR(16) NOT NULL CHECK (status IN ('PENDING', 'RETRYING', 'DELIVERED', 'FAILED')),
    recipient_count     INTEGER NOT NULL CHECK (recipient_count >= 0),
    provider_message_id VARCHAR(255),
    error_code          VARCHAR(64),
    attempt_count       INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at        TIMESTAMPTZ
);

CREATE INDEX idx_email_delivery_records_tenant_created
  ON email_delivery_records (tenant_id, created_at DESC);
CREATE INDEX idx_email_delivery_records_retrying
  ON email_delivery_records (status, updated_at)
  WHERE status IN ('PENDING', 'RETRYING');
CREATE TRIGGER trg_email_delivery_records_updated_at BEFORE UPDATE ON email_delivery_records
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;