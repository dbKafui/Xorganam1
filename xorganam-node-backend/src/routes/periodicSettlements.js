import { Router } from 'express'
import { authenticate, requireRole } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { enqueuePeriodicSettlementJob } from '../queue/queue.js'

export const periodicSettlementsRouter = Router()

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
