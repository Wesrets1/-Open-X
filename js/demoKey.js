/* ============================================================
   demoKey.js — shared demo credentials

   This is a deliberately public, spend-capped OpenRouter key used
   so a first-time visitor can see the sim working with a real
   endpoint before they configure their own.

   WHY THIS IS SAFE-ISH:
     • The key is hard-capped at $1 of credit on OpenRouter.
     • The model it points at is a :free tier, so it costs $0.
     • It is DEMO ONLY. Everything the player configures themselves
       always takes precedence, and nothing user-specific is sent.

   WHY IT IS STILL A TRADE-OFF:
     • Anyone can read this file and use the key. That is expected.
     • It can be revoked at any time from the OpenRouter dashboard,
       which will simply make the demo fall back to offline mode.

   Treat it as a public resource, never as a secret.
   ============================================================ */

/** Public demo endpoint — OpenRouter's OpenAI-compatible API. */
export const DEMO_BASE_URL = 'https://openrouter.ai/api/v1';

/** Public demo model. Free tier, so demo usage costs nothing. */
export const DEMO_MODEL = 'nvidia/nemotron-3.5-super-vl:free';

/**
 * Spend-capped public demo key.
 *
 * Left blank on purpose. GitHub push protection blocks committed
 * OpenRouter keys, and evading the scanner by splitting or encoding the
 * value would undermine a real security control.
 *
 * To enable the shared demo, pick one:
 *   1. Paste the key here and allow it once at
 *      github.com/<owner>/<repo>/security/secret-scanning
 *   2. Deploy a tiny proxy that injects the key server-side
 *   3. Leave it blank — the app then runs in offline demo mode
 */
export const DEMO_API_KEY = '';

/**
 * True when a config is falling back to the built-in demo endpoint
 * rather than using a key the player supplied.
 */
export function isUsingDemoKey(cfg) {
  return !!cfg && cfg.apiKey === DEMO_API_KEY;
}

/** Read-only summary for the Settings panel. */
export function demoKeyStatus(cfg) {
  if (!cfg) return { demo: false };
  const using = isUsingDemoKey(cfg);
  return {
    demo: using,
    model: using ? cfg.model : null,
    // Show only the tail so the panel never renders the whole key.
    tail: using ? DEMO_API_KEY.slice(-6) : null,
  };
}
