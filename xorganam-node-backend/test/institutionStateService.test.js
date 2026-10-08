import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const {
  assertInstitutionFinancialTransactionStatusTransition,
  assertInstitutionTransactionStatusTransition,
  updateInstitutionFinancialTransactionStatus,
  updateInstitutionTransactionStatus
} = await import('../src/services/institutionStateService.js')

describe('institution status integrity', () => {
  it('allows each defined institution financial workflow transition', () => {
    assert.doesNotThrow(() => assertInstitutionFinancialTransactionStatusTransition({
      currentStatus: 'PENDING_APPROVAL',
      nextStatus: 'PENDING_GATEWAY'
    }))
    assert.doesNotThrow(() => assertInstitutionFinancialTransactionStatusTransition({
      currentStatus: 'PENDING_APPROVAL',
      nextStatus: 'REJECTED'
    }))
    assert.doesNotThrow(() => assertInstitutionFinancialTransactionStatusTransition({
      currentStatus: 'PENDING_GATEWAY',
      nextStatus: 'POSTED'
    }))
    assert.doesNotThrow(() => assertInstitutionFinancialTransactionStatusTransition({
      currentStatus: 'PENDING_GATEWAY',
      nextStatus: 'FAILED'
    }))
  })

  it('rejects illegal institution financial transitions', () => {
    assert.throws(() => assertInstitutionFinancialTransactionStatusTransition({
      currentStatus: 'POSTED',
      nextStatus: 'FAILED'
    }), /Illegal institution financial transaction status transition/)
    assert.throws(() => assertInstitutionFinancialTransactionStatusTransition({
      currentStatus: 'REJECTED',
      nextStatus: 'POSTED'
    }), /Illegal institution financial transaction status transition/)
  })

  it('allows each institution transaction workflow transition', () => {
    assert.doesNotThrow(() => assertInstitutionTransactionStatusTransition({
      currentStatus: 'PENDING',
      nextStatus: 'RECEIVED'
    }))
    assert.doesNotThrow(() => assertInstitutionTransactionStatusTransition({
      currentStatus: 'PENDING',
      nextStatus: 'PAID_OUT'
    }))
    assert.doesNotThrow(() => assertInstitutionTransactionStatusTransition({
      currentStatus: 'PENDING',
      nextStatus: 'FAILED'
    }))
  })

  it('rejects illegal institution transaction transitions', () => {
    assert.throws(() => assertInstitutionTransactionStatusTransition({
      currentStatus: 'PAID_OUT',
      nextStatus: 'FAILED'
    }), /Illegal institution transaction status transition/)
    assert.throws(() => assertInstitutionTransactionStatusTransition({
      currentStatus: 'RECEIVED',
      nextStatus: 'PENDING'
    }), /Illegal institution transaction status transition/)
  })

  it('scopes institution financial status updates with distinct SQL parameters', async () => {
    let call
    const client = {
      async query(sql, params) {
        call = { sql, params }
        return { rows: [{ id: 'financial-txn-1', status: 'POSTED' }] }
      }
    }

    await updateInstitutionFinancialTransactionStatus(client, {
      id: 'financial-txn-1',
      institutionId: 'institution-1',
      currentStatus: 'PENDING_GATEWAY',
      nextStatus: 'POSTED',
      fields: { provider_reference: 'provider-1' }
    })

    assert.match(call.sql, /institution_id = \$3 AND status = \$4/)
    assert.match(call.sql, /provider_reference = \$5/)
    assert.deepEqual(call.params, ['financial-txn-1', 'POSTED', 'institution-1', 'PENDING_GATEWAY', 'provider-1'])
  })

  it('scopes institution transaction status updates with distinct SQL parameters', async () => {
    let call
    const client = {
      async query(sql, params) {
        call = { sql, params }
        return { rows: [{ id: 'institution-txn-1', status: 'RECEIVED' }] }
      }
    }

    await updateInstitutionTransactionStatus(client, {
      id: 'institution-txn-1',
      institutionId: 'institution-1',
      currentStatus: 'PENDING',
      nextStatus: 'RECEIVED',
      fields: { eganow_reference: 'provider-1' }
    })

    assert.match(call.sql, /institution_id = \$3 AND status = \$4/)
    assert.match(call.sql, /eganow_reference = \$5/)
    assert.deepEqual(call.params, ['institution-txn-1', 'RECEIVED', 'institution-1', 'PENDING', 'provider-1'])
  })
})
