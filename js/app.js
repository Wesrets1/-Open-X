/* ============================================================
   app.js — shell, routing, overlays, onboarding
   ============================================================ */

import {
  $, h, iconEl, icons, store, sleep, append, esc, plural,
} from './util.js';
import {
  getState, commit, subscribe, migrate, exportSave, importSave, resetAll,
  getNpc, getThread, upsertNpc,
} from './db.js';
import { getConfig, saveConfig, PRESETS } from './config.js';
import {
  bootstrapWorld, startAutonomy, stopAutonomy, tickPassive,
  replyAsPlayer, openThreadWith, runLocalAmbient,
} from './engine.js';
import { renderFeed, renderChats, renderThread, renderProfile, renderSettings } from './views.js';
import { renderNpcProfile, renderPostThread } from './personaViews.js';
import { avatar, pill } from './components.js';
import { applyDisplay, watchViewport, resolveNavMode } from './display.js';
import {
  TEMPLATES, listWorlds, worldMeta, switchWorld, deleteWorld,
  createFromTemplate, generateWorld, activateWorld, buildFromTemplate,
  makeNpc, ARCHETYPES,
} from './worlds.js';
import { dbg } from './debug.js';
import { generateCrowd, installCrowd, clearCrowd as clearCrowdAccounts, CROWD_SIZE } from './crowd.js';
import { memoryStats, allFacts, getLore, foldLore, clearMemory as clearWorldMemory } from './memory.js';

/* ============================================================
   Shell
   ============================================================ */

const device = $('#device');
const viewEl = $('#view');
const topEl = $('#topbar');
const tabEl = $('#tabbar');
const statusEl = $('#statusbar');
const layers = $('#layers');
const toastsEl = $('#toasts');

const TABS = [
  { id: 'feed', label: 'Home', icon: 'home' },
  { id: 'chats', label: 'Messages', icon: 'chat' },
  { id: 'profile', label: 'Profile', icon: 'user' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
];

const route = { tab: 'feed', threadId: null, npcId: null, postId: null };

/* ============================================================
   Toasts
   ============================================================ */

function toast(message, kind = 'info', ms = 2800) {
  const iconName = kind === 'ok' ? 'check' : kind === 'err' ? 'warning' : 'spark';
  const el = h('div', { class: 'toast ' + kind },
    h('div', { class: 'ico' }, iconEl(iconName, 15)),
    h('div', {}, message)
  );
  toastsEl.append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }, ms);
}

/* ============================================================
   Overlays
   ============================================================ */

function clearLayers() { layers.innerHTML = ''; }

function closeLayers() {
  layers.innerHTML = '';
}

/**
 * Bottom sheet.
 * @param {object} o
 * @param {string} o.title
 * @param {(body: HTMLElement, close: Function) => void} o.build
 */
function sheet({ title, build }) {
  clearLayers();
  const scrim = h('div', { class: 'scrim', onclick: closeLayers });
  const body = h('div', { class: 'sheet-body' });
  const close = () => closeLayers();
  const card = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sheet-grab' }),
    h('div', { class: 'sheet-head' },
      h('h2', {}, title),
      h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, iconEl('x', 17))
    ),
    body
  );
  layers.append(scrim, card);
  build(body, close);
  return close;
}

function modal({ build }) {
  clearLayers();
  const scrim = h('div', { class: 'scrim', onclick: closeLayers });
  const card = h('div', { class: 'modal-card', role: 'dialog', 'aria-modal': 'true' });
  const body = h('div', { class: 'modal-body' });
  card.append(body);
  layers.append(h('div', { class: 'modal' }, scrim, card));
  build(body, closeLayers);
  return closeLayers;
}

/** Small confirm dialog. */
function confirmModal({ title, body: text, confirmLabel = 'Confirm', danger = false, onConfirm }) {
  modal({
    build: (body, close) => {
      body.append(
        h('h2', {}, title),
        text ? h('p', { class: 'lead' }, text) : null,
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn', onclick: close }, 'Cancel'),
          h('button', {
            class: 'btn ' + (danger ? 'danger' : 'primary'),
            onclick: () => { close(); onConfirm?.(); },
          }, confirmLabel)
        )
      );
    },
  });
}

/* ============================================================
   Context helpers passed into view renderers
   ============================================================ */

const ctx = {
  toast,
  sheet,
  modal,
  closeLayers,

  /** Re-apply display state (navigation orientation, motion). */
  applyDisplay() {
    return applyDisplay();
  },

  scrollBottom() {
    requestAnimationFrame(() => {
      const scroller = viewEl.querySelector('.chat-scroll');
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      else viewEl.scrollTop = viewEl.scrollHeight;
    });
  },

  refresh() {
    render();
  },

  openThread(threadId) {
    route.tab = 'chats';
    route.threadId = threadId;
    render();
  },

  goToFeed() {
    route.tab = 'feed';
    route.threadId = null;
    render();
  },

  backToChats() {
    route.threadId = null;
    render();
  },

  /* ---- reply sheet ---- */
  replySheet(post) {
    sheet({
      title: 'Reply',
      build: (body, close) => {
        body.append(
          h('div', { class: 'card', style: { background: 'rgba(0,0,0,.22)' } },
            h('div', { class: 'post-head', style: { marginBottom: '8px' } },
              avatar(post.authorName, { size: 32 }),
              h('div', { class: 'meta' },
                h('div', { class: 'name', style: { fontSize: '13px' } }, post.authorName),
                h('div', { class: 'handle' }, post.authorHandle)
              )
            ),
            h('div', { class: 'post-body', style: { fontSize: '13.5px' } }, post.text)
          )
        );
        const ta = h('textarea', {
          class: 'textarea', rows: '3', placeholder: `Reply to ${post.authorName.split(' ')[0]}…`,
        });
        const btn = h('button', { class: 'btn primary block', disabled: true }, iconEl('send', 15), 'Send reply');
        ta.addEventListener('input', () => { btn.disabled = !ta.value.trim(); });
        btn.addEventListener('click', () => {
          const res = replyAsPlayer(post.id, ta.value);
          if (!res.ok) { toast(res.error, 'err'); return; }
          close();
          toast('Reply sent', 'ok');
          render();
        });
        body.append(h('div', { class: 'field' }, ta), btn);
      },
    });
  },

  /* ---- open a post thread ---- */
  openPost(postId) {
    route.postId = postId;
    render();
  },

  closePost() {
    route.postId = null;
    render();
  },

  /* ---- open a persona profile ---- */
  openNpcProfile(npcId) {
    route.npcId = npcId;
    render();
  },

  closeNpcProfile() {
    route.npcId = null;
    render();
  },

  openOwnProfile() {
    route.tab = 'profile';
    route.npcId = null;
    route.postId = null;
    route.threadId = null;
    render();
  },

  /* ---- new chat ---- */
  newChatSheet() {
    sheet({
      title: 'Start a chat',
      build: (body) => {
        const s = getState();
        for (const npc of s.npcs) {
          body.append(h('div', {
            class: 'row',
            onclick: () => {
              const t = openThreadWith(npc.id);
              closeLayers();
              if (t) ctx.openThread(t.id);
            },
          },
            avatar(npc.name, { size: 42 }),
            h('div', { class: 'r-main' },
              h('div', { class: 'r-title' }, npc.name),
              h('div', { class: 'r-sub' }, `${npc.handle} · ${npc.archetype}`)
            ),
            h('div', { class: 'r-meta' }, iconEl('chevron', 15))
          ));
        }
      },
    });
  },

  /* ---- edit profile ---- */
  editProfileSheet() {
    const s = getState();
    sheet({
      title: 'Edit profile',
      build: (body, close) => {
        const name = h('input', { class: 'input', value: s.player.name });
        const handle = h('input', { class: 'input', value: s.player.handle.replace(/^@/, '') });
        const bio = h('textarea', { class: 'textarea', rows: '3' });
        bio.value = s.player.bio || '';
        const save = h('button', { class: 'btn primary block' }, iconEl('check', 15), 'Save');
        save.addEventListener('click', () => {
          const st = getState();
          st.player.name = name.value.trim() || 'You';
          st.player.handle = '@' + (handle.value.trim().replace(/^@/, '') || 'you');
          st.player.bio = bio.value.trim().slice(0, 200);
          commit('profile');
          close();
          toast('Profile updated', 'ok');
          render();
        });
        body.append(
          h('div', { class: 'field' }, h('label', {}, 'Display name'), name),
          h('div', { class: 'field' }, h('label', {}, 'Handle'), handle),
          h('div', { class: 'field' }, h('label', {}, 'Bio'), bio),
          save
        );
      },
    });
  },

  /* ==========================================================
     Personas
     ========================================================== */

  /** Create a persona from scratch. */
  newPersonaSheet(onDone = null) {
    sheet({
      title: 'Add a persona',
      build: (body, close) => {
        const name = h('input', { class: 'input', placeholder: 'Full name' });
        const handle = h('input', { class: 'input', placeholder: 'handle (no @)' });
        const arch = h('select', { class: 'select' },
          ARCHETYPES.map((a) => h('option', { value: a }, a)));
        const vibe = h('input', { class: 'input', placeholder: 'two or three adjectives' });
        const bio = h('textarea', { class: 'textarea', rows: '2', placeholder: 'under 60 characters' });
        const followers = h('input', { class: 'input', type: 'number', min: '0', value: '1200' });
        const err = h('div', { class: 'hint', style: { color: 'var(--rose)' } }, '');

        const fill = (npc) => {
          name.value = npc.name;
          handle.value = npc.handle.replace(/^@/, '');
          arch.value = npc.archetype;
          vibe.value = npc.vibe || '';
          bio.value = npc.bio || '';
          followers.value = String(npc.followers || 0);
        };

        const genBtn = h('button', { class: 'btn sm' }, iconEl('wand', 14), 'Generate one');
        genBtn.addEventListener('click', async () => {
          const st = getState();
          genBtn.disabled = true;
          genBtn.textContent = 'Thinking…';
          try {
            const npc = await generatePersona(
              { name: st.meta.name, premise: st.meta.premise, theme: st.meta.theme },
              { avoid: st.npcs.flatMap((n) => [n.name, n.handle.replace(/^@/, '')]) }
            );
            fill(npc);
          } catch (e) {
            err.textContent = 'Could not generate a persona.';
          } finally {
            genBtn.disabled = false;
            genBtn.innerHTML = '';
            genBtn.append(iconEl('wand', 14), document.createTextNode('Generate one'));
          }
        });

        const save = h('button', { class: 'btn primary block' }, iconEl('plus', 15), 'Add persona');
        save.addEventListener('click', () => {
          const n = name.value.trim();
          const hd = handle.value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
          if (!n) { err.textContent = 'A name is required.'; return; }
          if (!hd) { err.textContent = 'A handle is required.'; return; }
          if (getState().npcs.some((x) => x.handle.toLowerCase() === '@' + hd)) {
            err.textContent = `@${hd} is already taken in this world.`;
            return;
          }
          const npc = makeNpc({
            name: n,
            handle: hd,
            archetype: arch.value,
            vibe: vibe.value.trim().slice(0, 60),
            bio: bio.value.trim().slice(0, 80),
            followers: Math.max(0, Number(followers.value) || 0),
          });
          upsertNpc(npc);
          commit('persona-added');
          close();
          toast(`${npc.name} joined the world`, 'ok');
          onDone?.(npc);
          render();
        });

        body.append(
          h('p', { class: 'lead' }, 'Personas live in this world only. They post, reply, and message you on their own.'),
          h('div', { class: 'field' }, h('label', {}, 'Display name'), name),
          h('div', { class: 'field' }, h('label', {}, 'Handle'), handle),
          h('div', { class: 'field' }, h('label', {}, 'Archetype'), arch),
          h('div', { class: 'field' }, h('label', {}, 'Vibe'), vibe),
          h('div', { class: 'field' }, h('label', {}, 'Bio'), bio),
          h('div', { class: 'field' }, h('label', {}, 'Followers'), followers),
          err,
          save
        );
      },
    });
  },

  /** Edit an existing persona. */
  editPersonaSheet(npcId) {
    const npc = getNpc(npcId);
    if (!npc) return;
    sheet({
      title: `Edit ${npc.name}`,
      build: (body, close) => {
        const name = h('input', { class: 'input', value: npc.name });
        const handle = h('input', { class: 'input', value: npc.handle.replace(/^@/, '') });
        const arch = h('select', { class: 'select' },
          ARCHETYPES.map((a) => h('option', { value: a, selected: a === npc.archetype }, a)));
        const vibe = h('input', { class: 'input', value: npc.vibe || '' });
        const bio = h('textarea', { class: 'textarea', rows: '2' });
        bio.value = npc.bio || '';
        const followers = h('input', { class: 'input', type: 'number', min: '0', value: String(npc.followers || 0) });
        const aff = h('input', { class: 'input', type: 'range', min: '-100', max: '100', value: String(npc.affinity ?? 0) });
        const affVal = h('span', { class: 'pill' }, String(npc.affinity ?? 0));
        aff.addEventListener('input', () => { affVal.textContent = aff.value; });

        const saveBtn = h('button', { class: 'btn primary', style: { flex: '1' } }, iconEl('check', 15), 'Save');
        saveBtn.addEventListener('click', () => {
          npc.name = name.value.trim() || npc.name;
          npc.handle = '@' + (handle.value.trim().replace(/^@/, '').replace(/[^a-zA-Z0-9_]/g, '') || npc.handle.replace(/^@/, ''));
          npc.archetype = arch.value;
          npc.vibe = vibe.value.trim().slice(0, 60);
          npc.bio = bio.value.trim().slice(0, 80);
          npc.followers = Math.max(0, Number(followers.value) || 0);
          npc.affinity = Math.max(-100, Math.min(100, Number(aff.value) || 0));
          commit('persona-edited');
          close();
          toast('Persona updated', 'ok');
          render();
        });

        const delBtn = h('button', { class: 'btn danger sm' }, iconEl('trash', 14), 'Remove');
        delBtn.addEventListener('click', () => {
          confirmModal({
            title: `Remove ${npc.name}?`,
            body: 'Their posts stay in the timeline, but they will no longer act.',
            confirmLabel: 'Remove',
            danger: true,
            onConfirm: () => {
              const s = getState();
              s.npcs = s.npcs.filter((n) => n.id !== npc.id);
              commit('persona-removed');
              close();
              route.npcId = null;
              toast(`${npc.name} removed`, 'ok');
              render();
            },
          });
        });

        body.append(
          h('div', { class: 'field' }, h('label', {}, 'Display name'), name),
          h('div', { class: 'field' }, h('label', {}, 'Handle'), handle),
          h('div', { class: 'field' }, h('label', {}, 'Archetype'), arch),
          h('div', { class: 'field' }, h('label', {}, 'Vibe'), vibe),
          h('div', { class: 'field' }, h('label', {}, 'Bio'), bio),
          h('div', { class: 'field' }, h('label', {}, 'Followers'), followers),
          h('div', { class: 'field' },
            h('label', {}, 'Feelings toward you'),
            h('div', { class: 'row-gap' }, aff, affVal)
          ),
          h('div', { class: 'btn-row', style: { marginTop: '6px' } }, saveBtn),
          h('div', { class: 'btn-row', style: { marginTop: '10px' } }, delBtn)
        );
      },
    });
  },

  /** Manage everyone in this world. */
  managePersonasSheet() {
    sheet({
      title: 'Personas',
      build: (body) => {
        const paint = () => {
          body.innerHTML = '';
          const s = getState();
          body.append(
            h('p', { class: 'lead' }, `${plural(s.npcs.length, 'persona')} in ${s.meta.name}.`),
            h('button', {
              class: 'btn primary block',
              style: { marginBottom: '14px' },
              onclick: () => { closeLayers(); ctx.newPersonaSheet(() => ctx.managePersonasSheet()); },
            }, iconEl('plus', 15), 'Add a persona')
          );

          for (const npc of s.npcs) {
            body.append(h('div', {
              class: 'row',
              onclick: () => { closeLayers(); ctx.openNpcProfile(npc.id); },
            },
              avatar(npc.name, { size: 40 }),
              h('div', { class: 'r-main' },
                h('div', { class: 'r-title' }, npc.name),
                h('div', { class: 'r-sub' }, `${npc.handle} · ${npc.archetype}`)
              ),
              h('button', {
                class: 'icon-btn',
                style: { width: '32px', height: '32px' },
                'aria-label': `Edit ${npc.name}`,
                onclick: (e) => { e.stopPropagation(); closeLayers(); ctx.editPersonaSheet(npc.id); },
              }, iconEl('gear', 14))
            ));
          }
        };
        paint();
      },
    });
  },

  /* ============================================================
     Crowd + world memory
     ============================================================ */

  /** Generate and install more background accounts. Returns how many. */
  async refillCrowd() {
    const accounts = await generateCrowd(CROWD_SIZE, {});
    const added = installCrowd(accounts);
    if (added) commit('crowd');
    return added;
  },

  clearCrowd() {
    const n = clearCrowdAccounts();
    commit('crowd');
    toast(`Removed ${plural(n, 'background account')}`, 'ok');
    return n;
  },

  /** Rewrite the world recap from accumulated facts. */
  async foldMemory() {
    const text = await foldLore({ force: true });
    if (text) commit('memory');
    return !!text;
  },

  clearMemory() {
    clearWorldMemory();
    commit('memory');
  },

  /** Full memory browser. */
  openMemorySheet() {
    sheet({
      title: 'World memory',
      build: (body) => {
        body.innerHTML = '';
        const st = memoryStats();
        const facts = allFacts();

        body.append(h('p', { class: 'lead' },
          `${plural(st.facts, 'thing')} remembered across ${plural(Object.keys(st.bySubject).length, 'subject')}.`));

        if (st.loreLength) {
          body.append(h('div', { class: 'card' },
            h('div', { class: 'section-title', style: { margin: '0 0 6px' } }, 'Story so far'),
            h('div', { class: 'memory-lore' }, getLore())
          ));
        }

        if (!facts.length) {
          body.append(h('div', { class: 'hint' }, 'Nothing remembered yet.'));
          return;
        }

        const nameFor = (subject) => {
          if (subject === 'player') return 'You';
          if (subject === 'world') return 'World';
          return getState().npcs.find((n) => n.id === subject)?.name || 'Someone';
        };

        // Group by subject so the list reads like a dossier.
        const groups = new Map();
        for (const f of facts) {
          if (!groups.has(f.subject)) groups.set(f.subject, []);
          groups.get(f.subject).push(f);
        }

        for (const [subject, list] of groups) {
          body.append(h('div', { class: 'section-title' }, nameFor(subject)));
          for (const f of list) {
            body.append(h('div', { class: 'card memory-fact' },
              h('div', {}, f.text),
              f.tags?.length
                ? h('div', { class: 'row-gap', style: { marginTop: '6px' } },
                    f.tags.map((t) => pill(t)))
                : null
            ));
          }
        }
      },
    });
  },

  /* ---- data ---- */
  exportSave() {
    try {
      const blob = new Blob([exportSave()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: `status-save-${Date.now()}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('Save exported', 'ok');
    } catch (e) {
      toast('Export failed', 'err');
    }
  },

  importSave() {
    const input = h('input', { type: 'file', accept: 'application/json,.json' });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        importSave(text);
        toast('Save imported', 'ok');
        render();
      } catch (e) {
        toast('Invalid save file', 'err');
      }
    });
    input.click();
  },

  confirmReset() {
    modal({
      build: (body, close) => {
        body.append(
          h('h2', {}, 'Reset everything?'),
          h('p', { class: 'lead' }, 'This deletes your world, posts, threads and characters. It cannot be undone.'),
          h('div', { class: 'btn-row' },
            h('button', { class: 'btn', onclick: close }, 'Cancel'),
            h('button', {
              class: 'btn danger',
              onclick: () => {
                resetAll();
                bootstrapWorld().then(() => {
                  close();
                  route.tab = 'feed';
                  route.threadId = null;
                  toast('World reset', 'ok');
                  render();
                });
              },
            }, iconEl('trash', 15), 'Delete world')
          )
        );
      },
    });
  },

  /* ==========================================================
     Worlds
     ========================================================== */

  openWorldPicker() {
    sheet({
      title: 'Worlds',
      build: (body) => {
        const paint = () => {
          body.innerHTML = '';
          const worlds = listWorlds();
          const activeId = getState().worldId;

          body.append(
            h('p', { class: 'lead' },
              'Each world is its own timeline, cast and save. Nothing is shared between them.'),
            h('button', {
              class: 'btn primary block',
              style: { marginBottom: '16px' },
              onclick: () => { closeLayers(); ctx.newWorldSheet(); },
            }, iconEl('plus', 15), 'Create a world')
          );

          const heading = h('div', { class: 'section-title', style: { marginTop: '4px' } }, 'Your worlds');
          body.append(heading);

          if (!worlds.length) {
            body.append(h('div', { class: 'nodata' }, 'No worlds yet.'));
            return;
          }

          for (const w of worlds) {
            const isActive = w.id === activeId;
            const row = h('div', {
              class: 'card',
              style: {
                padding: '13px 14px',
                marginBottom: '9px',
                display: 'flex',
                gap: '12px',
                alignItems: 'center',
                borderColor: isActive ? 'rgba(167,139,250,.5)' : '',
                background: isActive ? 'rgba(167,139,250,.09)' : '',
              },
            },
              h('div', {
                style: {
                  width: '42px', height: '42px', borderRadius: '13px',
                  display: 'grid', placeItems: 'center', fontSize: '20px',
                  background: w.accent || 'var(--surface-2)',
                  flex: '0 0 auto',
                },
              }, w.icon || '🌍'),
              h('div', { style: { flex: '1', minWidth: '0' } },
                h('div', { style: { fontSize: '14px', fontWeight: '750', display: 'flex', gap: '6px', alignItems: 'center' } },
                  w.name,
                  isActive ? h('span', { class: 'pill good', style: { fontSize: '9.5px', padding: '1px 6px' } }, 'active') : null
                ),
                h('div', { class: 'r-sub' }, w.premise || w.template || '')
              )
            );

            if (!isActive) {
              row.style.cursor = 'pointer';
              row.addEventListener('click', () => {
                closeLayers();
                ctx.loadWorld(w.id);
              });
              const del = h('button', {
                class: 'icon-btn',
                style: { width: '32px', height: '32px' },
                'aria-label': `Delete ${w.name}`,
                onclick: (e) => {
                  e.stopPropagation();
                  ctx.confirmDeleteWorld(w, paint);
                },
              }, iconEl('trash', 14));
              row.append(del);
            }

            body.append(row);
          }
        };
        paint();
      },
    });
  },

  async loadWorld(id) {
    const meta = worldMeta(id);
    if (!switchWorld(id)) { toast('World not found', 'err'); return; }
    stopAutonomy();
    migrate();
    await bootstrapWorld();
    route.tab = 'feed';
    route.threadId = null;
    startAutonomy();
    toast(`Loaded ${meta?.name || 'world'}`, 'ok');
    render();
  },

  confirmDeleteWorld(meta, onDone) {
    modal({
      build: (body, close) => {
        body.append(
          h('h2', {}, `Delete ${meta.name}?`),
          h('p', { class: 'lead' }, 'This world and everything in it is removed permanently.'),
          h('div', { class: 'btn-row' },
            h('button', { class: 'btn', onclick: close }, 'Cancel'),
            h('button', {
              class: 'btn danger',
              onclick: () => {
                if (deleteWorld(meta.id)) toast('World deleted', 'ok');
                close();
                onDone();
              },
            }, iconEl('trash', 15), 'Delete')
          )
        );
      },
    });
  },

  newWorldSheet() {
    let tab = 'template';
    sheet({
      title: 'Create a world',
      build: (body) => {
        const tabsRow = h('div', { style: { display: 'flex', gap: '6px', marginBottom: '16px' } });
        const panel = h('div', {});

        const paintTabs = () => {
          tabsRow.innerHTML = '';
          const mk = (id, label) => h('button', {
            class: 'btn sm' + (tab === id ? ' primary' : ''),
            style: { flex: '1' },
            onclick: () => { tab = id; paintTabs(); paint(); },
          }, label);
          tabsRow.append(mk('template', 'Templates'), mk('custom', 'Describe it'));
        };

        const paint = () => {
          panel.innerHTML = '';
          if (tab === 'template') panel.append(ctx._templatePicker());
          else panel.append(ctx._customWorldForm());
        };

        paintTabs();
        paint();
        body.append(tabsRow, panel);
      },
    });
  },

  _templatePicker() {
    const wrap = h('div', {});
    wrap.append(h('p', { class: 'lead' }, 'Pick a premise and a cast. Ready-made worlds are instant and cost nothing to create.'));
    for (const t of TEMPLATES) {
      const card = h('div', {
        class: 'card tappable',
        style: { padding: '14px', marginBottom: '9px', display: 'flex', gap: '12px', alignItems: 'center' },
        onclick: () => ctx._startTemplate(t.id),
      },
        h('div', {
          style: {
            width: '46px', height: '46px', borderRadius: '14px',
            display: 'grid', placeItems: 'center', fontSize: '22px',
            background: t.accent, flex: '0 0 auto',
          },
        }, t.icon),
        h('div', { style: { flex: '1', minWidth: '0' } },
          h('div', { style: { fontSize: '14px', fontWeight: '750' } }, t.name),
          h('div', { class: 'r-sub', style: { whiteSpace: 'normal' } }, t.tagline),
          h('div', { class: 'pill', style: { marginTop: '6px', fontSize: '10px' } },
            `${t.cast.length} characters`)
        )
      );
      wrap.append(card);
    }
    return wrap;
  },

  _customWorldForm() {
    const wrap = h('div', {});
    const ta = h('textarea', {
      class: 'textarea',
      rows: '4',
      placeholder: 'e.g. a crumbling seaside hotel where the staff and guests all have secrets',
      'data-draft': 'new-world-desc',
    });
    const name = h('input', { class: 'input', placeholder: 'Your name', value: getState().player.name });
    const handle = h('input', { class: 'input', placeholder: 'handle', value: getState().player.handle.replace(/^@/, '') });
    const btn = h('button', { class: 'btn primary block' }, iconEl('wand', 15), 'Generate world');
    const note = h('div', { class: 'hint' }, '');

    btn.addEventListener('click', async () => {
      const desc = ta.value.trim();
      if (desc.length < 8) { toast('Describe the world a little more.', 'err'); return; }
      btn.disabled = true;
      btn.innerHTML = '';
      btn.append(iconEl('refresh', 15), document.createTextNode('Building…'));
      try {
        const built = await generateWorld(desc, {
          playerName: name.value.trim() || 'You',
          handle: handle.value.trim() || 'you',
        });
        closeLayers();
        activateWorld(built, 'world-created');
        stopAutonomy();
        route.tab = 'feed';
        route.threadId = null;
        startAutonomy();
        toast(`Welcome to ${built.state.meta.name}`, 'ok');
        render();
      } catch (e) {
        btn.disabled = false;
        btn.innerHTML = '';
        btn.append(iconEl('wand', 15), document.createTextNode('Generate world'));
        note.textContent = e.message;
        note.style.color = 'var(--rose)';
        toast('World generation failed', 'err');
      }
    });

    wrap.append(
      h('p', { class: 'lead' }, 'Describe a setting. One cheap call builds the premise and cast.'),
      h('div', { class: 'field' }, h('label', {}, 'The world'), ta),
      h('div', { class: 'field' }, h('label', {}, 'Your name'), name),
      h('div', { class: 'field' }, h('label', {}, 'Your handle'), handle),
      h('div', { class: 'ob-note', html: '<b>Tip.</b> Specific places and tensions produce better casts than genres alone.' }),
      btn,
      note
    );
    return wrap;
  },

  _startTemplate(templateId) {
    const tpl = TEMPLATES.find((t) => t.id === templateId);
    const nameInput = h('input', { class: 'input', placeholder: 'Your name', value: getState().player.name });
    const handleInput = h('input', { class: 'input', placeholder: 'handle', value: getState().player.handle.replace(/^@/, '') });

    modal({
      build: (body, close) => {
        body.append(
          h('h2', {}, tpl.name),
          h('p', { class: 'lead' }, tpl.premise),
          h('div', { class: 'field' }, h('label', {}, 'Your name'), nameInput),
          h('div', { class: 'field' }, h('label', {}, 'Your handle'), handleInput),
          h('div', { class: 'btn-row' },
            h('button', { class: 'btn', onclick: close }, 'Cancel'),
            h('button', {
              class: 'btn primary',
              onclick: () => {
                const built = createFromTemplate(templateId, {
                  playerName: nameInput.value.trim() || 'You',
                  handle: handleInput.value.trim() || 'you',
                });
                close();
                closeLayers();
                stopAutonomy();
                route.tab = 'feed';
                route.threadId = null;
                startAutonomy();
                toast(`${built.state.meta.name} is live`, 'ok');
                render();
              },
            }, iconEl('spark', 15), 'Create world')
          )
        );
      },
    });
  },
};

function pillMini(affinity = 0) {
  const cls = affinity > 20 ? 'good' : affinity < -20 ? 'bad' : '';
  return h('span', { class: 'pill ' + cls, style: { fontSize: '10px', padding: '2px 7px' } },
    affinity > 0 ? `+${affinity}` : String(affinity));
}

/* ============================================================
   Chrome rendering
   ============================================================ */

function renderStatusBar() {
  const now = new Date();
  const time = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const cfg = getConfig();
  statusEl.innerHTML = '';
  statusEl.append(
    h('span', {}, time),
    h('span', { class: 'sb-right' },
      h('span', { class: 'sb-dot' + (cfg.demoMode ? ' off' : '') }),
      h('span', {}, cfg.demoMode ? 'demo' : 'live')
    )
  );
}

function renderTop() {
  topEl.innerHTML = '';
  const s = getState();

  /* ---- post thread ---- */
  if (route.postId) {
    append(topEl, [
      h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: () => ctx.closePost() },
        iconEl('back', 18)),
      h('div', { style: { minWidth: '0' } },
        h('h1', { style: { fontSize: '17px' } }, 'Post'),
        h('p', { class: 'sub' }, 'conversation')
      ),
      h('span', { class: 'spacer' }),
    ]);
    return;
  }

  /* ---- persona profile ---- */
  if (route.npcId) {
    const npc = getNpc(route.npcId);
    append(topEl, [
      h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: () => ctx.closeNpcProfile() },
        iconEl('back', 18)),
      h('div', { style: { minWidth: '0' } },
        h('h1', { style: { fontSize: '17px' } }, npc?.name || 'Persona'),
        h('p', { class: 'sub' }, npc ? `${plural(s.posts.filter(p => p.authorId === npc.id).length, 'post')}` : '')
      ),
      h('span', { class: 'spacer' }),
      npc
        ? h('button', {
            class: 'icon-btn',
            'aria-label': 'Edit persona',
            onclick: () => ctx.editPersonaSheet(npc.id),
          }, iconEl('gear', 18))
        : null,
    ].filter(Boolean));
    return;
  }

  if (route.tab === 'chats' && route.threadId) {
    const t = getThread(route.threadId);
    const npc = t ? getNpc(t.npcId) : null;
    const head = [
      h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: () => ctx.backToChats() },
        iconEl('back', 18)),
      npc ? avatar(npc.name, { size: 36, online: (Date.now() - (npc.lastActive || 0)) < 6e5 }) : null,
      h('div', { style: { minWidth: '0' } },
        h('h1', { style: { fontSize: '16px', display: 'flex', alignItems: 'center', gap: '5px' } },
          npc?.name || 'Chat',
          npc?.verified ? h('span', { class: 'verified', html: icons.verified, style: { width: '13px', height: '13px', color: 'var(--violet)' } }) : null
        ),
        h('p', { class: 'sub' }, npc ? `${npc.handle} · ${npc.archetype}` : '')
      ),
      h('span', { class: 'spacer' }),
    ].filter(Boolean);
    append(topEl, head);
    return;
  }
  const titles = {
    feed: ['Home', 'your timeline'],
    chats: ['Messages', 'direct messages'],
    profile: ['Profile', 'your posts'],
    settings: ['Settings', 'endpoint & display'],
  };
  const [title, sub] = titles[route.tab] || titles.feed;

  const unread = s.threads.reduce((a, t) => a + (t.unread || 0), 0);

  const actions = [
    route.tab === 'feed'
      ? h('button', {
          class: 'icon-btn',
          'aria-label': 'Refresh world',
          onclick: async (e) => {
            e.currentTarget.classList.add('spin-ico');
            runLocalAmbient();
            ctx.toast('Timeline refreshed', 'ok');
            await sleep(180);
            ctx.refresh();
          },
        }, iconEl('refresh', 18))
      : null,
    route.tab !== 'settings'
      ? h('button', {
          class: 'icon-btn',
          'aria-label': 'Settings',
          onclick: () => { route.tab = 'settings'; route.threadId = null; render(); },
        }, iconEl('gear', 18))
      : null,
    unread
      ? h('button', {
          class: 'icon-btn',
          'aria-label': `${unread} unread messages`,
          onclick: () => { route.tab = 'chats'; route.threadId = null; render(); },
        }, iconEl('chat', 18), h('span', { class: 'badge' }, unread > 9 ? '9+' : String(unread)))
      : null,
  ].filter(Boolean);

  topEl.append(
    h('button', {
      class: 'icon-btn',
      'aria-label': 'Switch world',
      title: getState().meta?.name || 'Worlds',
      onclick: () => ctx.openWorldPicker(),
      style: { width: '34px', height: '34px', fontSize: '16px' },
    }, (worldMeta(getState().worldId)?.icon) || '🌍'),
    h('div', {},
      h('h1', {}, title),
      h('p', { class: 'sub' }, sub)
    ),
    h('span', { class: 'spacer' }),
    ...actions
  );
}

function renderTabs() {
  const s = getState();
  const unread = s.threads.reduce((a, t) => a + (t.unread || 0), 0);

  // Build once, then update in place so the rail can animate.
  if (!tabEl._built) {
    tabEl.innerHTML = '';
    const rail = h('div', { class: 'tab-rail' });
    tabEl.append(rail);
    tabEl._rail = rail;
    tabEl._tabs = [];
    for (const t of TABS) {
      const btn = h('button', {
        class: 'tab',
        'data-tab': t.id,
        onclick: () => {
          if (route.tab === t.id && !route.threadId && !route.npcId && !route.postId) return;
          route.tab = t.id;
          route.threadId = null;
          route.npcId = null;
          route.postId = null;
          render();
        },
      },
        iconEl(t.icon, 22),
        h('span', {}, t.label),
        h('span', { class: 'tab-badge hidden' })
      );
      tabEl._tabs.push(btn);
      tabEl.append(btn);
    }
    tabEl._built = true;
  }

  TABS.forEach((t, i) => {
    const btn = tabEl._tabs[i];
    const active = route.tab === t.id && !route.threadId && !route.npcId && !route.postId;
    btn.setAttribute('aria-current', active ? 'page' : 'false');
    const badge = btn.querySelector('.tab-badge');
    const n = t.id === 'chats' ? unread : 0;
    badge.textContent = n > 9 ? '9+' : String(n);
    badge.classList.toggle('hidden', !n);
  });

  // Slide the rail under/next to the active tab. Measured from the real
  // DOM so grid gaps and padding never skew the position.
  positionRail();
}

/**
 * Align the active-tab indicator with its tab. Called after every render
 * and again on viewport changes, since the rail's geometry is derived
 * from live measurements and would otherwise go stale on resize.
 */
function positionRail() {
  requestAnimationFrame(() => {
    const idx = TABS.findIndex((t) => t.id === route.tab && !route.threadId && !route.npcId && !route.postId);
    const rail = tabEl._rail;
    if (!rail) return;
    if (idx < 0) { rail.style.opacity = '0'; return; }
    rail.style.opacity = '1';

    const side = device.dataset.nav === 'side';
    const btn = tabEl._tabs[idx];
    const tb = tabEl.getBoundingClientRect();
    const bb = btn.getBoundingClientRect();
    const padLeft = parseFloat(getComputedStyle(tabEl).paddingLeft) || 0;

    if (side) {
      // Vertical rail: a short vertical bar centred on the tab.
      // The rail uses `top: 0`, which resolves against the padding box,
      // so no vertical padding offset is needed.
      const h = Math.min(24, bb.width * 0.6);
      const y = bb.top - tb.top + bb.height / 2;
      rail.style.width = '3px';
      rail.style.height = h + 'px';
      rail.style.transform = `translateY(${y - h / 2}px)`;
    } else {
      // Horizontal rail: a short horizontal bar centred on the tab.
      // The rail is pinned at `left: 12px`, which is the tabbar's own
      // horizontal padding — subtract it so the bar centres correctly.
      const w = Math.min(22, bb.width * 0.5);
      const x = bb.left - tb.left + bb.width / 2;
      rail.style.height = '3px';
      rail.style.width = w + 'px';
      rail.style.transform = `translateX(${x - w / 2 - padLeft}px)`;
    }
  });
}

/* ============================================================
   Main render
   ============================================================ */

let renderQueued = false;
const drafts = new Map();
let lastKey = '';

/** Preserve in-progress text and focus across re-renders. */
function captureDrafts() {
  for (const el of viewEl.querySelectorAll('[data-draft]')) {
    const key = el.dataset.draft;
    if (!key) continue;
    drafts.set(key, {
      value: el.value,
      focused: document.activeElement === el,
      start: el.selectionStart,
      end: el.selectionEnd,
    });
  }
}

function restoreDrafts() {
  for (const el of viewEl.querySelectorAll('[data-draft]')) {
    const rec = drafts.get(el.dataset.draft);
    if (!rec) continue;
    if (el.value !== rec.value) el.value = rec.value;
    if (rec.focused) {
      el.focus({ preventScroll: true });
      try { el.setSelectionRange(rec.start, rec.end); } catch {}
    }
  }
}

function render() {
  if (renderQueued) return;
  renderQueued = true;

  const run = () => {
    try {
      paintNow();
    } catch (e) {
      console.error('render failed', e);
    } finally {
      renderQueued = false;
    }
  };

  // requestAnimationFrame is throttled to zero while the tab is hidden,
  // which would leave renderQueued stuck at true and silently stop all
  // future renders. Fall back to a timeout in that case.
  if (document.hidden) {
    setTimeout(run, 0);
    return;
  }
  requestAnimationFrame(run);
}

function paintNow() {
  captureDrafts();
  const scrollTop = viewEl.scrollTop;

  const key = route.tab + '|' + (route.threadId || '') + '|' + (route.npcId || '') + '|' + (route.postId || '');
  const isSwap = key !== lastKey && lastKey !== '';
  const prevTab = lastKey ? lastKey.split('|')[0] : '';

  lastKey = key;

  renderStatusBar();
  renderTop();
  renderTabs();

  viewEl.innerHTML = '';
  viewEl.classList.toggle('thread-mode', !!route.threadId);
  let content;
  if (route.postId) content = renderPostThread(ctx, route.postId);
  else if (route.npcId) content = renderNpcProfile(ctx, route.npcId);
  else if (route.tab === 'feed') content = renderFeed(ctx);
  else if (route.tab === 'chats') content = route.threadId ? renderThread(ctx, route.threadId) : renderChats(ctx);
  else if (route.tab === 'profile') content = renderProfile(ctx);
  else content = renderSettings(ctx);

  if (content) viewEl.append(content);
  restoreDrafts();

  if (route.threadId) {
    const scroller = viewEl.querySelector('.chat-scroll');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    else viewEl.scrollTop = viewEl.scrollHeight;
  } else viewEl.scrollTop = isSwap ? 0 : scrollTop;

  if (isSwap) slideIn(prevTab);
}

/**
 * Directional slide, matched to the navigation axis.
 *
 *   horizontal bar  → slide left/right along the tab order
 *   vertical rail   → slide up/down along the tab order
 *   drill-down      → slide in from the trailing edge
 *   back            → slide in from the leading edge
 */
function slideIn(prevTab) {
  const nav = document.getElementById('device').dataset.nav;
  const vertical = nav === 'side';

  const prevIdx = TABS.findIndex((t) => t.id === prevTab);
  const nextIdx = TABS.findIndex((t) => t.id === route.tab);

  let dx = 0;
  let dy = 0;

  if (route.npcId || route.postId || route.threadId) {
    // opening a detail view reads as "forward" in both axes
    if (vertical) dy = 34; else dx = 34;
  } else if (prevIdx >= 0 && nextIdx >= 0 && prevIdx !== nextIdx) {
    const forward = nextIdx > prevIdx;
    const magnitude = Math.min(42, 18 + Math.abs(nextIdx - prevIdx) * 9);
    if (vertical) dy = forward ? magnitude : -magnitude;
    else dx = forward ? magnitude : -magnitude;
  } else {
    if (vertical) dy = 22; else dx = 22;
  }

  viewEl.style.setProperty('--slide-x', dx + 'px');
  viewEl.style.setProperty('--slide-y', dy + 'px');

  // Restart the animation even if the class is already present.
  viewEl.classList.remove('slide-in');
  void viewEl.offsetWidth;
  viewEl.classList.add('slide-in');

  const blood = () => viewEl.classList.remove('slide-in');
  viewEl.addEventListener('animationend', blood, { once: true });
}

/* ============================================================
   Onboarding
   ============================================================ */

const ONBOARD_KEY = 'status.onboarded';

function shouldOnboard() {
  return !store.get(ONBOARD_KEY, false);
}

function showOnboarding() {
  const host = $('#onboarding');
  host.classList.add('on');
  host.innerHTML = '';

  let step = 0;
  let chosenTemplate = TEMPLATES[0].id;
  let chosenCustom = false;
  const card = h('div', { class: 'ob-card' });
  const steps = [];

  /* step 0 — welcome */
  steps.push(() => {
    card.innerHTML = '';
    card.append(
      h('div', { class: 'ob-logo' }, '📱'),
      h('h1', { html: 'Build your dream<br><em>social media life.</em>' }),
      h('p', { html: 'Pick a world, become someone in it, and post. A cast of characters lives their own lives around you — and every world keeps its own save.' }),
      h('button', { class: 'btn primary block', onclick: () => next() },
        'Choose a world', iconEl('chevron', 16)),
      h('div', { class: 'ob-note', html: '<b>Saved locally.</b> Every world is stored in this browser. Your keys and saves never leave it.' })
    );
  });

  /* step 1 — world */
  steps.push(() => {
    card.innerHTML = '';
    card.append(
      h('h1', {}, 'Pick your world'),
      h('p', {}, 'Each has its own place, cast and tension. You can make more later.')
    );

    const grid = h('div', {
      style: { display: 'grid', gap: '8px', maxHeight: '44vh', overflowY: 'auto', marginBottom: '16px' },
    });

    const rows = [];
    const select = (i) => {
      chosenTemplate = TEMPLATES[i].id;
      chosenCustom = false;
      rows.forEach((r, j) => {
        r.style.borderColor = j === i ? 'rgba(167,139,250,.75)' : 'var(--line)';
        r.style.background = j === i ? 'rgba(167,139,250,.13)' : 'var(--surface)';
      });
    };

    TEMPLATES.forEach((t, i) => {
      const el = h('button', {
        style: {
          display: 'flex', gap: '11px', alignItems: 'center', textAlign: 'left',
          padding: '11px 12px', borderRadius: '14px',
          border: '1px solid var(--line)', background: 'var(--surface)',
          color: 'inherit', width: '100%',
        },
        onclick: () => select(i),
      },
        h('span', {
          style: {
            width: '38px', height: '38px', borderRadius: '12px',
            display: 'grid', placeItems: 'center', fontSize: '19px',
            background: t.accent, flex: '0 0 auto',
          },
        }, t.icon),
        h('span', { style: { minWidth: '0' } },
          h('span', { style: { display: 'block', fontSize: '13.5px', fontWeight: '750' } }, t.name),
          h('span', { class: 'r-sub', style: { whiteSpace: 'normal', fontSize: '11.5px' } }, t.tagline)
        )
      );
      rows.push(el);
      grid.append(el);
    });
    select(0);

    card.append(
      grid,
      h('button', { class: 'btn primary block', onclick: () => next() }, 'Continue'),
      h('button', {
        class: 'btn block',
        style: { marginTop: '8px' },
        onclick: () => {
          chosenCustom = true;
          chosenTemplate = null;
          next();
        },
      }, 'Describe my own world instead')
    );
  });

  /* step 2 — endpoint */
  steps.push(() => {
    card.innerHTML = '';
    const presetSel = h('select', { class: 'select' },
      Object.values(PRESETS).map((p) => h('option', { value: p.id }, p.label))
    );
    const base = h('input', { class: 'input mono', value: PRESETS.openrouter.baseUrl });
    const key = h('input', { class: 'input mono', type: 'password', placeholder: 'sk-or-v1-…' });
    const model = h('input', { class: 'input mono', value: PRESETS.openrouter.model });

    presetSel.addEventListener('change', () => {
      const p = PRESETS[presetSel.value];
      base.value = p.baseUrl;
      model.value = p.model;
    });

    card.append(
      h('h1', {}, 'Connect your endpoint'),
      h('p', { html: 'Status talks to any OpenAI-compatible API. OpenRouter works out of the box.' }),
      h('div', { class: 'field' }, h('label', {}, 'Provider'), presetSel),
      h('div', { class: 'field' }, h('label', {}, 'Base URL'), base),
      h('div', { class: 'field' }, h('label', {}, 'API key'), key),
      h('div', { class: 'field' }, h('label', {}, 'Model'), model),
      h('div', { class: 'btn-row' },
        h('button', {
          class: 'btn primary',
          style: { flex: '1' },
          onclick: () => {
            saveConfig({
              preset: presetSel.value,
              baseUrl: base.value.trim(),
              apiKey: key.value.trim(),
              model: model.value.trim(),
              cheapModel: model.value.trim(),
              fastModel: model.value.trim(),
              demoMode: false,
            });
            next();
          },
        }, 'Save & continue'),
        h('button', {
          class: 'btn',
          onclick: () => { saveConfig({ demoMode: true }); next(); },
        }, 'Skip — use demo')
      ),
      h('div', { class: 'ob-note', html: '<b>Why a key?</b> Generation happens in the model. The key stays in localStorage and is sent only to the endpoint you choose.' })
    );
  });

  /* step 3 — character */
  steps.push(() => {
    card.innerHTML = '';
    const name = h('input', { class: 'input', placeholder: 'Your name', value: 'You' });
    const handle = h('input', { class: 'input', placeholder: 'handle', value: 'you' });
    card.append(
      h('h1', {}, 'Who are you?'),
      h('p', {}, 'This is the name your followers will see.'),
      h('div', { class: 'field' }, h('label', {}, 'Display name'), name),
      h('div', { class: 'field' }, h('label', {}, 'Handle'), handle),
      h('button', {
        class: 'btn primary block',
        onclick: () => { finish(name.value.trim(), handle.value.trim()); },
      }, 'Enter Status', iconEl('spark', 16))
    );
  });

  const dots = h('div', { class: 'ob-dots' }, steps.map(() => h('i')));
  host.append(h('div', { class: 'ob-wrap' }, card));

  function paint() {
    steps[step]();
    card.append(dots);
    [...dots.children].forEach((d, i) => d.classList.toggle('on', i <= step));
  }

  function next() {
    if (step >= steps.length - 1) return finish();
    step++;
    paint();
  }

  async function finish(playerName = 'You', handle = 'you') {
    store.set(ONBOARD_KEY, true);
    host.classList.remove('on');
    host.innerHTML = '';

    const opts = { playerName: playerName || 'You', handle: handle || 'you' };
    try {
      if (chosenCustom) {
        const built = await generateWorld(
          'An original, grounded world with a clear sense of place and a few unresolved tensions.',
          opts
        );
        activateWorld(built, 'world-created');
      } else {
        createFromTemplate(chosenTemplate || 'modern', opts);
      }
    } catch (e) {
      // never strand the player in onboarding
      createFromTemplate('modern', opts);
      startAutonomy();
    }

    route.tab = 'feed';
    route.threadId = null;
    startAutonomy();
    render();
  }

  paint();
}

/* ============================================================
   Background world activity
   ============================================================ */

async function refreshWorldInBackground() {
  // local ambient so the feed isn't empty on first load
  if (!getState().posts.length) runLocalAmbient();
}

/* ============================================================
   Visibility / timers
   ============================================================ */

function tickUi() {
  renderStatusBar();
  const changed = tickPassive();
  // Only re-render when a value the user can see actually moved.
  if (changed.followers && !document.activeElement?.matches('textarea, input')) {
    if (route.tab === 'profile' || route.tab === 'feed') render();
  }
}

/* ============================================================
   Boot
   ============================================================ */

let booted = false;

async function boot() {
  if (booted) return;
  booted = true;

  migrate();

  // Apply layout before the first paint so there's no flash.
  applyDisplay();

  // Only build/repair a world if the player is past onboarding.
  // Otherwise onboarding creates the first world itself.
  const onboarded = !shouldOnboard();
  if (onboarded) {
    await bootstrapWorld();
    tickPassive();
  }

  subscribe((state, reason) => {
    dbg('state change', reason);
    // Anything the world does on its own should surface without a manual refresh.
    const live = [
      'autonomy', 'ambient', 'autonomy-fallback', 'reactions', 'bootstrap',
      'world-created', 'dm-fallback', 'dm-echo', 'thread-compact', 'install',
    ];
    if (live.includes(reason)) {
      if (route.tab === 'feed' || route.tab === 'chats' || route.tab === 'profile') render();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLayers();
  });

  render();

  if (!onboarded) {
    showOnboarding();
  } else {
    startAutonomy();
  }

  setInterval(tickUi, 5000);

  /* ------------------------------------------------------------
     Responsive + measurement

     The app always fills the screen, so the only layout decision is
     the navigation orientation. A ResizeObserver on the tab bar is
     the reliable signal: it fires whenever the rail's own box
     changes, which covers window resizes, orientation changes,
     browser zoom, and devtools emulation — cases where `resize`
     alone can be skipped or arrive too early to measure against.
     ------------------------------------------------------------ */
  let lastNav = resolveNavMode();

  const onLayoutChange = () => {
    const nav = resolveNavMode();
    applyDisplay();
    if (nav !== lastNav) {
      lastNav = nav;
      render();
      dbg('nav changed →', nav);
      return;
    }
    // Same orientation, new geometry: the indicator is positioned from
    // live measurements, so re-align it. Re-pin the DM thread too.
    positionRail();
    if (route.threadId) {
      const scroller = viewEl.querySelector('.chat-scroll');
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    }
  };

  watchViewport(onLayoutChange);

  if (typeof ResizeObserver !== 'undefined') {
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { raf = 0; onLayoutChange(); });
    });
    ro.observe(tabEl);
  }

  // pause autonomy while hidden, resume on return
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopAutonomy();
    else startAutonomy();
  });

  window.addEventListener('beforeunload', () => {
    try { commit('unload', { silent: true }); } catch {}
  });

  // expose a tiny debug handle
  window.Status = { getState, getConfig, saveConfig, ctx, render, toast, worlds: {
    list: listWorlds, switch: switchWorld, create: createFromTemplate, generate: generateWorld,
  } };
  dbg('booted');

  // offline shell caching (only over http/https, and only on real hosts)
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch((e) => dbg('sw registration failed', e));
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
