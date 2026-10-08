import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const { buildReportSummary } = await import('../src/services/reportSummaryService.js')

describe('report financial reconciliation', () => {
  it('combines finalized transaction activity with ledger and unresolved flags', () => {
    const summary = buildReportSummary({
      transactionTotals: {
        totalCollected: 1250,
        totalPaidOut: 300,
        totalFees: 50,
        totalPlatformMargin: 20,
        feeDataUnavailableCount: 0,
        collectionCount: 4,
        successfulCount: 3,
        failedCount: 1,
        pendingCount: 1
      },
      ledgerTotals: {
        pendingAccrualAmount: 80,
        sweptAccrualAmount: 700,
        pendingSettlementAmount: 40,
        settledAmount: 600,
        allocatedAmount: 500,
        unresolvedFlagCount: 2
      }
    })

    assert.equal(summary.totalCollected, 1250)
    assert.equal(summary.totalPaidOut, 300)
    assert.equal(summary.totalFees, 50)
    assert.equal(summary.netRevenue, 20)
    assert.equal(summary.pendingFinancialMovement, 120)
    assert.equal(summary.finalizedFinancialMovement, 1550)
    assert.equal(summary.reconciliationRequiresReview, true)
    assert.equal(summary.unresolvedFlagCount, 2)
    assert.deepEqual(summary.reconciliationWarnings, ['Two financial reconciliation flags are unresolved.'])
  })
})
