import { withTransaction } from '../db/pool.js'
import { writePlatformAudit } from './auditService.js'

export async function requestMerchantPayoutDestinationChange({ merchantId, tenantId, requestedNumber, actor, request }) {
  return withTransaction(async (client) => {
    const { rows: merchants } = await client.query(
      'SELECT tenant_id, mobile_money_number FROM merchants WHERE id = $1 FOR UPDATE', [merchantId]
    )
    const merchant = merchants[0]
    if (!merchant) return { missing: true }
    if (merchant.tenant_id !== tenantId) return { tenantMismatch: true }
    if (merchant.mobile_money_number === requestedNumber) return { unchanged: true }
    const { rows: pending } = await client.query(
      `SELECT id FROM merchant_payout_destination_change_requests
        WHERE merchant_id = $1 AND status = 'PENDING'`, [merchantId]
    )
    if (pending.length) return { pending: pending[0].id }
    const { rows } = await client.query(
      `INSERT INTO merchant_payout_destination_change_requests
         (tenant_id, merchant_id, requested_by_user_id, previous_mobile_money_number, requested_mobile_money_number)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, status, previous_mobile_money_number, requested_mobile_money_number, created_at`,
      [tenantId, merchantId, actor.id, merchant.mobile_money_number, requestedNumber]
    )
    await writePlatformAudit({
      actorUserId: actor.id, tenantId, merchantId,
      action: 'MERCHANT_PAYOUT_DESTINATION_CHANGE_REQUESTED',
      resourceType: 'merchant_payout_destination_change_request', resourceId: rows[0].id,
      details: { previousMobileMoneyNumber: merchant.mobile_money_number, requestedMobileMoneyNumber: requestedNumber },
      ipAddress: request.ip || null, userAgent: request.headers['user-agent'] || null,
      requestId: request.id || null, client
    })
    return { request: rows[0] }
  })
}

export async function reviewMerchantPayoutDestinationChange({ requestId, tenantId, actor, decision, reason, request }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT r.*, m.mobile_money_number AS current_mobile_money_number
         FROM merchant_payout_destination_change_requests r
         JOIN merchants m ON m.id = r.merchant_id
        WHERE r.id = $1 AND r.tenant_id = $2 FOR UPDATE OF r, m`, [requestId, tenantId]
    )
    const change = rows[0]
    if (!change) return { missing: true }
    if (change.status !== 'PENDING') return { decided: true, status: change.status }
    if (change.requested_by_user_id === actor.id) return { selfReview: true }
    if (decision === 'APPROVED' && change.current_mobile_money_number !== change.previous_mobile_money_number) return { stale: true }
    if (decision === 'APPROVED') {
      await client.query(
        'UPDATE merchants SET mobile_money_number = $2, updated_at = now() WHERE id = $1',
        [change.merchant_id, change.requested_mobile_money_number]
      )
    }
    const { rows: reviewed } = await client.query(
      `UPDATE merchant_payout_destination_change_requests
          SET status = $2, reviewed_by_user_id = $3, reviewed_at = now(), review_reason = $4
        WHERE id = $1 AND status = 'PENDING'
        RETURNING id, merchant_id, status, previous_mobile_money_number, requested_mobile_money_number, reviewed_by_user_id, review_reason, reviewed_at`,
      [requestId, decision, actor.id, reason || null]
    )
    await writePlatformAudit({
      actorUserId: actor.id, tenantId, merchantId: change.merchant_id,
      action: `MERCHANT_PAYOUT_DESTINATION_CHANGE_${decision}`,
      resourceType: 'merchant_payout_destination_change_request', resourceId: requestId,
      details: { previousMobileMoneyNumber: change.previous_mobile_money_number, requestedMobileMoneyNumber: change.requested_mobile_money_number, reason: reason || null },
      ipAddress: request.ip || null, userAgent: request.headers['user-agent'] || null,
      requestId: request.id || null, client
    })
    return { request: reviewed[0] }
  })
}
