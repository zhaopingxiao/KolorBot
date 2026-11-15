import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConversationStore } from 'kolorbot-conversation';
import { createDiaryTools } from '../src/diary-tools.js';

async function run(
  tools: ReturnType<typeof createDiaryTools>,
  name: string,
  input: Record<string, unknown>,
): Promise<{ content: string; isError?: boolean }> {
  const found = tools.find((entry) => entry.name === name);
  assert.ok(found, `missing ${name}`);
  const result = await found.execute(input, {} as never);
  return typeof result === 'string' ? { content: result } : result;
}

test('diary tools use the current topic and require topic memory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kolorbot-diary-tools-'));
  const store = new ConversationStore({ path: join(dir, 'conversation.db') });
  const daily = join(dir, 'daily');
  const at = new Date(2026, 10, 14, 19, 21);
  try {
    const topic = store.ensureTopic('Remotion', 'remotion');
    store.startSegment(topic.slug);
    const tools = createDiaryTools({
      store,
      diaryDir: daily,
      workspace: dir,
      currentTopicSlug: () => 'remotion',
      now: () => at,
    });

    const list = await run(tools, 'list_topics', {});
    assert.match(list.content, /remotion — Remotion \(current\)/);

    const empty = await run(tools, 'read_diary', {});
    assert.match(empty.content, /No diary entries/);

    const written = await run(tools, 'write_diary', { content: '第一条记录' });
    assert.match(written.content, /Wrote diary/);
    assert.match(written.content, /write_topic/);
    const raw = readFileSync(join(daily, '2026-11-14.md'), 'utf8');
    assert.match(raw, /## Remotion/);
    assert.match(raw, /### 19:21/);
    assert.match(raw, /第一条记录/);

    const topicWritten = await run(tools, 'write_topic', {
      content: '- 项目路径：workspace/remotion-project\n- 当前状态：测试中',
    });
    assert.match(topicWritten.content, /Wrote topic memory/);
    const topicRaw = readFileSync(join(dir, 'topic', 'remotion.md'), 'utf8');
    assert.match(topicRaw, /^# Remotion/);
    assert.match(topicRaw, /remotion-project/);

    const dates = await run(tools, 'read_diary', {});
    assert.match(dates.content, /2026-11-14/);
    const section = await run(tools, 'read_diary', { date: '2026-11-14' });
    assert.match(section.content, /## Remotion/);
    assert.match(section.content, /第一条记录/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('diary/topic writes are blocked outside a diary turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kolorbot-diary-tools-guard-'));
  const store = new ConversationStore({ path: join(dir, 'conversation.db') });
  try {
    const topic = store.ensureTopic('Remotion', 'remotion');
    store.startSegment(topic.slug);
    const tools = createDiaryTools({
      store,
      diaryDir: join(dir, 'daily'),
      workspace: dir,
      currentTopicSlug: () => 'remotion',
      writeEnabled: () => false,
    });
    const diary = await run(tools, 'write_diary', { content: '不应写入' });
    assert.equal(diary.isError, true);
    assert.match(diary.content, /only available during a diary turn/);
    const topicWrite = await run(tools, 'write_topic', { content: '不应写入' });
    assert.equal(topicWrite.isError, true);
    assert.match(topicWrite.content, /only available during a diary turn/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});