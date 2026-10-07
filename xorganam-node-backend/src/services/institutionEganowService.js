import { createEganowClientForInstitution, normalizeEganowResponse, normalizePaypartnerCode } from './eganowClient.js'

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
  return inferred || normalizePaypartnerCode(requested || configured) || null
}

export async function initiateInstitutionCollection(institutionId, { reference, amount, msisdn, network, narration }) {
  const normalizedPhone = normalizePhone(msisdn)
  const { client, callbackUrl, networkProvider } = await createEganowClientForInstitution(institutionId)
  const paypartnerCode = networkFor(normalizedPhone, network, networkProvider)
  if (!paypartnerCode) throw new Error('Payment network could not be determined for this mobile number.')
  const payload = {
    paypartnerCode, amount, accountNoOrCardNoOrMSISDN: normalizedPhone,
    countryCode: 'GH0233', accountName: 'Customer', transactionId: reference,
    narration, transCurrencyIso: 'GHS', languageId: 'en', callback: callbackUrl
  }
  const response = await client.post('/api/transactions/collection', payload)
  return { ...normalizeEganowResponse(response.data), normalizedPhone, paypartnerCode }
}

export async function initiateInstitutionPayout(institutionId, { reference, amount, msisdn, network, narration }) {
  const normalizedPhone = normalizePhone(msisdn)
  const { client, callbackUrl, networkProvider } = await createEganowClientForInstitution(institutionId)
  const paypartnerCode = networkFor(normalizedPhone, network, networkProvider)
  if (!paypartnerCode) throw new Error('Payment network could not be determined for this mobile number.')
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
