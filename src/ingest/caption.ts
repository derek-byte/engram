import OpenAI from 'openai';
import type { EngramConfig, ImageCaptionConfig, Trajectory } from '../types/index.ts';
import type { CaptionCache } from '../storage/backend.ts';
import { REQUEST_TIMEOUT_MS, modelParams, withRetry } from '../llm/shared.ts';

// Mirrors RERANK_DEFAULTS: on by default, but every path is fail-safe — no key,
// disabled config, or LLM error → placeholder caption, never a throw.
export const IMAGE_CAPTION_DEFAULTS: ImageCaptionConfig = {
  enabled: true,
  model: 'gpt-4o-mini',
  maxPerTrajectory: 4,
};

// Rendered as `IMAGE: [uncaptioned image/png, 214 KB]` inside a prose chunk when
// no real caption is available (disabled/keyless/error/over-cap). Never cached —
// a key added later must be able to caption the same image.
export function placeholderCaption(mediaType: string, bytes: number): string {
  return `[uncaptioned ${mediaType}, ${Math.max(1, Math.round(bytes / 1024))} KB]`;
}

// Just the multimodal slice of the OpenAI SDK the captioner touches — lets tests
// inject a fake. Content is an array of text / image_url parts.
export interface CaptionClient {
  chat: {
    completions: {
      create(
        body: {
          model: string;
          messages: Array<{
            role: 'user';
            content: Array<
              | { type: 'text'; text: string }
              | { type: 'image_url'; image_url: { url: string } }
            >;
          }>;
          max_completion_tokens: number;
          temperature?: number;
        },
        options?: { timeout?: number; maxRetries?: number }
      ): Promise<{ choices: Array<{ message: { content: string | null } }> }>;
    };
  };
}

const CAPTION_PROMPT =
  'Describe this image in 1-3 concise, factual sentences. Include any visible text, ' +
  'error messages, or short code snippets verbatim. Do not speculate about intent.';

// One chat completion → caption text. withRetry (4 attempts) owns the backoff;
// the SDK maxRetries is 0 so it doesn't double-retry. Throws on exhausted retries
// or an empty response — resolveCaptions catches and falls back to a placeholder.
export async function captionImage(
  client: CaptionClient,
  model: string,
  mediaType: string,
  dataBase64: string
): Promise<string> {
  return withRetry(
    async () => {
      const res = await client.chat.completions.create(
        {
          model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: CAPTION_PROMPT },
                { type: 'image_url', image_url: { url: `data:${mediaType};base64,${dataBase64}` } },
              ],
            },
          ],
          ...modelParams(model),
        },
        { timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 }
      );
      const text = res.choices[0]?.message.content?.trim();
      if (!text) throw new Error('empty caption response');
      return text;
    },
    { attempts: 4 }
  );
}

// Resolve every image caption in place. Cache hits and successful LLM captions
// win; everything else (disabled / no client / no bytes / over the per-trajectory
// cap / any error) gets a placeholder. Only successful LLM captions are cached —
// placeholders never are.
export async function resolveCaptions(
  trajectories: Trajectory[],
  imageData: Map<string, { mediaType: string; data: string }>,
  deps: { cache: CaptionCache; config: ImageCaptionConfig; client: CaptionClient | null }
): Promise<void> {
  const { cache, config, client } = deps;

  const shas = new Set<string>();
  for (const t of trajectories) for (const img of t.images) shas.add(img.sha256);
  if (shas.size === 0) return;

  const cached = await cache.getCachedCaptions([...shas], config.model);
  const fresh: Array<{ sha: string; caption: string }> = [];
  // Resolve a sha once, reuse across trajectories within this batch.
  const resolved = new Map<string, string>();

  for (const t of trajectories) {
    for (let i = 0; i < t.images.length; i++) {
      const img = t.images[i]!;
      const placeholder = placeholderCaption(img.mediaType, img.bytes);

      // Only the first maxPerTrajectory images per trajectory are caption-eligible.
      if (i >= config.maxPerTrajectory) {
        img.caption = placeholder;
        continue;
      }

      const already = resolved.get(img.sha256);
      if (already !== undefined) {
        img.caption = already;
        continue;
      }

      const hit = cached.get(img.sha256);
      if (hit !== undefined) {
        img.caption = hit;
        resolved.set(img.sha256, hit);
        continue;
      }

      const bytes = imageData.get(img.sha256);
      if (!config.enabled || client === null || !bytes) {
        img.caption = placeholder;
        // Don't record in `resolved` — a placeholder must not shadow a later
        // eligible slot, but per-trajectory cap already handles ordering; keeping
        // it unresolved lets an identical image in another trajectory retry.
        continue;
      }

      let caption: string;
      try {
        caption = await captionImage(client, config.model, bytes.mediaType, bytes.data);
        fresh.push({ sha: img.sha256, caption });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[caption] ${reason}; using placeholder`);
        img.caption = placeholder;
        continue;
      }
      img.caption = caption;
      resolved.set(img.sha256, caption);
    }
  }

  if (fresh.length > 0) await cache.putCachedCaptions(fresh, config.model);
}

// Construct a caption client from config, or null when captioning is disabled or
// no API key is available — resolveCaptions then falls back to placeholders.
export function buildCaptioner(config: EngramConfig): CaptionClient | null {
  if (!config.imageCaption.enabled || !config.openaiApiKey) return null;
  return new OpenAI({ apiKey: config.openaiApiKey }) as unknown as CaptionClient;
}
