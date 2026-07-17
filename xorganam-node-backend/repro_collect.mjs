import 'dotenv/config'
import { initiateCollection } from './src/services/collectionService.js'

async function run() {
  try {
    const merchantId = '48b543f9-6089-4b7b-aa53-0ef01832c27e'
    const payload = {
      amount: 1,
      msisdn: '233547620052',
      network: 'MTNGH',
      narration: undefined
    }

    console.log('Running initiateCollection with payload:', { merchantId, ...payload })
    const result = await initiateCollection(merchantId, payload)
    console.log('Result:', result)
  } catch (err) {
    console.error('Error running initiateCollection:', err && err.message ? err.message : err)
    if (err && err.response) {
      console.error('Err response data:', err.response.data)
    }
    process.exitCode = 1
  }
}

run()
