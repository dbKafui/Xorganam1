ALTER TABLE institution_staff
  ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN login_locked_until TIMESTAMPTZ,
  ADD CONSTRAINT institution_staff_failed_login_attempts_nonnegative_chk
    CHECK (failed_login_attempts >= 0);
