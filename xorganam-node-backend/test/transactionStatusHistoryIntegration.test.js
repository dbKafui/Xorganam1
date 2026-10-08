import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { describe, it } from 'node:test'
import pg from 'pg'

const { Client } = pg
const connectionString = process.env.SECURITY_SCHEMA_TEST_DATABASE_URL

describe('transaction status history integration', () => {
  it('records initial and transitioned states and rejects history mutation', { skip: !connectionString }, async (t) => {
    const client = new Client({ connectionString })
    await client.connect()
    try {
      await client.query('BEGIN')
      const owner = await client.query(
        `SELECT m.tenant_id, m.id AS merchant_id
           FROM merchants m ORDER BY m.created_at LIMIT 1`
      )
      if (!owner.rows.length) {
        t.skip('The integration database needs a tenant merchant fixture.')
        return
      }

      const transaction = await client.query(
        `INSERT INTO transactions
           (tenant_id, merchant_id, type, status, amount, currency, internal_reference)
         VALUES ($1, $2, 'COLLECTION', 'PENDING', 1, 'GHS', $3)
         RETURNING id`,
        [owner.rows[0].tenant_id, owner.rows[0].merchant_id, `STATUS-HISTORY-${crypto.randomUUID()}`]
      )
      const transactionId = transaction.rows[0].id
      const initial = await client.query(
        `SELECT previous_status, next_status FROM transaction_status_history WHERE transaction_id = $1`,
        [transactionId]
      )
      assert.deepEqual(initial.rows.map((row) => [row.previous_status, row.next_status]), [[null, 'PENDING']])

      await client.query(`UPDATE transactions SET status = 'RECEIVED' WHERE id = $1`, [transactionId])
      const history = await client.query(
        `SELECT previous_status, next_status FROM transaction_status_history
          WHERE transaction_id = $1 ORDER BY changed_at, id`,
        [transactionId]
      )
      assert.deepEqual(history.rows.map((row) => [row.previous_status, row.next_status]), [
        [null, 'PENDING'],
        ['PENDING', 'RECEIVED']
      ])

      await assert.rejects(
        client.query(`UPDATE transaction_status_history SET failure_reason = 'tampered' WHERE transaction_id = $1`, [transactionId]),
        (error) => error.code === '55000'
      )
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      await client.end()
    }
  })
})
