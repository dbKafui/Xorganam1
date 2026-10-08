BEGIN;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(128),
  ADD COLUMN IF NOT EXISTS idempotency_fingerprint CHAR(64);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_idempotency_pair_chk') THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_idempotency_pair_chk
      CHECK ((idempotency_key IS NULL) = (idempotency_fingerprint IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_idempotency_fingerprint_chk') THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_idempotency_fingerprint_chk
      CHECK (idempotency_fingerprint IS NULL OR idempotency_fingerprint ~ '^[a-f0-9]{64}$');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_tenant_idempotency_key
  ON orders (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

COMMIT;
