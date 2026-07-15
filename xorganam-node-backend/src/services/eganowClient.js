import axios from 'axios'
import { env } from '../config/env.js'
import { getTenantEganowContext, TenantCredentialsError } from './credentialsService.js'

const PAYPARTNER_CODE_MAP = {
  MTNGH: 'MTNGH',
  MTN: 'MTNGH',
  TCELGH: 'TCELGH',
  TELECEL: 'TCELGH',
  TELECELGH: 'TCELGH',
  ATGH: 'ATGH',
  AIRTEL: 'ATGH',
  TIGO: 'ATGH',
  AIRTELTIGO: 'ATGH'
}

const DISALLOWED_EGANOW_BASE_URLS = [
  'https://developer.sandbox.egacoreapi.com',
  'http://developer.sandbox.egacoreapi.com'
]

function normalizePaypartnerCode(code) {
  if (!code) return null
  const normalized = String(code).trim().toUpperCase()
  return PAYPARTNER_CODE_MAP[normalized] || normalized
}

function normalizeMsisdnInput(rawValue) {
  if (rawValue === undefined || rawValue === null) return rawValue
  const raw = String(rawValue).trim()
  const digits = raw.replace(/\D/g, '')
  if (digits.startsWith('0') && digits.length === 10) {
    return `233${digits.slice(1)}`
  }
  if (digits.startsWith('233') && digits.length === 12) {
    return digits
  }
  if (digits.startsWith('2330') && digits.length === 13) {
    return `233${digits.slice(4)}`
  }
  if (digits.length === 9) {
    return `233${digits}`
  }
  return raw
}

export class EganowApiError extends Error {
  constructor(message, tenantId, statusCode, responseBody) {
    const bodyDetails = responseBody && typeof responseBody === 'object'
      ? JSON.stringify(responseBody)
      : responseBody
    super(`${message}${bodyDetails ? ` | response=${bodyDetails}` : ''}`)
    this.name = 'EganowApiError'
    this.tenantId = tenantId
    this.statusCode = statusCode
    this.responseBody = responseBody
  }
}

function normalizeEganowResponse(data) {
  return {
    raw: data,
    status: data.transactionStatus || data.status || data.message || null,
    reference: data.eganowReferenceNo || data.reference || data.referenceNo || null,
    transactionId: data.transactionId || data.transactionReference || null,
    message: data.message || data.error || null
  }
}

/**
 * Builds an Axios instance pre-configured with ONE tenant's Eganow
 * credentials. Never shared, never cached across tenants - a fresh client
 * is built per call so a stale/rotated token for tenant A can never leak
 * into a request made on behalf of tenant B.
 */
export async function createEganowClientForTenant(tenantId) {
  const ctx = await getTenantEganowContext(tenantId)

  if (!ctx.baseUrl) {
    throw new TenantCredentialsError('Tenant Eganow base URL is not configured.', tenantId)
  }

  const normalizedBaseUrl = String(ctx.baseUrl).trim()
  if (DISALLOWED_EGANOW_BASE_URLS.includes(normalizedBaseUrl)) {
    throw new TenantCredentialsError(
      'Sandbox Eganow base URL is not permitted. Please configure a valid tenant Eganow base URL.',
      tenantId
    )
  }

  if (!ctx.xAuth) {
    throw new TenantCredentialsError('Tenant Eganow x-Auth is not configured.', tenantId)
  }

  const token = await requestDeveloperJwtToken(ctx, tenantId)

  try {
    console.log('[eganow] tenant=', tenantId, 'usingTokenAuth=', true, 'hasXAuth=', !!ctx.xAuth)
  } catch (e) {
    /* ignore logging errors */
  }

  const client = axios.create({
    baseURL: ctx.baseUrl,
    timeout: 30_000,
    headers: {
      Authorization: `Bearer ${token}`,
      'x-Auth': ctx.xAuth,
      'Content-Type': 'application/json'
    }
  })

  return { client, tenantId, companyName: ctx.companyName }
}

export { normalizePaypartnerCode }

const EGANOW_TOKEN_CACHE_MS = 55 * 60 * 1000
const eganowTokenCache = new Map()

function getCachedJwtToken(tenantId) {
  const entry = eganowTokenCache.get(tenantId)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    eganowTokenCache.delete(tenantId)
    return null
  }
  return entry.token
}

async function requestDeveloperJwtToken(ctx, tenantId) {
  const cached = getCachedJwtToken(tenantId)
  if (cached) return cached

  if (!ctx.apiUsername || !ctx.apiPassword) {
    throw new TenantCredentialsError('Tenant Eganow API username/password are not configured.', tenantId)
  }
  if (!ctx.xAuth) {
    throw new TenantCredentialsError('Tenant Eganow x-Auth is not configured.', tenantId)
  }

  const response = await axios.get('/api/auth/token', {
    baseURL: ctx.baseUrl,
    timeout: 30_000,
    auth: {
      username: ctx.apiUsername,
      password: ctx.apiPassword
    },
    headers: {
      'x-Auth': ctx.xAuth,
      'Content-Type': 'application/json'
    }
  })

  const data = response.data
  const jwtToken = data?.developerJwtToken

  if (!jwtToken || data?.isSuccess === false) {
    const errorDetails = typeof data === 'object' ? JSON.stringify(data) : data
    throw new TenantCredentialsError(
      `Failed to obtain Eganow auth token for tenant ${tenantId}: ${errorDetails}`,
      tenantId
    )
  }

  eganowTokenCache.set(tenantId, {
    token: jwtToken,
    expiresAt: Date.now() + EGANOW_TOKEN_CACHE_MS
  })

  return jwtToken
}

async function withRetry(fn, { tenantId, operation, retries = 3 }) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err

      const status = err.response?.status
      const retryable = !status || status === 429 || status >= 500

      if (!retryable || attempt === retries) break

      const delayMs = 300 * 2 ** attempt
      console.warn(
        `[eganow] ${operation} retry ${attempt + 1}/${retries} for tenant ${tenantId} after ${delayMs}ms (status=${status})`
      )
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }

  throw new EganowApiError(
    `Eganow ${operation} failed for tenant ${tenantId}: ${lastError.message}`,
    tenantId,
    lastError.response?.status,
    lastError.response?.data
  )
}

/**
 * Internal transfer: merchant's collection account -> payout account.
 */
export async function sweepToPayoutAccount(tenantId, { reference, amount, network, narration }) {
  const { client } = await createEganowClientForTenant(tenantId)
  const paypartnerCode = normalizePaypartnerCode(network)
  const narrationValue = paypartnerCode || narration || 'InternalTransfer'

  return withRetry(
    async () => {
      const payload = {
        narration: narrationValue,
        TransactionAmount: amount,
        countryCode: 'GH0233',
        languageId: 'en'
      }
      
      // Add reference if provided for tracking
      if (reference) {
        payload.reference = reference
      }
      
      console.log('[eganow:sweep] tenant=', tenantId, 'payload=', JSON.stringify(payload))
      
      const response = await client.post('/api/transactions/collection-to-payout', payload)
      console.log('[eganow:sweep] response=', JSON.stringify(normalizeEganowResponse(response.data)))
      
      return normalizeEganowResponse(response.data)
    },
    { tenantId, operation: 'InternalTransfer' }
  )
}

/**
 * External disbursal: merchant's payout account -> her MoMo number.
 */
export async function disburseToMobileMoney(tenantId, { reference, amount, currency, accountNoOrCardNoOrMsisdn, network, narration, callback }) {
  const { client } = await createEganowClientForTenant(tenantId)

  return withRetry(
    async () => {
      const paypartnerCode = normalizePaypartnerCode(network)
      if (!paypartnerCode) {
        throw new EganowApiError('Payment partner code is not configured for this tenant.', tenantId)
      }

      const normalizedDestination = normalizeMsisdnInput(accountNoOrCardNoOrMsisdn)
      const body = {
        paypartnerCode,
        amount,
        accountNoOrCardNoOrMSISDN: normalizedDestination,
        accountName: 'Recipient',
        transactionId: reference,
        narration,
        transCurrencyIso: currency,
        expiryDateMonth: 0,
        expiryDateYear: 0,
        cvv: '',
        languageId: 'en'
      }
      if (callback) {
        body.callback = callback
      } else if (env.eganow.callbackUrl) {
        body.callback = env.eganow.callbackUrl
      }

      console.log('[eganow:payout] tenant=', tenantId, 'payload=', JSON.stringify({
        ...body,
        accountNoOrCardNoOrMSISDN: body.accountNoOrCardNoOrMSISDN ? '***' + body.accountNoOrCardNoOrMSISDN.slice(-4) : undefined
      }))

      const response = await client.post('/api/transactions/payout', body)
      console.log('[eganow:payout] response=', JSON.stringify(normalizeEganowResponse(response.data)))
      
      return normalizeEganowResponse(response.data)
    },
    { tenantId, operation: 'Payout' }
  )
}

export async function queryTransactionStatus(tenantId, reference) {
  const { client } = await createEganowClientForTenant(tenantId)

  return withRetry(
    async () => {
      const response = await client.post('/api/transactions/status', {
        transactionId: reference,
        languageId: 'en'
      })
      return normalizeEganowResponse(response.data)
    },
    { tenantId, operation: 'StatusQuery' }
  )
}

export { TenantCredentialsError }
