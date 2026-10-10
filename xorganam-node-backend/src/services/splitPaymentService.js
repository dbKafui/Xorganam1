import { query, withTransaction } from '../db/pool.js'
import { enqueueCollectionStatusPollJob } from '../queue/queue.js'
import { computeFee } from './feeService.js'
import { createVendorReference } from './referenceIds.js'
import {
  disburseToMobileMoney,
  EganowApiError,
  isGatewayFailure,
  isGatewaySuccess,
  isGatewayPending,
  queryTransactionStatus
} from './eganowClient.js'
import { retryFailedSplitPayout, updateTransactionStatus } from './transactionStateService.js'
import { updateInstitutionTransactionStatus } from './institutionStateService.js'
import { resolveSplitParentStatus } from './splitSettlementState.js'
import { amountForRule } from '../lib/periodicSettlementMoney.js'
import { normalizeAmountMinorUnits, formatMinorUnits } from './providerResultValidation.js'

export function calculateInstitutionAmount(collectionAmount, rule) {
  return amountForRule(collectionAmount, rule)
}

async function findOrCreateLeg({ tenantId, merchantId, merchantName, parentTransactionId, payoutLeg, amount, currency, destination, fee }) {
  return withTransaction(async (client) => {
    const insert = await client.query(
      `INSERT INTO transactions
         (tenant_id, merchant_id, parent_transaction_id, type, payout_leg, status,
          amount, currency, internal_reference, payout_msisdn, institution_id, base_amount,
          fee_charged_amount, fee_charged_payer, fee_eganow_cost, fee_platform_margin, fee_config_version_id)
       VALUES ($1, $2, $3, 'PAYOUT', $4, 'PENDING', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT ON CONSTRAINT uq_transactions_parent_type_leg DO NOTHING
      RETURNING id, internal_reference, status, amount, payout_msisdn, institution_id, payout_leg, payment_gateway_status, payout_retry_count`,
      [
        tenantId,
        merchantId,
        parentTransactionId,
        payoutLeg,
        amount,
        currency,
        createVendorReference(merchantName, payoutLeg === 'INSTITUTION' ? 'INST' : 'PO'),
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
      `SELECT id, internal_reference, status, amount, payout_msisdn, institution_id, payout_leg, payment_gateway_status, payout_retry_count
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

async function reopenFailedSplitLeg(leg, merchantName) {
  const internalReference = createVendorReference(merchantName, leg.payout_leg === 'INSTITUTION' ? 'INST' : 'PO')
  return withTransaction(async (client) => {
    const retry = await retryFailedSplitPayout(client, { id: leg.id, internalReference })
    if (retry.exhausted) return retry

    if (leg.payout_leg === 'INSTITUTION') {
      const { rows } = await client.query(
        `SELECT id, institution_id, status FROM institution_transactions
          WHERE counterparty_transaction_id = $1 FOR UPDATE`,
        [leg.id]
      )
      for (const institutionTransaction of rows) {
        await updateInstitutionTransactionStatus(client, {
          id: institutionTransaction.id,
          institutionId: institutionTransaction.institution_id,
          currentStatus: institutionTransaction.status,
          nextStatus: 'PENDING',
          fields: { eganow_reference: null }
        })
      }
    }
    return retry
  })
}

async function claimSplitPayoutSubmission(legId) {
  const { rows } = await query(
    `UPDATE transactions
        SET payment_gateway_status = 'SUBMISSION_STARTED', updated_at = now()
      WHERE id = $1 AND type = 'PAYOUT' AND status = 'PENDING'
        AND (payment_gateway_status IS NULL OR payment_gateway_status = 'READY')
      RETURNING id`,
    [legId]
  )
  return rows.length > 0
}

async function updateLeg(leg, result) {
  const success = isGatewaySuccess(result.status)
  const failed = isGatewayFailure(result.status)
  const status = success ? 'PAID_OUT' : failed ? 'FAILED' : 'PENDING'
  const fields = {
    eganow_reference: result.reference || null,
    eganow_transaction_id: result.transactionId || null,
    payment_gateway_status: result.status || null,
    failure_reason: failed ? `Eganow payout returned ${result.status}.` : null,
    completed_at: status === 'PENDING' ? null : new Date()
  }

  if (status === 'PENDING') {
    await query(
      `UPDATE transactions
          SET eganow_reference = COALESCE($2, eganow_reference),
              eganow_transaction_id = COALESCE($3, eganow_transaction_id),
              payment_gateway_status = COALESCE($4, payment_gateway_status),
              failure_reason = $5,
              updated_at = now()
        WHERE id = $1 AND status = 'PENDING'`,
      [leg.id, fields.eganow_reference, fields.eganow_transaction_id, fields.payment_gateway_status, fields.failure_reason]
    )
    return status
  }

  await withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT status FROM transactions WHERE id = $1 AND type = \'PAYOUT\' FOR UPDATE',
      [leg.id]
    )
    if (!rows.length) throw new Error('Split payout transaction was not found.')
    await updateTransactionStatus(client, {
      id: leg.id,
      type: 'PAYOUT',
      currentStatus: rows[0].status,
      nextStatus: status,
      fields
    })

    if (leg.payout_leg === 'INSTITUTION') {
      const institutionTransactions = await client.query(
        `SELECT id, institution_id, status FROM institution_transactions
          WHERE counterparty_transaction_id = $1 FOR UPDATE`,
        [leg.id]
      )
      for (const institutionTransaction of institutionTransactions.rows) {
        await updateInstitutionTransactionStatus(client, {
          id: institutionTransaction.id,
          institutionId: institutionTransaction.institution_id,
          currentStatus: institutionTransaction.status,
          nextStatus: status === 'PAID_OUT' ? 'RECEIVED' : 'FAILED',
          fields: { eganow_reference: result.reference || null }
        })
      }
    }
  })
  return status
}

export async function recordPeriodicAccrualAndVendorLeg(tx, { collectionTxn, merchant, rule }) {
  const baseAmount = String(collectionTxn.base_amount ?? collectionTxn.amount)
  const calculated = calculateInstitutionAmount(baseAmount, rule)
  const { rows: inserted } = await tx.query(
    `INSERT INTO periodic_accrual_ledger
       (tenant_id, merchant_id, institution_id, split_rule_id, source_transaction_id, accrued_amount)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source_transaction_id, institution_id) DO NOTHING
     RETURNING accrued_amount`,
    [collectionTxn.tenant_id, collectionTxn.merchant_id, rule.institution_id, rule.id, collectionTxn.id, calculated]
  )
  const accruedAmount = String(inserted[0]?.accrued_amount ?? (await tx.query(
    `SELECT accrued_amount FROM periodic_accrual_ledger WHERE source_transaction_id = $1 AND institution_id = $2`,
    [collectionTxn.id, rule.institution_id]
  )).rows[0]?.accrued_amount ?? calculated)
  const baseCents = normalizeAmountMinorUnits(baseAmount)
  const accruedCents = normalizeAmountMinorUnits(accruedAmount)
  if (baseCents === null || accruedCents === null) throw new Error('Periodic split contains unsupported amount precision.')
  const vendorCents = baseCents - accruedCents
  if (vendorCents <= 0n) throw new Error('Institution allocation leaves no positive vendor payout.')
  const vendorAmount = formatMinorUnits(vendorCents)
  const payoutFee = await computeFee(collectionTxn.tenant_id, 'PAYOUT', vendorAmount, (sql, params) => tx.query(sql, params))
  const payoutReference = createVendorReference(merchant?.display_name, 'PO')
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
  const currentStatus = parentRows[0]?.status
  const status = resolveSplitParentStatus({ ...state, currentStatus, allowPartial })

  if (currentStatus !== status) {
    await updateTransactionStatus(query, {
      id: collectionId,
      type: 'COLLECTION',
      currentStatus,
      nextStatus: status,
      fields: {
        completed_at: status === 'PAID_OUT' ? new Date() : null
      }
    })
  }
  return status
}

function contributionFrequencyIsDue(frequency, lastAt, now = new Date()) {
  if (!lastAt || frequency === 'PER_PAYOUT') return true
  const previous = new Date(lastAt)
  if (frequency === 'DAILY') return previous.toISOString().slice(0, 10) !== now.toISOString().slice(0, 10)
  if (frequency === 'MONTHLY') return previous.getUTCFullYear() !== now.getUTCFullYear() || previous.getUTCMonth() !== now.getUTCMonth()
  const weekStart = (date) => {
    const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
    value.setUTCDate(value.getUTCDate() - ((value.getUTCDay() + 6) % 7))
    return value.toISOString().slice(0, 10)
  }
  return weekStart(previous) !== weekStart(now)
}

export async function loadVendorPackagePayoutRule({ tenantId, merchantId, triggerMode }) {
  const { rows } = await query(
    `SELECT DISTINCT i.id AS institution_id, i.settlement_msisdn, i.settlement_account_name
       FROM institution_financial_accounts a
       JOIN institution_member_merchant vm ON vm.id = a.vendor_link_id AND vm.tenant_id = $1 AND vm.merchant_id = $2
       JOIN institution_member im ON im.id = vm.member_id AND im.institution_id = vm.institution_id AND im.status = 'APPROVED'
       JOIN institution_customers c ON c.id = a.customer_id AND c.institution_id = a.institution_id
        AND c.tenant_id = vm.tenant_id AND c.is_active AND c.kyc_status = 'VERIFIED'
       JOIN institution_financial_products p ON p.id = a.product_id AND p.institution_id = a.institution_id
       JOIN institutions i ON i.id = a.institution_id AND i.status = 'ACTIVE'
       JOIN tenant_institution_links l ON l.institution_id = a.institution_id AND l.tenant_id = vm.tenant_id
        AND l.status = 'ACTIVE' AND l.verification_status = 'APPROVED'
       LEFT JOIN institution_vendor_payout_rules vr ON vr.account_id = a.id AND vr.active
      WHERE a.status IN ('ACTIVE', 'OVERDUE') AND p.status = 'ACTIVE'
        AND (p.product_type = 'LOAN' AND a.status = 'OVERDUE'
          OR p.product_type IN ('SAVINGS', 'INVESTMENT') AND vr.account_id IS NOT NULL
            AND vr.trigger_mode IN ($3, 'BOTH'))
      ORDER BY i.id LIMIT 2`, [tenantId, merchantId, triggerMode]
  )
  if (rows.length > 1) return { unsupported_multi_institution: true }
  if (!rows.length) return null
  return {
    id: null,
    institution_id: rows[0].institution_id,
    settlement_msisdn: rows[0].settlement_msisdn,
    settlement_account_name: rows[0].settlement_account_name,
    mode: 'PER_TRANSACTION',
    type: 'FIXED',
    amount: 0,
    leg_execution_order: 'INSTITUTION_FIRST',
    vendor_payout_mode: 'PER_TRANSACTION',
    priority_deduction_selected: false
  }
}

async function prepareVendorFinancialAllocations({ collectionTxn, merchantId, institutionId, availableCents, triggerMode }) {
  return withTransaction(async (tx) => {
    const { rows: existing } = await tx.query(
      `SELECT account_id, allocation_type, amount_cents FROM institution_split_financial_allocations
        WHERE sweep_transaction_id = $1 AND source_transaction_id = $1 AND institution_id = $2
        ORDER BY created_at, id`, [collectionTxn.id, institutionId]
    )
    if (existing.length) return {
      amountCents: existing.reduce((sum, row) => sum + BigInt(row.amount_cents), 0n).toString(),
      rows: existing
    }

    const { rows: accounts } = await tx.query(
      `SELECT a.id AS account_id, a.status AS account_status, a.outstanding_cents, a.balance_cents,
              COALESCE((SELECT sum(i.amount_due_cents - i.amount_paid_cents)
                 FROM institution_loan_installments i WHERE i.account_id = a.id
                  AND i.status = 'OVERDUE' AND i.amount_paid_cents < i.amount_due_cents), 0)::bigint AS overdue_due_cents,
              COALESCE((SELECT sum(x.amount_cents) FROM institution_split_financial_allocations x
                 WHERE x.account_id = a.id AND x.allocation_type = 'LOAN_REPAYMENT' AND x.status = 'PENDING'), 0)::bigint AS pending_loan_cents,
              p.product_type, rule.trigger_mode, rule.frequency, rule.minimum_payout_cents,
              rule.calculation_type, rule.calculation_value,
              (SELECT max(x.created_at) FROM institution_split_financial_allocations x
                WHERE x.account_id = a.id) AS last_allocation_at
         FROM institution_financial_accounts a
         JOIN institution_member_merchant vm ON vm.id = a.vendor_link_id
          AND vm.institution_id = a.institution_id AND vm.tenant_id = $1 AND vm.merchant_id = $2
         JOIN institution_customers c ON c.id = a.customer_id AND c.institution_id = a.institution_id
          AND c.tenant_id = vm.tenant_id AND c.is_active AND c.kyc_status = 'VERIFIED'
         JOIN institution_financial_products p ON p.id = a.product_id AND p.institution_id = a.institution_id
         JOIN tenant_institution_links link ON link.tenant_id = vm.tenant_id AND link.institution_id = vm.institution_id
          AND link.status = 'ACTIVE' AND link.verification_status = 'APPROVED'
         LEFT JOIN institution_vendor_payout_rules rule ON rule.account_id = a.id AND rule.active
        WHERE a.institution_id = $3 AND a.status IN ('ACTIVE', 'OVERDUE')
          AND p.status = 'ACTIVE'
          AND (p.product_type = 'LOAN' AND a.status = 'OVERDUE'
            OR p.product_type IN ('SAVINGS', 'INVESTMENT') AND rule.account_id IS NOT NULL
              AND rule.trigger_mode IN ($4, 'BOTH'))
        ORDER BY CASE WHEN p.product_type = 'LOAN' THEN 0 ELSE 1 END, a.created_at, a.id
        FOR UPDATE OF a`,
      [collectionTxn.tenant_id, merchantId, institutionId, triggerMode]
    )
    let remaining = BigInt(availableCents)
    const created = []
    const payoutCents = normalizeAmountMinorUnits(collectionTxn.base_amount ?? collectionTxn.amount)
    if (payoutCents === null) throw new Error('Collection payout amount has unsupported precision.')
    for (const account of accounts) {
      if (remaining <= 0n) break
      let allocation = 0n
      let type
      if (account.product_type === 'LOAN') {
        const capacity = [remaining,
          BigInt(account.outstanding_cents) - BigInt(account.pending_loan_cents),
          BigInt(account.overdue_due_cents) - BigInt(account.pending_loan_cents)]
        allocation = capacity.reduce((smallest, value) => value < smallest ? value : smallest)
        type = 'LOAN_REPAYMENT'
      } else {
        if (payoutCents < BigInt(account.minimum_payout_cents)) continue
        if (!contributionFrequencyIsDue(account.frequency, account.last_allocation_at)) continue
        allocation = account.calculation_type === 'PERCENTAGE'
          ? (payoutCents * BigInt(account.calculation_value) + 5000n) / 10000n
          : BigInt(account.calculation_value)
        if (allocation > remaining) allocation = remaining
        type = account.product_type === 'SAVINGS' ? 'SAVINGS_CONTRIBUTION' : 'INVESTMENT_CONTRIBUTION'
      }
      if (allocation <= 0n) continue
      const { rows } = await tx.query(
        `INSERT INTO institution_split_financial_allocations
           (institution_id, sweep_transaction_id, source_transaction_id, account_id, allocation_type, amount_cents, status)
         VALUES ($1, $2, $2, $3, $4, $5, 'PENDING')
         ON CONFLICT DO NOTHING
         RETURNING account_id, allocation_type, amount_cents`,
        [institutionId, collectionTxn.id, account.account_id, type, String(allocation)]
      )
      if (rows[0]) {
        created.push(rows[0])
        remaining -= allocation
      }
    }
    return { amountCents: created.reduce((sum, row) => sum + BigInt(row.amount_cents), 0n).toString(), rows: created }
  })
}

async function postVendorFinancialAllocations(collectionId, institutionId) {
  await withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT id, account_id, allocation_type, amount_cents FROM institution_split_financial_allocations
        WHERE sweep_transaction_id = $1 AND source_transaction_id = $1 AND institution_id = $2 AND status = 'PENDING'
        FOR UPDATE`, [collectionId, institutionId]
    )
    for (const allocation of rows) {
      const amount = BigInt(allocation.amount_cents)
      if (allocation.allocation_type === 'LOAN_REPAYMENT') {
        const { rows: installments } = await tx.query(
          `SELECT id, amount_due_cents, amount_paid_cents FROM institution_loan_installments
            WHERE account_id = $1 AND status = 'OVERDUE' AND status <> 'PAID'
            ORDER BY due_date, installment_number FOR UPDATE`, [allocation.account_id]
        )
        let remaining = amount
        for (const installment of installments) {
          if (!remaining) break
          const due = BigInt(installment.amount_due_cents) - BigInt(installment.amount_paid_cents)
          const paid = remaining < due ? remaining : due
          if (paid <= 0n) continue
          const totalPaid = BigInt(installment.amount_paid_cents) + paid
          await tx.query(
            `UPDATE institution_loan_installments SET amount_paid_cents = $2,
                status = CASE WHEN $2 = amount_due_cents THEN 'PAID' ELSE 'PARTIALLY_PAID' END, updated_at = now()
              WHERE id = $1`, [installment.id, String(totalPaid)]
          )
          remaining -= paid
        }
        if (remaining > 0) throw new Error('Loan allocation exceeds the unpaid installment schedule.')
        await tx.query(
          `UPDATE institution_financial_accounts a SET outstanding_cents = GREATEST(0, outstanding_cents - $2),
              status = CASE WHEN a.outstanding_cents <= $2 THEN 'SETTLED'::institution_financial_account_status
                WHEN EXISTS (SELECT 1 FROM institution_loan_installments i WHERE i.account_id = a.id
                  AND i.status = 'OVERDUE' AND i.amount_paid_cents < i.amount_due_cents)
                THEN 'OVERDUE'::institution_financial_account_status ELSE 'ACTIVE'::institution_financial_account_status END,
              updated_at = now() WHERE a.id = $1`, [allocation.account_id, String(amount)]
        )
      } else {
        await tx.query(
          `UPDATE institution_financial_accounts SET balance_cents = balance_cents + $2,
              status = 'ACTIVE', updated_at = now() WHERE id = $1`, [allocation.account_id, String(amount)]
        )
      }
      await tx.query(`UPDATE institution_split_financial_allocations SET status = 'POSTED' WHERE id = $1`, [allocation.id])
    }
  })
}

export async function processSplitPayout({ tenantId, merchantId, collectionTxn, merchant, rule, triggerMode = 'AUTO', finalAttempt = false }) {
  if (rule.unsupported_multi_institution) {
    throw new Error('This payout has opted-in packages at multiple institutions. External payout is held until multi-institution payout legs are available.')
  }
  const vendorOnlyForPeriodic = rule.mode === 'PERIODIC' && rule.vendor_payout_mode === 'PER_TRANSACTION'
  if (rule.mode !== 'PER_TRANSACTION' && !vendorOnlyForPeriodic) {
    return { skipped: true, reason: 'periodic-rule-requires-accrual-worker' }
  }

  const baseAmount = String(collectionTxn.base_amount ?? collectionTxn.amount)
  const baseCents = normalizeAmountMinorUnits(baseAmount)
  if (baseCents === null) throw new Error('Collection payout amount has unsupported precision.')
  let institutionAmount = calculateInstitutionAmount(baseAmount, rule)
  if (vendorOnlyForPeriodic) {
    // This ledger entry and vendor payout leg belong to the payout decision.
    // Do not create either when collection or the internal wallet transfer
    // merely completes; the vendor may still be holding funds in the payout wallet.
    await withTransaction((tx) => recordPeriodicAccrualAndVendorLeg(tx, { collectionTxn, merchant, rule }))
    const { rows } = await query(`SELECT accrued_amount FROM periodic_accrual_ledger
      WHERE source_transaction_id = $1 AND institution_id = $2`, [collectionTxn.id, rule.institution_id])
    if (rows[0]) institutionAmount = String(rows[0].accrued_amount)
  }
  const financialAllocations = vendorOnlyForPeriodic
    ? { amountCents: 0, rows: [] }
    : await prepareVendorFinancialAllocations({
        collectionTxn, merchantId, institutionId: rule.institution_id,
        availableCents: baseCents - (normalizeAmountMinorUnits(institutionAmount) ?? 0n), triggerMode
      })
  const institutionCents = (normalizeAmountMinorUnits(institutionAmount) ?? 0n) + BigInt(financialAllocations.amountCents)
  const vendorCents = baseCents - institutionCents
  if (vendorCents < 0n) throw new Error('Institution allocations exceed the source payout amount.')
  const institutionAmountExact = formatMinorUnits(institutionCents)
  const vendorAmount = formatMinorUnits(vendorCents)
  const payoutFee = vendorCents > 0n ? await computeFee(tenantId, 'PAYOUT', vendorAmount) : null
  if (vendorCents === 0n && institutionCents === 0n) throw new Error('No positive payout allocation is available.')
  const institution = {
    msisdn: rule.settlement_msisdn,
    institutionId: rule.institution_id
  }
  const vendor = {
    msisdn: collectionTxn.payout_msisdn || merchant.mobile_money_number,
    institutionId: null
  }

  const legs = vendorOnlyForPeriodic
    ? (vendorCents > 0n ? [{
        payoutLeg: 'VENDOR',
        amount: vendorAmount,
        destination: vendor,
        network: merchant.network_provider,
        narration: `Vendor payout for collection ${collectionTxn.internal_reference}`
      }] : [])
    : [
        ...(vendorCents > 0n ? [{
          payoutLeg: 'VENDOR',
          amount: vendorAmount,
          destination: vendor,
          network: merchant.network_provider,
          narration: `Vendor payout for collection ${collectionTxn.internal_reference}`
        }] : []),
        ...(institutionCents > 0n ? [{
          payoutLeg: 'INSTITUTION',
          amount: institutionAmountExact,
          destination: institution,
          network: null,
          narration: `Institution payout for collection ${collectionTxn.internal_reference}`
        }] : [])
      ]
  if (!vendorOnlyForPeriodic && (rule.leg_execution_order === 'INSTITUTION_FIRST' || rule.priority_deduction_selected)) legs.reverse()

  const results = {}
  let pending = false
  let failure = null
  for (const legDefinition of legs) {
    const leg = await findOrCreateLeg({
      tenantId,
      merchantId,
      merchantName: merchant.display_name,
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

    if (!leg.created && (leg.status === 'PENDING' || leg.status === 'FAILED')
      && !(leg.status === 'PENDING' && leg.payment_gateway_status === 'READY')) {
      let statusResult
      try {
        statusResult = await queryTransactionStatus(tenantId, leg.internal_reference, { merchantId })
      } catch {
        pending = true
        results[legDefinition.payoutLeg] = 'PENDING'
        continue
      }
      if (isGatewaySuccess(statusResult.status)) {
        if (leg.status === 'FAILED') {
          throw new EganowApiError('Provider status conflicts with the terminal split payout state. Manual reconciliation is required.', tenantId)
        }
        results[legDefinition.payoutLeg] = await updateLeg(leg, statusResult)
        continue
      }
      if (isGatewayPending(statusResult.status)) {
        pending = true
        results[legDefinition.payoutLeg] = 'PENDING'
        await enqueueCollectionStatusPollJob({ tenantId, merchantId, transactionId: leg.id })
        continue
      }
      if (!isGatewayFailure(statusResult.status)) {
        pending = true
        results[legDefinition.payoutLeg] = 'PENDING'
        await enqueueCollectionStatusPollJob({ tenantId, merchantId, transactionId: leg.id })
        continue
      }

      if (leg.status === 'PENDING') {
        await updateLeg(leg, statusResult)
        leg.status = 'FAILED'
      }
      const retry = await reopenFailedSplitLeg(leg, merchant.display_name)
      if (retry.exhausted) {
        results[legDefinition.payoutLeg] = 'FAILED'
        failure = failure || new EganowApiError('Split payout retry limit reached. Manual reconciliation is required.', tenantId)
        continue
      }
      leg.status = 'PENDING'
      leg.internal_reference = retry.internalReference
      leg.payment_gateway_status = 'READY'
      leg.payout_retry_count = retry.retryCount
    }

    if (leg.payment_gateway_status !== 'SUBMISSION_STARTED'
      && !(await claimSplitPayoutSubmission(leg.id))) {
      pending = true
      results[legDefinition.payoutLeg] = 'PENDING'
      continue
    }

    try {
      const result = await disburseToMobileMoney(tenantId, {
        merchantId,
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
      else if (!isGatewaySuccess(result.status)) {
        pending = true
        await enqueueCollectionStatusPollJob({ tenantId, merchantId, transactionId: leg.id })
      }
    } catch (error) {
      pending = true
      failure = failure || error
      await enqueueCollectionStatusPollJob({ tenantId, merchantId, transactionId: leg.id })
    }
  }

  const parentStatus = await refreshSplitParentStatus(collectionTxn.id, finalAttempt)
  if (results.INSTITUTION === 'PAID_OUT' && financialAllocations.rows.length) {
    await postVendorFinancialAllocations(collectionTxn.id, rule.institution_id)
  }
  if (failure) throw failure
  if (pending) return { pending: true, results, status: parentStatus }
  return { status: parentStatus, results, vendorAmount, institutionAmount }
}
