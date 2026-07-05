// Ask answer-quality eval: a citation-faithfulness judge for `engram ask`.
//
// MANUAL benchmark, never CI. It needs a live pgvector index + an OpenAI key and
// spends real money (one ask call + one judge call per question), so it is not
// wired into `bun test` and refuses to run when config is incomplete.
//
// This is a THIN CLI wrapper: it parses args, builds the real collaborators, and
// drives runAskEval (src/eval/askeval.ts) — the same core the hidden
// `engram askeval-run` command uses. The eval logic lives there; this file owns
// only argument parsing and the printed table / --json output.
//
//   bun benchmarks/askeval.ts [--questions <path>] [--from-demand <days>]
//                             [--limit N] [--judge-model <model>] [--json]

import { loadConfig } from '../src/config/index.ts';
import {
  runAskEval,
  buildAskEvalDeps,
  askEvalConfigError,
  DEFAULT_QUESTIONS,
  type AskEvalOpts,
  type QuestionReport,
} from '../src/eval/askeval.ts';

interface Args extends AskEvalOpts {
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { questionsPath: DEFAULT_QUESTIONS, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--questions') args.questionsPath = argv[++i]!;
    else if (a === '--from-demand') args.fromDemandDays = Number(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--judge-model') args.judgeModel = argv[++i];
    else if (a === '--json') args.json = true;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function printTable(reports: QuestionReport[]): void {
  const cols = [
    ['question', 40],
    ['outcome', 14],
    ['claims', 7],
    ['supp', 5],
    ['part', 5],
    ['unsup', 6],
    ['cited', 6],
  ] as const;
  const line = (cells: string[]) => cells.map((c, i) => pad(c, cols[i]![1])).join(' ');
  console.log('\n' + line(cols.map((c) => c[0])));
  console.log('-'.repeat(cols.reduce((a, c) => a + c[1] + 1, 0)));
  for (const r of reports) {
    console.log(
      line([
        r.question,
        r.outcome,
        String(r.claimCount),
        String(r.supported),
        String(r.partial),
        String(r.unsupported),
        String(r.citedSources),
      ])
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  // Refuse clearly when we cannot run: this is a paid, live-backend benchmark.
  const guard = askEvalConfigError(config);
  if (guard) {
    console.error(guard);
    process.exit(1);
  }

  const { deps, close } = await buildAskEvalDeps(config);

  let output;
  try {
    output = await runAskEval(args, deps, (i, n, label) => {
      console.error(`[${i}/${n}] ${label}`);
    });
  } finally {
    await close();
  }
  const { summary, reports } = output;

  if (args.json) {
    console.log(JSON.stringify({ summary, reports }, null, 2));
    return;
  }

  printTable(reports);

  console.log('\nAggregate');
  console.log('---------');
  console.log(`questions:        ${summary.questions} (answered ${summary.answered}, not-covered ${summary.notCovered}, errors ${summary.errors})`);
  console.log(`cited claims:     ${summary.totalClaims} (supported ${summary.supported}, partial ${summary.partial}, unsupported ${summary.unsupported})`);
  console.log(`faithfulness:     ${summary.faithfulnessPct}% supported  (+${summary.partialPct}% partial)`);
  console.log(`not-covered rate: ${summary.notCoveredPct}%`);
  console.log(`citation density: ${summary.citationDensity} cited sources / answered question`);
  console.log(
    `ask (${summary.askModel}):   ${summary.askTokens.promptTokens} in + ${summary.askTokens.completionTokens} out tok`
  );
  console.log(
    `judge (${summary.judgeModel}): ${summary.judgeTokens.promptTokens} in + ${summary.judgeTokens.completionTokens} out tok`
  );
  const costStr =
    summary.costUsd !== null ? `$${summary.costUsd.toFixed(4)}` : `${summary.totalTokens} tok (set PRICING for a $ estimate)`;
  console.log(`est. cost:        ${costStr}`);

  // Surface any unsupported/partial claims — the whole point of the eval.
  const flagged = reports.flatMap((r) =>
    r.judged.filter((v) => v.verdict !== 'supported').map((v) => ({ id: r.id, v }))
  );
  if (flagged.length > 0) {
    console.log('\nFlagged claims (partial/unsupported)');
    console.log('------------------------------------');
    for (const { id, v } of flagged) {
      console.log(`[${id}] ${v.verdict.toUpperCase()} ${v.indices.map((n) => `[${n}]`).join('')}: ${v.claim}`);
      console.log(`    ↳ ${v.reason}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
