import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BackgroundBashManager,
  DEFAULT_SYSTEM_PROMPT,
  type AgentMessage,
  type KolorAgent,
  type KolorEvent,
  type McpServerConfig,
} from 'kolorbot-agent-loop';
import { SKILL_SOURCE_LABELS, SkillsRegistry, formatSkillsBlock } from 'kolorbot-skills';
import { ConversationStore } from 'kolorbot-conversation';
import { SingleConversation } from './conversation-session.js';
import { AgentPool } from './agent-pool.js';
import { resolveWebConfig, type WebConfig, type WebConfigOverrides } from './config.js';
import { IdleDiary } from './diary-idle.js';
import {
  HttpError,
  describeError,
  readJsonBody,
  sendJson,
  sendJsonText,
  sendSse,
  startSse,
  toHttpError,
} from './http.js';
import {
  MemoryStore,
  buildTopicDiaryMessage,
  buildSelfTellMessage,
  buildSelfUpdateMessage,
  diaryDateKey,
  findLatestDiarySection,
  formatLastMessageBlock,
  formatTopicMemoryBlock,
  isDiaryCommand,
  isSelfUpdateCommand,
  memorySignature,
  personaSignature,
  readDiaryEntries,
  readDiaryTopicSection,
  readAllTopicMemoryFilesForDate,
  readTopicMemoryForDate,
  readTopicMemoryFiles,
  readTopicMemoryRecordsForDate,
  readTopicMemory,
  selfTellInfo,
} from 'kolorbot-memory';
import {
  ProviderStore,
  discoverAnthropicModels,
  discoverModels,
  type DefaultModelConfig,
  type ModelTarget,
} from './providers.js';
import {
  MODEL_KINDS,
  VENDORS,
  effectiveProtocol,
  findVendor,
  protocolsFor,
  type ModelKind,
  type ModelProtocol,
} from './model-catalog.js';
import { RunBroker, type Run, type RunListener } from './runs.js';
import { classifyTopic, type TopicDecision } from './topic-classifier.js';
import { createDiaryTools } from './diary-tools.js';
import { VERSION } from './version.js';


/** Strict diary format: the `##` heading must be exactly the topic name. */
function diaryTopicMatches(topicName: string, sectionTopic: string): boolean {
  return sectionTopic.trim() === topicName.trim();
}

/** Local days on which this topic was actually discussed. */
function topicSegmentDates(segments: ReadonlyArray<{ topicSlug: string; startedAt: string }>, slug: string): string[] {
  return [
    ...new Set(
      segments
        .filter((segment) => segment.topicSlug === slug)
        .map((segment) => diaryDateKey(new Date(segment.startedAt))),
    ),
  ].sort();
}

/** Local days on which this topic has a timestamped memory file. */
function topicDiaryDates(workspace: string, topicSlug: string): string[] {
  return [...new Set(readTopicMemoryFiles(workspace, topicSlug).map((file) => file.date))].sort();
}
/** Default quiet period before the automatic diary turn. */
const DEFAULT_DIARY_IDLE_MS = 10 * 60 * 1000;

/**
 * System prompt: the generic agent-loop prompt plus the topic diary tools.
 */
const KOLOR_SYSTEM_PROMPT = [
  DEFAULT_SYSTEM_PROMPT,
  '',
  'The conversation is organized into topics. list_topics, read_today_memory, read_topic_memory and read_diary are available for reading. write_diary, write_topic and write_topic_note are only enabled during an explicit memory turn; in ordinary chat, do not write diary entries or topic memory files.',
  'Finish what you start: do not end a turn with a promise to do something later, and do not stop after a plan or a partial implementation. Keep calling tools and verifying until the task is actually done, then report briefly. Only stop early when you need information or permission from the user.',
].join('\n');

export interface KolorWebOptions extends WebConfigOverrides {
  /** Inject the single conversation (tests); defaults to the configured database path. */
  store?: SingleConversation;
  /** Quiet period before the automatic diary turn; default 10 minutes. */
  diaryIdleMs?: number;
  logger?: (message: string, error?: unknown) => void;
}

export interface KolorWebServer {
  server: Server;
  url: string;
  port: number;
  config: WebConfig;
  store: SingleConversation;
  pool: AgentPool;
  /** Model providers stored in `providers.json`. */
  providers: ProviderStore;
  /** Diary settings and markdown files under `<workspace>/daily`. */
  memory: MemoryStore;
  /** Per-session idle timers that trigger the diary turn. */
  diaryIdle: IdleDiary;
  /** Turns that keep running after the client that started them went away. */
  runs: RunBroker;
  close(): Promise<void>;
}

const STATIC_FILES = new Map<string, string>([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/styles.css', 'styles.css'],
  ['/logo.png', 'logo.png'],
  ['/favicon.svg', 'favicon.svg'],
  ['/icons/chat.svg', 'icons/chat.svg'],
  ['/icons/topics.svg', 'icons/topics.svg'],
  ['/icons/history.svg', 'icons/history.svg'],
  ['/icons/skills.svg', 'icons/skills.svg'],
  ['/icons/models.svg', 'icons/models.svg'],
  ['/icons/memory.svg', 'icons/memory.svg'],
]);

const CONTENT_TYPES: Record<string, string> = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'styles.css': 'text/css; charset=utf-8',
  'logo.png': 'image/png',
  'favicon.svg': 'image/svg+xml',
  'icons/chat.svg': 'image/svg+xml',
  'icons/topics.svg': 'image/svg+xml',
  'icons/history.svg': 'image/svg+xml',
  'icons/skills.svg': 'image/svg+xml',
  'icons/models.svg': 'image/svg+xml',
  'icons/memory.svg': 'image/svg+xml',
};

const AVATAR_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

/** Resolve a local avatar path, treating relative paths as workspace-relative. */
function resolveAvatarFile(root: string, raw: string): string | undefined {
  let value = raw.trim();
  if (value === '' || /^https?:\/\//i.test(value)) return undefined;
  try {
    if (value.startsWith('file://')) value = fileURLToPath(value);
  } catch {
    return undefined;
  }
  const candidate = isAbsolute(value) ? value : resolve(root, value);
  if (!existsSync(candidate)) return undefined;
  if (!isAbsolute(value)) {
    const rel = relative(root, candidate);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  }
  return candidate;
}

/** Convert skill-declared servers to the shape `KolorAgent` expects. */
function skillMcpConfigs(registry: SkillsRegistry): McpServerConfig[] {
  return registry.mcpServers().map((server) => {
    if (server.transport === 'stdio') {
      return {
        name: server.name,
        transport: 'stdio',
        command: server.command,
        args: server.args,
        cwd: server.cwd,
        ...(server.env === undefined ? {} : { env: server.env }),
      };
    }
    return {
      name: server.name,
      transport: server.transport,
      url: server.url,
      ...(server.headers === undefined ? {} : { headers: server.headers }),
    };
  });
}

/** Never expose MCP env/headers (API keys) to the browser. */
function publicMcpServers(
  registry: SkillsRegistry,
): Array<{ name: string; transport: string; skillId: string }> {
  return registry.mcpServers().map((server) => ({
    name: server.name,
    transport: server.transport,
    skillId: server.skillId,
  }));
}

/**
 * Start the KolorBot web app: chat UI, session store, MCP manager.
 *
 * Binds to localhost by default. There is no authentication; do not expose it
 * on a public interface.
 */
export async function createKolorWebServer(options: KolorWebOptions = {}): Promise<KolorWebServer> {
  const config = resolveWebConfig(options);
  mkdirSync(config.home, { recursive: true });
  mkdirSync(config.frameRoot, { recursive: true });

  const store = options.store ?? new SingleConversation(new ConversationStore({ path: config.conversationDbPath }));
  const providers = new ProviderStore({ path: join(config.home, 'providers.json') });
  const defaults = (): DefaultModelConfig => ({
    apiUrl: config.apiUrl,
    apiModelName: config.apiModelName,
    apiKey: config.apiKey,
  });
  const activeTarget = (): ModelTarget | undefined => providers.resolve(defaults());
  /** True only when the process was started with an explicit endpoint, model and key. */
  const hasEnvFallback = (): boolean =>
    config.apiUrl.trim() !== '' &&
    config.apiModelName.trim() !== '' &&
    config.apiKey.trim() !== '';

  const skillsRegistry = new SkillsRegistry({
    roots: [
      { source: 'user', path: config.userSkillsDir },
      { source: 'agents', path: config.skillsDir },
      { source: 'builtin', path: config.builtinSkillsDir },
    ],
    env: {
      ...process.env,
      ...(config.apiKey === ''
        ? {}
        : { DEEPSEEK_API_KEY: config.apiKey, KOLOR_API_KEY: config.apiKey }),
    },
  });
  mkdirSync(config.skillsDir, { recursive: true });
  mkdirSync(config.userSkillsDir, { recursive: true });

  const diaryIdleMs = options.diaryIdleMs ?? DEFAULT_DIARY_IDLE_MS;
  const memory = new MemoryStore({
    home: config.home,
    diaryDir: join(config.frameRoot, 'daily'),
    selfPath: join(config.frameRoot, 'AI.md'),
  });

  /** Set while a diary/backfill turn is writing a topic other than the chat topic. */
  let toolsTopicOverride: string | undefined;
  /** Diary/topic file writes are only allowed during diary turns. */
  let diaryWriteAllowed = false;
  /** Reserved synchronously by /api/message before its internal chat request starts. */
  let callbackTurnBusy = false;

  const backgroundNoticeQueue: string[] = [];
  let backgroundDispatchInFlight = false;
  const backgroundTasks = new BackgroundBashManager({
    maxRunning: 8,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    onComplete: (taskName) => {
      backgroundNoticeQueue.push(taskName);
      dispatchBackgroundNotification();
    },
  });

  const pool = new AgentPool({
    mcpConfigs: () => skillMcpConfigs(skillsRegistry),
    systemPrompt: KOLOR_SYSTEM_PROMPT,
    toolsForSession: () =>
      createDiaryTools({
        store: store.store,
        diaryDir: memory.diaryDir,
        workspace: config.frameRoot,
        currentTopicSlug: () => toolsTopicOverride ?? store.current().topic.slug,
        writeEnabled: () => diaryWriteAllowed,
      }),
    kolorFrame: {
      root: config.frameRoot,
      skillsRoot: config.skillsDir,
      extraSkillRoots: [config.userSkillsDir, config.builtinSkillsDir],
      background: backgroundTasks,
    },
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  const runs = new RunBroker();
  const publicDir = findPublicDir();

  /** Topic/write state for the isolated diary worker (one job at a time). */
  let diaryJobTopic: string | undefined;
  let diaryJobWrite = false;
  let diaryJobWriteAt: Date | undefined;
  const diaryPool = new AgentPool({
    mcpConfigs: () => skillMcpConfigs(skillsRegistry),
    systemPrompt: KOLOR_SYSTEM_PROMPT,
    toolsForSession: () =>
      createDiaryTools({
        store: store.store,
        diaryDir: memory.diaryDir,
        workspace: config.frameRoot,
        currentTopicSlug: () => diaryJobTopic ?? store.current().topic.slug,
        writeEnabled: () => diaryJobWrite,
        writeAt: () => diaryJobWriteAt,
      }),
    kolorFrame: {
      root: config.frameRoot,
      skillsRoot: config.skillsDir,
      extraSkillRoots: [config.userSkillsDir, config.builtinSkillsDir],
    },
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  const diaryIdle = new IdleDiary({
    idleMs: diaryIdleMs,
    isEnabled: () => memory.settings().diary.autoAppend,
    onFire: (sessionId) => runDiaryTurn(sessionId),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  /** URL used by the callback-message bridge to call this same server. */
  let localBaseUrl = '';
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        if (!response.writableEnded) response.end();
        return;
      }
      const { status, message } = toHttpError(error);
      sendJson(response, status, { error: message });
    });
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (!url.pathname.startsWith('/api/')) {
      serveStatic(url.pathname, response);
      return;
    }
    await handleApi(request, response, url.pathname, url.searchParams);
  }

  function serveStatic(pathname: string, response: ServerResponse): void {
    if (pathname.startsWith('/skill-code/')) {
      serveSkillCode(pathname, response);
      return;
    }
    const file = STATIC_FILES.get(pathname);
    if (file === undefined) throw new HttpError(404, 'not found');
    const body = readFileSync(join(publicDir, file));
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[file] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    response.end(body);
  }

  /** Serve one file from a skill's `code/` directory. */
  function serveSkillCode(pathname: string, response: ServerResponse): void {
    const match = /^\/skill-code\/([^/]+)\/(.+)$/.exec(pathname);
    if (match === null) throw new HttpError(404, 'not found');
    let id: string;
    let relativePath: string;
    try {
      id = decodeURIComponent(match[1] as string);
      relativePath = decodeURIComponent(match[2] as string);
    } catch {
      throw new HttpError(400, 'invalid skill code path');
    }
    const skill = skillsRegistry.codeSkills().find((entry) => entry.id === id);
    if (skill === undefined) throw new HttpError(404, 'unknown skill code');
    const codeRoot = skill.codeDir;
    const file = resolve(codeRoot, relativePath);
    if (file !== codeRoot && !file.startsWith(`${codeRoot}${sep}`)) {
      throw new HttpError(404, 'not found');
    }
    let body: Buffer;
    try {
      body = readFileSync(file);
    } catch {
      throw new HttpError(404, 'not found');
    }
    const types: Record<string, string> = {
      '.js': 'text/javascript; charset=utf-8',
      '.mjs': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
    };
    response.writeHead(200, {
      'content-type': types[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    response.end(body);
  }

  async function handleApi(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
    query: URLSearchParams,
  ): Promise<void> {
    const method = request.method ?? 'GET';

    if (pathname === '/api/config' && method === 'GET') {
      const active = providers.activeView(defaults());
      sendJson(response, 200, {
        version: VERSION,
        apiUrl: config.apiUrl,
        apiModelName: config.apiModelName,
        hasApiKey: config.apiKey !== '',
        hasModel: active.source !== 'none',
        activeModel: active,
        home: config.home,
        frameRoot: config.frameRoot,
        skillsDir: config.skillsDir,
        conversationDbPath: config.conversationDbPath,
        mcpServers: publicMcpServers(skillsRegistry),
        mcpStatus: pool.mcpStatus,
      });
      return;
    }

    if (pathname === '/api/conversation' && method === 'GET') {
      const current = store.current();
      sendJson(response, 200, {
        conversation: store.view(),
        current: { topic: current.topic, segment: current.segment },
      });
      return;
    }

    if (pathname === '/api/calendar' && method === 'GET') {
      const unique = [...new Set(
        store.store.listSegments().map((segment) => diaryDateKey(new Date(segment.startedAt))),
      )].sort();
      const byMonth = new Map<string, string[]>();
      for (const date of unique) {
        const month = date.slice(0, 7);
        const days = byMonth.get(month);
        if (days === undefined) byMonth.set(month, [date]);
        else days.push(date);
      }
      sendJson(response, 200, {
        dates: unique,
        months: [...byMonth.entries()]
          .sort(([a], [b]) => b.localeCompare(a))
          .map(([month, days]) => ({ month, days })),
        count: unique.length,
      });
      return;
    }

    const globalDayMatch = /^\/api\/days\/(\d{4}-\d{2}-\d{2})$/.exec(pathname);
    if (globalDayMatch !== null && method === 'GET') {
      const date = globalDayMatch[1] as string;
      const topicNames = new Map(
        store.store.listTopics().map((topic) => [topic.slug, topic.name]),
      );
      const segments = store.store
        .listSegments()
        .filter((segment) => diaryDateKey(new Date(segment.startedAt)) === date)
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        .map((segment) => ({
          id: segment.id,
          topicSlug: segment.topicSlug,
          topicName: topicNames.get(segment.topicSlug) ?? segment.topicSlug,
          startedAt: segment.startedAt,
          endedAt: segment.endedAt,
          messages: store.store.segmentMessages(segment.id),
        }));
      const memories = readAllTopicMemoryFilesForDate(config.frameRoot, date).map((record) => ({
        topicSlug: record.topicSlug,
        topicName: topicNames.get(record.topicSlug) ?? record.topicSlug,
        time: record.time,
        content: record.content,
      }));
      sendJson(response, 200, { date, segments, memories });
      return;
    }

    if (pathname === '/api/topics' && method === 'GET') {
      const topics = store.store.listTopics();
      const segments = store.store.listSegments();
      const conversationDates = new Map<string, Set<string>>();
      const diaryCounts = new Map<string, Set<string>>();
      for (const topic of topics) {
        conversationDates.set(topic.slug, new Set(topicSegmentDates(segments, topic.slug)));
        diaryCounts.set(topic.slug, new Set(topicDiaryDates(config.frameRoot, topic.slug)));
      }
      sendJson(response, 200, {
        topics: topics.map((topic) => ({
          ...topic,
          conversationDays: conversationDates.get(topic.slug)?.size ?? 0,
          diaryDays: diaryCounts.get(topic.slug)?.size ?? 0,
        })),
      });
      return;
    }

    const topicBackfillMatch = /^\/api\/topics\/([^/]+)\/days\/(\d{4}-\d{2}-\d{2})\/diary$/.exec(
      pathname,
    );
    if (topicBackfillMatch !== null && method === 'POST') {
      const slug = decodeURIComponent(topicBackfillMatch[1] as string);
      const date = topicBackfillMatch[2] as string;
      const topic = store.store.topic(slug);
      if (topic === undefined) throw new HttpError(404, 'unknown topic');
      const started = await startBackfillDiary(slug, date);
      if (!started.started) {
        throw new HttpError(started.status ?? 409, started.reason ?? 'could not start');
      }
      sendJson(response, 202, { started: true });
      return;
    }

    const topicDayMatch = /^\/api\/topics\/([^/]+)\/days\/(\d{4}-\d{2}-\d{2})$/.exec(pathname);
    if (topicDayMatch !== null && method === 'GET') {
      const slug = decodeURIComponent(topicDayMatch[1] as string);
      const date = topicDayMatch[2] as string;
      const topic = store.store.topic(slug);
      if (topic === undefined) throw new HttpError(404, 'unknown topic');
      const segments = store.store
        .listSegments()
        .filter(
          (segment) =>
            segment.topicSlug === slug &&
            diaryDateKey(new Date(segment.startedAt)) === date,
        )
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        .map((segment) => ({
          id: segment.id,
          startedAt: segment.startedAt,
          endedAt: segment.endedAt,
          messages: store.store.segmentMessages(segment.id),
        }));
      const records = readTopicMemoryRecordsForDate(config.frameRoot, topic.slug, date);
      const diary = records
        .map((record, index) => {
          const segment = segments[index];
          let time = record.time;
          if (segment !== undefined) {
            const at = new Date(segment.startedAt);
            time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
          }
          return `### 片段 ${index + 1} · ${time}\n\n${record.content.trim()}`;
        })
        .join('\n\n---\n\n');
      sendJson(response, 200, {
        topic,
        date,
        segments,
        diary,
        hasDiary: diary !== '',
      });
      return;
    }

    const topicCalendarMatch = /^\/api\/topics\/([^/]+)$/.exec(pathname);
    if (topicCalendarMatch !== null && method === 'GET') {
      const slug = decodeURIComponent(topicCalendarMatch[1] as string);
      const topic = store.store.topic(slug);
      if (topic === undefined) throw new HttpError(404, 'unknown topic');
      const dates = topicSegmentDates(store.store.listSegments(), slug);
      const diaryDates = topicDiaryDates(config.frameRoot, topic.slug);
      const byMonth = new Map<string, string[]>();
      for (const date of dates) {
        const month = date.slice(0, 7);
        const days = byMonth.get(month);
        if (days === undefined) byMonth.set(month, [date]);
        else days.push(date);
      }
      sendJson(response, 200, {
        topic,
        dates,
        diaryDates,
        memory: readTopicMemory(config.frameRoot, topic.slug),
        months: [...byMonth.entries()]
          .sort(([a], [b]) => b.localeCompare(a))
          .map(([month, days]) => ({ month, days })),
      });
      return;
    }

    if (pathname === '/api/providers') {
      if (method === 'GET') {
        sendJson(response, 200, providerPayload());
        return;
      }
      if (method === 'POST') {
        const added = await addProvider(request);
        sendJson(response, 201, added);
        return;
      }
      throw new HttpError(405, 'method not allowed');
    }

    const providerMatch = /^\/api\/providers\/([A-Za-z0-9_-]+)$/.exec(pathname);
    if (providerMatch !== null) {
      const id = providerMatch[1] as string;
      if (method === 'DELETE') {
        const deleted = providers.remove(id);
        sendJson(response, 200, {
          deleted,
          active: providers.activeView(defaults()),
        });
        return;
      }
      throw new HttpError(405, 'method not allowed');
    }

    const providerModelsMatch = /^\/api\/providers\/([A-Za-z0-9_-]+)\/models$/.exec(pathname);
    if (providerModelsMatch !== null && method === 'POST') {
      const id = providerModelsMatch[1] as string;
      const provider = providers.record(id);
      if (provider === undefined) throw new HttpError(404, `unknown provider "${id}"`);
      const effective = effectiveProtocol(provider);
      if (effective !== 'openai' && effective !== 'anthropic') {
        throw new HttpError(400, '该厂商的模型发现接口尚未接入');
      }
      const discovered =
        effective === 'anthropic'
          ? await discoverAnthropicModels({
              baseUrl: provider.baseUrl,
              apiKey: provider.apiKey,
            })
          : await discoverModels({
              baseUrl: provider.baseUrl,
              apiKey: provider.apiKey,
            });
      providers.setModels(id, discovered.models);
      sendJson(response, 200, {
        provider: providers.get(id),
        active: providers.activeView(defaults()),
        endpoint: discovered.endpoint,
      });
      return;
    }

    if (pathname === '/api/model' && method === 'PUT') {
      const body = await readJsonBody(request);
      if (!isRecord(body) || typeof body.providerId !== 'string') {
        throw new HttpError(400, 'request body must contain a "providerId" string');
      }
      providers.setActive(body.providerId, typeof body.model === 'string' ? body.model : '');
      sendJson(response, 200, { active: providers.activeView(defaults()) });
      return;
    }

    if (pathname === '/api/memory') {
      if (method === 'GET') {
        sendJson(response, 200, memoryPayload());
        return;
      }
      if (method === 'PUT') {
        const body = await readJsonBody(request);
        if (!isRecord(body) || !isRecord(body.diary) || typeof body.diary.autoAppend !== 'boolean') {
          throw new HttpError(400, 'request body must contain { "diary": { "autoAppend": boolean } }');
        }
        const settings = memory.setDiaryAutoAppend(body.diary.autoAppend);
        if (!settings.diary.autoAppend) diaryIdle.cancelAll();
        sendJson(response, 200, memoryPayload());
        return;
      }
      throw new HttpError(405, 'method not allowed');
    }

    if (pathname === '/api/agent' && method === 'GET') {
      const self = memory.self();
      const raw = self.headImage.trim();
      const remote = /^https?:\/\//i.test(raw) ? raw : '';
      const file = raw === '' ? undefined : resolveAvatarFile(config.frameRoot, raw);
      sendJson(response, 200, {
        name: self.name.trim() || 'KolorBot',
        headImage: self.headImage,
        avatarUrl: remote !== '' ? remote : file === undefined ? '' : '/api/agent/avatar',
      });
      return;
    }

    if (pathname === '/api/agent/avatar' && method === 'GET') {
      const self = memory.self();
      const file = resolveAvatarFile(config.frameRoot, self.headImage);
      const type = file === undefined ? undefined : AVATAR_TYPES[extname(file).toLowerCase()];
      if (file === undefined || type === undefined) throw new HttpError(404, 'avatar not found');
      let body: Buffer;
      try {
        body = readFileSync(file);
      } catch {
        throw new HttpError(404, 'avatar not found');
      }
      response.writeHead(200, {
        'content-type': type,
        'content-length': body.length,
        'cache-control': 'no-store',
      });
      response.end(body);
      return;
    }

    if (pathname === '/api/skill-code' && method === 'GET') {
      sendJson(response, 200, {
        skills: skillsRegistry.codeSkills().map((skill) => ({
          id: skill.id,
          name: skill.name,
          source: skill.source,
          url: `/skill-code/${encodeURIComponent(skill.id)}/index.js`,
        })),
      });
      return;
    }

    if (pathname === '/api/skills' && method === 'GET') {
      const mcpServers = publicMcpServers(skillsRegistry);
      const publicServer = (server: { name: string; transport: string }): {
        name: string;
        transport: string;
      } => ({ name: server.name, transport: server.transport });
      const skills = skillsRegistry.list().map((skill) => ({
        ...skill,
        mcpServers: mcpServers
          .filter((server) => server.skillId === skill.id)
          .map(publicServer),
      }));
      sendJson(response, 200, {
        root: config.skillsDir,
        // Display order: compatibility area, custom area, built-in area.
        roots: (['agents', 'user', 'builtin'] as const).map((source) => {
          const root = skillsRegistry.roots.find((entry) => entry.source === source);
          return {
            source,
            label: SKILL_SOURCE_LABELS[source],
            path: root?.path ?? '',
            count: skills.filter((skill) => skill.source === source).length,
          };
        }),
        signature: skillsRegistry.signature(),
        skills,
        globalMcpServers: mcpServers
          .filter((server) => server.skillId === '')
          .map(publicServer),
      });
      return;
    }

    const skillMatch = /^\/api\/skills\/([^/]+)$/.exec(pathname);
    if (skillMatch !== null && method === 'GET') {
      const id = decodeURIComponent(skillMatch[1] as string);
      const skill = skillsRegistry.get(id);
      if (skill === undefined) throw new HttpError(404, `unknown skill "${id}"`);
      sendJson(response, 200, {
        skill: {
          ...skill,
          mcpServers: publicMcpServers(skillsRegistry)
            .filter((server) => server.skillId === id)
            .map((server) => ({ name: server.name, transport: server.transport })),
        },
      });
      return;
    }

    if (pathname === '/api/sessions') {
      if (method === 'GET') {
        const live = runs.runningSessionIds();
        sendJson(response, 200, {
          sessions: store.list().map((session) => ({
            ...session,
            running: live.has(session.id),
          })),
        });
        return;
      }
      if (method === 'POST') {
        const body = await readJsonBody(request);
        const record = isRecord(body) ? body : {};
        const session = store.create({
          ...(typeof record.name === 'string' ? { name: record.name } : {}),
          ...(record.context === undefined ? {} : { context: record.context }),
        });
        sendJson(response, 201, { session });
        return;
      }
      throw new HttpError(405, 'method not allowed');
    }

    if (pathname === '/api/sessions/import' && method === 'POST') {
      const body = await readJsonBody(request);
      const text = isRecord(body) && typeof body.json === 'string'
        ? body.json
        : JSON.stringify(body);
      const name = isRecord(body) && typeof body.name === 'string' ? body.name : undefined;
      const session = store.importJson(text, name === undefined ? {} : { name });
      sendJson(response, 201, { session });
      return;
    }

    if (pathname === '/api/diary/organize' && method === 'POST') {
      if (activeTarget() === undefined) {
        throw new HttpError(400, 'no usable model: add a provider in the web UI (模型)');
      }
      const currentSegmentId = store.current().segment.id;
      const pending = store.store
        .pendingDiarySegments()
        .filter((entry) => entry.segment.id !== currentSegmentId);
      const groups = new Map<string, Array<{ id: string; topicSlug: string; startedAt: string }>>();
      for (const entry of pending) {
        const slug = entry.segment.topicSlug;
        const group = groups.get(slug);
        if (group === undefined) groups.set(slug, [entry.segment]);
        else group.push(entry.segment);
      }
      for (const [slug, segments] of groups) {
        void enqueueDiary(
          slug,
          segments,
          diaryDateKey(new Date(segments[0]?.startedAt ?? Date.now())),
        );
      }
      sendJson(response, 202, { started: pending.length > 0, segments: pending.length });
      return;
    }

    if (pathname === '/api/chat' && method === 'POST') {
      await handleChat(request, response);
      return;
    }

    if (pathname === '/api/chat/cancel' && method === 'POST') {
      const body = await readJsonBody(request);
      const sessionId = isRecord(body) && typeof body.sessionId === 'string' ? body.sessionId : '';
      const cancelled = runs.cancel(sessionId);
      sendJson(response, 200, { cancelled });
      return;
    }

    if (pathname === '/api/message' && method === 'POST') {
      await handleCallbackMessage(request, response);
      return;
    }

    // Refresh one MCP server: close its connection and reconnect it.
    const mcpRestartMatch = /^\/api\/mcp\/([A-Za-z0-9_:%.-]+)\/restart$/.exec(pathname);
    if (mcpRestartMatch !== null && method === 'POST') {
      const name = decodeURIComponent(mcpRestartMatch[1] as string);
      if (!skillsRegistry.mcpServers().some((server) => server.name === name)) {
        throw new HttpError(404, `unknown MCP server "${name}"`);
      }
      const status = await pool.restartMcpServer(name);
      sendJson(response, 200, { status: status ?? null, mcpStatus: pool.mcpStatus });
      return;
    }

    if (pathname === '/api/mcp') {
      if (method === 'GET') {
        sendJson(response, 200, {
          servers: publicMcpServers(skillsRegistry),
          frameRoot: config.frameRoot,
          status: pool.mcpStatus,
        });
        return;
      }
      throw new HttpError(
        405,
        'MCP servers are read from skill kolor.json files; the web UI is read-only',
      );
    }

    const exportMatch = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/export$/.exec(pathname);
    if (exportMatch !== null && method === 'GET') {
      const record = store.require(exportMatch[1] as string);
      const payload = store.exportJson(record.id);
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${safeFilename(record.name)}.json"`,
        'content-length': Buffer.byteLength(payload),
        'cache-control': 'no-store',
      });
      response.end(payload);
      return;
    }

    const runMatch = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/run$/.exec(pathname);
    if (runMatch !== null && method === 'GET') {
      const id = runMatch[1] as string;
      store.require(id);
      const view = runs.view(id);
      // Only a live turn has a buffer; a finished one is read from the session.
      const buffered = runs.active(id)?.events ?? [];
      // Hand-built so a multi-megabyte replay is never re-parsed.
      sendJsonText(
        response,
        200,
        `{"running":${runs.isRunning(id)},"run":${view === undefined ? 'null' : JSON.stringify(view)},"events":[${buffered.join(',')}]}`,
      );
      return;
    }

    const streamMatch = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/stream$/.exec(pathname);
    if (streamMatch !== null && method === 'GET') {
      const id = streamMatch[1] as string;
      store.require(id);
      const from = Number(query.get('from') ?? '0');
      attachRunSse(response, id, Number.isFinite(from) ? from : 0);
      return;
    }

    const topicMatch = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/topic$/.exec(pathname);
    if (topicMatch !== null && method === 'PUT') {
      const body = await readJsonBody(request);
      if (!isRecord(body) || typeof body.topic !== 'string') {
        throw new HttpError(400, 'request body must contain a "topic" string');
      }
      sendJson(response, 200, { session: store.setTopic(topicMatch[1] as string, body.topic) });
      return;
    }

    const resetMatch = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/reset$/.exec(pathname);
    if (resetMatch !== null && method === 'POST') {
      const id = resetMatch[1] as string;
      diaryIdle.cancel(id);
      runs.cancel(id, 'reset');
      const session = store.reset(id);
      await pool.disposeSession(id);
      sendJson(response, 200, { session });
      return;
    }

    const contextMatch = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/context$/.exec(pathname);
    if (contextMatch !== null && method === 'PUT') {
      const id = contextMatch[1] as string;
      const body = await readJsonBody(request);
      if (!isRecord(body) || body.context === undefined) {
        throw new HttpError(400, 'request body must contain a "context" array');
      }
      const session = store.replaceContext(id, body.context);
      sendJson(response, 200, { session });
      return;
    }

    const sessionMatch = /^\/api\/sessions\/([A-Za-z0-9_-]+)$/.exec(pathname);
    if (sessionMatch !== null) {
      const id = sessionMatch[1] as string;
      if (method === 'GET') {
        // `running` lets a client that just opened join a turn in progress.
        sendJson(response, 200, {
          session: store.require(id),
          running: runs.isRunning(id),
        });
        return;
      }
      if (method === 'PATCH') {
        const body = await readJsonBody(request);
        if (!isRecord(body) || typeof body.name !== 'string') {
          throw new HttpError(400, 'request body must contain a "name" string');
        }
        sendJson(response, 200, { session: store.rename(id, body.name) });
        return;
      }
      if (method === 'DELETE') {
        diaryIdle.cancel(id);
        runs.cancel(id, 'delete');
        const removed = store.delete(id);
        await pool.disposeSession(id);
        sendJson(response, 200, { deleted: removed });
        return;
      }
      throw new HttpError(405, 'method not allowed');
    }

    throw new HttpError(404, 'not found');
  }

  async function handleChat(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request);
    if (!isRecord(body) || typeof body.text !== 'string') {
      throw new HttpError(400, 'text is required');
    }
    const text = body.text.trim();
    if (text === '') throw new HttpError(400, 'text must not be empty');
    const autoNext = body.autoNext !== false;
    const target = activeTarget();
    if (target === undefined) {
      throw new HttpError(
        400,
        'no usable model: add a provider in the web UI (模型), or set KOLOR_API_URL / KOLOR_API_MODEL / DEEPSEEK_API_KEY and restart kolorbot-web',
      );
    }

    const session = store.require(store.id);
    diaryIdle.cancel(session.id);

    await pool.ensureSignature();

    // `/update-daily-memory`, `/self-md-update` and `/self-md-tell` become
    // task messages; diary writes go through the dedicated tools.
    const selfInfo = selfTellInfo(text);
    const diaryTurn = isDiaryCommand(text);
    let outgoing = text;
    if (diaryTurn) {
      outgoing = buildTopicDiaryMessage(new Date(), []);
    } else if (isSelfUpdateCommand(text)) {
      outgoing = buildSelfUpdateMessage();
    } else if (selfInfo !== undefined) {
      if (selfInfo === '') {
        throw new HttpError(400, 'send some information after /self-md-tell');
      }
      outgoing = buildSelfTellMessage(selfInfo);
    }
    const commandTurn = outgoing !== text;

    // Every ordinary message is routed into a topic before the turn starts.
    const current = store.current();
    let topic = current.topic;
    let segment = current.segment;
    let previousSegment: typeof current.segment | undefined;
    let switched = false;
    const segmentCount = store.store.segmentMessages(segment.id).length;
    const dayChanged =
      !commandTurn &&
      segmentCount > 0 &&
      diaryDateKey(new Date(segment.startedAt)) !== diaryDateKey(new Date());

    if (!commandTurn) {
      const decision = await classifyTopic({
        target,
        topics: store.store.listTopics(),
        currentTopic: segmentCount === 0 ? '(none)' : topic.name,
        recent: store.store.lastTextMessages(segment.id, 6),
        text,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });
      const next = resolveTopicDecision(decision, current.topic.slug);
      if (next !== undefined) {
        const empty = store.store.segmentMessages(segment.id).length === 0;
        if (empty) {
          // The adapter creates a placeholder default segment on first load;
          // retitle it instead of leaving an empty extra segment behind.
          store.store.retopicSegment(segment.id, next.slug);
          store.store.deleteTopicIfUnused(topic.slug);
          topic = next;
          segment = store.store.segment(segment.id) as typeof segment;
        } else {
          previousSegment = segment;
          topic = next;
          segment = store.store.startSegment(topic.slug, personaSignature(memory.self().content));
        }
        switched = true;
        await pool.disposeSession(session.id);
      } else if (dayChanged) {
        // Same topic, but the first message of a new local day: close the old
        // segment so the previous day can be organized independently.
        previousSegment = segment;
        segment = store.store.startSegment(topic.slug, personaSignature(memory.self().content));
        await pool.disposeSession(session.id);
      }
    }

    if (runs.isRunning(session.id)) {
      throw new HttpError(409, 'the conversation already has a running turn');
    }

    const prepared = buildTopicMessage({
      topic,
      segment,
      previousSegment,
      text: outgoing,
    });

    // The turn lives in the broker, not in this request: attaching the SSE
    // response is the only thing this handler does with the connection.
    const run = ((): Run => {
      try {
        return runs.begin({ sessionId: session.id, kind: 'chat', prompt: outgoing });
      } catch {
        throw new HttpError(409, 'the conversation already has a running turn');
      }
    })();
    if (switched) {
      runs.publish(run, {
        type: 'topic/switch',
        topic: { slug: topic.slug, name: topic.name },
        segmentId: segment.id,
      });
    }
    if (previousSegment !== undefined) {
      // The old topic is closed. Hand its transcript to the isolated diary
      // agent now, without waiting for the idle timer or reusing this agent.
      void enqueueDiary(
        previousSegment.topicSlug,
        [previousSegment],
        diaryDateKey(new Date(previousSegment.startedAt)),
      );
    }
    if (diaryTurn) diaryWriteAllowed = true;
    try {
      attachRunSse(response, session.id, 0);
      await driveTurn(run, {
        target,
        context: store.store.segmentMessages(segment.id),
        message: prepared,
        autoNext: autoNext && !commandTurn,
      });
    } catch (error) {
      // A broken socket must still close the run, or the conversation stays busy.
      if (runs.isRunning(session.id)) runs.finish(run, 'error', error);
    } finally {
      if (diaryTurn) diaryWriteAllowed = false;
      // Only a user turn restarts the quiet period.
      diaryIdle.noteTurnFinished(session.id);
      if (!diaryTurn) enqueuePendingSegments(segment.id);
    }
  }

  /** POST one JSON payload to a user-supplied callback URL. */
  async function postCallback(callbackUrl: string, payload: Record<string, unknown>): Promise<void> {
    try {
      const response = await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      await response.text().catch(() => '');
      if (!response.ok) {
        options.logger?.(`callback returned HTTP ${response.status}: ${callbackUrl}`);
      }
    } catch (error) {
      options.logger?.(
        `callback delivery failed: ${callbackUrl}`,
        error,
      );
    }
  }

  /** Send one external message and mirror each assistant context to its callback. */
  async function forwardCallbackTurn(message: string, callbackUrl: string): Promise<void> {
    let segment = '';
    let fullText = '';
    let contexts = 0;
    let status = 'done';
    let failure = '';

    const flushContext = async (): Promise<void> => {
      if (segment.trim() === '') {
        segment = '';
        return;
      }
      const context = segment;
      segment = '';
      contexts += 1;
      await postCallback(callbackUrl, {
        type: 'context',
        last: false,
        context,
        text: context,
        sequence: contexts,
        at: new Date().toISOString(),
      });
    };

    try {
      const callbackResponse = await fetch(`${localBaseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: message }),
      });
      if (!callbackResponse.ok) {
        const errorText = (await callbackResponse.text().catch(() => '')).slice(0, 4000);
        await postCallback(callbackUrl, {
          type: callbackResponse.status === 409 ? 'busy' : 'error',
          last: true,
          error: errorText === '' ? `chat request failed (${callbackResponse.status})` : errorText,
          at: new Date().toISOString(),
        });
        return;
      }
      if (callbackResponse.body === null) throw new Error('chat response has no body');

      const reader = callbackResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const processBlock = async (block: string): Promise<void> => {
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data === '' || data === '[DONE]') return;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(data) as Record<string, unknown>;
        } catch {
          return;
        }
        const type = typeof event.type === 'string' ? event.type : '';
        if (type === 'text/delta' && typeof event.text === 'string') {
          segment += event.text;
          fullText += event.text;
          return;
        }
        if (
          type === 'tool/call' ||
          type === 'tool/result' ||
          type === 'tool/skipped' ||
          type === 'turn/end' ||
          type === 'run/cancelled' ||
          type === 'web/error'
        ) {
          await flushContext();
          if (type === 'run/cancelled') status = 'cancelled';
          if (type === 'web/error' && typeof event.message === 'string') {
            failure = event.message;
          }
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          await processBlock(block);
          boundary = buffer.indexOf('\n\n');
        }
      }
      await flushContext();

      if (failure !== '') {
        await postCallback(callbackUrl, {
          type: 'error',
          last: true,
          error: failure,
          text: fullText,
          contexts,
          at: new Date().toISOString(),
        });
      } else {
        await postCallback(callbackUrl, {
          type: 'done',
          last: true,
          status,
          text: fullText,
          contexts,
          at: new Date().toISOString(),
        });
      }
    } catch (error) {
      try {
        await flushContext();
      } catch {
        // The callback failure above is the useful error.
      }
      await postCallback(callbackUrl, {
        type: 'error',
        last: true,
        error: describeError(error),
        text: fullText,
        contexts,
        at: new Date().toISOString(),
      });
    }
  }

  /** `POST /api/message`: fire a turn and mirror assistant contexts to a callback. */
  async function handleCallbackMessage(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody(request);
    if (!isRecord(body)) throw new HttpError(400, 'request body must be JSON');
    const message =
      typeof body.message === 'string'
        ? body.message
        : typeof body.text === 'string'
          ? body.text
          : '';
    const rawCallback =
      typeof body.callbackUrl === 'string'
        ? body.callbackUrl
        : typeof body.callback === 'string'
          ? body.callback
          : '';
    if (message.trim() === '') throw new HttpError(400, 'message is required');
    if (rawCallback.trim() === '') throw new HttpError(400, 'callbackUrl is required');
    let callback: URL;
    try {
      callback = new URL(rawCallback.trim());
    } catch {
      throw new HttpError(400, 'callbackUrl must be a valid URL');
    }
    if (callback.protocol !== 'http:' && callback.protocol !== 'https:') {
      throw new HttpError(400, 'callbackUrl must use http or https');
    }
    if (activeTarget() === undefined) {
      throw new HttpError(400, 'no usable model: add a provider in the web UI (模型)');
    }
    if (runs.isRunning(store.id) || callbackTurnBusy) {
      throw new HttpError(409, 'the AI is already processing a message');
    }
    callbackTurnBusy = true;

    sendJson(response, 202, {
      accepted: true,
      callbackUrl: callback.toString(),
      message: message.trim(),
    });
    void forwardCallbackTurn(message, callback.toString()).finally(() => {
      callbackTurnBusy = false;
    });
  }

  /** Apply the classifier's decision; `undefined` means "keep the current topic". */
  function resolveTopicDecision(
    decision: TopicDecision,
    currentSlug: string,
  ): ReturnType<SingleConversation['current']>['topic'] | undefined {
    if (decision.action === 'switch' && decision.slug !== undefined) {
      const topic = store.store.topic(decision.slug);
      return topic === undefined || topic.slug === currentSlug ? undefined : topic;
    }
    if (decision.action === 'new' && decision.name !== undefined) {
      const rawName = decision.name.trim();
      const name = rawName.replace(/\s*(话题|topic)\s*$/iu, '').trim() || rawName;
      const topic = store.store.ensureTopic(name, decision.slug);
      return topic.slug === currentSlug ? undefined : topic;
    }
    return undefined;
  }

  /**
   * Build the message for one topic turn: skills + topic memory on a fresh
   * segment (or when the persona changed) and the previous topic's last ten
   * messages on the first message of a new segment.
   */
  function buildTopicMessage(input: {
    topic: ReturnType<SingleConversation['current']>['topic'];
    segment: ReturnType<SingleConversation['current']>['segment'];
    previousSegment: ReturnType<SingleConversation['current']>['segment'] | undefined;
    text: string;
  }): string {
    const count = store.store.segmentMessages(input.segment.id).length;
    const blocks: string[] = [];

    if (count === 0) {
      const installed = skillsRegistry.list();
      if (installed.length > 0) blocks.push(formatSkillsBlock(installed));
    }

    const persona = memory.self().content;
    const signature = personaSignature(persona);
    if (count === 0 || input.segment.memorySignature !== signature) {
      const records = readTopicMemoryFiles(config.frameRoot, input.topic.slug);
      const latestRecord = records.at(-1);
      const memoryBlock = formatTopicMemoryBlock({
        persona,
        topicName: input.topic.name,
        topicContent: readTopicMemory(config.frameRoot, input.topic.slug),
        ...(latestRecord === undefined
          ? {}
          : {
              recordName: latestRecord.path.split(/[\\/]/).at(-1),
              recordContent: latestRecord.content,
            }),
      });
      if (memoryBlock !== '') blocks.push(memoryBlock);
      store.store.setSegmentMemorySignature(input.segment.id, signature);
    }

    if (input.previousSegment !== undefined) {
      const last = store.store.lastTextMessages(input.previousSegment.id, 10);
      const lastBlock = formatLastMessageBlock(last);
      if (lastBlock !== '') blocks.push(lastBlock);
    }

    return blocks.length === 0 ? input.text : `${blocks.join('\n\n')}\n\n${input.text}`;
  }

  /**
   * Drive one turn to completion, publishing every event into the broker.
   *
   * Nothing here depends on a client being connected, so closing the tab or
   * losing the network only detaches the live view. The context is persisted
   * at the end, which is what a client returning later reads back.
   */
  function lastAssistantContentEmpty(context: readonly AgentMessage[]): boolean {
    const last = context.at(-1);
    // A turn that ends on a tool result (or with no assistant at all) never
    // reached its final answer; a tool-call assistant alone does not count.
    if (last?.role === 'tool' || last?.role === 'user') return true;
    if (last?.role === 'assistant') return last.content.trim() === '';
    for (let index = context.length - 1; index >= 0; index -= 1) {
      const message = context[index];
      if (message?.role === 'assistant') return message.content.trim() === '';
    }
    return true;
  }

  /**
   * Post a synthetic user message through the normal chat path. It is
   * persisted and shown exactly like a real user message.
   */
  async function sendSyntheticUserMessage(text: string, autoNext: boolean): Promise<void> {
    if (localBaseUrl === '') {
      options.logger?.('cannot send synthetic user message: server URL is not ready');
      return;
    }
    try {
      const response = await fetch(`${localBaseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, autoNext }),
      });
      if (!response.ok) {
        options.logger?.(`synthetic user message failed with HTTP ${response.status}`);
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      if (response.body === null) return;
      const reader = response.body.getReader();
      while (!(await reader.read()).done) {
        // Drain the SSE stream so the headless turn can finish cleanly.
      }
    } catch (error) {
      options.logger?.(`synthetic user message failed: ${text}`, error);
    }
  }

  /**
   * Dispatch the oldest completed background task. A queued task whose output
   * was fully read (record deleted) or explicitly stopped is skipped silently.
   */
  function dispatchBackgroundNotification(): boolean {
    if (runs.isRunning('main') || backgroundDispatchInFlight) return false;
    while (backgroundNoticeQueue.length > 0) {
      const taskName = backgroundNoticeQueue.shift();
      if (taskName === undefined || !backgroundTasks.consumeNotification(taskName)) continue;
      backgroundDispatchInFlight = true;
      void sendSyntheticUserMessage(`${taskName} has done.`, true).finally(() => {
        backgroundDispatchInFlight = false;
        dispatchBackgroundNotification();
      });
      return true;
    }
    return false;
  }

  /**
   * Continue a naturally finished turn whose last assistant message is empty.
   */
  function requestAutoNext(): void {
    void sendSyntheticUserMessage('Next.', false);
  }

  async function driveTurn(
    run: Run,
    input: {
      target: ModelTarget;
      context: AgentMessage[];
      message: string;
      /** False for helper/backfill turns that must not alter the chat history. */
      persist?: boolean;
      /** False disables the automatic "Next." continuation for this turn. */
      autoNext?: boolean;
    },
  ): Promise<void> {
    const sessionId = run.sessionId;
    let savedContext: AgentMessage[] | undefined;
    let agent: KolorAgent | undefined;
    let failure: unknown;
    try {
      try {
        agent = await pool.get(sessionId, input.context, input.target);
        runs.publish(run, {
          type: 'ready',
          tools: agent.tools.map((tool) => tool.name),
          mcp: agent.mcpServers,
          model: { id: input.target.apiModelName, label: input.target.label },
        });
        for await (const event of agent.stream(input.message, { signal: run.controller.signal })) {
          runs.publish(run, serializeEvent(event));
        }
      } catch (error) {
        failure = error;
        if (!run.controller.signal.aborted) {
          runs.publish(run, { type: 'web/error', message: describeError(error) });
        }
      }

      // A cancelled turn is not an exception: the loop drains and ends with
      // `stopReason: 'aborted'`, so the flag itself is what tells us.
      const cancelled = run.controller.signal.aborted;
      if (cancelled) runs.publish(run, { type: 'run/cancelled' });

      // The session was reset or deleted while this turn was running: saving
      // the agent's context now would undo the reset (or resurrect a deleted
      // session), so the aborted turn is dropped instead.
      const discarded = run.abortReason === 'reset' || run.abortReason === 'delete';

      if (agent !== undefined && !discarded && input.persist !== false) {
        try {
          const context = agent.exportContext();
          const updated = store.replaceContext(sessionId, context);
          savedContext = context;
          runs.publish(run, {
            type: 'session/saved',
            session: {
              id: updated.id,
              name: updated.name,
              createdAt: updated.createdAt,
              updatedAt: updated.updatedAt,
              messageCount: updated.messageCount,
              preview: updated.preview,
            },
          });
        } catch (error) {
          failure ??= error;
          runs.publish(run, { type: 'web/error', message: describeError(error) });
        }
      }

      runs.finish(run, cancelled ? 'cancelled' : failure === undefined ? 'done' : 'error', failure);
      // A completed background task takes priority over automatic Next.:
      // only one synthetic user message is sent at a turn boundary.
      const notificationStarted = dispatchBackgroundNotification();
      const notificationWaiting = backgroundNoticeQueue.length > 0;
      if (
        !notificationStarted &&
        !notificationWaiting &&
        !cancelled &&
        run.abortReason === null &&
        run.kind === 'chat' &&
        input.persist !== false &&
        input.autoNext !== false &&
        savedContext !== undefined &&
        lastAssistantContentEmpty(savedContext)
      ) {
        requestAutoNext();
      }
    } catch (error) {
      // Never leave a run registered as running.
      runs.finish(run, 'error', error);
    }
  }

  /**
   * Attach an SSE client to a turn, replaying what it missed.
   *
   * Detaching (tab closed, reload, network loss, session switch) only removes
   * the listener. Writes are batched into one `response.write` per tick so a
   * very fast stream does not turn into thousands of syscalls.
   */
  function attachRunSse(response: ServerResponse, sessionId: string, from: number): void {
    startSse(response);

    const view = runs.view(sessionId);
    if (view !== undefined) {
      sendSse(response, { type: 'run/state', run: view, replayFrom: Math.max(0, from) });
    }

    const queue: string[] = [];
    let detached = false;
    let scheduled = false;

    const heartbeat = setInterval(() => {
      if (detached || response.writableEnded || response.destroyed) return;
      response.write(': ping\n\n');
    }, 15_000);
    heartbeat.unref?.();

    function flush(): void {
      scheduled = false;
      if (queue.length === 0) return;
      const frames = queue.splice(0, queue.length);
      writeSseFrames(response, frames);
    }

    const listener: RunListener = {
      event(payload: string): void {
        if (detached) return;
        queue.push(payload);
        if (!scheduled) {
          scheduled = true;
          setImmediate(flush);
        }
      },
      end(): void {
        if (detached) return;
        detached = true;
        clearInterval(heartbeat);
        flush();
        if (!response.writableEnded) response.end();
      },
    };

    const attached = runs.subscribe(sessionId, listener, from);
    if (attached === undefined) {
      // Nothing is running: the client reloads the saved session instead.
      detached = true;
      clearInterval(heartbeat);
      if (!response.writableEnded) response.end();
      return;
    }
    writeSseFrames(response, attached.replay);

    response.on('close', () => {
      if (detached) return;
      detached = true;
      clearInterval(heartbeat);
      attached.run.listeners.delete(listener);
    });
  }

  /** Buffer a batch of already-serialized events as SSE frames. */
  function writeSseFrames(response: ServerResponse, payloads: string[]): void {
    if (payloads.length === 0) return;
    if (response.writableEnded || response.destroyed) return;
    let out = '';
    for (const payload of payloads) out += `data: ${payload}\n\n`;
    response.write(out);
  }

  /** Quiet period in whole minutes, for the diary prompt and `/api/memory`. */
  function diaryIdleMinutes(): number {
    return Math.max(1, Math.round(diaryIdleMs / 60_000));
  }

  function memoryPayload(): Record<string, unknown> {
    return {
      settings: memory.settings(),
      diaryIdleMinutes: diaryIdleMinutes(),
      self: memory.self(),
      today: memory.diary(),
    };
  }

  /** Providers (keys masked) plus the model the composer should preselect. */
  function providerPayload(): Record<string, unknown> {
    return {
      providers: providers.list(),
      active: providers.activeView(defaults()),
      kinds: MODEL_KINDS,
      protocols: {
        llm: protocolsFor('llm'),
        speech: protocolsFor('speech'),
        image: protocolsFor('image'),
        video: protocolsFor('video'),
      },
      vendors: VENDORS,
      defaults: {
        apiUrl: config.apiUrl,
        apiModelName: config.apiModelName,
        hasApiKey: config.apiKey !== '',
        hasDefault: hasEnvFallback(),
      },
    };
  }

  /**
   * Add a provider and discover its models automatically.
   *
   * OpenAI v1 and Anthropic expose model-list endpoints. Native vendor
   * integrations are reserved for later; they can be saved without models.
   */
  async function addProvider(request: IncomingMessage): Promise<Record<string, unknown>> {
    const body = await readJsonBody(request);
    if (!isRecord(body)) throw new HttpError(400, 'request body must be JSON');
    const kind = (body.kind === 'speech' || body.kind === 'image' || body.kind === 'video'
      ? body.kind
      : 'llm') as ModelKind;
    const protocol = (body.protocol === 'anthropic' ||
    body.protocol === 'vendor' ||
    body.protocol === 'code'
      ? body.protocol
      : 'openai') as ModelProtocol;
    const vendorId = typeof body.vendor === 'string' ? body.vendor.trim() : '';
    const preset = findVendor(vendorId);
    if (protocol === 'vendor' && (preset === undefined || preset.kind !== kind)) {
      throw new HttpError(400, '请选择与模型类型匹配的厂商');
    }
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';
    const baseUrl = (
      typeof body.baseUrl === 'string' && body.baseUrl.trim() !== ''
        ? body.baseUrl
        : (preset?.baseUrl ?? '')
    ).trim();
    if (protocol !== 'code' && baseUrl === '') {
      throw new HttpError(400, '请填写接口地址或选择厂商');
    }
    const effective = protocol === 'vendor' ? (preset?.protocol ?? 'native') : protocol;

    let models: string[] = [];
    let endpoint: string | undefined;
    if (effective === 'openai') {
      const discovered = await discoverModels({ baseUrl, apiKey });
      models = discovered.models;
      endpoint = discovered.endpoint;
    } else if (effective === 'anthropic') {
      const discovered = await discoverAnthropicModels({ baseUrl, apiKey });
      models = discovered.models;
      endpoint = discovered.endpoint;
    }
    if (effective !== 'code' && effective !== 'native' && models.length === 0) {
      throw new HttpError(400, '没有识别到模型；确认接口地址和 API Key');
    }

    const provider = providers.add({
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      kind,
      protocol,
      ...(vendorId === '' ? {} : { vendor: vendorId }),
      baseUrl,
      apiKey,
      models,
      ...(typeof body.code === 'string' ? { code: body.code } : {}),
    });
    return {
      provider: providers.get(provider.id),
      active: providers.activeView(defaults()),
      ...(endpoint === undefined ? {} : { endpoint }),
    };
  }

  /** Start a diary turn for one topic on one past/current day. */
  async function startBackfillDiary(
    slug: string,
    date: string,
  ): Promise<{ started: boolean; status?: number; reason?: string }> {
    const topic = store.store.topic(slug);
    if (topic === undefined) return { started: false, status: 404, reason: 'unknown topic' };
    const segments = store.store
      .listSegments()
      .filter(
        (segment) =>
          segment.topicSlug === slug &&
          diaryDateKey(new Date(segment.startedAt)) === date,
      );
    if (segments.length === 0) {
      return { started: false, status: 400, reason: 'no conversation for that day and topic' };
    }
    const target = activeTarget();
    if (target === undefined) {
      return { started: false, status: 400, reason: 'no usable model' };
    }

    // Backfills use the same isolated diary agent as switch-triggered jobs;
    // they do not occupy the main conversation or reuse its context.
    void enqueueDiary(slug, segments, date);
    return { started: true };
  }

  /**
   * Run a turn nobody is waiting for (diary).
   *
   * It goes through the broker too, so the session is flagged as running and a
   * client that opens it sees the live progress. A busy session is skipped
   * rather than queued, so slow turns cannot pile up.
   */
  async function runHeadlessTurn(input: {
    sessionId: string;
    kind: 'diary';
    message: string;
    prompt: string;
    skipped: string;
    context?: AgentMessage[];
    persist?: boolean;
    /** Restart the diary quiet period afterwards (never for the diary itself). */
    rearmIdle: boolean;
  }): Promise<void> {
    const session = store.require(input.sessionId);
    if (runs.isRunning(session.id)) return;

    const target = activeTarget();
    if (target === undefined) {
      options.logger?.(input.skipped);
      return;
    }

    await pool.ensureSignature();
    // Re-check after the await; another turn may have started meanwhile.
    // here, and a busy session is skipped rather than queued.
    if (runs.isRunning(session.id)) return;
    const run = ((): Run | undefined => {
      try {
        return runs.begin({
          sessionId: session.id,
          kind: input.kind,
          prompt: input.prompt,
        });
      } catch {
        return undefined;
      }
    })();
    if (run === undefined) return;
    try {
      await driveTurn(run, {
        target,
        context: input.context ?? session.context,
        message: input.message,
        ...(input.persist === undefined ? {} : { persist: input.persist }),
      });
    } finally {
      if (input.rearmIdle) diaryIdle.noteTurnFinished(session.id);
    }
  }

  /** IDs currently owned by the diary queue, so idle and switch triggers do not duplicate. */
  const diaryScheduled = new Set<string>();
  let diaryQueue: Promise<void> = Promise.resolve();

  /**
   * Organize one topic segment with a brand-new agent and no conversation
   * context. The main chat agent is never reused for diary work.
   */
  async function organizeDiary(
    slug: string,
    segments: Array<{ id: string; topicSlug: string; startedAt: string }>,
    targetDate?: string,
  ): Promise<void> {
    const topic = store.store.topic(slug);
    const target = activeTarget();
    if (topic === undefined || target === undefined) {
      options.logger?.('skipped the diary turn: no topic or no model');
      return;
    }
    const transcripts = segments.map((segment) => ({
      topicName: topic.name,
      topicSlug: segment.topicSlug,
      startedAt: segment.startedAt,
      messages: store.store.segmentMessages(segment.id).map((message) => ({
        role: message.role,
        content: typeof message.content === 'string' ? message.content : '',
      })),
    }));
    const message = buildTopicDiaryMessage(
      new Date(),
      transcripts,
      targetDate === undefined ? {} : { targetDate },
    );
    const sectionDate = targetDate ?? diaryDateKey(new Date());
    const agentId = `diary-${randomUUID()}`;
    const lastMessageAt = store.store.lastMessageAt(segments[segments.length - 1]!.id);
    diaryJobWriteAt = lastMessageAt === undefined ? new Date() : new Date(lastMessageAt);
    diaryJobTopic = slug;
    diaryJobWrite = true;
    try {
      await diaryPool.ensureSignature();
      const agent = await diaryPool.get(agentId, [], target);
      // Drain the turn. The diary agent's context is thrown away afterwards;
      // only its file writes (diary/topic memory) survive.
      for await (const _event of agent.stream(message)) {
        // No UI/SSE consumer for this isolated turn.
      }
      if (readTopicMemoryForDate(config.frameRoot, topic.slug, sectionDate) !== '') {
        store.store.markDiaryWritten(segments.map((segment) => segment.id));
      } else {
        options.logger?.('the diary agent finished without appending anything');
      }
    } catch (error) {
      options.logger?.('diary worker failed', error);
    } finally {
      diaryJobWrite = false;
      diaryJobWriteAt = undefined;
      diaryJobTopic = undefined;
      await diaryPool.disposeSession(agentId);
    }
  }

  /** Queue segments for the isolated diary agent; safe to call repeatedly. */
  function enqueueDiary(
    slug: string,
    segments: Array<{ id: string; topicSlug: string; startedAt: string }>,
    targetDate?: string,
  ): Promise<void> {
    const pending = new Set(store.store.pendingDiarySegments().map((entry) => entry.segment.id));
    const fresh = segments.filter(
      (segment) => pending.has(segment.id) && !diaryScheduled.has(segment.id),
    );
    if (fresh.length === 0) return Promise.resolve();
    options.logger?.(`queued diary for ${slug}: ${fresh.map((segment) => segment.id).join(', ')}`);
    for (const segment of fresh) diaryScheduled.add(segment.id);
    const job = diaryQueue.then(() => organizeDiary(slug, fresh, targetDate));
    diaryQueue = job.catch((error: unknown) => {
      options.logger?.('diary queue failed', error);
    });
    return job.finally(() => {
      for (const segment of fresh) diaryScheduled.delete(segment.id);
    });
  }

  /**
   * Safety net for switch/idle races: after a main turn, organize every
   * pending segment except the still-open current one.
   */
  function enqueuePendingSegments(exceptSegmentId?: string): void {
    const pending = store.store
      .pendingDiarySegments()
      .filter((entry) => entry.segment.id !== exceptSegmentId);
    if (pending.length === 0) return;
    const groups = new Map<string, Array<{ id: string; topicSlug: string; startedAt: string }>>();
    for (const entry of pending) {
      const date = diaryDateKey(new Date(entry.segment.startedAt));
      const key = `${entry.segment.topicSlug}\u0000${date}`;
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [entry.segment]);
      else group.push(entry.segment);
    }
    for (const segments of groups.values()) {
      const first = segments[0];
      if (first === undefined) continue;
      void enqueueDiary(
        first.topicSlug,
        segments,
        diaryDateKey(new Date(first.startedAt)),
      );
    }
  }

  /**
   * Idle fallback. Switch-triggered diary jobs are queued immediately; this
   * still catches the last segment for callers that enable the idle setting.
   */
  async function runDiaryTurn(_sessionId: string): Promise<void> {
    const pending = store.store.pendingDiarySegments();
    if (pending.length === 0) return;

    const groups = new Map<string, typeof pending>();
    for (const entry of pending) {
      const slug = entry.segment.topicSlug;
      const group = groups.get(slug);
      if (group === undefined) groups.set(slug, [entry]);
      else group.push(entry);
    }

    for (const [slug, entries] of groups) {
      await enqueueDiary(
        slug,
        entries.map((entry) => entry.segment),
      );
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  const port = address?.port ?? config.port;
  const internalHost =
    config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  localBaseUrl = `http://${internalHost.includes(':') ? `[${internalHost}]` : internalHost}:${port}`;

  return {
    server,
    port,
    url: `http://${config.host}:${port}`,
    config: { ...config, port },
    store,
    pool,
    providers,
    memory,
    diaryIdle,
    runs,
    async close(): Promise<void> {
      diaryIdle.cancelAll();
      runs.cancelAll('shutdown');
      backgroundTasks.disposeAll();
      await diaryPool.close();
      await pool.close();
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      store.close();
    },
  };
}

function serializeEvent(event: KolorEvent): unknown {
  switch (event.type) {
    case 'agent/error':
      return {
        type: event.type,
        turn: event.turn,
        step: event.step,
        error: { name: event.error.name, message: event.error.message },
      };
    case 'turn/end':
      return {
        type: event.type,
        turn: event.turn,
        result: {
          ...event.result,
          ...(event.result.error === undefined
            ? {}
            : { error: { name: event.result.error.name, message: event.result.error.message } }),
        },
      };
    case 'mcp/error':
      return {
        type: event.type,
        server: event.server,
        error: { name: event.error.name, message: event.error.message },
      };
    default:
      return event;
  }
}

function findPublicDir(): string {
  const candidates = [new URL('../public/', import.meta.url), new URL('../../public/', import.meta.url)];
  for (const candidate of candidates) {
    const dir = fileURLToPath(candidate);
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  throw new Error('kolorbot-web: public/ directory not found');
}

function safeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
