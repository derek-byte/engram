import { describe, expect, test } from 'bun:test';
import type { Artifact, ToolCall } from '../types/index.ts';
import { MAX_ARTIFACTS, collectArtifacts, dedupeArtifacts, extractArtifacts } from './artifacts.ts';
import { chunkTrajectory } from './chunker.ts';
import { chunkHash, trajectoryHash } from './hash.ts';
import { genTrajectory, rng } from './testkit.ts';

describe('extractArtifacts — file rule (writer-tool inputs only)', () => {
  test('writer tools yield file artifacts from file_path/path/notebook_path', () => {
    expect(extractArtifacts('Write', { file_path: '/a.ts' }, undefined)).toEqual([
      { kind: 'file', ref: '/a.ts', tool: 'Write' },
    ]);
    expect(extractArtifacts('Edit', { file_path: '/b.ts' }, undefined)).toEqual([
      { kind: 'file', ref: '/b.ts', tool: 'Edit' },
    ]);
    expect(extractArtifacts('MultiEdit', { file_path: '/c.ts' }, undefined)).toEqual([
      { kind: 'file', ref: '/c.ts', tool: 'MultiEdit' },
    ]);
    expect(extractArtifacts('NotebookEdit', { notebook_path: '/d.ipynb' }, undefined)).toEqual([
      { kind: 'file', ref: '/d.ipynb', tool: 'NotebookEdit' },
    ]);
  });

  test('reader tools produce nothing — paths are consumed, not produced', () => {
    expect(extractArtifacts('Read', { file_path: '/a.ts' }, undefined)).toEqual([]);
    expect(extractArtifacts('Grep', { path: '/src' }, undefined)).toEqual([]);
    expect(extractArtifacts('Glob', { path: '/src' }, undefined)).toEqual([]);
  });

  test('missing/empty path or non-object input yields nothing', () => {
    expect(extractArtifacts('Write', {}, undefined)).toEqual([]);
    expect(extractArtifacts('Write', { file_path: '' }, undefined)).toEqual([]);
    expect(extractArtifacts('Write', undefined, undefined)).toEqual([]);
    expect(extractArtifacts('Write', 'not-an-object', undefined)).toEqual([]);
  });
});

describe('extractArtifacts — URL rule (tool outputs only)', () => {
  test('github pull-request URL classifies as pr, other URLs as url', () => {
    expect(extractArtifacts('Bash', undefined, 'https://github.com/o/r/pull/42')).toEqual([
      { kind: 'pr', ref: 'https://github.com/o/r/pull/42', tool: 'Bash' },
    ]);
    expect(extractArtifacts('Bash', undefined, 'see https://example.com/docs')).toEqual([
      { kind: 'url', ref: 'https://example.com/docs', tool: 'Bash' },
    ]);
  });

  test('host denylist drops loopback + the embedding API', () => {
    const out =
      'http://localhost:3000/x http://127.0.0.1:5432 http://0.0.0.0:8080 http://[::1]:9 https://api.openai.com/v1';
    expect(extractArtifacts('Bash', undefined, out)).toEqual([]);
  });

  test('a malformed URL match is skipped rather than thrown', () => {
    expect(extractArtifacts('Bash', undefined, 'http://')).toEqual([]);
  });
});

describe('extractArtifacts — combined single call', () => {
  test('a writer call with a URL in its output yields both', () => {
    const got = extractArtifacts('Write', { file_path: '/a.ts' }, 'wrote https://github.com/o/r/pull/7');
    expect(got).toEqual([
      { kind: 'file', ref: '/a.ts', tool: 'Write' },
      { kind: 'pr', ref: 'https://github.com/o/r/pull/7', tool: 'Write' },
    ]);
  });
});

describe('dedupeArtifacts', () => {
  test('dedupes by ref, first occurrence wins', () => {
    const arts: Artifact[] = [
      { kind: 'file', ref: '/a.ts', tool: 'Write' },
      { kind: 'file', ref: '/a.ts', tool: 'Edit' },
      { kind: 'url', ref: 'https://x.com', tool: 'Bash' },
    ];
    expect(dedupeArtifacts(arts)).toEqual([
      { kind: 'file', ref: '/a.ts', tool: 'Write' },
      { kind: 'url', ref: 'https://x.com', tool: 'Bash' },
    ]);
  });

  test('caps at MAX_ARTIFACTS distinct refs', () => {
    const arts: Artifact[] = Array.from({ length: MAX_ARTIFACTS + 10 }, (_, i) => ({
      kind: 'file' as const,
      ref: `/f${i}.ts`,
      tool: 'Write',
    }));
    const out = dedupeArtifacts(arts);
    expect(out).toHaveLength(MAX_ARTIFACTS);
    expect(out[0]!.ref).toBe('/f0.ts');
    expect(out[MAX_ARTIFACTS - 1]!.ref).toBe(`/f${MAX_ARTIFACTS - 1}.ts`);
  });
});

describe('collectArtifacts — over a trajectory ToolCall[]', () => {
  test('acceptance: Write + Read + Bash(gh pr create + localhost) → [file, pr]', () => {
    const toolCalls: ToolCall[] = [
      { name: 'Write', input: { file_path: '/src/x.ts' } },
      { name: 'Read', input: { file_path: '/src/y.ts' } },
      {
        name: 'Bash',
        input: { command: 'gh pr create' },
        output:
          'https://github.com/acme/engram/pull/99\nlocal preview at http://localhost:3000/pr',
      },
    ];
    expect(collectArtifacts(toolCalls)).toEqual([
      { kind: 'file', ref: '/src/x.ts', tool: 'Write' },
      { kind: 'pr', ref: 'https://github.com/acme/engram/pull/99', tool: 'Bash' },
    ]);
  });
});

// --- Sacred invariants ------------------------------------------------------

describe('hash invariance: artifacts live in metadata, never in the hashed identity', () => {
  test('trajectoryHash is byte-identical before/after artifacts are added', () => {
    const t = genTrajectory(rng(7));
    const before = trajectoryHash(t);
    const withArtifacts = {
      ...t,
      artifacts: [{ kind: 'file' as const, ref: '/added.ts', tool: 'Write' }],
    };
    expect(trajectoryHash(withArtifacts)).toBe(before);
  });

  test('chunk ids are unchanged by artifacts (content-only)', () => {
    const t = genTrajectory(rng(11), 2);
    const withArtifacts = {
      ...t,
      artifacts: [{ kind: 'url' as const, ref: 'https://x.com', tool: 'Bash' }],
    };
    const idsOf = (traj: typeof t) => {
      const trajId = trajectoryHash(traj);
      return chunkTrajectory(traj).map((text, i) => chunkHash(trajId, i, text));
    };
    expect(idsOf(withArtifacts)).toEqual(idsOf(t));
  });
});

describe('pathological outputs stay bounded', () => {
  test('a multi-MB output dense with distinct URLs caps at MAX_ARTIFACTS without throwing', () => {
    // ~200k distinct URLs (~5MB). Pre-fix this materialized an unbounded match
    // array and blew the spread-push arg limit; now matchAll + early exit.
    let out = '';
    for (let i = 0; i < 200_000; i++) out += `https://example.com/r/${i} `;
    const arts = extractArtifacts('Bash', undefined, out);
    expect(arts.length).toBe(MAX_ARTIFACTS);
    expect(arts[0]).toEqual({ kind: 'url', ref: 'https://example.com/r/0', tool: 'Bash' });
  });
});
