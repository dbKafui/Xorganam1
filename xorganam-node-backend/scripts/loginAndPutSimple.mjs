async function main(){
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
    apiUsername: 'GH02339a5f25650bfc4f4590bed81fe73d458a',
    apiPassword: 'a812944ea64444d1c2b18b1811432ccfad5759a83bd5442c2ae9c60e1fcc2d0b',
    eganowBaseUrl: 'https://developer.deveganowapi.com',
    xAuth: 'GH0233R0gwMjMzOWE1ZjI1NjUwYmZjNGY0NTkwYmVkODFmZTczZDQ1OGE6YTgxMjk0NGVhNjQ0NDRkMWMyYjE4YjE4MTE0MzJjY2ZhZDU3NTlhODNiZDU0NDJjMmFlOWM2MGUxZmNjMmQwYg==',
    webhookSecret: 'https://webhook.site/6063bf1e-9146-442d-a9ab-1f669f649b96',
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
