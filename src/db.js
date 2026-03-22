const { Pool } = require("pg");

let pool;

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is required");
    }
    pool = new Pool({
      connectionString,
      max: toPositiveInt(process.env.PG_POOL_MAX, 10),
      idleTimeoutMillis: toPositiveInt(process.env.PG_IDLE_TIMEOUT_MS, 30000),
      connectionTimeoutMillis: toPositiveInt(process.env.PG_CONNECT_TIMEOUT_MS, 10000),
      keepAlive: true,
      ssl: connectionString.includes("localhost")
        ? false
        : { rejectUnauthorized: false }
    });
  }
  return pool;
}

async function query(text, params = []) {
  return getPool().query(text, params);
}

async function queryOne(text, params = []) {
  const result = await query(text, params);
  return result.rows[0] || null;
}

module.exports = {
  getPool,
  query,
  queryOne
};
