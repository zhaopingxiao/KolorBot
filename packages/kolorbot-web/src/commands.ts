import { CliError } from './cli.js';

export type Command = 'web';

export interface CommandOptions {
  command: Command;
  host?: string;
  port?: number;
  help?: boolean;
}

/**
 * Parse `run web [flags]`.
 *
 * Bare `--host/--port` (no `run`) stays as shorthand for `run web`.
 */
export function parseCommandLine(argv: readonly string[]): CommandOptions {
  const args = [...argv];
  if (args.includes('--help') || args.includes('-h')) return { command: 'web', help: true };

  if (args[0] === 'run') {
    args.shift();
    const name = args.shift();
    if (name !== 'web') throw new CliError('run only supports "web" now');
  }

  const options: CommandOptions = { command: 'web' };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    const [flag, inline] = splitFlag(argument);
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = args[++index] as string | undefined;
      if (next === undefined || next.trim() === '') throw new CliError(`${flag} needs a value`);
      return next.trim();
    };

    if (flag === '--host') {
      options.host = value();
    } else if (flag === '--port') {
      options.port = parsePort(value());
    } else {
      throw new CliError(`unknown option "${argument}"`);
    }
  }
  return options;
}

export function commandUsage(): string {
  return [
    'Usage: kolorbot run web [options]',
    '',
    'Web options:',
    '  --host <host>   listen address (default 127.0.0.1)',
    '  --port <port>   listen port (default 3399; 0 picks a free port)',
    '  --help          show this help',
    '',
    'Environment: KOLOR_WEB_HOST, KOLOR_WEB_PORT.',
  ].join('\n');
}

function splitFlag(argument: string): [string, string | undefined] {
  const index = argument.indexOf('=');
  if (index === -1) return [argument, undefined];
  return [argument.slice(0, index), argument.slice(index + 1)];
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliError('--port must be an integer between 0 and 65535');
  }
  return port;
}
