function addressList(value) {
  if (value === undefined || value === null || value === '') return []
  return (Array.isArray(value) ? value : [value]).map((address) => String(address).trim()).filter(Boolean)
}

export function prepareEmailMessage(message, config, policy) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return { error: 'Invalid email message.' }
  const to = addressList(message.to)
  const cc = addressList(message.cc)
  const bcc = addressList(message.bcc)
  const recipients = [...to, ...cc, ...bcc]
  if (!recipients.length || recipients.length > policy.maxRecipients) return { error: 'Email recipient count is outside the configured limit.' }
  if (recipients.some((address) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))) return { error: 'Email recipient address is invalid.' }
  if (typeof message.subject !== 'string' || !message.subject.trim() || /[\r\n]/.test(message.subject)) {
    return { error: 'Email subject is invalid.' }
  }
  if (typeof config.fromAddress !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.fromAddress) || /[\r\n]/.test(config.fromName || '')) {
    return { error: 'Email sender identity is invalid.' }
  }
  if (typeof message.html !== 'string' && typeof message.text !== 'string') return { error: 'Email message must contain text or HTML.' }
  const replyTo = message.replyTo || config.replyTo || undefined
  if (replyTo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo)) return { error: 'Email reply address is invalid.' }
  const headers = message.headers || {}
  if (!headers || typeof headers !== 'object' || Array.isArray(headers) || Object.entries(headers).some(([name, value]) => (
    !/^[A-Za-z0-9-]+$/.test(name) || typeof value !== 'string' || /[\r\n]/.test(value)
  ))) return { error: 'Email headers are invalid.' }

  const attachments = Array.isArray(message.attachments) ? message.attachments : []
  let attachmentBytes = 0
  for (const attachment of attachments) {
    if (!attachment || typeof attachment.filename !== 'string' || !attachment.filename.trim() || /[\r\n]/.test(attachment.filename)) return { error: 'Email attachment metadata is invalid.' }
    if (Buffer.isBuffer(attachment.content)) attachmentBytes += attachment.content.length
    else if (typeof attachment.content === 'string') attachmentBytes += Buffer.byteLength(attachment.content)
    else return { error: 'Email attachment content is invalid.' }
    if (attachmentBytes > policy.maxAttachmentBytes) return { error: 'Email attachment size exceeds the configured limit.' }
  }

  const from = config.fromName
    ? { name: config.fromName, address: config.fromAddress }
    : config.fromAddress
  return {
    message: {
      from,
      to,
      ...(cc.length ? { cc } : {}),
      ...(bcc.length ? { bcc } : {}),
      subject: message.subject.trim(),
      ...(typeof message.html === 'string' ? { html: message.html } : {}),
      ...(typeof message.text === 'string' ? { text: message.text } : {}),
      replyTo,
      attachments,
      headers
    }
  }
}

export function classifyProviderFailure(error) {
  const smtpStatus = Number(error?.responseCode)
  const httpStatus = Number(error?.statusCode || error?.status || error?.$metadata?.httpStatusCode)
  const status = smtpStatus || httpStatus
  const code = String(error?.code || error?.cause?.code || error?.name || '').toUpperCase()
  const smtpTransient = smtpStatus >= 400 && smtpStatus < 500
  const httpTransient = [408, 425, 429].includes(httpStatus) || (httpStatus >= 500 && httpStatus < 600)
  const transient = smtpTransient || httpTransient || /TIMEOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|SOCKET|FETCH FAILED/.test(code)
  return {
    ok: false,
    transient,
    error: status ? `Email provider returned a failure (${status}).` : transient ? 'Email provider is temporarily unavailable.' : 'Email provider rejected the message.'
  }
}

export function resolveEmailJobFailure(attemptsMade, maxAttempts) {
  const retryPending = Number(attemptsMade) < Number(maxAttempts)
  return {
    status: retryPending ? 'RETRYING' : 'FAILED',
    completed: !retryPending
  }
}

export function combineAbortSignals(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}

export function composeRawEmail(message) {
  return new Promise((resolve, reject) => {
    import('nodemailer/lib/mail-composer/index.js').then(({ default: MailComposer }) => {
      new MailComposer(message).compile().build((error, buffer) => error ? reject(error) : resolve(buffer))
    }, reject)
  })
}

export function serializeEmailMessageForQueue(message) {
  return {
    ...message,
    attachments: Array.isArray(message?.attachments) ? message.attachments.map((attachment) => ({
      ...attachment,
      content: Buffer.isBuffer(attachment.content)
        ? { encoding: 'base64', value: attachment.content.toString('base64') }
        : attachment.content
    })) : []
  }
}

export function deserializeEmailMessageFromQueue(message) {
  return {
    ...message,
    attachments: Array.isArray(message?.attachments) ? message.attachments.map((attachment) => ({
      ...attachment,
      content: attachment.content?.encoding === 'base64' && typeof attachment.content.value === 'string'
        ? Buffer.from(attachment.content.value, 'base64')
        : attachment.content
    })) : []
  }
}