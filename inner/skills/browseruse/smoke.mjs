import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = process.env.BROWSERUSE_VIEW_PORT || '9223';

// A leftover server on the view port would serve the checks and make this
// script lie (the new server silently falls back to the next port).
try {
  await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(1200) });
  console.log(
    `port ${PORT} is already serving a live view (leftover server or a running KolorBot session); ` +
      'stop it first, then rerun the smoke test.',
  );
  process.exit(1);
} catch {
  // free port, continue
}

// Resolve the server next to this script so the smoke test runs from anywhere.
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const server = join(SERVER_DIR, 'server.mjs');
const child = spawn(process.execPath, [server], {
  cwd: SERVER_DIR,
  stdio: ['pipe', 'pipe', 'inherit'],
});

process.on('unhandledRejection', (reason) => {
  console.log('UNHANDLED REJECTION:', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (error) => {
  console.log('UNCAUGHT EXCEPTION:', error?.stack ?? error);
});

const requests = [
  { id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
  { id: 2, method: 'tools/list', params: {} },
  {
    id: 3,
    method: 'tools/call',
    params: {
      name: 'browser_open',
      arguments: {
        url: 'data:text/html,%3Cbody onclick=%22window.clicked=(window.clicked%7C%7C0)%2B1%22%3E%3Ch1%3EHi%20BrowserUse%3C/h1%3E%3Cbutton%3EGo%3C/button%3E%3Cinput id=%22name%22%3E%3C/body%3E',
      },
    },
  },
  { id: 4, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } },
  { id: 5, method: 'tools/call', params: { name: 'browser_click', arguments: { index: 0 } } },
  { id: 6, method: 'tools/call', params: { name: 'browser_type', arguments: { index: 1, text: 'hello' } } },
  { id: 7, method: 'tools/call', params: { name: 'browser_evaluate', arguments: { expression: 'document.title + "|" + document.querySelector("#name").value' } } },
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
    `view html: ${html.includes('screen.mjpg') ? 'ok' : 'MISSING'} | manual: ${html.includes('/input') ? 'ok' : 'MISSING'} | screen.png: ${bytes.length} bytes, jpeg=${bytes[0] === 0xff && bytes[1] === 0xd8}`,
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

  // Snapshot is text + screenshot: the markdown image and /shot/ URL must work.
  const snapshotText = done.get(4)?.result?.content?.[0]?.text ?? '';
  const image = /!\[[^\]]*\]\((http[^)]+\/shot\/[^)]+)\)/.exec(snapshotText);
  const shotFile = /Screenshot file: (.+)/.exec(snapshotText)?.[1] ?? '';
  console.log(
    `snapshot image: ${image ? 'ok' : 'MISSING'} | snapshot live URL: ${snapshotText.includes('Live view:') ? 'LEAK' : 'ok'} | file: ${shotFile}`,
  );
  if (image) {
    const shot = await fetch(image[1]);
    const bytes = Buffer.from(await shot.arrayBuffer());
    console.log(`shot url: ${shot.status}, ${bytes.length} bytes, jpeg=${bytes[0] === 0xff && bytes[1] === 0xd8}`);
  }

  // Every action must end with an automatic snapshot (text + screenshot),
  // and only browser_open may expose the live view URL.
  const openText = done.get(3)?.result?.content?.[0]?.text ?? '';
  console.log(
    `open live view: ${openText.includes('Live view:') ? 'ok' : 'MISSING'} | open auto snapshot: ${openText.includes('Auto snapshot after this action') ? 'ok' : 'MISSING'}`,
  );
  for (const [label, id] of [['click', 5], ['type', 6], ['evaluate', 7]]) {
    const text = done.get(id)?.result?.content?.[0]?.text ?? '';
    console.log(
      `auto snapshot ${label}: ${text.includes('## Auto snapshot after this action') ? 'ok' : 'MISSING'} | image: ${text.includes('![page screenshot]') ? 'ok' : 'MISSING'} | live URL: ${text.includes('Live view:') ? 'LEAK' : 'ok'}`,
    );
  }

  // Manual control: forward text and a click through /input, then read back.
  const input = (payload) =>
    fetch(`${base}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then((response) => response.json());
  console.log('input text:', JSON.stringify(await input({ type: 'text', text: '你好' })));
  console.log('input click:', JSON.stringify(await input({ type: 'click', x: 0.05, y: 0.05 })));

  const waitFor = async (requestId) => {
    const deadline = Date.now() + 60_000;
    while (!done.has(requestId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const call = async (requestId, name, args) => {
    child.stdin.write(
      `${JSON.stringify({ id: requestId, method: 'tools/call', params: { name, arguments: args } })}\n`,
    );
    await waitFor(requestId);
    requests.push({ id: requestId, method: 'tools/call', params: { name } });
  };

  await call(10, 'browser_evaluate', {
    expression: 'JSON.stringify({ name: document.querySelector("#name").value, clicked: window.clicked ?? 0 })',
  });

  // Wheel forwarding: open a tall page, scroll it through /input, read scrollY.
  await call(11, 'browser_open', {
    url: 'data:text/html,%3Cbody style=%22height:4000px%22%3E%3Ch1%3Etop%3C/h1%3E%3C/body%3E',
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  console.log('input wheel:', JSON.stringify(await input({ type: 'wheel', deltaY: 600 })));
  await new Promise((resolve) => setTimeout(resolve, 600));
  await call(12, 'browser_evaluate', { expression: 'String(window.scrollY)' });
  const scrollY = done.get(12)?.result?.content?.[0]?.text ?? '';
  console.log(`wheel scrolled page: ${/Result:\s*[1-9]\d*/.test(scrollY) ? 'ok' : `MISSING (${scrollY.replace(/\s+/g, ' ').slice(0, 80)})`}`);

  // Drag forwarding: mousedown -> moves -> mouseup must reach the page, and a
  // plain down+up at the same point must still count as a click.
  const dragPage =
    'data:text/html,' +
    encodeURIComponent(
      '<body style="margin:0;height:100vh;background:#eef"><script>' +
        'window.events={down:0,move:0,up:0,click:0};' +
        'document.addEventListener("mousedown",()=>events.down++);' +
        'document.addEventListener("mousemove",()=>events.move++);' +
        'document.addEventListener("mouseup",()=>events.up++);' +
        'document.addEventListener("click",()=>events.click++);' +
        '</script></body>',
    );
  await call(13, 'browser_open', { url: dragPage });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await input({ type: 'down', x: 0.3, y: 0.3 });
  await input({ type: 'move', x: 0.45, y: 0.45 });
  await input({ type: 'move', x: 0.6, y: 0.6 });
  await input({ type: 'up', x: 0.6, y: 0.6 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await call(14, 'browser_evaluate', { expression: 'JSON.stringify(window.events)' });
  const afterDrag = done.get(14)?.result?.content?.[0]?.text ?? '';
  const dragEvents = /Result:\s*(\{.*\})/s.exec(afterDrag)?.[1] ?? '';
  console.log(`drag events: ${dragEvents || `MISSING (${afterDrag.slice(0, 80)})`}`);

  await input({ type: 'down', x: 0.2, y: 0.2 });
  await input({ type: 'up', x: 0.2, y: 0.2 });
  await new Promise((resolve) => setTimeout(resolve, 250));
  await call(15, 'browser_evaluate', { expression: 'JSON.stringify(window.events)' });
  const afterClick = done.get(15)?.result?.content?.[0]?.text ?? '';
  const clickEvents = /Result:\s*(\{.*\})/s.exec(afterClick)?.[1] ?? '';
  console.log(`down+up click: ${clickEvents || `MISSING (${afterClick.slice(0, 80)})`}`);
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
