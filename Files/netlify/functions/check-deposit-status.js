/**
 * GET /.netlify/functions/check-deposit-status?since=<epoch ms>
 *
 * Read-only status check the booking page polls after a customer clicks
 * "Pay $20 Deposit to Book." Lets the page auto-detect a completed payment
 * and submit the booking automatically — no more customers paying and then
 * forgetting to come back and tap Confirm.
 *
 * IMPORTANT: this never consumes a payment record. Consumption stays the
 * sole responsibility of create-booking.js, and only happens after a
 * calendar event is actually created — same single-consumption design as
 * everywhere else in this system. This function only ever reads.
 *
 * ── WHY "since" MATTERS ──
 * Wendy's Clover link is a static Simple Pay Link (Starter/Payments plan),
 * so there's no per-booking reference to match against — every customer's
 * $20 hits the same link. clover-store.js's amount+time fallback finds the
 * closest $20 payment to "now," which is normally fine, but for a live
 * polling loop that's not precise enough: if an older, still-unconsumed $20
 * payment happens to be sitting in the store (an abandoned checkout from
 * earlier, say), a customer who just clicked Pay a few seconds ago could
 * get a false "yes, you paid" before their own payment has even landed.
 *
 * So this function takes the "since" the caller clicked Pay, and only
 * reports paid:true if the matched record's createdAt is at or after that
 * moment (with a small grace window for clock skew). Anything older is
 * treated as not-yet-paid, and the frontend keeps polling.
 */

const { findPaidOrder, EXPECTED_DEPOSIT_CENTS } = require('./clover-store');

// Allows the matched payment to be up to this many ms *before* the client's
// reported "since" timestamp — covers normal clock drift between the
// customer's browser and this function's clock, not a loophole for stale
// payments. Kept small and deliberate.
const CLOCK_SKEW_GRACE_MS = 5000;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const params = event.queryStringParameters || {};
  const since = Number(params.since);

  if (!Number.isFinite(since) || since <= 0) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Missing or invalid "since" query parameter (expected epoch ms).' }),
    };
  }

  try {
    const rec = await findPaidOrder({ amountCents: EXPECTED_DEPOSIT_CENTS, atTime: Date.now() });

    const paid = !!(rec && rec.createdAt >= (since - CLOCK_SKEW_GRACE_MS));

    console.log(
      'check-deposit-status →',
      'since:', since,
      '| matched:', rec ? rec.paymentId : 'NONE',
      '| matchedCreatedAt:', rec ? rec.createdAt : null,
      '| paid:', paid
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ paid }),
    };
  } catch (err) {
    console.error('check-deposit-status: lookup failed:', err);
    // Fail closed (paid:false) — a storage hiccup should never falsely
    // report a payment that hasn't been confirmed. The frontend just keeps
    // polling and the manual checkbox fallback is always still there.
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ paid: false }),
    };
  }
};
