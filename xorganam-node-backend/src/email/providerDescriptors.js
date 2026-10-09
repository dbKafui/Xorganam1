/** @type {import('./emailTypes.js').EmailProviderDescriptor[]} */
export const EMAIL_PROVIDER_DESCRIPTORS = Object.freeze([
  {
    type: 'smtp',
    label: 'SMTP',
    fields: [
      { key: 'host', input: 'text', required: true, secret: false },
      { key: 'port', input: 'number', required: true, secret: false, optionsSource: 'smtpPorts' },
      { key: 'encryption', input: 'select', required: true, secret: false, optionsSource: 'smtpEncryptionModes' },
      { key: 'username', input: 'text', required: false, secret: true },
      { key: 'password', input: 'password', required: false, secret: true }
    ]
  },
  {
    type: 'sendgrid',
    label: 'SendGrid',
    fields: [{ key: 'apiKey', input: 'password', required: true, secret: true }]
  },
  {
    type: 'ses',
    label: 'Amazon SES',
    fields: [
      { key: 'region', input: 'select', required: true, secret: false, optionsSource: 'sesRegions' },
      { key: 'accessKeyId', input: 'password', required: true, secret: true },
      { key: 'secretAccessKey', input: 'password', required: true, secret: true },
      { key: 'sessionToken', input: 'password', required: false, secret: true }
    ]
  },
  {
    type: 'mailgun',
    label: 'Mailgun',
    fields: [
      { key: 'domain', input: 'text', required: true, secret: false },
      { key: 'region', input: 'select', required: true, secret: false, optionsSource: 'mailgunRegions' },
      { key: 'apiKey', input: 'password', required: true, secret: true }
    ]
  }
])

export const EMAIL_PROVIDER_TYPES = Object.freeze(EMAIL_PROVIDER_DESCRIPTORS.map(({ type }) => type))

export function isEmailProviderType(value) {
  return EMAIL_PROVIDER_TYPES.includes(value)
}