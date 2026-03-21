/**
 * Knowledge base ingestion script.
 *
 * Usage:
 *   node --loader ts-node/esm src/scripts/ingest.ts <file-or-dir> [--agent <slug>] [--chunk-size <chars>]
 *
 * Reads text files, splits into overlapping chunks, embeds each chunk via Ollama,
 * and stores them in the knowledge_base table.
 *
 * Options:
 *   --agent <slug>   Store as private knowledge for this agent (default: global)
 *   --chunk-size <N> Characters per chunk (default: 1500)
 *   --overlap <N>    Overlap characters between chunks (default: 200)
 *   --source <name>  Override source label (default: file path)
 */

import fs from 'fs';
import path from 'path';
import { pool, query } from '../db/client.js';
import { embed, toVectorLiteral } from '../embedding/client.js';
import { resolveAgentId } from '../mcp/tools.js';

const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.ts', '.js', '.json', '.py', '.sql', '.yaml', '.yml'];

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

function chunkText(text: string, chunkSize: number, overlap: number): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));

    if (end === text.length) break;
    start = end - overlap;
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function collectFiles(inputPath: string): string[] {
  const stat = fs.statSync(inputPath);

  if (stat.isFile()) {
    return [inputPath];
  }

  if (stat.isDirectory()) {
    const entries = fs.readdirSync(inputPath, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(inputPath, entry.name);
      if (entry.isDirectory()) {
        files.push(...collectFiles(fullPath));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTENSIONS.includes(ext)) {
          files.push(fullPath);
        }
      }
    }

    return files;
  }

  return [];
}

// ---------------------------------------------------------------------------
// Ingest a single file
// ---------------------------------------------------------------------------

async function ingestFile(
  filePath: string,
  agentId: string | null,
  chunkSize: number,
  overlap: number,
  sourceOverride?: string
): Promise<number> {
  const source = sourceOverride ?? filePath;
  const content = fs.readFileSync(filePath, 'utf-8');
  const title = path.basename(filePath);
  const chunks = chunkText(content, chunkSize, overlap);

  console.log(`  Ingesting ${filePath} → ${chunks.length} chunk(s)`);

  let stored = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const embedding = await embed(chunk);

    await query(
      `INSERT INTO knowledge_base
         (agent_id, title, source, content, chunk_index, embedding, embedding_model, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8)
       ON CONFLICT DO NOTHING`,
      [
        agentId,
        title,
        source,
        chunk,
        i,
        embedding ? toVectorLiteral(embedding) : null,
        embedding ? (process.env['EMBEDDING_MODEL'] ?? 'nomic-embed-text') : null,
        JSON.stringify({ file_path: filePath, chunk_index: i, total_chunks: chunks.length }),
      ]
    );

    stored++;

    if (embedding) {
      process.stdout.write('.');
    } else {
      process.stdout.write('_'); // no embedding (Ollama down)
    }
  }

  process.stdout.write('\n');
  return stored;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log('Usage: node --loader ts-node/esm src/scripts/ingest.ts <path> [options]');
    console.log('Options:');
    console.log('  --agent <slug>      Store as agent-scoped knowledge');
    console.log('  --chunk-size <N>    Characters per chunk (default: 1500)');
    console.log('  --overlap <N>       Overlap characters (default: 200)');
    console.log('  --source <name>     Override source label');
    process.exit(0);
  }

  const inputPath = args[0]!;
  let agentSlug: string | undefined;
  let chunkSize = 1500;
  let overlap = 200;
  let sourceOverride: string | undefined;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--agent' && args[i + 1]) agentSlug = args[++i];
    else if (args[i] === '--chunk-size' && args[i + 1]) chunkSize = parseInt(args[++i]!, 10);
    else if (args[i] === '--overlap' && args[i + 1]) overlap = parseInt(args[++i]!, 10);
    else if (args[i] === '--source' && args[i + 1]) sourceOverride = args[++i];
  }

  let agentId: string | null = null;
  if (agentSlug) {
    agentId = await resolveAgentId(agentSlug);
    console.log(`Ingesting as private knowledge for agent: ${agentSlug} (${agentId})`);
  } else {
    console.log('Ingesting as global knowledge');
  }

  if (!fs.existsSync(inputPath)) {
    console.error(`Path not found: ${inputPath}`);
    process.exit(1);
  }

  const files = collectFiles(inputPath);
  console.log(`Found ${files.length} file(s) to ingest`);

  let totalChunks = 0;
  for (const file of files) {
    const count = await ingestFile(file, agentId, chunkSize, overlap, sourceOverride);
    totalChunks += count;
  }

  console.log(`\nIngestion complete: ${totalChunks} chunk(s) stored from ${files.length} file(s)`);
  await pool.end();
}

main().catch((err) => {
  console.error('Ingestion failed:', err);
  process.exit(1);
});
