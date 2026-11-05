/* ============================================================
   tools.js — internal function-calling registry

   The model never writes raw game state directly. It calls these
   functions, which validate and commit state locally. This keeps
   prompts small, output tokens low, and state consistent.

   Two directions:
     • LLM-facing  — JSON-schema tools passed to the endpoint
     • Local-facing — the same executors called by the engine directly,
                     so most ticks need zero endpoint calls.
   ============================================================ */

import { getState, addPost, addLog, addEvent, getNpc, upsertNpc } from './db.js';
import { chatMessage } from './llm.js';
import { rememberFact, memoryBrief } from './memory.js';
import { dbg } from './debug.js';
import { uid, clamp, fmtNum } from './util.js';

/* ---------------- schema helpers ---------------- */

const S = {
  str: (description, extra = {}) => ({ type: 'string', description, ...extra }),
  num: (description, extra = {}) => ({ type: 'number', description, ...extra }),
  int: (description, extra = {}) => ({ type: 'integer', description, ...extra }),
  bool: (description) => ({ type: 'boolean', description }),
  enum: (description, values) => ({ type: 'string', enum: values, description }),
  arr: (description, items) => ({ type: 'array', items, description }),
  obj: (description, properties, required = []) => ({
    type: 'object', description, properties, required,
    additionalProperties: false,
  }),
};

/* ============================================================
   Tool definitions
   ============================================================ */

export const TOOL_DEFS = [
  {
    name: 'create_post',
    description: 'Publish one social post authored by an existing character. Use for feed content.',
    parameters: S.obj(
      'A single post to publish.',
      {
        author: S.str('Character id from the roster. Use "player" for the user.'),
        text: S.str('Post body. Under 280 chars. No hashtag spam.', { maxLength: 400 }),
        kind: S.enum('Post flavour.', ['text', 'flex', 'vague', 'drama', 'wholesome', 'cryptic', 'announcement']),
        sentiment: S.num('Emotional tone, -1 hostile to 1 warm.', { minimum: -1, maximum: 1 }),
      },
      ['author', 'text']
    ),
  },
  {
    name: 'reply_to_post',
    description: 'Add a reply comment to an existing post.',
    parameters: S.obj(
      'A reply to attach to a post.',
      {
        postId: S.str('Target post id.'),
        author: S.str('Character id replying.'),
        text: S.str('Reply body. Under 200 chars.', { maxLength: 300 }),
      },
      ['postId', 'author', 'text']
    ),
  },
  {
    name: 'send_dm',
    description: 'Send a direct message from a character into a thread with the player.',
    parameters: S.obj(
      'A direct message.',
      {
        from: S.str('Character id sending the message.'),
        text: S.str('Message text. Conversational, 1-3 sentences.', { maxLength: 500 }),
        tone: S.enum('Delivery tone.', ['casual', 'flirty', 'cold', 'anxious', 'playful', 'dramatic', 'apologetic']),
      },
      ['from', 'text']
    ),
  },
  {
    name: 'adjust_relationship',
    description: 'Change how a character feels about the player.',
    parameters: S.obj(
      'A relationship delta.',
      {
        character: S.str('Character id.'),
        delta: S.int('Change in affinity, -20 to 20.', { minimum: -20, maximum: 20 }),
        reason: S.str('One short clause explaining it.'),
      },
      ['character', 'delta']
    ),
  },
  {
    name: 'adjust_player',
    description: 'Change player resources after an outcome (clout, mood, money).',
    parameters: S.obj(
      'A player resource delta.',
      {
        clout: S.int('Clout change.', { minimum: -50, maximum: 50 }),
        mood: S.int('Mood change.', { minimum: -30, maximum: 30 }),
        money: S.int('Money change.', { minimum: -200, maximum: 200 }),
        reason: S.str('Why.'),
      },
      []
    ),
  },
  {
    name: 'spawn_character',
    description: 'Introduce a new character into the world. Use sparingly.',
    parameters: S.obj(
      'A new character.',
      {
        name: S.str('Full display name.'),
        handle: S.str('Handle without @.'),
        bio: S.str('One-line bio.'),
        archetype: S.enum('Social role.', ['influencer', 'lurker', 'chaos', 'wholesome', 'rival', 'stan', 'brand', 'critic']),
        vibe: S.str('Two or three adjectives.'),
      },
      ['name', 'handle']
    ),
  },
  {
    name: 'log_event',
    description: 'Record a world event for the activity log. Cheap — batch several per call.',
    parameters: S.obj(
      'A world event.',
      {
        title: S.str('Short headline, under 60 chars.'),
        detail: S.str('Optional one-line detail.'),
        kind: S.enum('Event category.', ['growth', 'drama', 'money', 'mood', 'social', 'system']),
      },
      ['title']
    ),
  },
  {
    name: 'set_flag',
    description: 'Set a narrative flag for later reuse (e.g. "cat_drama_started").',
    parameters: S.obj(
      'A narrative flag.',
      {
        key: S.str('Flag name, snake_case.'),
        value: S.str('Flag value; stringified if not a string.'),
      },
      ['key', 'value']
    ),
  },
  {
    name: 'remember_fact',
    description: 'Record one durable fact about a character, the player, or the world. Use this whenever something happens that should still be true later — a promise, a secret, a job, a feud, a running joke. Write it as a short third-person statement.',
    parameters: S.obj(
      'A fact worth remembering.',
      {
        subject: S.str('Who or what it is about: a character id from the roster, "player", or "world".'),
        text: S.str('One short sentence. Third person. Under 160 chars.', { maxLength: 180 }),
        tags: S.arr('Optional topic tags for retrieval.', { type: 'string' }),
      },
      ['subject', 'text']
    ),
  },
];

/** OpenAI/OpenRouter-shaped tool array. */
export const TOOLS = TOOL_DEFS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

/* ============================================================
   Executors — each returns { ok, summary, data }
   ============================================================ */

const clampSentiment = (n) => clamp(Number.isFinite(n) ? n : 0, -1, 1);

function resolveAuthor(id) {
  if (!id || id === 'player' || id === 'you') return null;
  return getNpc(id);
}

export const EXEC = {
  create_post(args = {}) {
    const s = getState();
    const authorId = String(args.author || '').trim();
    const text = String(args.text || '').trim();
    if (!text) return { ok: false, summary: 'empty post text' };
    if (text.length > 400) return { ok: false, summary: 'post too long' };

    const npc = resolveAuthor(authorId);
    if (authorId && authorId !== 'player' && !npc) {
      return { ok: false, summary: `unknown author "${authorId}"` };
    }

    const post = addPost({
      authorId: npc ? npc.id : 'player',
      authorName: npc ? npc.name : s.player.name,
      authorHandle: npc ? npc.handle : s.player.handle,
      verified: npc ? !!npc.verified : s.player.verified,
      text,
      kind: args.kind || 'text',
      sentiment: clampSentiment(args.sentiment),
      likes: Math.max(0, Math.round(
        (npc ? (npc.followers || 0) : s.player.followers) * (0.01 + Math.random() * 0.03)
      )),
    });

    if (npc) {
      npc.posts = (npc.posts || 0) + 1;
      npc.lastActive = Date.now();
    } else {
      s.stats.posts++;
      s.stats.clout += 1;
    }

    dbg('tool:create_post', { author: authorId, len: text.length });
    return { ok: true, summary: `posted as ${npc ? npc.name : 'player'}`, data: { postId: post.id } };
  },

  reply_to_post(args = {}) {
    const s = getState();
    const post = s.posts.find((p) => p.id === args.postId);
    if (!post) return { ok: false, summary: `unknown post "${args.postId}"` };
    const text = String(args.text || '').trim();
    if (!text) return { ok: false, summary: 'empty reply' };

    const npc = resolveAuthor(args.author);
    post.replies = post.replies || [];
    post.replies.push({
      id: uid('rep'),
      authorId: npc ? npc.id : 'player',
      authorName: npc ? npc.name : s.player.name,
      authorHandle: npc ? npc.handle : s.player.handle,
      text: text.slice(0, 300),
      ts: Date.now(),
    });
    if (post.replies.length > 40) post.replies.length = 40;
    return { ok: true, summary: `replied on ${post.id}` };
  },

  send_dm(args = {}) {
    const s = getState();
    const npc = getNpc(String(args.from || ''));
    if (!npc) return { ok: false, summary: `unknown sender "${args.from}"` };
    const text = String(args.text || '').trim();
    if (!text) return { ok: false, summary: 'empty message' };

    let thread = s.threads.find((t) => t.npcId === npc.id);
    if (!thread) {
      thread = { id: uid('thread'), npcId: npc.id, ts: Date.now(), messages: [], unread: 0 };
      s.threads.unshift(thread);
    }
    thread.messages.push({
      id: uid('msg'),
      from: npc.id,
      text: text.slice(0, 600),
      tone: args.tone || 'casual',
      ts: Date.now(),
    });
    if (thread.messages.length > 120) thread.messages.splice(0, thread.messages.length - 120);
    thread.unread = (thread.unread || 0) + 1;
    thread.ts = Date.now();
    npc.lastActive = Date.now();

    return { ok: true, summary: `dm from ${npc.name}` };
  },

  adjust_relationship(args = {}) {
    const npc = getNpc(String(args.character || ''));
    if (!npc) return { ok: false, summary: `unknown character "${args.character}"` };
    const delta = clamp(Number(args.delta) || 0, -20, 20);
    npc.affinity = clamp((npc.affinity ?? 0) + delta, -100, 100);
    npc.lastActive = Date.now();
    if (args.reason) npc.lastReason = String(args.reason).slice(0, 140);
    return { ok: true, summary: `${npc.name} affinity ${delta >= 0 ? '+' : ''}${delta}` };
  },

  adjust_player(args = {}) {
    const s = getState();
    const before = { ...s.stats };
    if (Number.isFinite(args.clout)) s.stats.clout = Math.max(0, s.stats.clout + clamp(args.clout, -50, 50));
    if (Number.isFinite(args.mood)) s.stats.mood = clamp(s.stats.mood + clamp(args.mood, -30, 30), 0, 100);
    if (Number.isFinite(args.money)) s.stats.money = Math.max(0, s.stats.money + clamp(args.money, -200, 200));
    const diffs = [];
    if (s.stats.clout !== before.clout) diffs.push(`clout ${s.stats.clout - before.clout >= 0 ? '+' : ''}${s.stats.clout - before.clout}`);
    if (s.stats.mood !== before.mood) diffs.push(`mood ${s.stats.mood - before.mood >= 0 ? '+' : ''}${s.stats.mood - before.mood}`);
    if (s.stats.money !== before.money) diffs.push(`$${s.stats.money - before.money >= 0 ? '+' : ''}${s.stats.money - before.money}`);
    return { ok: true, summary: diffs.join(', ') || 'no change' };
  },

  spawn_character(args = {}) {
    const s = getState();
    const name = String(args.name || '').trim();
    if (!name) return { ok: false, summary: 'missing name' };
    const handle = '@' + String(args.handle || name).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 18);
    if (s.npcs.some((n) => n.handle.toLowerCase() === handle.toLowerCase())) {
      return { ok: false, summary: `handle ${handle} taken` };
    }
    const npc = upsertNpc({
      id: uid('npc'),
      name,
      handle,
      bio: String(args.bio || '').slice(0, 140),
      archetype: args.archetype || 'lurker',
      vibe: String(args.vibe || '').slice(0, 60),
      followers: Math.round(Math.random() * 4000),
      affinity: Math.round((Math.random() - 0.4) * 40),
      verified: false,
      posts: 0,
      lastActive: Date.now(),
      isNew: true,
    });
    addEvent({ kind: 'social', title: `${name} joined your orbit`, detail: handle });
    return { ok: true, summary: `spawned ${name}`, data: { id: npc.id } };
  },

  log_event(args = {}) {
    const title = String(args.title || '').trim();
    if (!title) return { ok: false, summary: 'missing title' };
    addEvent({
      kind: args.kind || 'system',
      title: title.slice(0, 90),
      detail: String(args.detail || '').slice(0, 200),
    });
    return { ok: true, summary: `event: ${title.slice(0, 30)}` };
  },

  set_flag(args = {}) {
    const s = getState();
    const key = String(args.key || '').trim();
    if (!key) return { ok: false, summary: 'missing key' };
    s.flags[key] = typeof args.value === 'string' ? args.value : JSON.stringify(args.value);
    return { ok: true, summary: `flag ${key}` };
  },

  remember_fact(args = {}) {
    const s = getState();
    const subject = String(args.subject || 'world').trim() || 'world';

    // Validate the subject so facts don't get orphaned under a typo.
    if (subject !== 'player' && subject !== 'world' && !s.npcs.some((n) => n.id === subject)) {
      return { ok: false, summary: `unknown subject "${subject}"` };
    }

    const fact = rememberFact({
      text: args.text,
      subject,
      tags: args.tags,
      source: 'model',
    });
    if (!fact) return { ok: false, summary: 'fact was empty or too short' };
    return { ok: true, summary: `remembered (${subject}): ${fact.text.slice(0, 40)}`, data: { id: fact.id } };
  },
};

/* ============================================================
   Dispatch
   ============================================================ */

/**
 * Execute one tool call. Never throws — returns an error summary
 * so the model can recover in the next round.
 */
export function runToolCall(call) {
  const name = call?.function?.name || call?.name;
  const rawArgs = call?.function?.arguments ?? call?.arguments ?? '{}';
  const exec = EXEC[name];
  const started = performance.now();

  if (!exec) {
    return { ok: false, name, summary: `unknown tool "${name}"`, ms: 0 };
  }

  let args = rawArgs;
  if (typeof rawArgs === 'string') {
    try {
      args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch (e) {
      addLog({ kind: 'tool', title: `Malformed arguments for ${name}`, detail: rawArgs.slice(0, 120), level: 'warn' });
      return { ok: false, name, summary: 'arguments were not valid JSON', ms: 0 };
    }
  }

  try {
    const res = exec(args || {});
    const ms = Math.round(performance.now() - started);
    addLog({
      kind: 'tool',
      title: `${name}`,
      detail: res.summary,
      level: res.ok ? 'ok' : 'warn',
      ms,
    });
    return { ...res, name, args, ms };
  } catch (e) {
    addLog({ kind: 'tool', title: `${name} threw`, detail: e.message, level: 'error' });
    return { ok: false, name, summary: e.message, ms: 0 };
  }
}

/* ============================================================
   Tool-call loop — one user action, at most N endpoint calls
   ============================================================ */

/**
 * Runs a conversational turn that may require tool use.
 *
 * @param {object} o
 * @param {Array}  o.messages      conversation so far
 * @param {number} [o.maxRounds]   tool round-trips (default 2)
 * @param {string} [o.tier]
 * @param {number} [o.maxTokens]
 * @param {string} [o.toolChoice]
 * @param {string} [o.cacheKey]
 */
export async function runToolLoop(o = {}) {
  const cfg = { maxRounds: 2, ...o };
  const messages = [...cfg.messages];
  const executed = [];
  const seen = new Set();
  let lastMessage = null;
  let rounds = 0;

  const signature = (call) => {
    const name = call?.function?.name || call?.name || '';
    const args = call?.function?.arguments ?? call?.arguments ?? '';
    return name + '|' + (typeof args === 'string' ? args : JSON.stringify(args));
  };

  while (rounds < cfg.maxRounds) {
    rounds++;
    const msg = await chatMessage({
      messages,
      tools: cfg.tools || TOOLS,
      toolChoice: cfg.toolChoice || (rounds === 1 ? cfg.firstToolChoice : 'auto'),
      tier: cfg.tier,
      maxTokens: cfg.maxTokens,
      temperature: cfg.temperature,
      cache: false,
      cacheKey: cfg.cacheKey,
      signal: cfg.signal,
    });
    lastMessage = msg;

    const calls = msg.tool_calls || [];
    if (!calls.length) break;

    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });

    let fresh = 0;
    let failed = 0;

    for (const call of calls) {
      const sig = signature(call);
      if (seen.has(sig)) {
        // The model repeated itself — acknowledge without re-applying.
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call?.function?.name,
          content: JSON.stringify({ ok: false, result: 'duplicate call ignored' }),
        });
        continue;
      }
      seen.add(sig);
      fresh++;
      const res = runToolCall(call);
      executed.push(res);
      if (!res.ok) failed++;
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: res.name,
        content: JSON.stringify({ ok: res.ok, result: res.summary }),
      });
    }

    // Nothing new happened — further rounds would just burn tokens.
    if (fresh === 0) break;
    // Every fresh call failed — stop rather than loop on errors.
    if (failed === fresh) break;
  }

  return {
    message: lastMessage,
    content: (lastMessage?.content || '').trim(),
    executed,
    rounds,
    mutated: executed.some((r) => r.ok),
  };
}

/* ============================================================
   Local intent router — decides if the endpoint is needed at all
   ============================================================ */

const LOCAL_INTENTS = [
  { match: /\b(like|heart)\b/i, handler: 'like' },
  { match: /\b(refresh|reload)\b/i, handler: 'refresh' },
  { match: /\b(stats|numbers)\b/i, handler: 'stats' },
];

/**
 * Pick the cheapest path for a player action.
 * @returns {{ needsLLM: boolean, handler?: string }}
 */
export function routeIntent(text, fallbackNeedsLLM = true) {
  const localFirst = true;
  if (!localFirst) return { needsLLM: true };
  for (const it of LOCAL_INTENTS) {
    if (it.match.test(text || '')) return { needsLLM: false, handler: it.handler };
  }
  return { needsLLM: fallbackNeedsLLM };
}

/* Character roster compacted for prompts — keeps input tokens small. */
export function rosterForPrompt(limit = 8) {
  const s = getState();
  return s.npcs.slice(0, limit).map((n) => ({
    id: n.id,
    name: n.name,
    archetype: n.archetype,
    affinity: n.affinity,
  }));
}

export function worldSnapshot() {
  const s = getState();
  return {
    player: { name: s.player.name, handle: s.player.handle, followers: fmtNum(s.player.followers) },
    clout: s.stats.clout,
    mood: s.stats.mood,
    money: s.stats.money,
    characters: rosterForPrompt(),
  };
}
