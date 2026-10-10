import { query } from '../db/pool.js'

export function isLoginLocked(lockedUntil, now = Date.now()) {
  return Boolean(lockedUntil && new Date(lockedUntil).getTime() > now)
}

export async function recordFailedLogin(userId, policy) {
  const { rows } = await query(
    `UPDATE users
        SET failed_login_attempts = CASE
              WHEN login_locked_until IS NOT NULL AND login_locked_until <= now() THEN 1
              ELSE failed_login_attempts + 1
            END,
            login_locked_until = CASE
              WHEN (CASE WHEN login_locked_until IS NOT NULL AND login_locked_until <= now()
                         THEN 1 ELSE failed_login_attempts + 1 END) >= $2
              THEN now() + ($3::bigint * interval '1 millisecond')
              ELSE NULL
            END
      WHERE id = $1
      RETURNING failed_login_attempts, login_locked_until`,
    [userId, policy.loginFailureThreshold, policy.loginLockoutDurationMs]
  )
  return rows[0] || null
}

export async function clearFailedLoginState(userId) {
  await query(
    'UPDATE users SET failed_login_attempts = 0, login_locked_until = NULL WHERE id = $1',
    [userId]
  )
}

export async function recordFailedInstitutionLogin(staffId, policy) {
  const { rows } = await query(
    `UPDATE institution_staff
        SET failed_login_attempts = CASE
              WHEN login_locked_until IS NOT NULL AND login_locked_until <= now() THEN 1
              ELSE failed_login_attempts + 1
            END,
            login_locked_until = CASE
              WHEN (CASE WHEN login_locked_until IS NOT NULL AND login_locked_until <= now()
                         THEN 1 ELSE failed_login_attempts + 1 END) >= $2
              THEN now() + ($3::bigint * interval '1 millisecond')
              ELSE NULL
            END
      WHERE id = $1
      RETURNING failed_login_attempts, login_locked_until`,
    [staffId, policy.loginFailureThreshold, policy.loginLockoutDurationMs]
  )
  return rows[0] || null
}

export async function clearFailedInstitutionLoginState(staffId) {
  await query(
    'UPDATE institution_staff SET failed_login_attempts = 0, login_locked_until = NULL WHERE id = $1',
    [staffId]
  )
}
