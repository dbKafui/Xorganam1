BEGIN;

ALTER TABLE periodic_accrual_ledger
  DROP CONSTRAINT IF EXISTS periodic_accrual_ledger_source_transaction_id_key;

CREATE UNIQUE INDEX uq_periodic_accrual_source_institution
  ON periodic_accrual_ledger (source_transaction_id, institution_id);

CREATE OR REPLACE VIEW institution_sweep_reconciliation AS
SELECT
  l.sweep_transaction_id,
  l.tenant_id,
  l.merchant_id,
  l.institution_id,
  l.period_key,
  l.status AS sweep_status,
  l.institution_amount,
  l.vendor_amount,
  l.institution_leg_status,
  l.vendor_leg_status,
  l.failure_reason,
  l.created_at,
  l.updated_at,
  COALESCE(SUM(a.accrued_amount) FILTER (WHERE a.status = 'PENDING'), 0) AS pending_accrual_amount,
  COALESCE(SUM(a.accrued_amount) FILTER (WHERE a.status = 'SWEPT'), 0) AS swept_accrual_amount
FROM institution_sweep_ledger l
LEFT JOIN periodic_accrual_ledger a
  ON a.swept_transaction_id = l.sweep_transaction_id
GROUP BY l.sweep_transaction_id, l.tenant_id, l.merchant_id, l.institution_id,
         l.period_key, l.status, l.institution_amount, l.vendor_amount,
         l.institution_leg_status, l.vendor_leg_status, l.failure_reason,
         l.created_at, l.updated_at;

COMMIT;
