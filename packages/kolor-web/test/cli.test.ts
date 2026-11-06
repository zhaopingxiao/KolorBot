import assert from 'node:assert/strict';
import test from 'node:test';
import { CliError, cliUsage, parseCliArgs } from '../src/cli.js';

test('parses --host and --port in both forms', () => {
  assert.deepEqual(parseCliArgs([]), {});
  assert.deepEqual(parseCliArgs(['--host', '0.0.0.0', '--port', '3399']), {
    host: '0.0.0.0',
    port: 3399,
  });
  assert.deepEqual(parseCliArgs(['--host=127.0.0.1', '--port=0']), {
    host: '127.0.0.1',
    port: 0,
  });
});

test('help and invalid options', () => {
  assert.deepEqual(parseCliArgs(['--help']), { help: true });
  assert.match(cliUsage(), /0\.0\.0\.0/);
  assert.throws(() => parseCliArgs(['--port', '70000']), CliError);
  assert.throws(() => parseCliArgs(['--host']), /--host needs/);
  assert.throws(() => parseCliArgs(['--wat']), /unknown option/);
});
