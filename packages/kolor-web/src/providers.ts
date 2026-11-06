import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KolorStateError, toChatCompletionsUrl } from 'kolor-agent-loop';
import { resolveKolorHome } from 'kolor-sessions';

/** One OpenAI-compatible provider stored on disk. */
export interface ProviderRecord {
  id: string;
  /** Label shown in the UI. */
  name: string;
  /** Base URL as entered (trailing `/chat/completions` / `/models` removed). */
  baseUrl: string;
  /** Bearer token. Never sent to the browser and never written into a session. */
  apiKey: string;
  /** Model ids returned by `GET <base>/models`. */
  models: string[];
  createdAt: string;
  updatedAt: string;
}

/** Provider shape exposed to the browser: the key is reduced to a hint. */
export interface ProviderView {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  hasKey: boolean;
  /** `••••abcd`, or an empty string when no key is stored. */
  keyHint: string;
  createdAt: string;
  updatedAt: string;
}

/** The model the chat should use right now. */
export interface ModelTarget {
  /** Base URL handed to `KolorAgent` (a `/chat/completions` URL is also accepted). */
  apiUrl: string;
  /** Model name sent in the request body. */
  apiModelName: string;
  apiKey: string;
  /** Human readable `provider · model` label. */
  label: string;
  /** `null` when the target comes from the environment instead of a provider. */
  providerId: string | null;
}

/** Active model as shown in the composer and the provider dialog. */
export interface ActiveModelView {
  providerId: string | null;
  model: string;
  label: string;
  source: 'provider' | 'env' | 'none';
}

/** Fallback endpoint taken from the environment (`DEEPSEEK_API_KEY` etc.). */
export interface DefaultModelConfig {
  apiUrl: string;
  apiModelName: string;
  apiKey: string;
}

export interface ProviderStoreOptions {
  /** Defaults to `~/.kolor/providers.json`. */
  path?: string;
  /** Kolor home used when `path` is omitted. */
  home?: string;
}

export interface DiscoverModelsOptions {
  baseUrl: string;
  apiKey?: string;
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Extra request headers (unused by the web UI, kept for library use). */
  headers?: Record<string, string>;
}

/** Result of asking a provider which models it serves. */
export interface DiscoveredModels {
  models: string[];
  /** The URL that answered successfully. */
  endpoint: string;
}

interface ProviderFile {
  version: 1;
  active: { providerId: string; model: string } | null;
  providers: ProviderRecord[];
}

const FILE_VERSION = 1;
const MAX_NAME_LENGTH = 120;
const MAX_MODELS = 2000;
const DEFAULT_MODELS_TIMEOUT_MS = 15_000;
const EMPTY_FILE: ProviderFile = { version: FILE_VERSION, active: null, providers: [] };

/**
 * Providers and their models, persisted as `~/.kolor/providers.json`.
 *
 * This is the only file that stores API keys, because a provider added in the
 * web UI has to survive a restart. The file is written atomically with owner
 * permissions and the keys are never included in an API response.
 */
export class ProviderStore {
  readonly path: string;

  constructor(options: ProviderStoreOptions = {}) {
    this.path = options.path ?? join(options.home ?? resolveKolorHome(), 'providers.json');
  }

  /** Providers with their keys masked, in insertion order. */
  list(): ProviderView[] {
    return this.#read().providers.map(toView);
  }

  /** The stored selection, or `null` when the environment default is in use. */
  selection(): { providerId: string; model: string } | null {
    const active = this.#read().active;
    return active === null ? null : { ...active };
  }

  /**
   * Resolve the model to use for the next turn.
   *
   * A stored provider wins. The environment is only used when the caller
   * explicitly supplied an endpoint, a model and a key — there is no built-in
   * default provider, so an unconfigured install has nothing to call.
   */
  resolve(defaults: DefaultModelConfig): ModelTarget | undefined {
    const file = this.#read();
    const active = file.active;
    if (active !== null) {
      const provider = file.providers.find((entry) => entry.id === active.providerId);
      if (provider !== undefined) {
        const model = active.model !== '' ? active.model : (provider.models[0] ?? '');
        if (model !== '') return providerTarget(provider, model);
      }
    }
    const fallbackUrl = defaults.apiUrl.trim();
    const fallbackModel = defaults.apiModelName.trim();
    if (defaults.apiKey.trim() !== '' && fallbackUrl !== '' && fallbackModel !== '') {
      return {
        apiUrl: fallbackUrl,
        apiModelName: fallbackModel,
        apiKey: defaults.apiKey,
        label: `环境变量 · ${fallbackModel}`,
        providerId: null,
      };
    }
    return undefined;
  }

  /** Active model with a source, for the composer and `/api/providers`. */
  activeView(defaults: DefaultModelConfig): ActiveModelView {
    const target = this.resolve(defaults);
    if (target === undefined) {
      return { providerId: null, model: '', label: '未配置模型', source: 'none' };
    }
    if (target.providerId === null) {
      return {
        providerId: null,
        model: target.apiModelName,
        label: target.label,
        source: 'env',
      };
    }
    return {
      providerId: target.providerId,
      model: target.apiModelName,
      label: target.label,
      source: 'provider',
    };
  }

  /**
   * Add a provider.
   *
   * The first provider (or the first provider that gets models) becomes active
   * automatically, so adding one is enough to start chatting.
   */
  add(input: { name?: string; baseUrl: string; apiKey?: string; models: string[] }): ProviderRecord {
    const file = this.#read();
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const apiKey = (input.apiKey ?? '').trim();
    const models = normalizeModels(input.models);
    if (models.length === 0) {
      throw new KolorStateError('a provider needs at least one model; run discovery or list them manually');
    }
    const now = new Date().toISOString();
    const provider: ProviderRecord = {
      id: `p_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      name: normalizeName(input.name, baseUrl),
      baseUrl,
      apiKey,
      models,
      createdAt: now,
      updatedAt: now,
    };
    const isFirst = file.providers.length === 0;
    file.providers.push(provider);
    // Only the very first provider steals the selection; adding another one
    // must not override a deliberate "default endpoint" choice.
    if (isFirst && file.active === null) {
      file.active = { providerId: provider.id, model: models[0] as string };
    }
    this.#write(file);
    return provider;
  }

  /** Replace the model list of one provider (after a refresh). */
  setModels(id: string, models: string[]): ProviderRecord {
    const file = this.#read();
    const provider = file.providers.find((entry) => entry.id === id);
    if (provider === undefined) throw new KolorStateError(`unknown provider "${id}"`);
    const next = normalizeModels(models);
    if (next.length === 0) {
      throw new KolorStateError('the provider returned no models; check the base URL and API key');
    }
    provider.models = next;
    provider.updatedAt = new Date().toISOString();
    if (file.active?.providerId === id && !next.includes(file.active.model)) {
      file.active = { providerId: id, model: next[0] as string };
    }
    this.#write(file);
    return provider;
  }

  /** Remove a provider; the selection falls back to the environment default. */
  remove(id: string): boolean {
    const file = this.#read();
    const index = file.providers.findIndex((entry) => entry.id === id);
    if (index === -1) return false;
    file.providers.splice(index, 1);
    if (file.active?.providerId === id) file.active = null;
    this.#write(file);
    return true;
  }

  /** Select a provider model. An empty `providerId` clears the selection. */
  setActive(providerId: string, model: string): void {
    const file = this.#read();
    if (providerId === '') {
      file.active = null;
      this.#write(file);
      return;
    }
    const provider = file.providers.find((entry) => entry.id === providerId);
    if (provider === undefined) throw new KolorStateError(`unknown provider "${providerId}"`);
    const chosen = model.trim() !== '' ? model.trim() : (provider.models[0] ?? '');
    if (chosen === '') throw new KolorStateError('this provider has no models to select');
    file.active = { providerId, model: chosen };
    this.#write(file);
  }

  /** One provider by id, key masked. */
  get(id: string): ProviderView | undefined {
    const provider = this.#read().providers.find((entry) => entry.id === id);
    return provider === undefined ? undefined : toView(provider);
  }

  /** Full record including the key. Server-side use only; never serialise it. */
  record(id: string): ProviderRecord | undefined {
    return this.#read().providers.find((entry) => entry.id === id);
  }

  #read(): ProviderFile {
    if (!existsSync(this.path)) return structuredClone(EMPTY_FILE);
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (error) {
      throw new KolorStateError(`could not read ${this.path}`, { cause: error });
    }
    if (raw.trim() === '') return structuredClone(EMPTY_FILE);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new KolorStateError(
        `${this.path} is not valid JSON; fix or delete it to manage providers again`,
        { cause: error },
      );
    }
    return normalizeFile(parsed);
  }

  #write(file: ProviderFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const payload = `${JSON.stringify(file, null, 2)}\n`;
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, payload, { mode: 0o600 });
    renameSync(temporary, this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // Windows does not use POSIX modes; the file still lives in the user profile.
    }
  }
}

/**
 * Ask an OpenAI-compatible provider which models it serves.
 *
 * Tries `<base>/models` (derived from the chat-completions URL) and then
 * `<base>/v1/models`, so both `https://api.deepseek.com` and a gateway rooted
 * at `/v1` work.
 */
export async function discoverModels(options: DiscoverModelsOptions): Promise<DiscoveredModels> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const apiKey = (options.apiKey ?? '').trim();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new KolorStateError('global fetch is not available; pass options.fetchImpl');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS;
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` }),
    ...options.headers,
  };

  let firstError: Error | undefined;
  for (const endpoint of modelsEndpoints(baseUrl)) {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = /timeout|abort/i.test(message);
      firstError ??= new KolorStateError(
        timedOut ? `请求模型列表超时：${endpoint}` : `无法连接 ${endpoint}：${message}`,
        { cause: error },
      );
      continue;
    }

    if (!response.ok) {
      const body = await safeText(response);
      firstError ??= new KolorStateError(
        `模型列表请求失败：${endpoint} 返回 ${response.status} ${response.statusText}${
          body === '' ? '' : ` — ${clip(body, 300)}`
        }`,
      );
      continue;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      firstError ??= new KolorStateError(`${endpoint} 没有返回 JSON`, { cause: error });
      continue;
    }
    return { models: parseModelsPayload(payload), endpoint };
  }

  throw firstError ?? new KolorStateError('could not list models from this provider');
}

/** `<base>/models` candidates, most specific first. */
export function modelsEndpoints(baseUrl: string): string[] {
  const chatEndpoint = toChatCompletionsUrl(baseUrl);
  const primary = chatEndpoint.replace(/\/chat\/completions$/, '/models');
  const endpoints = [primary];
  if (!/\/v\d+[a-z]*\/models$/i.test(new URL(primary).pathname)) {
    const root = new URL(normalizeBaseUrl(baseUrl));
    root.pathname = `${root.pathname.replace(/\/+$/, '')}/v1/models`;
    endpoints.push(root.toString());
  }
  return [...new Set(endpoints)];
}

/**
 * Normalise the base URL a user typed.
 *
 * Strips a pasted `/chat/completions` or `/models` suffix so the stored value
 * is the API root, which both chat and discovery can build on.
 */
export function normalizeBaseUrl(input: string): string {
  if (typeof input !== 'string') throw new KolorStateError('baseUrl must be a string');
  const raw = input.trim();
  if (raw === '') throw new KolorStateError('接口地址不能为空');
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new KolorStateError(`接口地址不是合法 URL：${raw}`, { cause: error });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new KolorStateError('接口地址必须以 http:// 或 https:// 开头');
  }
  let path = url.pathname.replace(/\/+$/, '');
  for (const suffix of ['/chat/completions', '/models']) {
    if (path.endsWith(suffix)) path = path.slice(0, -suffix.length);
  }
  path = path.replace(/\/+$/, '');
  url.pathname = path === '' ? '/' : path;
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function normalizeFile(value: unknown): ProviderFile {
  if (!isRecord(value)) return structuredClone(EMPTY_FILE);
  const providers: ProviderRecord[] = [];
  if (Array.isArray(value.providers)) {
    for (const entry of value.providers) {
      if (!isRecord(entry)) continue;
      const id = typeof entry.id === 'string' ? entry.id : '';
      const baseUrl = typeof entry.baseUrl === 'string' ? entry.baseUrl.trim() : '';
      if (id === '' || baseUrl === '') continue;
      providers.push({
        id,
        name: typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : baseUrl,
        baseUrl,
        apiKey: typeof entry.apiKey === 'string' ? entry.apiKey : '',
        models: normalizeModels(entry.models),
        createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date(0).toISOString(),
        updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date(0).toISOString(),
      });
    }
  }
  const rawActive = isRecord(value.active) ? value.active : undefined;
  const activeProviderId =
    typeof rawActive?.providerId === 'string' ? rawActive.providerId : '';
  const active =
    activeProviderId !== '' && providers.some((provider) => provider.id === activeProviderId)
      ? {
          providerId: activeProviderId,
          model: typeof rawActive?.model === 'string' ? rawActive.model : '',
        }
      : null;
  return { version: FILE_VERSION, active, providers };
}

function normalizeModels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    const id = typeof item === 'string' ? item.trim() : '';
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    if (seen.size >= MAX_MODELS) break;
  }
  return [...seen];
}

function normalizeName(name: string | undefined, baseUrl: string): string {
  const trimmed = (name ?? '').trim();
  const fallback = safeHostname(baseUrl);
  const value = trimmed === '' ? fallback : trimmed;
  return value.length <= MAX_NAME_LENGTH ? value : value.slice(0, MAX_NAME_LENGTH);
}

function safeHostname(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function providerTarget(provider: ProviderRecord, model: string): ModelTarget {
  return {
    apiUrl: provider.baseUrl,
    apiModelName: model,
    apiKey: provider.apiKey,
    label: `${provider.name} · ${model}`,
    providerId: provider.id,
  };
}

function toView(provider: ProviderRecord): ProviderView {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    models: [...provider.models],
    hasKey: provider.apiKey !== '',
    keyHint: keyHint(provider.apiKey),
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

function keyHint(apiKey: string): string {
  if (apiKey === '') return '';
  const tail = apiKey.slice(-4);
  return `••••${tail.length === 4 ? tail : ''}`;
}

function parseModelsPayload(payload: unknown): string[] {
  const items = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.data)
      ? payload.data
      : isRecord(payload) && Array.isArray(payload.models)
        ? payload.models
        : [];
  const ids = new Set<string>();
  for (const item of items) {
    const id =
      typeof item === 'string'
        ? item
        : isRecord(item) && typeof item.id === 'string'
          ? item.id
          : isRecord(item) && typeof item.name === 'string'
            ? item.name
            : '';
    const trimmed = id.trim();
    if (trimmed !== '') ids.add(trimmed);
  }
  return [...ids];
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return '';
  }
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
