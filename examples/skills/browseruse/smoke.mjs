import { spawn } from 'node:child_process';
import { join } from 'node:path';

const server = join(process.cwd(), 'server.mjs');
const child = spawn(process.execPath, [server], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'inherit'] });

const requests = [
  { id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
  { id: 2, method: 'tools/list', params: {} },
  {
    id: 3,
    method: 'tools/call',
    params: {
      name: 'browser_open',
      arguments: { url: 'data:text/html,<h1>Hi BrowserUse</h1><button>Go</button><input id="name">' },
    },
  },
  { id: 4, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } },
  { id: 5, method: 'tools/call', params: { name: 'browser_click', arguments: { index: 0 } } },
  { id: 6, method: 'tools/call', params: { name: 'browser_type', arguments: { index: 1, text: 'hello' } } },
  { id: 7, method: 'tools/call', params: { name: 'browser_evaluate', arguments: { expression: 'document.title + "|" + document.querySelector("#name").value' } } },
  { id: 8, method: 'tools/call', params: { name: 'browser_screenshot', arguments: {} } },
  { id: 9, method: 'tools/call', params: { name: 'browser_webmcp_list', arguments: {} } },
];

let buffer = '';
const done = new Map();
let exitCode = null;

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === '') continue;
    try {
      const message = JSON.parse(line);
      if (message.id !== undefined) done.set(message.id, message);
    } catch {
      // skip
    }
  }
});

child.on('error', (error) => {
  console.log('SPAWN ERROR', error.message);
});

child.on('exit', (code) => {
  exitCode = code;
});

for (const request of requests) {
  child.stdin.write(`${JSON.stringify(request)}\n`);
  // wait for this request's response before the next one
  const deadline = Date.now() + 60_000;
  while (!done.has(request.id) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// Live view: the HTML page, a single JPEG and the MJPEG stream must all serve.
{
  const base = 'http://127.0.0.1:9223';
  const html = await (await fetch(`${base}/`)).text();
  const png = await fetch(`${base}/screen.png`);
  const bytes = Buffer.from(await png.arrayBuffer());
  console.log(
    `view html: ${html.includes('screen.mjpg') ? 'ok' : 'MISSING'} | screen.png: ${bytes.length} bytes, jpeg=${bytes[0] === 0xff && bytes[1] === 0xd8}`,
  );
  try {
    const mjpeg = await fetch(`${base}/screen.mjpg`);
    const reader = mjpeg.body.getReader();
    const first = await reader.read();
    const head = Buffer.from(first.value ?? []).toString('utf8').slice(0, 80).replace(/\r/g, '');
    await reader.cancel();
    console.log(`mjpeg first chunk: ${head.includes('Content-Type: image/jpeg') ? 'ok' : `unexpected: ${head}`}`);
  } catch (error) {
    console.log(`mjpeg: ${error.message}`);
  }
}

async function report() {
  for (const request of requests) {
    const message = done.get(request.id);
    if (message === undefined) {
      console.log(`id=${request.id} ${request.method} → NO RESPONSE`);
      continue;
    }
    let text = '';
    if (message.result?.content) {
      text = message.result.content.map((part) => part.text ?? '').join(' ');
    }
    if (message.error) text = `ERROR ${message.error.code} ${message.error.message}`;
    const isError = message.result?.isError === true;
    const preview = text.replace(/\s+/g, ' ').slice(0, 220);
    console.log(`id=${request.id} ${JSON.stringify(request.params?.name ?? request.method)} ${isError ? 'ISERROR' : 'ok'}: ${preview}`);
  }
}

child.stdin.end();
await Promise.race([
  new Promise((resolve) => child.on('exit', resolve)),
  new Promise((resolve) => setTimeout(resolve, 8000)),
]);
report();
if (exitCode === null) {
  child.kill();
  console.log('killed (still running)');
}
console.log('exit:', exitCode);
process.exit(0);
