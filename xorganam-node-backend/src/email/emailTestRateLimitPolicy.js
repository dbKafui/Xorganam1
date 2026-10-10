export async function consumeTenantQuota(redis, tenantId, limit, windowMs) {
  const key = `tenant-email-test:${tenantId}`
  const count = Number(await redis.eval(
    `local count = redis.call('INCR', KEYS[1])
     if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
     return count`,
    1,
    key,
    windowMs
  ))
  return { allowed: count <= limit, remaining: Math.max(0, limit - count) }
}