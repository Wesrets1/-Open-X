/* debug.js — opt-in tracing.
   Enable with:  localStorage.setItem('status.debug','1')  */

import { store } from './util.js';

let enabled = store.get('status.debug', false) === true;

export function setDebug(on) {
  enabled = !!on;
  store.set('status.debug', enabled);
}

export function isDebug() {
  return enabled;
}

export function dbg(...args) {
  if (!enabled) return;
  console.log('%c[status]', 'color:#a78bfa;font-weight:700', ...args);
}

export function warn(...args) {
  console.warn('%c[status]', 'color:#fbbf24;font-weight:700', ...args);
}
