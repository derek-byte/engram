import { describe, expect, test } from 'bun:test';
import { buildPlist, watcherSpec, synthesisSpec } from './service.ts';

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
