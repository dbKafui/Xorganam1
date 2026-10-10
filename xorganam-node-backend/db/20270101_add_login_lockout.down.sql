ALTER TABLE users DROP CONSTRAINT IF EXISTS users_failed_login_attempts_nonnegative_chk;
ALTER TABLE users DROP COLUMN IF EXISTS login_locked_until;
ALTER TABLE users DROP COLUMN IF EXISTS failed_login_attempts;
