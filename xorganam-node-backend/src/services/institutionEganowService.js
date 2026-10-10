import { createEganowClientForInstitution, normalizeEganowResponse } from './eganowClient.js'
import { INSTITUTION_MOMO_NETWORKS, resolveInstitutionMomoNetwork, validateInstitutionBankPayout, validateInstitutionCardDetails } from './institutionPaymentMethods.js'

const networkByPrefix = [
  [/^233(?:24|54|55|59|25)/, 'MTNGH'],
  [/^233(?:20|50)/, 'TCELGH'],
  [/^233(?:26|27|56|57)/, 'ATGH']
]

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '')
  const normalized = digits.startsWith('0') && digits.length === 10 ? `233${digits.slice(1)}` : digits.length === 9 ? `233${digits}` : digits
  if (!/^233[0-9]{9}$/.test(normalized)) throw new Error('Enter a valid Ghana mobile number.')
  return normalized
}

function networkFor(phone, requested, configured) {
  const inferred = networkByPrefix.find(([pattern]) => pattern.test(phone))?.[1]
  return resolveInstitutionMomoNetwork(requested, inferred, configured)
}

export async function initiateInstitutionCollection(institutionId, { reference, amount, msisdn, network, narration, collectionMethod = 'MOMO', cardDetails }) {
  const { client, callbackUrl, networkProvider } = await createEganowClientForInstitution(institutionId)
  if (String(collectionMethod).toUpperCase() === 'CARD') {
    const card = validateInstitutionCardDetails(cardDetails)
    const response = await client.post('/api/transactions/card/collect', {
      paypartnerCode: 'CARDGATEWAY', amount,
      accountNoOrCardNoOrMSISDN: card.cardNumber,
      accountName: card.cardholderName, transactionId: reference, narration,
      transCurrencyIso: 'GHS', expiryDateMonth: card.expiryDateMonth,
      expiryDateYear: Number(card.expiryDateYear), cvv: card.cvv,
      languageId: 'en', callback: callbackUrl
    })
    return normalizeEganowResponse(response.data)
  }

  const normalizedPhone = normalizePhone(msisdn)
  const paypartnerCode = networkFor(normalizedPhone, network, networkProvider)
  if (!INSTITUTION_MOMO_NETWORKS.some(({ code }) => code === paypartnerCode)) throw new Error('Choose MTN, Telecel, or AT/AirtelTigo for this MoMo collection.')
  const payload = {
    paypartnerCode, amount, accountNoOrCardNoOrMSISDN: normalizedPhone,
    countryCode: 'GH0233', accountName: 'Customer', transactionId: reference,
    narration, transCurrencyIso: 'GHS', languageId: 'en', callback: callbackUrl
  }
  const response = await client.post('/api/transactions/collection', payload)
  return { ...normalizeEganowResponse(response.data), normalizedPhone, paypartnerCode }
}

export async function initiateInstitutionPayout(institutionId, { reference, amount, msisdn, network, narration, destinationType = 'MOMO', bankCode, bankAccountNumber, bankAccountName }) {
  const { client, callbackUrl, networkProvider } = await createEganowClientForInstitution(institutionId)
  if (String(destinationType).toUpperCase() === 'BANK') {
    const bank = validateInstitutionBankPayout({ bankCode, bankAccountNumber, bankAccountName })
    const response = await client.post('/api/transactions/payout', {
      paypartnerCode: bank.bankCode, amount,
      accountNoOrCardNoOrMSISDN: bank.bankAccountNumber,
      accountName: bank.bankAccountName, transactionId: reference, narration,
      transCurrencyIso: 'GHS', expiryDateMonth: 0, expiryDateYear: 0,
      cvv: '', languageId: 'en', callback: callbackUrl
    })
    return normalizeEganowResponse(response.data)
  }

  const normalizedPhone = normalizePhone(msisdn)
  const paypartnerCode = networkFor(normalizedPhone, network, networkProvider)
  if (!INSTITUTION_MOMO_NETWORKS.some(({ code }) => code === paypartnerCode)) throw new Error('Choose MTN, Telecel, or AT/AirtelTigo for this MoMo payout.')
  const payload = {
    paypartnerCode, amount, accountNoOrCardNoOrMSISDN: normalizedPhone,
    accountName: 'Recipient', transactionId: reference, narration,
    transCurrencyIso: 'GHS', expiryDateMonth: 0, expiryDateYear: 0,
    cvv: '', languageId: 'en', callback: callbackUrl
  }
  const response = await client.post('/api/transactions/payout', payload)
  return { ...normalizeEganowResponse(response.data), normalizedPhone, paypartnerCode }
}

export async function queryInstitutionEganowStatus(institutionId, reference) {
  const { client } = await createEganowClientForInstitution(institutionId)
  const response = await client.post('/api/transactions/status', { transactionId: reference, languageId: 'en' })
  return normalizeEganowResponse(response.data)
}

export { normalizePhone }
