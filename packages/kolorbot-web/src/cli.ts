/** Parsed `kolorbot-web` command-line options. */
export interface CliOptions {
  host?: string;
  port?: number;
  help?: boolean;
}

export class CliError extends Error {
  override name = 'CliError';
}

/** Parse arguments after the script name. Supports `--flag value` and `--flag=value`. */
export function parseCliArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--host' || argument.startsWith('--host=')) {
      const value = argument.includes('=')
        ? argument.slice('--host='.length)
        : (argv[++index] as string | undefined);
      if (value === undefined || value.trim() === '') {
        throw new CliError('--host needs a non-empty value');
      }
      options.host = value.trim();
      continue;
    }
    if (argument === '--port' || argument.startsWith('--port=')) {
      const raw = argument.includes('=')
        ? argument.slice('--port='.length)
        : (argv[++index] as string | undefined);
      const port = Number(raw);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new CliError('--port must be an integer between 0 and 65535');
      }
      options.port = port;
      continue;
    }
    throw new CliError(`unknown option "${argument}"`);
  }

  return options;
}

export function cliUsage(): string {
  return [
    'Usage: kolorbot-web [--host <host>] [--port <port>]',
    '',
    '  --host <host>  listen address (default 127.0.0.1; 0.0.0.0 exposes to the LAN)',
    '  --port <port>  listen port (default 3399; 0 picks a random free port)',
    '  -h, --help     show this help',
    '',
    'Environment: KOLOR_WEB_HOST, KOLOR_WEB_PORT (CLI flags take precedence).',
    'Warning: the web UI has no authentication. Only expose it on trusted networks.',
  ].join('\n');
}
