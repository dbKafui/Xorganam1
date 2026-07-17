-- Ensure collection child transactions have a unique parent/type combination.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_transactions_parent_type'
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT uq_transactions_parent_type UNIQUE (parent_transaction_id, type);
  END IF;
END;
$$;
