import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeInput } from '../src/middleware/sanitizeInput.js'

function run(body, path = '/api/v1/example') {
  const req = { body, path }
  const result = { status: null, payload: null, next: false }
  const res = {
    status(code) { result.status = code; return this },
    json(payload) { result.payload = payload; return this }
  }
  sanitizeInput(req, res, () => { result.next = true })
  return { req, result }
}

test('normalizes email while preserving account and API passwords exactly', () => {
  const apiPassword = '  Api secret\nwith exact whitespace  '
  const { req, result } = run({ email: '  Test.User@Example.COM ', password: '  account password  ', apiPassword, eganowApiPassword: apiPassword })
  assert.equal(result.next, true)
  assert.equal(req.body.email, 'test.user@example.com')
  assert.equal(req.body.password, '  account password  ')
  assert.equal(req.body.apiPassword, apiPassword)
  assert.equal(req.body.eganowApiPassword, apiPassword)
})

test('rejects invalid telephone, amount, card, bank account, and Ghana Card values without echoing them', () => {
  const { result } = run({
    phoneNumber: 'call me',
    amount: '1.239',
    cardNumber: '4111111111111112',
    bankAccountNumber: '123',
    ghanaCardNumber: 'not-an-id'
  })
  assert.equal(result.status, 400)
  assert.equal(result.payload.errors.length, 5)
  assert.equal(JSON.stringify(result.payload).includes('call me'), false)
})

test('validates Ghana Card document numbers when the document type identifies one', () => {
  const valid = run({ idDocumentType: 'GHANA_CARD', idDocumentNumber: 'gha-123456789-0' })
  assert.equal(valid.result.next, true)
  assert.equal(valid.req.body.idDocumentNumber, 'GHA-123456789-0')

  const invalid = run({ documentType: 'GHANA_CARD', documentNumber: '123456789' })
  assert.equal(invalid.result.status, 400)
})

test('does not modify or validate raw Eganow webhook callback bodies', () => {
  const body = { TransactionId: 'provider-reference', TransactionStatus: 'SUCCESS', email: 'Not an email' }
  const { req, result } = run(body, '/api/v1/webhooks/eganow')
  assert.equal(result.next, true)
  assert.equal(req.body, body)
})
