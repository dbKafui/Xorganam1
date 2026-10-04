BEGIN;

-- Link only explicitly associated member records to a tenant. The tenant
-- dashboard APIs still require an approved tenant/institution link.
ALTER TABLE institution_customers
  ADD COLUMN tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL;
CREATE INDEX idx_institution_customers_tenant
  ON institution_customers(tenant_id, institution_id) WHERE tenant_id IS NOT NULL;

ALTER TABLE institution_financial_accounts
  ALTER COLUMN created_by_staff_id DROP NOT NULL,
  ADD COLUMN created_by_tenant_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT institution_financial_accounts_requester_check
    CHECK ((created_by_staff_id IS NOT NULL)::int + (created_by_tenant_user_id IS NOT NULL)::int = 1);
ALTER TABLE institution_financial_transactions
  ALTER COLUMN created_by_staff_id DROP NOT NULL,
  ADD COLUMN created_by_tenant_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT institution_financial_transactions_requester_check
    CHECK ((created_by_staff_id IS NOT NULL)::int + (created_by_tenant_user_id IS NOT NULL)::int = 1);

-- Loan installments are separate from transaction rows so partial repayments
-- and their schedule do not overload the shared payment transaction schema.
CREATE TABLE institution_loan_installments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL,
  account_id UUID NOT NULL,
  installment_number INTEGER NOT NULL CHECK (installment_number > 0),
  due_date DATE NOT NULL,
  amount_due_cents BIGINT NOT NULL CHECK (amount_due_cents > 0),
  amount_paid_cents BIGINT NOT NULL DEFAULT 0 CHECK (amount_paid_cents >= 0),
  status TEXT NOT NULL DEFAULT 'DUE' CHECK (status IN ('DUE', 'PARTIALLY_PAID', 'PAID', 'OVERDUE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (institution_id, account_id) REFERENCES institution_financial_accounts(institution_id, id) ON DELETE RESTRICT,
  UNIQUE (account_id, installment_number),
  CHECK (amount_paid_cents <= amount_due_cents)
);
CREATE INDEX idx_institution_installments_due
  ON institution_loan_installments(institution_id, due_date, status);

CREATE TABLE institution_financial_fee_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('LOAN_REPAYMENT', 'SAVINGS_CONTRIBUTION', 'SAVINGS_WITHDRAWAL')),
  fee_type TEXT NOT NULL CHECK (fee_type IN ('NONE', 'FIXED', 'PERCENTAGE')),
  fee_value NUMERIC(12,4) NOT NULL DEFAULT 0 CHECK (fee_value >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'GHS' CHECK (currency = 'GHS'),
  updated_by_staff_id UUID NOT NULL REFERENCES institution_staff(id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (institution_id, operation),
  CHECK ((fee_type = 'NONE' AND fee_value = 0) OR (fee_type = 'PERCENTAGE' AND fee_value <= 100))
);

COMMIT;
