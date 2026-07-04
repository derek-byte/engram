import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPlist,
  watcherSpec,
  synthesisSpec,
  agentStatus,
  restartAgent,
  isKnownServiceLabel,
  type AgentSpec,
} from './service.ts';

describe('buildPlist', () => {
  test('watcher agent: RunAtLoad + KeepAlive, no schedule', () => {
    const xml = buildPlist(watcherSpec());
    expect(xml).toContain('<string>com.engram.watcher</string>');
    expect(xml).toContain('<key>KeepAlive</key>');
    expect(xml).toContain('watch-internal');
    expect(xml).not.toContain('StartCalendarInterval');
  });

  test('synthesis agent: StartCalendarInterval at the configured hour, no KeepAlive', () => {
    const xml = buildPlist(synthesisSpec(3));
    expect(xml).toContain('<string>com.engram.synthesis</string>');
    expect(xml).toContain('<key>StartCalendarInterval</key>');
    expect(xml).toContain('<key>Hour</key>\n    <integer>3</integer>');
    expect(xml).toContain('<key>Minute</key>\n    <integer>0</integer>');
    expect(xml).toContain('synthesis-run');
    expect(xml).toContain('<key>RunAtLoad</key>\n  <false/>');
    expect(xml).not.toContain('<key>KeepAlive</key>');
  });

  test('hour is honored', () => {
    expect(buildPlist(synthesisSpec(9))).toContain('<key>Hour</key>\n    <integer>9</integer>');
  });

  test('escapes XML metacharacters in program args', () => {
    const xml = buildPlist({ label: 'l', plistPath: '/tmp/l.plist', programArgs: ['/bin/a&b', 'x<y'], log: '/tmp/l.log' });
    expect(xml).toContain('/bin/a&amp;b');
    expect(xml).toContain('x&lt;y');
  });
});

describe('service labels', () => {
  test('isKnownServiceLabel recognizes only the two engram agents', () => {
    expect(isKnownServiceLabel('com.engram.watcher')).toBe(true);
    expect(isKnownServiceLabel('com.engram.synthesis')).toBe(true);
    expect(isKnownServiceLabel('com.engram.evil')).toBe(false);
    expect(isKnownServiceLabel('')).toBe(false);
  });

  test('restartAgent rejects an unknown label before touching launchctl', () => {
    expect(() => restartAgent('com.evil.service')).toThrow(/unknown service label/);
  });
});

describe('agentStatus', () => {
  // A synthetic label that is never loaded, so launchctl print returns not-loaded
  // deterministically without reading (or touching) the real engram agents.
  const plistPath = join(tmpdir(), `engram-svc-test-${crypto.randomUUID()}.plist`);
  const spec: AgentSpec = { label: 'com.engram.unit-test-nonexistent', plistPath, programArgs: ['/bin/true'], log: '/tmp/x.log' };
  afterEach(() => {
    try { rmSync(plistPath, { force: true }); } catch { /* best effort */ }
  });

  test('reports not-loaded and reflects plist presence', () => {
    const before = agentStatus(spec);
    expect(before.label).toBe(spec.label);
    expect(before.loaded).toBe(false);
    expect(before.state).toBeNull();
    expect(before.pid).toBeNull();
    expect(before.plistPresent).toBe(false);

    writeFileSync(plistPath, '<plist/>');
    expect(agentStatus(spec).plistPresent).toBe(true);
  });
});
