ALTER TABLE institution_financial_transactions
  ADD COLUMN collection_method TEXT NOT NULL DEFAULT 'MOMO'
    CHECK (collection_method IN ('MOMO', 'CARD')),
  ADD COLUMN network_provider TEXT,
  ADD COLUMN payout_destination_type TEXT NOT NULL DEFAULT 'MOMO'
    CHECK (payout_destination_type IN ('MOMO', 'BANK')),
  ADD COLUMN payout_bank_code TEXT;