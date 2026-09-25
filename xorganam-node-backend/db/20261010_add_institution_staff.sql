BEGIN;

CREATE TYPE institution_role AS ENUM ('INSTITUTION_ADMIN', 'SUPERVISOR', 'FIELD_OFFICER');

CREATE TABLE institution_branch (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT,
  address TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (institution_id, name),
  UNIQUE (institution_id, code),
  UNIQUE (institution_id, id)
);

CREATE TABLE institution_staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES institution_branch(id) ON DELETE SET NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  phone_number VARCHAR(30),
  password_hash VARCHAR(255) NOT NULL,
  role institution_role NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_institution_staff_institution ON institution_staff (institution_id);
CREATE INDEX idx_institution_staff_active ON institution_staff (institution_id, is_active);

ALTER TABLE institution_staff
  ADD CONSTRAINT fk_institution_staff_branch_institution
  FOREIGN KEY (institution_id, branch_id)
  REFERENCES institution_branch (institution_id, id);

COMMIT;