/**
 * sweep-pending-bookings.js
 *
 * PHASE 3 — ACTIVE RESCUE MODE.
 *
 * A Netlify Scheduled Function (see exports.config) that runs automatically
 * every 5 minutes with no browser involved. It completes bookings that the
 * normal browser flow failed to finish — the core of the Risk #1 safety net
 * (customer pays, then closes their browser before the booking completes).
 *
 * ── HOW A RESCUE WORKS ──
 * For each pending appointment (saved by save-pending-booking.js) that is
 * older than RESCUE_DELAY_MIN and has a matching, unconsumed $20 payment in
 * Clover, this function calls the REAL create-booking endpoint over HTTP —
 * exactly like the browser does — passing atTimeOverride so the deposit
 * lookup anchors to when the customer actually paid, not "now."
 *
 * Reusing create-booking (rather than re-implementing calendar writes,
 * slot checks, consume, and emails here) means a rescued booking is
 * byte-for-byte identical to a normal one, and there is only ONE
 * booking-creation code path to trust.
 *
 * On a successful rescue it:
 *   - marks the pending record "completed" (so it's never rescued twice)
 *   - emails Ramon a "booking rescued" notice with full details
 *
 * ── DOUBLE-BOOKING SAFETY ──
 * create-booking consumes the payment on success. If the browser ALSO
 * completes the same booking, whichever runs second finds the payment
 * already consumed and the deposit gate blocks the duplicate (402). Marking
 * the pending record "completed" is a second layer on top. This is why no
 * extra pending-record lock is needed (confirmed design decision).
 *
 * ── WHAT PHASE 3 DOES NOT DO (that's Phase 4) ──
 * The "slot got taken while payment was stuck" conflict case, the customer
 * "please pick a new time" email, and the "something went wrong" alert are
 * Phase 4. Here, a failed rescue is simply logged and the pending record is
 * left untouched so the next sweep retries.
 */

const { listPending, setPendingStatus, markConflict, PENDING_TTL_MIN } = require('./pending-store');
const { findPaidOrder, EXPECTED_DEPOSIT_CENTS } = require('./clover-store');

const RESCUE_DELAY_MIN = 5;

// Where to POST rescue bookings — the real create-booking endpoint. Uses
// the site's own URL so it hits the deployed function exactly like a
// browser would. URL env var lets it work across environments; falls back
// to the known production URL.
const SITE_URL = process.env.URL
  || process.env.DEPLOY_PRIME_URL
  || 'https://lizwendybeautystudiollc.com';
const CREATE_BOOKING_URL = SITE_URL + '/.netlify/functions/create-booking';

// EmailJS (same account/keys the rest of the system uses). The rescue
// notice uses its OWN dedicated template — deliberately separate from
// EMAILJS_TEMPLATE_STUDIO (Wendy's appointment notifications) so editing
// one can never affect the other.
const EMAILJS_SERVICE_ID      = process.env.EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_RESCUE = process.env.EMAILJS_TEMPLATE_RESCUE;
const EMAILJS_TEMPLATE_CONFLICT = process.env.EMAILJS_TEMPLATE_CONFLICT;
const EMAILJS_PUBLIC_KEY      = process.env.EMAILJS_PUBLIC_KEY;
const EMAILJS_PRIVATE_KEY     = process.env.EMAILJS_PRIVATE_KEY;
const NOTIFY_EMAIL            = process.env.STUDIO_EMAIL; // ramonlopez30798@gmail.com

// Base site URL, reused for building the customer's resume link.
const RESUME_WINDOW_MIN = 120; // 2-hour cutoff (enforced by resume endpoint in 4b)

exports.handler = async () => {
  const startedAt = Date.now();
  const pendingRecords = await listPending();

  const summary = {
    examined:     0,
    tooNew:       0,
    rescued:      [],
    rescueFailed: [],
    conflicts:    [],
    stale:        [],
    stillWaiting: 0,
    unexpected:   [],
  };

  for (const rec of pendingRecords) {
    if (rec.status !== 'pending') continue;
    summary.examined++;

    const ageMin = (Date.now() - rec.createdAt) / 60000;

    const artistId = rec.booking.artist === 'Johanna' ? 'johanna' : 'liz';
    if (artistId !== 'liz') {
      summary.unexpected.push({ pendingId: rec.pendingId, artist: rec.booking.artist });
      console.warn('sweep: unexpected non-deposit pending record', rec.pendingId, '(artist:', rec.booking.artist, ')');
      continue;
    }

    if (ageMin < RESCUE_DELAY_MIN) { summary.tooNew++; continue; }

    // Same lookup used everywhere else, anchored to when the customer paid.
    let match = null;
    try {
      match = await findPaidOrder({ amountCents: EXPECTED_DEPOSIT_CENTS, atTime: rec.createdAt });
    } catch (e) {
      console.error('sweep: findPaidOrder failed for', rec.pendingId, e && e.message);
      summary.stillWaiting++;
      continue; // transient — retry next sweep
    }

    if (!match) {
      if (ageMin >= PENDING_TTL_MIN) {
        summary.stale.push({ pendingId: rec.pendingId, customer: fullName(rec), ageMin: Math.round(ageMin) });
        console.log('sweep: STALE — no payment ever showed up →', rec.pendingId);
        // Phase 3 does not expire/delete; leave for a later cleanup phase.
      } else {
        summary.stillWaiting++;
      }
      continue;
    }

    // ── MATCH FOUND → attempt the rescue via the real create-booking ──
    const b = rec.booking;
    const bookingPayload = {
      firstName: b.firstName,
      lastName:  b.lastName,
      email:     b.email,
      phone:     b.phone,
      notes:     b.notes,
      date:      b.date,
      time:      b.time,
      services:  b.services,
      total:     b.total,
      artist:    b.artist,
      durationMinutes: b.durationMinutes,
      // Anchor the deposit lookup to when the customer actually paid, so a
      // delayed rescue still reconfirms the payment inside create-booking.
      atTimeOverride: rec.createdAt,
    };

    try {
      const res = await fetch(CREATE_BOOKING_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bookingPayload),
      });

      if (res.ok) {
        // Booking created (and payment consumed) by create-booking itself.
        await setPendingStatus(rec.pendingId, 'completed');
        const info = {
          pendingId: rec.pendingId,
          customer:  fullName(rec),
          artist:    b.artist,
          date:      b.date,
          time:      b.time,
          paymentId: match.paymentId,
        };
        summary.rescued.push(info);
        console.log('sweep: RESCUED booking ->', JSON.stringify(info));
        await sendRescueNotice(rec, match).catch(err =>
          console.error('sweep: rescue succeeded but notice email failed (booking is fine):', err && err.message)
        );
      } else if (res.status === 409) {
        // GENUINE SLOT CONFLICT — the time was taken while the payment was
        // stuck. Retrying can never succeed, so this is permanently done:
        // mark it "conflict" (storing the exact payment id + timestamp for
        // the resume flow), email the customer their resume link, and alert
        // Ramon. Every OTHER failure type falls through to the retry branch.
        await markConflict(rec.pendingId, match.paymentId);
        const info = {
          pendingId: rec.pendingId,
          customer:  fullName(rec),
          artist:    b.artist,
          date:      b.date,
          time:      b.time,
          paymentId: match.paymentId,
        };
        summary.conflicts.push(info);
        console.log('sweep: SLOT CONFLICT (permanent) ->', JSON.stringify(info));

        // Email the customer their "pick a new time" resume link.
        await sendConflictCustomerEmail(rec).catch(err =>
          console.error('sweep: conflict flagged but customer email failed:', err && err.message)
        );
        // Alert Ramon that a conflict occurred (reuses the rescue template).
        await sendConflictAlert(rec, match).catch(err =>
          console.error('sweep: conflict flagged but Ramon alert failed:', err && err.message)
        );
      } else {
        // Any other failure (402 deposit reconfirm, 400, 500, etc.). Leave
        // the pending record untouched so the next sweep retries.
        const errBody = await res.text().catch(() => '');
        summary.rescueFailed.push({ pendingId: rec.pendingId, status: res.status });
        console.warn('sweep: rescue attempt failed for', rec.pendingId, '-> status', res.status, errBody.slice(0, 200));
      }
    } catch (err) {
      // Network/transient error calling create-booking. Leave untouched; retry.
      summary.rescueFailed.push({ pendingId: rec.pendingId, error: err && err.message });
      console.error('sweep: rescue call threw for', rec.pendingId, '(will retry next sweep):', err && err.message);
    }
  }

  console.log(
    'sweep summary:',
    'examined=' + summary.examined,
    'tooNew=' + summary.tooNew,
    'rescued=' + summary.rescued.length,
    'rescueFailed=' + summary.rescueFailed.length,
    'conflicts=' + summary.conflicts.length,
    'stale=' + summary.stale.length,
    'stillWaiting=' + summary.stillWaiting,
    'unexpected=' + summary.unexpected.length,
    'durationMs=' + (Date.now() - startedAt)
  );

  return { statusCode: 200, body: JSON.stringify(summary) };
};

function fullName(rec) {
  return (rec.booking.firstName + ' ' + rec.booking.lastName).trim();
}

/**
 * Email Ramon that a booking was auto-rescued. Reuses the existing STUDIO
 * EmailJS template (no new template needed) with override subject/intro
 * making clear this was completed by the background system, not the normal
 * flow. Best-effort: a failure here never undoes the (already created)
 * booking.
 */
async function sendRescueNotice(rec, match) {
  if (!EMAILJS_SERVICE_ID || !NOTIFY_EMAIL) {
    console.warn('sweep: EmailJS/notify env not configured — skipping rescue notice.');
    return;
  }
  const b = rec.booking;
  const serviceList = (b.services || []).map(function (s) { return (typeof s === 'string' ? s : s.name); }).join(', ');
  const totalStr = '$' + Number(b.total || 0).toFixed(2);

  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id:  EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_RESCUE,
      user_id:     EMAILJS_PUBLIC_KEY,
      accessToken: EMAILJS_PRIVATE_KEY,
      template_params: {
        to_email:         NOTIFY_EMAIL,
        subject_override: '\u2699\ufe0f Booking auto-rescued \u2014 ' + b.date + ' at ' + b.time,
        intro_override:
          "Heads up: the background system automatically completed a booking that the customer's browser did not finish.\n\n" +
          'Customer: ' + fullName(rec) + '\n' +
          'Phone: ' + (b.phone || '(none)') + '\n' +
          'Email: ' + (b.email || '(none)') + '\n' +
          'Service: ' + serviceList + '\n' +
          'Artist: ' + b.artist + '\n' +
          'Date/Time: ' + b.date + ' at ' + b.time + '\n' +
          'Clover payment: ' + match.paymentId + '\n\n' +
          'The appointment is on the calendar and the customer has been sent their normal confirmation. No action needed unless something looks off.',
        first_name:    b.firstName,
        customer_name: fullName(rec),
        phone:         b.phone || '',
        email:         b.email || '',
        date:          b.date,
        time:          b.time,
        services:      serviceList,
        total:         totalStr,
        artist_name:   b.artist,
        cc:            '',
      },
    }),
  });
  const text = await res.text();
  console.log('sweep: rescue notice email -> status', res.status, text.slice(0, 120));
}

/**
 * Email the CUSTOMER their "please pick a new time" message with a resume
 * link. Uses the dedicated conflict template (separate from every other
 * template). The resume link carries the pendingId so Phase 4b can reopen
 * their booking with the original payment already attached — no re-payment.
 * The 2-hour window is enforced by the resume endpoint, not here.
 */
async function sendConflictCustomerEmail(rec) {
  if (!EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_CONFLICT) {
    console.warn('sweep: conflict template not configured — skipping customer email.');
    return;
  }
  const b = rec.booking;
  if (!b.email) {
    console.warn('sweep: conflict but customer has no email on file — cannot send resume link. pendingId', rec.pendingId);
    return;
  }
  const resumeLink = SITE_URL + '/?resume=' + rec.pendingId;

  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id:  EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_CONFLICT,
      user_id:     EMAILJS_PUBLIC_KEY,
      accessToken: EMAILJS_PRIVATE_KEY,
      template_params: {
        to_email:         b.email,
        first_name:       b.firstName || 'there',
        subject_override: 'We need you to pick a new time \u2014 ' + b.date,
        intro_override:
          'There was an issue completing your appointment booking for ' + b.date + ' at ' + b.time +
          ' with ' + b.artist + '. Your $20 deposit payment was received, but unfortunately that specific ' +
          'time slot is no longer available.\n\n' +
          'Please pick a new time here (your deposit is already applied \u2014 no additional payment needed):\n' +
          resumeLink + '\n\n' +
          'This link is valid for the next 2 hours. After that, just contact us directly and we\u2019ll help you reschedule.',
        date:        b.date,
        time:        b.time,
        artist_name: b.artist,
      },
    }),
  });
  const text = await res.text();
  console.log('sweep: conflict customer email -> status', res.status, text.slice(0, 120));
}

/**
 * Alert Ramon that a slot conflict happened. Reuses the RESCUE template
 * (the "to me" notification shell) with conflict-specific wording.
 */
async function sendConflictAlert(rec, match) {
  if (!EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_RESCUE || !NOTIFY_EMAIL) {
    console.warn('sweep: rescue/alert template not configured — skipping Ramon conflict alert.');
    return;
  }
  const b = rec.booking;
  const serviceList = (b.services || []).map(function (s) { return (typeof s === 'string' ? s : s.name); }).join(', ');

  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id:  EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_RESCUE,
      user_id:     EMAILJS_PUBLIC_KEY,
      accessToken: EMAILJS_PRIVATE_KEY,
      template_params: {
        to_email:         NOTIFY_EMAIL,
        subject_override: '\u26a0\ufe0f Booking conflict \u2014 customer must reschedule (' + b.date + ')',
        intro_override:
          'A paid booking could not be completed because the time slot was already taken.\n\n' +
          'Customer: ' + fullName(rec) + '\n' +
          'Phone: ' + (b.phone || '(none)') + '\n' +
          'Email: ' + (b.email || '(none)') + '\n' +
          'Service: ' + serviceList + '\n' +
          'Artist: ' + b.artist + '\n' +
          'Conflicted slot: ' + b.date + ' at ' + b.time + '\n' +
          'Clover payment: ' + match.paymentId + '\n\n' +
          'The customer has been emailed a resume link to pick a new time (valid 2 hours), with their deposit already applied. ' +
          (b.email ? 'No action needed unless they contact you.' : 'NOTE: no email on file for this customer — you may need to reach them by phone.'),
        customer_name: fullName(rec),
        phone:         b.phone || '',
        email:         b.email || '',
        date:          b.date,
        time:          b.time,
        services:      serviceList,
        artist_name:   b.artist,
      },
    }),
  });
  const text = await res.text();
  console.log('sweep: conflict alert (to Ramon) -> status', res.status, text.slice(0, 120));
}

exports.config = {
  schedule: '*/5 * * * *',
};
