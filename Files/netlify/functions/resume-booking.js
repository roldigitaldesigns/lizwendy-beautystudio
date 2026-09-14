/**
 * resume-booking.js
 *
 * PHASE 4b — the customer-facing "pick a new time" resume flow.
 *
 * When a paid booking hits a slot conflict, the sweep (Phase 4a) marks the
 * pending record "conflict", attaches the exact Clover payment id, stamps
 * conflictAt, and emails the customer a link: /?resume=<pendingId>. This
 * endpoint powers that link.
 *
 * ── TWO MODES ──
 *  GET  ?pendingId=X   → validate the link and return safe display context
 *                        so the page can show "Rebooking for <name> —
 *                        <service> with <artist>". Rejects expired,
 *                        already-used, or unknown links with a clear reason.
 *
 *  POST { pendingId, date, time }
 *                      → re-submit the booking at the customer's newly
 *                        chosen date/time, reusing the ORIGINAL payment (no
 *                        re-charge). Calls the real create-booking with
 *                        knownPaymentId so there's one booking code path.
 *
 * ── 2-HOUR WINDOW ──
 * The resume link is valid for RESUME_WINDOW_MIN after conflictAt. Enforced
 * on BOTH GET and POST (never trust a stale page). A genuine POST attempt
 * past the window alerts Ramon (visibility on anything going wrong).
 *
 * ── SINGLE-USE ──
 * A successful resume marks the record "completed" so the link can't book
 * twice. A failed attempt (e.g. the new time is ALSO taken) leaves it
 * "conflict" so the customer can pick yet another time within the window.
 */

const { getPending, setPendingStatus } = require('./pending-store');

const RESUME_WINDOW_MIN = 120; // 2 hours

const SITE_URL = process.env.URL
  || process.env.DEPLOY_PRIME_URL
  || 'https://lizwendybeautystudiollc.com';
const CREATE_BOOKING_URL = SITE_URL + '/.netlify/functions/create-booking';

// EmailJS — only used for the "expired link attempt" alert to Ramon,
// reusing the rescue/alert template (the "to me" shell).
const EMAILJS_SERVICE_ID      = process.env.EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_RESCUE = process.env.EMAILJS_TEMPLATE_RESCUE;
const EMAILJS_PUBLIC_KEY      = process.env.EMAILJS_PUBLIC_KEY;
const EMAILJS_PRIVATE_KEY     = process.env.EMAILJS_PRIVATE_KEY;
const NOTIFY_EMAIL            = process.env.STUDIO_EMAIL;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  if (event.httpMethod === 'GET')  return handleValidate(event);
  if (event.httpMethod === 'POST') return handleResume(event);

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
};

/* ── GET: validate the link, return display context ─────────────────── */
async function handleValidate(event) {
  const pendingId = event.queryStringParameters && event.queryStringParameters.pendingId;
  if (!pendingId) {
    return reject('missing', 'This link is missing its booking reference.');
  }

  const rec = await getPending(pendingId).catch(() => null);
  if (!rec) {
    return reject('not_found', 'We couldn\u2019t find this booking. Please contact us directly and we\u2019ll help you reschedule.');
  }
  if (rec.status === 'completed') {
    return reject('already_used', 'This booking has already been rescheduled. If that wasn\u2019t you, please contact us.');
  }
  if (rec.status !== 'conflict') {
    // Only a conflicted record is resumable. Anything else (still pending,
    // etc.) shouldn't be reachable via a resume link.
    return reject('not_resumable', 'This link isn\u2019t active. Please contact us directly and we\u2019ll help you reschedule.');
  }
  if (isExpired(rec)) {
    return reject('expired', 'This reschedule link has expired. Please contact us directly and we\u2019ll apply your deposit to a new appointment.');
  }

  const b = rec.booking;
  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      // Safe display context only — no payment ids or internals.
      firstName:       b.firstName || '',
      artist:          b.artist || '',
      services:        b.services || [],
      durationMinutes: b.durationMinutes || 60,
      originalDate:    b.date || '',
      originalTime:    b.time || '',
      minutesLeft:     minutesLeft(rec),
    }),
  };
}

/* ── POST: complete the rebooking at the new date/time ──────────────── */
async function handleResume(event) {
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid request.' }) }; }

  const { pendingId, date, time } = body;
  if (!pendingId || !date || !time) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Please choose a new date and time.' }) };
  }

  const rec = await getPending(pendingId).catch(() => null);
  if (!rec)                     return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Booking not found.', code: 'not_found' }) };
  if (rec.status === 'completed') return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: 'This booking was already rescheduled.', code: 'already_used' }) };
  if (rec.status !== 'conflict')  return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: 'This link is not active.', code: 'not_resumable' }) };

  if (isExpired(rec)) {
    // A real attempt past the window — alert Ramon, since it means a paid
    // customer is trying to rebook and can no longer self-serve.
    await sendExpiredAlert(rec).catch(err => console.error('resume: expired alert failed:', err && err.message));
    return { statusCode: 410, headers: CORS, body: JSON.stringify({
      error: 'This reschedule link has expired. Please contact us directly \u2014 your deposit is safe and we\u2019ll apply it to your new appointment.',
      code: 'expired',
    }) };
  }

  const b = rec.booking;
  if (!rec.paymentId) {
    // Shouldn't happen (4a always attaches it), but never guess a payment.
    console.error('resume: conflict record has no paymentId — cannot resume safely.', pendingId);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'We couldn\u2019t verify your deposit automatically. Please contact us directly.', code: 'no_payment' }) };
  }

  // Re-submit through the REAL create-booking, at the NEW date/time, reusing
  // the ORIGINAL payment exactly (knownPaymentId → exact lookup, no re-charge).
  const payload = {
    firstName: b.firstName,
    lastName:  b.lastName,
    email:     b.email,
    phone:     b.phone,
    notes:     b.notes,
    date:      date,   // customer's NEW choice
    time:      time,   // customer's NEW choice
    services:  b.services,
    total:     b.total,
    artist:    b.artist,
    durationMinutes: b.durationMinutes,
    knownPaymentId:  rec.paymentId,
  };

  let res;
  try {
    res = await fetch(CREATE_BOOKING_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('resume: create-booking call failed:', err && err.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Something went wrong on our end. Please try again in a moment.', code: 'network' }) };
  }

  if (res.ok) {
    // Single-use: mark completed so the link can't book twice.
    await setPendingStatus(pendingId, 'completed').catch(err => console.error('resume: could not mark completed (booking is fine):', err && err.message));
    console.log('resume: rebooked', pendingId, '->', date, time);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, message: 'Appointment confirmed' }) };
  }

  if (res.status === 409) {
    // The NEW time is also taken. Leave status "conflict" so they can try
    // yet another time within the window — do NOT consume the link.
    return { statusCode: 409, headers: CORS, body: JSON.stringify({
      error: 'That time was just taken too. Please choose another available time.',
      code: 'slot_taken',
    }) };
  }

  // Any other create-booking failure (402/400/500). Leave record resumable.
  const errText = await res.text().catch(() => '');
  console.warn('resume: create-booking returned', res.status, errText.slice(0, 200));
  return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'We couldn\u2019t complete your booking. Please try again or contact us directly.', code: 'create_failed' }) };
}

/* ── helpers ────────────────────────────────────────────────────────── */
function isExpired(rec) {
  const base = rec.conflictAt || rec.createdAt || 0;
  return (Date.now() - base) > RESUME_WINDOW_MIN * 60 * 1000;
}
function minutesLeft(rec) {
  const base = rec.conflictAt || rec.createdAt || 0;
  const left = RESUME_WINDOW_MIN - Math.floor((Date.now() - base) / 60000);
  return Math.max(0, left);
}
function reject(code, message) {
  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, code, message }) };
}

async function sendExpiredAlert(rec) {
  if (!EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_RESCUE || !NOTIFY_EMAIL) return;
  const b = rec.booking;
  await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id:  EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_RESCUE,
      user_id:     EMAILJS_PUBLIC_KEY,
      accessToken: EMAILJS_PRIVATE_KEY,
      template_params: {
        to_email:         NOTIFY_EMAIL,
        subject_override: '\u23f0 Expired reschedule link used \u2014 customer needs help',
        intro_override:
          'A customer tried to reschedule a paid booking after their 2-hour link expired. They need manual help.\n\n' +
          'Customer: ' + ((b.firstName || '') + ' ' + (b.lastName || '')).trim() + '\n' +
          'Phone: ' + (b.phone || '(none)') + '\n' +
          'Email: ' + (b.email || '(none)') + '\n' +
          'Original slot: ' + b.date + ' at ' + b.time + '\n' +
          'Clover payment: ' + (rec.paymentId || '(unknown)') + '\n\n' +
          'Their deposit is still valid \u2014 please reach out and help them pick a new time.',
        customer_name: ((b.firstName || '') + ' ' + (b.lastName || '')).trim(),
        phone: b.phone || '', email: b.email || '',
        date: b.date, time: b.time, artist_name: b.artist,
      },
    }),
  });
}
