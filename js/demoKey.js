/* ============================================================
   demoKey.js — shared demo endpoint

   The browser never holds a real API key. A small Cloudflare Worker
   (see /proxy) keeps the key server-side and forwards requests
   upstream. This file only knows the Worker's public URL.

   Why not embed the key?
     It was tried. OpenRouter detected the published key and revoked it
     within minutes, which silently broke the demo for everyone. A key
     that reaches a browser is public by definition.

   To enable the shared demo:
     1. Deploy /proxy (see proxy/README.md)
     2. Paste the Worker URL below

   While DEMO_BASE_URL is empty, first-time visitors enter their own
   endpoint, which is the honest default.
   ============================================================ */

/**
 * Public URL of the demo proxy Worker.
 * Example: 'https://status-demo-proxy.your-name.workers.dev'
 * Leave empty to disable the shared demo.
 */
export const DEMO_BASE_URL = '';

/** Model the proxy is configured to serve. */
export const DEMO_MODEL = 'nvidia/nemotron-3.5-super-vl:free';

/**
 * Placeholder sent as the bearer token. The Worker discards it and
 * substitutes the real key, so this value is not a secret.
 */
export const DEMO_TOKEN = 'proxy';

/** True when a shared demo endpoint has been configured. */
export function hasDemoEndpoint() {
  return !!DEMO_BASE_URL;
}

/**
 * True when a config is falling back to the shared demo proxy rather
 * than using a key the player supplied.
 */
export function isUsingDemoKey(cfg) {
  if (!cfg || !hasDemoEndpoint()) return false;
  const own = (cfg.apiKey || '').trim();
  return !own || own === DEMO_TOKEN;
}

/** Read-only summary for the Settings panel. */
export function demoKeyStatus(cfg) {
  return {
    demo: isUsingDemoKey(cfg),
    available: hasDemoEndpoint(),
    model: isUsingDemoKey(cfg) ? DEMO_MODEL : null,
  };
}
