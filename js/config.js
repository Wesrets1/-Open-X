/* ============================================================
   config.js — endpoint settings + defaults
   ============================================================ */

import { store } from './util.js';
import { DEMO_TOKEN, DEMO_BASE_URL, DEMO_MODEL, hasDemoEndpoint } from './demoKey.js';

const CONFIG_KEY = 'status.config.v1';

export const PRESETS = {
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'google/gemini-2.0-flash-001',
    cheapModel: 'meta-llama/llama-3.3-70b-instruct',
    fastModel: 'google/gemini-2.0-flash-001',
    headers: {},
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    cheapModel: 'gpt-4o-mini',
    fastModel: 'gpt-4o-mini',
    headers: {},
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.2',
    cheapModel: 'llama3.2',
    fastModel: 'llama3.2',
    headers: {},
  },
  custom: {
    id: 'custom',
    label: 'Custom endpoint',
    baseUrl: '',
    model: '',
    cheapModel: '',
    fastModel: '',
    headers: {},
  },
};

export const DEFAULTS = {
  preset: 'openrouter',
  baseUrl: PRESETS.openrouter.baseUrl,
  apiKey: '',
  model: PRESETS.openrouter.model,
  cheapModel: PRESETS.openrouter.cheapModel,
  fastModel: PRESETS.openrouter.fastModel,
  extraHeaders: '',
  temperature: 0.9,
  maxTokens: 600,
  streaming: false,

  /* `demoMode: true` means "opt out of the shared demo key". The app never
     generates content without a model: with no key and no demo key it
     falls back to the deterministic generator and tells you so.
     `demoEndpoint` allows the shared public key as a fallback. */
  demoMode: false,
  demoEndpoint: true,

  // call-optimisation knobs
  optimise: {
    enabled: true,
    cacheSeconds: 300,        // reuse identical requests within N seconds
    batchWorldEvents: true,   // one call generates many world events
    localFirst: true,         // resolve simple intents without a request
    maxCallsPerAction: 1,     // hard cap per user action
    coalesceWindowMs: 400,    // merge rapid identical triggers
    summariseAfter: 24,       // compact history past N messages
  },

  // game feel
  pace: 'normal',          // chill | normal | chaotic
  autonomy: true,          // NPCs act on their own
  nsfw: false,
  contentRating: '12+',

  // display
  display: {
    nav: 'auto',           // auto | bottom | side
    reduceMotion: false,
  },
};

let _config = null;

export function getConfig() {
  if (_config) return _config;
  const saved = store.get(CONFIG_KEY, {});
  _config = {
    ...DEFAULTS,
    ...saved,
    optimise: { ...DEFAULTS.optimise, ...(saved.optimise || {}) },
    display: { ...DEFAULTS.display, ...(saved.display || {}) },
  };
  return _config;
}

export function saveConfig(patch = {}) {
  const next = {
    ...getConfig(),
    ...patch,
    optimise: { ...getConfig().optimise, ...(patch.optimise || {}) },
    display: { ...getConfig().display, ...(patch.display || {}) },
  };
  _config = next;
  store.set(CONFIG_KEY, next);
  return next;
}

export function resetConfig() {
  _config = {
    ...DEFAULTS,
    optimise: { ...DEFAULTS.optimise },
    display: { ...DEFAULTS.display },
  };
  store.set(CONFIG_KEY, _config);
  return _config;
}

/**
 * The effective endpoint settings, with the shared demo proxy
 * substituted when the player has not supplied their own key.
 *
 * Precedence:
 *   1. A key the player entered       → use exactly what they set
 *   2. No key + a demo proxy deployed → the proxy, which holds the key
 *   3. Nothing                        → the caller has no endpoint
 */
export function resolveEndpoint(cfg = getConfig()) {
  const hasOwnKey = !!(cfg.apiKey && cfg.apiKey.trim() && cfg.apiKey.trim() !== DEMO_TOKEN);
  if (hasOwnKey) {
    return {
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      cheapModel: cfg.cheapModel || cfg.model,
      fastModel: cfg.fastModel || cfg.model,
      preset: cfg.preset,
      shared: false,
    };
  }

  if (cfg.demoEndpoint === false || !hasDemoEndpoint()) {
    return {
      baseUrl: cfg.baseUrl,
      apiKey: '',
      model: cfg.model,
      cheapModel: cfg.cheapModel || cfg.model,
      fastModel: cfg.fastModel || cfg.model,
      preset: cfg.preset,
      shared: false,
    };
  }

  // The proxy holds the real credential; this token is a placeholder it
  // discards. Nothing secret reaches the browser.
  return {
    baseUrl: DEMO_BASE_URL,
    apiKey: DEMO_TOKEN,
    model: DEMO_MODEL,
    cheapModel: DEMO_MODEL,
    fastModel: DEMO_MODEL,
    preset: 'custom',
    shared: true,
  };
}

/** Is the app currently borrowing the shared demo credential? */
export function usingSharedDemo(cfg = getConfig()) {
  return resolveEndpoint(cfg).shared;
}

/** True when there is any way to reach a real endpoint. */
export function isConfigured(cfg = getConfig()) {
  if (cfg.demoMode) return false;
  const ep = resolveEndpoint(cfg);
  return !!(ep.baseUrl && ep.apiKey);
}

/**
 * Is the app currently unable to reach any model?
 * In that state the deterministic generator is used and the UI must
 * say so, rather than implying it "works offline by design".
 */
export function isDegraded(cfg = getConfig()) {
  return cfg.demoMode || !isConfigured(cfg);
}

export function applyPreset(id) {
  const p = PRESETS[id];
  if (!p) return getConfig();
  return saveConfig({
    preset: id,
    baseUrl: p.baseUrl || getConfig().baseUrl,
    model: p.model || getConfig().model,
    cheapModel: p.cheapModel || p.model || getConfig().cheapModel,
    fastModel: p.fastModel || p.model || getConfig().fastModel,
  });
}

export function parseExtraHeaders(raw) {
  const out = {};
  if (!raw || !raw.trim()) return out;
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 1) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}
