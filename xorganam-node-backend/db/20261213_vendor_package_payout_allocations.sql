BEGIN;

DO $$
DECLARE constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'institution_financial_products'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%product_type%'
  LOOP
    EXECUTE format('ALTER TABLE institution_financial_products DROP CONSTRAINT %I', constraint_row.conname);
  END LOOP;
END $$;

ALTER TABLE institution_financial_products
  ADD CONSTRAINT institution_financial_products_term_policy_check CHECK (
    (product_type = 'LOAN' AND min_term_days BETWEEN 1 AND 36500 AND max_term_days BETWEEN min_term_days AND 36500)
    OR (product_type IN ('SAVINGS', 'INVESTMENT') AND min_term_days IS NULL AND max_term_days IS NULL)
  );

ALTER TABLE institution_financial_accounts
  ADD COLUMN vendor_link_id UUID REFERENCES institution_member_merchant(id) ON DELETE RESTRICT;

CREATE INDEX idx_institution_accounts_merchant
  ON institution_financial_accounts(institution_id, vendor_link_id, status)
  WHERE vendor_link_id IS NOT NULL;

ALTER TABLE institution_split_financial_allocations
  DROP CONSTRAINT institution_split_financial_allocations_allocation_type_check,
  ADD CONSTRAINT institution_split_financial_allocations_allocation_type_check
    CHECK (allocation_type IN ('LOAN_REPAYMENT', 'SAVINGS_CONTRIBUTION', 'INVESTMENT_CONTRIBUTION'));
ALTER TABLE institution_split_financial_allocations
  ADD COLUMN status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('PENDING', 'POSTED'));

CREATE TABLE institution_vendor_payout_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL,
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  account_id UUID NOT NULL,
  trigger_mode TEXT NOT NULL CHECK (trigger_mode IN ('AUTO', 'MANUAL', 'BOTH')),
  frequency TEXT NOT NULL CHECK (frequency IN ('PER_PAYOUT', 'DAILY', 'WEEKLY', 'MONTHLY')),
  minimum_payout_cents BIGINT NOT NULL DEFAULT 0 CHECK (minimum_payout_cents >= 0),
  calculation_type TEXT NOT NULL CHECK (calculation_type IN ('FIXED', 'PERCENTAGE')),
  calculation_value BIGINT NOT NULL CHECK (
    (calculation_type = 'FIXED' AND calculation_value > 0)
    OR (calculation_type = 'PERCENTAGE' AND calculation_value BETWEEN 1 AND 10000)
  ),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (institution_id, account_id)
    REFERENCES institution_financial_accounts(institution_id, id) ON DELETE RESTRICT,
  UNIQUE (account_id)
);

CREATE INDEX idx_vendor_payout_rules_lookup
  ON institution_vendor_payout_rules(institution_id, merchant_id, active);

COMMIT;
