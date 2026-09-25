import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const databaseDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db');
const throughArgument = process.argv.find((argument) => argument.startsWith('--through='));
const throughVersion = throughArgument?.split('=', 2)[1] ?? null;

function migrationVersion(name) {
  return name.split('_', 1)[0];
}

function checksum(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

async function getMigrations() {
  const names = await readdir(databaseDirectory);
  return names
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort()
    .filter((name) => !throughVersion || migrationVersion(name) <= throughVersion);
}

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const migrations = await getMigrations();
    const { rows: appliedRows } = await client.query(
      'SELECT name, checksum FROM schema_migrations',
    );
    const applied = new Map(appliedRows.map((row) => [row.name, row.checksum]));

    for (const name of migrations) {
      const contents = await readFile(path.join(databaseDirectory, name), 'utf8');
      const digest = checksum(contents);
      const existingChecksum = applied.get(name);

      if (existingChecksum) {
        if (existingChecksum !== '0'.repeat(64) && existingChecksum !== digest) {
          throw new Error(`Migration checksum changed after application: ${name}`);
        }
        continue;
      }

      process.stdout.write(`Applying ${name}\n`);
      await client.query('BEGIN');
      try {
        const migrationSql = contents
          .replace(/^\s*BEGIN;\s*/i, '')
          .replace(/\s*COMMIT;\s*$/i, '');
        await client.query(migrationSql);
        await client.query(
          'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
          [name, digest],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
