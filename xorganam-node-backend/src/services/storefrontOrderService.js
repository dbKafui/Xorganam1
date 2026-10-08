import crypto from 'node:crypto'
import { env } from '../config/env.js'
import { query, withTransaction } from '../db/pool.js'
import { CREDIT_PLAN_CANCELLABLE_STATUSES, updateCreditPlanStatus } from './creditStateService.js'

function normalizeMsisdn(value) {
  const digits = String(value || '').trim().replace(/\D/g, '')
  if (digits.startsWith('0') && digits.length === 10) return `233${digits.slice(1)}`
  if (digits.startsWith('233') && digits.length === 12) return digits
  if (digits.startsWith('2330') && digits.length === 13) return `233${digits.slice(4)}`
  if (digits.length === 9) return `233${digits}`
  return null
}

function cents(value) {
  const [whole, fraction = ''] = String(value).split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2))
}

function addDaysUtc(days) {
  const date = new Date()
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCDate(date.getUTCDate() + Number(days))
  return date.toISOString().slice(0, 10)
}

function nextDueDate(firstDate, frequency, offset) {
  const date = new Date(`${firstDate}T00:00:00.000Z`)
  if (frequency === 'DAILY') date.setUTCDate(date.getUTCDate() + offset)
  else if (frequency === 'WEEKLY') date.setUTCDate(date.getUTCDate() + offset * 7)
  else {
    const day = date.getUTCDate()
    date.setUTCDate(1)
    date.setUTCMonth(date.getUTCMonth() + offset)
    date.setUTCDate(Math.min(day, new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()))
  }
  return date.toISOString().slice(0, 10)
}

export class StorefrontOrderError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}

export const PREVENTED_ORDER_CANCELLATION_STATUS = {
  PENDING_PAYMENT: false,
  PLACED: false,
  FULFILLED: true,
  CANCELLED: true
}

export function assertStorefrontOrderCancellationAllowed(status) {
  return !PREVENTED_ORDER_CANCELLATION_STATUS[status]
}

export function isOrderPaymentSafeToCancel(paymentStatus) {
  return paymentStatus === null || paymentStatus === undefined || paymentStatus === 'FAILED'
}

export function isOrderCancellationSafe({
  paymentStatus,
  unresolvedReconciliation = false,
  creditPlanStatus = null,
  hasPaidInstallments = false
}) {
  return isOrderPaymentSafeToCancel(paymentStatus)
    && !unresolvedReconciliation
    && (!creditPlanStatus || (
      CREDIT_PLAN_CANCELLABLE_STATUSES.includes(creditPlanStatus) && !hasPaidInstallments
    ))
}

export function orderFingerprint({ slug, itemMap, customerIdentifier, customerName, fulfillmentType, address, merchantId, paymentMethod, collectionMethod }) {
  const payload = JSON.stringify({
    slug,
    items: [...itemMap.entries()].sort(([left], [right]) => left.localeCompare(right)),
    customerIdentifier,
    customerName,
    fulfillmentType,
    address,
    merchantId: merchantId || null,
    paymentMethod,
    collectionMethod: String(collectionMethod || 'MOMO').toUpperCase()
  })
  return crypto.createHmac('sha256', env.jwt.secret).update(payload).digest('hex')
}

async function createCreditPlan(tx, { tenantId, merchantId, orderId, customer, customerName, totalCents, defaults }) {
  const downPaymentCents = Math.round(totalCents * Number(defaults.down_payment_percent) / 100)
  const markupCents = cents(defaults.markup_amount)
  const financedCents = totalCents - downPaymentCents + markupCents
  const count = Number(defaults.installment_count)
  if (downPaymentCents >= totalCents || financedCents < count) throw new StorefrontOrderError('The vendor credit defaults do not fit this order amount. Contact the vendor.')
  const baseCents = Math.floor(financedCents / count)
  const firstDueDate = addDaysUtc(defaults.first_due_days)
  const { rows } = await tx.query(
    `INSERT INTO credit_plans
       (tenant_id, merchant_id, customer_identifier, customer_name, total_value, down_payment,
        installment_count, installment_frequency, installment_amount, markup_amount,
        late_fee_amount, late_fee_grace_days, missed_installment_threshold, order_id)
     VALUES ($1, $2, $3, NULLIF($4, ''), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id`,
    [tenantId, merchantId, customer, customerName, totalCents / 100, downPaymentCents / 100,
      count, defaults.installment_frequency, baseCents / 100, defaults.markup_amount,
      defaults.late_fee_amount, defaults.late_fee_grace_days, defaults.missed_installment_threshold, orderId]
  )
  const planId = rows[0].id
  for (let index = 0; index < count; index += 1) {
    const installmentCents = index === count - 1 ? financedCents - baseCents * index : baseCents
    await tx.query(
      `INSERT INTO credit_plan_installments (credit_plan_id, installment_number, due_date, amount_due)
       VALUES ($1, $2, $3::date, $4)`,
      [planId, index + 1, nextDueDate(firstDueDate, defaults.installment_frequency, index), installmentCents / 100]
    )
  }
  return { planId, downPayment: downPaymentCents / 100 }
}

export async function createStorefrontOrder(slug, input) {
  const customerIdentifier = normalizeMsisdn(input.customerPhone)
  if (!customerIdentifier) throw new StorefrontOrderError('Enter a valid Ghana mobile number.')
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 50) throw new StorefrontOrderError('Add between 1 and 50 products.')
  const itemMap = new Map()
  for (const item of input.items) {
    const productId = String(item?.productId || '')
    const quantity = Number(item?.quantity)
    if (!productId || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw new StorefrontOrderError('Each product requires a valid ID and quantity from 1 to 100.')
    if (itemMap.has(productId)) throw new StorefrontOrderError('Each product may appear only once in the cart.')
    itemMap.set(productId, quantity)
  }
  const fulfillmentType = String(input.fulfillmentType || '').toUpperCase()
  if (!['PICKUP', 'DELIVERY'].includes(fulfillmentType)) throw new StorefrontOrderError('Choose pickup or delivery.')
  const paymentMethod = String(input.paymentMethod || 'EGANOW').toUpperCase()
  if (!['EGANOW', 'CREDIT'].includes(paymentMethod)) throw new StorefrontOrderError('Choose a supported payment method.')
  const address = String(input.fulfillmentAddress || '').trim()
  if (fulfillmentType === 'DELIVERY' && (!address || address.length > 1000)) throw new StorefrontOrderError('Enter a delivery address of at most 1000 characters.')
  if (fulfillmentType === 'PICKUP' && address) throw new StorefrontOrderError('A delivery address is only accepted for delivery.')
  const idempotencyKey = input.idempotencyKey
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    throw new StorefrontOrderError('Idempotency-Key must be 8 to 128 characters using letters, numbers, period, underscore, colon, or hyphen.')
  }
  const fingerprint = idempotencyKey ? orderFingerprint({
    slug,
    itemMap,
    customerIdentifier,
    customerName: String(input.customerName || '').trim().slice(0, 160),
    fulfillmentType,
    address,
    merchantId: input.merchantId || null,
    paymentMethod,
    collectionMethod: input.collectionMethod
  }) : null

  const prepared = await withTransaction(async (tx) => {
    const { rows: storeRows } = await tx.query(
      `SELECT s.tenant_id, s.marketplace_opt_in, t.status AS tenant_status
         FROM storefronts s JOIN tenants t ON t.id = s.tenant_id
        WHERE s.slug = $1`, [slug]
    )
    const store = storeRows[0]
    if (!store || store.tenant_status !== 'ACTIVE') throw new StorefrontOrderError('This storefront is unavailable.', 404)
    if (input.marketplaceOrder && !store.marketplace_opt_in) throw new StorefrontOrderError('This vendor is not listed in the marketplace.', 404)

    if (idempotencyKey) {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`store-order:${store.tenant_id}:${idempotencyKey}`])
      const { rows: existingRows } = await tx.query(
        `SELECT id, tenant_id, merchant_id, status, payment_expires_at, collection_transaction_id,
          credit_plan_id, idempotency_fingerprint
           FROM orders WHERE tenant_id = $1 AND idempotency_key = $2 FOR UPDATE`,
        [store.tenant_id, idempotencyKey]
      )
      const existingOrder = existingRows[0]
      if (existingOrder) {
        if (existingOrder.idempotency_fingerprint !== fingerprint) {
          throw new StorefrontOrderError('This idempotency key was already used for a different order.', 409)
        }
        const { rows: totalRows } = await tx.query(
          'SELECT COALESCE(SUM(subtotal), 0) AS total_amount FROM order_items WHERE order_id = $1',
          [existingOrder.id]
        )
        let reusedCredit = null
        if (existingOrder.credit_plan_id) {
          const { rows: creditRows } = await tx.query('SELECT down_payment FROM credit_plans WHERE id = $1', [existingOrder.credit_plan_id])
          reusedCredit = { planId: existingOrder.credit_plan_id, downPayment: Number(creditRows[0]?.down_payment) || 0 }
        }
        return {
          order: existingOrder,
          totalAmount: Number(totalRows[0]?.total_amount || 0),
          paymentMethod: reusedCredit ? 'CREDIT' : 'EGANOW',
          customerIdentifier,
          credit: reusedCredit,
          existingOrder: true
        }
      }
    }

    let merchantId = input.merchantId || null
    if (fulfillmentType === 'DELIVERY') {
      const { rows } = await tx.query(
        `SELECT id FROM merchants
          WHERE tenant_id = $1 AND is_active AND account_setup_status = 'ACTIVE' AND is_default_fulfillment_branch
          FOR SHARE`, [store.tenant_id]
      )
      if (!rows[0]) throw new StorefrontOrderError('The vendor has not set a delivery fulfillment branch.', 409)
      merchantId = rows[0].id
    } else if (!merchantId) {
      throw new StorefrontOrderError('Choose a pickup location.')
    }
    const { rows: merchantRows } = await tx.query(
      `SELECT id FROM merchants WHERE id = $1 AND tenant_id = $2 AND is_active AND account_setup_status = 'ACTIVE' FOR SHARE`,
      [merchantId, store.tenant_id]
    )
    if (!merchantRows[0]) throw new StorefrontOrderError('The selected fulfillment location is unavailable.', 409)

    const productIds = [...itemMap.keys()]
    const { rows: productRows } = await tx.query(
      `SELECT p.id, p.name, p.price, p.listing_type
         FROM products p
        WHERE p.tenant_id = $1 AND p.visible AND p.id = ANY($2::uuid[])
        FOR SHARE`, [store.tenant_id, productIds]
    )
    if (productRows.length !== productIds.length) throw new StorefrontOrderError('One or more cart products are unavailable.', 409)
    let totalCents = 0
    const lines = productRows.map((product) => {
      const quantity = itemMap.get(product.id)
      const unitCents = cents(product.price)
      const subtotalCents = unitCents * quantity
      totalCents += subtotalCents
      return { productId: product.id, name: product.name, quantity, unitCents, subtotalCents, listingType: product.listing_type }
    })
    if (!Number.isSafeInteger(totalCents) || totalCents <= 0) throw new StorefrontOrderError('The order total is invalid.')

    for (const line of lines) {
      const { rows: stockRows } = await tx.query(
        `UPDATE product_stock
            SET quantity_available = CASE WHEN unlimited_stock THEN quantity_available ELSE quantity_available - $4 END
          WHERE tenant_id = $1 AND merchant_id = $2 AND product_id = $3
            AND (unlimited_stock OR quantity_available >= $4)
          RETURNING id`, [store.tenant_id, merchantId, line.productId, line.quantity]
      )
      if (!stockRows.length) throw new StorefrontOrderError(`${line.name} is unavailable in the selected quantity at this location.`, 409)
    }

    let defaults = null
    if (paymentMethod === 'CREDIT') {
      const { rows } = await tx.query(
        `SELECT * FROM tenant_credit_plan_defaults WHERE tenant_id = $1 AND enabled FOR SHARE`, [store.tenant_id]
      )
      defaults = rows[0]
      if (!defaults) throw new StorefrontOrderError('This vendor does not offer credit checkout.', 409)
    }
    const initialStatus = paymentMethod === 'CREDIT' && Number(defaults.down_payment_percent) === 0 ? 'PLACED' : 'PENDING_PAYMENT'
    const expiryMinutes = Math.max(5, Math.min(60, Number.parseInt(process.env.ORDER_PAYMENT_EXPIRY_MINUTES || '15', 10) || 15))
    const { rows: orderRows } = await tx.query(
      `INSERT INTO orders
         (tenant_id, merchant_id, customer_identifier, customer_name, fulfillment_type,
          fulfillment_address, status, payment_expires_at, idempotency_key, idempotency_fingerprint)
             VALUES ($1, $2, $3, NULLIF($4, ''), $5, NULLIF($6, ''), $7,
               now() + make_interval(mins => $8), $9, $10)
       RETURNING id, tenant_id, merchant_id, status, payment_expires_at`,
            [store.tenant_id, merchantId, customerIdentifier, String(input.customerName || '').trim().slice(0, 160), fulfillmentType, address, initialStatus, expiryMinutes, idempotencyKey, fingerprint]
    )
    const order = orderRows[0]
    for (const line of lines) {
      await tx.query(
        `INSERT INTO order_items
           (tenant_id, order_id, product_id, quantity, unit_price_at_purchase, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [store.tenant_id, order.id, line.productId, line.quantity, line.unitCents / 100, line.subtotalCents / 100]
      )
    }
    let credit = null
    if (paymentMethod === 'CREDIT') {
      credit = await createCreditPlan(tx, { tenantId: store.tenant_id, merchantId, orderId: order.id, customer: customerIdentifier, customerName: String(input.customerName || '').trim().slice(0, 160), totalCents, defaults })
      await tx.query(`UPDATE orders SET credit_plan_id = $2 WHERE id = $1`, [order.id, credit.planId])
    }
    return { order, totalAmount: totalCents / 100, paymentMethod, customerIdentifier, credit }
  })

  if (prepared.paymentMethod === 'CREDIT' && prepared.credit.downPayment === 0) {
    return { ...prepared, collection: null }
  }

  const collectionAmount = prepared.paymentMethod === 'CREDIT' ? prepared.credit.downPayment : prepared.totalAmount
  return { ...prepared, collectionAmount }
}

export async function cancelAndRestockOrder(tx, orderId, { onlyPending = false, reason = null } = {}) {
  const statuses = onlyPending ? ['PENDING_PAYMENT'] : ['PENDING_PAYMENT', 'PLACED']
  const { rows: paymentRows } = await tx.query(
    `SELECT id, status FROM transactions
      WHERE order_id = $1 AND type = 'COLLECTION'
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [orderId]
  )
  const { rows } = await tx.query(
    `SELECT id, tenant_id, merchant_id, credit_plan_id, status
       FROM orders
      WHERE id = $1 FOR UPDATE`, [orderId]
  )
  const order = rows[0]
  if (!order || !assertStorefrontOrderCancellationAllowed(order.status)) return false
  if (!statuses.includes(order.status)) return false
  const { rows: reconciliationRows } = await tx.query(
    `SELECT 1 FROM order_payment_reconciliation_flags
      WHERE order_id = $1 AND resolved_at IS NULL LIMIT 1`,
    [order.id]
  )
  let creditPlan = null
  if (order.credit_plan_id) {
    const { rows: planRows } = await tx.query(
      `SELECT p.id, p.status,
              EXISTS (SELECT 1 FROM credit_plan_installments i WHERE i.credit_plan_id = p.id AND i.status = 'PAID') AS has_paid_installments
         FROM credit_plans p WHERE p.id = $1 FOR UPDATE OF p`, [order.credit_plan_id]
    )
    creditPlan = planRows[0]
  }
  if (!isOrderCancellationSafe({
    paymentStatus: paymentRows[0]?.status,
    unresolvedReconciliation: reconciliationRows.length > 0,
    creditPlanStatus: creditPlan?.status || null,
    hasPaidInstallments: Boolean(creditPlan?.has_paid_installments)
  })) {
    throw new StorefrontOrderError('Payment, reconciliation, or credit-plan history requires review before cancellation or stock release.', 409)
  }
  const updated = await tx.query(
    `UPDATE orders SET status = 'CANCELLED', updated_at = now()
      WHERE id = $1 AND status = $2
      RETURNING id, tenant_id, merchant_id, credit_plan_id`, [orderId, order.status]
  )
  if (!updated.rows.length) return false
  const { rows: items } = await tx.query(
    `SELECT product_id, quantity FROM order_items WHERE order_id = $1`, [orderId]
  )
  for (const item of items) {
    const { rowCount } = await tx.query(
      `UPDATE product_stock SET quantity_available = quantity_available + $4
        WHERE tenant_id = $1 AND merchant_id = $2 AND product_id = $3 AND NOT unlimited_stock`,
      [order.tenant_id, order.merchant_id, item.product_id, item.quantity]
    )
    // No row means stock was unlimited or the stock row was incorrectly removed.
    const { rows: stock } = await tx.query(
      `SELECT unlimited_stock FROM product_stock WHERE tenant_id = $1 AND merchant_id = $2 AND product_id = $3`,
      [order.tenant_id, order.merchant_id, item.product_id]
    )
    if (!rowCount && stock[0] && !stock[0].unlimited_stock) throw new Error('Order inventory could not be released; cancellation was rolled back.')
    if (!stock[0]) throw new Error('Order inventory record is missing; cancellation was rolled back.')
  }
  if (creditPlan) {
    await updateCreditPlanStatus(tx, {
      id: creditPlan.id,
      currentStatus: creditPlan.status,
      nextStatus: 'CANCELLED'
    })
  }
  if (reason) await tx.query(`UPDATE orders SET cancellation_reason = $2 WHERE id = $1`, [order.id, reason])
  return true
}

export async function cancelAndRestock(orderId, options) {
  return withTransaction((tx) => cancelAndRestockOrder(tx, orderId, options))
}

export async function markStorefrontOrderPaid(tx, transactionId) {
  const { rows } = await tx.query(
    `SELECT id, order_id, tenant_id, status, eganow_reference
       FROM transactions WHERE id = $1 AND type = 'COLLECTION' AND order_id IS NOT NULL FOR UPDATE`, [transactionId]
  )
  const collection = rows[0]
  if (!collection) return { tagged: false }
  const placed = await tx.query(
    `UPDATE orders SET status = 'PLACED', collection_transaction_id = $2, updated_at = now()
      WHERE id = $1 AND tenant_id = $3 AND status = 'PENDING_PAYMENT'
      RETURNING id`, [collection.order_id, collection.id, collection.tenant_id]
  )
  if (placed.rows.length) return { tagged: true, placed: true }
  const { rows: orderRows } = await tx.query(`SELECT status, collection_transaction_id FROM orders WHERE id = $1 FOR UPDATE`, [collection.order_id])
  const order = orderRows[0]
  if (order?.status === 'PLACED' && order.collection_transaction_id === collection.id) return { tagged: true, placed: true, duplicate: true }
  if (order?.status === 'CANCELLED') {
    await tx.query(
      `INSERT INTO order_payment_reconciliation_flags (order_id, transaction_id, reason)
       VALUES ($1, $2, 'Eganow confirmed payment after stock reservation expired or order was cancelled.')
       ON CONFLICT (transaction_id) DO NOTHING`, [collection.order_id, collection.id]
    )
    return { tagged: true, reconciliationRequired: true }
  }
  return { tagged: true, placed: false }
}

export async function listExpiredOrderCandidateIds(limit = 50) {
  const { rows } = await query(
    `SELECT id FROM orders WHERE status = 'PENDING_PAYMENT' AND payment_expires_at < now()
      ORDER BY payment_expires_at LIMIT $1`, [limit]
  )
  return rows.map((row) => row.id)
}

export { normalizeMsisdn }
