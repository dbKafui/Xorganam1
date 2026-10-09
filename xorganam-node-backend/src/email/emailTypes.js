/** @typedef {'smtp' | 'sendgrid' | 'ses' | 'mailgun'} EmailProviderType */

/**
 * @typedef {object} EmailMessage
 * @property {string|string[]} to
 * @property {string|string[]=} [cc]
 * @property {string|string[]=} [bcc]
 * @property {string} subject
 * @property {string=} [html]
 * @property {string=} [text]
 * @property {string=} [replyTo]
 * @property {Array<{filename:string, content:Buffer|string, contentType?:string}>=} [attachments]
 * @property {Record<string,string>=} [headers]
 */

/**
 * @typedef {object} SendResult
 * @property {boolean} ok
 * @property {string=} [providerMessageId]
 * @property {string=} [error]
 * @property {boolean} transient
 */

/**
 * @typedef {object} MailSender
 * @property {(message:EmailMessage, options?:{signal?:AbortSignal}) => Promise<SendResult>} send
 */

/**
 * @typedef {object} TenantEmailConfig
 * @property {string} tenantId
 * @property {EmailProviderType} providerType
 * @property {Record<string, unknown>} settings
 * @property {Buffer|null} secretsEncrypted
 * @property {number|null} keyVersion
 * @property {string} fromAddress
 * @property {string|null} fromName
 * @property {string|null} replyTo
 * @property {boolean} senderVerified
 * @property {boolean} enabled
 */

/** @typedef {{key:string, input:'text'|'number'|'password'|'select', required:boolean, secret:boolean, optionsSource?:string}} ProviderFieldDescriptor */

/**
 * @typedef {object} EmailProviderDescriptor
 * @property {EmailProviderType} type
 * @property {string} label
 * @property {ProviderFieldDescriptor[]} fields
 */