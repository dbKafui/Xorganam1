BEGIN;

CREATE TABLE IF NOT EXISTS tenant_email_config (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL UNIQUE REFERENCES tenants (id) ON DELETE CASCADE,
    provider_type       VARCHAR(64) NOT NULL,
    settings            JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
    secrets_encrypted   BYTEA,
    key_version         INTEGER,
    from_address        VARCHAR(255) NOT NULL,
    from_name           VARCHAR(255),
    reply_to            VARCHAR(255),
    sender_verified     BOOLEAN NOT NULL DEFAULT FALSE,
    enabled             BOOLEAN NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT tenant_email_config_secret_version_chk CHECK (
        (secrets_encrypted IS NULL AND key_version IS NULL) OR
        (secrets_encrypted IS NOT NULL AND key_version > 0)
    ),
    CONSTRAINT tenant_email_config_enabled_sender_chk CHECK (NOT enabled OR sender_verified)
);

DROP TRIGGER IF EXISTS trg_tenant_email_config_updated_at ON tenant_email_config;
CREATE TRIGGER trg_tenant_email_config_updated_at BEFORE UPDATE ON tenant_email_config
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;