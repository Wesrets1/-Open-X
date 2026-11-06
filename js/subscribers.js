/* ============================================================
   subscribers.js — realistic follower growth

   Follower count used to be `clout * 1.8` plus noise, recomputed on a
   timer. That meant the number moved for no reason and never responded
   to what the player actually did. Nobody gained followers for a good
   post or lost them for a bad one.

   Real growth is driven by two things:

     1. VISIBILITY — how many people saw the post. A post that gets
        replies and likes reached more people, so more of them follow.

     2. RECEPTION — whether those people liked what they saw. A warm,
        funny or interesting post converts. A sour or try-hard one
        actively loses followers.

   So each post earns a delta computed from its own engagement and tone,
   and the ledger records why. The Home tab reads that ledger to show
   "you gained 14 subscribers — your post about the vending machine
   landed" instead of an unexplained number.
   ============================================================ */

import { getState, commit } from './db.js';
import { clamp, uid } from './util.js';
import { dbg } from './debug.js';

/** How many ledger entries to keep. */
const LOG_LIMIT = 40;

/* ============================================================
   Reception scoring — local, free, deterministic-ish
   ============================================================ */

/* Words that make a post land. Warmth, specificity, humour. */
const GOOD_SIGNALS = [
  { re: /\b(funny|lmao|lol|hilarious|joke|bit)\b/i, w: 0.16 },
  { re: /\b(thank|grateful|appreciate|love|proud|kind)\b/i, w: 0.14 },
  { re: /\b(finally|actually|honestly|genuinely)\b/i, w: 0.06 },
  { re: /\b(we|us|together|everyone)\b/i, w: 0.08 },
  { re: /\?/, w: 0.05 }, // questions invite replies
];

/* Words that make a post land badly. */
const BAD_SIGNALS = [
  { re: /\b(hate|stupid|idiot|pathetic|loser|trash|garbage)\b/i, w: -0.22 },
  { re: /\b(shut up|nobody asked|who cares|don't care)\b/i, w: -0.2 },
  { re: /\b(buy|sale|discount|promo|link in bio|dm me)\b/i, w: -0.14 },
  { re: /[A-Z]{6,}/, w: -0.1 }, // SHOUTING
  { re: /!{3,}/, w: -0.08 },
];

/**
 * How well did this post land? -1 (badly) .. 1 (very well).
 * Combines the text's own signals with how people actually responded.
 */
export function receptionOf(post) {
  const text = String(post.text || '');
  let score = 0;

  for (const s of GOOD_SIGNALS) if (s.re.test(text)) score += s.w;
  for (const s of BAD_SIGNALS) if (s.re.test(text)) score += s.w;

  // Engagement is the strongest signal. A post nobody touched converts
  // nobody; a post with a real conversation converts well.
  const replies = (post.replies || []).length;
  const likes = post.likes || 0;
  const views = Math.max(likes * 4, 1);

  const engagementRate = clamp((replies * 3 + likes) / Math.max(views, 1), 0, 1);
  score += engagementRate * 0.5;

  // A pile-on is not success. If most replies are hostile, it reads badly.
  const hostile = (post.replies || []).filter((r) => r.sentiment < -0.25).length;
  if (replies >= 3 && hostile / replies > 0.5) score -= 0.25;

  // Long posts that say nothing do worse than short sharp ones.
  if (text.length > 280) score -= 0.08;

  return clamp(score, -1, 1);
}

/**
 * How many people saw this post? Scales with the author's reach and how
 * much the post was actually engaged with. This is the "visibility" half.
 */
export function visibilityOf(post, followers = 0) {
  const likes = post.likes || 0;
  const replies = (post.replies || []).length;
  const base = Math.max(followers * 0.35, 40);
  // Engagement pushes a post beyond the author's own reach — that is how
  // something "goes further" than the account that posted it.
  const boost = 1 + Math.min(4, (likes + replies * 8) / Math.max(base, 1));
  return Math.round(base * boost);
}

/**
 * Compute the subscriber delta for one post.
 * Positive when it landed and reached people; negative when it soured.
 */
export function subscriberDeltaFor(post, followers = 0) {
  const reception = receptionOf(post);
  const reach = visibilityOf(post, followers);

  // Conversion rate: how many viewers actually subscribe. A well-received
  // post converts a small fraction of its reach; a badly-received one
  // loses a fraction of the existing base instead.
  const convertRate = 0.004 + reception * 0.012;
  let delta = Math.round(reach * convertRate);

  // A genuinely bad post costs followers — people leave quietly.
  if (reception < -0.15) {
    const churn = Math.round(Math.max(followers, 1) * Math.abs(reception) * 0.006);
    delta -= churn;
  }

  // Small posts should not swing the number wildly.
  const cap = Math.max(6, Math.round(Math.max(followers, 1) * 0.06));
  return clamp(delta, -cap, cap);
}

/* ============================================================
   Ledger
   ============================================================ */

export function subscriberLog() {
  const s = getState();
  if (!Array.isArray(s.subscriberLog)) s.subscriberLog = [];
  return s.subscriberLog;
}

/** Record a gain or loss with the reason it happened. */
export function recordSubscribers(delta, reason, { postId = null } = {}) {
  const s = getState();
  if (!delta) return null;
  if (!Array.isArray(s.subscriberLog)) s.subscriberLog = [];

  const entry = {
    id: uid('sub'),
    ts: Date.now(),
    delta: Math.round(delta),
    reason: String(reason || '').slice(0, 120),
    postId,
  };
  s.subscriberLog.unshift(entry);
  if (s.subscriberLog.length > LOG_LIMIT) s.subscriberLog.length = LOG_LIMIT;

  s.player.followers = Math.max(0, Math.round((s.player.followers || 0) + delta));
  dbg('subscribers', delta, reason);
  return entry;
}

/**
 * Apply growth for a post once its reactions have landed.
 * Called after the reaction pass settles, so engagement is final.
 */
export function settlePostSubscribers(postId) {
  const s = getState();
  const post = s.posts.find((p) => p.id === postId);
  if (!post || post.subsSettled) return null;
  post.subsSettled = true;

  const delta = subscriberDeltaFor(post, s.player.followers);
  if (!delta) return null;

  const reception = receptionOf(post);
  const reason = delta > 0
    ? reception > 0.35
      ? 'a post landed well'
      : 'a post got some reach'
    : 'a post did not land';
  const entry = recordSubscribers(delta, reason, { postId });
  commit('subscribers');
  return entry;
}

/** Net change over a window, for the Home summary. */
export function subscriberSummary(sinceMs = 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - sinceMs;
  const entries = subscriberLog().filter((e) => e.ts >= cutoff);
  const gained = entries.filter((e) => e.delta > 0).reduce((a, e) => a + e.delta, 0);
  const lost = entries.filter((e) => e.delta < 0).reduce((a, e) => a + e.delta, 0);
  return { gained, lost, net: gained + lost, count: entries.length, entries };
}
