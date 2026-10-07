BEGIN;

ALTER TABLE merchants ADD COLUMN vendor_reference TEXT;

UPDATE merchants
   SET vendor_reference =
       COALESCE(NULLIF(LEFT(REGEXP_REPLACE(UPPER(display_name), '[^A-Z]', '', 'g'), 4), ''), 'VEND')
       || '-VENDOR-'
       || TO_CHAR(onboarded_at AT TIME ZONE 'UTC', 'YYYYMMDD-HH24MISS')
       || '-'
       || UPPER(LEFT(REPLACE(gen_random_uuid()::text, '-', ''), 12));

ALTER TABLE merchants ALTER COLUMN vendor_reference SET NOT NULL;
CREATE UNIQUE INDEX uq_merchants_vendor_reference ON merchants(vendor_reference);

COMMIT;
