/* ============================================================
   storylines.js — ongoing subjects

   The feed felt like disconnected one-liners because nothing was
   ever "currently happening". Real social apps always have two or
   three live arguments running at once: a feud, a launch, a
   rumour, someone's bad week.

   A storyline is a small persistent object:

     { id, title, tension, actors[], heat, lastBeat, ts }

   - title    short label, e.g. "the vending machine feud"
   - tension  one line describing the disagreement
   - actors   character ids who are invested
   - heat     0..100 — how much people still care
   - lastBeat short description of the most recent development

   Heat decays every tick. Storylines that go cold are dropped, and
   new ones are seeded so there is always something in play. Every
   generation prompt receives the live storylines, which is what
   gives posts and replies a throughline instead of improv.
   ============================================================ */

import { getState } from './db.js';
import { rng, clamp, uid } from './util.js';
import { dbg } from './debug.js';

/** How many storylines stay in play at once. */
export const MAX_STORYLINES = 3;

/** Heat lost per tick. */
const DECAY = 4;

/** Below this, a storyline is retired. */
const RETIRE_BELOW = 12;

/* ============================================================
   Read
   ============================================================ */

export function allStorylines() {
  const s = getState();
  if (!Array.isArray(s.storylines)) s.storylines = [];
  // Saves written before the article fix can contain "the the algorithm
  // argument". Normalise on read so old worlds read correctly without a
  // migration step.
  for (const sl of s.storylines) {
    if (typeof sl.title === 'string') sl.title = sl.title.replace(/^the\s+the\s+/i, 'the ');
    if (typeof sl.tension === 'string') sl.tension = sl.tension.replace(/\bthe\s+the\s+/gi, 'the ');
  }
  return s.storylines;
}

/** The storylines worth putting in a prompt right now. */
export function liveStorylines(limit = MAX_STORYLINES) {
  return allStorylines()
    .filter((sl) => sl.heat >= RETIRE_BELOW)
    .sort((a, b) => b.heat - a.heat)
    .slice(0, limit);
}

/** Compact text block for prompts. Empty string when nothing is live. */
export function storylineBrief(limit = MAX_STORYLINES) {
  const live = liveStorylines(limit);
  if (!live.length) return '';
  const s = getState();
  const lines = live.map((sl) => {
    const names = (sl.actors || [])
      .map((id) => s.npcs.find((n) => n.id === id)?.name)
      .filter(Boolean);
    const who = names.length ? ` (${names.join(', ')})` : '';
    const beat = sl.lastBeat ? ` Latest: ${sl.lastBeat}` : '';
    return `- ${sl.title}${who}: ${sl.tension}${beat}`;
  });
  return lines.join('\n');
}

/** Storylines a specific character is invested in. */
export function storylinesFor(npcId) {
  return liveStorylines().filter((sl) => (sl.actors || []).includes(npcId));
}

/* ============================================================
   Write
   ============================================================ */

export function addStoryline({ title, tension, actors = [], heat = 60, lastBeat = '' }) {
  const s = getState();
  if (!Array.isArray(s.storylines)) s.storylines = [];
  const clean = String(title || '').trim().slice(0, 80);
  if (!clean) return null;
  // Don't stack near-duplicates.
  if (s.storylines.some((sl) => sl.title.toLowerCase() === clean.toLowerCase())) return null;

  const sl = {
    id: uid('sl'),
    title: clean,
    tension: String(tension || '').trim().slice(0, 200),
    actors: actors.filter(Boolean).slice(0, 6),
    heat: clamp(Number(heat) || 60, 0, 100),
    lastBeat: String(lastBeat || '').trim().slice(0, 160),
    ts: Date.now(),
  };
  s.storylines.unshift(sl);
  // Keep the list bounded — drop the coldest.
  if (s.storylines.length > MAX_STORYLINES + 2) {
    s.storylines.sort((a, b) => b.heat - a.heat);
    s.storylines.length = MAX_STORYLINES + 2;
  }
  dbg('storyline added', sl.title);
  return sl;
}

/** Nudge a storyline's heat and record a development. */
export function heatStoryline(id, delta = 10, beat = '') {
  const sl = allStorylines().find((x) => x.id === id);
  if (!sl) return null;
  sl.heat = clamp(sl.heat + delta, 0, 100);
  if (beat) sl.lastBeat = String(beat).slice(0, 160);
  sl.ts = Date.now();
  return sl;
}

/** Decay all storylines and retire the cold ones. */
export function decayStorylines() {
  const s = getState();
  if (!Array.isArray(s.storylines)) { s.storylines = []; return 0; }
  for (const sl of s.storylines) sl.heat = clamp(sl.heat - DECAY, 0, 100);
  const before = s.storylines.length;
  s.storylines = s.storylines.filter((sl) => sl.heat >= RETIRE_BELOW);
  return before - s.storylines.length;
}

/* ============================================================
   Seeding — local, free, no endpoint call
   ============================================================ */

/* Tension shapes that fit any world. Each is a disagreement two
   characters can plausibly be on opposite sides of. */
const TENSION_SHAPES = [
  { title: 'the {thing} argument', tension: '{a} thinks {thing} is fine. {b} thinks it is a symptom of everything wrong here.' },
  { title: 'who gets credit', tension: '{a} and {b} both claim they started {thing}. Neither will let it go.' },
  { title: 'the public callout', tension: '{a} subtweeted {b} about {thing}. {b} has not responded, which is somehow worse.' },
  { title: 'the return', tension: '{a} came back after a long absence and {b} is not being normal about it.' },
  { title: 'the group split', tension: 'Everyone used to do {thing} together. Now {a} and {b} do it separately and pretend not to notice.' },
  { title: 'the quiet feud', tension: '{a} and {b} are being extremely polite to each other in public. Nobody believes it.' },
  { title: 'the announcement', tension: '{a} announced {thing} without telling {b} first. {b} found out with everyone else.' },
  { title: 'the borrowed thing', tension: '{a} still has {b}\'s {thing}. It has been long enough that asking now would be strange.' },
  { title: 'the bad advice', tension: '{b} took {a}\'s advice about {thing} and it went badly. Only one of them thinks this is funny.' },
  { title: 'the new arrival', tension: '{a} is being very welcoming to {b}. {b} can tell it is not sincere.' },
];

const THINGS = {
  modern: ['the vending machine', 'that group chat', 'the algorithm', 'brunch', 'the gym', 'a situationship', 'the lease'],
  campus: ['the floor meeting', 'the group project', 'quiet hours', 'the dining hall', 'a borrowed charger', 'the study room'],
  rural: ['the diner', 'the pier', 'the tourism board', 'the old road', 'the bakery', 'the harvest'],
  scifi: ['the hum', 'the comms window', 'the hydroponics bay', 'the EVA schedule', 'the rationing', 'the airlock'],
  fandom: ['the setlist', 'the archive', 'the merch drop', 'the last song', 'the split', 'the label'],
  cozy: ['the oat milk', 'the corner table', 'the grinder', 'the chain across the street', 'the playlist', 'the lease'],
};

/**
 * Seed 2-3 storylines for a fresh world. Uses the cast and the theme,
 * so the subjects are specific to the place rather than generic.
 */
export function seedStorylines(npcs = [], theme = 'modern') {
  const cast = npcs.filter((n) => n.crowd !== true);
  if (cast.length < 2) return [];

  const things = THINGS[theme] || THINGS.modern;
  const created = [];
  const used = new Set();
  const count = Math.min(MAX_STORYLINES, Math.max(2, Math.floor(cast.length / 3)));

  for (let i = 0; i < count; i++) {
    const shape = TENSION_SHAPES[(i * 3 + rng.int(0, 2)) % TENSION_SHAPES.length];
    const a = rng.pick(cast.filter((n) => !used.has(n.id))) || cast[0];
    used.add(a.id);
    const b = rng.pick(cast.filter((n) => n.id !== a.id && !used.has(n.id))) || cast.find((n) => n.id !== a.id);
    if (!b) continue;
    used.add(b.id);

    const thing = rng.pick(things);
    // THINGS entries already carry their article ("the algorithm"), and some
    // title templates also start with "the". Substituting blindly produced
    // "the the algorithm argument", so drop the duplicate article.
    const fill = (tpl) => tpl
      .replace(/\{a\}/g, a.name)
      .replace(/\{b\}/g, b.name)
      .replace(/\{thing\}/g, (m, offset, str) =>
        /\bthe\s+$/i.test(str.slice(0, offset)) ? thing.replace(/^the\s+/i, '') : thing
      );

    const sl = addStoryline({
      title: fill(shape.title),
      tension: fill(shape.tension),
      actors: [a.id, b.id],
      heat: rng.int(55, 85),
      lastBeat: '',
    });
    if (sl) created.push(sl);
  }

  dbg('storylines seeded', created.length);
  return created;
}

/**
 * If nothing is live, invent a new subject from the current cast.
 * Called by the autonomy tick so the world never goes quiet.
 */
export function seedStorylineIfCold(npcs = [], theme = 'modern') {
  if (liveStorylines().length >= 2) return null;
  const cast = npcs.filter((n) => n.crowd !== true);
  if (cast.length < 2) return null;

  const things = THINGS[theme] || THINGS.modern;
  const shape = rng.pick(TENSION_SHAPES);
  const a = rng.pick(cast);
  const b = rng.pick(cast.filter((n) => n.id !== a.id));
  if (!b) return null;

  const thing = rng.pick(things);
  const fill = (tpl) => tpl.replace(/\{a\}/g, a.name).replace(/\{b\}/g, b.name).replace(/\{thing\}/g, thing);

  return addStoryline({
    title: fill(shape.title),
    tension: fill(shape.tension),
    actors: [a.id, b.id],
    heat: rng.int(50, 75),
    lastBeat: '',
  });
}
