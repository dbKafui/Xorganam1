import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { amountForRule } from '../src/lib/periodicSettlementMoney.js'

describe('periodic settlement money arithmetic', () => {
  it('calculates percentage splits from exact decimal amounts', () => {
    assert.equal(amountForRule('90071992547409.91', { id: 'r1', type: 'PERCENTAGE', amount: '12.5000' }), '11258999068426.24')
    assert.equal(amountForRule('10.01', { id: 'r2', type: 'PERCENTAGE', amount: '12.5000' }), '1.25')
  })

  it('rounds flat rules to minor units and rejects amounts above the source', () => {
    assert.equal(amountForRule('10.00', { id: 'r3', type: 'FLAT', amount: '1.2350' }), '1.24')
    assert.throws(() => amountForRule('10.00', { id: 'r4', type: 'FLAT', amount: '10.0050' }), /Invalid periodic split rule/)
  })
})
