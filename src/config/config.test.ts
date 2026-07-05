import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mergeConfig,
  patchConfigFile,
  CONTEXT_BUDGET_DEFAULT,
  CONTEXT_BUDGET_MIN,
  CONTEXT_BUDGET_MAX,
  TARGETED_SESSIONS_DEFAULT,
} from './index.ts';

describe('mergeConfig contextInjection', () => {
  test('defaults to enabled with the default budget when the block is absent', () => {
    const config = mergeConfig({});
    expect(config.contextInjection.enabled).toBe(true);
    expect(config.contextInjection.budget).toBe(CONTEXT_BUDGET_DEFAULT);
  });

  test('enabled=false is respected (the kill switch)', () => {
    const config = mergeConfig({ contextInjection: { enabled: false, budget: 800 } });
    expect(config.contextInjection.enabled).toBe(false);
    expect(config.contextInjection.budget).toBe(800);
  });

  test('partial block keeps defaults for missing keys', () => {
    const config = mergeConfig({ contextInjection: { enabled: false } } as never);
    expect(config.contextInjection.enabled).toBe(false);
    expect(config.contextInjection.budget).toBe(CONTEXT_BUDGET_DEFAULT);
  });

  test('budget is clamped and non-numeric budget falls back to the default', () => {
    expect(mergeConfig({ contextInjection: { enabled: true, budget: 5 } }).contextInjection.budget).toBe(CONTEXT_BUDGET_MIN);
    expect(mergeConfig({ contextInjection: { enabled: true, budget: 10_000_000 } }).contextInjection.budget).toBe(CONTEXT_BUDGET_MAX);
    expect(mergeConfig({ contextInjection: { enabled: true, budget: 'lots' as never } }).contextInjection.budget).toBe(CONTEXT_BUDGET_DEFAULT);
  });

  test('truthy non-boolean enabled coerces like the synthesis block', () => {
    const config = mergeConfig({ contextInjection: { enabled: 1 as never, budget: 1500 } });
    expect(config.contextInjection.enabled).toBe(true);
  });
});

describe('synthesis targetedSessionsPerNight', () => {
  let configPath: string;

  function patch(synthesis: Record<string, unknown>): Record<string, unknown> {
    configPath = join(tmpdir(), `engram-cfg-targeted-${crypto.randomUUID()}.json`);
    process.env.ENGRAM_CONFIG_PATH = configPath;
    writeFileSync(configPath, JSON.stringify({ synthesis: { enabled: true, hour: 5 } }));
    const raw = patchConfigFile({ synthesis });
    return raw.synthesis as Record<string, unknown>;
  }

  afterEach(() => {
    delete process.env.ENGRAM_CONFIG_PATH;
    try { rmSync(configPath, { force: true }); } catch { /* best effort */ }
  });

  test('absent key merges to the default of 5', () => {
    expect(mergeConfig({}).synthesis.targetedSessionsPerNight).toBe(TARGETED_SESSIONS_DEFAULT);
    expect(TARGETED_SESSIONS_DEFAULT).toBe(5);
  });

  test('patchConfigFile clamps above-max to 20', () => {
    const syn = patch({ targetedSessionsPerNight: 99 });
    expect(syn.targetedSessionsPerNight).toBe(20);
    // Siblings preserved.
    expect(syn.enabled).toBe(true);
    expect(syn.hour).toBe(5);
  });

  test('patchConfigFile clamps a negative value to 0', () => {
    expect(patch({ targetedSessionsPerNight: -3 }).targetedSessionsPerNight).toBe(0);
  });

  test('patchConfigFile falls back to the default on a non-numeric value (not an error)', () => {
    expect(patch({ targetedSessionsPerNight: 'x' }).targetedSessionsPerNight).toBe(TARGETED_SESSIONS_DEFAULT);
  });
});
