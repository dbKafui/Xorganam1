import test from 'node:test'
import assert from 'node:assert/strict'
import {
  INSTITUTION_BANK_PARTNERS,
  INSTITUTION_MOMO_NETWORKS,
  isInstitutionBankPartner,
  normalizeInstitutionMomoNetwork,
  resolveInstitutionMomoNetwork,
  validateInstitutionBankPayout,
  validateInstitutionCardDetails
} from '../src/services/institutionPaymentMethods.js'

test('supports the documented Ghana MoMo networks and aliases', () => {
  assert.deepEqual(INSTITUTION_MOMO_NETWORKS.map(({ code }) => code), ['MTNGH', 'TCELGH', 'ATGH'])
  assert.equal(normalizeInstitutionMomoNetwork('MTN'), 'MTNGH')
  assert.equal(normalizeInstitutionMomoNetwork('Telecel'), 'TCELGH')
  assert.equal(normalizeInstitutionMomoNetwork('AirtelTigo'), 'ATGH')
  assert.equal(normalizeInstitutionMomoNetwork('UNKNOWN'), null)
  assert.equal(resolveInstitutionMomoNetwork('TCEL', 'MTNGH', 'ATGH'), 'TCELGH')
  assert.equal(resolveInstitutionMomoNetwork('', 'MTNGH', 'ATGH'), 'MTNGH')
  assert.equal(resolveInstitutionMomoNetwork('', '', 'ATGH'), 'ATGH')
})

test('accepts exactly the documented bank paypartner codes', () => {
  assert.equal(INSTITUTION_BANK_PARTNERS.length, 24)
  assert.equal(isInstitutionBankPartner('STANBICGH'), true)
  assert.equal(isInstitutionBankPartner('GCBGH'), true)
  assert.equal(isInstitutionBankPartner('UNKNOWN'), false)
})

test('validates transient card input without accepting malformed values', () => {
  assert.deepEqual(validateInstitutionCardDetails({
    cardNumber: '4111 1111 1111 1111', cardholderName: 'Test Person',
    expiryDateMonth: 12, expiryDateYear: '2039', cvv: '100'
  }), {
    cardNumber: '4111111111111111', cardholderName: 'Test Person',
    expiryDateMonth: 12, expiryDateYear: '39', cvv: '100'
  })
  assert.throws(() => validateInstitutionCardDetails({ cardNumber: '4111111111111112' }), /valid card details/)
})

test('normalizes bank payout inputs and rejects unsupported details', () => {
  assert.deepEqual(validateInstitutionBankPayout({
    bankCode: 'stanbicgh', bankAccountNumber: '1234 567890', bankAccountName: 'Test Recipient'
  }), { bankCode: 'STANBICGH', bankAccountNumber: '1234567890', bankAccountName: 'Test Recipient' })
  assert.throws(() => validateInstitutionBankPayout({ bankCode: 'UNKNOWN', bankAccountNumber: '123456', bankAccountName: 'Name' }), /supported bank/)
})