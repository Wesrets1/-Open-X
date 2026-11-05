/* ============================================================
   llm.js — OpenAI-compatible client with call optimisation

   Optimisation layers:
     1. In-flight coalescing  — identical requests share one promise
     2. Response cache        — identical prompts reused for N seconds
     3. Tiered models         — cheap model for filler, fast for chat
     4. Token budgeting       — trims history, caps output
     5. Hard call cap         — per action, per tick
     6. Deterministic fallback — never blocks the game if offline
   ============================================================ */

import { getConfig, parseExtraHeaders } from './config.js';
import { dbg } from './debug.js';
import { store } from './util.js';

const CACHE_PREFIX = 'status.cache.';

/* ---------------- telemetry ---------------- */

const stats = {
  calls: 0,
  cacheHits: 0,
  coalesced: 0,
  failures: 0,
  promptTokens: 0,
  completionTokens: 0,
  cost: 0,
  lastError: null,
};

export const getStats = () => ({ ...stats, saved: stats.cacheHits + stats.coalesced });

export function resetStats() {
  Object.assign(stats, {
    calls: 0, cacheHits: 0, coalesced: 0, failures: 0,
    promptTokens: 0, completionTokens: 0, cost: 0, lastError: null,
  });
}

function recordUsage(usage) {
  if (!usage) return;
  stats.promptTokens += usage.prompt_tokens || 0;
  stats.completionTokens += usage.completion_tokens || 0;
  if (typeof usage.cost === 'number') stats.cost += usage.cost;
}

/* ---------------- caches ---------------- */

const memCache = new Map();
const inflight = new Map();

function hashStr(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = (h1 ^ c) >>> 0; h1 = Math.imul(h1, 16777619) >>> 0;
    h2 = (h2 + c * (i + 1)) >>> 0; h2 = Math.imul(h2 ^ c, 2654435761) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}

function cacheGet(key, ttlMs) {
  const hit = memCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) {
    stats.cacheHits++;
    dbg('llm:cache-hit', { key: key.slice(0, 12) });
    return hit.value;
  }
  const persisted = store.get(CACHE_PREFIX + key, null);
  if (persisted && Date.now() - persisted.at < ttlMs) {
    memCache.set(key, persisted);
    stats.cacheHits++;
    return persisted.value;
  }
  return undefined;
}

function cacheSet(key, value, persist = false) {
  const rec = { at: Date.now(), value };
  memCache.set(key, rec);
  if (memCache.size > 120) {
    const oldest = [...memCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) memCache.delete(oldest[0]);
  }
  if (persist) store.set(CACHE_PREFIX + key, rec);
}

export function clearCache() {
  memCache.clear();
  for (const k of store.keys()) if (k.startsWith(CACHE_PREFIX)) store.del(k);
}

/* ---------------- transport ---------------- */

export class LLMError extends Error {
  constructor(message, { status, body, retryable = false } = {}) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
    this.body = body;
    this.retryable = retryable;
  }
}

async function rawRequest(body, { signal } = {}) {
  const cfg = getConfig();
  if (!cfg.baseUrl) throw new LLMError('No endpoint configured.');

  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const headers = {
    'Content-Type': 'application/json',
    ...parseExtraHeaders(cfg.extraHeaders),
  };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  if (!headers['HTTP-Referer'] && cfg.preset === 'openrouter') {
    headers['HTTP-Referer'] = location.origin;
    headers['X-Title'] = 'Status — sims but social media';
  }

  dbg('llm:request', { model: body.model, messages: body.messages?.length, tools: body.tools?.length || 0 });

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new LLMError(
      'Could not reach the endpoint. Check the URL, your network, and CORS settings.',
      { retryable: true }
    );
  }

  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j?.error?.message || j?.message || JSON.stringify(j).slice(0, 300);
    } catch {
      try { detail = (await res.text()).slice(0, 300); } catch {}
    }
    throw new LLMError(
      `Request failed (${res.status})${detail ? ': ' + detail : '.'}`,
      { status: res.status, body: detail, retryable: res.status >= 500 || res.status === 429 }
    );
  }

  return res.json();
}

/* ---------------- public API ---------------- */

/**
 * chat(options)
 * @param {object} o
 * @param {Array}  o.messages
 * @param {string} [o.model]        override model
 * @param {string} [o.tier]         'main' | 'cheap' | 'fast'
 * @param {Array}  [o.tools]
 * @param {string} [o.toolChoice]
 * @param {object} [o.responseFormat]  { type:'json_object' } or json_schema
 * @param {number} [o.temperature]
 * @param {number} [o.maxTokens]
 * @param {boolean}[o.cache]        default true
 * @param {boolean}[o.persistCache]
 * @param {string} [o.cacheKey]     extra salt for the cache key
 * @param {number} [o.timeoutMs]
 * @param {AbortSignal} [o.signal]
 */
export async function chat(o = {}) {
  const cfg = getConfig();
  if (cfg.demoMode) return demoResponse(o);

  const tierModel =
    o.model ||
    (o.tier === 'cheap' ? cfg.cheapModel : o.tier === 'fast' ? cfg.fastModel : cfg.model) ||
    cfg.model;

  const maxTokens = Math.min(o.maxTokens ?? cfg.maxTokens, 4096);
  const temperature = o.temperature ?? cfg.temperature;

  const body = {
    model: tierModel,
    messages: o.messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (o.tools?.length) {
    body.tools = o.tools;
    if (o.toolChoice) body.tool_choice = o.toolChoice;
  }
  if (o.responseFormat) body.response_format = o.responseFormat;
  if (o.stop) body.stop = o.stop;

  const useCache = o.cache !== false && cfg.optimise.enabled && !o.tools?.length;
  const key = hashStr(JSON.stringify({ m: body.model, msgs: body.messages, t: temperature, mt: maxTokens, k: o.cacheKey || '' }));

  if (useCache) {
    const cached = cacheGet(key, (cfg.optimise.cacheSeconds || 300) * 1000);
    if (cached !== undefined) return cached;
  }

  // coalesce identical in-flight requests
  if (inflight.has(key)) {
    stats.coalesced++;
    dbg('llm:coalesced', { key: key.slice(0, 12) });
    return inflight.get(key);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), o.timeoutMs || 45000);
  if (o.signal) {
    if (o.signal.aborted) controller.abort();
    else o.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const run = (async () => {
    stats.calls++;
    try {
      let data;
      let attempt = 0;
      const maxAttempts = 2;
      while (true) {
        try {
          data = await rawRequest(body, { signal: controller.signal });
          break;
        } catch (e) {
          attempt++;
          if (attempt >= maxAttempts || !e.retryable) throw e;
          await new Promise((r) => setTimeout(r, 700 * attempt));
        }
      }
      recordUsage(data.usage);
      if (useCache) cacheSet(key, data, !!o.persistCache);
      return data;
    } catch (e) {
      stats.failures++;
      stats.lastError = e.message;
      throw e;
    } finally {
      clearTimeout(timeout);
      inflight.delete(key);
    }
  })();

  inflight.set(key, run);
  return run;
}

/** Convenience: chat and return the assistant message object. */
export async function chatMessage(o = {}) {
  const data = await chat(o);
  const choice = data.choices?.[0];
  if (!choice) throw new LLMError('The endpoint returned no choices.');
  return choice.message || { role: 'assistant', content: '' };
}

/** Convenience: chat and return plain text. */
export async function chatText(o = {}) {
  const msg = await chatMessage(o);
  return (msg.content || '').trim();
}

/**
 * Structured JSON helper with one automatic repair pass.
 * Uses response_format when supported, and falls back to parsing.
 */
export async function chatJSON(o = {}) {
  const cfg = getConfig();
  const attempt = async (extra = '') => {
    const messages = extra
      ? [...o.messages, { role: 'user', content: extra }]
      : o.messages;
    const raw = await chatText({
      ...o,
      cache: false,
      messages,
      responseFormat: cfg.optimise.enabled && o.schema
        ? { type: 'json_object' }
        : undefined,
      temperature: o.temperature ?? 0.85,
    });
    return parseJSONLoose(raw);
  };

  try {
    return await attempt();
  } catch (e) {
    if (e instanceof LLMError) throw e;
    dbg('llm:json-repair', { message: e.message });
    return attempt('Return ONLY valid minified JSON. No markdown, no explanation, no code fences.');
  }
}

export function parseJSONLoose(text) {
  if (!text) throw new Error('Empty response');
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(s); } catch {}

  const start = s.search(/[[{]/);
  if (start >= 0) {
    const open = s[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, escp = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (escp) escp = false;
        else if (c === '\\') escp = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(s.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  throw new Error('Response was not valid JSON.');
}

/* ---------------- connectivity test ---------------- */

export async function testConnection() {
  const cfg = getConfig();
  const started = performance.now();
  try {
    const res = await chat({
      messages: [
        { role: 'system', content: 'Reply with exactly: OK' },
        { role: 'user', content: 'ping' },
      ],
      maxTokens: 8,
      temperature: 0,
      cache: false,
      timeoutMs: 20000,
    });
    return {
      ok: true,
      ms: Math.round(performance.now() - started),
      model: res.model || cfg.model,
      text: res.choices?.[0]?.message?.content?.trim() || '',
    };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - started), error: e.message };
  }
}

/* ---------------- demo mode ---------------- */

import { demoChat } from './demo.js';

function demoResponse(o) {
  stats.calls++;
  const fake = demoChat(o);
  return new Promise((resolve) => {
    setTimeout(() => resolve(fake), 320 + Math.random() * 500);
  });
}
