/* ============================================================
   db.js — persistence layer (world-scoped, versioned, debounced)

   Every world gets its own save key, so switching worlds never
   loses a timeline. The active world id lives separately.
   ============================================================ */

import { store, uid } from './util.js';

const SAVE_PREFIX = 'status.save.v2.';
const ACTIVE_KEY = 'status.activeWorld';
const LEGACY_KEY = 'status.save.v1';
const MIGRATED_KEY = 'status.migrated.v2';

export const SCHEMA_VERSION = 2;

let _worldId = null;
let _state = null;
let _saveTimer = null;
const _subs = new Set();

export function blankState(world = {}) {
  return {
    version: SCHEMA_VERSION,
    worldId: world.id || 'default',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    player: {
      id: uid('player'),
      name: 'You',
      handle: '@you',
      bio: world.playerBio || 'New here. Figuring it out.',
      // Private character definition — sent to the model, never rendered.
      persona: '',
      avatarSeed: 'you',
      followers: 0,
      following: 0,
      verified: false,
      joinedAt: new Date().toISOString(),
    },
    stats: {
      clout: 0,
      money: world.startMoney ?? 120,
      mood: 70,
      streak: 0,
      posts: 0,
    },
    npcs: [],
    posts: [],
    threads: [],
    events: [],
    log: [],
    flags: {},
    /* World memory — the narrative record that lets characters and
       places stay consistent across separate posts, threads and DMs.
       Each entry is a curated fact written by the model via tools. */
    memory: {
      facts: [],      // { id, ts, subject, text, tags[], source }
      lore: '',       // running prose summary of the world so far
      updatedAt: 0,
    },
    meta: {
      premise: world.premise || '',
      theme: world.theme || 'modern',
      name: world.name || 'Status',
    },
  };
}

/* ---------------- active world ---------------- */

export function activeWorldId() {
  if (_worldId) return _worldId;
  _worldId = store.get(ACTIVE_KEY, null) || 'default';
  return _worldId;
}

export function setActiveWorldId(id) {
  if (!id) return;
  flush();
  _worldId = id;
  _state = null;
  store.set(ACTIVE_KEY, id);
}

export function hasWorldSave(id) {
  return store.get(SAVE_PREFIX + id, null) !== null;
}

export function deleteWorldSave(id) {
  if (id === activeWorldId()) return false;
  store.del(SAVE_PREFIX + id);
  return true;
}

/* ---------------- state ---------------- */

export function getState() {
  if (_state) return _state;
  const id = activeWorldId();
  const saved = store.get(SAVE_PREFIX + id, null);
  _state = saved && saved.version === SCHEMA_VERSION ? saved : blankState({ id });

  const b = blankState({ id });
  for (const k of Object.keys(b)) if (_state[k] === undefined) _state[k] = b[k];
  _state.stats = { ...b.stats, ..._state.stats };
  _state.player = { ...b.player, ..._state.player };
  _state.meta = { ...b.meta, ..._state.meta };
  // Memory was added after the first saves shipped.
  _state.memory = { ...b.memory, ...(_state.memory || {}) };
  if (!Array.isArray(_state.memory.facts)) _state.memory.facts = [];
  _state.worldId = id;

  // Retired stat fields from older saves.
  for (const dead of ['energy', 'maxEnergy', 'lastEnergyAt']) delete _state.stats[dead];

  return _state;
}

export function subscribe(fn) {
  _subs.add(fn);
  return () => _subs.delete(fn);
}

function emit(reason = 'update') {
  for (const fn of _subs) {
    try { fn(_state, reason); } catch (e) { console.error('subscriber failed', e); }
  }
}

export function commit(reason = 'update', { silent = false } = {}) {
  const s = getState();
  s.updatedAt = new Date().toISOString();
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(flush, 240);
  if (!silent) emit(reason);
}

export function flush() {
  const s = getState();
  const key = SAVE_PREFIX + (s.worldId || activeWorldId());
  const ok = store.set(key, s);
  if (!ok) {
    s.log = s.log.slice(0, Math.max(0, Math.floor(s.log.length / 2)));
    s.posts = s.posts.slice(0, 220);
    store.set(key, s);
  }
}

export function update(reason, fn, opts) {
  const s = getState();
  const result = fn(s);
  commit(reason, opts);
  return result;
}

/* ---------------- install / reset ---------------- */

/** Install a fully-built world state and make it active. */
export function installState(id, state, reason = 'world-created') {
  flush();
  _worldId = id;
  _state = { ...state, worldId: id, version: SCHEMA_VERSION };
  store.set(ACTIVE_KEY, id);
  clearTimeout(_saveTimer);
  flush();
  emit(reason);
  return _state;
}

export function resetAll() {
  const id = activeWorldId();
  const meta = getState().meta;
  _state = blankState({ id, ...meta });
  flush();
  emit('reset');
  return _state;
}

export function exportSave() {
  return JSON.stringify(getState(), null, 2);
}

export function importSave(json) {
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || !parsed.player) {
    throw new Error('Not a Status save file.');
  }
  const id = activeWorldId();
  _state = { ...blankState({ id }), ...parsed, version: SCHEMA_VERSION, worldId: id };
  flush();
  emit('import');
  return _state;
}

export function saveSizeKB() {
  try { return Math.round((JSON.stringify(getState()).length * 2) / 1024); }
  catch { return 0; }
}

/* ---------------- legacy migration ---------------- */

/** v1 kept one save under one key with no world concept — wrap it as "default". */
export function migrateLegacy() {
  if (store.get(MIGRATED_KEY, false) === true) return false;
  const legacy = store.get(LEGACY_KEY, null);
  const target = SAVE_PREFIX + 'default';
  if (legacy && !store.get(target, null)) {
    store.set(target, {
      ...blankState({ id: 'default' }),
      ...legacy,
      version: SCHEMA_VERSION,
      worldId: 'default',
      meta: { premise: '', theme: 'modern', name: 'Status' },
    });
    store.set(ACTIVE_KEY, 'default');
  }
  store.set(MIGRATED_KEY, true);
  return true;
}

export function migrate() {
  migrateLegacy();
  const s = getState();
  if (s.version !== SCHEMA_VERSION) {
    s.version = SCHEMA_VERSION;
    flush();
  }
  return s;
}

/* ---------------- collection helpers ---------------- */

export const addPost = (post) => {
  const s = getState();
  const full = { id: uid('post'), ts: Date.now(), likes: 0, reposts: 0, replies: [], ...post };
  s.posts.unshift(full);
  if (s.posts.length > 400) s.posts.length = 400;
  return full;
};

export const addThread = (thread) => {
  const s = getState();
  const full = { id: uid('thread'), ts: Date.now(), messages: [], unread: 0, ...thread };
  s.threads.unshift(full);
  return full;
};

export const addLog = (entry) => {
  const s = getState();
  s.log.unshift({ id: uid('log'), ts: Date.now(), ...entry });
  if (s.log.length > 300) s.log.length = 300;
  return s.log[0];
};

export const addEvent = (entry) => {
  const s = getState();
  s.events.unshift({ id: uid('ev'), ts: Date.now(), ...entry });
  if (s.events.length > 200) s.events.length = 200;
  return s.events[0];
};

export const getNpc = (id) => getState().npcs.find((n) => n.id === id);
export const getThread = (id) => getState().threads.find((t) => t.id === id);
export const upsertNpc = (npc) => {
  const s = getState();
  const i = s.npcs.findIndex((n) => n.id === npc.id);
  if (i >= 0) s.npcs[i] = { ...s.npcs[i], ...npc };
  else s.npcs.push({ id: uid('npc'), ...npc });
  return i >= 0 ? s.npcs[i] : s.npcs[s.npcs.length - 1];
};
