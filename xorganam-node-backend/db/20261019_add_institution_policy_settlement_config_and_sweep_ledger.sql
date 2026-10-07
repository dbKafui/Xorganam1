BEGIN;

CREATE TYPE institution_sweep_status AS ENUM (
  'PENDING',
  'SETTLED',
  'PARTIALLY_SETTLED',
  'ACCRUED_UNSWEPT'
);

CREATE TABLE institution_policy (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  frequency_mode_min TEXT,
  frequency_mode_max TEXT,
  periodic_schedule_min JSONB,
  periodic_schedule_max JSONB,
  priority_deduction_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_institution_policy_period CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE UNIQUE INDEX uq_institution_policy_current
  ON institution_policy (institution_id)
  WHERE effective_to IS NULL;

CREATE TABLE tenant_merchant_settlement_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  merchant_id UUID NOT NULL,
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
  frequency_mode TEXT NOT NULL,
  periodic_schedule JSONB,
  priority_deduction_selected BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, merchant_id, institution_id),
  FOREIGN KEY (tenant_id, merchant_id) REFERENCES merchants (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE institution_sweep_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
  tenant_id UUID NOT NULL,
  merchant_id UUID NOT NULL,
  source_transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  sweep_transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  vendor_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (vendor_amount >= 0),
  institution_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (institution_amount >= 0),
  vendor_leg_status transaction_status,
  institution_leg_status transaction_status,
  status institution_sweep_status NOT NULL DEFAULT 'PENDING',
  failure_reason TEXT,
  period_key DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, merchant_id) REFERENCES merchants (tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (source_transaction_id),
  UNIQUE (sweep_transaction_id)
);

CREATE INDEX idx_institution_sweep_ledger_scope
  ON institution_sweep_ledger (institution_id, tenant_id, merchant_id, status, created_at DESC);

COMMIT;