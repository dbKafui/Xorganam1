BEGIN;

ALTER TABLE transactions
  ADD COLUMN credit_plan_id UUID REFERENCES credit_plans(id) ON DELETE RESTRICT,
  ADD COLUMN credit_installment_id UUID REFERENCES credit_plan_installments(id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_credit_installment_only_on_collection
    CHECK (credit_installment_id IS NULL OR type = 'COLLECTION'),
  ADD CONSTRAINT chk_credit_tags_both_present
    CHECK ((credit_plan_id IS NULL) = (credit_installment_id IS NULL)),
  ADD CONSTRAINT fk_transaction_credit_installment_plan
    FOREIGN KEY (credit_plan_id, credit_installment_id)
    REFERENCES credit_plan_installments (credit_plan_id, id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX uq_credit_installment_collection
  ON transactions (credit_installment_id)
  WHERE credit_installment_id IS NOT NULL AND type = 'COLLECTION' AND status <> 'FAILED';

COMMIT;
