import { combineAbortSignals, prepareEmailMessage, classifyProviderFailure } from '../emailMessagePolicy.js'

function personalizations(message) {
  const recipients = (items) => (items || []).map((email) => ({ email }))
  return [{
    to: recipients(message.to),
    ...(message.cc ? { cc: recipients(message.cc) } : {}),
    ...(message.bcc ? { bcc: recipients(message.bcc) } : {}),
    ...(message.headers ? { headers: message.headers } : {})
  }]
}

export class SendGridSender {
  constructor(config, policy) {
    this.config = config
    this.policy = policy
  }

  async send(message, { signal } = {}) {
    const prepared = prepareEmailMessage(message, this.config, this.policy)
    if (prepared.error) return { ok: false, transient: false, error: prepared.error }
    const apiKey = this.config.secrets?.apiKey
    if (typeof apiKey !== 'string' || !apiKey) return { ok: false, transient: false, error: 'SendGrid credentials are missing.' }
    const content = []
    if (prepared.message.text !== undefined) content.push({ type: 'text/plain', value: prepared.message.text })
    if (prepared.message.html !== undefined) content.push({ type: 'text/html', value: prepared.message.html })
    const payload = {
      personalizations: personalizations(prepared.message),
      from: prepared.message.from,
      subject: prepared.message.subject,
      content,
      ...(prepared.message.replyTo ? { reply_to: prepared.message.replyTo } : {}),
      ...(prepared.message.attachments.length ? { attachments: prepared.message.attachments.map((attachment) => ({
        content: Buffer.isBuffer(attachment.content) ? attachment.content.toString('base64') : Buffer.from(attachment.content).toString('base64'),
        filename: attachment.filename,
        type: attachment.contentType || 'application/octet-stream',
        disposition: 'attachment'
      })) } : {})
    }

    try {
      const response = await fetch(this.policy.sendgridApiUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: combineAbortSignals(signal, this.policy.sendTimeoutMs)
      })
      if (!response.ok) return classifyProviderFailure({ status: response.status })
      return { ok: true, transient: false, providerMessageId: response.headers.get('x-message-id') || undefined }
    } catch (error) {
      return classifyProviderFailure(error)
    }
  }
}