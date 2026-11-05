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

There is **no rate limit and no token cap**. The model is free, so the only
real ceiling is OpenRouter's own free-tier quota. Model pinning is what stops
this being a general-purpose relay.

`max_tokens` is passed through to the caller untouched. Note that this model is
a reasoning model: a tight `max_tokens` can be consumed entirely by internal
reasoning and return `content: null` with `finish_reason: "length"`.

## Test locally

`wrangler dev` reads secrets from `.dev.vars`, **not** from your shell
environment. Create `proxy/.dev.vars` (already gitignored):

```
OPENROUTER_KEY=sk-or-v1-...
```

Then:

```bash
wrangler dev --local --port 8788
curl -X POST http://127.0.0.1:8788 \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://localhost:8137' \
  -d '{"model":"nvidia/nemotron-3.5-super-vl:free","messages":[{"role":"user","content":"say ok"}],"max_tokens":300}'
```

## Deploying without an account

If `wrangler login` is not an option, wrangler can create a throwaway
account:

```bash
wrangler deploy --temporary --secrets-file .dev.vars
```

This prints a `claim URL` and a working `*.workers.dev` URL immediately.

> **The temporary account expires.** Wrangler reports a claim window
> (60 minutes). Open the claim URL and attach the Worker to a real
> Cloudflare account, or the demo endpoint will stop resolving. Once
> claimed, redeploy normally with `wrangler deploy` and rotate the key
> with `wrangler secret put OPENROUTER_KEY`.
