BEGIN;

CREATE TABLE tenant_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);

CREATE INDEX idx_tenant_notifications_user_created
  ON tenant_notifications (user_id, created_at DESC);
CREATE INDEX idx_tenant_notifications_user_unread
  ON tenant_notifications (user_id, created_at DESC) WHERE read_at IS NULL;

COMMIT;
