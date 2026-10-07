import axios from 'axios'
import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import https from 'node:https'
import net from 'node:net'
import { readSecret } from '../security/vaultClient.js'

function privateIpv4(value) {
  const parts = value.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => part < 0 || part > 255)) return true
  const [a, b] = parts
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19))
}

function privateAddress(value) {
  const version = net.isIP(value)
  if (version === 4) return privateIpv4(value)
  if (version !== 6) return true
  const address = value.toLowerCase()
  return !(address.startsWith('2') || address.startsWith('3')) ||
    address.startsWith('2001:db8:') || address.startsWith('2001:0000:')
}

export async function validateMerchantWebhookUrl(rawUrl) {
  let url
  try { url = new URL(String(rawUrl || '')) } catch { throw new Error('Webhook URL must be a valid HTTPS URL.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Webhook URL must use HTTPS and must not contain credentials or a fragment.')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  let addresses
  if (net.isIP(host)) addresses = [{ address: host, family: net.isIP(host) }]
  else addresses = await dns.lookup(host, { all: true, verbatim: true })
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) {
    throw new Error('Webhook URL must resolve only to public IP addresses.')
  }
  return { url, address: addresses[0] }
}

export async function deliverMerchantWebhook({ config, eventType, eventId, payload }) {
  const { url, address } = await validateMerchantWebhookUrl(config.url)
  const secretData = await readSecret(config.secret_reference)
  const secret = secretData?.secret
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Merchant webhook signing secret is unavailable.')
  const body = JSON.stringify({ id: eventId, event: eventType, data: payload, sentAt: new Date().toISOString() })
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex')
  const lookup = (_hostname, options, callback) => {
    if (options?.all) return callback(null, [address])
    callback(null, address.address, address.family)
  }
  const httpsAgent = new https.Agent({ lookup, keepAlive: false })
  const response = await axios.post(url.toString(), body, {
    headers: { 'Content-Type': 'application/json', 'x-xorganam-signature': signature, 'x-xorganam-event': eventType },
    timeout: 10_000, maxRedirects: 0, maxContentLength: 65536, maxBodyLength: 65536,
    httpsAgent, proxy: false, validateStatus: (status) => status >= 200 && status < 300
  })
  return response.status
}
