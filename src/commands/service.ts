import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ENGRAM_DIR, ensureEngramDir, loadConfig } from '../config/index.ts';

const WATCHER_LABEL = 'com.engram.watcher';
const SYNTHESIS_LABEL = 'com.engram.synthesis';

export interface AgentSpec {
  label: string;
  plistPath: string;
  programArgs: string[];
  log: string;
  // Present ⇒ StartCalendarInterval at the given hour (nightly); absent ⇒ KeepAlive.
  schedule?: { hour: number };
}

function repoRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
}

function plistPathFor(label: string): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
}

function indexPath(): string {
  return join(repoRoot(), 'src', 'index.ts');
}

export function watcherSpec(): AgentSpec {
  return {
    label: WATCHER_LABEL,
    plistPath: plistPathFor(WATCHER_LABEL),
    programArgs: [process.execPath, indexPath(), 'watch-internal'],
    log: join(ENGRAM_DIR, 'watcher.log'),
  };
}

export function synthesisSpec(hour: number): AgentSpec {
  return {
    label: SYNTHESIS_LABEL,
    plistPath: plistPathFor(SYNTHESIS_LABEL),
    programArgs: [process.execPath, indexPath(), 'synthesis-run'],
    log: join(ENGRAM_DIR, 'synthesis.log'),
    schedule: { hour },
  };
}

function domainTarget(): string {
  return `gui/${process.getuid?.() ?? ''}`;
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

// Generic plist builder. A schedule ⇒ RunAtLoad false + StartCalendarInterval;
// otherwise RunAtLoad true + KeepAlive (the always-on watcher). Exported so a
// unit test can assert the generated XML without touching launchctl.
export function buildPlist(spec: AgentSpec): string {
  const bun = spec.programArgs[0]!;
  const path = `${dirname(bun)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  const args = spec.programArgs.map((a) => `    <string>${escapeXml(a)}</string>`).join('\n');
  const lifecycle = spec.schedule
    ? `  <key>RunAtLoad</key>
  <false/>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${spec.schedule.hour}</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>`
    : `  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${spec.label}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
${lifecycle}
  <key>WorkingDirectory</key>
  <string>${escapeXml(repoRoot())}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(spec.log)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(spec.log)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(path)}</string>
  </dict>
</dict>
</plist>
`;
}

function serviceTarget(label: string): string {
  return `${domainTarget()}/${label}`;
}

function unloadExisting(spec: AgentSpec): void {
  launchctl(['bootout', serviceTarget(spec.label)]);
  if (existsSync(spec.plistPath)) launchctl(['unload', spec.plistPath]);
}

function installAgent(spec: AgentSpec): void {
  const dir = dirname(spec.plistPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  ensureEngramDir();
  unloadExisting(spec);
  writeFileSync(spec.plistPath, buildPlist(spec));
  launchctl(['enable', serviceTarget(spec.label)]);
  const boot = launchctl(['bootstrap', domainTarget(), spec.plistPath]);
  if (!boot.ok) {
    const legacy = launchctl(['load', '-w', spec.plistPath]);
    if (!legacy.ok) {
      console.error(`Failed to load ${spec.label}:\n${boot.out}\n${legacy.out}`);
      process.exit(1);
    }
  }
  console.log(`Installed ${spec.label}`);
  console.log(`  plist:  ${spec.plistPath}`);
  console.log(`  runs:   ${spec.programArgs.join(' ')}`);
  if (spec.schedule) console.log(`  when:   daily at ${String(spec.schedule.hour).padStart(2, '0')}:00`);
  console.log(`  log:    ${spec.log}`);
}

function uninstallAgent(spec: AgentSpec): void {
  unloadExisting(spec);
  if (existsSync(spec.plistPath)) {
    unlinkSync(spec.plistPath);
    console.log(`Uninstalled ${spec.label} (removed ${spec.plistPath})`);
  } else {
    console.log(`${spec.label} was not installed (no plist at ${spec.plistPath})`);
  }
}

function statusLine(spec: AgentSpec): void {
  const print = launchctl(['print', serviceTarget(spec.label)]);
  console.log(`\n${spec.label}`);
  if (print.ok) {
    const state = print.out.match(/state = (\S+)/)?.[1] ?? 'unknown';
    const pid = print.out.match(/pid = (\d+)/)?.[1];
    console.log(`  service:  loaded (state ${state}${pid ? `, pid ${pid}` : ''})`);
  } else {
    console.log('  service:  not loaded');
  }
  console.log(`  plist:    ${existsSync(spec.plistPath) ? spec.plistPath : 'absent'}`);
  if (spec.schedule) console.log(`  when:     daily at ${String(spec.schedule.hour).padStart(2, '0')}:00`);
  console.log(`  log:      ${spec.log}`);
  if (existsSync(spec.log)) {
    const lines = readFileSync(spec.log, 'utf-8').split('\n').filter(Boolean).slice(-8);
    for (const l of lines) console.log(`    ${l}`);
  }
}

export interface ServiceOptions {
  dryRun?: boolean;
}

export async function serviceCommand(action: string, opts: ServiceOptions = {}): Promise<void> {
  if (process.platform !== 'darwin') {
    console.error('engram service uses launchd and is only supported on macOS.');
    process.exit(1);
  }

  const config = loadConfig();
  const watcher = watcherSpec();
  const synthesis = synthesisSpec(config.synthesis.hour);

  switch (action) {
    case 'install': {
      if (opts.dryRun) {
        // Emit the plists that WOULD be installed — watcher always, synthesis iff
        // enabled — without ever calling launchctl.
        console.log(`# ${watcher.label} (${watcher.plistPath})`);
        console.log(buildPlist(watcher));
        if (config.synthesis.enabled) {
          console.log(`# ${synthesis.label} (${synthesis.plistPath})`);
          console.log(buildPlist(synthesis));
        } else {
          console.log(`# ${synthesis.label}: disabled (synthesis.enabled=false) — would be removed if present`);
        }
        return;
      }
      installAgent(watcher);
      if (config.synthesis.enabled) {
        installAgent(synthesis);
      } else {
        // Toggle-off + install must remove a previously-installed synthesis agent.
        if (existsSync(synthesis.plistPath)) uninstallAgent(synthesis);
      }
      console.log(`\nCheck it with: engram service status`);
      break;
    }
    case 'uninstall':
      uninstallAgent(watcher);
      uninstallAgent(synthesis);
      break;
    case 'status':
      statusLine(watcher);
      statusLine(synthesis);
      break;
    default:
      console.error(`Unknown action '${action}'. Use: install | uninstall | status`);
      process.exit(1);
  }
}
