BEGIN;

WITH ranked_permissions AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY user_id, permission_type, resource_id
           ORDER BY granted_at DESC, created_at DESC, id DESC
         ) AS position
    FROM user_permissions
)
DELETE FROM user_permissions p
 USING ranked_permissions r
 WHERE p.id = r.id AND r.position > 1;

ALTER TABLE user_permissions
  DROP CONSTRAINT uq_user_permission;

CREATE UNIQUE INDEX uq_user_permission_scope
  ON user_permissions (user_id, permission_type, (COALESCE(resource_id::text, '')));

ALTER TABLE user_permissions
  ADD COLUMN expires_at TIMESTAMPTZ,
  ADD CONSTRAINT chk_user_permissions_expiry
    CHECK (expires_at IS NULL OR expires_at > granted_at);

CREATE INDEX idx_user_permissions_expiry
  ON user_permissions (expires_at)
  WHERE expires_at IS NOT NULL;

COMMIT;