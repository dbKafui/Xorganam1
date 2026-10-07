import { query } from '../db/pool.js'

function cents(value) {
  return Math.round(Number(value || 0) * 100) / 100
}

function calculate(type, amount, flat, percentage, cap) {
  if (type === 'FLAT') return cents(flat)
  const result = cents(amount * Number(percentage || 0) / 100)
  return type === 'PERCENTAGE_WITH_CAP' ? Math.min(result, cents(cap)) : result
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
  if (!config) return { chargedAmount: 0, chargedPayer: 'WAIVED', eganowCost: 0, platformMargin: 0, feeConfigVersionId: null }
  const base = Number(amount)
  const fee = calculate(config.charge_calc_type, base, config.charge_flat_amount, config.charge_percentage, config.charge_cap_amount)
  const cost = calculate(config.eganow_cost_calc_type, base, config.eganow_cost_flat_amount, config.eganow_cost_percentage, config.eganow_cost_cap_amount)
  const chargedAmount = config.charge_payer === 'WAIVED' ? 0 : fee
  return {
    chargedAmount,
    configuredChargeAmount: fee,
    chargedPayer: config.charge_payer,
    eganowCost: cost,
    platformMargin: cents(chargedAmount - cost),
    feeConfigVersionId: config.id
  }
}
