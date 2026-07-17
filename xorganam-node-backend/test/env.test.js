import assert from 'node:assert';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('env configuration', () => {
  it('requires critical environment variables', () => {
    const script = `
      process.env.DATABASE_URL = 'postgresql://localhost/test';
      process.env.REDIS_URL = 'redis://localhost:6379';
      process.env.ENCRYPTION_MASTER_KEY = 'test-key';
      process.env.JWT_SECRET = 'test-secret';
      import('../src/config/env.js').then(() => console.log('OK')).catch((err) => {
        console.error(err.message);
        process.exit(1);
      });
    `;

    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: __dirname,
      encoding: 'utf8'
    });

    assert.ok(output.includes('OK'));
  });
});
