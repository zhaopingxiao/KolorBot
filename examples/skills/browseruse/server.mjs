#!/usr/bin/env node
/**
 * BrowserUse MCP server: a real (headless) browser the agent can drive,
 * with a live picture served on a local URL.
 *
 * Tools:
 *   - browser_open(url)            navigate the browser to a page
 *   - browser_snapshot()           page outline + click/type indexes + saved screenshot
 *   - browser_click(index)         click an element from the last snapshot
 *   - browser_type(index, text)    fill an input/textarea from the snapshot
 *   - browser_press(key)           press a keyboard key (e.g. Enter, Escape)
 *   - browser_evaluate(expression) run JavaScript in the page
 *   - browser_webmcp_list()        list WebMCP tools registered by the page
 *   - browser_webmcp_call(name)    invoke a page-registered WebMCP tool
 *
 * Live view: http://127.0.0.1:<BROWSERUSE_VIEW_PORT|9223>/ streams the browser
 * screen as MJPEG, so a human can watch what the agent is doing.
 *
 * The server speaks newline-delimited JSON-RPC over stdio (MCP). The only
 * dependency is playwright-core; it drives the system Edge (channel 'msedge'),
 * so no browser download is needed. WebMCP calls use Chrome DevTools Protocol
 * commands `Page.listWebMCPTools` / `Page.invokeWebMCPTool` and require
 * Chrome/Edge >= 149; the launch flags enable the feature.
 */
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const SHOTS_DIR = join(SKILL_DIR, 'shots');
mkdirSync(SHOTS_DIR, { recursive: true });

const SERVER_INFO = { name: 'browseruse', version: '0.1.0' };
const HEADLESS = (process.env.BROWSERUSE_HEADLESS || 'true').trim().toLowerCase() !== 'false';
const VIEW_PORT = Number.parseInt(process.env.BROWSERUSE_VIEW_PORT || '9223', 10);

const SNAPSHOT_MAX_ITEMS = 300;
const SNAPSHOT_TEXT_CHARS = 8000;
const EVAL_RESULT_CHARS = 8000;

let browser = null;
let page = null;
let cdpSession = null;
let latestFrame = Buffer.alloc(0);
let frameVersion = 0;
let viewerCount = 0;

/* ------------------------------------------------------------------ view */

const viewServer = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (pathname === '/' || pathname === '/index.html') {
    const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>BrowserUse 实时画面</title>
<style>
  body { margin: 0; background: #111; color: #eee; font-family: system-ui, sans-serif; overflow: hidden; }
  header { display: flex; align-items: center; gap: 10px; padding: 8px 14px; font-size: 13px; color: #aaa; }
  header .grow { flex: 1; }
  header input { flex: 0 0 260px; padding: 5px 9px; border: 0; border-radius: 7px; background: #222; color: #eee; font-size: 13px; }
  #stage { position: relative; display: flex; justify-content: center; align-items: flex-start; height: calc(100vh - 40px); }
  #frame { max-width: 100%; max-height: 100%; cursor: crosshair; touch-action: none; }
  #hint { position: fixed; left: 14px; bottom: 10px; font-size: 11px; color: #888; }
</style></head>
<body>
  <header>
    <span>BrowserUse · 实时画面（鼠标点击 / 滚轮 / 键盘直接操作浏览器）</span>
    <span class="grow"></span>
    <input id="textbox" placeholder="中文/文字输入：回车发送到网页" autocomplete="off">
  </header>
  <div id="stage"><img id="frame" src="/screen.mjpg" alt="browser screen"></div>
  <div id="hint">点击 = 点击网页 · 滚轮 = 滚动 · 键盘 = 键入（先点一下画面让网页获得焦点） · ${viewAddress()}</div>
<script>
const frame = document.getElementById('frame');
const textbox = document.getElementById('textbox');
const rel = (event) => {
  const rect = frame.getBoundingClientRect();
  return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
};
const send = (payload) => fetch('/input', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
}).catch(() => {});
frame.addEventListener('click', (event) => send({ type: 'click', ...rel(event), button: event.button }));
frame.addEventListener('dblclick', (event) => send({ type: 'dblclick', ...rel(event) }));
frame.addEventListener('contextmenu', (event) => { event.preventDefault(); send({ type: 'click', ...rel(event), button: 2 }); });
frame.addEventListener('wheel', (event) => { event.preventDefault(); send({ type: 'wheel', deltaX: event.deltaX, deltaY: event.deltaY }); });
// Touch scrolling: a single-finger vertical swipe scrolls the real page.
let touchY = null;
frame.addEventListener('touchstart', (event) => {
  if (event.touches.length === 1) touchY = event.touches[0].clientY;
}, { passive: true });
frame.addEventListener('touchmove', (event) => {
  if (touchY === null || event.touches.length !== 1) return;
  event.preventDefault();
  const y = event.touches[0].clientY;
  const deltaY = touchY - y;
  if (Math.abs(deltaY) >= 14) {
    send({ type: 'wheel', deltaX: 0, deltaY });
    touchY = y;
  }
}, { passive: false });
frame.addEventListener('touchend', () => { touchY = null; }, { passive: true });
let moveTimer = 0;
frame.addEventListener('mousemove', (event) => {
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => send({ type: 'move', ...rel(event) }), 30);
});
document.addEventListener('keydown', (event) => {
  if (event.target === textbox) return;
  event.preventDefault();
  send({ type: 'key', key: event.key, ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey, meta: event.metaKey });
});
textbox.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  send({ type: 'text', text: textbox.value });
  textbox.value = '';
});
</script>
</body></html>`;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
    return;
  }
  if (pathname === '/screen.png') {
    response.writeHead(200, {
      'content-type': 'image/jpeg',
      'content-length': latestFrame.length,
      'cache-control': 'no-store',
    });
    response.end(latestFrame);
    return;
  }
  if (pathname.startsWith('/shot/')) {
    const name = decodeURIComponent(pathname.slice('/shot/'.length));
    if (!/^[A-Za-z0-9._-]+\.jpeg$/.test(name)) {
      response.writeHead(400).end('bad screenshot name');
      return;
    }
    try {
      const file = readFileSync(join(SHOTS_DIR, name));
      response.writeHead(200, {
        'content-type': 'image/jpeg',
        'content-length': file.length,
        'cache-control': 'no-store',
      });
      response.end(file);
    } catch {
      response.writeHead(404).end('not found');
    }
    return;
  }
  if (pathname === '/screen.mjpg') {
    response.writeHead(200, {
      'content-type': 'multipart/x-mixed-replace; boundary=kb-frame',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    viewerCount += 1;
    let version = -1;
    const timer = setInterval(() => {
      if (response.destroyed || response.writableEnded) return;
      if (version === frameVersion) return;
      version = frameVersion;
      try {
        response.write(`--kb-frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${latestFrame.length}\r\n\r\n`);
        response.write(latestFrame);
        response.write('\r\n');
      } catch {
        // viewer went away; the close handler cleans up
      }
    }, 100);
    response.on('close', () => {
      clearInterval(timer);
      viewerCount = Math.max(0, viewerCount - 1);
    });
    return;
  }
  if (pathname === '/input' && request.method === 'POST') {
    const body = await new Promise((resolve, reject) => {
      const parts = [];
      request.on('data', (chunk) => parts.push(Buffer.from(chunk)));
      request.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
      request.on('error', reject);
    });
    try {
      await applyInput(JSON.parse(body || '{}'));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  response.writeHead(404).end('not found');
});

/** Start the live-view HTTP server on VIEW_PORT (or the next free port). */
function startViewServer() {
  return new Promise((resolve) => {
    const tryPort = (port) => {
      const server = viewServer;
      const onError = (error) => {
        if (error.code === 'EADDRINUSE' && port - VIEW_PORT < 20) {
          tryPort(port + 1);
        } else {
          process.stderr.write(`browseruse: live view not available: ${error.message}\n`);
          resolve(null);
        }
      };
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve(port);
      });
    };
    tryPort(VIEW_PORT);
  });
}

let viewPort = null;
function viewAddress() {
  return `http://127.0.0.1:${viewPort ?? VIEW_PORT}/`;
}

/* --------------------------------------------------------------- browser */

async function ensureBrowser() {
  if (browser !== null && browser.isConnected()) return;
  const launchArgs = [
    '--enable-features=WebMCP,WebMCPTesting,DevToolsWebMCPSupport',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: HEADLESS, args: launchArgs });
  } catch (error) {
    throw new Error(
      `could not launch the system Edge: ${error instanceof Error ? error.message : error}. ` +
        'Install Edge or run `npm install playwright` to download a browser instead.',
    );
  }
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(30_000);
}

async function requirePage() {
  await ensureBrowser();
  if (page === null || page.isClosed()) {
    page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  }
  return page;
}

async function captureFrame() {
  const current = page;
  if (current === null || current.isClosed()) return;
  try {
    latestFrame = await current.screenshot({ type: 'jpeg', quality: 65 });
    frameVersion += 1;
  } catch {
    // the page may be closing; the next action recaptures
  }
}

/** Keep the live view fresh while someone is watching. */
const frameTimer = setInterval(() => {
  if (viewerCount > 0) void captureFrame();
}, 250);

/* ------------------------------------------------- manual control ---- */

/**
 * Forward mouse / keyboard events from the live-view page to the real page.
 * Coordinates are relative (0..1) inside the displayed screenshot and are
 * scaled to the browser viewport.
 */
async function applyInput(payload) {
  if (!isRecord(payload)) throw new Error('input payload must be an object');
  const current = await requirePage();
  const size = current.viewportSize() ?? { width: 1280, height: 720 };
  const x = (value) => clamp01(typeof value === 'number' ? value : 0) * size.width;
  const y = (value) => clamp01(typeof value === 'number' ? value : 0) * size.height;
  const button = (name) =>
    name === 1 ? 'middle' : name === 2 ? 'right' : 'left';

  switch (payload.type) {
    case 'move':
      await current.mouse.move(x(payload.x), y(payload.y));
      break;
    case 'click':
      await current.mouse.click(x(payload.x), y(payload.y), { button: button(payload.button) });
      break;
    case 'dblclick':
      await current.mouse.dblclick(x(payload.x), y(payload.y));
      break;
    case 'wheel':
      // Point the mouse at the middle of the viewport first: Playwright's
      // wheel targets whatever is under the cursor, and a stale position can
      // sit over a non-scrollable area.
      await current.mouse.move(size.width / 2, size.height / 2);
      await current.mouse.wheel(clamp(payload.deltaX, -600, 600), clamp(payload.deltaY, -600, 600));
      break;
    case 'key':
      await current.keyboard.press(keyCombo(payload));
      break;
    case 'text':
      await current.keyboard.insertText(String(payload.text ?? ''));
      break;
    default:
      throw new Error(`unknown input type ${JSON.stringify(payload.type)}`);
  }
  void captureFrame();
}

const KEY_ALIASES = {
  ' ': 'Space',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Enter: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
};

function keyCombo(payload) {
  const raw = typeof payload.key === 'string' ? payload.key : '';
  const parts = [];
  if (payload.ctrl === true) parts.push('Control');
  if (payload.shift === true) parts.push('Shift');
  if (payload.alt === true) parts.push('Alt');
  if (payload.meta === true) parts.push('Meta');
  if (raw.length === 1) parts.push(raw);
  else parts.push(KEY_ALIASES[raw] ?? raw);
  if (parts.length === 0) throw new Error('key is required');
  return parts.join('+');
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(min, Math.min(max, value));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

/* ------------------------------------------------------------- snapshot */

const SNAPSHOT_SCRIPT = `
(() => {
  const interesting = 'a,button,input,textarea,select,[role="button"],[role="link"],summary,[contenteditable="true"],[tabindex]';
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.01;
  };
  let index = 0;
  const items = [];
  for (const el of document.querySelectorAll(interesting)) {
    if (!visible(el)) continue;
    if (index >= ${SNAPSHOT_MAX_ITEMS}) break;
    const tag = el.tagName.toLowerCase();
    const label = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.value || el.getAttribute('placeholder') || '')
      .trim().replace(/\\s+/g, ' ').slice(0, 100);
    el.setAttribute('data-kb-idx', String(index));
    items.push({
      i: index,
      tag,
      text: label,
      href: el.href ? String(el.href).slice(0, 200) : null,
      type: el.getAttribute('type'),
      name: el.getAttribute('name'),
      checked: el.checked === undefined ? null : el.checked,
      options: tag === 'select' ? [...el.options].slice(0, 20).map((o) => o.text).join('|') : null,
    });
    index += 1;
  }
  return JSON.stringify({
    title: document.title,
    url: location.href.slice(0, 300),
    text: (document.body.innerText || '').slice(0, ${SNAPSHOT_TEXT_CHARS}),
    items,
  });
})()`;

async function snapshotPage({ instructions = true } = {}) {
  const current = await requirePage();
  const payload = await current.evaluate(SNAPSHOT_SCRIPT);
  await captureFrame();
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return payload;
  }
  const lines = [`# ${parsed.title || '(no title)'}`, `URL: ${parsed.url}`, ''];
  if (parsed.items.length === 0) lines.push('(no interactive elements found)');
  for (const item of parsed.items) {
    const extra = [];
    if (item.tag === 'a') extra.push(`href=${item.href ?? ''}`);
    if (item.type) extra.push(`type=${item.type}`);
    if (item.name) extra.push(`name=${item.name}`);
    if (item.checked !== null) extra.push(`checked=${item.checked}`);
    if (item.options) extra.push(`options=${item.options}`);
    lines.push(
      `[${item.i}] <${item.tag}>${extra.length > 0 ? ` (${extra.join(', ')})` : ''} ${item.text}`,
    );
  }
  if (parsed.text.trim() !== '') {
    lines.push('', '## Page text', parsed.text);
  }

  const shot = saveFrame();
  if (instructions) {
    lines.push(
      '',
      'Use browser_click(i) / browser_type(i, text) with these indexes. Re-snapshot after the page changes.',
    );
  }
  lines.push(
    '',
    '## Screenshot',
    `![page screenshot](${shot.url})`,
    `Screenshot file: ${shot.file}`,
    'You may paste the markdown image line above into your reply to show the page (e.g. when the user asks for a screenshot); it is optional for every action.',
    'Only look at the image itself (or ask for another snapshot) when the text snapshot is not enough to understand the page.',
  );
  return clip(lines.join('\n'), 24_000);
}

/**
 * Every action automatically ends with a fresh snapshot (page text + a new
 * screenshot), so the model never has to call browser_snapshot just to see
 * what its last action did.
 */
async function appendAutoSnapshot(text) {
  const snapshot = await snapshotPage({ instructions: false });
  return `${text}\n\n---\n## Auto snapshot after this action\n${snapshot}`;
}

/* ------------------------------------------------------------------ tools */

const TOOLS = [
  {
    name: 'browser_open',
    description:
      'Open a URL in the real browser (http/https, or a data: URL). Returns the page title, URL and the live view URL — ' +
      'mention the live view URL to the user once after opening a page, and repeat it only when the user asks for it. ' +
      'The result ends with an automatic snapshot (page text + an optional markdown screenshot line); show the image when useful.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'http(s) URL to open.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_snapshot',
    description:
      'Readable snapshot of the current page: title, URL, visible text, every interactive element with an index, ' +
      'plus a freshly captured screenshot saved in the skill directory. The result contains an optional markdown image line ' +
      '(![page screenshot](http://...)) and the screenshot file path; paste it into your reply only when the user asks ' +
      'for a screenshot or it helps. Indexes change when the page changes, ' +
      'so re-snapshot before clicking again. Only look at the image itself when the text snapshot is not enough.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'browser_click',
    description:
      'Click the element with the given index from the last browser_snapshot. The result ends with an automatic ' +
      'snapshot (page text and a fresh screenshot, shown only if useful).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        index: { type: 'integer', minimum: 0, description: 'Element index from browser_snapshot.' },
      },
      required: ['index'],
    },
  },
  {
    name: 'browser_type',
    description:
      'Type text into the input/textarea with the given index from the last browser_snapshot. ' +
      'Replaces the existing value and fires a real input event, so React-style forms work. The result ends with ' +
      'an automatic snapshot (screenshot optional).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        index: { type: 'integer', minimum: 0, description: 'Input index from browser_snapshot.' },
        text: { type: 'string', description: 'Text to type.' },
      },
      required: ['index', 'text'],
    },
  },
  {
    name: 'browser_press',
    description:
      'Press a keyboard key on the page, e.g. "Enter", "Escape", "Tab", "ArrowDown". The result ends with an ' +
      'automatic snapshot (screenshot optional).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        key: { type: 'string', description: 'Key name as accepted by Playwright (Enter, Escape, ...).' },
      },
      required: ['key'],
    },
  },
  {
    name: 'browser_evaluate',
    description:
      'Run a JavaScript expression in the page and return its JSON result. Use it to read data the snapshot misses; ' +
      'keep side effects minimal. The result ends with an automatic snapshot (screenshot optional).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        expression: { type: 'string', description: 'JavaScript expression, e.g. document.title' },
      },
      required: ['expression'],
    },
  },
  {
    name: 'browser_webmcp_list',
    description:
      'List WebMCP tools registered by the current page (Chrome/Edge >= 149). Returns their names, ' +
      'descriptions and input schemas so they can be invoked with browser_webmcp_call.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'browser_webmcp_call',
    description:
      'Invoke a WebMCP tool registered by the current page (see browser_webmcp_list). ' +
      'Returns the invocation status and output.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'WebMCP tool name from browser_webmcp_list.' },
        input: {
          type: 'object',
          description: 'JSON-serializable input matching the tool inputSchema.',
        },
      },
      required: ['name'],
    },
  },
];

async function handleToolCall(id, params) {
  const name = isRecord(params) && typeof params.name === 'string' ? params.name : '';
  const args = isRecord(params) && isRecord(params.arguments) ? params.arguments : {};
  try {
    let text;
    switch (name) {
      case 'browser_open':
        text = await openUrl(args);
        break;
      case 'browser_snapshot':
        text = await snapshotPage();
        break;
      case 'browser_click':
        text = await clickIndex(args);
        break;
      case 'browser_type':
        text = await typeIndex(args);
        break;
      case 'browser_press':
        text = await pressKey(args);
        break;
      case 'browser_evaluate':
        text = await evaluateJs(args);
        break;
      case 'browser_webmcp_list':
        text = await listWebMcpTools();
        break;
      case 'browser_webmcp_call':
        text = await callWebMcpTool(args);
        break;
      default:
        throw new Error(`Unknown tool "${name}"`);
    }
    sendResult(id, { content: [{ type: 'text', text }] });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    sendResult(id, { content: [{ type: 'text', text: `Error: ${text}` }], isError: true });
  }
}

async function openUrl(args) {
  const url = requireHttpUrl(args, 'url');
  const current = await requirePage();
  await current.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await sleep(300);
  await captureFrame();
  const text =
    `Opened ${url}\nTitle: ${await current.title()}\nURL: ${current.url()}\n` +
    `Live view: ${viewAddress()}\n` +
    'Show the live view URL to the user once now; do not repeat it in later replies unless they ask.';
  return appendAutoSnapshot(text);
}

async function clickIndex(args) {
  const index = requireInt(args, 'index');
  const current = await requirePage();
  const result = await current.evaluate(
    (i) => {
      const el = document.querySelector(`[data-kb-idx="${i}"]`);
      if (!el) return { ok: false, error: `index ${i} not found; the page changed, run browser_snapshot again` };
      el.scrollIntoView({ block: 'center' });
      const label = (el.innerText || el.getAttribute('aria-label') || el.value || '').trim().slice(0, 80);
      el.click();
      return { ok: true, label };
    },
    index,
  );
  await sleep(500);
  await captureFrame();
  if (!result.ok) throw new Error(result.error);
  return appendAutoSnapshot(`Clicked [${index}] "${result.label}".\nURL: ${current.url()}`);
}

async function typeIndex(args) {
  const index = requireInt(args, 'index');
  const text = requireString(args, 'text');
  const current = await requirePage();
  const result = await current.evaluate(
    ({ i, value }) => {
      const el = document.querySelector(`[data-kb-idx="${i}"]`);
      if (!el) return { ok: false, error: `index ${i} not found; the page changed, run browser_snapshot again` };
      const tag = el.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        return { ok: false, error: `index ${i} is <${tag.toLowerCase()}>, not an input` };
      }
      el.scrollIntoView({ block: 'center' });
      el.focus();
      if (tag === 'SELECT') {
        el.value = value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        const proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, value);
        else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { ok: true };
    },
    { i: index, value: text },
  );
  await captureFrame();
  if (!result.ok) throw new Error(result.error);
  return appendAutoSnapshot(`Typed into [${index}]: ${text}`);
}

async function pressKey(args) {
  const key = requireString(args, 'key');
  const current = await requirePage();
  await current.keyboard.press(key);
  await sleep(200);
  await captureFrame();
  return appendAutoSnapshot(`Pressed ${key}`);
}

async function evaluateJs(args) {
  const expression = requireString(args, 'expression');
  const current = await requirePage();
  const result = await current.evaluate(expression);
  const rendered =
    typeof result === 'string'
      ? result
      : JSON.stringify(result) === undefined
        ? String(result)
        : JSON.stringify(result);
  return appendAutoSnapshot(`Result:\n${clip(rendered, EVAL_RESULT_CHARS)}`);
}

/** Save the latest frame under the skill directory and return its file + URL. */
function saveFrame(prefix = 'snapshot') {
  const name = `${prefix}-${Date.now()}.jpeg`;
  const file = join(SHOTS_DIR, name);
  writeFileSync(file, latestFrame);
  return { file, url: `${viewAddress()}shot/${name}` };
}

/* ------------------------------------------------------------------ WebMCP */

async function webMcpSession() {
  const current = await requirePage();
  if (cdpSession === null || cdpSession.detached) {
    cdpSession = await current.context().newCDPSession(current);
  }
  return cdpSession;
}

async function listWebMcpTools() {
  await requirePage();
  let payload;
  try {
    const session = await webMcpSession();
    payload = await session.send('Page.listWebMCPTools', {});
  } catch (error) {
    throw new Error(
      `WebMCP is not available in this browser: ${error instanceof Error ? error.message : error}. ` +
        'It needs Chrome/Edge >= 149 launched with the WebMCP flags.',
    );
  }
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  if (tools.length === 0) return 'This page registers no WebMCP tools.';
  return tools
    .map(
      (tool) =>
        `- ${tool.name}${tool.description ? `: ${tool.description}` : ''}${tool.inputSchema ? `\n  schema: ${JSON.stringify(tool.inputSchema).slice(0, 500)}` : ''}`,
    )
    .join('\n');
}

async function callWebMcpTool(args) {
  const name = requireString(args, 'name');
  const input = isRecord(args.input) ? args.input : {};
  await requirePage();
  let result;
  try {
    const session = await webMcpSession();
    result = await session.send('Page.invokeWebMCPTool', { name, input });
  } catch (error) {
    throw new Error(
      `WebMCP call failed: ${error instanceof Error ? error.message : error}. ` +
        'It needs Chrome/Edge >= 149 with the WebMCP flags.',
    );
  }
  await captureFrame();
  const status = typeof result?.status === 'string' ? result.status : 'Unknown';
  const output = result?.output !== undefined ? result.output : result?.errorText ?? result?.exception ?? '';
  return [`WebMCP ${name}: ${status}`, ...(output === '' ? [] : [String(output)])].join('\n');
}

/* ------------------------------------------------------------------- MCP */

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const text = line.trim();
  if (text === '') return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    process.stderr.write('browseruse: invalid JSON-RPC line\n');
    return;
  }
  void handleMessage(message);
});
rl.on('close', () => {
  // stdin ended (host exited): stop cleanly and let the event loop drain.
  void closeResources();
});

async function handleMessage(message) {
  if (!isRecord(message) || typeof message.method !== 'string') return;
  const { id, method, params } = message;
  if (id === undefined) return; // notifications need no response
  try {
    if (method === 'initialize') {
      sendResult(id, {
        protocolVersion:
          isRecord(params) && typeof params.protocolVersion === 'string'
            ? params.protocolVersion
            : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    }
    if (method === 'ping') {
      sendResult(id, {});
      return;
    }
    if (method === 'tools/list') {
      sendResult(id, { tools: TOOLS });
      return;
    }
    if (method === 'tools/call') {
      await handleToolCall(id, params);
      return;
    }
    sendError(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    sendError(id, -32603, error instanceof Error ? error.message : String(error));
  }
}

async function closeResources() {
  clearInterval(frameTimer);
  try {
    if (browser !== null) await browser.close();
  } catch {
    // already closed
  }
  try {
    await new Promise((resolve) => viewServer.close(() => resolve()));
  } catch {
    // already closed
  }
}

function shutdown() {
  void closeResources().then(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/* --------------------------------------------------------------- helpers */

function requireString(args, key) {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function requireInt(args, key) {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  return value;
}

function requireHttpUrl(args, key) {
  const raw = requireString(args, key).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${key} must be a valid http(s) or data URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'data:') {
    throw new Error(`${key} must use http, https or data:`);
  }
  return raw;
}

function clip(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} characters]`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendResult(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function sendError(id, code, message) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`,
  );
}

/* ------------------------------------------------------------------- boot */

const booted = await startViewServer();
if (booted !== null) {
  viewPort = booted;
  process.stderr.write(`browseruse: live view at http://127.0.0.1:${booted}/\n`);
} else {
  process.stderr.write('browseruse: no live view (port unavailable)\n');
}
