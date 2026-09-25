import crypto from 'node:crypto'
import { query, withTransaction } from '../db/pool.js'
import {
  disburseToMobileMoney,
  getPayoutWalletBalance,
  isGatewayFailure,
  isGatewaySuccess,
  queryTransactionStatus
} from './eganowClient.js'

const RETRY_WINDOW_MS = 10 * 60 * 1000

export class SweepPendingError extends Error {}

function scheduleValue(schedule) {
  const unit = String(schedule?.unit || '').toUpperCase()
  const interval = Number(schedule?.interval)
  if (!['DAYS', 'WEEKS', 'MONTHS', 'YEARS'].includes(unit) || !Number.isInteger(interval) || interval < 1) {
    throw new Error('Invalid periodic schedule.')
  }
  return { unit, interval }
}

function addPeriod(date, schedule, count) {
  const result = new Date(`${date}T00:00:00.000Z`)
  const amount = schedule.interval * count
  if (schedule.unit === 'DAYS') result.setUTCDate(result.getUTCDate() + amount)
  if (schedule.unit === 'WEEKS') result.setUTCDate(result.getUTCDate() + amount * 7)
  if (schedule.unit === 'MONTHS') result.setUTCMonth(result.getUTCMonth() + amount)
  if (schedule.unit === 'YEARS') result.setUTCFullYear(result.getUTCFullYear() + amount)
  return result.toISOString().slice(0, 10)
}

function dateDifferenceInPeriods(anchor, now, schedule) {
  const start = new Date(`${anchor}T00:00:00.000Z`)
  const current = new Date(`${now}T00:00:00.000Z`)
  if (schedule.unit === 'DAYS' || schedule.unit === 'WEEKS') {
    const days = Math.floor((current - start) / 86400000)
    return Math.floor(days / (schedule.interval * (schedule.unit === 'WEEKS' ? 7 : 1)))
  }
  const months = (current.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    current.getUTCMonth() - start.getUTCMonth()
  return Math.floor(months / (schedule.interval * (schedule.unit === 'YEARS' ? 12 : 1)))
}

function completedPeriod(anchor, schedule, now = new Date()) {
  const today = now.toISOString().slice(0, 10)
  if (schedule.unit === 'YEARS') {
    const anchorYear = Number(String(anchor).slice(0, 4))
    const currentYear = now.getUTCFullYear()
    const elapsedYears = currentYear - anchorYear
    const block = Math.floor(elapsedYears / schedule.interval)
    if (block < 1) return null
    const endYear = anchorYear + block * schedule.interval
    return {
      key: `${endYear - schedule.interval}-01-01`,
      start: `${endYear - schedule.interval}-01-01`,
      end: `${endYear}-01-01`
    }
  }
  const periodsElapsed = dateDifferenceInPeriods(anchor, today, schedule)
  if (periodsElapsed < 1) return null
  return {
    key: addPeriod(anchor, schedule, periodsElapsed - 1),
    start: addPeriod(anchor, schedule, periodsElapsed - 1),
    end: addPeriod(anchor, schedule, periodsElapsed)
  }
}

function amountForRule(amount, rule) {
  const value = rule.type === 'PERCENTAGE'
    ? Number(amount) * Number(rule.amount) / 100
    : Number(rule.amount)
  if (!Number.isFinite(value) || value < 0 || value > Number(amount)) {
    throw new Error(`Invalid periodic split rule ${rule.id}.`)
  }
  return Math.round(value * 100) / 100
}

function reference(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`
}

async function loadDueConfigurations(now) {
  const { rows } = await query(
    `SELECT c.*, i.name AS institution_name, i.settlement_msisdn,
            i.settlement_account_name, m.display_name, m.mobile_money_number,
         m.network_provider, m.eganow_payout_account_id
       FROM tenant_merchant_settlement_config c
       JOIN institutions i ON i.id = c.institution_id
       JOIN merchants m ON m.id = c.merchant_id AND m.tenant_id = c.tenant_id
      WHERE c.frequency_mode = 'PERIODIC' AND m.is_active
      ORDER BY c.created_at`,
    []
  )
  return rows.map((row) => ({ ...row, period: completedPeriod(row.schedule_anchor_date, scheduleValue(row.periodic_schedule), now) }))
    .filter((row) => row.period)
}

async function accrueConfiguration(config) {
  const { rows: sourceRows } = await query(
    `    SELECT DISTINCT ON (t.id) t.id, t.amount, t.created_at, r.id AS split_rule_id, r.amount AS rule_amount,
            r.type AS rule_type
       FROM transactions t
       JOIN split_rules r
         ON r.tenant_id = t.tenant_id AND r.institution_id = $3
        AND r.mode = 'PERIODIC' AND r.active
        AND (r.merchant_id = t.merchant_id OR r.merchant_id IS NULL)
      WHERE t.tenant_id = $1 AND t.merchant_id = $2
        AND t.type = 'COLLECTION'
        AND t.status IN ('RECEIVED', 'SWEPT_INTERNAL', 'PAID_OUT', 'PARTIALLY_SETTLED')
        AND t.created_at >= $4::date AND t.created_at < $5::date
      ORDER BY t.id, CASE WHEN r.merchant_id = t.merchant_id THEN 0 ELSE 1 END, r.created_at DESC`,
    [config.tenant_id, config.merchant_id, config.institution_id, config.period.start, config.period.end]
  )

  for (const source of sourceRows) {
    const institutionAmount = amountForRule(source.amount, {
      id: source.split_rule_id,
      amount: source.rule_amount,
      type: source.rule_type
    })
    await query(
      `INSERT INTO periodic_accrual_ledger
         (tenant_id, merchant_id, institution_id, split_rule_id, source_transaction_id, accrued_amount, period_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (source_transaction_id) DO NOTHING`,
      [config.tenant_id, config.merchant_id, config.institution_id, source.split_rule_id, source.id, institutionAmount, config.period.key]
    )
  }
}

async function createSweep(config) {
  const { rows: totals } = await query(
    `SELECT COALESCE(SUM(a.accrued_amount) FILTER (WHERE a.status = 'PENDING'), 0) AS institution_amount,
            COALESCE(SUM(t.amount - a.accrued_amount) FILTER (WHERE a.status = 'PENDING'), 0) AS vendor_amount
       FROM periodic_accrual_ledger a
       JOIN transactions t ON t.id = a.source_transaction_id
      WHERE a.tenant_id = $1 AND a.merchant_id = $2 AND a.institution_id = $3
        AND a.period_key = $4`,
    [config.tenant_id, config.merchant_id, config.institution_id, config.period.key]
  )
  const institutionAmount = Number(totals[0].institution_amount)
  if (institutionAmount <= 0) return null

  const vendorAmount = config.vendor_payout_mode === 'PERIODIC'
    ? Math.round(Number(totals[0].vendor_amount) * 100) / 100
    : 0

  return withTransaction(async (client) => {
    const parent = await client.query(
      `INSERT INTO transactions
         (tenant_id, merchant_id, institution_id, type, status, amount, currency,
          period_key, internal_reference)
       VALUES ($1, $2, $3, 'SWEEP_PAYOUT', 'PENDING', $4, 'GHS', $5, $6)
       ON CONFLICT ON CONSTRAINT uq_transactions_periodic_sweep DO NOTHING
       RETURNING id`,
      [config.tenant_id, config.merchant_id, config.institution_id, institutionAmount + vendorAmount, config.period.key, reference('SWEEP')]
    )
    if (!parent.rows[0]) {
      const existing = await client.query(
        `SELECT id, amount FROM transactions
          WHERE tenant_id = $1 AND merchant_id = $2 AND institution_id = $3
            AND period_key = $4 AND type = 'SWEEP_PAYOUT'`,
        [config.tenant_id, config.merchant_id, config.institution_id, config.period.key]
      )
      if (!existing.rows[0]) return null
      const { rows: existingLedger } = await client.query(
        `SELECT institution_amount, vendor_amount
           FROM institution_sweep_ledger
          WHERE sweep_transaction_id = $1`,
        [existing.rows[0].id]
      )
      return {
        ...existing.rows[0],
        institutionAmount: Number(existingLedger[0]?.institution_amount || 0),
        vendorAmount: Number(existingLedger[0]?.vendor_amount || 0),
        amount: Number(existing.rows[0].amount)
      }
    }

    const sweep = parent.rows[0]
    await client.query(
      `INSERT INTO institution_sweep_ledger
         (institution_id, tenant_id, merchant_id, sweep_transaction_id,
          vendor_amount, institution_amount, period_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (sweep_transaction_id) DO NOTHING`,
      [config.institution_id, config.tenant_id, config.merchant_id, sweep.id, vendorAmount, institutionAmount, config.period.key]
    )
    return { ...sweep, institutionAmount, vendorAmount, amount: institutionAmount + vendorAmount }
  })
}

async function findLeg(parentId, payoutLeg) {
  const { rows } = await query(
    `SELECT id, status, amount, internal_reference, payout_msisdn, eganow_reference
       FROM transactions
      WHERE parent_transaction_id = $1 AND type = 'PAYOUT' AND payout_leg = $2`,
    [parentId, payoutLeg]
  )
  return rows[0] || null
}

async function createLeg(parent, config, payoutLeg, amount, destination) {
  const existing = await findLeg(parent.id, payoutLeg)
  if (existing) return existing
  const { rows } = await query(
    `INSERT INTO transactions
       (tenant_id, merchant_id, institution_id, parent_transaction_id, type, payout_leg,
        status, amount, currency, internal_reference, payout_msisdn, period_key)
     VALUES ($1, $2, $3, $4, 'PAYOUT', $5, 'PENDING', $6, 'GHS', $7, $8, $9)
     ON CONFLICT ON CONSTRAINT uq_transactions_parent_type_leg DO NOTHING
     RETURNING id, status, amount, internal_reference, payout_msisdn`,
    [config.tenant_id, config.merchant_id, payoutLeg === 'INSTITUTION' ? config.institution_id : null,
      parent.id, payoutLeg, amount, reference(`SWEEP-${payoutLeg}`), destination, config.period.key]
  )
  return rows[0] || findLeg(parent.id, payoutLeg)
}

async function settleLeg(leg, config, network) {
  if (leg.status === 'PAID_OUT') return 'PAID_OUT'
  if (leg.status === 'FAILED') return 'FAILED'

  if (leg.eganow_reference) {
    const statusResult = await queryTransactionStatus(config.tenant_id, leg.eganow_reference)
    if (isGatewaySuccess(statusResult.status) || isGatewayFailure(statusResult.status)) {
      const status = isGatewaySuccess(statusResult.status) ? 'PAID_OUT' : 'FAILED'
      await query(
        `UPDATE transactions SET status = $2, payment_gateway_status = $3,
                failure_reason = $4, completed_at = CASE WHEN $2 <> 'PENDING' THEN now() ELSE completed_at END,
                updated_at = now() WHERE id = $1`,
        [leg.id, status, statusResult.status, status === 'FAILED' ? `Eganow returned ${statusResult.status}.` : null]
      )
      return status
    }
    throw new SweepPendingError(`Sweep leg ${leg.id} remains pending.`)
  }

  const result = await disburseToMobileMoney(config.tenant_id, {
    reference: leg.internal_reference,
    amount: leg.amount,
    currency: 'GHS',
    accountNoOrCardNoOrMsisdn: leg.payout_msisdn,
    network,
    narration: `Periodic settlement ${config.period.key}`
  })
  const status = isGatewaySuccess(result.status) ? 'PAID_OUT' : isGatewayFailure(result.status) ? 'FAILED' : 'PENDING'
  await query(
    `UPDATE transactions SET status = $2, eganow_reference = COALESCE($3, eganow_reference),
            eganow_transaction_id = COALESCE($4, eganow_transaction_id),
            payment_gateway_status = $5, failure_reason = $6,
            raw_webhook_payload = $7,
            completed_at = CASE WHEN $2 = 'PAID_OUT' THEN now() ELSE completed_at END, updated_at = now()
      WHERE id = $1`,
    [leg.id, status, result.reference, result.transactionId, result.status,
      status === 'FAILED' ? `Eganow returned ${result.status}.` : null, result.raw]
  )
  if (status === 'PENDING') throw new SweepPendingError(`Sweep leg ${leg.id} is still pending.`)
  return status
}

export async function runDuePeriodicSettlements({ now = new Date(), tenantId = null } = {}) {
  const configs = await loadDueConfigurations(now)
  const selected = tenantId ? configs.filter((config) => config.tenant_id === tenantId) : configs
  const results = []
  for (const config of selected) {
    await accrueConfiguration(config)
    const parent = await createSweep(config)
    if (!parent) continue

    let balance
    try {
      balance = await getPayoutWalletBalance(config.tenant_id, config.eganow_payout_account_id)
    } catch (error) {
      await query(
        `UPDATE institution_sweep_ledger
            SET status = 'ACCRUED_UNSWEPT', failure_reason = $2, updated_at = now()
          WHERE sweep_transaction_id = $1`,
        [parent.id, error.message]
      )
      results.push({ sweepId: parent.id, status: 'ACCRUED_UNSWEPT', reason: error.message })
      continue
    }

    if (Number(balance) < Number(parent.amount)) {
      await query(
        `UPDATE institution_sweep_ledger SET status = 'ACCRUED_UNSWEPT',
                failure_reason = 'Insufficient payout-wallet balance.', updated_at = now()
          WHERE sweep_transaction_id = $1`,
        [parent.id]
      )
      results.push({ sweepId: parent.id, status: 'ACCRUED_UNSWEPT' })
      continue
    }

    const institutionLeg = await createLeg(parent, config, 'INSTITUTION', parent.institutionAmount, config.settlement_msisdn)
    const vendorLeg = config.vendor_payout_mode === 'PERIODIC'
      ? await createLeg(parent, config, 'VENDOR', parent.vendorAmount, config.mobile_money_number)
      : null
    let institutionStatus
    let vendorStatus = 'PAID_OUT'
    try {
      institutionStatus = await settleLeg(institutionLeg, config)
      vendorStatus = vendorLeg ? await settleLeg(vendorLeg, config, config.network_provider) : 'PAID_OUT'
    } catch (error) {
      await query(
        `UPDATE institution_sweep_ledger
            SET status = 'PENDING',
                institution_leg_status = $2,
                vendor_leg_status = $3,
                failure_reason = $4,
                updated_at = now()
          WHERE sweep_transaction_id = $1`,
        [parent.id, institutionStatus || institutionLeg.status, vendorStatus, error.message]
      )
      throw error
    }
    const status = institutionStatus === 'PAID_OUT' && vendorStatus === 'PAID_OUT'
      ? 'SETTLED'
      : institutionStatus === 'FAILED' || vendorStatus === 'FAILED'
        ? 'PARTIALLY_SETTLED'
        : 'PENDING'
    await query(
      `UPDATE institution_sweep_ledger SET status = $2,
              institution_leg_status = $3, vendor_leg_status = $4, updated_at = now()
        WHERE sweep_transaction_id = $1`,
      [parent.id, status, institutionStatus, vendorStatus]
    )
    if (status === 'SETTLED') {
      await query(
        `UPDATE periodic_accrual_ledger
            SET status = 'SWEPT', swept_transaction_id = $1, swept_at = now()
          WHERE tenant_id = $2 AND merchant_id = $3 AND institution_id = $4
            AND period_key = $5 AND status = 'PENDING'`,
        [parent.id, config.tenant_id, config.merchant_id, config.institution_id, config.period.key]
      )
    }
    results.push({ sweepId: parent.id, status })
  }
  return results
}

export const periodicSettlementInternals = { completedPeriod, scheduleValue, RETRY_WINDOW_MS }
