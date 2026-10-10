import assert from 'node:assert/strict'
import test from 'node:test'
import { formatCurrencyAmount, formatCurrencyMinorUnits, multiplyDecimalByInteger } from '../../shared/currency.js'

test('formats NUMERIC amounts exactly beyond JavaScript safe integer precision', () => {
  assert.match(formatCurrencyAmount('9007199254740993.27', 'GHS', 'en-GH'), /9,007,199,254,740,993\.27/)
  assert.match(formatCurrencyMinorUnits('900719925474099327', 'GHS', 'en-GH'), /9,007,199,254,740,993\.27/)
})

test('uses currency minor units and rejects unsupported fractional precision', () => {
  assert.match(formatCurrencyAmount('1234', 'JPY', 'en-US'), /1,234/)
  assert.equal(formatCurrencyAmount('1.234', 'GHS', 'en-US'), '—')
  assert.match(formatCurrencyAmount('-0.25', 'USD', 'en-US'), /-\$0\.25/)
})

test('multiplies storefront prices by integer quantities without floating point', () => {
  assert.equal(multiplyDecimalByInteger('19.99', 3, 'GHS'), '5997')
  assert.equal(multiplyDecimalByInteger('90071992547409.91', 2, 'GHS'), '18014398509481982')
  assert.equal(multiplyDecimalByInteger('1.001', 2, 'GHS'), null)
})
