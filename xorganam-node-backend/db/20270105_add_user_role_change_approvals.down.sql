DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM user_role_change_requests) THEN
    RAISE EXCEPTION 'Cannot roll back populated role-change approval history.';
  END IF;
END;
$$;
DROP TABLE IF EXISTS user_role_change_requests;
