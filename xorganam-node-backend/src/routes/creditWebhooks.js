import { Router } from 'express'
import crypto from 'node:crypto'
import { query } from '../db/pool.js'
import { authenticate, requireAnyRole, resolveTenantScope, ForbiddenError } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { validateMerchantWebhookUrl } from '../services/outboundWebhookService.js'
import { writeSecret } from '../security/vaultClient.js'
import { replayCreditWebhookDelivery } from '../queue/queue.js'

export const creditWebhooksRouter = Router()
creditWebhooksRouter.use(authenticate)

function tenantScope(req, res) {
  try { return resolveTenantScope(req, req.query.tenantId || req.body?.tenantId) } catch (error) {
    if (error instanceof ForbiddenError) { res.status(403).json({ message: error.message }); return null }
    throw error
  }
}

function ownMerchant(req, res, merchantId) {
  if (req.user.role === 'TENANT_BRANCH_MANAGER' && req.user.merchantId !== merchantId) {
    res.status(403).json({ message: 'Branch managers can only manage webhooks for their assigned merchant.' })
    return false
  }
  return true
}

creditWebhooksRouter.get('/:merchantId', asyncHandler(async (req, res) => {
  const tenantId = tenantScope(req, res)
  if (!tenantId || !ownMerchant(req, res, req.params.merchantId)) return
  const { rows } = await query(
    `SELECT id, merchant_id, url, active, created_at, updated_at
       FROM merchant_webhook_config WHERE tenant_id = $1 AND merchant_id = $2`,
    [tenantId, req.params.merchantId]
  )
  if (!rows.length) return res.status(404).json({ message: 'No webhook is configured for this merchant.' })
  res.json(rows[0])
}))

creditWebhooksRouter.get('/:merchantId/deliveries', asyncHandler(async (req, res) => {
  const tenantId = tenantScope(req, res)
  if (!tenantId || !ownMerchant(req, res, req.params.merchantId)) return
  const requestedPage = Number(req.query.page || 1)
  const requestedPageSize = Number(req.query.pageSize || 25)
  if (!Number.isInteger(requestedPage) || requestedPage < 1 || requestedPage > 10000) {
    return res.status(400).json({ message: 'page must be a whole number between 1 and 10000.' })
  }
  if (!Number.isInteger(requestedPageSize) || requestedPageSize < 1 || requestedPageSize > 100) {
    return res.status(400).json({ message: 'pageSize must be a whole number between 1 and 100.' })
  }
  const { rows } = await query(
    `SELECT id, event_type, delivered_at, last_error, created_at
       FROM credit_webhook_outbox
      WHERE tenant_id = $1 AND merchant_id = $2
      ORDER BY created_at DESC, id DESC
      LIMIT $3 OFFSET $4`,
    [tenantId, req.params.merchantId, requestedPageSize, (requestedPage - 1) * requestedPageSize]
  )
  res.json({
    items: rows.map((row) => ({
      ...row,
      status: row.delivered_at ? 'DELIVERED' : row.last_error ? 'FAILED' : 'PENDING',
      last_error: row.last_error ? String(row.last_error).slice(0, 500) : null
    })),
    page: requestedPage,
    pageSize: requestedPageSize
  })
}))

creditWebhooksRouter.put('/:merchantId', requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_BRANCH_MANAGER'), asyncHandler(async (req, res) => {
  const tenantId = tenantScope(req, res)
  if (!tenantId || !ownMerchant(req, res, req.params.merchantId)) return
  const url = String(req.body?.url || '').trim()
  if (!url || url.length > 2048) return res.status(400).json({ message: 'A webhook URL of at most 2048 characters is required.' })
  const merchant = await query('SELECT id FROM merchants WHERE id = $1 AND tenant_id = $2', [req.params.merchantId, tenantId])
  if (!merchant.rows.length) return res.status(404).json({ message: 'Merchant not found.' })
  try { await validateMerchantWebhookUrl(url) } catch (error) { return res.status(400).json({ message: error.message }) }
  const webhookSecret = crypto.randomBytes(32).toString('hex')
  // Keep each rotation immutable so a Vault write followed by a failed DB
  // update cannot silently invalidate the secret currently in use.
  const secretReference = `xorganam/webhooks/${tenantId}/${req.params.merchantId}/${crypto.randomUUID()}`
  try { await writeSecret(secretReference, { secret: webhookSecret }) } catch (error) {
    console.error('[credit-webhook] Vault write failed', { code: error?.code || 'VAULT_ERROR' })
    return res.status(503).json({ message: 'The webhook signing secret could not be secured. Check Vault configuration and try again.' })
  }
  const { rows } = await query(
    `INSERT INTO merchant_webhook_config (tenant_id, merchant_id, url, secret_reference, active)
     VALUES ($1, $2, $3, $4, TRUE)
     ON CONFLICT (tenant_id, merchant_id)
     DO UPDATE SET url = EXCLUDED.url, secret_reference = EXCLUDED.secret_reference,
                   active = TRUE, updated_at = now()
     RETURNING id, merchant_id, url, active, created_at, updated_at`,
    [tenantId, req.params.merchantId, url, secretReference]
  )
  res.json({ ...rows[0], webhookSecret })
}))

creditWebhooksRouter.delete('/:merchantId', requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_BRANCH_MANAGER'), asyncHandler(async (req, res) => {
  const tenantId = tenantScope(req, res)
  if (!tenantId || !ownMerchant(req, res, req.params.merchantId)) return
  const { rowCount } = await query(
    `UPDATE merchant_webhook_config SET active = FALSE, updated_at = now()
      WHERE tenant_id = $1 AND merchant_id = $2 AND active`, [tenantId, req.params.merchantId]
  )
  if (!rowCount) return res.status(404).json({ message: 'No active webhook is configured for this merchant.' })
  res.status(204).end()
}))

creditWebhooksRouter.post('/:merchantId/deliveries/:eventId/replay', requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_BRANCH_MANAGER'), asyncHandler(async (req, res) => {
  const tenantId = tenantScope(req, res)
  if (!tenantId || !ownMerchant(req, res, req.params.merchantId)) return
  const { rows } = await query(
    `SELECT e.id, e.last_error, e.delivered_at, c.active
       FROM credit_webhook_outbox e
       LEFT JOIN merchant_webhook_config c
         ON c.tenant_id = e.tenant_id AND c.merchant_id = e.merchant_id
      WHERE e.id = $1 AND e.tenant_id = $2 AND e.merchant_id = $3`,
    [req.params.eventId, tenantId, req.params.merchantId]
  )
  const event = rows[0]
  if (!event) return res.status(404).json({ message: 'Webhook delivery not found.' })
  if (event.delivered_at) return res.status(409).json({ message: 'Delivered webhook events cannot be replayed from failure recovery.' })
  if (!event.last_error) return res.status(409).json({ message: 'Only failed webhook deliveries can be replayed.' })
  if (!event.active) return res.status(409).json({ message: 'Configure an active webhook before replaying this event.' })

  const { rows: updatedRows } = await query(
    `UPDATE credit_webhook_outbox SET last_error = NULL
      WHERE id = $1 AND tenant_id = $2 AND merchant_id = $3
        AND delivered_at IS NULL AND last_error IS NOT NULL
      RETURNING id`,
    [event.id, tenantId, req.params.merchantId]
  )
  if (!updatedRows.length) return res.status(409).json({ message: 'This webhook delivery has already changed. Refresh and try again.' })

  try {
    const job = await replayCreditWebhookDelivery(event.id)
    if (!job) {
      await query(
        `UPDATE credit_webhook_outbox SET last_error = $4
          WHERE id = $1 AND tenant_id = $2 AND merchant_id = $3 AND delivered_at IS NULL`,
        [event.id, tenantId, req.params.merchantId, event.last_error]
      )
      return res.status(409).json({ message: 'The queue contains a completed job for this event; inspect the delivery state before retrying.' })
    }
  } catch (error) {
    await query(
      `UPDATE credit_webhook_outbox SET last_error = $4
        WHERE id = $1 AND tenant_id = $2 AND merchant_id = $3 AND delivered_at IS NULL`,
      [event.id, tenantId, req.params.merchantId, event.last_error]
    )
    throw error
  }
  res.status(202).json({ id: event.id, status: 'QUEUED' })
}))
