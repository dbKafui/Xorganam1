#!/usr/bin/env node

import http from 'node:http'

// Test the collection endpoint directly
const merchantId = '96595d2f-1eda-44c9-9ff2-8d8dc1f50a7d' // From logs
const testData = {
  merchantId,
  amount: 5,
  msisdn: '0547620052',
  network: 'MTNGH'
}

const postData = JSON.stringify(testData)

const options = {
  hostname: 'localhost',
  port: 3000,
  path: `/api/v1/public/collect`,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData)
  }
}

const req = http.request(options, (res) => {
  console.log(`STATUS: ${res.statusCode}`)
  console.log(`HEADERS: ${JSON.stringify(res.headers)}`)
  res.setEncoding('utf8')
  let data = ''
  res.on('data', (chunk) => {
    data += chunk
  })
  res.on('end', () => {
    console.log('BODY:')
    console.log(data)
  })
})

req.on('error', (e) => {
  console.error(`problem with request: ${e.message}`)
})

req.write(postData)
req.end()
