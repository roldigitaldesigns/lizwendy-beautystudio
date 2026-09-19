// Formatting utilities. Money arrives as integer cents and is always shown
// as $X,XXX.XX. Dates are shown in the tenant's own timezone.

const nfCache = new Map();
function moneyFormatter(currency) {
  if (!nfCache.has(currency)) {
    nfCache.set(currency, new Intl.NumberFormat('en-US', {
      style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
    }));
  }
  return nfCache.get(currency);
}

const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

/** 12345 → "$123.45" */
export function money(cents, currency = 'USD') {
  return isNum(cents) ? moneyFormatter(currency).format(Number(cents) / 100) : '—';
}

/** Splits a money string for the tickers: "$1,234.56" → { text, whole: "$1,234", fraction: ".56" } */
export function moneyParts(cents, currency = 'USD') {
  const text = money(cents, currency);
  const i = text.lastIndexOf('.');
  return i > 0 ? { text, whole: text.slice(0, i), fraction: text.slice(i) } : { text, whole: text, fraction: '' };
}

export const int = (n) => (isNum(n) ? new Intl.NumberFormat('en-US').format(Number(n)) : '—');
export const pct = (v, digits = 1) => (isNum(v) ? `${Number(v).toFixed(digits)}%` : '—');

// ── DATES (all 'YYYY-MM-DD' math is done in UTC so DST can't shift a day) ──
const DAY = 864e5;
const toUTC = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const fromUTC = (ms) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (d, n) => fromUTC(toUTC(d) + n * DAY);
export const dateOnly = (v) => String(v).slice(0, 10);

/** Today's calendar date in a timezone, as YYYY-MM-DD. */
export function todayIn(tz, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Monday of the week containing d (weeks start Monday, matching the database). */
export function mondayOf(d) {
  const dow = new Date(toUTC(d)).getUTCDay(); // 0 = Sunday
  return addDays(d, -((dow + 6) % 7));
}

export const monthStartOf = (d) => `${d.slice(0, 7)}-01`;
/** Month arithmetic on a 'YYYY-MM-01' string. */
export function addMonths(monthStart, k) {
  return fromUTC(Date.UTC(+monthStart.slice(0, 4), +monthStart.slice(5, 7) - 1 + k, 1));
}

const fmtUTC = (d, opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).format(new Date(toUTC(d)));
export const monthLabel = (d) => fmtUTC(d, { month: 'long', year: 'numeric' });
export const monthShort = (d) => fmtUTC(d, { month: 'short' });
export const dayLabel = (d) => fmtUTC(d, { weekday: 'short', month: 'short', day: 'numeric' });
export const shortDay = (d) => fmtUTC(d, { month: 'short', day: 'numeric' });

/** ISO timestamp → "Sat, Oct 3 at 2:00 PM" in tz. */
export function appointmentLabel(iso, tz) {
  if (!iso) return '';
  const dt = new Date(iso);
  const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(dt);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(dt);
  return `${day} at ${time}`;
}

export const dateInTz = (iso, tz) => todayIn(tz, new Date(iso));
export const fullStamp = (iso, tz) =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
export const clockTime = (d, tz) =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);

export function relTime(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} hr ago`;
  const d = Math.round(hr / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

// ── CONTACT ──
const digitsOf = (s) => String(s || '').replace(/\D/g, '');
export function formatPhone(e164) {
  const d = digitsOf(e164);
  const n = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  return n.length === 10 ? `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}` : (e164 || '');
}
export function maskPhone(e164) {
  const d = digitsOf(e164);
  return d.length >= 4 ? `(•••) •••-${d.slice(-4)}` : '••••';
}
export function maskEmail(email) {
  if (!email) return '';
  const [user, domain = ''] = String(email).split('@');
  return `${user.slice(0, 2)}•••@${domain}`;
}

/** Lowercase + strip accents, so "Cedeno" finds "Cedeño". */
export const normalize = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export { digitsOf };

/** Percentage change, or null when there's no baseline to compare against. */
export function changePct(cur, prev) {
  if (!isNum(cur) || !isNum(prev) || Number(prev) === 0) return null;
  return ((Number(cur) - Number(prev)) / Math.abs(Number(prev))) * 100;
}
