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
 * CREATE the new event BEFORE deleting the old one. If the create fails
 * (slot taken, calendar error), the customer still has their original
 * appointment untouched. Only once the new event is safely on the calendar
 * do we delete the old one.
 *
 * ── 24-HOUR GATE ──
 * Rescheduling is refused within 24 hours of the CURRENT appointment start.
 */

const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { recordLedgerEvent, toE164, parseCents } = require('./_lib/ledger');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { enabled: false },
    })
  : null;

const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY  = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const STUDIO_EMAIL  = process.env.STUDIO_EMAIL;
const JOHANNA_EMAIL = process.env.JOHANNA_EMAIL;

const GMAIL_USER         = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

const SITE_URL = process.env.SITE_URL || 'https://lizwendybeautystudiollc.com';

const CALENDAR_IDS = {
  liz:     process.env.GOOGLE_CALENDAR_ID,
  johanna: process.env.JOHANNA_CALENDAR_ID,
};

const ARTIST_NAMES = {
  liz:     'Liz Wendy Cedeño',
  johanna: 'Johanna',
};

const CALENDAR_COLORS = {
  liz:     '11',
  johanna: '5',
};

const ARTIST_EMAILS = {
  liz:     STUDIO_EMAIL,
  johanna: JOHANNA_EMAIL,
};

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

const RESCHEDULE_CUTOFF_MS = 24 * 60 * 60 * 1000;

let gmailTransporter = null;
function getGmailTransport() {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) return null;
  if (!gmailTransporter) {
    gmailTransporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: GMAIL_USER,
        pass: GMAIL_APP_PASSWORD,
      },
    });
  }
  return gmailTransporter;
}

function escapeIcsText(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function formatIcsDateUTC(dt) {
  const iso = dt.toISOString().replace(/[-:]/g, '').split('.')[0];
  return `${iso}Z`;
}

function buildCalendarInviteIcs({ uid, startDate, endDate, summary, description, location }) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Liz Wendy Beauty Studio//Booking//EN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${formatIcsDateUTC(new Date())}`,
    `DTSTART:${formatIcsDateUTC(startDate)}`,
    `DTEND:${formatIcsDateUTC(endDate)}`,
    `SUMMARY:${escapeIcsText(summary)}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    `LOCATION:${escapeIcsText(location)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

function formatTime(slot) {
  const [h, m = 0] = String(slot || '09:00').split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m || 0).padStart(2, '0')} ${ampm}`;
}

async function sendRescheduleEmail({ toEmail, cc, subjectLine, introLine, outroLine, details, manageUrl, icsContent, isEs }) {
  if (process.env.PAUSE_EMAILS === 'true') {
    return { ok: false, skipped: 'emails_paused' };
  }

  const transporter = getGmailTransport();
  if (!transporter || !toEmail) {
    console.warn('sendRescheduleEmail: Gmail SMTP not configured or no recipient email');
    return { ok: false, skipped: 'gmail_not_configured' };
  }

  const labels = {
    artist: isEs ? 'Artista' : 'Artist',
    date: isEs ? 'Fecha' : 'Date',
    time: isEs ? 'Hora' : 'Time',
    services: isEs ? 'Servicios' : 'Services',
    location: isEs ? 'Ubicación' : 'Location',
    cta: isEs ? 'Administrar Cita' : 'Manage Appointment',
  };

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #E8DEC8;border-radius:10px;background:#FCFBF8;color:#2B2620;">
      <h2 style="margin:0 0 12px;color:#947234;">Liz Wendy Beauty Studio</h2>
      <p style="margin:0 0 14px;font-size:14px;line-height:1.5;">${introLine}</p>
      <div style="background:#FFFFFF;border:1px solid #E8DEC8;border-radius:8px;padding:14px 16px;margin-bottom:14px;font-size:13px;line-height:1.6;">
        <div><strong>${labels.artist}:</strong> ${details.artistName || 'Liz Wendy Cedeño'}</div>
        <div><strong>${labels.date}:</strong> ${details.date || '—'}</div>
        <div><strong>${labels.time}:</strong> ${details.time || '—'}</div>
        <div><strong>${labels.services}:</strong> ${details.services || '—'}</div>
        <div><strong>${labels.location}:</strong> 76 Livingston Ave, New Brunswick, NJ 08901</div>
      </div>
      <p style="margin:0 0 14px;font-size:13px;color:#7A7060;line-height:1.5;">${outroLine}</p>
      ${manageUrl ? `<p style="margin:0;font-size:12px;"><a href="${manageUrl}" style="color:#947234;font-weight:bold;">${labels.cta}</a></p>` : ''}
    </div>
  `;

  const info = await transporter.sendMail({
    from: `"Liz Wendy Beauty Studio" <${GMAIL_USER}>`,
    to: toEmail,
    cc: cc || undefined,
    subject: subjectLine,
    html,
    attachments: icsContent
      ? [{
          filename: 'liz-wendy-appointment.ics',
          content: icsContent,
          contentType: 'text/calendar; charset=utf-8; method=PUBLISH',
        }]
      : [],
  });

  console.log(`sendRescheduleEmail → ${toEmail} | messageId:`, info.messageId);
  return { ok: true, messageId: info.messageId };
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const data = JSON.parse(event.body || '{}');
    const { token, artistId, newDate, newTime, lang } = data;

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

    const auth = new google.auth.JWT({
      email:  CLIENT_EMAIL,
      key:    PRIVATE_KEY,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    const calendar = google.calendar({ version: 'v3', auth });

    const found = await calendar.events.list({
      calendarId: CALENDAR_ID,
      privateExtendedProperty: `cancelToken=${token}`,
      maxResults: 1,
    });

    const oldEvent = found.data.items && found.data.items[0];
    if (!oldEvent) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'not_found' }) };
    }

    const oldStart = oldEvent.start && oldEvent.start.dateTime
      ? new Date(oldEvent.start.dateTime)
      : null;
    if (!oldStart || isNaN(oldStart.getTime())) {
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

    const oldEnd = oldEvent.end && oldEvent.end.dateTime ? new Date(oldEvent.end.dateTime) : null;
    const originalDurationMin = (oldEnd && !isNaN(oldEnd.getTime()))
      ? Math.max(30, Math.round((oldEnd.getTime() - oldStart.getTime()) / 60000))
      : 60;

    function getNYOffset(dStr) {
      const d = new Date(`${dStr}T12:00:00Z`);
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).formatToParts(d);
      const nyHour = parseInt(parts.find(p => p.type === 'hour').value, 10);
      let diff = nyHour - 12;
      if (diff > 0) diff -= 24;
      return `${diff < 0 ? '-' : '+'}${String(Math.abs(diff)).padStart(2, '0')}:00`;
    }
    const [slotH, slotM = 0] = newTime.split(':').map(Number);
    const offset = getNYOffset(newDate);
    const newStart = new Date(`${newDate}T${String(slotH).padStart(2,'0')}:${String(slotM).padStart(2,'0')}:00${offset}`);

    const roundedDuration = Math.ceil(originalDurationMin / 15) * 15;
    const newEnd = new Date(newStart.getTime() + roundedDuration * 60 * 1000);

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

    const props = (oldEvent.extendedProperties && oldEvent.extendedProperties.private) || {};
    const firstName     = props.customerFirst || '';
    const customerEmail = props.customerEmail || '';
    const customerPhone = props.customerPhone || '';
    const artistName    = props.artistName    || ARTIST_NAMES[artistId] || 'Liz Wendy Cedeño';
    const serviceList   = props.serviceList   || '';

    const ledgerRef  = props.ledgerRef || token;
    const priceCents = parseCents(props.priceCents);

    const dateObj      = new Date(newDate + 'T12:00:00Z');
    const dateReadable = `${DAYS[dateObj.getUTCDay()]}, ${MONTHS[dateObj.getUTCMonth()]} ${dateObj.getUTCDate()}, ${dateObj.getUTCFullYear()}`;
    const timeReadable = formatTime(newTime);

    const oldDateReadable = props.dateReadable || '';
    const oldTimeReadable = props.timeReadable || '';

    const newToken  = crypto.randomBytes(16).toString('hex');
    const manageUrl = `${SITE_URL}/cancel.html?token=${newToken}&artist=${artistId}`;

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
          cancelToken:     newToken,
          customerFirst:   firstName,
          customerEmail:   customerEmail,
          customerPhone:   customerPhone,
          artistName:      artistName,
          dateReadable:    dateReadable,
          timeReadable:    timeReadable,
          serviceList:     serviceList,
          ledgerRef:       ledgerRef,
          priceCents:      props.priceCents || '',
          durationMinutes: String(roundedDuration),
        },
      },
    };

    await calendar.events.insert({ calendarId: CALENDAR_ID, resource: newCalEvent });
    console.log(`reschedule-booking: created new event for ${firstName} @ ${dateReadable} ${timeReadable}`);

    try {
      await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: oldEvent.id });
      console.log(`reschedule-booking: deleted old event ${oldEvent.id}`);
    } catch (delErr) {
      console.error('reschedule-booking: OLD event delete failed (new event already created):', delErr);
    }

    if (supabase) {
      try {
        const { data: updatedAppt, error: sbErr } = await supabase
          .from('appointments')
          .update({
            appointment_date: newDate,
            appointment_time: newTime,
            start_time: newStart.toISOString(),
            cancel_token: newToken,
            reminder_24h_sent: false,
            reminder_sameday_sent: false,
            updated_at: new Date().toISOString(),
          })
          .eq('cancel_token', token)
          .select();

        if (sbErr) {
          console.error('reschedule-booking: Supabase update error:', sbErr.message);
        } else {
          console.log('reschedule-booking: Supabase appointment updated successfully:', updatedAppt);
        }
      } catch (sbEx) {
        console.error('reschedule-booking: Supabase exception:', sbEx);
      }
    } else {
      console.warn('reschedule-booking: Supabase client not initialized (missing keys)');
    }

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

    try {
      const isEs = lang === 'es';

      const icsContent = buildCalendarInviteIcs({
        uid: `${newToken}@lizwendybeautystudiollc.com`,
        startDate: newStart,
        endDate: newEnd,
        summary: `Liz Wendy Beauty Studio — ${serviceList}`,
        description: `Artist: ${artistName}\nServices: ${serviceList}\nManage or cancel: ${manageUrl}`,
        location: '76 Livingston Ave, New Brunswick, NJ 08901',
      });

      const customerNotification = customerEmail
        ? sendRescheduleEmail({
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
            icsContent,
            isEs,
          })
        : Promise.resolve({ skipped: 'no_email_on_record' });

      const artistInbox = ARTIST_EMAILS[artistId] || STUDIO_EMAIL;
      const artistCc    = (artistInbox && STUDIO_EMAIL && artistInbox !== STUDIO_EMAIL) ? STUDIO_EMAIL : '';
      const movedFrom   = `${oldDateReadable || '(previous date)'}${oldTimeReadable ? ` a las ${oldTimeReadable}` : ''}`;

      const artistNotification = sendRescheduleEmail({
        toEmail: artistInbox,
        cc: artistCc,
        subjectLine: `Cita Reprogramada — ${dateReadable}`,
        introLine: `Aviso: la siguiente cita fue reprogramada desde ${movedFrom}${firstName ? ` (clienta: ${firstName})` : ''}.`,
        outroLine: `El calendario ya fue actualizado con el nuevo horario.`,
        details: { firstName, date: dateReadable, time: timeReadable, services: serviceList, artistName },
        manageUrl,
        icsContent: null,
        isEs: false,
      });

      const results = await Promise.all([customerNotification, artistNotification]);
      console.log('reschedule-booking email results:', JSON.stringify(results));
    } catch (emailErr) {
      console.error('reschedule-booking: notification emails failed (event already moved):', emailErr);
    }

    await ledgerPromise;

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, newToken }) };
  } catch (err) {
    console.error('reschedule-booking error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'server_error' }),
    };
  }
};
