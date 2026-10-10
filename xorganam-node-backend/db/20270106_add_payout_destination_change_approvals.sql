CREATE TABLE merchant_payout_destination_change_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  requested_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  previous_mobile_money_number TEXT NOT NULL,
  requested_mobile_money_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  review_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  CHECK (previous_mobile_money_number <> requested_mobile_money_number),
  CHECK (reviewed_by_user_id IS NULL OR reviewed_by_user_id <> requested_by_user_id),
  CHECK ((status = 'PENDING' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL)
      OR (status <> 'PENDING' AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL)),
  CHECK (status <> 'REJECTED' OR (review_reason IS NOT NULL AND length(trim(review_reason)) > 0))
);

CREATE UNIQUE INDEX uq_merchant_payout_destination_pending
  ON merchant_payout_destination_change_requests (merchant_id) WHERE status = 'PENDING';
CREATE INDEX idx_merchant_payout_destination_queue
  ON merchant_payout_destination_change_requests (tenant_id, status, created_at DESC);
