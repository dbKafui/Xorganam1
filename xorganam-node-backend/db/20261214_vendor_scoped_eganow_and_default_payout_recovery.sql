BEGIN;

CREATE TABLE merchant_eganow_credentials (
  merchant_id UUID PRIMARY KEY REFERENCES merchants(id) ON DELETE RESTRICT,
  api_username_encrypted TEXT NOT NULL,
  api_password_encrypted TEXT NOT NULL,
  x_auth_encrypted TEXT NOT NULL,
  base_url TEXT,
  callback_url TEXT NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE institution_default_payout_recoveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
  tenant_id UUID NOT NULL,
  merchant_id UUID NOT NULL,
  account_id UUID NOT NULL REFERENCES institution_financial_accounts(id) ON DELETE RESTRICT,
  installment_id UUID NOT NULL REFERENCES institution_loan_installments(id) ON DELETE RESTRICT,
  sweep_transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
  payout_transaction_id UUID NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE RESTRICT,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'POSTED', 'FAILED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_at TIMESTAMPTZ,
  FOREIGN KEY (tenant_id, merchant_id) REFERENCES merchants(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (sweep_transaction_id, installment_id)
);

CREATE INDEX idx_institution_default_recovery_pending
  ON institution_default_payout_recoveries(merchant_id, institution_id, status, created_at)
  WHERE status = 'PENDING';

COMMIT;
