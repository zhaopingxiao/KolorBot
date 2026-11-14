import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { SkillsRegistry, formatSkillsBlock, resolveSkillsRoot } from '../src/skills.js';
import { parseSkillMarkdown } from '../src/frontmatter.js';

function tempRoot(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'kolorbot-skills-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return join(dir, 'skills');
}

function writeSkill(
  root: string,
  id: string,
  frontmatter: string,
  body = '# Instructions\n',
  extraFiles: Record<string, string> = {},
): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`, 'utf8');
  for (const [path, content] of Object.entries(extraFiles)) {
    const absolute = join(dir, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
}

test('parses frontmatter scalars and blocks', () => {
  const folded = parseSkillMarkdown(
    ['---', 'name: pdf', 'description: >', '  Extract text', '  from PDFs.', '---', '# Body'].join(
      '\n',
    ),
  );
  assert.equal(folded.frontmatter.name, 'pdf');
  assert.equal(folded.frontmatter.description, 'Extract text from PDFs.');
  assert.equal(folded.body, '# Body');

  const quoted = parseSkillMarkdown('---\ndescription: "say \\"hi\\""\n---\nbody');
  assert.equal(quoted.frontmatter.description, 'say "hi"');

  const plain = parseSkillMarkdown(
    ['---', 'description: line one', '  line two', '---', 'x'].join('\n'),
  );
  assert.equal(plain.frontmatter.description, 'line one line two');

  assert.deepEqual(parseSkillMarkdown('# no frontmatter'), {
    frontmatter: {},
    body: '# no frontmatter',
  });
});

test('lists installed skills sorted by id', (t) => {
  const root = tempRoot(t);
  writeSkill(root, 'review', 'name: Review\ndescription: Review a diff');
  writeSkill(root, 'pdf', 'name: PDF tools\ndescription: >\n  Extract and merge\n  PDF files.');
  mkdirSync(join(root, 'not-a-skill'), { recursive: true });
  mkdirSync(join(root, '.hidden'), { recursive: true });

  const registry = new SkillsRegistry({ root });
  const skills = registry.list();
  assert.deepEqual(
    skills.map((skill) => skill.id),
    ['pdf', 'review'],
  );
  assert.equal(skills[0]?.name, 'PDF tools');
  assert.equal(skills[0]?.description, 'Extract and merge PDF files.');
  assert.equal(skills[1]?.description, 'Review a diff');
});

test('falls back to the first paragraph for a description', (t) => {
  const root = tempRoot(t);
  writeSkill(root, 'plain', 'name: plain', '# Heading\n\nDo the thing.\n');
  const skill = new SkillsRegistry({ root }).list()[0];
  assert.equal(skill?.description, 'Do the thing.');
});

test('merges the three skills areas with the first root winning', (t) => {
  const agents = tempRoot(t);
  const user = tempRoot(t);
  const builtin = tempRoot(t);
  writeSkill(agents, 'shared', 'name: Shared\ndescription: from agents');
  writeSkill(user, 'shared', 'name: Shared\ndescription: from user');
  writeSkill(user, 'only-user', 'description: user only');
  writeSkill(builtin, 'builtin-one', 'description: built in');
  writeSkill(builtin, 'only-user', 'description: builtin copy');

  const registry = new SkillsRegistry({
    roots: [
      { source: 'user', path: user },
      { source: 'agents', path: agents },
      { source: 'builtin', path: builtin },
    ],
  });
  const skills = registry.list();
  assert.deepEqual(
    skills.map((skill) => skill.id),
    ['builtin-one', 'only-user', 'shared'],
  );
  assert.equal(skills.find((skill) => skill.id === 'shared')?.source, 'user');
  assert.equal(skills.find((skill) => skill.id === 'shared')?.description, 'from user');
  assert.equal(skills.find((skill) => skill.id === 'only-user')?.description, 'user only');

  assert.deepEqual(
    registry.listSource('builtin').map((skill) => skill.id),
    ['builtin-one', 'only-user'],
  );
  const builtinSkill = registry.get('builtin-one');
  assert.equal(builtinSkill?.source, 'builtin');
  assert.match(builtinSkill?.path ?? '', /builtin-one[\\/]SKILL\.md$/);
});

test('collects MCP servers across roots with the first declaration winning', (t) => {
  const agents = tempRoot(t);
  const user = tempRoot(t);
  writeSkill(agents, 'a', 'description: A');
  mkdirSync(user, { recursive: true });
  writeFileSync(
    join(agents, 'kolor.json'),
    JSON.stringify({
      mcpServers: {
        shared: { command: 'node', args: ['agents.js'] },
        onlyAgents: { command: 'node', args: ['a.js'] },
      },
    }),
    'utf8',
  );
  writeFileSync(
    join(user, 'kolor.json'),
    JSON.stringify({ mcpServers: { shared: { command: 'node', args: ['user.js'] } } }),
    'utf8',
  );

  const servers = new SkillsRegistry({
    roots: [
      { source: 'user', path: user },
      { source: 'agents', path: agents },
    ],
  }).mcpServers();
  assert.deepEqual(
    servers.map((server) => [server.name, server.transport]),
    [
      ['shared', 'stdio'],
      ['onlyAgents', 'stdio'],
    ],
  );
  const shared = servers[0];
  if (shared?.transport !== 'stdio') {
    assert.fail('the shared server should be stdio');
  }
  assert.equal(shared.command, 'node');
  assert.deepEqual(shared.args, ['user.js']);
});

test('signature changes only when id or description changes', (t) => {
  const root = tempRoot(t);
  writeSkill(root, 'alpha', 'description: first');
  const registry = new SkillsRegistry({ root });
  const before = registry.signature();
  assert.match(before, /^v2:[0-9a-f]{40}$/);

  writeSkill(root, 'alpha', 'description: first', '# Body changed');
  assert.equal(registry.signature(), before, 'body changes do not alter the list');

  writeSkill(root, 'alpha', 'description: second');
  const afterDescription = registry.signature();
  assert.notEqual(afterDescription, before);

  writeSkill(root, 'beta', 'description: another');
  assert.notEqual(registry.signature(), afterDescription);
});

test('read returns SKILL.md content and files', (t) => {
  const root = tempRoot(t);
  writeSkill(root, 'demo', 'description: demo skill', '# Demo\n\nUse it.', {
    'scripts/run.py': 'print("hi")\n',
    'references/guide.md': '# Guide\n',
  });

  const registry = new SkillsRegistry({ root });
  const skill = registry.read('demo');
  assert.match(skill.content, /^---\ndescription: demo skill\n---\n# Demo/);
  assert.deepEqual(skill.files, ['references/guide.md', 'scripts/run.py', 'SKILL.md']);
  assert.equal(skill.path, join(root, 'demo', 'SKILL.md'));
});

test('reads MCP servers from skill kolor.json files', (t) => {
  const root = tempRoot(t);
  writeSkill(root, 'github', 'description: GitHub tools', '# GitHub\n', {
    'kolor.json': JSON.stringify({
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: 'token' },
        },
        remote: {
          type: 'http',
          url: 'https://example.com/mcp',
          headers: { authorization: 'Bearer token' },
        },
        local: {
          command: './bin/server.sh',
          args: [],
          cwd: 'runtime',
        },
        badUrl: { url: 'ftp://example.com/mcp' },
        'bad name!': { command: 'nope' },
      },
    }),
  });
  writeSkill(root, 'other', 'description: Other tools', '# Other\n', {
    'kolor.json': JSON.stringify({
      mcp: {
        github: { command: 'shadowed' },
        search: { type: 'sse', url: 'https://example.com/sse' },
      },
    }),
  });

  const servers = new SkillsRegistry({ root }).mcpServers();
  assert.deepEqual(
    servers.map((server) => [server.name, server.transport, server.skillId]),
    [
      ['github', 'stdio', 'github'],
      ['remote', 'http', 'github'],
      ['local', 'stdio', 'github'],
      ['search', 'sse', 'other'],
    ],
  );

  const github = servers.find((server) => server.name === 'github');
  assert.equal(github?.transport, 'stdio');
  if (github?.transport === 'stdio') {
    assert.equal(github.command, 'npx');
    assert.deepEqual(github.args, ['-y', '@modelcontextprotocol/server-github']);
    assert.equal(github.cwd, join(root, 'github'));
  }

  const local = servers.find((server) => server.name === 'local');
  assert.equal(local?.transport, 'stdio');
  if (local?.transport === 'stdio') {
    assert.equal(local.command, join(root, 'github', 'bin', 'server.sh'));
    assert.equal(local.cwd, join(root, 'github', 'runtime'));
  }

  const remote = servers.find((server) => server.name === 'remote');
  assert.equal(remote?.transport, 'http');
  if (remote?.transport === 'http') {
    assert.equal(remote.url, 'https://example.com/mcp');
    assert.equal(remote.headers?.authorization, 'Bearer token');
  }
});

test('reads a global kolor.json from the skills root', (t) => {
  const root = tempRoot(t);
  writeSkill(root, 'demo', 'description: demo');
  writeFileSync(
    join(root, 'kolor.json'),
    JSON.stringify({
      mcpServers: { global: { command: 'node', args: ['global.js'] } },
    }),
    'utf8',
  );

  const servers = new SkillsRegistry({ root }).mcpServers();
  assert.equal(servers.length, 1);
  assert.equal(servers[0]?.name, 'global');
  assert.equal(servers[0]?.skillId, '');
});

test('expands ${VAR} placeholders in skill MCP env', (t) => {
  const root = tempRoot(t);
  writeSkill(root, 'search', 'description: Search', '# Search\n', {
    'kolor.json': JSON.stringify({
      mcpServers: {
        search: {
          command: 'node',
          args: ['server.mjs'],
          env: {
            DEEPSEEK_API_KEY: '${TEST_DEEPSEEK_KEY}',
            EMPTY: '${MISSING_KEY}',
          },
        },
      },
    }),
  });

  const servers = new SkillsRegistry({
    root,
    env: { TEST_DEEPSEEK_KEY: 'sk-secret' },
  }).mcpServers();
  assert.equal(servers.length, 1);
  assert.equal(servers[0]?.transport, 'stdio');
  if (servers[0]?.transport === 'stdio') {
    assert.equal(servers[0].env?.DEEPSEEK_API_KEY, 'sk-secret');
    assert.equal(servers[0].env?.EMPTY, '');
  }
});

test('ignores missing or broken kolor.json files', (t) => {
  const root = tempRoot(t);
  writeSkill(root, 'broken', 'description: broken', '# Broken\n', {
    'kolor.json': '{ not json',
  });
  writeSkill(root, 'plain', 'description: plain');
  const registry = new SkillsRegistry({ root });
  assert.deepEqual(registry.mcpServers(), []);
});

test('unknown ids and missing roots are handled', (t) => {
  const root = tempRoot(t);
  const registry = new SkillsRegistry({ root });
  assert.deepEqual(registry.list(), []);
  assert.throws(() => registry.read('missing'), /unknown skill/);
  assert.equal(registry.get('../etc'), undefined);
});

test('formats the system-skills block', () => {
  const block = formatSkillsBlock([
    { id: 'pdf', name: 'PDF', description: 'Extract PDF text', path: '/x/pdf/SKILL.md', source: 'agents' },
    { id: 'review', name: 'Review', description: 'Review a diff', path: '/x/review/SKILL.md', source: 'agents' },
  ]);
  assert.equal(
    block,
    [
      '<system-skills>',
      'pdf - Extract PDF text',
      'review - Review a diff',
      '</system-skills>',
    ].join('\n'),
  );
});

test('resolves the skills root from the environment', () => {
  assert.equal(resolveSkillsRoot({ KOLOR_SKILLS_DIR: 'D:/s' }), 'D:/s');
  assert.match(resolveSkillsRoot({ KOLOR_HOME: 'D:/home' }), /[\\/]\.agents[\\/]skills$/);
  assert.match(resolveSkillsRoot({}), /[\\/]\.agents[\\/]skills$/);
});
