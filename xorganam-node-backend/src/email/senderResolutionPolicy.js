export function shouldUsePlatformEmailFallback(tenantConfig) {
  return !tenantConfig || tenantConfig.enabled !== true
}