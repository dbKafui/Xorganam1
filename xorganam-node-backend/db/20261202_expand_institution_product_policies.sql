BEGIN;

ALTER TABLE institution_financial_products
  ADD COLUMN tenor_options_months INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN late_fee_basis_points INTEGER NOT NULL DEFAULT 0 CHECK (late_fee_basis_points BETWEEN 0 AND 10000),
  ADD COLUMN grace_period_days INTEGER NOT NULL DEFAULT 0 CHECK (grace_period_days BETWEEN 0 AND 365),
  ADD COLUMN min_contribution_history_cents BIGINT NOT NULL DEFAULT 0 CHECK (min_contribution_history_cents >= 0),
  ADD CONSTRAINT institution_product_tenor_options_valid CHECK (
    cardinality(tenor_options_months) = 0 OR
    (array_position(tenor_options_months, 0) IS NULL AND array_position(tenor_options_months, NULL) IS NULL)
  );

ALTER TABLE institution_loan_installments ADD COLUMN late_fee_applied_at TIMESTAMPTZ;

COMMIT;
