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
   Deliberately unlimited: no rate limit and no token cap. The model is
   free, so the only real ceiling is OpenRouter's own free-tier quota.
   The Worker still pins the model, which is what stops it being used as
   a general-purpose relay.
   ============================================================ */

const UPSTREAM = 'https://openrouter.ai/api/v1/chat/completions';

/** Free-tier model this proxy is allowed to use. */
const ALLOWED_MODEL = 'nvidia/nemotron-3.5-super-vl:free';

/** Origins allowed to call this proxy. Add your own host if you fork. */
const ALLOWED_ORIGINS = [
  'https://wesrets1.github.io',
  'http://localhost:8137',
  'http://127.0.0.1:8137',
];

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

    // max_tokens is passed through untouched — the caller decides its own
    // budget. This also matters for reasoning models, where a tight cap can
    // be consumed entirely by internal reasoning and return empty content.
    const payload = {
      ...body,
      model: ALLOWED_MODEL,
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
