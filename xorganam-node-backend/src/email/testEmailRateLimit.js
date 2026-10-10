import { getRedisConnection } from '../queue/queue.js'
import { emailDeliveryPolicy } from '../config/emailDelivery.js'
import { consumeTenantQuota } from './emailTestRateLimitPolicy.js'

export async function consumeTenantEmailTestQuota(tenantId) {
  return consumeTenantQuota(getRedisConnection(), tenantId, emailDeliveryPolicy.testRateLimit, emailDeliveryPolicy.testRateWindowMs)
}