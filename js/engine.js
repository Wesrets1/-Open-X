/* ============================================================
   engine.js — game rules, autonomy, action handlers

   Call-optimisation strategy:
     • Local physics first: followers and mood tick without
       any endpoint traffic.
     • Autonomy is queued and flushed in ONE batched call per cycle.
     • Identical player actions within the coalesce window reuse the
       in-flight request (handled in llm.js).
     • Failure is never fatal: the local generator keeps the world alive.
   ============================================================ */

import { getState, commit, addLog, addEvent, addPost, addThread, getNpc } from './db.js';
import { getConfig } from './config.js';
import { chatMessage, chatJSON, LLMError } from './llm.js';
import { runToolCall, TOOLS, worldSnapshot } from './tools.js';
import { storylineBrief, seedStorylines, seedStorylineIfCold, decayStorylines } from './storylines.js';
import {
  worldSystemPrompt, feedSystemPrompt, dmSystemPrompt,
  suggestionSystemPrompt, autonomySystemPrompt, summaryPrompt,
} from './prompts.js';
import { rng, clamp, uid, fmtNum, sleep, debounce } from './util.js';
import { crowdReply, crowdEngagement, topUpCrowd, crowdMembers } from './crowd.js';
import { foldLore, memoryBrief, extractFacts } from './memory.js';
import { dbg, warn } from './debug.js';
import {
  reactTo, makePostStimulus, makeDmStimulus, makeReplyStimulus,
  extractMentions, markPerceived, selectResponders, relevance,
  ensureAgent, driftAgents, noteSpoke, pickAmbientActor,
  ambientPostFor, ambientDmFor, localReaction,
} from './reactions.js';

/* ============================================================
   Followers / passive drift
   ============================================================ */

export function recomputeFollowers() {
  const s = getState();
  const base = s.stats.clout * 1.8;
  const noise = (Math.random() - 0.45) * 2.5;
  s.player.followers = Math.max(0, Math.round(base + noise));
  s.player.following = s.npcs.length;
  return s.player.followers;
}

export function tickPassive() {
  const s = getState();
  const changed = { followers: false, drift: [] };

  // mood drifts toward 60 slowly
  if (Math.random() < 0.25) {
    const d = s.stats.mood > 60 ? -1 : 1;
    s.stats.mood = clamp(s.stats.mood + d, 0, 100);
  }

  // clout decay if idle
  const idle = Date.now() - new Date(s.posts[0]?.ts || s.createdAt).getTime();
  if (idle > 30 * 60 * 1000 && s.stats.clout > 0 && Math.random() < 0.15) {
    s.stats.clout = Math.max(0, s.stats.clout - 1);
    changed.drift.push('clout');
  }

  // Followers only need recomputing when clout moves, or occasionally.
  // (Recomputing every tick causes needless re-renders that fight typing.)
  const before = s.player.followers;
  if (changed.drift.includes('clout') || Math.random() < 0.12) {
    recomputeFollowers();
  }
  if (s.player.followers !== before) changed.followers = true;

  if (changed.followers || changed.drift.length) commit('tick', { silent: true });
  return changed;
}

/* ============================================================
   Player actions
   ============================================================ */

/**
 * Publish a player post. Free to do — no resource cost.
 */
export async function publishPost(text, { withReactions = true } = {}) {
  text = String(text || '').trim();
  if (!text) return { ok: false, error: 'Write something first.' };

  const s = getState();
  const post = addPost({
    authorId: 'player',
    authorName: s.player.name,
    authorHandle: s.player.handle,
    verified: s.player.verified,
    text,
    kind: detectPostKind(text),
    sentiment: 0.4,
    likes: 0,
  });
  s.stats.posts++;
  s.stats.clout += 2;
  s.stats.mood = clamp(s.stats.mood + 3, 0, 100);
  s.stats.streak++;
  addLog({ kind: 'post', title: 'You posted', detail: text.slice(0, 70), level: 'ok' });
  commit('post');

  if (withReactions) {
    // Reactions land asynchronously — don't block the composer, but
    // make sure the commit that follows triggers a repaint.
    reactToPlayerPost(post.id).catch((e) => warn('reaction pass failed', e));
  }
  return { ok: true, post };
}

function detectPostKind(text) {
  if (/[?]\s*$/.test(text)) return 'vague';
  if (/!{2,}|😤|🙄/.test(text)) return 'drama';
  if (/\b(so grateful|thank you|love this)\b/i.test(text)) return 'wholesome';
  if (/\b(launch|announce|new)\b/i.test(text)) return 'announcement';
  return 'text';
}

/**
 * Ask the world to react to the player's post.
 * Reactions come from agents who actually care — see reactions.js.
 */
export async function reactToPlayerPost(postId) {
  const s = getState();
  const post = s.posts.find((p) => p.id === postId);
  if (!post) return;

  // Background noise first — the timeline should look like it was seen by
  // strangers, not just by the named cast. This is local and free.
  crowdEngagement(post.id, { looks: true });
  crowdReply(post.id, { min: 1, max: 5 });

  const stim = makePostStimulus(post);
  const result = await reactTo(stim, { max: 3 });
  commit('reactions');
  return result;
}

/** Like a post — free, no endpoint call. */
export function likePost(postId) {
  const post = getState().posts.find((p) => p.id === postId);
  if (!post) return { ok: false };
  post.likes = (post.likes || 0) + 1;
  post.likedByPlayer = true;
  getState().stats.mood = clamp(getState().stats.mood + 1, 0, 100);
  commit('like');
  return { ok: true };
}

/** Reply to a post as the player. */
export function replyAsPlayer(postId, text) {
  text = String(text || '').trim();
  if (!text) return { ok: false, error: 'Empty reply.' };
  const post = getState().posts.find((p) => p.id === postId);
  if (!post) return { ok: false, error: 'Post not found.' };
  const s = getState();
  post.replies = post.replies || [];
  post.replies.push({
    id: uid('rep'),
    authorId: 'player',
    authorName: s.player.name,
    authorHandle: s.player.handle,
    text: text.slice(0, 300),
    ts: Date.now(),
    mine: true,
  });
  s.stats.clout += 1;
  commit('reply');

  // The post's author notices. Mentioning someone else pulls them in too.
  const stim = makeReplyStimulus(postId, text, post.authorId);
  reactTo(stim, { max: 2 }).then(() => commit('reactions')).catch((e) => warn('reply reactions failed', e));

  return { ok: true };
}

/* ============================================================
   DMs
   ============================================================ */

export function openThreadWith(npcId) {
  const s = getState();
  let t = s.threads.find((x) => x.npcId === npcId);
  if (!t) {
    const npc = getNpc(npcId);
    if (!npc) return null;
    t = addThread({ npcId, messages: [], unread: 0, ts: Date.now() });
    commit('thread-new');
  }
  return t;
}

export function markThreadRead(threadId) {
  const t = getState().threads.find((x) => x.id === threadId);
  if (t?.unread) {
    t.unread = 0;
    commit('thread-read');
  }
}

/**
 * Player sends a DM. One endpoint call, tools enabled for
 * relationship shifts and follow-up messages.
 */
export async function sendDM(threadId, text, { signal } = {}) {
  text = String(text || '').trim();
  if (!text) return { ok: false, error: 'Empty message.' };
  const s = getState();
  const thread = s.threads.find((t) => t.id === threadId);
  if (!thread) return { ok: false, error: 'Thread not found.' };
  const npc = getNpc(thread.npcId);
  if (!npc) return { ok: false, error: 'Character not found.' };

  thread.messages.push({ id: uid('msg'), from: 'player', text, ts: Date.now() });
  thread.ts = Date.now();
  commit('dm-send');

  const stim = makeDmStimulus(text, npc.id);
  const agent = ensureAgent(npc);

  // Demo mode: reply from the character's own state, no endpoint call.
  if (getConfig().demoMode) {
    await sleep(420 + Math.random() * 500);
    const reply = localReaction(npc, stim) || fallbackReply(npc, text);
    thread.messages.push({
      id: uid('msg'),
      from: npc.id,
      text: reply,
      tone: 'casual',
      ts: Date.now(),
    });
    noteSpoke(npc);
    thread.ts = Date.now();
    npc.lastActive = Date.now();
    commit('dm-receive');
    return { ok: true, delivered: true, local: true };
  }

  const history = trimHistory(thread.messages, 14);
  const messages = [
    {
      role: 'system',
      content: dmSystemPrompt(npc, worldSnapshot(), {
        mood: Math.round(agent.mood),
        patience: Math.round(agent.patience),
        grudge: Math.round(agent.grudge),
        attention: Math.round(agent.attention * 100),
        interests: agent.interests,
        memory: agent.memory.slice(-3),
        summary: thread.summary || '',
        worldMemory: memoryBrief(npc.id, 8),
      }),
    },
    ...history.map((m) => ({
      role: m.from === 'player' ? 'user' : 'assistant',
      content: m.text,
    })),
  ];

  try {
    const cfg = getConfig();
    const msg = await chatMessage({
      messages,
      tools: cfg.optimise.enabled
        ? TOOLS.filter((t) => ['send_dm', 'adjust_relationship', 'adjust_player', 'set_flag', 'remember_fact'].includes(t.function.name))
        : undefined,
      toolChoice: cfg.optimise.enabled ? 'auto' : undefined,
      tier: 'main',
      maxTokens: 700,
      temperature: 0.95,
      cache: false,
      signal,
    });

    const calls = msg.tool_calls || [];
    let delivered = false;
    for (const call of calls) {
      const name = call.function?.name;
      if (name === 'send_dm') {
        // refuse impersonation of anyone but this character
        let args = {};
        try { args = JSON.parse(call.function?.arguments || '{}'); } catch {}
        if (args.from && args.from !== npc.id) {
          addLog({ kind: 'tool', title: 'DM rejected', detail: `tried to speak as ${args.from}`, level: 'warn' });
          continue;
        }
        delivered = true;
      }
      runToolCall(call);
    }

    // The model may answer in content instead of calling send_dm.
    if (!delivered && msg.content && msg.content.trim()) {
      thread.messages.push({
        id: uid('msg'),
        from: npc.id,
        text: msg.content.trim(),
        tone: 'casual',
        ts: Date.now(),
      });
      delivered = true;
    }

    noteSpoke(npc);
    thread.ts = Date.now();
    npc.lastActive = Date.now();
    commit('dm-receive');

    // Pull durable facts out of the exchange so this conversation can be
    // remembered somewhere else later. Fire-and-forget: it must never
    // block the reply the player already sees.
    const lastMsg = getState().threads.find((t) => t.id === threadId)?.messages.slice(-1)[0];
    if (lastMsg && lastMsg.from === npc.id) {
      extractFacts({
        playerText: text,
        replyText: lastMsg.text,
        npcId: npc.id,
        npcName: npc.name,
        source: 'dm',
      }).catch(() => {});
    }

    // The character's reply may itself provoke others — but only if
    // the player's message named somebody, and only a named cast member.
    // Crowd accounts must never open a DM thread.
    const mentioned = extractMentions(text);
    if (mentioned.length) {
      const others = getState().npcs.filter(
        (n) => n.crowd !== true
          && n.id !== npc.id
          && mentioned.includes(n.handle.replace(/^@/, '').toLowerCase())
      );
      if (others.length) {
        const echo = makeReplyStimulus(null, text);
        echo.postId = null;
        for (const other of others) {
          const text2 = localEcho(other, text);
          if (!text2) continue;
          let t2 = getState().threads.find((t) => t.npcId === other.id);
          if (!t2) t2 = addThread({ npcId: other.id });
          t2.messages.push({ id: uid('msg'), from: other.id, text: text2, tone: 'casual', ts: Date.now() });
          t2.unread = (t2.unread || 0) + 1;
          t2.ts = Date.now();
          noteSpoke(other);
        }
        commit('dm-echo');
      }
    }

    return { ok: true, delivered };
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, aborted: true };
    // graceful offline fallback so the conversation never dead-ends
    thread.messages.push({
      id: uid('msg'),
      from: npc.id,
      text: fallbackReply(npc, text),
      tone: 'casual',
      ts: Date.now(),
      offline: true,
    });
    noteSpoke(npc);
    addLog({ kind: 'llm', title: 'DM fell back to local reply', detail: e.message, level: 'warn' });
    commit('dm-fallback');
    return { ok: true, fallback: true, error: e.message };
  }
}

/** A third party chiming in because they were named. */
function localEcho(npc, text) {
  const a = ensureAgent(npc);
  if (a.grudge > 50) return rng.pick(['why am i being mentioned here', 'leave me out of this']);
  if ((npc.affinity ?? 0) > 30) return rng.pick(['wait what\'s happening', 'i was mentioned?? i\'m here']);
  return rng.pick(['huh?', 'not sure why i\'m in this', 'what did i do']);
}

function fallbackReply(npc, playerText) {
  const warm = (npc.affinity ?? 0) > 20;
  const t = playerText.toLowerCase();
  if (/\?$/.test(t)) return warm ? 'honestly, yeah. probably.' : 'why are you asking me that';
  if (/\b(sorry|my bad)\b/.test(t)) return 'it\'s fine. really.';
  if (/\b(hi|hey|hello)\b/.test(t)) return warm ? 'hey you 👋' : 'oh. hi.';
  return warm
    ? 'okay i hear you. tell me more?'
    : 'hmm. noted.';
}

function trimHistory(messages, n) {
  if (messages.length <= n) return messages;
  return messages.slice(-n);
}

/* ============================================================
   Suggestions
   ============================================================ */

export async function suggestPosts() {
  const cfg = getConfig();
  if (cfg.demoMode) {
    await sleep(420);
    return [
      'the coffee machine broke and i have never felt more alive',
      'unpopular opinion: i don\'t actually miss anyone',
      'day 4 of trying to be a person. progress unclear.',
    ];
  }
  try {
    const json = await chatJSON({
      messages: [
        { role: 'system', content: suggestionSystemPrompt(worldSnapshot()) },
        { role: 'user', content: 'Give me 3 options.' },
      ],
      tier: 'cheap',
      maxTokens: 220,
      schema: true,
    });
    const opts = Array.isArray(json.options) ? json.options : [];
    return opts.filter((x) => typeof x === 'string').slice(0, 3);
  } catch (e) {
    warn('suggestions failed', e);
    return [];
  }
}

/* ============================================================
   Autonomy — batched world activity
   ============================================================ */

let autonomyTimer = null;
let autonomyBusy = false;

export function startAutonomy() {
  stopAutonomy();
  const cfg = getConfig();
  const interval = cfg.pace === 'chill' ? 180000 : cfg.pace === 'chaotic' ? 45000 : 100000;
  autonomyTimer = setInterval(() => {
    if (!getConfig().autonomy) return;
    runAutonomyTick().catch((e) => warn('autonomy tick failed', e));
  }, interval);
  dbg('autonomy started', interval);
}

export function stopAutonomy() {
  if (autonomyTimer) clearInterval(autonomyTimer);
  autonomyTimer = null;
}

/**
 * One batched autonomy cycle.
 * Exactly ONE endpoint call, regardless of how many events it produces.
 */
export async function runAutonomyTick() {
  if (autonomyBusy) return { skipped: true };
  const cfg = getConfig();
  autonomyBusy = true;
  try {
    if (cfg.demoMode) {
      runLocalAmbient();
      return { ok: true, local: true };
    }

    driftAgents();
    decayStorylines();

    const st = getState();
    // Keep at least two subjects in play so the feed always has a throughline.
    seedStorylineIfCold(st.npcs, st.meta?.theme);

    const mood = moodLabel(st.stats.mood);
    const actors = [];
    const busy = new Set();
    for (let i = 0; i < 3; i++) {
      const a = pickAmbientActor(busy);
      if (a) { actors.push(a); busy.add(a.id); }
    }

    const msg = await chatMessage({
      messages: [
        {
          role: 'system',
          content: autonomySystemPrompt(
            worldSnapshot(),
            mood,
            actors.map((n) => {
              const ag = ensureAgent(n);
              return {
                id: n.id, name: n.name, archetype: n.archetype,
                affinity: n.affinity ?? 0,
                mood: Math.round(ag.mood),
                grudge: Math.round(ag.grudge),
                interests: ag.interests,
              };
            }),
            {
              premise: st.meta?.premise,
              storylines: storylineBrief(),
              recentPosts: st.posts.slice(0, 3).map((p) => `${p.authorName}: ${String(p.text).slice(0, 90)}`).join('\n'),
            }
          ),
        },
        { role: 'user', content: 'Generate ambient activity now.' },
      ],
      // Only the naming tools. Crowd accounts are excluded from `actors`
      // above, so the model cannot speak as one.
      tools: TOOLS.filter((t) =>
        ['create_post', 'reply_to_post', 'send_dm', 'adjust_relationship', 'log_event', 'remember_fact', 'start_storyline', 'heat_storyline']
          .includes(t.function.name)
      ),
      toolChoice: 'auto',
      tier: 'cheap',
      maxTokens: 900,
      temperature: 1.0,
      cache: false,
    });

    const allowed = new Set(actors.map((n) => n.id));
    const calls = msg.tool_calls || [];
    let applied = 0;

    for (const call of calls) {
      const name = call.function?.name;
      let args = {};
      try { args = JSON.parse(call.function?.arguments || '{}'); } catch { continue; }

      // enforce the actor set so the model can't invent people
      const speaker = args.author || args.from || args.character;
      if (['create_post', 'send_dm', 'reply_to_post', 'adjust_relationship'].includes(name)) {
        if (speaker && speaker !== 'player' && !allowed.has(speaker)) {
          addLog({ kind: 'tool', title: 'Ambient action rejected', detail: `${speaker} was not scheduled to act`, level: 'warn' });
          continue;
        }
      }
      runToolCall(call);
      applied++;
    }

    if (!applied) {
      dbg('autonomy produced no usable calls, using local ambient');
      runLocalAmbient();
    }
    tickPassive();
    commit('autonomy');
    return { ok: true, calls: applied };
  } catch (e) {
    addLog({ kind: 'llm', title: 'Ambient tick failed', detail: e.message, level: 'warn' });
    runLocalAmbient();
    commit('autonomy-fallback');
    return { ok: false, error: e.message };
  } finally {
    autonomyBusy = false;
  }
}

/** Zero-cost ambient activity, used in demo mode and as a fallback. */
export function runLocalAmbient() {
  const s = getState();
  if (!s.npcs.length) return;

  driftAgents();

  const actions = rng.int(1, 2);
  const busy = new Set();

  for (let i = 0; i < actions; i++) {
    const npc = pickAmbientActor(busy);
    if (!npc) continue;
    busy.add(npc.id);

    const roll = Math.random();

    if (roll < 0.55) {
      const spec = ambientPostFor(npc);
      addPost({
        authorId: npc.id,
        authorName: npc.name,
        authorHandle: npc.handle,
        verified: !!npc.verified,
        text: spec.text,
        kind: spec.kind,
        sentiment: spec.sentiment,
        likes: Math.round(npc.followers * (0.008 + Math.random() * 0.014)),
      });
      npc.posts = (npc.posts || 0) + 1;
      npc.lastActive = Date.now();
      noteSpoke(npc);
    } else if (roll < 0.8) {
      const spec = ambientDmFor(npc);
      let t = s.threads.find((x) => x.npcId === npc.id);
      if (!t) t = addThread({ npcId: npc.id });
      t.messages.push({
        id: uid('msg'),
        from: npc.id,
        text: spec.text,
        tone: spec.tone,
        ts: Date.now(),
      });
      t.unread = (t.unread || 0) + 1;
      t.ts = Date.now();
      npc.lastActive = Date.now();
      noteSpoke(npc);
    } else {
      // NPCs also react to each other — the world moves without you.
      const others = s.posts.filter((p) => p.authorId !== npc.id).slice(0, 12);
      if (others.length && rng.chance(0.6)) {
        const target = rng.pick(others);
        target.replies = target.replies || [];
        if (!target.replies.some((r) => r.authorId === npc.id)) {
          target.replies.push({
            id: uid('rep'),
            authorId: npc.id,
            authorName: npc.name,
            authorHandle: npc.handle,
            text: localReaction(npc, { id: target.id, postId: target.id, text: target.text, mentions: [], kind: 'post' }) || 'hmm',
            ts: Date.now(),
            reacted: true,
          });
          target.likes = (target.likes || 0) + rng.int(1, 8);
          noteSpoke(npc);
        }
      } else {
        const e = rng.pick([
          { kind: 'growth', title: 'Your follower count ticked up' },
          { kind: 'social', title: `${npc.name} posted something you should see` },
          { kind: 'mood', title: 'You took an accidental nap' },
          { kind: 'money', title: 'A small payment landed' },
        ]);
        addEvent({ ...e, detail: npc.handle });
      }
    }
  }
  tickPassive();
  commit('ambient');
}

function localPostText(npc, kind) {
  return ambientPostFor(npc).text;
}

export function moodLabel(mood) {
  if (mood >= 80) return 'euphoric';
  if (mood >= 62) return 'good';
  if (mood >= 45) return 'steady';
  if (mood >= 28) return 'restless';
  return 'low';
}

/* ============================================================
   History compaction
   ============================================================ */

export async function summariseThread(threadId) {
  const cfg = getConfig();
  const s = getState();
  const t = s.threads.find((x) => x.id === threadId);
  if (!t) return;
  const limit = cfg.optimise.summariseAfter || 24;
  if (t.messages.length < limit) return;

  const old = t.messages.slice(0, t.messages.length - 8);
  if (cfg.demoMode) {
    t.summary = (t.summary || '') + ' [earlier conversation summarised]';
    t.messages = t.messages.slice(-8);
    commit('thread-compact');
    return;
  }
  try {
    const summary = await chatMessage({
      messages: [{ role: 'user', content: summaryPrompt(old) }],
      tier: 'cheap',
      maxTokens: 120,
      temperature: 0.3,
      cache: true,
      cacheKey: 'summary' + threadId + old.length,
    });
    t.summary = (summary.content || '').trim() || t.summary;
    t.messages = t.messages.slice(-8);
    addLog({ kind: 'llm', title: 'Thread compacted', detail: `${old.length} messages summarised`, level: 'ok' });
    commit('thread-compact');
  } catch (e) {
    warn('summarise failed', e);
  }
}

/* ============================================================
   Bootstrap
   ============================================================ */

/**
 * Make sure the active world has a cast. Worlds are normally built
 * by js/worlds.js; this is the safety net for the very first run
 * (or a corrupted save) so the app is never empty.
 */
export async function bootstrapWorld() {
  const s = getState();

  // Saves written before storylines existed have an empty array. Seed them
  // lazily so an existing world gains ongoing subjects without a reset.
  if (s.npcs.length && !s.storylines?.length) {
    seedStorylines(s.npcs, s.meta?.theme);
    commit('storylines-seeded');
  }

  if (s.npcs.length) return;

  const { ensureWorld } = await import('./worlds.js');
  const created = ensureWorld();
  if (created) return;

  // Adopted an existing save but it had no cast — repair in place.
  const cur = getState();
  if (cur.npcs.length) return;
  const { buildFromTemplate } = await import('./worlds.js');
  const built = buildFromTemplate(cur.meta?.theme || 'modern');
  cur.npcs = built.state.npcs;
  cur.posts = cur.posts.length ? cur.posts : built.state.posts;
  cur.stats.clout = Math.max(cur.stats.clout, 4);
  recomputeFollowers();
  addEvent({ kind: 'system', title: 'Cast restored', detail: 'Your world was rebuilt.' });
  commit('bootstrap');
}

export { fmtNum };
