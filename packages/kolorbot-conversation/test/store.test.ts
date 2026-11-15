import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConversationStore } from '../src/index.js';

function tempStore(): { store: ConversationStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kolorbot-conversation-'));
  return { store: new ConversationStore({ path: join(dir, 'conversation.db') }), dir };
}

test('creates and reuses topics, and starts a new segment per visit', () => {
  const { store, dir } = tempStore();
  try {
    const remotion = store.ensureTopic('工作区 Remotion 环境', 'remotion');
    assert.equal(remotion.slug, 'remotion');
    assert.equal(store.ensureTopic('工作区 Remotion 环境').slug, 'remotion');
    assert.equal(store.listTopics().length, 1);

    const first = store.startSegment(remotion.slug, 'persona-1');
    assert.equal(store.currentSegment()?.id, first.id);
    const second = store.startSegment(remotion.slug, 'persona-1');
    assert.notEqual(second.id, first.id);
    assert.equal(store.segment(first.id)?.endedAt === null, false);
    assert.equal(store.listSegments().length, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('stores segment messages, keeps the last user/assistant texts and survives reopen', () => {
  const { store, dir } = tempStore();
  const topic = store.ensureTopic('Deepseek Workspace', 'deepseek-workspace');
  const segment = store.startSegment(topic.slug);

  store.appendMessages(segment.id, [
    { role: 'user', content: '第一条' },
    { role: 'assistant', content: '回复一', toolCalls: [] },
    { role: 'tool', toolCallId: 'call_1', name: 'read_file', content: 'file body', isError: false },
  ]);
  assert.equal(store.segmentMessages(segment.id).length, 3);
  assert.deepEqual(store.lastTextMessages(segment.id, 10), [
    { role: 'user', content: '第一条' },
    { role: 'assistant', content: '回复一' },
  ]);
  const view = store.view();
  assert.equal(view.messages.length, 3);
  assert.equal(view.segments[0]?.topicSlug, 'deepseek-workspace');
  store.close();

  const reopened = new ConversationStore({ path: join(dir, 'conversation.db') });
  try {
    assert.equal(reopened.messageCount(), 3);
    assert.equal(reopened.segmentMessages(segment.id).length, 3);
  } finally {
    reopened.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('rejects unknown topics and derives a fallback slug', () => {
  const { store, dir } = tempStore();
  try {
    assert.throws(() => store.startSegment('missing'), /unknown topic/);
    const topic = store.ensureTopic('中文话题');
    assert.match(topic.slug, /^topic-/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('last-message texts drop injected system envelopes', () => {
  const { store, dir } = tempStore();
  try {
    const topic = store.ensureTopic('Remotion', 'remotion');
    const segment = store.startSegment(topic.slug);
    store.appendMessages(segment.id, [
      { role: 'user', content: '<system-skills>\nskill\n</system-skills>\n\n真实问题' },
      { role: 'assistant', content: '<system-last-message>\nuser: old\n</system-last-message>\n\n回答', toolCalls: [] },
    ]);
    assert.deepEqual(store.lastTextMessages(segment.id, 10), [
      { role: 'user', content: '真实问题' },
      { role: 'assistant', content: '回答' },
    ]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});