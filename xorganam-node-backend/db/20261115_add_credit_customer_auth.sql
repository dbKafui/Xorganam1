BEGIN;

CREATE TABLE credit_customer_auth_challenges (
  customer_identifier TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  failed_attempts SMALLINT NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  consumed_at TIMESTAMPTZ
);

COMMIT;
