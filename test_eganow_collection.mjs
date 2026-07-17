const base = 'https://developer.deveganowapi.com'
const username = 'GH02339a5f25650bfc4f4590bed81fe73d458a'
const password = 'a812944ea64444d1c2b18b1811432ccfad5759a83bd5442c2ae9c60e1fcc2d0b'
const xAuth = 'GH0233R0gwMjMzOWE1ZjI1NjUwYmZjNGY0NTkwYmVkODFmZTczZDQ1OGE6YTgxMjk0NGVhNjQ0NDRkMWMyYjE4YjE4MTE0MzJjY2ZhZDU3NTlhODNiZDU0NDJjMmFlOWM2MGUxZmNjMmQwYg=='
const callback = 'https://webhook.site/6063bf1e-9146-442d-a9ab-1f669f649b96?id=6f9e4799-9907-4a52-8284-d8a0a5053e32&vscodeBrowserReqId=1784143299338'

async function run() {
  const tokenRes = await fetch(`${base}/api/auth/token`, {
    method: 'GET',
    headers: {
      'x-Auth': xAuth,
      Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
      'Content-Type': 'application/json'
    }
  })
  const tokenBody = await tokenRes.json()
  console.log('TOKEN_STATUS', tokenRes.status)
  console.log('TOKEN_BODY', tokenBody)
  const token = tokenBody.developerJwtToken
  if (!token) {
    throw new Error('No developerJwtToken in auth response')
  }

  const payload = {
    paypartnerCode: 'MTNGH',
    amount: 1,
    accountNoOrCardNoOrMSISDN: '233547620052',
    countryCode: 'GH0233',
    accountName: 'TEST USER',
    transactionId: 'COL-TEST-1234',
    narration: 'Collection test',
    transCurrencyIso: 'GHS',
    languageId: 'en',
    callback
  }

  const collectRes = await fetch(`${base}/api/transactions/collection`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-Auth': xAuth,
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  })
  const collectBody = await collectRes.text()
  console.log('COLLECT_STATUS', collectRes.status)
  console.log(collectBody)
}

run().catch((err) => {
  console.error('ERROR', err)
  process.exit(1)
})
