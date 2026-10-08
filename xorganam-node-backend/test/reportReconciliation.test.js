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

  it('reads database-shaped aggregate rows and returns ledger detail', () => {
    const summary = buildReportSummary({
      transactionTotals: {
        total_collected: '1250.00',
        total_paid_out: '300.00',
        total_fees: '50.00',
        total_platform_margin: '20.00',
        fee_data_unavailable_count: '2',
        collection_count: '4',
        successful_count: '3',
        failed_count: '1',
        pending_count: '1'
      },
      ledgerTotals: {
        pending_accrual_amount: '80.00',
        swept_accrual_amount: '700.00',
        pending_settlement_amount: '40.00',
        settled_amount: '600.00',
        allocated_amount: '500.00',
        unresolved_flag_count: '1'
      }
    })

    assert.equal(summary.totalCollected, 1250)
    assert.equal(summary.totalPaidOut, 300)
    assert.equal(summary.totalFees, 50)
    assert.equal(summary.netRevenue, 20)
    assert.equal(summary.feeDataUnavailableTransactions, 2)
    assert.equal(summary.collectionCount, 4)
    assert.equal(summary.successfulCount, 3)
    assert.equal(summary.failedCount, 1)
    assert.equal(summary.pendingCount, 1)
    assert.equal(summary.pendingFinancialMovement, 120)
    assert.equal(summary.sweptAccrualAmount, 700)
    assert.equal(summary.settledAmount, 600)
    assert.equal(summary.allocatedAmount, 500)
    assert.equal(summary.unresolvedFlagCount, 1)
  })
})
