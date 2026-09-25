BEGIN;

ALTER TABLE institutions
  ADD COLUMN verification_sla_hours INTEGER NOT NULL DEFAULT 48,
  ADD CONSTRAINT chk_institution_verification_sla_positive CHECK (verification_sla_hours > 0);

COMMIT;