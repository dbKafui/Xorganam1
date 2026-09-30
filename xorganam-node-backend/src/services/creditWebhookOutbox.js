export async function recordCreditWebhookEvent(tx, { tenantId, merchantId, eventType, eventKey, payload }) {
  await tx.query(
    `INSERT INTO credit_webhook_outbox (tenant_id, merchant_id, event_key, event_type, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (event_key) DO NOTHING`,
    [tenantId, merchantId, eventKey, eventType, JSON.stringify(payload)]
  )
}
