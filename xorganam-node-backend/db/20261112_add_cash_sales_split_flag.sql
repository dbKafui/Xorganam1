BEGIN;

ALTER TABLE tenant_institution_links
  ADD COLUMN cash_sales_included_in_split BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
