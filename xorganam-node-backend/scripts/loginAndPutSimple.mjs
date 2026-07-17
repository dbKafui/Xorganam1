const EGANOW_TEST_API_USERNAME = process.env.EGANOW_TEST_API_USERNAME || ''
const EGANOW_TEST_API_PASSWORD = process.env.EGANOW_TEST_API_PASSWORD || ''
const EGANOW_TEST_BASE_URL = process.env.EGANOW_TEST_BASE_URL || ''
const EGANOW_TEST_XAUTH = process.env.EGANOW_TEST_XAUTH || ''
const EGANOW_TEST_WEBHOOK_SECRET = process.env.EGANOW_TEST_WEBHOOK_SECRET || 'https://webhook.site/placeholder'

async function main(){
  if (!EGANOW_TEST_API_USERNAME || !EGANOW_TEST_API_PASSWORD || !EGANOW_TEST_BASE_URL || !EGANOW_TEST_XAUTH) {
    console.error('Missing Eganow test configuration. Set EGANOW_TEST_API_USERNAME, EGANOW_TEST_API_PASSWORD, EGANOW_TEST_BASE_URL, and EGANOW_TEST_XAUTH.')
    process.exit(1)
  }

  const login = await fetch('http://localhost:3001/api/v1/auth/login',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({email:'eyramd75@gmail.com',password:'3yR@mCart3r'})
  })
  console.log('login status', login.status)
  const lb = await login.text()
  console.log('login body', lb)
  let token = null
  try{ token = JSON.parse(lb).token }catch(e){}
  if(!token){ console.error('no token, aborting'); return }
  const payload = {
    apiUsername: EGANOW_TEST_API_USERNAME,
    apiPassword: EGANOW_TEST_API_PASSWORD,
    eganowBaseUrl: EGANOW_TEST_BASE_URL,
    xAuth: EGANOW_TEST_XAUTH,
    webhookSecret: EGANOW_TEST_WEBHOOK_SECRET,
    serviceName: '',
    isEnabled: true
  }
  const put = await fetch('http://localhost:3001/api/v1/tenants/747c4afa-bdb7-46a6-8fbf-6ce8046d489d/eganow-credentials',{
    method:'PUT', headers: { 'Content-Type':'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload)
  })
  console.log('put status', put.status)
  const pb = await put.text()
  console.log('put body', pb)
}

main().catch(e=>{console.error(e); process.exit(1)})
