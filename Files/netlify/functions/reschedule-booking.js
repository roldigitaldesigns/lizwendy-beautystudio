/**
 * POST /.netlify/functions/reschedule-booking
 *
 * Self-serve reschedule flow, driven by cancel.html's "Churn Deflector" UI.
 * Moves an existing appointment to a new date/time WITHOUT the customer
 * having to cancel and rebook from scratch.
 *
 * Body (JSON):
 * {
 *   action: "reschedule",   // reserved for future multi-action parity
 *   token,                  // 32-hex cancel/reschedule token from the booking
 *   artistId,               // "liz" | "johanna" (short id, as in cancel links)
 *   newDate: "YYYY-MM-DD",
 *   newTime: "HH:MM",       // 30-min granularity ("09:00" / "09:30")
 *   lang                    // "en" | "es" (email copy routing)
 * }
 *
 * ── SAFETY MODEL (why the ordering is what it is) ──
 * The single most important rule here: CREATE the new event BEFORE deleting
 * the old one. If the create fails (slot taken, calendar error), the customer
 * still has their original appointment untouched — a failed reschedule must
 * never destroy an existing booking. Only once the new event is safely on the
 * calendar do we delete the old one.
 *
 * ── 24-HOUR GATE ──
 * Rescheduling is refused within 24 hours of the CURRENT appointment start.
 * This is enforced here on the backend (the authoritative gate); cancel.html
 * also hides the reschedule UI early using appointmentStart from the lookup,
 * but a bypassed frontend can't defeat this check.
 *
 * ── DURATION ──
 * The rescheduled appointment keeps the SAME duration as the original. That
 * duration is derived from the old event's real start/end timestamps, then
 * (for Wendy only) re-rounded UP to the nearest whole hour against the new
 * start — exactly matching create-booking.js's hourly-grid rule, so a
 * rescheduled Wendy booking behaves identically to a fresh one. Johanna keeps
 * her exact duration (30-min grid).
 *
 * ── DENIAL OF DEPOSIT LOGIC ──
 * There is intentionally no deposit/payment logic here — neither artist takes
 * payment through the site anymore (matches create-booking.js).
 */

const { google } = require('googleapis');
const crypto = require('crypto');
const { recordLedgerEvent, toE164, parseCents } = require('./_lib/ledger');

const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY  = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const STUDIO_EMAIL  = process.env.STUDIO_EMAIL;
const JOHANNA_EMAIL = process.env.JOHANNA_EMAIL;

const EMAILJS_SERVICE_ID        = process.env.EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_CUSTOMER = process.env.EMAILJS_TEMPLATE_CUSTOMER;
const EMAILJS_PUBLIC_KEY        = process.env.EMAILJS_PUBLIC_KEY;
const EMAILJS_PRIVATE_KEY       = process.env.EMAILJS_PRIVATE_KEY;

const SITE_URL = process.env.SITE_URL || 'https://lizwendybeautystudiollc.com';

// Short artistId → calendar. Matches get-availability.js / cancel-booking.js.
const CALENDAR_IDS = {
  liz:     process.env.GOOGLE_CALENDAR_ID,
  johanna: process.env.JOHANNA_CALENDAR_ID,
};

// Short artistId → the full artist name stored on the event / shown to users.
const ARTIST_NAMES = {
  liz:     'Liz Wendy Cedeño',
  johanna: 'Johanna',
};

// Short artistId → calendar color (mirrors create-booking.js CALENDAR_COLORS).
// 5 = Banana (yellow), 11 = Tomato (red).
const CALENDAR_COLORS = {
  liz:     '11',
  johanna: '5',
};

// Short artistId → notification inbox. Wendy is CC'd on Johanna's, matching
// the booking/cancellation notification pattern.
const ARTIST_EMAILS = {
  liz:     STUDIO_EMAIL,
  johanna: JOHANNA_EMAIL,
};

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

// Reschedule is refused within this many ms of the current appointment start.
const RESCHEDULE_CUTOFF_MS = 24 * 60 * 60 * 1000; // 24 hours

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // POST-only, mirroring cancel-booking's anti-auto-click safety. A reschedule
  // is a state change and must never be triggerable by a GET link preview.
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const data = JSON.parse(event.body || '{}');
    const { token, artistId, newDate, newTime, lang } = data;

    // ── VALIDATION ──
    if (!token || !/^[a-f0-9]{32}$/.test(token)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid_link' }) };
    }
    const CALENDAR_ID = CALENDAR_IDS[artistId];
    if (!CALENDAR_ID) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid_link' }) };
    }
    if (!newDate || !/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid_date' }) };
    }
    if (!newTime || !/^\d{2}:\d{2}$/.test(newTime)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid_time' }) };
    }

    // ── AUTH ──
    const auth = new google.auth.JWT({
      email:  CLIENT_EMAIL,
      key:    PRIVATE_KEY,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    const calendar = google.calendar({ version: 'v3', auth });

    // ── FIND THE EXISTING BOOKING BY TOKEN ──
    // Same privateExtendedProperty lookup as cancel-booking.js: matches at
    // most one event, bounded to "yesterday onward".
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const found = await calendar.events.list({
      calendarId: CALENDAR_ID,
      privateExtendedProperty: `cancelToken=${token}`,
      timeMin: dayAgo.toISOString(),
      singleEvents: true,
      maxResults: 1,
    });

    const oldEvent = found.data.items && found.data.items[0];
    if (!oldEvent) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'not_found' }) };
    }

    // ── 24-HOUR GATE (authoritative) ──
    // Uses the old event's real start timestamp, not a human-readable string.
    const oldStart = oldEvent.start && oldEvent.start.dateTime
      ? new Date(oldEvent.start.dateTime)
      : null;
    if (!oldStart || isNaN(oldStart.getTime())) {
      // No usable timed start (e.g. an all-day/edge event) — refuse rather
      // than guess.
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'not_reschedulable' }) };
    }
    if (oldStart.getTime() - Date.now() < RESCHEDULE_CUTOFF_MS) {
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({
          error: 'too_late',
          message: 'Rescheduling is only available more than 24 hours before your appointment.',
        }),
      };
    }

    // ── PRESERVE ORIGINAL DURATION ──
    // Derive the original appointment length from the old event's real
    // start/end, so the rescheduled event is exactly as long as before.
    const oldEnd = oldEvent.end && oldEvent.end.dateTime ? new Date(oldEvent.end.dateTime) : null;
    const originalDurationMin = (oldEnd && !isNaN(oldEnd.getTime()))
      ? Math.max(30, Math.round((oldEnd.getTime() - oldStart.getTime()) / 60000))
      : 60; // safe fallback if end is somehow missing

    // ── BUILD THE NEW EVENT TIMES ──
    // Preserve the existing hardcoded -04:00 convention used across the
    // codebase (create-booking.js / get-availability.js). NOTE: this shares
    // the known DST limitation flagged for the October fix — kept identical
    // here on purpose so reschedule and fresh bookings behave the same until
    // that fix lands in one coordinated pass.
    const [slotH, slotM = 0] = newTime.split(':').map(Number);
    const newStart = new Date(`${newDate}T${String(slotH).padStart(2,'0')}:${String(slotM).padStart(2,'0')}:00-04:00`);

    // Per-artist rounding: Wendy → whole-hour block, Johanna → exact. Matches
    // create-booking.js exactly.
    const roundedDuration = artistId === 'liz'
      ? Math.ceil(originalDurationMin / 60) * 60
      : originalDurationMin;
    const newEnd = new Date(newStart.getTime() + roundedDuration * 60 * 1000);

    // ── CHECK THE NEW SLOT IS FREE ──
    // Excludes the old event itself from the conflict check (it may sit in the
    // window if someone reschedules to an adjacent time on the same day).
    const existing = await calendar.events.list({
      calendarId:   CALENDAR_ID,
      timeMin:      newStart.toISOString(),
      timeMax:      newEnd.toISOString(),
      singleEvents: true,
    });
    const conflict = (existing.data.items || []).some(ev => ev.id !== oldEvent.id);
    if (conflict) {
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({ error: 'slot_taken', message: 'That time was just booked. Please choose another.' }),
      };
    }

    // ── CARRY OVER BOOKING DETAILS FROM THE OLD EVENT ──
    const props = (oldEvent.extendedProperties && oldEvent.extendedProperties.private) || {};
    const firstName     = props.customerFirst || '';
    const customerEmail = props.customerEmail || '';
    const customerPhone = props.customerPhone || '';
    const artistName    = props.artistName    || ARTIST_NAMES[artistId] || 'Liz Wendy Cedeño';
    const serviceList   = props.serviceList   || '';

    // ── Command Center ledger identity ──
    // ledgerRef is stable across reschedules (each reschedule mints a new
    // cancel token, but the ledger must keep ONE booking). Bookings made
    // before the ledger existed have no ledgerRef, so their current token
    // becomes it — and is carried forward from here on.
    const ledgerRef  = props.ledgerRef || token;
    const priceCents = parseCents(props.priceCents); // null for pre-ledger bookings

    // Human-readable strings for the NEW date/time.
    const dateObj      = new Date(newDate + 'T12:00:00');
    const dateReadable = `${DAYS[dateObj.getDay()]}, ${MONTHS[dateObj.getMonth()]} ${dateObj.getDate()}, ${dateObj.getFullYear()}`;
    const timeReadable = formatTime(newTime);

    // Human-readable OLD date/time for the artist notice ("moved from → to").
    const oldDateReadable = props.dateReadable || '';
    const oldTimeReadable = props.timeReadable || '';

    // ── NEW CANCEL/RESCHEDULE TOKEN ──
    // A fresh token for the new event so its own cancel/reschedule link is
    // valid and the old token stops resolving once the old event is deleted.
    const newToken   = crypto.randomBytes(16).toString('hex');
    const manageUrl  = `${SITE_URL}/cancel.html?token=${newToken}&artist=${artistId}`;

    // ── 1. CREATE THE NEW EVENT (before deleting the old — see safety model) ──
    const newCalEvent = {
      summary: oldEvent.summary || `💅 ${firstName} — ${serviceList}`,
      description: [
        `Client: ${firstName}`,
        customerEmail ? `Email: ${customerEmail}` : `Email: (not provided — phone booking)`,
        `Phone: ${customerPhone}`,
        `Services: ${serviceList}`,
        `↻ Rescheduled from ${oldDateReadable || '(previous date)'}${oldTimeReadable ? ` at ${oldTimeReadable}` : ''}`,
        '',
        `Rescheduled via lizwendybeautystudiollc.com`,
      ].filter(Boolean).join('\n'),
      start: { dateTime: newStart.toISOString(), timeZone: 'America/New_York' },
      end:   { dateTime: newEnd.toISOString(),   timeZone: 'America/New_York' },
      colorId: CALENDAR_COLORS[artistId] || '11',
      extendedProperties: {
        private: {
          cancelToken:   newToken,
          customerFirst: firstName,
          customerEmail: customerEmail,
          customerPhone: customerPhone,
          artistName:    artistName,
          dateReadable:  dateReadable,
          timeReadable:  timeReadable,
          serviceList:   serviceList,
          // Carried forward so the NEXT cancel/reschedule still knows the
          // booking's ledger identity and value.
          ledgerRef:       ledgerRef,
          priceCents:      props.priceCents || '',
          durationMinutes: String(roundedDuration),
        },
      },
    };

    await calendar.events.insert({ calendarId: CALENDAR_ID, resource: newCalEvent });
    console.log(`reschedule-booking: created new event for ${firstName} @ ${dateReadable} ${timeReadable}`);

    // ── 2. DELETE THE OLD EVENT (only after the new one is safely created) ──
    // Best-effort: if this fails, the customer has BOTH slots briefly, which
    // reconciliation catches — far better than the reverse (losing the new
    // booking). We still surface success because the reschedule itself (the
    // new event) is confirmed.
    try {
      await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: oldEvent.id });
      console.log(`reschedule-booking: deleted old event ${oldEvent.id}`);
    } catch (delErr) {
      console.error('reschedule-booking: OLD event delete failed (new event already created):', delErr);
    }

    // ── LEDGER (Command Center) ──
    // The reschedule is real from here on, so record it. from_cancel_flow is
    // true because this endpoint is only reachable from the cancel.html
    // manage page (the Churn Deflector). Runs in parallel with the emails.
    const ledgerPromise = recordLedgerEvent({
      event_type:              'rescheduled',
      idempotency_key:         `resched:${token}:${newToken}`,
      booking_ref:             ledgerRef,
      customer_phone:          toE164(customerPhone),
      customer_name:           firstName,
      customer_email:          customerEmail || null,
      locale:                  lang === 'es' ? 'es' : 'en',
      artist_ref:              artistId,
      service_summary:         serviceList,
      price_cents:             priceCents,
      duration_minutes:        roundedDuration,
      appointment_at:          newStart.toISOString(),
      previous_appointment_at: oldStart.toISOString(),
      from_cancel_flow:        true,
      actor:                   'customer',
    });

    // ── 3. NOTIFICATIONS (isolated — never fail an already-completed reschedule) ──
    try {
      const isEs = lang === 'es';

      // Customer: reschedule confirmation (email only — business rule for
      // reschedule). Reuses the customer confirmation template via overrides,
      // same mechanism cancel-booking.js uses.
      let customerNotification;
      if (customerEmail) {
        customerNotification = sendRescheduleEmail({
          toEmail: customerEmail,
          cc: '',
          subjectLine: isEs
            ? `Cita Reprogramada — ${dateReadable}`
            : `Appointment Rescheduled — ${dateReadable}`,
          introLine: isEs
            ? `Hola ${firstName}, tu cita ha sido reprogramada. Aquí están tus nuevos detalles.`
            : `Hi ${firstName}, your appointment has been rescheduled. Here are your new details.`,
          outroLine: isEs
            ? `¿Necesitas hacer otro cambio? Puedes gestionar tu cita cuando quieras. ¡Nos vemos pronto! ✨`
            : `Need to make another change? You can manage your appointment anytime. See you soon! ✨`,
          details: { firstName, date: dateReadable, time: timeReadable, services: serviceList, artistName },
          manageUrl,
        });
      } else {
        customerNotification = Promise.resolve({ skipped: 'no_email_on_record' });
      }

      // Artist: reschedule notice showing OLD → NEW so they see exactly what
      // moved. Wendy CC'd on Johanna's, matching the booking pattern.
      const artistInbox = ARTIST_EMAILS[artistId] || STUDIO_EMAIL;
      const artistCc    = (artistInbox !== STUDIO_EMAIL) ? STUDIO_EMAIL : '';
      const movedFrom   = `${oldDateReadable || '(previous date)'}${oldTimeReadable ? ` a las ${oldTimeReadable}` : ''}`;

      const artistNotification = sendRescheduleEmail({
        toEmail: artistInbox,
        cc: artistCc,
        subjectLine: `Cita Reprogramada — ${dateReadable}`,
        introLine: `Aviso: ${firstName || 'una clienta'} reprogramó su cita.\nAntes: ${movedFrom}\nAhora: ${dateReadable} a las ${timeReadable}.`,
        outroLine: `El horario anterior ya quedó libre en tu calendario automáticamente.`,
        details: { firstName, date: dateReadable, time: timeReadable, services: serviceList, artistName },
        manageUrl: '',
      });

      const results = await Promise.all([customerNotification, artistNotification]);
      console.log('reschedule-booking email results:', JSON.stringify(results));
    } catch (emailErr) {
      console.error('reschedule-booking: notifications failed (reschedule already completed):', emailErr);
    }

    // Must be awaited (serverless freezes after return). Resolves, never rejects.
    await ledgerPromise;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        booking: { date: dateReadable, time: timeReadable, services: serviceList, artistName },
      }),
    };

  } catch (err) {
    console.error('reschedule-booking error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'server_error' }) };
  }
};

/* ── EMAIL: Reschedule notice ──
   Reuses EMAILJS_TEMPLATE_CUSTOMER with subject/intro/outro overrides, the
   same pattern cancel-booking.js uses so no new template is required. The
   customer template must expose {{subject_override}}, {{intro_override}},
   {{outro_override}}. */
async function sendRescheduleEmail({ toEmail, cc, subjectLine, introLine, outroLine, details, manageUrl }) {
  if (!EMAILJS_TEMPLATE_CUSTOMER) {
    console.error('reschedule-booking: EMAILJS_TEMPLATE_CUSTOMER not set — skipping email to', toEmail);
    return { ok: false, skipped: 'no_template' };
  }

  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id:  EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_CUSTOMER,
      user_id:     EMAILJS_PUBLIC_KEY,
      accessToken: EMAILJS_PRIVATE_KEY,
      template_params: {
        to_email:         toEmail,
        cc_email:         cc || '',
        subject_override: subjectLine,
        intro_override:   introLine,
        outro_override:   outroLine,
        date:             details.date,
        time:             details.time,
        services:         details.services,
        artist_name:      details.artistName,
        // Template requires these — pass empty when unused so EmailJS doesn't
        // reject missing variables.
        first_name:  details.firstName || '',
        total:       '',
        notes_line:  '',
        cancel_url:  manageUrl || '',
      },
    }),
  });

  const text = await res.text();
  console.log(`sendRescheduleEmail → ${toEmail} | status:`, res.status, '| response:', text);
  return { ok: res.ok, status: res.status, response: text };
}

/* ── UTIL ── (verbatim from create-booking.js so time formatting matches) */
function formatTime(slot) {
  const [h, m = 0] = slot.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${ampm}`;
}
