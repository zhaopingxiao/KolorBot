import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SYSTEM_PROMPT,
  resolveConfig,
  toChatCompletionsUrl,
  type KolorConfig,
} from '../src/config.js';
import { KolorConfigError } from '../src/util/errors.js';

const base: KolorConfig = {
  apiUrl: 'https://api.deepseek.com',
  apiModelName: 'deepseek-chat',
  apiKey: 'sk-test',
};

test('normalises base URLs into chat-completions endpoints', () => {
  assert.equal(toChatCompletionsUrl('https://api.deepseek.com'), 'https://api.deepseek.com/chat/completions');
  assert.equal(toChatCompletionsUrl('https://api.deepseek.com/'), 'https://api.deepseek.com/chat/completions');
  assert.equal(
    toChatCompletionsUrl('https://api.deepseek.com/v1'),
    'https://api.deepseek.com/v1/chat/completions',
  );
  assert.equal(
    toChatCompletionsUrl('https://api.openai.com/v1/chat/completions'),
    'https://api.openai.com/v1/chat/completions',
  );
});

test('rejects unusable apiUrl values', () => {
  assert.throws(() => toChatCompletionsUrl('not a url'), KolorConfigError);
  assert.throws(() => toChatCompletionsUrl('ftp://example.com'), KolorConfigError);
  assert.throws(() => toChatCompletionsUrl('   '), KolorConfigError);
});

test('fills defaults and keeps required fields', () => {
  const config = resolveConfig(base);
  assert.equal(config.endpoint, 'https://api.deepseek.com/chat/completions');
  assert.equal(config.apiModelName, 'deepseek-chat');
  assert.equal(config.maxSteps, 40);
  assert.equal(config.maxParallelToolCalls, 10);
  assert.equal(config.toolTimeoutMs, 60_000);
  assert.equal(config.systemPrompt, DEFAULT_SYSTEM_PROMPT);
  assert.deepEqual(config.mcpServers, []);
});

test('accepts a custom system prompt, including the empty string', () => {
  assert.equal(resolveConfig({ ...base, systemPrompt: 'be terse' }).systemPrompt, 'be terse');
  assert.equal(resolveConfig({ ...base, systemPrompt: '' }).systemPrompt, '');
});

test('reports every invalid field at once', () => {
  assert.throws(
    () =>
      resolveConfig({
        apiUrl: '',
        apiModelName: '',
        apiKey: '',
        maxSteps: 0,
      }),
    (error: unknown) => {
      assert.ok(error instanceof KolorConfigError);
      assert.match(error.message, /apiUrl is required/);
      assert.match(error.message, /apiModelName is required/);
      assert.match(error.message, /apiKey is required/);
      assert.match(error.message, /maxSteps must be a positive integer/);
      return true;
    },
  );
});

test('validates MCP server entries', () => {
  assert.throws(
    () => resolveConfig({ ...base, mcpServers: [{ name: 'x', command: '' }] }),
    /command is required/,
  );
  assert.throws(
    () =>
      resolveConfig({
        ...base,
        mcpServers: [{ name: 'remote', transport: 'http', url: 'nope' }],
      }),
    /url is not a valid URL/,
  );
  assert.throws(
    () =>
      resolveConfig({
        ...base,
        mcpServers: [
          { name: 'same', command: 'node' },
          { name: 'same', command: 'node' },
        ],
      }),
    /duplicate MCP server name/,
  );
});
