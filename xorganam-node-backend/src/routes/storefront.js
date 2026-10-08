import { Router } from 'express'
import { query, withTransaction } from '../db/pool.js'
import { authenticate, requireAnyRole, resolveTenantScope, ForbiddenError } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { customerAuth } from './creditCustomers.js'
import { initiateCollection, CollectionRejectedError } from '../services/collectionService.js'
import { cancelAndRestock, cancelAndRestockOrder, createStorefrontOrder, StorefrontOrderError } from '../services/storefrontOrderService.js'
import { sanitizeBrandingConfig, validateStorefrontImageUrl } from '../services/storefrontSanitizer.js'

export const publicStorefrontRouter = Router()
export const storefrontRouter = Router()
export const storefrontCustomerRouter = Router()
export const storefrontAdminRouter = Router()

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const FREQUENCIES = new Set(['DAILY', 'WEEKLY', 'MONTHLY'])

function scopedTenant(req, res) {
  try { return resolveTenantScope(req, req.query.tenantId || req.body?.tenantId) } catch (error) {
    if (error instanceof ForbiddenError) { res.status(403).json({ message: error.message }); return null }
    throw error
  }
}

function normalizeSlug(value) {
  const slug = String(value || '').trim().toLowerCase()
  if (slug.length < 3 || slug.length > 60 || !SLUG.test(slug)) throw new StorefrontOrderError('Storefront slug must be 3–60 lowercase letters, numbers, or single hyphens between words.')
  return slug
}

function numberCents(value, name) {
  const text = String(value ?? '')
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new StorefrontOrderError(`${name} must be a positive amount with up to two decimal places.`)
  const [whole, fraction = ''] = text.split('.')
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new StorefrontOrderError(`${name} must be a positive amount.`)
  return cents
}

function validateProductInput(input, partial = false) {
  const product = {}
  if (!partial || input.name !== undefined) {
    product.name = String(input.name || '').trim()
    if (!product.name || product.name.length > 160) throw new StorefrontOrderError('Product name is required and must be at most 160 characters.')
  }
  if (!partial || input.description !== undefined) {
    product.description = String(input.description || '').trim()
    if (product.description.length > 10000) throw new StorefrontOrderError('Product description must be at most 10000 characters.')
  }
  if (!partial || input.listingType !== undefined) {
    product.listingType = String(input.listingType || '').toUpperCase()
    if (!['PHYSICAL', 'SERVICE'].includes(product.listingType)) throw new StorefrontOrderError('listingType must be PHYSICAL or SERVICE.')
  }
  if (!partial || input.price !== undefined) product.priceCents = numberCents(input.price, 'price')
  if (input.categoryId !== undefined) {
    product.categoryId = input.categoryId || null
    if (product.categoryId && !UUID.test(product.categoryId)) throw new StorefrontOrderError('categoryId is invalid.')
  }
  if (input.storefrontCategoryId !== undefined) {
    product.storefrontCategoryId = input.storefrontCategoryId || null
    if (product.storefrontCategoryId && !UUID.test(product.storefrontCategoryId)) throw new StorefrontOrderError('storefrontCategoryId is invalid.')
  }
  if (input.specifications !== undefined) {
    const specifications = input.specifications
    if (!specifications || typeof specifications !== 'object' || Array.isArray(specifications)) {
      throw new StorefrontOrderError('specifications must be a key/value object.')
    }
    const entries = Object.entries(specifications)
    if (entries.length > 30) throw new StorefrontOrderError('A product may have at most 30 specifications.')
    product.specifications = Object.fromEntries(entries.map(([rawKey, rawValue]) => {
      const key = String(rawKey).trim()
      if (!key || key.length > 80 || !['string', 'number', 'boolean'].includes(typeof rawValue)) {
        throw new StorefrontOrderError('Each specification needs a label up to 80 characters and a text, number, or boolean value.')
      }
      const value = String(rawValue).trim()
      if (!value || value.length > 500) throw new StorefrontOrderError('Specification values must be 1–500 characters.')
      return [key, value]
    }))
  }
  if (input.media !== undefined) {
    if (!Array.isArray(input.media) || input.media.length > 10) throw new StorefrontOrderError('media must contain at most 10 HTTPS image URLs.')
    product.media = input.media.map((item, position) => ({
      url: validateStorefrontImageUrl(item?.url, `media[${position}].url`),
      altText: String(item?.altText || '').trim().slice(0, 300),
      position
    }))
  }
  if (input.featured !== undefined) product.featured = Boolean(input.featured)
  if (input.sortPriority !== undefined) {
    const priority = Number(input.sortPriority)
    if (!Number.isInteger(priority) || priority < -100000 || priority > 100000) throw new StorefrontOrderError('sortPriority must be an integer from -100000 to 100000.')
    product.sortPriority = priority
  }
  return product
}

async function publicProducts(tenantId, condition = '', params = []) {
  const { rows } = await query(
    `SELECT p.id, p.tenant_id, p.name, p.description, p.listing_type, p.price, p.category_id,
            p.storefront_category_id, vc.name AS storefront_category_name, p.specifications,
            p.featured, p.sort_priority, p.created_at,
            COALESCE((SELECT json_agg(json_build_object('id', r.id, 'url', r.url, 'altText', r.alt_text, 'position', r.position) ORDER BY r.position)
                        FROM product_media r WHERE r.product_id = p.id), '[]'::json) AS media,
            COALESCE((SELECT json_agg(json_build_object('merchantId', st.merchant_id, 'branchName', m.display_name,
                              'quantityAvailable', CASE WHEN st.unlimited_stock THEN NULL ELSE st.quantity_available END,
                              'unlimitedStock', st.unlimited_stock) ORDER BY m.display_name)
                        FROM product_stock st JOIN merchants m ON m.id = st.merchant_id
                         WHERE st.product_id = p.id AND m.is_active AND m.account_setup_status = 'ACTIVE'), '[]'::json) AS stock_by_branch
       FROM products p LEFT JOIN storefront_product_categories vc ON vc.id = p.storefront_category_id AND vc.tenant_id = p.tenant_id
      WHERE p.tenant_id = $1 AND p.visible ${condition}
      ORDER BY p.featured DESC, p.sort_priority DESC, p.created_at DESC`, [tenantId, ...params]
  )
  return rows
}

publicStorefrontRouter.get('/storefronts/:slug', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT s.id, s.tenant_id, s.slug, s.marketplace_opt_in, s.branding_config,
            t.company_name AS vendor_name,
            (SELECT m.id FROM merchants m WHERE m.tenant_id = s.tenant_id AND m.is_default_fulfillment_branch LIMIT 1) AS default_fulfillment_branch_id
       FROM storefronts s JOIN tenants t ON t.id = s.tenant_id
      WHERE lower(s.slug) = lower($1) AND t.status = 'ACTIVE'`, [req.params.slug]
  )
  const storefront = rows[0]
  if (!storefront) return res.status(404).json({ message: 'Storefront not found.' })
  const [products, branches, reviews, creditDefaults, categories] = await Promise.all([
    publicProducts(storefront.tenant_id),
    query(`SELECT id, display_name FROM merchants
            WHERE tenant_id = $1 AND is_active AND account_setup_status = 'ACTIVE'
            ORDER BY display_name`, [storefront.tenant_id]),
    query(`SELECT id, rating, comment, created_at FROM reviews
            WHERE tenant_id = $1 AND target_type = 'VENDOR' AND status = 'VISIBLE'
            ORDER BY created_at DESC LIMIT 20`, [storefront.tenant_id]),
    query(`SELECT enabled, down_payment_percent, installment_count, installment_frequency, first_due_days
             FROM tenant_credit_plan_defaults WHERE tenant_id = $1`, [storefront.tenant_id]),
    query(`SELECT id, name FROM storefront_product_categories WHERE tenant_id = $1 ORDER BY lower(name)`, [storefront.tenant_id])
  ])
  res.json({ storefront, products, branches: branches.rows, reviews: reviews.rows, creditDefaults: creditDefaults.rows[0] || null, categories: categories.rows })
}))

publicStorefrontRouter.get('/marketplace/products/:productId/reviews', asyncHandler(async (req, res) => {
  if (!UUID.test(req.params.productId)) return res.status(400).json({ message: 'Invalid product ID.' })
  const { rows } = await query(
    `SELECT r.id, r.rating, r.comment, r.created_at FROM reviews r
       JOIN marketplace_listings p ON p.id = r.product_id
      WHERE r.product_id = $1 AND r.target_type = 'PRODUCT' AND r.status = 'VISIBLE'
      ORDER BY r.created_at DESC LIMIT 100`, [req.params.productId]
  )
  res.json(rows)
}))

publicStorefrontRouter.get('/marketplace/categories', asyncHandler(async (_req, res) => {
  const { rows } = await query(
    `SELECT c.id, c.name, c.slug, c.parent_category_id,
            (SELECT count(*)::int FROM marketplace_listings p WHERE p.category_id = c.id) AS listing_count
       FROM marketplace_categories c ORDER BY c.name`
  )
  res.json(rows)
}))

publicStorefrontRouter.get('/marketplace/categories/:categoryId/products', asyncHandler(async (req, res) => {
  if (!UUID.test(req.params.categoryId)) return res.status(400).json({ message: 'Invalid category ID.' })
  const limit = Math.min(60, Math.max(1, Number.parseInt(req.query.limit || '24', 10) || 24))
  const offset = Math.max(0, Number.parseInt(req.query.offset || '0', 10) || 0)
  const { rows } = await query(
    `SELECT p.id, p.tenant_id, p.name, p.description, p.listing_type, p.price, p.category_id,
            p.featured, p.sort_priority, p.vendor_slug, t.company_name AS vendor_name,
            COALESCE((SELECT json_agg(json_build_object('id', m.id, 'url', m.url, 'altText', m.alt_text) ORDER BY m.position)
                        FROM product_media m WHERE m.product_id = p.id), '[]'::json) AS media
       FROM marketplace_listings p JOIN tenants t ON t.id = p.tenant_id
      WHERE p.category_id = $1 AND t.status = 'ACTIVE'
      ORDER BY p.featured DESC, p.sort_priority DESC, p.created_at DESC LIMIT $2 OFFSET $3`,
    [req.params.categoryId, limit, offset]
  )
  res.json(rows)
}))

publicStorefrontRouter.get('/marketplace/products', asyncHandler(async (req, res) => {
  const term = String(req.query.q || '').trim()
  if (term.length > 120) return res.status(400).json({ message: 'Search text must be at most 120 characters.' })
  const limit = Math.min(60, Math.max(1, Number.parseInt(req.query.limit || '24', 10) || 24))
  const offset = Math.max(0, Number.parseInt(req.query.offset || '0', 10) || 0)
  const filters = ['t.status = \'ACTIVE\'']
  const params = []
  if (term) { params.push(term); filters.push(`p.search_vector @@ websearch_to_tsquery('english', $${params.length})`) }
  if (req.query.categoryId) {
    if (!UUID.test(String(req.query.categoryId))) return res.status(400).json({ message: 'Invalid category ID.' })
    params.push(req.query.categoryId); filters.push(`p.category_id = $${params.length}`)
  }
  params.push(limit); const limitParameter = params.length
  params.push(offset); const offsetParameter = params.length
  const { rows } = await query(
    `SELECT p.id, p.tenant_id, p.name, p.description, p.listing_type, p.price, p.category_id,
            p.featured, p.sort_priority, p.vendor_slug, t.company_name AS vendor_name,
            COALESCE((SELECT json_agg(json_build_object('id', m.id, 'url', m.url, 'altText', m.alt_text) ORDER BY m.position)
                        FROM product_media m WHERE m.product_id = p.id), '[]'::json) AS media
       FROM marketplace_listings p JOIN tenants t ON t.id = p.tenant_id
      WHERE ${filters.join(' AND ')}
      ORDER BY p.featured DESC, p.sort_priority DESC, p.created_at DESC LIMIT $${limitParameter} OFFSET $${offsetParameter}`,
    params
  )
  res.json(rows)
}))

publicStorefrontRouter.post('/storefronts/:slug/orders', asyncHandler(async (req, res) => {
  await startOrderCheckout(req, res, false)
}))

publicStorefrontRouter.post('/marketplace/storefronts/:slug/orders', asyncHandler(async (req, res) => {
  await startOrderCheckout(req, res, true)
}))

async function startOrderCheckout(req, res, marketplaceOrder) {
  let prepared
  try {
    prepared = await createStorefrontOrder(req.params.slug, {
      ...req.body,
      marketplaceOrder,
      idempotencyKey: req.get('Idempotency-Key') || null
    })
  } catch (error) {
    if (error instanceof StorefrontOrderError) return res.status(error.status).json({ message: error.message })
    throw error
  }
  if (!prepared.collectionAmount) {
    const { rows } = await query('SELECT status FROM orders WHERE id = $1', [prepared.order.id])
    return res.status(201).json({ orderId: prepared.order.id, status: rows[0]?.status || 'PLACED', totalAmount: prepared.totalAmount, paymentMethod: 'CREDIT' })
  }
  try {
    const result = await initiateCollection(prepared.order.merchant_id || prepared.order.merchantId, {
      amount: prepared.collectionAmount,
      msisdn: prepared.customerIdentifier,
      collectionMethod: req.body?.collectionMethod,
      cardNumber: req.body?.cardNumber,
      cardholderName: req.body?.cardholderName,
      expiryDateMonth: req.body?.expiryDateMonth,
      expiryDateYear: req.body?.expiryDateYear,
      cvv: req.body?.cvv,
      narration: `Storefront order ${prepared.order.id}`,
      idempotencyKey: req.get('Idempotency-Key') || null,
      orderId: prepared.order.id,
      creditPlanId: prepared.paymentMethod === 'CREDIT' ? prepared.credit.planId : null
    })
    if (result.status === 'FAILED') {
      if (!prepared.existingOrder) {
        await cancelAndRestock(prepared.order.id, { onlyPending: true, reason: 'Eganow did not start the order payment.' })
      }
      return res.status(402).json({ message: result.failureReason || 'Eganow could not start this payment.', orderId: prepared.order.id, status: 'CANCELLED' })
    }
    await query(`UPDATE orders SET collection_transaction_id = $2 WHERE id = $1 AND status = 'PENDING_PAYMENT'`, [prepared.order.id, result.transactionId])
    const { rows: currentOrderRows } = await query('SELECT status FROM orders WHERE id = $1', [prepared.order.id])
    res.status(prepared.existingOrder ? 200 : 201).json({ orderId: prepared.order.id, status: currentOrderRows[0]?.status || prepared.order.status, totalAmount: prepared.totalAmount,
      paymentAmount: prepared.collectionAmount, paymentMethod: prepared.paymentMethod, reference: result.internalReference,
      redirectHtml: result.redirectHtml || null,
      message: result.message || (String(req.body?.collectionMethod || 'MOMO').toUpperCase() === 'CARD' ? 'Complete card verification to finish payment.' : prepared.paymentMethod === 'CREDIT' ? 'Approve the down-payment prompt on your phone.' : 'Approve the payment prompt on your phone.') })
  } catch (error) {
    if (error instanceof CollectionRejectedError) {
      if (!prepared.existingOrder) await cancelAndRestock(prepared.order.id, { onlyPending: true, reason: error.message })
      return res.status(error.status).json({ message: error.message })
    }
    throw error
  }
}

storefrontRouter.use(authenticate)

storefrontRouter.get('/categories', requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_BRANCH_MANAGER'), asyncHandler(async (req, res) => {
  const tenantId = scopedTenant(req, res)
  if (!tenantId) return
  const { rows } = await query(
    `SELECT c.id, c.name, c.created_at, count(p.id)::int AS product_count
       FROM storefront_product_categories c
       LEFT JOIN products p ON p.tenant_id = c.tenant_id AND p.storefront_category_id = c.id
      WHERE c.tenant_id = $1 GROUP BY c.id ORDER BY lower(c.name)`, [tenantId]
  )
  res.json(rows)
}))

storefrontRouter.post('/categories', requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER'), asyncHandler(async (req, res) => {
  const tenantId = scopedTenant(req, res)
  if (!tenantId) return
  const name = String(req.body?.name || '').trim()
  if (!name || name.length > 80) return res.status(400).json({ message: 'Category name is required and must be at most 80 characters.' })
  try {
    const { rows } = await query(
      `INSERT INTO storefront_product_categories (tenant_id, name) VALUES ($1, $2) RETURNING id, name, created_at`, [tenantId, name]
    )
    res.status(201).json(rows[0])
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ message: 'A category with that name already exists in this storefront.' })
    throw error
  }
}))

storefrontRouter.patch('/categories/:categoryId', requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER'), asyncHandler(async (req, res) => {
  const tenantId = scopedTenant(req, res)
  if (!tenantId) return
  if (!UUID.test(req.params.categoryId)) return res.status(400).json({ message: 'Invalid category ID.' })
  const name = String(req.body?.name || '').trim()
  if (!name || name.length > 80) return res.status(400).json({ message: 'Category name is required and must be at most 80 characters.' })
  try {
    const { rows } = await query(
      `UPDATE storefront_product_categories SET name = $3 WHERE id = $1 AND tenant_id = $2 RETURNING id, name`,
      [req.params.categoryId, tenantId, name]
    )
    if (!rows.length) return res.status(404).json({ message: 'Storefront category not found.' })
    res.json(rows[0])
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ message: 'A category with that name already exists in this storefront.' })
    throw error
  }
}))

storefrontRouter.delete('/categories/:categoryId', requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER'), asyncHandler(async (req, res) => {
  const tenantId = scopedTenant(req, res)
  if (!tenantId) return
  if (!UUID.test(req.params.categoryId)) return res.status(400).json({ message: 'Invalid category ID.' })
  const { rowCount } = await query(`DELETE FROM storefront_product_categories WHERE id = $1 AND tenant_id = $2`, [req.params.categoryId, tenantId])
  if (!rowCount) return res.status(404).json({ message: 'Storefront category not found.' })
  res.status(204).end()
}))

storefrontRouter.get('/', asyncHandler(async (req, res) => {
  const tenantId = scopedTenant(req, res)
  if (!tenantId) return
  const { rows } = await query(
    `SELECT s.*, m.id AS default_fulfillment_branch_id, m.display_name AS default_fulfillment_branch_name
       FROM storefronts s LEFT JOIN merchants m
         ON m.tenant_id = s.tenant_id AND m.is_default_fulfillment_branch
      WHERE s.tenant_id = $1`, [tenantId]
  )
  if (!rows.length) return res.json(null)
  res.json(rows[0])
}))

storefrontRouter.put('/', requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER'), asyncHandler(async (req, res) => {
  const tenantId = scopedTenant(req, res)
  if (!tenantId) return
  let slug, branding
  try {
    slug = normalizeSlug(req.body?.slug)
    branding = sanitizeBrandingConfig(req.body?.brandingConfig || {})
  } catch (error) { return res.status(400).json({ message: error.message }) }
  const defaultBranchId = req.body?.defaultFulfillmentBranchId || null
  if (defaultBranchId && !UUID.test(defaultBranchId)) return res.status(400).json({ message: 'defaultFulfillmentBranchId is invalid.' })
  try {
    const result = await withTransaction(async (tx) => {
      if (defaultBranchId) {
        const branch = await tx.query(
          `SELECT id FROM merchants WHERE id = $1 AND tenant_id = $2 AND is_active AND account_setup_status = 'ACTIVE' FOR UPDATE`,
          [defaultBranchId, tenantId]
        )
        if (!branch.rows.length) throw new StorefrontOrderError('Default delivery branch must be active with Eganow setup complete.', 409)
      }
      const { rows } = await tx.query(
        `INSERT INTO storefronts (tenant_id, slug, marketplace_opt_in, branding_config)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (tenant_id) DO UPDATE SET slug = EXCLUDED.slug,
           marketplace_opt_in = EXCLUDED.marketplace_opt_in,
           branding_config = EXCLUDED.branding_config, updated_at = now()
         RETURNING *`,
        [tenantId, slug, Boolean(req.body?.marketplaceOptIn), JSON.stringify(branding)]
      )
      if (defaultBranchId) {
        await tx.query(`UPDATE merchants SET is_default_fulfillment_branch = FALSE WHERE tenant_id = $1 AND is_default_fulfillment_branch`, [tenantId])
        await tx.query(`UPDATE merchants SET is_default_fulfillment_branch = TRUE WHERE tenant_id = $1 AND id = $2`, [tenantId, defaultBranchId])
      } else if (req.body?.defaultFulfillmentBranchId === null) {
        await tx.query(`UPDATE merchants SET is_default_fulfillment_branch = FALSE WHERE tenant_id = $1 AND is_default_fulfillment_branch`, [tenantId])
      }
      return rows[0]
    })
    res.json(result)
  } catch (error) {
    if (error instanceof StorefrontOrderError) return res.status(error.status).json({ message: error.message })
    if (error.code === '23505') return res.status(409).json({ message: 'That storefront slug is already in use.' })
    throw error
  }
}))

storefrontRouter.get('/products', requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_BRANCH_MANAGER'), asyncHandler(async (req, res) => {
  const tenantId = scopedTenant(req, res)
  if (!tenantId) return
  const { rows } = await query(
    `SELECT p.*, c.name AS category_name, vc.name AS storefront_category_name,
            COALESCE((SELECT json_agg(json_build_object('id', m.id, 'url', m.url, 'altText', m.alt_text, 'position', m.position) ORDER BY m.position)
                        FROM product_media m WHERE m.product_id = p.id), '[]'::json) AS media,
            COALESCE((SELECT json_agg(json_build_object('merchantId', st.merchant_id, 'branchName', merchant.display_name,
                              'quantityAvailable', CASE WHEN st.unlimited_stock THEN NULL ELSE st.quantity_available END,
                              'unlimitedStock', st.unlimited_stock))
                        FROM product_stock st JOIN merchants merchant ON merchant.id = st.merchant_id
                       WHERE st.product_id = p.id), '[]'::json) AS stock_by_branch
       FROM products p LEFT JOIN marketplace_categories c ON c.id = p.category_id
       LEFT JOIN storefront_product_categories vc ON vc.id = p.storefront_category_id AND vc.tenant_id = p.tenant_id
      WHERE p.tenant_id = $1 ORDER BY p.created_at DESC`, [tenantId]
  )
  res.json(rows)
}))

storefrontRouter.post('/products', requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER'), asyncHandler(async (req, res) => {
  const tenantId = scopedTenant(req, res)
  if (!tenantId) return
  let product
  try { product = validateProductInput(req.body || {}) } catch (error) { return res.status(400).json({ message: error.message }) }
  try {
    const created = await withTransaction(async (tx) => {
      if (product.storefrontCategoryId) {
        const category = await tx.query(`SELECT id FROM storefront_product_categories WHERE id = $1 AND tenant_id = $2`, [product.storefrontCategoryId, tenantId])
        if (!category.rows.length) throw new StorefrontOrderError('Choose a category from this storefront.')
      }
      const { rows } = await tx.query(
        `INSERT INTO products (tenant_id, name, description, listing_type, price, category_id, storefront_category_id, specifications, featured, sort_priority)
         VALUES ($1, $2, NULLIF($3, ''), $4::product_listing_type, $5, $6, $7, $8::jsonb, $9, $10) RETURNING *`,
        [tenantId, product.name, product.description, product.listingType, product.priceCents / 100,
          product.categoryId || null, product.storefrontCategoryId || null, JSON.stringify(product.specifications || {}), product.featured || false, product.sortPriority || 0]
      )
      for (const media of product.media || []) await tx.query(
        `INSERT INTO product_media (product_id, url, alt_text, position) VALUES ($1, $2, $3, $4)`,
        [rows[0].id, media.url, media.altText, media.position]
      )
      return rows[0]
    })
    res.status(201).json(created)
  } catch (error) {
    if (error instanceof StorefrontOrderError) return res.status(error.status).json({ message: error.message })
    if (error.code === '23503') return res.status(400).json({ message: 'Choose an existing marketplace category.' })
    throw error
  }
}))

storefrontRouter.patch('/products/:productId', requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER'), asyncHandler(async (req, res) => {
  const tenantId = scopedTenant(req, res)
  if (!tenantId) return
  if (!UUID.test(req.params.productId)) return res.status(400).json({ message: 'Invalid product ID.' })
  let product
  try { product = validateProductInput(req.body || {}, true) } catch (error) { return res.status(400).json({ message: error.message }) }
  const fields = ['name', 'description', 'listingType', 'priceCents', 'categoryId', 'storefrontCategoryId', 'specifications', 'featured', 'sortPriority']
  const values = []
  const sets = []
  const sqlColumns = { name: 'name', description: 'description', listingType: 'listing_type', priceCents: 'price', categoryId: 'category_id', storefrontCategoryId: 'storefront_category_id', specifications: 'specifications', featured: 'featured', sortPriority: 'sort_priority' }
  for (const key of fields) {
    if (product[key] === undefined) continue
    values.push(key === 'priceCents' ? product[key] / 100 : key === 'specifications' ? JSON.stringify(product[key]) : product[key])
    sets.push(`${sqlColumns[key]} = $${values.length}${key === 'listingType' ? '::product_listing_type' : key === 'specifications' ? '::jsonb' : ''}`)
  }
  if (!sets.length && product.media === undefined) return res.status(400).json({ message: 'Provide at least one product field to update.' })
  try {
    const result = await withTransaction(async (tx) => {
      if (product.storefrontCategoryId) {
        const category = await tx.query(`SELECT id FROM storefront_product_categories WHERE id = $1 AND tenant_id = $2`, [product.storefrontCategoryId, tenantId])
        if (!category.rows.length) throw new StorefrontOrderError('Choose a category from this storefront.')
      }
      let current
      if (sets.length) {
        values.push(req.params.productId, tenantId)
        const { rows } = await tx.query(`UPDATE products SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length - 1} AND tenant_id = $${values.length} RETURNING *`, values)
        current = rows[0]
      } else {
        const { rows } = await tx.query('SELECT * FROM products WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [req.params.productId, tenantId])
        current = rows[0]
      }
      if (!current) return null
      if (product.media !== undefined) {
        await tx.query('DELETE FROM product_media WHERE product_id = $1', [current.id])
        for (const media of product.media) await tx.query(
          `INSERT INTO product_media (product_id, url, alt_text, position) VALUES ($1, $2, $3, $4)`,
          [current.id, media.url, media.altText, media.position]
        )
      }
      return current
    })
    if (!result) return res.status(404).json({ message: 'Product not found.' })
    res.json(result)
  } catch (error) {
    if (error instanceof StorefrontOrderError) return res.status(error.status).json({ message: error.message })
    if (error.code === '23503') return res.status(400).json({ message: 'Choose an existing marketplace category.' })
    throw error
  }
}))

storefrontRouter.delete('/products/:productId', requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER'), asyncHandler(async (req, res) => {
  const tenantId = scopedTenant(req, res)
  if (!tenantId) return
  const { rowCount } = await query('DELETE FROM products WHERE id = $1 AND tenant_id = $2', [req.params.productId, tenantId])
  if (!rowCount) return res.status(404).json({ message: 'Product not found.' })
  res.status(204).end()
}))

storefrontRouter.patch('/products/:productId/visibility', requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER'), asyncHandler(async (req, res) => {
  const tenantId = scopedTenant(req, res)
  if (!tenantId) return
  if (typeof req.body?.visible !== 'boolean') return res.status(400).json({ message: 'visible must be true or false.' })
  const { rows } = await query(
    `UPDATE products SET visible = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING id, visible`,
    [req.params.productId, tenantId, req.body.visible]
  )
  if (!rows.length) return res.status(404).json({ message: 'Product not found.' })
  res.json(rows[0])
}))

storefrontRouter.put('/products/:productId/stock', requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_BRANCH_MANAGER'), asyncHandler(async (req, res) => {
  const tenantId = scopedTenant(req, res)
  if (!tenantId) return
  const merchantId = req.user.role === 'TENANT_BRANCH_MANAGER' ? req.user.merchantId : req.body?.merchantId
  const quantity = Number(req.body?.quantityAvailable)
  const unlimited = Boolean(req.body?.unlimitedStock)
  if (!UUID.test(req.params.productId) || !UUID.test(String(merchantId || '')) || !Number.isInteger(quantity) || quantity < 0 || quantity > 1000000) {
    return res.status(400).json({ message: 'Valid product, branch, and non-negative integer quantity are required.' })
  }
  const product = await query(`SELECT listing_type FROM products WHERE id = $1 AND tenant_id = $2`, [req.params.productId, tenantId])
  if (!product.rows.length) return res.status(404).json({ message: 'Product not found.' })
  if (unlimited && product.rows[0].listing_type !== 'SERVICE') return res.status(400).json({ message: 'Unlimited stock can only be used with service listings.' })
  const branch = await query(`SELECT id FROM merchants WHERE id = $1 AND tenant_id = $2 AND is_active AND account_setup_status = 'ACTIVE'`, [merchantId, tenantId])
  if (!branch.rows.length) return res.status(404).json({ message: 'Active Eganow fulfillment branch not found.' })
  const { rows } = await query(
    `INSERT INTO product_stock (tenant_id, merchant_id, product_id, quantity_available, unlimited_stock)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (product_id, merchant_id) DO UPDATE SET quantity_available = EXCLUDED.quantity_available,
       unlimited_stock = EXCLUDED.unlimited_stock
     RETURNING *`, [tenantId, merchantId, req.params.productId, quantity, unlimited]
  )
  res.json(rows[0])
}))

storefrontRouter.get('/orders', requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_BRANCH_MANAGER'), asyncHandler(async (req, res) => {
  const tenantId = scopedTenant(req, res)
  if (!tenantId) return
  const branchId = req.user.role === 'TENANT_BRANCH_MANAGER' ? req.user.merchantId : req.query.merchantId || null
  const status = req.query.status || null
  const { rows } = await query(
    `SELECT o.*, m.display_name AS branch_name,
            COALESCE((SELECT json_agg(json_build_object('productId', p.id, 'name', p.name, 'quantity', oi.quantity,
                            'unitPrice', oi.unit_price_at_purchase, 'subtotal', oi.subtotal) ORDER BY p.name)
                        FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = o.id), '[]'::json) AS items,
            COALESCE((SELECT sum(oi.subtotal) FROM order_items oi WHERE oi.order_id = o.id), 0) AS total_amount
       FROM orders o JOIN merchants m ON m.id = o.merchant_id AND m.tenant_id = o.tenant_id
      WHERE o.tenant_id = $1 AND ($2::uuid IS NULL OR o.merchant_id = $2) AND ($3::order_status IS NULL OR o.status = $3)
      ORDER BY o.created_at DESC LIMIT 500`, [tenantId, branchId, status]
  )
  res.json(rows)
}))

storefrontRouter.patch('/orders/:orderId/status', requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_BRANCH_MANAGER'), asyncHandler(async (req, res) => {
  const tenantId = scopedTenant(req, res)
  if (!tenantId) return
  const nextStatus = String(req.body?.status || '').toUpperCase()
  if (!['FULFILLED', 'CANCELLED'].includes(nextStatus)) return res.status(400).json({ message: 'Orders may be marked FULFILLED or CANCELLED.' })
  const branchId = req.user.role === 'TENANT_BRANCH_MANAGER' ? req.user.merchantId : null
  if (nextStatus === 'CANCELLED') {
    let result
    try {
      result = await withTransaction(async (tx) => {
        const { rows } = await tx.query(
          `SELECT id FROM orders WHERE id = $1 AND tenant_id = $2 AND ($3::uuid IS NULL OR merchant_id = $3)`,
          [req.params.orderId, tenantId, branchId]
        )
        if (!rows.length) return 'NOT_FOUND'
        const cancelled = await cancelAndRestockOrder(tx, req.params.orderId, { reason: String(req.body?.reason || 'Cancelled by vendor.').slice(0, 500) })
        return cancelled ? 'CANCELLED' : 'CONFLICT'
      })
    } catch (error) {
      if (error instanceof StorefrontOrderError) return res.status(error.status).json({ message: error.message })
      throw error
    }
    if (result === 'NOT_FOUND') return res.status(404).json({ message: 'Order not found.' })
    if (result === 'CONFLICT') return res.status(409).json({ message: 'Only pending-payment or placed orders can be cancelled.' })
    return res.json({ id: req.params.orderId, status: 'CANCELLED' })
  }
  const { rows } = await query(
    `UPDATE orders SET status = 'FULFILLED', updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND ($3::uuid IS NULL OR merchant_id = $3) AND status = 'PLACED'
      RETURNING id, status`, [req.params.orderId, tenantId, branchId]
  )
  if (!rows.length) return res.status(409).json({ message: 'Order not found or not currently placed.' })
  res.json(rows[0])
}))

storefrontRouter.get('/credit-defaults', requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER'), asyncHandler(async (req, res) => {
  const tenantId = scopedTenant(req, res)
  if (!tenantId) return
  const { rows } = await query('SELECT * FROM tenant_credit_plan_defaults WHERE tenant_id = $1', [tenantId])
  res.json(rows[0] || { tenant_id: tenantId, enabled: false, down_payment_percent: '0.00', installment_count: 4,
    installment_frequency: 'MONTHLY', markup_amount: '0.00', late_fee_amount: '0.00', late_fee_grace_days: 0,
    missed_installment_threshold: 3, first_due_days: 30 })
}))

storefrontRouter.put('/credit-defaults', requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER'), asyncHandler(async (req, res) => {
  const tenantId = scopedTenant(req, res)
  if (!tenantId) return
  const input = req.body || {}
  const percent = Number(input.downPaymentPercent)
  const count = Number(input.installmentCount)
  const grace = Number(input.lateFeeGraceDays)
  const threshold = Number(input.missedInstallmentThreshold)
  const firstDays = Number(input.firstDueDays)
  const frequency = String(input.installmentFrequency || '').toUpperCase()
  let markup, lateFee
  try {
    markup = input.markupAmount === 0 || input.markupAmount === '0' ? 0 : numberCents(input.markupAmount, 'markupAmount') / 100
    lateFee = input.lateFeeAmount === 0 || input.lateFeeAmount === '0' ? 0 : numberCents(input.lateFeeAmount, 'lateFeeAmount') / 100
  } catch (error) { return res.status(400).json({ message: error.message }) }
  if (!Number.isFinite(percent) || percent < 0 || percent >= 100 || !Number.isInteger(count) || count < 1 || count > 120 ||
      !FREQUENCIES.has(frequency) || !Number.isInteger(grace) || grace < 0 || grace > 365 ||
      !Number.isInteger(threshold) || threshold < 1 || threshold > 120 || !Number.isInteger(firstDays) || firstDays < 1 || firstDays > 365) {
    return res.status(400).json({ message: 'Credit defaults have invalid down payment, schedule, fee, threshold, or first due offset values.' })
  }
  const { rows } = await query(
    `INSERT INTO tenant_credit_plan_defaults
       (tenant_id, enabled, down_payment_percent, installment_count, installment_frequency,
        markup_amount, late_fee_amount, late_fee_grace_days, missed_installment_threshold, first_due_days)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (tenant_id) DO UPDATE SET enabled = EXCLUDED.enabled,
       down_payment_percent = EXCLUDED.down_payment_percent, installment_count = EXCLUDED.installment_count,
       installment_frequency = EXCLUDED.installment_frequency, markup_amount = EXCLUDED.markup_amount,
       late_fee_amount = EXCLUDED.late_fee_amount, late_fee_grace_days = EXCLUDED.late_fee_grace_days,
       missed_installment_threshold = EXCLUDED.missed_installment_threshold,
       first_due_days = EXCLUDED.first_due_days, updated_at = now() RETURNING *`,
    [tenantId, Boolean(input.enabled), percent, count, frequency, markup, lateFee, grace, threshold, firstDays]
  )
  res.json(rows[0])
}))

storefrontCustomerRouter.use(customerAuth)
storefrontCustomerRouter.get('/orders', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT o.id, o.tenant_id, o.merchant_id, o.fulfillment_type, o.fulfillment_address, o.status,
            o.created_at, t.company_name AS vendor_name, m.display_name AS branch_name,
            COALESCE((SELECT sum(oi.subtotal) FROM order_items oi WHERE oi.order_id = o.id), 0) AS total_amount,
            COALESCE((SELECT json_agg(json_build_object('productId', p.id, 'name', p.name, 'quantity', oi.quantity, 'subtotal', oi.subtotal))
                        FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = o.id), '[]'::json) AS items
       FROM orders o JOIN tenants t ON t.id = o.tenant_id JOIN merchants m ON m.id = o.merchant_id
      WHERE o.customer_identifier = $1 ORDER BY o.created_at DESC LIMIT 100`, [req.creditCustomer.phone]
  )
  res.json(rows)
}))
storefrontCustomerRouter.post('/reviews', asyncHandler(async (req, res) => {
  const { targetType, productId, tenantId, orderId, rating, comment } = req.body || {}
  const type = String(targetType || '').toUpperCase()
  const numericRating = Number(rating)
  if (!['PRODUCT', 'VENDOR'].includes(type) || !UUID.test(String(orderId || '')) || !Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
    return res.status(400).json({ message: 'A valid target, placed order, and 1–5 star rating are required.' })
  }
  if (type === 'PRODUCT' && !UUID.test(String(productId || ''))) return res.status(400).json({ message: 'A valid productId is required for product reviews.' })
  if (type === 'VENDOR' && !UUID.test(String(tenantId || ''))) return res.status(400).json({ message: 'A valid tenantId is required for vendor reviews.' })
  const text = String(comment || '').trim()
  if (text.length > 2000) return res.status(400).json({ message: 'Review comments must be at most 2000 characters.' })
  const order = await query(
    `SELECT tenant_id, status FROM orders WHERE id = $1 AND customer_identifier = $2 AND status IN ('PLACED', 'FULFILLED')`,
    [orderId, req.creditCustomer.phone]
  )
  if (!order.rows.length) return res.status(404).json({ message: 'A placed or fulfilled purchase for this verified number was not found.' })
  const purchasedTenant = order.rows[0].tenant_id
  if (type === 'VENDOR' && tenantId !== purchasedTenant) return res.status(400).json({ message: 'The order is for a different vendor.' })
  if (type === 'PRODUCT') {
    const item = await query(
      `SELECT 1 FROM order_items WHERE order_id = $1 AND product_id = $2 AND tenant_id = $3`,
      [orderId, productId, purchasedTenant]
    )
    if (!item.rows.length) return res.status(400).json({ message: 'The order does not contain this product.' })
  }
  try {
    const { rows } = await query(
      `INSERT INTO reviews (target_type, product_id, tenant_id, order_id, customer_identifier, rating, comment)
       VALUES ($1::review_target_type, $2, $3, $4, $5, $6, NULLIF($7, '')) RETURNING id, target_type, rating, comment, status, created_at`,
      [type, type === 'PRODUCT' ? productId : null, purchasedTenant, orderId, req.creditCustomer.phone, numericRating, text]
    )
    res.status(201).json(rows[0])
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ message: 'A review for this purchase and target already exists.' })
    throw error
  }
}))

storefrontAdminRouter.use(authenticate)
storefrontAdminRouter.get('/categories', requireAnyRole('PLATFORM_ADMIN'), asyncHandler(async (_req, res) => {
  const { rows } = await query('SELECT * FROM marketplace_categories ORDER BY name')
  res.json(rows)
}))
storefrontAdminRouter.post('/categories', requireAnyRole('PLATFORM_ADMIN'), asyncHandler(async (req, res) => {
  const name = String(req.body?.name || '').trim()
  const slug = String(req.body?.slug || '').trim().toLowerCase()
  const parentId = req.body?.parentCategoryId || null
  if (!name || name.length > 80 || !SLUG.test(slug) || (parentId && !UUID.test(parentId))) return res.status(400).json({ message: 'A valid category name, slug, and optional parent are required.' })
  try {
    const { rows } = await query('INSERT INTO marketplace_categories (name, slug, parent_category_id) VALUES ($1, $2, $3) RETURNING *', [name, slug, parentId])
    res.status(201).json(rows[0])
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ message: 'Category name or slug already exists.' })
    if (error.code === '23503') return res.status(400).json({ message: 'Parent category not found.' })
    throw error
  }
}))
storefrontAdminRouter.patch('/categories/:categoryId', requireAnyRole('PLATFORM_ADMIN'), asyncHandler(async (req, res) => {
  const name = req.body?.name === undefined ? undefined : String(req.body.name).trim()
  const slug = req.body?.slug === undefined ? undefined : String(req.body.slug).trim().toLowerCase()
  if ((name !== undefined && (!name || name.length > 80)) || (slug !== undefined && !SLUG.test(slug))) return res.status(400).json({ message: 'Category name or slug is invalid.' })
  const { rows } = await query(
    `UPDATE marketplace_categories SET name = COALESCE($2, name), slug = COALESCE($3, slug) WHERE id = $1 RETURNING *`,
    [req.params.categoryId, name ?? null, slug ?? null]
  )
  if (!rows.length) return res.status(404).json({ message: 'Category not found.' })
  res.json(rows[0])
}))

storefrontAdminRouter.delete('/categories/:categoryId', requireAnyRole('PLATFORM_ADMIN'), asyncHandler(async (req, res) => {
  if (!UUID.test(req.params.categoryId)) return res.status(400).json({ message: 'Invalid category ID.' })
  try {
    const { rowCount } = await query('DELETE FROM marketplace_categories WHERE id = $1', [req.params.categoryId])
    if (!rowCount) return res.status(404).json({ message: 'Category not found.' })
    res.status(204).end()
  } catch (error) {
    if (error.code === '23503') return res.status(409).json({ message: 'This category is still used by products or child categories.' })
    throw error
  }
}))

storefrontAdminRouter.get('/reviews/moderation', requireAnyRole('PLATFORM_ADMIN'), asyncHandler(async (req, res) => {
  const status = req.query.status || 'PENDING_MODERATION'
  if (!['PENDING_MODERATION', 'VISIBLE', 'HIDDEN'].includes(status)) return res.status(400).json({ message: 'Invalid review status.' })
  const { rows } = await query(
    `SELECT r.*, t.company_name AS vendor_name, p.name AS product_name
       FROM reviews r JOIN tenants t ON t.id = r.tenant_id
       LEFT JOIN products p ON p.id = r.product_id
      WHERE r.status = $1::review_status ORDER BY r.created_at LIMIT 500`, [status]
  )
  res.json(rows)
}))
storefrontAdminRouter.patch('/reviews/:reviewId/moderation', requireAnyRole('PLATFORM_ADMIN'), asyncHandler(async (req, res) => {
  const status = String(req.body?.status || '').toUpperCase()
  if (!['VISIBLE', 'HIDDEN'].includes(status)) return res.status(400).json({ message: 'Review status must be VISIBLE or HIDDEN.' })
  const { rows } = await query(
    `UPDATE reviews SET status = $2::review_status, moderated_at = now(), moderated_by_user_id = $3
      WHERE id = $1 RETURNING id, status, moderated_at, moderated_by_user_id`,
    [req.params.reviewId, status, req.user.id]
  )
  if (!rows.length) return res.status(404).json({ message: 'Review not found.' })
  res.json(rows[0])
}))

storefrontAdminRouter.get('/reconciliation-flags', requireAnyRole('PLATFORM_ADMIN'), asyncHandler(async (_req, res) => {
  const { rows } = await query(
    `SELECT f.*, o.tenant_id, o.merchant_id, o.customer_identifier,
            t.company_name AS vendor_name, m.display_name AS branch_name,
            tx.amount AS payment_amount, tx.internal_reference, tx.eganow_reference
       FROM order_payment_reconciliation_flags f
       JOIN orders o ON o.id = f.order_id
       JOIN tenants t ON t.id = o.tenant_id
       JOIN merchants m ON m.id = o.merchant_id
       JOIN transactions tx ON tx.id = f.transaction_id
      WHERE f.resolved_at IS NULL ORDER BY f.created_at LIMIT 500`
  )
  res.json(rows)
}))
storefrontAdminRouter.patch('/reconciliation-flags/:flagId/resolve', requireAnyRole('PLATFORM_ADMIN'), asyncHandler(async (req, res) => {
  const note = String(req.body?.resolutionNote || '').trim()
  if (!note || note.length > 2000) return res.status(400).json({ message: 'A resolution note of at most 2000 characters is required.' })
  const { rows } = await query(
    `UPDATE order_payment_reconciliation_flags SET resolved_at = now(), resolved_by_user_id = $2, resolution_note = $3
      WHERE id = $1 AND resolved_at IS NULL RETURNING *`, [req.params.flagId, req.user.id, note]
  )
  if (!rows.length) return res.status(404).json({ message: 'Open reconciliation flag not found.' })
  res.json(rows[0])
}))
