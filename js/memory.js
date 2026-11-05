/* ============================================================
   memory.js — durable world memory

   The sim needs continuity: something said in a DM should be
   knowable on the feed three posts later. Prompt context alone
   cannot do that — it is too short and too expensive to resend.

   So the world keeps two kinds of memory:

     1. FACTS — short, structured, curated statements written by
        the model through the `remember_fact` tool. Each has a
        subject (a character id, "player" or "world"), a one-line
        text, and optional tags. Cheap to store, cheap to query,
        cheap to inject.

     2. LORE — a compact prose recap of the world so far,
        rewritten occasionally from the oldest facts. This is the
        "what has happened" summary that keeps tone consistent.

   Both live in the world save, so they are scoped per world and
   travel with export/import.
   ============================================================ */

import { getState, addLog } from './db.js';
import { chatText, chatJSON } from './llm.js';
import { uid, clamp } from './util.js';
import { dbg } from './debug.js';

/** How many facts we keep per world before folding the oldest into lore. */
export const FACT_LIMIT = 60;

/** How many facts get injected into a single prompt. */
export const INJECT_LIMIT = 12;

const TEXT_MAX = 180;
const TAG_MAX = 4;

/* ============================================================
   Read
   ============================================================ */

function mem() {
  const s = getState();
  if (!s.memory || typeof s.memory !== 'object') {
    s.memory = { facts: [], lore: '', updatedAt: 0, lastFoldedAt: 0 };
  }
  if (!Array.isArray(s.memory.facts)) s.memory.facts = [];
  if (typeof s.memory.lastFoldedAt !== 'number') s.memory.lastFoldedAt = 0;
  return s.memory;
}

/** All facts, newest first. */
export function allFacts() {
  return mem().facts;
}

/** The running prose recap. */
export function getLore() {
  return mem().lore || '';
}

/**
 * Facts about a given subject.
 * @param {string} subject  character id, 'player', or 'world'
 */
export function factsAbout(subject, limit = INJECT_LIMIT) {
  if (!subject) return [];
  return mem().facts
    .filter((f) => f.subject === subject)
    .slice(0, limit);
}

/** Facts matching any of the given tags. */
export function factsByTags(tags = [], limit = INJECT_LIMIT) {
  if (!tags.length) return [];
  const set = new Set(tags.map((t) => String(t).toLowerCase()));
  return mem()
    .facts.filter((f) => (f.tags || []).some((t) => set.has(t)))
    .slice(0, limit);
}

/**
 * The memory block for one character's prompt: their own facts,
 * anything about the player that involves them, and world facts.
 */
export function memoryFor(npcId, limit = INJECT_LIMIT) {
  const about = factsAbout(npcId, limit);
  const world = mem().facts.filter((f) => f.subject === 'world').slice(0, 4);
  const player = factsAbout('player', 4);

  const seen = new Set();
  const merged = [];
  for (const f of [...about, ...player, ...world]) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    merged.push(f);
  }
  return merged.slice(0, limit);
}

/** Compact text block suitable for dropping into a system prompt. */
export function memoryBrief(npcId, limit = INJECT_LIMIT) {
  const lore = getLore();
  const facts = npcId ? memoryFor(npcId, limit) : mem().facts.slice(0, limit);
  if (!lore && !facts.length) return '';

  const lines = [];
  if (lore) lines.push('WHAT HAS HAPPENED:', lore);
  if (facts.length) {
    lines.push('THINGS YOU KNOW:');
    for (const f of facts) lines.push(`- ${f.text}`);
  }
  return lines.join('\n');
}

/* ============================================================
   Write
   ============================================================ */

/**
 * Store a fact.
 *
 * @param {object} o
 * @param {string} o.text      one-line statement
 * @param {string} [o.subject] character id, 'player' or 'world'
 * @param {string[]} [o.tags]
 * @param {string} [o.source]  where it came from (post, dm, tool…)
 * @returns {object|null}
 */
export function rememberFact({ text, subject = 'world', tags = [], source = 'model' } = {}) {
  const clean = String(text || '').trim().replace(/\s+/g, ' ').slice(0, TEXT_MAX);
  if (clean.length < 4) return null;

  const m = mem();
  const subj = String(subject || 'world').trim() || 'world';

  // Don't let the same statement pile up — models repeat themselves.
  const norm = clean.toLowerCase();
  const existing = m.facts.find(
    (f) => f.subject === subj && f.text.toLowerCase() === norm
  );
  if (existing) {
    existing.ts = Date.now();
    return existing;
  }

  const fact = {
    id: uid('fact'),
    ts: Date.now(),
    subject: subj,
    text: clean,
    tags: (Array.isArray(tags) ? tags : [tags])
      .map((t) => String(t).toLowerCase().trim())
      .filter(Boolean)
      .slice(0, TAG_MAX),
    source,
  };

  m.facts.unshift(fact);
  m.updatedAt = Date.now();

  // Enforce the cap by dropping the oldest. Lore is updated separately.
  if (m.facts.length > FACT_LIMIT) {
    m.facts.length = FACT_LIMIT;
  }

  dbg('memory:fact', { subject: subj, len: clean.length });
  return fact;
}

/** Replace the running prose recap. */
export function setLore(text) {
  const m = mem();
  m.lore = String(text || '').trim().slice(0, 1200);
  m.updatedAt = Date.now();
  return m.lore;
}

/** Facts that have never been folded into the lore summary. */
export function unfoldedFacts() {
  const m = mem();
  const since = m.lastFoldedAt || 0;
  return m.facts.filter((f) => f.ts > since);
}

/**
 * Fold the given facts into the lore recap and mark them as absorbed.
 * Called after the model rewrites the recap.
 *
 * @param {string} text       new prose recap
 * @param {number} [untilTs]  facts at or before this timestamp are absorbed
 */
export function foldedLore(text, untilTs = Date.now()) {
  const m = mem();
  if (typeof text === 'string' && text.trim()) m.lore = text.trim().slice(0, 1200);
  m.lastFoldedAt = untilTs;
  m.updatedAt = Date.now();
  return m.lore;
}

/** Wipe memory for the active world. */
export function clearMemory() {
  const s = getState();
  s.memory = { facts: [], lore: '', updatedAt: 0, lastFoldedAt: 0 };
  addLog({ kind: 'system', title: 'World memory cleared', level: 'warn' });
}

/** Small usage summary for the settings panel. */
export function memoryStats() {
  const m = mem();
  const bySubject = {};
  for (const f of m.facts) bySubject[f.subject] = (bySubject[f.subject] || 0) + 1;
  return {
    facts: m.facts.length,
    loreLength: (m.lore || '').length,
    bySubject,
    updatedAt: m.updatedAt,
  };
}

/* ============================================================
   Prompt recurrences used by world generation
   ============================================================ */

export function factLimitReached() {
  return mem().facts.length >= FACT_LIMIT;
}

export function trimmed(n, max = TEXT_MAX) {
  return clamp(n, 0, max);
}

/* ============================================================
   Extraction — turning an exchange into facts
   ============================================================ */

const EXTRACT_SYSTEM = `You extract durable facts from a social-media conversation.

You are given an exchange between the player and one character.
Output the facts a person would actually remember later.

Rules:
- Only facts that will still matter next week: promises, plans, secrets,
  jobs, relationships, losses, running jokes, strong opinions.
- Skip small talk, greetings, and anything already listed as known.
- One short third-person sentence per fact. No quotes, no narration.
- Subject is "player" for facts about the player, or the character id
  for facts about that character, or "world" for facts about both.
- Return strict JSON: { "facts": [ { "subject": "...", "text": "...", "tags": [] } ] }
- If nothing is worth remembering, return { "facts": [] }.`;

/**
 * Ask the model what is worth remembering from an exchange.
 *
 * This exists because relying on the model to spontaneously call
 * `remember_fact` mid-conversation is unreliable — it is focused on
 * writing a reply. Extracting afterwards is one small extra call and
 * makes continuity actually happen.
 *
 * @returns {Promise<number>} how many facts were stored
 */
export async function extractFacts({ playerText, replyText, npcId, npcName, source = 'dm' }) {
  const player = String(playerText || '').trim();
  const reply = String(replyText || '').trim();
  if (!player || player.length < 8) return 0;

  const known = mem().facts.slice(0, 20).map((f) => `- ${f.text}`).join('\n') || '- (nothing yet)';

  try {
    const json = await chatJSON({
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM },
        {
          role: 'user',
          content: [
            `Character: ${npcName} (id: ${npcId})`,
            '',
            `PLAYER SAID: ${player.slice(0, 400)}`,
            `CHARACTER REPLIED: ${reply.slice(0, 400)}`,
            '',
            'ALREADY KNOWN:',
            known,
            '',
            'Return the JSON.',
          ].join('\n'),
        },
      ],
      tier: 'cheap',
      maxTokens: 400,
      temperature: 0.2,
      cache: false,
      schema: true,
    });

    const list = Array.isArray(json?.facts) ? json.facts : [];
    let stored = 0;
    for (const f of list.slice(0, 4)) {
      const subject = String(f?.subject || 'world').trim();
      // Normalise the model's spelling of the subject.
      const resolved = subject === 'player' || subject === 'world'
        ? subject
        : (subject === npcId || subject === npcName ? npcId : 'world');
      const fact = rememberFact({
        text: f?.text,
        subject: resolved,
        tags: f?.tags,
        source,
      });
      if (fact) stored++;
    }
    dbg('memory:extracted', { stored, source });
    return stored;
  } catch (e) {
    dbg('memory:extract failed', e.message);
    return 0;
  }
}

const LORE_SYSTEM = `You maintain the running "story so far" recap for a social-media life sim.

You are given the existing recap plus new events. Rewrite it as one tight paragraph.

Rules:
- Past tense, third person, neutral narrator.
- Keep only what still matters: relationships, feuds, promises, running jokes, status changes.
- Drop anything trivial or already covered.
- Never invent events that are not in the input.
- Maximum 120 words. One paragraph, no lists, no headings.`;

/**
 * Rewrite the world's lore recap from its newest facts.
 * Costs one cheap call, so it runs rarely and is always optional.
 *
 * @returns {Promise<string|null>} the new recap, or null if skipped
 */
export async function foldLore({ force = false } = {}) {
  const m = mem();
  const pending = unfoldedFacts();
  // Not worth a call for a trickle of facts.
  if (!force && pending.length < 8) return null;
  if (!pending.length) return null;

  const state = getState();
  const cast = state.npcs
    .filter((n) => !n.crowd)
    .map((n) => `${n.name} (${n.archetype})`)
    .join(', ');

  try {
    const text = await chatText({
      messages: [
        { role: 'system', content: LORE_SYSTEM },
        {
          role: 'user',
          content: [
            `World: ${state.meta?.name || 'Status'} — ${state.meta?.premise || ''}`,
            `Cast: ${cast}`,
            '',
            m.lore ? `EXISTING RECAP:\n${m.lore}` : 'EXISTING RECAP: (none yet)',
            '',
            'NEW EVENTS:',
            ...pending.map((f) => `- ${f.text}`),
            '',
            'Rewrite the recap.',
          ].join('\n'),
        },
      ],
      tier: 'cheap',
      maxTokens: 400,
      temperature: 0.6,
      cache: false,
    });

    const clean = String(text || '').trim();
    if (!clean) return null;
    const newest = Math.max(...pending.map((f) => f.ts));
    foldedLore(clean, newest);
    dbg('memory:lore folded', { facts: pending.length, len: clean.length });
    return clean;
  } catch (e) {
    dbg('memory:lore fold skipped', e.message);
    return null;
  }
}
