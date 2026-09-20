// ROL Command Center — dashboard controller.
// Plain ES modules, no framework. Data comes only from the ledger-read function.

import * as api from './api.js';
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { Odometer } from './odometer.js';
import { sparkline, pairedBars, utilStrip } from './charts.js';
import {
  money, moneyParts, int, pct, addDays, addMonths, dateOnly, todayIn, mondayOf, monthStartOf,
  monthLabel, monthShort, dayLabel, shortDay, appointmentLabel, dateInTz, fullStamp, clockTime,
  relTime, formatPhone, maskPhone, maskEmail, normalize, digitsOf, changePct,
} from './format.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const POLL_MS = 30000;
const CLIENT_PAGE = 10;

const state = {
  tenants: [], tenant: null, gen: 0,
  range: 30, today: '',
  data: { perf: null, churn: null, capacity: null, ltv: null, activity: null },
  ui: { churnMonth: null, capWeeks: 1, filter: 'all', search: '', sort: { key: 'ltv_cents', dir: 'desc' }, shown: CLIENT_PAGE, revealed: new Set() },
  seen: new Set(), primed: false,
  pollTimer: null, tickTimer: null, lastOk: 0,
};

// One entry per ledger view. `cards` are the elements that show its data.
const SOURCES = {
  perf:     { view: 'v_daily_performance', cards: ['kpi-revenue', 'kpi-bookings'],            opts: () => ({ from: addDays(state.today, -(2 * state.range - 1)), limit: 400 }) },
  churn: { view: 'v_churn_deflection', cards: ['kpi-rescued', 'kpi-rate', 'card-churn'], opts: () => ({ to: addMonths(monthStartOf(state.today), 3), limit: 12 }) },
  capacity: { view: 'v_artist_capacity', cards: ['card-capacity'], opts: () => ({ from: addDays(mondayOf(state.today), -7), to: addDays(mondayOf(state.today), 35), limit: 60 }) },
  ltv:      { view: 'v_customer_ltv',      cards: ['card-clients'],                           opts: () => ({ limit: 1000 }) },
  activity: { view: 'v_recent_activity',   cards: ['card-feed'],                              opts: () => ({ limit: 50 }) },
};
const RENDERERS = { perf: renderPerf, churn: renderChurn, capacity: renderCapacity, ltv: renderClients, activity: renderFeed };

const tz = () => (state.tenant && state.tenant.timezone) || 'America/New_York';
const cur = () => (state.tenant && state.tenant.currency) || 'USD';
const num = (v) => Number(v) || 0;

// ───────────────────────── card states & error boundary ─────────────────────────

function setState(id, st, message) {
  const el = document.getElementById(id);
  if (!el) return;
  el.dataset.state = st;
  el.setAttribute('aria-busy', String(st === 'loading'));
  if (st === 'error') { const m = $('.err-msg', el); if (m) m.textContent = message || ''; }
}

function setLive(status, text) {
  const el = $('#live-status');
  el.dataset.state = status;
  $('.live-text', el).textContent = text;
}

async function loadSource(key, { loading = false, keep = false, fresh = false } = {}) {
  const src = SOURCES[key];
  const gen = state.gen;
  state.today = todayIn(tz());
  if (loading) src.cards.forEach((id) => setState(id, 'loading'));
  try {
    const res = await api.read(state.tenant.slug, src.view, src.opts());
    if (gen !== state.gen) return false;              // tenant changed mid-flight: drop the stale answer
    state.data[key] = res.rows;
    render(key, { fresh });
    return true;
  } catch (err) {
    if (gen !== state.gen || err.code === 'unauthorized') return false;
    console.error(`load ${key} failed:`, err.code || err);
    if (!(keep && state.data[key])) src.cards.forEach((id) => setState(id, 'error', api.friendly(err)));
    return false;
  }
}

function render(key, opts) {
  const src = SOURCES[key];
  // Cards must be visible BEFORE the tickers are set, or their roll-in can't animate.
  src.cards.forEach((id) => setState(id, 'ready'));
  try {
    RENDERERS[key](opts || {});
  } catch (err) {
    console.error(`render ${key} failed:`, err);
    src.cards.forEach((id) => setState(id, 'error', 'Something went wrong showing this card.'));
  }
}

// ───────────────────────── KPI helpers ─────────────────────────

function setDelta(el, d) {
  clear(el);
  el.className = `delta ${d.dir}`;
  if (d.dir === 'up') el.append(icon('up', { size: 14 }));
  if (d.dir === 'down') el.append(icon('down', { size: 14 }));
  el.append(d.text);
}

function pctDelta(p) {
  if (p == null) return { dir: 'none', text: 'No prior data' };
  if (Math.abs(p) < 0.05) return { dir: 'flat', text: '0.0%' };
  return p > 0 ? { dir: 'up', text: `+${p.toFixed(1)}%` } : { dir: 'down', text: `−${Math.abs(p).toFixed(1)}%` };
}

function setKpi(id, { value, plain, period, delta, vs, extra, spark, fresh }) {
  const el = document.getElementById(id);
  $('[data-role="period"]', el).textContent = period;
  const v = $('[data-role="value"]', el);
  if (plain != null) Odometer.plain(v, plain); else Odometer.set(v, value, { fresh });
  setDelta($('[data-role="delta"]', el), delta);
  $('[data-role="note"]', el).textContent = delta.dir === 'none' ? '' : vs;
  $('[data-role="extra"]', el).textContent = extra || '';
  sparkline($('[data-role="spark"]', el), spark);
}

const countParts = (n) => ({ text: int(n), whole: int(n) });

// ───────────────────────── renderers ─────────────────────────

function renderPerf({ fresh }) {
  const rows = state.data.perf || [];
  const N = state.range, today = state.today;
  const from0 = addDays(today, -(N - 1)), prevFrom = addDays(today, -(2 * N - 1)), prevTo = addDays(today, -N);
  const byDay = new Map(rows.map((r) => [dateOnly(r.day), r]));
  const sum = (a, b, f) => { let t = 0; for (const [d, r] of byDay) if (d >= a && d <= b) t += num(r[f]); return t; };
  const after = addDays(today, 1), far = '9999-12-31';
  const series = (f) => Array.from({ length: N }, (_, i) => num((byDay.get(addDays(from0, i)) || {})[f]));

  const rev = sum(from0, today, 'booked_revenue_cents'), prevRev = sum(prevFrom, prevTo, 'booked_revenue_cents');
  const bk = sum(from0, today, 'bookings_active');
  const upRev = sum(after, far, 'booked_revenue_cents'), upBk = sum(after, far, 'bookings_active');
  const cancelled = sum(from0, today, 'bookings_cancelled');
  const revChange = pctDelta(changePct(rev, prevRev));

  // Hero = the forward pipeline (tomorrow onward). The lookback window moves to the footnote and sparkline.
  setKpi('kpi-revenue', {
    value: moneyParts(upRev, cur()), period: 'Upcoming pipeline', fresh,
    delta: { dir: 'none', text: `${int(upBk)} booked` }, vs: '',
    extra: `${money(rev, cur())} booked in the last ${N} days${revChange.dir === 'none' ? '' : ` (${revChange.text} vs prior)`}`,
    spark: series('booked_revenue_cents'),
  });
  setKpi('kpi-bookings', {
    value: countParts(upBk), period: 'Upcoming pipeline', fresh,
    delta: { dir: 'none', text: '' }, vs: '',
    extra: `${int(bk)} booked in the last ${N} days · ${int(cancelled)} cancelled`,
    spark: series('bookings_active'),
  });
  ['kpi-revenue', 'kpi-bookings'].forEach((id) => document.getElementById(id).classList.add('is-pipeline'));
}

function churnRows() {
  const map = new Map((state.data.churn || []).map((r) => [dateOnly(r.month_start), r]));
  const thisMonth = monthStartOf(state.today);
  return { map, thisMonth };
}

// Panel chart range: 3 months back through 2 months ahead. (The two KPI sparklines stay on the
// trailing 6 months so they don't drop to $0 for months that haven't happened yet.)
const churnRange = (thisMonth) => Array.from({ length: 6 }, (_, i) => addMonths(thisMonth, i - 3));

function renderChurn({ fresh }) {
  const { map, thisMonth } = churnRows();
  const last = addMonths(thisMonth, -1);
  const row = (m) => map.get(m) || {};
  const months6 = Array.from({ length: 6 }, (_, i) => addMonths(thisMonth, i - 5)); // trailing: KPI sparklines only
  const monthsRange = churnRange(thisMonth);                                        // panel chart: past + future

  // KPI: rescued revenue (this calendar month)
  const saved = num(row(thisMonth).revenue_saved_cents), savedPrev = num(row(last).revenue_saved_cents);
  setKpi('kpi-rescued', {
    value: moneyParts(saved, cur()), period: 'This month', fresh,
    delta: pctDelta(changePct(saved, savedPrev)), vs: 'vs last month',
    extra: `${int(num(row(thisMonth).deflected_count))} appointment${num(row(thisMonth).deflected_count) === 1 ? '' : 's'} kept`,
    spark: months6.map((m) => num(row(m).revenue_saved_cents)),
  });

  // KPI: deflection rate
  const rate = row(thisMonth).deflection_rate_pct, ratePrev = row(last).deflection_rate_pct;
  const hasRate = rate !== null && rate !== undefined;
  const pts = hasRate && ratePrev != null ? num(rate) - num(ratePrev) : null;
  const ptsDelta = pts == null ? { dir: 'none', text: 'No prior data' }
    : Math.abs(pts) < 0.05 ? { dir: 'flat', text: '0.0 pts' }
    : { dir: pts > 0 ? 'up' : 'down', text: `${pts > 0 ? '+' : '−'}${Math.abs(pts).toFixed(1)} pts` };
  setKpi('kpi-rate', {
    value: { text: pct(rate), whole: num(rate).toFixed(1), suffix: '%' }, plain: hasRate ? null : '—',
    period: 'This month', fresh, delta: ptsDelta, vs: 'vs last month',
    extra: hasRate ? `${int(num(row(thisMonth).deflected_count))} rescheduled, ${int(num(row(thisMonth).cancelled_count))} cancelled` : 'No reschedules or cancellations yet',
    spark: months6.map((m) => num(row(m).deflection_rate_pct)),
  });

  // Panel: month selector (history, this month, and at most two months ahead)
  const latest = addMonths(thisMonth, 2);
  const avail = [...new Set([thisMonth, ...map.keys()])].filter((m) => m <= latest).sort().reverse();
  if (!state.ui.churnMonth || !avail.includes(state.ui.churnMonth)) state.ui.churnMonth = thisMonth;
  const sel = $('#churn-month');
  clear(sel);
  avail.forEach((m) => sel.append(h('option', { value: m, selected: m === state.ui.churnMonth ? true : null }, monthLabel(m))));
  paintChurnPanel(monthsRange);
}

function paintChurnPanel(monthsRange) {
  const { map, thisMonth } = churnRows();
  const m = state.ui.churnMonth;
  const r = map.get(m) || {};
  const upcoming = num(r.upcoming_revenue_cents), upcomingCount = num(r.upcoming_count);
  const rescued = num(r.revenue_saved_cents), lost = num(r.revenue_lost_cents);
  const kept = num(r.deflected_count), cancelled = num(r.cancelled_count), intents = num(r.cancel_intents);
  const idle = Math.max(0, intents - kept - cancelled);
  const card = document.getElementById('card-churn');
  const q = (role) => $(`[data-role="${role}"]`, card);

  q('sub').textContent = m > thisMonth
    ? `${monthLabel(m)} hasn't started yet. This shows what's already booked.`
    : r.deflection_rate_pct != null
      ? `${pct(r.deflection_rate_pct)} of people who moved or cancelled an appointment in ${monthLabel(m)} chose to reschedule.`
      : `No reschedules or cancellations recorded in ${monthLabel(m)}.`;
  q('upcoming').textContent = money(upcoming, cur());
  q('upcoming-note').textContent = `${int(upcomingCount)} appointment${upcomingCount === 1 ? '' : 's'} still to come`;
  q('rescued').textContent = money(rescued, cur());
  q('lost').textContent = money(lost, cur());
  q('rescued-note').textContent = `${int(kept)} appointment${kept === 1 ? '' : 's'} moved instead of cancelled`;
  q('lost-note').textContent = `${int(cancelled)} cancellation${cancelled === 1 ? '' : 's'}`;

  // Flow bar + legend
  const flow = q('flow');
  clear(flow);
  const total = kept + cancelled + idle;
  if (total === 0) flow.append(h('span', { class: 'seg-empty' }));
  else [['seg-gain', kept], ['seg-loss', cancelled], ['seg-idle', idle]].forEach(([cls, n]) => {
    if (n > 0) { const s = h('span', { class: cls }); s.style.flexGrow = String(n); flow.append(s); }
  });
  flow.setAttribute('aria-label', `${int(intents)} manage links opened: ${int(kept)} rescheduled, ${int(cancelled)} cancelled, ${int(idle)} left without changing`);
  const legend = q('legend');
  clear(legend);
  legend.append(
    h('li', { class: 'legend-total' }, 'Manage links opened', h('span', { class: 'count' }, int(intents))),
    h('li', {}, h('span', { class: 'swatch swatch-gain' }), 'Rescheduled instead of cancelling', h('span', { class: 'count' }, int(kept))),
    h('li', {}, h('span', { class: 'swatch swatch-loss' }), 'Cancelled', h('span', { class: 'count' }, int(cancelled))),
    h('li', {}, h('span', { class: 'swatch swatch-idle' }), 'Left without changing', h('span', { class: 'count' }, int(idle))),
  );

  // Trend: upcoming (blue), rescued (green) and lost (red) per month
  const bars = monthsRange.map((mm) => {
    const x = map.get(mm) || {};
    const up = num(x.upcoming_revenue_cents), gain = num(x.revenue_saved_cents), loss = num(x.revenue_lost_cents);
    return {
      label: monthShort(mm), upcoming: up, gain, loss, current: mm === m,
      title: `${monthLabel(mm)}: upcoming ${money(up, cur())}, rescued ${money(gain, cur())}, lost ${money(loss, cur())}`,
    };
  });
  const svg = q('bars');
  pairedBars(svg, bars);
  svg.setAttribute('aria-label', `Upcoming, rescued and lost revenue by month. ${bars.map((b) => b.title).join('. ')}`);
}

// ── Artist capacity ──
// v_artist_capacity has one row per artist per week (Monday start, studio timezone), so every
// window is a whole number of weeks starting at this week's Monday: 1, 2 or 4 weeks.
const capGroup = () => $('#cap-window') || $('#week-seg');
const CAP_LABEL = { 1: 'This week', 2: '2 weeks', 4: '4 weeks' };

/** One artist's totals over `weeks` weeks from `startMonday`. A week with no row counts as 0 booked
 *  but still adds a full week of capacity, so the percentage isn't inflated. */
function capacityTotals(rows, startMonday, weeks) {
  const perWeek = num(rows[0].weekly_capacity_minutes);
  let minutes = 0, bookings = 0, cents = 0;
  for (let i = 0; i < weeks; i++) {
    const wk = rows.find((r) => dateOnly(r.week_start) === addDays(startMonday, i * 7));
    if (wk) { minutes += num(wk.booked_minutes); bookings += num(wk.bookings); cents += num(wk.revenue_cents); }
  }
  const capacity = perWeek * weeks;
  return { minutes, bookings, cents, capacity, pct: capacity ? (100 * minutes) / capacity : 0 };
}

function renderCapacity() {
  const rows = state.data.capacity || [];
  const weeks = state.ui.capWeeks;
  const monday = mondayOf(state.today);
  const card = document.getElementById('card-capacity');
  $('[data-role="sub"]', card).textContent = `${dayLabel(monday)} to ${dayLabel(addDays(monday, weeks * 7 - 1))}`;

  const artists = new Map();
  rows.forEach((r) => { if (!artists.has(r.artist_id)) artists.set(r.artist_id, r.display_name); });
  const list = $('[data-role="artists"]', card);
  const item = list.tagName === 'UL' || list.tagName === 'OL' ? 'li' : 'div'; // valid HTML for either container
  clear(list);
  const foot = $('[data-role="foot"]', card) || $('.footnote, .panel-foot', card);
  if (foot) {
    foot.hidden = artists.size === 0;
    foot.textContent = "Utilization is booked hours divided by each artist's capacity for the selected weeks. The small bars show last week through four weeks ahead; the darker bars are the weeks counted above.";
  }
  if (artists.size === 0) {
    list.append(h(item, { class: 'empty' }, h('strong', {}, 'No appointments scheduled yet'), 'Utilization appears here once bookings come in.'));
    return;
  }

  [...artists].sort((a, b) => a[1].localeCompare(b[1])).forEach(([id, name]) => {
    const mine = rows.filter((r) => r.artist_id === id);
    const t = capacityTotals(mine, monday, weeks);
    const p = t.pct;
    const full = p >= 85;
    const hrs = (mins) => `${+(mins / 60).toFixed(1)}`;

    const fill = h('span', {});
    const meter = h('div', { class: `meter${full ? ' is-full' : ''}`, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(p), 'aria-label': `${name} utilization, ${CAP_LABEL[weeks].toLowerCase()}` }, fill);
    requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${Math.min(p, 100)}%`; }));

    // Small bars: last week through four weeks ahead. The weeks inside the selected window are dark.
    const stripEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    stripEl.setAttribute('class', 'artist-strip');
    stripEl.setAttribute('role', 'img');
    const cols = [-1, 0, 1, 2, 3, 4].map((o) => {
      const ws = addDays(monday, o * 7);
      const x = mine.find((r) => dateOnly(r.week_start) === ws);
      return { pct: x ? num(x.utilization_pct) : 0, current: o >= 0 && o < weeks, title: `Week of ${shortDay(ws)}: ${pct(x ? x.utilization_pct : 0)}` };
    });
    utilStrip(stripEl, cols);
    stripEl.setAttribute('aria-label', `Weekly utilization, last week through four weeks ahead: ${cols.map((c) => c.title).join('; ')}`);

    list.append(h(item, { class: 'artist' },
      h('span', { class: 'artist-name' }, name),
      h('span', { class: `artist-pct${full ? ' is-full' : ''}` }, pct(p)),
      meter,
      h('div', { class: 'artist-meta' },
        h('span', {}, h('b', {}, `${hrs(t.minutes)} h`), ` of ${hrs(t.capacity)} h booked`),
        h('span', {}, h('b', {}, int(t.bookings)), t.bookings === 1 ? ' booking' : ' bookings'),
        h('span', {}, h('b', {}, money(t.cents, cur()))),
        full ? h('span', { class: 'artist-flag' }, 'Nearly full') : null),
      stripEl,
    ));
  });
}

// ── Clients ──

// Lifecycle filters. "Upcoming" uses next_appointment_at (active future bookings only, added by
// migration 005). Until 005 has been run that column is absent, so we fall back to
// last_appointment_at, which can include cancelled bookings (the old behaviour).
const nextAppt = (c) => ('next_appointment_at' in c ? c.next_appointment_at : c.last_appointment_at);
const isUpcoming = (c) => { const t = Date.parse(nextAppt(c)); return Number.isFinite(t) && t > Date.now(); };
const CLIENT_FILTERS = {
  all: () => true,
  upcoming: isUpcoming,
  returning: (c) => num(c.visits) > 1,
  new: (c) => num(c.visits) <= 1,
};
const FILTER_NOUN = { all: 'clients', upcoming: 'upcoming clients', returning: 'returning clients', new: 'new clients' };
const EMPTY_TEXT = {
  upcoming:  ['No upcoming clients', 'Clients with an active future booking appear here.'],
  returning: ['No returning clients yet', 'Clients appear here after their second visit.'],
  new:       ['No new clients', 'Clients with no visit yet, or just one, appear here.'],
};

function clientList() {
  const q = normalize(state.ui.search).split(/\s+/).filter(Boolean);
  const { key, dir } = state.ui.sort;
  const all = state.data.ltv || [];
  const matched = q.length ? all.filter((c) => q.every((t) => c._hay.includes(t))) : all; // search only: what the pill counts show
  const filtered = matched.filter(CLIENT_FILTERS[state.ui.filter] || CLIENT_FILTERS.all);
  const mult = dir === 'asc' ? 1 : -1;
  const byName = (a, b) => (a.display_name || '~').localeCompare(b.display_name || '~', 'en', { sensitivity: 'base' });
  filtered.sort((a, b) => {
    let d;
    if (key === 'display_name') d = byName(a, b);
    else if (key === 'last_appointment_at') d = (Date.parse(a.last_appointment_at) || 0) - (Date.parse(b.last_appointment_at) || 0);
    else d = num(a[key]) - num(b[key]);
    return d * mult || byName(a, b);
  });
  return { all, matched, filtered };
}

function renderClients() {
  (state.data.ltv || []).forEach((c) => { c._hay = `${normalize(c.display_name)} ${digitsOf(c.phone)} ${normalize(c.email)}`; });
  paintClients();
}

function paintClients() {
  const card = document.getElementById('card-clients');
  const { all, matched, filtered } = clientList();
  const f = CLIENT_FILTERS[state.ui.filter] ? state.ui.filter : 'all';
  const term = state.ui.search.trim();
  const returning = all.filter(CLIENT_FILTERS.returning).length;
  $('[data-role="sub"]', card).textContent = all.length
    ? `${int(all.length)} clients, ${int(returning)} have visited more than once`
    : 'Clients appear here after their first booking';

 // Filter pills: pressed state + a count that follows the search box
  $$('#client-filter [data-filter]').forEach((b) => {
    const k = b.dataset.filter;
    b.setAttribute('aria-pressed', String(k === f));
    const n = $('.seg-count', b);
    if (n) n.textContent = int(matched.filter(CLIENT_FILTERS[k] || CLIENT_FILTERS.all).length);
  });

  $$('.th-btn', card).forEach((b) => {
    const th = b.closest('th');
    const on = b.dataset.sort === state.ui.sort.key;
    th.setAttribute('aria-sort', on ? (state.ui.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    b.querySelector('.icon')?.remove();
    b.append(icon(on && state.ui.sort.dir === 'asc' ? 'chevUp' : 'chevDown', { size: 14 }));
  });

  const rows = $('[data-role="rows"]', card);
  clear(rows);
  const visible = filtered;

  if (!filtered.length) {
    let title, hint;
    if (!all.length) [title, hint] = ['No clients yet', 'They show up here after their first booking.'];
    else if (term) [title, hint] = [`No ${FILTER_NOUN[f]} match “${term}”`, f === 'all' ? 'Try a name, the last digits of a phone number, or part of an email.' : 'Try a different search, or choose All.'];
    else [title, hint] = EMPTY_TEXT[f];
    rows.append(h('tr', {}, h('td', { colspan: 5, class: 'empty' }, h('strong', {}, title), hint)));
  }

  visible.forEach((c) => {
    const shown = state.ui.revealed.has(c.phone);
    const name = c.display_name || 'Unnamed client';
    const latest = c.last_appointment_at;
    const reveal = h('button', {
      type: 'button', class: 'reveal', 'data-phone': c.phone, 'aria-pressed': String(shown),
      'aria-label': `${shown ? 'Hide' : 'Show'} contact details for ${name}`, title: shown ? 'Hide contact details' : 'Show contact details',
    }, icon(shown ? 'eyeOff' : 'eye', { size: 16 }));

    rows.append(h('tr', {},
      h('td', {},
        h('div', { class: 'client-name' }, name),
        h('div', { class: 'client-sub' },
          h('span', { class: `tag ${c.segment === 'returning' ? 'tag-returning' : 'tag-new'}` }, c.segment === 'returning' ? 'Returning' : 'New'),
          h('span', {}, c.locale === 'es' ? 'Spanish' : 'English'))),
      h('td', {}, h('div', { class: 'contact' }, reveal,
        h('div', { class: 'contact-lines' },
          h('span', {}, shown ? formatPhone(c.phone) : maskPhone(c.phone)),
          c.email ? h('span', { class: 'email' }, shown ? c.email : maskEmail(c.email)) : h('span', { class: 'email muted' }, 'No email')))),
      h('td', { class: 'num' }, int(c.visits)),
      h('td', { class: 'num' }, h('span', { class: 'ltv' }, money(c.ltv_cents, cur()))),
      h('td', {}, latest ? h('span', {}, dayLabel(dateInTz(latest, tz())), ' ', isUpcoming(c) ? h('span', { class: 'tag tag-upcoming' }, 'Upcoming') : null) : h('span', { class: 'muted' }, 'None yet')),
    ));
  });

  $('[data-role="count"]', card).textContent = filtered.length
  ? `Showing ${int(filtered.length)} ${FILTER_NOUN[f]}${term ? ` matching “${term}”` : `, sorted by ${sortLabel()}`}`
  : '';
const more = $('[data-role="more"]', card);
if (more) more.hidden = true;

const sortLabel = () => ({ display_name: 'name', visits: 'visits', ltv_cents: 'lifetime value', last_appointment_at: 'latest appointment' }[state.ui.sort.key]);
}

// ── Activity feed ──

const FEED_ICON = { created: 'plus', cancel_intent: 'link', rescheduled: 'reschedule', cancelled: 'cancel' };

function renderFeed() {
  const rows = state.data.activity || [];
  const list = $('[data-role="feed"]', document.getElementById('card-feed'));
  clear(list);
  if (!rows.length) {
    list.append(h('li', { class: 'empty' }, h('strong', {}, 'Nothing recorded yet'), 'New bookings, reschedules and cancellations appear here as they happen.'));
    return;
  }
  const today = state.today, yesterday = addDays(today, -1);
  let lastDay = null;
  rows.forEach((e) => {
    const day = dateInTz(e.occurred_at, tz());
    if (day !== lastDay) {
      lastDay = day;
      // A plain <li>: an <ol> may only contain <li> elements.
      list.append(h('li', { class: 'feed-day' }, day === today ? 'Today' : day === yesterday ? 'Yesterday' : dayLabel(day)));
    }
    list.append(feedItem(e, state.primed && !state.seen.has(e.event_id)));
  });
  rows.forEach((e) => state.seen.add(e.event_id));
  state.primed = true;
}

function feedItem(e, isNew) {
  const who = (e.customer_name || 'A client').trim();
  const what = e.service_summary || 'an appointment';
  const withArtist = e.artist_name ? ` with ${e.artist_name}` : '';
  const price = num(e.price_cents_at_event);
  const when = e.to_appointment_at ? appointmentLabel(e.to_appointment_at, tz()) : '';
  let text, meta = [];

  switch (e.event_type) {
    case 'created':
      text = [h('b', {}, who), ` booked ${what}${withArtist}`];
      meta = [price > 0 ? money(price, cur()) : 'Price to be confirmed', when];
      break;
    case 'cancel_intent':
      text = [h('b', {}, who), ` opened the manage link for ${what}`];
      meta = [when];
      break;
    case 'rescheduled':
      text = [h('b', {}, who), ` rescheduled ${what}${withArtist}`];
      meta = [when && `Now ${when}`, e.from_cancel_flow ? h('span', { class: 'feed-badge gain' }, `Rescued ${money(price, cur())}`) : null];
      break;
    case 'cancelled':
      text = [h('b', {}, who), ` cancelled ${what}${withArtist}`];
      meta = [h('span', { class: 'feed-badge loss' }, `Lost ${money(price, cur())}`), when];
      break;
    default:
      text = [h('b', {}, who), ` ${String(e.event_type).replace(/_/g, ' ')}`];
  }

  return h('li', { class: `feed-item${isNew ? ' is-new' : ''}` },
    h('span', { class: `feed-icon t-${e.event_type}` }, icon(FEED_ICON[e.event_type] || 'link', { size: 15 })),
    h('div', {}, h('p', { class: 'feed-text' }, ...text), h('div', { class: 'feed-meta' }, ...meta.filter(Boolean).map((m) => (typeof m === 'string' ? h('span', {}, m) : m)))),
    h('time', { class: 'feed-time', datetime: e.occurred_at, title: fullStamp(e.occurred_at, tz()), 'data-t': e.occurred_at }, relTime(e.occurred_at)),
  );
}

// ───────────────────────── live updates ─────────────────────────

async function poll() {
  if (document.hidden || !state.tenant) return;
  const prevTop = state.data.activity && state.data.activity[0] && state.data.activity[0].event_id;
  const ok = await loadSource('activity', { keep: true });
  if (ok) {
    const top = state.data.activity[0] && state.data.activity[0].event_id;
    if (top !== prevTop) await Promise.all(['perf', 'churn', 'capacity', 'ltv'].map((k) => loadSource(k, { keep: true })));
    stamp();
  } else if (state.tenant) {
    setLive('error', 'Connection lost. Retrying');
  }
}

function stamp() {
  state.lastOk = Date.now();
  setLive('live', `Updated ${clockTime(new Date(), tz())}`);
}

function tickTimes() {
  $$('[data-t]').forEach((t) => { t.textContent = relTime(t.dataset.t); });
}

function startLive() {
  stopLive();
  state.pollTimer = setInterval(poll, POLL_MS);
  state.tickTimer = setInterval(tickTimes, 20000);
}
function stopLive() {
  clearInterval(state.pollTimer);
  clearInterval(state.tickTimer);
}

// ───────────────────────── tenant / session ─────────────────────────

async function loadTenant() {
  state.gen += 1;
  state.today = todayIn(tz());
  state.data = { perf: null, churn: null, capacity: null, ltv: null, activity: null };
  state.ui = { churnMonth: null, capWeeks: 1, filter: 'all', search: '', sort: { key: 'ltv_cents', dir: 'desc' }, shown: CLIENT_PAGE, revealed: new Set() };
  state.seen = new Set(); state.primed = false;
  $('#client-search').value = '';
  $$('.seg-btn', capGroup() || document).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.window === '1')));
  document.title = `${state.tenant.display_name} | Command Center`;
  setLive('loading', 'Loading');

  const results = await Promise.all(Object.keys(SOURCES).map((k) => loadSource(k, { loading: true, fresh: true })));
  if (results.some(Boolean)) stamp(); else setLive('error', 'Could not load data');
}

async function enterApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  setLive('loading', 'Loading');
  try {
    state.tenants = await api.listTenants();
  } catch (err) {
    if (err.code === 'unauthorized') return;
    setLive('error', 'Could not load data');
    Object.values(SOURCES).flatMap((s) => s.cards).forEach((id) => setState(id, 'error', api.friendly(err)));
    return;
  }
  if (!state.tenants.length) {
    setLive('error', 'No clients set up');
    Object.values(SOURCES).flatMap((s) => s.cards).forEach((id) => setState(id, 'error', 'No clients are set up in the ledger yet.'));
    return;
  }
  const saved = (() => { try { return localStorage.getItem('cc-tenant'); } catch (_) { return null; } })();
  state.tenant = state.tenants.find((t) => t.slug === saved) || state.tenants[0];
  const sel = $('#tenant-select');
  clear(sel);
  state.tenants.forEach((t) => sel.append(h('option', { value: t.slug, selected: t.slug === state.tenant.slug ? true : null }, t.display_name)));
  await loadTenant();
  startLive();
  $('#main').focus({ preventScroll: true });
}

function showLogin(message) {
  stopLive();
  state.tenant = null;
  $('#app').hidden = true;
  $('#login').hidden = false;
  const err = $('#login-error');
  err.hidden = !message;
  err.textContent = message || '';
  $('#passcode').value = '';
  $('#passcode').focus();
}

function retry(key) {
  if (!state.tenant) return enterApp();
  return loadSource(key, { loading: true, fresh: true }).then((ok) => { if (ok) stamp(); });
}

// ───────────────────────── theme ─────────────────────────

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('cc-theme', theme); } catch (_) {}
  const btn = $('#theme-toggle');
  clear(btn);
  btn.append(icon(theme === 'studio' ? 'moon' : 'sun', { size: 18 }));
  const label = theme === 'studio' ? 'Switch to the dark terminal theme' : 'Switch to the studio theme';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.setAttribute('aria-pressed', String(theme === 'terminal'));
}

// ───────────────────────── boot ─────────────────────────

function fillStaticParts() {
  $$('.card-skel').forEach((el) => {
    const n = Number(el.dataset.lines) || 3;
    for (let i = 0; i < n; i++) el.append(h('div', { class: `skel${i === 0 && el.closest('.kpi') ? ' skel-big' : ''}` }));
  });
  $$('.card-err').forEach((el) => {
    el.append(
      h('p', { class: 'err-title' }, icon('alert', { size: 18 }), 'This section didn’t load'),
      h('p', { class: 'err-msg' }),
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => retry(el.dataset.retryKey) }, 'Try again'),
    );
  });
  $$('[data-icon]').forEach((el) => el.append(icon(el.dataset.icon, { size: 18 })));
}

function wire() {
  $('#theme-toggle').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'studio' ? 'terminal' : 'studio'));
  $('#signout').addEventListener('click', () => { api.session.clear(); showLogin(); });
  window.addEventListener('cc:unauthorized', () => showLogin('Your session expired. Sign in again.'));

  $('#login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const pass = $('#passcode').value;
    const err = $('#login-error');
    if (!pass) { err.hidden = false; err.textContent = 'Enter the passcode.'; return; }
    const btn = $('#login-submit');
    btn.disabled = true; btn.textContent = 'Signing in…'; err.hidden = true;
    try {
      await api.login(pass);
      $('#passcode').value = '';
      await enterApp();
    } catch (e) {
      err.hidden = false; err.textContent = api.friendly(e);
    } finally {
      btn.disabled = false; btn.textContent = 'Sign in';
    }
  });

  $('#tenant-select').addEventListener('change', (ev) => {
    state.tenant = state.tenants.find((t) => t.slug === ev.target.value) || state.tenant;
    try { localStorage.setItem('cc-tenant', state.tenant.slug); } catch (_) {}
    loadTenant();
  });

  $('#range-seg').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-range]');
    if (!b || Number(b.dataset.range) === state.range) return;
    state.range = Number(b.dataset.range);
    $$('#range-seg .seg-btn').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    loadSource('perf');
  });

 capGroup()?.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-window]');
    if (!b) return;
    state.ui.capWeeks = Number(b.dataset.window);
    $$('.seg-btn', capGroup()).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    if (state.data.capacity) renderCapacity();
  });

 $('#churn-month').addEventListener('change', (ev) => {
    state.ui.churnMonth = ev.target.value;
    paintChurnPanel(churnRange(churnRows().thisMonth));
  });

  let t;
  $('#client-search').addEventListener('input', (ev) => {
    clearTimeout(t);
    t = setTimeout(() => { state.ui.search = ev.target.value; state.ui.shown = Infinity; if (state.data.ltv) paintClients(); }, 120);
  });
$('#client-filter')?.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-filter]');
    if (!b || b.dataset.filter === state.ui.filter) return;
    state.ui.filter = b.dataset.filter;
    state.ui.shown = Infinity;               // back to the first page, like search does
    if (state.data.ltv) paintClients();
  });
  $('#clients-table').addEventListener('click', (ev) => {
    const th = ev.target.closest('.th-btn');
    if (th) {
      const key = th.dataset.sort;
      state.ui.sort = state.ui.sort.key === key
        ? { key, dir: state.ui.sort.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'display_name' ? 'asc' : 'desc' };
      paintClients();
      return;
    }
    const rv = ev.target.closest('.reveal');
    if (rv) {
      const p = rv.dataset.phone;
      state.ui.revealed.has(p) ? state.ui.revealed.delete(p) : state.ui.revealed.add(p);
      paintClients();
      $(`.reveal[data-phone="${CSS.escape(p)}"]`)?.focus();
    }
  });

$('#card-clients [data-role="more"]')?.addEventListener('click', () => { state.ui.shown += CLIENT_PAGE; paintClients(); });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.tenant && Date.now() - state.lastOk > POLL_MS) poll();
  });
}

function boot() {
  fillStaticParts();
  applyTheme(document.documentElement.dataset.theme === 'terminal' ? 'terminal' : 'studio');
  wire();
  if (api.session.token()) enterApp(); else showLogin();
}

boot();
