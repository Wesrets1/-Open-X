# Demo proxy

A Cloudflare Worker that sits between the browser and OpenRouter so the
demo API key never ships to the client.

## Why

The app used to embed a public demo key. Any key in a public repository is
exposed the moment it is pushed — OpenRouter revoked it automatically, which
broke the demo. The key now lives in a Worker secret instead.

## Deploy

```bash
npm i -g wrangler
wrangler login
cd proxy
wrangler secret put OPENROUTER_KEY   # paste the key when prompted
wrangler deploy
```

Wrangler prints a URL like:

```
https://status-demo-proxy.<your-subdomain>.workers.dev
```

## Point the app at it

In `js/demoKey.js`:

```js
export const DEMO_BASE_URL = 'https://status-demo-proxy.<you>.workers.dev';
export const DEMO_MODEL = 'nvidia/nemotron-3.5-super-vl:free';
export const DEMO_API_KEY = 'proxy';   // placeholder, never used upstream
```

The client sends `Bearer proxy`; the Worker discards it and substitutes the
real key. Nothing secret is in the repository.

Also add your Pages origin to `ALLOWED_ORIGINS` in `worker.js`.

## Limits

| Setting | Default | Purpose |
|---|---|---|
| `ALLOWED_MODEL` | `nvidia/nemotron-3.5-super-vl:free` | Proxy refuses any other model |
| `MAX_TOKENS` | 4096 | Caps per-request cost |
| `RATE_LIMIT` | 12 / minute / IP | Basic abuse control |

The rate limiter uses in-memory counters, which reset when the isolate
recycles. That is a speed bump, not a guarantee. For a hard limit, bind a KV
namespace and store counters there — or set a spend cap on the upstream key,
which is the real backstop.

## Test locally

```bash
wrangler dev --local
curl -X POST http://localhost:8787 \
  -H 'Content-Type: application/json' \
  -d '{"model":"nvidia/nemotron-3.5-super-vl:free","messages":[{"role":"user","content":"say ok"}],"max_tokens":200}'
```
