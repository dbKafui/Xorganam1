BEGIN;

ALTER TABLE tenant_institution_links
  ADD COLUMN verification_sla_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN frequency_mode_min TEXT,
  ADD COLUMN frequency_mode_max TEXT,
  ADD COLUMN periodic_schedule_min JSONB,
  ADD COLUMN periodic_schedule_max JSONB,
  ADD COLUMN priority_deduction_allowed BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;