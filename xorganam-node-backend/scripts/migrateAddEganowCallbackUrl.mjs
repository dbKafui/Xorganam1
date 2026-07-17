import { query } from '../src/db/pool.js'

async function run() {
  const callbackUrl = process.env.EGANOW_CALLBACK_URL || null

  console.log('Adding eganow_callback_url column if missing...')
  await query('ALTER TABLE tenant_eganow_credentials ADD COLUMN IF NOT EXISTS eganow_callback_url VARCHAR(255);')

  if (callbackUrl) {
    console.log(`Backfilling existing rows with callbackUrl=${callbackUrl} where null`)
    const res = await query('UPDATE tenant_eganow_credentials SET eganow_callback_url = $1 WHERE eganow_callback_url IS NULL', [callbackUrl])
    console.log('Rows updated:', res.rowCount)
  }

  console.log('Migration complete.')
  process.exit(0)
}

run().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
