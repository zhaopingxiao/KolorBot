/* KolorBot web client: vanilla ES module, no build step. */

const $ = (selector) => document.querySelector(selector);

const state = {
  sessions: [],
  session: null,
  filter: '',
  running: false,
  runningIds: new Set(),
  /** The stream this page is currently mirroring, if any. */
  live: null,
  providerData: null,
  memory: null,
};

/* ---------------- helpers ---------------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function inlineMarkdown(text) {
  let html = escapeHtml(text);
  // Inline code first so its content is left alone, then links and emphasis.
  html = html.replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>');
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>',
  );
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return html;
}

const MD_FENCE = (line) => /^\s*(```|~~~)/.test(line);
const MD_HEADING = (line) => /^(#{1,6})\s+(.+)$/.exec(line);
const MD_HR = (line) => /^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line);
const MD_QUOTE = (line) => /^>\s?/.test(line);
const MD_LIST_ITEM = (line) => /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
const MD_TABLE_ROW = (line) => /^\s*\|.*\|\s*$/.test(line);
const MD_TABLE_SEP = (line) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');

function renderMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let index = 0;

  const isBlank = (line) => line.trim() === '';
  const blockStart = (at) => {
    if (at >= lines.length) return true;
    const line = lines[at];
    if (isBlank(line) || MD_FENCE(line) || MD_HEADING(line) !== null || MD_HR(line)) return true;
    if (MD_QUOTE(line) || MD_LIST_ITEM(line) !== null) return true;
    return MD_TABLE_ROW(line) && at + 1 < lines.length && MD_TABLE_SEP(lines[at + 1]);
  };

  while (index < lines.length) {
    const line = lines[index];
    if (isBlank(line)) {
      index += 1;
      continue;
    }

    // Fenced code block with an optional language label.
    if (MD_FENCE(line)) {
      const lang = (/^```(\S*)/.exec(line.trim())?.[1] ?? '').trim();
      const buffer = [];
      index += 1;
      while (index < lines.length && !MD_FENCE(lines[index])) {
        buffer.push(lines[index]);
        index += 1;
      }
      index += 1; // closing fence
      const code = escapeHtml(buffer.join('\n'));
      if (lang === '') out.push(`<pre class="code">${code}</pre>`);
      else {
        out.push(
          `<div class="code-block"><div class="code-lang">${escapeHtml(lang)}</div><pre class="code">${code}</pre></div>`,
        );
      }
      continue;
    }

    const heading = MD_HEADING(line);
    if (heading !== null) {
      const level = heading[1].length;
      out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (MD_HR(line)) {
      out.push('<hr>');
      index += 1;
      continue;
    }

    if (MD_QUOTE(line)) {
      const buffer = [];
      while (index < lines.length && MD_QUOTE(lines[index])) {
        buffer.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      out.push(`<blockquote>${renderMarkdown(buffer.join('\n'))}</blockquote>`);
      continue;
    }

    const listMatch = MD_LIST_ITEM(line);
    if (listMatch !== null) {
      const items = [];
      while (index < lines.length) {
        const match = MD_LIST_ITEM(lines[index]);
        if (match === null) break;
        items.push({
          indent: match[1].replaceAll('\t', '  ').length,
          ordered: /^\d/.test(match[2]),
          text: match[3],
        });
        index += 1;
      }
      out.push(renderListItems(items));
      continue;
    }

    if (MD_TABLE_ROW(line) && index + 1 < lines.length && MD_TABLE_SEP(lines[index + 1])) {
      const headerCells = splitTableRow(line);
      index += 2;
      const rows = [];
      while (index < lines.length && MD_TABLE_ROW(lines[index])) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      const cells = (row, tag) =>
        row.map((cell) => `<${tag}>${inlineMarkdown(cell.trim())}</${tag}>`).join('');
      out.push(
        `<div class="md-table"><table><thead><tr>${cells(headerCells, 'th')}</tr></thead><tbody>${rows
          .map((row) => `<tr>${cells(row, 'td')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
      continue;
    }

    // Paragraph: lines until a blank line or the next block element.
    const buffer = [line];
    index += 1;
    while (index < lines.length && !blockStart(index)) {
      buffer.push(lines[index]);
      index += 1;
    }
    out.push(`<p>${buffer.map(inlineMarkdown).join('<br>')}</p>`);
  }
  return out.join('');
}

function splitTableRow(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  return row.split('|');
}

function renderListItems(items) {
  let cursor = 0;
  function renderLevel(indent) {
    const groups = [];
    let groupType = null;
    let groupItems = [];
    const flush = () => {
      if (groupItems.length === 0) return;
      const tag = groupType === 'ordered' ? 'ol' : 'ul';
      groups.push(`<${tag}>${groupItems.join('')}</${tag}>`);
      groupItems = [];
    };
    while (cursor < items.length) {
      const item = items[cursor];
      if (item.indent < indent || item.indent > indent) break;
      const type = item.ordered ? 'ordered' : 'unordered';
      if (groupType !== type) {
        flush();
        groupType = type;
      }
      cursor += 1;
      const task = /^\[([ xX])\]\s+(.*)$/.exec(item.text);
      let inner = '';
      if (task !== null) {
        inner = `<input type="checkbox" disabled ${task[1] !== ' ' ? 'checked' : ''}> ${inlineMarkdown(task[2])}`;
      } else {
        inner = inlineMarkdown(item.text);
      }
      if (cursor < items.length && items[cursor].indent > indent) {
        inner += renderLevel(items[cursor].indent);
      }
      groupItems.push(`<li>${inner}</li>`);
    }
    flush();
    return groups.join('');
  }
  return renderLevel(items[0]?.indent ?? 0);
}

function stripEnvelopes(content) {
  let text = content;
  let previous;
  do {
    previous = text;
    text = text.replace(/^<system-skills>\r?\n[\s\S]*?\r?\n<\/system-skills>\r?\n*/, '');
    text = text.replace(/^<system-topic>\r?\n[\s\S]*?\r?\n<\/system-topic>\r?\n*/, '');
    text = text.replace(
      /^<system-daily-memory>\r?\n[\s\S]*?\r?\n<\/system-daily-memory>\r?\n*/,
      '',
    );
    text = text.replace(
      /^<system-daily-memory-task>\r?\n[\s\S]*?\r?\n<\/system-daily-memory-task>\r?\n*/,
      '',
    );
  } while (text !== previous);
  return text;
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return '';
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const date = new Date(iso);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function toast(message, type = 'success') {
  const host = document.querySelector('dialog[open]') ?? document.body;
  const container = $('#toasts');
  if (container.parentElement !== host) host.appendChild(container);

  const node = el('div', `toast ${type}`, message);
  container.appendChild(node);
  requestAnimationFrame(() => node.classList.add('show'));

  const delay = type === 'error' ? 4200 : 2400;
  setTimeout(() => {
    node.classList.remove('show');
    setTimeout(() => node.remove(), 200);
  }, delay);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let data = null;
  if (text !== '') {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    throw new Error(data?.error ?? `请求失败（${response.status}）`);
  }
  return data;
}

/* ---------------- sessions ---------------- */

async function loadSessions() {
  const data = await api('/api/sessions');
  state.sessions = data?.sessions ?? [];
  // Turns keep running after their client detaches, so the list (not the
  // current page) says which sessions are busy.
  state.runningIds = new Set(
    state.sessions.filter((session) => session.running === true).map((session) => session.id),
  );
  renderSessions();
  if (state.session !== null) syncBusy();
}

function renderSessions() {
  const list = $('#session-list');
  list.innerHTML = '';
  const query = state.filter.trim().toLowerCase();
  const items = state.sessions.filter(
    (session) => query === '' || session.name.toLowerCase().includes(query),
  );

  for (const session of items) {
    const button = el('button', 'session');
    button.title = session.name;
    if (state.runningIds.has(session.id)) {
      button.appendChild(el('span', 'running-dot'));
      button.title = session.name + '（正在运行）';
    }
    button.appendChild(el('span', 'session-name', session.name));
    if (state.session?.id === session.id) button.classList.add('active');
    button.addEventListener('click', () => {
      closeDrawers();
      void selectSession(session.id);
    });
    list.appendChild(button);
  }
}

async function selectSession(id) {
  // Leaving a running session only stops mirroring it; the turn continues and
  // is replayed in full when you come back.
  if (state.live !== null && state.live.sessionId !== id) detachRun();
  const data = await api(`/api/sessions/${id}`);
  state.session = data.session;
  renderHeader();
  renderMessages(true);
  renderSessions();
  if (data.running === true) await attachLive(id);
  else toggleRunning(false, id);
}

function newChat() {
  if (state.live !== null) detachRun();
  closeDrawers();
  state.session = null;
  renderHeader();
  renderMessages(true);
  renderSessions();
  const input = $('#input');
  input.value = '';
  input.style.height = 'auto';
  input.focus();
}

function renderHeader() {
  const session = state.session;
  $('#session-title').textContent = session?.name ?? '新对话';

  let count = session?.messageCount ?? 0;
  if (session && state.running) {
    count = Math.max(
      count,
      document.querySelectorAll('#messages .user-message, #messages .assistant-message').length,
    );
  }
  $('#session-meta').textContent = session ? `${count} 条消息 · ${timeAgo(session.updatedAt)}` : '';

  const disabled = !session || state.running;
  for (const id of ['edit-topic', 'schedule-chat', 'reset-chat', 'delete-chat']) {
    $(`#${id}`).disabled = disabled;
  }
}

/* ---------------- messages ---------------- */

function renderMessages(forceBottom = false, note = null) {
  const container = $('#messages');
  const stick = forceBottom || atBottom();
  const previousTop = container.scrollTop;
  const previousHeight = container.scrollHeight;
  container.innerHTML = '';
  const context = state.session?.context ?? [];

  const toolResults = new Map();
  for (const message of context) {
    if (message.role === 'tool') toolResults.set(message.toolCallId, message);
  }

  let turn = null;
  for (const message of context) {
    if (message.role === 'user') {
      turn = el('div', 'turn');
      const text = stripEnvelopes(message.content ?? '');
      if (text !== '') turn.appendChild(el('div', 'user-message', text));
      container.appendChild(turn);
      continue;
    }
    if (message.role !== 'assistant') continue;

    const text = message.content ?? '';
    const calls = message.toolCalls ?? [];
    if (text.trim() === '' && calls.length === 0) continue;
    if (turn === null) {
      turn = el('div', 'turn');
      container.appendChild(turn);
    }
    if (text.trim() !== '') {
      const body = el('div', 'assistant-message');
      body.innerHTML = renderMarkdown(text);
      turn.appendChild(body);
    }
    for (const call of calls) {
      appendToolCard(turn, call, toolResults.get(call.id));
    }
  }

  if (note !== null) {
    const turns = container.querySelectorAll('.turn');
    const last = turns[turns.length - 1];
    if (last !== undefined) last.appendChild(el('div', 'run-note', note));
  }

  if (stick) {
    scrollMessagesToBottom();
  } else {
    // The list was rebuilt in place: keep the reader where they were instead
    // of yanking them to the bottom when they were reading further up.
    container.scrollTop = previousTop + (container.scrollHeight - previousHeight);
  }
}

function appendAssistant(turn) {
  const body = el('div', 'assistant-message');
  turn.appendChild(body);
  return body;
}

/* ---------------- thinking indicator ---------------- */

function appendThinking(turn) {
  const node = el('div', 'thinking');
  node.setAttribute('aria-label', '思考中');
  for (let i = 0; i < 3; i += 1) node.appendChild(el('span', 'thinking-dot'));
  turn.appendChild(node);
  return node;
}

function showThinking(stream) {
  if (stream.thinking !== null && stream.thinking.isConnected) return;
  const stick = atBottom();
  stream.thinking = appendThinking(stream.turn);
  if (stick) {
    const container = $('#messages');
    container.scrollTop = container.scrollHeight;
  }
}

function hideThinking(stream) {
  if (stream?.thinking == null) return;
  stream.thinking.remove();
  stream.thinking = null;
}

/* ---------------- tools ---------------- */

function truncateForDisplay(value, limit = 12000) {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [truncated ${text.length - limit} chars]`;
}

function formatToolArguments(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return '{}';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function appendToolCard(turn, call, result) {
  const details = el('details', 'tool-call');
  details.open = true;

  const summary = el('summary', 'tool-head');
  summary.appendChild(el('span', 'tool-caret', '›'));
  summary.appendChild(el('span', 'tool-name', call.name));
  const status = el('span', 'tool-status running', '运行中');
  summary.appendChild(status);
  const duration = el('span', 'tool-duration', '');
  summary.appendChild(duration);
  details.appendChild(summary);

  const body = el('div', 'tool-body');
  body.appendChild(el('div', 'tool-section-label', '参数'));
  const args = el('pre', 'tool-pre');
  args.textContent = truncateForDisplay(formatToolArguments(call.arguments));
  body.appendChild(args);
  body.appendChild(el('div', 'tool-section-label', '结果'));
  const resultNode = el('pre', 'tool-pre result', '等待结果…');
  body.appendChild(resultNode);
  details.appendChild(body);

  const card = { element: details, status, duration, result: resultNode };
  if (result !== undefined) {
    applyToolResult(card, {
      content: result.content,
      isError: result.isError,
    });
  }
  turn.appendChild(details);
  return card;
}

function applyToolResult(card, event) {
  const isError = event.isError === true;
  card.status.className = `tool-status ${isError ? 'error' : 'ok'}`;
  card.status.textContent = isError ? '失败' : '完成';
  card.element.classList.toggle('error', isError);
  card.result.textContent = truncateForDisplay(event.content ?? '');
  if (event.durationMs !== undefined) {
    card.duration.textContent = formatDuration(event.durationMs);
  }
}

function applyToolSkipped(card, reason) {
  card.status.className = 'tool-status skipped';
  card.status.textContent = '跳过';
  card.result.textContent = `跳过：${reason}`;
}

/* ---------------- chat ---------------- */

/**
 * One live view per session, keyed by session id.
 *
 * The server owns the turn; this object only mirrors it into the DOM. It can be
 * thrown away and rebuilt from the replay buffer at any time, which is what
 * makes switching sessions and reloading safe mid-turn.
 */
const streams = new Map();

function syncBusy() {
  state.running = state.session !== null && state.runningIds.has(state.session.id);
  $('#send').classList.toggle('hidden', state.running);
  $('#stop').classList.toggle('hidden', !state.running);
  if (state.running) $('#model-select').disabled = true;
  else renderModelSelect();
  renderHeader();
}

function toggleRunning(running, sessionId) {
  if (sessionId !== undefined) {
    if (running) state.runningIds.add(sessionId);
    else state.runningIds.delete(sessionId);
  }
  syncBusy();
  renderSessions();
}

function readSseEvent(chunk) {
  const dataLines = [];
  for (const line of chunk.split('\n')) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join('\n'));
  } catch {
    return null;
  }
}

async function consumeStream(response, onEvent, onError) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let index;
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (chunk.startsWith(':')) continue; // heartbeat
      const event = readSseEvent(chunk);
      if (event === null) continue;
      onEvent(event);
      if (event.type === 'agent/error' || event.type === 'web/error') {
        onError(event.message ?? '运行失败');
      }
    }
  }
}

/* ---- streaming render: one paint per frame, not one per token ---- */

/** Height of one text line in the message list (the "follow" threshold). */
function lineHeight() {
  const sample = document.querySelector('#messages .assistant-message, #messages .user-message');
  if (sample !== null) {
    const value = parseFloat(getComputedStyle(sample).lineHeight);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 22;
}

/**
 * True only when the reader is within one text line of the bottom.
 *
 * Auto-scroll follows new output only in that case; scrolled further up, the
 * view is left alone so reading history is not yanked away.
 */
function atBottom() {
  const container = $('#messages');
  return container.scrollHeight - container.scrollTop - container.clientHeight <= lineHeight();
}

function scrollMessagesToBottom() {
  const container = $('#messages');
  container.scrollTop = container.scrollHeight;
}

function flushStream(stream) {
  if (stream.frame !== 0) {
    cancelAnimationFrame(stream.frame);
    stream.frame = 0;
  }
  if (stream.pending === '') return;
  stream.text += stream.pending;
  stream.lastFragment = stream.pending;
  stream.pending = '';
  const stick = atBottom();
  if (stream.currentText === null) stream.currentText = appendAssistant(stream.turn);
  renderStreamBody(stream);
  if (stick) scrollMessagesToBottom();
}

/**
 * Live markdown: everything except the newest fragment is rendered immediately;
 * the newest fragment stays raw so its fade-in animation keeps running. On the
 * next frame it becomes part of the rendered prefix.
 */
function renderStreamBody(stream) {
  const body = stream.currentText;
  if (body === null) return;
  const fragment = stream.lastFragment;
  const prefix = stream.text.slice(0, Math.max(0, stream.text.length - fragment.length));
  body.innerHTML = prefix === '' ? '' : renderMarkdown(prefix);
  body.appendChild(el('span', 'stream-chunk', fragment));
}

function queueText(stream, text) {
  stream.pending += text;
  if (stream.frame === 0) stream.frame = requestAnimationFrame(() => flushStream(stream));
}

/**
 * Drop the assistant body when it never received any text.
 *
 * A tool-only step leaves an empty placeholder; removing it keeps the card
 * from being separated by a blank bubble.
 */
function dropEmptyAssistant(stream) {
  const body = stream.currentText;
  if (body !== null && body.textContent === '') {
    body.remove();
    stream.currentText = null;
  }
}

function ensureStream(sessionId, run) {
  const existing = streams.get(sessionId);
  if (existing !== undefined) return existing;

  const container = $('#messages');
  const stick = atBottom();
  const turn = el('div', 'turn');
  const prompt = stripEnvelopes(run.prompt ?? '');
  if (prompt !== '') turn.appendChild(el('div', 'user-message', prompt));
  container.appendChild(turn);

  const stream = {
    sessionId,
    turn,
    currentText: null,
    pending: '',
    text: '',
    lastFragment: '',
    frame: 0,
    cards: new Map(),
    thinking: null,
    cancelled: false,
  };
  streams.set(sessionId, stream);
  if (stick) scrollMessagesToBottom();
  return stream;
}

function handleRunEvent(sessionId, event) {
  if (event.type === 'run/state') {
    ensureStream(sessionId, event.run ?? {});
    return;
  }

  const stream = streams.get(sessionId);
  if (stream === undefined) return;

  if (event.type === 'step/start' || event.type === 'reasoning/delta') {
    showThinking(stream);
  } else if (event.type === 'text/delta') {
    hideThinking(stream);
    queueText(stream, event.text);
  } else if (event.type === 'tool/call') {
    flushStream(stream);
    const stick = atBottom();
    hideThinking(stream);
    dropEmptyAssistant(stream);
    const card = appendToolCard(stream.turn, {
      name: event.name,
      arguments: event.arguments,
    });
    stream.cards.set(event.callId, card);
    stream.currentText = null;
    if (stick) scrollMessagesToBottom();
  } else if (event.type === 'tool/result') {
    flushStream(stream);
    const stick = atBottom();
    hideThinking(stream);
    dropEmptyAssistant(stream);
    let card = stream.cards.get(event.callId);
    if (card === undefined) {
      card = appendToolCard(stream.turn, { name: event.name, arguments: '' });
      stream.cards.set(event.callId, card);
    }
    applyToolResult(card, event);
    stream.currentText = null;
    if (stick) scrollMessagesToBottom();
  } else if (event.type === 'tool/skipped') {
    flushStream(stream);
    const stick = atBottom();
    hideThinking(stream);
    dropEmptyAssistant(stream);
    let card = stream.cards.get(event.callId);
    if (card === undefined) {
      card = appendToolCard(stream.turn, { name: event.name, arguments: '' });
      stream.cards.set(event.callId, card);
    }
    applyToolSkipped(card, event.reason ?? 'skipped');
    stream.currentText = null;
    if (stick) scrollMessagesToBottom();
  } else if (event.type === 'turn/end') {
    hideThinking(stream);
  } else if (event.type === 'run/cancelled') {
    const stick = atBottom();
    stream.cancelled = true;
    hideThinking(stream);
    flushStream(stream);
    stream.turn.appendChild(el('div', 'run-note', '已停止'));
    if (stick) scrollMessagesToBottom();
  } else if (event.type === 'session/saved') {
    flushStream(stream);
  }
}

async function consumeRun(response, sessionId) {
  let error = null;
  let reported = false;
  await consumeStream(
    response,
    (event) => {
      try {
        handleRunEvent(sessionId, event);
      } catch (failure) {
        // One unrenderable event must not kill the live view: the turn keeps
        // running server side, and `finishRun` reconciles from the session.
        if (!reported) {
          reported = true;
          toast(failure?.message ?? String(failure), 'error');
        }
      }
    },
    (message) => {
      error = message;
    },
  );
  if (error !== null) toast(error, 'error');
}

/**
 * Attach the visible session to a running turn.
 *
 * `open` issues the request (a POST to start a turn, a GET to rejoin one). The
 * server streams `run/state` first and then replays every event from the
 * beginning, so the same handler rebuilds a turn that started long ago.
 *
 * Resolves true when the turn finished while attached, false when this client
 * detached early (the turn keeps running server side).
 */
async function attachRun(sessionId, open) {
  detachRun();
  const controller = new AbortController();
  state.live = { sessionId, controller };
  let completed = false;
  try {
    const response = await open(controller.signal);
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(data?.error ?? `请求失败（${response.status}）`);
    }
    await consumeRun(response, sessionId);
    completed = true;
  } catch (error) {
    if (error?.name === 'AbortError') return false;
    throw error;
  } finally {
    if (state.live?.controller === controller) state.live = null;
  }
  return completed;
}

/** Stop mirroring a turn without stopping it. Rejoining replays from the start. */
function detachRun() {
  const live = state.live;
  if (live === null) return;
  state.live = null;
  live.controller.abort();

  const stream = streams.get(live.sessionId);
  if (stream !== undefined) {
    if (stream.frame !== 0) cancelAnimationFrame(stream.frame);
    streams.delete(live.sessionId);
  }
}

/** The turn is over: fold the live view into the saved session. */
async function finishRun(sessionId) {
  const stream = streams.get(sessionId);
  const cancelled = stream?.cancelled === true;
  if (stream !== undefined) {
    flushStream(stream);
    hideThinking(stream);
    streams.delete(sessionId);
  }

  toggleRunning(false, sessionId);
  await loadSessions().catch(() => {});
  if (state.session?.id !== sessionId) return;

  try {
    const fresh = await api(`/api/sessions/${sessionId}`);
    state.session = fresh.session;
    renderHeader();
    // The cancelled marker survives the rebuild; scroll position is kept when
    // the reader was not following the bottom.
    renderMessages(false, cancelled ? '已停止' : null);
  } catch {
    // Keep the live view if the session cannot be reloaded.
  }
}

/** Join a turn that is already running (page load, session switch, polling). */
async function attachLive(sessionId) {
  if (state.live?.sessionId === sessionId) return;
  toggleRunning(true, sessionId);
  try {
    const completed = await attachRun(sessionId, (signal) =>
      fetch(`/api/sessions/${sessionId}/stream`, {
        signal,
        headers: { accept: 'text/event-stream' },
      }),
    );
    if (completed) await finishRun(sessionId);
  } catch {
    // Nothing running any more, or the stream could not be opened.
    toggleRunning(false, sessionId);
  }
}

async function sendMessage() {
  const input = $('#input');
  const text = input.value.trim();
  if (text === '' || state.running) return;

  input.value = '';
  input.style.height = 'auto';

  try {
    if (state.session === null) {
      const name = text.split('\n')[0].slice(0, 32) || '新对话';
      const created = await api('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      state.session = created.session;
      renderHeader();
      await loadSessions();
    }

    const session = state.session;
    if (session === null) return;

    toggleRunning(true, session.id);
    const completed = await attachRun(session.id, (signal) =>
      fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({ sessionId: session.id, text }),
      }),
    );
    if (completed) await finishRun(session.id);
  } catch (error) {
    toast(error?.message ?? String(error), 'error');
    if (state.session !== null) {
      const id = state.session.id;
      // A 409 means another tab/turn owns the session: resync and join it
      // instead of leaving the stop button hidden until the next poll.
      await loadSessions().catch(() => {});
      if (state.runningIds.has(id)) await attachLive(id);
      else toggleRunning(false, id);
    }
  }
}

async function stopRun() {
  const session = state.session;
  if (!session) return;
  try {
    // The turn ends server side and the stream closes right after, so the
    // live view still receives the final state instead of being cut off.
    await api('/api/chat/cancel', {
      method: 'POST',
      body: JSON.stringify({ sessionId: session.id }),
    });
  } catch {
    // The turn may have already finished.
  }
}


/* ---------------- topic ---------------- */

function openTopic() {
  if (!state.session) return;
  closeDrawers();
  $('#topic-input').value = state.session.topic ?? '';
  $('#topic-error').textContent = '';
  $('#topic-dialog').showModal();
}

async function saveTopic(topic) {
  if (!state.session) return;
  try {
    const data = await api(`/api/sessions/${state.session.id}/topic`, {
      method: 'PUT',
      body: JSON.stringify({ topic }),
    });
    state.session = data.session;
    $('#topic-dialog').close();
    toast(topic === '' ? '主题已清除' : '主题已保存');
  } catch (error) {
    $('#topic-error').textContent = error.message;
  }
}

/* ---------------- schedule ---------------- */

const SCHEDULE_NODES = {
  time: { container: '#task-times', type: 'time', value: '09:00' },
  day: { container: '#task-days', type: 'number', value: '1', min: '1', max: '31' },
  minute: { container: '#task-minutes', type: 'number', value: '0', min: '0', max: '59' },
};

function addScheduleNode(kind, value) {
  const spec = SCHEDULE_NODES[kind];
  const container = $(spec.container);
  const row = el('div', 'node-row');
  const input = document.createElement('input');
  input.type = spec.type;
  if (spec.min !== undefined) input.min = spec.min;
  if (spec.max !== undefined) input.max = spec.max;
  input.value = value ?? spec.value;
  row.appendChild(input);

  const remove = el('button', 'node-remove', '×');
  remove.type = 'button';
  remove.setAttribute('aria-label', '删除');
  remove.addEventListener('click', () => {
    row.remove();
    syncScheduleNodes(container);
  });
  row.appendChild(remove);

  container.appendChild(row);
  syncScheduleNodes(container);
  return row;
}

/** The last remaining row cannot be removed. */
function syncScheduleNodes(container) {
  const rows = [...container.querySelectorAll('.node-row')];
  for (const row of rows) {
    row.querySelector('.node-remove')?.classList.toggle('hidden', rows.length <= 1);
  }
}

function resetScheduleNodes() {
  for (const kind of ['time', 'day', 'minute']) {
    const container = $(SCHEDULE_NODES[kind].container);
    container.innerHTML = '';
    addScheduleNode(kind);
  }
}

function openSchedule() {
  if (!state.session) return;
  closeDrawers();
  $('#task-error').textContent = '';
  $('#task-name').value = '';
  $('#task-type').value = 'daily';
  resetScheduleNodes();
  updateScheduleFields();
  $('#schedule-dialog').showModal();
  void loadTasks();
}

function updateScheduleFields() {
  const type = $('#task-type').value;
  $('#task-weekly').classList.toggle('hidden', type !== 'weekly');
  $('#task-days-field').classList.toggle('hidden', type !== 'monthly');
  $('#task-minutes-field').classList.toggle('hidden', type !== 'hourly');
  $('#task-times-field').classList.toggle('hidden', type === 'hourly');
}

async function loadTasks() {
  if (!state.session) return;
  const data = await api(`/api/sessions/${state.session.id}/tasks`);
  const list = $('#task-list');
  list.innerHTML = '';
  const tasks = data?.tasks ?? [];

  for (const task of tasks) {
    const item = el('div', 'list-item');
    const grow = el('div', 'grow');
    grow.appendChild(el('div', 'list-name', task.name));
    grow.appendChild(el('div', 'list-sub', task.description ?? ''));
    item.appendChild(grow);

    const remove = el('button', 'text-button danger', '删除');
    remove.addEventListener('click', async () => {
      await api(`/api/sessions/${state.session.id}/tasks/${task.id}`, { method: 'DELETE' });
      await loadTasks();
      toast('定时任务已删除');
    });
    item.appendChild(remove);
    list.appendChild(item);
  }
}

function readScheduleValues(kind) {
  const container = $(SCHEDULE_NODES[kind].container);
  return [...container.querySelectorAll('input')].map((input) => input.value);
}

function readTimes() {
  const values = readScheduleValues('time').filter((value) => value !== '');
  if (values.length === 0) throw new Error('至少填写一个时间');
  for (const value of values) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('时间格式需为 HH:mm');
  }
  return [...new Set(values)];
}

function readNumbers(kind, label, min, max) {
  const values = readScheduleValues(kind).filter((value) => value !== '');
  if (values.length === 0) throw new Error(`至少填写一个${label}`);
  const numbers = [];
  for (const value of values) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) {
      throw new Error(`${label}需在 ${min}-${max} 之间`);
    }
    numbers.push(number);
  }
  return [...new Set(numbers)].sort((a, b) => a - b);
}

function buildSchedule() {
  const type = $('#task-type').value;
  if (type === 'hourly') {
    return { type, minutes: readNumbers('minute', '分钟', 0, 59) };
  }
  const times = readTimes();
  if (type === 'daily') return { type, times };
  if (type === 'weekly') {
    const weekdays = [...document.querySelectorAll('#task-weekly input:checked')].map((input) =>
      Number(input.value),
    );
    if (weekdays.length === 0) throw new Error('至少选择一天');
    return { type, weekdays, times };
  }
  return { type: 'monthly', days: readNumbers('day', '日期', 1, 31), times };
}

async function addTask() {
  if (!state.session) return;
  const name = $('#task-name').value.trim();
  $('#task-error').textContent = '';
  if (name === '') {
    $('#task-error').textContent = '请填写任务名';
    return;
  }
  try {
    const schedule = buildSchedule();
    await api(`/api/sessions/${state.session.id}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ name, schedule }),
    });
    $('#task-name').value = '';
    await loadTasks();
    toast('定时任务已添加');
  } catch (error) {
    $('#task-error').textContent = error.message;
  }
}

/* ---------------- skills ---------------- */

function openSkills() {
  closeDrawers();
  $('#skills-dialog').showModal();
  void loadSkills();
}

function mcpBadge(count) {
  return el('span', 'badge mcp', count > 1 ? `MCP ×${count}` : 'MCP');
}

function renderSkillMcp(servers) {
  const box = $('#skill-mcp');
  box.innerHTML = '';
  if (!servers || servers.length === 0) {
    box.classList.add('hidden');
    return;
  }
  box.appendChild(el('div', 'skill-mcp-head', 'MCP servers'));
  for (const server of servers) {
    const row = el('div', 'skill-mcp-item');
    row.appendChild(el('span', 'skill-mcp-name', server.name));
    const actions = el('span', 'skill-mcp-actions');
    actions.appendChild(el('span', 'skill-mcp-transport', server.transport));
    const refresh = el('button', 'text-button skill-mcp-refresh', '刷新');
    refresh.type = 'button';
    refresh.title = '关闭这个 MCP 服务器并重新连接';
    refresh.addEventListener('click', () => void restartMcpServer(server, refresh));
    actions.appendChild(refresh);
    row.appendChild(actions);
    box.appendChild(row);
  }
  box.classList.remove('hidden');
}

async function restartMcpServer(server, button) {
  button.disabled = true;
  button.textContent = '重启中…';
  try {
    const data = await api(`/api/mcp/${encodeURIComponent(server.name)}/restart`, { method: 'POST' });
    const ok = data?.status?.ok === true;
    if (data?.status === null || data?.status === undefined) {
      toast(`已重启 MCP 服务器：${server.name}（当前没有活跃连接）`);
    } else if (ok) {
      toast(`已重启 MCP 服务器：${server.name}`);
    } else {
      toast(`MCP 服务器 ${server.name} 重启失败：${data?.status?.error ?? '未知错误'}`, 'error');
    }
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '刷新';
  }
}

async function loadSkills() {
  const data = await api('/api/skills');
  const list = $('#skills-list');
  const detail = $('#skill-detail');
  list.innerHTML = '';
  detail.classList.add('hidden');
  detail.textContent = '';
  renderSkillMcp([]);

  const globalServers = data?.globalMcpServers ?? [];
  if (globalServers.length > 0) {
    const item = el('div', 'list-item');
    const grow = el('div', 'grow');
    grow.appendChild(el('div', 'list-name', '全局 MCP'));
    grow.appendChild(
      el('div', 'list-sub', globalServers.map((server) => `${server.name} · ${server.transport}`).join('，')),
    );
    item.appendChild(grow);
    list.appendChild(item);
  }

  const skills = data?.skills ?? [];

  for (const skill of skills) {
    const servers = skill.mcpServers ?? [];
    const item = el('div', 'list-item');
    const grow = el('div', 'grow');
    const name = el('div', 'list-name', skill.name);
    if (servers.length > 0) name.appendChild(mcpBadge(servers.length));
    grow.appendChild(name);
    grow.appendChild(el('div', 'list-sub', skill.description));
    item.appendChild(grow);
    item.style.cursor = 'pointer';
    item.addEventListener('click', async () => {
      const loaded = await api(`/api/skills/${encodeURIComponent(skill.id)}`);
      renderSkillMcp(loaded.skill?.mcpServers ?? servers);
      detail.textContent = loaded.skill?.content ?? '';
      detail.classList.remove('hidden');
    });
    list.appendChild(item);
  }
}

/* ---------------- models & providers ---------------- */

async function loadProviders() {
  try {
    state.providerData = await api('/api/providers');
  } catch {
    return;
  }
  renderModelSelect();
  if ($('#models-dialog').open) renderProviderList();
}

function parseModelValue(value) {
  if (value === '__env__') return { providerId: '', model: '' };
  const index = value.indexOf('::');
  if (index === -1) return null;
  return { providerId: value.slice(0, index), model: value.slice(index + 2) };
}

function modelValue(provider, model) {
  return `${provider.id}::${model}`;
}

function renderModelSelect() {
  const select = $('#model-select');
  const data = state.providerData;
  const active = data?.active ?? null;
  const options = [];
  for (const provider of data?.providers ?? []) {
    for (const model of provider.models) {
      options.push({ value: modelValue(provider, model), label: `${provider.name} · ${model}` });
    }
  }
  if (data?.defaults?.hasDefault) {
    options.push({ value: '__env__', label: `环境变量 · ${data.defaults.apiModelName}` });
  }

  select.innerHTML = '';
  if (options.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '未配置模型';
    option.disabled = true;
    option.selected = true;
    select.appendChild(option);
    select.disabled = true;
    select.title = '还没有可用的模型，点左下角「模型」添加提供商';
    return;
  }

  const activeValue =
    active?.source === 'provider'
      ? `${active.providerId}::${active.model}`
      : active?.source === 'env'
        ? '__env__'
        : '';
  let matched = false;
  for (const item of options) {
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = item.label;
    if (item.value === activeValue) {
      option.selected = true;
      matched = true;
    }
    select.appendChild(option);
  }
  if (!matched && active?.source === 'provider' && active.model !== '') {
    // The stored model is not in the fetched list (stale file); keep it selectable.
    const option = document.createElement('option');
    option.value = activeValue;
    option.textContent = active.label;
    option.selected = true;
    select.appendChild(option);
    matched = true;
  }
  if (!matched) select.selectedIndex = 0;
  select.disabled = state.running;
  select.title = active?.source === 'none' ? '' : `当前：${active?.label ?? ''}`;
}

async function applyModel(value) {
  const selection = parseModelValue(value);
  if (selection === null) return;
  try {
    await api('/api/model', { method: 'PUT', body: JSON.stringify(selection) });
    await loadProviders();
    toast('模型已切换');
  } catch (error) {
    toast(error.message, 'error');
    renderModelSelect();
  }
}

function openModels() {
  closeDrawers();
  $('#provider-error').textContent = '';
  $('#models-dialog').showModal();
  void loadProviders();
}

function renderProviderList() {
  const list = $('#provider-list');
  const data = state.providerData;
  const providers = data?.providers ?? [];
  const active = data?.active ?? { source: 'none' };

  $('#models-active').textContent =
    active.source === 'none' ? '当前：未配置模型' : `当前：${active.label}`;

  list.innerHTML = '';
  if (providers.length === 0) {
    list.appendChild(
      el('p', 'provider-empty', '还没有提供商。在下面填写接口地址和 API Key，会自动识别它的所有模型。'),
    );
    return;
  }

  for (const provider of providers) {
    const item = el('div', 'provider-item');
    const head = el('div', 'list-item');
    const grow = el('div', 'grow');
    const name = el('div', 'list-name', provider.name);
    if (active.source === 'provider' && active.providerId === provider.id) {
      name.appendChild(el('span', 'badge active', '使用中'));
    }
    grow.appendChild(name);
    grow.appendChild(
      el(
        'div',
        'list-sub',
        [
          provider.baseUrl,
          provider.hasKey ? provider.keyHint : '无 Key',
          `${provider.models.length} 个模型`,
        ].join(' · '),
      ),
    );
    head.appendChild(grow);

    const actions = el('div', 'actions');
    const refresh = el('button', 'text-button', '刷新');
    refresh.addEventListener('click', () => void refreshProvider(provider, refresh));
    const remove = el('button', 'text-button danger', '删除');
    remove.addEventListener('click', () => void removeProvider(provider));
    actions.append(refresh, remove);
    head.appendChild(actions);
    item.appendChild(head);

    if (provider.models.length > 0) {
      const models = el('div', 'provider-models');
      for (const model of provider.models) {
        const chip = el('button', 'model-chip', model);
        if (
          active.source === 'provider' &&
          active.providerId === provider.id &&
          active.model === model
        ) {
          chip.classList.add('active');
        }
        chip.addEventListener('click', () => void applyModel(modelValue(provider, model)));
        models.appendChild(chip);
      }
      item.appendChild(models);
    } else {
      item.appendChild(el('p', 'provider-empty', '还没有模型，点「刷新」重新识别。'));
    }
    list.appendChild(item);
  }
}

async function addProvider() {
  const errorNode = $('#provider-error');
  errorNode.textContent = '';
  const name = $('#provider-name').value.trim();
  const baseUrl = $('#provider-url').value.trim();
  const apiKey = $('#provider-key').value.trim();
  const modelsText = $('#provider-models').value.trim();
  if (baseUrl === '') {
    errorNode.textContent = '请填写接口地址';
    return;
  }

  const models = modelsText === '' ? [] : modelsText.split(/[,，\s]+/).filter(Boolean);
  const button = $('#provider-add');
  button.disabled = true;
  button.textContent = '识别中…';
  try {
    await api('/api/providers', {
      method: 'POST',
      body: JSON.stringify({ name, baseUrl, apiKey, models }),
    });
    $('#provider-name').value = '';
    $('#provider-url').value = '';
    $('#provider-key').value = '';
    $('#provider-models').value = '';
    await loadProviders();
    toast('提供商已添加');
  } catch (error) {
    errorNode.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = '添加并识别模型';
  }
}

async function refreshProvider(provider, button) {
  button.disabled = true;
  button.textContent = '识别中…';
  try {
    await api(`/api/providers/${provider.id}/models`, { method: 'POST' });
    await loadProviders();
    toast('模型列表已更新');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '刷新';
  }
}

async function removeProvider(provider) {
  if (!confirm(`删除提供商「${provider.name}」？`)) return;
  try {
    await api(`/api/providers/${provider.id}`, { method: 'DELETE' });
    await loadProviders();
    toast('提供商已删除');
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ---------------- memory ---------------- */

function openMemory() {
  closeDrawers();
  $('#memory-dialog').showModal();
  void loadMemory();
}

async function loadMemory() {
  try {
    state.memory = await api('/api/memory');
  } catch (error) {
    toast(error.message, 'error');
    return;
  }
  renderMemory();
}

function renderMemory() {
  const data = state.memory;
  if (!data) return;
  const enabled = data.settings?.diary?.autoAppend === true;
  $('#diary-auto').checked = enabled;
  $('#diary-sub').textContent = enabled
    ? `对话结束 ${data.diaryIdleMinutes} 分钟没有新消息时，自动让 AI 追加当天日记`
    : `打开后，对话结束 ${data.diaryIdleMinutes} 分钟没有新消息时自动让 AI 追加当天日记`;

  const today = data.today;
  $('#diary-path').textContent = today?.relativePath ?? '';
  const preview = $('#diary-preview');
  preview.textContent = today?.content?.trim()
    ? today.content
    : '今天还没有日记。到点自动整理，或在输入框发送 /update-daily-memory。';
}

async function setDiaryAutoAppend(enabled) {
  try {
    state.memory = await api('/api/memory', {
      method: 'PUT',
      body: JSON.stringify({ diary: { autoAppend: enabled } }),
    });
    renderMemory();
    toast(enabled ? '已开启定时追加日记' : '已关闭定时追加日记');
  } catch (error) {
    $('#diary-auto').checked = !enabled;
    toast(error.message, 'error');
  }
}

/* ---------------- wiring ---------------- */

function currentDrawer() {
  if ($('.sidebar').classList.contains('open')) return 'left';
  if ($('.header-actions').classList.contains('open')) return 'right';
  return null;
}

function syncDrawers(side) {
  const left = side === 'left';
  const right = side === 'right';
  $('.sidebar').classList.toggle('open', left);
  $('.header-actions').classList.toggle('open', right);
  $('#drawer-backdrop').classList.toggle('hidden', side === null);
  document.body.classList.toggle('drawer-open', side !== null);

  const leftButton = $('#toggle-sidebar');
  const rightButton = $('#toggle-actions');
  leftButton.setAttribute('aria-expanded', String(left));
  rightButton.setAttribute('aria-expanded', String(right));
  leftButton.setAttribute('aria-label', left ? '关闭对话列表' : '打开对话列表');
  rightButton.setAttribute('aria-label', right ? '关闭会话操作' : '打开会话操作');
}

function toggleDrawer(side) {
  syncDrawers(currentDrawer() === side ? null : side);
}

function closeDrawers() {
  syncDrawers(null);
}

function wireDialogs() {
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }
  for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => {
      document.getElementById(button.getAttribute('data-close')).close();
    });
  }
}

function wire() {
  $('#toggle-sidebar').addEventListener('click', () => toggleDrawer('left'));
  $('#toggle-actions').addEventListener('click', () => toggleDrawer('right'));
  $('#drawer-backdrop').addEventListener('click', closeDrawers);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDrawers();
  });
  const desktop = window.matchMedia('(min-width: 901px)');
  desktop.addEventListener('change', (event) => {
    if (event.matches) closeDrawers();
  });

  $('#new-chat').addEventListener('click', newChat);

  const search = $('#session-filter');
  search.addEventListener('input', () => {
    state.filter = search.value;
    renderSessions();
  });

  $('#send').addEventListener('click', () => void sendMessage());
  $('#stop').addEventListener('click', () => void stopRun());

  const input = $('#input');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  });

  $('#edit-topic').addEventListener('click', openTopic);
  $('#topic-save').addEventListener('click', () => void saveTopic($('#topic-input').value));
  $('#topic-clear').addEventListener('click', () => void saveTopic(''));

  $('#schedule-chat').addEventListener('click', openSchedule);
  $('#task-type').addEventListener('change', updateScheduleFields);
  $('#task-add').addEventListener('click', () => void addTask());
  $('#task-add-time').addEventListener('click', () => addScheduleNode('time'));
  $('#task-add-day').addEventListener('click', () => addScheduleNode('day'));
  $('#task-add-minute').addEventListener('click', () => addScheduleNode('minute'));

  $('#reset-chat').addEventListener('click', async () => {
    if (!state.session) return;
    closeDrawers();
    if (!confirm('重置会清空这个对话的上下文，主题和定时任务保留。')) return;
    await api(`/api/sessions/${state.session.id}/reset`, { method: 'POST' });
    await selectSession(state.session.id);
    await loadSessions();
    toast('已重置');
  });

  $('#delete-chat').addEventListener('click', async () => {
    if (!state.session) return;
    closeDrawers();
    if (!confirm(`删除「${state.session.name}」？`)) return;
    await api(`/api/sessions/${state.session.id}`, { method: 'DELETE' });
    state.session = null;
    renderHeader();
    renderMessages();
    await loadSessions();
    newChat();
    toast('对话已删除');
  });

  $('#open-skills').addEventListener('click', openSkills);

  $('#open-models').addEventListener('click', openModels);
  $('#open-memory').addEventListener('click', openMemory);
  $('#diary-auto').addEventListener('change', (event) =>
    void setDiaryAutoAppend(event.target.checked),
  );
  $('#diary-refresh').addEventListener('click', () => void loadMemory());
  $('#provider-add').addEventListener('click', () => void addProvider());
  $('#model-select').addEventListener('change', (event) => void applyModel(event.target.value));

  wireDialogs();

  setInterval(async () => {
    try {
      await loadSessions();
      if (state.session === null) return;
      const sessionId = state.session.id;
      // A turn that started elsewhere (scheduled task, another tab) is worth
      // joining: the replay rebuilds the whole thing, not just the tail.
      if (state.live === null && state.runningIds.has(sessionId)) {
        await attachLive(sessionId);
        return;
      }
      if (state.live !== null) return;
      const summary = state.sessions.find((session) => session.id === sessionId);
      if (summary && summary.messageCount !== state.session.messageCount) {
        await selectSession(sessionId);
      } else if (summary) {
        state.session.messageCount = summary.messageCount;
        state.session.updatedAt = summary.updatedAt;
        renderHeader();
      }
    } catch {
      // Polling is best-effort.
    }
  }, 20_000);
}

async function init() {
  wire();
  await loadProviders();
  await loadSessions();
  if (state.sessions.length > 0) {
    await selectSession(state.sessions[0].id);
  } else {
    newChat();
  }
}

void init();
