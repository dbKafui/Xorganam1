CREATE TABLE kyc_document_review_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kyc_document_id UUID NOT NULL REFERENCES kyc_documents(id) ON DELETE RESTRICT,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  previous_status TEXT NOT NULL,
  next_status TEXT NOT NULL CHECK (next_status IN ('APPROVED', 'REJECTED')),
  rejection_reason TEXT,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((next_status = 'REJECTED') = (rejection_reason IS NOT NULL))
);

CREATE INDEX idx_kyc_review_history_document_time
  ON kyc_document_review_history (kyc_document_id, reviewed_at DESC);

CREATE OR REPLACE FUNCTION prevent_kyc_review_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'kyc_document_review_history is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER kyc_review_history_append_only
  BEFORE UPDATE OR DELETE ON kyc_document_review_history
  FOR EACH ROW EXECUTE FUNCTION prevent_kyc_review_history_mutation();
CREATE TRIGGER kyc_review_history_no_truncate
  BEFORE TRUNCATE ON kyc_document_review_history
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_kyc_review_history_mutation();
