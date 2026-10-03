BEGIN;

CREATE TABLE institution_dispute (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  merchant_id UUID NOT NULL,
  transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  raised_by_staff_id UUID REFERENCES institution_staff(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  reason TEXT NOT NULL,
  resolution_note TEXT,
  resolved_by_staff_id UUID REFERENCES institution_staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  FOREIGN KEY (tenant_id, merchant_id) REFERENCES merchants (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_institution_dispute_scope
  ON institution_dispute (institution_id, status, created_at DESC);

COMMIT;