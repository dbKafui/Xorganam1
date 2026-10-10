const COOKIE_NAME = 'xorganam_admin_session'
const COOKIE_PATH = '/api/v1'

function cookieAttributes() {
  return `Path=${COOKIE_PATH}; HttpOnly; SameSite=Strict${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
}

export function getAdminSessionCookie(req) {
  const cookieHeader = req.headers.cookie || ''
  for (const part of cookieHeader.split(';')) {
    const [name, ...value] = part.trim().split('=')
    if (name === COOKIE_NAME) return value.join('=')
  }
  return null
}

export function setAdminSessionCookie(res, token) {
  res.append('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; ${cookieAttributes()}`)
}

export function clearAdminSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE_NAME}=; ${cookieAttributes()}; Max-Age=0`)
}