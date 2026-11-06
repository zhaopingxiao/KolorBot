import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentIdentity, ToolCall, ToolDefinition } from '../src/types.js';
import { ToolRegistry } from '../src/tools/registry.js';
import {
  executeToolCalls,
  type ToolSchedulerEvent,
  type ToolSchedulerOptions,
  type ToolSchedulerOutcome,
} from '../src/tools/scheduler.js';

const identity: AgentIdentity = { id: 'test-agent', sessionId: 'test-session' };

function call(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

function tool(
  name: string,
  execute: ToolDefinition['execute'],
  extra: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: {} },
    execute,
    ...extra,
  };
}

function options(
  tools: ToolDefinition[],
  calls: ToolCall[],
  overrides: Partial<ToolSchedulerOptions> = {},
): ToolSchedulerOptions {
  const registry = new ToolRegistry();
  registry.registerAll(tools);
  return {
    registry,
    calls,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
    maxParallel: 10,
    defaultTimeoutMs: 2000,
    maxResultChars: 10_000,
    agent: identity,
    ...overrides,
  };
}

async function collect(
  schedulerOptions: ToolSchedulerOptions,
): Promise<{ events: ToolSchedulerEvent[]; outcome: ToolSchedulerOutcome }> {
  const generator = executeToolCalls(schedulerOptions);
  const events: ToolSchedulerEvent[] = [];
  while (true) {
    const next = await generator.next();
    if (next.done) return { events, outcome: next.value };
    events.push(next.value);
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('bounds parallel calls and commits results in model order', async () => {
  let active = 0;
  let peak = 0;
  const tools = Array.from({ length: 5 }, (_, index) =>
    tool(`t${index}`, async () => {
      active += 1;
      peak = Math.max(peak, active);
      // Later calls finish first, so ordering can only come from the commit rule.
      await delay(40 - index * 7);
      active -= 1;
      return `result-${index}`;
    }),
  );
  const calls = tools.map((_, index) => call(`call-${index}`, `t${index}`));

  const { events, outcome } = await collect(options(tools, calls, { maxParallel: 2 }));

  assert.equal(outcome.aborted, false);
  assert.ok(peak <= 2, `expected at most 2 concurrent calls, saw ${peak}`);
  const results = events.filter((event) => event.type === 'tool/result');
  assert.deepEqual(
    results.map((event) => event.callId),
    calls.map((entry) => entry.id),
  );
  assert.deepEqual(
    results.map((event) => (event.type === 'tool/result' ? event.content : '')),
    ['result-0', 'result-1', 'result-2', 'result-3', 'result-4'],
  );
});

test('exclusive calls form a barrier around the parallel calls before and after them', async () => {
  const order: string[] = [];
  const makeTool = (name: string, concurrency?: 'parallel' | 'exclusive') =>
    tool(
      name,
      async () => {
        order.push(`start:${name}`);
        await delay(15);
        order.push(`end:${name}`);
        return name;
      },
      concurrency === undefined ? {} : { concurrency },
    );
  const tools = [makeTool('a'), makeTool('b'), makeTool('c', 'exclusive'), makeTool('d')];
  const calls = [call('1', 'a'), call('2', 'b'), call('3', 'c'), call('4', 'd')];

  const { outcome } = await collect(options(tools, calls, { maxParallel: 4 }));

  assert.equal(outcome.aborted, false);
  assert.ok(order.indexOf('start:c') > order.indexOf('end:a'));
  assert.ok(order.indexOf('start:c') > order.indexOf('end:b'));
  assert.ok(order.indexOf('start:d') > order.indexOf('end:c'));
});

test('cancellation drains started calls and reports the rest as skipped', async () => {
  const controller = new AbortController();
  const pending = () => new Promise<string>(() => undefined);
  const tools = [
    tool('fast', pending),
    tool('slow', pending),
    tool('never', pending),
    tool('never2', pending),
  ];
  const calls = [call('1', 'fast'), call('2', 'slow'), call('3', 'never'), call('4', 'never2')];

  setTimeout(() => controller.abort(new Error('user cancelled')), 20);
  const { events, outcome } = await collect(
    options(tools, calls, { maxParallel: 2, signal: controller.signal }),
  );

  assert.equal(outcome.aborted, true);
  const results = events.filter((event) => event.type === 'tool/result');
  const skipped = events.filter((event) => event.type === 'tool/skipped');
  assert.equal(results.length, 2);
  assert.ok(results.every((event) => event.type === 'tool/result' && event.isError));
  assert.deepEqual(
    skipped.map((event) => (event.type === 'tool/skipped' ? event.callId : '')),
    ['3', '4'],
  );
});

test('unknown tools and invalid arguments become model-readable errors', async () => {
  const tools = [tool('known', () => 'ok')];
  const calls = [
    call('1', 'known'),
    call('2', 'missing'),
    { id: '3', name: 'known', arguments: '{not json' },
  ];

  const { events } = await collect(options(tools, calls));
  const results = events.filter((event) => event.type === 'tool/result');
  assert.equal(results.length, 3);
  assert.equal(results[0]?.type === 'tool/result' ? results[0].isError : true, false);
  assert.match(
    results[1]?.type === 'tool/result' ? results[1].content : '',
    /unknown tool "missing"/,
  );
  assert.match(results[2]?.type === 'tool/result' ? results[2].content : '', /invalid JSON arguments/);
});

test('a tool that outlives its deadline fails with a timeout result', async () => {
  const tools = [tool('sleepy', async () => delay(100).then(() => 'late'))];
  const { events } = await collect(
    options(tools, [call('1', 'sleepy')], { defaultTimeoutMs: 10 }),
  );
  const result = events.find((event) => event.type === 'tool/result');
  assert.equal(result?.type, 'tool/result');
  if (result?.type === 'tool/result') {
    assert.equal(result.isError, true);
    assert.match(result.content, /timed out after 10ms/);
  }
});

test('a concluding tool ends the turn', async () => {
  const tools = [
    tool('submit', () => ({ content: 'submitted', concludeTurn: true })),
    tool('after', () => 'should not run'),
  ];
  const { outcome } = await collect(
    options(tools, [call('1', 'submit'), call('2', 'after')], { maxParallel: 2 }),
  );
  assert.equal(outcome.concluded, true);
});
