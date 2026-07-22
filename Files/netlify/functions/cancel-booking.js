/**
 * POST /.netlify/functions/cancel-booking
 *
 * Two-step cancellation flow, driven by cancel.html:
 *
 *   Step 1 — { action: "lookup", token, artistId }
 *     Finds the booking by its cancel token and returns the details
 *     (date, time, services, artist) WITHOUT deleting anything, so the
 *     page can show "Are you sure you want to cancel this?".
 *
 *   Step 2 — { action: "cancel", token, artistId, lang }
 *     Deletes the calendar event, then emails the customer a cancellation
 *     notice (with an invitation to rebook on the site) and notifies the
 *     artist that the slot is free again. Wendy is CC'd when the artist
 *     isn't her, matching the booking-notification pattern.
 *
 * SAFETY: This function only ever acts on POST. The cancel link in emails
 * is a plain GET to cancel.html — email security scanners that auto-follow
 * links can never trigger a deletion, because deletion requires the
 * explicit confirm-button POST from the page.
 *
 * The token is a random 32-hex-char secret generated at booking time and
 * stored in the calendar event's private extended properties — no separate
 * database involved. Looking up by token uses Google Calendar's
 * privateExtendedProperty search, which matches at most one event.
 */

const { google } = require('googleapis');

const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY  = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const STUDIO_EMAIL   = process.env.STUDIO_EMAIL;
const YUDELKYS_EMAIL = process.env.YUDELKYS_EMAIL;
const JOHANNA_EMAIL  = process.env.JOHANNA_EMAIL;

const EMAILJS_SERVICE_ID      = process.env.EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_CANCEL = process.env.EMAILJS_TEMPLATE_CANCEL; // new template — see setup notes
const EMAILJS_PUBLIC_KEY      = process.env.EMAILJS_PUBLIC_KEY;
const EMAILJS_PRIVATE_KEY     = process.env.EMAILJS_PRIVATE_KEY;

const SITE_URL = process.env.SITE_URL || 'https://lizwendybeautystudiollc.com';

// Same artistId convention as get-availability.js / create-booking.js
const CALENDAR_IDS = {
  liz:      process.env.GOOGLE_CALENDAR_ID,
  yudelkys: process.env.YUDELKYS_CALENDAR_ID,
  johanna:  process.env.JOHANNA_CALENDAR_ID,
};

const ARTIST_EMAILS = {
  liz:      STUDIO_EMAIL,
  yudelkys: YUDELKYS_EMAIL,
  johanna:  JOHANNA_EMAIL,
};

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // GET (or anything but POST) never acts — core anti-auto-click safety.
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const data = JSON.parse(event.body || '{}');
    const { action, token, artistId, lang } = data;

    // Token format guard: exactly what create-booking generates (32 hex chars).
    if (!token || !/^[a-f0-9]{32}$/.test(token)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid_link' }) };
    }

    const CALENDAR_ID = CALENDAR_IDS[artistId];
    if (!CALENDAR_ID) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid_link' }) };
    }

    // ── AUTH ──
    const auth = new google.auth.JWT({
      email:  CLIENT_EMAIL,
      key:    PRIVATE_KEY,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    const calendar = google.calendar({ version: 'v3', auth });

    // ── FIND THE BOOKING BY TOKEN ──
    // privateExtendedProperty matches only events carrying this exact
    // key=value pair, so at most one event can come back. Bounded to
    // "yesterday onward" — past appointments can't meaningfully be cancelled.
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const found = await calendar.events.list({
      calendarId: CALENDAR_ID,
      privateExtendedProperty: `cancelToken=${token}`,
      timeMin: dayAgo.toISOString(),
      singleEvents: true,
      maxResults: 1,
    });

    const booking = found.data.items && found.data.items[0];
    if (!booking) {
      // Already cancelled, or link is stale/invalid — same friendly answer
      // either way (don't reveal which).
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'not_found' }) };
    }

    const props = (booking.extendedProperties && booking.extendedProperties.private) || {};
    const details = {
      firstName:  props.customerFirst || '',
      artistName: props.artistName    || '',
      date:       props.dateReadable  || '',
      time:       props.timeReadable  || '',
      services:   props.serviceList   || '',
    };

    // ── STEP 1: LOOKUP ONLY ──
    if (action === 'lookup') {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, booking: details }) };
    }

    // ── STEP 2: CONFIRMED CANCELLATION ──
    if (action === 'cancel') {
      await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: booking.id });
      console.log(`cancel-booking: deleted event ${booking.id} (${details.services} / ${details.date})`);

      // Emails are isolated — a send failure must never make the customer
      // think the cancellation didn't happen (the event is already gone).
      try {
        const customerEmail = props.customerEmail || '';
        const results = await Promise.all([
          customerEmail
            ? sendCancellationEmail({
                toEmail: customerEmail,
                cc: '',
                subjectLine: (lang === 'es')
                  ? `Cita Cancelada — ${details.date}`
                  : `Appointment Cancelled — ${details.date}`,
                introLine: (lang === 'es')
                  ? `Hola ${details.firstName}, tu cita ha sido cancelada.`
                  : `Hi ${details.firstName}, your appointment has been cancelled.`,
                outroLine: (lang === 'es')
                  ? `¿Te gustaría reagendar? Reserva una nueva cita cuando quieras en lizwendybeautystudiollc.com — ¡nos encantaría verte pronto! ✨`
                  : `Would you like to reschedule? Book a new time anytime at lizwendybeautystudiollc.com — we'd love to see you soon! ✨`,
                details,
              })
            : Promise.resolve({ skipped: true }),
          sendCancellationEmail({
            toEmail: ARTIST_EMAILS[artistId] || STUDIO_EMAIL,
            cc: (ARTIST_EMAILS[artistId] && ARTIST_EMAILS[artistId] !== STUDIO_EMAIL) ? STUDIO_EMAIL : '',
            subjectLine: `Cita Cancelada — ${details.date}`,
            introLine: `Aviso: la siguiente cita fue cancelada${details.firstName ? ` (clienta: ${details.firstName})` : ''}.`,
            outroLine: `Este horario ya quedó libre en tu calendario automáticamente.`,
            details,
          }),
        ]);
        console.log('cancel-booking email results:', JSON.stringify(results));
      } catch (emailErr) {
        console.error('cancel-booking: emails failed (event already deleted):', emailErr);
      }

      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid_action' }) };

  } catch (err) {
    console.error('cancel-booking error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'server_error' }),
    };
  }
};

/* ── EMAIL: Cancellation notice (shared template, parameterized content) ──
   Uses ONE new EmailJS template (EMAILJS_TEMPLATE_CANCEL) for both the
   customer notice and the artist heads-up — the intro/outro lines carry
   the audience-specific wording so only one template needs creating. */
async function sendCancellationEmail({ toEmail, cc, subjectLine, introLine, outroLine, details }) {
  if (!EMAILJS_TEMPLATE_CANCEL) {
    console.error('cancel-booking: EMAILJS_TEMPLATE_CANCEL not set — skipping email to', toEmail);
    return { ok: false, skipped: 'no_template' };
  }

  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id:  EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_CANCEL,
      user_id:     EMAILJS_PUBLIC_KEY,
      accessToken: EMAILJS_PRIVATE_KEY,
      template_params: {
        to_email:     toEmail,
        cc_email:     cc || '',
        subject_line: subjectLine,
        intro_line:   introLine,
        outro_line:   outroLine,
        date:         details.date,
        time:         details.time,
        services:     details.services,
        artist_name:  details.artistName,
      },
    }),
  });

  const text = await res.text();
  console.log(`sendCancellationEmail → ${toEmail} | status:`, res.status, '| response:', text);
  return { ok: res.ok, status: res.status, response: text };
}
