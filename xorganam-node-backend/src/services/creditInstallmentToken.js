import jwt from 'jsonwebtoken'
import crypto from 'node:crypto'
import { env } from '../config/env.js'

const ISSUER = 'xorganam-credit'
const AUDIENCE = 'credit-installment-payment'

export function issueInstallmentToken({ planId, installmentId, expiresAt }) {
  return jwt.sign(
    { planId, installmentId, nonce: crypto.randomBytes(16).toString('hex') },
    env.jwt.secret,
    { algorithm: 'HS256', issuer: ISSUER, audience: AUDIENCE, expiresIn: Math.max(60, Math.floor((expiresAt.getTime() - Date.now()) / 1000)) }
  )
}

export function verifyInstallmentToken(token) {
  const payload = jwt.verify(token, env.jwt.secret, {
    algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE
  })
  if (!payload.planId || !payload.installmentId || !payload.nonce) throw new Error('Invalid installment payment link.')
  return { planId: payload.planId, installmentId: payload.installmentId }
}

export function installmentPaymentUrl(token) {
  const baseUrl = String(process.env.CHECKOUT_PUBLIC_URL || '').trim()
  if (!baseUrl) throw new Error('CHECKOUT_PUBLIC_URL is required to create customer payment links.')
  const url = new URL(`/pay/${encodeURIComponent(token)}`, baseUrl)
  return url.toString()
}
