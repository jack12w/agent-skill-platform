const { Client } = require('pg');
const fs = require('fs'), path = require('path');
const env = {};
for (const l of fs.readFileSync(path.join(__dirname,'packages/api/.env'),'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g,'');
}
const c = new Client({ host: env.DB_HOST, port:+env.DB_PORT, user:env.DB_USER, password:env.DB_PASSWORD, database:env.DB_NAME, ssl:false });
(async()=>{ await c.connect();
  console.log('snapshots count:', (await c.query('SELECT COUNT(*) FROM leaderboard_snapshots')).rows);
  console.log('rows:', (await c.query('SELECT type, period, snapshot_date, created_at FROM leaderboard_snapshots ORDER BY created_at DESC LIMIT 5')).rows);
  await c.end();
})().catch(e=>{console.error(e.message);process.exit(1)});
