import { query } from '../db/pool.js'
import { refreshEganowTokenForTenant } from '../services/eganowClient.js'

const TOKEN_REFRESH_INTERVAL_MS = Number.parseInt(
  process.env.EGANOW_TOKEN_REFRESH_INTERVAL_MS || String(40 * 60 * 1000),
  10
)
const TOKEN_REFRESH_INITIAL_DELAY_MS = Number.parseInt(
  process.env.EGANOW_TOKEN_REFRESH_INITIAL_DELAY_MS || '15000',
  10
)

let refreshTimer = null
let refreshInFlight = false

async function refreshAllEganowTokens() {
  if (refreshInFlight) {
    return { skipped: true, reason: 'refresh-in-flight' }
  }

  refreshInFlight = true

  try {
    const { rows } = await query(
      `SELECT t.id
         FROM tenants t
         JOIN tenant_eganow_credentials c ON c.tenant_id = t.id
        WHERE t.status = 'ACTIVE'
          AND COALESCE(c.is_enabled, FALSE) = TRUE`
    )

    if (!rows.length) {
      return { refreshed: 0, tenants: [] }
    }

    let refreshedCount = 0
    for (const row of rows) {
      try {
        await refreshEganowTokenForTenant(row.id)
        refreshedCount += 1
      } catch (err) {
        // Tenant identifiers and provider errors can disclose integration details in shared logs.
        console.warn('[eganow-token-worker] token refresh failed', { code: err?.code || 'TOKEN_REFRESH_ERROR' })
      }
    }

    console.log('[eganow-token-worker] token refresh pass completed', { count: refreshedCount })

    return { refreshed: refreshedCount }
  } finally {
    refreshInFlight = false
  }
}

export function startEganowTokenRefreshWorker() {
  if (refreshTimer) {
    return refreshTimer
  }

  const runRefresh = () => {
    refreshAllEganowTokens().catch((err) => {
      console.error('[eganow-token-worker] refresh pass failed', { code: err?.code || 'TOKEN_REFRESH_ERROR' })
    })
  }

  setTimeout(runRefresh, TOKEN_REFRESH_INITIAL_DELAY_MS)
  refreshTimer = setInterval(runRefresh, TOKEN_REFRESH_INTERVAL_MS)

  return refreshTimer
}

startEganowTokenRefreshWorker()
