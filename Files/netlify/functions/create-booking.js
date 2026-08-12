/**
 * POST /.netlify/functions/create-booking
 *
 * Body (JSON):
 * {
 *   firstName, lastName, email, phone, notes,
 *   date: "YYYY-MM-DD", time: "HH:00",
 *   services: [{ name, price }],
 *   total: number,
 *   artist: string
 * }
 *
 * Actions:
 * 1. Double-check slot is still free
 * 2. Create Google Calendar event (blocks the slot)
 * 3. Send confirmation email to customer via EmailJS
 * 4. Send notification email to Wendy/Ramon via EmailJS
 */

const { google } = require('googleapis');
const crypto = require('crypto');

// schedules.json must sit in this same folder (next to this function file)
// so it gets bundled and deployed automatically with the function.
const SCHEDULES = require('./schedules.json');

// Checks an artist's optional "blackout" date ranges in schedules.json
// (e.g. Wendy unavailable for all of August). dateStr and range bounds
// are YYYY-MM-DD, which compares correctly as plain strings.
function isDateBlackedOut(artistId, dateStr) {
  const schedule = SCHEDULES && SCHEDULES[artistId];
  if (!schedule || !Array.isArray(schedule.blackout)) return false;
  return schedule.blackout.some(r => dateStr >= r.from && dateStr <= r.to);
}

const SITE_URL = process.env.SITE_URL || 'https://lizwendybeautystudiollc.com';

const CLIENT_EMAIL  = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY   = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const STUDIO_EMAIL  = process.env.STUDIO_EMAIL; // ramonlopez30798@gmail.com for dev
const JOHANNA_EMAIL  = process.env.JOHANNA_EMAIL;  // Jaimejohanna11@gmail.com

// ── ARTIST → CALENDAR ID ROUTING ──
// Johanna's ID is a placeholder until her dedicated studio calendar is
// created and shared with the service account. Swap the env var in
// Netlify once you have it — no code changes needed.
const CALENDAR_IDS = {
  'Liz Wendy Cedeño': process.env.GOOGLE_CALENDAR_ID,
  'Johanna':           process.env.JOHANNA_CALENDAR_ID,  // placeholder
};

// Short artistId used in cancel links (matches get-availability.js /
// get-itinerary.js convention) — needed so cancel-booking.js knows which
// calendar to search without exposing the raw calendar ID in the URL.
const ARTIST_IDS = {
  'Liz Wendy Cedeño': 'liz',
  'Johanna':           'johanna',
};

// ── ARTIST → CALENDAR COLOR ──
// Lets Wendy tell whose appointment is whose at a glance when viewing
// multiple artists' calendars overlaid together. Google Calendar colorId
// reference: 5=Banana(yellow), 7=Peacock(blue-teal), 11=Tomato(red).
const CALENDAR_COLORS = {
  'Liz Wendy Cedeño': '11', // Tomato — Wendy's existing/signature color
  'Johanna':           '5',  // Banana
};

// Routes each booking notification to the correct artist's inbox.
// Wendy is CC'd on every booking regardless of artist, so she retains full visibility.
const ARTIST_EMAILS = {
  'Liz Wendy Cedeño': STUDIO_EMAIL,
  'Johanna':           JOHANNA_EMAIL,
};

const EMAILJS_SERVICE_ID       = process.env.EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_CUSTOMER = process.env.EMAILJS_TEMPLATE_CUSTOMER;
const EMAILJS_TEMPLATE_STUDIO   = process.env.EMAILJS_TEMPLATE_STUDIO;
const EMAILJS_PUBLIC_KEY        = process.env.EMAILJS_PUBLIC_KEY;
const EMAILJS_PRIVATE_KEY       = process.env.EMAILJS_PRIVATE_KEY;

// ── TWILIO WHATSAPP (customer confirmation when no email is given) ──
// Populated once the Twilio WhatsApp Sender is approved. Until then,
// sendWhatsAppConfirmation() below logs and no-ops rather than throwing,
// so phone-only bookings still succeed even before Twilio is fully wired.
const TWILIO_ACCOUNT_SID     = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN      = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER; // e.g. 'whatsapp:+17325551234'
const TWILIO_TEMPLATE_SID    = process.env.TWILIO_TEMPLATE_SID;    // approved utility template

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const data = JSON.parse(event.body);
    const { firstName, lastName, email, phone, notes, date, time, services, total, artist, durationMinutes } = data;

    // Basic validation
    // lastName and email are optional — phone is the required contact method
    // so confirmations can always reach the customer (email if given, else
    // WhatsApp). See sendCustomerEmail/sendWhatsAppConfirmation routing below.
    if (!firstName || !phone || !date || !time || !services?.length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    // Resolve which artist this booking is for. Only fall back to Wendy when
    // no artist was specified at all (legacy/empty case) — a NAMED artist
    // that isn't recognized (e.g. someone who has left the studio, or a
    // stale cached page still offering them) must be explicitly rejected,
    // never silently redirected onto Wendy's calendar.
    const knownArtist = Object.prototype.hasOwnProperty.call(CALENDAR_IDS, artist);
    if (artist && !knownArtist) {
      console.error(`create-booking: unrecognized artist "${artist}" — rejecting rather than silently falling back.`);
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'The selected artist is no longer available for booking. Please refresh the page and choose another artist.' }) };
    }
    const CALENDAR_ID = knownArtist ? CALENDAR_IDS[artist] : CALENDAR_IDS['Liz Wendy Cedeño'];
    if (!CALENDAR_ID) {
      console.error(`create-booking: no calendar configured for artist "${artist}"`);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Booking is temporarily unavailable for this artist. Please try again later or call us directly.' }) };
    }

    // ── BLACKOUT GATE ──
    // Final backend check: refuse to write a calendar event on a date the
    // artist has blacked out, even if the request skipped the calendar UI
    // and get-availability entirely.
    const requestArtistId = ARTIST_IDS[artist] || 'liz';
    if (isDateBlackedOut(requestArtistId, date)) {
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
    const [slotH] = time.split(':').map(Number);
    const eventStart = new Date(`${date}T${String(slotH).padStart(2,'0')}:00:00-04:00`);

    // Duration comes from the front end (sum of selected services' estimated
    // times, rounded up to the nearest 15 min). Fall back to 60 min if
    // missing or invalid, so older clients / bad input never break booking.
    const safeDuration = (Number.isFinite(durationMinutes) && durationMinutes > 0)
      ? durationMinutes
      : 60;
    const eventEnd = new Date(eventStart.getTime() + safeDuration * 60 * 1000);

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
    const serviceList = services.map(s => s.name).join(', ');
    const totalStr    = total > 0 ? `$${total}` : 'TBD (consultation)';
    const dateObj     = new Date(date + 'T12:00:00');
    const dateReadable = `${DAYS[dateObj.getDay()]}, ${MONTHS[dateObj.getMonth()]} ${dateObj.getDate()}, ${dateObj.getFullYear()}`;
    const timeReadable = formatTime(time);
    const fullName     = lastName ? `${firstName} ${lastName}` : firstName;

    // ── Cancel link setup ──
    // A random token (not the calendar event ID, which shouldn't be exposed
    // directly) identifies this booking. It's stored on the event itself via
    // Google Calendar's private extended properties, so no separate database
    // is needed — cancel-booking.js looks the event up by searching for this
    // token on the correct artist's calendar.
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
      colorId: CALENDAR_COLORS[artist] || '11', // per-artist color, defaults to Tomato
      extendedProperties: {
        private: {
          cancelToken:   cancelToken,
          customerFirst: firstName,
          customerEmail: email || '',
          customerPhone: phone || '',
          artistName:    artist || 'Liz Wendy Cedeño',
          dateReadable:  dateReadable,
          timeReadable:  timeReadable,
          serviceList:   serviceList,
        },
      },
    };

    await calendar.events.insert({ calendarId: CALENDAR_ID, resource: calEvent });

    // ── 4. SEND EMAILS (isolated — must never break booking confirmation) ──
    console.log('Starting email sends. EMAILJS_SERVICE_ID present:', !!EMAILJS_SERVICE_ID, '| STUDIO_EMAIL:', STUDIO_EMAIL);

    try {
      // Customer confirmation channel: email wins if provided (even when
      // phone is also given, per business rule); otherwise WhatsApp via phone.
      const customerConfirmation = email
        ? sendCustomerEmail({ firstName, email, dateReadable, timeReadable, serviceList, totalStr, notes, artist, cancelUrl })
        : sendWhatsAppConfirmation({ firstName, phone, dateReadable, timeReadable, serviceList, totalStr, artist, cancelUrl });

      const [customerResult, studioResult] = await Promise.all([
        customerConfirmation,
        sendStudioEmail({ fullName, email, phone, dateReadable, timeReadable, serviceList, totalStr, notes, artist, cancelUrl }),
      ]);
      console.log('Customer confirmation result:', JSON.stringify(customerResult));
      console.log('Studio email result:', JSON.stringify(studioResult));
    } catch (notifyErr) {
      console.error('Customer/studio notification failed (booking still confirmed):', notifyErr);
    }

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
async function sendCustomerEmail({ firstName, email, dateReadable, timeReadable, serviceList, totalStr, notes, artist, cancelUrl }) {
  const notesLine = notes ? `Your notes: ${notes}\n\n` : '';

  console.log('sendCustomerEmail → sending to:', email);

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
        subject_override: `Appointment Confirmed — ${dateReadable} at ${timeReadable}`,
        intro_override:   `Hi ${firstName}, your appointment at Liz Wendy Beauty Studio has been confirmed! ✦`,
        outro_override:   (notes ? `Your notes: ${notes}\n\n` : '') + 'Please arrive 5 minutes early. If you need to cancel or reschedule, kindly do so at least 24 hours in advance.\n\nWe look forward to seeing you!',
        date:             dateReadable,
        time:             timeReadable,
        services:         serviceList,
        total:            totalStr,
        notes_line:       '',
        artist_name:      artist || 'Liz Wendy Cedeño',
        cancel_url:       cancelUrl,
      },
    }),
  });

  const text = await res.text();
  console.log('sendCustomerEmail → status:', res.status, '| response:', text);
  return { ok: res.ok, status: res.status, response: text };
}

/* ── WHATSAPP: Customer Confirmation (via Twilio, used when no email given) ──
   Requires an approved Twilio WhatsApp utility template (TWILIO_TEMPLATE_SID).
   If Twilio credentials aren't configured yet, this logs and returns a
   skipped result rather than throwing — booking confirmation must never
   fail just because WhatsApp isn't wired up yet. */
async function sendWhatsAppConfirmation({ firstName, phone, dateReadable, timeReadable, serviceList, totalStr, artist, cancelUrl }) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_NUMBER || !TWILIO_TEMPLATE_SID) {
    console.error('sendWhatsAppConfirmation: Twilio not fully configured — skipping WhatsApp send to', phone);
    return { ok: false, skipped: 'twilio_not_configured' };
  }

  // Normalize to E.164-ish + whatsapp: prefix. Assumes US numbers (10 digits,
  // no country code) if none was given — matches the front end/voice agent,
  // which only ever collect a US callback number today.
  const digits = String(phone).replace(/\D/g, '');
  const e164 = digits.length === 10 ? `+1${digits}` : `+${digits}`;
  const toWhatsApp = `whatsapp:${e164}`;

  console.log('sendWhatsAppConfirmation → sending to:', toWhatsApp);

  const body = new URLSearchParams({
    From: TWILIO_WHATSAPP_NUMBER,
    To: toWhatsApp,
    ContentSid: TWILIO_TEMPLATE_SID,
    // Template variables — must match the placeholder order/names approved
    // in the Twilio/Meta template exactly (e.g. {{1}} firstName, {{2}} service,
    // {{3}} artist, {{4}} date, {{5}} time). Update this map once the
    // approved template's variable numbering is confirmed.
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
  console.log('sendWhatsAppConfirmation → status:', res.status, '| response:', text);
  return { ok: res.ok, status: res.status, response: text };
}

/* ── EMAIL: Studio Notification (via EmailJS) ── */
async function sendStudioEmail({ fullName, email, phone, dateReadable, timeReadable, serviceList, totalStr, notes, artist, cancelUrl }) {
  const notesLine = notes ? `📝 Notes: ${notes}` : '';

  // Route to the booked artist's inbox. Fall back to STUDIO_EMAIL if artist is unrecognized.
  const recipientEmail = ARTIST_EMAILS[artist] || STUDIO_EMAIL;

  // Wendy gets CC'd on every booking so she sees everything, even when another artist is booked.
  // (No CC needed when she IS the booked artist — that would just duplicate her own notification.)
  const ccEmail = (recipientEmail !== STUDIO_EMAIL) ? STUDIO_EMAIL : '';

  console.log('sendStudioEmail → sending to:', recipientEmail, '| cc:', ccEmail || '(none)');

  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id:  EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_STUDIO,
      user_id:     EMAILJS_PUBLIC_KEY,
      accessToken: EMAILJS_PRIVATE_KEY,
      template_params: {
        to_email:      recipientEmail,
        cc_email:      ccEmail,
        full_name:     fullName,
        customer_email: email,
        phone:         phone,
        date:          dateReadable,
        time:          timeReadable,
        services:      serviceList,
        total:         totalStr,
        notes_line:    notesLine,
        cancel_url:    cancelUrl,
      },
    }),
  });

  const text = await res.text();
  console.log('sendStudioEmail → status:', res.status, '| response:', text);
  return { ok: res.ok, status: res.status, response: text };
}

/* ── UTIL ── */
function formatTime(slot) {
  const [h] = slot.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:00 ${ampm}`;
}
