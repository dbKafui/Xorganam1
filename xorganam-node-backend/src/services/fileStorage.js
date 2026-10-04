import multer from 'multer'
import { encrypt, decrypt } from '../security/encryption.js'
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

fs.mkdirSync(UPLOAD_ROOT, { recursive: true, mode: 0o700 })
fs.chmodSync(UPLOAD_ROOT, 0o700)

export const kycUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5, fields: 30 },
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

export function hasAllowedDocumentSignature(extension, bytes) {
  if (!Buffer.isBuffer(bytes)) return false
  if (extension === '.pdf') return bytes.subarray(0, 5).toString('ascii') === '%PDF-'
  if (extension === '.png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (extension === '.jpg' || extension === '.jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  return false
}

export async function encryptKycFile(bytes, tenantSalt) {
  const envelope = await encrypt(bytes.toString('base64'), tenantSalt)
  return Buffer.from(`XOR-KYC1\n${envelope}`, 'utf8')
}

export async function decryptKycFile(bytes, tenantSalt) {
  const marker = Buffer.from('XOR-KYC1\n')
  if (!bytes.subarray(0, marker.length).equals(marker)) return bytes // legacy files remain readable
  const envelope = bytes.subarray(marker.length).toString('utf8')
  const decoded = await decrypt(envelope, tenantSalt)
  if (!decoded || decoded === envelope || envelope === decoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(decoded)) {
    throw new Error('Unable to decrypt stored KYC document.')
  }
  return Buffer.from(decoded, 'base64')
}

export function newKycDocumentFilename(originalName) {
  const extension = path.extname(originalName).toLowerCase()
  if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error('Unsupported document extension.')
  return `${crypto.randomUUID()}${extension}`
}

export { UPLOAD_ROOT }
