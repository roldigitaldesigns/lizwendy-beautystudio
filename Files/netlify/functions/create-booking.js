/**
 * POST /.netlify/functions/create-booking
 *
 * Body (JSON):
 * {
 *   firstName, lastName, email, phone, notes,
 *   date: "YYYY-MM-DD", time: "HH:MM",
 *   services: [{ name, price }],
 *   total: number,
 *   artist: string,
 *   durationMinutes: number,
 *   lang: "en" | "es"
 * }
 */

const { google } = require('googleapis');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');
const { recordLedgerEvent, toE164, toCents } = require('./_lib/ledger');

// — SUPABASE CONFIG —
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
      realtime: {
        enabled: false,
      },
    })
  : null;

// ── SERVICE DURATIONS (server-side fallback for voice bookings) ──
const SERVICE_DURATIONS = {
  'Occasion Makeup': 45,
  'Occasion Makeup + Lashes': 60,
  'Bridal Makeup': 60,
  'Elaborate / Complex Look': 60,
  'Quinceañera': 60,
  'Regular Manicure': 30,
  'Gel Manicure': 45,
  'Acrylic Full Set': 120,
  'Acrylic Refill': 90,
  'Gel X / Soft Gel Tips': 75,
  'Dip Powder / SNS': 60,
  'Regular Pedicure': 45,
  'Spa / Deluxe Pedicure': 60,
  'Nail Art / Design': 30,
  'Nail Art / Designs': 60,
  'Eyebrows': 15,
  'Upper Lip': 10,
  'Underarms': 15,
  'Bikini Line': 20,
  'Brazilian Wax': 30,
  'Full Legs': 45,
  'Half Legs': 25,
  'Full Arms': 25,
  'Back Wax': 30,
  'Full Face Wax': 30,
  'Full Body Wax': 90,
  'Eyebrow Tinting': 20,
  'Eyebrow Lamination': 45,
  'Lamination + Tint': 60,
  'Natural Glow': 60,
  'Lam + Shaping + Wax': 75,
  'Powder Brows / Ombré': 120,
  'Combo Brows': 120,
  'Lip Blush (PMU)': 120,
  'Permanent Eyeliner': 90,
  '6–8 Week PMU Touch-up': 60,
  'Annual PMU Touch-up': 90,
  'Classic Lash Extensions': 120,
  'Hybrid Lash Extensions': 120,
  'Volume Lash Extensions': 120,
  'Lash Lift': 45,
  'Lash Lift + Tint': 60,
  'Soft Glam': 60,
  'Brow Queen': 75,
  'Doll Eyes': 75,
  'Full Face Beauty': 90,
  'Luxury Beauty': 120,
  'Mobile Makeup (No Lashes)': 60,
  'Mobile Makeup + Lashes': 75,
  'Bridal Party Mobile': 60,
  'Express Facial': 30,
  'Deep Cleansing Facial': 75,
  'Hydrating Facial': 60,
  'Calming Facial': 60,
  'Vitamin C Brightening Facial': 60,
  'Acne Facial': 75,
  'Anti-Aging Facial': 75,
  'Dermaplaning Facial': 60,
  'Microdermabrasion': 60,
  'Premium Facial': 90,
  'Glow Skin Package': 90,
  'Luxury Facial Package': 105,
  'LED Light Therapy': 15,
  'Eye Contour Treatment': 15,
  'Collagen Mask': 15,
  'High Frequency': 15,
  'Facial Massage & Lymphatic Drainage': 20,
  'Neck & Décolletage Treatment': 20,
};

const DEFAULT_SERVICE_MINUTES = 60;

const SERVICE_DURATIONS_LOWER = Object.keys(SERVICE_DURATIONS).map(name => ({
  name, lower: name.toLowerCase(), minutes: SERVICE_DURATIONS[name],
}));

function lookupServiceDuration(rawName) {
  if (!rawName) return DEFAULT_SERVICE_MINUTES;
  if (SERVICE_DURATIONS[rawName] != null) return SERVICE_DURATIONS[rawName];

  const lower = String(rawName).toLowerCase().trim();
  for (const entry of SERVICE_DURATIONS_LOWER) {
    if (entry.lower === lower) return entry.minutes;
  }
  for (const entry of SERVICE_DURATIONS_LOWER) {
    if (entry.lower.includes(lower) || lower.includes(entry.lower)) return entry.minutes;
  }
  return DEFAULT_SERVICE_MINUTES;
}

function computeDurationFromServices(services) {
  if (!Array.isArray(services) || services.length === 0) return DEFAULT_SERVICE_MINUTES;

  const total = services.reduce((sum, s) => {
    const name = typeof s === 'string' ? s : (s && s.name);
    return sum + lookupServiceDuration(name);
  }, 0);

  return Math.ceil(total / 15) * 15;
}

let SCHEDULES = null;
try {
  SCHEDULES = require('./schedules.json');
} catch (e) {
  SCHEDULES = null;
}

async function isDateBlackedOut(artistId, dateStr) {
  if (!supabase) {
    const schedule = SCHEDULES && SCHEDULES[artistId];
    if (!schedule || !Array.isArray(schedule.blackout)) return false;
    return schedule.blackout.some(r => dateStr >= r.from && dateStr <= r.to);
  }

  try {
    const { data: blackouts } = await supabase
      .from('artist_blackouts')
      .select('id')
      .eq('artist_id', artistId)
      .lte('start_date', dateStr)
      .gte('end_date', dateStr);

    if (blackouts && blackouts.length > 0) return true;
  } catch (err) {
    console.warn('Supabase blackout check error, checking fallback schedules.json:', err.message);
  }

  const schedule = SCHEDULES && SCHEDULES[artistId];
  if (!schedule || !Array.isArray(schedule.blackout)) return false;
  return schedule.blackout.some(r => dateStr >= r.from && dateStr <= r.to);
}

const SITE_URL = process.env.SITE_URL || 'https://lizwendybeautystudiollc.com';

const CLIENT_EMAIL  = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY   = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const STUDIO_EMAIL  = process.env.STUDIO_EMAIL;
const JOHANNA_EMAIL = process.env.JOHANNA_EMAIL;

const GMAIL_USER         = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

const CALENDAR_IDS = {
  'Liz Wendy Cedeño': process.env.GOOGLE_CALENDAR_ID,
  'Johanna':          process.env.JOHANNA_CALENDAR_ID,
};

const ARTIST_IDS = {
  'Liz Wendy Cedeño': 'liz',
  'Johanna':          'johanna',
};

const CALENDAR_COLORS = {
  'Liz Wendy Cedeño': '11',
  'Johanna':          '5',
};

const ARTIST_EMAILS = {
  'Liz Wendy Cedeño': STUDIO_EMAIL,
  'Johanna':          JOHANNA_EMAIL,
};

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

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

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const data = JSON.parse(event.body);
    const { firstName, lastName, email, phone, notes, date, time, services, total, artist, durationMinutes, lang } = data;

    if (!firstName || !phone || !date || !time || !services?.length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    const knownArtist = Object.prototype.hasOwnProperty.call(CALENDAR_IDS, artist);
    if (artist && !knownArtist) {
      console.error(`create-booking: unrecognized artist "${artist}"`);
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'The selected artist is no longer available. Please choose another artist.' }) };
    }
    const CALENDAR_ID = knownArtist ? CALENDAR_IDS[artist] : CALENDAR_IDS['Liz Wendy Cedeño'];
    if (!CALENDAR_ID) {
      console.error(`create-booking: no calendar configured for artist "${artist}"`);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Booking is temporarily unavailable for this artist.' }) };
    }

    const requestArtistId = ARTIST_IDS[artist] || 'liz';
    if (await isDateBlackedOut(requestArtistId, date)) {
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({ error: 'This artist is not available on the selected date. Please choose another date.' }),
      };
    }

    const auth = new google.auth.JWT({
      email:  CLIENT_EMAIL,
      key:    PRIVATE_KEY,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    const calendar = google.calendar({ version: 'v3', auth });

    const [slotH, slotM = 0] = time.split(':').map(Number);

    function getNYOffset(dStr) {
      const d = new Date(`${dStr}T12:00:00Z`);
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).formatToParts(d);
      const nyHour = parseInt(parts.find(p => p.type === 'hour').value, 10);
      let diff = nyHour - 12;
      if (diff > 0) diff -= 24;
      return `${diff < 0 ? '-' : '+'}${String(Math.abs(diff)).padStart(2, '0')}:00`;
    }

    const offset = getNYOffset(date);
    const eventStart = new Date(`${date}T${String(slotH).padStart(2,'0')}:${String(slotM).padStart(2,'0')}:00${offset}`);

    const safeDuration = (Number.isFinite(durationMinutes) && durationMinutes > 0)
      ? durationMinutes
      : computeDurationFromServices(services);

    const roundedDuration = safeDuration;
    const eventEnd = new Date(eventStart.getTime() + roundedDuration * 60 * 1000);

    const existing = await calendar.events.list({
      calendarId:   CALENDAR_ID,
      timeMin:      eventStart.toISOString(),
      timeMax:      eventEnd.toISOString(),
      singleEvents: true,
    });

    if (existing.data.items && existing.data.items.length > 0) {
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({ error: 'This slot was just booked. Please select another time.' }),
      };
    }

    const serviceList  = services.map(s => typeof s === 'string' ? s : s.name).join(', ');
    const totalStr     = total > 0 ? `$${total}` : 'TBD (consultation)';
    const dateObj      = new Date(date + 'T12:00:00Z');
    const dateReadable = `${DAYS[dateObj.getUTCDay()]}, ${MONTHS[dateObj.getUTCMonth()]} ${dateObj.getUTCDate()}, ${dateObj.getUTCFullYear()}`;
    const timeReadable = formatTime(time);

    const cleanFirst = String(firstName || '').trim();
    const cleanLast  = String(lastName || '').trim();
    const fullName   = (cleanLast && !cleanLast.toLowerCase().startsWith(cleanFirst.toLowerCase() + ' '))
      ? `${cleanFirst} ${cleanLast}`
      : (cleanLast || cleanFirst);

    const cancelToken = crypto.randomBytes(16).toString('hex');
    const artistId    = ARTIST_IDS[artist] || 'liz';
    const cancelUrl   = `${SITE_URL}/cancel.html?token=${cancelToken}&artist=${artistId}`;

    const calEvent = {
      summary: `💅 ${fullName} — ${serviceList}`,
      description: [
        `Client: ${fullName}`,
        email ? `Email: ${email}` : `Email: (not provided — phone booking)`,
        `Phone: ${phone}`,
        `Services: ${serviceList}`,
        `Estimated Total: ${totalStr}`,
        notes ? `Notes: ${notes}` : '',
        '',
        `Booked via lizwendybeautystudiollc.com`,
      ].filter(Boolean).join('\n'),
      start: { dateTime: eventStart.toISOString(), timeZone: 'America/New_York' },
      end:   { dateTime: eventEnd.toISOString(),   timeZone: 'America/New_York' },
      colorId: CALENDAR_COLORS[artist] || '11',
      extendedProperties: {
        private: {
          cancelToken:     cancelToken,
          customerFirst:   cleanFirst,
          customerEmail:   email || '',
          customerPhone:   phone || '',
          artistName:      artist || 'Liz Wendy Cedeño',
          dateReadable:    dateReadable,
          timeReadable:    timeReadable,
          serviceList:     serviceList,
          ledgerRef:       cancelToken,
          priceCents:      String(total > 0 ? (toCents(total) || 0) : 0),
          durationMinutes: String(roundedDuration),
        },
      },
    };

    await calendar.events.insert({ calendarId: CALENDAR_ID, resource: calEvent });

    const supabaseInsertPromise = supabase
      ? supabase
          .from('appointments')
          .insert({
            cancel_token:     cancelToken,
            artist_id:        artistId,
            customer_name:    fullName,
            customer_email:   email || null,
            customer_phone:   phone,
            notes:            notes || null,
            appointment_date: date,
            appointment_time: time,
            start_time:       eventStart.toISOString(),
            duration_minutes: roundedDuration,
            services:         services,
            total_price:      total > 0 ? total : 0,
            deposit_paid:     requestArtistId === 'liz',
            status:           'confirmed'
          })
          .then(({ error }) => {
            if (error) console.error('Supabase appointments insert error:', error.message);
          })
      : Promise.resolve();

    const ledgerPromise = recordLedgerEvent({
      event_type:       'created',
      idempotency_key:  `created:${cancelToken}`,
      booking_ref:      cancelToken,
      customer_phone:   toE164(phone),
      customer_name:    fullName,
      customer_email:   email || null,
      locale:           lang === 'es' ? 'es' : 'en',
      artist_ref:       artistId,
      service_summary:  serviceList,
      channel:          (typeof services[0] === 'string') ? 'phone' : 'web',
      price_cents:      total > 0 ? toCents(total) : 0,
      duration_minutes: roundedDuration,
      appointment_at:   eventStart.toISOString(),
      actor:            'customer',
    });

    try {
      const icsContent = buildCalendarInviteIcs({
        uid: `${cancelToken}@lizwendybeautystudiollc.com`,
        startDate: eventStart,
        endDate: eventEnd,
        summary: `Liz Wendy Beauty Studio — ${serviceList}`,
        description: `Artist: ${artist || 'Liz Wendy Cedeño'}\nServices: ${serviceList}\nManage or cancel: ${cancelUrl}`,
        location: '76 Livingston Ave, New Brunswick, NJ 08901',
      });

      const tasks = [
        sendStudioEmail({ fullName, email, phone, dateReadable, timeReadable, serviceList, totalStr, notes, artist, cancelUrl }),
      ];

      if (email) {
        tasks.push(
          sendCustomerEmail({
            firstName: cleanFirst,
            fullName,
            email,
            dateReadable,
            timeReadable,
            serviceList,
            totalStr,
            notes,
            artist,
            cancelUrl,
            icsContent,
            lang,
          })
        );
      }

      await Promise.allSettled(tasks);
    } catch (notifyErr) {
      console.error('Customer/studio notification failed (booking confirmed):', notifyErr);
    }

    await Promise.allSettled([ledgerPromise, supabaseInsertPromise]);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, message: 'Booking confirmed' }),
    };

  } catch (err) {
    console.error('create-booking error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Booking failed. Please try again or call us directly.' }),
    };
  }
};

/* ── EMAIL: Customer Confirmation (via Gmail SMTP) ── */
async function sendCustomerEmail({ firstName, email, dateReadable, timeReadable, serviceList, totalStr, notes, artist, cancelUrl, icsContent, lang }) {
  if (process.env.PAUSE_EMAILS === 'true') {
    return { ok: false, skipped: 'emails_paused' };
  }

  const transporter = getGmailTransport();
  if (!transporter || !email) {
    console.warn('sendCustomerEmail: Gmail SMTP not configured or no customer email');
    return { ok: false, skipped: 'gmail_not_configured' };
  }

  const artistDisplay = artist || 'Liz Wendy Cedeño';
  const es = lang === 'es';

  const subject = es
    ? `Cita Confirmada: ${serviceList} el ${dateReadable}`
    : `Appointment Confirmed: ${serviceList} on ${dateReadable}`;

  const greeting = es
    ? `¡Hola ${firstName}! Tu cita con <strong>${artistDisplay}</strong> ha sido confirmada.`
    : `Hi ${firstName}! Your appointment with <strong>${artistDisplay}</strong> has been confirmed.`;

  const reminderNote = es
    ? 'Por favor llega 5 minutos antes. Si necesitas reprogramar o cancelar, avísanos con al menos 24 horas de anticipación.'
    : 'Please arrive 5 minutes early. If you need to reschedule or cancel, kindly let us know at least 24 hours in advance.';

  const notesHtml = notes
    ? `<div style="margin-top:10px;padding-top:10px;border-top:1px solid #E8DEC8;font-size:12px;color:#7A7060;"><strong>${es ? 'Notas' : 'Notes'}:</strong> ${notes}</div>`
    : '';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #E8DEC8;border-radius:10px;background:#FCFBF8;color:#2B2620;">
      <h2 style="margin:0 0 12px;color:#947234;">Liz Wendy Beauty Studio</h2>
      <p style="margin:0 0 16px;font-size:14px;line-height:1.5;">${greeting}</p>
      <div style="background:#FFFFFF;border:1px solid #E8DEC8;border-radius:8px;padding:14px 16px;margin-bottom:16px;font-size:13px;line-height:1.6;">
        <div><strong>${es ? 'Artista' : 'Artist'}:</strong> ${artistDisplay}</div>
        <div><strong>${es ? 'Fecha' : 'Date'}:</strong> ${dateReadable}</div>
        <div><strong>${es ? 'Hora' : 'Time'}:</strong> ${timeReadable}</div>
        <div><strong>${es ? 'Servicios' : 'Services'}:</strong> ${serviceList}</div>
        <div><strong>${es ? 'Total Estimado' : 'Estimated Total'}:</strong> ${totalStr}</div>
        <div><strong>${es ? 'Ubicación' : 'Location'}:</strong> 76 Livingston Ave, New Brunswick, NJ 08901</div>
        ${notesHtml}
      </div>
      <p style="margin:0 0 16px;font-size:12px;color:#7A7060;line-height:1.5;">${reminderNote}</p>
      <p style="margin:0;font-size:12px;">
        <a href="${cancelUrl}" style="color:#947234;font-weight:bold;">${es ? 'Administrar o Cancelar Cita' : 'Manage or Cancel Appointment'}</a>
      </p>
    </div>
  `;

  const info = await transporter.sendMail({
    from: `"Liz Wendy Beauty Studio" <${GMAIL_USER}>`,
    to: email,
    subject,
    html,
    attachments: icsContent
      ? [{
          filename: 'liz-wendy-appointment.ics',
          content: icsContent,
          contentType: 'text/calendar; charset=utf-8; method=PUBLISH',
        }]
      : [],
  });

  console.log(`sendCustomerEmail → ${email} | messageId:`, info.messageId);
  return { ok: true, messageId: info.messageId };
}

/* ── EMAIL: Studio Notification (via Gmail SMTP) ── */
async function sendStudioEmail({ fullName, email, phone, dateReadable, timeReadable, serviceList, totalStr, notes, artist, cancelUrl }) {
  if (process.env.PAUSE_EMAILS === 'true') {
    return { ok: false, skipped: 'emails_paused' };
  }

  const transporter = getGmailTransport();
  const artistDisplay = artist || 'Liz Wendy Cedeño';
  const recipientEmail = ARTIST_EMAILS[artistDisplay] || STUDIO_EMAIL;
  const ccEmail = (recipientEmail && STUDIO_EMAIL && recipientEmail !== STUDIO_EMAIL) ? STUDIO_EMAIL : undefined;

  if (!transporter || !recipientEmail) {
    console.warn('sendStudioEmail: Gmail SMTP not configured or no recipient email');
    return { ok: false, skipped: 'gmail_not_configured' };
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #E8DEC8;border-radius:10px;background:#FCFBF8;color:#2B2620;">
      <h2 style="margin:0 0 12px;color:#947234;">New Appointment Booked</h2>
      <div style="background:#FFFFFF;border:1px solid #E8DEC8;border-radius:8px;padding:14px 16px;margin-bottom:16px;font-size:13px;line-height:1.6;">
        <div><strong>Client:</strong> ${fullName}</div>
        <div><strong>Phone:</strong> ${phone}</div>
        <div><strong>Email:</strong> ${email || 'Not provided'}</div>
        <div><strong>Artist:</strong> ${artistDisplay}</div>
        <div><strong>Date:</strong> ${dateReadable}</div>
        <div><strong>Time:</strong> ${timeReadable}</div>
        <div><strong>Services:</strong> ${serviceList}</div>
        <div><strong>Estimated Total:</strong> ${totalStr}</div>
        <div><strong>Notes:</strong> ${notes || 'None'}</div>
      </div>
      <p style="margin:0;font-size:12px;">
        <a href="${cancelUrl}" style="color:#947234;font-weight:bold;">View / Cancel Booking Link</a>
      </p>
    </div>
  `;

  const info = await transporter.sendMail({
    from: `"Liz Wendy Beauty Studio" <${GMAIL_USER}>`,
    to: recipientEmail,
    cc: ccEmail,
    subject: `New Booking: ${fullName} — ${dateReadable} at ${timeReadable}`,
    html,
  });

  console.log(`sendStudioEmail → ${recipientEmail} | messageId:`, info.messageId);
  return { ok: true, messageId: info.messageId };
}
