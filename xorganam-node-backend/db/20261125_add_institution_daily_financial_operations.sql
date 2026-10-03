BEGIN;

CREATE TYPE institution_financial_product_type AS ENUM ('LOAN', 'SAVINGS');
CREATE TYPE institution_financial_product_status AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'RETIRED');
CREATE TYPE institution_customer_kyc_status AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');
CREATE TYPE institution_financial_account_status AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'SETTLED', 'REJECTED', 'SUSPENDED', 'CLOSED');
CREATE TYPE institution_financial_transaction_type AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'LOAN_DISBURSEMENT', 'LOAN_REPAYMENT');
CREATE TYPE institution_financial_transaction_status AS ENUM ('PENDING_APPROVAL', 'POSTED', 'REJECTED');
CREATE TYPE institution_notification_delivery_status AS ENUM ('PENDING', 'SENT', 'FAILED');

-- This customer registry is institution-owned. It stays separate from
-- institution_member, which records members referred through tenant links.
CREATE TABLE institution_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
  branch_id UUID,
  customer_number TEXT NOT NULL CHECK (length(trim(customer_number)) BETWEEN 1 AND 64),
  first_name TEXT NOT NULL CHECK (length(trim(first_name)) BETWEEN 1 AND 100),
  last_name TEXT NOT NULL CHECK (length(trim(last_name)) BETWEEN 1 AND 100),
  phone_number TEXT NOT NULL CHECK (phone_number ~ '^233[0-9]{9}$'),
  email TEXT,
  kyc_reference TEXT CHECK (kyc_reference IS NULL OR length(kyc_reference) <= 160),
  kyc_status institution_customer_kyc_status NOT NULL DEFAULT 'PENDING',
  kyc_note TEXT CHECK (kyc_note IS NULL OR length(kyc_note) <= 1000),
  notification_consent BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_staff_id UUID NOT NULL REFERENCES institution_staff(id) ON DELETE RESTRICT,
  verified_by_staff_id UUID REFERENCES institution_staff(id) ON DELETE RESTRICT,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (institution_id, customer_number),
  UNIQUE (institution_id, id),
  FOREIGN KEY (institution_id, branch_id) REFERENCES institution_branch(institution_id, id) ON DELETE RESTRICT,
  CHECK ((kyc_status = 'VERIFIED') = (verified_at IS NOT NULL AND verified_by_staff_id IS NOT NULL))
);
CREATE INDEX idx_institution_customers_daily_list
  ON institution_customers(institution_id, kyc_status, created_at DESC);
CREATE INDEX idx_institution_customers_branch
  ON institution_customers(institution_id, branch_id, created_at DESC);

CREATE TABLE institution_financial_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
  product_type institution_financial_product_type NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  currency CHAR(3) NOT NULL DEFAULT 'GHS' CHECK (currency = 'GHS'),
  min_amount_cents BIGINT NOT NULL CHECK (min_amount_cents > 0),
  max_amount_cents BIGINT NOT NULL CHECK (max_amount_cents >= min_amount_cents),
  annual_rate_basis_points INTEGER NOT NULL DEFAULT 0 CHECK (annual_rate_basis_points >= 0),
  min_term_days INTEGER,
  max_term_days INTEGER,
  min_balance_cents BIGINT NOT NULL DEFAULT 0 CHECK (min_balance_cents >= 0),
  withdrawals_per_month INTEGER CHECK (withdrawals_per_month IS NULL OR withdrawals_per_month > 0),
  max_active_accounts_per_customer SMALLINT NOT NULL DEFAULT 1 CHECK (max_active_accounts_per_customer BETWEEN 1 AND 100),
  status institution_financial_product_status NOT NULL DEFAULT 'DRAFT',
  created_by_staff_id UUID NOT NULL REFERENCES institution_staff(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (institution_id, id),
  CHECK (
    (product_type = 'LOAN' AND min_term_days BETWEEN 1 AND 36500 AND max_term_days BETWEEN min_term_days AND 36500)
    OR (product_type = 'SAVINGS' AND min_term_days IS NULL AND max_term_days IS NULL)
  )
);
CREATE INDEX idx_institution_products_available
  ON institution_financial_products(institution_id, product_type, status, name);

CREATE TABLE institution_financial_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
  customer_id UUID NOT NULL,
  product_id UUID NOT NULL,
  account_number TEXT NOT NULL CHECK (account_number ~ '^XG-[A-Z0-9]{12}$'),
  status institution_financial_account_status NOT NULL DEFAULT 'PENDING_APPROVAL',
  requested_amount_cents BIGINT NOT NULL CHECK (requested_amount_cents >= 0),
  contractual_due_cents BIGINT NOT NULL CHECK (contractual_due_cents >= requested_amount_cents),
  balance_cents BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  outstanding_cents BIGINT NOT NULL DEFAULT 0 CHECK (outstanding_cents >= 0),
  annual_rate_basis_points INTEGER NOT NULL CHECK (annual_rate_basis_points >= 0),
  term_days INTEGER,
  maturity_date DATE,
  created_by_staff_id UUID NOT NULL REFERENCES institution_staff(id) ON DELETE RESTRICT,
  approved_by_staff_id UUID REFERENCES institution_staff(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (institution_id, account_number),
  UNIQUE (institution_id, id),
  FOREIGN KEY (institution_id, customer_id) REFERENCES institution_customers(institution_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (institution_id, product_id) REFERENCES institution_financial_products(institution_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'PENDING_APPROVAL') = (approved_at IS NULL AND approved_by_staff_id IS NULL)),
  CHECK (requested_amount_cents > 0 OR contractual_due_cents = 0),
  CHECK (term_days IS NULL OR term_days > 0),
  CHECK (maturity_date IS NULL OR term_days IS NOT NULL)
);
CREATE INDEX idx_institution_accounts_daily_list
  ON institution_financial_accounts(institution_id, status, created_at DESC);
CREATE INDEX idx_institution_accounts_customer
  ON institution_financial_accounts(institution_id, customer_id, created_at DESC);

CREATE TABLE institution_financial_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
  account_id UUID NOT NULL,
  transaction_type institution_financial_transaction_type NOT NULL,
  status institution_financial_transaction_status NOT NULL DEFAULT 'PENDING_APPROVAL',
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  external_reference TEXT NOT NULL CHECK (length(trim(external_reference)) BETWEEN 3 AND 160),
  note TEXT CHECK (note IS NULL OR length(note) <= 1000),
  created_by_staff_id UUID NOT NULL REFERENCES institution_staff(id) ON DELETE RESTRICT,
  approved_by_staff_id UUID REFERENCES institution_staff(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ,
  rejection_note TEXT CHECK (rejection_note IS NULL OR length(rejection_note) <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (institution_id, account_id) REFERENCES institution_financial_accounts(institution_id, id) ON DELETE RESTRICT,
  UNIQUE (institution_id, external_reference),
  CHECK ((status = 'PENDING_APPROVAL') = (approved_at IS NULL AND approved_by_staff_id IS NULL)),
  CHECK ((status = 'REJECTED') = (rejection_note IS NOT NULL))
);
CREATE INDEX idx_institution_financial_transactions_queue
  ON institution_financial_transactions(institution_id, status, created_at DESC);
CREATE INDEX idx_institution_financial_transactions_account
  ON institution_financial_transactions(institution_id, account_id, created_at DESC);

CREATE TABLE institution_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
  created_by_staff_id UUID NOT NULL REFERENCES institution_staff(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
  body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 1000),
  channel TEXT NOT NULL CHECK (channel IN ('STAFF_IN_APP', 'CUSTOMER_SMS')),
  recipient_count INTEGER NOT NULL DEFAULT 0 CHECK (recipient_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (institution_id, id)
);
CREATE TABLE institution_notification_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL,
  notification_id UUID NOT NULL,
  customer_id UUID,
  staff_id UUID,
  status institution_notification_delivery_status NOT NULL DEFAULT 'PENDING',
  failure_reason TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (institution_id, notification_id) REFERENCES institution_notifications(institution_id, id) ON DELETE CASCADE,
  FOREIGN KEY (institution_id, customer_id) REFERENCES institution_customers(institution_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (staff_id) REFERENCES institution_staff(id) ON DELETE RESTRICT,
  CHECK ((customer_id IS NOT NULL)::int + (staff_id IS NOT NULL)::int = 1),
  CHECK ((status = 'SENT') = (sent_at IS NOT NULL))
);
CREATE INDEX idx_institution_notifications_recent
  ON institution_notifications(institution_id, created_at DESC);

COMMIT;
