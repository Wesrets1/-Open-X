/* ============================================================
   views.js — screen renderers
   ============================================================ */

import {
  h, esc, richText, avatarGradient, initials, ago, fmtNum, fmtCost, icons, iconEl,
  clockTime, dayStamp, rng, clamp, debounce, plural,
} from './util.js';
import {
  avatar, pill, meter, statBox, toggler, field, emptyState, sectionTitle,
  postCard, timelinePost, bubble, typingBubble, logEntry, skeletonPost,
} from './components.js';
import { getState, commit } from './db.js';
import { getConfig, saveConfig, PRESETS, usingSharedDemo } from './config.js';
import { hasDemoEndpoint } from './demoKey.js';
import { listWorlds } from './worlds.js';
import {
  describeViewport,
} from './display.js';
import {
  publishPost, likePost, replyAsPlayer, openThreadWith, sendDM, markThreadRead,
  suggestPosts, moodLabel, runAutonomyTick,
  runLocalAmbient, recomputeFollowers,
} from './engine.js';
import { getStats, resetStats, testConnection, clearCache } from './llm.js';
import { memoryStats } from './memory.js';

/** Toast helper that tolerates a ctx without it (defensive). */
function toastSafe(ctx, msg) {
  if (typeof ctx.toast === 'function') ctx.toast(msg, 'ok');
}

/* ============================================================
   FEED
   ============================================================ */

export function renderFeed(ctx) {
  const s = getState();
  const root = h('div', { class: 'view-inner' });
  root.append(composerBlock(ctx));

  const posts = s.posts.slice(0, 60);
  if (!posts.length) {
    root.append(emptyState({
      icon: 'feed',
      title: 'Your timeline is quiet',
      body: 'Post something, or let the world wake up on its own.',
      action: h('button', {
        class: 'btn',
        onclick: () => { runLocalAmbient(); ctx.refresh(); },
      }, iconEl('refresh', 15), 'Stir the timeline'),
    }));
    return root;
  }

  const list = h('div', { class: 'tw-feed-list' });
  for (const p of posts) {
    list.append(timelinePost(p, {
      onLike: (post) => { likePost(post.id); ctx.refresh(); },
      onReply: (post) => ctx.openPost(post.id),
      onOpen: (post) => ctx.openPost(post.id),
      onAuthor: (authorId) => {
        if (authorId && authorId !== 'player') ctx.openNpcProfile(authorId);
        else ctx.openOwnProfile();
      },
    }));
  }
  root.append(list);
  return root;
}

/** Inline composer, Twitter-style: avatar + expanding textarea + toolbar. */
function composerBlock(ctx) {
  const s = getState();
  const ta = h('textarea', {
    placeholder: 'What is happening?',
    maxlength: '400',
    rows: '1',
    'aria-label': 'Compose a post',
    'data-draft': 'feed-composer',
  });
  const count = h('span', { class: 'count' }, '');
  const postBtn = h('button', { class: 'btn primary sm', disabled: true }, 'Post');
  const ideaBtn = h('button', { class: 'icon-btn', title: 'Suggest ideas', 'aria-label': 'Ideas' },
    iconEl('dice', 17));

  const sync = () => {
    const n = ta.value.length;
    count.textContent = n ? `${n}/400` : '';
    postBtn.disabled = n === 0;
    ta.style.height = 'auto';
    ta.style.height = Math.min(140, ta.scrollHeight) + 'px';
  };
  ta.addEventListener('input', sync);

  const submit = async () => {
    const text = ta.value;
    if (!text.trim()) return;
    postBtn.disabled = true;
    const res = await publishPost(text);
    if (!res.ok) {
      ctx.toast(res.error || 'Could not post.', 'err');
      sync();
      return;
    }
    ta.value = '';
    sync();
    ctx.toast('Posted', 'ok');
    ctx.refresh();
  };

  ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
  });
  postBtn.addEventListener('click', submit);

  ideaBtn.addEventListener('click', async () => {
    ideaBtn.disabled = true;
    const opts = await suggestPosts();
    ideaBtn.disabled = false;
    if (!opts.length) { ctx.toast('No ideas came back.', 'err'); return; }
    ctx.sheet({
      title: 'Post ideas',
      build: (body, close) => {
        for (const o of opts) {
          body.append(h('div', {
            class: 'card tappable',
            onclick: () => { close(); ta.value = o; sync(); ta.focus(); },
          }, h('div', { class: 'post-body' }, o)));
        }
      },
    });
  });

  return h('div', { class: 'tw-composer' },
    avatar(s.player.name, { size: 40 }),
    h('div', { class: 'twc-main' },
      ta,
      h('div', { class: 'twc-bar' },
        count,
        ideaBtn,
        postBtn
      )
    )
  );
}
/* ============================================================
   CHATS
   ============================================================ */

export function renderChats(ctx) {
  const s = getState();
  const root = h('div', { class: 'view-inner' });

  const threads = [...s.threads].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const unreadTotal = threads.reduce((a, t) => a + (t.unread || 0), 0);

  root.append(
    h('div', { class: 'spread', style: { margin: '4px 2px 14px' } },
      h('div', { class: 'row-gap' },
        pill(plural(threads.length, 'thread')),
        unreadTotal ? pill(`${unreadTotal} new`, 'warn') : null
      ),
      h('button', {
        class: 'btn sm',
        onclick: () => ctx.newChatSheet(),
      }, iconEl('plus', 14), 'New')
    )
  );

  if (!threads.length) {
    root.append(emptyState({
      icon: 'chat',
      title: 'No messages yet',
      body: 'Start a conversation with someone in your orbit.',
      action: h('button', { class: 'btn primary', onclick: () => ctx.newChatSheet() },
        iconEl('plus', 15), 'Start a chat'),
    }));
    return root;
  }

  for (const t of threads) {
    const npc = s.npcs.find((n) => n.id === t.npcId);
    if (!npc) continue;
    const last = t.messages[t.messages.length - 1];
    const preview = last
      ? (last.from === 'player' ? 'You: ' : '') + last.text
      : 'Say hello';
    root.append(
      h('div', {
        class: 'row',
        onclick: () => ctx.openThread(t.id),
      },
        avatar(npc.name, { size: 46, online: (Date.now() - (npc.lastActive || 0)) < 6e5 }),
        h('div', { class: 'r-main' },
          h('div', { class: 'r-title' }, npc.name,
            npc.verified ? h('span', { class: 'verified', html: icons.verified }) : null),
          h('div', { class: 'r-sub' }, preview)
        ),
        h('div', { class: 'r-meta' },
          h('div', {}, ago(t.ts || Date.now())),
          t.unread ? h('div', { style: { marginTop: '5px' } }, pill(String(t.unread), 'bad')) : null
        )
      )
    );
  }
  return root;
}

/* ---------------- single thread ---------------- */

export function renderThread(ctx, threadId) {
  const s = getState();
  const t = s.threads.find((x) => x.id === threadId);
  const root = h('div', { class: 'view-inner' });
  if (!t) return emptyState({ icon: 'chat', title: 'Thread not found' });

  const npc = s.npcs.find((n) => n.id === t.npcId);
  if (!npc) return emptyState({ icon: 'chat', title: 'Character not found' });

  markThreadRead(threadId);

  const scroller = h('div', { class: 'chat-scroll' });
  let lastFrom = null;
  if (t.summary) {
    scroller.append(h('div', {
      class: 'pill', style: { alignSelf: 'center', margin: '6px 0 10px', fontSize: '10.5px' },
    }, 'earlier conversation summarised'));
  }
  for (const m of t.messages) {
    const same = m.from === lastFrom;
    scroller.append(bubble({
      text: m.text,
      mine: m.from === 'player',
      ts: m.ts,
      same,
    }));
    lastFrom = m.from;
  }
  root.append(scroller);

  const ta = h('textarea', {
    class: 'textarea',
    placeholder: `Message ${npc.name.split(' ')[0]}…`,
    rows: '1',
    'aria-label': 'Message',
    'data-draft': 'thread-' + threadId,
  });
  const sendBtn = h('button', { class: 'send-btn', 'aria-label': 'Send' }, iconEl('send', 19));

  let sending = false;
  const send = async () => {
    const text = ta.value.trim();
    if (!text || sending) return;
    sending = true;
    ta.value = '';
    ta.style.height = 'auto';
    sendBtn.disabled = true;

    scroller.append(bubble({ text, mine: true, ts: Date.now() }));
    const typer = typingBubble();
    scroller.append(typer);
    ctx.scrollBottom();

    const res = await sendDM(threadId, text);
    typer.remove();
    if (!res.ok && !res.aborted) ctx.toast(res.error || 'Message failed', 'err');

    const cur = getState().threads.find((x) => x.id === threadId);
    if (cur) {
      const last = cur.messages[cur.messages.length - 1];
      if (last && last.from !== 'player') {
        scroller.append(bubble({ text: last.text, mine: false, ts: last.ts }));
      }
    }
    sending = false;
    sendBtn.disabled = false;
    ctx.scrollBottom();
    commit('thread-view');
  };

  sendBtn.addEventListener('click', send);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(120, ta.scrollHeight) + 'px';
  });

  root.append(h('div', { class: 'chat-input-bar' }, ta, sendBtn));
  setTimeout(() => ctx.scrollBottom(), 40);
  return root;
}

/* ============================================================
   PROFILE — Twitter-style
   ============================================================ */

export function renderProfile(ctx) {
  const s = getState();
  const root = h('div', { class: 'view-inner' });
  const st = s.stats;
  const myPosts = s.posts.filter((p) => p.authorId === 'player');

  /* ---- banner ---- */
  root.append(
    h('div', { class: 'tw-banner' },
      h('div', { class: 'tw-banner-bg' }),
      h('div', { class: 'tw-banner-avatar' },
        avatar(s.player.name, { size: 76 }),
        h('button', {
          class: 'btn sm tw-edit-btn',
          onclick: () => ctx.editProfileSheet(),
        }, 'Edit profile')
      )
    )
  );

  /* ---- identity ---- */
  root.append(
    h('div', { class: 'tw-identity' },
      h('div', { class: 'tw-name-row' },
        h('span', { class: 'tw-name' }, s.player.name),
        s.player.verified ? h('span', { class: 'verified tw-verified', html: icons.verified }) : null
      ),
      h('div', { class: 'tw-handle' }, s.player.handle),
      s.player.bio ? h('div', { class: 'tw-bio' }, s.player.bio) : null,
      h('div', { class: 'tw-meta' },
        iconEl('clock', 14),
        `Joined ${new Date(s.player.joinedAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`
      ),
      h('div', { class: 'tw-counts' },
        h('span', {}, h('b', {}, fmtNum(s.player.following)), ' Following'),
        h('span', {}, h('b', {}, fmtNum(s.player.followers)), ' Followers')
      )
    )
  );

  /* ---- tabs ---- */
  const tabs = [
    { id: 'posts', label: 'Posts', count: myPosts.length },
    { id: 'replies', label: 'Replies', count: 0 },
    { id: 'media', label: 'Media', count: 0 },
  ];
  const state = { tab: 'posts' };
  const tabRow = h('div', { class: 'tw-tabs' });
  const list = h('div', { class: 'tw-list' });

  const paintTabs = () => {
    tabRow.innerHTML = '';
    for (const t of tabs) {
      tabRow.append(h('button', {
        class: 'tw-tab' + (state.tab === t.id ? ' on' : ''),
        onclick: () => { state.tab = t.id; paintTabs(); paintList(); },
      }, t.label, t.count ? h('span', { class: 'tw-tab-count' }, String(t.count)) : null));
    }
  };

  const paintList = () => {
    list.innerHTML = '';

    if (state.tab === 'replies') {
      list.append(emptyState({
        icon: 'comment',
        title: 'No replies yet',
        body: 'Reply to someone in your timeline and it will show up here.',
      }));
      return;
    }
    if (state.tab === 'media') {
      list.append(emptyState({
        icon: 'image',
        title: 'No media yet',
        body: 'This app is text-only for now.',
      }));
      return;
    }

    if (!myPosts.length) {
      list.append(emptyState({
        icon: 'feed',
        title: 'You haven\'t posted yet',
        body: 'Your posts will appear here.',
        action: h('button', {
          class: 'btn primary',
          onclick: () => { ctx.goToFeed(); },
        }, 'Write a post'),
      }));
      return;
    }

    for (const p of myPosts) {
      list.append(timelinePost(p, ctx));
    }
  };

  paintTabs();
  paintList();
  root.append(tabRow, list);

  /* ---- compact stats footer ---- */
  root.append(
    h('div', { class: 'tw-stats-strip' },
      stripStat('Clout', String(st.clout)),
      stripStat('Money', '$' + fmtNum(st.money)),
      stripStat('Streak', `${st.streak}d`),
      stripStat('Posts', String(st.posts))
    )
  );

  /* ---- people you follow ---- */
  root.append(sectionTitle('Following'));
  const sorted = [...s.npcs].sort((a, b) => (b.affinity ?? 0) - (a.affinity ?? 0));
  for (const n of sorted.slice(0, 12)) {
    const aff = n.affinity ?? 0;
    root.append(
      h('div', {
        class: 'row',
        onclick: () => { const t = openThreadWith(n.id); if (t) ctx.openThread(t.id); },
      },
        avatar(n.name, { size: 42 }),
        h('div', { class: 'r-main' },
          h('div', { class: 'r-title' }, n.name,
            n.verified ? h('span', { class: 'verified', html: icons.verified }) : null),
          h('div', { class: 'r-sub' }, `${n.handle} · ${n.archetype}`)
        ),
        h('div', { class: 'r-meta', style: { minWidth: '46px' } },
          pill(aff > 0 ? `+${aff}` : String(aff), aff > 20 ? 'good' : aff < -20 ? 'bad' : '')
        )
      )
    );
  }

  return root;
}

function stripStat(label, value) {
  return h('div', { class: 'strip-stat' },
    h('span', { class: 'ss-v' }, value),
    h('span', { class: 'ss-k' }, label)
  );
}

/* ============================================================
   SETTINGS
   ============================================================ */

export function renderSettings(ctx) {
  const c = getConfig();
  const s = getState();
  const root = h('div', { class: 'view-inner' });

  /* ---- endpoint ---- */
  root.append(sectionTitle('Endpoint'));

  const presetSel = h('select', { class: 'select' },
    Object.values(PRESETS).map((p) => h('option', { value: p.id, selected: p.id === c.preset }, p.label))
  );
  const baseInput = h('input', { class: 'input mono', value: c.baseUrl, placeholder: 'https://openrouter.ai/api/v1', spellcheck: 'false' });
  const keyInput = h('input', { class: 'input mono', type: 'password', value: c.apiKey, placeholder: 'sk-or-v1-…', spellcheck: 'false' });
  const modelInput = h('input', { class: 'input mono', value: c.model, placeholder: 'google/gemini-2.0-flash-001', spellcheck: 'false' });
  const cheapInput = h('input', { class: 'input mono', value: c.cheapModel, placeholder: 'cheap tier model' });
  const fastInput = h('input', { class: 'input mono', value: c.fastModel, placeholder: 'fast tier model' });
  const headersInput = h('textarea', {
    class: 'textarea mono',
    placeholder: 'X-Custom-Header: value\nAnother-Header: value',
    rows: '2',
  });
  headersInput.value = c.extraHeaders || '';

  const statusLine = h('div', { class: 'hint' }, '');

  // "Shared demo is on" is a derived fact, not a single flag:
  //   demoMode     true  = explicitly opt out (deterministic generator)
  //   demoEndpoint false = do not borrow the shared endpoint
  // Reading only one of them is what made this switch feel inverted.
  const sharedOn = () => !!c.demoMode === false && c.demoEndpoint !== false && hasDemoEndpoint();

  const demoSwitch = h('button', {
    class: 'switch',
    role: 'switch',
    'aria-checked': String(sharedOn()),
    'aria-label': 'Shared demo',
    onclick: (e) => {
      const on = e.currentTarget.getAttribute('aria-checked') !== 'true';
      e.currentTarget.setAttribute('aria-checked', String(on));
      // Turning the shared demo off must never silently flip the app into
      // offline generation — that is a separate, explicit choice. It just
      // stops borrowing the shared endpoint and waits for your own key.
      saveConfig({ demoMode: false, demoEndpoint: on });
      ctx.toast(
        on
          ? 'Using the shared demo endpoint'
          : 'Shared demo off — add your own API key below',
        'info'
      );
      ctx.refresh();
    },
  });

  presetSel.addEventListener('change', () => {
    const id = presetSel.value;
    const p = PRESETS[id];
    saveConfig({ preset: id, baseUrl: p.baseUrl, model: p.model, cheapModel: p.cheapModel, fastModel: p.fastModel });
    baseInput.value = p.baseUrl;
    modelInput.value = p.model;
    cheapInput.value = p.cheapModel;
    fastInput.value = p.fastModel;
    ctx.toast(`Loaded ${p.label} defaults`, 'ok');
  });

  const saveEndpoint = () => {
    saveConfig({
      baseUrl: baseInput.value.trim(),
      apiKey: keyInput.value.trim(),
      model: modelInput.value.trim(),
      cheapModel: cheapInput.value.trim() || modelInput.value.trim(),
      fastModel: fastInput.value.trim() || modelInput.value.trim(),
      extraHeaders: headersInput.value,
    });
    ctx.toast('Endpoint saved', 'ok');
    ctx.refresh();
  };

  const testBtn = h('button', { class: 'btn sm' }, iconEl('bolt', 14), 'Test');
  testBtn.addEventListener('click', async () => {
    saveEndpoint();
    testBtn.disabled = true;
    testBtn.textContent = 'Testing…';
    const r = await testConnection();
    testBtn.disabled = false;
    testBtn.innerHTML = '';
    testBtn.append(iconEl('bolt', 14), document.createTextNode('Test'));
    statusLine.textContent = r.ok
      ? `OK · ${r.ms}ms · ${r.model}`
      : `Failed · ${r.error}`;
    statusLine.style.color = r.ok ? 'var(--green)' : 'var(--rose)';
    ctx.toast(r.ok ? 'Endpoint reachable' : 'Endpoint failed', r.ok ? 'ok' : 'err');
  });

  root.append(
    h('div', { class: 'card' },
      h('div', { class: 'toggle', style: { borderBottom: '1px solid var(--line)' } },
        h('div', {},
          h('div', { class: 't-label' }, 'Shared demo'),
          h('div', { class: 't-desc' },
            hasDemoEndpoint()
              ? 'Use the built-in demo proxy and a free model, so you can play without configuring anything. Your own key below always takes priority.'
              : 'No shared demo is deployed for this copy. Add your own endpoint below to play.')
        ),
        demoSwitch
      ),
      field({ label: 'Provider preset', input: presetSel }),
      field({
        label: 'Base URL',
        hint: 'Any OpenAI-compatible endpoint. The app appends /chat/completions.',
        input: baseInput,
      }),
      field({
        label: 'API key',
        hint: 'Stored in localStorage on this device only. Never sent anywhere except your endpoint.',
        input: keyInput,
      }),
      field({ label: 'Main model', input: modelInput }),
      field({
        label: 'Cheap model',
        hint: 'Used for ambient activity, replies and summaries. Pick the cheapest model you trust.',
        input: cheapInput,
      }),
      field({ label: 'Fast model', hint: 'Used for short synchronous turns.', input: fastInput }),
      field({ label: 'Extra headers', hint: 'One per line, "Name: value".', input: headersInput }),
      (() => {
        const shared = usingSharedDemo(c);
        const available = hasDemoEndpoint();
        return h('div', { class: 'hint', style: { marginBottom: '10px' } },
          shared
            ? 'No key set — using the shared demo proxy and its free model. Anything you enter below replaces it.'
            : available
              ? 'Using the key you entered below.'
              : 'No shared demo is deployed, so an API key is required. Any OpenAI-compatible endpoint works.');
      })(),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary sm', onclick: saveEndpoint }, iconEl('check', 14), 'Save'),
        testBtn
      ),
      statusLine
    )
  );

  /* ---- call optimisation ---- */
  root.append(sectionTitle('Call optimisation'));

  const opt = c.optimise;
  root.append(
    h('div', { class: 'card' },
      toggler({
        label: 'Optimise endpoint calls',
        desc: 'Cache, coalesce, and cap requests. Strongly recommended.',
        checked: opt.enabled,
        onChange: (v) => { saveConfig({ optimise: { enabled: v } }); },
      }),
      toggler({
        label: 'Local-first routing',
        desc: 'Handle simple commands (like, refresh, stats) without a request.',
        checked: opt.localFirst,
        onChange: (v) => { saveConfig({ optimise: { localFirst: v } }); },
      }),
      toggler({
        label: 'Batch world events',
        desc: 'One request produces many events instead of one request per event.',
        checked: opt.batchWorldEvents,
        onChange: (v) => { saveConfig({ optimise: { batchWorldEvents: v } }); },
      }),
      h('div', { class: 'field', style: { marginTop: '14px', marginBottom: 0 } },
        h('label', {}, 'Cache window'),
        h('div', { class: 'row-gap' },
          h('input', {
            class: 'input', type: 'range', min: '0', max: '1800', step: '30',
            value: String(opt.cacheSeconds),
            oninput: (e) => {
              const v = Number(e.target.value);
              saveConfig({ optimise: { cacheSeconds: v } });
              e.target.nextElementSibling.textContent = v === 0 ? 'off' : `${v}s`;
            },
          }),
          h('span', { class: 'pill' }, opt.cacheSeconds === 0 ? 'off' : `${opt.cacheSeconds}s`)
        ),
        h('div', { class: 'hint' }, 'Identical prompts inside this window are served from cache.')
      ),
      h('div', { class: 'field', style: { marginBottom: 0 } },
        h('label', {}, 'History compaction threshold'),
        h('div', { class: 'row-gap' },
          h('input', {
            class: 'input', type: 'range', min: '8', max: '60', step: '2',
            value: String(opt.summariseAfter),
            oninput: (e) => {
              const v = Number(e.target.value);
              saveConfig({ optimise: { summariseAfter: v } });
              e.target.nextElementSibling.textContent = `${v} msgs`;
            },
          }),
          h('span', { class: 'pill' }, `${opt.summariseAfter} msgs`)
        ),
        h('div', { class: 'hint' }, 'Long DM threads get summarised to keep prompts small.')
      )
    )
  );

  /* ---- display ---- */
  root.append(sectionTitle('Display'));

  const vp = describeViewport();
  const navSel = h('select', { class: 'select' },
    [
      ['auto', 'Automatic — match screen shape'],
      ['bottom', 'Bottom bar — always horizontal'],
      ['side', 'Side rail — always vertical'],
    ].map(([v, l]) => h('option', { value: v, selected: c.display.nav === v }, l))
  );
  navSel.addEventListener('change', () => {
    saveConfig({ display: { nav: navSel.value } });
    ctx.applyDisplay();
    ctx.toast('Navigation layout updated', 'ok');
  });

  root.append(
    h('div', { class: 'card' },
      h('div', { class: 'hint', style: { marginBottom: '12px' } },
        `Your screen is ${vp.w}×${vp.h} (${vp.shaped}). Navigation is currently ${vp.nav === 'side' ? 'vertical' : 'horizontal'}.`),
      field({
        label: 'Navigation layout',
        hint: 'Automatic puts the bar at the bottom on portrait phones and moves it to a vertical rail in landscape, on desktop, and on an opened foldable.',
        input: navSel,
      }),
      toggler({
        label: 'Reduce motion',
        desc: 'Disable animations and transitions across the app.',
        checked: !!c.display.reduceMotion,
        onChange: (v) => {
          saveConfig({ display: { reduceMotion: v } });
          ctx.applyDisplay();
        },
      })
    )
  );

  /* ---- usage ---- */
  const stats = getStats();
  root.append(sectionTitle('Usage this session'));
  root.append(
    h('div', { class: 'card' },
      h('div', { class: 'stat-grid', style: { marginBottom: '12px' } },
        statBox('Endpoint calls', String(stats.calls), 'requests sent'),
        statBox('Saved calls', String(stats.saved), 'cache + coalesce'),
        statBox('Prompt tokens', fmtNum(stats.promptTokens), 'input'),
        statBox('Cost', fmtCost(stats.cost), stats.failures ? `${stats.failures} failed` : 'no failures')
      ),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn sm', onclick: () => { resetStats(); ctx.refresh(); } },
          iconEl('refresh', 14), 'Reset stats'),
        h('button', {
          class: 'btn sm',
          onclick: () => { clearCache(); ctx.toast('Cache cleared', 'ok'); },
        }, iconEl('trash', 14), 'Clear cache')
      ),
      stats.lastError
        ? h('div', { class: 'hint', style: { color: 'var(--rose)', marginTop: '10px' } }, 'Last error: ' + stats.lastError)
        : null
    )
  );

  /* ---- this world's personas ---- */
  const cast = s.npcs.filter((n) => !n.crowd);
  const crowd = s.npcs.filter((n) => n.crowd);
  root.append(sectionTitle('Personas'));
  root.append(
    h('div', { class: 'card' },
      h('div', { class: 'hint', style: { marginBottom: '12px' } },
        `${plural(cast.length, 'named persona')} live in ${s.meta.name}. They post and message you on their own.`),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn sm primary', onclick: () => ctx.newPersonaSheet() },
          iconEl('plus', 14), 'Add persona'),
        h('button', { class: 'btn sm', onclick: () => ctx.managePersonasSheet() },
          iconEl('users', 14), 'Manage all')
      )
    )
  );

  /* ---- crowd ---- */
  root.append(sectionTitle('Background accounts'));
  root.append(
    h('div', { class: 'card' },
      h('div', { class: 'hint', style: { marginBottom: '12px' } },
        `${plural(crowd.length, 'background account')} exist to make the timeline feel public. They reply with short noise, never start conversations, and never DM you.`),
      h('div', { class: 'btn-row' },
        h('button', {
          class: 'btn sm',
          onclick: async () => {
            ctx.toast('Generating accounts…');
            const n = await ctx.refillCrowd();
            ctx.toast(n ? `Added ${plural(n, 'background account')}` : 'Crowd is already full', 'ok');
            ctx.refresh();
          },
        }, iconEl('plus', 14), 'Add more'),
        h('button', {
          class: 'btn sm',
          onclick: () => { ctx.clearCrowd(); ctx.refresh(); },
        }, iconEl('trash', 14), 'Remove all')
      )
    )
  );

  /* ---- world memory ---- */
  const memStats = memoryStats();
  root.append(sectionTitle('World memory'));
  root.append(
    h('div', { class: 'card' },
      h('div', { class: 'hint', style: { marginBottom: '12px' } },
        memStats.facts
          ? `${plural(memStats.facts, 'thing')} remembered. Characters use these when they react to you, so what you say in one place carries into another.`
          : 'Nothing remembered yet. Chat with someone or post about your life and details will be kept.'),
      memStats.lore
        ? h('div', { class: 'memory-lore' }, h('b', {}, 'Story so far: '), memStats.lore)
        : null,
      memStats.facts
        ? h('button', {
            class: 'btn sm',
            onclick: () => ctx.openMemorySheet(),
          }, iconEl('feed', 14), 'View memory')
        : null,
      h('div', { class: 'btn-row', style: { marginTop: '10px' } },
        h('button', {
          class: 'btn sm',
          onclick: async () => {
            const ok = await ctx.foldMemory();
            ctx.toast(ok ? 'Recap updated' : 'Not enough new events to summarise', ok ? 'ok' : 'info');
            ctx.refresh();
          },
        }, iconEl('refresh', 14), 'Rebuild recap'),
        h('button', {
          class: 'btn sm',
          onclick: () => { ctx.clearMemory(); ctx.toast('Memory cleared', 'ok'); ctx.refresh(); },
        }, iconEl('trash', 14), 'Clear')
      )
    )
  );

  /* ---- world ---- */
  root.append(sectionTitle('This world'));
  const curMeta = getState().meta || {};
  const wIndex = listWorlds().find((w) => w.id === getState().worldId);

  root.append(
    h('div', { class: 'card' },
      h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '14px' } },
        h('div', {
          style: {
            width: '44px', height: '44px', borderRadius: '13px',
            display: 'grid', placeItems: 'center', fontSize: '21px',
            background: wIndex?.accent || 'var(--surface-2)', flex: '0 0 auto',
          },
        }, wIndex?.icon || '🌍'),
        h('div', { style: { minWidth: '0' } },
          h('div', { style: { fontSize: '14.5px', fontWeight: '750' } }, curMeta.name || 'Status'),
          h('div', { class: 'r-sub', style: { whiteSpace: 'normal' } }, curMeta.premise || 'No premise set.')
        )
      ),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn sm primary', onclick: () => ctx.openWorldPicker() },
          iconEl('spark', 14), 'Switch world'),
        h('button', { class: 'btn sm', onclick: () => ctx.newWorldSheet() },
          iconEl('plus', 14), 'New world')
      )
    )
  );

  root.append(sectionTitle('World'));
  const paceSel = h('select', { class: 'select' },
    [['chill', 'Chill — slow ambient activity'],
     ['normal', 'Normal — balanced'],
     ['chaotic', 'Chaotic — constant drama']].map(([v, l]) =>
      h('option', { value: v, selected: c.pace === v }, l))
  );
  paceSel.addEventListener('change', () => {
    saveConfig({ pace: paceSel.value });
    ctx.toast('Pace updated', 'ok');
  });

  root.append(
    h('div', { class: 'card' },
      toggler({
        label: 'NPC autonomy',
        desc: 'Characters post and message you on their own.',
        checked: c.autonomy,
        onChange: (v) => { saveConfig({ autonomy: v }); ctx.toast(v ? 'Autonomy on' : 'Autonomy paused', 'info'); },
      }),
      field({ label: 'World pace', input: paceSel }),
      h('div', { class: 'btn-row' },
        h('button', {
          class: 'btn sm primary',
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            await runAutonomyTick();
            e.currentTarget.disabled = false;
            ctx.toast('World ticked', 'ok');
            ctx.refresh();
          },
        }, iconEl('spark', 14), 'Tick now'),
        h('button', {
          class: 'btn sm',
          onclick: () => { runLocalAmbient(); ctx.toast('Local activity generated', 'ok'); ctx.refresh(); },
        }, iconEl('bolt', 14), 'Local only')
      )
    )
  );

  /* ---- save data ---- */
  root.append(sectionTitle('Save data'));
  root.append(
    h('div', { class: 'card' },
      h('div', { class: 'hint', style: { marginBottom: '12px' } },
        `${plural(s.posts.length, 'post')} · ${plural(s.threads.length, 'thread')} · ${plural(s.npcs.length, 'character')} · ${plural(s.log.length, 'log entry', 'log entries')}`),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn sm', onclick: () => ctx.exportSave() }, iconEl('download', 14), 'Export'),
        h('button', { class: 'btn sm', onclick: () => ctx.importSave() }, iconEl('upload', 14), 'Import'),
        h('button', {
          class: 'btn sm danger',
          onclick: () => ctx.confirmReset(),
        }, iconEl('trash', 14), 'Reset world')
      )
    )
  );

  root.append(
    h('div', { class: 'nodata', style: { paddingTop: '24px' } },
      h('div', {}, 'Status — a local-first social sim.'),
      h('div', { style: { marginTop: '4px' } }, 'Your data never leaves this browser.')
    )
  );

  return root;
}
