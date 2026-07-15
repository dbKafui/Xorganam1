import bcrypt from 'bcryptjs'

const SALT_ROUNDS = 12

export function hashPassword(plainText) {
  return bcrypt.hash(plainText, SALT_ROUNDS)
}

export function verifyPassword(plainText, hash) {
  return bcrypt.compare(plainText, hash)
}
