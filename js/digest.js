/* ============================================================
   digest.js — the Home tab heads-up summary

   A short, scannable brief of what actually matters right now:

     • what the world is currently arguing about
     • who is talking to whom, and about what
     • how many subscribers you gained or lost, and why
     • anything that needs your attention (unread DMs, a pile-on)

   Everything here is computed locally from state — no endpoint call.
   The prose is templated but driven by real data, so it stays honest
   and costs nothing to render.
   ============================================================ */

import { getState } from './db.js';
import { liveStorylines } from './storylines.js';
import { subscriberSummary } from './subscribers.js';
import { clamp } from './util.js';

/** How far back the digest looks. */
const WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * Build the digest object the Home tab renders.
 * @returns {{ storylines, activity, subscribers, attention, headline }}
 */
export function buildDigest() {
  const s = getState();
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  /* ---- what is happening ---- */
  const storylines = liveStorylines().map((sl) => {
    const names = (sl.actors || [])
      .map((id) => s.npcs.find((n) => n.id === id)?.name)
      .filter(Boolean);
    // How much activity has this subject actually generated recently?
    const beats = s.posts.filter((p) => {
      if ((p.ts || 0) < cutoff) return false;
      const t = String(p.text || '').toLowerCase();
      const title = String(sl.title || '').toLowerCase();
      const key = title.replace(/^the\s+/, '').split(' ')[0];
      return key && t.includes(key);
    }).length;
    return {
      id: sl.id,
      title: sl.title,
      tension: sl.tension,
      actors: names,
      heat: sl.heat,
      beats,
      lastBeat: sl.lastBeat,
    };
  });

  /* ---- who is talking ---- */
  const recentPosts = s.posts.filter((p) => (p.ts || 0) >= cutoff);
  const recentReplies = [];
  for (const p of s.posts) {
    for (const r of p.replies || []) {
      if ((r.ts || 0) >= cutoff) recentReplies.push({ ...r, postId: p.id, postAuthor: p.authorName });
    }
  }

  // Characters who spoke most recently, and how much.
  const byAuthor = new Map();
  for (const p of recentPosts) {
    if (p.authorId === 'player') continue;
    const e = byAuthor.get(p.authorId) || { name: p.authorName, posts: 0, replies: 0 };
    e.posts++;
    byAuthor.set(p.authorId, e);
  }
  for (const r of recentReplies) {
    if (r.authorId === 'player') continue;
    const e = byAuthor.get(r.authorId) || { name: r.authorName, posts: 0, replies: 0 };
    e.replies++;
    byAuthor.set(r.authorId, e);
  }
  const active = [...byAuthor.values()]
    .sort((a, b) => (b.posts + b.replies) - (a.posts + a.replies))
    .slice(0, 4);

  /* ---- subscribers ---- */
  const subs = subscriberSummary(WINDOW_MS);

  /* ---- what needs you ---- */
  const attention = [];
  const unread = s.threads.reduce((a, t) => a + (t.unread || 0), 0);
  if (unread) {
    const who = s.threads
      .filter((t) => t.unread)
      .map((t) => s.npcs.find((n) => n.id === t.npcId)?.name)
      .filter(Boolean)
      .slice(0, 2);
    attention.push({
      kind: 'dm',
      text: `${unread} unread message${unread === 1 ? '' : 's'}${who.length ? ' from ' + who.join(' and ') : ''}`,
    });
  }

  // A player post taking heat — lots of replies, low reception.
  const myPosts = s.posts.filter((p) => p.authorId === 'player' && (p.ts || 0) >= cutoff);
  for (const p of myPosts) {
    const replies = p.replies || [];
    if (replies.length >= 4) {
      const hostile = replies.filter((r) => r.sentiment < -0.25).length;
      if (hostile / replies > 0.4) {
        attention.push({
          kind: 'heat',
          text: `your post about "${String(p.text).slice(0, 40)}…" is getting pushback`,
        });
        break;
      }
    }
  }

  // Someone with a grudge is being loud.
  const angry = s.npcs
    .filter((n) => n.crowd !== true && (n.agent?.grudge ?? 0) > 55)
    .sort((a, b) => (b.agent?.grudge ?? 0) - (a.agent?.grudge ?? 0))[0];
  if (angry) {
    attention.push({ kind: 'grudge', text: `${angry.name} is still angry about something` });
  }

  /* ---- headline ---- */
  let headline = '';
  if (storylines.length) {
    const top = storylines[0];
    headline = top.actors.length >= 2
      ? `${top.actors[0]} and ${top.actors[1]} are mid-argument about ${top.title.replace(/^the\s+/, '')}`
      : `the feed is focused on ${top.title}`;
  } else if (active.length) {
    headline = `${active[0].name} is the loudest voice on your timeline right now`;
  } else {
    headline = 'the timeline is quiet';
  }

  return {
    headline,
    storylines,
    activity: {
      active,
      postCount: recentPosts.length,
      replyCount: recentReplies.length,
      // A couple of the most recent exchanges, for flavour.
      recent: recentReplies
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .slice(0, 3)
        .map((r) => ({
          author: r.authorName,
          text: String(r.text).slice(0, 90),
          to: r.replyToHandle || r.postAuthor,
        })),
    },
    subscribers: {
      ...subs,
      total: s.player.followers || 0,
      // The single most recent reason, for the one-line summary.
      latest: subs.entries[0] || null,
    },
    attention,
    windowHours: Math.round(WINDOW_MS / 3600000),
  };
}

/** One-line summary for the compact header. */
export function digestLine(digest = buildDigest()) {
  const parts = [];
  if (digest.subscribers.net !== 0) {
    const sign = digest.subscribers.net > 0 ? '+' : '';
    parts.push(`${sign}${digest.subscribers.net} subscribers`);
  }
  if (digest.storylines.length) {
    parts.push(`${digest.storylines.length} live subject${digest.storylines.length === 1 ? '' : 's'}`);
  }
  if (digest.attention.length) {
    parts.push(`${digest.attention.length} thing${digest.attention.length === 1 ? '' : 's'} need you`);
  }
  return parts.join(' · ') || 'nothing needs you right now';
}
