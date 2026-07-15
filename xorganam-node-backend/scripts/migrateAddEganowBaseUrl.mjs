import { query } from '../src/db/pool.js'

async function run() {
  const baseUrl = process.env.EGANOW_BASE_URL || null

  console.log('Adding eganow_base_url column if missing...')
  await query("ALTER TABLE tenant_eganow_credentials ADD COLUMN IF NOT EXISTS eganow_base_url VARCHAR(255);")

  console.log(`Backfilling existing rows with baseUrl=${baseUrl} where null`)
  const res = await query('UPDATE tenant_eganow_credentials SET eganow_base_url = $1 WHERE eganow_base_url IS NULL', [baseUrl])
  console.log('Rows updated:', res.rowCount)

  console.log('Migration complete.')
  process.exit(0)
}

run().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
