export function resolveSplitParentStatus({ expected, settled, failed, currentStatus, allowPartial = false }) {
  const expectedCount = Number(expected)
  const settledCount = Number(settled)
  const failedCount = Number(failed)
  const allLegsSettled = expectedCount > 0 && expectedCount === settledCount
  const partialSettlement = settledCount > 0 && (
    currentStatus === 'PARTIALLY_SETTLED' || (failedCount > 0 && allowPartial)
  )

  if (allLegsSettled) return 'PAID_OUT'
  if (partialSettlement) return 'PARTIALLY_SETTLED'
  return 'SWEPT_INTERNAL'
}