// Small inline SVG charts. No chart library: these are a few paths and rects,
// so the dashboard loads nothing third-party.

import { svgEl, clear } from './dom.js';

/** Line + soft area, scaled to the series. `values` is an array of numbers. */
export function sparkline(svg, values) {
  clear(svg);
  const W = 120, H = 36, pad = 3;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  if (!values || values.length < 2) return;
  const max = Math.max(...values), min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => [
    (i / (values.length - 1)) * W,
    H - pad - ((v - min) / span) * (H - pad * 2),
  ]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  svg.append(
    svgEl('path', { d: `${line} L${W} ${H} L0 ${H} Z`, class: 'spark-area' }),
    svgEl('path', { d: line, class: 'spark-line', 'vector-effect': 'non-scaling-stroke', fill: 'none' }),
  );
}

/**
 * Grouped bars per month: upcoming (blue), rescued (green), lost (red).
 * `months` = [{label, upcoming, gain, loss, current, title}]. Values are cents; bars share one
 * scale (the biggest value shown). `upcoming` is optional (treated as 0).
 */
export function pairedBars(svg, months) {
  clear(svg);
  const W = 440, H = 230, top = 10, bottom = 26, gap = 3;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const max = Math.max(1, ...months.flatMap((m) => [m.upcoming || 0, m.gain, m.loss]));
  const slot = W / Math.max(months.length, 1);
  const bw = Math.min(18, slot * 0.22);
  const base = H - bottom;
  const groupW = bw * 3 + gap * 2;
  svg.append(svgEl('line', { x1: 0, x2: W, y1: base, y2: base, class: 'axis' }));
  months.forEach((m, i) => {
    const cx = slot * i + slot / 2, x0 = cx - groupW / 2;
    const g = svgEl('g', { class: m.current ? 'bars is-current' : 'bars' });
    g.append(svgEl('title', {}, m.title));
    [['bar-upcoming', m.upcoming || 0], ['bar-gain', m.gain], ['bar-loss', m.loss]].forEach(([cls, v], j) => {
      const hgt = (v / max) * (base - top);
      g.append(svgEl('rect', { x: x0 + j * (bw + gap), y: base - hgt, width: bw, height: Math.max(hgt, v ? 2 : 0), rx: 4, class: cls }));
    });
    g.append(svgEl('text', { x: cx, y: H - 6, 'text-anchor': 'middle', class: 'axis-label' }, m.label));
    svg.append(g);
  });
}

/** Tiny column strip of weekly utilization (0-100+). `cols` = [{pct, current, title}] */
export function utilStrip(svg, cols) {
  clear(svg);
  const W = 100, H = 28, gap = 4;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const bw = (W - gap * (cols.length - 1)) / cols.length;
  cols.forEach((c, i) => {
    const hgt = Math.max(3, (Math.min(c.pct, 100) / 100) * (H - 2));
    const g = svgEl('g', { class: c.current ? 'col is-current' : 'col' });
    g.append(
      svgEl('title', {}, c.title),
      svgEl('rect', { x: i * (bw + gap), y: H - hgt, width: bw, height: hgt, rx: 2 }),
    );
    svg.append(g);
  });
}
