BEGIN;

ALTER TABLE institution_policy
  ADD COLUMN vendor_payout_modes JSONB NOT NULL DEFAULT '["PER_TRANSACTION"]'::jsonb;

ALTER TABLE tenant_merchant_settlement_config
  ADD COLUMN vendor_payout_mode TEXT NOT NULL DEFAULT 'PER_TRANSACTION',
  ADD COLUMN schedule_anchor_date DATE NOT NULL DEFAULT CURRENT_DATE;

ALTER TABLE periodic_accrual_ledger
  ADD COLUMN period_key DATE;

ALTER TABLE tenant_merchant_settlement_config
  ADD CONSTRAINT chk_vendor_payout_mode
  CHECK (vendor_payout_mode IN ('PER_TRANSACTION', 'PERIODIC'));

COMMENT ON COLUMN tenant_merchant_settlement_config.periodic_schedule IS
  'Schedule object: {unit: DAYS|WEEKS|MONTHS|YEARS, interval: positive integer}. Anchor is stored separately.';

CREATE INDEX idx_periodic_accrual_ledger_period
  ON periodic_accrual_ledger (tenant_id, merchant_id, institution_id, period_key, status);

COMMIT;
