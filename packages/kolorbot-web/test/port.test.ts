import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import test from 'node:test';
import { canListen, chooseServerPort } from '../src/port.js';

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no address'));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('chooses the next port when the preferred port is occupied', async () => {
  const occupied = createServer();
  const occupiedPort = await listen(occupied, 0);
  const free = createServer();
  const freePort = await listen(free, 0);
  await close(free);
  try {
    assert.equal(await canListen('127.0.0.1', occupiedPort), false);
    assert.equal(await chooseServerPort('127.0.0.1', [occupiedPort, freePort]), freePort);
  } finally {
    await close(occupied);
  }
});
