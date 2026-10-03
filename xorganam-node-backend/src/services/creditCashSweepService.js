import crypto from 'node:crypto'
import { query, withTransaction } from '../db/pool.js'
import { disburseToMobileMoney, getPayoutWalletBalance, isGatewayFailure, isGatewaySuccess, queryTransactionStatus } from './eganowClient.js'

function reference() {
  return `CASH-SWEEP-${Date.now()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`
}

async function createCashSweepGroups() {
  return withTransaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('xorganam-credit-cash-sweep'))`)
    const { rows: scopes } = await tx.query(
      `SELECT tenant_id, merchant_id, institution_id
         FROM periodic_accrual_ledger
        WHERE status = 'PENDING' AND source_credit_installment_id IS NOT NULL
          AND swept_transaction_id IS NULL
        GROUP BY tenant_id, merchant_id, institution_id ORDER BY tenant_id, merchant_id, institution_id LIMIT 100`
    )
    const created = []
    for (const scope of scopes) {
      const { rows: accruals } = await tx.query(
        `SELECT id, accrued_amount FROM periodic_accrual_ledger
          WHERE tenant_id = $1 AND merchant_id = $2 AND institution_id = $3
            AND status = 'PENDING' AND source_credit_installment_id IS NOT NULL
            AND swept_transaction_id IS NULL
          FOR UPDATE`, [scope.tenant_id, scope.merchant_id, scope.institution_id]
      )
      if (!accruals.length) continue
      const total = accruals.reduce((sum, item) => sum + Number(item.accrued_amount), 0)
      const { rows: parentRows } = await tx.query(
        `INSERT INTO transactions (tenant_id, merchant_id, institution_id, type, status, amount, currency, internal_reference)
         VALUES ($1, $2, $3, 'SWEEP_PAYOUT', 'PENDING', $4, 'GHS', $5)
         RETURNING id`, [scope.tenant_id, scope.merchant_id, scope.institution_id, total, reference()]
      )
      const parentId = parentRows[0].id
      await tx.query(
        `INSERT INTO institution_sweep_ledger
           (institution_id, tenant_id, merchant_id, sweep_transaction_id, vendor_amount,
            institution_amount, status, period_key)
         VALUES ($1, $2, $3, $4, 0, $5, 'PENDING', CURRENT_DATE)`,
        [scope.institution_id, scope.tenant_id, scope.merchant_id, parentId, total]
      )
      await tx.query(
        `UPDATE periodic_accrual_ledger SET swept_transaction_id = $4, period_key = CURRENT_DATE
          WHERE id = ANY($1::uuid[]) AND tenant_id = $2 AND merchant_id = $3`,
        [accruals.map((item) => item.id), scope.tenant_id, scope.merchant_id, parentId]
      )
      created.push(parentId)
    }
    return created
  })
}

async function processCashSweep(parentId) {
  const { rows } = await query(
    `SELECT l.tenant_id, l.merchant_id, l.institution_id, l.institution_amount,
            l.status AS sweep_status, i.settlement_msisdn, m.network_provider,
            COALESCE((SELECT id FROM transactions leg WHERE leg.parent_transaction_id = t.id
                      AND leg.type = 'PAYOUT' AND leg.payout_leg = 'INSTITUTION' LIMIT 1), NULL) AS leg_id
       FROM institution_sweep_ledger l
       JOIN transactions t ON t.id = l.sweep_transaction_id
       JOIN institutions i ON i.id = l.institution_id
       JOIN merchants m ON m.id = l.merchant_id AND m.tenant_id = l.tenant_id
      WHERE l.sweep_transaction_id = $1 AND EXISTS (
        SELECT 1 FROM periodic_accrual_ledger a
         WHERE a.swept_transaction_id = l.sweep_transaction_id
           AND a.source_credit_installment_id IS NOT NULL AND a.status = 'PENDING'
      )`, [parentId]
  )
  const sweep = rows[0]
  if (!sweep) return { skipped: true }
  let leg
  if (sweep.leg_id) {
    const found = await query(`SELECT id, status, internal_reference, eganow_reference, amount FROM transactions WHERE id = $1`, [sweep.leg_id])
    leg = found.rows[0]
  }
  if (leg?.status === 'PAID_OUT') return completeCashSweep(parentId, leg.id)
  if (leg?.status === 'FAILED') {
    await query(`UPDATE institution_sweep_ledger SET status = 'PARTIALLY_SETTLED', institution_leg_status = 'FAILED', updated_at = now() WHERE sweep_transaction_id = $1`, [parentId])
    return { failed: true, manualReviewRequired: true }
  }

  const balance = await getPayoutWalletBalance(sweep.tenant_id)
  if (Number(balance) < Number(sweep.institution_amount)) {
    await query(`UPDATE institution_sweep_ledger SET status = 'ACCRUED_UNSWEPT', failure_reason = 'Insufficient payout-wallet balance.', updated_at = now() WHERE sweep_transaction_id = $1`, [parentId])
    return { accruedUnswept: true }
  }

  if (!leg) {
    const { rows: inserted } = await query(
      `INSERT INTO transactions
         (tenant_id, merchant_id, institution_id, parent_transaction_id, type, payout_leg,
          status, amount, currency, internal_reference, payout_msisdn)
       VALUES ($1, $2, $3, $4, 'PAYOUT', 'INSTITUTION', 'PENDING', $5, 'GHS', $6, $7)
       ON CONFLICT ON CONSTRAINT uq_transactions_parent_type_leg DO NOTHING
       RETURNING id, status, internal_reference, amount`,
      [sweep.tenant_id, sweep.merchant_id, sweep.institution_id, parentId, sweep.institution_amount, reference(), sweep.settlement_msisdn]
    )
    if (inserted[0]) leg = inserted[0]
    else {
      const existing = await query(`SELECT id, status, internal_reference, eganow_reference, amount FROM transactions WHERE parent_transaction_id = $1 AND type = 'PAYOUT' AND payout_leg = 'INSTITUTION'`, [parentId])
      leg = existing.rows[0]
    }
  }

  if (leg.eganow_reference) {
    const status = await queryTransactionStatus(sweep.tenant_id, leg.eganow_reference)
    if (isGatewaySuccess(status.status)) return markCashLegPaid(parentId, leg.id, status.status)
    if (isGatewayFailure(status.status)) return markCashLegFailed(parentId, leg.id, status.status)
    await query(`UPDATE institution_sweep_ledger SET status = 'PENDING', updated_at = now() WHERE sweep_transaction_id = $1`, [parentId])
    return { pending: true }
  }

  const result = await disburseToMobileMoney(sweep.tenant_id, {
    reference: leg.internal_reference, amount: leg.amount, currency: 'GHS',
    accountNoOrCardNoOrMsisdn: sweep.settlement_msisdn, network: sweep.network_provider,
    narration: `Cash installment institution split ${parentId}`
  })
  if (isGatewaySuccess(result.status)) return markCashLegPaid(parentId, leg.id, result.status, result)
  if (isGatewayFailure(result.status)) return markCashLegFailed(parentId, leg.id, result.status, result)
  await query(
    `UPDATE transactions SET eganow_reference = COALESCE($2, eganow_reference),
            eganow_transaction_id = COALESCE($3, eganow_transaction_id), payment_gateway_status = $4, updated_at = now()
      WHERE id = $1`, [leg.id, result.reference || null, result.transactionId || null, result.status || 'PENDING']
  )
  await query(`UPDATE institution_sweep_ledger SET status = 'PENDING', updated_at = now() WHERE sweep_transaction_id = $1`, [parentId])
  return { pending: true }
}

async function markCashLegPaid(parentId, legId, status, result = {}) {
  await query(
    `UPDATE transactions SET status = 'PAID_OUT', payment_gateway_status = $2,
            eganow_reference = COALESCE($3, eganow_reference),
            eganow_transaction_id = COALESCE($4, eganow_transaction_id), completed_at = now(), updated_at = now()
      WHERE id = $1`, [legId, status, result.reference || null, result.transactionId || null]
  )
  return completeCashSweep(parentId, legId)
}

async function markCashLegFailed(parentId, legId, status, result = {}) {
  await query(
    `UPDATE transactions SET status = 'FAILED', payment_gateway_status = $2,
            eganow_reference = COALESCE($3, eganow_reference),
            eganow_transaction_id = COALESCE($4, eganow_transaction_id),
            failure_reason = 'Eganow rejected the institution cash split payout.', completed_at = now(), updated_at = now()
      WHERE id = $1`, [legId, status, result.reference || null, result.transactionId || null]
  )
  await query(`UPDATE transactions SET status = 'PARTIALLY_SETTLED', updated_at = now() WHERE id = $1`, [parentId])
  await query(`UPDATE institution_sweep_ledger SET status = 'PARTIALLY_SETTLED', institution_leg_status = 'FAILED', failure_reason = 'Eganow rejected the institution cash split payout.', updated_at = now() WHERE sweep_transaction_id = $1`, [parentId])
  return { failed: true, manualReviewRequired: true }
}

async function completeCashSweep(parentId, legId) {
  return withTransaction(async (tx) => {
    await tx.query(`UPDATE transactions SET status = 'PAID_OUT', completed_at = now(), updated_at = now() WHERE id = $1`, [parentId])
    await tx.query(`UPDATE institution_sweep_ledger SET status = 'SETTLED', institution_leg_status = 'PAID_OUT', updated_at = now() WHERE sweep_transaction_id = $1`, [parentId])
    await tx.query(
      `UPDATE periodic_accrual_ledger SET status = 'SWEPT', swept_at = now()
        WHERE swept_transaction_id = $1 AND source_credit_installment_id IS NOT NULL AND status = 'PENDING'`, [parentId]
    )
    return { settled: true, legId }
  })
}

export async function runDueCreditCashSweeps() {
  await createCashSweepGroups()
  const { rows } = await query(
    `SELECT DISTINCT l.sweep_transaction_id
       FROM institution_sweep_ledger l
      WHERE l.sweep_transaction_id IS NOT NULL
        AND l.status IN ('PENDING', 'ACCRUED_UNSWEPT')
        AND EXISTS (SELECT 1 FROM periodic_accrual_ledger a
                     WHERE a.swept_transaction_id = l.sweep_transaction_id
                       AND a.source_credit_installment_id IS NOT NULL AND a.status = 'PENDING')
      ORDER BY l.sweep_transaction_id LIMIT 500`
  )
  const results = []
  for (const row of rows) results.push({ sweepId: row.sweep_transaction_id, ...(await processCashSweep(row.sweep_transaction_id)) })
  return results
}
