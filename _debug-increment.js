// Manually replicate what recordEvent should do
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

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

  // Find the only skill
  const { rows: skills } = await client.query('SELECT id FROM skills LIMIT 1');
  const skillId = skills[0].id;
  console.log('Using skill:', skillId);

  // Recompute stats from events
  const { rows: counts } = await client.query(
    `SELECT type, COUNT(*) AS n FROM events WHERE skill_id = $1 GROUP BY type`,
    [skillId]
  );
  console.log('Event counts:', counts);

  let likes = 0, downloads = 0;
  for (const c of counts) {
    if (c.type === 'like') likes = parseInt(c.n, 10);
    if (c.type === 'download') downloads = parseInt(c.n, 10);
  }
  const totalScore = likes * 2 + downloads;

  // Dedupe likes (same user/skill) — count distinct users instead
  const { rows: distinctLikes } = await client.query(
    `SELECT COUNT(DISTINCT user_id) AS n FROM events WHERE skill_id = $1 AND type = 'like' AND user_id IS NOT NULL`,
    [skillId]
  );
  const dedupedLikes = parseInt(distinctLikes[0].n, 10);
  console.log('Deduped likes (distinct users):', dedupedLikes);
  console.log('Downloads:', downloads);

  // Update skill_stats to reflect reality
  const updated = await client.query(
    `UPDATE skill_stats
     SET likes_total = $1, downloads_total = $2, total_score = $3, updated_at = NOW()
     WHERE skill_id = $4
     RETURNING *`,
    [dedupedLikes, downloads, dedupedLikes * 2 + downloads, skillId]
  );
  console.log('Updated row:', updated.rows[0]);

  await client.end();
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
