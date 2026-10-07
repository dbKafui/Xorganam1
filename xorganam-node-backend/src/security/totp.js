import crypto from 'node:crypto'

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32Encode(bytes) {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31]
  return output
}

function base32Decode(value) {
  let bits = 0
  let buffer = 0
  const output = []
  for (const char of String(value).toUpperCase().replace(/=+$/, '')) {
    const index = BASE32.indexOf(char)
    if (index < 0) throw new Error('Invalid authenticator secret.')
    buffer = (buffer << 5) | index
    bits += 5
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(output)
}

export function createTotpSecret() {
  return base32Encode(crypto.randomBytes(20))
}

function totpAt(secret, timestamp) {
  const counter = BigInt(Math.floor(timestamp / 30_000))
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(counter)
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(message).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary = digest.readUInt32BE(offset) & 0x7fffffff
  return String(binary % 1_000_000).padStart(6, '0')
}

export function verifyTotp(secret, suppliedCode, now = Date.now()) {
  if (!/^\d{6}$/.test(String(suppliedCode || ''))) return false
  const supplied = Buffer.from(String(suppliedCode))
  for (const drift of [-30_000, 0, 30_000]) {
    const expected = Buffer.from(totpAt(secret, now + drift))
    if (crypto.timingSafeEqual(expected, supplied)) return true
  }
  return false
}

export function totpProvisioningUri(secret, accountName, issuer = 'XORGANAM') {
  const label = encodeURIComponent(`${issuer}:${accountName}`)
  const query = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' })
  return `otpauth://totp/${label}?${query}`
}
