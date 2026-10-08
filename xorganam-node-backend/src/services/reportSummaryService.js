function asNumber(value) {
  return Number(value ?? 0)
}

function readTotal(source, camelCaseKey, snakeCaseKey) {
  return source?.[camelCaseKey] ?? source?.[snakeCaseKey]
}

export function buildReportSummary({
  transactionTotals,
  ledgerTotals = {}
}) {
  const totalCollected = asNumber(readTotal(transactionTotals, 'totalCollected', 'total_collected'))
  const totalPaidOut = asNumber(readTotal(transactionTotals, 'totalPaidOut', 'total_paid_out'))
  const totalFees = asNumber(readTotal(transactionTotals, 'totalFees', 'total_fees'))
  const totalPlatformMargin = asNumber(readTotal(transactionTotals, 'totalPlatformMargin', 'total_platform_margin'))

  const pendingAccrualAmount = asNumber(readTotal(ledgerTotals, 'pendingAccrualAmount', 'pending_accrual_amount'))
  const sweptAccrualAmount = asNumber(readTotal(ledgerTotals, 'sweptAccrualAmount', 'swept_accrual_amount'))
  const pendingSettlementAmount = asNumber(readTotal(ledgerTotals, 'pendingSettlementAmount', 'pending_settlement_amount'))
  const settledAmount = asNumber(readTotal(ledgerTotals, 'settledAmount', 'settled_amount'))
  const allocatedAmount = asNumber(readTotal(ledgerTotals, 'allocatedAmount', 'allocated_amount'))
  const pendingFinancialMovement = pendingAccrualAmount + pendingSettlementAmount
  const finalizedFinancialMovement = totalCollected + totalPaidOut
  const unresolvedFlagCount = asNumber(readTotal(ledgerTotals, 'unresolvedFlagCount', 'unresolved_flag_count'))
  const feeDataUnavailableCount = asNumber(readTotal(transactionTotals, 'feeDataUnavailableCount', 'fee_data_unavailable_count'))
  const collectionCount = asNumber(readTotal(transactionTotals, 'collectionCount', 'collection_count'))
  const successfulCount = asNumber(readTotal(transactionTotals, 'successfulCount', 'successful_count'))
  const failedCount = asNumber(readTotal(transactionTotals, 'failedCount', 'failed_count'))
  const pendingCount = asNumber(readTotal(transactionTotals, 'pendingCount', 'pending_count'))
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
