CREATE TABLE user_role_change_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  requested_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  previous_role TEXT NOT NULL,
  requested_role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  review_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  CHECK ((status = 'PENDING' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL)
      OR (status <> 'PENDING' AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL)),
  CHECK (reviewed_by_user_id IS NULL OR reviewed_by_user_id <> requested_by_user_id),
  CHECK (status <> 'REJECTED' OR (review_reason IS NOT NULL AND length(trim(review_reason)) > 0))
);

CREATE UNIQUE INDEX uq_user_role_change_one_pending
  ON user_role_change_requests (user_id) WHERE status = 'PENDING';
CREATE INDEX idx_user_role_change_requests_queue
  ON user_role_change_requests (tenant_id, status, created_at DESC);
