BEGIN;

ALTER TABLE credit_plans
  ADD COLUMN order_id UUID REFERENCES orders(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX uq_credit_plans_order
  ON credit_plans (order_id) WHERE order_id IS NOT NULL;

ALTER TABLE orders
  ADD CONSTRAINT fk_orders_credit_plan
    FOREIGN KEY (credit_plan_id) REFERENCES credit_plans(id) ON DELETE RESTRICT;

ALTER TABLE transactions
  DROP CONSTRAINT chk_credit_tags_both_present,
  ADD CONSTRAINT chk_credit_tags_both_present
    CHECK (
      (credit_plan_id IS NULL AND credit_installment_id IS NULL)
      OR (credit_plan_id IS NOT NULL AND (credit_installment_id IS NOT NULL OR order_id IS NOT NULL))
    ),
  ADD CONSTRAINT chk_credit_plan_only_on_collection
    CHECK (credit_plan_id IS NULL OR type = 'COLLECTION'),
  ADD CONSTRAINT fk_transaction_order_tenant
    FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX uq_order_active_collection
  ON transactions (order_id) WHERE order_id IS NOT NULL AND type = 'COLLECTION' AND status <> 'FAILED';

CREATE OR REPLACE VIEW credit_customer_balance AS
SELECT cp.tenant_id, cp.merchant_id, cp.customer_identifier, cp.id AS credit_plan_id,
       cp.status AS plan_status,
       COALESCE(SUM(cpi.amount_due) FILTER (WHERE cpi.status IN ('PENDING', 'OVERDUE')), 0) AS outstanding_promised,
       COALESCE(SUM(cpi.amount_due) FILTER (WHERE cpi.status = 'PAID'), 0) AS actually_collected,
       COUNT(*) FILTER (WHERE cpi.status = 'OVERDUE')::int AS overdue_installment_count
  FROM credit_plans cp
  JOIN credit_plan_installments cpi ON cpi.credit_plan_id = cp.id
 WHERE cp.status <> 'CANCELLED'
 GROUP BY cp.tenant_id, cp.merchant_id, cp.customer_identifier, cp.id, cp.status;

CREATE OR REPLACE VIEW merchant_credit_exposure AS
SELECT tenant_id, merchant_id,
       SUM(outstanding_promised) AS total_outstanding_promised,
       SUM(actually_collected) AS total_actually_collected
  FROM credit_customer_balance
 GROUP BY tenant_id, merchant_id;

COMMIT;
