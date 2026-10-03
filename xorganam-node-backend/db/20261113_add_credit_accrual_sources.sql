BEGIN;

ALTER TABLE periodic_accrual_ledger
  ALTER COLUMN source_transaction_id DROP NOT NULL,
  ADD COLUMN source_credit_installment_id UUID REFERENCES credit_plan_installments(id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_accrual_exactly_one_source
    CHECK ((source_transaction_id IS NOT NULL) <> (source_credit_installment_id IS NOT NULL)),
  DROP CONSTRAINT IF EXISTS periodic_accrual_ledger_source_transaction_id_key,
  DROP CONSTRAINT IF EXISTS uq_accrual_source_transaction;

ALTER TABLE periodic_accrual_ledger
  ADD CONSTRAINT uq_accrual_source_credit_installment UNIQUE (source_credit_installment_id);

COMMIT;
