# Status — sims but social media

A local-first social-media life sim that runs entirely in the browser and is driven by **your own OpenAI-compatible endpoint**. OpenRouter works out of the box.

No build step. No backend. No account. Deploy the folder to any static host — GitHub Pages included.

---

## What it is

You play a person on a social app. You post, reply, and DM a small cast of characters who have their own archetypes, opinions of you, and lives that continue while you're away.

Everything — your world, your saves, your API key — stays in your browser's `localStorage`.

---

## Features

**The sim**
- Twitter-style timeline: flat posts, expanded threads, replies, likes
- Persona profiles with relationship state you can inspect
- DM threads with per-character memory, mood, patience and grudges
- Followers, clout, money, posting streaks
- **No action limits** — post, reply and message as much as you like
- Autonomous NPC activity on a timer (chill / normal / chaotic)
- **Reactive character agency** — see below

**Multiple worlds**
- Six built-in premises: Modern Life, Campus, Hollow Creek, Orbit Station, The Fandom, The Roastery
- Each world has its own cast, premise, timeline and save
- Generate a custom world by describing it in one sentence
- Add, edit or remove personas at any time — by hand or generated
- Switch or delete worlds without losing any timeline

**The endpoint layer**
- Any OpenAI-compatible `/chat/completions` API
- Presets for OpenRouter, OpenAI, Ollama, or a custom URL
- Separate main / cheap / fast model tiers
- Custom headers, live connection test, cost + token telemetry

**Responsive layout**
- The app always fills the screen — no frame, no scaling, no density mode
- Automatic nav orientation: bottom bar on portrait phones, vertical side rail in landscape, on desktop, and on an opened foldable
- Directional view transitions that follow the nav axis
- Optional manual override in Settings → Display (defaults to Automatic)
- Reduce-motion toggle

---

## Reactive character agency

This is the core of the sim, and it is deliberately **not** a generic
"write a reply from somebody" prompt.

The player is one ordinary user. Everyone else is an agent with independent
state: `mood`, `patience`, `attention`, `grudge`, topic `interests`, and a short
`memory` of what the player has done.

1. A player action emits a **stimulus** — a post, reply, or DM.
2. Every character **perceives** it and scores relevance locally, for free:
   - Were they mentioned, or is it their post you replied under?
   - Does the topic intersect with what they care about?
   - Are they invested (high affinity) or watching closely (low affinity)?
   - Do they have the bandwidth, or are they busy / sulking?
3. Only characters above a relevance threshold get a generation pass — and they
   get it with **their own state attached**, so the reply follows from who they
   are, not from what would be convenient.

Consequences:

- A rival with a grudge replies coldly. A stan replies warmly. A brand account
  ignores it entirely.
- Silence is a valid outcome. Not everyone responds to everything.
- Impersonation is rejected: the engine refuses any tool call where a character
  speaks as someone who wasn't selected.
- Most ticks cost **zero endpoint calls**, because perception is local math.

The same machinery drives unprompted activity: characters post and message you
based on mood, archetype and how recently they last spoke.

**Call optimisation**
- **In-flight coalescing** — identical requests share one promise
- **Response cache** — configurable window, memory + localStorage
- **Local-first path** — deterministic generation where quality doesn't matter
- **Batched world events** — one request produces many events
- **Tiered models** — cheap model for filler, main model for conversation
- **History compaction** — long threads summarised back down
- **Hard caps** — bounded tool rounds per action
- **Graceful fallback** — the world never stalls when the endpoint is down

**Internal function calling**
The model never writes raw game state. It calls validated tools:

| Tool | Purpose |
|---|---|
| `create_post` | Publish a post as a character |
| `reply_to_post` | Comment on an existing post |
| `send_dm` | Send a private message |
| `adjust_relationship` | Shift a character's affinity |
| `adjust_player` | Change clout / mood / money |
| `spawn_character` | Introduce a new character |
| `log_event` | Record world activity (cheap, batchable) |
| `set_flag` | Store narrative state for later |

Every tool validates its arguments and commits state locally, so a malformed model response degrades to a logged warning instead of corrupting the save.

---

## Deploy to GitHub Pages

1. Create a repository and push these files to the default branch.
2. **Settings → Pages → Source: Deploy from a branch**
3. Branch `main`, folder `/ (root)` → **Save**.
4. Your app is live at `https://<user>.github.io/<repo>/`.

There is nothing to build. A workflow is included at `.github/workflows/pages.yml` if you prefer Actions-based deployment.

### Before you go live

- Everything is static, so **anyone can read the code** — but nobody can read your API key, because it lives only in your browser.
- Users each bring their own key. There is no shared key to leak.
- If your endpoint doesn't send CORS headers for your Pages origin, browser requests will fail. OpenRouter, OpenAI, and a local Ollama with permissive CORS all work.

---

## Configure

Open **Settings → Endpoint**.

```
Base URL   https://openrouter.ai/api/v1
Model      google/gemini-2.0-flash-001
Cheap      meta-llama/llama-3.3-70b-instruct
```

The app appends `/chat/completions` to whatever base URL you give it. Hit **Test** to verify reachability before playing.

### Demo mode

On by default until you configure an endpoint. Uses a local generator that returns real chat-completion-shaped responses — including tool calls — so every code path is exercised with zero network traffic. Good for trying the app, and it's the automatic fallback when a request fails.

---

## Cost control

Rough guidance:

- **Ambient activity** is one `cheap`-tier call per cycle (45s–3min depending on pace).
- **A DM** is one `main`-tier call.
- **A post** may trigger one cheap call for reactions — only if relevant characters exist.
- **Likes, replies, profile edits, persona edits, navigation** cost nothing.

The Settings panel shows live call counts, cached calls, tokens, and reported cost.

To spend almost nothing:

1. Set `Cheap` to the cheapest usable model.
2. Raise the cache window to 900s.
3. Set pace to **Chill**.
4. Turn off **Optimise endpoint calls** only if you want maximum variety.

---

## Architecture

```
index.html              shell
css/styles.css          design tokens + all styling
js/app.js               routing, overlays, onboarding, chrome
js/views.js             screen renderers
js/components.js        reusable UI pieces
js/engine.js            game rules, autonomy, player actions
js/reactions.js         NPC agent state, perception, reactive generation
js/tools.js             tool registry + executor + tool-call loop
js/worlds.js            world templates, custom generation, persona generation
js/personaViews.js      persona profiles + post threads
js/llm.js               endpoint client, cache, coalescing, telemetry
js/display.js           responsive nav orientation
js/prompts.js           system prompts (kept short on purpose)
js/demo.js              offline generator
js/db.js                world-scoped localStorage persistence
js/config.js            settings + presets
js/util.js              DOM/format/random helpers
js/debug.js             opt-in tracing
```

Prompt tokens are the dominant cost in apps like this, so the world state is passed as compact JSON and the roster is truncated. Prompts are deliberately terse.

---

## Debugging

```js
localStorage.setItem('status.debug', '1');
```

Reload. The console then logs every request, cache hit, coalesced call, and tool execution.

`window.Status` exposes `getState()`, `getConfig()`, `saveConfig()`, `render()`, and `toast()` for poking at the running world.

---

## Data

Everything is stored under these `localStorage` keys:

| Key | Contents |
|---|---|
| `status.save.v2.<worldId>` | One world's state |
| `status.worlds.v1` | Index of worlds (name, premise, icon) |
| `status.activeWorld` | Which world is open |
| `status.config.v1` | Endpoint + display settings |
| `status.cache.*` | Cached responses |
| `status.onboarded` | Onboarding flag |
| `status.debug` | Tracing flag |

**Settings → Save data** exports and imports JSON saves, and resets the world.

---

## Design notes

- The simulator favours *small and believable* over *big and loud*. Characters should feel like people you half-know.
- The model is treated as an unreliable narrator with a typed interface — hence tools with validation, and a local fallback everywhere.
- Failure is a first-class state. Every network path has a local equivalent.

---

Not affiliated with Google Play, WishRoll, or any app named in this project's inspirations. Original code, original visual design.
