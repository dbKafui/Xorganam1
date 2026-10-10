function positiveInteger(value, name, fallback) {
  const raw = value ?? String(fallback)
  const parsed = Number(raw)
  if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`)
  }
  return parsed
}

export function parseAuthPolicy(environment = process.env) {
  return Object.freeze({
    loginFailureThreshold: positiveInteger(environment.LOGIN_FAILURE_THRESHOLD, 'LOGIN_FAILURE_THRESHOLD', 5),
    loginLockoutDurationMs: positiveInteger(environment.LOGIN_LOCKOUT_DURATION_MS, 'LOGIN_LOCKOUT_DURATION_MS', 900000),
    maxActiveSessions: positiveInteger(environment.MAX_ACTIVE_SESSIONS, 'MAX_ACTIVE_SESSIONS', 5),
    globalSearchResultLimit: positiveInteger(environment.GLOBAL_SEARCH_RESULT_LIMIT, 'GLOBAL_SEARCH_RESULT_LIMIT', 20),
    emailVerificationTokenTtlMs: positiveInteger(environment.EMAIL_VERIFICATION_TOKEN_TTL_MS, 'EMAIL_VERIFICATION_TOKEN_TTL_MS', 1800000),
    emailVerificationRequestLimit: positiveInteger(environment.EMAIL_VERIFICATION_REQUEST_LIMIT, 'EMAIL_VERIFICATION_REQUEST_LIMIT', 3),
    emailVerificationRateWindowMs: positiveInteger(environment.EMAIL_VERIFICATION_RATE_WINDOW_MS, 'EMAIL_VERIFICATION_RATE_WINDOW_MS', 3600000),
    passwordResetTokenTtlMs: positiveInteger(environment.PASSWORD_RESET_TOKEN_TTL_MS, 'PASSWORD_RESET_TOKEN_TTL_MS', 1800000),
    passwordResetRequestLimit: positiveInteger(environment.PASSWORD_RESET_REQUEST_LIMIT, 'PASSWORD_RESET_REQUEST_LIMIT', 3),
    passwordResetRateWindowMs: positiveInteger(environment.PASSWORD_RESET_RATE_WINDOW_MS, 'PASSWORD_RESET_RATE_WINDOW_MS', 3600000)
  })
}

export const authPolicy = parseAuthPolicy()
