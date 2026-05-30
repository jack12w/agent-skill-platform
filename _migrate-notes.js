require('dotenv').config({ path: require('path').join(__dirname, 'packages', 'api', '.env') });
const { Client } = require('pg');

const client = new Client({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to RDS.');
    await client.query('ALTER TABLE skill_versions ADD COLUMN IF NOT EXISTS notes TEXT;');
    console.log('Done - notes column added.');
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    await client.end();
  }
})();
