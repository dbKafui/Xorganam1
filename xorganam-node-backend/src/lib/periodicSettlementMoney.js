import { normalizeAmountMinorUnits, formatMinorUnits } from '../services/providerResultValidation.js'

export function amountForRule(amount, rule) {
  const baseCents = normalizeAmountMinorUnits(amount)
  const ruleText = String(rule.amount ?? '')
  const match = /^(\d+)(?:\.(\d+))?$/.exec(ruleText)
  if (baseCents === null || !match) throw new Error(`Invalid periodic split rule ${rule.id}.`)
  const fraction = match[2] || ''
  const scale = 10n ** BigInt(fraction.length)
  const ruleValue = BigInt(`${match[1]}${fraction}`)
  let cents
  if (rule.type === 'PERCENTAGE') {
    const numerator = baseCents * ruleValue
    const denominator = scale * 100n
    cents = (numerator + denominator / 2n) / denominator
  } else {
    const numerator = ruleValue * 100n
    cents = (numerator + scale / 2n) / scale
  }
  if (cents < 0n || cents > baseCents) throw new Error(`Invalid periodic split rule ${rule.id}.`)
  return formatMinorUnits(cents)
}
