/**
 * clover-store.js
 *
 * Shared storage layer for Clover deposit verification.
 *
 * Wraps Netlify Blobs so both the webhook receiver
 * (clover-payment-webhook.js) and the booking gate (create-booking.js)
 * read and write "paid deposit" records through one tested interface,
 * instead of each duplicating storage logic.
 *
 * A record represents "Clover confirmed a real deposit payment." It is
 * written by the webhook when Clover fires a payment event, and looked up
 * by create-booking.js before a Wendy booking is allowed through.
 *
 * ── MATCHING STRATEGY (deliberately flexible) ──
 * We don't yet know whether Wendy's Clover link can carry a custom order
 * reference (Hosted Checkout / Payment Links API) or is a flat static link
 * (Simple Pay Link) with no custom field. So findPaidOrder() supports BOTH:
 *
 *   1. orderRef match  — exact, preferred. Used when the Clover payment
 *      carries a reference we generated on our side (Section 1).
 *   2. amount + time-window match — fallback. Used when the link is static
 *      and the only signals Clover gives us are "a $20 deposit came in at
 *      roughly this time." Less precise, so it also enforces single-use
 *      (a matched record is consumed) to reduce the chance of one payment
 *      satisfying two bookings.
 *
 * Whichever Section 1 resolves to, this interface does not change — only
 * which branch of findPaidOrder() gets exercised.
 *
 * ── STORE SHAPE ──
 * Store name: "clover-deposits"
 * Key:   the Clover payment id (guaranteed unique per payment)
 * Value: {
 *   paymentId:  string,      // Clover's payment id (also the key)
 *   orderRef:   string|null, // our reference, if the link carried one
 *   amountCents:number,      // paid amount in cents (2000 = $20.00)
 *   createdAt:  number,      // epoch ms when we recorded it
 *   consumed:   boolean,     // true once a booking has claimed this payment
 *   consumedBy: string|null, // booking identifier that claimed it (audit)
 *   raw:        object       // trimmed slice of Clover payload, for audit
 * }
 */

const { getStore } = require('@netlify/blobs');

const STORE_NAME = 'clover-deposits';

// A matched-by-amount payment is only considered valid if it landed within
// this many minutes of the booking submission. Wide enough to cover a
// customer paying, then filling out the form; tight enough to avoid matching
// an unrelated older payment. Only used in the amount+time fallback path.
const AMOUNT_MATCH_WINDOW_MIN = 30;

// The expected deposit, in cents. Kept here so the fallback matcher has a
// single source of truth; the webhook records whatever Clover actually sends.
const EXPECTED_DEPOSIT_CENTS = 2000; // $20.00

// ── DIRECT CLOVER API FALLBACK ──
// When the webhook never fires (an entire day of silence is what prompted
// this — payments landed in Clover but no Blobs record was ever written),
// the Blobs lookup below finds nothing and a real, paid customer gets no
// booking. This fallback asks Clover directly: instead of waiting for
// Clover to push us a payment event, findPaidOrder() reaches OUT to Clover's
// Ecommerce API and reads recent charges itself.
//
// Base URL verified against Clover docs (docs.clover.com): production
// Ecommerce API is scl.clover.com; sandbox is scl-sandbox.dev.clover.com.
// Auth is the merchant-scoped private token as a Bearer token — no merchant
// id needed in the request, and the charge payload carries none to check.
const CLOVER_API_BASE = process.env.CLOVER_API_BASE
  || 'https://scl.clover.com'; // production; override for sandbox if ever needed
const CLOVER_PRIVATE_TOKEN = process.env.CLOVER_PRIVATE_TOKEN;

// Master switch. Default ON so the fallback actually protects bookings the
// moment this deploys — the webhook has already proven it can go silent, so
// the safety net should be live by default, not opt-in. Set
// CLOVER_API_FALLBACK=false in Netlify to disable without a code change.
const CLOVER_API_FALLBACK_ENABLED =
  String(process.env.CLOVER_API_FALLBACK || 'true').toLowerCase() !== 'false';

// Hard ceiling on how many charges to pull per fallback lookup. The window
// filter below already scopes to the last AMOUNT_MATCH_WINDOW_MIN minutes,
// so this is just a belt-and-suspenders cap; Clover's max page size is 100.
const CLOVER_API_MAX_CHARGES = 100;

function store() {
  // Netlify's automatic Blobs context injection doesn't always land
  // reliably (a known platform gap — MissingBlobsEnvironmentError even on
  // a clean deploy). BLOBS_SITE_ID / BLOBS_TOKEN are the manual fallback:
  // an explicit Project ID + Personal Access Token, set in Netlify env
  // vars. If both are present, use them. If not, fall back to letting
  // @netlify/blobs auto-detect — so this keeps working unmodified if
  // Netlify's auto-injection starts working reliably in the future.
  const siteID = process.env.BLOBS_SITE_ID;
  const token  = process.env.BLOBS_TOKEN;
  if (siteID && token) {
    return getStore({ name: STORE_NAME, siteID, token });
  }
  return getStore(STORE_NAME);
}

/**
 * Record a confirmed Clover deposit payment.
 * Called by the webhook. Idempotent: re-recording the same paymentId
 * overwrites rather than duplicates, so Clover re-delivering an event
 * (which webhooks do) can't create two records for one payment.
 *
 * @param {object} p
 * @param {string} p.paymentId    Clover payment id (required, used as key)
 * @param {string} [p.orderRef]   our reference if the link carried one
 * @param {number} p.amountCents  amount paid, in cents
 * @param {object} [p.raw]        trimmed Clover payload for audit
 * @returns {Promise<object>} the stored record
 */
async function recordPaidOrder({ paymentId, orderRef = null, amountCents, raw = {} }) {
  if (!paymentId) throw new Error('recordPaidOrder: paymentId is required');
  if (!Number.isFinite(amountCents)) throw new Error('recordPaidOrder: amountCents must be a number');

  const record = {
    paymentId,
    orderRef: orderRef || null,
    amountCents,
    createdAt: Date.now(),
    consumed: false,
    consumedBy: null,
    raw,
  };

  await store().setJSON(paymentId, record);
  return record;
}

/**
 * Look up a valid, unconsumed paid deposit for a booking.
 *
 * Preferred path: pass { orderRef } for an exact match.
 * Fallback path:  pass { amountCents, atTime } to match a recent payment of
 *                 the expected amount within the time window.
 *
 * Does NOT consume the record — call consumePaidOrder() once the booking
 * actually succeeds, so a failed booking attempt doesn't burn the payment.
 *
 * @param {object} criteria
 * @param {string} [criteria.orderRef]    exact reference to match
 * @param {number} [criteria.amountCents] expected amount (fallback path)
 * @param {number} [criteria.atTime]      booking time epoch ms (fallback path)
 * @returns {Promise<object|null>} the matching record, or null
 */
async function findPaidOrder({ orderRef, amountCents, atTime } = {}) {
  const s = store();

  // ── Preferred: exact orderRef match ──
  if (orderRef) {
    const { blobs } = await s.list();
    for (const b of blobs) {
      const rec = await s.get(b.key, { type: 'json' });
      if (rec && !rec.consumed && rec.orderRef === orderRef) {
        return rec;
      }
    }
    return null;
  }

  // ── Fallback: amount + time-window match ──
  if (Number.isFinite(amountCents)) {
    const windowMs = AMOUNT_MATCH_WINDOW_MIN * 60 * 1000;
    const ref = Number.isFinite(atTime) ? atTime : Date.now();
    const { blobs } = await s.list();

    let best = null;
    for (const b of blobs) {
      const rec = await s.get(b.key, { type: 'json' });
      if (!rec || rec.consumed) continue;
      if (rec.amountCents !== amountCents) continue;
      if (Math.abs(rec.createdAt - ref) > windowMs) continue;
      // Prefer the payment closest in time to the booking submission.
      if (!best || Math.abs(rec.createdAt - ref) < Math.abs(best.createdAt - ref)) {
        best = rec;
      }
    }
    if (best) return best;

    // ── Blobs came up empty → ASK CLOVER DIRECTLY ──
    // The webhook was supposed to have written a record by now. If it didn't
    // (the exact failure this fallback exists for), the loop above found
    // nothing. Rather than give up and leave a paying customer un-bookable,
    // reach out to Clover's API and look for the charge ourselves.
    if (CLOVER_API_FALLBACK_ENABLED) {
      try {
        const apiMatch = await findPaidOrderViaCloverApi({ amountCents, atTime: ref, windowMs });
        if (apiMatch) return apiMatch;
      } catch (e) {
        // Never let an API hiccup crash the booking path. A failure here is
        // logged and treated as "no match" — same as a Blobs miss — so the
        // caller behaves exactly as it does today when nothing is found.
        console.error('findPaidOrder: Clover API fallback failed (treated as no match):', e && e.message);
      }
    }

    return null;
  }

  return null;
}

/**
 * Direct-from-Clover fallback for findPaidOrder()'s amount+time path.
 *
 * Reads recent charges straight from Clover's Ecommerce API and looks for an
 * APPROVED/succeeded charge of the expected amount inside the same time
 * window the Blobs matcher uses. On a hit, it BACK-FILLS the payment into
 * Blobs via recordPaidOrder() and returns that stored record — so:
 *   • create-booking.js can consumePaidOrder() it exactly like a
 *     webhook-sourced record (no special-casing downstream), and
 *   • a second booking attempt for the same charge finds it already in
 *     Blobs (and, once consumed, ignores it) — closing the double-spend hole
 *     that a webhook-less payment would otherwise open.
 *
 * Returns the stored record, or null if nothing matches / API unavailable.
 */
async function findPaidOrderViaCloverApi({ amountCents, atTime, windowMs }) {
  if (!CLOVER_PRIVATE_TOKEN) {
    console.warn('clover-api-fallback: CLOVER_PRIVATE_TOKEN not set — cannot query Clover. Skipping.');
    return null;
  }

  const ref = Number.isFinite(atTime) ? atTime : Date.now();
  // Only pull charges created within the match window (plus the same small
  // slack the window already implies). Clover's `created` filter takes ms
  // timestamps with gt/lte comparison operators.
  const sinceMs = ref - windowMs;
  const untilMs = ref + windowMs;

  const url = `${CLOVER_API_BASE}/v1/charges`
    + `?limit=${CLOVER_API_MAX_CHARGES}`
    + `&created.gt=${sinceMs}`
    + `&created.lte=${untilMs}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${CLOVER_PRIVATE_TOKEN}`,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('clover-api-fallback: charges request failed →', res.status, body.slice(0, 300));
    return null;
  }

  const json = await res.json();
  const charges = Array.isArray(json && json.data) ? json.data : [];
  console.log(`clover-api-fallback: pulled ${charges.length} charge(s) in window [${sinceMs}, ${untilMs}]`);

  // Find the best APPROVED, correct-amount charge closest in time to the
  // booking submission — same selection rule as the Blobs matcher.
  let best = null;
  for (const c of charges) {
    if (!c || typeof c !== 'object') continue;
    // A charge counts only if it actually succeeded and was paid — mirrors
    // the webhook's "APPROVED only" rule so a declined/failed attempt can
    // never satisfy a booking.
    const succeeded = c.status === 'succeeded' || c.paid === true;
    if (!succeeded) continue;
    if (Number(c.amount) !== amountCents) continue;
    // Clover `created` is Unix ms already.
    const created = Number(c.created);
    if (!Number.isFinite(created)) continue;
    if (Math.abs(created - ref) > windowMs) continue;
    if (!best || Math.abs(created - ref) < Math.abs(Number(best.created) - ref)) {
      best = c;
    }
  }

  if (!best) {
    console.log('clover-api-fallback: no matching approved charge found in window.');
    return null;
  }

  // Guard against re-recording a charge we already have (e.g. the webhook
  // did land for a prior booking and the record is sitting consumed in
  // Blobs). If it's already stored, defer to that record rather than
  // overwriting — never resurrect a consumed payment.
  const s = store();
  const existing = await s.get(best.id, { type: 'json' }).catch(() => null);
  if (existing) {
    if (existing.consumed) {
      console.log('clover-api-fallback: charge', best.id, 'already recorded AND consumed — not reusing.');
      return null;
    }
    console.log('clover-api-fallback: charge', best.id, 'already in Blobs (unconsumed) — using existing record.');
    return existing;
  }

  // Back-fill the record the webhook failed to write, keyed by Clover's own
  // payment id, so downstream consume/dedup works identically to the webhook
  // path.
  const record = await recordPaidOrder({
    paymentId:   best.id,
    orderRef:    null, // static Simple Pay Link carries no custom reference
    amountCents: Number(best.amount),
    raw: {
      source:      'clover-api-fallback',
      status:      best.status || null,
      paid:        best.paid === true,
      created:     best.created || null,
      ref_num:     best.ref_num || null,
      auth_code:   best.auth_code || null,
    },
  });
  console.log('clover-api-fallback: back-filled charge', record.paymentId, 'into Blobs from Clover API.');
  return record;
}

/**
 * Mark a paid-order record as consumed so it can't satisfy a second booking.
 * Called only after a booking has successfully been created. Uses the
 * paymentId (the store key) rather than re-searching, so it's a direct write.
 *
 * @param {string} paymentId
 * @param {string} [consumedBy]  booking identifier for the audit trail
 * @returns {Promise<object|null>} the updated record, or null if not found
 */
async function consumePaidOrder(paymentId, consumedBy = null) {
  if (!paymentId) throw new Error('consumePaidOrder: paymentId is required');
  const s = store();
  const rec = await s.get(paymentId, { type: 'json' });
  if (!rec) return null;

  rec.consumed = true;
  rec.consumedBy = consumedBy;
  await s.setJSON(paymentId, rec);
  return rec;
}

module.exports = {
  recordPaidOrder,
  findPaidOrder,
  consumePaidOrder,
  EXPECTED_DEPOSIT_CENTS,
  AMOUNT_MATCH_WINDOW_MIN,
  _STORE_NAME: STORE_NAME,
};
