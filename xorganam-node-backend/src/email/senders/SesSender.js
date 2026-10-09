import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { combineAbortSignals, composeRawEmail, prepareEmailMessage, classifyProviderFailure } from '../emailMessagePolicy.js'

export class SesSender {
  constructor(config, policy) {
    this.config = config
    this.policy = policy
  }

  async send(message, { signal } = {}) {
    const prepared = prepareEmailMessage(message, this.config, this.policy)
    if (prepared.error) return { ok: false, transient: false, error: prepared.error }
    const region = this.config.settings.region
    if (!this.policy.sesRegions.includes(region)) return { ok: false, transient: false, error: 'Amazon SES region is not allowed by policy.' }
    if (!this.config.secrets?.accessKeyId || !this.config.secrets?.secretAccessKey) {
      return { ok: false, transient: false, error: 'Amazon SES credentials are missing.' }
    }
    const credentials = {
      accessKeyId: this.config.secrets.accessKeyId,
      secretAccessKey: this.config.secrets.secretAccessKey,
      ...(this.config.secrets.sessionToken ? { sessionToken: this.config.secrets.sessionToken } : {})
    }
    const client = new SESv2Client({
      region,
      ...(credentials ? { credentials } : {}),
      requestHandler: new NodeHttpHandler({
        connectionTimeout: this.policy.sendTimeoutMs,
        requestTimeout: this.policy.sendTimeoutMs
      })
    })
    try {
      const raw = await composeRawEmail(prepared.message)
      const result = await client.send(new SendEmailCommand({ Content: { Raw: { Data: raw } } }), {
        abortSignal: combineAbortSignals(signal, this.policy.sendTimeoutMs)
      })
      return { ok: true, transient: false, providerMessageId: result.MessageId }
    } catch (error) {
      return classifyProviderFailure(error)
    } finally {
      client.destroy()
    }
  }
}