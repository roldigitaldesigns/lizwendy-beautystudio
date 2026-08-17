/**
 * POST /.netlify/functions/clover-payment-webhook
 *
 * Receives payment notifications from Clover the moment a deposit payment
 * actually completes, and records confirmed payments in Netlify Blobs (via
 * clover-store.js) so create-booking.js can verify a real deposit was paid
 * before allowing a Wendy booking through.
 *
 * This is the ONLY trustworthy signal that a payment happened — it comes
 * from Clover itself, not from the customer clicking a checkbox.
 *
 * ── VERIFICATION (dual-scheme, both stubbed-safe until secrets are set) ──
 * Clover uses one of two verification schemes depending on which product the
 * payment link is built on. We don't yet know which one Wendy's account will
 * use, so this supports BOTH and picks based on which env var is populated:
 *
 *   1. Hosted Checkout  → "Clover-Signature" header, HMAC-SHA256 of
 *      "<timestamp>.<rawBody>" keyed with CLOVER_WEBHOOK_SECRET, compared
 *      against the v1=... value. (base64 digest.)
 *   2. App / Dev Dashboard → static "X-Clover-Auth" verification code,
 *      compared against CLOVER_VERIFICATION_CODE.
 *
 * SAFETY: until the relevant secret env var is set, verification runs in
 * LOG-ONLY mode — it computes and logs the result but does NOT reject the
 * request. This lets you complete Clover's webhook setup/verification
 * handshake without the function hard-failing. Once the secret is set,
 * set CLOVER_VERIFY_ENFORCE=true to switch to real rejection.
 *
 * Clover also sends an initial verification request during setup that
 * contains a "verificationCode" and no payment data — we echo/ack that
 * without trying to record a payment.
 */

const crypto = require('crypto');
const { recordPaidOrder, EXPECTED_DEPOSIT_CENTS } = require('./clover-store');

const WEBHOOK_SECRET      = process.env.CLOVER_WEBHOOK_SECRET;      // Hosted Checkout HMAC key
const VERIFICATION_CODE   = process.env.CLOVER_VERIFICATION_CODE;  // App/Dev static auth code
const ENFORCE_VERIFY      = String(process.env.CLOVER_VERIFY_ENFORCE || '').toLowerCase() === 'true';
const MERCHANT_ID         = process.env.CLOVER_MERCHANT_ID || null; // optional extra guard

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Clover-Signature, X-Clover-Auth',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Header names arrive lowercased in Netlify/Lambda event.headers.
  const h = event.headers || {};
  const rawBody = event.body || '';

  // ── Clover setup handshake ──
  // When you first register/verify the webhook URL, Clover sends a request
  // carrying a verificationCode (and no payment). Ack it so the handshake
  // completes; don't try to parse it as a payment.
  let payload;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch (e) {
    console.error('clover-webhook: body was not valid JSON:', rawBody.slice(0, 500));
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (payload.verificationCode) {
    console.log('clover-webhook: received setup verificationCode:', payload.verificationCode);
    return { statusCode: 200, headers, body: JSON.stringify({ verificationCode: payload.verificationCode }) };
  }

  // ── Verify authenticity ──
  const verify = verifyRequest({ headers: h, rawBody });
  console.log('clover-webhook: verification →', JSON.stringify(verify));
  if (ENFORCE_VERIFY && !verify.ok) {
    console.error('clover-webhook: REJECTED — verification failed while enforcing.');
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Signature verification failed' }) };
  }

  // ── Extract payment info (tolerant to the two payload shapes) ──
  const info = extractPayment(payload);
  console.log('clover-webhook: extracted →', JSON.stringify(info));

  // Optional merchant guard: if we know our merchant id and the payload
  // carries one that doesn't match, ignore it.
  if (MERCHANT_ID && info.merchantId && info.merchantId !== MERCHANT_ID) {
    console.warn('clover-webhook: merchant mismatch, ignoring. got', info.merchantId, 'want', MERCHANT_ID);
    return { statusCode: 200, headers, body: JSON.stringify({ ignored: 'merchant mismatch' }) };
  }

  // Only record APPROVED payments. Declines/refunds are logged but not stored
  // as valid deposits (this is exactly the case that bit us — a declined
  // Apple Pay attempt must NOT count as paid).
  if (info.status && info.status.toUpperCase() !== 'APPROVED') {
    console.log('clover-webhook: non-approved payment, not recording. status =', info.status);
    return { statusCode: 200, headers, body: JSON.stringify({ ignored: 'not approved', status: info.status }) };
  }

  if (!info.paymentId) {
    console.warn('clover-webhook: no payment id found in payload; acking without recording.');
    return { statusCode: 200, headers, body: JSON.stringify({ ignored: 'no payment id' }) };
  }

  try {
    const rec = await recordPaidOrder({
      paymentId:   info.paymentId,
      orderRef:    info.orderRef || null,   // present only if the link carried one
      amountCents: Number.isFinite(info.amountCents) ? info.amountCents : EXPECTED_DEPOSIT_CENTS,
      raw:         info.raw,
    });
    console.log('clover-webhook: recorded paid deposit', rec.paymentId, '| orderRef:', rec.orderRef, '| cents:', rec.amountCents);
    return { statusCode: 200, headers, body: JSON.stringify({ recorded: true, paymentId: rec.paymentId }) };
  } catch (err) {
    console.error('clover-webhook: failed to record payment:', err);
    // Return 200 anyway so Clover doesn't hammer retries forever on a
    // storage blip; the failure is logged for us to catch.
    return { statusCode: 200, headers, body: JSON.stringify({ recorded: false, error: 'store write failed' }) };
  }
};

/**
 * Verify the request really came from Clover.
 * Returns { ok, mode, reason } — never throws, so a malformed header can't
 * crash the handler; the caller decides whether to enforce.
 */
function verifyRequest({ headers, rawBody }) {
  // Scheme 1: Hosted Checkout HMAC signature.
  const sigHeader = headers['clover-signature'] || headers['Clover-Signature'];
  if (WEBHOOK_SECRET && sigHeader) {
    try {
      // Header form: "t=1642599079,v1=abcdef..."
      // Split each pair on the FIRST '=' only — the v1 value is base64 and
      // can itself end in '=' padding, which a naive split('=') would drop,
      // breaking verification of otherwise-valid signatures.
      const parts = Object.fromEntries(
        sigHeader.split(',').map(kv => {
          const i = kv.indexOf('=');
          const k = i === -1 ? kv : kv.slice(0, i);
          const v = i === -1 ? ''  : kv.slice(i + 1);
          return [k.trim(), v.trim()];
        })
      );
      const t  = parts.t;
      const v1 = parts.v1;
      if (!t || !v1) return { ok: false, mode: 'hmac', reason: 'missing t/v1 in header' };

      const signedPayload = `${t}.${rawBody}`;
      const expected = crypto
        .createHmac('sha256', WEBHOOK_SECRET)
        .update(signedPayload)
        .digest('base64');

      const ok = timingSafeEqualStr(expected, v1);
      return { ok, mode: 'hmac', reason: ok ? 'match' : 'digest mismatch' };
    } catch (e) {
      return { ok: false, mode: 'hmac', reason: 'error: ' + e.message };
    }
  }

  // Scheme 2: App/Dev Dashboard static auth code.
  const authHeader = headers['x-clover-auth'] || headers['X-Clover-Auth'];
  if (VERIFICATION_CODE && authHeader) {
    const ok = timingSafeEqualStr(VERIFICATION_CODE, authHeader);
    return { ok, mode: 'authcode', reason: ok ? 'match' : 'code mismatch' };
  }

  // No secret configured yet, or no recognizable header present.
  return {
    ok: false,
    mode: 'none',
    reason: WEBHOOK_SECRET || VERIFICATION_CODE
      ? 'no matching verification header on request'
      : 'no verification secret configured yet (log-only mode)',
  };
}

/**
 * Pull the fields we care about out of Clover's payload, tolerant to the
 * two documented shapes (Hosted Checkout vs App webhook). Anything not found
 * comes back undefined/null so the caller can decide how to handle it.
 */
function extractPayment(payload) {
  const raw = payload || {};

  // Hosted Checkout shape (flat-ish):
  //   { type:'PAYMENT', status:'APPROVED', id:<paymentUUID>,
  //     merchantId:<uuid>, amount:<cents>, data:<checkoutSessionUUID>, ... }
  // App webhook shape (nested under merchant → type arrays), less common for
  // a hosted deposit link, but we defensively check a couple of spots.
  const status =
    raw.status ||
    raw.Status ||
    (raw.payment && raw.payment.status) ||
    null;

  const paymentId =
    raw.id ||
    raw.Id ||
    raw.paymentId ||
    (raw.payment && raw.payment.id) ||
    null;

  const merchantId =
    raw.merchantId ||
    raw.MerchantId ||
    (raw.merchant && raw.merchant.id) ||
    null;

  // Amount is in cents in Clover. Try the common spots.
  let amountCents =
    raw.amount ??
    (raw.payment && raw.payment.amount) ??
    (raw.data && raw.data.amount) ??
    undefined;
  if (typeof amountCents === 'string') amountCents = parseInt(amountCents, 10);

  // Our custom reference, IF the link supported one. Clover surfaces custom
  // data differently per product; check the likely carriers. Static Simple
  // Pay Links won't have any of these — that's the amount+time fallback case.
  const orderRef =
    raw.orderRef ||
    raw.reference ||
    raw.note ||
    (raw.metadata && (raw.metadata.orderRef || raw.metadata.reference)) ||
    (raw.data && (raw.data.orderRef || raw.data.reference || raw.data.note)) ||
    null;

  return {
    status,
    paymentId,
    merchantId,
    amountCents,
    orderRef,
    // Keep a trimmed slice for the audit trail without storing the entire blob.
    raw: {
      type:       raw.type || raw.Type || null,
      status,
      id:         paymentId,
      merchantId,
      amount:     amountCents,
      createdTime: raw.createdTime || raw.created || null,
    },
  };
}

/** Constant-time string comparison that won't throw on length mismatch. */
function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
