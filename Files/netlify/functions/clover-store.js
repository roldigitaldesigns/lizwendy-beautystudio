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

function store() {
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
    return best;
  }

  return null;
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
