import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const {
  assertInstitutionSweepStatusTransition,
  updateInstitutionSweepStatus
} = await import('../src/services/institutionSweepStateService.js')

describe('institution sweep status integrity', () => {
  it('allows each defined sweep lifecycle transition', () => {
    assert.doesNotThrow(() => assertInstitutionSweepStatusTransition({
      currentStatus: 'PENDING', nextStatus: 'SETTLED'
    }))
    assert.doesNotThrow(() => assertInstitutionSweepStatusTransition({
      currentStatus: 'PENDING', nextStatus: 'ACCRUED_UNSWEPT'
    }))
    assert.doesNotThrow(() => assertInstitutionSweepStatusTransition({
      currentStatus: 'PENDING', nextStatus: 'PARTIALLY_SETTLED'
    }))
    assert.doesNotThrow(() => assertInstitutionSweepStatusTransition({
      currentStatus: 'PARTIALLY_SETTLED', nextStatus: 'SETTLED'
    }))
  })

  it('rejects illegal sweep transitions', () => {
    assert.throws(() => assertInstitutionSweepStatusTransition({
      currentStatus: 'SETTLED', nextStatus: 'PENDING'
    }), /Illegal institution sweep status transition/)
    assert.throws(() => assertInstitutionSweepStatusTransition({
      currentStatus: 'PARTIALLY_SETTLED', nextStatus: 'ACCRUED_UNSWEPT'
    }), /Illegal institution sweep status transition/)
  })

  it('rejects a second terminal-state update', async () => {
    const client = {
      query: async () => ({ rows: [] })
    }

    await assert.rejects(
      () => updateInstitutionSweepStatus(client, {
        id: '00000000-0000-0000-0000-000000000001',
        currentStatus: 'SETTLED',
        nextStatus: 'PENDING'
      }),
      /Illegal institution sweep status transition/
    )
  })
})
