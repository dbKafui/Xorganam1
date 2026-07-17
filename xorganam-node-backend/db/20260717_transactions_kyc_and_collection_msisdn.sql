ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS collection_msisdn VARCHAR(30),
  ADD COLUMN IF NOT EXISTS kyc_msisdn VARCHAR(30);

CREATE INDEX IF NOT EXISTS idx_transactions_collection_msisdn ON transactions (collection_msisdn);
CREATE INDEX IF NOT EXISTS idx_transactions_kyc_msisdn ON transactions (kyc_msisdn);
