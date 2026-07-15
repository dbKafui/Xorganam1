import multer from 'multer'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'uploads', 'kyc')

fs.mkdirSync(UPLOAD_ROOT, { recursive: true })

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const tenantId = req.body.tenantId || req.user?.tenantId || 'unknown'
    const dir = path.join(UPLOAD_ROOT, tenantId)
    fs.mkdirSync(dir, { recursive: true })
    cb(null, dir)
  },
  filename: (_req, file, cb) => {
    const safeName = `${crypto.randomUUID()}${path.extname(file.originalname)}`
    cb(null, safeName)
  }
})

export const kycUpload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB
})

/**
 * Converts a multer file object into the public-relative URL stored on
 * kyc_documents.document_url. server.js serves UPLOAD_ROOT statically at
 * this same /kyc-uploads prefix.
 */
export function toDocumentUrl(tenantId, file) {
  return `/kyc-uploads/${tenantId}/${file.filename}`
}

export { UPLOAD_ROOT }
