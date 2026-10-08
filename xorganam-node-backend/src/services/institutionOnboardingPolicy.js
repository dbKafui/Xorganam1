export function normalizeInstitutionVerificationChecks(value = {}) {
  return {
    legalEntity: value.legalEntity === true,
    settlementAccount: value.settlementAccount === true,
    applicantAuthority: value.applicantAuthority === true
  }
}

export function hasCompleteInstitutionVerification(checks) {
  return Boolean(checks?.legalEntity && checks?.settlementAccount && checks?.applicantAuthority)
}