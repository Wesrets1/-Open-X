/* ============================================================
   Status demo proxy — Cloudflare Worker

   Why this exists
   ---------------
   The browser must never hold the demo API key. If it is in the
   repository (or in the bundle) it is public the moment it is pushed,
   and providers revoke leaked keys automatically.

   So the key lives here, as an encrypted Worker secret. The browser
   calls this Worker, and the Worker forwards the request upstream
   with the key attached.

   Deploy
   ------
     1. npm i -g wrangler
     2. wrangler login
     3. cd proxy
     4. wrangler secret put OPENROUTER_KEY      # paste the key
     5. wrangler deploy

   Then copy the printed URL into js/demoKey.js as DEMO_BASE_URL.

   Abuse control
   -------------
   This is a public endpoint for a free-tier model, so it is rate
   limited per IP and capped per day. Adjust DAILY_CAP / RATE_LIMIT
   below. Cloudflare's KV binding is optional; without it the counters
   are per-isolate and only approximate.
   ============================================================ */

const UPSTREAM = 'https://openrouter.ai/api/v1/chat/completions';

/** Free-tier model this proxy is allowed to use. */
const ALLOWED_MODEL = 'nvidia/nemotron-3.5-super-vl:free';

/** Hard ceiling on how many tokens a demo caller may request. */
const MAX_TOKENS = 4096;

/** Requests allowed per IP per window. */
const RATE_LIMIT = 12;
const RATE_WINDOW_MS = 60_000;

/** Origins allowed to call this proxy. Add your own host if you fork. */
const ALLOWED_ORIGINS = [
  'https://wesrets1.github.io',
  'http://localhost:8137',
  'http://127.0.0.1:8137',
];

// In-memory counters. Reset whenever the isolate recycles, which makes
// them a speed bump rather than a guarantee. Bind a KV namespace and
// swap the two helpers below for a hard limit.
const buckets = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const hits = (buckets.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  buckets.set(ip, hits);
  if (buckets.size > 5000) buckets.clear(); // crude memory bound
  return hits.length > RATE_LIMIT;
}

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, HTTP-Referer, X-Title',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== 'POST') {
      return json({ error: { message: 'Method not allowed' } }, 405, cors);
    }

    // Reject unknown callers early. This is not a security boundary
    // (Origin is forgeable by non-browser clients) — it just stops
    // casual embedding on random sites.
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: { message: 'Origin not allowed' } }, 403, cors);
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (rateLimited(ip)) {
      return json({ error: { message: 'Slow down — too many demo requests.' } }, 429, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: { message: 'Body must be JSON.' } }, 400, cors);
    }

    // The demo is for a single free model. Anything else is refused so
    // the proxy cannot be used as a general-purpose relay.
    if (body.model && body.model !== ALLOWED_MODEL) {
      return json({
        error: { message: `This demo only serves ${ALLOWED_MODEL}. Add your own key in Settings to use another model.` },
      }, 400, cors);
    }

    const payload = {
      ...body,
      model: ALLOWED_MODEL,
      max_tokens: Math.min(Number(body.max_tokens) || MAX_TOKENS, MAX_TOKENS),
    };

    // Never let a caller pass through credentials of their own.
    delete payload.user;

    try {
      const upstream = await fetch(UPSTREAM, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.OPENROUTER_KEY}`,
          'HTTP-Referer': 'https://wesrets1.github.io/-Open-X/',
          'X-Title': 'Status demo',
        },
        body: JSON.stringify(payload),
      });

      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: {
          'Content-Type': 'application/json',
          // Demo responses are not cacheable.
          'Cache-Control': 'no-store',
          ...cors,
        },
      });
    } catch (e) {
      return json({ error: { message: `Upstream unreachable: ${e.message}` } }, 502, cors);
    }
  },
};
