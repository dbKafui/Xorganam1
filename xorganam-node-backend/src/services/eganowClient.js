import axios from 'axios'
import { getTenantEganowContext, TenantCredentialsError } from './credentialsService.js'

const DEFAULT_EGANOW_BASE_URL = 'https://developer.deveganowapi.com'

const PAYPARTNER_CODE_MAP = {
  MTNGH: 'MTNGH',
  MTN: 'MTNGH',
  TCELGH: 'TCELGH',
  TELECEL: 'TCELGH',
  TELECELGH: 'TCELGH',
  VODAFONE: 'TCELGH',
  ATGH: 'ATGH',
  AIRTEL: 'ATGH',
  TIGO: 'ATGH',
  AIRTELTIGO: 'ATGH'
}

const EGANOW_PENDING_STATUSES = new Set(['pending', 'received', 'processing', 'accepted', 'authentication_in_progress'])
const EGANOW_SUCCESS_STATUSES = new Set(['success', 'successful', 'completed'])
const EGANOW_FAILURE_STATUSES = new Set(['failed', 'failure', 'declined', 'expired', 'cancelled', 'canceled', 'rejected'])

function normalizePaypartnerCode(code) {
  if (!code) return null
  const normalized = String(code).trim().toUpperCase()
  return PAYPARTNER_CODE_MAP[normalized] || normalized
}

function inferPaypartnerCodeFromMsisdn(msisdn) {
  if (!msisdn) return null
  const digits = String(msisdn).replace(/\D/g, '')
  if (digits.startsWith('23324') || digits.startsWith('23354') || digits.startsWith('23355') || digits.startsWith('23359') || digits.startsWith('23325')) {
    return 'MTNGH'
  }
  if (digits.startsWith('23320') || digits.startsWith('23350')) {
    return 'TCELGH'
  }
  if (digits.startsWith('23326') || digits.startsWith('23327') || digits.startsWith('23356') || digits.startsWith('23357')) {
    return 'ATGH'
  }
  return null
}

function normalizeMsisdnInput(rawValue) {
  if (rawValue === undefined || rawValue === null) return rawValue
  const raw = String(rawValue).trim()
  const digits = raw.replace(/\D/g, '')
  const strippedLeadingZero = digits.replace(/^0+/, '')
  if (strippedLeadingZero.length === 9) {
    return `233${strippedLeadingZero}`
  }
  if (digits.startsWith('2330') && digits.length === 13) {
    return `233${digits.slice(4)}`
  }
  if (digits.startsWith('233') && digits.length === 12) {
    return digits
  }
  if (digits.length === 9) {
    return `233${digits}`
  }
  return digits
}

function normalizeGatewayStatusValue(status) {
  if (status === null || status === undefined) return null
  return String(status).trim().toLowerCase()
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '')
}

function isInvalidEganowBaseUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl).toLowerCase()

  if (!normalized) return true

  try {
    const url = new URL(normalized)
    return !url.hostname || !['http:', 'https:'].includes(url.protocol)
  } catch {
    return true
  }
}

function isGatewayPending(status) {
  const normalized = normalizeGatewayStatusValue(status)
  return !normalized || EGANOW_PENDING_STATUSES.has(normalized)
}

function isGatewaySuccess(status) {
  const normalized = normalizeGatewayStatusValue(status)
  return normalized ? EGANOW_SUCCESS_STATUSES.has(normalized) : false
}

function isGatewayFailure(status) {
  const normalized = normalizeGatewayStatusValue(status)
  return normalized ? EGANOW_FAILURE_STATUSES.has(normalized) : false
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
  if (data === null || data === undefined) {
    return {
      raw: data,
      status: null,
      reference: null,
      transactionId: null,
      message: null,
      eganowReference: null
    }
  }

  if (typeof data !== 'object') {
    const value = String(data).trim()
    return {
      raw: data,
      status: value || null,
      reference: null,
      transactionId: null,
      message: value || null,
      eganowReference: null
    }
  }

  const rawStatus = data.transactionStatus ?? data.transactionstatus ?? data.messageSuccessfulOrFailed ?? data.status ?? data.message ?? null
  const normalizedStatus = normalizeGatewayStatusValue(rawStatus)
  const reference = data.eganowReferenceNo || data.reference || data.referenceNo || null
  const transactionId = data.transactionId || data.transactionReference || data.transaction_id || null
  const message = data.message || data.messageSuccessfulOrFailed || data.error || null

  const hasEganowShape = Object.prototype.hasOwnProperty.call(data, 'transactionStatus') ||
    Object.prototype.hasOwnProperty.call(data, 'transactionstatus') ||
    Object.prototype.hasOwnProperty.call(data, 'eganowReferenceNo') ||
    Object.prototype.hasOwnProperty.call(data, 'reference') ||
    Object.prototype.hasOwnProperty.call(data, 'referenceNo') ||
    Object.prototype.hasOwnProperty.call(data, 'transactionId') ||
    Object.prototype.hasOwnProperty.call(data, 'transactionReference') ||
    Object.prototype.hasOwnProperty.call(data, 'transaction_id') ||
    Object.prototype.hasOwnProperty.call(data, 'message')

  return {
    raw: data,
    status: normalizedStatus || (rawStatus === null && hasEganowShape ? 'PENDING' : null),
    reference,
    transactionId,
    message,
    eganowReference: reference
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

  const normalizedBaseUrl = normalizeBaseUrl(ctx.baseUrl || DEFAULT_EGANOW_BASE_URL)
  if (isInvalidEganowBaseUrl(normalizedBaseUrl)) {
    throw new TenantCredentialsError(
      'Tenant Eganow base URL is not permitted. Please configure a valid tenant Eganow base URL.',
      tenantId
    )
  }

  if (!ctx.xAuth) {
    throw new TenantCredentialsError('Tenant Eganow x-Auth is not configured.', tenantId)
  }

  const token = await requestDeveloperJwtToken(ctx, tenantId, normalizedBaseUrl)

  try {
    console.log('[eganow] tenant=', tenantId, 'usingTokenAuth=', true, 'hasXAuth=', !!ctx.xAuth)
  } catch (e) {
    /* ignore logging errors */
  }

  const client = axios.create({
    baseURL: normalizedBaseUrl,
    timeout: 30_000,
    headers: {
      Authorization: `Bearer ${token}`,
      'x-Auth': ctx.xAuth,
      'Content-Type': 'application/json'
    }
  })

  // Optional verbose logging for Eganow HTTP traffic. Enable by setting
  // environment variable EGANOW_DEBUG=true in the runtime environment.
  try {
    const debug = String(process.env.EGANOW_DEBUG || '').toLowerCase() === 'true'
    if (debug) console.log('[eganow] DEBUG logging enabled for tenant=', tenantId)

    if (debug) {
      client.interceptors.request.use((req) => {
        try {
          const safeHeaders = { ...req.headers }
          if (safeHeaders.Authorization) safeHeaders.Authorization = 'REDACTED'
          if (safeHeaders['x-Auth']) safeHeaders['x-Auth'] = 'REDACTED'
          console.log('[eganow:debug] REQUEST', {
            tenantId,
            method: req.method,
            url: req.baseURL ? (req.baseURL + req.url) : req.url,
            headers: safeHeaders,
            data: req.data
          })
        } catch (e) {
          console.warn('[eganow:debug] request log failed', e?.message)
        }
        return req
      })

      client.interceptors.response.use(
        (res) => {
          try {
            console.log('[eganow:debug] RESPONSE', {
              tenantId,
              status: res.status,
              statusText: res.statusText,
              data: res.data
            })
          } catch (e) {
            console.warn('[eganow:debug] response log failed', e?.message)
          }
          return res
        },
        (err) => {
          try {
            const resp = err.response
            console.log('[eganow:debug] ERROR RESPONSE', {
              tenantId,
              message: err.message,
              status: resp?.status || null,
              data: resp?.data || null
            })
          } catch (e) {
            console.warn('[eganow:debug] error response log failed', e?.message)
          }
          throw err
        }
      )
    }
  } catch (e) {
    /* ignore logging setup errors */
  }

  return { client, tenantId, companyName: ctx.companyName, callbackUrl: ctx.callbackUrl || null }
}

export async function refreshEganowTokenForTenant(tenantId) {
  const ctx = await getTenantEganowContext(tenantId)
  const normalizedBaseUrl = normalizeBaseUrl(ctx.baseUrl || DEFAULT_EGANOW_BASE_URL)

  if (isInvalidEganowBaseUrl(normalizedBaseUrl)) {
    throw new TenantCredentialsError(
      'Tenant Eganow base URL is not permitted. Please configure a valid tenant Eganow base URL.',
      tenantId
    )
  }

  if (!ctx.xAuth) {
    throw new TenantCredentialsError('Tenant Eganow x-Auth is not configured.', tenantId)
  }

  const token = await requestDeveloperJwtToken(ctx, tenantId, normalizedBaseUrl, { forceRefresh: true })
  return { tenantId, token, baseUrl: normalizedBaseUrl }
}

export {
  normalizePaypartnerCode,
  normalizeEganowResponse,
  normalizeGatewayStatusValue,
  isGatewayPending,
  isGatewaySuccess,
  isGatewayFailure
}

const EGANOW_TOKEN_CACHE_MS = 45 * 60 * 1000
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

async function requestDeveloperJwtToken(ctx, tenantId, baseUrl, options = {}) {
  const { forceRefresh = false } = options
  if (!forceRefresh) {
    const cached = getCachedJwtToken(tenantId)
    if (cached) return cached
  } else {
    eganowTokenCache.delete(tenantId)
  }

  if (!ctx.apiUsername || !ctx.apiPassword) {
    throw new TenantCredentialsError('Tenant Eganow API username/password are not configured.', tenantId)
  }
  if (!ctx.xAuth) {
    throw new TenantCredentialsError('Tenant Eganow x-Auth is not configured.', tenantId)
  }

  const debug = String(process.env.EGANOW_DEBUG || '').toLowerCase() === 'true'
  if (debug) {
    console.log('[eganow:debug] token.request', {
      tenantId,
      url: `${baseUrl}/api/auth/token`,
      authUsername: ctx.apiUsername ? 'configured' : 'missing',
      hasXAuth: !!ctx.xAuth
    })
  }

  let response
  try {
    response = await axios.get('/api/auth/token', {
      baseURL: baseUrl,
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
  } catch (err) {
    const resp = err.response
    console.error('[eganow:debug] token.request.failed', {
      tenantId,
      status: resp?.status || null,
      data: resp?.data || err.message,
      message: err.message
    })
    throw err
  }

  const data = response.data
  if (debug) {
    console.log('[eganow:debug] token.response', {
      tenantId,
      status: response.status,
      data: response.data
    })
  }
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
export async function sweepToPayoutAccount(tenantId, { amount, network, narration }) {
  const { client } = await createEganowClientForTenant(tenantId)
  const paypartnerCode = normalizePaypartnerCode(network)
  const narrationValue = narration || 'InternalTransfer'

  return withRetry(
    async () => {
      const payload = {
        narration: narrationValue,
        TransactionAmount: amount,
        countryCode: 'GH0233',
        languageId: 'en'
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
  const { client, callbackUrl: tenantCallbackUrl } = await createEganowClientForTenant(tenantId)

  return withRetry(
    async () => {
      const normalizedDestination = normalizeMsisdnInput(accountNoOrCardNoOrMsisdn)
      let paypartnerCode = normalizePaypartnerCode(network)
      const inferredPaypartnerCode = inferPaypartnerCodeFromMsisdn(normalizedDestination)
      if (inferredPaypartnerCode) {
        if (paypartnerCode && paypartnerCode !== inferredPaypartnerCode) {
          console.log('[eganow:payout] destination MSISDN paypartner differs from configured network; using inferred paypartner', {
            tenantId,
            configuredNetwork: network,
            configuredPaypartnerCode: paypartnerCode,
            inferredPaypartnerCode,
            destination: normalizedDestination
          })
        }
        paypartnerCode = inferredPaypartnerCode
      }

      if (!paypartnerCode) {
        throw new EganowApiError('Payment partner code is not configured for this tenant.', tenantId)
      }

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
      } else if (tenantCallbackUrl) {
        body.callback = tenantCallbackUrl
      } else {
        // Do not fall back to environment value — tenant must provide callback in their config
        throw new TenantCredentialsError('Tenant Eganow callback URL is not configured.', tenantId)
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
