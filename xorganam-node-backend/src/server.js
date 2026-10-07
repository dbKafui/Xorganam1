import express from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { env } from './config/env.js'
import { pool } from './db/pool.js'

import { webhooksRouter } from './routes/webhooks.js'
import { publicRouter } from './routes/public.js'
import { authRouter } from './routes/auth.js'
import { tenantsRouter } from './routes/tenants.js'
import { merchantsRouter } from './routes/merchants.js'
import { transactionsRouter } from './routes/transactions.js'
import { reportsRouter } from './routes/reports.js'
import { usersRouter } from './routes/users.js'
import { settlementConfigRouter } from './routes/settlementConfig.js'
import { periodicSettlementsRouter } from './routes/periodicSettlements.js'
import { tenantInstitutionLinksRouter } from './routes/tenantInstitutionLinks.js'
import { tenantPortalRouter } from './routes/tenantPortal.js'
import { notificationsRouter } from './routes/notifications.js'
import { creditPlansRouter, creditPaymentsRouter } from './routes/creditPlans.js'
import { creditCustomerPublicRouter, creditCustomerRouter } from './routes/creditCustomers.js'
import { creditWebhooksRouter } from './routes/creditWebhooks.js'
import { publicStorefrontRouter, storefrontRouter, storefrontCustomerRouter, storefrontAdminRouter } from './routes/storefront.js'
import { institutionAuthRouter, institutionPortalRouter } from './routes/institutionPortal.js'
import { institutionFinanceRouter, tenantInstitutionFinanceRouter } from './routes/institutionFinance.js'
import { institutionNotificationsRouter } from './routes/institutionNotifications.js'
import { institutionOnboardingPublicRouter, institutionOnboardingAdminRouter } from './routes/institutionOnboarding.js'
import { ForbiddenError } from './middleware/auth.js'
import { getRedisConnection } from './queue/queue.js'
import { mfaRouter } from './routes/mfa.js'
import { platformSecurityRouter } from './routes/platformSecurity.js'
import { sanitizeInput } from './middleware/sanitizeInput.js'
import './workers/eganowTokenRefreshWorker.js'

const app = express()
if (env.corsOrigins.includes('*')) {
  // Credentialed browser sessions must never be available to arbitrary origins.
  throw new Error('CORS_ORIGINS cannot contain a wildcard when credentials are enabled.')
}

app.use((req, res, next) => {
  // API responses do not need a browser document policy or third-party origins.
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  next()
})

app.use(
  cors({
    origin: env.corsOrigins,
    credentials: true
  })
)

// Captures the exact raw bytes of the request body onto req.rawBody
// BEFORE JSON parsing, since HMAC signature verification (webhooks route)
// must run against the same bytes Eganow signed - a re-serialized
// JSON.stringify(req.body) is not guaranteed to be byte-identical (key
// order, whitespace, number formatting can all differ) and would make
// every signature check fail.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf
    }
  })
)
app.use(sanitizeInput)

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1')
    const redis = getRedisConnection()
    await redis.ping()
    res.json({ status: 'ok' })
  } catch (err) {
    console.error('[health] dependency check failed', { code: err?.code || 'DEPENDENCY_UNAVAILABLE' })
    res.status(503).json({ status: 'unhealthy' })
  }
})

// Anonymous endpoints get a shared, stricter rate limit - they carry no
// auth token to key a per-user limiter on, so this is IP-based.
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests, please try again shortly.' }
})

const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many registration attempts, please try again later.' }
})

const creditCustomerAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many verification requests. Please try again later.' }
})

const institutionLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts. Please try again later.' }
})

const mfaVerificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many MFA attempts. Please try again later.' }
})

const tenantLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts. Please try again later.' }
})

const institutionRegistrationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many institution registration attempts. Please try again later.' }
})

app.use('/api/v1/webhooks', webhooksRouter)
app.use('/api/v1/public/tenants/register', registrationLimiter)
app.use('/api/v1/public/credit-customer', creditCustomerAuthLimiter, creditCustomerPublicRouter)
app.use('/api/v1/public/credit-installments', publicLimiter, creditPaymentsRouter)
app.use('/api/v1/public', publicLimiter, publicStorefrontRouter)
app.use('/api/v1/public', publicLimiter, publicRouter)

app.use('/api/v1/auth/login', tenantLoginLimiter)
app.use('/api/v1/auth/mfa', mfaVerificationLimiter, mfaRouter)
app.use('/api/v1/auth', authRouter)
app.use('/api/v1/platform/security-settings', platformSecurityRouter)
app.use('/api/v1/institution-auth/login', institutionLoginLimiter)
app.use('/api/v1/institution-auth/registrations', institutionRegistrationLimiter, institutionOnboardingPublicRouter)
app.use('/api/v1/institution-auth', institutionAuthRouter)
app.use('/api/v1/institution-onboarding', institutionOnboardingAdminRouter)
app.use('/api/v1/institution-portal', institutionPortalRouter)
app.use('/api/v1/institution-portal/finance', institutionFinanceRouter)
app.use('/api/v1/institution-portal/notifications', institutionNotificationsRouter)
app.use('/api/v1/tenant-portal/institution-finance', tenantInstitutionFinanceRouter)
app.use('/api/v1/tenants', tenantsRouter)
app.use('/api/v1/merchants', merchantsRouter)
app.use('/api/v1/transactions', transactionsRouter)
app.use('/api/v1/reports', reportsRouter)
app.use('/api/v1/users', usersRouter)
app.use('/api/v1/settlement-config', settlementConfigRouter)
app.use('/api/v1/tenant-institution-links', tenantInstitutionLinksRouter)
app.use('/api/v1/tenant-portal', tenantPortalRouter)
app.use('/api/v1/notifications', notificationsRouter)
app.use('/api/v1/credit-plans', creditPlansRouter)
app.use('/api/v1/credit-customer', creditCustomerRouter)
app.use('/api/v1/credit-webhooks', creditWebhooksRouter)
app.use('/api/v1/storefront', storefrontRouter)
app.use('/api/v1/storefront-customer', storefrontCustomerRouter)
app.use('/api/v1/storefront-admin', storefrontAdminRouter)
app.use('/api/v1/periodic-settlements', periodicSettlementsRouter)

app.use((req, res) => {
  res.status(404).json({ message: 'Not found.' })
})

// Centralized error handler - guarantees an unexpected thrown error in
// any route never crashes the process or leaks a stack trace to the caller.
app.use((err, _req, res, _next) => {
  if (err instanceof ForbiddenError) {
    return res.status(403).json({ message: err.message })
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Malformed JSON body.' })
  }
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ message: 'Uploaded document exceeds the 20 MB limit.' })
  if (err?.code === 'LIMIT_FILE_COUNT' || err?.code === 'LIMIT_FIELD_COUNT') return res.status(400).json({ message: 'Too many upload fields or files.' })
  if (err?.statusCode === 400) return res.status(400).json({ message: err.message })
  // Error messages may contain SQL, provider response bodies, callback URLs,
  // identifiers, or request data. Log only a stable error classification.
  console.error('[http] request failed', { name: err?.name || 'Error', code: err?.code || 'UNEXPECTED' })
  res.status(500).json({ message: 'Internal server error.' })
})

app.listen(env.port, () => {
  console.log(`XORGANAM API listening on :${env.port}`)
})

process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandled rejection', { name: reason?.name || typeof reason, code: reason?.code || 'UNEXPECTED' })
})

process.on('uncaughtException', (err) => {
  console.error('[process] uncaught exception', { name: err?.name || 'Error', code: err?.code || 'UNEXPECTED' })
})

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing DB pool…')
  await pool.end()
  process.exit(0)
})
