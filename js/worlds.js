/* ============================================================
   worlds.js — world templates, generation, save management

   A "world" is a premise plus a cast plus a starting timeline.
   Worlds are independent saves: switching one never touches another.

   Three ways to make one:
     1. Template  — instant, deterministic. Zero cost.
     2. Prompted  — describe it, one cheap call builds the cast.
     3. Blank     — you shape it as you play.
   ============================================================ */

import {
  getState, installState, hasWorldSave, deleteWorldSave, setActiveWorldId,
  activeWorldId, blankState, commit,
} from './db.js';
import { getConfig } from './config.js';
import { chatJSON, LLMError } from './llm.js';
import { uid, rng, slug } from './util.js';
import { addEvent } from './db.js';
import { CROWD_SIZE, localNickname } from './crowd.js';
import { dbg, warn } from './debug.js';

/* ============================================================
   Archetype vocabulary — reused by templates and the generator
   ============================================================ */

export const ARCHETYPES = [
  'influencer', 'lurker', 'chaos', 'wholesome', 'rival',
  'stan', 'brand', 'critic', 'mentor', 'ghost', 'clout-chaser', 'romantic',
];

const AFFINITY_BIAS = {
  influencer: 5, lurker: 10, chaos: 25, wholesome: 45, rival: -25,
  stan: 60, brand: 0, critic: -12, mentor: 35, ghost: 0,
  'clout-chaser': -5, romantic: 30,
};

/* ============================================================
   Templates
   ============================================================ */

/**
 * Each template declares a premise and a cast. Cast members are
 * described as data, never as prose, so prompts stay cheap.
 */
export const TEMPLATES = [
  {
    id: 'modern',
    name: 'Modern Life',
    tagline: 'The default. Strangers, rivals, and one overly online friend.',
    premise: 'A loose circle of people who know each other mostly through the app.',
    theme: 'modern',
    icon: '📱',
    accent: 'linear-gradient(135deg,#a78bfa,#f472b6)',
    startMoney: 120,
    cast: [
      { name: 'Mira Vale', handle: 'miravale', archetype: 'influencer', vibe: 'polished, quietly competitive', bio: 'lifestyle · 3 alarms · will monetise anything', followers: 48200, verified: true },
      { name: 'Dev Okonkwo', handle: 'devok', archetype: 'chaos', vibe: 'loud, zero impulse control', bio: 'i make bad decisions publicly', followers: 12400 },
      { name: 'Sana Rahim', handle: 'sanarah', archetype: 'wholesome', vibe: 'warm, steady, group-chat therapist', bio: 'baking, books, being normal online', followers: 6800 },
      { name: 'Kit Marlowe', handle: 'kitm', archetype: 'critic', vibe: 'dry, sharp, terminally online', bio: 'i have opinions about your posts', followers: 22100, verified: true },
      { name: 'Rhea Sun', handle: 'rheasun', archetype: 'rival', vibe: 'ambitious, keeps score', bio: "building something. you'll see.", followers: 31500 },
      { name: 'Bex', handle: 'bexonline', archetype: 'lurker', vibe: 'quiet, devastating when they post', bio: 'here. watching.', followers: 1900 },
      { name: 'Noor Haddad', handle: 'noorh', archetype: 'stan', vibe: 'loyal, slightly unhinged', bio: 'number one fan of exactly three people', followers: 4300 },
      { name: 'Corvid Co.', handle: 'corvidco', archetype: 'brand', vibe: 'faceless, suspiciously friendly', bio: 'we sell the thing you already want', followers: 156000, verified: true },
    ],
  },
  {
    id: 'campus',
    name: 'Campus',
    tagline: 'One semester, one dorm floor, entirely too much drama.',
    premise: 'Second-year students on a shared dorm floor at a mid-size university.',
    theme: 'campus',
    icon: '🎓',
    accent: 'linear-gradient(135deg,#5eead4,#60a5fa)',
    startMoney: 45,
    cast: [
      { name: 'Priya Nair', handle: 'priyanair', archetype: 'influencer', vibe: 'student council, always filming', bio: 'campus content · vlog era', followers: 8600, verified: true },
      { name: 'Tomas Reyes', handle: 'tomasrey', archetype: 'chaos', vibe: 'rooftop philosopher, no sleep', bio: '3am thoughts only', followers: 2100 },
      { name: 'Lena Fischer', handle: 'lenaf', archetype: 'wholesome', vibe: 'library regular, brings snacks', bio: 'study with me · tea reviews', followers: 1400 },
      { name: 'Amir Hossain', handle: 'amirh', archetype: 'rival', vibe: 'same major, better grades', bio: 'we are not competing. we are.', followers: 3900 },
      { name: 'Gus', handle: 'gusinthedorm', archetype: 'lurker', vibe: 'never posts, always knows', bio: 'i live here', followers: 380 },
      { name: 'Dani Cole', handle: 'danicole', archetype: 'romantic', vibe: 'hopeless, sincere, dangerous', bio: 'looking for something real (jk)', followers: 5200 },
      { name: 'The RA', handle: 'flooreightra', archetype: 'brand', vibe: 'institutional, cheerful threat', bio: 'quiet hours start at 10', followers: 1100 },
    ],
  },
  {
    id: 'hollow',
    name: 'Hollow Creek',
    tagline: 'Small town. Everyone knows. Nobody says.',
    premise: 'A coastal town of 4,000 where the same families have been feuding for decades.',
    theme: 'rural',
    icon: '🌾',
    accent: 'linear-gradient(135deg,#fbbf24,#fb7185)',
    startMoney: 60,
    cast: [
      { name: 'June Halloway', handle: 'junehalloway', archetype: 'wholesome', vibe: 'bakery owner, town memory', bio: 'flour, gossip, and quiet judgement', followers: 7400 },
      { name: 'Wade Pruitt', handle: 'wadepruitt', archetype: 'chaos', vibe: 'truck, dog, unresolved anger', bio: 'born here. staying here. sadly.', followers: 2900 },
      { name: 'Cass Merritt', handle: 'cassmerritt', archetype: 'rival', vibe: 'came back from the city changed', bio: 'i left for a reason', followers: 11800 },
      { name: 'Old Dale', handle: 'olddale', archetype: 'mentor', vibe: 'says little, means all of it', bio: 'been here longer than the road', followers: 900 },
      { name: 'Marisol Vega', handle: 'marisolvega', archetype: 'influencer', vibe: 'trying to make the town a brand', bio: 'hollow creek tourism board (unofficial)', followers: 15600 },
      { name: 'Toby', handle: 'tobyfromthepier', archetype: 'lurker', vibe: 'always at the pier', bio: 'fishing. thinking. repeat.', followers: 640 },
    ],
  },
  {
    id: 'orbit',
    name: 'Orbit Station',
    tagline: 'Twelve people. One habitat. No exit until spring.',
    premise: 'A research crew on a small orbital station with spotty comms to Earth.',
    theme: 'scifi',
    icon: '🛰️',
    accent: 'linear-gradient(135deg,#60a5fa,#a78bfa)',
    startMoney: 200,
    cast: [
      { name: 'Cmdr. Iyer', handle: 'cmdriyer_orb', archetype: 'mentor', vibe: 'calm, procedural, tired', bio: 'station commander. logs on time.', followers: 24000, verified: true },
      { name: 'Dr. Sable', handle: 'sablesci', archetype: 'critic', vibe: 'precise, unimpressed', bio: 'i publish. you post.', followers: 8100 },
      { name: 'Milo Vance', handle: 'milovance', archetype: 'chaos', vibe: 'engineer who keeps breaking rules', bio: 'if it beeps, i touched it', followers: 6300 },
      { name: 'Rin Okafor', handle: 'rinokafor', archetype: 'wholesome', vibe: 'hydroponics, homesickness, hope', bio: 'growing tomatoes in space', followers: 19200 },
      { name: 'UNIT-9', handle: 'unit9_hab', archetype: 'brand', vibe: 'helpful, literal, unsettling', bio: 'habitat systems nominal', followers: 55000, verified: true },
      { name: 'Jules Park', handle: 'julespark', archetype: 'romantic', vibe: 'long-distance from 400km up', bio: 'sending this from orbit. hi.', followers: 13400 },
    ],
  },
  {
    id: 'fandom',
    name: 'The Fandom',
    tagline: 'A band, a fandom, and a group chat that never sleeps.',
    premise: 'Fans and hangers-on orbiting an indie band mid-breakup.',
    theme: 'fandom',
    icon: '🎸',
    accent: 'linear-gradient(135deg,#f472b6,#fbbf24)',
    startMoney: 80,
    cast: [
      { name: 'Ash Delacroix', handle: 'ashdelacroix', archetype: 'influencer', vibe: 'frontperson, magnetic, messy', bio: 'voice of small hours', followers: 420000, verified: true },
      { name: 'Wren', handle: 'wrenstanacct', archetype: 'stan', vibe: 'devoted, organised, dangerous', bio: 'i run the archive', followers: 31000 },
      { name: 'Basil Quinn', handle: 'basilquinn', archetype: 'critic', vibe: 'writes long reviews nobody asked for', bio: 'music criticism as a lifestyle', followers: 17400 },
      { name: 'Sam Osei', handle: 'samosei', archetype: 'wholesome', vibe: 'tour crew, everyone likes them', bio: 'i load the van', followers: 4600 },
      { name: 'Kit Rios', handle: 'kitrios', archetype: 'rival', vibe: 'former bandmate, current problem', bio: 'i was there first', followers: 22800 },
      { name: 'LUXE', handle: 'luxeband', archetype: 'brand', vibe: 'label account, vaguely threatening', bio: 'we own the masters', followers: 91000, verified: true },
    ],
  },
  {
    id: 'coffee',
    name: 'The Roastery',
    tagline: 'A café, its regulars, and a very public feud about milk.',
    premise: 'A neighbourhood coffee shop and the people who treat it as an office.',
    theme: 'cozy',
    icon: '☕',
    accent: 'linear-gradient(135deg,#d97706,#92400e)',
    startMoney: 95,
    cast: [
      { name: 'Opal Reyes', handle: 'opalreyes', archetype: 'wholesome', vibe: 'owner, remembers your order', bio: 'we open at 7. i am here at 5.', followers: 9800 },
      { name: 'Nate', handle: 'natewriteshere', archetype: 'lurker', vibe: 'same corner table since march', bio: 'working on something', followers: 1200 },
      { name: 'Simone Park', handle: 'simonepark', archetype: 'influencer', vibe: 'reviews cafés for a living', bio: 'i have a spreadsheet', followers: 56000, verified: true },
      { name: 'Bram', handle: 'bramoatmilk', archetype: 'critic', vibe: 'opinionated about dairy', bio: 'oat milk is not a personality. mine is.', followers: 8300 },
      { name: 'Tess', handle: 'tessbarista', archetype: 'chaos', vibe: 'new hire, chaotic energy', bio: 'day 3. already broke the grinder.', followers: 2400 },
      { name: 'Hale & Co.', handle: 'haleandco', archetype: 'brand', vibe: 'the chain across the street', bio: 'convenience, everywhere', followers: 210000, verified: true },
    ],
  },
];

export const getTemplate = (id) => TEMPLATES.find((t) => t.id === id) || TEMPLATES[0];

/* ============================================================
   Cast construction
   ============================================================ */

/**
 * Normalise a user- or model-supplied handle to a slug.
 * Handles are used in @mentions and looked up by exact match, so they
 * must be lowercase, alphanumeric and underscore only.
 */
export function slugHandle(value) {
  return String(value || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 20) || 'you';
}

/**
 * Build crowd NPCs synchronously from the local nickname pool.
 * Called during world construction, where we must not await an
 * endpoint (the world is installed in one synchronous step).
 */
export function seedCrowd(count = 14) {
  const exists = new Set();
  const out = [];
  const bios = [
    'here.', 'mostly lurking.', 'i reply to everything.', 'no thoughts',
    'chronically online.', '3am poster.', 'just reading.', 'hi.',
  ];
  const archetypes = ['lurker', 'stan', 'chaos', 'critic', 'wholesome', 'influencer'];
  for (let i = 0; i < count; i++) {
    const nick = localNickname(exists);
    exists.add(nick.handle);
    out.push({
      id: uid('npc'),
      name: nick.name,
      handle: '@' + nick.handle,
      archetype: archetypes[i % archetypes.length],
      vibe: '',
      bio: bios[i % bios.length],
      followers: rng.int(12, 900),
      verified: false,
      affinity: 0,
      posts: 0,
      lastActive: Date.now() - rng.int(0, 3_600_000),
      isNew: false,
      crowd: true,
    });
  }
  return out;
}

export function makeNpc(spec, i = 0) {
  const archetype = spec.archetype || rng.pick(ARCHETYPES);
  const name = spec.name || `Character ${i + 1}`;
  const handle = '@' + slug(spec.handle || name);
  const bias = AFFINITY_BIAS[archetype] ?? 0;
  return {
    id: uid('npc'),
    name,
    handle,
    archetype,
    vibe: spec.vibe || '',
    bio: spec.bio || '',
    followers: spec.followers ?? rng.int(800, 40000),
    verified: !!spec.verified,
    affinity: spec.affinity ?? Math.round(bias + (Math.random() - 0.5) * 18),
    posts: 0,
    lastActive: Date.now() - Math.round(Math.random() * 6e6),
    isNew: false,
  };
}

/* Opening posts per theme — keeps a new world from looking empty. */
const OPENERS = {
  modern: [
    ["three coffees deep and the day hasn't started. this is fine.", 'text', 0.1],
    ["just got into a fight with a vending machine. it won.", 'drama', -0.3],
    ["made focaccia for the first time and honestly? i could cry.", 'wholesome', 0.8],
    ["everyone is posting their best nine like we didn't all watch it happen.", 'cryptic', -0.2],
    ["new project. can't say what yet. but you're going to want to be early.", 'announcement', 0.4],
  ],
  campus: [
    ["it is 2am and the library is somehow full. who are you people.", 'text', 0.0],
    ["got my grade back. we do not discuss it.", 'vague', -0.4],
    ["roommate brought snacks unprompted. i would die for them.", 'wholesome', 0.9],
    ["floor meeting was four minutes of announcements and forty minutes of war.", 'drama', -0.2],
    ["study playlist is up. two hours. no skips.", 'announcement', 0.5],
  ],
  rural: [
    ["bakery is open. the sourdough survived the night.", 'wholesome', 0.7],
    ["saw who was at the diner this morning. no i won't say.", 'cryptic', -0.1],
    ["pier at 6am. nobody here. that's the point.", 'text', 0.3],
    ["some people came back to town and expect us to forget. we don't forget.", 'drama', -0.5],
    ["tourism board meeting thursday. bring opinions.", 'announcement', 0.2],
  ],
  scifi: [
    ["habitat systems nominal. hydration reminder: cervical.", 'text', 0.0],
    ["third night in a row with the hum. engineering says it's fine.", 'cryptic', -0.2],
    ["tomatoes are fruiting. i am emotional about it.", 'wholesome', 0.85],
    ["comms window opens in 40 minutes. writing everything down.", 'text', 0.4],
    ["surface EVA approved. do not touch my suit.", 'announcement', 0.1],
  ],
  fandom: [
    ["setlist for tonight. don't ask about the last song.", 'announcement', 0.3],
    ["why is there a five-hour video essay about us", 'chaos', -0.1],
    ["met them outside the venue. i was normal. i was so normal.", 'wholesome', 0.9],
    ["reminder that we were here before the algorithm found them.", 'cryptic', 0.2],
    ["the merch store is restocked. i'm so sorry.", 'flex', 0.4],
  ],
  cozy: [
    ["new single origin in. it tastes like apricot. fight me.", 'announcement', 0.6],
    ["same table. same order. same manuscript. day 47.", 'text', 0.1],
    ["the oat milk discourse has reached my comment section.", 'drama', -0.3],
    ["someone left a book here. it has notes in it. i'm invested.", 'wholesome', 0.7],
    ["chain across the street opened at 6. we open at 7. this is war.", 'drama', -0.4],
  ],
};

export const THEME_TWEAKS = {
  modern: { tags: ['#lifestyle', '#relatable', '#latepost'] },
  campus: { tags: ['#campus', '#studytok', '#dorm'] },
  rural: { tags: ['#smalltown', '#slowliving'] },
  scifi: { tags: ['#orbital', '#stationlog'] },
  fandom: { tags: ['#fandom', '#tourlife', '#setlist'] },
  cozy: { tags: ['#coffee', '#neighbourhood'] },
};

function buildOpenerPosts(npcs, theme) {
  const pool = OPENERS[theme] || OPENERS.modern;
  const posts = [];
  const used = new Set();
  for (let i = 0; i < pool.length; i++) {
    let idx = i % npcs.length;
    while (used.has(idx) && used.size < npcs.length) idx = (idx + 1) % npcs.length;
    used.add(idx);
    const npc = npcs[idx];
    const [text, kind, sentiment] = pool[i];
    posts.push({
      id: uid('post'),
      authorId: npc.id,
      authorName: npc.name,
      authorHandle: npc.handle,
      verified: !!npc.verified,
      text,
      kind,
      sentiment,
      likes: Math.round(npc.followers * (0.012 + Math.random() * 0.02)),
      reposts: Math.round(npc.followers * 0.002 * Math.random()),
      replies: [],
      ts: Date.now() - (i + 1) * 1.7e6,
    });
    npc.posts++;
  }
  return posts;
}

/* ============================================================
   World registry (index of created worlds, for the picker)
   ============================================================ */

const INDEX_KEY = 'status.worlds.v1';

export function listWorlds() {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveIndex(list) {
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(list)); } catch {}
}

export function upsertWorldIndex(entry) {
  const list = listWorlds();
  const i = list.findIndex((w) => w.id === entry.id);
  const record = {
    id: entry.id,
    name: entry.name,
    template: entry.template || 'custom',
    premise: entry.premise || '',
    theme: entry.theme || 'modern',
    icon: entry.icon || '🌍',
    accent: entry.accent || 'linear-gradient(135deg,#a78bfa,#f472b6)',
    createdAt: entry.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (i >= 0) list[i] = { ...list[i], ...record };
  else list.unshift(record);
  saveIndex(list);
  return record;
}

export function removeWorldIndex(id) {
  saveIndex(listWorlds().filter((w) => w.id !== id));
}

export function worldMeta(id) {
  return listWorlds().find((w) => w.id === id) || null;
}

/* ============================================================
   Builders
   ============================================================ */

/** Build a world from a template. Zero endpoint calls. */
export function buildFromTemplate(templateId, { playerName = 'You', handle = '@you' } = {}) {
  const tpl = getTemplate(templateId);
  const id = uid('world');
  const state = blankState({
    id,
    premise: tpl.premise,
    theme: tpl.theme,
    name: tpl.name,
    startMoney: tpl.startMoney,
  });

  state.player.name = String(playerName || 'You').slice(0, 40);
  state.player.handle = '@' + slugHandle(handle);
  state.player.bio = `New in ${tpl.name}.`;

  const tweak = THEME_TWEAKS[tpl.theme] || THEME_TWEAKS.modern;
  state.npcs = tpl.cast.map((c, i) => makeNpc(c, i));

  // Seed a crowd of background accounts so the feed looks public.
  state.npcs.push(...seedCrowd(CROWD_SIZE));

  state.posts = buildOpenerPosts(state.npcs, tpl.theme);
  state.stats.clout = 4;
  state.player.followers = Math.max(0, Math.round(state.stats.clout * 1.8));
  state.player.following = state.npcs.length;

  state.events.push({
    id: uid('ev'),
    ts: Date.now(),
    kind: 'system',
    title: `${tpl.name} is live`,
    detail: tpl.premise,
  });

  return { id, state, template: tpl };
}

export function activateWorld(built, reason = 'world-created') {
  installState(built.id, built.state, reason);
  upsertWorldIndex({
    id: built.id,
    name: built.state.meta.name,
    template: built.template?.id || 'custom',
    premise: built.state.meta.premise,
    theme: built.state.meta.theme,
    icon: built.template?.icon,
    accent: built.template?.accent,
    createdAt: built.state.createdAt,
  });
  return built.id;
}

/** Start playing a template world right now. */
export function createFromTemplate(templateId, opts = {}) {
  const built = buildFromTemplate(templateId, opts);
  activateWorld(built);
  return built;
}

/* ============================================================
   Custom world generation (one cheap call)
   ============================================================ */

const CUSTOM_SYSTEM = `You invent settings for a social-media life sim.
Produce a small, believable world with a specific place, a specific tension, and a cast of 5-7 people.

NAMING IS CRITICAL. Names must be coherent with the world you invent:
- Every character's name must sound plausible for the setting's culture,
  region, era and social class. A fishing village in Norway and a Tokyo
  fandom scene must not produce interchangeable names.
- Handles must feel like real handles: short, lowercase, personal,
  occasionally with numbers or underscores. They should echo the name
  or the character's obsession — never generic ("user12345").
- Do not reuse the same name stems across characters. No two characters
  may share a first name or a similar handle.
- Invent original people. Never use real public figures.

Return STRICT JSON only:
{
  "name": "World title, 2-4 words",
  "premise": "One sentence describing the place and the tension.",
  "theme": "modern|campus|rural|scifi|fandom|cozy",
  "icon": "one emoji",
  "characters": [
    {
      "name": "Full Name, culturally coherent with the setting",
      "handle": "lowercase handle without @",
      "archetype": "influencer|lurker|chaos|wholesome|rival|stan|brand|critic|mentor|ghost|clout-chaser|romantic",
      "vibe": "2-3 adjectives",
      "bio": "under 60 characters",
      "followers": 1200
    }
  ]
}

Rules:
- Handles: lowercase, alphanumeric plus underscores, max 18 chars.
- Followers must vary wildly between characters.
- Include at least one character who dislikes the player and one who likes them.
- Each character must have a distinct archetype so their posts feel different.
- No prose outside the JSON.`;

/* ============================================================
   Single persona generation (used by the world maker)
   ============================================================ */

const PERSONA_SYSTEM = `You invent one person who uses a social app inside a specific world.

Coherence rules:
- The name must sound natural for this setting's culture, region and class.
- The handle must feel like a real handle: lowercase, short, personal,
  max 18 characters, using only a-z, 0-9 and underscores.
- The voice and bio must match the archetype, not contradict it.
- Invent an original person. Never use a real public figure.
- Do not reuse a name or handle already listed.

Return STRICT JSON only:
{
  "name": "Full Name",
  "handle": "lowercase_handle",
  "archetype": "influencer|lurker|chaos|wholesome|rival|stan|brand|critic|mentor|ghost|clout-chaser|romantic",
  "vibe": "2-3 adjectives",
  "bio": "under 60 characters",
  "followers": 3400
}`;

/**
 * Ask the model for one new persona that fits the current world.
 * Falls back to a generated persona when the endpoint is unavailable.
 */
export async function generatePersona(worldContext, { avoid = [] } = {}) {
  const cfg = getConfig();
  const exists = new Set(avoid.map((a) => String(a).toLowerCase()));

  if (cfg.demoMode) return localPersona(worldContext, exists);

  try {
    const json = await chatJSON({
      messages: [
        { role: 'system', content: PERSONA_SYSTEM },
        {
          role: 'user',
          content: [
            `World: ${worldContext.name}`,
            `Premise: ${worldContext.premise}`,
            `Theme: ${worldContext.theme}`,
            '',
            'Already present (do not reuse):',
            JSON.stringify(avoid),
            '',
            'Invent one new person who would plausibly be here.',
          ].join('\n'),
        },
      ],
      tier: 'cheap',
      maxTokens: 320,
      temperature: 1.0,
      schema: true,
    });

    const name = String(json.name || '').trim();
    let handle = String(json.handle || '')
      .toLowerCase()
      .replace(/^@/, '')
      .replace(/[^a-z0-9_]/g, '')
      .slice(0, 18);

    if (!name || !handle) throw new Error('Model returned an incomplete persona');
    if (exists.has(name.toLowerCase()) || exists.has('@' + handle)) {
      handle = handle + Math.floor(Math.random() * 90 + 10);
    }

    return makeNpc({
      name: name.slice(0, 40),
      handle,
      archetype: ARCHETYPES.includes(json.archetype) ? json.archetype : rng.pick(ARCHETYPES),
      vibe: String(json.vibe || '').slice(0, 60),
      bio: String(json.bio || '').slice(0, 80),
      followers: Number.isFinite(json.followers) ? Math.max(0, Math.round(json.followers)) : rng.int(500, 30000),
    });
  } catch (e) {
    warn('persona generation fell back to local', e);
    return localPersona(worldContext, exists);
  }
}

/* Local, culturally-neutral fallback pool. */
const NAME_POOL = {
  modern: [
    ['Nadia Osei', 'nadiaosei'], ['Theo Brandt', 'theobrandt'], ['Yuki Tanabe', 'yukitanabe'],
    ['Marco Silva', 'marcosilva'], ['Iris Kaur', 'iriskaur'], ['Dorian Vale', 'dorianvale'],
    ['Amara Eze', 'amaraeze'], ['Lucas Meyer', 'lucasmeyer'], ['Sofia Duarte', 'sofiaduarte'],
    ['Ravi Menon', 'ravimenon'], ['Hana Kovač', 'hanakovac'], ['Elias Nord', 'eliasnord'],
  ],
  campus: [
    ['Zoe Whitfield', 'zoewhit'], ['Omar Haddad', 'omarhaddad'], ['Bea Lindqvist', 'bealind'],
    ['Jae Park', 'jaepark'], ['Tobi Adeyemi', 'tobiade'], ['Clara Ruiz', 'clararuiz'],
    ['Nikhil Rao', 'nikhilrao'], ['Maya Brennan', 'mayabrennan'], ['Sam Okafor', 'samokafor'],
  ],
  rural: [
    ['Hattie Boone', 'hattieboone'], ['Cody Pruitt', 'codypruitt'], ['Willa Marsh', 'willamarsh'],
    ['Dell Hargrove', 'dellhargrove'], ['Ruthie Vance', 'ruthievance'], ['Bo Tanner', 'botanner'],
    ['Effie Calloway', 'effiecal'], ['Grant Holloway', 'granthol'], ['Lula Mae Reed', 'lulamaereed'],
  ],
  scifi: [
    ['Anya Volkov', 'anyavolkov'], ['Idris Bello', 'idrisbello'], ['Mei-Lin Zhao', 'meilinzhao'],
    ['Caspian Rhea', 'caspianrhea'], ['Nour Farouk', 'nourfarouk'], ['Kestrel', 'kestrel_hab'],
    ['Dr. Almeida', 'dralmeida'], ['Soren Vik', 'sorenvik'], ['Talia Reyes', 'taliareyes'],
  ],
  fandom: [
    ['Ronnie Wilde', 'ronniewilde'], ['Kit Song', 'kitsong'], ['Marley Chen', 'marleychen'],
    ['Ash Rivera', 'ashrivera'], ['Nico Vale', 'nicovale'], ['Junie Park', 'juniepark'],
    ['Dax Morneau', 'daxmorneau'], ['Sully Grant', 'sullygrant'], ['Pia Novak', 'pianovak'],
  ],
  cozy: [
    ['Elsie Tran', 'elsietran'], ['Otto Brenner', 'ottobrenner'], ['Mina Saad', 'minasaad'],
    ['Peter Lin', 'peterlin'], ['Rosa Almeida', 'rosaalmeida'], ['Hugo Marsh', 'hugomarsh'],
    ['Nell Fontaine', 'nellfontaine'], ['Isaac Bell', 'isaacbell'], ['Freya Olsen', 'freyaolsen'],
  ],
};

const VIBE_POOL = [
  'wry, observant, slow to trust', 'bright, relentless, a little too online',
  'quiet, exacting, secretly sentimental', 'loud, generous, allergic to being bored',
  'careful, private, devastating when provoked', 'curious, restless, always mid-project',
  'steady, dry, the one who actually replies', 'dramatic, funny, no filter',
];

const ARCH_POOL = ['influencer', 'lurker', 'chaos', 'wholesome', 'rival', 'critic', 'romantic', 'clout-chaser'];

function localPersona(worldContext, exists) {
  const theme = worldContext?.theme || 'modern';
  const pool = NAME_POOL[theme] || NAME_POOL.modern;

  const fresh = pool.filter(([n, h]) => !exists.has(n.toLowerCase()) && !exists.has('@' + h));
  const [name, handle] = (fresh.length ? rng.pick(fresh) : rng.pick(pool));

  let finalHandle = handle;
  if (exists.has('@' + finalHandle)) finalHandle = handle + rng.int(10, 99);

  return makeNpc({
    name,
    handle: finalHandle,
    archetype: rng.pick(ARCH_POOL),
    vibe: rng.pick(VIBE_POOL),
    bio: '',
    followers: rng.int(400, 24000),
  });
}

/* ============================================================
   World generation
   ============================================================ */

export async function generateWorld(description, { playerName = 'You', handle = '@you' } = {}) {
  const cfg = getConfig();

  if (cfg.demoMode) {
    return buildFromTemplate(rng.pick(TEMPLATES).id, { playerName, handle });
  }

  const json = await chatJSON({
    messages: [
      { role: 'system', content: CUSTOM_SYSTEM },
      { role: 'user', content: `Build a world about: ${description}` },
    ],
    tier: 'cheap',
    maxTokens: 900,
    temperature: 0.95,
    schema: true,
  });

  const chars = Array.isArray(json.characters) ? json.characters : [];
  if (chars.length < 3) throw new Error('The model returned too few characters. Try again.');

  const theme = Object.keys(OPENERS).includes(json.theme) ? json.theme : 'modern';
  const id = uid('world');
  const state = blankState({
    id,
    premise: String(json.premise || description).slice(0, 240),
    theme,
    name: String(json.name || 'Custom World').slice(0, 40),
    startMoney: 100,
  });

  state.player.name = String(playerName || 'You').slice(0, 40);
  state.player.handle = '@' + slugHandle(handle);
  state.player.bio = 'Just arrived.';

  // Dedupe names and handles — models often repeat stems.
  const usedNames = new Set();
  const usedHandles = new Set();
  state.npcs = [];

  for (const [i, c] of chars.slice(0, 8).entries()) {
    let name = String(c.name || '').trim().slice(0, 40);
    let h = String(c.handle || '')
      .toLowerCase()
      .replace(/^@/, '')
      .replace(/[^a-z0-9_]/g, '')
      .slice(0, 18);

    if (!name) continue;

    // Names are deduped on the surname-less stem so "Mira Vale" and
    // "Mira Sol" don't both land in one world.
    const stem = name.split(' ')[0].toLowerCase();
    if (usedNames.has(stem)) continue;
    usedNames.add(stem);

    if (!h) h = slug(name);
    let unique = h;
    let n = 2;
    while (usedHandles.has(unique)) unique = `${h}${n++}`;
    usedHandles.add(unique);

    state.npcs.push(makeNpc({
      name,
      handle: unique,
      archetype: ARCHETYPES.includes(c.archetype) ? c.archetype : 'lurker',
      vibe: String(c.vibe || '').slice(0, 60),
      bio: String(c.bio || '').slice(0, 80),
      followers: Number.isFinite(c.followers) ? Math.max(0, Math.round(c.followers)) : rng.int(500, 40000),
    }, i));
  }

  // If dedupe was too aggressive, top the cast back up locally.
  while (state.npcs.length < 4) {
    state.npcs.push(localPersona({ theme }, new Set(
      state.npcs.flatMap((n) => [n.name.toLowerCase(), n.handle.toLowerCase()])
    )));
  }

  state.posts = buildOpenerPosts(state.npcs, theme);

  // Background accounts so the timeline reads as public, not staged.
  state.npcs.push(...seedCrowd(CROWD_SIZE));

  state.stats.clout = 4;
  state.player.followers = Math.max(0, Math.round(state.stats.clout * 1.8));
  state.player.following = state.npcs.length;

  state.events.push({
    id: uid('ev'),
    ts: Date.now(),
    kind: 'system',
    title: `${state.meta.name} is live`,
    detail: state.meta.premise,
  });

  return {
    id,
    state,
    template: {
      id: 'custom',
      name: state.meta.name,
      icon: String(json.icon || '🌍').slice(0, 4),
      accent: 'linear-gradient(135deg,#5eead4,#a78bfa)',
    },
  };
}

/* ============================================================
   Switching & deletion
   ============================================================ */

export function switchWorld(worldId) {
  if (!worldId || worldId === activeWorldId()) return false;
  flushNow();
  setActiveWorldId(worldId);
  upsertWorldIndex({ ...(worldMeta(worldId) || { id: worldId, name: 'World' }), id: worldId });
  return true;
}

function flushNow() {
  try {
    const s = getState();
    localStorage.setItem('status.save.v2.' + (s.worldId || activeWorldId()), JSON.stringify(s));
  } catch (e) { warn('flushNow failed', e); }
}

export function deleteWorld(worldId) {
  if (worldId === activeWorldId()) return false;
  removeWorldIndex(worldId);
  return deleteWorldSave(worldId);
}

/** Guarantee at least one world exists, migrating old saves. */
export function ensureWorld() {
  const list = listWorlds();
  if (list.length) return false;
  if (hasWorldSave(activeWorldId())) {
    // Legacy world with no index entry — adopt it.
    const s = getState();
    upsertWorldIndex({
      id: s.worldId,
      name: s.meta?.name || 'Status',
      template: 'modern',
      premise: s.meta?.premise || '',
      theme: s.meta?.theme || 'modern',
      icon: '📱',
    });
    return false;
  }
  createFromTemplate('modern');
  return true;
}
