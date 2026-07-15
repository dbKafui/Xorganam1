import { Router } from 'express'
import crypto from 'node:crypto'
import { query } from '../db/pool.js'
import { authenticate, requireRole, resolveTenantScope, ForbiddenError } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { initiateCollection, CollectionRejectedError } from '../services/collectionService.js'
import { sweepToPayoutAccount, disburseToMobileMoney, EganowApiError } from '../services/eganowClient.js'
import { reconcileTransaction } from '../services/reconciliationService.js'

function getEganowCallbackUrl(req) {
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim()
  return process.env.EGANOW_CALLBACK_URL || `${proto}://${req.get('host')}/api/v1/webhooks/eganow`
}

export const transactionsRouter = Router()

transactionsRouter.use(authenticate)

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

// ---------------------------------------------------------------------
// List + detail
// ---------------------------------------------------------------------
transactionsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const tenantId = scopeOrRespond(req, res, req.query.tenantId)
    if (!tenantId) return

    const { merchantId, status, type, page = 1, pageSize = 20 } = req.query
    const limit = Math.min(parseInt(pageSize, 10) || 20, 200)
    const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit

    const conditions = ['tenant_id = $1']
    const params = [tenantId]

    if (merchantId) {
      params.push(merchantId)
      conditions.push(`merchant_id = $${params.length}`)
    }
    if (status) {
      params.push(status)
      conditions.push(`status = $${params.length}`)
    }
    if (type) {
      params.push(type)
      conditions.push(`type = $${params.length}`)
    }

    const whereClause = conditions.join(' AND ')

    const countResult = await query(`SELECT COUNT(*)::int AS total FROM transactions WHERE ${whereClause}`, params)
    const total = countResult.rows[0].total

    params.push(limit, offset)
    const { rows } = await query(
      `SELECT id, merchant_id, type, status, amount, fees, currency, internal_reference,
              eganow_reference, failure_reason, created_at, completed_at
         FROM transactions
        WHERE ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )

    res.json({
      page: Math.max(parseInt(page, 10) || 1, 1),
      pageSize: limit,
      totalCount: total,
      totalPages: Math.ceil(total / limit) || 1,
      transactions: rows.map(mapTransaction)
    })
  })
)

transactionsRouter.get(
  '/:transactionId',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT id, tenant_id, merchant_id, parent_transaction_id, type, status, amount, fees, currency,
              internal_reference, eganow_reference, failure_reason, notification_sent, manually_triggered,
              created_at, completed_at
         FROM transactions WHERE id = $1`,
      [req.params.transactionId]
    )
    if (rows.length === 0) return res.status(404).json({ message: 'Transaction not found.' })

    const txn = rows[0]
    if (scopeOrRespond(req, res, txn.tenant_id) === null) return

    const children = await query(
      `SELECT id, type, status, amount, fees, currency, internal_reference, created_at
         FROM transactions WHERE parent_transaction_id = $1`,
      [txn.id]
    )

    res.json({
      ...mapTransaction(txn),
      parentTransactionId: txn.parent_transaction_id,
      notificationSent: txn.notification_sent,
      manuallyTriggered: txn.manually_triggered,
      childTransactions: children.rows.map(mapTransaction)
    })
  })
)

// ---------------------------------------------------------------------
// Manual collection (staff-triggered - e.g. a phone order, or a retry)
// ---------------------------------------------------------------------
transactionsRouter.post(
  '/collect',
  requireRole('TENANT_OPERATOR'),
  asyncHandler(async (req, res) => {
    const { merchantId, amount, msisdn, network, narration } = req.body || {}
    if (!merchantId) return res.status(400).json({ message: 'merchantId is required.' })

    const merchantRow = await query('SELECT tenant_id FROM merchants WHERE id = $1', [merchantId])
    if (merchantRow.rows.length === 0) return res.status(404).json({ message: 'Merchant not found.' })
    if (scopeOrRespond(req, res, merchantRow.rows[0].tenant_id) === null) return

    try {
      const result = await initiateCollection(merchantId, {
        amount: Number(amount),
        msisdn,
        network,
        narration,
        callback: getEganowCallbackUrl(req)
      })
      if (result.status !== 'FAILED') {
        await query('UPDATE transactions SET manually_triggered = TRUE, initiated_by_user_id = $2 WHERE id = $1', [
          result.transactionId,
          req.user.id
        ])
      }
      res.json({ id: result.transactionId, internalReference: result.internalReference, status: result.status })
    } catch (err) {
      if (err instanceof CollectionRejectedError) return res.status(400).json({ message: err.message })
      throw err
    }
  })
)

// ---------------------------------------------------------------------
// Manual internal transfer (MANUAL payout_mode, or an AUTO_SWEEP
// merchant with allow_manual_control granted)
// ---------------------------------------------------------------------
transactionsRouter.post(
  '/internal-transfer',
  requireRole('TENANT_MANAGER'),
  asyncHandler(async (req, res) => {
    const { sourceTransactionId, amount } = req.body || {}
    if (!sourceTransactionId) return res.status(400).json({ message: 'sourceTransactionId is required.' })

    const sourceRows = await query(
      `SELECT t.id, t.tenant_id, t.merchant_id, t.status, t.amount, t.currency, t.internal_reference,
              m.eganow_collection_account_id, m.eganow_payout_account_id
         FROM transactions t
         JOIN merchants m ON m.id = t.merchant_id
        WHERE t.id = $1`,
      [sourceTransactionId]
    )
    if (sourceRows.rows.length === 0) return res.status(404).json({ message: 'Source transaction not found.' })
    const source = sourceRows.rows[0]

    if (scopeOrRespond(req, res, source.tenant_id) === null) return
    if (source.status !== 'RECEIVED') return res.status(400).json({ message: 'Source transaction must be in RECEIVED status.' })

    const existingChild = await query(
      `SELECT id FROM transactions WHERE parent_transaction_id = $1 AND type = 'INTERNAL_TRANSFER'`,
      [source.id]
    )
    if (existingChild.rows.length > 0) return res.status(409).json({ message: 'An internal transfer already exists for this transaction.' })

    const internalReference = `IT-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`
    const transferAmount = Number(amount) || source.amount

    const inserted = await query(
      `INSERT INTO transactions
         (tenant_id, merchant_id, parent_transaction_id, type, status, amount, currency, internal_reference,
          manually_triggered, initiated_by_user_id)
       VALUES ($1, $2, $3, 'INTERNAL_TRANSFER', 'RECEIVED', $4, $5, $6, TRUE, $7)
       RETURNING id`,
      [source.tenant_id, source.merchant_id, source.id, transferAmount, source.currency, internalReference, req.user.id]
    )
    const transferId = inserted.rows[0].id

    try {
      const result = await sweepToPayoutAccount(source.tenant_id, {
        reference: internalReference,
        amount: transferAmount,
        currency: source.currency,
        network: source.network_provider
      })

      await query(
        `UPDATE transactions SET status = 'SWEPT_INTERNAL', eganow_reference = $2, eganow_transaction_id = $3, completed_at = now(), updated_at = now() WHERE id = $1`,
        [transferId, result.reference || internalReference, result.transactionId || null]
      )
      await query(`UPDATE transactions SET status = 'SWEPT_INTERNAL', updated_at = now() WHERE id = $1`, [source.id])

      res.json({ id: transferId, internalReference, status: 'SWEPT_INTERNAL' })
    } catch (err) {
      const message = err instanceof EganowApiError ? err.message : err.message
      await query(`UPDATE transactions SET status = 'FAILED', failure_reason = $2, updated_at = now() WHERE id = $1`, [transferId, message])
      res.status(502).json({ message: 'Internal transfer failed.', detail: message })
    }
  })
)

// ---------------------------------------------------------------------
// Manual payout
// ---------------------------------------------------------------------
transactionsRouter.post(
  '/payout',
  requireRole('TENANT_MANAGER'),
  asyncHandler(async (req, res) => {
    const { sourceTransactionId, amount, accountNoOrMsisdn, network } = req.body || {}
    if (!sourceTransactionId) return res.status(400).json({ message: 'sourceTransactionId is required.' })

    const sourceRows = await query(
      `SELECT t.id, t.tenant_id, t.merchant_id, t.status, t.amount, t.currency, t.internal_reference,
              m.mobile_money_number, m.network_provider
         FROM transactions t
         JOIN merchants m ON m.id = t.merchant_id
        WHERE t.id = $1`,
      [sourceTransactionId]
    )
    if (sourceRows.rows.length === 0) return res.status(404).json({ message: 'Source transaction not found.' })
    const source = sourceRows.rows[0]

    if (scopeOrRespond(req, res, source.tenant_id) === null) return
    if (source.status !== 'SWEPT_INTERNAL') {
      return res.status(400).json({ message: 'Source transaction must be SWEPT_INTERNAL before payout.' })
    }

    const internalReference = `PO-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`
    const payoutAmount = Number(amount) || source.amount
    const destination = accountNoOrMsisdn || source.mobile_money_number

    const inserted = await query(
      `INSERT INTO transactions
         (tenant_id, merchant_id, parent_transaction_id, type, status, amount, currency, internal_reference,
          manually_triggered, initiated_by_user_id)
       VALUES ($1, $2, $3, 'PAYOUT', 'RECEIVED', $4, $5, $6, TRUE, $7)
       RETURNING id`,
      [source.tenant_id, source.merchant_id, source.id, payoutAmount, source.currency, internalReference, req.user.id]
    )
    const payoutId = inserted.rows[0].id

    try {
      const result = await disburseToMobileMoney(source.tenant_id, {
        reference: internalReference,
        amount: payoutAmount,
        currency: source.currency,
        accountNoOrCardNoOrMsisdn: destination,
        network: network || source.network_provider,
        narration: `Manual payout for ${source.internal_reference}`,
        callback: getEganowCallbackUrl(req)
      })

      await query(
        `UPDATE transactions SET status = 'PAID_OUT', eganow_reference = $2, eganow_transaction_id = $3, completed_at = now(), updated_at = now() WHERE id = $1`,
        [payoutId, result.reference || internalReference, result.transactionId || null]
      )
      await query(`UPDATE transactions SET status = 'PAID_OUT', updated_at = now() WHERE id = $1`, [source.id])

      res.json({ id: payoutId, internalReference, status: 'PAID_OUT' })
    } catch (err) {
      const message = err instanceof EganowApiError ? err.message : err.message
      await query(`UPDATE transactions SET status = 'FAILED', failure_reason = $2, updated_at = now() WHERE id = $1`, [payoutId, message])
      res.status(502).json({ message: 'Payout failed.', detail: message })
    }
  })
)

// ---------------------------------------------------------------------
// On-demand reconciliation
// ---------------------------------------------------------------------
transactionsRouter.post(
  '/:transactionId/reconcile',
  requireRole('TENANT_OPERATOR'),
  asyncHandler(async (req, res) => {
    const ownerCheck = await query('SELECT tenant_id FROM transactions WHERE id = $1', [req.params.transactionId])
    if (ownerCheck.rows.length === 0) return res.status(404).json({ message: 'Transaction not found.' })
    if (scopeOrRespond(req, res, ownerCheck.rows[0].tenant_id) === null) return

    const updated = await reconcileTransaction(req.params.transactionId, req.user.isPlatformAdmin ? null : req.user.tenantId)
    if (!updated) return res.status(404).json({ message: 'Transaction not found.' })

    res.json(mapTransaction(updated))
  })
)

function mapTransaction(row) {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    type: row.type,
    status: row.status,
    amount: row.amount,
    fees: row.fees,
    currency: row.currency,
    internalReference: row.internal_reference,
    eganowReference: row.eganow_reference,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    completedAt: row.completed_at
  }
}
