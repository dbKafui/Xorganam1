export const INSTITUTION_MOMO_NETWORKS = Object.freeze([
  { code: 'MTNGH', label: 'MTN Ghana' },
  { code: 'TCELGH', label: 'Telecel Ghana' },
  { code: 'ATGH', label: 'AT / AirtelTigo' }
])

export const INSTITUTION_BANK_PARTNERS = Object.freeze([
  { code: 'GCBGH', label: 'GCB Bank Limited' },
  { code: 'SOCIETE', label: 'Societe Generale Ghana' },
  { code: 'ARBAPEX', label: 'ARB Apex Bank Limited' },
  { code: 'OMNIBSIC', label: 'OmniBSIC Bank' },
  { code: 'FIRSTATGH', label: 'First Atlantic Bank' },
  { code: 'FBNGH', label: 'First Bank of Nigeria' },
  { code: 'BANKOFAFRICA', label: 'Bank of Africa' },
  { code: 'FIDELITY', label: 'Fidelity Bank Limited' },
  { code: 'FNBGH', label: 'First National Bank' },
  { code: 'CBG', label: 'Consolidated Bank Ghana' },
  { code: 'ACCESSGH', label: 'Access Bank Ltd' },
  { code: 'UNAFBKGH', label: 'United Bank for Africa' },
  { code: 'GTBANKGH', label: 'Guaranty Trust Bank' },
  { code: 'PBL', label: 'Prudential Bank Ltd' },
  { code: 'CAL', label: 'CAL Bank Limited' },
  { code: 'ECOBANKGH', label: 'Ecobank Ghana Limited' },
  { code: 'ZENITHGH', label: 'Zenith Bank Ghana Ltd' },
  { code: 'REPUBLIC', label: 'Republic Bank Limited' },
  { code: 'UMB', label: 'Universal Merchant Bank' },
  { code: 'ADB', label: 'Agricultural Development Bank' },
  { code: 'NIB', label: 'National Investment Bank' },
  { code: 'ABSA', label: 'Absa Bank Ghana Limited' },
  { code: 'STANCHART', label: 'Standard Chartered Bank' },
  { code: 'STANBICGH', label: 'Stanbic Bank Ghana' }
])

const momoAliases = new Map([
  ['MTN', 'MTNGH'], ['MTNGH', 'MTNGH'],
  ['TCEL', 'TCELGH'], ['TCELGH', 'TCELGH'], ['TELECEL', 'TCELGH'], ['TELECELGH', 'TCELGH'],
  ['AT', 'ATGH'], ['ATGH', 'ATGH'], ['AIRTEL', 'ATGH'], ['AIRTELTIGO', 'ATGH'], ['TIGO', 'ATGH']
])
const bankCodes = new Set(INSTITUTION_BANK_PARTNERS.map(({ code }) => code))

export function normalizeInstitutionMomoNetwork(value) {
  if (typeof value !== 'string') return null
  return momoAliases.get(value.trim().toUpperCase()) || null
}

export function resolveInstitutionMomoNetwork(requested, inferred, fallback) {
  return normalizeInstitutionMomoNetwork(requested) ||
    normalizeInstitutionMomoNetwork(inferred) ||
    normalizeInstitutionMomoNetwork(fallback)
}

export function isInstitutionBankPartner(value) {
  return typeof value === 'string' && bankCodes.has(value.trim().toUpperCase())
}

function luhnValid(value) {
  const digits = String(value || '').replace(/[\s-]/g, '')
  if (!/^\d{12,19}$/.test(digits)) return false
  let sum = 0
  const parity = digits.length % 2
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[index])
    if (index % 2 === parity) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
  }
  return sum % 10 === 0
}

export function validateInstitutionCardDetails(details = {}) {
  const cardNumber = String(details.cardNumber || '').replace(/[\s-]/g, '')
  const cardholderName = String(details.cardholderName || '').trim()
  const expiryDateMonth = Number(details.expiryDateMonth)
  const expiryDateYear = String(details.expiryDateYear || '').slice(-2)
  const cvv = String(details.cvv || '')
  if (!luhnValid(cardNumber) || cardholderName.length < 2 || cardholderName.length > 128 ||
      !Number.isInteger(expiryDateMonth) || expiryDateMonth < 1 || expiryDateMonth > 12 ||
      !/^\d{2}$/.test(expiryDateYear) || !/^\d{3,4}$/.test(cvv)) {
    throw new Error('Provide valid card details for the secure card collection.')
  }
  const expiry = new Date(2000 + Number(expiryDateYear), expiryDateMonth, 0, 23, 59, 59)
  if (expiry < new Date()) throw new Error('The card expiry date must be in the future.')
  return { cardNumber, cardholderName, expiryDateMonth, expiryDateYear, cvv }
}

export function validateInstitutionBankPayout({ bankCode, bankAccountNumber, bankAccountName }) {
  const code = String(bankCode || '').trim().toUpperCase()
  const accountNumber = String(bankAccountNumber || '').replace(/\s/g, '')
  const accountName = String(bankAccountName || '').trim()
  if (!isInstitutionBankPartner(code)) throw new Error('Choose a supported bank partner.')
  if (!/^\d{6,34}$/.test(accountNumber)) throw new Error('Enter a valid bank account number.')
  if (accountName.length < 2 || accountName.length > 160) throw new Error('Enter a valid bank account holder name.')
  return { bankCode: code, bankAccountNumber: accountNumber, bankAccountName: accountName }
}