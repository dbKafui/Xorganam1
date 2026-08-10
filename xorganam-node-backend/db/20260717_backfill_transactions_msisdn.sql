-- Backfill collection_msisdn and kyc_msisdn from raw_webhook_payload when present
-- Attempts common key names used by Eganow payloads.

UPDATE transactions
   SET collection_msisdn = COALESCE(
        collection_msisdn,
        (raw_webhook_payload->> 'AccountNoOrCardNoOrMSISDN'),
        (raw_webhook_payload->> 'accountNoOrCardNoOrMSISDN'),
        (raw_webhook_payload->> 'MobileNumber'),
        (raw_webhook_payload->> 'mobileNumber')
      )
 WHERE collection_msisdn IS NULL
   AND raw_webhook_payload IS NOT NULL;

-- KYC mobile number often available in KYC webhook shapes; set kyc_msisdn where missing
UPDATE transactions
   SET kyc_msisdn = COALESCE(
        kyc_msisdn,
        (raw_webhook_payload->> 'MobileNumber'),
        (raw_webhook_payload->> 'mobileNumber')
      )
 WHERE kyc_msisdn IS NULL
   AND raw_webhook_payload IS NOT NULL;

-- Normalize to E.164-like for rows that look like local (starting with 0xxx)
-- This is a best-effort normalization; adjust as needed for your locales.
UPDATE transactions
   SET collection_msisdn = regexp_replace(collection_msisdn, '^0+', '233')
 WHERE collection_msisdn IS NOT NULL
   AND collection_msisdn ~ '^0[0-9]+';

UPDATE transactions
   SET kyc_msisdn = regexp_replace(kyc_msisdn, '^0+', '233')
 WHERE kyc_msisdn IS NOT NULL
   AND kyc_msisdn ~ '^0[0-9]+';

-- Create indexes if not already present (safe to run repeatedly)
CREATE INDEX IF NOT EXISTS idx_transactions_collection_msisdn ON transactions (collection_msisdn);
CREATE INDEX IF NOT EXISTS idx_transactions_kyc_msisdn ON transactions (kyc_msisdn);
