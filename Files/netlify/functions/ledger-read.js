/**
 * POST /.netlify/functions/ledger-read
 *
 * The Command Center dashboard's ONLY door into the ledger. The browser never
 * talks to Supabase: this function holds the service-role key, checks a
 * passcode-derived session token, and returns rows for ONE tenant at a time.
 *
 * WHY EXPLICIT TENANT FILTERING: the service role bypasses Row Level
 * Security, so RLS cannot isolate tenants here. Every read below is filtered
 * by tenant_id in code, and the view names are an allowlist. Don't add a code
 * path that skips either.
 *
 * Actions (JSON body):
 *   { action: "login",   passcode }                          → { token, expires_at }
 *   { action: "tenants" }                                    → { tenants: [...] }
 *   { action: "read", tenant, view, from?, to?, limit? }     → { rows: [...] }
 *       tenant: slug, e.g. "lwbs"
 *       view:   v_daily_performance | v_churn_deflection | v_artist_capacity
 *               | v_customer_ltv | v_recent_activity
 *       from/to: YYYY-MM-DD, `from` inclusive, `to` exclusive, applied to the
 *                view's date column (not supported by v_customer_ltv)
 *   tenants / read require:  Authorization: Bearer <token>
 *
 * Env vars (Netlify):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (already set for the ledger)
 *   DASHBOARD_PASSCODE        ≥ 12 chars. What you type into the login screen.
 *   DASHBOARD_TOKEN_SECRET    ≥ 32 chars, random. Signs session tokens.
 *   DASHBOARD_ALLOWED_ORIGIN  optional. Only if the dashboard is served from a
 *                             different origin than this function.
 *
 * NOTE: phone numbers and emails are returned in full to an authenticated
 * session. Masking in the UI is shoulder-surfing protection for presentations,
 * not a security boundary.
 */

'use strict';

const crypto = require('crypto');

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const UPSTREAM_TIMEOUT_MS = 8000;
const TENANT_CACHE_MS = 5 * 60 * 1000;

// ── VIEW ALLOWLIST ──
// order: PostgREST order clause. rangeCol: column that from/to filter on.
const VIEWS = {
  v_daily_performance: { order: 'day.desc',                          rangeCol: 'day',         defLimit: 120, maxLimit: 400 },
  v_churn_deflection:  { order: 'month_start.desc',                  rangeCol: 'month_start', defLimit: 12,  maxLimit: 60  },
  v_artist_capacity:   { order: 'week_start.desc,display_name.asc',  rangeCol: 'week_start',  defLimit: 60,  maxLimit: 300 },
  v_customer_ltv:      { order: 'ltv_cents.desc,phone.asc',          rangeCol: null,          defLimit: 500, maxLimit: 1000 },
  v_recent_activity:   { order: 'occurred_at.desc,event_id.desc',    rangeCol: 'occurred_at', defLimit: 50,  maxLimit: 200 },
};

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── CONFIG (read per call so a misconfiguration is reported, not cached) ──
function config() {
  const c = {
    url:      (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
    key:      process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    passcode: process.env.DASHBOARD_PASSCODE || '',
    secret:   process.env.DASHBOARD_TOKEN_SECRET || '',
    origin:   process.env.DASHBOARD_ALLOWED_ORIGIN || '',
  };
  const problems = [];
  if (!c.url || !c.key)          problems.push('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
  if (c.passcode.length < 12)    problems.push('DASHBOARD_PASSCODE missing or shorter than 12 characters');
  if (c.secret.length < 32)      problems.push('DASHBOARD_TOKEN_SECRET missing or shorter than 32 characters');
  return { c, problems };
}

// ── RESPONSES ──
function respond(statusCode, body, origin) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    headers['Vary'] = 'Origin';
  }
  return { statusCode, headers, body: body === undefined ? '' : JSON.stringify(body) };
}

// ── AUTH ──
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b)); // equal-length digests

const sign = (payloadB64, secret) =>
  crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');

function issueToken(secret) {
  const exp = Date.now() + TOKEN_TTL_MS;
  const p = Buffer.from(JSON.stringify({ exp, v: 1 })).toString('base64url');
  return { token: `${p}.${sign(p, secret)}`, exp };
}

function verifyToken(token, secret) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const given = Buffer.from(parts[1]);
  const want  = Buffer.from(sign(parts[0], secret));
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    return Number.isFinite(exp) && exp > Date.now();
  } catch (_) {
    return false;
  }
}

// Best-effort brute-force brake. Serverless instances don't share memory, so
// this is a speed bump, not a guarantee — the real defence is a long passcode.
const failures = new Map(); // ip -> { n, reset }
const MAX_FAILS = 8, FAIL_WINDOW_MS = 10 * 60 * 1000;
const isLockedOut = (ip) => { const f = failures.get(ip); return !!f && f.reset > Date.now() && f.n >= MAX_FAILS; };
function noteFailure(ip) {
  const now = Date.now();
  if (failures.size > 500) failures.clear();
  const f = failures.get(ip);
  if (!f || f.reset <= now) failures.set(ip, { n: 1, reset: now + FAIL_WINDOW_MS });
  else f.n++;
}

// ── SUPABASE (PostgREST) ──
async function sb(cfg, path, params) {
  const headers = { apikey: cfg.key, Accept: 'application/json' };
  // Legacy service_role keys are JWTs (also sent as Bearer); sb_secret_ keys are not.
  if (cfg.key.startsWith('eyJ')) headers.Authorization = `Bearer ${cfg.key}`;

  const qs = params.toString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.url}/rest/v1/${path}${qs ? `?${qs}` : ''}`, { headers, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

const tenantCache = new Map(); // slug -> { id, row, at }
async function resolveTenant(cfg, slug) {
  const hit = tenantCache.get(slug);
  if (hit && Date.now() - hit.at < TENANT_CACHE_MS) return hit;

  const rows = await sb(cfg, 'tenants', new URLSearchParams({
    select: 'id,slug,display_name,vertical,currency,timezone',
    slug: `eq.${slug}`,
    is_active: 'eq.true',
    limit: '1',
  }));
  if (!rows.length) return null;
  const { id, ...row } = rows[0];
  const entry = { id, row, at: Date.now() };
  tenantCache.set(slug, entry);
  return entry;
}

// ── HANDLER ──
exports.handler = async (event) => {
  const { c: cfg, problems } = config();
  const origin = cfg.origin;

  if (event.httpMethod === 'OPTIONS') return respond(204, undefined, origin);
  if (event.httpMethod !== 'POST')    return respond(405, { error: 'method_not_allowed' }, origin);

  if (problems.length) {
    console.error('ledger-read: server misconfigured —', problems.join('; '));
    return respond(500, { error: 'server_misconfigured' }, origin);
  }

  let data;
  try {
    if ((event.body || '').length > 10000) return respond(413, { error: 'payload_too_large' }, origin);
    data = JSON.parse(event.body || '{}');
  } catch (_) {
    return respond(400, { error: 'invalid_json' }, origin);
  }

  const headers = event.headers || {};
  const ip = headers['x-nf-client-connection-ip'] || headers['x-forwarded-for'] || 'unknown';

  try {
    // ── LOGIN ──
    if (data.action === 'login') {
      if (isLockedOut(ip)) return respond(429, { error: 'too_many_attempts' }, origin);
      if (typeof data.passcode !== 'string' || !safeEqual(data.passcode, cfg.passcode)) {
        noteFailure(ip);
        await new Promise((r) => setTimeout(r, 400)); // slow down guessing
        return respond(401, { error: 'invalid_passcode' }, origin);
      }
      failures.delete(ip);
      const { token, exp } = issueToken(cfg.secret);
      return respond(200, { ok: true, token, expires_at: new Date(exp).toISOString() }, origin);
    }

    // Everything below needs a valid session.
    const authHeader = headers.authorization || headers.Authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!verifyToken(token, cfg.secret)) return respond(401, { error: 'unauthorized' }, origin);

    // ── TENANT LIST (for the switcher) ──
    if (data.action === 'tenants') {
      const rows = await sb(cfg, 'tenants', new URLSearchParams({
        select: 'slug,display_name,vertical,currency,timezone',
        is_active: 'eq.true',
        order: 'display_name.asc',
      }));
      return respond(200, { ok: true, tenants: rows }, origin);
    }

    // ── READ ──
    if (data.action === 'read') {
      const spec = Object.prototype.hasOwnProperty.call(VIEWS, data.view) ? VIEWS[data.view] : null;
      if (!spec) return respond(400, { error: 'invalid_view' }, origin);

      if (typeof data.tenant !== 'string' || !SLUG_RE.test(data.tenant)) {
        return respond(400, { error: 'invalid_tenant' }, origin);
      }
      for (const k of ['from', 'to']) {
        if (data[k] != null && (typeof data[k] !== 'string' || !DATE_RE.test(data[k]) || isNaN(Date.parse(data[k])))) {
          return respond(400, { error: `invalid_${k}` }, origin);
        }
      }
      if ((data.from != null || data.to != null) && !spec.rangeCol) {
        return respond(400, { error: 'range_not_supported' }, origin);
      }

      const tenant = await resolveTenant(cfg, data.tenant);
      if (!tenant) return respond(404, { error: 'unknown_tenant' }, origin);

      const limit = Math.min(Math.max(parseInt(data.limit, 10) || spec.defLimit, 1), spec.maxLimit);
      const params = new URLSearchParams({
        select: '*',
        tenant_id: `eq.${tenant.id}`,   // ← THE tenant isolation (service role bypasses RLS)
        order: spec.order,
        limit: String(limit),
      });
      if (data.from) params.append(spec.rangeCol, `gte.${data.from}`);
      if (data.to)   params.append(spec.rangeCol, `lt.${data.to}`);

      const rows = await sb(cfg, data.view, params);
      // tenant_id is the internal join key; the client only ever needs the slug.
      const clean = rows.map(({ tenant_id, ...rest }) => rest);
      return respond(200, {
        ok: true,
        tenant: tenant.row,
        view: data.view,
        count: clean.length,
        generated_at: new Date().toISOString(),
        rows: clean,
      }, origin);
    }

    return respond(400, { error: 'invalid_action' }, origin);

  } catch (err) {
    // Details stay in the server log; the client gets a generic error.
    console.error('ledger-read error:', err && err.message ? err.message : err);
    return respond(502, { error: 'upstream_error' }, origin);
  }
};
