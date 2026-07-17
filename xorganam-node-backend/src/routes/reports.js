import { Router } from 'express'
import { query } from '../db/pool.js'
import { authenticate, requirePlatformAdmin, resolveTenantScope, ForbiddenError } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/asyncHandler.js'

export const reportsRouter = Router()

reportsRouter.use(authenticate)

function scopeOrRespond(req, res, requestedTenantId) {
  try {
    return resolveTenantScope(req, requestedTenantId)
  } catch (err) {
    if (err instanceof ForbiddenError) {
      res.status(403).json({ message: err.message })
      return null
    }
    throw err
  }
}

async function computeTotals(whereClause, params) {
  const { rows } = await query(
    `SELECT
      COALESCE(SUM(amount) FILTER (WHERE type = 'COLLECTION' AND status IN ('RECEIVED', 'SWEPT_INTERNAL', 'PAID_OUT')), 0) AS total_collected,
        COALESCE(SUM(amount) FILTER (WHERE type = 'PAYOUT' AND status = 'PAID_OUT'), 0) AS total_paid_out,
        COALESCE(SUM(fees), 0) AS total_fees,
        COUNT(*) FILTER (WHERE type = 'COLLECTION') AS collection_count,
        COUNT(*) FILTER (WHERE type = 'COLLECTION' AND status IN ('RECEIVED', 'SWEPT_INTERNAL', 'PAID_OUT')) AS successful_count,
        COUNT(*) FILTER (WHERE status = 'FAILED') AS failed_count,
        COUNT(*) FILTER (WHERE status = 'PENDING') AS pending_count
     FROM transactions
     WHERE ${whereClause}`,
    params
  )
  return rows[0]
}

// ---------------------------------------------------------------------
// One merchant's totals
// ---------------------------------------------------------------------
reportsRouter.get(
  '/merchant',
  asyncHandler(async (req, res) => {
    const { merchantId } = req.query
    if (!merchantId) return res.status(400).json({ message: 'merchantId is required.' })

    const merchantRow = await query(
      `SELECT m.id, m.tenant_id, m.display_name FROM merchants m WHERE m.id = $1`,
      [merchantId]
    )
    if (merchantRow.rows.length === 0) return res.status(404).json({ message: 'Merchant not found.' })
    const merchant = merchantRow.rows[0]

    if (scopeOrRespond(req, res, merchant.tenant_id) === null) return

    const totals = await computeTotals('merchant_id = $1', [merchantId])

    const recent = await query(
      `SELECT id, type, status, amount, currency, internal_reference, payment_gateway_status, created_at
         FROM transactions WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [merchantId]
    )

    res.json({
      merchantId: merchant.id,
      displayName: merchant.display_name,
      ...mapTotals(totals),
      recentTransactions: recent.rows.map(mapTxnSummary)
    })
  })
)

// ---------------------------------------------------------------------
// Tenant aggregate (across all of a tenant's merchants)
// ---------------------------------------------------------------------
reportsRouter.get(
  '/tenant',
  asyncHandler(async (req, res) => {
    const tenantId = scopeOrRespond(req, res, req.query.tenantId)
    if (!tenantId) return

    const tenantRow = await query('SELECT id, company_name FROM tenants WHERE id = $1', [tenantId])
    if (tenantRow.rows.length === 0) return res.status(404).json({ message: 'Tenant not found.' })

    const totals = await computeTotals('tenant_id = $1', [tenantId])

    const perMerchant = await query(
      `SELECT m.id, m.display_name,
              COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'COLLECTION' AND t.status IN ('RECEIVED','SWEPT_INTERNAL','PAID_OUT')), 0) AS total_collected,
              COUNT(t.id) FILTER (WHERE t.type = 'COLLECTION') AS transaction_count
         FROM merchants m
         LEFT JOIN transactions t ON t.merchant_id = m.id
        WHERE m.tenant_id = $1
        GROUP BY m.id, m.display_name
        ORDER BY total_collected DESC`,
      [tenantId]
    )

    res.json({
      tenantId,
      companyName: tenantRow.rows[0].company_name,
      ...mapTotals(totals),
      merchants: perMerchant.rows.map((r) => ({
        merchantId: r.id,
        displayName: r.display_name,
        totalCollected: Number(r.total_collected),
        transactionCount: Number(r.transaction_count)
      }))
    })
  })
)

// ---------------------------------------------------------------------
// System-wide (platform admin only)
// ---------------------------------------------------------------------
reportsRouter.get(
  '/system',
  requirePlatformAdmin,
  asyncHandler(async (_req, res) => {
    const tenantCounts = await query(
      `SELECT
          COUNT(*) FILTER (WHERE status = 'ACTIVE') AS active_tenants,
          COUNT(*) FILTER (WHERE status IN ('PENDING', 'UNDER_REVIEW')) AS pending_tenants
       FROM tenants`
    )

    const totals = await computeTotals('TRUE', [])

    const topTenants = await query(
      `SELECT t.id, t.company_name,
              COALESCE(SUM(tr.amount) FILTER (WHERE tr.type = 'COLLECTION' AND tr.status IN ('RECEIVED','SWEPT_INTERNAL','PAID_OUT')), 0) AS total_volume,
              COUNT(tr.id) FILTER (WHERE tr.type = 'COLLECTION') AS transaction_count
         FROM tenants t
         LEFT JOIN transactions tr ON tr.tenant_id = t.id
        GROUP BY t.id, t.company_name
        ORDER BY total_volume DESC
        LIMIT 10`
    )

    res.json({
      totalActiveTenants: Number(tenantCounts.rows[0].active_tenants),
      totalPendingTenants: Number(tenantCounts.rows[0].pending_tenants),
      ...mapTotals(totals),
      topTenantsByVolume: topTenants.rows.map((r) => ({
        tenantId: r.id,
        companyName: r.company_name,
        totalVolume: Number(r.total_volume),
        transactionCount: Number(r.transaction_count)
      }))
    })
  })
)

function mapTotals(row) {
  return {
    totalCollected: Number(row.total_collected),
    totalPaidOut: Number(row.total_paid_out),
    totalFees: Number(row.total_fees),
    netRevenue: Number(row.total_collected) - Number(row.total_fees),
    collectionCount: Number(row.collection_count),
    successfulCount: Number(row.successful_count),
    failedCount: Number(row.failed_count),
    pendingCount: Number(row.pending_count)
  }
}

function mapTxnSummary(row) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    paymentGatewayStatus: row.payment_gateway_status,
    amount: row.amount,
    currency: row.currency,
    internalReference: row.internal_reference,
    createdAt: row.created_at
  }
}
