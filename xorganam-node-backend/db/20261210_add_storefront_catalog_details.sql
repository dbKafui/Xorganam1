BEGIN;

CREATE TABLE storefront_product_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX uq_storefront_product_categories_tenant_name
  ON storefront_product_categories (tenant_id, lower(name));

ALTER TABLE products
  ADD COLUMN storefront_category_id UUID REFERENCES storefront_product_categories(id) ON DELETE SET NULL,
  ADD COLUMN specifications JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(specifications) = 'object');

CREATE INDEX idx_products_storefront_category
  ON products (tenant_id, storefront_category_id, visible);

COMMIT;
