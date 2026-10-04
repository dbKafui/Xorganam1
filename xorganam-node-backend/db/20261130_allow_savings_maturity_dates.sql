BEGIN;

DO $$
DECLARE constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'institution_financial_accounts'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%maturity_date%term_days%'
  LOOP
    EXECUTE format('ALTER TABLE institution_financial_accounts DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

COMMIT;
