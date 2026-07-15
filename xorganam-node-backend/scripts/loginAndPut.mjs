import fetch from 'node-fetch'

async function main() {
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
    apiUsername: 'GH02339a5f25650bfc4f4590bed81fe73d458a',
    apiPassword: 'a812944ea64444d1c2b18b1811432ccfad5759a83bd5442c2ae9c60e1fcc2d0b',
    eganowBaseUrl: 'https://developer.deveganowapi.com',
    xAuth: 'GH0233R0gwMjMzOWE1ZjI1NjUwYmZjNGY0NTkwYmVkODFmZTczZDQ1OGE6YTgxMjk0NGVhNjQ0NDRkMWMyYjE4YjE4MTE0MzJjY2ZhZDU3NTlhODNiZDU0NDJjMmFlOWM2MGUxZmNjMmQwYg==',
    webhookSecret: 'https://webhook.site/6063bf1e-9146-442d-a9ab-1f669f649b96',
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
