import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildTopicDiaryMessage,
  findLatestDiarySection,
  readDiaryEntries,
  readDiaryTopicSection,
  appendDiaryEntry,
  parsePersona,
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

test('self commands include the AI.md rules inline', () => {
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
    recordName: '2026-11-18-21-32.md',
    recordContent: '最后一次记录：时间轴已经改完。',
  });
  assert.match(memory, /^<system-memory>/);
  assert.ok(memory.indexOf('## Topic: Remotion') < memory.indexOf('## Latest record'));
  assert.match(memory, /## Latest record \(2026-11-18-21-32\.md\)/);
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
  assert.match(message, /workspace\/topic\/<topic name>\/<timestamp>\.md/);
  assert.match(message, /write_topic_note/);
  assert.match(message, /last message completion time/);
  assert.equal(message.includes('### 19:00'), false);
  assert.equal(message.includes('first-appearance order'), false);
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
    assert.equal(findLatestDiarySection(daily, 'Remotion 话题', new Date(2026, 10, 14, 12, 0)), undefined);
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
    assert.equal(readDiaryTopicSection(daily, '2026-11-14', 'Remotion 话题'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
test('appends diary entries at the current time without duplicating topic sections', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kolorbot-diary-write-'));
  const daily = join(dir, 'daily');
  try {
    const at = new Date(2026, 10, 14, 19, 21);
    appendDiaryEntry(daily, '2026-11-14', 'Remotion', '第一条', at);
    appendDiaryEntry(daily, '2026-11-14', 'Remotion', '同分钟追加', at);
    appendDiaryEntry(daily, '2026-11-14', 'Deepseek Workspace', '另一个话题', at);
    appendDiaryEntry(daily, '2026-11-14', 'Remotion', '下一分钟', new Date(2026, 10, 14, 19, 22));
    const content = readFileSync(join(daily, '2026-11-14.md'), 'utf8');
    assert.equal((content.match(/^## Remotion$/gm) ?? []).length, 1);
    assert.match(content, /## Remotion\s+### 19:21\s+第一条\s+同分钟追加/);
    assert.match(content, /### 19:22\s+下一分钟/);
    assert.ok(content.indexOf('## Remotion') < content.indexOf('## Deepseek Workspace'));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
test('parses the fixed AI.md name and head-image header', () => {
  const profile = parsePersona(
    '# 小K\n\n## head-image\n\n> C:\\Users\\jiayi\\avatar.png\n\n## 性格\n\n温柔',
  );
  assert.equal(profile.name, '小K');
  assert.equal(profile.headImage, 'C:\\Users\\jiayi\\avatar.png');
  assert.deepEqual(parsePersona('没有标题'), { name: '', headImage: '' });
});