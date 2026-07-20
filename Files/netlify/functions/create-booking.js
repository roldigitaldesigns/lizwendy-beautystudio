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

const CLIENT_EMAIL  = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY   = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const STUDIO_EMAIL  = process.env.STUDIO_EMAIL; // ramonlopez30798@gmail.com for dev
const YUDELKYS_EMAIL = process.env.YUDELKYS_EMAIL; // yudelkys.msantana@gmail.com
const JOHANNA_EMAIL  = process.env.JOHANNA_EMAIL;  // Jaimejohanna11@gmail.com

// ── ARTIST → CALENDAR ID ROUTING ──
// Yudelkys and Johanna IDs are placeholders until their dedicated studio
// calendars are created and shared with the service account. Swap the
// env vars in Netlify once you have them — no code changes needed.
const CALENDAR_IDS = {
  'Liz Wendy Cedeño': process.env.GOOGLE_CALENDAR_ID,
  'Yudelkys':          process.env.YUDELKYS_CALENDAR_ID, // placeholder
  'Johanna':           process.env.JOHANNA_CALENDAR_ID,  // placeholder
};

// ── ARTIST → CALENDAR COLOR ──
// Lets Wendy tell whose appointment is whose at a glance when viewing
// multiple artists' calendars overlaid together. Google Calendar colorId
// reference: 5=Banana(yellow), 7=Peacock(blue-teal), 11=Tomato(red).
const CALENDAR_COLORS = {
  'Liz Wendy Cedeño': '11', // Tomato — Wendy's existing/signature color
  'Yudelkys':          '7',  // Peacock
  'Johanna':           '5',  // Banana
};

// Routes each booking notification to the correct artist's inbox.
// Wendy is CC'd on every booking regardless of artist, so she retains full visibility.
const ARTIST_EMAILS = {
  'Liz Wendy Cedeño': STUDIO_EMAIL,
  'Yudelkys':          YUDELKYS_EMAIL,
  'Johanna':           JOHANNA_EMAIL,
};

const EMAILJS_SERVICE_ID       = process.env.EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_CUSTOMER = process.env.EMAILJS_TEMPLATE_CUSTOMER;
const EMAILJS_TEMPLATE_STUDIO   = process.env.EMAILJS_TEMPLATE_STUDIO;
const EMAILJS_PUBLIC_KEY        = process.env.EMAILJS_PUBLIC_KEY;
const EMAILJS_PRIVATE_KEY       = process.env.EMAILJS_PRIVATE_KEY;

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
    if (!firstName || !lastName || !email || !phone || !date || !time || !services?.length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    const CALENDAR_ID = CALENDAR_IDS[artist] || CALENDAR_IDS['Liz Wendy Cedeño'];
    if (!CALENDAR_ID) {
      console.error(`create-booking: no calendar configured for artist "${artist}"`);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Booking is temporarily unavailable for this artist. Please try again later or call us directly.' }) };
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
    const fullName     = `${firstName} ${lastName}`;

    const calEvent = {
      summary: `💅 ${fullName} — ${serviceList}`,
      description: [
        `Client: ${fullName}`,
        `Email: ${email}`,
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
    };

    await calendar.events.insert({ calendarId: CALENDAR_ID, resource: calEvent });

    // ── 4. SEND EMAILS (isolated — must never break booking confirmation) ──
    console.log('Starting email sends. EMAILJS_SERVICE_ID present:', !!EMAILJS_SERVICE_ID, '| STUDIO_EMAIL:', STUDIO_EMAIL);

    try {
      const [customerResult, studioResult] = await Promise.all([
        sendCustomerEmail({ firstName, email, dateReadable, timeReadable, serviceList, totalStr, notes }),
        sendStudioEmail({ fullName, email, phone, dateReadable, timeReadable, serviceList, totalStr, notes, artist }),
      ]);
      console.log('Customer email result:', JSON.stringify(customerResult));
      console.log('Studio email result:', JSON.stringify(studioResult));
    } catch (emailErr) {
      console.error('Email sending failed (booking still confirmed):', emailErr);
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
async function sendCustomerEmail({ firstName, email, dateReadable, timeReadable, serviceList, totalStr, notes }) {
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
        to_email:   email,
        first_name: firstName,
        date:       dateReadable,
        time:       timeReadable,
        services:   serviceList,
        total:      totalStr,
        notes_line: notesLine,
      },
    }),
  });

  const text = await res.text();
  console.log('sendCustomerEmail → status:', res.status, '| response:', text);
  return { ok: res.ok, status: res.status, response: text };
}

/* ── EMAIL: Studio Notification (via EmailJS) ── */
async function sendStudioEmail({ fullName, email, phone, dateReadable, timeReadable, serviceList, totalStr, notes, artist }) {
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
