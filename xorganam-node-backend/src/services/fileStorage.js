import multer from 'multer'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'uploads', 'kyc')
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg', '.png'])

export function safeTenantUploadDir(tenantId) {
  // Tenant IDs become path components; only accept canonical UUIDs to prevent traversal.
  if (typeof tenantId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId)) {
    throw new Error('Invalid tenant ID for document storage.')
  }
  const dir = path.resolve(UPLOAD_ROOT, tenantId)
  if (!dir.startsWith(`${path.resolve(UPLOAD_ROOT)}${path.sep}`)) throw new Error('Invalid document storage path.')
  return dir
}

fs.mkdirSync(UPLOAD_ROOT, { recursive: true })

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    try {
      // Use the URL's tenant ID, which is available before multipart fields are parsed.
      const dir = safeTenantUploadDir(req.params.tenantId)
      fs.mkdirSync(dir, { recursive: true })
      cb(null, dir)
    } catch (error) { cb(error) }
  },
  filename: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase()
    const safeName = `${crypto.randomUUID()}${extension}`
    cb(null, safeName)
  }
})

export const kycUpload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024, files: 10, fields: 30 }, // Bound upload resource use.
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase()
    if (!ALLOWED_EXTENSIONS.has(extension)) return cb(Object.assign(new Error('Only PDF, JPEG, and PNG documents are accepted.'), { statusCode: 400 }))
    cb(null, true)
  }
})

/**
 * Returns the authenticated API URL used to retrieve a stored KYC document.
 */
export function toDocumentUrl(tenantId, file) {
  return `/api/v1/tenants/${tenantId}/kyc-documents/${file.filename}/file`
}

export { UPLOAD_ROOT }
