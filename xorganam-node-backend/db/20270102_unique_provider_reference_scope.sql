DO $$
BEGIN
  IF EXISTS (
    SELECT tenant_id, merchant_id, eganow_reference
      FROM transactions
     WHERE eganow_reference IS NOT NULL
     GROUP BY tenant_id, merchant_id, eganow_reference
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate Eganow references exist; resolve them before applying 20270102_unique_provider_reference_scope.sql.';
  END IF;
END;
$$;

CREATE UNIQUE INDEX uq_transactions_provider_reference_scope
  ON transactions (tenant_id, merchant_id, eganow_reference)
  WHERE eganow_reference IS NOT NULL;
