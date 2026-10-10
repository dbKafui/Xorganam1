ALTER TABLE institution_financial_transactions
  DROP COLUMN IF EXISTS payout_bank_code,
  DROP COLUMN IF EXISTS payout_destination_type,
  DROP COLUMN IF EXISTS network_provider,
  DROP COLUMN IF EXISTS collection_method;