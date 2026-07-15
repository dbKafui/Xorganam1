import { pool, query } from '../db/pool.js'
import { hashPassword } from '../security/password.js'

const email = (process.env.SEED_ADMIN_EMAIL || 'admin@xorganam.local').toLowerCase().trim()
const password = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe!2026#'

async function main() {
  const existing = await query('SELECT id FROM users WHERE role = $1 LIMIT 1', ['PLATFORM_ADMIN'])
  if (existing.rows.length > 0) {
    console.log('A PLATFORM_ADMIN already exists - skipping seed.')
    await pool.end()
    return
  }

  const passwordHash = await hashPassword(password)

  await query(
    `INSERT INTO users (tenant_id, first_name, last_name, email, password_hash, role, is_active)
     VALUES (NULL, 'Platform', 'Administrator', $1, $2, 'PLATFORM_ADMIN', TRUE)`,
    [email, passwordHash]
  )

  console.log(`Seeded PLATFORM_ADMIN account: ${email}`)
  console.log('Change this password immediately outside of local/sandbox use.')
  await pool.end()
}

main().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
