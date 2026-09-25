BEGIN;

CREATE TABLE institution_staff_hierarchy (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  field_officer_staff_id UUID NOT NULL REFERENCES institution_staff(id) ON DELETE CASCADE,
  supervisor_staff_id UUID NOT NULL REFERENCES institution_staff(id) ON DELETE RESTRICT,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_staff_hierarchy_period CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT chk_staff_hierarchy_distinct CHECK (field_officer_staff_id <> supervisor_staff_id)
);

CREATE UNIQUE INDEX uq_active_staff_hierarchy
  ON institution_staff_hierarchy (field_officer_staff_id)
  WHERE effective_to IS NULL;

CREATE TABLE institution_member (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  full_name TEXT,
  phone_number VARCHAR(30),
  status verification_status NOT NULL DEFAULT 'PENDING',
  verification_method TEXT,
  verified_at TIMESTAMPTZ,
  verified_by_staff_id UUID REFERENCES institution_staff(id) ON DELETE SET NULL,
  verified_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (institution_id, member_id)
);

CREATE TABLE institution_member_merchant (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES institution_member(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  merchant_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (institution_id, member_id, tenant_id, merchant_id),
  FOREIGN KEY (tenant_id, merchant_id) REFERENCES merchants (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE institution_member_assignment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  tenant_institution_link_id UUID NOT NULL REFERENCES tenant_institution_links(id) ON DELETE CASCADE,
  field_officer_staff_id UUID NOT NULL REFERENCES institution_staff(id) ON DELETE RESTRICT,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_member_assignment_period CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE UNIQUE INDEX uq_active_member_assignment
  ON institution_member_assignment (tenant_institution_link_id)
  WHERE effective_to IS NULL;

CREATE INDEX idx_member_assignment_officer
  ON institution_member_assignment (field_officer_staff_id, effective_to);

COMMIT;