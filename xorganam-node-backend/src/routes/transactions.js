import { Router } from 'express'
import crypto from 'node:crypto'
import { query } from '../db/pool.js'
import { authenticate, requireRole, resolveTenantScope, ForbiddenError } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { initiateCollection, CollectionRejectedError } from '../services/collectionService.js'
import { sweepToPayoutAccount, disburseToMobileMoney, EganowApiError, isGatewaySuccess, isGatewayFailure } from '../services/eganowClient.js'
import { reconcileTransaction } from '../services/reconciliationService.js'
import { enqueueCollectionStatusPollJob } from '../queue/queue.js'

// No env-level Eganow callback fallback: tenant-stored callback must be used.

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

    // Enforce merchant scoping: if the authenticated user is assigned to a specific
    // merchant, they may only view that merchant's transactions (unless they are
    // platform admin or tenant-wide user with merchantId == null).
    let effectiveMerchantId = merchantId
    if (req.user?.merchantId) {
      if (effectiveMerchantId && effectiveMerchantId !== String(req.user.merchantId)) {
        return res.status(403).json({ message: 'You do not have access to other merchants.' })
      }
      effectiveMerchantId = String(req.user.merchantId)
    }

    if (effectiveMerchantId) {
      params.push(effectiveMerchantId)
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
              payment_gateway_status,
              eganow_reference, failure_reason, collection_msisdn, kyc_msisdn, kyc_name, payout_msisdn, created_at, completed_at
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
      `SELECT t.id, t.tenant_id, t.merchant_id, t.parent_transaction_id, t.type, t.status, t.amount, t.fees, t.currency,
              t.internal_reference, t.eganow_reference, t.payment_gateway_status, t.failure_reason, t.notification_sent, t.manually_triggered,
              t.collection_msisdn, t.kyc_msisdn, t.kyc_name, t.payout_msisdn, t.created_at, t.completed_at,
              m.display_name AS merchant_display_name
         FROM transactions t
         JOIN merchants m ON m.id = t.merchant_id
        WHERE t.id = $1`,
      [req.params.transactionId]
    )
    if (rows.length === 0) return res.status(404).json({ message: 'Transaction not found.' })

    const txn = rows[0]
    if (scopeOrRespond(req, res, txn.tenant_id) === null) return

    // Enforce merchant scoping for transaction detail
    if (req.user?.merchantId && String(txn.merchant_id) !== String(req.user.merchantId)) {
      return res.status(403).json({ message: 'You do not have access to this transaction.' })
    }

    const children = await query(
      `SELECT id, type, status, amount, fees, currency, internal_reference, payment_gateway_status, created_at
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
    const { merchantId, amount, msisdn, network, narration, payoutMsisdn, payoutMobileNumber, accountNoOrMsisdn } = req.body || {}
    if (!merchantId) return res.status(400).json({ message: 'merchantId is required.' })

    const merchantRow = await query('SELECT tenant_id FROM merchants WHERE id = $1', [merchantId])
    if (merchantRow.rows.length === 0) return res.status(404).json({ message: 'Merchant not found.' })
    if (scopeOrRespond(req, res, merchantRow.rows[0].tenant_id) === null) return
    // If user is merchant-scoped, they may only initiate collections for their merchant
    if (req.user?.merchantId && String(req.user.merchantId) !== String(merchantId)) {
      return res.status(403).json({ message: 'You do not have access to this merchant.' })
    }

    try {
      const result = await initiateCollection(merchantId, {
        amount: Number(amount),
        msisdn,
        network,
        narration,
        payoutMsisdn: payoutMsisdn || payoutMobileNumber || accountNoOrMsisdn || null,
        callback: undefined
      })
      if (result.status !== 'FAILED') {
        await query('UPDATE transactions SET manually_triggered = TRUE, initiated_by_user_id = $2 WHERE id = $1', [
          result.transactionId,
          req.user.id
        ])
      }
      res.json({
        id: result.transactionId,
        internalReference: result.internalReference,
        status: result.status,
        paymentGatewayStatus: result.paymentGatewayStatus || result.status
      })
    } catch (err) {
      if (err instanceof CollectionRejectedError) return res.status(400).json({ message: err.message })
      if (err.name === 'TenantCredentialsError') return res.status(400).json({ message: err.message })
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
              m.eganow_collection_account_id, m.eganow_payout_account_id, m.network_provider, m.display_name
         FROM transactions t
         JOIN merchants m ON m.id = t.merchant_id
        WHERE t.id = $1`,
      [sourceTransactionId]
    )
    if (sourceRows.rows.length === 0) return res.status(404).json({ message: 'Source transaction not found.' })
    const source = sourceRows.rows[0]

    if (scopeOrRespond(req, res, source.tenant_id) === null) return
    // Enforce merchant scoping for operations on a specific transaction
    if (req.user?.merchantId && String(source.merchant_id) !== String(req.user.merchantId)) {
      return res.status(403).json({ message: 'You do not have access to this transaction.' })
    }
    if (source.status !== 'RECEIVED') {
      return res.status(400).json({ message: 'Source transaction must be RECEIVED from the payment gateway before internal transfer.' })
    }

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
       VALUES ($1, $2, $3, 'INTERNAL_TRANSFER', 'PENDING', $4, $5, $6, TRUE, $7)
       RETURNING id`,
      [source.tenant_id, source.merchant_id, source.id, transferAmount, source.currency, internalReference, req.user.id]
    )
    const transferId = inserted.rows[0].id

    try {
      const result = await sweepToPayoutAccount(source.tenant_id, {
        amount: transferAmount,
        network: source.network_provider,
        narration: source.display_name || `Internal transfer for ${internalReference}`
      })

      if (isGatewayFailure(result.status)) {
        throw new EganowApiError(`Internal transfer failed with status ${result.status}`, source.tenant_id, null, result.raw)
      }

      if (!isGatewaySuccess(result.status)) {
        await query(
          `UPDATE transactions
              SET status = 'PENDING',
                  payment_gateway_status = $2,
                  eganow_reference = COALESCE($3, eganow_reference),
                  eganow_transaction_id = COALESCE($4, eganow_transaction_id),
                  updated_at = now()
            WHERE id = $1`,
          [transferId, result.status || 'PENDING', result.reference || null, result.transactionId || null]
        )
        await enqueueCollectionStatusPollJob({ tenantId: source.tenant_id, merchantId: source.merchant_id, transactionId: transferId })
        return res.json({ id: transferId, internalReference, status: 'PENDING', paymentGatewayStatus: result.status || 'PENDING' })
      }

      await query(
        `UPDATE transactions
            SET status = 'SWEPT_INTERNAL',
                payment_gateway_status = $4,
                eganow_reference = $2,
                eganow_transaction_id = $3,
                completed_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [transferId, result.reference || internalReference, result.transactionId || null, result.status]
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
              m.display_name, m.mobile_money_number, m.network_provider
         FROM transactions t
         JOIN merchants m ON m.id = t.merchant_id
        WHERE t.id = $1`,
      [sourceTransactionId]
    )
    if (sourceRows.rows.length === 0) return res.status(404).json({ message: 'Source transaction not found.' })
    const source = sourceRows.rows[0]

    if (scopeOrRespond(req, res, source.tenant_id) === null) return
    if (req.user?.merchantId && String(source.merchant_id) !== String(req.user.merchantId)) {
      return res.status(403).json({ message: 'You do not have access to this transaction.' })
    }
    if (source.status !== 'SWEPT_INTERNAL') {
      return res.status(400).json({ message: 'Source transaction must be SWEPT_INTERNAL before payout.' })
    }

    const internalReference = `PO-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`
    const payoutAmount = Number(amount) || source.amount
    const destination = accountNoOrMsisdn || source.mobile_money_number

    const inserted = await query(
      `INSERT INTO transactions
         (tenant_id, merchant_id, parent_transaction_id, type, status, amount, currency, internal_reference, payout_msisdn,
          manually_triggered, initiated_by_user_id)
       VALUES ($1, $2, $3, 'PAYOUT', 'PENDING', $4, $5, $6, $7, TRUE, $8)
       RETURNING id`,
      [source.tenant_id, source.merchant_id, source.id, payoutAmount, source.currency, internalReference, destination, req.user.id]
    )
    const payoutId = inserted.rows[0].id

    try {
      const result = await disburseToMobileMoney(source.tenant_id, {
        reference: internalReference,
        amount: payoutAmount,
        currency: source.currency,
        accountNoOrCardNoOrMsisdn: destination,
        network: network || source.network_provider,
        narration: `Manual payout for ${source.internal_reference}`
      })

      if (isGatewayFailure(result.status)) {
        throw new EganowApiError(`Payout failed with status ${result.status}`, source.tenant_id, null, result.raw)
      }

      if (!isGatewaySuccess(result.status)) {
        await query(
          `UPDATE transactions
              SET status = 'PENDING',
                  payment_gateway_status = $2,
                  eganow_reference = COALESCE($3, eganow_reference),
                  eganow_transaction_id = COALESCE($4, eganow_transaction_id),
                  updated_at = now()
            WHERE id = $1`,
          [payoutId, result.status || 'PENDING', result.reference || null, result.transactionId || null]
        )
        await enqueueCollectionStatusPollJob({ tenantId: source.tenant_id, merchantId: source.merchant_id, transactionId: payoutId })
        return res.json({ id: payoutId, internalReference, status: 'PENDING', paymentGatewayStatus: result.status || 'PENDING' })
      }

      await query(
        `UPDATE transactions
            SET status = 'PAID_OUT',
                payment_gateway_status = $4,
                eganow_reference = $2,
                eganow_transaction_id = $3,
                completed_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [payoutId, result.reference || internalReference, result.transactionId || null, result.status]
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
    const ownerCheck = await query('SELECT tenant_id, merchant_id FROM transactions WHERE id = $1', [req.params.transactionId])
    if (ownerCheck.rows.length === 0) return res.status(404).json({ message: 'Transaction not found.' })
    if (scopeOrRespond(req, res, ownerCheck.rows[0].tenant_id) === null) return
    if (req.user?.merchantId && String(ownerCheck.rows[0].merchant_id) !== String(req.user.merchantId)) {
      return res.status(403).json({ message: 'You do not have access to this transaction.' })
    }

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
    paymentGatewayStatus: row.payment_gateway_status,
    amount: row.amount,
    fees: row.fees,
    currency: row.currency,
    internalReference: row.internal_reference,
    eganowReference: row.eganow_reference,
      collectionMsisdn: row.collection_msisdn || null,
      kycMsisdn: row.kyc_msisdn || null,
      kycName: row.kyc_name || null,
      payoutMsisdn: row.payout_msisdn || null,
    merchantName: row.merchant_display_name || null,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    completedAt: row.completed_at
  }
}
