import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import pg from 'pg'

const { Client } = pg
const connectionString = process.env.SECURITY_SCHEMA_TEST_DATABASE_URL

describe('platform security schema integration', () => {
  it('keeps persisted platform audit events append-only', { skip: !connectionString }, async () => {
    const client = new Client({ connectionString })
    await client.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `INSERT INTO platform_audit_log (action, resource_type, details)
         VALUES ('SECURITY_SCHEMA_TEST', 'test', '{}'::jsonb)
         RETURNING id`
      )
      const auditId = rows[0].id

      await client.query('SAVEPOINT before_update')
      await assert.rejects(
        client.query(`UPDATE platform_audit_log SET action = 'MUTATED' WHERE id = $1`, [auditId]),
        (error) => error.code === '55000'
      )
      await client.query('ROLLBACK TO SAVEPOINT before_update')

      await client.query('SAVEPOINT before_delete')
      await assert.rejects(
        client.query('DELETE FROM platform_audit_log WHERE id = $1', [auditId]),
        (error) => error.code === '55000'
      )
      await client.query('ROLLBACK TO SAVEPOINT before_delete')

      await client.query('SAVEPOINT before_truncate')
      await assert.rejects(
        client.query('TRUNCATE platform_audit_log'),
        (error) => error.code === '55000'
      )
      await client.query('ROLLBACK TO SAVEPOINT before_truncate')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      await client.end()
    }
  })
})
