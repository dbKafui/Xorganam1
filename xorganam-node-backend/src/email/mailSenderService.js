import { query } from '../db/pool.js'
import { readSecret } from '../security/vaultClient.js'
import { decryptTenantEmailSecrets } from '../security/tenantEmailConfigCrypto.js'
import { tenantEmailKeyring } from '../config/tenantEmailConfig.js'
import { emailDeliveryPolicy } from '../config/emailDelivery.js'
import { getRedisConnection } from '../queue/queue.js'
import { getRegisteredMailSender } from './senderRegistry.js'
import { EmailSenderCache } from './EmailSenderCache.js'
import { shouldUsePlatformEmailFallback } from './senderResolutionPolicy.js'

const senderCache = new EmailSenderCache(emailDeliveryPolicy.cacheMaxEntries)
let invalidationSubscriber = null
let subscriptionPromise = null

async function ensureInvalidationSubscription() {
  if (!subscriptionPromise) {
    invalidationSubscriber = getRedisConnection().duplicate()
    invalidationSubscriber.on('message', (channel, rawMessage) => {
      if (channel !== emailDeliveryPolicy.cacheInvalidationChannel) return
      try {
        const event = JSON.parse(rawMessage)
        if (event.tenantId) senderCache.invalidate(event.tenantId)
        else senderCache.invalidate()
      } catch {
        senderCache.invalidate()
      }
    })
    subscriptionPromise = invalidationSubscriber.subscribe(emailDeliveryPolicy.cacheInvalidationChannel)
      .catch((error) => {
        invalidationSubscriber?.disconnect()
        invalidationSubscriber = null
        subscriptionPromise = null
        throw error
      })
  }
  await subscriptionPromise
}

function senderFromConfig(config) {
  return getRegisteredMailSender(config.providerType, config, emailDeliveryPolicy)
}

async function loadTenantSender(tenantId) {
  const { rows } = await query(
    `SELECT tenant_id, provider_type, settings, secrets_encrypted, key_version,
            from_address, from_name, reply_to, sender_verified, enabled
       FROM tenant_email_config WHERE tenant_id = $1`,
    [tenantId]
  )
  const row = rows[0]
  if (shouldUsePlatformEmailFallback(row)) {
    const reason = row ? 'disabled' : 'missing'
    console.warn('[tenant-email] using platform default sender', { tenantId, reason })
    const defaultSecrets = await readSecret(emailDeliveryPolicy.defaultSecretReference)
    if (!defaultSecrets) throw new Error('Platform default email sender secrets are unavailable.')
    return senderFromConfig({
      tenantId,
      providerType: emailDeliveryPolicy.defaultProviderType,
      settings: emailDeliveryPolicy.defaultSettings,
      secrets: defaultSecrets,
      fromAddress: emailDeliveryPolicy.defaultFromAddress,
      fromName: emailDeliveryPolicy.defaultFromName,
      replyTo: null
    })
  }
  if (!row.sender_verified) throw new Error('Enabled tenant email config has no verified sender identity.')
  const secrets = row.secrets_encrypted
    ? decryptTenantEmailSecrets(tenantId, row.secrets_encrypted, row.key_version, tenantEmailKeyring.keys)
    : {}
  return senderFromConfig({
    tenantId,
    providerType: row.provider_type,
    settings: row.settings,
    secrets,
    fromAddress: row.from_address,
    fromName: row.from_name,
    replyTo: row.reply_to
  })
}

export async function getMailSender(tenantId) {
  if (typeof tenantId !== 'string' || !tenantId.trim()) throw new TypeError('A tenant ID is required to resolve an email sender.')
  await ensureInvalidationSubscription()
  const cached = senderCache.get(tenantId)
  if (cached) return cached
  senderCache.invalidate(tenantId)
  const sender = await loadTenantSender(tenantId)
  senderCache.set(tenantId, sender, emailDeliveryPolicy.cacheTtlMs)
  return sender
}

export async function invalidateMailSender(tenantId) {
  senderCache.invalidate(tenantId)
  await getRedisConnection().publish(
    emailDeliveryPolicy.cacheInvalidationChannel,
    JSON.stringify(tenantId ? { tenantId } : {})
  )
}

export function closeMailSenderInvalidationSubscription() {
  invalidationSubscriber?.disconnect()
  invalidationSubscriber = null
  subscriptionPromise = null
}