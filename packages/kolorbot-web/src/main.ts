import { CliError } from './cli.js';
import { commandUsage, parseCommandLine, type CommandOptions } from './commands.js';
import { createKolorWebServer, type KolorWebServer } from './server.js';

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
    const app = await createKolorWebServer({
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.port === undefined ? {} : { port: options.port }),
    });
    logWeb(app);
    installShutdown(async () => {
      await app.close();
    });
  } catch (error) {
    console.error('failed to start KolorBot:', describe(error));
    process.exitCode = 1;
  }
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
