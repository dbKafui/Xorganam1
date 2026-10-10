ALTER TABLE institution_staff
  DROP CONSTRAINT IF EXISTS institution_staff_failed_login_attempts_nonnegative_chk;
ALTER TABLE institution_staff
  DROP COLUMN IF EXISTS login_locked_until,
  DROP COLUMN IF EXISTS failed_login_attempts;
