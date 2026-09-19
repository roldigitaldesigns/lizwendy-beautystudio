/**
 * ROL Command Center — ledger client.
 *
 * Sends one booking event to the Supabase ledger via the ledger_record_event
 * RPC (migration 002). Designed so it can NEVER break a customer's booking:
 * recordLedgerEvent() always resolves (never throws), times out quickly, and
 * retries at most once. Duplicate deliveries are harmless — the RPC dedupes
 * on idempotency_key.
 *
 * Env vars (Netlify → Site settings → Environment variables):
 *   SUPABASE_URL                e.g. https://abcd1234.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY   server-side ONLY — never expose to the browser
 *   LEDGER_TENANT_SLUG          optional, defaults to "lwbs"
 *
 * Lives in _lib/ so Netlify doesn't publish it as its own function endpoint.
 */

'use strict';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TENANT_SLUG  = process.env.LEDGER_TENANT_SLUG || 'lwbs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Normalize a US-style phone number to E.164 (+1XXXXXXXXXX), matching the
 * assumption already used by the WhatsApp senders. Returns null if the result
 * wouldn't satisfy the ledger's E.164 constraint.
 */
function toE164(raw) {
  const digits = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (!digits) return null;
  const e164 = digits.length === 10 ? `+1${digits}` : `+${digits}`;
  return /^\+[1-9][0-9]{7,14}$/.test(e164) ? e164 : null;
}

/** Dollars → integer cents. Returns null for missing/invalid so the ledger can fall back. */
function toCents(dollars) {
  if (dollars === null || dollars === undefined || dollars === '') return null;
  const n = Number(dollars);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

/** Parses a cents value stored as a string in calendar extended properties. */
function parseCents(str) {
  if (str === null || str === undefined || str === '') return null;
  const n = parseInt(str, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * @param {object} evt   payload fields for ledger_record_event (see migration 002);
 *                       tenant_slug is added automatically.
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=2500]  per-attempt timeout
 * @param {number} [opts.retries=1]       extra attempts after the first
 * @returns {Promise<{ok:boolean, status?:string, skipped?:string, error?:string}>}
 */
async function recordLedgerEvent(evt, opts = {}) {
  const { timeoutMs = 2500, retries = 1 } = opts;
  const label = `${evt.event_type}:${evt.idempotency_key || 'no-key'}`;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('ledger: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping', label);
    return { ok: false, skipped: 'not_configured' };
  }

  const payload = { tenant_slug: TENANT_SLUG, ...evt };
  const headers = { 'Content-Type': 'application/json', apikey: SUPABASE_KEY };
  // Legacy service_role keys are JWTs and go in Authorization too; the newer
  // sb_secret_ keys are not JWTs and must be sent via apikey only.
  if (SUPABASE_KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${SUPABASE_KEY}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res  = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ledger_record_event`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ payload }),
        signal: ctrl.signal,
      });
      const text = await res.text();

      if (res.ok) {
        let result = {};
        try { result = JSON.parse(text); } catch (_) { /* non-JSON is fine */ }
        console.log(`ledger: ${label} → ${result.status || 'ok'}${result.reason ? ` (${result.reason})` : ''}`);
        return { ok: true, status: result.status };
      }

      console.error(`ledger: ${label} → HTTP ${res.status}: ${text.slice(0, 300)}`);
      // 4xx means our payload/config is wrong — retrying can't fix it.
      if (res.status >= 400 && res.status < 500) return { ok: false, error: `http_${res.status}` };
    } catch (err) {
      console.error(`ledger: ${label} attempt ${attempt + 1} failed:`, err && err.name === 'AbortError' ? 'timeout' : err);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await sleep(300);
  }
  return { ok: false, error: 'exhausted_retries' };
}

module.exports = { recordLedgerEvent, toE164, toCents, parseCents };
