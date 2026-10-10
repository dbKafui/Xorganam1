import { Router } from 'express'
import { authenticate, requireAnyRole, requirePlatformAdmin, resolveTenantScope, ForbiddenError } from '../middleware/auth.js'
import { pool, query, withTransaction } from '../db/pool.js'
import { getRedisConnection, getQueueHealth, getFailedQueueJobs } from '../queue/queue.js'
import { buildOperationalHealthSummary } from '../services/operationalHealthService.js'
import { writePlatformAudit } from '../services/auditService.js'
import { searchGlobalRecords } from '../services/globalSearchService.js'

export const operationsRouter = Router()

operationsRouter.get('/search', authenticate, requirePlatformAdmin, async (req, res, next) => {
  try {
    const rows = await searchGlobalRecords(req.query.q)
    res.json({ results: rows })
  } catch (error) {
    next(error)
  }
})

operationsRouter.get('/health/failures', authenticate, requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_BRANCH_MANAGER', 'PLATFORM_ADMIN'), async (req, res) => {
  const requestedTenantId = req.query.tenantId
  let tenantId
  try {
    tenantId = req.user.isPlatformAdmin && !requestedTenantId
      ? null
      : resolveTenantScope(req, requestedTenantId)
  } catch (error) {
    if (error instanceof ForbiddenError) return res.status(403).json({ message: error.message })
    throw error
  }

  const limit = Math.max(1, Math.min(50, Number(req.query.limit || 20)))
  const failures = await getFailedQueueJobs(limit, tenantId)
  res.json({ failures, tenantId })
})

operationsRouter.get('/health', authenticate, requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_BRANCH_MANAGER', 'PLATFORM_ADMIN'), async (req, res) => {
  try {
    const requestedTenantId = req.query.tenantId
    const tenantId = resolveTenantScope(req, requestedTenantId)
    const [database, redis, queues, providerStatus] = await Promise.all([
      pool.query('SELECT 1').then(() => ({ available: true, error: null })).catch((error) => ({
        available: false,
        error: error?.message || 'database check failed'
      })),
      getRedisConnection().ping().then(() => ({ available: true, error: null })).catch((error) => ({
        available: false,
        error: error?.message || 'redis check failed'
      })),
      getQueueHealth(),
      Promise.resolve({
        email: { configured: Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL), status: process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL ? 'healthy' : 'unconfigured' },
        sms: { configured: Boolean(process.env.SMS_GATEWAY_BASE_URL), status: process.env.SMS_GATEWAY_BASE_URL ? 'healthy' : 'unconfigured' }
      })
    ])

    const summary = buildOperationalHealthSummary({
      database,
      redis,
      queues,
      providers: providerStatus
    })

    if (tenantId && req.user && !req.user.isPlatformAdmin) {
      summary.tenantId = tenantId
    }

    res.status(summary.status === 'healthy' ? 200 : 503).json(summary)
  } catch (error) {
    console.error('[operations] health check failed', { code: error?.code || 'HEALTH_CHECK_ERROR' })
    res.status(503).json({ status: 'degraded', criticalIssues: ['Operational health check could not complete.'], notice: 'The monitored services could not be checked.' })
  }
})

operationsRouter.get('/failures', authenticate, requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_BRANCH_MANAGER', 'PLATFORM_ADMIN'), async (req, res, next) => {
  try {
    const requestedTenantId = req.query.tenantId
    const tenantId = req.user.isPlatformAdmin && !requestedTenantId
      ? null
      : resolveTenantScope(req, requestedTenantId)
    const status = String(req.query.status || 'OPEN').toUpperCase()
    if (!['OPEN', 'RESOLVED', 'ALL'].includes(status)) return res.status(400).json({ message: 'status must be OPEN, RESOLVED, or ALL.' })
    const limit = Number(req.query.limit || 50)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return res.status(400).json({ message: 'limit must be between 1 and 100.' })

    const merchantId = req.user.role === 'TENANT_BRANCH_MANAGER' ? req.user.merchantId : null
    const { rows } = await query(
      `SELECT f.id, f.queue_name, f.job_id, f.job_name, f.tenant_id, f.merchant_id, f.transaction_id,
              t.company_name AS tenant_name,
              f.attempts_made, f.error_code, f.status, f.resolution_note, f.resolved_by_user_id,
              f.resolved_at, f.created_at, f.updated_at
         FROM operational_failure_alerts f
         LEFT JOIN tenants t ON t.id = f.tenant_id
        WHERE ($1::uuid IS NULL OR tenant_id = $1)
          AND ($2 = 'ALL' OR f.status = $2)
          AND ($4::uuid IS NULL OR f.merchant_id = $4)
        ORDER BY f.created_at DESC LIMIT $3`,
      [tenantId, status, limit, merchantId]
    )
    res.json(rows.map((row) => ({
      id: row.id,
      queueName: row.queue_name,
      jobId: row.job_id,
      jobName: row.job_name,
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      merchantId: row.merchant_id,
      transactionId: row.transaction_id,
      attemptsMade: row.attempts_made,
      errorCode: row.error_code,
      status: row.status,
      resolutionNote: row.resolution_note,
      resolvedByUserId: row.resolved_by_user_id,
      resolvedAt: row.resolved_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    })))
  } catch (error) {
    if (error instanceof ForbiddenError) return res.status(403).json({ message: error.message })
    next(error)
  }
})

operationsRouter.post('/failures/:failureId/resolve', authenticate, requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER', 'PLATFORM_ADMIN'), async (req, res, next) => {
  try {
    const tenantId = req.user.isPlatformAdmin && !req.body?.tenantId
      ? null
      : resolveTenantScope(req, req.body?.tenantId)
    const note = String(req.body?.resolutionNote || '').trim()
    if (note.length < 5 || note.length > 1000) {
      return res.status(400).json({ message: 'resolutionNote must be between 5 and 1000 characters.' })
    }

    const result = await withTransaction(async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, tenant_id, merchant_id, queue_name, job_id, transaction_id, status
           FROM operational_failure_alerts
          WHERE id = $1 AND ($2::uuid IS NULL OR tenant_id = $2)
          FOR UPDATE`,
        [req.params.failureId, tenantId]
      )
      const alert = rows[0]
      if (!alert) return { notFound: true }
      if (alert.status !== 'OPEN') return { conflict: true }
      const { rows: updated } = await tx.query(
        `UPDATE operational_failure_alerts
            SET status = 'RESOLVED', resolution_note = $2, resolved_by_user_id = $3,
                resolved_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'OPEN'
          RETURNING id, status, resolution_note, resolved_at`,
        [alert.id, note, req.user.id]
      )
      await writePlatformAudit({
        actorUserId: req.user.id,
        tenantId: alert.tenant_id,
        merchantId: alert.merchant_id,
        action: 'operational_failure.resolved',
        resourceType: 'operational_failure_alert',
        resourceId: String(alert.id),
        details: {
          queueName: alert.queue_name,
          jobId: alert.job_id,
          transactionId: alert.transaction_id,
          resolutionNote: note
        },
        ipAddress: req.ip || null,
        userAgent: req.headers['user-agent'] || null,
        requestId: req.id || null,
        client: tx
      })
      return { alert: updated[0] }
    })
    if (result.notFound) return res.status(404).json({ message: 'Failure alert not found.' })
    if (result.conflict) return res.status(409).json({ message: 'Failure alert is already resolved.' })
    res.json(result.alert)
  } catch (error) {
    if (error instanceof ForbiddenError) return res.status(403).json({ message: error.message })
    next(error)
  }
})
