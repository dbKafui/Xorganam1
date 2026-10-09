import { parseTenantEmailKeyring } from '../security/tenantEmailConfigCrypto.js'

export const tenantEmailKeyring = parseTenantEmailKeyring(process.env)