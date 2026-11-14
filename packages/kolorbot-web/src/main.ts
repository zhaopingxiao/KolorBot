import {
  SchedulerClient,
  SchedulerDaemon,
  ScheduledTurnRunner,
  TaskStore,
  resolveSchedulerConfig,
  skillsForConfig,
  type SchedulerConfig,
} from 'kolorbot-scheduler';
import { SessionStore } from 'kolorbot-sessions';
import { CliError } from './cli.js';
import { commandUsage, parseCommandLine, type CommandOptions } from './commands.js';
import { createKolorWebServer, type KolorWebServer } from './server.js';

const logger = (message: string, error?: unknown): void => {
  console.error(error === undefined ? message : `${message}: ${describe(error)}`);
};

/** Run the CLI once. Exported so the SEA entry can call it without top-level await. */
export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  let options: CommandOptions;
  try {
    options = parseCommandLine(argv);
  } catch (error) {
    console.error(error instanceof CliError ? error.message : String(error));
    console.error('');
    console.error(commandUsage());
    process.exitCode = 1;
    return;
  }

  if (options.help === true) {
    console.log(commandUsage());
    return;
  }

  try {
    if (options.command === 'web') {
      await runWeb(options);
    } else if (options.command === 'scheduler') {
      await runScheduler(options);
    } else {
      await runGateway(options);
    }
  } catch (error) {
    console.error('failed to start KolorBot:', describe(error));
    process.exitCode = 1;
  }
}

/** Start only the web daemon. Scheduled tasks are unavailable unless a daemon exists. */
async function runWeb(options: CommandOptions): Promise<void> {
  const app = await createKolorWebServer({
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.schedulerUrl === undefined ? {} : { schedulerUrl: options.schedulerUrl }),
  });

  logWeb(app);
  const status = await app.scheduler.status();
  console.log(
    status.available
      ? `scheduler  已连接 ${status.url}（外部进程，本进程没有启动它；要和 Web 一起启动请用 run gateway）`
      : 'scheduler  未启动（定时任务不可用，用 run scheduler 启动）',
  );
  installShutdown(async () => {
    await app.close();
  });
}

/** Start only the scheduled-task daemon. There is no web server in this mode. */
async function runScheduler(options: CommandOptions): Promise<void> {
  const config = resolveSchedulerConfig({
    ...(options.schedulerHost === undefined ? {} : { host: options.schedulerHost }),
    ...(options.schedulerPort === undefined ? {} : { port: options.schedulerPort }),
  });
  const { daemon, sessions, tasks } = await startScheduler(config);
  console.log(`KolorBot scheduler  ${daemon.url}`);
  installShutdown(async () => {
    await daemon.close();
    sessions.close();
    tasks.close();
  });
}

/**
 * Start both daemons in one process.
 *
 * If a scheduler is already running at the configured address, reuse it instead
 * of failing on EADDRINUSE (this is what "already started" used to look like).
 */
async function runGateway(options: CommandOptions): Promise<void> {
  const config = resolveSchedulerConfig({
    ...(options.schedulerHost === undefined ? {} : { host: options.schedulerHost }),
    ...(options.schedulerPort === undefined ? {} : { port: options.schedulerPort }),
  });
  const url = schedulerUrl(config);
  const existing = await new SchedulerClient({ baseUrl: url }).status();
  if (existing.available) {
    const app = await createKolorWebServer({
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.port === undefined ? {} : { port: options.port }),
      schedulerUrl: url,
    });
    logWeb(app);
    console.log(`scheduler  复用已在运行的 ${url}（本进程没有重复启动它）`);
    installShutdown(async () => {
      await app.close();
    });
    return;
  }

  const { daemon, sessions, tasks } = await startScheduler(config);
  const app = await createKolorWebServer({
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    schedulerUrl: daemon.url,
  });

  logWeb(app);
  console.log(`scheduler  ${daemon.url}`);
  installShutdown(async () => {
    await app.close();
    await daemon.close();
    sessions.close();
    tasks.close();
  });
}

async function startScheduler(
  config: SchedulerConfig,
): Promise<{ daemon: SchedulerDaemon; sessions: SessionStore; tasks: TaskStore }> {
  const sessions = new SessionStore({ path: config.dbPath });
  const tasks = new TaskStore({ path: config.dbPath });
  const runner = new ScheduledTurnRunner({
    config,
    sessions,
    skills: skillsForConfig(config),
    logger,
  });
  const daemon = new SchedulerDaemon({ config, sessions, tasks, runner, logger });
  try {
    await daemon.start();
  } catch (error) {
    sessions.close();
    tasks.close();
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error(
        `scheduler 端口 ${config.port} 已被占用，但 /health 不通；` +
          '换一个 --scheduler-port，或先停止占用该端口的进程。',
      );
    }
    throw error;
  }
  return { daemon, sessions, tasks };
}

function schedulerUrl(config: SchedulerConfig): string {
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  return `http://${host.includes(':') ? `[${host}]` : host}:${config.port}`;
}

function logWeb(app: KolorWebServer): void {
  const host = app.config.host;
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  console.log(`KolorBot web  http://${formatHost(displayHost)}:${app.port}`);
  console.log(`listen        ${formatHost(host)}:${app.port}`);
  const active = app.providers.activeView({
    apiUrl: app.config.apiUrl,
    apiModelName: app.config.apiModelName,
    apiKey: app.config.apiKey,
  });
  console.log(
    `model         ${
      active.source === 'none' ? '未配置（请在 Web 的「模型」页添加提供商）' : active.label
    }`,
  );
  console.log(`workspace     ${app.config.frameRoot}`);
}

function installShutdown(close: () => Promise<void>): void {
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    console.log(`\n${signal}: shutting down`);
    try {
      await close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
