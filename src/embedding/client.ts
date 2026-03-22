/**
 * Ollama embedding client.
 * Generates 768-dim vectors using nomic-embed-text (local, no API key needed).
 */

function normalizeOllamaHost(raw: string): string {
  // Add scheme if missing
  let host = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `http://${raw}`;
  // Replace bind-all address with localhost for client use
  host = host.replace('://0.0.0.0', '://localhost');
  return host;
}

function normalizeModelName(raw: string): string {
  // Append :latest if no tag specified
  return raw.includes(':') ? raw : `${raw}:latest`;
}

// Embeddings always go to gpu0 (shared pool) — never gpu1, which is reserved for Alex's 35b model.
// OLLAMA_HOST_GPU0 is set per-container in docker-compose.yml; falls back to localhost for tests.
const OLLAMA_HOST = normalizeOllamaHost(process.env['OLLAMA_HOST_GPU0'] ?? process.env['OLLAMA_HOST'] ?? 'localhost:11434');
const EMBEDDING_MODEL = normalizeModelName(process.env['EMBEDDING_MODEL'] ?? 'nomic-embed-text');

interface OllamaEmbedResponse {
  embedding: number[];
}

/**
 * Generate a 768-dimensional embedding for the given text.
 * Returns null if Ollama is unavailable or the model isn't loaded yet.
 */
export async function embed(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, prompt: text }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.warn(`[embed] Ollama returned ${res.status}: ${await res.text()}`);
      return null;
    }

    const data = (await res.json()) as OllamaEmbedResponse;
    return data.embedding ?? null;
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      console.warn('[embed] Timeout — writing memory without embedding');
    } else {
      console.warn(`[embed] Ollama unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }
}

/**
 * Format a float[] as a pgvector literal: '[0.1,0.2,...]'
 */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
