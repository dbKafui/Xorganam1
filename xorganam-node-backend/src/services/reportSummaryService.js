import { addDecimalStrings, decimalCount } from '../lib/decimalString.js'

function readTotal(source, camelCaseKey, snakeCaseKey) {
  return source?.[camelCaseKey] ?? source?.[snakeCaseKey]
}

export function buildReportSummary({
  transactionTotals,
  ledgerTotals = {}
}) {
  const totalCollected = String(readTotal(transactionTotals, 'totalCollected', 'total_collected') ?? '0')
  const totalPaidOut = String(readTotal(transactionTotals, 'totalPaidOut', 'total_paid_out') ?? '0')
  const totalFees = String(readTotal(transactionTotals, 'totalFees', 'total_fees') ?? '0')
  const totalPlatformMargin = String(readTotal(transactionTotals, 'totalPlatformMargin', 'total_platform_margin') ?? '0')

  const pendingAccrualAmount = String(readTotal(ledgerTotals, 'pendingAccrualAmount', 'pending_accrual_amount') ?? '0')
  const sweptAccrualAmount = String(readTotal(ledgerTotals, 'sweptAccrualAmount', 'swept_accrual_amount') ?? '0')
  const pendingSettlementAmount = String(readTotal(ledgerTotals, 'pendingSettlementAmount', 'pending_settlement_amount') ?? '0')
  const settledAmount = String(readTotal(ledgerTotals, 'settledAmount', 'settled_amount') ?? '0')
  const allocatedAmount = String(readTotal(ledgerTotals, 'allocatedAmount', 'allocated_amount') ?? '0')
  const pendingFinancialMovement = addDecimalStrings(pendingAccrualAmount, pendingSettlementAmount)
  const finalizedFinancialMovement = addDecimalStrings(totalCollected, totalPaidOut)
  const unresolvedFlagCount = decimalCount(readTotal(ledgerTotals, 'unresolvedFlagCount', 'unresolved_flag_count') ?? 0)
  const feeDataUnavailableCount = decimalCount(readTotal(transactionTotals, 'feeDataUnavailableCount', 'fee_data_unavailable_count') ?? 0)
  const collectionCount = decimalCount(readTotal(transactionTotals, 'collectionCount', 'collection_count') ?? 0)
  const successfulCount = decimalCount(readTotal(transactionTotals, 'successfulCount', 'successful_count') ?? 0)
  const failedCount = decimalCount(readTotal(transactionTotals, 'failedCount', 'failed_count') ?? 0)
  const pendingCount = decimalCount(readTotal(transactionTotals, 'pendingCount', 'pending_count') ?? 0)
  const unresolvedFlagText = unresolvedFlagCount === 1 ? 'One' : unresolvedFlagCount === 2 ? 'Two' : unresolvedFlagCount.toString()

  const warnings = unresolvedFlagCount > 0
    ? [`${unresolvedFlagText} financial reconciliation ${unresolvedFlagCount === 1 ? 'flag is' : 'flags are'} unresolved.`]
    : []

  return {
    totalCollected,
    totalPaidOut,
    totalFees,
    netRevenue: totalPlatformMargin,
    feeDataUnavailableTransactions: feeDataUnavailableCount,
    collectionCount,
    successfulCount,
    failedCount,
    pendingCount,
    pendingAccrualAmount,
    sweptAccrualAmount,
    pendingSettlementAmount,
    settledAmount,
    allocatedAmount,
    pendingFinancialMovement,
    finalizedFinancialMovement,
    unresolvedFlagCount,
    reconciliationRequiresReview: unresolvedFlagCount > 0,
    reconciliationWarnings: warnings
  }
}
