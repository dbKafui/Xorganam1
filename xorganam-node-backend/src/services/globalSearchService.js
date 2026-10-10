import { query } from '../db/pool.js'
import { authPolicy } from '../config/authPolicy.js'

export function buildSearchPattern(term) {
  const normalized = String(term || '').trim()
  if (normalized.length < 2 || normalized.length > 100) {
    throw new Error('Search query must be between 2 and 100 characters.')
  }
  return `%${normalized.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
}

export async function searchGlobalRecords(term, db = query) {
  const pattern = buildSearchPattern(term)
  const { rows } = await db(
    `SELECT entity_type, id, tenant_id, label, description, status, created_at FROM (
       SELECT 'tenant'::text AS entity_type, t.id::text AS id, t.id AS tenant_id, t.company_name AS label,
              t.contact_email AS description, t.status::text AS status, t.created_at
         FROM tenants t WHERE t.company_name ILIKE $1 ESCAPE '\\' OR t.contact_email ILIKE $1 ESCAPE '\\'
       UNION ALL
       SELECT 'merchant', m.id::text, m.tenant_id, m.display_name, m.vendor_reference,
              CASE WHEN m.is_active THEN 'ACTIVE' ELSE 'INACTIVE' END, m.created_at
         FROM merchants m WHERE m.display_name ILIKE $1 ESCAPE '\\' OR m.vendor_reference ILIKE $1 ESCAPE '\\' OR m.mobile_money_number ILIKE $1 ESCAPE '\\'
       UNION ALL
       SELECT 'transaction', t.id::text, t.tenant_id, t.internal_reference,
              concat(t.type::text, ' · ', t.amount::text, ' ', t.currency), t.status::text, t.created_at
         FROM transactions t WHERE t.internal_reference ILIKE $1 ESCAPE '\\' OR t.eganow_reference ILIKE $1 ESCAPE '\\'
            OR t.collection_msisdn ILIKE $1 ESCAPE '\\' OR t.payout_msisdn ILIKE $1 ESCAPE '\\'
       UNION ALL
       SELECT 'user', u.id::text, u.tenant_id, concat_ws(' ', u.first_name, u.last_name), u.email,
              CASE WHEN u.is_active THEN 'ACTIVE' ELSE 'INACTIVE' END, u.created_at
         FROM users u WHERE u.email ILIKE $1 ESCAPE '\\' OR u.first_name ILIKE $1 ESCAPE '\\' OR u.last_name ILIKE $1 ESCAPE '\\'
       UNION ALL
       SELECT 'customer', cp.customer_identifier, cp.tenant_id,
              COALESCE(NULLIF(cp.customer_name, ''), cp.customer_identifier), cp.customer_identifier,
              cp.status::text, cp.created_at
         FROM credit_plans cp
        WHERE cp.customer_identifier ILIKE $1 ESCAPE '\\' OR cp.customer_name ILIKE $1 ESCAPE '\\'
     ) matches ORDER BY created_at DESC LIMIT $2`,
    [pattern, authPolicy.globalSearchResultLimit]
  )
  return rows
}
