ALTER TYPE transaction_status ADD VALUE IF NOT EXISTS 'UNKNOWN';
ALTER TYPE transaction_status ADD VALUE IF NOT EXISTS 'REJECTED';
ALTER TYPE transaction_status ADD VALUE IF NOT EXISTS 'VERIFICATION_BLOCKED';
ALTER TYPE transaction_status ADD VALUE IF NOT EXISTS 'MANUAL_RECONCILIATION_REQUIRED';

-- Some environments predate the partially-settled migration or recreated the type
-- without it. Keeping this guard here ensures any fresh database or drift repair
-- includes the status expected by settlement and reporting logic.
ALTER TYPE transaction_status ADD VALUE IF NOT EXISTS 'PARTIALLY_SETTLED';
