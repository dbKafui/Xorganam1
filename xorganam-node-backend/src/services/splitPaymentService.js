import crypto from 'node:crypto'
import { query, withTransaction } from '../db/pool.js'
import { enqueueCollectionStatusPollJob } from '../queue/queue.js'
import {
  disburseToMobileMoney,
  EganowApiError,
  isGatewayFailure,
  isGatewaySuccess
} from './eganowClient.js'

function calculateInstitutionAmount(collectionAmount, rule) {
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

async function findOrCreateLeg({ tenantId, merchantId, parentTransactionId, payoutLeg, amount, currency, destination }) {
  return withTransaction(async (client) => {
    const insert = await client.query(
      `INSERT INTO transactions
         (tenant_id, merchant_id, parent_transaction_id, type, payout_leg, status,
          amount, currency, internal_reference, payout_msisdn, institution_id)
       VALUES ($1, $2, $3, 'PAYOUT', $4, 'PENDING', $5, $6, $7, $8, $9)
       ON CONFLICT ON CONSTRAINT uq_transactions_parent_type_leg DO NOTHING
       RETURNING id, internal_reference, status, amount, payout_msisdn, institution_id`,
      [
        tenantId,
        merchantId,
        parentTransactionId,
        payoutLeg,
        amount,
        currency,
        createReference(`PO-${payoutLeg}`),
        destination.msisdn,
        destination.institutionId
      ]
    )

    if (insert.rows[0]) return insert.rows[0]

    const existing = await client.query(
      `SELECT id, internal_reference, status, amount, payout_msisdn, institution_id
         FROM transactions
        WHERE parent_transaction_id = $1 AND type = 'PAYOUT' AND payout_leg = $2`,
      [parentTransactionId, payoutLeg]
    )
    return existing.rows[0]
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
  return status
}

export async function refreshSplitParentStatus(collectionId) {
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
  const status = Number(state.expected) === 2 && Number(state.settled) === 2
    ? 'PAID_OUT'
    : Number(state.failed) > 0 || Number(state.settled) > 0
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

export async function processSplitPayout({ tenantId, merchantId, collectionTxn, merchant, rule }) {
  if (rule.mode !== 'PER_TRANSACTION') {
    return { skipped: true, reason: 'periodic-rule-requires-accrual-worker' }
  }

  const institutionAmount = calculateInstitutionAmount(collectionTxn.amount, rule)
  const vendorAmount = Math.round((Number(collectionTxn.amount) - institutionAmount) * 100) / 100
  const institution = {
    msisdn: rule.settlement_msisdn,
    institutionId: rule.institution_id
  }
  const vendor = {
    msisdn: collectionTxn.payout_msisdn || merchant.mobile_money_number,
    institutionId: null
  }

  const legs = [
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
  if (rule.leg_execution_order === 'INSTITUTION_FIRST') legs.reverse()

  const results = {}
  for (const legDefinition of legs) {
    const leg = await findOrCreateLeg({
      tenantId,
      merchantId,
      parentTransactionId: collectionTxn.id,
      payoutLeg: legDefinition.payoutLeg,
      amount: legDefinition.amount,
      currency: collectionTxn.currency,
      destination: legDefinition.destination
    })

    if (leg.status === 'PAID_OUT') {
      results[legDefinition.payoutLeg] = 'PAID_OUT'
      continue
    }

    const result = await disburseToMobileMoney(tenantId, {
      reference: leg.internal_reference,
      amount: leg.amount,
      currency: collectionTxn.currency,
      accountNoOrCardNoOrMsisdn: legDefinition.destination.msisdn,
      network: legDefinition.network,
      narration: legDefinition.narration
    })
    results[legDefinition.payoutLeg] = await updateLeg(leg, result)

    if (!isGatewaySuccess(result.status)) {
      if (isGatewayFailure(result.status)) {
        throw new EganowApiError(`Split ${legDefinition.payoutLeg} payout failed with status ${result.status}`, tenantId, null, result.raw)
      }
      await enqueueCollectionStatusPollJob({ tenantId, merchantId, transactionId: leg.id })
      return { pending: true, results }
    }
  }

  const parentStatus = await refreshSplitParentStatus(collectionTxn.id)
  return { status: parentStatus, results, vendorAmount, institutionAmount }
}
