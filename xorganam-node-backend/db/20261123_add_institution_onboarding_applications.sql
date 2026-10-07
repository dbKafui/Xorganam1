BEGIN;

CREATE TYPE institution_onboarding_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE institution_onboarding_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_name TEXT NOT NULL CHECK (length(trim(institution_name)) BETWEEN 2 AND 160),
  institution_type institution_type NOT NULL,
  settlement_msisdn TEXT NOT NULL CHECK (settlement_msisdn ~ '^233[0-9]{9}$'),
  settlement_account_name TEXT NOT NULL CHECK (length(trim(settlement_account_name)) BETWEEN 2 AND 160),
  admin_first_name TEXT NOT NULL CHECK (length(trim(admin_first_name)) BETWEEN 1 AND 100),
  admin_last_name TEXT NOT NULL CHECK (length(trim(admin_last_name)) BETWEEN 1 AND 100),
  admin_email VARCHAR(255) NOT NULL CHECK (admin_email = lower(admin_email)),
  admin_password_hash VARCHAR(255),
  status institution_onboarding_status NOT NULL DEFAULT 'PENDING',
  tracking_token_hash CHAR(64) NOT NULL,
  institution_id UUID REFERENCES institutions(id) ON DELETE RESTRICT,
  reviewer_note TEXT,
  reviewed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  CHECK ((status = 'PENDING') = (admin_password_hash IS NOT NULL)),
  CHECK ((status = 'APPROVED') = (institution_id IS NOT NULL)),
  CHECK (status <> 'REJECTED' OR (reviewer_note IS NOT NULL AND length(trim(reviewer_note)) > 0))
);

CREATE UNIQUE INDEX uq_institution_onboarding_tracking_token
  ON institution_onboarding_applications (tracking_token_hash);
CREATE UNIQUE INDEX uq_institution_onboarding_pending_email
  ON institution_onboarding_applications (admin_email) WHERE status = 'PENDING';
CREATE INDEX idx_institution_onboarding_review_queue
  ON institution_onboarding_applications (created_at) WHERE status = 'PENDING';

COMMIT;
