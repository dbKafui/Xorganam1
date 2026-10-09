import nodemailer from 'nodemailer'
import { prepareEmailMessage, classifyProviderFailure } from '../emailMessagePolicy.js'

export class SmtpSender {
  constructor(config, policy) {
    this.config = config
    this.policy = policy
  }

  async send(message, { signal } = {}) {
    const prepared = prepareEmailMessage(message, this.config, this.policy)
    if (prepared.error) return { ok: false, transient: false, error: prepared.error }
    const { host, port, encryption } = this.config.settings
    const username = this.config.secrets?.username
    const password = this.config.secrets?.password
    const normalizedEncryption = String(encryption || '').toLowerCase()
    if (!host || !Number.isInteger(Number(port)) || !this.policy.allowedSmtpPorts.includes(Number(port))) {
      return { ok: false, transient: false, error: 'SMTP host or port is not configured correctly.' }
    }
    if (!this.policy.smtpEncryptionModes.includes(normalizedEncryption)) {
      return { ok: false, transient: false, error: 'SMTP encryption mode is not allowed by policy.' }
    }
    if (normalizedEncryption === 'implicit_tls' && Number(port) !== this.policy.smtpImplicitTlsPort) {
      return { ok: false, transient: false, error: 'Implicit TLS must use the configured implicit-TLS SMTP port.' }
    }
    if (normalizedEncryption === 'starttls' && !this.policy.smtpStartTlsPorts.includes(Number(port))) {
      return { ok: false, transient: false, error: 'STARTTLS must use a configured STARTTLS SMTP port.' }
    }
    if (normalizedEncryption === 'none' && !this.policy.allowInsecureSmtp) {
      return { ok: false, transient: false, error: 'Unencrypted SMTP is disabled.' }
    }

    const transport = nodemailer.createTransport({
      host,
      port: Number(port),
      secure: normalizedEncryption === 'implicit_tls',
      requireTLS: normalizedEncryption === 'starttls',
      ...(username ? { auth: { user: username, pass: password } } : {}),
      connectionTimeout: this.policy.sendTimeoutMs,
      greetingTimeout: this.policy.sendTimeoutMs,
      socketTimeout: this.policy.sendTimeoutMs,
      tls: { servername: host }
    })
    if (signal?.aborted) {
      transport.close()
      return { ok: false, transient: true, error: 'Email delivery was cancelled.' }
    }
    let timeout
    let removeAbortListener = () => {}
    try {
      const aborted = new Promise((_, reject) => {
        const onAbort = () => {
          transport.close()
          reject(new Error('ABORT_ERR'))
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        removeAbortListener = () => signal?.removeEventListener('abort', onAbort)
        timeout = setTimeout(() => {
          transport.close()
          reject(new Error('ETIMEDOUT'))
        }, this.policy.sendTimeoutMs)
      })
      const result = await Promise.race([transport.sendMail(prepared.message), aborted])
      return { ok: true, transient: false, providerMessageId: result.messageId || result.response || undefined }
    } catch (error) {
      return classifyProviderFailure(error)
    } finally {
      clearTimeout(timeout)
      removeAbortListener()
      transport.close()
    }
  }
}