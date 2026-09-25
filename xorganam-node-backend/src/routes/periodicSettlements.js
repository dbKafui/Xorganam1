import { Router } from 'express'
import { authenticate, requireRole, resolveTenantScope, ForbiddenError } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { enqueuePeriodicSettlementJob } from '../queue/queue.js'
import { query } from '../db/pool.js'

export const periodicSettlementsRouter = Router()

function scopedTenant(req, res, requestedTenantId) {
  try {
    return resolveTenantScope(req, requestedTenantId)
  } catch (error) {
    if (error instanceof ForbiddenError) {
      res.status(403).json({ message: error.message })
      return null
    }
    throw error
  }
}

periodicSettlementsRouter.post(
  '/run-due',
  authenticate,
  requireRole('TENANT_MANAGER'),
  asyncHandler(async (req, res) => {
    const tenantId = req.user.isPlatformAdmin ? req.body?.tenantId : req.user.tenantId
    if (req.user.isPlatformAdmin && !tenantId) {
      return res.status(400).json({ message: 'tenantId is required for platform admin requests.' })
    }
    const job = await enqueuePeriodicSettlementJob({ tenantId })
    res.status(202).json({ queued: true, jobId: job.id })
  })
)

periodicSettlementsRouter.get(
  '/reconciliation',
  authenticate,
  asyncHandler(async (req, res) => {
    const tenantId = scopedTenant(req, res, req.query.tenantId)
    if (!tenantId) return

    const { rows } = await query(
      `SELECT r.*
         FROM institution_portal_reconciliation r
         JOIN transactions p ON p.id = r.parent_transaction_id
        WHERE p.tenant_id = $1
        ORDER BY p.created_at DESC`,
      [tenantId]
    )
    res.json(rows)
  })
)
