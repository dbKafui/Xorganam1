import './collectForMeWorker.js'
import './collectionStatusPollWorker.js'
import './eganowTokenRefreshWorker.js'
import './periodicSettlementWorker.js'
import { startInstitutionVerificationSlaWorker } from './institutionVerificationSlaWorker.js'

startInstitutionVerificationSlaWorker()
import './creditWebhookWorker.js'
import './creditReminderWorker.js'
import './creditCashSweepWorker.js'
import './orderExpiryWorker.js'

console.log('[workers] worker runner loaded')
