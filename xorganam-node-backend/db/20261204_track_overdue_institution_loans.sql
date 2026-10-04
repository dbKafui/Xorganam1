BEGIN;

ALTER TYPE institution_financial_account_status ADD VALUE IF NOT EXISTS 'OVERDUE';

COMMIT;
