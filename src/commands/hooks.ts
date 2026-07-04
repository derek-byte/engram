import { indexPath } from './service.ts';

export interface HooksOptions {
  json?: boolean;
}

// Build the SessionStart hook snippet for ~/.claude/settings.json. Schema
// verified against the official docs (code.claude.com/docs/en/hooks):
// hooks.SessionStart is an array of { matcher, hooks: [{ type, command, timeout }] };
// on exit 0 the command's plain stdout is added as session context; SessionStart
// cannot block; the command runs via shell with $CLAUDE_PROJECT_DIR exported.
export function buildHookSnippet(): {
  hooks: { SessionStart: Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout: number }> }> };
} {
  const command = `${process.execPath} ${indexPath()} context --cwd "$CLAUDE_PROJECT_DIR"`;
  return {
    hooks: {
      SessionStart: [
        {
          matcher: 'startup|clear',
          hooks: [{ type: 'command', command, timeout: 10 }],
        },
      ],
    },
  };
}

export async function hooksCommand(action: string, opts: HooksOptions): Promise<void> {
  if (action !== 'print') {
    throw new Error(`unknown hooks action: ${action} (expected 'print')`);
  }

  const snippet = buildHookSnippet();
  const json = JSON.stringify(snippet, null, 2);

  if (opts.json) {
    console.log(json);
    return;
  }

  console.log(`# engram context — SessionStart hook

Every new Claude Code session starts already knowing what you decided in this
repo. Merge the snippet below into your settings.json "hooks" block:

${json}

How it works
  On session start Claude Code runs the command; its stdout (a compact markdown
  block of relevant wiki pages + recent decisions/gotchas) is injected as context.
  The command is silent-empty — a repo with no engram knowledge prints nothing,
  so no session ever gets noise. It exits 0 even on error, so it can't break a start.

Where to put it
  Global (all projects):   ~/.claude/settings.json
  Per-project (this repo): .claude/settings.json   (checked in or gitignored)

Knobs
  --budget 800     shrink the injected block (default ~1500 tokens)
  matcher          add |resume|compact to re-inject on resume / after compaction
                   (they keep their own transcript/summary, so that's usually
                   redundant — start with startup|clear)

Preview what a session would see:
  ${process.execPath} ${indexPath()} context --cwd "$PWD"`);
}
