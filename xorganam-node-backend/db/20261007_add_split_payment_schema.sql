BEGIN;

ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'SWEEP_PAYOUT';

CREATE TYPE institution_type AS ENUM ('SAVINGS_AND_LOANS', 'CREDIT_UNION');
CREATE TYPE split_mode AS ENUM ('PER_TRANSACTION', 'PERIODIC');
CREATE TYPE split_type AS ENUM ('PERCENTAGE', 'FIXED');
CREATE TYPE leg_order AS ENUM ('VENDOR_FIRST', 'INSTITUTION_FIRST');
CREATE TYPE split_rule_scope AS ENUM ('TENANT_DEFAULT', 'MERCHANT_OVERRIDE');
CREATE TYPE accrual_status AS ENUM ('PENDING', 'SWEPT', 'VOIDED');
CREATE TYPE fee_stage AS ENUM ('COLLECTION', 'PAYOUT');
CREATE TYPE fee_calc_type AS ENUM ('FLAT', 'PERCENTAGE', 'PERCENTAGE_WITH_CAP');
CREATE TYPE fee_payer AS ENUM ('CUSTOMER', 'MERCHANT', 'WAIVED');

CREATE TABLE institutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  institution_type institution_type NOT NULL,
  settlement_msisdn TEXT NOT NULL,
  settlement_account_name TEXT NOT NULL,
  settlement_country_code TEXT NOT NULL DEFAULT 'GH0233',
  api_verification_supported BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tenant_institution_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  member_id TEXT,
  verification_status verification_status NOT NULL DEFAULT 'PENDING',
  verification_method TEXT NOT NULL DEFAULT 'MANUAL',
  verified_at TIMESTAMPTZ,
  verified_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  min_percentage NUMERIC(5,2),
  max_percentage NUMERIC(5,2),
  min_fixed_amount NUMERIC(18,2),
  max_fixed_amount NUMERIC(18,2),
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, institution_id)
);

CREATE TABLE split_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  merchant_id UUID,
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  scope_level split_rule_scope NOT NULL,
  mode split_mode NOT NULL,
  type split_type NOT NULL,
  amount NUMERIC(18,4) NOT NULL,
  periodic_frequency TEXT,
  periodic_day_of_week SMALLINT,
  periodic_day_of_month SMALLINT,
  periodic_time_of_day TIME,
  leg_execution_order leg_order NOT NULL DEFAULT 'VENDOR_FIRST',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, merchant_id) REFERENCES merchants (tenant_id, id),
  CONSTRAINT chk_split_rule_scope CHECK (
    (scope_level = 'TENANT_DEFAULT' AND merchant_id IS NULL)
    OR (scope_level = 'MERCHANT_OVERRIDE' AND merchant_id IS NOT NULL)
  ),
  CONSTRAINT chk_split_rule_amount CHECK (amount >= 0 AND (type <> 'PERCENTAGE' OR amount <= 100))
);

CREATE UNIQUE INDEX uq_split_rules_active_tenant_default
  ON split_rules (tenant_id, institution_id)
  WHERE active AND scope_level = 'TENANT_DEFAULT';

CREATE UNIQUE INDEX uq_split_rules_active_merchant_override
  ON split_rules (tenant_id, merchant_id, institution_id)
  WHERE active AND scope_level = 'MERCHANT_OVERRIDE';

CREATE TABLE periodic_accrual_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  merchant_id UUID NOT NULL,
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
  split_rule_id UUID NOT NULL REFERENCES split_rules(id) ON DELETE RESTRICT,
  source_transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
  accrued_amount NUMERIC(18,2) NOT NULL CHECK (accrued_amount > 0),
  accrued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status accrual_status NOT NULL DEFAULT 'PENDING',
  swept_transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  swept_at TIMESTAMPTZ,
  FOREIGN KEY (tenant_id, merchant_id) REFERENCES merchants (tenant_id, id),
  UNIQUE (source_transaction_id)
);

ALTER TABLE transactions
  ADD COLUMN institution_id UUID REFERENCES institutions(id) ON DELETE RESTRICT,
  ADD COLUMN period_key DATE,
  ADD CONSTRAINT uq_transactions_periodic_sweep
    UNIQUE (tenant_id, merchant_id, institution_id, period_key, type);

ALTER TABLE transactions
  ADD COLUMN base_amount NUMERIC(18,2),
  ADD COLUMN fee_charged_amount NUMERIC(18,2),
  ADD COLUMN fee_charged_payer fee_payer,
  ADD COLUMN fee_eganow_cost NUMERIC(18,2),
  ADD COLUMN fee_platform_margin NUMERIC(18,2),
  ADD COLUMN fee_config_version_id UUID;

CREATE TABLE fee_config_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  stage fee_stage NOT NULL,
  charge_calc_type fee_calc_type NOT NULL,
  charge_flat_amount NUMERIC(18,2),
  charge_percentage NUMERIC(5,2),
  charge_cap_amount NUMERIC(18,2),
  charge_payer fee_payer NOT NULL,
  eganow_cost_calc_type fee_calc_type NOT NULL,
  eganow_cost_flat_amount NUMERIC(18,2),
  eganow_cost_percentage NUMERIC(5,2),
  eganow_cost_cap_amount NUMERIC(18,2),
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to TIMESTAMPTZ,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_fee_payer_by_stage CHECK (stage = 'COLLECTION' OR charge_payer <> 'CUSTOMER'),
  CONSTRAINT chk_fee_charge_values CHECK (
    (charge_calc_type = 'FLAT' AND charge_flat_amount IS NOT NULL)
    OR (charge_calc_type IN ('PERCENTAGE', 'PERCENTAGE_WITH_CAP') AND charge_percentage IS NOT NULL)
  ),
  CONSTRAINT chk_fee_charge_cap CHECK (charge_calc_type <> 'PERCENTAGE_WITH_CAP' OR charge_cap_amount IS NOT NULL),
  CONSTRAINT chk_fee_cost_values CHECK (
    (eganow_cost_calc_type = 'FLAT' AND eganow_cost_flat_amount IS NOT NULL)
    OR (eganow_cost_calc_type IN ('PERCENTAGE', 'PERCENTAGE_WITH_CAP') AND eganow_cost_percentage IS NOT NULL)
  ),
  CONSTRAINT chk_fee_cost_cap CHECK (eganow_cost_calc_type <> 'PERCENTAGE_WITH_CAP' OR eganow_cost_cap_amount IS NOT NULL)
);

ALTER TABLE transactions
  ADD CONSTRAINT fk_transactions_fee_config
  FOREIGN KEY (fee_config_version_id) REFERENCES fee_config_versions(id);

DROP INDEX IF EXISTS idx_transactions_status;
CREATE INDEX idx_transactions_status
  ON transactions (status)
  WHERE status IN ('PENDING', 'RECEIVED', 'SWEPT_INTERNAL', 'PARTIALLY_SETTLED');

CREATE UNIQUE INDEX uq_fee_config_current
  ON fee_config_versions (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), stage)
  WHERE effective_to IS NULL;

CREATE VIEW split_reconciliation AS
SELECT
  p.id AS parent_transaction_id,
  p.status AS parent_status,
  v.status AS vendor_leg_status,
  v.failure_reason AS vendor_failure_reason,
  i.status AS institution_leg_status,
  i.failure_reason AS institution_failure_reason
FROM transactions p
LEFT JOIN transactions v
  ON v.parent_transaction_id = p.id
 AND v.type = 'PAYOUT'
 AND v.payout_leg = 'VENDOR'
LEFT JOIN transactions i
  ON i.parent_transaction_id = p.id
 AND i.type = 'PAYOUT'
 AND i.payout_leg = 'INSTITUTION'
WHERE p.type = 'COLLECTION'
  AND i.id IS NOT NULL;

COMMIT;