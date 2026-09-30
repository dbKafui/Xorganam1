import { Router } from 'express'
import crypto from 'node:crypto'
import { query } from '../db/pool.js'
import { authenticate, requireAnyRole, resolveTenantScope, ForbiddenError } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { validateMerchantWebhookUrl } from '../services/outboundWebhookService.js'
import { writeSecret } from '../security/vaultClient.js'

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
    console.error('[credit-webhook] Vault write failed:', error.message)
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
