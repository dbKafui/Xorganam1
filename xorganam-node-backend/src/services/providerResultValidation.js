export function validateProviderResult({
  expectedAmount,
  expectedCurrency,
  expectedReference,
  actualAmount,
  actualCurrency,
  actualReference
}) {
  const mismatches = []
  const expectedAmountCents = normalizeAmountMinorUnits(expectedAmount)
  const actualAmountCents = normalizeAmountMinorUnits(actualAmount)

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

export function normalizeAmountMinorUnits(value) {
  if (value === null || value === undefined || value === '') return null
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : String(value).trim()
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text)
  if (!match) return null
  const fractional = match[2] || ''
  const significantFraction = fractional.replace(/0+$/, '')
  if (significantFraction.length > 2) return null
  const minor = `${match[1]}${fractional.padEnd(2, '0').slice(0, 2)}`
  try {
    return BigInt(minor)
  } catch {
    return null
  }
}

export function formatMinorUnits(value) {
  const minorUnits = typeof value === 'bigint' ? value : BigInt(value)
  const sign = minorUnits < 0n ? '-' : ''
  const absolute = minorUnits < 0n ? -minorUnits : minorUnits
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`
}
