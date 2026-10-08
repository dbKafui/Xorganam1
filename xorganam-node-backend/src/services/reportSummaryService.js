function asNumber(value) {
  return Number(value ?? 0)
}

export function buildReportSummary({
  transactionTotals,
  ledgerTotals = {}
}) {
  const totalCollected = asNumber(transactionTotals?.totalCollected)
  const totalPaidOut = asNumber(transactionTotals?.totalPaidOut)
  const totalFees = asNumber(transactionTotals?.totalFees)
  const totalPlatformMargin = asNumber(transactionTotals?.totalPlatformMargin)

  const pendingFinancialMovement = asNumber(ledgerTotals.pendingAccrualAmount) + asNumber(ledgerTotals.pendingSettlementAmount)
  const finalizedFinancialMovement = totalCollected + totalPaidOut
  const unresolvedFlagCount = asNumber(ledgerTotals.unresolvedFlagCount)
  const unresolvedFlagText = unresolvedFlagCount === 1 ? 'One' : unresolvedFlagCount === 2 ? 'Two' : unresolvedFlagCount.toString()

  const warnings = unresolvedFlagCount > 0
    ? [`${unresolvedFlagText} financial reconciliation ${unresolvedFlagCount === 1 ? 'flag is' : 'flags are'} unresolved.`]
    : []

  return {
    totalCollected,
    totalPaidOut,
    totalFees,
    netRevenue: totalPlatformMargin,
    feeDataUnavailableTransactions: asNumber(transactionTotals?.feeDataUnavailableCount),
    collectionCount: asNumber(transactionTotals?.collectionCount),
    successfulCount: asNumber(transactionTotals?.successfulCount),
    failedCount: asNumber(transactionTotals?.failedCount),
    pendingCount: asNumber(transactionTotals?.pendingCount),
    pendingFinancialMovement,
    finalizedFinancialMovement,
    unresolvedFlagCount,
    reconciliationRequiresReview: unresolvedFlagCount > 0,
    reconciliationWarnings: warnings
  }
}
