import { pool, query, withTransaction } from '../db/pool.js'
import { rotateTenantEmailSecrets } from '../security/tenantEmailConfigCrypto.js'
import { tenantEmailKeyring } from '../config/tenantEmailConfig.js'
import { emailDeliveryPolicy } from '../config/emailDelivery.js'
import { getRedisConnection } from '../queue/queue.js'

const dryRun = process.argv.includes('--dry-run')

async function rotateAll() {
  const { rows } = await query(
    `SELECT tenant_id, secrets_encrypted, key_version
       FROM tenant_email_config
      WHERE secrets_encrypted IS NOT NULL AND key_version <> $1
      ORDER BY tenant_id`,
    [tenantEmailKeyring.activeVersion]
  )
  let rotated = 0
  for (const row of rows) {
    const result = rotateTenantEmailSecrets(row.tenant_id, row.secrets_encrypted, row.key_version, tenantEmailKeyring)
    if (!dryRun) {
      await withTransaction(async (client) => {
        const update = await client.query(
          `UPDATE tenant_email_config
              SET secrets_encrypted = $3, key_version = $4, updated_at = now()
            WHERE tenant_id = $1 AND key_version = $2`,
          [row.tenant_id, row.key_version, result.ciphertext, result.keyVersion]
        )
        if (update.rowCount !== 1) throw new Error('Email secret changed during key rotation.')
      })
      await getRedisConnection().publish(emailDeliveryPolicy.cacheInvalidationChannel, JSON.stringify({ tenantId: row.tenant_id }))
    }
    result.ciphertext.fill(0)
    rotated += 1
  }
  process.stdout.write(`Tenant email secret rotation ${dryRun ? 'dry run' : 'complete'}: rows=${rotated}, activeKeyVersion=${tenantEmailKeyring.activeVersion}\n`)
}

rotateAll()
  .catch((error) => {
    console.error('[tenant-email-key-rotation] failed', { name: error?.name || 'Error', code: error?.code || 'ROTATION_FAILED' })
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end()
    if (!dryRun) {
      try { await getRedisConnection().quit() } catch { /* Redis may already be closed. */ }
    }
  })