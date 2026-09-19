import { svgEl } from './dom.js';

// 24x24 stroke icons. Paths are static constants.
const PATHS = {
  sun:        ['M12 3v2M12 19v2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M3 12h2M19 12h2M5.6 18.4L7 17M17 7l1.4-1.4', 'circle:12,12,4'],
  moon:       ['M20 13.2A8.2 8.2 0 1 1 10.8 4a6.5 6.5 0 0 0 9.2 9.2z'],
  eye:        ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', 'circle:12,12,2.8'],
  eyeOff:     ['M4 4l16 16', 'M9.9 5.8A9 9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.6 3.4M6.2 7.3A16 16 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 3.8-.8'],
  search:     ['M20.5 20.5l-4.2-4.2', 'circle:11,11,6.5'],
  up:         ['M12 19V6M6 11.5l6-6 6 6'],
  down:       ['M12 5v13M6 12.5l6 6 6-6'],
  chevUp:     ['M7 14l5-5 5 5'],
  chevDown:   ['M7 10l5 5 5-5'],
  plus:       ['M12 5v14M5 12h14'],
  link:       ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  reschedule: ['M4.5 12a7.5 7.5 0 0 1 13-5.1L20 9M20 4.5V9h-4.5M19.5 12a7.5 7.5 0 0 1-13 5.1L4 15M4 19.5V15h4.5'],
  cancel:     ['M6 6l12 12M18 6L6 18'],
  alert:      ['M12 8v5M12 16.5v.5', 'circle:12,12,9'],
};

export function icon(name, { size = 18, cls = '' } = {}) {
  const svg = svgEl('svg', {
    viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
    'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true', focusable: 'false', class: `icon ${cls}`.trim(),
  });
  for (const p of PATHS[name] || []) {
    if (p.startsWith('circle:')) {
      const [cx, cy, r] = p.slice(7).split(',');
      svg.append(svgEl('circle', { cx, cy, r }));
    } else svg.append(svgEl('path', { d: p }));
  }
  return svg;
}
