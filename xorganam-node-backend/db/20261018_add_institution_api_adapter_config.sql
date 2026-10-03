BEGIN;

CREATE TYPE institution_api_adapter_type AS ENUM ('GENERIC_REST', 'CUSTOM');

CREATE TABLE institution_api_adapter_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL UNIQUE REFERENCES institutions(id) ON DELETE CASCADE,
  adapter_type institution_api_adapter_type NOT NULL DEFAULT 'GENERIC_REST',
  base_url TEXT,
  auth_type TEXT,
  auth_config JSONB,
  request_template JSONB,
  response_active_path TEXT,
  response_detail_path TEXT,
  custom_adapter_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_institution_adapter_custom_key
    CHECK (adapter_type <> 'CUSTOM' OR custom_adapter_key IS NOT NULL),
  CONSTRAINT chk_institution_adapter_generic_config
    CHECK (adapter_type <> 'GENERIC_REST' OR (base_url IS NOT NULL AND request_template IS NOT NULL))
);

COMMIT;