# config

`~/.engram/config.json`, merged over defaults, then env overrides on top.

Load order: defaults ← `config.json` ← env vars. `saveConfig` persists the file;
`promptForMissing` fills required fields on first run.

## Embedding provider

- `embeddingProvider`: `'openai'` (default) | `'local'`.
- `embeddingModel` / `embeddingDim` follow the provider unless the file pins them
  explicitly: `openai` → `text-embedding-3-small` / 1536, `local` →
  `all-MiniLM-L6-v2` / 384. (See `PROVIDER_DEFAULTS` in `ingest/embed.ts`.)
- `local` needs no API key; `configIsComplete` only requires an OpenAI key when
  the provider is `openai`, and `promptForMissing` skips the key prompt otherwise.

## Env overrides

- `OPENAI_API_KEY` → `openaiApiKey`
- `ENGRAM_DATABASE_URL` → `databaseUrl`
- `ENGRAM_EMBEDDING_PROVIDER` → `embeddingProvider` (`openai` | `local`; anything
  else throws)

The default provider stays `openai` for now — the embedding benchmark decides the
long-term default. Switching providers changes the vector dimension, so a switch
requires a fresh/reconciled index (see `ingest/README.md`).
