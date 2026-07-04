import { describe, expect, test } from 'bun:test';
import { mergeConfig, CONTEXT_BUDGET_DEFAULT, CONTEXT_BUDGET_MIN, CONTEXT_BUDGET_MAX } from './index.ts';

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
