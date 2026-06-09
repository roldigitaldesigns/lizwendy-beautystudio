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
 * 3. Send confirmation email to customer via Web3Forms
 * 4. Send notification email to Wendy/Ramon via Web3Forms
 */

const { google } = require('googleapis');

const CALENDAR_ID   = process.env.GOOGLE_CALENDAR_ID;
const CLIENT_EMAIL  = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY   = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const WEB3FORMS_KEY = process.env.WEB3FORMS_KEY;
const STUDIO_EMAIL  = process.env.STUDIO_EMAIL; // ramonlopez30798@gmail.com for dev

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
    const { firstName, lastName, email, phone, notes, date, time, services, total, artist } = data;

    // Basic validation
    if (!firstName || !lastName || !email || !phone || !date || !time || !services?.length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };
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
    const eventEnd   = new Date(`${date}T${String(slotH + 1).padStart(2,'0')}:00:00-04:00`);

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
      colorId: '11', // Tomato red — visible on calendar
    };

    await calendar.events.insert({ calendarId: CALENDAR_ID, resource: calEvent });

    // ── 4. SEND EMAILS ──
    await Promise.all([
      sendCustomerEmail({ firstName, email, dateReadable, timeReadable, serviceList, totalStr, notes }),
      sendStudioEmail({ fullName, email, phone, dateReadable, timeReadable, serviceList, totalStr, notes }),
    ]);

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

/* ── EMAIL: Customer Confirmation ── */
async function sendCustomerEmail({ firstName, email, dateReadable, timeReadable, serviceList, totalStr, notes }) {
  const body = `
Hi ${firstName},

Your appointment at Liz Wendy Beauty Studio has been confirmed! ✦

────────────────────────────
📅  ${dateReadable}
🕐  ${timeReadable}
✨  ${serviceList}
💰  Estimated Total: ${totalStr}
📍  76 Livingston Ave, New Brunswick, NJ 08901
────────────────────────────

${notes ? `Your notes: ${notes}\n\n` : ''}Please arrive 5 minutes early. If you need to cancel or reschedule, kindly do so at least 24 hours in advance.

────────────────────────────
💳  SECURE YOUR APPOINTMENT
A $20 deposit is required to confirm your booking.
Pay here: https://link.clover.com/urlshortener/VZSmPk
This deposit will be applied to your total balance.
────────────────────────────

We look forward to seeing you!

— Liz Wendy Beauty Studio
📸 @lizwendybeautystudiollc
🌐 lizwendybeautystudiollc.com
  `.trim();

  return fetch('https://api.web3forms.com/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_key: WEB3FORMS_KEY,
      subject:    `✦ Appointment Confirmed — ${dateReadable} at ${timeReadable}`,
      from_name:  'Liz Wendy Beauty Studio',
      to:         email,
      message:    body,
    }),
  });
}

/* ── EMAIL: Studio Notification ── */
async function sendStudioEmail({ fullName, email, phone, dateReadable, timeReadable, serviceList, totalStr, notes }) {
  const body = `
New booking received via lizwendybeautystudiollc.com

────────────────────────────
👤  Client: ${fullName}
📧  Email: ${email}
📱  Phone: ${phone}
────────────────────────────
📅  Date: ${dateReadable}
🕐  Time: ${timeReadable}
✨  Services: ${serviceList}
💰  Estimated Total: ${totalStr}
${notes ? `📝  Notes: ${notes}` : ''}
────────────────────────────

This appointment has been automatically added to the Liz Wendy Bookings calendar.
  `.trim();

  return fetch('https://api.web3forms.com/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_key: WEB3FORMS_KEY,
      subject:    `📅 New Booking: ${fullName} — ${dateReadable} at ${timeReadable}`,
      from_name:  'Liz Wendy Booking System',
      to:         STUDIO_EMAIL,
      message:    body,
    }),
  });
}

/* ── UTIL ── */
function formatTime(slot) {
  const [h] = slot.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:00 ${ampm}`;
}
