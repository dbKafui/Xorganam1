BEGIN;

CREATE TYPE institution_loan_interest_model AS ENUM ('FLAT', 'REDUCING_BALANCE');
CREATE TYPE institution_loan_repayment_frequency AS ENUM ('WEEKLY', 'MONTHLY');

ALTER TABLE institution_financial_products
  ADD COLUMN loan_interest_model institution_loan_interest_model,
  ADD COLUMN repayment_frequency institution_loan_repayment_frequency,
  ADD COLUMN savings_lock_in_months INTEGER NOT NULL DEFAULT 0 CHECK (savings_lock_in_months >= 0),
  ADD COLUMN early_withdrawal_penalty_basis_points INTEGER NOT NULL DEFAULT 0 CHECK (early_withdrawal_penalty_basis_points BETWEEN 0 AND 10000);

ALTER TABLE institution_financial_accounts
  ADD COLUMN disbursed_at TIMESTAMPTZ,
  ADD COLUMN disbursement_transaction_id UUID REFERENCES institution_financial_transactions(id) ON DELETE RESTRICT;

ALTER TABLE institution_financial_transactions
  ADD COLUMN penalty_cents BIGINT NOT NULL DEFAULT 0 CHECK (penalty_cents >= 0);

ALTER TABLE institution_loan_installments
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE UNIQUE INDEX uq_institution_eganow_collection_wallet
  ON institutions(eganow_collection_account_id) WHERE eganow_collection_account_id IS NOT NULL;
CREATE UNIQUE INDEX uq_institution_eganow_payout_wallet
  ON institutions(eganow_payout_account_id) WHERE eganow_payout_account_id IS NOT NULL;

CREATE INDEX idx_institution_installments_account_unpaid
  ON institution_loan_installments(account_id, installment_number) WHERE status <> 'PAID';

COMMIT;
