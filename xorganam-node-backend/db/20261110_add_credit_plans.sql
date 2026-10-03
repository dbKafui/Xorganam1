BEGIN;

CREATE TYPE credit_plan_status AS ENUM ('ACTIVE', 'COMPLETED', 'OVERDUE', 'DEFAULTED');

CREATE TABLE credit_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  merchant_id UUID NOT NULL,
  customer_identifier TEXT NOT NULL,
  customer_name TEXT,
  total_value NUMERIC(18,2) NOT NULL CHECK (total_value > 0),
  down_payment NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (down_payment >= 0),
  installment_count SMALLINT NOT NULL CHECK (installment_count > 0),
  installment_frequency TEXT NOT NULL CHECK (installment_frequency IN ('DAILY', 'WEEKLY', 'MONTHLY')),
  installment_amount NUMERIC(18,2) NOT NULL CHECK (installment_amount > 0),
  markup_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (markup_amount >= 0),
  late_fee_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (late_fee_amount >= 0),
  late_fee_grace_days SMALLINT NOT NULL DEFAULT 0 CHECK (late_fee_grace_days >= 0),
  missed_installment_threshold SMALLINT NOT NULL DEFAULT 3 CHECK (missed_installment_threshold > 0),
  status credit_plan_status NOT NULL DEFAULT 'ACTIVE',
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, merchant_id) REFERENCES merchants (tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, id)
);

CREATE INDEX idx_credit_plans_customer
  ON credit_plans (customer_identifier, created_at DESC);
CREATE INDEX idx_credit_plans_merchant_status
  ON credit_plans (tenant_id, merchant_id, status, created_at DESC);

CREATE TABLE credit_plan_installments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_plan_id UUID NOT NULL REFERENCES credit_plans(id) ON DELETE RESTRICT,
  installment_number SMALLINT NOT NULL CHECK (installment_number > 0),
  due_date DATE NOT NULL,
  amount_due NUMERIC(18,2) NOT NULL CHECK (amount_due > 0),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID', 'OVERDUE')),
  paid_transaction_id UUID REFERENCES transactions(id) ON DELETE RESTRICT,
  paid_at TIMESTAMPTZ,
  manually_recorded BOOLEAN NOT NULL DEFAULT FALSE,
  manually_recorded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (credit_plan_id, installment_number),
  CHECK ((status = 'PAID') = (paid_at IS NOT NULL)),
  CHECK (NOT manually_recorded OR (status = 'PAID' AND paid_transaction_id IS NULL AND manually_recorded_by_user_id IS NOT NULL)),
  UNIQUE (credit_plan_id, id)
);

CREATE INDEX idx_credit_installments_due
  ON credit_plan_installments (due_date, status, credit_plan_id);
CREATE INDEX idx_credit_installments_plan_status
  ON credit_plan_installments (credit_plan_id, installment_number, status);

CREATE VIEW credit_customer_balance AS
SELECT cp.tenant_id, cp.merchant_id, cp.customer_identifier, cp.id AS credit_plan_id,
       cp.status AS plan_status,
       COALESCE(SUM(cpi.amount_due) FILTER (WHERE cpi.status IN ('PENDING', 'OVERDUE')), 0) AS outstanding_promised,
       COALESCE(SUM(cpi.amount_due) FILTER (WHERE cpi.status = 'PAID'), 0) AS actually_collected,
       COUNT(*) FILTER (WHERE cpi.status = 'OVERDUE')::int AS overdue_installment_count
  FROM credit_plans cp
  JOIN credit_plan_installments cpi ON cpi.credit_plan_id = cp.id
 GROUP BY cp.tenant_id, cp.merchant_id, cp.customer_identifier, cp.id, cp.status;

CREATE VIEW merchant_credit_exposure AS
SELECT tenant_id, merchant_id,
       SUM(outstanding_promised) AS total_outstanding_promised,
       SUM(actually_collected) AS total_actually_collected
  FROM credit_customer_balance
 GROUP BY tenant_id, merchant_id;

COMMIT;
