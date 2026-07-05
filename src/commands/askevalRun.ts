import { loadConfig } from '../config/index.ts';
import { LocalStore } from '../storage/local.ts';
import {
  runAskEval,
  buildAskEvalDeps,
  askEvalConfigError,
  type AskEvalDeps,
  type AskEvalOpts,
} from '../eval/askeval.ts';
import type { EngramConfig } from '../types/index.ts';

// One JSON line per phase, synthesis-run style: {at, phase, ...data}.
function log(phase: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), phase, ...data }));
}

// Injectable seams (all optional; real defaults below). Same philosophy as
// synthesisRunCommand: the command is a thin wire-up so its lifecycle — guard,
// run-row bookkeeping, per-question streaming, error handling — is testable
// without a live pg backend or a paid LLM.
export interface AskevalRunDeps {
  config?: EngramConfig;
  local?: LocalStore;
  build?: (config: EngramConfig) => Promise<{ deps: AskEvalDeps; close: () => Promise<void> }>;
  run?: typeof runAskEval;
  log?: (phase: string, data: Record<string, unknown>) => void;
}

// Hidden headless command: runs the ask-quality eval end to end and streams one
// JSON line per question plus a final {phase:'done', summary}. Records the run
// lifecycle to askeval_runs (start at launch, finish with summary+reports on
// completion / error). This is what the UI's job runner spawns.
export async function askevalRunCommand(opts: AskEvalOpts = {}, deps: AskevalRunDeps = {}): Promise<void> {
  const lg = deps.log ?? log;
  const config = deps.config ?? loadConfig();

  // Guard BEFORE opening a run row, so a misconfigured launch leaves no orphan.
  const guard = askEvalConfigError(config);
  if (guard) {
    lg('error', { message: guard });
    process.exit(1);
  }

  const build = deps.build ?? buildAskEvalDeps;
  const run = deps.run ?? runAskEval;
  const ownsLocal = !deps.local;
  const local = deps.local ?? new LocalStore();
  const id = local.startAskevalRun();

  let close: (() => Promise<void>) | undefined;
  try {
    const built = await build(config);
    close = built.close;
    const { summary, reports } = await run(opts, built.deps, (i, n, label, report) => {
      lg('question', {
        i,
        of: n,
        label,
        outcome: report?.outcome,
        supported: report?.supported,
        partial: report?.partial,
        unsupported: report?.unsupported,
      });
    });
    local.finishAskevalRun(id, 'done', summary, reports);
    lg('done', { summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    local.finishAskevalRun(id, 'error', { error: message });
    lg('error', { message });
    process.exitCode = 1;
  } finally {
    if (close) await close();
    if (ownsLocal) local.close();
  }
}
