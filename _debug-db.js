// Quick DB inspection script — run from project root with: node _debug-db.js
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// Parse api/.env manually
const envPath = path.join(__dirname, 'packages/api/.env');
const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const client = new Client({
  host: env.DB_HOST,
  port: parseInt(env.DB_PORT || '5432', 10),
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  ssl: env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

(async () => {
  await client.connect();

  console.log('\n=== skills ===');
  const skills = await client.query('SELECT id, slug, name FROM skills');
  console.table(skills.rows);

  console.log('\n=== skill_stats ===');
  const stats = await client.query(
    'SELECT skill_id, likes_total, downloads_total, total_score, weekly_score FROM skill_stats'
  );
  console.table(stats.rows);

  console.log('\n=== events (last 20) ===');
  const events = await client.query(
    `SELECT id, skill_id, type, user_id, created_at FROM events ORDER BY created_at DESC LIMIT 20`
  );
  console.table(events.rows);

  console.log('\n=== event counts by type ===');
  const counts = await client.query(
    `SELECT type, COUNT(*) AS n FROM events GROUP BY type ORDER BY type`
  );
  console.table(counts.rows);

  await client.end();
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
