/* KolorBot web client: vanilla ES module, no build step. */

const $ = (selector) => document.querySelector(selector);

const state = {
  /** Single conversation: topics, segments and messages. */
  conversation: null,
  conversationSignature: '',
  agent: null,
  currentTopic: null,
  /** Virtual session used by the live-run/SSE code (always id `main`). */
  session: null,
  running: false,
  runningIds: new Set(),
  /** The stream this page is currently mirroring, if any. */
  live: null,
  providerData: null,
  memory: null,
  /** A message typed while a turn was running; sent when it finishes. */
  queued: null,
  /** Optimistic user bubble shown while the topic is being classified. */
  pending: null,
  /** Current page: chat | topics | skills | models | memory. */
  page: 'chat',
  /** Skills page variant: main (Kolorbot + universal) or agent. */
  skillsArea: 'main',
  topicSlug: null,
  topicDate: null,
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
  // Inline code first so its content is left alone, then images, links and emphasis.
  html = html.replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>');
  html = html.replace(
    /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
    '<img class="md-image" src="$2" alt="$1" loading="lazy">',
  );
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
  // Injected blocks can be nested inside <system-last-message> (it quotes
  // older user messages verbatim), so peel envelopes from the inside out.
  for (;;) {
    const next = text.replace(
      /<system-([a-z-]+)>((?:(?!<system-)[\s\S])*?)<\/system-\1>\r?\n*/g,
      '',
    );
    if (next === text) break;
    text = next;
  }
  return text.replace(/^\s+/, '');
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

/* ---------------- agent card ---------------- */

async function loadAgent() {
  try {
    state.agent = await api('/api/agent');
  } catch {
    state.agent = null;
  }
  renderAgent();
}

function renderAgent() {
  const data = state.agent;
  const name = String(data?.name ?? 'KolorBot').trim() || 'KolorBot';
  $('#agent-name').textContent = name;
  $('#agent-name').title = name;
  const fallback = $('#agent-avatar-fallback');
  const image = $('#agent-avatar-image');
  fallback.textContent = name.slice(0, 1).toUpperCase();
  if (typeof data?.avatarUrl === 'string' && data.avatarUrl !== '') {
    image.onerror = () => {
      image.classList.add('hidden');
      fallback.classList.remove('hidden');
    };
    image.src = data.avatarUrl;
    image.classList.remove('hidden');
    fallback.classList.add('hidden');
  } else {
    image.classList.add('hidden');
    image.removeAttribute('src');
    fallback.classList.remove('hidden');
  }
}

function setAgentMenu(open) {
  $('#agent-menu').classList.toggle('hidden', !open);
  $('#agent-menu-button').setAttribute('aria-expanded', String(open));
}

function closeAgentMenu() {
  setAgentMenu(false);
}
/* ---------------- sessions ---------------- */

/** Load the single conversation and rebuild the header. */
async function loadConversation() {
  const data = await api('/api/conversation');
  state.conversation = data.conversation;
  state.currentTopic = data.current?.topic ?? null;
  const messages = state.conversation?.messages ?? [];
  const today = localDateKey(new Date());
  const todayMessages = messages.filter((entry) => {
    const at = entry.createdAt === undefined ? null : new Date(entry.createdAt);
    return at !== null && !Number.isNaN(at.getTime()) && localDateKey(at) === today;
  });
  const last = todayMessages[todayMessages.length - 1];
  state.session = {
    id: 'main',
    name: state.currentTopic?.name ?? '对话',
    topic: state.currentTopic?.name ?? '',
    messageCount: todayMessages.length,
    updatedAt: last?.createdAt ?? null,
    context: [],
  };
  try {
    const live = await api('/api/sessions/main');
    state.runningIds = live.running === true ? new Set(['main']) : new Set();
  } catch {
    state.runningIds = new Set();
  }
  const signature = [
    state.currentTopic?.name ?? '',
    state.conversation?.segments.length ?? 0,
    messages.length,
    last?.id ?? '',
  ].join(':');
  const changed = signature !== state.conversationSignature;
  state.conversationSignature = signature;
  renderHeader();
  if (changed && state.page === 'chat' && state.live === null && state.pending === null) {
    renderMessages(false);
  }
  syncBusy();
}

// Older call sites still say "loadSessions"; there is only one conversation now.
const loadSessions = loadConversation;
function renderSessions() {}

async function selectSession(_id) {
  await loadConversation();
}

function newChat() {
  document.querySelector('#input').value = '';
  document.querySelector('#input').focus();
}

const PAGES = {
  chat: { title: '对话', subtitle: '' },
  topics: { title: '历史', subtitle: '历史 / 全部日历' },
  skills: { title: '技能', subtitle: 'Kolorbot Skill / 通用 Agent Skills / MCP' },
  models: { title: '模型', subtitle: '厂商集成 / OpenAI v1 / 代码接入' },
  memory: { title: '设定', subtitle: 'AI 人设 / AI.md' },
};

function pageFromHash() {
  if (location.hash.startsWith('#/topics')) return 'topics';
  const match = /^#\/(chat|skills|models|memory)$/.exec(location.hash);
  return match === null ? 'chat' : match[1];
}

function showPage(name, syncHash = true) {
  if (!(name in PAGES)) name = 'chat';
  const changed = state.page !== name;
  state.page = name;
  for (const page of document.querySelectorAll('.page')) {
    page.classList.toggle('hidden', page.id !== `page-${name}`);
  }
  const activePage = name === 'topics' ? 'chat' : name;
  for (const item of document.querySelectorAll('.sidebar-nav [data-page]')) {
    item.classList.toggle('active', item.dataset.page === activePage);
  }
  if (syncHash) {
    if (name === 'topics') {
      if (location.hash !== '#/topics') location.hash = '#/topics';
    } else if (pageFromHash() !== name) {
      location.hash = `#/${name}`;
    }
  }
  closeDrawers();
  renderHeader();
  if (name === 'topics') {
    if (!syncHash || location.hash === '#/topics') void routeTopics();
    return;
  }
  if (!changed) return;
  if (name === 'skills') void loadSkills();
  else if (name === 'models') void loadProviders();
  else if (name === 'memory') void loadMemory();
  else if (state.live === null) renderMessages(false);
}

function renderHeader() {
  const session = state.session;
  const topic = state.currentTopic;
  const page = PAGES[state.page] ?? PAGES.chat;
  const isAgentSkills = state.page === 'skills' && state.skillsArea === 'agent';
  $('#session-title').textContent =
    state.page === 'chat' ? (topic?.name ?? '对话') : isAgentSkills ? 'Agent Skill' : page.title;
  $('#session-meta').textContent =
    state.page === 'chat'
      ? session
        ? session.updatedAt
          ? timeAgo(session.updatedAt)
          : ''
        : ''
      : isAgentSkills
        ? 'Agent 专属技能 / agent/skills'
        : page.subtitle;
}

/* ---------------- topics ---------------- */

let topicRouteToken = 0;

function resetTopicsScroll() {
  const page = $('#page-topics');
  if (page === null) return;
  page.scrollTop = 0;
  requestAnimationFrame(() => {
    page.scrollTop = 0;
  });
}

function setTopicsView(view) {
  resetTopicsScroll();
  $('#topic-calendar-view').classList.toggle('hidden', view !== 'calendar');
  $('#topic-day-view').classList.toggle('hidden', view !== 'day');
}

async function routeTopics() {
  const token = ++topicRouteToken;
  const path = location.hash.replace(/^#\/topics\/?/, '');
  const parts = path
    .split('/')
    .filter((part) => part !== '')
    .map((part) => decodeURIComponent(part));
  try {
    if (parts.length === 0) {
      await loadGlobalCalendar(token);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(parts[0])) {
      await loadGlobalDay(parts[0], token);
    } else {
      location.hash = '#/topics';
    }
  } catch (error) {
    if (token !== topicRouteToken) return;
    toast(error?.message ?? String(error), 'error');
  }
}

async function loadGlobalCalendar(token) {
  setTopicsView('calendar');
  const calendars = $('#topic-calendars');
  const meta = $('#topic-calendar-meta');
  $('#topic-calendar-title').textContent = '所有对话';
  meta.textContent = '加载中…';
  calendars.innerHTML = '';
  const data = await api('/api/calendar');
  if (token !== topicRouteToken) return;
  meta.textContent =
    data.dates.length === 0 ? '还没有对话记录。' : `共 ${data.dates.length} 天对话记录`;
  if (data.months.length === 0) {
    calendars.appendChild(el('p', 'topic-empty', '等第一次对话后，这里会出现日历。'));
    return;
  }
  for (const month of data.months) {
    calendars.appendChild(renderGlobalMonth(month));
  }
  resetTopicsScroll();
}

function renderGlobalMonth(month) {
  const [yearText, monthText] = month.month.split('-');
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const days = new Set(month.days);
  const card = el('div', 'calendar-month');
  card.appendChild(el('div', 'calendar-month-title', `${year} 年 ${Number(monthText)} 月`));
  const grid = el('div', 'calendar-grid');
  for (const weekday of ['一', '二', '三', '四', '五', '六', '日']) {
    grid.appendChild(el('div', 'calendar-weekday', weekday));
  }
  const first = new Date(year, monthIndex, 1);
  const lead = (first.getDay() + 6) % 7;
  for (let index = 0; index < lead; index += 1) {
    grid.appendChild(el('div', 'calendar-day'));
  }
  const total = new Date(year, monthIndex + 1, 0).getDate();
  const today = localDateKey(new Date());
  for (let day = 1; day <= total; day += 1) {
    const date = `${month.month}-${String(day).padStart(2, '0')}`;
    if (days.has(date)) {
      const button = el('button', 'calendar-day has-entry', String(day));
      button.type = 'button';
      if (date === today) button.classList.add('today');
      button.title = `${date} · 查看当天全部对话`;
      button.addEventListener('click', () => {
        location.hash = `#/topics/${date}`;
      });
      grid.appendChild(button);
    } else {
      const cell = el('div', 'calendar-day', String(day));
      if (date === today) cell.classList.add('today');
      grid.appendChild(cell);
    }
  }
  card.appendChild(grid);
  return card;
}

async function loadGlobalDay(date, token) {
  setTopicsView('day');
  state.topicDate = date;
  $('#topic-day-title').textContent = '加载中…';
  $('#topic-day-chat').innerHTML = '';
  $('#topic-day-diary').innerHTML = '';
  setTopicTab('chat');
  const data = await api(`/api/days/${encodeURIComponent(date)}`);
  if (token !== topicRouteToken) return;
  $('#topic-day-title').textContent = date;
  renderDayChat(data.segments ?? []);
  renderDayMemory(data.memories ?? []);
  setTopicTab('chat');
  resetTopicsScroll();
}

function dayDivider(topicName, time) {
  const divider = el('div', 'topic-segment-divider');
  divider.appendChild(el('span', 'topic-divider-line'));
  divider.appendChild(el('span', 'topic-divider-badge topic-segment-topic', topicName));
  divider.appendChild(el('span', 'topic-divider-badge topic-segment-time', time));
  divider.appendChild(el('span', 'topic-divider-line'));
  return divider;
}

function renderDayChat(segments) {
  const box = $('#topic-day-chat');
  box.innerHTML = '';
  if (segments.length === 0) {
    box.appendChild(el('p', 'topic-day-chat-empty', '这一天没有对话记录。'));
    return;
  }
  for (const segment of segments) {
    box.appendChild(
      dayDivider(segment.topicName ?? segment.topicSlug ?? '话题', hhmm(segment.startedAt)),
    );
    const messages = segment.messages ?? [];
    const toolResults = new Map();
    for (const message of messages) {
      if (message.role === 'tool') toolResults.set(message.toolCallId, message);
    }
    let turn = null;
    for (const message of messages) {
      if (message.role === 'user') {
        const text = stripEnvelopes(message.content ?? '');
        if (text === '') continue;
        turn = el('div', 'turn');
        turn.appendChild(el('div', 'user-message', text));
        box.appendChild(turn);
        continue;
      }
      if (message.role !== 'assistant') continue;
      const text = message.content ?? '';
      const calls = message.toolCalls ?? [];
      if (text.trim() === '' && calls.length === 0) continue;
      if (turn === null) {
        turn = el('div', 'turn');
        box.appendChild(turn);
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
  }
}

function renderDayMemory(memories) {
  const diary = $('#topic-day-diary');
  diary.innerHTML = '';
  if (memories.length === 0) {
    diary.appendChild(el('p', 'topic-empty', '这一天还没有话题记忆。'));
    return;
  }
  for (const memory of memories) {
    const item = el('section', 'day-memory-item');
    const label = `--------${memory.topicSlug}-${String(memory.time).replace(':', '-')}--------`;
    item.appendChild(el('div', 'day-memory-label', label));
    const body = el('div', 'assistant-message');
    body.innerHTML = renderMarkdown(memory.content ?? '');
    item.appendChild(body);
    diary.appendChild(item);
  }
}

function setTopicTab(tab) {
  for (const button of document.querySelectorAll('[data-topic-tab]')) {
    button.classList.toggle('active', button.dataset.topicTab === tab);
  }
  $('#topic-day-chat').classList.toggle('hidden', tab !== 'chat');
  $('#topic-day-diary').classList.toggle('hidden', tab !== 'diary');
}

function localDateKey(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function hhmm(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
/* ---------------- messages ---------------- */

function topicDivider(name) {
  const divider = el('div', 'topic-divider');
  divider.appendChild(el('span', 'topic-divider-line'));
  divider.appendChild(el('span', 'topic-divider-name', name));
  divider.appendChild(el('span', 'topic-divider-line'));
  return divider;
}

function renderMessages(forceBottom = false, note = null) {
  const container = $('#messages');
  const stick = forceBottom || atBottom();
  const previousTop = container.scrollTop;
  const previousHeight = container.scrollHeight;
  container.innerHTML = '';
  const view = state.conversation;
  if (view === null) return;
  const today = localDateKey(new Date());
  const todayMessages = (view.messages ?? []).filter((entry) => {
    const at = entry.createdAt === undefined ? null : new Date(entry.createdAt);
    return at !== null && !Number.isNaN(at.getTime()) && localDateKey(at) === today;
  });
  if (todayMessages.length === 0) {
    const empty = el('div', 'chat-empty');
    empty.appendChild(el('h2', 'chat-empty-title', '今天有什么可以帮到你？'));
    empty.appendChild(el('p', 'chat-empty-sub', '直接说说你在做什么，或者想改什么。'));
    container.appendChild(empty);
    return;
  }

  const topicNames = new Map(view.topics.map((topic) => [topic.slug, topic.name]));
  const segmentTopic = new Map(view.segments.map((segment) => [segment.id, segment.topicSlug]));
  let renderedSegments = 0;

  for (const segment of view.segments) {
    const stored = todayMessages.filter((message) => message.segmentId === segment.id);
    if (stored.length === 0) continue;
    if (renderedSegments > 0) {
      container.appendChild(topicDivider(topicNames.get(segmentTopic.get(segment.id)) ?? '话题'));
    }
    renderedSegments += 1;

    const toolResults = new Map();
    for (const entry of stored) {
      if (entry.message.role === 'tool') toolResults.set(entry.message.toolCallId, entry.message);
    }

    let turn = null;
    for (const entry of stored) {
      const message = entry.message;
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
  }

  if (renderedSegments === 0) {
    const empty = el('div', 'chat-empty');
    empty.appendChild(el('h2', 'chat-empty-title', '今天有什么可以帮到你？'));
    empty.appendChild(el('p', 'chat-empty-sub', '直接说说你在做什么，或者想改什么。'));
    container.appendChild(empty);
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

/* ---------------- skill code plugin bridge ---------------- */

const pluginEventListeners = new Set();

function emitPluginEvent(event, meta = {}) {
  if (pluginEventListeners.size === 0) return;
  const payload = { ...event, ...meta, at: new Date().toISOString() };
  for (const listener of [...pluginEventListeners]) {
    try {
      listener(payload);
    } catch (error) {
      console.error('skill code listener failed', error);
    }
  }
}

/** Remove a session's live turn state and its DOM element. */
function dropStream(sessionId) {
  const stream = streams.get(sessionId);
  if (stream === undefined) return;
  if (stream.frame !== 0) {
    cancelAnimationFrame(stream.frame);
    stream.frame = 0;
  }
  stream.turn.remove();
  streams.delete(sessionId);
}

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
/**
 * End one assistant text segment (a tool call came next).
 *
 * The DOM bubble keeps what it already rendered; the stream buffer must start
 * empty again, otherwise the next bubble would render all previous segments
 * plus the new text.
 */
function resetSegment(stream) {
  stream.currentText = null;
  stream.text = '';
  stream.lastFragment = '';
}

function dropEmptyAssistant(stream) {
  const body = stream.currentText;
  if (body !== null && body.textContent === '') {
    body.remove();
    stream.currentText = null;
  }
}

/** Show the user's message immediately while the server classifies its topic. */
function beginPendingTurn(text) {
  const container = $('#messages');
  const turn = el('div', 'turn pending-turn');
  turn.appendChild(el('div', 'user-message', text));
  const thinking = appendThinking(turn);
  container.appendChild(turn);
  scrollMessagesToBottom();
  state.pending = { text, turn, thinking };
}

function clearPendingTurn() {
  if (state.pending === null) return;
  state.pending.turn.remove();
  state.pending = null;
}

function ensureStream(sessionId, run) {
  const existing = streams.get(sessionId);
  if (existing !== undefined) {
    if (existing.turn.isConnected) return existing;
    // A rebuild detached the live turn; start a fresh one instead of writing
    // into DOM nodes that are no longer in the document.
    streams.delete(sessionId);
  }

  const container = $('#messages');
  container.querySelector('.chat-empty')?.remove();
  const stick = atBottom();
  let turn;
  if (state.pending !== null) {
    // Reuse the optimistic bubble: no duplicate message, drop its dots.
    const pending = state.pending;
    state.pending = null;
    turn = pending.turn;
    turn.classList.remove('pending-turn');
    pending.thinking.remove();
    const prompt = stripEnvelopes(run.prompt ?? '');
    const bubble = turn.querySelector('.user-message');
    if (prompt !== '' && bubble !== null) bubble.textContent = prompt;
  } else {
    turn = el('div', 'turn');
    const prompt = stripEnvelopes(run.prompt ?? '');
    if (prompt !== '') turn.appendChild(el('div', 'user-message', prompt));
    container.appendChild(turn);
  }

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

  let stream = streams.get(sessionId);
  if (stream === undefined) stream = ensureStream(sessionId, {});

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
    resetSegment(stream);
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
    resetSegment(stream);
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
    resetSegment(stream);
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
      emitPluginEvent(event, { sessionId, source: 'web' });
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
  // Every attach replays the whole run, so start from a clean turn. A stream
  // left over from an aborted/dropped turn must never be reused: new text would
  // append to the old answer and the two turns would merge into one message.
  dropStream(sessionId);
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
  clearPendingTurn();
  await loadConversation().catch(() => {});
  void loadAgent();
  // The cancelled marker survives the rebuild; scroll position is kept when
  // the reader was not following the bottom.
  renderMessages(false, cancelled ? '已停止' : null);
  await flushQueuedMessage();
}

/** Send a message that was queued while the previous turn was running. */
async function flushQueuedMessage() {
  const queued = state.queued;
  if (queued === null || state.running) return;
  const sessionId = state.session?.id ?? null;
  if (queued.sessionId !== sessionId) {
    state.queued = null;
    return;
  }
  state.queued = null;
  const input = $('#input');
  input.value = queued.text;
  input.style.height = 'auto';
  await sendMessage();
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
    await flushQueuedMessage();
  }
}

const COMMAND_COMPLETIONS = [
  { value: '/self-md-update', description: '按当前对话更新设定' },
  { value: '/self-md-tell', description: '按后面的内容更新设定' },
  { value: '/update-daily-memory', description: '立即整理一次记忆' },
];

function hideCommandMenu() {
  $('#command-menu').classList.add('hidden');
}

function chooseCommand(value) {
  const input = $('#input');
  input.value = value === '/self-md-tell' ? `${value} ` : value;
  input.focus();
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  input.setSelectionRange(input.value.length, input.value.length);
  hideCommandMenu();
}

function updateCommandMenu() {
  const menu = $('#command-menu');
  const value = $('#input').value;
  if (!value.startsWith('/') || value.includes('\n') || value.slice(1).includes(' ')) {
    hideCommandMenu();
    return;
  }
  const matches = COMMAND_COMPLETIONS.filter((command) => command.value.startsWith(value));
  if (matches.length === 0) {
    hideCommandMenu();
    return;
  }
  menu.replaceChildren(
    ...matches.map((command) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'command-item';
      item.setAttribute('role', 'option');
      const code = document.createElement('code');
      code.textContent = command.value;
      const description = document.createElement('span');
      description.className = 'command-description';
      description.textContent = command.description;
      item.append(code, description);
      item.addEventListener('mousedown', (event) => event.preventDefault());
      item.addEventListener('click', () => chooseCommand(command.value));
      return item;
    }),
  );
  menu.classList.remove('hidden');
}
async function sendMessage() {
  const input = $('#input');
  const text = input.value.trim();
  if (text === '') return;

  if (text === '/update-daily-memory') {
    input.value = '';
    input.style.height = 'auto';
    hideCommandMenu();
    try {
      const result = await api('/api/diary/organize', { method: 'POST' });
      toast(result?.started ? '记忆整理已交给独立记忆 Agent' : '没有需要整理的对话片段');
    } catch (error) {
      toast(error.message, 'error');
    }
    return;
  }

  // A turn is already running: queue this text instead of leaving it in the
  // box (pressing Enter again would accumulate the old text into the next send).
  if (state.running) {
    state.queued = { sessionId: 'main', text };
    input.value = '';
    input.style.height = 'auto';
    hideCommandMenu();
    toast('已排队：当前这一轮结束后自动发送');
    return;
  }

  input.value = '';
  input.style.height = 'auto';
  hideCommandMenu();
  beginPendingTurn(text);

  try {
    if (state.session === null) await loadConversation();

    const session = state.session;
    if (session === null) return;

    toggleRunning(true, session.id);
    const completed = await attachRun(session.id, (signal) =>
      fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({ text }),
      }),
    );
    if (completed) await finishRun(session.id);
    else clearPendingTurn();
  } catch (error) {
    clearPendingTurn();
    toast(error?.message ?? String(error), 'error');
    if (state.session !== null) {
      const id = state.session.id;
      // A 409 means another tab/turn owns the session: resync and join it
      // instead of leaving the stop button hidden until the next poll.
      await loadSessions().catch(() => {});
      if (state.runningIds.has(id)) await attachLive(id);
      else {
        toggleRunning(false, id);
        await flushQueuedMessage();
      }
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
  const unavailable = data?.available === false;
  const notice = $('#task-unavailable');
  notice.classList.toggle('hidden', !unavailable);
  notice.textContent = unavailable
    ? '定时任务不可用：调度器守护进程没有运行（用 run scheduler 启动）'
    : '';
  $('#task-add').disabled = unavailable;
  if (unavailable) return;
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
  showPage('skills');
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
  const categories = Array.isArray(data?.categories) ? data.categories : [];
  if (categories.length > 0) {
    const area = state.skillsArea === 'agent' ? 'agent' : 'main';
    const visible = categories.filter((category) =>
      area === 'agent' ? category.id === 'agent' : category.id !== 'agent',
    );
    for (const category of visible) {
      const categorySkills = skills.filter((skill) => category.sources.includes(skill.source));
      const head = el('div', 'skill-group-head');
      head.title = (category.roots ?? []).map((root) => root.path).filter(Boolean).join('\n');
      head.appendChild(el('span', 'skill-group-title', category.label ?? category.id));
      head.appendChild(el('span', 'skill-group-count', String(categorySkills.length)));
      list.appendChild(head);
      if (categorySkills.length === 0) {
        const paths = (category.roots ?? []).map((root) => root.path).filter(Boolean);
        list.appendChild(
          el('div', 'skill-group-empty', `（空）把技能放进 ${paths.join(' 或 ') || '对应目录'}`),
        );
      }
      for (const skill of categorySkills) list.appendChild(skillListItem(skill));
    }
    return;
  }

  const groups = Array.isArray(data?.roots) ? data.roots : [];
  if (groups.length === 0) {
    // Older server: flat list.
    for (const skill of skills) list.appendChild(skillListItem(skill));
  } else {
    for (const group of groups) {
      const groupSkills = skills.filter((skill) => skill.source === group.source);
      const head = el('div', 'skill-group-head');
      head.title = group.path ?? '';
      head.appendChild(el('span', 'skill-group-title', group.label ?? group.source));
      head.appendChild(el('span', 'skill-group-count', String(groupSkills.length)));
      list.appendChild(head);
      if (groupSkills.length === 0) {
        list.appendChild(el('div', 'skill-group-empty', `（空）把技能放进 ${group.path ?? '这个目录'}`));
      }
      for (const skill of groupSkills) list.appendChild(skillListItem(skill));
    }
  }
}

function skillListItem(skill) {
  const servers = skill.mcpServers ?? [];
  const item = el('div', 'list-item');
  const grow = el('div', 'grow');
  const name = el('div', 'list-name', skill.name);
  if (servers.length > 0) name.appendChild(mcpBadge(servers.length));
  if (skill.hasCode === true) name.appendChild(el('span', 'badge do', 'Do'));
  grow.appendChild(name);
  grow.appendChild(el('div', 'list-sub', skill.description));
  item.appendChild(grow);
  item.style.cursor = 'pointer';
  item.addEventListener('click', async () => {
    const loaded = await api(`/api/skills/${encodeURIComponent(skill.id)}`);
    renderSkillMcp(loaded.skill?.mcpServers ?? servers);
    $('#skill-detail').textContent = loaded.skill?.content ?? '';
    $('#skill-detail').classList.remove('hidden');
  });
  return item;
}

/* ---------------- models & providers ---------------- */

const MODEL_KIND_LABELS = {
  llm: '大语言模型',
};
const MODEL_PROTOCOL_LABELS = {
  openai: 'OpenAI v1',
  anthropic: 'Anthropic',
  vendor: '厂商集成',
  code: '代码接入',
};

function providerVendor(vendorId) {
  return (state.providerData?.vendors ?? []).find((vendor) => vendor.id === vendorId);
}

function providerKindLabel(provider) {
  return MODEL_KIND_LABELS[provider.kind] ?? provider.kind;
}

function providerProtocolLabel(provider) {
  if (provider.protocol === 'vendor') {
    return `厂商集成 · ${providerVendor(provider.vendor)?.label ?? provider.vendor ?? '未选择'}`;
  }
  return MODEL_PROTOCOL_LABELS[provider.protocol] ?? provider.protocol;
}

async function loadProviders() {
  try {
    state.providerData = await api('/api/providers');
  } catch {
    return;
  }
  updateProviderFormOptions();
  renderModelSelect();
  if (state.page === 'models') renderProviderList();
}

function updateProviderFormOptions() {
  const data = state.providerData;
  const protocolSelect = $('#provider-protocol');
  const options = data?.protocols?.llm ?? [
    { id: 'vendor', label: '厂商集成' },
    { id: 'openai', label: 'OpenAI v1' },
    { id: 'code', label: '代码接入' },
  ];
  const previous = protocolSelect.value;
  protocolSelect.innerHTML = '';
  for (const option of options) {
    const node = document.createElement('option');
    node.value = option.id;
    node.textContent = option.label;
    protocolSelect.appendChild(node);
  }
  if (options.some((option) => option.id === previous)) protocolSelect.value = previous;
  updateProviderForm();
}

function updateProviderForm() {
  const kind = 'llm';
  const protocol = $('#provider-protocol').value;
  const vendorRow = $('#provider-vendor-row');
  const vendorSelect = $('#provider-vendor');
  const url = $('#provider-url');
  const key = $('#provider-key');
  const code = $('#provider-code');
  const hint = $('#provider-hint');
  const isVendor = protocol === 'vendor';
  const isCode = protocol === 'code';
  vendorRow.classList.toggle('hidden', !isVendor);
  code.classList.toggle('hidden', !isCode);
  url.classList.toggle('hidden', isCode || isVendor);
  key.classList.toggle('hidden', isCode);
  if (isVendor) {
    const vendors = (state.providerData?.vendors ?? []).filter((vendor) => vendor.kind === kind);
    const previous = vendorSelect.value;
    vendorSelect.innerHTML = '';
    for (const vendor of vendors) {
      const node = document.createElement('option');
      node.value = vendor.id;
      const wire =
        vendor.protocol === 'openai'
          ? 'OpenAI v1'
          : vendor.protocol === 'anthropic'
            ? 'Anthropic'
            : '专用接口';
      node.textContent = `${vendor.label} · ${wire}`;
      vendorSelect.appendChild(node);
    }
    if (vendors.some((vendor) => vendor.id === previous)) vendorSelect.value = previous;
    const selected = providerVendor(vendorSelect.value);
    if (selected !== undefined) url.value = selected.baseUrl;
  } else if (protocol === 'anthropic' && url.value.trim() === '') {
    url.value = 'https://api.anthropic.com';
  } else if (!isCode) {
    const selected = currentProviderVendor();
    if (selected !== undefined && url.value === selected.baseUrl) url.value = '';
  }
  if (hint !== null) {
    hint.textContent = isCode
      ? '代码接入：provider 保存 Node.js 方法源码；方法参数是输入内容，返回值是输出内容。接口定义见 README。'
      : isVendor
        ? '厂商集成：接口地址按厂商预设；Key 只保存在本机的 providers.json。'
        : protocol === 'anthropic'
          ? 'Anthropic Messages API。'
          : 'OpenAI v1 兼容协议；Key 只保存在本机的 providers.json。';
  }
}

function currentProviderVendor() {
  return providerVendor($('#provider-vendor').value);
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
    const vendor = providerVendor(provider.vendor);
    const effective = provider.protocol === 'vendor' ? vendor?.protocol : provider.protocol;
    if (provider.kind !== 'llm' || effective === 'native' || effective === 'code') continue;
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
  showPage('models');
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
      el('p', 'provider-empty', '还没有提供商。选择协议/厂商并填写 API Key，服务端会自动识别模型。'),
    );
    return;
  }

  for (const provider of providers) {
    const item = el('div', 'provider-item');
    const head = el('div', 'list-item');
    const grow = el('div', 'grow');
    const name = el('div', 'list-name', provider.name);
    name.appendChild(el('span', 'badge', providerKindLabel(provider)));
    name.appendChild(el('span', 'badge', providerProtocolLabel(provider)));
    if (active.source === 'provider' && active.providerId === provider.id) {
      name.appendChild(el('span', 'badge active', '使用中'));
    }
    grow.appendChild(name);
    grow.appendChild(
      el(
        'div',
        'list-sub',
        [
          provider.baseUrl || (provider.hasCode ? '代码接入' : '未填写接口地址'),
          provider.hasKey ? provider.keyHint : '无 Key',
          `${provider.models.length} 个模型`,
        ].join(' · '),
      ),
    );
    head.appendChild(grow);

    const actions = el('div', 'actions');
    const canDiscover =
      provider.protocol === 'openai' ||
      provider.protocol === 'anthropic' ||
      (provider.protocol === 'vendor' &&
        (providerVendor(provider.vendor)?.protocol === 'openai' ||
          providerVendor(provider.vendor)?.protocol === 'anthropic'));
    if (canDiscover) {
      const refresh = el('button', 'text-button', '刷新');
      refresh.addEventListener('click', () => void refreshProvider(provider, refresh));
      actions.appendChild(refresh);
    }
    const remove = el('button', 'text-button danger', '删除');
    remove.addEventListener('click', () => void removeProvider(provider));
    actions.append(remove);
    head.appendChild(actions);
    item.appendChild(head);

    if (provider.models.length > 0) {
      const models = el('div', 'provider-models');
      const vendor = providerVendor(provider.vendor);
      const effective = provider.protocol === 'vendor' ? vendor?.protocol : provider.protocol;
      const selectable =
        provider.kind === 'llm' && (effective === 'openai' || effective === 'anthropic');
      for (const model of provider.models) {
        const chip = el('button', 'model-chip', model);
        if (selectable) {
          if (
            active.source === 'provider' &&
            active.providerId === provider.id &&
            active.model === model
          ) {
            chip.classList.add('active');
          }
          chip.addEventListener('click', () => void applyModel(modelValue(provider, model)));
        } else {
          chip.disabled = true;
          chip.title = '该类型暂未接入聊天';
        }
        models.appendChild(chip);
      }
      item.appendChild(models);
    } else {
      item.appendChild(el('p', 'provider-empty', '暂无可用模型。'));
    }
    list.appendChild(item);
  }
}

async function addProvider() {
  const errorNode = $('#provider-error');
  errorNode.textContent = '';
  const name = $('#provider-name').value.trim();
  const kind = 'llm';
  const protocol = $('#provider-protocol').value;
  const vendor = protocol === 'vendor' ? $('#provider-vendor').value : '';
  const baseUrl = protocol === 'vendor' || protocol === 'code' ? '' : $('#provider-url').value.trim();
  const apiKey = protocol === 'code' ? '' : $('#provider-key').value.trim();
  const code = protocol === 'code' ? $('#provider-code').value.trim() : '';
  if (protocol !== 'code' && protocol !== 'vendor' && baseUrl === '') {
    errorNode.textContent = '请填写接口地址';
    return;
  }
  if (protocol === 'vendor' && vendor === '') {
    errorNode.textContent = '请选择厂商';
    return;
  }
  if (protocol === 'code' && code === '') {
    errorNode.textContent = '请填写代码接入的 Node.js 方法';
    return;
  }

  const button = $('#provider-add');
  button.disabled = true;
  button.textContent = '识别中…';
  try {
    await api('/api/providers', {
      method: 'POST',
      body: JSON.stringify({
        name,
        kind,
        protocol,
        vendor,
        baseUrl,
        apiKey,
        code,
      }),
    });
    $('#provider-name').value = '';
    $('#provider-url').value = '';
    $('#provider-key').value = '';
    $('#provider-code').value = '';
    await loadProviders();
    toast('提供商已添加');
  } catch (error) {
    errorNode.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = '添加提供商';
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
  showPage('memory');
}

async function loadMemory() {
  try {
    state.memory = await api('/api/memory');
  } catch (error) {
    toast(error.message, 'error');
    return;
  }
  renderMemory();
  void loadAgent();
}

function renderMemory() {
  const data = state.memory;
  if (!data) return;
  const self = data.self;
  const size = formatBytes(self?.sizeBytes ?? 0);
  $('#self-path').textContent = self?.overLimit
    ? `${self.relativePath} · ${size} / 1 MiB（超出，需要删减）`
    : `${self?.relativePath ?? 'AI.md'} · ${size}`;
  const name = String(self?.name ?? '').trim();
  const headImage = String(self?.headImage ?? '').trim();
  $('#self-identity').textContent =
    name === ''
      ? '还没有解析到名字和头像路径。'
      : `名字：${name}　头像：${headImage === '' ? '未设置' : headImage}`;
  const selfPreview = $('#self-preview');
  selfPreview.textContent = self?.content?.trim()
    ? self.content
    : '还没有设定文件 (agent/AI.md)。发送 /self-md-update 或 /self-md-tell … 让 AI 创建。';
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/* ---------------- wiring ---------------- */

function currentDrawer() {
  return $('.sidebar').classList.contains('open') ? 'left' : null;
}

function syncDrawers(side) {
  const left = side === 'left';
  $('.sidebar').classList.toggle('open', left);
  $('#drawer-backdrop').classList.toggle('hidden', side === null);
  document.body.classList.toggle('drawer-open', side !== null);
  const leftButton = $('#toggle-sidebar');
  leftButton.setAttribute('aria-expanded', String(left));
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
  $('#drawer-backdrop').addEventListener('click', closeDrawers);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeDrawers();
      closeAgentMenu();
      hideCommandMenu();
    }
  });
  const desktop = window.matchMedia('(min-width: 901px)');
  desktop.addEventListener('change', (event) => {
    if (event.matches) closeDrawers();
  });

  $('#send').addEventListener('click', () => void sendMessage());
  $('#stop').addEventListener('click', () => void stopRun());

  const input = $('#input');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
    updateCommandMenu();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  });

  for (const item of document.querySelectorAll('.sidebar-nav [data-page]')) {
    item.addEventListener('click', () => {
      const page = item.dataset.page;
      if (page === 'skills') {
        state.skillsArea = 'main';
        if (state.page === 'skills') {
          renderHeader();
          void loadSkills();
        } else {
          showPage('skills');
        }
        return;
      }
      showPage(page);
    });
  }
  $('#agent-menu-button').addEventListener('click', (event) => {
    event.stopPropagation();
    setAgentMenu($('#agent-menu').classList.contains('hidden'));
  });
  for (const item of document.querySelectorAll('[data-agent-page]')) {
    item.addEventListener('click', () => {
      closeAgentMenu();
      if (item.dataset.agentPage === 'models') openModels();
      else if (item.dataset.agentPage === 'topics') showPage('topics');
      else if (item.dataset.agentPage === 'agent-skills') {
        state.skillsArea = 'agent';
        if (state.page === 'skills') {
          renderHeader();
          void loadSkills();
        } else {
          showPage('skills');
        }
      } else openMemory();
    });
  }
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.agent-card')) closeAgentMenu();
  });
  $('#topic-day-back').addEventListener('click', () => {
    location.hash = '#/topics';
  });
  for (const tab of document.querySelectorAll('[data-topic-tab]')) {
    tab.addEventListener('click', () => setTopicTab(tab.dataset.topicTab));
  }
  window.addEventListener('hashchange', () => showPage(pageFromHash(), false));
  $('#self-refresh').addEventListener('click', () => void loadMemory());
  $('#provider-protocol').addEventListener('change', () => updateProviderForm());
  $('#provider-vendor').addEventListener('change', () => {
    const vendor = currentProviderVendor();
    if (vendor !== undefined) $('#provider-url').value = vendor.baseUrl;
  });
  $('#provider-add').addEventListener('click', () => void addProvider());
  $('#model-select').addEventListener('change', (event) => void applyModel(event.target.value));

  setInterval(async () => {
    try {
      // Never rebuild the message list under an active turn: it would detach
      // the live stream and the UI would look frozen on the previous turn.
      if (state.pending !== null) return;
      if (state.live !== null) {
        const live = await api('/api/sessions/main');
        if (live.running !== true) await finishRun('main');
        return;
      }
      await loadConversation();
      // Also picks up turns started by /api/message, which have no local
      // optimistic bubble. Attach as soon as the broker reports them.
      if (state.runningIds.has('main')) {
        await attachLive('main');
      }
    } catch {
      // Polling is best-effort.
    }
  }, 2_000);
}

/* ---------------- skill code plugins ---------------- */

const pluginPages = {
  current: null,
};

const pluginBaseStyle = `
.kb-plugin-page {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: #f7f7f5;
  color: #202124;
  font-family: "Segoe UI", "Microsoft YaHei UI", sans-serif;
}
.kb-plugin-page-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 20px;
  border-bottom: 1px solid #e6e5e1;
  background: rgba(255,255,255,.92);
}
.kb-plugin-page-back {
  border: 0;
  border-radius: 8px;
  padding: 7px 11px;
  color: #3d3f42;
  background: #f0efeb;
  cursor: pointer;
}
.kb-plugin-page-title {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
}
.kb-plugin-page-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
`;

function closePluginPage(restoreHash = true) {
  const page = pluginPages.current;
  if (page === null) return;
  pluginPages.current = null;
  window.removeEventListener('hashchange', page.onHash);
  page.overlay.remove();
  document.documentElement.classList.remove('kb-plugin-open');
  if (restoreHash && location.hash === page.pageHash) {
    window.history.replaceState(null, '', page.previousHash || '#/chat');
  }
  try {
    page.onClose?.();
  } catch (error) {
    console.error('skill code close handler failed', error);
  }
}

/**
 * Open a full-screen page from a skill plugin.
 *
 * The page gets its own URL hash, so browser Back closes it and returns to the
 * previous KolorBot page. Render into `root`; everything is plain DOM.
 */
function openPluginPage(options = {}) {
  closePluginPage(false);
  const overlay = document.createElement('div');
  overlay.className = 'kb-plugin-page';
  overlay.dataset.pluginPage = String(options.id ?? 'page');

  const header = document.createElement('div');
  header.className = 'kb-plugin-page-header';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'kb-plugin-page-back';
  back.textContent = '← 返回';
  const title = document.createElement('h2');
  title.className = 'kb-plugin-page-title';
  title.textContent = String(options.title ?? '插件页面');
  header.append(back, title);

  const body = document.createElement('div');
  body.className = 'kb-plugin-page-body';
  overlay.append(header, body);

  const previousHash = location.hash || '#/chat';
  const pageHash = options.hash ?? `#/plugin/${encodeURIComponent(String(options.id ?? 'page'))}`;
  const page = {
    overlay,
    previousHash,
    pageHash,
    onHash: () => {
      if (location.hash !== pageHash) closePluginPage(false);
    },
    onClose: options.onClose,
  };
  pluginPages.current = page;
  back.addEventListener('click', () => closePluginPage(true));
  window.addEventListener('hashchange', page.onHash);
  document.documentElement.classList.add('kb-plugin-open');
  document.body.appendChild(overlay);
  if (location.hash !== pageHash) location.hash = pageHash;

  options.render?.(body);
  return {
    root: body,
    close: () => closePluginPage(true),
    setTitle: (value) => {
      title.textContent = String(value);
    },
  };
}

function addPluginStyle(css) {
  const style = document.createElement('style');
  style.dataset.skillCodeStyle = 'true';
  style.textContent = String(css);
  document.head.appendChild(style);
  return () => style.remove();
}

function addPluginScript(code) {
  const script = document.createElement('script');
  script.dataset.skillCodeScript = 'true';
  script.textContent = String(code);
  document.body.appendChild(script);
  return () => script.remove();
}

/**
 * Send a message and receive its SSE events directly.
 *
 * This is deliberately independent from the main chat renderer: a plugin page
 * can show text/tool progress in its own DOM while the server runs the same
 * turn in the usual RunBroker.
 */
async function selectGlobalModel(providerId = '', model = '') {
  const data = await api('/api/model', {
    method: 'PUT',
    body: JSON.stringify({
      providerId: String(providerId ?? ''),
      model: String(model ?? ''),
    }),
  });
  await loadProviders();
  return data.active;
}

async function pluginSendMessage(text, options = {}) {
  const value = String(text ?? '').trim();
  if (value === '') throw new Error('message must not be empty');
  if (options.providerId !== undefined || options.model !== undefined) {
    await selectGlobalModel(options.providerId ?? '', options.model ?? '');
  }
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: options.signal,
    body: JSON.stringify({ text: value }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error ?? `请求失败（${response.status}）`);
  }
  const events = [];
  let reply = '';
  let failure = '';
  await consumeStream(
    response,
    (event) => {
      events.push(event);
      if (event.type === 'text/delta' && typeof event.text === 'string') {
        reply += event.text;
      }
      emitPluginEvent(event, { sessionId: 'main', source: 'plugin' });
      try {
        options.onEvent?.(event);
      } catch (error) {
        console.error('skill code event handler failed', error);
      }
    },
    (message) => {
      failure = message;
    },
  );
  await loadConversation().catch(() => {});
  return { text: reply, events, error: failure === '' ? null : failure };
}

async function loadSkillCode() {
  let data;
  try {
    data = await api('/api/skill-code');
  } catch {
    return;
  }
  const skills = Array.isArray(data?.skills) ? data.skills : [];
  for (const skill of skills) {
    if (typeof skill?.url !== 'string') continue;
    try {
      const module = await import(`${skill.url}${skill.url.includes('?') ? '&' : '?'}v=${Date.now()}`);
      const activate = module.default ?? module.activate;
      if (typeof activate === 'function') {
        await activate(window.KolorBot);
      }
    } catch (error) {
      console.error(`skill code "${skill.id}" failed to load`, error);
    }
  }
}

const KolorBot = Object.freeze({
  version: '1.0',
  /** Full conversation object: topics, segments and stored messages. */
  async getConversation() {
    const data = await api('/api/conversation');
    return data.conversation;
  },
  /** Flat stored messages, newest last. */
  async getMessages() {
    const data = await api('/api/conversation');
    return data.conversation?.messages ?? [];
  },
  /** Available providers/models plus the currently active model. */
  async getModels() {
    return api('/api/providers');
  },
  /** Select the global model used by subsequent messages. */
  async selectModel(providerId = '', model = '') {
    return selectGlobalModel(providerId, model);
  },
  /** Persona name, raw head-image setting and a browser-usable avatar URL. */
  async getPersona() {
    const data = await api('/api/agent');
    return {
      name: String(data?.name ?? 'KolorBot'),
      headImage: String(data?.headImage ?? ''),
      avatarUrl: String(data?.avatarUrl ?? ''),
    };
  },
  /** Avatar image bytes, or null when the persona has no image. */
  async getAvatar() {
    const data = await api('/api/agent');
    const url = String(data?.avatarUrl ?? '');
    if (url === '') return null;
    try {
      const response = await fetch(url, { cache: 'no-store' });
      return response.ok ? await response.blob() : null;
    } catch {
      return null;
    }
  },
  /** Current in-page state snapshot (not a live reference). */
  getState() {
    return {
      page: state.page,
      currentTopic: state.currentTopic,
      conversation: state.conversation,
      running: state.running,
    };
  },
  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    pluginEventListeners.add(listener);
    return () => pluginEventListeners.delete(listener);
  },
  on(type, listener) {
    return this.subscribe((event) => {
      if (event?.type === type) listener(event);
    });
  },
  sendMessage: pluginSendMessage,
  navigate(hash) {
    const value = String(hash ?? '');
    if (!value.startsWith('#')) throw new Error('navigate requires a hash like "#/chat"');
    location.hash = value;
  },
  openPage: openPluginPage,
  closePage: () => closePluginPage(true),
  addStyle: addPluginStyle,
  addScript: addPluginScript,
  /** Set a global field for legacy scripts/plugins. */
  setGlobal(name, value) {
    const key = String(name ?? '');
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) throw new Error('invalid global name');
    window[key] = value;
    return () => {
      try { delete window[key]; } catch { window[key] = undefined; }
    };
  },
});

window.KolorBot = KolorBot;
addPluginStyle(pluginBaseStyle);

async function init() {
  wire();
  await loadProviders();
  await loadAgent();
  await loadConversation();
  showPage(pageFromHash(), false);
  if (state.runningIds.has('main')) await attachLive('main');
  void loadSkillCode();
}

void init();