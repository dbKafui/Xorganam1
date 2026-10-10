DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM kyc_document_review_history) THEN
    RAISE EXCEPTION 'Cannot roll back populated KYC review history without losing audit evidence.';
  END IF;
END;
$$;
DROP TRIGGER IF EXISTS kyc_review_history_no_truncate ON kyc_document_review_history;
DROP TRIGGER IF EXISTS kyc_review_history_append_only ON kyc_document_review_history;
DROP FUNCTION IF EXISTS prevent_kyc_review_history_mutation();
DROP TABLE IF EXISTS kyc_document_review_history;
