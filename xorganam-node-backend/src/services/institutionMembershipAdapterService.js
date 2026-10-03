import axios from 'axios'
import https from 'node:https'
import dns from 'node:dns'
import { isIP } from 'node:net'
import { URL } from 'node:url'
import { query } from '../db/pool.js'

const REQUEST_TIMEOUT_MS = 5000
const MAX_RESPONSE_BYTES = 256 * 1024
const customAdapters = new Map()

function isBlockedAddress(address) {
  const version = isIP(address)
  if (version === 4) {
    const octets = address.split('.').map(Number)
    const [a, b] = octets
    return a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && octets[2] === 0) ||
      (a === 192 && b === 0 && octets[2] === 2) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 88 && octets[2] === 99) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && octets[2] === 100) ||
      (a === 203 && b === 0 && octets[2] === 113) ||
      a >= 224
  }
  if (version === 6) {
    const normalized = address.toLowerCase()
    return normalized === '::' || normalized === '::1' ||
      normalized.startsWith('fc') || normalized.startsWith('fd') ||
      normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb') ||
      normalized.startsWith('::ffff:') || normalized.startsWith('ff') ||
      normalized.startsWith('2001:db8:') || normalized.startsWith('2001:0:') ||
      normalized.startsWith('2002:')
  }
  return true
}

function secureLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error)
    if (!addresses.length || addresses.some(({ address }) => isBlockedAddress(address))) {
      return callback(new Error('Membership adapter host resolves to a prohibited network address.'))
    }
    if (options?.all) return callback(null, addresses)
    callback(null, addresses[0].address, addresses[0].family)
  })
}

function validateBaseUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('Membership adapter base URL is invalid.')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      !url.hostname || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') ||
      isIP(url.hostname)) {
    throw new Error('Membership adapter base URL must be a public HTTPS URL without embedded credentials.')
  }
  return url
}

function getPath(value, path) {
  if (!path || typeof path !== 'string') {
    throw new Error('Membership adapter response path is not configured.')
  }
  return path.split('.').reduce((current, key) => {
    if (!key || ['__proto__', 'prototype', 'constructor'].includes(key) ||
        current === null || current === undefined || typeof current !== 'object') {
      return undefined
    }
    return current[key]
  }, value)
}

function substitute(value, memberId) {
  if (typeof value === 'string') return value.replaceAll('{memberId}', memberId)
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, memberId))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substitute(entry, memberId)]))
  }
  return value
}

function resolveSecret(config) {
  const authConfig = config.auth_config
  const reference = authConfig && typeof authConfig === 'object' ? authConfig.secretRef : null
  if (config.auth_type === 'NONE') return null
  if (typeof reference !== 'string' || !/^[A-Z][A-Z0-9_]{2,127}$/.test(reference)) {
    throw new Error('Membership adapter secret reference is invalid or missing.')
  }
  const secret = process.env[reference]
  if (!secret) throw new Error('Membership adapter secret is not available in the configured secrets environment.')
  return secret
}

function adapterAuthHeaders(config, secret) {
  if (config.auth_type === 'NONE') return {}
  if (!secret) throw new Error('Membership adapter authentication secret is unavailable.')
  if (config.auth_type === 'API_KEY') return { 'x-api-key': secret }
  if (config.auth_type === 'BEARER') return { Authorization: `Bearer ${secret}` }
  if (config.auth_type === 'BASIC') return { Authorization: `Basic ${Buffer.from(secret).toString('base64')}` }
  throw new Error('Membership adapter authentication mode is not supported.')
}

function parseActive(value) {
  if (value === true || value === 1) return true
  if (value === false || value === 0) return false
  if (typeof value === 'string') {
    const normalized = value.trim().toUpperCase()
    if (['TRUE', 'YES', 'ACTIVE', 'APPROVED', 'MEMBER'].includes(normalized)) return true
    if (['FALSE', 'NO', 'INACTIVE', 'REJECTED', 'NOT_MEMBER'].includes(normalized)) return false
  }
  throw new Error('Membership adapter response did not contain a recognizable active status.')
}

function normalizeRequestTemplate(template, memberId) {
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    throw new Error('Membership adapter request template must be an object.')
  }
  const method = String(template.method || '').toUpperCase()
  if (!['GET', 'POST'].includes(method)) {
    throw new Error('Membership adapter request method must be GET or POST.')
  }
  const path = typeof template.path === 'string' ? template.path : ''
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error('Membership adapter request path must be a relative absolute-path.')
  }
  const headers = template.headers && typeof template.headers === 'object' && !Array.isArray(template.headers)
    ? template.headers
    : {}
  for (const name of Object.keys(headers)) {
    if (['authorization', 'x-api-key', 'host'].includes(name.toLowerCase())) {
      throw new Error('Membership adapter template cannot override protected headers.')
    }
  }
  return {
    method,
    path: substitute(path, encodeURIComponent(memberId)),
    headers: substitute(headers, memberId),
    data: method === 'POST' ? substitute(template.body, memberId) : undefined
  }
}

export function registerCustomInstitutionMembershipAdapter(key, adapter) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(key) || typeof adapter?.checkMembership !== 'function') {
    throw new Error('Custom membership adapter registration is invalid.')
  }
  customAdapters.set(key, adapter)
}

async function loadConfig(institutionId) {
  const { rows } = await query(
    `SELECT c.*, i.api_verification_supported
       FROM institution_api_adapter_config c
       JOIN institutions i ON i.id = c.institution_id
      WHERE c.institution_id = $1 AND i.status = 'ACTIVE'`,
    [institutionId]
  )
  if (!rows.length || !rows[0].api_verification_supported) {
    throw new Error('API-based membership verification is not enabled for this institution.')
  }
  return rows[0]
}

async function checkGenericRest(config, memberId) {
  const base = validateBaseUrl(config.base_url)
  const request = normalizeRequestTemplate(config.request_template, memberId)
  const basePrefix = base.toString().replace(/\/?$/, '/')
  const url = new URL(request.path.slice(1), basePrefix)
  if (url.origin !== base.origin) {
    throw new Error('Membership adapter request path escapes its configured host.')
  }

  const secret = resolveSecret(config)
  const response = await axios.request({
    method: request.method,
    url: url.toString(),
    data: request.data,
    headers: { Accept: 'application/json', ...request.headers, ...adapterAuthHeaders(config, secret) },
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 0,
    maxContentLength: MAX_RESPONSE_BYTES,
    maxBodyLength: MAX_RESPONSE_BYTES,
    proxy: false,
    httpsAgent: new https.Agent({ lookup: secureLookup }),
    validateStatus: (status) => status >= 200 && status < 300
  })

  const active = parseActive(getPath(response.data, config.response_active_path))
  const detail = config.response_detail_path ? getPath(response.data, config.response_detail_path) : null
  return {
    active,
    statusDetail: typeof detail === 'string' || typeof detail === 'number' || typeof detail === 'boolean'
      ? String(detail).slice(0, 500)
      : null
  }
}

export async function verifyInstitutionMembership(institutionId, memberId) {
  if (typeof memberId !== 'string' || !memberId.trim() || memberId.length > 200) {
    throw new Error('Membership reference is invalid.')
  }
  const config = await loadConfig(institutionId)
  if (config.adapter_type === 'CUSTOM') {
    const adapter = customAdapters.get(config.custom_adapter_key)
    if (!adapter) throw new Error('Configured custom membership adapter is not registered.')
    const result = await adapter.checkMembership(memberId.trim())
    if (!result || typeof result.active !== 'boolean') {
      throw new Error('Custom membership adapter returned an invalid result.')
    }
    return { active: result.active, statusDetail: String(result.statusDetail || '').slice(0, 500) || null }
  }
  if (config.adapter_type !== 'GENERIC_REST') {
    throw new Error('Configured membership adapter type is unsupported.')
  }
  return checkGenericRest(config, memberId.trim())
}

export const institutionMembershipAdapterInternals = {
  isBlockedAddress,
  validateBaseUrl,
  parseActive,
  normalizeRequestTemplate
}