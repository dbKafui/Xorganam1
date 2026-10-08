export function validateProviderResult({
  expectedAmount,
  expectedCurrency,
  expectedReference,
  actualAmount,
  actualCurrency,
  actualReference
}) {
  const mismatches = []
  const expectedAmountCents = normalizeAmount(expectedAmount)
  const actualAmountCents = normalizeAmount(actualAmount)

  if (expectedAmountCents === null || actualAmountCents === null) {
    if (expectedAmount !== undefined && expectedAmount !== null && expectedAmount !== '') mismatches.push('amount')
  } else if (expectedAmountCents !== actualAmountCents) {
    mismatches.push('amount')
  }

  if (expectedCurrency) {
    if (!actualCurrency || String(expectedCurrency).toUpperCase() !== String(actualCurrency).toUpperCase()) mismatches.push('currency')
  }

  if (expectedReference) {
    if (!actualReference || String(expectedReference).trim() !== String(actualReference).trim()) mismatches.push('reference')
  }

  return {
    valid: mismatches.length === 0,
    mismatches
  }
}

function normalizeAmount(value) {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  return Math.round(numeric * 100)
}
