/**
 * TrustCore Engine — entry point
 *
 * Mode is selected by the first CLI argument (default: mcp):
 *   npm run dev               → MCP server (stdio, port 3001)
 *   npm run dev:alex          → Alex always-on chief-of-staff loop
 *   npm run dev:research      → Research sub-agent poll loop
 *   npm run dev:email-writer  → Email Writer sub-agent poll loop
 *   npm run dev:api           → Mission Control HTTP+WS API (port 3002)
 */

const mode = process.argv[2] ?? 'mcp';

async function main(): Promise<void> {
  if (mode === 'alex') {
    const { runAlex } = await import('./agents/alex/index.js');
    await runAlex();
  } else if (mode === 'research') {
    await import('./agents/research/index.js');
  } else if (mode === 'email-writer') {
    await import('./agents/email-writer/index.js');
  } else if (mode === 'api') {
    const { startApiServer } = await import('./api/server.js');
    await startApiServer();
  } else if (mode === 'mc-mcp') {
    const { startMissionControlMcpServer } = await import('./mcp/mission-control-server.js');
    await startMissionControlMcpServer();
  } else {
    const { startMcpServer } = await import('./mcp/server.js');
    await startMcpServer();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
