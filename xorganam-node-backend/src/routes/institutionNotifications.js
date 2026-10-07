import { Router } from 'express'
import { query, withTransaction } from '../db/pool.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { institutionAuthenticate } from '../middleware/institutionAuth.js'
import { requireInstitutionPermission } from '../middleware/requireInstitutionPermission.js'
import { institutionNotificationEvents, dispatchInstitutionNotification } from '../services/institutionNotificationService.js'

export const institutionNotificationsRouter = Router()
institutionNotificationsRouter.use(institutionAuthenticate)

institutionNotificationsRouter.get('/settings', requireInstitutionPermission('customer:view'), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT event, enabled, template_text, updated_at
       FROM institution_notification_settings WHERE institution_id = $1 ORDER BY event`,
    [req.institutionAuth.institutionId]
  )
  res.json(rows)
}))

institutionNotificationsRouter.put('/settings', requireInstitutionPermission('rule_config:write'), asyncHandler(async (req, res) => {
  const settings = req.body?.settings
  if (!Array.isArray(settings) || settings.length > institutionNotificationEvents.length) return res.status(400).json({ message: 'Provide notification settings as an array.' })
  const seen = new Set()
  for (const setting of settings) {
    if (!institutionNotificationEvents.includes(setting.event) || seen.has(setting.event) || typeof setting.enabled !== 'boolean' ||
        typeof setting.templateText !== 'string' || !setting.templateText.trim() || setting.templateText.length > 500) {
      return res.status(400).json({ message: 'Each notification event must be unique with an enabled flag and a 1–500 character SMS template.' })
    }
    seen.add(setting.event)
  }
  await withTransaction(async (tx) => {
    for (const setting of settings) await tx.query(
      `INSERT INTO institution_notification_settings (institution_id, event, enabled, template_text, updated_by_staff_id)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (institution_id, event) DO UPDATE SET
         enabled = EXCLUDED.enabled, template_text = EXCLUDED.template_text,
         updated_by_staff_id = EXCLUDED.updated_by_staff_id, updated_at = now()`,
      [req.institutionAuth.institutionId, setting.event, setting.enabled, setting.templateText.trim(), req.institutionAuth.id]
    )
  })
  res.json({ message: 'Notification settings saved.' })
}))

institutionNotificationsRouter.post('/send', requireInstitutionPermission('notification:send'), asyncHandler(async (req, res) => {
  const { customerId, event, amount, dueDate, productName } = req.body || {}
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(customerId || '') ||
      !institutionNotificationEvents.includes(event)) return res.status(400).json({ message: 'Select an institution customer and supported notification event.' })
  const { rows: customers } = await query(
    `SELECT id FROM institution_customers WHERE id = $1 AND institution_id = $2 AND is_active
      AND ($3 = 'INSTITUTION_ADMIN' OR branch_id IS NOT DISTINCT FROM $4)`,
    [customerId, req.institutionAuth.institutionId, req.institutionAuth.role, req.institutionAuth.branchId]
  )
  if (!customers.length) return res.status(404).json({ message: 'Active customer not found in your branch.' })
  const result = await dispatchInstitutionNotification({
    institutionId: req.institutionAuth.institutionId, customerId, event, sentByStaffId: req.institutionAuth.id,
    values: { amount: amount == null ? '' : String(amount).slice(0, 40), dueDate: dueDate == null ? '' : String(dueDate).slice(0, 40), productName: productName == null ? '' : String(productName).slice(0, 100) }
  })
  if (!result.sent) return res.status(result.reason === 'already-processed' ? 200 : 409).json(result)
  res.status(202).json({ message: 'SMS accepted by the notification gateway.', logId: result.logId })
}))

institutionNotificationsRouter.get('/log', requireInstitutionPermission('customer:view'), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT n.id, n.event, n.delivery_status, n.failure_reason, n.attempted_at, n.sent_at,
            n.sent_by_user_id, c.id AS customer_id, c.first_name, c.last_name, c.customer_number
       FROM institution_notification_log n JOIN institution_customers c ON c.id = n.customer_id
      WHERE n.institution_id = $1 AND ($2 = 'INSTITUTION_ADMIN' OR c.branch_id IS NOT DISTINCT FROM $3)
      ORDER BY n.attempted_at DESC LIMIT 300`,
    [req.institutionAuth.institutionId, req.institutionAuth.role, req.institutionAuth.branchId]
  )
  res.json(rows)
}))
