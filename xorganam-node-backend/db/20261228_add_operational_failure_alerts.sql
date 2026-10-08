BEGIN;

CREATE TABLE operational_failure_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_name TEXT NOT NULL CHECK (length(queue_name) BETWEEN 1 AND 100),
  job_id TEXT NOT NULL CHECK (length(job_id) BETWEEN 1 AND 200),
  job_name TEXT NOT NULL DEFAULT '',
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
  transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  attempts_made INTEGER NOT NULL DEFAULT 0 CHECK (attempts_made >= 0),
  error_code TEXT NOT NULL DEFAULT 'WORKER_ERROR',
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  resolution_note TEXT,
  resolved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (queue_name, job_id),
  FOREIGN KEY (tenant_id, merchant_id) REFERENCES merchants (tenant_id, id) ON DELETE SET NULL,
  CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL)),
  CHECK (status <> 'RESOLVED' OR (resolved_by_user_id IS NOT NULL AND length(trim(resolution_note)) >= 5))
);

CREATE INDEX idx_operational_failures_tenant_status_created
  ON operational_failure_alerts (tenant_id, status, created_at DESC);
CREATE INDEX idx_operational_failures_status_created
  ON operational_failure_alerts (status, created_at DESC);

COMMIT;