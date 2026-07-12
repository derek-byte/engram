import { describe, expect, test } from 'bun:test';
import type { ImageCaptionConfig, Trajectory, TrajectoryImage } from '../types/index.ts';
import { placeholderCaption, resolveCaptions, type CaptionClient } from './caption.ts';
import { FakeBackend } from './testkit.ts';

const MODEL = 'fake-caption-model';

function cfg(over: Partial<ImageCaptionConfig> = {}): ImageCaptionConfig {
  return { enabled: true, model: MODEL, maxPerTrajectory: 4, ...over };
}

function img(sha: string, caption = ''): TrajectoryImage {
  return { sha256: sha, mediaType: 'image/png', bytes: 214 * 1024, caption };
}

function traj(images: TrajectoryImage[]): Trajectory {
  return {
    sessionId: 's',
    repo: 'r',
    branch: 'b',
    cwd: '/c',
    timestamp: new Date(0),
    userMessage: 'q',
    assistantBlocks: [],
    thinkingBlocks: [],
    images,
    toolCalls: [],
    filePaths: [],
    artifacts: [],
    exitCode: null,
  };
}

// Counting fake vision client. Returns a fixed caption or throws.
class FakeCaptionClient implements CaptionClient {
  calls = 0;
  constructor(private behavior: 'ok' | 'throw', private text = 'a captioned image') {}
  chat = {
    completions: {
      create: async () => {
        this.calls++;
        if (this.behavior === 'throw') throw new Error('vision boom');
        return { choices: [{ message: { content: this.text } }] };
      },
    },
  };
}

function dataMap(shas: string[]): Map<string, { mediaType: string; data: string }> {
  const m = new Map<string, { mediaType: string; data: string }>();
  for (const sha of shas) m.set(sha, { mediaType: 'image/png', data: 'YWJj' });
  return m;
}

describe('resolveCaptions', () => {
  test('disabled config → placeholder, client never called', async () => {
    const backend = new FakeBackend();
    const client = new FakeCaptionClient('ok');
    const t = traj([img('s1')]);
    await resolveCaptions([t], dataMap(['s1']), { cache: backend, config: cfg({ enabled: false }), client });
    expect(t.images[0]!.caption).toBe(placeholderCaption('image/png', 214 * 1024));
    expect(client.calls).toBe(0);
    expect(backend.putCaptionCalls).toBe(0);
  });

  test('null client → placeholder, no throw', async () => {
    const backend = new FakeBackend();
    const t = traj([img('s1')]);
    await resolveCaptions([t], dataMap(['s1']), { cache: backend, config: cfg(), client: null });
    expect(t.images[0]!.caption).toBe(placeholderCaption('image/png', 214 * 1024));
  });

  test('cache hit skips the client entirely', async () => {
    const backend = new FakeBackend();
    backend.seedCaption('s1', MODEL, 'cached caption');
    const client = new FakeCaptionClient('ok');
    const t = traj([img('s1')]);
    await resolveCaptions([t], dataMap(['s1']), { cache: backend, config: cfg(), client });
    expect(t.images[0]!.caption).toBe('cached caption');
    expect(client.calls).toBe(0);
  });

  test('maxPerTrajectory caps LLM calls; the rest get placeholders', async () => {
    const backend = new FakeBackend();
    const client = new FakeCaptionClient('ok');
    const t = traj([img('s1'), img('s2'), img('s3')]);
    await resolveCaptions([t], dataMap(['s1', 's2', 's3']), { cache: backend, config: cfg({ maxPerTrajectory: 2 }), client });
    expect(client.calls).toBe(2);
    expect(t.images[0]!.caption).toBe('a captioned image');
    expect(t.images[1]!.caption).toBe('a captioned image');
    expect(t.images[2]!.caption).toBe(placeholderCaption('image/png', 214 * 1024));
  });

  test('client throw → placeholder, no exception, nothing cached', async () => {
    const backend = new FakeBackend();
    const client = new FakeCaptionClient('throw');
    const t = traj([img('s1')]);
    await resolveCaptions([t], dataMap(['s1']), { cache: backend, config: cfg(), client });
    expect(t.images[0]!.caption).toBe(placeholderCaption('image/png', 214 * 1024));
    expect(backend.putCaptionCalls).toBe(0);
  });

  test('successful captions are cached; placeholders are not', async () => {
    const backend = new FakeBackend();
    const client = new FakeCaptionClient('ok');
    // s1 is captionable (bytes present); s2 has no bytes → placeholder.
    const t = traj([img('s1'), img('s2')]);
    await resolveCaptions([t], dataMap(['s1']), { cache: backend, config: cfg(), client });
    expect(t.images[0]!.caption).toBe('a captioned image');
    expect(t.images[1]!.caption).toBe(placeholderCaption('image/png', 214 * 1024));

    // Only s1 landed in the cache.
    const cached = await backend.getCachedCaptions(['s1', 's2'], MODEL);
    expect(cached.get('s1')).toBe('a captioned image');
    expect(cached.has('s2')).toBe(false);
  });
});
