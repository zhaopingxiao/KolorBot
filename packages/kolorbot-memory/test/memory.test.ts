import assert from 'node:assert/strict';
import test from 'node:test';
import {
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
