const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u
const phonePattern = /^[+\d().\s-]+$/u
const currencyPattern = /^\d+(?:\.\d{1,2})?$/u
const accountPattern = /^\d{6,34}$/u
const ghanaCardPattern = /^GHA-\d{9}-\d$/u
const blockedKeys = new Set(['__proto__', 'prototype', 'constructor'])

function hasUnsafeControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0)
    if (code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || code === 0x7f) {
      return true
    }
  }
  return false
}

export function isValidGhanaCardNumber(value) {
  return typeof value === 'string' && ghanaCardPattern.test(value.trim().toUpperCase())
}

function luhnValid(value) {
  const digits = value.replace(/[\s-]/gu, '')
  if (!/^\d{12,19}$/u.test(digits)) return false
  let sum = 0
  let double = false
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index])
    if (double) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    double = !double
  }
  return sum % 10 === 0
}

function isApiPassword(key) {
  return /api[_-]?.*password/i.test(key)
}

function validateScalar(value, key, path, errors) {
  if (isApiPassword(key)) return value

  const normalizedKey = key.toLowerCase().replace(/[_-]/gu, '')
  if (typeof value === 'string') {
    if (value.length > 10000) {
      errors.push({ field: path, message: 'Text is too long.' })
      return value
    }
    if (hasUnsafeControlCharacter(value)) errors.push({ field: path, message: 'Control characters are not allowed.' })

    if (normalizedKey.includes('email')) {
      const email = value.trim().toLowerCase()
      if (email && (email.length > 254 || !emailPattern.test(email))) {
        errors.push({ field: path, message: 'Enter a valid email address.' })
      }
      return email
    }

    const multiPurposeAccount = normalizedKey === 'accountnoormsisdn' || normalizedKey === 'accountnumberormsisdn'
    if (!multiPurposeAccount && /(?:phone(?:number)?|mobile(?:number|moneynumber)?|msisdn|telephone)$/u.test(normalizedKey)) {
      const digitCount = value.replace(/\D/gu, '').length
      if (value && (!phonePattern.test(value) || digitCount < 7 || digitCount > 15)) {
        errors.push({ field: path, message: 'Enter a valid telephone number.' })
      }
    }

    if (/(?:amount|principal|balance|contributionhistory|downpayment|markupamount|feevalue|totalvalue|approvalamount|approvallimit)(?:cents)?$/u.test(normalizedKey) && value !== '') {
      const valid = normalizedKey.endsWith('cents')
        ? /^\d+$/u.test(value) && Number.isSafeInteger(Number(value))
        : currencyPattern.test(value) && Number.isFinite(Number(value)) && Number.isSafeInteger(Math.round(Number(value) * 100))
      if (!valid) errors.push({ field: path, message: 'Enter a non-negative amount with at most two decimal places.' })
    }

    if (/^(?:cardnumber|pan)$/u.test(normalizedKey) && value && !luhnValid(value)) {
      errors.push({ field: path, message: 'Enter a valid card number.' })
    }

    if (/^(?:bankaccountnumber|bankaccountno)$/u.test(normalizedKey) && value && !accountPattern.test(value)) {
      errors.push({ field: path, message: 'Enter a valid bank account number.' })
    }

    if (/^(?:ghanacard|ghanacardnumber|ghanacardid)$/u.test(normalizedKey) && value) {
      const cardId = value.trim().toUpperCase()
      if (!isValidGhanaCardNumber(cardId)) errors.push({ field: path, message: 'Enter a Ghana Card number in GHA-XXXXXXXXX-X format.' })
      return cardId
    }

    return value
  }

  if (typeof value === 'number' && /(?:amount|principal|balance|contributionhistory|downpayment|feevalue|totalvalue|approvallimit)$/u.test(normalizedKey)) {
    const cents = Math.round(value * 100)
    if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(cents) || Math.abs(value * 100 - cents) > 1e-8) {
      errors.push({ field: path, message: 'Enter a valid non-negative amount.' })
    }
  }
  if (typeof value === 'number' && /cents$/u.test(normalizedKey) && (!Number.isSafeInteger(value) || value < 0)) {
    errors.push({ field: path, message: 'Enter a valid non-negative amount in cents.' })
  }
  if (typeof value === 'number' && normalizedKey.includes('email')) {
    errors.push({ field: path, message: 'Enter a valid email address.' })
  }
  if (typeof value === 'number' && /(?:phone(?:number)?|mobile(?:number|moneynumber)?|msisdn|telephone)$/u.test(normalizedKey)) {
    errors.push({ field: path, message: 'Enter a valid telephone number.' })
  }
  if (typeof value === 'string' && /(?:password|passphrase)$/u.test(normalizedKey) && value.length > 1024) {
    errors.push({ field: path, message: 'Password is too long.' })
  }
  if (/^(?:cardnumber|pan|bankaccountnumber|bankaccountno|ghanacard|ghanacardnumber|ghanacardid)$/u.test(normalizedKey) && value != null && value !== '' && typeof value !== 'string') {
    errors.push({ field: path, message: 'This identifier must be submitted as text.' })
  }
  return value
}

function sanitizeValue(value, key, path, errors, depth = 0) {
  if (isApiPassword(key)) return value
  if (depth > 12) {
    errors.push({ field: path, message: 'Input nesting is too deep.' })
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > 1000) errors.push({ field: path, message: 'Too many values were submitted.' })
    return value.slice(0, 1000).map((item, index) => sanitizeValue(item, key, `${path}[${index}]`, errors, depth + 1))
  }
  if (value && typeof value === 'object') {
    const clean = Object.create(null)
    const documentType = String(value.documentType || value.idDocumentType || '').toUpperCase()
    for (const [childKey, childValue] of Object.entries(value)) {
      const childPath = path ? `${path}.${childKey}` : childKey
      if (blockedKeys.has(childKey)) {
        errors.push({ field: childPath, message: 'This field name is not allowed.' })
        continue
      }
      let safeValue = sanitizeValue(childValue, childKey, childPath, errors, depth + 1)
      if (/^(?:documentnumber|iddocumentnumber)$/u.test(childKey.toLowerCase().replace(/[_-]/gu, '')) && /GHA|GHANA.*CARD/u.test(documentType) && typeof safeValue === 'string') {
        safeValue = safeValue.trim().toUpperCase()
        if (!isValidGhanaCardNumber(safeValue)) errors.push({ field: childPath, message: 'Enter a Ghana Card number in GHA-XXXXXXXXX-X format.' })
      }
      clean[childKey] = safeValue
    }
    return clean
  }
  return validateScalar(value, key, path, errors)
}

/**
 * Validate user supplied JSON before route handlers see it. Secrets are never
 * trimmed or case-normalized; API password fields bypass this middleware's
 * scalar checks entirely so gateway credentials are forwarded verbatim.
 */
export function sanitizeInput(req, res, next) {
  // Provider callbacks are signed/verified against their original contract.
  if (req.path.startsWith('/api/v1/webhooks/')) return next()

  if (!req.body || typeof req.body !== 'object') return next()
  const errors = []
  req.body = sanitizeValue(req.body, '', '', errors)
  if (errors.length) return res.status(400).json({ message: 'Request contains invalid input.', errors })
  next()
}
