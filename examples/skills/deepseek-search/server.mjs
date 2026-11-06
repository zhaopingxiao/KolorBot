#!/usr/bin/env node
/**
 * DeepSeek Search / Fetch MCP server.
 *
 * Exposes two tools:
 *   - search: POST /v1/tools/search
 *   - fetch:  POST /v1/tools/fetch
 *
 * The server speaks newline-delimited JSON-RPC over stdio (MCP) and has no
 * third-party dependencies, so it can live inside a skill directory.
 */
import { createInterface } from 'node:readline';

const SERVER_INFO = { name: 'deepseek-search', version: '0.1.0' };
const API_BASE = (process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com').replace(/\/+$/, '');
const API_KEY = (process.env.DEEPSEEK_API_KEY || process.env.KOLOR_API_KEY || '').trim();

const SEARCH_TOOL = {
  name: 'search',
  description:
    'Search the web with DeepSeek Search. Returns ranked results with title, URL, summary, date, authority, and optional page content. ' +
    'Use this for up-to-date facts, then cite the returned URLs. Supports operators: site:, -site:, "exact phrase", lang:, after:, before:, -word.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: {
        type: 'string',
        description: 'Search query, 1-128 characters. Search operators are supported.',
      },
      count: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Number of results to return. Default 5, max 50.',
      },
      need_content: {
        type: 'boolean',
        description: 'Include page body content in each result. Default false; use fetch for full articles.',
      },
      ori_question: {
        type: 'string',
        description: 'Optional original user question (max 128 chars) to improve search intent.',
      },
    },
    required: ['query'],
  },
};

const FETCH_TOOL = {
  name: 'fetch',
  description:
    'Fetch a single web page as Markdown with DeepSeek Fetch. Use it after search when the summary is not enough, or when the user gives a URL. ' +
    'Content is clipped to max_chars; raise it if you need more.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      url: {
        type: 'string',
        description: 'HTTP or HTTPS URL of the page to fetch.',
      },
      max_chars: {
        type: 'integer',
        minimum: 1000,
        maximum: 50000,
        description: 'Maximum characters of Markdown to return. Default 12000, max 50000.',
      },
    },
    required: ['url'],
  },
};

const TOOLS = [SEARCH_TOOL, FETCH_TOOL];

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const text = line.trim();
  if (text === '') return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    process.stderr.write('deepseek-search: invalid JSON-RPC line\n');
    return;
  }
  void handleMessage(message);
});
rl.on('close', () => process.exit(0));

async function handleMessage(message) {
  if (!isRecord(message) || typeof message.method !== 'string') return;
  const { id, method, params } = message;

  if (id === undefined) {
    // notifications/initialized and similar notifications need no response
    return;
  }

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

async function handleToolCall(id, params) {
  const name = isRecord(params) && typeof params.name === 'string' ? params.name : '';
  const args = isRecord(params) && isRecord(params.arguments) ? params.arguments : {};

  try {
    let text;
    if (name === 'search') {
      text = await runSearch(args);
    } else if (name === 'fetch') {
      text = await runFetch(args);
    } else {
      throw new Error(`Unknown tool "${name}"`);
    }
    sendResult(id, { content: [{ type: 'text', text }] });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    sendResult(id, { content: [{ type: 'text', text: `Error: ${text}` }], isError: true });
  }
}

async function runSearch(args) {
  const query = requireString(args, 'query').trim();
  if (query === '') throw new Error('query must not be empty');
  if (unicodeLength(query) > 128) throw new Error('query must be at most 128 characters');

  const count = optionalInt(args, 'count', 5, 1, 50);
  const needContent = args.need_content === true;
  const payload = { query, count, need_content: needContent };

  if (args.ori_question !== undefined && args.ori_question !== null) {
    if (typeof args.ori_question !== 'string') throw new Error('ori_question must be a string');
    const question = args.ori_question.trim();
    if (question !== '') {
      if (unicodeLength(question) > 128) {
        throw new Error('ori_question must be at most 128 characters');
      }
      payload.ori_question = question;
    }
  }

  const data = await apiPost('/v1/tools/search', payload);
  return formatSearchResults(query, data, needContent);
}

async function runFetch(args) {
  const url = requireHttpUrl(args, 'url');
  const maxChars = optionalInt(args, 'max_chars', 12000, 1000, 50000);
  const data = await apiPost('/v1/tools/fetch', { url });
  const content = typeof data.content === 'string' ? data.content : '';
  if (content.trim() === '') throw new Error('Fetch returned no readable content');
  const title = typeof data.title === 'string' && data.title.trim() !== '' ? data.title : '(untitled)';
  return [`# ${title}`, `URL: ${url}`, '', clip(content, maxChars)].join('\n');
}

function formatSearchResults(query, data, needContent) {
  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length === 0) return `No results for "${query}".`;

  const lines = [`Search results for "${query}" (${results.length}):`];
  results.forEach((result, index) => {
    if (!isRecord(result)) return;
    const title = typeof result.title === 'string' ? result.title : '(untitled)';
    const url = typeof result.url === 'string' ? result.url : '';
    lines.push('', `${index + 1}. ${title}`, `   URL: ${url}`);

    const meta = [];
    if (typeof result.site_name === 'string' && result.site_name) meta.push(result.site_name);
    if (typeof result.date === 'string' && result.date) meta.push(result.date);
    if (typeof result.rerank_score === 'number') meta.push(`score ${result.rerank_score}`);
    if (typeof result.authority === 'number' && result.authority >= 0) {
      meta.push(`authority ${result.authority}`);
    }
    if (meta.length > 0) lines.push(`   ${meta.join(' · ')}`);

    if (typeof result.summary === 'string' && result.summary.trim() !== '') {
      lines.push(`   Summary: ${result.summary.trim()}`);
    } else if (typeof result.snippet === 'string' && result.snippet.trim() !== '') {
      lines.push(`   Snippet: ${result.snippet.trim()}`);
    }

    if (needContent && typeof result.content === 'string' && result.content.trim() !== '') {
      lines.push('   Content excerpt:');
      lines.push(indent(clip(result.content.trim(), 1500), '   '));
    }
  });
  lines.push('', 'Cite the URLs you use. Use fetch on a URL if you need the full article.');
  return lines.join('\n');
}

async function apiPost(path, payload) {
  if (API_KEY === '') {
    throw new Error(
      'DeepSeek API key is missing. Set DEEPSEEK_API_KEY (or KOLOR_API_KEY) in the environment that starts kolor-web.',
    );
  }

  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        await sleep(800);
        continue;
      }
      throw new Error(`DeepSeek request failed: ${error instanceof Error ? error.message : error}`);
    }

    const text = await response.text();
    let data = null;
    try {
      data = text === '' ? null : JSON.parse(text);
    } catch {
      data = null;
    }

    if (response.ok) {
      if (data === null) throw new Error('DeepSeek returned a non-JSON response');
      return data;
    }

    const message =
      (isRecord(data) && isRecord(data.error) && typeof data.error.message === 'string'
        ? data.error.message
        : text.slice(0, 500)) || response.statusText;

    if ((response.status === 408 || response.status === 429 || response.status >= 500) && attempt === 0) {
      await sleep(800);
      continue;
    }
    throw new Error(`DeepSeek API ${response.status}: ${message}`);
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function requireString(args, key) {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function optionalInt(args, key, fallback, min, max) {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function requireHttpUrl(args, key) {
  const raw = requireString(args, key).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${key} must be a valid HTTP/HTTPS URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${key} must use http or https`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(`${key} must not contain credentials`);
  }
  return raw;
}

function clip(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n… [truncated ${text.length - max} characters]`;
}

function indent(text, prefix) {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function unicodeLength(text) {
  return Array.from(text).length;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
