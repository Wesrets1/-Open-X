/* ============================================================
   util.js — DOM, formatting, randomness, small helpers
   ============================================================ */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, String(sv));
        else el.style[sk] = sv;
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

/** Append children, skipping null/undefined/false. */
export function append(el, ...children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Escape, then linkify @handles and #tags. */
export function richText(s) {
  return esc(s)
    .replace(/(^|\s)(@[a-z0-9_]{2,24})/gi, '$1<span class="tag">$2</span>')
    .replace(/(^|\s)(#[a-z0-9_]{2,30})/gi, '$1<span class="tag">$2</span>')
    .replace(/\n/g, '<br>');
}

/* ---------- ids ---------- */
let _seq = 0;
export const uid = (p = 'id') =>
  `${p}_${Date.now().toString(36)}${(_seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/* ---------- randomness ---------- */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const rng = {
  float: (min = 0, max = 1) => min + Math.random() * (max - min),
  int: (min, max) => Math.floor(min + Math.random() * (max - min + 1)),
  pick: (arr) => arr[Math.floor(Math.random() * arr.length)],
  picks: (arr, n) => {
    const copy = [...arr];
    const out = [];
    while (out.length < n && copy.length) out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
    return out;
  },
  chance: (p) => Math.random() < p,
  shuffle: (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },
};

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const lerp = (a, b, t) => a + (b - a) * t;

/* ---------- numbers / time ---------- */
export function fmtNum(n) {
  n = Number(n) || 0;
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '') + 'K';
  if (n < 1e9) return (n / 1e6).toFixed(n < 1e7 ? 1 : 0).replace(/\.0$/, '') + 'M';
  return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
}

export function fmtCost(n) {
  const v = Number(n) || 0;
  if (v === 0) return '$0.0000';
  if (v < 0.0001) return '<$0.0001';
  return '$' + v.toFixed(v < 1 ? 4 : 2);
}

export function ago(ts) {
  const d = Date.now() - new Date(ts).getTime();
  const s = Math.floor(d / 1000);
  if (s < 45) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr}h`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days}d`;
  const w = Math.floor(days / 7);
  if (w < 5) return `${w}w`;
  return `${Math.floor(days / 30)}mo`;
}

export function clockTime(ts = Date.now()) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function dayStamp(ts = Date.now()) {
  return new Date(ts).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function debounce(fn, ms = 250) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function throttle(fn, ms = 120) {
  let last = 0, timer;
  return (...a) => {
    const now = Date.now();
    const wait = ms - (now - last);
    if (wait <= 0) {
      last = now;
      fn(...a);
    } else {
      clearTimeout(timer);
      timer = setTimeout(() => { last = Date.now(); fn(...a); }, wait);
    }
  };
}

/* ---------- text ---------- */
export const initials = (name = '') =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';

export const truncate = (s, n = 100) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

/** "1 post" / "3 posts" — avoids the "1 posts" bug. */
export const plural = (n, one, many = null) =>
  `${n} ${Number(n) === 1 ? one : (many || one + 's')}`;

export const titleCase = (s) => String(s).replace(/\b\w/g, (c) => c.toUpperCase());

export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20);

/** Deterministic hue from a string, for avatars. */
export function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

export function avatarGradient(name) {
  const hue = hashHue(name || '?');
  const h2 = (hue + 62) % 360;
  return `linear-gradient(135deg, hsl(${hue} 72% 66%), hsl(${h2} 74% 60%))`;
}

/* ---------- arrays ---------- */
export const sum = (arr, f = (x) => x) => arr.reduce((a, b) => a + f(b), 0);
export const avg = (arr, f = (x) => x) => (arr.length ? sum(arr, f) / arr.length : 0);
export const uniq = (arr) => [...new Set(arr)];
export function groupBy(arr, f) {
  const m = new Map();
  for (const x of arr) {
    const k = f(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}
export const byNewest = (arr, key = 'ts') =>
  [...arr].sort((a, b) => new Date(b[key]) - new Date(a[key]));

/* ---------- storage ---------- */
export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { console.warn('storage write failed', e); return false; }
  },
  del(key) { try { localStorage.removeItem(key); } catch {} },
  keys() { try { return Object.keys(localStorage); } catch { return []; } },
  usage() {
    let bytes = 0;
    for (const k of this.keys()) {
      try { bytes += (localStorage.getItem(k) || '').length * 2; } catch {}
    }
    return bytes;
  },
};

/* ---------- icons ---------- */
const P = (d, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;

export const icons = {
  home: P('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>'),
  feed: P('<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 8h8M8 12h8M8 16h5"/>'),
  chat: P('<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.8 9.8 0 0 1-3-.5L4 21l1.6-4a8.3 8.3 0 0 1-1.6-5A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5Z"/>'),
  user: P('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5S20 17 20 21"/>'),
  gear: P('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.6a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4Z"/>'),
  heart: P('<path d="M12 20.5 4.7 13a5 5 0 0 1 7.3-6.8l.1.1.1-.1A5 5 0 0 1 19.3 13Z"/>'),
  comment: P('<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.8 9.8 0 0 1-3-.5L4 21l1.6-4a8.3 8.3 0 0 1-1.6-5A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5Z"/>'),
  repeat: P('<path d="m17 2 4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
  send: P('<path d="m22 2-7 20-4-9-9-4Z"/>'),
  plus: P('<path d="M12 5v14M5 12h14"/>'),
  x: P('<path d="M18 6 6 18M6 6l12 12"/>'),
  check: P('<path d="M20 6 9 17l-5-5"/>'),
  spark: P('<path d="m12 3 1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9Z"/><path d="M18 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9Z"/>'),
  bolt: P('<path d="M13 2 4 14h6l-1 8 9-12h-6Z"/>'),
  trash: P('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>'),
  refresh: P('<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>'),
  verified: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 2.1 3.2-.3.9 3.1 2.8 1.6-1.3 2.9 1.3 2.9-2.8 1.6-.9 3.1-3.2-.3L12 22l-2.4-2.1-3.2.3-.9-3.1L2.7 15l1.3-2.9L2.7 9.2l2.8-1.6.9-3.1 3.2.3Z" opacity=".22"/><path d="m8.5 12 2.4 2.4 4.6-4.8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  clock: P('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  energy: P('<path d="M13 2 4 14h6l-1 8 9-12h-6Z"/>'),
  money: P('<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5h4a1.7 1.7 0 0 1 0 3.4h-3a1.7 1.7 0 0 0 0 3.4h4"/>'),
  star: P('<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9Z"/>'),
  users: P('<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.2 2.7-5.2 6-5.2s6 2 6 5.2"/><path d="M16 5.2a3.2 3.2 0 0 1 0 6.1"/><path d="M18 14.8c2 .5 3.4 2.2 3.4 4.6"/>'),
  trend: P('<path d="m3 17 6-6 4 4 7-7"/><path d="M14 8h6v6"/>'),
  image: P('<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="m4 18 5-5 4 4 3-2.5 4 3.5"/>'),
  lock: P('<rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>'),
  key: P('<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8 3 3-2 2-2-2-3 3"/>'),
  download: P('<path d="M12 3v12M7 11l5 5 5-5"/><path d="M4 21h16"/>'),
  upload: P('<path d="M12 21V9M7 13l5-5 5 5"/><path d="M4 3h16"/>'),
  eye: P('<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.8"/>'),
  warning: P('<path d="M12 3 2.5 20h19Z"/><path d="M12 9v5M12 17.2v.2"/>'),
  chevron: P('<path d="m9 5 7 7-7 7"/>'),
  back: P('<path d="m15 5-7 7 7 7"/>'),
  wand: P('<path d="M15 4V2M15 10V8M11.5 6.5h2M17.5 6.5h2"/><path d="m3 21 9-9"/><path d="m12.5 8.5 3 3"/>'),
  dice: P('<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.5" cy="8.5" r="1.3" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/>'),
};

export const icon = (name, cls = '') =>
  `<span class="${cls}" style="display:contents">${icons[name] || icons.spark}</span>`;

/** Turn an icon string into an element safe to append. */
export function iconEl(name, size = 18) {
  const wrap = document.createElement('span');
  wrap.style.display = 'contents';
  wrap.innerHTML = icons[name] || icons.spark;
  const svg = wrap.firstElementChild;
  if (svg) {
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
  }
  return wrap;
}
