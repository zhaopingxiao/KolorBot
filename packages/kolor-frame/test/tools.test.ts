import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { callFrameTool, resolveFramePath } from '../src/tools.js';

function tempRoot(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'kolor-frame-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('write_file and read_file round-trip with line ranges', async (t) => {
  const root = tempRoot(t);
  const written = await callFrameTool(
    'write_file',
    { path: 'notes/a.txt', content: 'one\ntwo\nthree\nfour\n' },
    { root },
  );
  assert.equal(written.isError, undefined);
  assert.match(written.content, /Wrote 19 bytes to notes\/a.txt/);

  const full = await callFrameTool('read_file', { path: 'notes/a.txt' }, { root });
  assert.equal(full.content, 'one\ntwo\nthree\nfour');

  const slice = await callFrameTool('read_file', { path: 'notes/a.txt', offset: 2, limit: 2 }, { root });
  assert.match(slice.content, /^\[lines 2-3 of 4\]\ntwo\nthree$/);

  const appended = await callFrameTool(
    'write_file',
    { path: 'notes/a.txt', content: 'five', append: true },
    { root },
  );
  assert.match(appended.content, /^Appended/);
  const after = await callFrameTool('read_file', { path: 'notes/a.txt', offset: 5 }, { root });
  assert.match(after.content, /five/);
});

test('rejects paths outside the root', async (t) => {
  const root = tempRoot(t);
  assert.throws(() => resolveFramePath(root, '../outside.txt'), /escapes/);
  assert.throws(() => resolveFramePath(root, 'a/../../outside.txt'), /escapes/);
  assert.throws(() => resolveFramePath(root, '..'), /escapes/);

  const escaped = await callFrameTool('read_file', { path: '../secret.txt' }, { root });
  assert.equal(escaped.isError, true);
  assert.match(escaped.content, /escapes the KolorFrame root/);
});

test('read_file reports missing files and empty input', async (t) => {
  const root = tempRoot(t);
  const missing = await callFrameTool('read_file', { path: 'nope.txt' }, { root });
  assert.equal(missing.isError, true);
  assert.match(missing.content, /file not found/);

  const emptyPath = await callFrameTool('read_file', { path: '' }, { root });
  assert.equal(emptyPath.isError, true);
});

test('list_files walks the tree and respects depth', async (t) => {
  const root = tempRoot(t);
  await callFrameTool('write_file', { path: 'src/index.ts', content: 'export {}' }, { root });
  await callFrameTool('write_file', { path: 'README.md', content: '# hi' }, { root });
  await callFrameTool('write_file', { path: 'src/deep/nested/file.txt', content: 'x' }, { root });

  const listing = await callFrameTool('list_files', { path: '.', depth: 2 }, { root });
  assert.match(listing.content, /^Listing \. \(depth 2\):/);
  assert.match(listing.content, /src\//);
  assert.match(listing.content, /README\.md \(\d+ bytes\)/);
  assert.match(listing.content, /src\/index\.ts/);
  assert.doesNotMatch(listing.content, /nested/);

  const deep = await callFrameTool('list_files', { path: 'src', depth: 4 }, { root });
  assert.match(deep.content, /deep\/nested\/file\.txt/);
});

test('bash runs commands and reports failures', async (t) => {
  const root = tempRoot(t);
  const ok = await callFrameTool(
    'bash',
    { command: `"${process.execPath}" -e "console.log('frame-ok'); console.error('warn')"` },
    { root },
  );
  assert.equal(ok.isError, undefined);
  assert.match(ok.content, /exit_code: 0/);
  assert.match(ok.content, /frame-ok/);
  assert.match(ok.content, /--- stderr ---\nwarn/);

  const failed = await callFrameTool(
    'bash',
    { command: `"${process.execPath}" -e "process.exit(3)"` },
    { root },
  );
  assert.equal(failed.isError, true);
  assert.match(failed.content, /exit_code: 3/);

  const outside = await callFrameTool('bash', { command: 'echo hi', cwd: '../..' }, { root });
  assert.equal(outside.isError, true);
  assert.match(outside.content, /escapes|not found/);
});

test('skills tool reads an installed skill', async (t) => {
  const root = tempRoot(t);
  const skillsRoot = join(root, 'skills');
  mkdirSync(join(skillsRoot, 'pdf'), { recursive: true });
  writeFileSync(
    join(skillsRoot, 'pdf', 'SKILL.md'),
    '---\nname: PDF tools\ndescription: Extract text from PDFs\n---\n# Steps\n\nUse pdftotext.\n',
    'utf8',
  );

  const result = await callFrameTool('skills', { id: 'pdf' }, { root, skillsRoot });
  assert.equal(result.isError, undefined);
  assert.match(result.content, /# Skill pdf/);
  assert.match(result.content, /name: PDF tools/);
  assert.match(result.content, /# Steps/);
  assert.match(result.content, /SKILL\.md/);

  const missing = await callFrameTool('skills', { id: 'nope' }, { root, skillsRoot });
  assert.equal(missing.isError, true);
  assert.match(missing.content, /unknown skill/);
});

test('unknown tools and bad arguments become errors', async (t) => {
  const root = tempRoot(t);
  const unknown = await callFrameTool('rm_rf', {}, { root });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content, /unknown KolorFrame tool/);

  const bad = await callFrameTool('write_file', { path: 'x.txt' }, { root });
  assert.equal(bad.isError, true);
  assert.match(bad.content, /content must be a string/);
});
