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
import { UPLOAD_ROOT } from './services/fileStorage.js'
import { ForbiddenError } from './middleware/auth.js'

const app = express()

app.use(
  cors({
    origin: env.corsOrigins?.length ? env.corsOrigins : '*',
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

// KYC document files, served back out at the URL stored on kyc_documents.document_url.
app.use('/kyc-uploads', express.static(UPLOAD_ROOT))

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1')
    res.json({ status: 'ok' })
  } catch (err) {
    res.status(503).json({ status: 'db_unreachable', error: err.message })
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

app.use('/api/v1/webhooks', webhooksRouter)
app.use('/api/v1/public/tenants/register', registrationLimiter)
app.use('/api/v1/public', publicLimiter, publicRouter)

app.use('/api/v1/auth', authRouter)
app.use('/api/v1/tenants', tenantsRouter)
app.use('/api/v1/merchants', merchantsRouter)
app.use('/api/v1/transactions', transactionsRouter)
app.use('/api/v1/reports', reportsRouter)
app.use('/api/v1/users', usersRouter)

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
  console.error('[unhandled route error]', err)
  res.status(500).json({ message: 'Internal server error.' })
})

app.listen(env.port, () => {
  console.log(`XORGANAM API listening on :${env.port}`)
})

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason)
})

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err)
})

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing DB pool…')
  await pool.end()
  process.exit(0)
})
