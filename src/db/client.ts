/**
 * PostgreSQL connection pool — the single shared database client for all of TrustCore.
 *
 * All agents, the API server, the MCP server, and the resource manager
 * import `query` and `pool` from this module. There is no other database
 * access path in the system.
 *
 * Pool settings:
 *   max: 10                — max simultaneous PG connections across all consumers
 *   idleTimeoutMillis: 30s — connections returned to pool after 30s idle
 *   connectionTimeoutMillis: 5s — fail fast if PG is unreachable at startup
 *
 * The module reads DATABASE_URL from the environment (or .env file) at import time.
 * If DATABASE_URL is missing, the module throws immediately — fail-fast is intentional
 * because every downstream operation would fail anyway.
 */

import { Pool } from 'pg';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

// Load .env if present
import * as fs from 'fs';
import * as path from 'path';

/**
 * Minimal .env loader — reads KEY=VALUE pairs from .env in the working directory.
 * Only sets variables that aren't already in the environment (Docker env takes precedence).
 * Used so local `node --loader ts-node/esm` invocations work without a process manager.
 */
function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}

loadEnv();

if (!process.env['DATABASE_URL']) {
  throw new Error('DATABASE_URL is not set. Did you create .env?');
}

export const pool = new Pool({
  connectionString: process.env['DATABASE_URL'],
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err: Error) => {
  console.error('Unexpected pg pool error:', err);
});

/**
 * Execute a parameterized SQL query using the shared connection pool.
 * This is the primary DB access function used throughout the codebase.
 * Uses $1, $2, ... placeholders (pg-style, not ? MySQL-style).
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<QueryResult<T>> {
  return pool.query<T>(sql, params);
}

/**
 * Acquire a dedicated client from the pool for multi-statement transactions.
 * Automatically releases the client back to the pool when done, even on error.
 * Use this when you need BEGIN / COMMIT / ROLLBACK semantics or multiple
 * queries that must share the same connection.
 */
export async function withClient<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
