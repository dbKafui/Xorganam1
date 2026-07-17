apply ALTER TYPE transaction_status ADD VALUE IF NOT EXISTS 'PENDING' BEFORE 'RECEIVED';

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS payment_gateway_status VARCHAR(100);

DROP INDEX IF EXISTS idx_transactions_status;
CREATE INDEX idx_transactions_status
  ON transactions (status)
  WHERE status IN ('PENDING', 'RECEIVED', 'SWEPT_INTERNAL');
