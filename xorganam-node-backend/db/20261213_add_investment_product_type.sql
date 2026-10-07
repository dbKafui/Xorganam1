-- Keep enum extension separate so PostgreSQL commits the new label before
-- later migrations use it in constraints or queries.
ALTER TYPE institution_financial_product_type ADD VALUE IF NOT EXISTS 'INVESTMENT';
