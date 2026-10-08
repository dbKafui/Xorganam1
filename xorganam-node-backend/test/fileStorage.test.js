import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import path from 'node:path'

process.env.DATABASE_URL = 'postgresql://localhost/test'
process.env.REDIS_URL = 'redis://localhost:6379'
process.env.ENCRYPTION_MASTER_KEY = 'test-key'
process.env.JWT_SECRET = 'test-secret'

const { safeTenantUploadDir } = await import('../src/services/fileStorage.js')

const TENANT_ID = '6f9619ff-8b86-4011-b42d-00cf4fc964ff'

describe('KYC file storage paths', () => {
  it('keeps a valid tenant directory under the KYC upload root', () => {
    const uploadDir = safeTenantUploadDir(TENANT_ID)
    assert.equal(path.basename(uploadDir), TENANT_ID)
    assert.match(uploadDir, /uploads[\\/]kyc[\\/]6f9619ff-/)
  })

  it('rejects path traversal and non-UUID tenant IDs', () => {
    assert.throws(() => safeTenantUploadDir('../../tmp'))
    assert.throws(() => safeTenantUploadDir('/tmp'))
  })
})
