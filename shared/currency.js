function currencyParts(minorUnits, currency, locale) {
  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0
  })
  const fractionDigits = new Intl.NumberFormat(locale, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits
  const negative = minorUnits < 0n
  const absolute = negative ? -minorUnits : minorUnits
  const base = 10n ** BigInt(fractionDigits)
  const major = absolute / base
  const fraction = fractionDigits ? String(absolute % base).padStart(fractionDigits, '0') : ''
  const parts = formatter.formatToParts(negative && major === 0n ? -1n : negative ? -major : major)
  if (negative && major === 0n) {
    const integerPart = parts.find((part) => part.type === 'integer')
    if (integerPart) integerPart.value = '0'
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      if (parts[index].type === 'group') parts.splice(index, 1)
    }
  }
  if (!fraction || /^0+$/.test(fraction)) return parts.map((part) => part.value).join('')
  const decimalSeparator = new Intl.NumberFormat(locale).formatToParts(1.1).find((part) => part.type === 'decimal')?.value || '.'
  let integerIndex = -1
  for (let index = 0; index < parts.length; index += 1) if (parts[index].type === 'integer') integerIndex = index
  parts.splice(integerIndex + 1, 0, { type: 'decimal', value: decimalSeparator }, { type: 'fraction', value: fraction })
  return parts.map((part) => part.value).join('')
}

export function formatCurrencyMinorUnits(value, currency = 'GHS', locale) {
  const text = String(value ?? '0').trim()
  if (!/^-?\d+$/.test(text)) return '—'
  return currencyParts(BigInt(text), currency, locale)
}

export function decimalAmountFromMinorUnits(value, currency = 'GHS') {
  const text = String(value ?? '0').trim()
  if (!/^-?\d+$/.test(text)) return ''
  const fractionDigits = new Intl.NumberFormat(undefined, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits
  const units = BigInt(text)
  const sign = units < 0n ? '-' : ''
  const absolute = units < 0n ? -units : units
  if (!fractionDigits) return `${sign}${absolute}`
  const base = 10n ** BigInt(fractionDigits)
  return `${sign}${absolute / base}.${String(absolute % base).padStart(fractionDigits, '0')}`
}

export function decimalToMinorUnits(value, currency = 'GHS') {
  const text = String(value ?? '0').trim()
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text)
  if (!match) return null
  const fractionDigits = new Intl.NumberFormat(undefined, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits
  const fraction = match[3] || ''
  if (fraction.length > fractionDigits && /[1-9]/.test(fraction.slice(fractionDigits))) return null
  const scale = 10n ** BigInt(fractionDigits)
  const fractionalUnits = BigInt(fraction.slice(0, fractionDigits).padEnd(fractionDigits, '0') || '0')
  const units = BigInt(match[2]) * scale + fractionalUnits
  return (match[1] === '-' ? -units : units).toString()
}

export function addDecimalAmounts(...values) {
  const parsed = values.map((value) => {
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value ?? '0').trim())
    if (!match) throw new Error('Currency values must be plain decimal strings.')
    const fraction = match[3] || ''
    return { integer: match[1] === '-' ? -BigInt(`${match[2]}${fraction}`) : BigInt(`${match[2]}${fraction}`), scale: fraction.length }
  })
  const scale = Math.max(0, ...parsed.map((item) => item.scale))
  const total = parsed.reduce((sum, item) => sum + item.integer * (10n ** BigInt(scale - item.scale)), 0n)
  const sign = total < 0n ? '-' : ''
  const absolute = total < 0n ? -total : total
  if (!scale) return `${sign}${absolute}`
  const digits = String(absolute).padStart(scale + 1, '0')
  return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`
}

export function multiplyDecimalByInteger(value, multiplier, currency = 'GHS') {
  const units = decimalToMinorUnits(value, currency)
  const count = String(multiplier)
  if (units === null || !/^\d+$/.test(count)) return null
  return (BigInt(units) * BigInt(count)).toString()
}

export function formatCurrencyAmount(value, currency = 'GHS', locale) {
  const text = String(value ?? '0').trim()
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text)
  if (!match) return '—'
  const fractionDigits = new Intl.NumberFormat(locale, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits
  const fraction = match[3] || ''
  if (fraction.length > fractionDigits && /[1-9]/.test(fraction.slice(fractionDigits))) return '—'
  const exactFraction = fraction.slice(0, fractionDigits).padEnd(fractionDigits, '0')
  const scale = 10n ** BigInt(fractionDigits)
  const minorUnits = BigInt(match[2]) * scale + BigInt(exactFraction || '0')
  return currencyParts(match[1] === '-' ? -minorUnits : minorUnits, currency, locale)
}
