/**
 * config.ts — Central typed configuration module.
 *
 * All environment variables are read here, defaulted, and exported as a
 * single typed `config` object. Import this instead of reaching for
 * `process.env` directly so that:
 *   - Defaults are in one place
 *   - Missing required vars fail fast with a clear message
 *   - Future contributors know what every setting does
 *
 * Call `validateConfig()` once at startup to catch missing required vars
 * before the agent tries to use them.
 */

// ---------------------------------------------------------------------------
// Helper: read env var with optional default
// ---------------------------------------------------------------------------

function env(key: string, defaultValue?: string): string {
  const val = process.env[key];
  if (val !== undefined && val.trim() !== '') return val.trim();
  if (defaultValue !== undefined) return defaultValue;
  throw new Error(
    `[config] Required environment variable "${key}" is not set. ` +
    `Check your .env file against .env.example.`
  );
}

function envOptional(key: string, defaultValue: string): string {
  return process.env[key]?.trim() || defaultValue;
}

function envInt(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (!val) return defaultValue;
  const n = parseInt(val, 10);
  if (isNaN(n)) throw new Error(`[config] "${key}" must be an integer, got "${val}"`);
  return n;
}

// ---------------------------------------------------------------------------
// Normalize helpers (shared with embedding/llm clients)
// ---------------------------------------------------------------------------

function normalizeOllamaHost(raw: string): string {
  let host = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `http://${raw}`;
  host = host.replace('://0.0.0.0', '://localhost');
  return host.replace(/\/$/, '');
}

function normalizeModelName(raw: string): string {
  return raw.includes(':') ? raw : `${raw}:latest`;
}

// ---------------------------------------------------------------------------
// Config object
// ---------------------------------------------------------------------------

export const config = {
  /** Node environment (production | development | test) */
  nodeEnv: envOptional('NODE_ENV', 'development') as 'production' | 'development' | 'test',

  // --- Database ---
  /** Full PostgreSQL connection string */
  databaseUrl: env(
    'DATABASE_URL',
    'postgresql://trustcore:changeme@localhost:5432/trustcore_memory'
  ),
  /** Max DB pool connections */
  dbPoolMax: envInt('DB_POOL_MAX', 10),

  // --- Ollama ---
  /** Normalized Ollama base URL — points to GPU1 (Alex's permanent home) for backwards compat */
  ollamaHost: normalizeOllamaHost(envOptional('OLLAMA_HOST', 'localhost:11434')),
  /** GPU0 — shared execution pool for sub-agents and factory */
  ollamaHostGpu0: normalizeOllamaHost(envOptional('OLLAMA_HOST_GPU0', 'http://ollama-gpu0:11434')),
  /** GPU1 — Alex's permanent home, reserved models only */
  ollamaHostGpu1: normalizeOllamaHost(envOptional('OLLAMA_HOST_GPU1', 'http://ollama-gpu1:11434')),
  /** Embedding model (always has a :tag suffix) */
  embeddingModel: normalizeModelName(envOptional('EMBEDDING_MODEL', 'nomic-embed-text')),
  /** LLM chat/completion model */
  llmModel: envOptional('LLM_MODEL', 'qwen2.5-coder:32b'),

  // --- Agent behaviour ---
  /** Heartbeat interval for Alex in milliseconds */
  alexHeartbeatMs: envInt('ALEX_HEARTBEAT_MS', 60_000),
  /** Research agent poll interval in milliseconds */
  researchPollMs: envInt('RESEARCH_POLL_MS', 30_000),
  /** Age in days before low-importance memories are eligible for consolidation */
  consolidationAgeDays: envInt('CONSOLIDATION_AGE_DAYS', 7),
  /** Max memories consolidated in one pass */
  consolidationBatch: envInt('CONSOLIDATION_BATCH', 50),

  // --- API server ---
  /** Port for the Mission Control HTTP/WS API */
  apiPort: envInt('API_PORT', 3002),
  /** Port for the MCP stdio server (internal) */
  mcpPort: envInt('MCP_PORT', 3001),

  // --- Knowledge base ingestion ---
  /** Default chunk size in characters */
  ingestChunkSize: envInt('INGEST_CHUNK_SIZE', 1500),
  /** Default overlap between chunks */
  ingestOverlap: envInt('INGEST_OVERLAP', 200),
} as const;

export type Config = typeof config;

// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------

/**
 * Call at agent startup to surface missing/invalid config before doing any work.
 * Throws with a human-readable message if anything is wrong.
 */
export function validateConfig(): void {
  const errors: string[] = [];

  if (!config.databaseUrl.startsWith('postgresql://') && !config.databaseUrl.startsWith('postgres://')) {
    errors.push(`DATABASE_URL must start with postgresql:// or postgres://`);
  }

  if (config.alexHeartbeatMs < 5_000) {
    errors.push(`ALEX_HEARTBEAT_MS must be >= 5000 (got ${config.alexHeartbeatMs})`);
  }

  if (errors.length > 0) {
    throw new Error(
      `[config] Configuration errors:\n${errors.map((e) => `  - ${e}`).join('\n')}\n` +
      `Check your .env file.`
    );
  }

  console.log('[config] Configuration validated OK');
  console.log(`[config]   DB:      ${config.databaseUrl.replace(/:\/\/[^@]+@/, '://*****@')}`);
  console.log(`[config]   Ollama:  ${config.ollamaHost}`);
  console.log(`[config]   LLM:     ${config.llmModel}`);
  console.log(`[config]   Embed:   ${config.embeddingModel}`);
}
