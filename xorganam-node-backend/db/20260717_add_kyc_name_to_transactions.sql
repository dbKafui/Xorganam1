-- Migration: add kyc_name to transactions so we can store name-enquiry results
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS kyc_name VARCHAR(255);

-- No backfill performed; existing rows will remain NULL. Application will
-- populate `kyc_name` on new collections when a name-enquiry returns a name.
