import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KolorAgent, KolorEvent, McpServerConfig } from 'kolor-agent-loop';
import { SkillsRegistry, formatSkillsBlock } from 'kolor-skills';
import {
  SessionStore,
  describeSchedule,
  nextRunAt,
  type SessionTask,
} from 'kolor-sessions';
import { AgentPool } from './agent-pool.js';
import { resolveWebConfig, type WebConfig, type WebConfigOverrides } from './config.js';
import { IdleDiary } from './diary-idle.js';
import {
  HttpError,
  describeError,
  readJsonBody,
  sendJson,
  sendSse,
  startSse,
  toHttpError,
} from './http.js';
import {
  MemoryStore,
  buildDiaryTaskMessage,
  formatDiaryBlock,
  isDiaryCommand,
} from './memory.js';
import {
  ProviderStore,
  discoverModels,
  type DefaultModelConfig,
  type ModelTarget,
} from './providers.js';
import { TaskScheduler } from './scheduler.js';
import { VERSION } from './version.js';

/** Default quiet period before the automatic diary turn. */
const DEFAULT_DIARY_IDLE_MS = 10 * 60 * 1000;

export interface KolorWebOptions extends WebConfigOverrides {
  /** Inject a store (tests); defaults to the configured database path. */
  store?: SessionStore;
  /** Disable the background ticker (tests drive `fireDueTasks` manually). */
  startScheduler?: boolean;
  /** Quiet period before the automatic diary turn; default 10 minutes. */
  diaryIdleMs?: number;
  logger?: (message: string, error?: unknown) => void;
}

export interface KolorWebServer {
  server: Server;
  url: string;
  port: number;
  config: WebConfig;
  store: SessionStore;
  pool: AgentPool;
  /** Model providers stored in `providers.json`. */
  providers: ProviderStore;
  /** Diary settings and markdown files under `<workspace>/daily`. */
  memory: MemoryStore;
  /** Per-session idle timers that trigger the diary turn. */
  diaryIdle: IdleDiary;
  scheduler: TaskScheduler;
  /** Run a scheduler tick at `now` (defaults to the current time). */
  fireDueTasks(now?: Date): Promise<void>;
  close(): Promise<void>;
}

const STATIC_FILES = new Map<string, string>([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/styles.css', 'styles.css'],
  ['/logo.png', 'logo.png'],
  ['/favicon.svg', 'favicon.svg'],
]);

const CONTENT_TYPES: Record<string, string> = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'styles.css': 'text/css; charset=utf-8',
  'logo.png': 'image/png',
  'favicon.svg': 'image/svg+xml',
};

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

  const store = options.store ?? new SessionStore({ path: config.sessionsDbPath });
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
    root: config.skillsDir,
    env: {
      ...process.env,
      ...(config.apiKey === ''
        ? {}
        : { DEEPSEEK_API_KEY: config.apiKey, KOLOR_API_KEY: config.apiKey }),
    },
  });
  mkdirSync(config.skillsDir, { recursive: true });

  const diaryIdleMs = options.diaryIdleMs ?? DEFAULT_DIARY_IDLE_MS;
  const memory = new MemoryStore({
    home: config.home,
    diaryDir: join(config.frameRoot, 'daily'),
  });

  const pool = new AgentPool({
    mcpConfigs: () => skillMcpConfigs(skillsRegistry),
    createReminder: (sessionId, input) => store.createTask(sessionId, input),
    createDiary: (note, options) => memory.append(note, undefined, options),
    kolorFrame: { root: config.frameRoot, skillsRoot: config.skillsDir },
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  const controllers = new Map<string, AbortController>();
  const publicDir = findPublicDir();

  const diaryIdle = new IdleDiary({
    idleMs: diaryIdleMs,
    isEnabled: () => memory.settings().diary.autoAppend,
    onFire: (sessionId) => runDiaryTurn(sessionId),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  const scheduler = new TaskScheduler({
    listTasks: () => store.listAllTasks(),
    markFired: (taskId, at) => store.markTaskFired(taskId, at),
    onFire: (task, message) => runScheduledTurn(task, message),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

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
    await handleApi(request, response, url.pathname);
  }

  function serveStatic(pathname: string, response: ServerResponse): void {
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

  async function handleApi(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
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
        sessionsDbPath: config.sessionsDbPath,
        mcpServers: publicMcpServers(skillsRegistry),
        mcpStatus: pool.mcpStatus,
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
      const discovered = await discoverModels({
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

    if (pathname === '/api/skills' && method === 'GET') {
      const mcpServers = publicMcpServers(skillsRegistry);
      const publicServer = (server: { name: string; transport: string }): {
        name: string;
        transport: string;
      } => ({ name: server.name, transport: server.transport });
      sendJson(response, 200, {
        root: config.skillsDir,
        signature: skillsRegistry.signature(),
        skills: skillsRegistry.list().map((skill) => ({
          ...skill,
          mcpServers: mcpServers
            .filter((server) => server.skillId === skill.id)
            .map(publicServer),
        })),
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
        sendJson(response, 200, { sessions: store.list() });
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

    if (pathname === '/api/chat' && method === 'POST') {
      await handleChat(request, response);
      return;
    }

    if (pathname === '/api/chat/cancel' && method === 'POST') {
      const body = await readJsonBody(request);
      const sessionId = isRecord(body) && typeof body.sessionId === 'string' ? body.sessionId : '';
      const controller = controllers.get(sessionId);
      controller?.abort(new Error('cancelled by user'));
      sendJson(response, 200, { cancelled: controller !== undefined });
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
      const session = store.reset(id);
      await pool.disposeSession(id);
      sendJson(response, 200, { session });
      return;
    }

    const tasksMatch = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/tasks$/.exec(pathname);
    if (tasksMatch !== null) {
      const id = tasksMatch[1] as string;
      if (method === 'GET') {
        store.require(id);
        sendJson(response, 200, { tasks: store.listTasks(id).map(taskView) });
        return;
      }
      if (method === 'POST') {
        const body = await readJsonBody(request);
        if (!isRecord(body) || typeof body.name !== 'string') {
          throw new HttpError(400, 'request body must contain "name" and "schedule"');
        }
        const task = store.createTask(id, { name: body.name, schedule: body.schedule });
        sendJson(response, 201, { task: taskView(task) });
        return;
      }
      throw new HttpError(405, 'method not allowed');
    }

    const taskMatch = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/tasks\/([A-Za-z0-9_-]+)$/.exec(pathname);
    if (taskMatch !== null && method === 'DELETE') {
      const removed = store.deleteTask(taskMatch[1] as string, taskMatch[2] as string);
      sendJson(response, 200, { deleted: removed });
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
        sendJson(response, 200, { session: store.require(id) });
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
    if (!isRecord(body) || typeof body.sessionId !== 'string' || typeof body.text !== 'string') {
      throw new HttpError(400, 'sessionId and text are required');
    }
    const sessionId = body.sessionId;
    const text = body.text.trim();
    if (text === '') throw new HttpError(400, 'text must not be empty');
    const target = activeTarget();
    if (target === undefined) {
      throw new HttpError(
        400,
        'no usable model: add a provider in the web UI (模型), or set KOLOR_API_URL / KOLOR_API_MODEL / DEEPSEEK_API_KEY and restart kolor-web',
      );
    }

    const session = store.require(sessionId);
    if (controllers.has(session.id)) {
      throw new HttpError(409, 'this session already has a running turn');
    }
    diaryIdle.cancel(session.id);

    await pool.ensureSignature();

    const controller = new AbortController();
    controllers.set(session.id, controller);
    startSse(response);

    let finished = false;
    response.on('close', () => {
      if (!finished) controller.abort(new Error('client disconnected'));
    });

    // `/update-daily-memory` sends exactly the same message as an idle trigger.
    const outgoing = isDiaryCommand(text) ? buildDiaryTaskMessage(new Date()) : text;

    let agent: KolorAgent | undefined;
    try {
      agent = await pool.get(session.id, session.context, target);
      sendSse(response, {
        type: 'ready',
        tools: agent.tools.map((tool) => tool.name),
        mcp: agent.mcpServers,
        model: { id: target.apiModelName, label: target.label },
      });
      const prepared = prepareOutgoingMessage(session.id, outgoing);
      if (prepared.topicApplied) sendSse(response, { type: 'topic/applied' });
      for await (const event of agent.stream(prepared.content, { signal: controller.signal })) {
        sendSse(response, serializeEvent(event));
      }
    } catch (error) {
      sendSse(response, { type: 'web/error', message: describeError(error) });
    } finally {
      if (agent !== undefined) {
        try {
          const updated = store.replaceContext(session.id, agent.exportContext());
          sendSse(response, {
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
          sendSse(response, { type: 'web/error', message: describeError(error) });
        }
      }
      finished = true;
      controllers.delete(session.id);
      diaryIdle.noteTurnFinished(session.id);
      if (!response.writableEnded) response.end();
    }
  }

  /** Quiet period in whole minutes, for the diary prompt and `/api/memory`. */
  function diaryIdleMinutes(): number {
    return Math.max(1, Math.round(diaryIdleMs / 60_000));
  }

  function memoryPayload(): Record<string, unknown> {
    return {
      settings: memory.settings(),
      diaryIdleMinutes: diaryIdleMinutes(),
      today: memory.diary(),
    };
  }

  function taskView(task: SessionTask): Record<string, unknown> {
    return {
      id: task.id,
      sessionId: task.sessionId,
      name: task.name,
      schedule: task.schedule,
      createdAt: task.createdAt,
      lastFiredAt: task.lastFiredAt,
      description: describeSchedule(task.schedule),
      nextRunAt: nextRunAt(task.schedule),
    };
  }

  /** Providers (keys masked) plus the model the composer should preselect. */
  function providerPayload(): Record<string, unknown> {
    return {
      providers: providers.list(),
      active: providers.activeView(defaults()),
      defaults: {
        apiUrl: config.apiUrl,
        apiModelName: config.apiModelName,
        hasApiKey: config.apiKey !== '',
        hasDefault: hasEnvFallback(),
      },
    };
  }

  /**
   * Add a provider, discovering its models unless the caller listed them.
   *
   * Discovery failures become 400s: saving a provider without models would
   * leave nothing selectable in the composer.
   */
  async function addProvider(request: IncomingMessage): Promise<Record<string, unknown>> {
    const body = await readJsonBody(request);
    if (!isRecord(body) || typeof body.baseUrl !== 'string' || body.baseUrl.trim() === '') {
      throw new HttpError(400, 'request body must contain a "baseUrl" string');
    }
    const baseUrl = body.baseUrl;
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';
    const manual = Array.isArray(body.models)
      ? body.models.filter((model): model is string => typeof model === 'string')
      : [];

    let models = manual;
    let endpoint: string | undefined;
    if (models.length === 0) {
      const discovered = await discoverModels({ baseUrl, apiKey });
      models = discovered.models;
      endpoint = discovered.endpoint;
      if (models.length === 0) {
        throw new HttpError(
          400,
          `没有从 ${discovered.endpoint} 识别到模型；确认接口地址，或手动填写模型`,
        );
      }
    }

    const provider = providers.add({
      baseUrl,
      apiKey,
      models,
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
    });
    return {
      provider: providers.get(provider.id),
      active: providers.activeView(defaults()),
      ...(endpoint === undefined ? {} : { endpoint }),
    };
  }

  /**
   * Build the message the agent receives.
   *
   * Skills and today's diary are injected when the conversation starts, after a
   * reset, or when their content changed since it was last sent. The topic
   * envelope (if pending) is still applied by the session store.
   */
  function prepareOutgoingMessage(
    sessionId: string,
    text: string,
  ): { content: string; topicApplied: boolean } {
    const session = store.require(sessionId);
    const installed = skillsRegistry.list();
    const signature = skillsRegistry.signature();
    const injectSkills =
      installed.length > 0 &&
      (session.messageCount === 0 || session.skillsSignature !== signature);

    const diary = memory.diary();
    const injectDiary =
      diary.signature !== '' &&
      (session.messageCount === 0 || session.dailySignature !== diary.signature);

    const prepared = store.prepareUserMessage(sessionId, text);
    if (session.skillsSignature !== signature) {
      store.markSkillsSent(sessionId, signature);
    }
    if (session.dailySignature !== diary.signature) {
      store.markDailySent(sessionId, diary.signature);
    }

    const blocks: string[] = [];
    if (injectSkills) blocks.push(formatSkillsBlock(installed));
    if (injectDiary) blocks.push(formatDiaryBlock(diary.content));

    return {
      content: blocks.length === 0 ? prepared.content : `${blocks.join('\n\n')}\n\n${prepared.content}`,
      topicApplied: prepared.topicApplied,
    };
  }

  /**
   * Run one scheduled task as a normal agent turn without an SSE client.
   *
   * Persisting after the turn keeps the session consistent; a busy session is
   * skipped rather than queued so a slow turn cannot pile up.
   */
  async function runScheduledTurn(task: SessionTask, message: string): Promise<void> {
    const session = store.require(task.sessionId);
    if (controllers.has(session.id)) return;

    const target = activeTarget();
    if (target === undefined) {
      options.logger?.(`skipped task "${task.name}": no model is configured`);
      return;
    }

    const controller = new AbortController();
    controllers.set(session.id, controller);
    let agent: KolorAgent | undefined;
    try {
      await pool.ensureSignature();
      agent = await pool.get(session.id, session.context, target);
      const prepared = prepareOutgoingMessage(session.id, message);
      for await (const _event of agent.stream(prepared.content, { signal: controller.signal })) {
        // Scheduled turns have no client; consuming the stream drives the loop.
      }
    } finally {
      if (agent !== undefined) {
        try {
          store.replaceContext(session.id, agent.exportContext());
        } catch (error) {
          options.logger?.('could not persist a scheduled turn', error);
        }
      }
      controllers.delete(session.id);
      diaryIdle.noteTurnFinished(session.id);
    }
  }

  /**
   * Write today's diary for one session after it went quiet.
   *
   * Runs like a scheduled turn (no SSE client) and is deliberately not
   * re-armed, so the diary turn cannot trigger itself again.
   */
  async function runDiaryTurn(sessionId: string): Promise<void> {
    const session = store.require(sessionId);
    if (controllers.has(session.id)) return;

    const target = activeTarget();
    if (target === undefined) {
      options.logger?.('skipped the diary turn: no model is configured');
      return;
    }

    const before = memory.diary().signature;
    const message = buildDiaryTaskMessage(new Date());

    const controller = new AbortController();
    controllers.set(session.id, controller);
    let agent: KolorAgent | undefined;
    try {
      await pool.ensureSignature();
      agent = await pool.get(session.id, session.context, target);
      const prepared = prepareOutgoingMessage(session.id, message);
      for await (const _event of agent.stream(prepared.content, { signal: controller.signal })) {
        // The diary turn has no client; consuming the stream drives the loop.
      }
    } finally {
      if (agent !== undefined) {
        try {
          store.replaceContext(session.id, agent.exportContext());
        } catch (error) {
          options.logger?.('could not persist the diary turn', error);
        }
      }
      controllers.delete(session.id);
      const after = memory.diary().signature;
      if (after === before) {
        options.logger?.('the diary turn finished without appending anything');
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  const port = address?.port ?? config.port;

  if (options.startScheduler !== false) scheduler.start();

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
    scheduler,
    fireDueTasks: (now?: Date) => scheduler.tick(now),
    async close(): Promise<void> {
      scheduler.stop();
      diaryIdle.cancelAll();
      for (const controller of controllers.values()) {
        controller.abort(new Error('server shutting down'));
      }
      controllers.clear();
      await Promise.race([
        scheduler.whenIdle(),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ]);
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
  throw new Error('kolor-web: public/ directory not found');
}

function safeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
