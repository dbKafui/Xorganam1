BEGIN;

ALTER TABLE split_rules
  ADD CONSTRAINT chk_split_rule_periodic_schedule
  CHECK (
    mode <> 'PERIODIC'
    OR (
      periodic_frequency IS NOT NULL
      AND periodic_frequency IN ('DAYS', 'WEEKS', 'MONTHS', 'YEARS')
      AND (
        (periodic_frequency = 'DAYS' AND periodic_day_of_week IS NULL AND periodic_day_of_month IS NULL)
        OR periodic_frequency IN ('WEEKS', 'MONTHS', 'YEARS')
      )
    )
  );

ALTER TABLE tenant_merchant_settlement_config
  ADD CONSTRAINT chk_settlement_frequency_mode
  CHECK (frequency_mode IN ('PER_TRANSACTION', 'PERIODIC'));

ALTER TABLE tenant_merchant_settlement_config
  ADD CONSTRAINT chk_settlement_periodic_schedule
  CHECK (
    frequency_mode <> 'PERIODIC'
    OR (
      periodic_schedule IS NOT NULL
      AND periodic_schedule ? 'unit'
      AND periodic_schedule ? 'interval'
      AND periodic_schedule->>'unit' IN ('DAYS', 'WEEKS', 'MONTHS', 'YEARS')
      AND (periodic_schedule->>'interval')::integer > 0
    )
  );

ALTER TABLE institution_policy
  ADD CONSTRAINT chk_policy_frequency_bounds
  CHECK (
    frequency_mode_min IS NULL OR frequency_mode_min IN ('PER_TRANSACTION', 'PERIODIC')
  ),
  ADD CONSTRAINT chk_policy_frequency_max
  CHECK (
    frequency_mode_max IS NULL OR frequency_mode_max IN ('PER_TRANSACTION', 'PERIODIC')
  );

COMMENT ON COLUMN tenant_merchant_settlement_config.periodic_schedule IS
  'Schedule object: {unit: DAYS|WEEKS|MONTHS|YEARS, interval: positive integer}.';

COMMIT;
