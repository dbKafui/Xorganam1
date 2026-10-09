import { combineAbortSignals, prepareEmailMessage, classifyProviderFailure } from '../emailMessagePolicy.js'

function appendRecipients(form, key, recipients) {
  for (const recipient of recipients || []) form.append(key, recipient)
}

export class MailgunSender {
  constructor(config, policy) {
    this.config = config
    this.policy = policy
  }

  async send(message, { signal } = {}) {
    const prepared = prepareEmailMessage(message, this.config, this.policy)
    if (prepared.error) return { ok: false, transient: false, error: prepared.error }
    const apiKey = this.config.secrets?.apiKey
    const domain = String(this.config.settings.domain || '').trim()
    const region = this.config.settings.region
    if (!apiKey || !domain || !this.policy.mailgunRegions.includes(region)) {
      return { ok: false, transient: false, error: 'Mailgun credentials or region are not configured correctly.' }
    }
    const form = new FormData()
    form.set('from', typeof prepared.message.from === 'string'
      ? prepared.message.from
      : `${prepared.message.from.name} <${prepared.message.from.address}>`)
    appendRecipients(form, 'to', prepared.message.to)
    appendRecipients(form, 'cc', prepared.message.cc)
    appendRecipients(form, 'bcc', prepared.message.bcc)
    form.set('subject', prepared.message.subject)
    if (prepared.message.text !== undefined) form.set('text', prepared.message.text)
    if (prepared.message.html !== undefined) form.set('html', prepared.message.html)
    if (prepared.message.replyTo) form.set('h:Reply-To', prepared.message.replyTo)
    for (const [name, value] of Object.entries(prepared.message.headers)) form.set(`h:${name}`, value)
    for (const attachment of prepared.message.attachments) {
      const content = Buffer.isBuffer(attachment.content) ? attachment.content : Buffer.from(attachment.content)
      form.append('attachment', new Blob([content], { type: attachment.contentType || 'application/octet-stream' }), attachment.filename)
    }

    try {
      const response = await fetch(`${this.policy.mailgunApiBaseUrls[region]}/${encodeURIComponent(domain)}/messages`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}` },
        body: form,
        signal: combineAbortSignals(signal, this.policy.sendTimeoutMs)
      })
      if (!response.ok) return classifyProviderFailure({ status: response.status })
      const result = await response.json().catch(() => ({}))
      return { ok: true, transient: false, providerMessageId: result.id || undefined }
    } catch (error) {
      return classifyProviderFailure(error)
    }
  }
}