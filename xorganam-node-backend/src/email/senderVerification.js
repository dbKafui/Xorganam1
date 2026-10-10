import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import { domainToASCII } from 'node:url'

export function createSenderVerificationToken() {
  const token = crypto.randomBytes(32).toString('base64url')
  const hash = crypto.createHash('sha256').update(token).digest('hex')
  return { token, hash }
}

export function senderVerificationRecord(fromAddress, token) {
  const domain = domainToASCII(String(fromAddress || '').split('@').at(-1).toLowerCase())
  if (!domain) throw new Error('Sender email domain is invalid.')
  return {
    recordType: 'TXT',
    recordName: `_xorganam-email-verification.${domain}`,
    recordValue: `xorganam-email-verification=${token}`
  }
}

export function hashSenderVerificationToken(token) {
  return crypto.createHash('sha256').update(token).digest()
}

export async function verifySenderDnsRecord(fromAddress, expectedHash, resolveTxt = dns.resolveTxt) {
  if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) return false
  const domain = domainToASCII(String(fromAddress || '').split('@').at(-1).toLowerCase())
  if (!domain) return false
  let records
  try {
    records = await resolveTxt(`_xorganam-email-verification.${domain}`)
  } catch (error) {
    if (error?.code === 'ENODATA' || error?.code === 'ENOTFOUND') return false
    throw error
  }
  const expected = Buffer.from(expectedHash, 'hex')
  for (const chunks of records) {
    const value = Array.isArray(chunks) ? chunks.join('') : String(chunks)
    const prefix = 'xorganam-email-verification='
    if (!value.startsWith(prefix)) continue
    const received = hashSenderVerificationToken(value.slice(prefix.length))
    if (received.length === expected.length && crypto.timingSafeEqual(received, expected)) return true
  }
  return false
}