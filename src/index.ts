/**
 * TrustCore Engine — entry point
 *
 * Usage:
 *   npm run dev           → starts the MCP server (stdio)
 *   npm run dev:alex      → starts Alex's main loop
 *   npm run dev:research  → starts Research sub-agent
 *   node ... src/index.ts api   → starts Mission Control API (port 3002)
 */

const mode = process.argv[2] ?? 'mcp';

async function main(): Promise<void> {
  if (mode === 'alex') {
    const { runAlex } = await import('./agents/alex/index.js');
    await runAlex();
  } else if (mode === 'research') {
    await import('./agents/research/index.js');
  } else if (mode === 'api') {
    const { startApiServer } = await import('./api/server.js');
    await startApiServer();
  } else {
    const { startMcpServer } = await import('./mcp/server.js');
    await startMcpServer();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
