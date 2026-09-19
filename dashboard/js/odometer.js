// Kinetic number ticker. Each digit is a vertical reel (0-9 repeated) that
// slides to its target; on first paint the reels spin a full turn, the leftmost
// digits settling first while the last ones keep ticking. Later updates roll
// from the old digit to the new one.
// Respects prefers-reduced-motion (numbers just appear).

import { h, clear } from './dom.js';

const CYCLES = 3; // 0-9 three times, so a fresh render can spin past a whole turn
const isDigit = (c) => c >= '0' && c <= '9';
const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function reel() {
  const r = h('span', { class: 'reel' });
  for (let i = 0; i < CYCLES * 10; i++) r.append(h('span', { class: 'n' }, String(i % 10)));
  return r;
}

export const Odometer = {
  /**
   * @param {HTMLElement} el     container (kept: it holds the screen-reader text too)
   * @param {{text:string, whole:string, fraction?:string, suffix?:string}} parts  formatted value; `fraction` renders smaller, `suffix` (e.g. %) full size
   * @param {{fresh?:boolean}} [opts]  fresh = rebuild and spin from zero
   */
  set(el, parts, { fresh = false } = {}) {
    const chars = [...parts.whole].map((c) => ({ c, minor: false }))
      .concat([...(parts.fraction || '')].map((c) => ({ c, minor: true })))
      .concat([...(parts.suffix || '')].map((c) => ({ c, minor: false })));
    const sig = chars.map((x) => (isDigit(x.c) ? '#' : x.c) + (x.minor ? '~' : '')).join('');

    let vis = el.querySelector(':scope > .odo');
    let sr = el.querySelector(':scope > .sr-only');
    if (!vis) {
      clear(el);
      vis = h('span', { class: 'odo', 'aria-hidden': 'true' });
      sr = h('span', { class: 'sr-only' });
      el.append(vis, sr);
    }
    sr.textContent = parts.text;

    if (fresh || vis.dataset.sig !== sig) {
      clear(vis);
      vis.dataset.sig = sig;
      for (const { c, minor } of chars) {
        vis.append(isDigit(c)
          ? h('span', { class: `d${minor ? ' minor' : ''}` }, reel())
          : h('span', { class: `sep${minor ? ' minor' : ''}` }, c));
      }
      vis.querySelectorAll('.reel').forEach((r) => r.style.setProperty('--p', 0)); // start at 0, no transition yet
      void vis.offsetWidth; // commit the starting position before animating
    }

    const targets = chars.filter((x) => isDigit(x.c)).map((x) => Number(x.c));
    const reels = vis.querySelectorAll('.reel');
    const quick = reduced();
    reels.forEach((r, i) => {
      r.style.transitionDuration = quick ? '0ms' : `${950 + Math.min(i, 6) * 120}ms`;
      r.style.setProperty('--p', 10 + targets[i]);
    });
  },

  /** For "no data" states: plain text, no reels. */
  plain(el, text) {
    clear(el);
    el.append(h('span', { class: 'odo-plain' }, text));
  },
};
