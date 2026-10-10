export const EMAIL_API_MESSAGES = Object.freeze({
  tenantAccessDenied: 'Email settings are available only to the authenticated tenant.',
  invalidTenantId: 'Tenant ID must be a valid UUID.',
  notConfigured: 'No tenant email configuration exists.',
  invalidConfiguration: 'Email configuration is invalid.',
  senderMustBeVerified: 'Verify the sender domain before enabling email delivery.',
  verificationChallengeRequired: 'Save an email sender address before requesting domain verification.',
  verificationChallengeCreated: 'Add the returned TXT record to your sender domain, then confirm verification.',
  senderVerificationSucceeded: 'Sender domain verified. Email delivery may now be enabled.',
  senderVerificationPending: 'The required DNS TXT record was not found or did not match.',
  testRequiresEnabledConfig: 'Enable a verified tenant email configuration before sending a test.',
  testQueued: 'Test email queued to the authenticated account email.',
  rateLimitExceeded: 'Test email limit reached for this tenant. Try again later.',
  deliveryNotFound: 'Email delivery was not found.',
  invalidDeliveryId: 'Delivery ID must be a valid UUID.'
})

export const EMAIL_TEST_MESSAGE = Object.freeze({
  subject: 'Tenant email configuration test',
  text: 'This is a test message confirming the configured tenant email sender.'
})