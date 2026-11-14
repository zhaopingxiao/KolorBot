import {
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
      ? `scheduler  ${status.url}`
      : 'scheduler  未启动（定时任务不可用，用 run scheduler 启动）',
  );
  installShutdown(async () => {
    await app.close();
  });
}

/** Start only the scheduled-task daemon. There is no web server in this mode. */
async function runScheduler(options: CommandOptions): Promise<void> {
  const { daemon, sessions, tasks } = await startScheduler({
    ...(options.schedulerHost === undefined ? {} : { host: options.schedulerHost }),
    ...(options.schedulerPort === undefined ? {} : { port: options.schedulerPort }),
  });
  console.log(`KolorBot scheduler  ${daemon.url}`);
  installShutdown(async () => {
    await daemon.close();
    sessions.close();
    tasks.close();
  });
}

/** Start both daemons in one process; the web UI sees the scheduler as available. */
async function runGateway(options: CommandOptions): Promise<void> {
  const { daemon, sessions, tasks } = await startScheduler({
    ...(options.schedulerHost === undefined ? {} : { host: options.schedulerHost }),
    ...(options.schedulerPort === undefined ? {} : { port: options.schedulerPort }),
  });
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
  overrides: { host?: string; port?: number } = {},
): Promise<{ daemon: SchedulerDaemon; sessions: SessionStore; tasks: TaskStore }> {
  const config: SchedulerConfig = resolveSchedulerConfig(overrides);
  const sessions = new SessionStore({ path: config.dbPath });
  const tasks = new TaskStore({ path: config.dbPath });
  const runner = new ScheduledTurnRunner({
    config,
    sessions,
    skills: skillsForConfig(config),
    logger,
  });
  const daemon = new SchedulerDaemon({ config, sessions, tasks, runner, logger });
  await daemon.start();
  return { daemon, sessions, tasks };
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
