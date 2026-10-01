/**
 * POST /.netlify/functions/create-booking
 *
 * Body (JSON):
 * {
 *   firstName, lastName, email, phone, notes,
 *   date: "YYYY-MM-DD", time: "HH:MM",
 *   services: [{ name, price }],
 *   total: number,
 *   artist: string
 * }
 *
 * Actions:
 * 1. Double-check slot is still free on Google Calendar
 * 2. Create Google Calendar event (blocks the slot)
 * 3. Save appointment ledger entry in Supabase (appointments table)
 * 4. Send confirmation email to customer via EmailJS
 * 5. Send notification email to Wendy/Ramon via EmailJS
 */

const { google } = require('googleapis');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { recordLedgerEvent, toE164, toCents } = require('./_lib/ledger');

// ── SUPABASE CONFIG ──
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dayyxufmvxqxobjxdxzv.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRheXl4dWZtdnhxeG9ianhkeHp2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3ODAxNjQsImV4cCI6MjEwNTM1NjE2NH0.Oaqg-UIEYlob64MYMypadVjRcMSDowZ9BshhJKO6PEc';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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

// Fallback schedules in case of filesystem reading
let SCHEDULES = null;
try {
  SCHEDULES = require('./schedules.json');
} catch (e) {
  SCHEDULES = null;
}

async function isDateBlackedOut(artistId, dateStr) {
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

const CALENDAR_IDS = {
  'Liz Wendy Cedeño': process.env.GOOGLE_CALENDAR_ID,
  'Johanna':          process.env.JOHANNA_CALENDAR_ID,
};

const ARTIST_IDS = {
  'Liz Wendy Cedeño': 'liz',
  'Johanna':          'johanna',
};

const CALENDAR_COLORS = {
  'Liz Wendy Cedeño': '11', // Tomato
  'Johanna':          '5',  // Banana
};

const ARTIST_EMAILS = {
  'Liz Wendy Cedeño': STUDIO_EMAIL,
  'Johanna':          JOHANNA_EMAIL,
};

const EMAILJS_SERVICE_ID        = process.env.EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_CUSTOMER = process.env.EMAILJS_TEMPLATE_CUSTOMER;
const EMAILJS_TEMPLATE_STUDIO   = process.env.EMAILJS_TEMPLATE_STUDIO;
const EMAILJS_PUBLIC_KEY        = process.env.EMAILJS_PUBLIC_KEY;
const EMAILJS_PRIVATE_KEY       = process.env.EMAILJS_PRIVATE_KEY;

const TWILIO_ACCOUNT_SID     = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN      = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;
const TWILIO_TEMPLATE_SID    = process.env.TWILIO_TEMPLATE_SID;

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

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

    // ── BLACKOUT GATE ──
    const requestArtistId = ARTIST_IDS[artist] || 'liz';
    if (await isDateBlackedOut(requestArtistId, date)) {
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({ error: 'This artist is not available on the selected date. Please choose another date.' }),
      };
    }

    // ── 1. AUTH ──
    const auth = new google.auth.JWT({
      email:  CLIENT_EMAIL,
      key:    PRIVATE_KEY,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    const calendar = google.calendar({ version: 'v3', auth });

    // ── 2. DOUBLE-CHECK SLOT IS FREE ──
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

    // ── 3. CREATE CALENDAR EVENT ──
    const serviceList = services.map(s => typeof s === 'string' ? s : s.name).join(', ');
    const totalStr    = total > 0 ? `$${total}` : 'TBD (consultation)';
    const dateObj     = new Date(date + 'T12:00:00');
    const dateReadable = `${DAYS[dateObj.getDay()]}, ${MONTHS[dateObj.getMonth()]} ${dateObj.getDate()}, ${dateObj.getFullYear()}`;
    const timeReadable = formatTime(time);
    const fullName     = lastName ? `${firstName} ${lastName}` : firstName;

    const cancelToken = crypto.randomBytes(16).toString('hex');
    const artistId = ARTIST_IDS[artist] || 'liz';
    const cancelUrl = `${SITE_URL}/cancel.html?token=${cancelToken}&artist=${artistId}`;

    const calEvent = {
      summary: `💅 ${fullName} — ${serviceList}`,
      description: [
        `Client: ${fullName}`,
        email ? `Email: ${email}` : `Email: (not provided — phone booking, WhatsApp confirmation sent)`,
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
          customerFirst:   firstName,
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

    // ── 4. RECORD TO SUPABASE APPOINTMENTS TABLE ──
    const supabaseInsertPromise = supabase
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
      });

    // ── 5. LEDGER (Command Center) ──
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

    // ── 6. SEND NOTIFICATIONS ──
    try {
      const customerConfirmation = email
        ? sendCustomerEmail({ firstName, email, dateReadable, timeReadable, serviceList, totalStr, notes, artist, cancelUrl, lang })
        : sendWhatsAppConfirmation({ firstName, phone, dateReadable, timeReadable, serviceList, totalStr, artist, cancelUrl });

      await Promise.all([
        customerConfirmation,
        sendStudioEmail({ fullName, email, phone, dateReadable, timeReadable, serviceList, totalStr, notes, artist, cancelUrl }),
      ]);
    } catch (notifyErr) {
      console.error('Customer/studio notification failed (booking confirmed):', notifyErr);
    }

    // Await background records before serverless response freeze
    await Promise.all([ledgerPromise, supabaseInsertPromise]);

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

/* ── EMAIL: Customer Confirmation (via EmailJS) ── */
async function sendCustomerEmail({ firstName, email, dateReadable, timeReadable, serviceList, totalStr, notes, artist, cancelUrl, lang }) {
  const artistDisplay = artist || 'Liz Wendy Cedeño';
  const isEs = lang === 'es';

  const emailCopy = isEs
    ? {
        subject: `Cita Confirmada: ${serviceList} el ${dateReadable}`,
        intro:   `¡Hola ${firstName}! Tu cita con ${artistDisplay} ha sido confirmada. Por favor revisa los detalles a continuación.`,
        outro:   (notes ? `Tus notas: ${notes}\n\n` : '') +
                 'Por favor llega 5 minutos antes. Si necesitas reprogramar o cancelar, avísanos con al menos 24 horas de anticipación.\n\n¡Te esperamos pronto! ✨',
      }
    : {
        subject: `Appointment Confirmed: ${serviceList} on ${dateReadable}`,
        intro:   `Hi ${firstName}! Your appointment with ${artistDisplay} has been confirmed. Please review your details below.`,
        outro:   (notes ? `Your notes: ${notes}\n\n` : '') +
                 'Please arrive 5 minutes early. If you need to reschedule or cancel, kindly let us know at least 24 hours in advance.\n\nWe look forward to seeing you! ✨',
      };

  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id:  EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_CUSTOMER,
      user_id:     EMAILJS_PUBLIC_KEY,
      accessToken: EMAILJS_PRIVATE_KEY,
      template_params: {
        to_email:         email,
        first_name:       firstName,
        subject_override: emailCopy.subject,
        intro_override:   emailCopy.intro,
        outro_override:   emailCopy.outro,
        date:             dateReadable,
        time:             timeReadable,
        services:         serviceList,
        total:            totalStr,
        notes_line:       '',
        artist_name:      artistDisplay,
        cancel_url:       cancelUrl,
      },
    }),
  });

  const text = await res.text();
  return { ok: res.ok, status: res.status, response: text };
}

/* ── WHATSAPP: Customer Confirmation (via Twilio) ── */
async function sendWhatsAppConfirmation({ firstName, phone, dateReadable, timeReadable, serviceList, totalStr, artist, cancelUrl }) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_NUMBER || !TWILIO_TEMPLATE_SID) {
    console.error('sendWhatsAppConfirmation: Twilio not configured');
    return { ok: false, skipped: 'twilio_not_configured' };
  }

  const digits = String(phone).replace(/\D/g, '');
  const e164 = digits.length === 10 ? `+1${digits}` : `+${digits}`;
  const toWhatsApp = `whatsapp:${e164}`;

  const body = new URLSearchParams({
    From: TWILIO_WHATSAPP_NUMBER,
    To: toWhatsApp,
    ContentSid: TWILIO_TEMPLATE_SID,
    ContentVariables: JSON.stringify({
      '1': firstName,
      '2': serviceList,
      '3': artist || 'Liz Wendy Cedeño',
      '4': dateReadable,
      '5': timeReadable,
    }),
  });

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64'),
      },
      body,
    }
  );

  const text = await res.text();
  return { ok: res.ok, status: res.status, response: text };
}

/* ── EMAIL: Studio Notification (via EmailJS) ── */
async function sendStudioEmail({ fullName, email, phone, dateReadable, timeReadable, serviceList, totalStr, notes, artist, cancelUrl }) {
  const notesLine = [
    notes ? `📝 Notes: ${notes}` : '',
  ].filter(Boolean).join('\n');

  const recipientEmail = ARTIST_EMAILS[artist] || STUDIO_EMAIL;
  const ccEmail = (recipientEmail !== STUDIO_EMAIL) ? STUDIO_EMAIL : '';

  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id:  EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_STUDIO,
      user_id:     EMAILJS_PUBLIC_KEY,
      accessToken: EMAILJS_PRIVATE_KEY,
      template_params: {
        to_email:       recipientEmail,
        cc_email:       ccEmail,
        full_name:      fullName,
        customer_email: email,
        phone:          phone,
        date:           dateReadable,
        time:           timeReadable,
        services:       serviceList,
        total:          totalStr,
        notes_line:     notesLine,
        cancel_url:     cancelUrl,
      },
    }),
  });

  const text = await res.text();
  return { ok: res.ok, status: res.status, response: text };
}

/* ── UTIL ── */
function formatTime(slot) {
  const [h, m = 0] = slot.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${ampm}`;
}
