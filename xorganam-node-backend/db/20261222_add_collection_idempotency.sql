BEGIN;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(128),
  ADD COLUMN IF NOT EXISTS idempotency_fingerprint CHAR(64);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_idempotency_pair_chk') THEN
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_idempotency_pair_chk
      CHECK ((idempotency_key IS NULL) = (idempotency_fingerprint IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_idempotency_fingerprint_chk') THEN
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_idempotency_fingerprint_chk
      CHECK (idempotency_fingerprint IS NULL OR idempotency_fingerprint ~ '^[a-f0-9]{64}$');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_merchant_idempotency_key
  ON transactions (merchant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMIT;
