import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildTopicDiaryMessage,
  findLatestDiarySection,
  readDiaryEntries,
  readDiaryTopicSection,
  formatLastMessageBlock,
  formatTopicMemoryBlock,
  buildSelfTellMessage,
  buildSelfUpdateMessage,
  formatMemoryBlock,
  memorySignature,
  selfTellInfo,
} from '../src/index.js';

test('formats AI.md before the daily diary', () => {
  const block = formatMemoryBlock('# 名字\n\n温柔', '## 09:00\n\n干活');
  assert.match(block, /^<system-memory>\n## AI self \(AI\.md\)\n/);
  assert.ok(block.indexOf('温柔') < block.indexOf('## Daily memory'));
  assert.ok(block.indexOf('## Daily memory') < block.indexOf('干活'));
});

test('omits empty sections and returns nothing when both are empty', () => {
  assert.equal(formatMemoryBlock('', ''), '');
  assert.equal(formatMemoryBlock('设定', '').includes('## Daily memory'), false);
  assert.equal(formatMemoryBlock('', '日记').includes('AI self (AI.md)'), false);
});

test('signature covers both files', () => {
  assert.equal(memorySignature('a', 'b'), memorySignature('a', 'b'));
  assert.notEqual(memorySignature('a', 'b'), memorySignature('a', 'c'));
  assert.notEqual(memorySignature('a', 'b'), memorySignature('c', 'b'));
});

test('clips AI.md at 1 MiB with a marker', () => {
  const block = formatMemoryBlock('x'.repeat(1024 * 1024 + 10), '');
  assert.match(block, /AI\.md truncated at 1 MiB/);
  assert.equal(block.includes('x'.repeat(1024 * 1024 + 10)), false);
});

test('self commands point at the kolor skill', () => {
  assert.match(buildSelfUpdateMessage(), /AI\.md/);
  assert.match(buildSelfTellMessage('喜欢猫'), /喜欢猫/);
  assert.equal(selfTellInfo('/self-md-tell 喜欢猫'), '喜欢猫');
  assert.equal(selfTellInfo('/self-md-tell'), '');
});

test('builds topic memory and last-message blocks', () => {
  const memory = formatTopicMemoryBlock({
    persona: '温柔',
    topicName: 'Remotion',
    topicContent: '项目在 workspace/remotion-project',
    diaryDate: '2026-11-14',
    diaryContent: '## Remotion\n\n昨天在改时间轴',
  });
  assert.match(memory, /^<system-memory>/);
  assert.ok(memory.indexOf('## Topic: Remotion') < memory.indexOf('## Latest diary'));
  const last = formatLastMessageBlock([
    { role: 'user', content: '上一句' },
    { role: 'assistant', content: '上一答' },
  ]);
  assert.match(last, /^<system-last-message>\nuser: 上一句\nassistant: 上一答/);
});

test('topic diary trigger carries the new layout and topic file instruction', () => {
  const message = buildTopicDiaryMessage(new Date(2026, 10, 14, 19, 21), [
    {
      topicName: 'Remotion',
      topicSlug: 'remotion',
      startedAt: new Date(2026, 10, 14, 19, 0).toISOString(),
      messages: [
        { role: 'user', content: '改一下时间轴' },
        { role: 'assistant', content: '好了' },
      ],
    },
  ]);
  assert.match(message, /## Remotion/);
  assert.match(message, /### 19:00/);
  assert.match(message, /workspace\/topic\/<slug>\.md/);
  assert.match(message, /first-appearance order/);
});

test('finds today, then the latest earlier, then the earliest diary section', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kolorbot-diary-'));
  const daily = join(dir, 'daily');
  mkdirSync(daily, { recursive: true });
  try {
    writeFileSync(
      join(daily, '2026-11-10.md'),
      '# 2026-11-10\n\n## Remotion\n\n### 09:00\n\n最早一次\n',
      'utf8',
    );
    writeFileSync(
      join(daily, '2026-11-13.md'),
      '# 2026-11-13\n\n## Remotion\n\n### 10:00\n\n昨天\n',
      'utf8',
    );
    const found = findLatestDiarySection(daily, 'Remotion', new Date(2026, 10, 14, 12, 0));
    assert.equal(found?.date, '2026-11-13');
    assert.match(found?.content ?? '', /昨天/);

    const earliest = findLatestDiarySection(daily, 'Remotion', new Date(2026, 10, 12, 12, 0));
    assert.equal(earliest?.date, '2026-11-10');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
test('indexes all diary topics and reads one topic section', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kolorbot-diary-index-'));
  const daily = join(dir, 'daily');
  mkdirSync(daily, { recursive: true });
  try {
    writeFileSync(
      join(daily, '2026-11-13.md'),
      '# 2026-11-13\n\n## Remotion\n\n### 10:00\n\nremotion 13\n\n## Workspace\n\n### 11:00\n\nworkspace 13\n',
      'utf8',
    );
    writeFileSync(
      join(daily, '2026-11-14.md'),
      '# 2026-11-14\n\n## Remotion\n\n### 19:00\n\nremotion 14\n',
      'utf8',
    );
    const entries = readDiaryEntries(daily);
    assert.deepEqual(
      entries.map((entry) => `${entry.date}:${entry.topic}`),
      ['2026-11-13:Remotion', '2026-11-13:Workspace', '2026-11-14:Remotion'],
    );
    assert.match(readDiaryTopicSection(daily, '2026-11-14', 'Remotion'), /## Remotion/);
    assert.match(readDiaryTopicSection(daily, '2026-11-14', 'Remotion'), /remotion 14/);
    assert.equal(readDiaryTopicSection(daily, '2026-11-14', 'Workspace'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});