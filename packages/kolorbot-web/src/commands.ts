import { CliError } from './cli.js';

export type Command = 'web' | 'scheduler' | 'gateway';

export interface CommandOptions {
  command: Command;
  /** Web listen address. */
  host?: string;
  /** Web listen port. */
  port?: number;
  /** Scheduler listen address (gateway / scheduler commands). */
  schedulerHost?: string;
  /** Scheduler listen port (gateway / scheduler commands). */
  schedulerPort?: number;
  /** URL the web UI uses to reach the scheduler. */
  schedulerUrl?: string;
  help?: boolean;
}

const COMMANDS: readonly Command[] = ['web', 'scheduler', 'gateway'];

/**
 * Parse `run <web|scheduler|gateway> [flags]`.
 *
 * Bare `--host/--port` (no `run`) is kept as shorthand for `run web` so older
 * scripts keep working.
 */
export function parseCommandLine(argv: readonly string[]): CommandOptions {
  const args = [...argv];
  if (args.includes('--help') || args.includes('-h')) return { command: 'web', help: true };

  let command: Command = 'web';
  if (args[0] === 'run') {
    args.shift();
    const name = args.shift();
    if (name === undefined || !COMMANDS.includes(name as Command)) {
      throw new CliError(`run needs one of: ${COMMANDS.join(', ')}`);
    }
    command = name as Command;
  }

  const options: CommandOptions = { command };
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
    } else if (flag === '--scheduler-host') {
      options.schedulerHost = value();
    } else if (flag === '--scheduler-port') {
      options.schedulerPort = parsePort(value());
    } else if (flag === '--scheduler-url') {
      options.schedulerUrl = value();
    } else {
      throw new CliError(`unknown option "${argument}"`);
    }
  }

  if (command === 'scheduler') {
    if (options.schedulerPort === undefined && options.port !== undefined) {
      // `run scheduler --port 3400` reads naturally too.
      options.schedulerPort = options.port;
      delete options.port;
    }
    if (options.schedulerHost === undefined && options.host !== undefined) {
      options.schedulerHost = options.host;
      delete options.host;
    }
  }
  return options;
}

export function commandUsage(): string {
  return [
    'Usage: kolorbot run <web|scheduler|gateway> [options]',
    '',
    '  run web        start only the web daemon (scheduled tasks show as unavailable)',
    '  run scheduler  start only the scheduled-task daemon (no web UI)',
    '  run gateway    start both daemons together',
    '',
    'Web options:',
    '  --host <host>            web listen address (default 127.0.0.1)',
    '  --port <port>            web listen port (default 3399; 0 picks a free port)',
    '  --scheduler-url <url>    scheduler URL used by web (default http://127.0.0.1:3400)',
    '',
    'Scheduler options:',
    '  --scheduler-host <host>  scheduler listen address (default 127.0.0.1)',
    '  --scheduler-port <port>  scheduler listen port (default 3400)',
    '  (run scheduler accepts --host/--port as aliases)',
    '',
    'Environment: KOLOR_WEB_HOST, KOLOR_WEB_PORT, KOLOR_SCHEDULER_HOST,',
    '             KOLOR_SCHEDULER_PORT, KOLOR_SCHEDULER_URL.',
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
