import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ENGRAM_DIR, ensureEngramDir } from '../config/index.ts';

const LABEL = 'com.engram.watcher';
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const WATCHER_LOG = join(ENGRAM_DIR, 'watcher.log');

function repoRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
}

function domainTarget(): string {
  return `gui/${process.getuid?.() ?? ''}`;
}

function serviceTarget(): string {
  return `${domainTarget()}/${LABEL}`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function launchctl(args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync('launchctl', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}` };
  }
}

function buildPlist(): string {
  const bun = process.execPath;
  const index = join(repoRoot(), 'src', 'index.ts');
  const path = `${dirname(bun)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(bun)}</string>
    <string>${escapeXml(index)}</string>
    <string>watch-internal</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${escapeXml(repoRoot())}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(WATCHER_LOG)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(WATCHER_LOG)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(path)}</string>
  </dict>
</dict>
</plist>
`;
}

function unloadExisting(): void {
  // Modern form first, then the pre-bootstrap fallback. Both ignore not-loaded.
  launchctl(['bootout', serviceTarget()]);
  // No -w: that would persist a disabled override that survives uninstall
  // and makes every future bootstrap fail.
  if (existsSync(PLIST_PATH)) launchctl(['unload', PLIST_PATH]);
}

function install(): void {
  const dir = dirname(PLIST_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  ensureEngramDir();

  unloadExisting();
  writeFileSync(PLIST_PATH, buildPlist());

  // Clear any stale disabled override (older installs, manual `launchctl disable`).
  launchctl(['enable', serviceTarget()]);
  const boot = launchctl(['bootstrap', domainTarget(), PLIST_PATH]);
  if (!boot.ok) {
    const legacy = launchctl(['load', '-w', PLIST_PATH]);
    if (!legacy.ok) {
      console.error(`Failed to load service:\n${boot.out}\n${legacy.out}`);
      process.exit(1);
    }
  }

  console.log(`Installed ${LABEL}`);
  console.log(`  plist:  ${PLIST_PATH}`);
  console.log(`  runs:   ${process.execPath} ${join(repoRoot(), 'src', 'index.ts')} watch-internal`);
  console.log(`  cwd:    ${repoRoot()}`);
  console.log(`  log:    ${WATCHER_LOG}`);
  console.log(`\nCheck it with: engram service status`);
}

function uninstall(): void {
  unloadExisting();
  if (existsSync(PLIST_PATH)) {
    unlinkSync(PLIST_PATH);
    console.log(`Uninstalled ${LABEL} (removed ${PLIST_PATH})`);
  } else {
    console.log(`${LABEL} was not installed (no plist at ${PLIST_PATH})`);
  }
}

function status(): void {
  const print = launchctl(['print', serviceTarget()]);
  if (print.ok) {
    const state = print.out.match(/state = (\S+)/)?.[1] ?? 'unknown';
    const pid = print.out.match(/pid = (\d+)/)?.[1];
    console.log(`service:  loaded (state ${state}${pid ? `, pid ${pid}` : ''})`);
  } else {
    console.log('service:  not loaded');
  }
  console.log(`plist:    ${existsSync(PLIST_PATH) ? PLIST_PATH : 'absent'}`);
  console.log(`log:      ${WATCHER_LOG}`);

  if (existsSync(WATCHER_LOG)) {
    const lines = readFileSync(WATCHER_LOG, 'utf-8').split('\n').filter(Boolean).slice(-15);
    if (lines.length) {
      console.log('\nlast log lines:');
      for (const l of lines) console.log(`  ${l}`);
    }
  }
}

export async function serviceCommand(action: string): Promise<void> {
  if (process.platform !== 'darwin') {
    console.error('engram service uses launchd and is only supported on macOS.');
    process.exit(1);
  }

  switch (action) {
    case 'install':
      install();
      break;
    case 'uninstall':
      uninstall();
      break;
    case 'status':
      status();
      break;
    default:
      console.error(`Unknown action '${action}'. Use: install | uninstall | status`);
      process.exit(1);
  }
}
