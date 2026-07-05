import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { indexPath } from './service.ts';

export interface HooksOptions {
  json?: boolean;
}

// Default target for the SessionStart hook. Overridable via ENGRAM_CLAUDE_SETTINGS
// so tests never touch the real ~/.claude/settings.json (mirrors the
// ENGRAM_CONFIG_PATH seam in src/config/index.ts).
export const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
function resolveSettingsPath(explicit?: string): string {
  return explicit ?? process.env.ENGRAM_CLAUDE_SETTINGS ?? CLAUDE_SETTINGS_PATH;
}

export interface HookStatus {
  installed: boolean;
  // Installed via a src/index.ts that is NOT the current checkout — a moved/renamed
  // repo left a stale hook that runs the wrong (or missing) engram.
  stalePath: boolean;
  path: string;
  // Set only when settings.json exists but does not parse as JSON.
  parseError?: boolean;
}

// Thrown by install/uninstall when settings.json exists but is not valid JSON.
// We REFUSE to touch a malformed file rather than clobber a user's config.
export class SettingsParseError extends Error {}

// The detection predicate, applied to a single hook command string: it invokes
// engram's `context` verb through some src/index.ts. `hookStatus` decides
// current-vs-stale by whether that path is the current checkout's indexPath().
function isEngramContextCommand(command: string): boolean {
  return command.includes(' context') && command.includes('src/index.ts');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Every SessionStart hook command string in a parsed settings object, defensively
// (the file is user-editable and may hold odd shapes).
function collectSessionStartCommands(parsed: unknown): string[] {
  const out: string[] = [];
  if (!isPlainObject(parsed)) return out;
  const hooks = parsed.hooks;
  if (!isPlainObject(hooks)) return out;
  const sessionStart = hooks.SessionStart;
  if (!Array.isArray(sessionStart)) return out;
  for (const entry of sessionStart) {
    if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) continue;
    for (const h of entry.hooks) {
      if (isPlainObject(h) && typeof h.command === 'string') out.push(h.command);
    }
  }
  return out;
}

function computeStatus(parsed: unknown, path: string): HookStatus {
  const current = indexPath();
  let installed = false;
  let currentMatch = false;
  for (const cmd of collectSessionStartCommands(parsed)) {
    if (!isEngramContextCommand(cmd)) continue;
    installed = true;
    if (cmd.includes(current)) currentMatch = true;
  }
  return { installed, stalePath: installed && !currentMatch, path };
}

// Read settings.json. Missing → treat as {} (installers create it). Present but
// malformed → SettingsParseError, so callers refuse rather than clobber. Returns
// the raw text too so callers can write a byte-exact backup before mutating.
function readSettings(path: string): { obj: Record<string, unknown>; raw: string | null } {
  if (!existsSync(path)) return { obj: {}, raw: null };
  const raw = readFileSync(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SettingsParseError('settings.json is malformed; fix it manually');
  }
  if (!isPlainObject(parsed)) {
    throw new SettingsParseError('settings.json is malformed; fix it manually');
  }
  return { obj: parsed, raw };
}

// A filename-safe ISO stamp: 2026-07-04T12:00:00.000Z → 2026-07-04T12-00-00-000Z.
function safeStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function writeBackup(path: string, raw: string): string {
  const backupPath = `${path}.engram-${safeStamp()}.bak`;
  writeFileSync(backupPath, raw);
  return backupPath;
}

export function hookStatus(settingsPath?: string): HookStatus {
  const path = resolveSettingsPath(settingsPath);
  if (!existsSync(path)) return { installed: false, stalePath: false, path };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { installed: false, stalePath: false, path, parseError: true };
  }
  return computeStatus(parsed, path);
}

export interface HookMutation {
  changed: boolean;
  backupPath?: string;
}

// Merge the SessionStart snippet into settings.json. Idempotent: a no-op (and NO
// backup) when a CURRENT hook is already present. A STALE hook (moved checkout /
// changed interpreter) is repaired in place — stale engram entries removed, the
// current snippet appended, one backup — otherwise the UI's install button would
// be a silent no-op forever on a stale install. A pre-existing file is backed up
// byte-for-byte before it is rewritten. Refuses a malformed file.
export function installHook(settingsPath?: string): HookMutation {
  const path = resolveSettingsPath(settingsPath);
  const { obj, raw } = readSettings(path);
  const status = computeStatus(obj, path);
  if (status.installed && !status.stalePath) return { changed: false };

  // Back up only a pre-existing file — nothing to preserve when we create it.
  const backupPath = raw !== null ? writeBackup(path, raw) : undefined;

  if (status.installed && status.stalePath) stripEngramEntries(obj);

  const hooks = isPlainObject(obj.hooks) ? obj.hooks : (obj.hooks = {});
  const sessionStart = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : (hooks.SessionStart = []);
  sessionStart.push(buildHookSnippet().hooks.SessionStart[0]);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2));
  return { changed: true, backupPath };
}

// Remove engram's SessionStart hook. Idempotent: a no-op (and NO backup) when not
// installed. Removes only matching inner hook commands; prunes an entry / the
// SessionStart array / the hooks object ONLY when this uninstall emptied it (a
// hooks block that also holds PreToolUse etc. is preserved). Refuses a malformed file.
export function uninstallHook(settingsPath?: string): HookMutation {
  const path = resolveSettingsPath(settingsPath);
  if (!existsSync(path)) return { changed: false };
  const { obj, raw } = readSettings(path);
  if (!computeStatus(obj, path).installed) return { changed: false };

  const backupPath = writeBackup(path, raw!);
  stripEngramEntries(obj);
  writeFileSync(path, JSON.stringify(obj, null, 2));
  return { changed: true, backupPath };
}

// Drop every SessionStart entry/inner hook whose command matches the engram
// predicate, pruning containers ONLY when this removal emptied them (a hooks
// block that also holds PreToolUse etc. is preserved). Shared by uninstall and
// the stale-repair path of install.
function stripEngramEntries(obj: Record<string, unknown>): void {
  if (!isPlainObject(obj.hooks)) return;
  const hooks = obj.hooks;
  if (!Array.isArray(hooks.SessionStart)) return;
  const keptEntries: unknown[] = [];
  for (const entry of hooks.SessionStart) {
    if (isPlainObject(entry) && Array.isArray(entry.hooks)) {
      const keptInner = entry.hooks.filter(
        (h) => !(isPlainObject(h) && typeof h.command === 'string' && isEngramContextCommand(h.command))
      );
      // An entry whose only hooks were engram's is dropped entirely.
      if (keptInner.length === 0) continue;
      entry.hooks = keptInner;
    }
    keptEntries.push(entry);
  }
  if (keptEntries.length === 0) delete hooks.SessionStart;
  else hooks.SessionStart = keptEntries;
  if (Object.keys(hooks).length === 0) delete obj.hooks;
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
  switch (action) {
    case 'print':
      return printHook(opts);
    case 'status':
      return statusHook(opts);
    case 'install':
      return runInstall(opts);
    case 'uninstall':
      return runUninstall(opts);
    default:
      throw new Error(`unknown hooks action: ${action} (expected install | uninstall | status | print)`);
  }
}

function statusHook(opts: HooksOptions): void {
  const st = hookStatus();
  if (opts.json) {
    console.log(JSON.stringify(st, null, 2));
    return;
  }
  console.log(`SessionStart hook (${st.path})`);
  if (st.parseError) {
    console.log('  status:  settings.json is malformed — cannot read (fix it manually)');
    return;
  }
  if (!st.installed) {
    console.log("  status:  not installed  (run 'engram hooks install')");
    return;
  }
  if (st.stalePath) {
    console.log("  status:  installed but STALE — points at a different src/index.ts");
    console.log("           re-run 'engram hooks install' after 'engram hooks uninstall'");
    return;
  }
  console.log('  status:  installed (current)');
}

function runInstall(opts: HooksOptions): void {
  const r = installHook();
  const st = hookStatus();
  if (opts.json) {
    console.log(JSON.stringify({ changed: r.changed, backupPath: r.backupPath, status: st }, null, 2));
    return;
  }
  if (!r.changed) {
    console.log(`SessionStart hook already installed (${st.path}) — no change.`);
    return;
  }
  console.log(`Installed SessionStart hook → ${st.path}`);
  if (r.backupPath) console.log(`  backup: ${r.backupPath}`);
}

function runUninstall(opts: HooksOptions): void {
  const r = uninstallHook();
  const st = hookStatus();
  if (opts.json) {
    console.log(JSON.stringify({ changed: r.changed, backupPath: r.backupPath, status: st }, null, 2));
    return;
  }
  if (!r.changed) {
    console.log(`SessionStart hook not installed (${st.path}) — no change.`);
    return;
  }
  console.log(`Removed SessionStart hook from ${st.path}`);
  if (r.backupPath) console.log(`  backup: ${r.backupPath}`);
}

function printHook(opts: HooksOptions): void {
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

Knobs (in ~/.engram/config.json — no need to touch this hook again)
  "contextInjection": { "enabled": false }   turn injection off; the hook stays
                   installed and prints nothing until you flip it back
  "contextInjection": { "budget": 800 }      shrink the injected block
                   (default ~1500 tokens; --budget flag overrides per-run)
  matcher          add |resume|compact to re-inject on resume / after compaction
                   (they keep their own transcript/summary, so that's usually
                   redundant — start with startup|clear)

Preview what a session would see:
  ${process.execPath} ${indexPath()} context --cwd "$PWD"`);
}
