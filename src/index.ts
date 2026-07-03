#!/usr/bin/env bun
import { Command } from 'commander';
import { searchCommand } from './commands/search.ts';
import { statusCommand } from './commands/status.ts';
import { backfillCommand } from './commands/backfill.ts';
import { watchInternalCommand } from './commands/watch.ts';
import { uiCommand } from './commands/ui.ts';
import { mcpCommand } from './commands/mcp.ts';
import { serviceCommand } from './commands/service.ts';
import { dreamCommand } from './commands/dream.ts';
import { wikiCommand } from './commands/wiki.ts';
import { synthesisRunCommand } from './commands/synthesisRun.ts';

const program = new Command();

program
  .name('engram')
  .description('Global semantic memory for your coding sessions')
  .version('0.1.0');

program
  .command('search')
  .description('Search your indexed sessions')
  .argument('<query>', 'natural-language query')
  .option('--branch <branch>', 'limit to a git branch')
  .option('--repo <repo>', 'limit to a repo')
  .option('--since <date>', 'only results after this ISO date')
  .option('--tier <tier>', 'raw | dream | wiki | synth | all (default all)', 'all')
  .option('--limit <n>', 'max results', '5')
  .option('--rerank', 'rerank top-K candidates with an LLM (needs OPENAI_API_KEY)')
  .option('--json', 'emit JSON instead of formatted output')
  .action(async (query, opts) => {
    await searchCommand(query, opts);
  });

program
  .command('status')
  .description('Show watcher state, config, and chunk count')
  .action(async () => {
    await statusCommand();
  });

program
  .command('backfill')
  .description('Scan ~/.claude/projects and index any new sessions')
  .action(async () => {
    await backfillCommand();
  });

program
  .command('ui')
  .description('Serve a local search UI over your memory index (127.0.0.1 only)')
  .option('--port <n>', 'port to bind', '7777')
  .action(async (opts) => {
    await uiCommand(opts);
  });

program
  .command('mcp')
  .description('Run the MCP server (stdio) so Claude Code can search your sessions')
  .action(async () => {
    await mcpCommand();
  });

program
  .command('service')
  .description('Manage the launchd agents (macOS): install | uninstall | status')
  .argument('<action>', 'install, uninstall, or status')
  .option('--dry-run', 'print the plists that would be installed without touching launchctl')
  .action(async (action, opts) => {
    await serviceCommand(action, opts);
  });

program
  .command('wiki')
  .description('Compile dream chunks into a knowledge wiki: ingest | lint | status | reindex')
  .argument('<action>', 'ingest, lint, status, or reindex')
  .option('--repo <repo>', 'limit to a repo')
  .option('--since <date>', 'only units with activity after this ISO date')
  .option('--limit <n>', 'max units to compile this run', '20')
  .option('--owner <owner>', 'source owner (dream chunks) to compile from', 'derek')
  .option('--wiki-owner <owner>', 'owner to write wiki chunks under (default = --owner)')
  .option('--dry-run', 'print the compile plan + token estimate without calling the LLM or writing')
  .option('--llm', 'wiki lint: also run the LLM contradiction pass')
  .option('--json', 'emit JSON instead of formatted output')
  .action(async (action, opts) => {
    await wikiCommand(action, opts);
  });

program
  .command('synthesis-run', { hidden: true })
  .description('Headless dream → wiki compile over anything new (nightly agent / watcher hook)')
  .action(async () => {
    await synthesisRunCommand();
  });

program
  .command('dream')
  .description('Synthesize a dream-tier memory layer over raw chunks (incremental, fingerprinted)')
  .option('--repo <repo>', 'limit to a repo')
  .option('--since <date>', 'only units with activity after this ISO date')
  .option('--limit <n>', 'max units to synthesize this run', '20')
  .option('--owner <owner>', 'source owner to synthesize from', 'derek')
  .option('--dream-owner <owner>', 'owner to write dream chunks under (default = --owner)')
  .option('--dry-run', 'print the unit plan + token estimate without calling the LLM or writing')
  .option('--json', 'emit JSON instead of formatted output')
  .action(async (opts) => {
    await dreamCommand(opts);
  });

program
  .command('watch-internal', { hidden: true })
  .description('Long-running file watcher (used by launchd / dev.sh)')
  .action(async () => {
    await watchInternalCommand();
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
