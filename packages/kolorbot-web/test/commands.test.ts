import assert from 'node:assert/strict';
import test from 'node:test';
import { CliError } from '../src/cli.js';
import { parseCommandLine } from '../src/commands.js';

test('parses run web and bare flags', () => {
  assert.deepEqual(parseCommandLine(['run', 'web', '--port', '3399']), {
    command: 'web',
    port: 3399,
  });
  assert.deepEqual(parseCommandLine(['--host', '127.0.0.1', '--port', '0']), {
    command: 'web',
    host: '127.0.0.1',
    port: 0,
  });
  assert.deepEqual(parseCommandLine(['run', 'web', '--host=0.0.0.0']), {
    command: 'web',
    host: '0.0.0.0',
  });
});

test('rejects removed commands and bad ports', () => {
  assert.throws(() => parseCommandLine(['run', 'gateway']), /only supports/);
  assert.throws(() => parseCommandLine(['run', 'scheduler']), /only supports/);
  assert.throws(() => parseCommandLine(['run', 'web', '--port', '70000']), /--port/);
  assert.throws(() => parseCommandLine(['run', 'web', '--wat']), CliError);
});
