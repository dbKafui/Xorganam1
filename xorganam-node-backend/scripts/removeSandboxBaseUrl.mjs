import { query } from '../src/db/pool.js'

async function run() {
  const sandbox = process.env.EGANOW_SANDBOX_BASE_URL || null
  console.log(`Removing sandbox base URL (${sandbox}) from tenant_eganow_credentials`)
  const res = await query('UPDATE tenant_eganow_credentials SET eganow_base_url = NULL WHERE eganow_base_url = $1', [sandbox])
  console.log('Rows updated:', res.rowCount)
  console.log('Done.')
  process.exit(0)
}

run().catch((err) => {
  console.error('Failed:', err)
  process.exit(1)
})
