CREATE TABLE platform_demo_mfa_exemptions (
  principal_type TEXT NOT NULL CHECK (principal_type IN ('TENANT', 'INSTITUTION')),
  principal_id UUID NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_type, principal_id)
);
