const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api/v1'

function getToken() {
  const legacyToken = localStorage.getItem('xorganam_token')
  if (legacyToken) {
    localStorage.removeItem('xorganam_token')
    localStorage.removeItem('xorganam_user')
  }
  return sessionStorage.getItem('xorganam_token')
}

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message)
    this.status = status
    this.details = details
  }
}

async function request(path, { method = 'GET', body, isForm = false, params } = {}) {
  let url = `${BASE_URL}${path}`

  if (params) {
    const query = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    ).toString()
    if (query) url += `?${query}`
  }

  const headers = {}
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  if (!isForm && body !== undefined) headers['Content-Type'] = 'application/json'

  const response = await fetch(url, {
    method,
    headers,
    body: isForm ? body : body !== undefined ? JSON.stringify(body) : undefined
  })

  if (response.status === 401) {
    sessionStorage.removeItem('xorganam_token')
    sessionStorage.removeItem('xorganam_user')
    localStorage.removeItem('xorganam_token')
    localStorage.removeItem('xorganam_user')
    if (!window.location.pathname.startsWith('/login')) {
      window.location.href = '/login'
    }
    throw new ApiError('Session expired. Please sign in again.', 401)
  }

  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('application/json') ? await response.json().catch(() => null) : null

  if (!response.ok) {
    const message = payload?.message || payload?.title || `Request failed (${response.status}).`
    const details = payload?.errors
    throw new ApiError(message, response.status, details)
  }

  return payload
}

export const api = {
  get: (path, params) => request(path, { method: 'GET', params }),
  post: (path, body) => request(path, { method: 'POST', body }),
  put: (path, body) => request(path, { method: 'PUT', body }),
  del: (path) => request(path, { method: 'DELETE' }),
  postForm: (path, formData) => request(path, { method: 'POST', body: formData, isForm: true })
}

export { BASE_URL }
