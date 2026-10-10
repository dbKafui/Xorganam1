import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

process.env.DATABASE_URL = 'postgresql://localhost/test'
process.env.REDIS_URL = 'redis://localhost:6379'
process.env.ENCRYPTION_MASTER_KEY = 'test-key'
process.env.JWT_SECRET = 'test-secret'

const { computeFee } = await import('../src/services/feeService.js')

function feeConfig(overrides = {}) {
  return {
    id: 'aab9494d-a46f-44c9-9ff7-c4e6edc9b323',
    charge_calc_type: 'PERCENTAGE',
    charge_flat_amount: null,
    charge_percentage: '1.25',
    charge_cap_amount: null,
    charge_payer: 'MERCHANT',
    eganow_cost_calc_type: 'FLAT',
    eganow_cost_flat_amount: '0.03',
    eganow_cost_percentage: null,
    eganow_cost_cap_amount: null,
    ...overrides
  }
}

describe('precise fee arithmetic', () => {
  it('calculates percentage, flat cost, and margin with integer minor units', async () => {
    const result = await computeFee('tenant', 'COLLECTION', '10.00', async () => ({ rows: [feeConfig()] }))
    assert.equal(result.chargedAmount, '0.13')
    assert.equal(result.configuredChargeAmount, '0.13')
    assert.equal(result.eganowCost, '0.03')
    assert.equal(result.platformMargin, '0.10')
  })

  it('keeps large NUMERIC amounts exact beyond JavaScript integer precision', async () => {
    const result = await computeFee('tenant', 'COLLECTION', '90071992547409.99', async () => ({
      rows: [feeConfig({ charge_percentage: '1.00', eganow_cost_flat_amount: '0.00' })]
    }))
    assert.equal(result.chargedAmount, '900719925474.10')
  })

  it('rejects values with unsupported monetary precision', async () => {
    await assert.rejects(
      computeFee('tenant', 'COLLECTION', '12.345', async () => ({ rows: [feeConfig()] })),
      /at most two fractional digits/
    )
  })
})
