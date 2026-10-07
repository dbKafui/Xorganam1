BEGIN;

ALTER TABLE institutions ADD COLUMN api_key_salt TEXT;
UPDATE institutions SET api_key_salt = gen_random_uuid()::text WHERE api_key_salt IS NULL;
ALTER TABLE institutions ALTER COLUMN api_key_salt SET NOT NULL;
ALTER TABLE institutions
  ADD COLUMN eganow_collection_account_id TEXT,
  ADD COLUMN eganow_payout_account_id TEXT,
  ADD COLUMN eganow_network_provider TEXT;

CREATE TABLE institution_eganow_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL UNIQUE REFERENCES institutions(id) ON DELETE CASCADE,
  api_username_encrypted TEXT,
  api_password_encrypted TEXT,
  x_auth_encrypted TEXT,
  eganow_base_url TEXT NOT NULL DEFAULT 'https://developer.sandbox.egacoreapi.com',
  callback_url TEXT,
  is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE institution_financial_transactions
  ADD COLUMN fee_cents BIGINT NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  ADD COLUMN payout_amount_cents BIGINT CHECK (payout_amount_cents IS NULL OR payout_amount_cents >= 0),
  ADD COLUMN gateway_reference TEXT,
  ADD COLUMN gateway_transaction_id TEXT,
  ADD COLUMN payment_gateway_status TEXT,
  ADD COLUMN failure_reason TEXT,
  ADD COLUMN payer_phone_number TEXT;

ALTER TYPE institution_financial_transaction_status ADD VALUE IF NOT EXISTS 'PENDING_GATEWAY';
ALTER TYPE institution_financial_transaction_status ADD VALUE IF NOT EXISTS 'FAILED';

COMMIT;
