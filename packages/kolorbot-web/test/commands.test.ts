import assert from 'node:assert/strict';
import test from 'node:test';
import { CliError } from '../src/cli.js';
import { parseCommandLine } from '../src/commands.js';

test('parses run web, scheduler and gateway', () => {
  assert.deepEqual(parseCommandLine(['run', 'web', '--port', '3399']), {
    command: 'web',
    port: 3399,
  });
  assert.deepEqual(parseCommandLine(['run', 'scheduler', '--port', '3400']), {
    command: 'scheduler',
    schedulerPort: 3400,
  });
  assert.deepEqual(
    parseCommandLine([
      'run',
      'gateway',
      '--host',
      '0.0.0.0',
      '--port',
      '3399',
      '--scheduler-port',
      '3400',
    ]),
    {
      command: 'gateway',
      host: '0.0.0.0',
      port: 3399,
      schedulerPort: 3400,
    },
  );
});

test('keeps bare flags as web shorthand and rejects bad commands', () => {
  assert.deepEqual(parseCommandLine(['--host', '127.0.0.1', '--port', '0']), {
    command: 'web',
    host: '127.0.0.1',
    port: 0,
  });
  assert.deepEqual(parseCommandLine(['run', 'web', '--scheduler-url', 'http://x:3400']), {
    command: 'web',
    schedulerUrl: 'http://x:3400',
  });
  assert.throws(() => parseCommandLine(['run']), CliError);
  assert.throws(() => parseCommandLine(['run', 'cron']), /run needs one of/);
  assert.throws(() => parseCommandLine(['run', 'web', '--port', '70000']), /--port/);
});
