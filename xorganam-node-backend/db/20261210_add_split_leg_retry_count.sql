BEGIN;

ALTER TABLE transactions
  ADD COLUMN payout_retry_count INTEGER NOT NULL DEFAULT 0 CHECK (payout_retry_count >= 0);

COMMIT;
