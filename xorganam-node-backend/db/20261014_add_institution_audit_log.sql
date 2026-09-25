BEGIN;

CREATE TABLE institution_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  tenant_institution_link_id UUID REFERENCES tenant_institution_links(id) ON DELETE SET NULL,
  actor_staff_id UUID REFERENCES institution_staff(id) ON DELETE SET NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  note JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_institution_audit_institution_created
  ON institution_audit_log (institution_id, created_at DESC);

CREATE INDEX idx_institution_audit_link_created
  ON institution_audit_log (tenant_institution_link_id, created_at DESC);

COMMIT;