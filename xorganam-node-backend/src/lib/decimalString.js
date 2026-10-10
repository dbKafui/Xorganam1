function parseDecimal(value) {
  const text = String(value ?? '0').trim()
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text)
  if (!match) throw new Error('Value must be a plain decimal string.')
  const fraction = match[3] || ''
  const scale = fraction.length
  const absolute = BigInt(`${match[2]}${fraction}`)
  return { value: match[1] === '-' ? -absolute : absolute, scale }
}

export function addDecimalStrings(...values) {
  const parsed = values.map(parseDecimal)
  const scale = Math.max(0, ...parsed.map((item) => item.scale))
  const total = parsed.reduce((sum, item) => sum + item.value * (10n ** BigInt(scale - item.scale)), 0n)
  const sign = total < 0n ? '-' : ''
  const absolute = total < 0n ? -total : total
  if (scale === 0) return `${sign}${absolute}`
  const digits = String(absolute).padStart(scale + 1, '0')
  return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`
}

export function decimalCount(value) {
  const parsed = parseDecimal(value)
  if (parsed.scale > 0 && parsed.value % (10n ** BigInt(parsed.scale)) !== 0n) {
    throw new Error('Count must be an integer.')
  }
  const count = parsed.value / (10n ** BigInt(parsed.scale))
  const number = Number(count)
  if (!Number.isSafeInteger(number)) throw new Error('Count exceeds the safe integer range.')
  return number
}
