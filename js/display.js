/* ============================================================
   display.js — layout adaptation

   Rules, in order of precedence:
     1. The app always fills the screen. There is no frame, no
        scaling, and no density mode.
     2. Navigation orientation comes from the viewport shape:
        - portrait phone                → bottom bar
        - landscape / desktop / tablet  → side rail
        - squarish (opened foldable)    → side rail
     3. An explicit choice in Settings wins over detection.
   ============================================================ */

import { getConfig } from './config.js';

/** At or below this width, treat the viewport as a phone. */
const PHONE_MAX_W = 640;

/** At or above this width/height ratio, treat it as squarish or wider. */
const SQUARISH_RATIO = 0.9;

/**
 * Decide nav orientation for the current viewport.
 * @returns {'bottom'|'side'}
 */
export function resolveNavMode(cfg = getConfig()) {
  const mode = cfg.display?.nav || 'auto';
  if (mode === 'bottom' || mode === 'side') return mode;

  const w = window.innerWidth;
  const h = window.innerHeight;
  const ratio = w / Math.max(1, h);

  // Portrait phone: bottom bar.
  if (w <= PHONE_MAX_W && ratio < SQUARISH_RATIO) return 'bottom';

  // Landscape, desktop, tablet, unfolded foldable, squarish: side rail.
  if (ratio >= SQUARISH_RATIO) return 'side';

  // Portrait tablet — bottom bar reads better.
  return 'bottom';
}

/** Push display state into the DOM. Idempotent and cheap. */
export function applyDisplay() {
  const cfg = getConfig();
  const root = document.documentElement;
  const device = document.getElementById('device');
  if (!device) return { nav: 'bottom' };

  const nav = resolveNavMode(cfg);

  device.dataset.nav = nav;
  root.classList.toggle('reduce-motion', !!cfg.display?.reduceMotion);

  return { nav };
}

/** Watch for viewport changes that could change the nav orientation. */
export function watchViewport(handler) {
  let raf = null;
  const run = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      raf = null;
      handler(resolveNavMode());
    });
  };

  window.addEventListener('resize', run, { passive: true });
  window.addEventListener('orientationchange', run, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', run, { passive: true });
  }

  return () => {
    window.removeEventListener('resize', run);
    window.removeEventListener('orientationchange', run);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', run);
  };
}

/** Human-readable summary for the settings panel. */
export function describeViewport() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const ratio = Number((w / Math.max(1, h)).toFixed(2));
  const shaped =
    w <= PHONE_MAX_W && ratio < SQUARISH_RATIO ? 'phone'
      : ratio >= 1.35 ? 'landscape'
        : ratio >= SQUARISH_RATIO ? 'squarish'
          : 'portrait';
  return { w, h, ratio, shaped, nav: resolveNavMode() };
}
