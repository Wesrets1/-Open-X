/* ============================================================
   personaViews.js — persona profile + post thread
   ============================================================ */

import {
  h, richText, ago, fmtNum, icons, iconEl, plural,
} from './util.js';
import { avatar, pill, emptyState, sectionTitle, timelinePost } from './components.js';
import {
  getState, commit, getNpc,
} from './db.js';
import { openThreadWith, likePost, replyAsPlayer } from './engine.js';
import { ensureAgent } from './reactions.js';

/* ============================================================
   Persona profile
   ============================================================ */

export function renderNpcProfile(ctx, npcId) {
  const s = getState();
  const npc = getNpc(npcId);
  const root = h('div', { class: 'view-inner' });

  if (!npc) {
    return emptyState({ icon: 'user', title: 'Persona not found', body: 'They may have been removed from this world.' });
  }

  const theirPosts = s.posts.filter((p) => p.authorId === npc.id);
  const agent = ensureAgent(npc);
  const followsYou = (npc.affinity ?? 0) > 0;

  /* banner */
  root.append(
    h('div', { class: 'tw-banner' },
      h('div', { class: 'tw-banner-bg' }),
      h('div', { class: 'tw-banner-avatar' },
        avatar(npc.name, { size: 76 }),
        h('div', { class: 'row-gap' },
          h('button', {
            class: 'btn sm',
            onclick: () => {
              const t = openThreadWith(npc.id);
              if (t) ctx.openThread(t.id);
            },
          }, iconEl('chat', 14), 'Message'),
          h('button', {
            class: 'btn sm',
            'aria-label': 'Edit persona',
            onclick: () => ctx.editPersonaSheet(npc.id),
          }, iconEl('gear', 14))
        )
      )
    )
  );

  /* identity */
  root.append(
    h('div', { class: 'tw-identity' },
      h('div', { class: 'tw-name-row' },
        h('span', { class: 'tw-name' }, npc.name),
        npc.verified ? h('span', { class: 'verified tw-verified', html: icons.verified }) : null
      ),
      h('div', { class: 'tw-handle' }, npc.handle),
      npc.bio ? h('div', { class: 'tw-bio' }, npc.bio) : null,
      h('div', { class: 'tw-meta' },
        iconEl('users', 14),
        `${npc.archetype}${npc.vibe ? ' · ' + npc.vibe : ''}`
      ),
      h('div', { class: 'tw-counts' },
        h('span', {}, h('b', {}, fmtNum(npc.followers || 0)), ' Followers'),
        h('span', {}, h('b', {}, String(theirPosts.length)), ' Posts')
      ),
      h('div', { class: 'row-gap', style: { marginTop: '12px', flexWrap: 'wrap' } },
        pill(
          followsYou ? 'Follows you' : 'Doesn\'t follow you',
          followsYou ? 'good' : ''
        ),
        pill(`feels ${feelingLabel(npc.affinity)}`, affinityVariant(npc.affinity)),
        agent.grudge > 30 ? pill('holds a grudge', 'bad') : null
      )
    )
  );

  /* posts */
  root.append(h('div', { style: { height: '4px' } }));
  if (!theirPosts.length) {
    root.append(emptyState({
      icon: 'feed',
      title: 'No posts yet',
      body: `${npc.name.split(' ')[0]} hasn't posted in this world.`,
    }));
  } else {
    const list = h('div', { class: 'tw-feed-list' });
    for (const p of theirPosts) {
      list.append(timelinePost(p, {
        onLike: () => { likePost(p.id); ctx.refresh(); },
        onReply: () => ctx.openPost(p.id),
        onOpen: () => ctx.openPost(p.id),
      }));
    }
    root.append(list);
  }

  return root;
}

function feelingLabel(aff = 0) {
  if (aff >= 60) return 'devoted';
  if (aff >= 25) return 'warm toward you';
  if (aff >= 5) return 'positive';
  if (aff > -6) return 'neutral';
  if (aff > -25) return 'cool';
  if (aff > -60) return 'hostile';
  return 'openly resentful';
}

function affinityVariant(aff = 0) {
  if (aff >= 25) return 'good';
  if (aff <= -25) return 'bad';
  return '';
}

/* ============================================================
   Post thread
   ============================================================ */

export function renderPostThread(ctx, postId) {
  const s = getState();
  const post = s.posts.find((p) => p.id === postId);
  const root = h('div', { class: 'view-inner' });

  if (!post) {
    return emptyState({ icon: 'feed', title: 'Post not found' });
  }

  const author = post.authorId === 'player'
    ? s.player
    : s.npcs.find((n) => n.id === post.authorId);

  /* main post, expanded */
  root.append(
    h('article', { class: 'thread-main' },
      h('div', { class: 'thread-head' },
        avatar(post.authorName, { size: 46 }),
        h('div', { class: 'thread-who' },
          h('div', { class: 'tp-name', style: { fontSize: '15px' } },
            post.authorName,
            post.verified ? h('span', { class: 'verified tp-verified', html: icons.verified }) : null
          ),
          h('div', { class: 'tp-handle' }, post.authorHandle)
        ),
        author && post.authorId !== 'player'
          ? h('button', {
              class: 'btn xs',
              onclick: () => ctx.openNpcProfile(post.authorId),
            }, 'View profile')
          : null
      ),
      h('div', { class: 'thread-body', html: richText(post.text) }),
      h('div', { class: 'thread-meta' }, ago(post.ts) + ' ago'),
      h('div', { class: 'thread-stats' },
        countStat(post.replies?.length || 0, 'replies'),
        countStat(post.reposts || 0, 'reposts'),
        countStat(post.likes || 0, 'likes')
      )
    )
  );

  /* reply composer */
  const firstName = post.authorName.split(' ')[0];
  const ta = h('textarea', {
    class: 'textarea',
    rows: '2',
    placeholder: `Reply to ${firstName}…`,
    'data-draft': 'thread-reply-' + postId,
  });

  // Which reply the composer is aimed at. null means the root post.
  // Replying to a reply mentions its author, which is what routes the
  // reaction back to that specific character.
  let replyTarget = null;
  const setTarget = (r) => {
    replyTarget = r;
    ta.placeholder = r ? `Reply to ${r.authorName.split(' ')[0]}…` : `Reply to ${firstName}…`;
    banner.textContent = r ? `Replying to ${r.authorName}` : '';
    banner.classList.toggle('hidden', !r);
  };

  const banner = h('div', { class: 'reply-target hidden' });

  const replyBtn = h('button', { class: 'btn primary sm', disabled: true }, 'Reply');
  ta.addEventListener('input', () => { replyBtn.disabled = !ta.value.trim(); });
  replyBtn.addEventListener('click', () => {
    const text = ta.value.trim();
    if (!text) return;
    const target = replyTarget;
    const mention = target ? `@${target.authorHandle.replace(/^@/, '')} ` : '';
    const res = replyAsPlayer(post.id, mention + text);
    if (!res.ok) { ctx.toast(res.error, 'err'); return; }
    ta.value = '';
    replyBtn.disabled = true;
    setTarget(null);
    ctx.toast(target ? `Replied to ${target.authorName}` : 'Reply sent', 'ok');
    ctx.refresh();
  });
  root.append(h('div', { class: 'thread-compose' }, banner, ta, replyBtn));

  /* replies */
  const replies = post.replies || [];
  if (!replies.length) {
    root.append(h('div', { class: 'nodata' }, 'No replies yet.'));
  } else {
    root.append(sectionTitle(plural(replies.length, 'reply', 'replies')));

    for (const r of replies) {
      root.append(
        h('div', { class: 'thread-reply' },
          avatar(r.authorName, { size: 34 }),
          h('div', { class: 'tr-main' },
            h('div', { class: 'tr-head' },
              h('span', { class: 'tp-name' }, r.authorName),
              r.authorId !== 'player'
                ? h('span', {
                    class: 'tp-handle tp-link',
                    onclick: (e) => { e.stopPropagation(); ctx.openNpcProfile(r.authorId); },
                  }, r.authorHandle)
                : h('span', { class: 'tp-handle' }, r.authorHandle),
              h('span', { class: 'tp-dot' }, '·'),
              h('span', { class: 'tp-time' }, ago(r.ts))
            ),
            h('div', { class: 'tr-body' }, r.text),
            h('div', { class: 'tr-actions' },
              h('button', {
                class: 'tr-act',
                'aria-label': `Reply to ${r.authorName}`,
                onclick: (e) => {
                  e.stopPropagation();
                  setTarget(r);
                  ta.focus();
                  ta.scrollIntoView({ block: 'center', behavior: 'smooth' });
                },
              }, iconEl('comment', 13), 'Reply')
            )
          )
        )
      );
    }
  }

  return root;
}

function countStat(n, label) {
  return h('span', { class: 'tstat' },
    h('b', {}, fmtNum(n)),
    ' ' + label
  );
}
