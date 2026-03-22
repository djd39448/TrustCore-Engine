/**
 * register-agent.ts
 * Registers a trained Ollama model as a sub-agent in the TrustCore Engine swarm.
 *
 * What it does:
 *   1. Validates the Ollama model exists (ollama list)
 *   2. Inserts a record in agents table (TrustCore Engine DB)
 *   3. Adds a knowledge_base entry with training provenance
 *   4. Writes an observation to unified_memory announcing the new agent
 *   5. Prints the new agent UUID for reference
 *
 * Usage:
 *   npx ts-node scripts/register-agent.ts  *     --model trustcore-agent-v1  *     --slug trustcore-agent-v1  *     --description "Custom-trained TrustCore agent"  *     --task "General instruction following"
 */

import { Pool } from 'pg';
import { execSync } from 'child_process';

// ---- Parse args ----
const args = process.argv.slice(2);
function getArg(name: string, required = true): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) {
    if (required) { console.error(`Missing required arg: ${name}`); process.exit(1); }
    return undefined;
  }
  return args[i + 1];
}

const modelName    = getArg('--model')!;
const slug         = getArg('--slug')!;
const description  = getArg('--description')!;
const task         = getArg('--task', false) ?? 'General task completion';
const ggufPath     = getArg('--gguf-path', false);

const DATABASE_URL = process.env['DATABASE_URL'] ??
  'postgresql://trustcore:changeme@localhost:5432/trustcore_memory';

// ---- Validate Ollama model exists ----
console.log(`[register] Checking Ollama model: ${modelName}`);
try {
  const list = execSync('ollama list 2>&1').toString();
  if (!list.includes(modelName)) {
    console.error(`Model '${modelName}' not found in Ollama. Run: ollama create ${modelName} -f Modelfile`);
    process.exit(1);
  }
  console.log(`[register] Model confirmed in Ollama`);
} catch {
  console.warn(`[register] Could not verify Ollama model (Ollama may not be running) — proceeding anyway`);
}

// ---- Connect to DB ----
const pool = new Pool({ connectionString: DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    // Check if slug already exists
    const existing = await client.query('SELECT id FROM agents WHERE slug = $1', [slug]);
    if (existing.rows.length > 0) {
      console.log(`[register] Agent '${slug}' already exists: ${existing.rows[0].id}`);
      await pool.end();
      return;
    }

    // 1. Insert agent record
    const agentResult = await client.query<{ id: string }>(`
      INSERT INTO agents (slug, display_name, type, description, docker_image, is_active)
      VALUES ($1, $2, 'sub-agent', $3, $4, true)
      RETURNING id
    `, [slug, modelName, description, modelName]);
    const agentId = agentResult.rows[0]!.id;
    console.log(`[register] Agent registered: ${agentId}`);

    // 2. Find system agent for authoring memory
    const sysAgent = await client.query<{ id: string }>(
      "SELECT id FROM agents WHERE slug = 'system' LIMIT 1"
    );
    const systemId = sysAgent.rows[0]?.id;

    // 3. Insert knowledge_base entry with training provenance
    await client.query(`
      INSERT INTO knowledge_base (agent_id, title, source, content, chunk_index, metadata)
      VALUES ($1, $2, $3, $4, 0, $5)
    `, [
      agentId,
      `Agent training record: ${slug}`,
      `factory/${slug}`,
      `Agent: ${modelName}\nSlug: ${slug}\nTask: ${task}\nDescription: ${description}` +
        (ggufPath ? `\nGGUF: ${ggufPath}` : '') +
        `\nRegistered: ${new Date().toISOString()}`,
      JSON.stringify({ model: modelName, slug, task, registered_at: new Date().toISOString() })
    ]);
    console.log(`[register] Knowledge base entry created`);

    // 4. Write unified_memory announcement
    if (systemId) {
      await client.query(`
        INSERT INTO unified_memory (author_agent_id, event_type, summary, content, importance)
        VALUES ($1, 'observation', $2, $3, 4)
      `, [
        systemId,
        `New agent registered in swarm: ${slug}`,
        JSON.stringify({ agent_id: agentId, slug, model: modelName, task, description })
      ]);
      console.log(`[register] Announced to unified_memory`);
    }

    console.log(`\n✓ Agent '${slug}' is live in the TrustCore swarm`);
    console.log(`  UUID: ${agentId}`);
    console.log(`  Ollama model: ${modelName}`);
    console.log(`  Task: ${task}`);
    console.log(`\nAlex can now dispatch tasks to slug '${slug}'`);
    console.log(`Add '${slug}' to REGISTERED_AGENTS in src/agents/registry.ts`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
