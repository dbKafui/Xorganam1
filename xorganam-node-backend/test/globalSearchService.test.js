import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

process.env.DATABASE_URL ||= 'postgresql://localhost/global_search_test'
process.env.REDIS_URL ||= 'redis://localhost:6379'
process.env.ENCRYPTION_MASTER_KEY ||= 'global-search-test-key'
process.env.JWT_SECRET ||= 'global-search-test-secret'

const { buildSearchPattern, searchGlobalRecords } = await import('../src/services/globalSearchService.js')

describe('operator global search', () => {
  it('requires a useful bounded search term and escapes LIKE metacharacters', () => {
    assert.throws(() => buildSearchPattern('x'), /between 2 and 100/)
    assert.throws(() => buildSearchPattern('x'.repeat(101)), /between 2 and 100/)
    assert.equal(buildSearchPattern('acme%_\\corp'), '%acme\\%\\_\\\\corp%')
  })

  it('uses a bounded parameterized query and never returns provider payloads', async () => {
    let call
    const rows = await searchGlobalRecords('alpha', async (sql, params) => {
      call = { sql, params }
      return { rows: [{ entity_type: 'tenant', label: 'Alpha' }] }
    })
    assert.deepEqual(rows, [{ entity_type: 'tenant', label: 'Alpha' }])
    assert.match(call.sql, /LIMIT \$2/)
    assert.doesNotMatch(call.sql, /raw_webhook_payload|password_hash|api_password/i)
    assert.equal(call.params[0], '%alpha%')
    assert.equal(Number.isInteger(call.params[1]), true)
  })
})
