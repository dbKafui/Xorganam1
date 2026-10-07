import pg from 'pg'
import { env } from '../config/env.js'

const { Pool } = pg

export const pool = new Pool({
  connectionString: env.database.connectionString,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
})

pool.on('error', (err) => {
  // A background/idle client error must never crash the process - it's
  // just a dead connection the pool will replace on next checkout.
  // Driver errors may include SQL or connection details; emit only a stable code.
  console.error('[pg pool] unexpected idle client error', { code: err?.code || 'DB_ERROR' })
})

/**
 * Convenience wrapper for a single parameterized query.
 * @param {string} text
 * @param {any[]} params
 */
export function query(text, params) {
  return pool.query(text, params)
}

/**
 * Runs `fn` inside a transaction, committing on success and rolling back
 * on any thrown error. `fn` receives a checked-out client to use for all
 * statements in the transaction.
 */
export async function withTransaction(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
