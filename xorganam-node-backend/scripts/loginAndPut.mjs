import fetch from 'node-fetch'

const EGANOW_TEST_API_USERNAME = process.env.EGANOW_TEST_API_USERNAME || ''
const EGANOW_TEST_API_PASSWORD = process.env.EGANOW_TEST_API_PASSWORD || ''
const EGANOW_TEST_BASE_URL = process.env.EGANOW_TEST_BASE_URL || ''
const EGANOW_TEST_XAUTH = process.env.EGANOW_TEST_XAUTH || ''
const EGANOW_TEST_WEBHOOK_SECRET = process.env.EGANOW_TEST_WEBHOOK_SECRET || 'https://webhook.site/placeholder'

async function main() {
  if (!EGANOW_TEST_API_USERNAME || !EGANOW_TEST_API_PASSWORD || !EGANOW_TEST_BASE_URL || !EGANOW_TEST_XAUTH) {
    console.error('Missing Eganow test configuration. Set EGANOW_TEST_API_USERNAME, EGANOW_TEST_API_PASSWORD, EGANOW_TEST_BASE_URL, and EGANOW_TEST_XAUTH.')
    process.exit(1)
  }

  const loginRes = await fetch('http://localhost:3001/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@xorganam.local', password: 'ChangeMe!2026#' })
  })
  console.log('login status', loginRes.status)
  const loginBody = await loginRes.text()
  console.log(loginBody)

  let token
  try {
    token = JSON.parse(loginBody).token
  } catch (e) {}
  if (!token) return

  const payload = {
    apiUsername: EGANOW_TEST_API_USERNAME,
    apiPassword: EGANOW_TEST_API_PASSWORD,
    eganowBaseUrl: EGANOW_TEST_BASE_URL,
    xAuth: EGANOW_TEST_XAUTH,
    webhookSecret: EGANOW_TEST_WEBHOOK_SECRET,
    serviceName: '',
    isEnabled: true
  }

  const putRes = await fetch('http://localhost:3001/api/v1/tenants/747c4afa-bdb7-46a6-8fbf-6ce8046d489d/eganow-credentials', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload)
  })
  console.log('put status', putRes.status)
  const putBody = await putRes.text()
  console.log(putBody)
}

main().catch((e) => { console.error(e) })
