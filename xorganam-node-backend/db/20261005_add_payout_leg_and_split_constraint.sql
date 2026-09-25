BEGIN;

CREATE TYPE payout_leg AS ENUM ('NONE', 'VENDOR', 'INSTITUTION');

ALTER TABLE transactions
  ADD COLUMN payout_leg payout_leg NOT NULL DEFAULT 'NONE';

ALTER TABLE transactions
  DROP CONSTRAINT uq_transactions_parent_type;

ALTER TABLE transactions
  ADD CONSTRAINT uq_transactions_parent_type_leg
  UNIQUE (parent_transaction_id, type, payout_leg);

ALTER TABLE transactions
  ADD CONSTRAINT chk_payout_leg_only_on_payout
  CHECK (type = 'PAYOUT' OR payout_leg = 'NONE');

COMMIT;