import crypto from 'node:crypto'
import { withTransaction } from '../db/pool.js'

const CODE_COUNT = 10
const CODE_PATTERN = /^[A-F0-9]{24}$/

function principalColumns(principalType) {
  if (principalType === 'TENANT') return { principalColumn: 'user_id', actorColumn: 'actor_user_id' }
  if (principalType === 'INSTITUTION') {
    return { principalColumn: 'institution_staff_id', actorColumn: 'actor_institution_staff_id' }
  }
  throw new Error('Recovery codes require a TENANT or INSTITUTION principal.')
}

export function normalizeRecoveryCode(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\s-]/g, '').toUpperCase()
}

export function isValidRecoveryCode(value) {
  return CODE_PATTERN.test(normalizeRecoveryCode(value))
}

function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex')
}

export function generateRecoveryCodes() {
  return Array.from({ length: CODE_COUNT }, () => {
    const raw = crypto.randomBytes(12).toString('hex').toUpperCase()
    return raw.match(/.{1,4}/g).join('-')
  })
}

export async function enableMfaWithRecoveryCodes(principalId, principalType, codes = generateRecoveryCodes()) {
  const { principalColumn } = principalColumns(principalType)
  const principalTable = principalType === 'TENANT' ? 'users' : 'institution_staff'
  const hashes = codes.map((code) => hashRecoveryCode(normalizeRecoveryCode(code)))

  await withTransaction(async (client) => {
    const scopeColumn = principalType === 'TENANT' ? 'tenant_id' : 'institution_id'
    const { rows } = await client.query(
      `UPDATE ${principalTable}
          SET mfa_enabled = TRUE, mfa_secret_encrypted = mfa_pending_secret_encrypted,
              mfa_pending_secret_encrypted = NULL, updated_at = now()
        WHERE id = $1 AND mfa_enabled = FALSE AND mfa_pending_secret_encrypted IS NOT NULL
        RETURNING id, ${scopeColumn}`,
      [principalId]
    )
    if (!rows.length) throw new Error('MFA enrollment is no longer valid.')

    for (const hash of hashes) {
      await client.query(
        `INSERT INTO mfa_recovery_codes (${principalColumn}, code_hash) VALUES ($1, $2)`,
        [principalId, hash]
      )
    }
    await client.query(
      `INSERT INTO platform_audit_log
         (actor_user_id, actor_institution_staff_id, tenant_id, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, 'MFA_ENABLED', $4, $5, $6)`,
      [
        principalType === 'TENANT' ? principalId : null,
        principalType === 'INSTITUTION' ? principalId : null,
        principalType === 'TENANT' ? rows[0].tenant_id : null,
        principalType === 'TENANT' ? 'user' : 'institution_staff',
        principalId,
        JSON.stringify({ recoveryCodesIssued: codes.length, institutionId: principalType === 'INSTITUTION' ? rows[0].institution_id : null })
      ]
    )
  })
  return codes
}

export async function replaceMfaRecoveryCodes(principalId, principalType, codes = generateRecoveryCodes(), requestContext = {}) {
  const { principalColumn } = principalColumns(principalType)
  const hashes = codes.map((code) => hashRecoveryCode(normalizeRecoveryCode(code)))

  await withTransaction(async (client) => {
    await client.query(`DELETE FROM mfa_recovery_codes WHERE ${principalColumn} = $1`, [principalId])
    for (const hash of hashes) {
      await client.query(
        `INSERT INTO mfa_recovery_codes (${principalColumn}, code_hash) VALUES ($1, $2)`,
        [principalId, hash]
      )
    }
    await client.query(
      `INSERT INTO platform_audit_log
         (actor_user_id, actor_institution_staff_id, tenant_id, action, resource_type, resource_id,
          details, ip_address, user_agent, request_id)
       VALUES ($1, $2, $3, 'MFA_RECOVERY_CODES_ROTATED', $4, $5, $6, $7, $8, $9)`,
      [
        principalType === 'TENANT' ? principalId : null,
        principalType === 'INSTITUTION' ? principalId : null,
        principalType === 'TENANT'
          ? (await client.query('SELECT tenant_id FROM users WHERE id = $1', [principalId])).rows[0]?.tenant_id || null
          : null,
        principalType === 'TENANT' ? 'user' : 'institution_staff',
        principalId,
        JSON.stringify({ recoveryCodesIssued: codes.length }),
        requestContext.ipAddress || null,
        requestContext.userAgent || null,
        requestContext.requestId || null
      ]
    )
  })
  return codes
}

export async function consumeMfaRecoveryCode(principalId, principalType, value, requestContext = {}) {
  const normalized = normalizeRecoveryCode(value)
  if (!isValidRecoveryCode(normalized)) return false
  const { principalColumn, actorColumn } = principalColumns(principalType)
  const codeHash = hashRecoveryCode(normalized)

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE mfa_recovery_codes SET used_at = now()
        WHERE ${principalColumn} = $1 AND code_hash = $2 AND used_at IS NULL
        RETURNING id`,
      [principalId, codeHash]
    )
    if (!rows.length) return false

    await client.query(
      `INSERT INTO platform_audit_log (${actorColumn}, action, resource_type, resource_id, details,
                  ip_address, user_agent, request_id)
       VALUES ($1, 'MFA_RECOVERY_CODE_USED', 'mfa_recovery_code', $2,
           jsonb_build_object('principalType', $3, 'codeRevealed', false), $4, $5, $6)`,
      [principalId, rows[0].id, principalType, requestContext.ipAddress || null,
        requestContext.userAgent || null, requestContext.requestId || null]
    )
    return true
  })
}
