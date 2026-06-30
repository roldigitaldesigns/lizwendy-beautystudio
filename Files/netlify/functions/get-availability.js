/**
 * GET /.netlify/functions/get-availability?date=YYYY-MM-DD&artistId=liz
 *
 * Returns taken 1-hour slots for a given date by reading the correct
 * artist's Google Calendar (artistId: liz | yudelkys | johanna).
 * Defaults to Wendy's calendar if artistId is missing (back-compat).
 *
 * Response: { takenSlots: ["09:00", "11:00", ...] }
 */

const { google } = require('googleapis');

const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY  = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

// ── ARTIST → CALENDAR ID ROUTING ──
// Yudelkys and Johanna IDs are placeholders until their dedicated studio
// calendars are created and shared with the service account. Swap the
// env vars in Netlify once you have them — no code changes needed.
const CALENDAR_IDS = {
  liz:      process.env.GOOGLE_CALENDAR_ID,
  yudelkys: process.env.YUDELKYS_CALENDAR_ID, // placeholder — set in Netlify when available
  johanna:  process.env.JOHANNA_CALENDAR_ID,  // placeholder — set in Netlify when available
};

// ── ARTIST → WORKING HOURS ──
// (0=Sun…6=Sat) → [startHour, endHour]. Defaults to Wendy's hours for any
// artist without a specific schedule defined yet — update once known.
const ARTIST_HOURS = {
  liz: {
    1: [9, 19],  // Mon
    3: [9, 19],  // Wed
    4: [9, 19],  // Thu
    5: [9, 19],  // Fri
    6: [7, 16],  // Sat
  },
  yudelkys: {
    1: [9, 19],  // Mon
    3: [9, 19],  // Wed
    4: [9, 19],  // Thu
    5: [9, 19],  // Fri
    6: [7, 16],  // Sat
  },
  johanna: {
    1: [9, 19],  // Mon
    3: [9, 19],  // Wed
    4: [9, 19],  // Thu
    5: [9, 19],  // Fri
    6: [7, 16],  // Sat
  },
};

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  try {
    const dateStr  = event.queryStringParameters && event.queryStringParameters.date;
    const artistId = (event.queryStringParameters && event.queryStringParameters.artistId) || 'liz';

    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid date' }) };
    }

    const CALENDAR_ID = CALENDAR_IDS[artistId];
    if (!CALENDAR_ID) {
      console.error(`get-availability: no calendar configured for artistId "${artistId}"`);
      return { statusCode: 200, headers, body: JSON.stringify({ takenSlots: [] }) };
    }

    const HOURS = ARTIST_HOURS[artistId] || ARTIST_HOURS.liz;

    // Check it's a work day
    const date = new Date(dateStr + 'T00:00:00');
    const dow  = date.getDay();
    if (!HOURS[dow]) {
      return { statusCode: 200, headers, body: JSON.stringify({ takenSlots: [] }) };
    }

    // Auth
    const auth = new google.auth.JWT({
      email: CLIENT_EMAIL,
      key:   PRIVATE_KEY,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });

    const calendar = google.calendar({ version: 'v3', auth });

    // Query events for the full day (Eastern Time offset handled via ISO)
    const timeMin = new Date(dateStr + 'T00:00:00-04:00').toISOString();
    const timeMax = new Date(dateStr + 'T23:59:59-04:00').toISOString();

    const res = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = res.data.items || [];

    // Generate all slots for the day
    const [start, end] = HOURS[dow];
    const allSlots = [];
    for (let h = start; h < end; h++) {
      allSlots.push(`${String(h).padStart(2, '0')}:00`);
    }

    // Mark slots as taken if any calendar event overlaps them
    const takenSlots = allSlots.filter(slot => {
      const [slotH] = slot.split(':').map(Number);
      const slotStart = new Date(`${dateStr}T${String(slotH).padStart(2,'0')}:00:00-04:00`);
      const slotEnd   = new Date(`${dateStr}T${String(slotH + 1).padStart(2,'0')}:00:00-04:00`);

      return events.some(ev => {
        if (!ev.start) return false;
        // All-day events block the whole day
        if (ev.start.date && !ev.start.dateTime) return true;
        const evStart = new Date(ev.start.dateTime);
        const evEnd   = new Date(ev.end.dateTime);
        // Overlap check
        return evStart < slotEnd && evEnd > slotStart;
      });
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ takenSlots }),
    };

  } catch (err) {
    console.error('get-availability error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to fetch availability', takenSlots: [] }),
    };
  }
};
