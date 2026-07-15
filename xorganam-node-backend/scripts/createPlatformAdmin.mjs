import { query, pool } from '../src/db/pool.js'
import { hashPassword } from '../src/security/password.js'

const email = (process.env.SEED_ADMIN_EMAIL || 'eyramd75@gmail.com').toLowerCase().trim()
const password = process.env.SEED_ADMIN_PASSWORD || '3yR@mCart3r'

async function main(){
  const existing = await query('SELECT id FROM users WHERE email = $1 LIMIT 1', [email])
  const passwordHash = await hashPassword(password)
  if(existing.rows.length>0){
    await query('UPDATE users SET password_hash=$2, role=$3, is_active=TRUE WHERE email=$1', [email, passwordHash, 'PLATFORM_ADMIN'])
    console.log('Updated existing PLATFORM_ADMIN:', email)
  } else {
    await query(`INSERT INTO users (tenant_id, first_name, last_name, email, password_hash, role, is_active)
      VALUES (NULL, 'Platform', 'Administrator', $1, $2, 'PLATFORM_ADMIN', TRUE)`, [email, passwordHash])
    console.log('Created PLATFORM_ADMIN:', email)
  }
  await pool.end()
}

main().catch((e)=>{ console.error(e); process.exit(1) })
