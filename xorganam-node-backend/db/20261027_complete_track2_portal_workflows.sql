BEGIN;

CREATE TYPE dispute_channel AS ENUM ('APP', 'EMAIL');

ALTER TABLE institution_branch
  ADD COLUMN eganow_settlement_account_ref TEXT;

ALTER TABLE split_rules
  ADD COLUMN periodic_interval INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT chk_split_rule_periodic_interval CHECK (periodic_interval > 0);

ALTER TABLE institution_staff
  ADD CONSTRAINT uq_institution_staff_institution_id UNIQUE (institution_id, id);

ALTER TABLE tenant_institution_links
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD CONSTRAINT uq_tenant_institution_link_scope UNIQUE (id, tenant_id, institution_id);

UPDATE tenant_institution_links
   SET created_at = linked_at,
       updated_at = linked_at;

ALTER TABLE institution_member_assignment
  ADD COLUMN tenant_id UUID,
  ADD COLUMN assigned_by_staff_id UUID REFERENCES institution_staff(id) ON DELETE SET NULL;

UPDATE institution_member_assignment a
   SET tenant_id = l.tenant_id
  FROM tenant_institution_links l
 WHERE l.id = a.tenant_institution_link_id;

ALTER TABLE institution_member_assignment
  ALTER COLUMN tenant_id SET NOT NULL,
  ADD COLUMN escalated_to_supervisor_id UUID REFERENCES institution_staff(id) ON DELETE SET NULL,
  ADD COLUMN escalated_at TIMESTAMPTZ,
  ADD CONSTRAINT fk_member_assignment_link_scope
    FOREIGN KEY (tenant_institution_link_id, tenant_id, institution_id)
    REFERENCES tenant_institution_links (id, tenant_id, institution_id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_member_assignment_officer_scope
    FOREIGN KEY (institution_id, field_officer_staff_id)
    REFERENCES institution_staff (institution_id, id) ON DELETE RESTRICT;

ALTER TABLE institution_staff_hierarchy
  ADD CONSTRAINT fk_hierarchy_officer_scope
    FOREIGN KEY (institution_id, field_officer_staff_id)
    REFERENCES institution_staff (institution_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_hierarchy_supervisor_scope
    FOREIGN KEY (institution_id, supervisor_staff_id)
    REFERENCES institution_staff (institution_id, id) ON DELETE RESTRICT;

CREATE TABLE tenant_institution_link_verification_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_institution_link_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  institution_id UUID NOT NULL,
  merchant_id UUID NOT NULL,
  note TEXT,
  recorded_by_staff_id UUID REFERENCES institution_staff(id) ON DELETE SET NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_institution_link_id, tenant_id, institution_id)
    REFERENCES tenant_institution_links (id, tenant_id, institution_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, merchant_id)
    REFERENCES merchants (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_link_verification_evidence_link
  ON tenant_institution_link_verification_evidence (tenant_institution_link_id, recorded_at DESC);

ALTER TABLE institution_dispute
  ADD COLUMN channel dispute_channel NOT NULL DEFAULT 'EMAIL';

UPDATE institution_dispute
   SET channel = CASE WHEN raised_by_staff_id IS NULL THEN 'APP'::dispute_channel ELSE 'EMAIL'::dispute_channel END;

ALTER TABLE institution_dispute
  ADD CONSTRAINT chk_institution_dispute_at_most_one_raiser
    CHECK (raised_by_staff_id IS NULL OR raised_by_tenant_user_id IS NULL) NOT VALID,
  ADD CONSTRAINT chk_institution_dispute_status
    CHECK (status IN ('OPEN', 'UNDER_REVIEW', 'RESOLVED'));

ALTER TABLE institution_audit_log
  ADD COLUMN dispute_id UUID REFERENCES institution_dispute(id) ON DELETE CASCADE,
  ADD CONSTRAINT chk_institution_audit_at_most_one_subject
    CHECK (tenant_institution_link_id IS NULL OR dispute_id IS NULL) NOT VALID;

COMMIT;