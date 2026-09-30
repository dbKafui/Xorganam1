import { Router } from 'express'
import { query } from '../db/pool.js'
import { authenticate } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/asyncHandler.js'

export const notificationsRouter = Router()
notificationsRouter.use(authenticate)

notificationsRouter.get('/', asyncHandler(async (req, res) => {
  const [items, count] = await Promise.all([
    query(`SELECT id, notification_type, title, body, data, created_at, read_at
             FROM tenant_notifications WHERE user_id = $1
            ORDER BY created_at DESC LIMIT 50`, [req.user.id]),
    query('SELECT COUNT(*)::int AS count FROM tenant_notifications WHERE user_id = $1 AND read_at IS NULL', [req.user.id])
  ])
  res.json({ notifications: items.rows, unreadCount: count.rows[0].count })
}))

notificationsRouter.patch('/:notificationId/read', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `UPDATE tenant_notifications SET read_at = COALESCE(read_at, now())
      WHERE id = $1 AND user_id = $2
      RETURNING id, read_at`, [req.params.notificationId, req.user.id]
  )
  if (!rows.length) return res.status(404).json({ message: 'Notification not found.' })
  res.json(rows[0])
}))
