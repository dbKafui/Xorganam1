BEGIN;

CREATE TABLE merchant_webhook_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  merchant_id UUID NOT NULL,
  url TEXT NOT NULL,
  secret_reference TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, merchant_id) REFERENCES merchants (tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, merchant_id)
);

CREATE TABLE credit_webhook_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  merchant_id UUID NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK (event_type IN ('installment.paid', 'installment.overdue', 'plan.completed')),
  payload JSONB NOT NULL,
  delivered_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, merchant_id) REFERENCES merchants (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_credit_webhook_outbox_pending
  ON credit_webhook_outbox (created_at) WHERE delivered_at IS NULL;

CREATE TABLE credit_reminder_delivery (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_plan_installment_id UUID NOT NULL REFERENCES credit_plan_installments(id) ON DELETE CASCADE,
  reminder_type TEXT NOT NULL CHECK (reminder_type IN ('PRE_DUE', 'DUE_TODAY')),
  reminder_date DATE NOT NULL,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (credit_plan_installment_id, reminder_type, reminder_date)
);

COMMIT;
