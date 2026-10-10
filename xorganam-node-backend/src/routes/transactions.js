import { Router } from 'express'
import { query, withTransaction } from '../db/pool.js'
import { authenticate, requireRole, requirePermission, userHasPermission, resolveTenantScope, ForbiddenError } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { initiateCollection, CollectionRejectedError } from '../services/collectionService.js'
import { sweepToPayoutAccount, disburseToMobileMoney, EganowApiError, isGatewaySuccess, isGatewayFailure } from '../services/eganowClient.js'
import { reconcileTransaction } from '../services/reconciliationService.js'
import { enqueueCollectionStatusPollJob } from '../queue/queue.js'
import { markCreditInstallmentCollected } from '../services/creditInstallmentSettlement.js'
import { loadVendorPackagePayoutRule, processSplitPayout } from '../services/splitPaymentService.js'
import { computeFee } from '../services/feeService.js'
import { createVendorReference } from '../services/referenceIds.js'
import { updateTransactionStatus } from '../services/transactionStateService.js'
import { writePlatformAudit } from '../services/auditService.js'
import { formatMinorUnits, normalizeAmountMinorUnits } from '../services/providerResultValidation.js'

// No env-level Eganow callback fallback: tenant-stored callback must be used.

export const transactionsRouter = Router()

transactionsRouter.use(authenticate)

transactionsRouter.get('/fee-config', requireRole('TENANT_ADMIN'), asyncHandler(async (req, res) => {
  const tenantId = scopeOrRespond(req, res, req.query.tenantId)
  if (!tenantId) return
  const { rows } = await query(`SELECT id, stage, charge_calc_type, charge_flat_amount, charge_percentage,
      charge_cap_amount, charge_payer, eganow_cost_calc_type, eganow_cost_flat_amount,
      eganow_cost_percentage, eganow_cost_cap_amount, effective_from
    FROM fee_config_versions WHERE tenant_id = $1 AND effective_to IS NULL ORDER BY stage`, [tenantId])
  res.json({ feeConfigs: rows })
}))

transactionsRouter.put('/fee-config', requireRole('TENANT_ADMIN'), asyncHandler(async (req, res) => {
  const tenantId = scopeOrRespond(req, res, req.body?.tenantId)
  if (!tenantId) return
  const configs = req.body?.feeConfigs
  const calcTypes = new Set(['FLAT', 'PERCENTAGE', 'PERCENTAGE_WITH_CAP'])
  const stages = new Set(['COLLECTION', 'PAYOUT'])
  const payers = new Set(['CUSTOMER', 'MERCHANT', 'WAIVED'])
  if (!Array.isArray(configs) || configs.length < 1 || configs.length > 2) return res.status(400).json({ message: 'Provide one collection and/or payout fee configuration.' })
  const seen = new Set()
  for (const item of configs) {
    if (!stages.has(item.stage) || seen.has(item.stage) || !calcTypes.has(item.chargeCalcType) || !calcTypes.has(item.eganowCostCalcType) || !payers.has(item.chargePayer) || (item.stage === 'PAYOUT' && item.chargePayer === 'CUSTOMER')) return res.status(400).json({ message: 'Fee stage, calculation type, or payer is invalid.' })
    seen.add(item.stage)
    const amountValues = [item.chargeFlatAmount, item.chargeCapAmount, item.eganowCostFlatAmount, item.eganowCostCapAmount]
    if (amountValues.some((value) => value != null && (normalizeAmountMinorUnits(value) ?? -1n) < 0n)) return res.status(400).json({ message: 'Fee amounts must be non-negative decimal values with at most two fractional digits.' })
    const percentageValues = [item.chargePercentage, item.eganowCostPercentage]
    if (percentageValues.some((value) => value != null && (normalizeAmountMinorUnits(value) ?? -1n) < 0n)) return res.status(400).json({ message: 'Fee rates must be non-negative decimal values with at most two fractional digits.' })
    if (['PERCENTAGE', 'PERCENTAGE_WITH_CAP'].includes(item.chargeCalcType) && (normalizeAmountMinorUnits(item.chargePercentage) ?? 10001n) > 10000n) return res.status(400).json({ message: 'Fee percentages must be between 0 and 100.' })
    if (['PERCENTAGE', 'PERCENTAGE_WITH_CAP'].includes(item.eganowCostCalcType) && (normalizeAmountMinorUnits(item.eganowCostPercentage) ?? 10001n) > 10000n) return res.status(400).json({ message: 'Eganow cost percentages must be between 0 and 100.' })
    if (item.chargeCalcType === 'FLAT' && item.chargeFlatAmount == null || item.chargeCalcType === 'PERCENTAGE_WITH_CAP' && item.chargeCapAmount == null) return res.status(400).json({ message: 'Provide the flat fee or percentage cap required by the selected calculation.' })
    if (item.eganowCostCalcType === 'FLAT' && item.eganowCostFlatAmount == null || item.eganowCostCalcType === 'PERCENTAGE_WITH_CAP' && item.eganowCostCapAmount == null) return res.status(400).json({ message: 'Provide the Eganow flat cost or percentage cap required by the selected calculation.' })
  }
  await withTransaction(async (tx) => {
    const previous = await tx.query(
      `SELECT stage, charge_calc_type, charge_flat_amount, charge_percentage, charge_cap_amount,
              charge_payer, eganow_cost_calc_type, eganow_cost_flat_amount,
              eganow_cost_percentage, eganow_cost_cap_amount, effective_from
         FROM fee_config_versions
        WHERE tenant_id = $1 AND stage = ANY($2::text[]) AND effective_to IS NULL
        ORDER BY stage`,
      [tenantId, [...seen]]
    )
    for (const item of configs) {
      await tx.query(`UPDATE fee_config_versions SET effective_to = now()
        WHERE tenant_id = $1 AND stage = $2 AND effective_to IS NULL`, [tenantId, item.stage])
      await tx.query(`INSERT INTO fee_config_versions
        (tenant_id, stage, charge_calc_type, charge_flat_amount, charge_percentage, charge_cap_amount,
         charge_payer, eganow_cost_calc_type, eganow_cost_flat_amount, eganow_cost_percentage,
         eganow_cost_cap_amount, created_by_user_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [tenantId, item.stage, item.chargeCalcType, item.chargeFlatAmount ?? null, item.chargePercentage ?? null,
        item.chargeCapAmount ?? null, item.chargePayer, item.eganowCostCalcType,
        item.eganowCostFlatAmount ?? null, item.eganowCostPercentage ?? null,
        item.eganowCostCapAmount ?? null, req.user.id])
    }
    const auditQuery = (text, params) => tx.query(text, params)
    await writePlatformAudit({
      actorUserId: req.user.id,
      tenantId,
      action: 'TENANT_FEE_CONFIG_UPDATED',
      resourceType: 'fee_config_versions',
      details: { previous: previous.rows, current: configs },
      ipAddress: req.ip || null,
      userAgent: req.headers['user-agent'] || null,
      requestId: req.id || null,
      client: auditQuery
    })
  })
  res.json({ updated: [...seen] })
}))

transactionsRouter.post('/fee-config/:stage/rollback', requireRole('TENANT_ADMIN'), asyncHandler(async (req, res) => {
  const tenantId = scopeOrRespond(req, res, req.body?.tenantId)
  if (!tenantId) return
  const stage = String(req.params.stage || '').toUpperCase()
  if (!['COLLECTION', 'PAYOUT'].includes(stage)) return res.status(400).json({ message: 'Fee stage is invalid.' })
  const restored = await withTransaction(async (tx) => {
    const { rows: activeRows } = await tx.query(
      `SELECT * FROM fee_config_versions
        WHERE tenant_id = $1 AND stage = $2 AND effective_to IS NULL FOR UPDATE`,
      [tenantId, stage]
    )
    const active = activeRows[0]
    if (!active) return { missing: true }
    const { rows: priorRows } = await tx.query(
      `SELECT * FROM fee_config_versions
        WHERE tenant_id = $1 AND stage = $2 AND effective_to IS NOT NULL
        ORDER BY effective_to DESC, created_at DESC LIMIT 1`,
      [tenantId, stage]
    )
    const prior = priorRows[0]
    if (!prior) return { noPrior: true }
    await tx.query('UPDATE fee_config_versions SET effective_to = now() WHERE id = $1', [active.id])
    const { rows } = await tx.query(
      `INSERT INTO fee_config_versions
        (tenant_id, stage, charge_calc_type, charge_flat_amount, charge_percentage, charge_cap_amount,
         charge_payer, eganow_cost_calc_type, eganow_cost_flat_amount, eganow_cost_percentage,
         eganow_cost_cap_amount, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, stage, charge_calc_type, charge_flat_amount, charge_percentage, charge_cap_amount,
         charge_payer, eganow_cost_calc_type, eganow_cost_flat_amount, eganow_cost_percentage,
         eganow_cost_cap_amount, effective_from`,
      [tenantId, stage, prior.charge_calc_type, prior.charge_flat_amount, prior.charge_percentage,
        prior.charge_cap_amount, prior.charge_payer, prior.eganow_cost_calc_type,
        prior.eganow_cost_flat_amount, prior.eganow_cost_percentage, prior.eganow_cost_cap_amount, req.user.id]
    )
    await writePlatformAudit({
      actorUserId: req.user.id,
      tenantId,
      action: 'TENANT_FEE_CONFIG_ROLLED_BACK',
      resourceType: 'fee_config_versions',
      resourceId: rows[0].id,
      details: { stage, replacedVersionId: active.id, restoredFromVersionId: prior.id },
      ipAddress: req.ip || null,
      userAgent: req.headers['user-agent'] || null,
      requestId: req.id || null,
      client: (sql, params) => tx.query(sql, params)
    })
    return { config: rows[0] }
  })
  if (restored.missing) return res.status(404).json({ message: 'No active fee configuration exists for this stage.' })
  if (restored.noPrior) return res.status(409).json({ message: 'No earlier fee configuration exists to restore.' })
  res.json({ restored: true, feeConfig: restored.config })
}))

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
  requirePermission('VIEW_TRANSACTIONS'),
  asyncHandler(async (req, res) => {
    const tenantId = scopeOrRespond(req, res, req.query.tenantId)
    if (!tenantId) return

    const { merchantId, customerIdentifier, status, type, page = 1, pageSize = 20 } = req.query
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
    if (customerIdentifier) {
      if (typeof customerIdentifier !== 'string' || customerIdentifier.length > 32 || !/^[+0-9 ()-]+$/.test(customerIdentifier)) {
        return res.status(400).json({ message: 'Customer mobile number is invalid.' })
      }
      params.push(customerIdentifier.replace(/[ ()-]/g, ''))
      conditions.push(`(collection_msisdn = $${params.length} OR kyc_msisdn = $${params.length}
        OR EXISTS (SELECT 1 FROM credit_plans cp WHERE cp.id = credit_plan_id AND cp.customer_identifier = $${params.length})
        OR EXISTS (SELECT 1 FROM orders o WHERE o.id = order_id AND o.customer_identifier = $${params.length}))`)
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
              t.collection_msisdn, t.kyc_msisdn, t.kyc_name, t.payout_msisdn, t.payout_leg, t.payout_retry_count, t.created_at, t.completed_at,
              m.display_name AS merchant_display_name
              ,sr.vendor_leg_status, sr.vendor_failure_reason,
              sr.institution_leg_status, sr.institution_failure_reason,
              COALESCE(ms.allow_manual_control, FALSE) AS allow_manual_control
         FROM transactions t
         JOIN merchants m ON m.id = t.merchant_id
         LEFT JOIN split_reconciliation sr ON sr.parent_transaction_id = t.id
         LEFT JOIN merchant_settings ms ON ms.merchant_id = m.id
        WHERE t.id = $1`,
      [req.params.transactionId]
    )
    if (rows.length === 0) return res.status(404).json({ message: 'Transaction not found.' })

    const txn = rows[0]
    if (scopeOrRespond(req, res, txn.tenant_id) === null) return
    if (!await userHasPermission(req.user.id, 'VIEW_TRANSACTIONS', txn.merchant_id, req.user.role)) {
      return res.status(403).json({ message: 'You do not have VIEW_TRANSACTIONS permission for this merchant.' })
    }

    // Enforce merchant scoping for transaction detail
    if (req.user?.merchantId && String(txn.merchant_id) !== String(req.user.merchantId)) {
      return res.status(403).json({ message: 'You do not have access to this transaction.' })
    }

    const children = await query(
      `SELECT id, type, status, payout_leg, payout_retry_count, amount, fees, currency, internal_reference, payment_gateway_status, failure_reason, created_at
         FROM transactions WHERE parent_transaction_id = $1`,
      [txn.id]
    )
    const history = await query(
      `SELECT id, previous_status, next_status, payment_gateway_status, failure_reason, changed_at
         FROM transaction_status_history
        WHERE transaction_id = $1 AND tenant_id = $2
        ORDER BY changed_at DESC, id DESC LIMIT 100`,
      [txn.id, txn.tenant_id]
    )

    res.json({
      ...mapTransaction(txn),
      parentTransactionId: txn.parent_transaction_id,
      allowManualControl: txn.allow_manual_control,
      vendorLegStatus: txn.vendor_leg_status || null,
      vendorFailureReason: txn.vendor_failure_reason || null,
      institutionLegStatus: txn.institution_leg_status || null,
      institutionFailureReason: txn.institution_failure_reason || null,
      notificationSent: txn.notification_sent,
      manuallyTriggered: txn.manually_triggered,
      childTransactions: children.rows.map(mapTransaction),
      statusHistory: history.rows.map((event) => ({
        id: event.id,
        previousStatus: event.previous_status,
        status: event.next_status,
        paymentGatewayStatus: event.payment_gateway_status,
        failureReason: event.failure_reason,
        changedAt: event.changed_at
      }))
    })
  })
)

// ---------------------------------------------------------------------
// Manual collection (staff-triggered - e.g. a phone order, or a retry)
// ---------------------------------------------------------------------
transactionsRouter.post(
  '/collect',
  requirePermission('INITIATE_COLLECTION'),
  asyncHandler(async (req, res) => {
    const { merchantId, amount, msisdn, network, narration, payoutMsisdn, payoutMobileNumber, accountNoOrMsisdn, collectionMethod, cardNumber, cardholderName, expiryDateMonth, expiryDateYear, cvv } = req.body || {}
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
        amount,
        msisdn,
        network,
        narration,
        collectionMethod,
        cardNumber,
        cardholderName,
        expiryDateMonth,
        expiryDateYear,
        cvv,
        payoutMsisdn: payoutMsisdn || payoutMobileNumber || accountNoOrMsisdn || null,
        idempotencyKey: req.get('Idempotency-Key') || null,
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
        paymentGatewayStatus: result.paymentGatewayStatus || result.status,
        redirectHtml: result.redirectHtml || null,
        message: result.message || null,
        duplicate: result.duplicate || false
      })
    } catch (err) {
      if (err instanceof CollectionRejectedError) return res.status(err.status).json({ message: err.message })
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
  requirePermission('INITIATE_PAYOUT'),
  asyncHandler(async (req, res) => {
    const { sourceTransactionId, amount } = req.body || {}
    if (!sourceTransactionId) return res.status(400).json({ message: 'sourceTransactionId is required.' })

    const sourceRows = await query(
      `SELECT t.id, t.tenant_id, t.merchant_id, t.status, t.amount, t.base_amount,
              t.fee_charged_amount, t.fee_charged_payer, t.payout_msisdn, t.currency, t.internal_reference,
              m.eganow_collection_account_id, m.eganow_payout_account_id, m.account_setup_status, m.network_provider, m.display_name,
              COALESCE(ms.allow_manual_control, FALSE) AS allow_manual_control
         FROM transactions t
         JOIN merchants m ON m.id = t.merchant_id
         LEFT JOIN merchant_settings ms ON ms.merchant_id = m.id
        WHERE t.id = $1`,
      [sourceTransactionId]
    )
    if (sourceRows.rows.length === 0) return res.status(404).json({ message: 'Source transaction not found.' })
    const source = sourceRows.rows[0]

    if (scopeOrRespond(req, res, source.tenant_id) === null) return
    if (req.body?.merchantId && String(req.body.merchantId) !== String(source.merchant_id)) {
      return res.status(403).json({ message: 'The source transaction does not belong to the specified merchant.' })
    }
    // Enforce merchant scoping for operations on a specific transaction
    if (req.user?.merchantId && String(source.merchant_id) !== String(req.user.merchantId)) {
      return res.status(403).json({ message: 'You do not have access to this transaction.' })
    }
    if (source.account_setup_status && source.account_setup_status !== 'ACTIVE') {
      return res.status(409).json({ message: 'Eganow account setup is pending for this merchant.' })
    }
    if (req.user.role === 'TENANT_BRANCH_MANAGER' && !source.allow_manual_control) {
      return res.status(403).json({ message: 'Manual controls are not enabled for this merchant.' })
    }
    if (source.status !== 'RECEIVED') {
      return res.status(400).json({ message: 'Source transaction must be RECEIVED from the payment gateway before internal transfer.' })
    }

    const requestedTransferAmount = amount == null || amount === '' ? source.amount : amount
    const transferAmountMinor = normalizeAmountMinorUnits(requestedTransferAmount)
    const sourceAmountMinor = normalizeAmountMinorUnits(source.amount)
    if (transferAmountMinor === null || transferAmountMinor <= 0n || sourceAmountMinor === null || transferAmountMinor > sourceAmountMinor) {
      return res.status(400).json({ message: 'Transfer amount must be positive and no greater than the source collection amount.' })
    }
    const transferAmount = Number(transferAmountMinor) / 100
    const internalReference = createVendorReference(source.display_name, 'IT')
    const transfer = await withTransaction(async (client) => {
      const { rows: lockedSource } = await client.query('SELECT status FROM transactions WHERE id = $1 FOR UPDATE', [source.id])
      if (lockedSource[0]?.status !== 'RECEIVED') return { sourceChanged: true }
      const { rows: existing } = await client.query(
        `SELECT id, internal_reference, status, payment_gateway_status
           FROM transactions WHERE parent_transaction_id = $1 AND type = 'INTERNAL_TRANSFER'
          ORDER BY created_at LIMIT 1`, [source.id]
      )
      if (existing[0]) return { existing: existing[0] }
      const { rows } = await client.query(
        `INSERT INTO transactions
           (tenant_id, merchant_id, parent_transaction_id, type, status, amount, currency, internal_reference,
            manually_triggered, initiated_by_user_id)
         VALUES ($1, $2, $3, 'INTERNAL_TRANSFER', 'PENDING', $4, $5, $6, TRUE, $7)
         RETURNING id`,
        [source.tenant_id, source.merchant_id, source.id, transferAmount, source.currency, internalReference, req.user.id]
      )
      return { id: rows[0].id, created: true }
    })
    if (transfer.sourceChanged) return res.status(409).json({ message: 'Source transaction changed while starting the transfer. Refresh and try again.' })
    if (transfer.existing) {
      if (transfer.existing.status === 'PENDING') {
        try {
          const reconciled = await reconcileTransaction(transfer.existing.id, source.tenant_id)
          return res.status(reconciled?.status === 'PENDING' ? 202 : 200).json({
            id: transfer.existing.id, internalReference: transfer.existing.internal_reference,
            status: reconciled?.status || 'PENDING', paymentGatewayStatus: reconciled?.payment_gateway_status || transfer.existing.payment_gateway_status
          })
        } catch {
          return res.status(202).json({ id: transfer.existing.id, internalReference: transfer.existing.internal_reference, status: 'PENDING' })
        }
      }
      return res.status(409).json({ message: 'An internal transfer already exists for this transaction.', id: transfer.existing.id, status: transfer.existing.status })
    }
    const transferId = transfer.id

    try {
      const result = await sweepToPayoutAccount(source.tenant_id, {
        merchantId: source.merchant_id,
        reference: internalReference,
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

      await withTransaction(async (client) => {
        await updateTransactionStatus(client, {
          id: transferId,
          type: 'INTERNAL_TRANSFER',
          currentStatus: 'PENDING',
          nextStatus: 'SWEPT_INTERNAL',
          fields: {
            payment_gateway_status: result.status,
            eganow_reference: result.reference || internalReference,
            eganow_transaction_id: result.transactionId || null,
            completed_at: new Date()
          }
        })
        await updateTransactionStatus(client, {
          id: source.id,
          type: 'COLLECTION',
          currentStatus: source.status,
          nextStatus: 'SWEPT_INTERNAL',
          fields: {}
        })
        await markCreditInstallmentCollected(client, source.id)
      })

      res.json({ id: transferId, internalReference, status: 'SWEPT_INTERNAL' })
    } catch (err) {
      const message = err instanceof EganowApiError ? err.message : err.message
      let reconciled
      try {
        reconciled = await reconcileTransaction(transferId, source.tenant_id)
      } catch {
        reconciled = null
      }
      if (reconciled?.status === 'SWEPT_INTERNAL') {
        return res.json({ id: transferId, internalReference, status: 'SWEPT_INTERNAL', reconciled: true })
      }
      if (!reconciled || reconciled.status === 'PENDING') {
        await enqueueCollectionStatusPollJob({ tenantId: source.tenant_id, merchantId: source.merchant_id, transactionId: transferId })
        return res.status(202).json({ id: transferId, internalReference, status: 'PENDING', message: 'Transfer outcome is being verified before retry.' })
      }
      res.status(502).json({ message: 'Internal transfer failed.', detail: reconciled.failure_reason || message })
    }
  })
)

// ---------------------------------------------------------------------
// Manual payout
// ---------------------------------------------------------------------
transactionsRouter.post(
  '/payout',
  requirePermission('INITIATE_PAYOUT'),
  asyncHandler(async (req, res) => {
    const { sourceTransactionId, amount, accountNoOrMsisdn, network, destinationType = 'MOMO', accountName, bankCode } = req.body || {}
    if (!sourceTransactionId) return res.status(400).json({ message: 'sourceTransactionId is required.' })

    const sourceRows = await query(
      `SELECT t.id, t.tenant_id, t.merchant_id, t.status, t.amount, t.base_amount,
              t.fee_charged_amount, t.fee_charged_payer, t.currency, t.internal_reference,
              m.display_name, m.mobile_money_number, m.network_provider, m.account_setup_status,
              COALESCE(ms.allow_manual_control, FALSE) AS allow_manual_control
         FROM transactions t
         JOIN merchants m ON m.id = t.merchant_id
         LEFT JOIN merchant_settings ms ON ms.merchant_id = m.id
        WHERE t.id = $1`,
      [sourceTransactionId]
    )
    if (sourceRows.rows.length === 0) return res.status(404).json({ message: 'Source transaction not found.' })
    const source = sourceRows.rows[0]

    if (scopeOrRespond(req, res, source.tenant_id) === null) return
    if (req.body?.merchantId && String(req.body.merchantId) !== String(source.merchant_id)) {
      return res.status(403).json({ message: 'The source transaction does not belong to the specified merchant.' })
    }
    if (req.user?.merchantId && String(source.merchant_id) !== String(req.user.merchantId)) {
      return res.status(403).json({ message: 'You do not have access to this transaction.' })
    }
    if (source.account_setup_status && source.account_setup_status !== 'ACTIVE') {
      return res.status(409).json({ message: 'Eganow account setup is pending for this merchant.' })
    }
    if (req.user.role === 'TENANT_BRANCH_MANAGER' && !source.allow_manual_control) {
      return res.status(403).json({ message: 'Manual controls are not enabled for this merchant.' })
    }
    if (!['SWEPT_INTERNAL', 'PARTIALLY_SETTLED'].includes(source.status)) {
      return res.status(400).json({ message: 'Source transaction must be SWEPT_INTERNAL before payout.' })
    }

    const splitRows = await query(
      `SELECT r.*, i.settlement_msisdn, i.settlement_account_name,
              COALESCE(smc.vendor_payout_mode, 'PERIODIC') AS vendor_payout_mode,
              COALESCE(smc.priority_deduction_selected, FALSE) AS priority_deduction_selected
         FROM split_rules r
         JOIN institutions i ON i.id = r.institution_id AND i.status = 'ACTIVE'
         JOIN tenant_institution_links l ON l.tenant_id = r.tenant_id AND l.institution_id = r.institution_id
           AND l.status = 'ACTIVE' AND l.verification_status = 'APPROVED'
         LEFT JOIN tenant_merchant_settlement_config smc ON smc.tenant_id = r.tenant_id
           AND smc.merchant_id = $2 AND smc.institution_id = r.institution_id
        WHERE r.tenant_id = $1 AND r.active AND r.effective_from <= now()
          AND (r.effective_to IS NULL OR r.effective_to > now())
        AND ((r.scope_level = 'MERCHANT_OVERRIDE' AND r.merchant_id = $2)
            OR (r.scope_level = 'TENANT_DEFAULT' AND r.merchant_id IS NULL))
          AND EXISTS (SELECT 1 FROM tenant_merchant_settlement_config opted
                       WHERE opted.tenant_id = r.tenant_id AND opted.merchant_id = $2
                         AND opted.institution_id = r.institution_id)
        ORDER BY CASE WHEN r.merchant_id = $2 THEN 0 ELSE 1 END, r.created_at DESC LIMIT 1`,
      [source.tenant_id, source.merchant_id]
    )
    const packageRule = splitRows.rows[0] ? null : await loadVendorPackagePayoutRule({
      tenantId: source.tenant_id, merchantId: source.merchant_id, triggerMode: 'MANUAL'
    })
    const payoutRule = splitRows.rows[0] || packageRule
    if (payoutRule) {
      if (String(destinationType).toUpperCase() !== 'MOMO') return res.status(409).json({ message: 'Bank payouts are not enabled for split settlement.' })
      try {
        const splitResult = await processSplitPayout({
          tenantId: source.tenant_id,
          merchantId: source.merchant_id,
          collectionTxn: source,
          merchant: { id: source.merchant_id, display_name: source.display_name, mobile_money_number: source.mobile_money_number, network_provider: source.network_provider },
          rule: payoutRule,
          triggerMode: 'MANUAL',
          finalAttempt: false
        })
        if (splitResult.pending) return res.status(202).json({ id: source.id, status: 'SWEPT_INTERNAL', paymentGatewayStatus: 'PENDING' })
        return res.json({ id: source.id, status: splitResult.status || 'SWEPT_INTERNAL', legs: splitResult.results || {} })
      } catch (error) {
        if (error instanceof EganowApiError) return res.status(502).json({ message: 'One or more split payout legs failed. Retry or reconcile the payout.' })
        throw error
      }
    }
    if (source.status === 'PARTIALLY_SETTLED') return res.status(409).json({ message: 'The split rule for this partially settled transaction is no longer active. Contact support before retrying.' })

    // A source collection may have only one manual payout. Reconcile that payout
    // on retries instead of creating a new gateway reference and risking a double payment.
    const existingPayout = await query(
      `SELECT id, internal_reference, status, payment_gateway_status
         FROM transactions
        WHERE parent_transaction_id = $1 AND type = 'PAYOUT' AND manually_triggered = TRUE
        ORDER BY created_at DESC LIMIT 1`, [source.id]
    )
    if (existingPayout.rows[0]) {
      const payout = existingPayout.rows[0]
      if (payout.status === 'PENDING') {
        try {
          const reconciled = await reconcileTransaction(payout.id, source.tenant_id)
          return res.status(reconciled?.status === 'PENDING' ? 202 : 200).json({
            id: payout.id, internalReference: payout.internal_reference,
            status: reconciled?.status || 'PENDING', paymentGatewayStatus: reconciled?.payment_gateway_status || payout.payment_gateway_status
          })
        } catch {
          return res.status(202).json({ id: payout.id, internalReference: payout.internal_reference, status: 'PENDING', paymentGatewayStatus: payout.payment_gateway_status || 'UNKNOWN' })
        }
      }
      if (payout.status === 'PAID_OUT') return res.json({ id: payout.id, internalReference: payout.internal_reference, status: 'PAID_OUT' })
      return res.status(409).json({ message: 'A manual payout already exists for this collection. Reconcile or resolve it before attempting another payout.', id: payout.id, status: payout.status })
    }

    const internalReference = createVendorReference(source.display_name, 'PO')
    const normalizedDestinationType = String(destinationType).toUpperCase()
    const destination = accountNoOrMsisdn || (normalizedDestinationType === 'MOMO' ? source.mobile_money_number : null)
    if (!['MOMO', 'BANK'].includes(normalizedDestinationType)) return res.status(400).json({ message: 'Choose Mobile Money or Bank payout.' })
    const supportedBanks = new Set(['GCBGH', 'SOCIETE', 'ARBAPEX', 'OMNIBSIC', 'FIRSTATGH', 'FBNGH', 'BANKOFAFRICA', 'FIDELITY', 'FNBGH', 'CBG', 'ACCESSGH', 'UNAFBKGH', 'GTBANKGH', 'PBL', 'CAL', 'ECOBANKGH', 'ZENITHGH', 'REPUBLIC', 'UMB', 'ADB', 'NIB', 'ABSA', 'STANCHART', 'STANBICGH'])
    if (!destination || (normalizedDestinationType === 'BANK' && (!supportedBanks.has(String(bankCode || '').toUpperCase()) || !String(accountName || '').trim() || !/^\d{6,34}$/.test(String(destination).replace(/\s/g, ''))))) {
      return res.status(400).json({ message: 'Provide a valid destination, recipient name, and supported bank.' })
    }
    const availableAmountMinor = normalizeAmountMinorUnits(source.base_amount ?? source.amount)
    const requestedPayoutMinor = amount == null || amount === '' ? availableAmountMinor : normalizeAmountMinorUnits(amount)
    if (availableAmountMinor === null || requestedPayoutMinor === null || requestedPayoutMinor <= 0n || requestedPayoutMinor > availableAmountMinor || requestedPayoutMinor > BigInt(Number.MAX_SAFE_INTEGER)) {
      return res.status(400).json({ message: 'Payout amount must be a valid positive amount within the available collection balance.' })
    }
    const requestedPayoutAmount = formatMinorUnits(requestedPayoutMinor)
    const payoutFee = await computeFee(source.tenant_id, 'PAYOUT', requestedPayoutAmount)
    // Provider amount is converted only after exact minor-unit bounds validation.
    const payoutAmount = Number(requestedPayoutMinor) / 100

    const inserted = await withTransaction(async (tx) => {
      await tx.query('SELECT id FROM transactions WHERE id = $1 FOR UPDATE', [source.id])
      const existing = await tx.query(
        `SELECT id, internal_reference, status, payment_gateway_status FROM transactions
          WHERE parent_transaction_id = $1 AND type = 'PAYOUT' AND manually_triggered = TRUE
          ORDER BY created_at DESC LIMIT 1`, [source.id]
      )
      if (existing.rows[0]) return { row: existing.rows[0], created: false }
      const created = await tx.query(
      `INSERT INTO transactions
         (tenant_id, merchant_id, parent_transaction_id, type, status, amount, currency, internal_reference, payout_msisdn,
          manually_triggered, initiated_by_user_id, payout_leg, base_amount, fee_charged_amount, fee_charged_payer,
          fee_eganow_cost, fee_platform_margin, fee_config_version_id)
       VALUES ($1, $2, $3, 'PAYOUT', 'PENDING', $4, $5, $6, $7, TRUE, $8, 'NONE', $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [source.tenant_id, source.merchant_id, source.id, payoutAmount, source.currency, internalReference, destination, req.user.id,
        requestedPayoutAmount, payoutFee.chargedAmount, payoutFee.chargedPayer, payoutFee.eganowCost, payoutFee.platformMargin, payoutFee.feeConfigVersionId]
      )
      return { row: { id: created.rows[0].id, internal_reference: internalReference, status: 'PENDING' }, created: true }
    })
    if (!inserted.created) {
      const payout = inserted.row
      return res.status(payout.status === 'PENDING' ? 202 : 409).json({ id: payout.id, internalReference: payout.internal_reference, status: payout.status, paymentGatewayStatus: payout.payment_gateway_status })
    }
    const payoutId = inserted.row.id

    try {
      const result = await disburseToMobileMoney(source.tenant_id, {
        merchantId: source.merchant_id,
        reference: internalReference,
        amount: payoutAmount,
        currency: source.currency,
        accountNoOrCardNoOrMsisdn: normalizedDestinationType === 'BANK' ? String(destination).replace(/\s/g, '') : destination,
        accountName: accountName || 'Recipient',
        destinationType: normalizedDestinationType,
        network: normalizedDestinationType === 'BANK' ? bankCode : network || source.network_provider,
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

      await withTransaction(async (tx) => {
        await updateTransactionStatus(tx, {
          id: payoutId,
          type: 'PAYOUT',
          currentStatus: 'PENDING',
          nextStatus: 'PAID_OUT',
          fields: {
            payment_gateway_status: result.status,
            eganow_reference: result.reference || internalReference,
            eganow_transaction_id: result.transactionId || null,
            completed_at: new Date()
          }
        })
        await updateTransactionStatus(tx, {
          id: source.id,
          type: 'COLLECTION',
          currentStatus: source.status,
          nextStatus: 'PAID_OUT',
          fields: {}
        })
      })

      res.json({ id: payoutId, internalReference, status: 'PAID_OUT' })
    } catch (err) {
      // A transport/API error can happen after the provider accepted the request.
      // Keep the same reference pending and reconcile it; never expose it to a fresh submission.
      await query(`UPDATE transactions SET payment_gateway_status = 'UNKNOWN', updated_at = now() WHERE id = $1 AND status = 'PENDING'`, [payoutId])
      await enqueueCollectionStatusPollJob({ tenantId: source.tenant_id, merchantId: source.merchant_id, transactionId: payoutId })
      res.status(202).json({ id: payoutId, internalReference, status: 'PENDING', paymentGatewayStatus: 'UNKNOWN' })
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
    payoutLeg: row.payout_leg || 'NONE',
    payoutRetryCount: Number(row.payout_retry_count || 0),
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
