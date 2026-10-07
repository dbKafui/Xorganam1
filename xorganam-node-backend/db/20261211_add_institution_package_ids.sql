BEGIN;

-- Keep the database UUID as an internal join key. The package identifier used
-- by institutions is supplied by that institution and remains opaque to Xorganam.
ALTER TABLE institution_financial_products
  ADD COLUMN institution_package_id TEXT;

ALTER TABLE institution_financial_products
  ADD CONSTRAINT institution_financial_products_package_id_length
  CHECK (institution_package_id IS NULL OR length(trim(institution_package_id)) BETWEEN 1 AND 160);

CREATE UNIQUE INDEX uq_institution_financial_products_external_id
  ON institution_financial_products(institution_id, institution_package_id)
  WHERE institution_package_id IS NOT NULL;

COMMIT;
