import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { migrateLegacyLayout } from '../src/layout-migration.js';

function tempHome(t: TestContext): string {
  const home = mkdtempSync(join(tmpdir(), 'kolor-layout-'));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return home;
}

test('moves workspace, skills and conversation database into agent', (t) => {
  const home = tempHome(t);
  const legacyWorkspace = join(home, 'workspace');
  mkdirSync(join(legacyWorkspace, 'topic', 'greeting'), { recursive: true });
  mkdirSync(join(legacyWorkspace, 'assets'), { recursive: true });
  mkdirSync(join(legacyWorkspace, 'projects', 'demo'), { recursive: true });
  writeFileSync(join(legacyWorkspace, 'AI.md'), '# Test\n', 'utf8');
  writeFileSync(join(legacyWorkspace, 'assets', 'a.png'), 'png', 'utf8');
  writeFileSync(join(legacyWorkspace, 'projects', 'demo', 'README.md'), 'demo\n', 'utf8');
  writeFileSync(join(legacyWorkspace, 'topic', 'greeting', 'main.md'), 'memory\n', 'utf8');
  mkdirSync(join(home, 'skills', 'demo'), { recursive: true });
  writeFileSync(join(home, 'skills', 'demo', 'SKILL.md'), '# Demo\n', 'utf8');
  writeFileSync(join(home, 'conversation.db'), 'db', 'utf8');
  writeFileSync(join(home, 'conversation.db-wal'), 'wal', 'utf8');
  writeFileSync(join(home, 'conversation.db-shm'), 'shm', 'utf8');

  const target = join(home, 'agent');
  const result = migrateLegacyLayout(home, target, join(target, 'workspace'), join(target, 'conversation.db'));

  assert.equal(result.moved.length, 5);
  assert.equal(existsSync(join(home, 'workspace')), false);
  assert.equal(existsSync(join(home, 'skills')), false);
  assert.equal(existsSync(join(home, 'conversation.db')), false);
  assert.equal(readFileSync(join(target, 'AI.md'), 'utf8'), '# Test\n');
  assert.equal(readFileSync(join(target, 'topic', 'greeting', 'main.md'), 'utf8'), 'memory\n');
  assert.equal(readFileSync(join(target, 'workspace', 'assets', 'a.png'), 'utf8'), 'png');
  assert.equal(readFileSync(join(target, 'workspace', 'projects', 'demo', 'README.md'), 'utf8'), 'demo\n');
  assert.equal(readFileSync(join(target, 'skills', 'demo', 'SKILL.md'), 'utf8'), '# Demo\n');
  assert.equal(readFileSync(join(target, 'conversation.db'), 'utf8'), 'db');
  assert.equal(readFileSync(join(target, 'conversation.db-wal'), 'utf8'), 'wal');
  assert.equal(readFileSync(join(target, 'conversation.db-shm'), 'utf8'), 'shm');
});

test('does not migrate a custom frame root', (t) => {
  const home = tempHome(t);
  mkdirSync(join(home, 'workspace'), { recursive: true });
  writeFileSync(join(home, 'workspace', 'AI.md'), '# Legacy\n', 'utf8');
  const custom = join(home, 'custom-agent');
  const result = migrateLegacyLayout(home, custom, join(custom, 'workspace'), join(home, 'custom.db'));
  assert.deepEqual(result.moved, []);
  assert.equal(readFileSync(join(home, 'workspace', 'AI.md'), 'utf8'), '# Legacy\n');
  assert.equal(existsSync(custom), false);
});
