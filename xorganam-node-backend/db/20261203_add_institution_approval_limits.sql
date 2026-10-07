BEGIN;

ALTER TABLE institutions
  ADD COLUMN supervisor_approval_limit_cents BIGINT NOT NULL DEFAULT 0 CHECK (supervisor_approval_limit_cents >= 0);

COMMIT;
