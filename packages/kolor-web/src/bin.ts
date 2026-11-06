#!/usr/bin/env node
import { CliError, cliUsage, parseCliArgs } from './cli.js';
import { createKolorWebServer } from './server.js';

let options;
try {
  options = parseCliArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof CliError ? error.message : String(error));
  console.error('');
  console.error(cliUsage());
  process.exit(1);
}

if (options.help === true) {
  console.log(cliUsage());
  process.exit(0);
}

try {
  const app = await createKolorWebServer({
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
  });

  const host = app.config.host;
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  console.log(`KolorBot web  http://${formatHost(displayHost)}:${app.port}`);
  console.log(`listen     ${formatHost(host)}:${app.port}`);
  const active = app.providers.activeView({
    apiUrl: app.config.apiUrl,
    apiModelName: app.config.apiModelName,
    apiKey: app.config.apiKey,
  });
  if (active.source === 'none') {
    console.log('model      未配置（请在 Web 的「模型」页添加提供商）');
  } else {
    const endpoint =
      active.providerId === null
        ? app.config.apiUrl
        : (app.providers.get(active.providerId)?.baseUrl ?? '');
    console.log(`model      ${active.label}${endpoint === '' ? '' : ` @ ${endpoint}`}`);
  }
  console.log(`sessions   ${app.config.sessionsDbPath}`);
  console.log(`workspace  ${app.config.frameRoot}`);
  if (active.source === 'none') {
    console.warn(
      'warning    no model provider is configured; add one in the web UI (模型), or set KOLOR_API_URL / KOLOR_API_MODEL / DEEPSEEK_API_KEY',
    );
  }
  if (!isLoopback(host)) {
    console.warn(
      `warning    listening on ${host}; the web UI has no authentication, use only on a trusted network`,
    );
  }

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    console.log(`\n${signal}: shutting down`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
} catch (error) {
  console.error('failed to start kolor-web:', error instanceof Error ? error.message : error);
  process.exit(1);
}

function isLoopback(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}
