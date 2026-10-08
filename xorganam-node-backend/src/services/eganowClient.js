import axios from 'axios'
import { getTenantEganowContext, getMerchantEganowContext, getInstitutionEganowContext, TenantCredentialsError, InstitutionCredentialsError } from './credentialsService.js'

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
    const host = url.hostname.toLowerCase()
    const allowedHost = host === 'developer.sandbox.egacoreapi.com' || host === 'developer.deveganowapi.com'
      || host.endsWith('.egacoreapi.com') || host.endsWith('.deveganowapi.com')
    return !url.hostname || url.protocol !== 'https:' || !allowedHost || (!!url.port && url.port !== '443') || !!url.username || !!url.password || !!url.search || !!url.hash
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
  constructor(message, tenantId, statusCode) {
    super(message)
    this.name = 'EganowApiError'
    this.tenantId = tenantId
    this.statusCode = statusCode
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

  const rawStatus = data.transactionStatus ?? data.TransactionStatus ?? data.transactionstatus ?? data.messageSuccessfulOrFailed ?? data.status ?? data.message ?? null
  const normalizedStatus = normalizeGatewayStatusValue(rawStatus)
  const reference = data.eganowReferenceNo || data.EganowReferenceNo || data.reference || data.referenceNo || null
  const transactionId = data.transactionId || data.TransactionId || data.transactionReference || data.transaction_id || null
  const message = data.message || data.messageSuccessfulOrFailed || data.error || data.FailureReason || null

  const hasEganowShape = Object.prototype.hasOwnProperty.call(data, 'transactionStatus') ||
    Object.prototype.hasOwnProperty.call(data, 'TransactionStatus') ||
    Object.prototype.hasOwnProperty.call(data, 'transactionstatus') ||
    Object.prototype.hasOwnProperty.call(data, 'eganowReferenceNo') ||
    Object.prototype.hasOwnProperty.call(data, 'EganowReferenceNo') ||
    Object.prototype.hasOwnProperty.call(data, 'reference') ||
    Object.prototype.hasOwnProperty.call(data, 'referenceNo') ||
    Object.prototype.hasOwnProperty.call(data, 'transactionId') ||
    Object.prototype.hasOwnProperty.call(data, 'TransactionId') ||
    Object.prototype.hasOwnProperty.call(data, 'transactionReference') ||
    Object.prototype.hasOwnProperty.call(data, 'transaction_id') ||
    Object.prototype.hasOwnProperty.call(data, 'message')

  return {
    raw: data,
    status: normalizedStatus || (rawStatus === null && hasEganowShape ? 'PENDING' : null),
    reference,
    transactionId,
    message,
    redirectHtml: data.redirectHtml ?? data.data?.redirectHtml ?? null,
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

  const client = axios.create({
    baseURL: normalizedBaseUrl,
    timeout: 30_000,
    maxRedirects: 0,
    proxy: false,
    headers: {
      Authorization: `Bearer ${token}`,
      'x-Auth': ctx.xAuth,
      'Content-Type': 'application/json'
    }
  })

  return { client, tenantId, companyName: ctx.companyName, callbackUrl: ctx.callbackUrl || null }
}

export async function createEganowClientForMerchant(tenantId, merchantId) {
  const ctx = await getMerchantEganowContext(tenantId, merchantId)
  const normalizedBaseUrl = normalizeBaseUrl(ctx.baseUrl || DEFAULT_EGANOW_BASE_URL)
  if (isInvalidEganowBaseUrl(normalizedBaseUrl)) {
    throw new TenantCredentialsError('Vendor Eganow base URL is not permitted.', tenantId)
  }
  const tokenContext = `merchant:${merchantId}`
  const token = await requestDeveloperJwtToken(ctx, tokenContext, normalizedBaseUrl, { cacheKey: tokenContext })
  const client = axios.create({
    baseURL: normalizedBaseUrl,
    timeout: 30_000,
    maxRedirects: 0,
    proxy: false,
    headers: { Authorization: `Bearer ${token}`, 'x-Auth': ctx.xAuth, 'Content-Type': 'application/json' }
  })
  return { client, tenantId, merchantId, callbackUrl: ctx.callbackUrl, payoutAccountId: ctx.payoutAccountId }
}

export async function createEganowClientForInstitution(institutionId) {
  const ctx = await getInstitutionEganowContext(institutionId)
  const normalizedBaseUrl = normalizeBaseUrl(ctx.baseUrl || DEFAULT_EGANOW_BASE_URL)
  if (isInvalidEganowBaseUrl(normalizedBaseUrl)) throw new InstitutionCredentialsError('Institution Eganow base URL is invalid.', institutionId)
  const tokenContext = `institution:${institutionId}`
  const token = await requestDeveloperJwtToken(ctx, tokenContext, normalizedBaseUrl)
  const client = axios.create({
    baseURL: normalizedBaseUrl,
    timeout: 30_000,
    maxRedirects: 0,
    proxy: false,
    headers: { Authorization: `Bearer ${token}`, 'x-Auth': ctx.xAuth, 'Content-Type': 'application/json' }
  })
  return { client, institutionId, institutionName: ctx.institutionName, callbackUrl: ctx.callbackUrl,
    collectionAccountId: ctx.collectionAccountId, payoutAccountId: ctx.payoutAccountId, networkProvider: ctx.networkProvider }
}

export async function refreshEganowTokenForInstitution(institutionId) {
  const ctx = await getInstitutionEganowContext(institutionId)
  const normalizedBaseUrl = normalizeBaseUrl(ctx.baseUrl || DEFAULT_EGANOW_BASE_URL)
  if (isInvalidEganowBaseUrl(normalizedBaseUrl)) throw new InstitutionCredentialsError('Institution Eganow base URL is invalid.', institutionId)
  const token = await requestDeveloperJwtToken(ctx, `institution:${institutionId}`, normalizedBaseUrl,
    { forceRefresh: true, cacheKey: `institution:${institutionId}` })
  return { institutionId, token, baseUrl: normalizedBaseUrl }
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
  const cacheKey = options.cacheKey || tenantId
  if (!forceRefresh) {
    const cached = getCachedJwtToken(cacheKey)
    if (cached) return cached
  } else {
    eganowTokenCache.delete(cacheKey)
  }

  if (!ctx.apiUsername || !ctx.apiPassword) {
    throw new TenantCredentialsError('Tenant Eganow API username/password are not configured.', tenantId)
  }
  if (!ctx.xAuth) {
    throw new TenantCredentialsError('Tenant Eganow x-Auth is not configured.', tenantId)
  }

  const response = await axios.get('/api/auth/token', {
    baseURL: baseUrl,
    timeout: 30_000,
    maxRedirects: 0,
    proxy: false,
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
    throw new TenantCredentialsError(
      `Failed to obtain Eganow auth token for tenant ${tenantId}.`,
      tenantId
    )
  }

  eganowTokenCache.set(cacheKey, {
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
export async function sweepToPayoutAccount(tenantId, { reference, amount, network: _network, narration, merchantId = null }) {
  const { client } = merchantId
    ? await createEganowClientForMerchant(tenantId, merchantId)
    : await createEganowClientForTenant(tenantId)
  const narrationValue = narration || 'InternalTransfer'

  return withRetry(
    async () => {
      const payload = {
        narration: narrationValue,
        TransactionAmount: amount,
        transactionId: reference,
        countryCode: 'GH0233',
        languageId: 'en'
      }

      const response = await client.post('/api/transactions/collection-to-payout', payload)

      return normalizeEganowResponse(response.data)
    },
    { tenantId, operation: 'InternalTransfer' }
  )
}

/**
 * External disbursal: merchant's payout account -> her MoMo number.
 */
export async function disburseToMobileMoney(tenantId, { reference, amount, currency, accountNoOrCardNoOrMsisdn, network, narration, callback, destinationType = 'MOMO', accountName = 'Recipient', merchantId = null }) {
  const { client, callbackUrl: tenantCallbackUrl } = merchantId
    ? await createEganowClientForMerchant(tenantId, merchantId)
    : await createEganowClientForTenant(tenantId)

  return withRetry(
    async () => {
      const isBank = String(destinationType).toUpperCase() === 'BANK'
      const normalizedDestination = isBank ? String(accountNoOrCardNoOrMsisdn || '').replace(/\s/g, '') : normalizeMsisdnInput(accountNoOrCardNoOrMsisdn)
      let paypartnerCode = normalizePaypartnerCode(network)
      const inferredPaypartnerCode = isBank ? null : inferPaypartnerCodeFromMsisdn(normalizedDestination)
      if (inferredPaypartnerCode) {
        paypartnerCode = inferredPaypartnerCode
      }

      if (!paypartnerCode) {
        throw new EganowApiError('Payment partner code is not configured for this tenant.', tenantId)
      }

      const body = {
        paypartnerCode,
        amount,
        accountNoOrCardNoOrMSISDN: normalizedDestination,
        accountName,
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

      const response = await client.post('/api/transactions/payout', body)
      
      return normalizeEganowResponse(response.data)
    },
    { tenantId, operation: 'Payout' }
  )
}

export async function queryTransactionStatus(tenantId, reference, { merchantId = null } = {}) {
  const { client } = merchantId
    ? await createEganowClientForMerchant(tenantId, merchantId)
    : await createEganowClientForTenant(tenantId)

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

export async function getPayoutWalletBalance(tenantId, _accountId, merchantId = null) {
  const merchantContext = merchantId
    ? await createEganowClientForMerchant(tenantId, merchantId)
    : null
  if (merchantContext && _accountId && String(merchantContext.payoutAccountId) !== String(_accountId)) {
    throw new TenantCredentialsError('The payout account does not belong to this vendor.', tenantId)
  }
  const clientContext = merchantContext || await createEganowClientForTenant(tenantId)
  const { client } = clientContext

  return withRetry(
    async () => {
      const response = await client.get('/api/transactions/collection/get-balance', {
        data: {},
        headers: { 'Content-Type': 'application/json' }
      })
      const balance = Number(response.data?.balance)
      if (!Number.isFinite(balance) || balance < 0) {
        throw new EganowApiError('Eganow returned an invalid payout-wallet balance.', tenantId, response.status, response.data)
      }
      return balance
    },
    { tenantId, operation: 'PayoutWalletBalance' }
  )
}

export { TenantCredentialsError }
