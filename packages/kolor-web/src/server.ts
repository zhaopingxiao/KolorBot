import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SYSTEM_PROMPT,
  type AgentMessage,
  type KolorAgent,
  type KolorEvent,
  type McpServerConfig,
} from 'kolor-agent-loop';
import { SKILL_SOURCE_LABELS, SkillsRegistry, formatSkillsBlock } from 'kolor-skills';
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
  sendJsonText,
  sendSse,
  startSse,
  toHttpError,
} from './http.js';
import {
  MemoryStore,
  buildDiaryTaskMessage,
  buildSelfTellMessage,
  buildSelfUpdateMessage,
  formatMemoryBlock,
  isDiaryCommand,
  isSelfUpdateCommand,
  memorySignature,
  selfTellInfo,
} from './memory.js';
import {
  ProviderStore,
  discoverModels,
  type DefaultModelConfig,
  type ModelTarget,
} from './providers.js';
import { RunBroker, type Run, type RunListener } from './runs.js';
import { TaskScheduler } from './scheduler.js';
import { VERSION } from './version.js';

/** Default quiet period before the automatic diary turn. */
const DEFAULT_DIARY_IDLE_MS = 10 * 60 * 1000;

/**
 * System prompt: the generic agent-loop prompt plus a pointer to the built-in
 * `kolor` skill, which carries the framework documentation (three skill areas,
 * writing skills, MCP config, diary location and prompts).
 */
const KOLOR_SYSTEM_PROMPT = [
  DEFAULT_SYSTEM_PROMPT,
  '',
  'KolorBot framework knowledge lives in the built-in skill "kolor": the three skill areas, how to write a skill, MCP configuration, the diary (where it is stored and the rules to update it), the persona/self settings (AI.md), sessions, providers and the HTTP API.',
  'When the user asks how KolorBot itself works, call the `skills` tool with id "kolor" and read it instead of guessing. Do not load it for ordinary coding, browsing or office tasks.',
].join('\n');

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
  /** Turns that keep running after the client that started them went away. */
  runs: RunBroker;
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

  const pool = new AgentPool({
    mcpConfigs: () => skillMcpConfigs(skillsRegistry),
    createReminder: (sessionId, input) => store.createTask(sessionId, input),
    systemPrompt: KOLOR_SYSTEM_PROMPT,
    kolorFrame: {
      root: config.frameRoot,
      skillsRoot: config.skillsDir,
      extraSkillRoots: [config.userSkillsDir, config.builtinSkillsDir],
    },
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  const runs = new RunBroker();
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
    await handleApi(request, response, url.pathname, url.searchParams);
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
    diaryIdle.cancel(session.id);

    await pool.ensureSignature();

    // `/update-daily-memory`, `/self-md-update` and `/self-md-tell` become
    // task messages; the rules for both live in the built-in kolor skill.
    const selfInfo = selfTellInfo(text);
    let outgoing = text;
    if (isDiaryCommand(text)) {
      outgoing = buildDiaryTaskMessage(new Date());
    } else if (isSelfUpdateCommand(text)) {
      outgoing = buildSelfUpdateMessage();
    } else if (selfInfo !== undefined) {
      if (selfInfo === '') {
        throw new HttpError(400, 'send some information after /self-md-tell');
      }
      outgoing = buildSelfTellMessage(selfInfo);
    }

    // Re-check after the await: two quick POSTs could both pass the check
    // above. `begin` is synchronous, so this closes the race window.
    if (runs.isRunning(session.id)) {
      throw new HttpError(409, 'this session already has a running turn');
    }

    // The turn lives in the broker, not in this request: attaching the SSE
    // response is the only thing this handler does with the connection.
    // `outgoing` is what the user sees in the live bubble once envelopes are
    // stripped, so a diary command shows the same timestamped line as an
    // automatic trigger.
    const run = ((): Run => {
      try {
        return runs.begin({ sessionId: session.id, kind: 'chat', prompt: outgoing });
      } catch {
        throw new HttpError(409, 'this session already has a running turn');
      }
    })();
    try {
      attachRunSse(response, session.id, 0);
      await driveTurn(run, {
        target,
        context: session.context,
        message: outgoing,
      });
    } catch (error) {
      // A broken socket must still close the run, or the session stays busy.
      if (runs.isRunning(session.id)) runs.finish(run, 'error', error);
    } finally {
      // Only a user turn restarts the quiet period.
      diaryIdle.noteTurnFinished(session.id);
    }
  }

  /**
   * Drive one turn to completion, publishing every event into the broker.
   *
   * Nothing here depends on a client being connected, so closing the tab or
   * losing the network only detaches the live view. The context is persisted
   * at the end, which is what a client returning later reads back.
   */
  async function driveTurn(
    run: Run,
    input: { target: ModelTarget; context: AgentMessage[]; message: string },
  ): Promise<void> {
    const sessionId = run.sessionId;
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
        const prepared = prepareOutgoingMessage(sessionId, input.message);
        if (prepared.topicApplied) runs.publish(run, { type: 'topic/applied' });
        for await (const event of agent.stream(prepared.content, { signal: run.controller.signal })) {
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

      if (agent !== undefined && !discarded) {
        try {
          const updated = store.replaceContext(sessionId, agent.exportContext());
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

    const self = memory.self();
    const diary = memory.diary();
    const signatureOfMemory = memorySignature(self.content, diary.content);
    const injectMemory =
      signatureOfMemory !== '' &&
      (session.messageCount === 0 || session.memorySignature !== signatureOfMemory);

    const prepared = store.prepareUserMessage(sessionId, text);
    if (session.skillsSignature !== signature) {
      store.markSkillsSent(sessionId, signature);
    }
    if (session.memorySignature !== signatureOfMemory) {
      store.markMemorySent(sessionId, signatureOfMemory);
    }

    const blocks: string[] = [];
    if (injectSkills) blocks.push(formatSkillsBlock(installed));
    if (injectMemory) blocks.push(formatMemoryBlock(self.content, diary.content));

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
    await runHeadlessTurn({
      sessionId: task.sessionId,
      kind: 'task',
      message,
      prompt: message,
      skipped: `skipped task "${task.name}": no model is configured`,
      rearmIdle: true,
    });
  }

  /**
   * Run a turn nobody is waiting for (scheduled task, diary).
   *
   * It goes through the broker too, so the session is flagged as running and a
   * client that opens it sees the live progress. A busy session is skipped
   * rather than queued, so slow turns cannot pile up.
   */
  async function runHeadlessTurn(input: {
    sessionId: string;
    kind: 'task' | 'diary';
    message: string;
    prompt: string;
    skipped: string;
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
    // Re-check after the await; a scheduler tick and a chat request can meet
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
      await driveTurn(run, { target, context: session.context, message: input.message });
    } finally {
      if (input.rearmIdle) diaryIdle.noteTurnFinished(session.id);
    }
  }

  /**
   * Write today's diary for one session after it went quiet.
   *
   * Runs like a scheduled turn (no SSE client) and is deliberately not
   * re-armed, so the diary turn cannot trigger itself again.
   */
  async function runDiaryTurn(sessionId: string): Promise<void> {
    const before = memory.diary().signature;
    const message = buildDiaryTaskMessage(new Date());
    await runHeadlessTurn({
      sessionId,
      kind: 'diary',
      message,
      prompt: message,
      skipped: 'skipped the diary turn: no model is configured',
      rearmIdle: false,
    });
    const after = memory.diary().signature;
    if (after === before) {
      options.logger?.('the diary turn finished without appending anything');
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
    runs,
    scheduler,
    fireDueTasks: (now?: Date) => scheduler.tick(now),
    async close(): Promise<void> {
      scheduler.stop();
      diaryIdle.cancelAll();
      runs.cancelAll('shutdown');
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
