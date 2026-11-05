/* ============================================================
   reactions.js — reactive NPC simulation

   Core rule: the player is ONE character. Everyone else is an
   agent with their own memory, mood, attention and grudges.

   Reactions are never requested generically ("write a reply from
   somebody"). Instead:

     1. A player action emits a STIMULUS.
     2. Every NPC PERCEIVES it and scores relevance locally:
        were they mentioned? do they care about this topic?
        are they already invested in this thread? is their
        attention available, or are they busy/sulking?
     3. Only the few who actually care get a generation pass,
        and they get it WITH their own state attached, so the
        output is a consequence of who they are — not improv.

   This keeps prompts small, keeps behaviour causal, and means
   most ticks cost zero endpoint calls.
   ============================================================ */

import { getState, addPost, addLog, getNpc } from './db.js';
import { getConfig } from './config.js';
import { chatMessage, LLMError } from './llm.js';
import { runToolCall, TOOLS } from './tools.js';
import { rng, clamp, uid, fmtNum, slug } from './util.js';
import { dbg, warn } from './debug.js';

/* ============================================================
   NPC internal state
   ============================================================ */

/** Lazily attach (and repair) the agent state fields an NPC needs. */
export function ensureAgent(npc) {
  if (!npc) return npc;

  const defaults = {
    mood: clamp(45 + Math.round((npc.affinity ?? 0) * 0.3) + rng.int(-15, 15), 0, 100),
    attention: 1,
    patience: clamp(50 + rng.int(-20, 20), 0, 100),
    grudge: Math.max(0, -(npc.affinity ?? 0)),
    lastSpokeAt: 0,
    lastSeenPlayerAt: 0,
    seen: [],
    interests: interestsFor(npc),
    memory: [],
  };

  if (!npc.agent || typeof npc.agent !== 'object') {
    npc.agent = defaults;
    return npc.agent;
  }

  // Merge forward — saves written by older builds may be missing fields.
  let repaired = false;
  for (const [k, v] of Object.entries(defaults)) {
    if (npc.agent[k] === undefined || npc.agent[k] === null) {
      npc.agent[k] = v;
      repaired = true;
    }
  }
  if (!Array.isArray(npc.agent.seen)) { npc.agent.seen = []; repaired = true; }
  if (!Array.isArray(npc.agent.memory)) { npc.agent.memory = []; repaired = true; }
  if (!Array.isArray(npc.agent.interests) || !npc.agent.interests.length) {
    npc.agent.interests = interestsFor(npc);
    repaired = true;
  }
  if (repaired) dbg('agent repaired', npc.name);

  return npc.agent;
}

const INTEREST_MAP = {
  influencer: ['clout', 'aesthetic', 'growth', 'brand', 'flex'],
  lurker: ['drama', 'observation', 'vague'],
  chaos: ['drama', 'argument', 'meme', 'unhinged'],
  wholesome: ['kindness', 'food', 'comfort', 'support'],
  rival: ['competition', 'clout', 'status'],
  stan: ['fandom', 'loyalty', 'defence'],
  brand: ['product', 'partnership', 'growth'],
  critic: ['opinion', 'taste', 'argument'],
  mentor: ['advice', 'growth', 'guidance'],
  ghost: ['silence', 'mystery'],
  'clout-chaser': ['clout', 'trending', 'status'],
  romantic: ['feelings', 'attention', 'intimacy'],
};

function interestsFor(npc) {
  return INTEREST_MAP[npc.archetype] || ['drama', 'vague'];
}

/* ============================================================
   Stimuli
   ============================================================ */

/**
 * @typedef {object} Stimulus
 * @property {'post'|'reply'|'dm'|'like'|'follow'|'event'} kind
 * @property {string} id
 * @property {string} text
 * @property {string[]} mentions     handles mentioned, lowercase without @
 * @property {string} [postId]
 * @property {number} weight         0..1 — how loud this is
 * @property {number} ts
 */

export function makePostStimulus(post) {
  return {
    kind: 'post',
    id: post.id,
    postId: post.id,
    text: post.text || '',
    mentions: extractMentions(post.text || ''),
    weight: 1,
    ts: Date.now(),
    authorId: post.authorId,
  };
}

export function makeDmStimulus(text, npcId) {
  return {
    kind: 'dm',
    id: uid('stim'),
    text: String(text || ''),
    mentions: [],
    weight: 1,
    ts: Date.now(),
    directTo: npcId,
  };
}

export function makeReplyStimulus(postId, text, targetAuthorId = null) {
  return {
    kind: 'reply',
    id: uid('stim'),
    postId,
    text: String(text || ''),
    mentions: extractMentions(text || ''),
    weight: 0.8,
    ts: Date.now(),
    targetAuthorId,
  };
}

export function extractMentions(text) {
  return [...String(text).matchAll(/@([a-z0-9_]{2,24})/gi)]
    .map((m) => m[1].toLowerCase())
    .slice(0, 8);
}

/** Cheap topic tagging — no endpoint needed. */
const TOPIC_RULES = [
  { tag: 'drama', re: /\b(fight|drama|hate|awful|lie|betray|blocked|fake|petty)\b/i },
  { tag: 'clout', re: /\b(followers|viral|engagement|algorithm|numbers|reach|posting)\b/i },
  { tag: 'food', re: /\b(coffee|bakery|food|eat|dinner|lunch|sourdough|cake|cafe|restaurant|pizza)\b/i },
  { tag: 'argument', re: /\b(actually|wrong|disagree|overrated|unpopular|said what i said|fight me)\b/i },
  { tag: 'kindness', re: /\b(thank|grateful|love|kind|appreciate|proud)\b/i },
  { tag: 'competition', re: /\b(beat|better|won|lost|compete|grind|try hard)\b/i },
  { tag: 'feelings', re: /\b(feel|sad|happy|lonely|miss|anxious|cry|tired)\b/i },
  { tag: 'growth', re: /\b(new|launch|project|building|started|announce)\b/i },
  { tag: 'aesthetic', re: /\b(aesthetic|vibe|outfit|jacket|design|look)\b/i },
  { tag: 'meme', re: /\b(lol|lmfao|unhinged|feral|chaos)\b/i },
  { tag: 'vague', re: /\b(anyway|hmm|no thoughts|idk|whatever)\b/i },
];

export function topicsOf(text) {
  const tags = new Set();
  for (const r of TOPIC_RULES) if (r.re.test(text)) tags.add(r.tag);
  if (tags.size === 0) tags.add('vague');
  return [...tags];
}

/* ============================================================
   Perception — local, synchronous, free
   ============================================================ */

/**
 * How much does this NPC care about this stimulus right now?
 * Returns 0..1. Zero means they simply do not notice.
 */
export function relevance(npc, stim) {
  const a = ensureAgent(npc);
  if (a.seen.includes(stim.id)) return 0;

  let score = 0;

  // direct address is basically impossible to ignore
  if (stim.directTo && stim.directTo === npc.id) score += 1.2;

  const handle = npc.handle.replace(/^@/, '').toLowerCase();
  if (stim.mentions.includes(handle)) score += 1.0;

  // the author of the post you replied under definitely notices
  if (stim.kind === 'reply' && stim.targetAuthorId === npc.id) score += 1.1;

  // does the topic intersect with what they care about?
  const tags = topicsOf(stim.text);
  const overlap = tags.filter((t) => a.interests.includes(t)).length;
  score += overlap * 0.42;

  // affinity pulls attention in both directions
  const aff = npc.affinity ?? 0;
  if (aff > 30) score += 0.3;
  else if (aff < -20) score += 0.4; // they're watching, just not kindly

  // grudges make people noisy
  score += clamp(a.grudge / 80, 0, 0.35);

  // baseline: a post on the timeline is visible to everyone
  score += 0.22;

  // bandwidth — busy or sulking NPCs fade out, but never into silence.
  // The floor is deliberately well above 0: baseline is only 0.22, so a
  // 0.05 floor multiplies it down to ~0.01 and that character can never
  // reach the reaction threshold again.
  score *= clamp(a.attention, 0.5, 1);
  if (a.patience < 25) score *= 0.7;

  // cooldown so nobody dogpiles every single post
  const since = Date.now() - (a.lastSpokeAt || 0);
  if (since < 45_000) score *= 0.45;
  else if (since < 180_000) score *= 0.8;

  // ambient noise keeps it from being too deterministic
  score *= 0.8 + Math.random() * 0.5;

  return clamp(score, 0, 1);
}

/**
 * Pick who reacts. Always returns at most `max` agents, ordered
 * by how strongly they care. Callers get the *why* so prompts and
 * the activity log can explain the reaction.
 */
export function selectResponders(stim, { max = 3, threshold = 0.28 } = {}) {
  const s = getState();
  const scored = s.npcs
    .map((npc) => ({ npc, score: relevance(npc, stim) }))
    .filter((r) => r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
  return scored;
}

/** Mark a stimulus as handled by these agents (prevents repeats). */
export function markPerceived(stim, responders) {
  for (const { npc } of responders) {
    const a = ensureAgent(npc);
    a.seen.push(stim.id);
    if (a.seen.length > 40) a.seen.shift();
    a.lastSeenPlayerAt = Date.now();
  }
}

/* ============================================================
   Attention / mood drift — this is what makes it feel alive
   ============================================================ */

export function driftAgents() {
  const s = getState();
  for (const npc of s.npcs) {
    const a = ensureAgent(npc);

    // attention recovers toward 1
    a.attention = clamp(a.attention + 0.08, 0, 1);

    // patience recovers slowly
    a.patience = clamp(a.patience + 2, 0, 100);

    // mood pulls toward a baseline set by affinity
    const target = clamp(48 + (npc.affinity ?? 0) * 0.35, 10, 95);
    a.mood = clamp(a.mood + (target - a.mood) * 0.08, 0, 100);

    // grudges fade unless reinforced
    a.grudge = Math.max(0, a.grudge - 0.4);

    // memory is bounded
    if (a.memory.length > 6) a.memory = a.memory.slice(-6);
  }
  return s.npcs.length;
}

/** Called after any NPC speaks — costs bandwidth. */
export function noteSpoke(npc, amount = 0.25) {
  const a = ensureAgent(npc);
  a.lastSpokeAt = Date.now();
  a.attention = clamp(a.attention - amount, 0.5, 1);
}

/** Called when the player does something an NPC dislikes. */
export function noteSlight(npc, amount = 10) {
  const a = ensureAgent(npc);
  a.grudge = clamp(a.grudge + amount, 0, 100);
  a.patience = clamp(a.patience - amount, 0, 100);
  a.attention = clamp(a.attention + 0.25, 0, 1); // irritation sharpens focus
}

/** Called when the player does something an NPC likes. */
export function noteWarmth(npc, amount = 10) {
  const a = ensureAgent(npc);
  a.grudge = Math.max(0, a.grudge - amount);
  a.patience = clamp(a.patience + amount * 0.6, 0, 100);
}

/* ============================================================
   Local reaction generation — free, causal, always available
   ============================================================ */

const LOCAL_REACTION = {
  influencer: {
    warm: ['ok this is actually a great post', 'you ate here honestly', 'the algorithm is going to love you for this'],
    neutral: ['noted 👀', 'interesting timing', 'hmm ok'],
    cold: ['interesting that you posted this today', 'bold choice'],
  },
  lurker: {
    warm: ['yeah', 'this', 'okay i see you'],
    neutral: ['…', 'hmm', 'sure'],
    cold: ['hm.', 'noted.'],
  },
  chaos: {
    warm: ['LMAOOO ok this is unhinged and i respect it', 'you are so unwell and i love it'],
    neutral: ['what does this even mean', 'ok go off i guess'],
    cold: ['this is a weird thing to post', 'why would you say this publicly'],
  },
  wholesome: {
    warm: ['this made my whole day 🫶', 'so proud of you honestly', 'this is lovely'],
    neutral: ['thanks for sharing this', 'aw'],
    cold: ['is everything okay?', 'that seems hard. hope you\'re alright.'],
  },
  rival: {
    warm: ['fine. that one was good.', 'okay i\'ll give you that'],
    neutral: ['interesting', 'hm. we\'ll see.'],
    cold: ['i\'ve seen better', 'this is a strange angle for you', 'not your best'],
  },
  stan: {
    warm: ['!!!!! this is everything', 'you\'re so real for this', 'i will be thinking about this all week'],
    neutral: ['okay yes', 'noted!!'],
    cold: ['wait what happened', 'are you okay??'],
  },
  brand: {
    warm: ['great content. we should talk.', 'we love to see it'],
    neutral: ['noted for our records.'],
    cold: ['this does not align with our messaging.'],
  },
  critic: {
    warm: ['i don\'t hate it. which is rare.', 'surprisingly good'],
    neutral: ['weird framing but ok', 'i have thoughts. many thoughts.'],
    cold: ['this is exactly the kind of post i mean', 'poorly considered'],
  },
  mentor: {
    warm: ['well said. keep going.', 'that\'s growth.'],
    neutral: ['worth thinking about more.', 'hmm. sit with that.'],
    cold: ['you can do better than this.'],
  },
  ghost: {
    warm: ['…'],
    neutral: [''],
    cold: [''],
  },
  'clout-chaser': {
    warm: ['okay this is going to get numbers', 'can i repost this'],
    neutral: ['huh', 'interesting'],
    cold: ['this won\'t do well btw'],
  },
  romantic: {
    warm: ['this is my favourite thing you\'ve posted', 'i keep rereading this'],
    neutral: ['hmm. thinking about this.'],
    cold: ['are you trying to say something?'],
  },
};

function toneFor(npc, stim) {
  const a = ensureAgent(npc);
  const aff = (npc.affinity ?? 0) + (a.mood - 50) * 0.4;
  if (aff > 25) return 'warm';
  if (aff < -20) return 'cold';
  if (a.grudge > 30) return 'cold';
  return 'neutral';
}

/** Deterministic-in-spirit reaction text. Zero cost. */
export function localReaction(npc, stim) {
  const tone = toneFor(npc, stim);
  const bank = LOCAL_REACTION[npc.archetype] || LOCAL_REACTION.lurker;
  const lines = bank[tone] || bank.neutral;
  let text = rng.pick(lines.filter(Boolean));
  if (!text) return null;

  const a = ensureAgent(npc);
  const mentioned = stim.mentions.includes(npc.handle.replace(/^@/, '').toLowerCase());
  if (mentioned && rng.chance(0.6)) {
    text = rng.pick(['yes? you called?', 'you @\'d me. i\'m here.', 'what do you want 😭', 'ok i\'m listening']);
  }
  if (stim.kind === 'dm') {
    text = rng.pick(tone === 'warm'
      ? ['hey. i was hoping you\'d text.', 'you always know when to message me.', 'ok yes i\'m here']
      : tone === 'cold'
        ? ['what.', 'yes?', 'i\'m busy.']
        : ['hey', 'oh hi', 'what\'s up']);
  }
  return text;
}

/** Apply a reaction to the world. Shared by local and LLM paths. */
export function deliverReaction(npc, stim, text, { tone = 'casual' } = {}) {
  if (!text) return null;
  const s = getState();

  if (stim.kind === 'post' || stim.kind === 'reply') {
    const post = s.posts.find((p) => p.id === stim.postId);
    if (!post) return null;
    post.replies = post.replies || [];
    // don't double-post the same text
    if (post.replies.some((r) => r.authorId === npc.id && r.text === text)) return null;
    post.replies.push({
      id: uid('rep'),
      authorId: npc.id,
      authorName: npc.name,
      authorHandle: npc.handle,
      text: String(text).slice(0, 300),
      ts: Date.now(),
      reacted: true,
    });
    if (post.replies.length > 40) post.replies.length = 40;
    post.likes = (post.likes || 0) + rng.int(1, 12);
    noteSpoke(npc);
    return { kind: 'reply', postId: post.id };
  }

  if (stim.kind === 'dm' || stim.kind === 'direct') {
    let thread = s.threads.find((t) => t.npcId === npc.id);
    if (!thread) {
      thread = { id: uid('thread'), npcId: npc.id, ts: Date.now(), messages: [], unread: 0 };
      s.threads.unshift(thread);
    }
    thread.messages.push({
      id: uid('msg'),
      from: npc.id,
      text: String(text).slice(0, 600),
      tone,
      ts: Date.now(),
    });
    if (thread.messages.length > 120) thread.messages.splice(0, thread.messages.length - 120);
    thread.unread = (thread.unread || 0) + 1;
    thread.ts = Date.now();
    noteSpoke(npc);
    return { kind: 'dm', threadId: thread.id };
  }

  return null;
}

/* ============================================================
   LLM reaction pass — only for agents who actually care
   ============================================================ */

function agentBrief(npc) {
  const a = ensureAgent(npc);
  return {
    id: npc.id,
    name: npc.name,
    archetype: npc.archetype,
    vibe: npc.vibe,
    affinity: npc.affinity ?? 0,
    mood: Math.round(a.mood),
    patience: Math.round(a.patience),
    grudge: Math.round(a.grudge),
    interests: a.interests,
    recent: a.memory.slice(-3),
  };
}

const REACTION_SYSTEM = `You are the reaction layer of a social-media life sim.

The player is a single ordinary user posting on a social app. You do not speak for the player.
You write reactions for the specific characters listed, and only them.

Rules:
- Each character reacts according to their own archetype, mood, patience and grudge — not the player's wishes.
- A character with low affinity does NOT suddenly become warm.
- A character with high grudge is sharp, cold or dismissive.
- Some characters should simply not react. Do not force a reply from everyone.
- Write like real people: short, lowercase, no hashtags, no emoji spam, no stage directions.
- Never invent new characters.
- Use reply_to_post for public reactions, send_dm for private ones.
- If a character would say nothing, skip them entirely.`;

/**
 * Generate reactions for the responders only.
 *
 * @param {Stimulus} stim
 * @param {Array<{npc:object, score:number}>} responders
 * @param {object} [opts]
 */
export async function generateReactions(stim, responders, opts = {}) {
  if (!responders.length) return { ok: true, delivered: 0, calls: 0 };

  const cfg = getConfig();

  // Local path: free, instant, deterministic-in-spirit.
  if (cfg.demoMode || !cfg.optimise.enabled || opts.forceLocal) {
    let delivered = 0;
    for (const { npc, score } of responders) {
      // the less they care, the more likely they say nothing
      if (!rng.chance(clamp(score + 0.15, 0, 0.95))) continue;
      const text = localReaction(npc, stim);
      if (deliverReaction(npc, stim, text)) delivered++;
      else noteSpoke(npc);
    }
    commitReactions();
    return { ok: true, delivered, calls: 0, local: true };
  }

  /* ---- live path: one call, responders only ---- */
  const s = getState();
  const post = stim.postId ? s.posts.find((p) => p.id === stim.postId) : null;
  const context = post
    ? {
        post: post.text,
        author: post.authorName,
        existingReplies: (post.replies || []).slice(-4).map((r) => `${r.authorName}: ${r.text}`),
      }
    : { message: stim.text };

  const messages = [
    { role: 'system', content: REACTION_SYSTEM },
    {
      role: 'user',
      content: [
        `STIMULUS (${stim.kind}):`,
        JSON.stringify(context),
        '',
        `Post id: ${stim.postId || 'n/a'}`,
        '',
        'CHARACTERS PRESENT:',
        JSON.stringify(responders.map(({ npc }) => agentBrief(npc))),
        '',
        'Write the reactions now.',
      ].join('\n'),
    },
  ];

  try {
    const msg = await chatMessage({
      messages,
      tools: TOOLS.filter((t) =>
        ['reply_to_post', 'send_dm', 'adjust_relationship', 'adjust_player', 'set_flag'].includes(t.function.name)
      ),
      toolChoice: 'auto',
      tier: 'cheap',
      // Generous enough to survive a reasoning model's hidden thinking
      // tokens; chat() still escalates once if the reply comes back empty.
      maxTokens: 1000,
      temperature: 0.95,
      cache: false,
    });

    let delivered = 0;
    const validIds = new Set(responders.map(({ npc }) => npc.id));

    for (const call of msg.tool_calls || []) {
      const name = call.function?.name;
      let args = {};
      try { args = JSON.parse(call.function?.arguments || '{}'); } catch { continue; }

      if (name === 'reply_to_post' || name === 'send_dm') {
        const speakerId = name === 'reply_to_post' ? args.author : args.from;
        // refuse impersonation of anyone outside the responder set
        if (!validIds.has(speakerId)) {
          addLog({ kind: 'tool', title: 'Reaction rejected', detail: `${speakerId} was not selected to react`, level: 'warn' });
          continue;
        }
        const npc = getNpc(speakerId);
        if (!npc) continue;
        if (name === 'reply_to_post') {
          if (args.postId !== stim.postId) continue;
          if (deliverReaction(npc, stim, args.text)) delivered++;
        } else {
          if (deliverReaction(npc, { ...stim, kind: 'dm', directTo: npc.id }, args.text, { tone: args.tone })) delivered++;
        }
        continue;
      }

      runToolCall(call);
    }

    // If the model returned prose instead of tools, treat it as one
    // reaction from the most relevant agent — but never attribute it
    // to a character who wasn't selected.
    if (delivered === 0 && msg.content && msg.content.trim()) {
      const npc = responders[0].npc;
      if (deliverReaction(npc, stim, msg.content.trim())) delivered++;
    }

    // Only characters who actually said something pay a bandwidth cost.
    // Marking every candidate as "spoke" on a pass that produced nothing
    // drains attention for no benefit and eventually mutes the cast.
    if (delivered > 0) {
      for (const { npc } of responders) noteSpoke(npc, 0.15);
    }
    commitReactions();
    return { ok: true, delivered, calls: 1 };
  } catch (e) {
    if (!(e instanceof LLMError)) warn('reaction pass threw', e);
    addLog({ kind: 'llm', title: 'Reaction pass fell back to local', detail: e.message, level: 'warn' });
    return generateReactions(stim, responders, { forceLocal: true });
  }
}

function commitReactions() {
  // commit happens in db via import at call sites; keep this a no-op hook
  // so callers can subscribe if needed later.
  dbg('reactions committed');
}

/* ============================================================
   Public entry point used by the engine
   ============================================================ */

/**
 * React to a player action. This is the only function the engine
 * needs to call.
 *
 * @param {Stimulus} stim
 * @param {object} [opts]
 */
export async function reactTo(stim, opts = {}) {
  const responders = selectResponders(stim, opts);
  if (!responders.length) {
    dbg('no responders for stimulus', stim.kind);
    return { ok: true, responders: [], delivered: 0 };
  }

  dbg('responders', responders.map((r) => `${r.npc.name}@${r.score.toFixed(2)}`));

  // relationship consequences before they speak — they react to what
  // the player did, so the feeling lands first
  for (const { npc, score } of responders) {
    const tags = topicsOf(stim.text);
    if (tags.includes('drama') || tags.includes('argument')) noteSlight(npc, 6 * score);
    if (tags.includes('kindness') || tags.includes('feelings')) noteWarmth(npc, 6 * score);
    const a = ensureAgent(npc);
    a.memory.push(`${stim.kind === 'dm' ? 'player texted' : 'player posted'}: ${stim.text.slice(0, 48)}`);
    if (a.memory.length > 6) a.memory = a.memory.slice(-6);
  }

  const result = await generateReactions(stim, responders, opts);
  markPerceived(stim, responders);

  return { ...result, responders: responders.map((r) => ({ id: r.npc.id, name: r.npc.name, score: r.score })) };
}

/* ============================================================
   Ambient agency — NPCs act without being prompted by anything
   ============================================================ */

/** Who is most likely to post unprompted right now? */
export function pickAmbientActor(exclude = new Set()) {
  const s = getState();
  const candidates = s.npcs.filter((n) => !exclude.has(n.id));
  if (!candidates.length) return null;

  const scored = candidates.map((npc) => {
    const a = ensureAgent(npc);
    // talkative archetypes and good moods post more
    const base = {
      chaos: 0.9, influencer: 0.85, 'clout-chaser': 0.8, stan: 0.7,
      critic: 0.6, wholesome: 0.6, romantic: 0.55, brand: 0.5,
      rival: 0.5, mentor: 0.45, lurker: 0.25, ghost: 0.1,
    }[npc.archetype] ?? 0.5;

    const freshness = clamp((Date.now() - (a.lastSpokeAt || 0)) / 600_000, 0, 1);
    const mood = a.mood / 100;
    return { npc, score: base * (0.35 + freshness * 0.65) * (0.5 + mood) * a.attention };
  });

  scored.sort((x, y) => y.score - x.score);
  const top = scored.slice(0, 3);
  const total = top.reduce((sum, t) => sum + t.score, 0);
  let roll = Math.random() * total;
  for (const t of top) {
    roll -= t.score;
    if (roll <= 0) return t.npc;
  }
  return top[0]?.npc || null;
}

/** What would this NPC plausibly post? Local, free. */
export function ambientPostFor(npc) {
  const a = ensureAgent(npc);
  const mood = a.mood;

  const MOOD_POSTS = {
    low: [
      'everything is fine. everything is fine.',
      'not going to talk about it',
      'tired in a way sleep does not fix',
      'deleted the app for six minutes',
    ],
    mid: [
      'anyway.',
      'no thoughts',
      'this week has been a lot of week',
      'currently thinking about nothing specific',
      'unpopular opinion incoming',
    ],
    high: [
      'okay today is actually good',
      'small win and i\'m taking it',
      'the sunlight is doing something to me',
      'i like it here actually',
    ],
  };

  const bucket = mood < 35 ? 'low' : mood > 65 ? 'high' : 'mid';
  let text = rng.pick(MOOD_POSTS[bucket]);

  const tags = a.interests;
  if (tags.includes('food') && rng.chance(0.4)) {
    text = rng.pick(['the sourdough finally worked', 'made something and it came out right', 'coffee count: unclear']);
  } else if (tags.includes('competition') && rng.chance(0.35)) {
    text = rng.pick(['i\'m going to win and it\'s going to be embarrassing for everyone else', 'watching someone try very hard']);
  } else if (tags.includes('feelings') && rng.chance(0.3)) {
    text = rng.pick(['miss someone i shouldn\'t', 'feeling a way about it']);
  }

  return {
    text,
    kind: bucket === 'low' ? 'cryptic' : 'text',
    sentiment: (mood - 50) / 60,
    localsOnly: true,
  };
}

/** An NPC deciding to message the player unprompted. */
export function ambientDmFor(npc) {
  const a = ensureAgent(npc);
  const aff = npc.affinity ?? 0;

  if (a.grudge > 40) {
    return { text: rng.pick(['we should talk.', 'noticed your post.', 'can we not do this here.']), tone: 'cold' };
  }
  if (aff > 40 && a.mood > 55) {
    return { text: rng.pick(['hey. you around?', 'thinking about you', 'we should do something soon']), tone: 'flirty' };
  }
  if (a.mood < 35) {
    return { text: rng.pick(['are you awake', 'sorry it\'s late', 'never mind']), tone: 'anxious' };
  }
  return { text: rng.pick(['did you see the thing', 'quick question', 'ok this is going to sound weird']), tone: 'casual' };
}

export { topicsOf as classifyTopics };
