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

const OLLAMA_HOST = normalizeOllamaHost(process.env['OLLAMA_HOST'] ?? 'localhost:11434');
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
    // Ollama not ready yet — embeddings will be backfilled later
    console.warn(`[embed] Ollama unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Format a float[] as a pgvector literal: '[0.1,0.2,...]'
 */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
