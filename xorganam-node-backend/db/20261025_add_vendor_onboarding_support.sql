BEGIN;
CREATE TYPE merchant_account_setup_status AS ENUM ('PENDING', 'ACTIVE');

ALTER TABLE merchants
  ALTER COLUMN eganow_collection_account_id DROP NOT NULL,
  ALTER COLUMN eganow_payout_account_id DROP NOT NULL,
  ADD COLUMN account_setup_status merchant_account_setup_status NOT NULL DEFAULT 'PENDING';

UPDATE merchants
   SET account_setup_status = 'ACTIVE'
 WHERE eganow_collection_account_id IS NOT NULL
   AND eganow_payout_account_id IS NOT NULL;

ALTER TABLE merchants
  ADD CONSTRAINT chk_merchant_active_requires_accounts
  CHECK (account_setup_status <> 'ACTIVE'
         OR (eganow_collection_account_id IS NOT NULL AND eganow_payout_account_id IS NOT NULL));

ALTER TABLE institution_staff ADD COLUMN referral_code TEXT UNIQUE;
ALTER TABLE tenant_institution_links
  ADD COLUMN sourced_by_staff_id UUID REFERENCES institution_staff(id) ON DELETE SET NULL,
  ADD COLUMN source_channel TEXT NOT NULL DEFAULT 'TENANT_INITIATED'
    CHECK (source_channel IN ('TENANT_INITIATED', 'FIELD_QR', 'FIELD_REFERRAL_CODE'));
COMMIT;
