BEGIN;

CREATE TYPE institution_txn_type AS ENUM ('COLLECTION', 'PAYOUT');
CREATE TYPE institution_txn_status AS ENUM ('PENDING', 'RECEIVED', 'PAID_OUT', 'FAILED');

CREATE TABLE institution_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
  type institution_txn_type NOT NULL,
  status institution_txn_status NOT NULL DEFAULT 'PENDING',
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  internal_reference TEXT NOT NULL UNIQUE,
  eganow_reference TEXT,
  counterparty_transaction_id UUID REFERENCES transactions(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_institution_transactions_counterparty
  ON institution_transactions (counterparty_transaction_id)
  WHERE counterparty_transaction_id IS NOT NULL;

CREATE INDEX idx_institution_transactions_institution_created
  ON institution_transactions (institution_id, created_at DESC);

COMMIT;
