import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const { resolveSplitParentStatus } = await import('../src/services/splitSettlementState.js')

describe('split parent settlement state', () => {
  it('keeps a fully failed payout parent swept while retry or review is pending', () => {
    assert.equal(resolveSplitParentStatus({
      expected: '2', settled: '0', failed: '2', currentStatus: 'SWEPT_INTERNAL', allowPartial: true
    }), 'SWEPT_INTERNAL')
  })

  it('marks completed and partially completed split payouts accurately', () => {
    assert.equal(resolveSplitParentStatus({ expected: '2', settled: '2', failed: '0' }), 'PAID_OUT')
    assert.equal(resolveSplitParentStatus({
      expected: '2', settled: '1', failed: '1', currentStatus: 'SWEPT_INTERNAL', allowPartial: true
    }), 'PARTIALLY_SETTLED')
  })

  it('does not regress a partial settlement while another leg remains pending', () => {
    assert.equal(resolveSplitParentStatus({
      expected: '2', settled: '1', failed: '0', currentStatus: 'PARTIALLY_SETTLED'
    }), 'PARTIALLY_SETTLED')
  })
})