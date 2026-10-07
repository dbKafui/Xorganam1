BEGIN;

CREATE TYPE institution_notification_event AS ENUM (
  'CONTRIBUTION_REMINDER', 'REPAYMENT_DUE', 'REPAYMENT_OVERDUE',
  'SAVINGS_MATURITY', 'VERIFICATION_APPROVED', 'VERIFICATION_REJECTED', 'DISPUTE_UPDATE'
);

CREATE TYPE institution_savings_frequency AS ENUM ('PER_TRANSACTION', 'DAILY', 'WEEKLY', 'MONTHLY');

ALTER TABLE institution_financial_products
  ADD COLUMN contribution_frequency institution_savings_frequency NOT NULL DEFAULT 'PER_TRANSACTION';

CREATE TABLE institution_notification_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  event institution_notification_event NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  template_text TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'SMS' CHECK (channel = 'SMS'),
  updated_by_staff_id UUID REFERENCES institution_staff(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (institution_id, event),
  CHECK (length(template_text) BETWEEN 1 AND 500)
);

CREATE TABLE institution_notification_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES institution_customers(id) ON DELETE CASCADE,
  event institution_notification_event NOT NULL,
  sent_at TIMESTAMPTZ,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivery_status TEXT NOT NULL CHECK (delivery_status IN ('PENDING', 'SENT', 'FAILED')),
  failure_reason TEXT,
  sent_by_user_id UUID REFERENCES institution_staff(id) ON DELETE SET NULL,
  dedupe_key TEXT UNIQUE
);

CREATE INDEX idx_institution_notification_log_scope
  ON institution_notification_log(institution_id, customer_id, attempted_at DESC);

COMMIT;
