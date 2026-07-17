import {getRedisConnection, COLLECT_FOR_ME_QUEUE} from './src/queue/queue.js';
import {Queue} from 'bullmq';

const redis = getRedisConnection();
const queue = new Queue(COLLECT_FOR_ME_QUEUE, {connection: redis});

const job = await queue.add('collect-for-me', {
  tenantId: '8dd3ca13-c813-47c7-9444-c35c2b20539a',
  merchantId: '96595d2f-1eda-44c9-9ff2-8d8dc1f50a7d',
  transactionId: '9ef5db1c-b11f-4646-add4-a37ef76c0661'
}, {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 2000
  }
});

console.log(`Enqueued job ${job.id}`);
redis.disconnect();
process.exit(0);
