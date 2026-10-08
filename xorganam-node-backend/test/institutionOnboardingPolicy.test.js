import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const {
  normalizeInstitutionVerificationChecks,
  hasCompleteInstitutionVerification
} = await import('../src/services/institutionOnboardingPolicy.js')

describe('institution onboarding review policy', () => {
  it('requires independent legal entity, settlement account, and applicant authority checks', () => {
    assert.equal(hasCompleteInstitutionVerification(normalizeInstitutionVerificationChecks({
      legalEntity: true,
      settlementAccount: true
    })), false)
    assert.equal(hasCompleteInstitutionVerification(normalizeInstitutionVerificationChecks({
      legalEntity: true,
      settlementAccount: true,
      applicantAuthority: true
    })), true)
  })

  it('accepts only explicit boolean verification attestations', () => {
    const checks = normalizeInstitutionVerificationChecks({
      legalEntity: 'true',
      settlementAccount: 1,
      applicantAuthority: true
    })
    assert.deepEqual(checks, { legalEntity: false, settlementAccount: false, applicantAuthority: true })
    assert.equal(hasCompleteInstitutionVerification(checks), false)
  })
})
