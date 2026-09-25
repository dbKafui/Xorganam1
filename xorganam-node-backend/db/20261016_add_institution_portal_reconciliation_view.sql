BEGIN;

CREATE OR REPLACE VIEW institution_portal_reconciliation AS
SELECT
  sr.parent_transaction_id,
  sr.parent_status,
  sr.vendor_leg_status,
  sr.vendor_failure_reason,
  sr.institution_leg_status,
  sr.institution_failure_reason,
  COALESCE(pa.pending_amount, 0) AS pending_accrual_amount,
  COALESCE(pa.swept_amount, 0) AS swept_accrual_amount
FROM split_reconciliation sr
LEFT JOIN (
  SELECT
    source_transaction_id,
    SUM(accrued_amount) FILTER (WHERE status = 'PENDING') AS pending_amount,
    SUM(accrued_amount) FILTER (WHERE status = 'SWEPT') AS swept_amount
  FROM periodic_accrual_ledger
  GROUP BY source_transaction_id
) pa ON pa.source_transaction_id = sr.parent_transaction_id;

COMMIT;