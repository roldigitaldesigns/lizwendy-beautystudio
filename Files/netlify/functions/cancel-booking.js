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
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const { recordLedgerEvent, toE164, parseCents } = require('./_lib/ledger');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY  = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const STUDIO_EMAIL   = process.env.STUDIO_EMAIL;
const JOHANNA_EMAIL  = process.env.JOHANNA_EMAIL;

const GMAIL_USER         = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

// Same artistId convention as get-availability.js / create-booking.js
const CALENDAR_IDS = {
  liz:      process.env.GOOGLE_CALENDAR_ID,
  johanna:  process.env.JOHANNA_CALENDAR_ID,
};

const ARTIST_EMAILS = {
  liz:      STUDIO_EMAIL,
  johanna:  JOHANNA_EMAIL,
};

function getGmailTransport() {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) return null;
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD,
    },
  });
}

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
    // Kept separate from `details` (not shown on the cancel.html confirmation
    // screen) — only used internally to route the cancellation notice below.
    const customerEmail = props.customerEmail || '';
    const customerPhone = props.customerPhone || '';

    const appointmentStart = (booking.start && booking.start.dateTime) || null;

    // ── Command Center ledger identity (see reschedule-booking.js) ──
    // Stable across reschedules; pre-ledger bookings fall back to their token.
    const ledgerRef  = props.ledgerRef || token;
    const priceCents = parseCents(props.priceCents); // null for pre-ledger bookings
    const ledgerBase = {
      booking_ref:     ledgerRef,
      customer_phone:  toE164(customerPhone),
      customer_name:   details.firstName,
      customer_email:  customerEmail || null,
      artist_ref:      artistId,
      service_summary: details.services,
      price_cents:     priceCents,
      appointment_at:  appointmentStart,
      actor:           'customer',
    };

    // Derive duration from event start/end or stored extendedProperties
    const evEndIso = (booking.end && booking.end.dateTime) || null;
    let durationMinutes = parseInt(props.durationMinutes, 10) || 60;
    if (appointmentStart && evEndIso) {
      const diffMin = Math.round((Date.parse(evEndIso) - Date.parse(appointmentStart)) / 60000);
      if (diffMin > 0) durationMinutes = diffMin;
    }

    // ── STEP 1: LOOKUP ONLY ──
    if (action === 'lookup') {
      await recordLedgerEvent(
        { ...ledgerBase, event_type: 'cancel_intent', idempotency_key: `intent:${token}` },
        { timeoutMs: 1500, retries: 0 }
      );

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, booking: details, appointmentStart, durationMinutes }),
      };
    }

    // ── STEP 2: CONFIRMED CANCELLATION ──
    if (action === 'cancel') {
      await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: booking.id });
      console.log(`cancel-booking: deleted event ${booking.id} (${details.services} / ${details.date})`);

      if (supabase) {
        try {
          await supabase
            .from('appointments')
            .update({ status: 'cancelled' })
            .eq('cancel_token', token);
        } catch (sbErr) {
          console.error('cancel-booking: failed to update supabase status:', sbErr);
        }
      }

      // ── LEDGER (Command Center) ──
      const ledgerPromise = recordLedgerEvent({
        ...ledgerBase,
        event_type:      'cancelled',
        idempotency_key: `cancel:${token}`,
        locale:          lang === 'es' ? 'es' : 'en',
      });

      // Notifications are isolated — a send failure must never make the
      // customer think the cancellation didn't happen (the event is already gone).
      try {
        const customerNotification = customerEmail
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
          : Promise.resolve({ skipped: 'no_customer_email' });

        const results = await Promise.all([
          customerNotification,
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

      // Must be awaited (serverless freezes after return). Resolves, never rejects.
      await ledgerPromise;

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

/* ── EMAIL: Cancellation notice via Gmail SMTP ── */
async function sendCancellationEmail({ toEmail, cc, subjectLine, introLine, outroLine, details }) {
  const transporter = getGmailTransport();
  if (!transporter || !toEmail) {
    console.error('cancel-booking: GMAIL_USER/GMAIL_APP_PASSWORD or toEmail missing — skipping email to', toEmail);
    return { ok: false, skipped: 'gmail_not_configured' };
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #E8DEC8;border-radius:10px;background:#FCFBF8;color:#2B2620;">
      <h2 style="margin:0 0 12px;color:#947234;">Liz Wendy Beauty Studio</h2>
      <p style="margin:0 0 14px;font-size:14px;">${introLine}</p>
      <div style="background:#FFFFFF;border:1px solid #E8DEC8;border-radius:8px;padding:14px 16px;margin-bottom:14px;font-size:13px;">
        <div><strong>Artist:</strong> ${details.artistName || 'Liz Wendy Cedeño'}</div>
        <div><strong>Date:</strong> ${details.date || '—'}</div>
        <div><strong>Time:</strong> ${details.time || '—'}</div>
        <div><strong>Services:</strong> ${details.services || '—'}</div>
      </div>
      <p style="margin:0;font-size:13px;color:#7A7060;">${outroLine}</p>
    </div>
  `;

  const info = await transporter.sendMail({
    from: `"Liz Wendy Beauty Studio" <${GMAIL_USER}>`,
    to: toEmail,
    cc: cc || undefined,
    subject: subjectLine,
    html,
  });

  console.log(`sendCancellationEmail → ${toEmail} | messageId:`, info.messageId);
  return { ok: true, messageId: info.messageId };
}
