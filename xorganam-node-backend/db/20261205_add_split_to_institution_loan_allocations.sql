BEGIN;

CREATE TABLE institution_split_financial_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
  sweep_transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
  source_transaction_id UUID REFERENCES transactions(id) ON DELETE RESTRICT,
  source_credit_installment_id UUID REFERENCES credit_plan_installments(id) ON DELETE RESTRICT,
  account_id UUID NOT NULL REFERENCES institution_financial_accounts(id) ON DELETE RESTRICT,
  allocation_type TEXT NOT NULL CHECK (allocation_type IN ('LOAN_REPAYMENT', 'SAVINGS_CONTRIBUTION')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((source_transaction_id IS NOT NULL)::int + (source_credit_installment_id IS NOT NULL)::int = 1)
);

CREATE UNIQUE INDEX uq_split_finance_source_transaction
  ON institution_split_financial_allocations(sweep_transaction_id, source_transaction_id, account_id)
  WHERE source_transaction_id IS NOT NULL;
CREATE UNIQUE INDEX uq_split_finance_source_credit_installment
  ON institution_split_financial_allocations(sweep_transaction_id, source_credit_installment_id, account_id)
  WHERE source_credit_installment_id IS NOT NULL;

CREATE INDEX idx_institution_split_financial_allocations_account
  ON institution_split_financial_allocations(institution_id, account_id, created_at DESC);

COMMIT;
