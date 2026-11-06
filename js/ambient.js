/* ============================================================
   ambient.js — the world moving without the player

   Two gaps this closes:

     1. Posts the player never touched got no replies. The reaction
        layer only ran on player stimuli, so a cast member's post sat
        there forever unless the player replied to it. Real feeds do
        not work that way — people reply to each other.

     2. Personas never addressed each other. Every reply was aimed at
        the player or at the void. Threads had no back-and-forth
        between characters.

   So this module runs a periodic pass over recent posts and lets the
   cast reply to each other, including replying to replies. It is one
   endpoint call per pass and it only touches posts that are still
   fresh enough to be worth engaging with.
   ============================================================ */

import { getState, addLog } from './db.js';
import { getConfig } from './config.js';
import { chatMessage } from './llm.js';
import { runToolCall, TOOLS } from './tools.js';
import { ensureAgent, noteSpoke, relevance } from './reactions.js';
import { storylineBrief } from './storylines.js';
import { situationBlock } from './prompts.js';
import { rng, clamp, uid } from './util.js';
import { dbg, warn } from './debug.js';

/** How many posts a single pass may engage with. */
const MAX_TARGETS = 3;

/** A post older than this is not worth replying to. */
const FRESH_MS = 45 * 60 * 1000;

/** Don't let one thread grow past this many replies. */
const THREAD_CAP = 40;

const AMBIENT_SYSTEM = `You are the conversation layer of a social-media life sim.

The player is ONE ordinary user. You never write their posts or speak for them.
You write replies BETWEEN the named characters — people talking to each other,
not to the player.

Rules:
- Reply as the character listed. Never invent new characters.
- Address the specific thing said. Quote it, argue with it, twist it.
- Characters may reply to another character's reply, not just the root post.
  When you do, set replyTo to that reply's author id.
- Take sides. Be petty, funny, unfair, or sincere. Do not be polite by default.
- Short. Lowercase. No hashtags. No emoji spam. No stage directions.
- Not everyone needs to reply. Two good replies beat five generic ones.
- If a CURRENTLY HAPPENING storyline is relevant, tie the reply to it.
- Never write a reply that would fit under any other post.`;

/**
 * Pick posts worth engaging with: recent, not already saturated, and
 * preferably ones with a live storyline attached.
 */
export function pickAmbientTargets(limit = MAX_TARGETS) {
  const s = getState();
  const now = Date.now();
  const cast = new Set(s.npcs.filter((n) => n.crowd !== true).map((n) => n.id));

  const candidates = s.posts
    .filter((p) => {
      if (!cast.has(p.authorId)) return false;      // cast posts only
      if (now - (p.ts || 0) > FRESH_MS) return false; // too old
      if ((p.replies || []).length >= THREAD_CAP) return false;
      return true;
    })
    .map((p) => {
      const replies = p.replies || [];
      // Prefer posts with some traction but not saturated ones.
      const traction = clamp(replies.length / 6, 0, 1);
      const freshness = clamp(1 - (now - (p.ts || 0)) / FRESH_MS, 0, 1);
      // A post whose author is in a live storyline is more worth replying to.
      const sl = (s.storylines || []).some((x) => (x.actors || []).includes(p.authorId) && x.heat >= 12);
      const score = freshness * 0.5 + traction * 0.3 + (sl ? 0.2 : 0);
      return { post: p, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return candidates.map((c) => c.post);
}

/**
 * Who could plausibly reply to this post? Excludes the author and anyone
 * who already replied. Uses the same relevance scoring as the reaction
 * layer so behaviour stays consistent.
 */
export function candidatesFor(post, limit = 3) {
  const s = getState();
  const already = new Set((post.replies || []).map((r) => r.authorId));
  const stim = {
    kind: 'post',
    id: post.id,
    postId: post.id,
    text: post.text || '',
    mentions: [],
    weight: 1,
    ts: Date.now(),
    authorId: post.authorId,
  };

  return s.npcs
    .filter((n) => n.crowd !== true && n.id !== post.authorId && !already.has(n.id))
    .map((npc) => ({ npc, score: relevance(npc, stim) }))
    .filter((r) => r.score >= 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * One ambient conversation pass. Returns how many replies landed.
 * Costs at most one endpoint call.
 */
export async function runAmbientConversation() {
  const cfg = getConfig();
  const s = getState();
  const targets = pickAmbientTargets();
  if (!targets.length) return { ok: true, delivered: 0, reason: 'no targets' };

  // Build the candidate set per target, then flatten into one prompt.
  const plan = [];
  for (const post of targets) {
    const cands = candidatesFor(post);
    if (!cands.length) continue;
    plan.push({ post, cands });
  }
  if (!plan.length) return { ok: true, delivered: 0, reason: 'no candidates' };

  // Local path — free, instant.
  if (cfg.demoMode || !cfg.optimise.enabled) {
    let delivered = 0;
    for (const { post, cands } of plan) {
      for (const { npc, score } of cands.slice(0, 2)) {
        if (!rng.chance(clamp(score + 0.1, 0, 0.9))) continue;
        if (deliverAmbientReply(npc, post, null)) delivered++;
      }
    }
    return { ok: true, delivered, local: true };
  }

  const situation = situationBlock({
    premise: s.meta?.premise,
    storylines: storylineBrief(),
  });

  const threadContext = plan.map(({ post, cands }) => ({
    postId: post.id,
    author: post.authorName,
    text: String(post.text).slice(0, 220),
    existingReplies: (post.replies || []).slice(-4).map((r) => ({
      author: r.authorName,
      authorId: r.authorId,
      text: String(r.text).slice(0, 120),
    })),
    candidates: cands.map(({ npc }) => {
      const a = ensureAgent(npc);
      return {
        id: npc.id,
        name: npc.name,
        archetype: npc.archetype,
        affinity: npc.affinity ?? 0,
        mood: Math.round(a.mood),
        grudge: Math.round(a.grudge),
        interests: a.interests,
      };
    }),
  }));

  try {
    const msg = await chatMessage({
      messages: [
        { role: 'system', content: AMBIENT_SYSTEM },
        {
          role: 'user',
          content: [
            situation,
            '',
            'THREADS TO CONTINUE:',
            JSON.stringify(threadContext),
            '',
            'Write 2-4 replies total across these threads. Characters should',
            'talk to each other, not just to the original author. Use',
            'reply_to_post with the postId. Set replyTo when answering a',
            'specific reply.',
          ].join('\n'),
        },
      ],
      tools: TOOLS.filter((t) =>
        ['reply_to_post', 'heat_storyline', 'adjust_relationship'].includes(t.function.name)
      ),
      toolChoice: 'auto',
      tier: 'cheap',
      maxTokens: 900,
      temperature: 1.0,
      cache: false,
    });

    let delivered = 0;
    const validPostIds = new Set(plan.map((p) => p.post.id));
    const validSpeakers = new Set(plan.flatMap((p) => p.cands.map((c) => c.npc.id)));

    for (const call of msg.tool_calls || []) {
      const name = call.function?.name;
      let args = {};
      try { args = JSON.parse(call.function?.arguments || '{}'); } catch { continue; }

      if (name === 'reply_to_post') {
        if (!validPostIds.has(args.postId)) continue;
        if (!validSpeakers.has(args.author)) continue;
        const npc = s.npcs.find((n) => n.id === args.author);
        const post = s.posts.find((p) => p.id === args.postId);
        if (!npc || !post) continue;
        if (deliverAmbientReply(npc, post, args)) delivered++;
        continue;
      }
      runToolCall(call);
    }

    if (delivered) {
      for (const { cands } of plan) for (const { npc } of cands) noteSpoke(npc, 0.12);
      addLog({ kind: 'ambient', title: 'Cast replied to each other', detail: `${delivered} replies`, level: 'ok' });
    }
    return { ok: true, delivered, calls: 1 };
  } catch (e) {
    if (e?.name !== 'LLMError') warn('ambient conversation failed', e);
    addLog({ kind: 'llm', title: 'Ambient conversation fell back', detail: e.message, level: 'warn' });
    // Fall back to local so the thread still gets a reply.
    let delivered = 0;
    for (const { post, cands } of plan) {
      const { npc } = cands[0];
      if (deliverAmbientReply(npc, post, null)) delivered++;
    }
    return { ok: false, delivered, error: e.message };
  }
}

/**
 * Attach a reply to a post. Handles both "reply to the post" and
 * "reply to a specific reply" (replyTo).
 */
export function deliverAmbientReply(npc, post, args = null) {
  if (!post) return false;
  post.replies = post.replies || [];
  if (post.replies.length >= THREAD_CAP) return false;

  const text = String(args?.text || '').trim();
  if (!text) return false;

  // Don't let the same character say the same thing twice.
  if (post.replies.some((r) => r.authorId === npc.id && r.text === text)) return false;

  // Resolve who this reply is aimed at, if anyone.
  let replyTo = null;
  let replyToHandle = null;
  if (args?.replyTo) {
    const target = post.replies.find((r) => r.authorId === args.replyTo);
    if (target) {
      replyTo = target.authorId;
      replyToHandle = target.authorHandle;
    }
  }

  post.replies.push({
    id: uid('rep'),
    authorId: npc.id,
    authorName: npc.name,
    authorHandle: npc.handle,
    text: text.slice(0, 300),
    ts: Date.now(),
    reacted: true,
    replyTo,
    replyToHandle,
  });

  // A reply is engagement — the post gets a little more reach.
  post.likes = (post.likes || 0) + rng.int(1, 9);
  npc.lastActive = Date.now();
  noteSpoke(npc);
  return true;
}
