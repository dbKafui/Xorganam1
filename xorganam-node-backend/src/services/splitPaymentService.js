import crypto from 'node:crypto'
import { query, withTransaction } from '../db/pool.js'
import { enqueueCollectionStatusPollJob } from '../queue/queue.js'
import { computeFee } from './feeService.js'
import {
  disburseToMobileMoney,
  EganowApiError,
  isGatewayFailure,
  isGatewaySuccess,
  isGatewayPending,
  queryTransactionStatus
} from './eganowClient.js'

export function calculateInstitutionAmount(collectionAmount, rule) {
  const amount = Number(collectionAmount)
  const configuredAmount = Number(rule.amount)
  const institutionAmount = rule.type === 'PERCENTAGE'
    ? amount * configuredAmount / 100
    : configuredAmount

  if (!Number.isFinite(institutionAmount) || institutionAmount < 0 || institutionAmount > amount) {
    throw new Error(`Invalid split amount for rule ${rule.id}`)
  }

  return Math.round(institutionAmount * 100) / 100
}

function createReference(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`
}

async function findOrCreateLeg({ tenantId, merchantId, parentTransactionId, payoutLeg, amount, currency, destination, fee }) {
  return withTransaction(async (client) => {
    const insert = await client.query(
      `INSERT INTO transactions
         (tenant_id, merchant_id, parent_transaction_id, type, payout_leg, status,
          amount, currency, internal_reference, payout_msisdn, institution_id, base_amount,
          fee_charged_amount, fee_charged_payer, fee_eganow_cost, fee_platform_margin, fee_config_version_id)
       VALUES ($1, $2, $3, 'PAYOUT', $4, 'PENDING', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT ON CONSTRAINT uq_transactions_parent_type_leg DO NOTHING
       RETURNING id, internal_reference, status, amount, payout_msisdn, institution_id, payout_leg, payment_gateway_status`,
      [
        tenantId,
        merchantId,
        parentTransactionId,
        payoutLeg,
        amount,
        currency,
        `${createReference('PO')}-${payoutLeg === 'INSTITUTION' ? 'INST' : 'VENDOR'}`,
        destination.msisdn,
        destination.institutionId,
        amount,
        fee?.chargedAmount || 0,
        fee?.chargedPayer || 'WAIVED',
        fee?.eganowCost || 0,
        fee?.platformMargin || 0,
        fee?.feeConfigVersionId || null
      ]
    )

    const leg = insert.rows[0] || (await client.query(
      `SELECT id, internal_reference, status, amount, payout_msisdn, institution_id, payout_leg, payment_gateway_status
         FROM transactions
        WHERE parent_transaction_id = $1 AND type = 'PAYOUT' AND payout_leg = $2 FOR UPDATE`,
      [parentTransactionId, payoutLeg]
    )).rows[0]
    if (leg) leg.created = Boolean(insert.rows[0])

    if (leg && payoutLeg === 'INSTITUTION' && destination.institutionId) {
      await client.query(
        `INSERT INTO institution_transactions
           (institution_id, type, status, amount, internal_reference, counterparty_transaction_id)
         VALUES ($1, 'COLLECTION', 'PENDING', $2, $3, $4)
         ON CONFLICT (internal_reference) DO NOTHING`,
        [destination.institutionId, leg.amount, `ICOL-${leg.id}`, leg.id]
      )
    }
    return leg
  })
}

async function updateLeg(leg, result) {
  const success = isGatewaySuccess(result.status)
  const failed = isGatewayFailure(result.status)
  const status = success ? 'PAID_OUT' : failed ? 'FAILED' : 'PENDING'

  await query(
    `UPDATE transactions
        SET status = $2,
            eganow_reference = COALESCE($3, eganow_reference),
            eganow_transaction_id = COALESCE($4, eganow_transaction_id),
            payment_gateway_status = COALESCE($5, payment_gateway_status),
            failure_reason = $6,
            completed_at = CASE WHEN $7 THEN now() ELSE completed_at END,
            updated_at = now()
      WHERE id = $1`,
    [
      leg.id,
      status,
      result.reference || null,
      result.transactionId || null,
      result.status || null,
      failed ? `Eganow payout returned ${result.status}.` : null,
      success
    ]
  )
  if (leg.payout_leg === 'INSTITUTION') {
    await query(
      `UPDATE institution_transactions
          SET status = CASE WHEN $2 = 'PAID_OUT' THEN 'RECEIVED'::institution_txn_status
                            WHEN $2 = 'FAILED' THEN 'FAILED'::institution_txn_status
                            ELSE 'PENDING'::institution_txn_status END,
              eganow_reference = COALESCE($3, eganow_reference)
        WHERE counterparty_transaction_id = $1`,
      [leg.id, status, result.reference || null]
    )
  }
  return status
}

export async function recordPeriodicAccrualAndVendorLeg(tx, { collectionTxn, merchant, rule }) {
  const baseAmount = Number(collectionTxn.base_amount ?? collectionTxn.amount)
  const calculated = calculateInstitutionAmount(baseAmount, rule)
  const { rows: inserted } = await tx.query(
    `INSERT INTO periodic_accrual_ledger
       (tenant_id, merchant_id, institution_id, split_rule_id, source_transaction_id, accrued_amount)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source_transaction_id, institution_id) DO NOTHING
     RETURNING accrued_amount`,
    [collectionTxn.tenant_id, collectionTxn.merchant_id, rule.institution_id, rule.id, collectionTxn.id, calculated]
  )
  const accruedAmount = Number(inserted[0]?.accrued_amount ?? (await tx.query(
    `SELECT accrued_amount FROM periodic_accrual_ledger WHERE source_transaction_id = $1 AND institution_id = $2`,
    [collectionTxn.id, rule.institution_id]
  )).rows[0]?.accrued_amount ?? calculated)
  let vendorAmount = baseAmount - accruedAmount
  const payoutFee = await computeFee(collectionTxn.tenant_id, 'PAYOUT', Math.max(0, vendorAmount), (sql, params) => tx.query(sql, params))
  vendorAmount = Math.round(vendorAmount * 100) / 100
  if (vendorAmount <= 0) throw new Error('Institution allocation leaves no positive vendor payout.')
  const payoutReference = `${createReference('PO')}-VENDOR`
  await tx.query(
    `INSERT INTO transactions
       (tenant_id, merchant_id, parent_transaction_id, type, payout_leg, status, amount, currency,
        internal_reference, payout_msisdn, base_amount, fee_charged_amount, fee_charged_payer,
        fee_eganow_cost, fee_platform_margin, fee_config_version_id, payment_gateway_status)
     VALUES ($1, $2, $3, 'PAYOUT', 'VENDOR', 'PENDING', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'READY')
     ON CONFLICT ON CONSTRAINT uq_transactions_parent_type_leg DO NOTHING`,
    [collectionTxn.tenant_id, collectionTxn.merchant_id, collectionTxn.id, vendorAmount, collectionTxn.currency,
      payoutReference, collectionTxn.payout_msisdn || merchant.mobile_money_number, baseAmount, payoutFee.chargedAmount,
      payoutFee.chargedPayer, payoutFee.eganowCost, payoutFee.platformMargin, payoutFee.feeConfigVersionId]
  )
}

export async function refreshSplitParentStatus(collectionId, allowPartial = false) {
  const { rows } = await query(
    `SELECT
       COUNT(*) FILTER (WHERE payout_leg IN ('VENDOR', 'INSTITUTION')) AS expected,
       COUNT(*) FILTER (WHERE payout_leg IN ('VENDOR', 'INSTITUTION') AND status = 'PAID_OUT') AS settled,
       COUNT(*) FILTER (WHERE payout_leg IN ('VENDOR', 'INSTITUTION') AND status = 'FAILED') AS failed,
       COUNT(*) FILTER (WHERE payout_leg IN ('VENDOR', 'INSTITUTION') AND status = 'PENDING') AS pending
     FROM transactions
    WHERE parent_transaction_id = $1 AND type = 'PAYOUT'`,
    [collectionId]
  )
  const state = rows[0]
  const { rows: parentRows } = await query(`SELECT status FROM transactions WHERE id = $1`, [collectionId])
  const exhaustedPartial = Number(state.failed) > 0 && Number(state.settled) > 0
  const status = Number(state.expected) > 0 && Number(state.expected) === Number(state.settled)
    ? 'PAID_OUT'
    : exhaustedPartial && (allowPartial || parentRows[0]?.status === 'PARTIALLY_SETTLED')
      ? 'PARTIALLY_SETTLED'
      : 'SWEPT_INTERNAL'

  await query(
    `UPDATE transactions
        SET status = $2,
            completed_at = CASE WHEN $2 = 'PAID_OUT' THEN now() ELSE completed_at END,
            updated_at = now()
      WHERE id = $1`,
    [collectionId, status]
  )
  return status
}

export async function processSplitPayout({ tenantId, merchantId, collectionTxn, merchant, rule, finalAttempt = false }) {
  const vendorOnlyForPeriodic = rule.mode === 'PERIODIC' && rule.vendor_payout_mode === 'PER_TRANSACTION'
  if (rule.mode !== 'PER_TRANSACTION' && !vendorOnlyForPeriodic) {
    return { skipped: true, reason: 'periodic-rule-requires-accrual-worker' }
  }

  const baseAmount = Number(collectionTxn.base_amount ?? collectionTxn.amount)
  let institutionAmount = calculateInstitutionAmount(baseAmount, rule)
  if (vendorOnlyForPeriodic) {
    const { rows } = await query(`SELECT accrued_amount FROM periodic_accrual_ledger
      WHERE source_transaction_id = $1 AND institution_id = $2`, [collectionTxn.id, rule.institution_id])
    if (rows[0]) institutionAmount = Number(rows[0].accrued_amount)
  }
  let vendorAmount = Math.round((baseAmount - institutionAmount) * 100) / 100
  const payoutFee = await computeFee(tenantId, 'PAYOUT', Math.max(0, vendorAmount))
  vendorAmount = Math.round(vendorAmount * 100) / 100
  if (vendorAmount <= 0) throw new Error('Institution split leaves no positive vendor payout.')
  const institution = {
    msisdn: rule.settlement_msisdn,
    institutionId: rule.institution_id
  }
  const vendor = {
    msisdn: collectionTxn.payout_msisdn || merchant.mobile_money_number,
    institutionId: null
  }

  const legs = vendorOnlyForPeriodic
    ? [{
        payoutLeg: 'VENDOR',
        amount: vendorAmount,
        destination: vendor,
        network: merchant.network_provider,
        narration: `Vendor payout for collection ${collectionTxn.internal_reference}`
      }]
    : [
        {
          payoutLeg: 'VENDOR',
          amount: vendorAmount,
          destination: vendor,
          network: merchant.network_provider,
          narration: `Vendor payout for collection ${collectionTxn.internal_reference}`
        },
        {
          payoutLeg: 'INSTITUTION',
          amount: institutionAmount,
          destination: institution,
          network: null,
          narration: `Institution payout for collection ${collectionTxn.internal_reference}`
        }
      ]
  if (!vendorOnlyForPeriodic && (rule.leg_execution_order === 'INSTITUTION_FIRST' || rule.priority_deduction_selected)) legs.reverse()

  const results = {}
  let pending = false
  let failure = null
  for (const legDefinition of legs) {
    const leg = await findOrCreateLeg({
      tenantId,
      merchantId,
      parentTransactionId: collectionTxn.id,
      payoutLeg: legDefinition.payoutLeg,
      amount: legDefinition.amount,
      currency: collectionTxn.currency,
      destination: legDefinition.destination,
      fee: legDefinition.payoutLeg === 'VENDOR' ? payoutFee : null
    })

    if (leg.status === 'PAID_OUT') {
      results[legDefinition.payoutLeg] = 'PAID_OUT'
      continue
    }

    if (!leg.created && (leg.status === 'PENDING' || leg.status === 'FAILED')) {
      if (leg.payment_gateway_status === 'READY') {
        await query(`UPDATE transactions SET payment_gateway_status = 'SUBMISSION_STARTED', updated_at = now() WHERE id = $1`, [leg.id])
        leg.payment_gateway_status = 'SUBMISSION_STARTED'
      } else {
      let statusResult
      try {
        statusResult = await queryTransactionStatus(tenantId, leg.internal_reference)
      } catch {
        pending = true
        results[legDefinition.payoutLeg] = 'PENDING'
        continue
      }
      if (isGatewaySuccess(statusResult.status)) {
        results[legDefinition.payoutLeg] = await updateLeg(leg, statusResult)
        continue
      }
      if (isGatewayPending(statusResult.status)) {
        pending = true
        results[legDefinition.payoutLeg] = 'PENDING'
        continue
      }
      if (!isGatewayFailure(statusResult.status)) {
        pending = true
        results[legDefinition.payoutLeg] = 'PENDING'
        continue
      }
      }
    }

    try {
      const result = await disburseToMobileMoney(tenantId, {
        reference: leg.internal_reference,
        amount: leg.amount,
        currency: collectionTxn.currency,
        accountNoOrCardNoOrMsisdn: legDefinition.destination.msisdn,
        accountName: legDefinition.payoutLeg === 'INSTITUTION' ? rule.settlement_account_name : 'Recipient',
        network: legDefinition.network,
        narration: legDefinition.narration
      })
      results[legDefinition.payoutLeg] = await updateLeg(leg, result)
      if (isGatewayFailure(result.status)) failure = failure || new EganowApiError(`Split ${legDefinition.payoutLeg} payout failed with status ${result.status}`, tenantId)
      else if (!isGatewaySuccess(result.status)) pending = true
    } catch (error) {
      pending = true
      failure = failure || error
      await enqueueCollectionStatusPollJob({ tenantId, merchantId, transactionId: leg.id })
    }
  }

  const parentStatus = await refreshSplitParentStatus(collectionTxn.id, finalAttempt)
  if (failure) throw failure
  if (pending) return { pending: true, results, status: parentStatus }
  return { status: parentStatus, results, vendorAmount, institutionAmount }
}
