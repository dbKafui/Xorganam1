BEGIN;

CREATE TYPE product_listing_type AS ENUM ('PHYSICAL', 'SERVICE');
CREATE TYPE order_status AS ENUM ('PENDING_PAYMENT', 'PLACED', 'FULFILLED', 'CANCELLED');
CREATE TYPE fulfillment_type AS ENUM ('PICKUP', 'DELIVERY');
CREATE TYPE review_target_type AS ENUM ('PRODUCT', 'VENDOR');
CREATE TYPE review_status AS ENUM ('VISIBLE', 'HIDDEN', 'PENDING_MODERATION');

ALTER TABLE merchants
  ADD COLUMN is_default_fulfillment_branch BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX uq_merchants_default_fulfillment_branch
  ON merchants (tenant_id) WHERE is_default_fulfillment_branch;

CREATE TABLE marketplace_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  parent_category_id UUID REFERENCES marketplace_categories(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  description TEXT CHECK (description IS NULL OR length(description) <= 10000),
  listing_type product_listing_type NOT NULL,
  price NUMERIC(18,2) NOT NULL CHECK (price > 0),
  category_id UUID REFERENCES marketplace_categories(id) ON DELETE SET NULL,
  visible BOOLEAN NOT NULL DEFAULT TRUE,
  featured BOOLEAN NOT NULL DEFAULT FALSE,
  sort_priority INTEGER NOT NULL DEFAULT 0,
  search_vector tsvector GENERATED ALWAYS AS
    (to_tsvector('english', coalesce(name, '') || ' ' || coalesce(description, ''))) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE INDEX idx_products_search_vector ON products USING GIN (search_vector);
CREATE INDEX idx_products_tenant_visible ON products (tenant_id, visible, created_at DESC);
CREATE INDEX idx_products_category ON products (category_id, featured DESC, sort_priority DESC, created_at DESC);

CREATE TABLE product_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url TEXT NOT NULL CHECK (length(url) <= 2048),
  alt_text TEXT NOT NULL DEFAULT '' CHECK (length(alt_text) <= 300),
  position SMALLINT NOT NULL DEFAULT 0 CHECK (position >= 0),
  UNIQUE (product_id, position)
);

CREATE TABLE storefronts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  slug TEXT NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 3 AND 60),
  marketplace_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
  branding_config JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(branding_config) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_storefront_slug_case_insensitive ON storefronts (lower(slug));

CREATE TABLE product_stock (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  merchant_id UUID NOT NULL,
  product_id UUID NOT NULL,
  quantity_available INTEGER NOT NULL DEFAULT 0 CHECK (quantity_available >= 0),
  unlimited_stock BOOLEAN NOT NULL DEFAULT FALSE,
  FOREIGN KEY (tenant_id, merchant_id) REFERENCES merchants (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id) ON DELETE CASCADE,
  UNIQUE (product_id, merchant_id)
);

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  merchant_id UUID NOT NULL,
  customer_identifier TEXT NOT NULL CHECK (customer_identifier ~ '^233[0-9]{9}$'),
  customer_name TEXT,
  fulfillment_type fulfillment_type NOT NULL,
  fulfillment_address TEXT,
  status order_status NOT NULL DEFAULT 'PENDING_PAYMENT',
  collection_transaction_id UUID REFERENCES transactions(id) ON DELETE RESTRICT,
  credit_plan_id UUID,
  payment_expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '15 minutes'),
  cancellation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, merchant_id) REFERENCES merchants (tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, id),
  CHECK ((fulfillment_type = 'DELIVERY') OR fulfillment_address IS NULL)
);

CREATE INDEX idx_orders_expiry ON orders (payment_expires_at) WHERE status = 'PENDING_PAYMENT';
CREATE INDEX idx_orders_tenant_created ON orders (tenant_id, created_at DESC);
CREATE INDEX idx_orders_merchant_status ON orders (tenant_id, merchant_id, status, created_at DESC);

ALTER TABLE transactions
  ADD COLUMN order_id UUID REFERENCES orders(id) ON DELETE RESTRICT;

CREATE INDEX idx_transactions_order_id ON transactions (order_id) WHERE order_id IS NOT NULL;

CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  order_id UUID NOT NULL,
  product_id UUID NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_at_purchase NUMERIC(18,2) NOT NULL CHECK (unit_price_at_purchase > 0),
  subtotal NUMERIC(18,2) NOT NULL CHECK (subtotal > 0),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (order_id, product_id)
);

CREATE TABLE order_payment_reconciliation_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  transaction_id UUID NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  resolution_note TEXT
);

CREATE INDEX idx_order_payment_reconciliation_open
  ON order_payment_reconciliation_flags (created_at) WHERE resolved_at IS NULL;

CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type review_target_type NOT NULL,
  product_id UUID,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  order_id UUID,
  customer_identifier TEXT NOT NULL CHECK (customer_identifier ~ '^233[0-9]{9}$'),
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT CHECK (comment IS NULL OR length(comment) <= 2000),
  status review_status NOT NULL DEFAULT 'PENDING_MODERATION',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  moderated_at TIMESTAMPTZ,
  moderated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  CHECK ((target_type = 'PRODUCT') = (product_id IS NOT NULL)),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX uq_product_review_per_order
  ON reviews (product_id, order_id, customer_identifier) WHERE target_type = 'PRODUCT' AND order_id IS NOT NULL;
CREATE UNIQUE INDEX uq_vendor_review_per_order
  ON reviews (tenant_id, order_id, customer_identifier) WHERE target_type = 'VENDOR' AND order_id IS NOT NULL;
CREATE INDEX idx_reviews_public_product ON reviews (product_id, created_at DESC) WHERE status = 'VISIBLE';
CREATE INDEX idx_reviews_public_vendor ON reviews (tenant_id, created_at DESC) WHERE status = 'VISIBLE';
CREATE INDEX idx_reviews_moderation ON reviews (created_at) WHERE status = 'PENDING_MODERATION';

CREATE OR REPLACE VIEW marketplace_listings AS
SELECT p.*, s.slug AS vendor_slug
  FROM products p
  JOIN storefronts s ON s.tenant_id = p.tenant_id
 WHERE s.marketplace_opt_in = TRUE AND p.visible = TRUE;

CREATE TABLE tenant_credit_plan_defaults (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  down_payment_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (down_payment_percent >= 0 AND down_payment_percent < 100),
  installment_count SMALLINT NOT NULL DEFAULT 4 CHECK (installment_count BETWEEN 1 AND 120),
  installment_frequency TEXT NOT NULL DEFAULT 'MONTHLY' CHECK (installment_frequency IN ('DAILY', 'WEEKLY', 'MONTHLY')),
  markup_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (markup_amount >= 0),
  late_fee_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (late_fee_amount >= 0),
  late_fee_grace_days SMALLINT NOT NULL DEFAULT 0 CHECK (late_fee_grace_days BETWEEN 0 AND 365),
  missed_installment_threshold SMALLINT NOT NULL DEFAULT 3 CHECK (missed_installment_threshold BETWEEN 1 AND 120),
  first_due_days SMALLINT NOT NULL DEFAULT 30 CHECK (first_due_days BETWEEN 1 AND 365),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
