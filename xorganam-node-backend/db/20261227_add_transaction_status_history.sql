BEGIN;

CREATE TABLE transaction_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
  tenant_id UUID NOT NULL,
  merchant_id UUID NOT NULL,
  previous_status transaction_status,
  next_status transaction_status NOT NULL,
  payment_gateway_status TEXT,
  failure_reason TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, merchant_id) REFERENCES merchants (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_transaction_status_history_tenant_time
  ON transaction_status_history (tenant_id, changed_at DESC);
CREATE INDEX idx_transaction_status_history_transaction_time
  ON transaction_status_history (transaction_id, changed_at DESC);

INSERT INTO transaction_status_history (
  transaction_id, tenant_id, merchant_id, previous_status, next_status,
  payment_gateway_status, failure_reason, changed_at
)
SELECT id, tenant_id, merchant_id, NULL, status, payment_gateway_status, failure_reason,
       COALESCE(updated_at, completed_at, created_at, now())
  FROM transactions;

CREATE OR REPLACE FUNCTION record_transaction_status_insert()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO transaction_status_history (
    transaction_id, tenant_id, merchant_id, previous_status, next_status,
    payment_gateway_status, failure_reason
  ) VALUES (
    NEW.id, NEW.tenant_id, NEW.merchant_id, NULL, NEW.status,
    NEW.payment_gateway_status, NEW.failure_reason
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION record_transaction_status_update()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO transaction_status_history (
      transaction_id, tenant_id, merchant_id, previous_status, next_status,
      payment_gateway_status, failure_reason
    ) VALUES (
      NEW.id, NEW.tenant_id, NEW.merchant_id, OLD.status, NEW.status,
      NEW.payment_gateway_status, NEW.failure_reason
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_transaction_status_history_insert
  AFTER INSERT ON transactions
  FOR EACH ROW EXECUTE FUNCTION record_transaction_status_insert();

CREATE TRIGGER trg_transaction_status_history_update
  AFTER UPDATE OF status ON transactions
  FOR EACH ROW EXECUTE FUNCTION record_transaction_status_update();

CREATE OR REPLACE FUNCTION prevent_transaction_status_history_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'transaction_status_history is append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_transaction_status_history_append_only
  BEFORE UPDATE OR DELETE ON transaction_status_history
  FOR EACH ROW EXECUTE FUNCTION prevent_transaction_status_history_mutation();

CREATE TRIGGER trg_transaction_status_history_no_truncate
  BEFORE TRUNCATE ON transaction_status_history
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_transaction_status_history_mutation();

COMMIT;