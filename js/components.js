/* ============================================================
   components.js — reusable UI pieces
   ============================================================ */

import {
  h, esc, richText, avatarGradient, initials, ago, fmtNum, icons, iconEl, clockTime,
} from './util.js';

export function avatar(name, { size = 44, ring = false, online = false, src = null } = {}) {
  const el = h('div', {
    class: 'avatar' + (ring ? ' ring' : ''),
    style: { '--sz': size + 'px', background: avatarGradient(name) },
    'aria-hidden': 'true',
  });
  if (src) {
    const img = h('img', { src, alt: '' });
    img.onerror = () => { img.remove(); el.textContent = initials(name); };
    el.append(img);
  } else {
    el.textContent = initials(name);
  }
  if (online) el.append(h('span', { class: 'online' }));
  return el;
}

export function pill(text, variant = '') {
  return h('span', { class: 'pill' + (variant ? ' ' + variant : '') }, text);
}

export function meter({ label, value, max = 100, fill = 'fill-violet', icon = null, display = null }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return h('div', { class: 'meter' },
    h('div', { class: 'meter-top' },
      h('div', { class: 'meter-label' }, icon ? iconEl(icon, 14) : null, label),
      h('div', { class: 'meter-val' }, display ?? `${Math.round(value)}%`)
    ),
    h('div', { class: 'meter-track' },
      h('div', { class: 'meter-fill ' + fill, style: { width: pct + '%' } })
    )
  );
}

export function statBox(k, v, d = '') {
  return h('div', { class: 'stat-box' },
    h('div', { class: 'sb-k' }, k),
    h('div', { class: 'sb-v' }, v),
    d ? h('div', { class: 'sb-d' }, d) : null
  );
}

export function toggler({ label, desc, checked, onChange }) {
  const el = h('div', { class: 'toggle' },
    h('div', {},
      h('div', { class: 't-label' }, label),
      desc ? h('div', { class: 't-desc' }, desc) : null
    ),
    h('button', {
      class: 'switch',
      role: 'switch',
      'aria-checked': String(!!checked),
      'aria-label': label,
      onclick: () => {
        const next = el.querySelector('.switch').getAttribute('aria-checked') !== 'true';
        el.querySelector('.switch').setAttribute('aria-checked', String(next));
        onChange(next);
      },
    })
  );
  return el;
}

export function field({ label, hint, input }) {
  return h('div', { class: 'field' },
    h('label', {}, label),
    input,
    hint ? h('div', { class: 'hint' }, hint) : null
  );
}

export function emptyState({ icon = 'spark', title, body, action = null }) {
  return h('div', { class: 'empty' },
    h('div', { class: 'ico' }, iconEl(icon, 28)),
    h('h3', {}, title),
    body ? h('p', {}, body) : null,
    action
  );
}

export function sectionTitle(text) {
  return h('div', { class: 'section-title' }, text);
}

export function skeletonPost() {
  return h('div', { class: 'card' },
    h('div', { class: 'row-gap' },
      h('div', { class: 'skel', style: { width: '44px', height: '44px', borderRadius: '50%' } }),
      h('div', { style: { flex: '1' } },
        h('div', { class: 'skel', style: { width: '42%', height: '11px', marginBottom: '7px' } }),
        h('div', { class: 'skel', style: { width: '26%', height: '9px' } })
      )
    ),
    h('div', { class: 'skel', style: { height: '10px', marginTop: '14px', width: '94%' } }),
    h('div', { class: 'skel', style: { height: '10px', marginTop: '7px', width: '72%' } })
  );
}

export function logEntry(entry) {
  const iconMap = {
    post: 'feed', tool: 'bolt', llm: 'spark', dm: 'chat', like: 'heart', reply: 'comment',
  };
  const levelClass = entry.level === 'warn' ? 'fill-amber' : entry.level === 'error' ? 'fill-rose' : '';
  return h('div', { class: 'log-entry' },
    h('div', { class: 'le-ico' }, iconEl(iconMap[entry.kind] || 'spark', 13)),
    h('div', { class: 'le-main' },
      h('div', { class: 'le-t' }, entry.title),
      entry.detail ? h('div', { class: 'le-d' }, entry.detail) : null
    ),
    entry.ms != null ? h('div', { class: 'le-cost' }, entry.ms + 'ms') : null
  );
}

/* ============================================================
   Timeline post — flat, Twitter-style
   ============================================================ */

export function timelinePost(post, handlers = {}) {
  const { onLike, onReply, onOpen, onAuthor } = handlers;

  return h('article', {
    class: 'timeline-post',
    dataset: { id: post.id },
    onclick: onOpen ? () => onOpen(post) : null,
  },
    h('div', { class: 'tp-avatar' }, avatar(post.authorName, { size: 42 })),
    h('div', { class: 'tp-main' },
      h('div', { class: 'tp-head' },
        h('span', {
          class: 'tp-name' + (onAuthor ? ' tp-link' : ''),
          onclick: onAuthor
            ? (e) => { e.stopPropagation(); onAuthor(post.authorId); }
            : null,
        }, post.authorName),
        post.verified ? h('span', { class: 'tp-verified', html: icons.verified }) : null,
        h('span', {
          class: 'tp-handle' + (onAuthor ? ' tp-link' : ''),
          onclick: onAuthor
            ? (e) => { e.stopPropagation(); onAuthor(post.authorId); }
            : null,
        }, post.authorHandle),
        h('span', { class: 'tp-dot' }, '·'),
        h('span', { class: 'tp-time' }, ago(post.ts))
      ),
      h('div', { class: 'tp-body', html: richText(post.text) }),
      post.replies?.length
        ? h('div', { class: 'tp-replies' },
            post.replies.slice(-2).map((r) =>
              h('div', { class: 'tp-reply' },
                avatar(r.authorName, { size: 22 }),
                h('span', {},
                  h('b', {}, r.authorName.split(' ')[0]),
                  ' ',
                  r.text
                )
              )
            )
          )
        : null,
      h('div', { class: 'tp-actions' },
        h('button', {
          class: 'tp-act',
          onclick: (e) => { e.stopPropagation(); onReply?.(post); },
        }, iconEl('comment', 15), fmtNum(post.replies?.length || 0)),
        h('button', {
          class: 'tp-act',
          onclick: (e) => e.stopPropagation(),
        }, iconEl('repeat', 15), fmtNum(post.reposts || 0)),
        h('button', {
          class: 'tp-act' + (post.likedByPlayer ? ' liked' : ''),
          onclick: (e) => { e.stopPropagation(); onLike?.(post); },
        }, iconEl('heart', 15), fmtNum(post.likes || 0)),
        h('button', {
          class: 'tp-act',
          onclick: (e) => e.stopPropagation(),
        }, iconEl('eye', 15), fmtNum((post.likes || 0) * 4))
      )
    )
  );
}

/* ============================================================
   Post card (legacy card look, kept for compact contexts)
   ============================================================ */

export function postCard(post, handlers = {}) {
  const {
    onLike, onReply, onOpen, showAuthor = true, compact = false,
  } = handlers;

  const el = h('article', { class: 'post', dataset: { id: post.id } });

  if (showAuthor) {
    el.append(
      h('div', { class: 'post-head' },
        avatar(post.authorName, { size: 40 }),
        h('div', { class: 'meta' },
          h('div', { class: 'name' },
            post.authorName,
            post.verified ? h('span', { class: 'verified', html: icons.verified }) : null
          ),
          h('div', { class: 'handle' }, `${post.authorHandle} · ${ago(post.ts)}`)
        )
      )
    );
  }

  el.append(h('div', { class: 'post-body', html: richText(post.text) }));

  el.append(
    h('div', { class: 'post-stats' },
      h('div', { class: 'stat' }, iconEl('heart', 13), fmtNum(post.likes || 0)),
      h('div', { class: 'stat' }, iconEl('comment', 13), fmtNum(post.replies?.length || 0)),
      h('div', { class: 'stat' }, iconEl('repeat', 13), fmtNum(post.reposts || 0)),
      h('div', { class: 'stat' }, iconEl('eye', 13), fmtNum((post.likes || 0) * 4))
    )
  );

  if (post.replies?.length && !compact) {
    for (const r of post.replies.slice(-3)) {
      const isSelf = r.mine || r.authorId === 'player';
      el.append(
        h('div', { class: 'reply' },
          avatar(r.authorName, { size: 26 }),
          h('div', {},
            h('div', { class: 'r-name' },
              r.authorName,
              isSelf && r.authorName !== 'You' ? h('span', { class: 'muted' }, ' (you)') : null
            ),
            h('div', { class: 'r-body' }, r.text)
          )
        )
      );
    }
  }

  const actions = h('div', { class: 'post-actions' });
  if (onLike) {
    actions.append(h('button', {
      class: 'act hot',
      onclick: (e) => { e.stopPropagation(); onLike(post, e.currentTarget); },
      disabled: post.likedByPlayer,
    }, iconEl('heart', 13), post.likedByPlayer ? 'Liked' : 'Like'));
  }
  if (onReply) {
    actions.append(h('button', {
      class: 'act',
      onclick: (e) => { e.stopPropagation(); onReply(post); },
    }, iconEl('comment', 13), 'Reply'));
  }
  if (onOpen) {
    actions.append(h('button', {
      class: 'act accent',
      onclick: (e) => { e.stopPropagation(); onOpen(post); },
    }, iconEl('wand', 13), 'React'));
  }
  if (actions.childElementCount) el.append(actions);

  return el;
}

/* ============================================================
   Bubble
   ============================================================ */

export function bubble({ text, mine = false, name = '', ts = null, same = false }) {
  return h('div', { class: 'bubble-row ' + (mine ? 'me' : 'them') + (same ? ' same' : '') },
    h('div', { class: 'bubble' }, text),
    ts ? h('span', { class: 'bubble-time' }, clockTime(ts)) : null
  );
}

export function typingBubble(name = '') {
  return h('div', { class: 'bubble-row them' },
    h('div', { class: 'bubble' },
      h('span', { class: 'typing' }, h('span'), h('span'), h('span'))
    )
  );
}
