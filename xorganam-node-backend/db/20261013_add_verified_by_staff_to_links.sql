BEGIN;

ALTER TABLE tenant_institution_links
  ADD COLUMN verified_by_staff_id UUID REFERENCES institution_staff(id) ON DELETE SET NULL;

COMMIT;