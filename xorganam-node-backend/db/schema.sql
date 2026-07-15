-- =====================================================================
-- XORGANAM on Eganow — Multi-tenant schema (v2)
-- Tenant   = the business/operator holding Eganow API credentials (an
--            aggregator, a savings-group operator, an enterprise).
--            Tenant staff log in and run the dashboard.
-- Merchant = one sub-account under a tenant (a market woman), with her
--            own Eganow collection/payout account pair and her own
--            external MoMo destination. Merchants never log in - they
--            only ever receive SMS notifications.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- gen_random_uuid()

-- ---------------------------------------------------------------------
-- ENUM types
-- ---------------------------------------------------------------------
CREATE TYPE tenant_status AS ENUM ('PENDING', 'UNDER_REVIEW', 'ACTIVE', 'REJECTED', 'SUSPENDED');

CREATE TYPE payout_mode AS ENUM ('AUTO_SWEEP', 'MANUAL');

CREATE TYPE transaction_type AS ENUM ('COLLECTION', 'INTERNAL_TRANSFER', 'PAYOUT');

CREATE TYPE transaction_status AS ENUM ('RECEIVED', 'SWEPT_INTERNAL', 'PAID_OUT', 'FAILED');

CREATE TYPE user_role AS ENUM ('PLATFORM_ADMIN', 'TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_OPERATOR', 'TENANT_VIEWER');

CREATE TYPE kyc_type AS ENUM ('INDIVIDUAL', 'BUSINESS');

CREATE TYPE verification_status AS ENUM ('PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED');

-- ---------------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------------
CREATE TABLE tenants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_name    VARCHAR(255) NOT NULL,
    contact_phone   VARCHAR(20) NOT NULL,
    contact_email   VARCHAR(255) NOT NULL,
    -- Per-tenant salt mixed into webhook-signature / credential-encryption
    -- derivation, so a compromised key for one tenant never helps decrypt
    -- another tenant's secrets.
    api_key_salt    VARCHAR(255) NOT NULL,
    status          tenant_status NOT NULL DEFAULT 'PENDING',
    approved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tenants_status ON tenants (status);

-- ---------------------------------------------------------------------
-- users — tenant staff (and platform admins, tenant_id NULL for those)
-- ---------------------------------------------------------------------
CREATE TABLE users (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          UUID REFERENCES tenants (id) ON DELETE CASCADE,

    first_name         VARCHAR(100) NOT NULL,
    last_name          VARCHAR(100) NOT NULL,
    email              VARCHAR(255) NOT NULL UNIQUE,
    phone_number       VARCHAR(20),
    password_hash      VARCHAR(255) NOT NULL,

    role               user_role NOT NULL,
    is_active          BOOLEAN NOT NULL DEFAULT TRUE,

    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at      TIMESTAMPTZ,

    -- Only PLATFORM_ADMIN may have a null tenant_id; every other role
    -- must belong to exactly one tenant.
    CONSTRAINT chk_users_tenant_role CHECK (
        (role = 'PLATFORM_ADMIN' AND tenant_id IS NULL) OR
        (role != 'PLATFORM_ADMIN' AND tenant_id IS NOT NULL)
    )
);

CREATE INDEX idx_users_tenant ON users (tenant_id);
CREATE INDEX idx_users_email ON users (email);

-- ---------------------------------------------------------------------
-- tenant_eganow_credentials
-- One row per tenant. Values are stored encrypted (application-layer
-- AES-256-GCM, see src/security/encryption.js).
-- ---------------------------------------------------------------------
CREATE TABLE tenant_eganow_credentials (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                       UUID NOT NULL UNIQUE REFERENCES tenants (id) ON DELETE CASCADE,

    eganow_api_key_encrypted        TEXT,
    eganow_client_secret_encrypted  TEXT,
    eganow_access_token_encrypted   TEXT,
    eganow_refresh_token_encrypted  TEXT,
    access_token_expires_at         TIMESTAMPTZ,

    -- HMAC secret Eganow signs webhook payloads with for this tenant.
    webhook_secret_encrypted        TEXT,

    eganow_base_url                 VARCHAR(255),

    eganow_merchant_code            VARCHAR(100),
    is_enabled                      BOOLEAN NOT NULL DEFAULT FALSE,

    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- tenant_notification_settings
-- Pluggable SMS/email provider config, one row per tenant.
-- ---------------------------------------------------------------------
CREATE TABLE tenant_notification_settings (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                   UUID NOT NULL UNIQUE REFERENCES tenants (id) ON DELETE CASCADE,

    sms_provider_name           VARCHAR(100),
    sms_provider_key_encrypted  TEXT,
    sms_sender_id               VARCHAR(20),
    sms_enabled                 BOOLEAN NOT NULL DEFAULT FALSE,

    email_provider_name           VARCHAR(100),
    email_provider_key_encrypted  TEXT,
    email_from_address             VARCHAR(255),
    email_enabled                  BOOLEAN NOT NULL DEFAULT FALSE,

    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- kyc_documents
-- ---------------------------------------------------------------------
CREATE TABLE kyc_documents (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

    kyc_type             kyc_type NOT NULL,
    document_type        VARCHAR(100) NOT NULL,
    document_number      VARCHAR(100) NOT NULL,
    document_url         VARCHAR(1024) NOT NULL,

    verification_status  verification_status NOT NULL DEFAULT 'PENDING',
    rejection_reason     TEXT,
    verified_by_user_id  UUID REFERENCES users (id) ON DELETE SET NULL,
    verified_at          TIMESTAMPTZ,

    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_kyc_documents UNIQUE (tenant_id, document_type, document_number)
);

CREATE INDEX idx_kyc_documents_tenant ON kyc_documents (tenant_id);
CREATE INDEX idx_kyc_documents_status ON kyc_documents (verification_status);

-- ---------------------------------------------------------------------
-- merchants
-- One row per sub-account (market woman) under a tenant.
-- ---------------------------------------------------------------------
CREATE TABLE merchants (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                       UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

    display_name                    VARCHAR(255) NOT NULL,
    mobile_money_number             VARCHAR(20) NOT NULL,
    network_provider                VARCHAR(50) NOT NULL, -- MTN, Vodafone, AirtelTigo, ...

    payout_mode                     payout_mode NOT NULL DEFAULT 'MANUAL',

    -- The two Eganow wallet legs this merchant's money moves through.
    eganow_collection_account_id    VARCHAR(150) NOT NULL,
    eganow_payout_account_id        VARCHAR(150) NOT NULL,

    is_active                       BOOLEAN NOT NULL DEFAULT TRUE,
    onboarded_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_merchant_collection_account UNIQUE (tenant_id, eganow_collection_account_id),
    CONSTRAINT uq_merchant_payout_account UNIQUE (tenant_id, eganow_payout_account_id)
);

CREATE INDEX idx_merchants_tenant ON merchants (tenant_id);
CREATE INDEX idx_merchants_tenant_active ON merchants (tenant_id, is_active);
CREATE INDEX idx_merchants_collection_account ON merchants (eganow_collection_account_id);
CREATE INDEX idx_merchants_payout_account ON merchants (eganow_payout_account_id);
-- Lets a composite FK from merchant_settings / transactions reference
-- (tenant_id, id) together, so those tables can enforce "this merchant
-- really belongs to this tenant" at the database level.
CREATE UNIQUE INDEX uq_merchants_tenant_id_id ON merchants (tenant_id, id);

-- ---------------------------------------------------------------------
-- merchant_settings
-- Permission overlay, independent of payout_mode.
-- ---------------------------------------------------------------------
CREATE TABLE merchant_settings (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    merchant_id             UUID NOT NULL REFERENCES merchants (id) ON DELETE CASCADE,

    allow_manual_control    BOOLEAN NOT NULL DEFAULT FALSE,
    notify_sms              BOOLEAN NOT NULL DEFAULT TRUE,
    notify_email            BOOLEAN NOT NULL DEFAULT FALSE,
    contact_email           VARCHAR(255),

    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_merchant_settings UNIQUE (tenant_id, merchant_id),
    CONSTRAINT fk_merchant_settings_merchant_tenant
        FOREIGN KEY (tenant_id, merchant_id)
        REFERENCES merchants (tenant_id, id)
        ON DELETE CASCADE
);

CREATE INDEX idx_merchant_settings_tenant_merchant ON merchant_settings (tenant_id, merchant_id);

-- ---------------------------------------------------------------------
-- transactions
-- Every row scoped by BOTH tenant_id and merchant_id.
-- ---------------------------------------------------------------------
CREATE TABLE transactions (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               UUID NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
    merchant_id             UUID NOT NULL REFERENCES merchants (id) ON DELETE RESTRICT,

    parent_transaction_id   UUID REFERENCES transactions (id) ON DELETE SET NULL,

    type                    transaction_type NOT NULL,
    status                  transaction_status NOT NULL DEFAULT 'RECEIVED',

    amount                  NUMERIC(18, 2) NOT NULL,
    fees                    NUMERIC(18, 2) NOT NULL DEFAULT 0,
    currency                VARCHAR(10) NOT NULL DEFAULT 'GHS',

    internal_reference      VARCHAR(100) NOT NULL,
    eganow_reference         VARCHAR(150),
    eganow_transaction_id    VARCHAR(150),

    initiated_by_user_id     UUID REFERENCES users (id) ON DELETE SET NULL,
    manually_triggered        BOOLEAN NOT NULL DEFAULT FALSE,

    failure_reason           TEXT,
    raw_webhook_payload       JSONB,
    notification_sent        BOOLEAN NOT NULL DEFAULT FALSE,

    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at              TIMESTAMPTZ,

    CONSTRAINT uq_transactions_internal_reference UNIQUE (internal_reference),
    CONSTRAINT fk_transactions_merchant_tenant
        FOREIGN KEY (tenant_id, merchant_id)
        REFERENCES merchants (tenant_id, id)
        ON DELETE RESTRICT
);

CREATE INDEX idx_transactions_tenant_merchant ON transactions (tenant_id, merchant_id);
CREATE INDEX idx_transactions_tenant_merchant_status ON transactions (tenant_id, merchant_id, status);
CREATE INDEX idx_transactions_tenant_merchant_created ON transactions (tenant_id, merchant_id, created_at DESC);
CREATE INDEX idx_transactions_tenant_created ON transactions (tenant_id, created_at DESC);
CREATE INDEX idx_transactions_status ON transactions (status) WHERE status IN ('RECEIVED', 'SWEPT_INTERNAL');
CREATE INDEX idx_transactions_eganow_reference ON transactions (eganow_reference);
CREATE INDEX idx_transactions_parent ON transactions (parent_transaction_id);

-- ---------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tenants_updated_at BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_tenant_credentials_updated_at BEFORE UPDATE ON tenant_eganow_credentials
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_tenant_notification_settings_updated_at BEFORE UPDATE ON tenant_notification_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_kyc_documents_updated_at BEFORE UPDATE ON kyc_documents
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_merchants_updated_at BEFORE UPDATE ON merchants
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_merchant_settings_updated_at BEFORE UPDATE ON merchant_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_transactions_updated_at BEFORE UPDATE ON transactions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- Idempotent merchant_settings row on merchant creation.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_default_merchant_settings()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO merchant_settings (tenant_id, merchant_id, allow_manual_control)
    VALUES (NEW.tenant_id, NEW.id, FALSE)
    ON CONFLICT (tenant_id, merchant_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_merchants_default_settings AFTER INSERT ON merchants
    FOR EACH ROW EXECUTE FUNCTION create_default_merchant_settings();

-- ---------------------------------------------------------------------
-- Idempotent tenant_eganow_credentials + tenant_notification_settings
-- row on tenant creation, so every downstream read can assume the row
-- exists rather than null-checking a missing 1:1 row everywhere.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_default_tenant_config_rows()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO tenant_eganow_credentials (tenant_id, is_enabled)
    VALUES (NEW.id, FALSE)
    ON CONFLICT (tenant_id) DO NOTHING;

    INSERT INTO tenant_notification_settings (tenant_id)
    VALUES (NEW.id)
    ON CONFLICT (tenant_id) DO NOTHING;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tenants_default_config AFTER INSERT ON tenants
    FOR EACH ROW EXECUTE FUNCTION create_default_tenant_config_rows();
