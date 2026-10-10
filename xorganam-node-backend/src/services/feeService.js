import { query } from '../db/pool.js'

function amountMinorUnits(value) {
  const text = String(value ?? '0').trim()
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text)
  if (!match) throw new Error('Financial amount must be a decimal with at most two fractional digits.')
  const sign = match[1] === '-' ? -1n : 1n
  const fractional = (match[3] || '').padEnd(2, '0')
  return sign * (BigInt(match[2]) * 100n + BigInt(fractional || '0'))
}

function percentageMinorUnits(amountCents, percentage) {
  const text = String(percentage ?? '0').trim()
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text)
  if (!match) throw new Error('Fee percentage must be a decimal with at most two fractional digits.')
  const scale = match[2]?.length || 0
  const percentageUnits = BigInt(match[1] + (match[2] || ''))
  const divisor = 100n * (10n ** BigInt(scale))
  const numerator = amountCents * percentageUnits
  return (numerator + divisor / 2n) / divisor
}

function formatMinorUnits(value) {
  const sign = value < 0n ? '-' : ''
  const absolute = value < 0n ? -value : value
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`
}

function calculate(type, amountCents, flat, percentage, cap) {
  if (type === 'FLAT') return amountMinorUnits(flat)
  const result = percentageMinorUnits(amountCents, percentage)
  return type === 'PERCENTAGE_WITH_CAP' ? result < amountMinorUnits(cap) ? result : amountMinorUnits(cap) : result
}

export async function computeFee(tenantId, stage, amount, db = query) {
  const { rows } = await db(
    `SELECT * FROM fee_config_versions
      WHERE stage = $2 AND effective_from <= now() AND effective_to IS NULL
        AND (tenant_id = $1 OR tenant_id IS NULL)
      ORDER BY (tenant_id IS NOT NULL) DESC
      LIMIT 1`, [tenantId, stage]
  )
  const config = rows[0]
  if (!config) return { chargedAmount: '0.00', chargedPayer: 'WAIVED', eganowCost: '0.00', platformMargin: '0.00', feeConfigVersionId: null }
  const base = amountMinorUnits(amount)
  const fee = calculate(config.charge_calc_type, base, config.charge_flat_amount, config.charge_percentage, config.charge_cap_amount)
  const cost = calculate(config.eganow_cost_calc_type, base, config.eganow_cost_flat_amount, config.eganow_cost_percentage, config.eganow_cost_cap_amount)
  const chargedAmount = config.charge_payer === 'WAIVED' ? 0n : fee
  return {
    chargedAmount: formatMinorUnits(chargedAmount),
    configuredChargeAmount: formatMinorUnits(fee),
    chargedPayer: config.charge_payer,
    eganowCost: formatMinorUnits(cost),
    platformMargin: formatMinorUnits(chargedAmount - cost),
    feeConfigVersionId: config.id
  }
}
