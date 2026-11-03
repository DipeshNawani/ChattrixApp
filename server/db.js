'use strict';
const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// BIGINT / COUNT(*) come back as strings by default -> make them numbers (safe for our values)
types.setTypeParser(20, v => parseInt(v, 10));

if (!process.env.DATABASE_URL) {
  try {
    const _env = path.join(__dirname, '.env');
    if (typeof process.loadEnvFile === 'function' && fs.existsSync(_env)) {
      process.loadEnvFile(_env);
    }
  } catch (_) {}
}

if (!process.env.DATABASE_URL) {
  console.error('\nDATABASE_URL is not set.\nSet it to your Supabase connection string (see README -> "Supabase setup") or any PostgreSQL URL.\n');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }, // Supabase needs SSL
  max: Number(process.env.PG_POOL_MAX) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 20000
});
pool.on('error', e => console.error('pg pool error:', e.message));

// write SQL with ? placeholders -> converted to $1, $2 ...
const pgify = sql => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };
const run = (sql, params = []) => pool.query(pgify(sql), params);
const all = async (sql, params) => (await run(sql, params)).rows;
const one = async (sql, params) => (await run(sql, params)).rows[0] || null;

async function init() {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
}

module.exports = { pool, run, all, one, init };
