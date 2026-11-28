import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BackgroundBashError,
  BackgroundBashManager,
  taskBaseName,
} from '../src/frame/background.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('timed out'));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

test('derives sanitized, case-sensitive task names', () => {
  assert.equal(taskBaseName('python -c "print(1)"'), 'python');
  assert.equal(taskBaseName('C:\\Python\\python.exe -c x'), 'python');
  assert.equal(taskBaseName('./scripts/run.sh --flag'), 'run.sh');
  assert.equal(taskBaseName('python.exe'), 'python');
  assert.equal(taskBaseName('Python -c x'), 'Python');
  assert.notEqual(taskBaseName('Python -c x'), taskBaseName('python -c x'));
  assert.equal(taskBaseName('foo:bar baz'), 'foo_bar');
  assert.equal(taskBaseName('  '), 'task');
});

test('names collisions with _2 and reuses names after the record is read', async () => {
  const manager = new BackgroundBashManager();
  try {
    const first = manager.start('node -e "setTimeout(() => {}, 2000)"', process.cwd());
    const second = manager.start('node -e "setTimeout(() => {}, 2000)"', process.cwd());
    assert.equal(first.name, 'node');
    assert.equal(second.name, 'node_2');
    assert.match(manager.read(first.name).content, /\(Running\.\.\.\)$/);

    manager.stop(first.name);
    manager.stop(second.name);
    assert.match(manager.read(first.name).content, /(empty output)|[^\n]/);
    assert.match(manager.read(second.name).content, /(empty output)|[^\n]/);
    assert.equal(manager.read(first.name).isError, true);
    assert.equal(manager.read(second.name).isError, true);

    const reused = manager.start('node -e "setTimeout(() => {}, 2000)"', process.cwd());
    assert.equal(reused.name, 'node');
    manager.stop(reused.name);
    manager.read(reused.name);
  } finally {
    manager.disposeAll();
  }
});

test('returns output, deletes finished records, and consumes a completion only once', async () => {
  let completed = '';
  const manager = new BackgroundBashManager({
    onComplete: (name) => {
      completed = name;
    },
  });
  try {
    const started = manager.start('node -e "console.log(\'background-ok\')"', process.cwd());
    await waitFor(() => completed === started.name);
    assert.equal(manager.consumeNotification(started.name), true);
    assert.equal(manager.consumeNotification(started.name), false);

    const output = manager.read(started.name);
    assert.equal(output.isError, undefined);
    assert.match(output.content, /background-ok/);
    assert.equal(manager.read(started.name).isError, true);
  } finally {
    manager.disposeAll();
  }
});

test('reading a finished task deletes the record and suppresses its notification', async () => {
  let completed = '';
  const manager = new BackgroundBashManager({
    onComplete: (name) => {
      completed = name;
    },
  });
  try {
    const started = manager.start('node -e "console.log(\'read-first\')"', process.cwd());
    await waitFor(() => completed === started.name);
    const output = manager.read(started.name);
    assert.match(output.content, /read-first/);
    assert.equal(manager.consumeNotification(started.name), false);
    assert.equal(manager.read(started.name).isError, true);
  } finally {
    manager.disposeAll();
  }
});

test('stop keeps output readable and suppresses the completion callback', async () => {
  let completed = '';
  const manager = new BackgroundBashManager({
    onComplete: (name) => {
      completed = name;
    },
  });
  try {
    const started = manager.start('node -e "setTimeout(() => console.log(\'late\'), 2000)"', process.cwd());
    await sleep(80);
    const stopped = manager.stop(started.name);
    assert.equal(stopped.isError, undefined);
    await sleep(120);
    assert.equal(completed, '');
    assert.equal(manager.read(started.name).isError, undefined);
    assert.equal(manager.read(started.name).isError, true);
  } finally {
    manager.disposeAll();
  }
});

test('rejects more than eight running tasks', async () => {
  const manager = new BackgroundBashManager();
  try {
    for (let index = 0; index < 8; index += 1) {
      manager.start('node -e "setTimeout(() => {}, 5000)"', process.cwd());
    }
    assert.throws(
      () => manager.start('node -e "setTimeout(() => {}, 5000)"', process.cwd()),
      (error: unknown) => error instanceof BackgroundBashError,
    );
  } finally {
    manager.disposeAll();
  }
});
