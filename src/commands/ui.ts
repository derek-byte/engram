import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig,
  configIsComplete,
  readConfigFile,
  patchConfigFile,
  ConfigPatchError,
  EDITABLE_CONFIG_KEYS,
  DEFAULT_OWNER,
} from '../config/index.ts';
import {
  servicesStatus,
  restartAgent,
  reconcileSynthesisAgent,
  isKnownServiceLabel,
  installAgent,
  uninstallAgent,
  watcherSpec,
  synthesisSpec,
  type ServicesStatus,
  type SynthesisReconcile,
} from './service.ts';
import { hookStatus, installHook, uninstallHook, SettingsParseError } from './hooks.ts';
import { isKnownJobKind, realJobOps, JobConflictError, type JobOps } from './jobs.ts';
import { PgVectorBackend } from '../storage/pgvector.ts';
import { LocalStore } from '../storage/local.ts';
import { WikiStore } from '../wiki/store.ts';
import { isValidSlug } from '../wiki/links.ts';
import { lintWiki } from '../wiki/lint.ts';
import { Embedder, buildProvider } from '../ingest/embed.ts';
import { runSearch } from '../search/index.ts';
import { runAsk, demandRowForAsk, OpenAIAskLLM, AskError } from '../ask/index.ts';
import type { VectorBackend, WikiEvidenceStore } from '../storage/backend.ts';
import type { Artifact, EngramConfig, SearchFilters } from '../types/index.ts';

const SNIPPET_CHARS = 300;
const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const HTML_PATH = join(UI_DIR, 'index.html');
const CSS_PATH = join(UI_DIR, 'app.css');

// The UI ships as ES modules (app.js + the modules it imports), served
// straight out of src/ui with no build step. Only names matching this shape
// are ever read off disk — [a-z-]+ admits no '.', '/', or '%', so a request
// path can never traverse out of UI_DIR.
const JS_NAME_RE = /^[a-z-]+\.js$/;

export interface UiOptions {
  port?: string;
}

function snippet(s: string): string {
  const cleaned = s.replace(/\s+/g, ' ').trim();
  return cleaned.length <= SNIPPET_CHARS ? cleaned : cleaned.slice(0, SNIPPET_CHARS) + '…';
}

// Annotate a page's derived artifacts with an `exists` flag for the UI. Only
// meaningful for kind 'file' — a cheap local existsSync so file chips can render
// moved/deleted paths struck-through. url/pr are remote, so exists is left true.
function withExists(artifacts: Artifact[] | undefined): Array<Artifact & { exists: boolean }> {
  return (artifacts ?? []).map((a) => ({ ...a, exists: a.kind === 'file' ? existsSync(a.ref) : true }));
}

// launchd operations are injected so route tests exercise the config/services
// endpoints without shelling out to the real launchctl (or the developer's own
// installed agents). uiCommand wires in the real service.ts functions.
export interface ServiceOps {
  status: () => ServicesStatus;
  restart: (label: string) => { ok: boolean; out: string };
  reconcileSynthesis: () => SynthesisReconcile;
  // Setup-pane fixers: install/uninstall the launchd agents. Injected so route
  // tests exercise POST /api/setup/service without shelling out to launchctl or
  // writing plists to the developer's own LaunchAgents dir.
  install: () => void;
  uninstall: () => void;
}

export const realServiceOps: ServiceOps = {
  status: servicesStatus,
  restart: restartAgent,
  reconcileSynthesis: reconcileSynthesisAgent,
  // Mirrors serviceCommand's install: watcher always, synthesis iff enabled
  // (and a previously-installed synthesis agent is removed when toggled off).
  install: () => {
    installAgent(watcherSpec());
    const config = loadConfig();
    const synthesis = synthesisSpec(config.synthesis.hour);
    if (config.synthesis.enabled) installAgent(synthesis);
    else if (existsSync(synthesis.plistPath)) uninstallAgent(synthesis);
  },
  uninstall: () => {
    uninstallAgent(watcherSpec());
    uninstallAgent(synthesisSpec(loadConfig().synthesis.hour));
  },
};

export interface UiDeps {
  // Called per GET / so edits to index.html show on refresh — no server restart.
  html: () => string;
  // Same per-request read for the split-out static assets. Optional so route
  // tests can inject fakes; default reads the real files off disk.
  css?: () => string;
  // Serve /<name>.js for the entry module and everything it imports. `name` is
  // pre-validated against JS_NAME_RE before this is called; return null for a
  // module that doesn't exist (→ 404).
  js?: (name: string) => string | null;
  // Vector store + the read-only trust queries the wiki lint/evidence routes need.
  backend: VectorBackend & WikiEvidenceStore;
  embedder: Embedder;
  local: LocalStore;
  wiki: WikiStore;
  dim: number;
  port: number;
  services?: ServiceOps;
  // Job runner for the Analytics "Run eval" button. Injected so route tests
  // fake the runner without spawning a child — same seam as `services`. Default
  // wires in the real Bun.spawn-backed ops.
  jobs?: JobOps;
  // POST /api/ask builds its LLM per request from the on-disk config (a key
  // added in Settings works without a restart). Injected so route tests supply
  // a fake OpenAIAskLLM (real class + fake AskChatClient) with no network, and
  // a keyless config returns null to exercise the 503 path — same seam
  // philosophy as `services`. Default builds the real one from loadConfig().
  buildAskLLM?: (config: EngramConfig) => OpenAIAskLLM | null;
}

// The whitelisted, secret-free config view returned by GET /api/config and
// echoed back by PUT. loadConfig folds env + defaults, so this reflects the
// effective config a new run would see (config edits apply to new processes).
function publicConfig() {
  const c = loadConfig();
  return {
    embeddingProvider: c.embeddingProvider,
    dreamModel: c.dreamModel,
    wikiModel: c.wikiModel,
    rerank: { enabled: c.rerank.enabled },
    synthesis: c.synthesis,
    contextInjection: c.contextInjection,
    hasOpenaiKey: Boolean(c.openaiApiKey),
    hasDatabaseUrl: Boolean(c.databaseUrl),
  };
}

// Default target for the MCP-registration probe. Overridable via
// ENGRAM_CLAUDE_JSON so tests never read the real ~/.claude.json (mirrors the
// ENGRAM_CLAUDE_SETTINGS seam in hooks.ts). Read-only — the setup pane never
// writes this file; `make setup` owns it.
export const CLAUDE_JSON_PATH = join(homedir(), '.claude.json');
function resolveClaudeJsonPath(): string {
  return process.env.ENGRAM_CLAUDE_JSON ?? CLAUDE_JSON_PATH;
}

// One setup check as returned by GET /api/setup. `fix` is null when ok — a
// passing check has nothing to fix; 'make-setup' points the user at the CLI
// fix-path for heavy items; 'in-app' means a button on the pane can fix it.
export interface SetupCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  fix: 'make-setup' | 'in-app' | null;
}

function isPlainObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// The JSON write-gate shared by every mutating route: require an
// application/json content-type, parse the body, and require a plain object.
// Returns the parsed object or a ready-to-return {error,status} the caller maps
// to Response.json — behavior is byte-identical to the inline copies it replaces.
type JsonBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: string; status: number };

async function readJsonBody(req: Request): Promise<JsonBodyResult> {
  if (req.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') {
    return { ok: false, error: 'expected content-type: application/json', status: 400 };
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { ok: false, error: 'invalid json', status: 400 };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'expected a json object', status: 400 };
  }
  return { ok: true, body: body as Record<string, unknown> };
}

// decodeURIComponent throws URIError on a malformed %-escape (e.g. '%ZZ'); a bare
// call on a path param turns that into an unhandled throw → 500. This returns null
// instead so the caller can answer a clean 400.
function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

// Is the engram MCP server registered in ~/.claude.json? Read-only. Absent or
// unparseable ⇒ we can't tell, so ok:false with the make-setup hint.
function mcpCheck(): { ok: boolean; detail: string } {
  const path = resolveClaudeJsonPath();
  if (!existsSync(path)) return { ok: false, detail: 'unknown — run make setup' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { ok: false, detail: 'unknown — run make setup' };
  }
  if (!isPlainObj(parsed)) return { ok: false, detail: 'unknown — run make setup' };
  const servers = parsed.mcpServers;
  if (isPlainObj(servers) && 'engram' in servers) return { ok: true, detail: 'engram server registered' };
  return { ok: false, detail: 'engram server not registered — run make setup' };
}

// Drift-detection checklist for the setup pane. `make setup` is the fix-path for
// the heavy items (postgres/index/mcp); hook + service each have an in-app fixer.
// postgres + index share a single count guarded by a short race timeout — the
// backend is the server's shared one, so pg was up at boot but can die after.
async function buildSetupChecks(
  backend: VectorBackend,
  services: ServiceOps
): Promise<SetupCheck[]> {
  let count: number | null = null;
  let pgOk = false;
  let pgDetail = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('postgres unreachable (timed out after 1.5s)')), 1500);
    });
    count = await Promise.race([backend.count(), timeout]);
    pgOk = true;
    pgDetail = 'reachable';
  } catch (err) {
    pgDetail = `${err instanceof Error ? err.message : String(err)} — is Postgres running? (Docker Desktop / make setup)`;
  } finally {
    if (timer) clearTimeout(timer);
  }

  const indexOk = count !== null && count > 0;
  const indexDetail =
    count === null ? 'unknown — postgres unreachable' : `${count} chunk${count === 1 ? '' : 's'}`;

  const hs = hookStatus();
  const hookOk = hs.installed && !hs.stalePath && !hs.staleInterpreter && !hs.parseError;
  let hookDetail: string;
  if (hs.parseError) hookDetail = 'settings.json malformed — fix it manually';
  else if (!hs.installed) hookDetail = 'not installed';
  else if (hs.stalePath) hookDetail = 'installed but stale — points at a different src/index.ts';
  else if (hs.staleInterpreter) hookDetail = 'installed but stale — interpreter path gone (bun upgraded?)';
  else hookDetail = 'installed (current)';

  const mcp = mcpCheck();

  const st = services.status();
  let serviceOk: boolean;
  let serviceDetail: string;
  if (!st.supported) {
    serviceOk = false;
    serviceDetail = 'launchd unsupported (macOS only)';
  } else if (!st.serviceInstalled) {
    serviceOk = false;
    serviceDetail = 'not installed';
  } else {
    serviceOk = true;
    serviceDetail = st.agents
      .map((a) => `${a.label}: ${a.loaded ? (a.state ?? 'loaded') : 'not loaded'}`)
      .join(', ');
  }

  return [
    { id: 'postgres', label: 'Postgres', ok: pgOk, detail: pgDetail, fix: pgOk ? null : 'make-setup' },
    { id: 'index', label: 'Index', ok: indexOk, detail: indexDetail, fix: indexOk ? null : 'make-setup' },
    { id: 'hook', label: 'SessionStart hook', ok: hookOk, detail: hookDetail, fix: hookOk ? null : 'in-app' },
    { id: 'mcp', label: 'MCP server', ok: mcp.ok, detail: mcp.detail, fix: mcp.ok ? null : 'make-setup' },
    { id: 'service', label: 'Background service', ok: serviceOk, detail: serviceDetail, fix: serviceOk ? null : 'in-app' },
  ];
}

// The full request handler, extracted from Bun.serve so route tests can call it
// with Request objects directly (no port bind, no network) — same seam
// philosophy as service.ts's exported buildPlist. uiCommand is a thin wire-up.
export function buildUiFetch(deps: UiDeps): (req: Request) => Promise<Response> {
  const { html, backend, embedder, local, wiki, dim, port } = deps;
  const css = deps.css ?? (() => readFileSync(CSS_PATH, 'utf-8'));
  const js =
    deps.js ??
    ((name: string) => {
      const path = join(UI_DIR, name); // name matched JS_NAME_RE — no traversal possible
      return existsSync(path) ? readFileSync(path, 'utf-8') : null;
    });
  const services = deps.services ?? realServiceOps;
  const jobs = deps.jobs ?? realJobOps;
  const buildAskLLM =
    deps.buildAskLLM ??
    ((config: EngramConfig) => (config.openaiApiKey ? new OpenAIAskLLM(config.openaiApiKey, config.wikiModel) : null));

  // DNS-rebinding defense: only loopback Host values are legitimate for this
  // server. A malicious site rebound to 127.0.0.1 arrives with its own Host,
  // so anything else gets rejected before touching the index. Browser requests
  // carrying a foreign Origin are rejected for the same reason.
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));

  return async function fetch(req: Request): Promise<Response> {
    const host = req.headers.get('host');
    if (!host || !allowedHosts.has(host.toLowerCase())) {
      return new Response('forbidden', { status: 403 });
    }
    const origin = req.headers.get('origin');
    if (origin && !allowedOrigins.has(origin.toLowerCase())) {
      return new Response('forbidden', { status: 403 });
    }

    const url = new URL(req.url);

    if (url.pathname === '/') {
      return new Response(html(), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    // Exact-match static assets, served per-request like GET / (edits show on
    // refresh, no restart). No filesystem interpolation from the request path.
    if (url.pathname === '/app.css') {
      return new Response(css(), {
        headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    // ES-module JS assets: /app.js plus every module it imports. The name is
    // validated against JS_NAME_RE before any filesystem read (no dots, no
    // slashes, no %-escapes ⇒ no traversal); anything else falls through to 404.
    const jsName = url.pathname.slice(1);
    if (JS_NAME_RE.test(jsName)) {
      const body = js(jsName);
      if (body === null) return new Response('not found', { status: 404 });
      return new Response(body, {
        headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    if (url.pathname === '/api/stats') {
      try {
        const chunks = await backend.count();
        return Response.json({ model: embedder.model, dim, chunks });
      } catch (err) {
        console.error('stats failed:', err instanceof Error ? err.message : err);
        return Response.json({ error: 'stats failed' }, { status: 500 });
      }
    }

    if (url.pathname === '/api/config') {
      // A malformed config.json on disk must surface as a JSON 500 like every
      // other route — never Bun's default error page.
      if (req.method === 'GET') {
        try {
          return Response.json(publicConfig());
        } catch (err) {
          console.error('config read failed:', err instanceof Error ? err.message : err);
          return Response.json({ error: 'config read failed' }, { status: 500 });
        }
      }
      if (req.method !== 'PUT') return new Response('method not allowed', { status: 405 });

      // Writes must be JSON — a form/navigation POST can't reach this branch.
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
      const patch = parsed.body;
      // Reject secrets and read-only keys up front — only editable keys pass.
      const rejected = Object.keys(patch).filter((k) => !(EDITABLE_CONFIG_KEYS as readonly string[]).includes(k));
      if (rejected.length > 0) {
        return Response.json({ error: `not editable: ${rejected.join(', ')}` }, { status: 400 });
      }
      if ('embeddingProvider' in patch && patch.embeddingProvider !== 'openai' && patch.embeddingProvider !== 'local') {
        return Response.json({ error: "embeddingProvider must be 'openai' or 'local'" }, { status: 400 });
      }

      let prevProvider: string;
      try {
        prevProvider = (readConfigFile().embeddingProvider as string | undefined) ?? 'local';
        patchConfigFile(patch);
      } catch (err) {
        if (err instanceof ConfigPatchError) {
          return Response.json({ error: err.message }, { status: 400 });
        }
        console.error('config write failed:', err instanceof Error ? err.message : err);
        return Response.json({ error: 'config write failed' }, { status: 500 });
      }
      // Switching embedding provider desyncs the vector column ⇒ a re-embed is required.
      const reembedRequired = 'embeddingProvider' in patch && patch.embeddingProvider !== prevProvider;
      // A synthesis toggle/hour change reconciles the launchd agent (only if installed).
      let synthesisReconcile: SynthesisReconcile | undefined;
      if ('synthesis' in patch) {
        try {
          synthesisReconcile = services.reconcileSynthesis();
        } catch (err) {
          console.error('synthesis reconcile failed:', err instanceof Error ? err.message : err);
        }
      }
      return Response.json({ ...publicConfig(), reembedRequired, synthesisReconcile });
    }

    if (url.pathname === '/api/hook') {
      // SessionStart hook install/uninstall/status for the settings pane.
      if (req.method === 'GET') {
        try {
          return Response.json(hookStatus());
        } catch (err) {
          console.error('hook status failed:', err instanceof Error ? err.message : err);
          return Response.json({ error: 'hook status failed' }, { status: 500 });
        }
      }
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
      // Writes are JSON-gated like PUT /api/config so a form/navigation POST can't reach here.
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
      const action = parsed.body.action;
      try {
        let changed: boolean;
        if (action === 'install') changed = installHook().changed;
        else if (action === 'uninstall') changed = uninstallHook().changed;
        else return Response.json({ error: "unknown action (expected 'install' or 'uninstall')" }, { status: 400 });
        return Response.json({ changed, status: hookStatus() });
      } catch (err) {
        // A malformed settings.json makes the installer REFUSE — surface the
        // message so the pane can tell the user to fix it by hand.
        if (err instanceof SettingsParseError) return Response.json({ error: err.message }, { status: 500 });
        console.error('hook mutation failed:', err instanceof Error ? err.message : err);
        return Response.json({ error: 'hook mutation failed' }, { status: 500 });
      }
    }

    if (url.pathname === '/api/ask') {
      // Ask synthesizes an answer with an LLM and can't degrade to search, so
      // it's a POST behind the same JSON gates as PUT /api/config — a
      // form/navigation POST can't reach the handler body.
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
      const b = parsed.body;
      const q = typeof b.q === 'string' ? b.q.trim() : '';
      if (!q) return Response.json({ error: 'q is required' }, { status: 400 });

      // Built per request from the on-disk config so a key added in Settings
      // works without a server restart. No key ⇒ 503 (client shows a Settings
      // hint; search below still works — ask never silently degrades).
      const llm = buildAskLLM(loadConfig());
      if (!llm) return Response.json({ error: 'no_api_key' }, { status: 503 });

      const kRaw = Math.floor(Number(b.k ?? 12));
      const k = Number.isFinite(kRaw) ? Math.min(50, Math.max(1, kRaw)) : 12;
      const tier: SearchFilters['tier'] = b.tier === 'raw' || b.tier === 'all' || b.tier === 'synth' ? b.tier : 'synth';
      const repo = typeof b.repo === 'string' && b.repo.trim() ? b.repo.trim() : undefined;
      const filters: SearchFilters = { limit: k, tier, repo };

      // Recents pre-call: even a failed/unanswerable ask is demand signal
      // (mirrors the CLI, src/commands/ask.ts:62).
      try {
        local.logRecent('ask', q, q);
      } catch {
        /* recents are cosmetic */
      }

      const t0 = Date.now();
      try {
        const result = await runAsk(q, filters, { backend, embedder, llm });
        // AskSource carries no similarity/sessionId, so an ask row logs top_tier
        // (from the first source) but leaves top_similarity / top_session_id null
        // — the targeted-synthesis handle is sourced from search rows, which do
        // carry both. Row shape is shared with the CLI/MCP ask surfaces.
        try {
          local.logDemand(demandRowForAsk('ui', q, tier, repo ?? null, result));
        } catch {
          /* demand log is cosmetic */
        }
        return Response.json({
          answer: result.answer,
          sources: result.sources,
          usage: result.usage,
          model: result.model,
          tookMs: Date.now() - t0,
        });
      } catch (err) {
        try {
          local.logDemand({ surface: 'ui', kind: 'ask', query: q, tier, repo, resultCount: 0, outcome: 'error' });
        } catch {
          /* demand log is cosmetic */
        }
        // AskError = a real answering failure (bad key, model refusal, timeout);
        // surface it as JSON, never Bun's default error page. Anything else 500s.
        if (err instanceof AskError) return Response.json({ error: err.message }, { status: 502 });
        console.error('ask failed:', err instanceof Error ? err.message : err);
        return Response.json({ error: 'ask failed' }, { status: 500 });
      }
    }

    if (url.pathname === '/api/demand') {
      // Unmet-demand report for the search empty state (roadmap #6). days is
      // clamped 1–365; body is {days, summary, unmet:[...]}.
      const daysRaw = Math.floor(Number(url.searchParams.get('days') ?? '30'));
      const days = Number.isFinite(daysRaw) ? Math.min(365, Math.max(1, daysRaw)) : 30;
      try {
        return Response.json({ days, summary: local.demandSummary(days), unmet: local.unmetDemand(days) });
      } catch (err) {
        console.error('demand failed:', err instanceof Error ? err.message : err);
        return Response.json({ error: 'demand failed' }, { status: 500 });
      }
    }

    // Page index for the Wiki nav view (list only, no bodies).
    if (url.pathname === '/api/wiki') {
      try {
        return Response.json(
          wiki.listPages().map((p) => ({ slug: p.slug, title: p.title, kind: p.kind, updated: p.updated }))
        );
      } catch (err) {
        console.error('wiki list failed:', err instanceof Error ? err.message : err);
        return Response.json({ error: 'wiki list failed' }, { status: 500 });
      }
    }

    // Wiki lint, on demand. Backend is in scope, so provenance + pending-unit
    // rules run too. Shape: {findings:[{rule, level, page, detail}], counts}.
    if (url.pathname === '/api/lint') {
      try {
        const findings = await lintWiki(wiki, {
          checkProvenance: (ids) => backend.existingChunkIds(ids, 'dream'),
          pendingUnits: () => backend.pendingWikiUnits(DEFAULT_OWNER),
        });
        const warns = findings.filter((f) => f.severity === 'warn').length;
        return Response.json({
          findings: findings.map((f) => ({ rule: f.rule, level: f.severity, page: f.page, detail: f.detail })),
          counts: { warns, infos: findings.length - warns },
        });
      } catch (err) {
        console.error('lint failed:', err instanceof Error ? err.message : err);
        return Response.json({ error: 'lint failed' }, { status: 500 });
      }
    }

    if (url.pathname === '/api/services') {
      try {
        return Response.json(services.status());
      } catch (err) {
        console.error('services status failed:', err instanceof Error ? err.message : err);
        return Response.json({ error: 'services status failed' }, { status: 500 });
      }
    }

    const restartMatch = url.pathname.match(/^\/api\/services\/([^/]+)\/restart$/);
    if (restartMatch) {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
      const label = safeDecode(restartMatch[1]!);
      if (label === null) return Response.json({ error: 'bad service label' }, { status: 400 });
      // Unknown labels 404 before touching launchctl (labels are never interpolated).
      if (!isKnownServiceLabel(label)) return Response.json({ error: 'unknown service' }, { status: 404 });
      try {
        const r = services.restart(label);
        return Response.json({ ok: r.ok, label }, { status: r.ok ? 200 : 500 });
      } catch (err) {
        console.error('service restart failed:', err instanceof Error ? err.message : err);
        return Response.json({ error: 'restart failed' }, { status: 500 });
      }
    }

    // GET /api/setup — drift-detection checklist for the setup pane. One payload
    // {checks:[{id,label,ok,detail,fix}]} the view renders as a fix-it list.
    if (url.pathname === '/api/setup') {
      if (req.method !== 'GET') return new Response('method not allowed', { status: 405 });
      try {
        return Response.json({ checks: await buildSetupChecks(backend, services) });
      } catch (err) {
        console.error('setup checks failed:', err instanceof Error ? err.message : err);
        return Response.json({ error: 'setup checks failed' }, { status: 500 });
      }
    }

    // POST /api/setup/service — the in-app fixer for the background service.
    // JSON-gated like the other write routes; launchd is macOS-only so a
    // non-darwin host is a clean 400 rather than a launchctl error.
    if (url.pathname === '/api/setup/service') {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
      if (process.platform !== 'darwin') return Response.json({ error: 'macOS only' }, { status: 400 });
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
      const action = parsed.body.action;
      try {
        if (action === 'install') services.install();
        else if (action === 'uninstall') services.uninstall();
        else return Response.json({ error: "unknown action (expected 'install' or 'uninstall')" }, { status: 400 });
        return Response.json({ ok: true, status: services.status() });
      } catch (err) {
        console.error('setup service change failed:', err instanceof Error ? err.message : err);
        return Response.json({ error: 'service change failed' }, { status: 500 });
      }
    }

    if (url.pathname === '/api/search') {
      const q = url.searchParams.get('q')?.trim() ?? '';
      if (!q) return Response.json([]);
      const kRaw = Math.floor(Number(url.searchParams.get('k') ?? '3'));
      const k = Number.isFinite(kRaw) ? Math.min(50, Math.max(1, kRaw)) : 3;
      const tierRaw = url.searchParams.get('tier');
      const tier: SearchFilters['tier'] =
        tierRaw === 'raw' || tierRaw === 'dream' || tierRaw === 'wiki' || tierRaw === 'synth' || tierRaw === 'all'
          ? tierRaw
          : 'synth';
      const filters: SearchFilters = { limit: k, tier };
      try {
        const results = await runSearch(q, filters, { backend, embedder });
        if (q.length >= 3) {
          // Cosmetic usage log; never let a failure break search. Only meaningful
          // queries (>=3 chars, with hits) become a `search` recent;
          // consecutive-identical / prefix-refinement dedupe lives in
          // LocalStore.logRecent.
          if (results.length > 0) {
            try {
              local.logRecent('search', q, q);
            } catch {
              /* recents are cosmetic */
            }
          }
          // Demand signal (roadmap #6): log EVERY settled query >=3 chars incl.
          // zero-hit — a zero-hit search is the strongest unmet-demand signal
          // and was previously dropped. top_* come from the best hit when
          // present; a zero-hit row leaves them null.
          try {
            const top = results[0];
            local.logDemand({
              surface: 'ui',
              kind: 'search',
              query: q,
              tier,
              resultCount: results.length,
              topSimilarity: top?.similarity ?? null,
              topTier: top?.chunk.metadata.tier ?? null,
              topSessionId: top?.chunk.metadata.sessionId ?? null,
            });
          } catch {
            /* demand log is cosmetic */
          }
        }
        return Response.json(
          results.map((r) => {
            const m = r.chunk.metadata;
            const slug = m.tier === 'wiki' ? (m.trajectoryId?.replace(/^wiki:/, '') ?? null) : null;
            return {
              id: r.chunk.id,
              similarity: r.similarity,
              repo: m.repo,
              branch: m.branch,
              timestamp: m.timestamp,
              sessionId: m.sessionId,
              tier: m.tier,
              kind: m.dreamType ?? null,
              slug,
              sources: m.sourceChunkIds ?? [],
              trajectoryId: m.trajectoryId ?? null,
              chunkIndex: m.chunkIndex ?? null,
              artifacts: m.artifacts ?? [],
              snippet: snippet(r.chunk.content),
            };
          })
        );
      } catch (err) {
        console.error('search failed:', err instanceof Error ? err.message : err);
        // A failed search is still a settled demand signal — nothing was found.
        if (q.length >= 3) {
          try {
            local.logDemand({ surface: 'ui', kind: 'search', query: q, tier, resultCount: 0 });
          } catch {
            /* demand log is cosmetic */
          }
        }
        return Response.json({ error: 'search failed' }, { status: 500 });
      }
    }

    const wikiMatch = url.pathname.match(/^\/api\/wiki\/(.+)$/);
    if (wikiMatch) {
      const slug = safeDecode(wikiMatch[1]!);
      if (slug === null) return Response.json({ error: 'bad slug' }, { status: 400 });
      // Slug validation doubles as the path-traversal guard: pagePath is only
      // ever reached with a validated kebab-case slug.
      if (!isValidSlug(slug)) return Response.json({ error: 'bad slug' }, { status: 400 });
      let page;
      try {
        page = wiki.readPage(slug);
      } catch (err) {
        console.error('wiki read failed:', err instanceof Error ? err.message : err);
        return Response.json({ error: 'read failed' }, { status: 500 });
      }
      if (!page) return Response.json({ error: 'not found' }, { status: 404 });
      try {
        local.logRecent('view', 'wiki:' + slug, page.title);
      } catch {
        /* recents are cosmetic */
      }
      // Evidence roll-up over the page's dream sources. Non-fatal: a pg hiccup
      // leaves the header off rather than failing the page.
      let evidence = { sessionCount: 0, firstSeen: null as Date | null, lastSeen: null as Date | null };
      try {
        evidence = await backend.wikiPageEvidence(page.sources);
      } catch (err) {
        console.error('wiki evidence failed:', err instanceof Error ? err.message : err);
      }
      return Response.json({
        slug: page.slug,
        title: page.title,
        kind: page.kind,
        summary: page.summary,
        updated: page.updated,
        created: page.created,
        sourceCount: page.sources.length,
        sessionCount: evidence.sessionCount,
        firstSeen: evidence.firstSeen,
        lastSeen: evidence.lastSeen,
        trajectoryId: 'wiki:' + slug,
        artifacts: withExists(page.artifacts),
        body: page.body,
      });
    }

    if (url.pathname === '/api/recents') {
      try {
        return Response.json(local.getRecents(50));
      } catch (err) {
        console.error('recents failed:', err instanceof Error ? err.message : err);
        return Response.json({ error: 'recents failed' }, { status: 500 });
      }
    }

    const traj = url.pathname.match(/^\/api\/trajectory\/(.+)$/);
    if (traj) {
      const trajectoryId = safeDecode(traj[1]!);
      if (trajectoryId === null) return Response.json({ error: 'bad trajectory id' }, { status: 400 });
      try {
        const chunks = await backend.getTrajectory(trajectoryId);
        // Log raw/dream trajectory opens as views; wiki drill-downs are excluded
        // because the page view already logged 'wiki:<slug>'.
        if (chunks.length > 0 && !trajectoryId.startsWith('wiki:')) {
          const m = chunks[0]!.metadata;
          try {
            local.logRecent('view', 'traj:' + trajectoryId, (m.repo ?? '(no-repo)') + '@' + (m.branch ?? 'no-branch'));
          } catch {
            /* recents are cosmetic */
          }
        }
        return Response.json(
          chunks.map((c) => ({
            id: c.id,
            chunkIndex: c.metadata.chunkIndex ?? null,
            chunkCount: c.metadata.chunkCount ?? null,
            content: c.content,
            repo: c.metadata.repo,
            branch: c.metadata.branch,
            timestamp: c.metadata.timestamp,
            sessionId: c.metadata.sessionId,
            artifacts: c.metadata.artifacts ?? [],
          }))
        );
      } catch (err) {
        console.error('trajectory fetch failed:', err instanceof Error ? err.message : err);
        return Response.json({ error: 'fetch failed' }, { status: 500 });
      }
    }

    // POST /api/jobs/:kind/run — launch a whitelisted job. Behind the same JSON
    // gates as PUT /api/config; body {fromDemandDays?, limit?, judgeModel?} is
    // validated/clamped and translated to askeval-run flags. 202 on launch, 409
    // if one is already running, 404 for an unknown kind (never spawned).
    const jobRunMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/run$/);
    if (jobRunMatch) {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
      const kind = safeDecode(jobRunMatch[1]!);
      if (kind === null) return Response.json({ error: 'bad job kind' }, { status: 400 });
      if (!isKnownJobKind(kind)) return Response.json({ error: 'unknown job' }, { status: 404 });
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
      const b = parsed.body;
      const args: string[] = [];
      if (b.fromDemandDays !== undefined) {
        const d = Math.floor(Number(b.fromDemandDays));
        if (!Number.isFinite(d)) return Response.json({ error: 'fromDemandDays must be a number' }, { status: 400 });
        args.push('--from-demand', String(Math.min(365, Math.max(1, d))));
      }
      if (b.limit !== undefined) {
        const l = Math.floor(Number(b.limit));
        if (!Number.isFinite(l)) return Response.json({ error: 'limit must be a number' }, { status: 400 });
        args.push('--limit', String(Math.min(50, Math.max(1, l))));
      }
      if (b.judgeModel !== undefined) {
        if (typeof b.judgeModel !== 'string' || !b.judgeModel.trim()) {
          return Response.json({ error: 'judgeModel must be a non-empty string' }, { status: 400 });
        }
        args.push('--judge-model', b.judgeModel.trim());
      }
      try {
        jobs.start(kind, args);
        return Response.json({ started: true }, { status: 202 });
      } catch (err) {
        if (err instanceof JobConflictError) return Response.json({ error: 'already running' }, { status: 409 });
        console.error('job start failed:', err instanceof Error ? err.message : err);
        return Response.json({ error: 'job start failed' }, { status: 500 });
      }
    }

    // GET /api/jobs/:kind — runner status + recent run history in one call so
    // the Analytics view renders without a second round-trip.
    const jobStatusMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (jobStatusMatch) {
      const kind = safeDecode(jobStatusMatch[1]!);
      if (kind === null) return Response.json({ error: 'bad job kind' }, { status: 400 });
      if (!isKnownJobKind(kind)) return Response.json({ error: 'unknown job' }, { status: 404 });
      try {
        return Response.json({ ...jobs.status(kind), runs: local.getAskevalRuns(10) });
      } catch (err) {
        console.error('job status failed:', err instanceof Error ? err.message : err);
        return Response.json({ error: 'job status failed' }, { status: 500 });
      }
    }

    // GET /api/analytics — one read-only payload the Analytics view renders:
    // demand/lint trends, context-injection activity + gate + hook, askeval runs.
    if (url.pathname === '/api/analytics') {
      try {
        return Response.json({
          demandTrend: local.getSnapshots('demand', 30),
          lintTrend: local.getSnapshots('lint', 30),
          context: {
            ...local.contextStats(30),
            configEnabled: loadConfig().contextInjection.enabled,
            hook: hookStatus(),
          },
          askevalRuns: local.getAskevalRuns(10),
        });
      } catch (err) {
        console.error('analytics failed:', err instanceof Error ? err.message : err);
        return Response.json({ error: 'analytics failed' }, { status: 500 });
      }
    }

    return new Response('not found', { status: 404 });
  };
}

export async function uiCommand(opts: UiOptions): Promise<void> {
  const config = loadConfig();
  if (!configIsComplete(config)) {
    console.error("engram isn't configured yet. Run 'engram backfill' first.");
    process.exit(1);
  }

  const port = opts.port ? Number(opts.port) : 7777;
  const html = () => readFileSync(HTML_PATH, 'utf-8');

  const backend = PgVectorBackend.fromConfig(config);
  await backend.initialize();
  // Pass the backend as the embedding cache so repeat queries hit embedding_cache (free).
  const embedder = new Embedder(buildProvider(config), backend);
  const local = new LocalStore();
  const wiki = new WikiStore(config.wikiDir);

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    // Verified on Bun 1.3.14: the default 10s idleTimeout severs a pending
    // response (POST /api/ask runs a 5–60s LLM call), and the client sees a
    // dropped socket rather than the answer. 240s comfortably covers the ask
    // path's own 60s LLM timeout + retry.
    idleTimeout: 240,
    // css/js use buildUiFetch's defaults: per-request reads from src/ui.
    fetch: buildUiFetch({ html, backend, embedder, local, wiki, dim: config.embeddingDim, port }),
  });

  console.log(`engram ui → http://${server.hostname}:${server.port}`);
}
