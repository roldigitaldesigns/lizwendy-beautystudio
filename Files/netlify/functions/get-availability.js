/**
 * GET /.netlify/functions/get-availability?date=YYYY-MM-DD&artistId=liz
 *
 * Returns taken 30-min slots for a given date by reading the correct
 * artist's Google Calendar (artistId: liz | johanna).
 * Defaults to Wendy's calendar if artistId is missing (back-compat).
 *
 * Working hours are read from schedules.json (same file the front-end
 * fetches), so the calendar shown to customers and the hours enforced
 * here can never disagree. See schedules.json's "_readme" for how to
 * edit hours — no code changes needed to update someone's schedule.
 *
 * Response: { takenSlots: ["09:00", "09:30", "11:00", ...] }
 */

const { google } = require('googleapis');

// schedules.json must sit in this same folder (next to this function file)
// so it gets bundled and deployed automatically with the function.
const SCHEDULES = require('./schedules.json');

const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY  = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

// ── ARTIST → CALENDAR ID ROUTING ──
// Johanna's ID is a placeholder until her dedicated studio calendar is
// created and shared with the service account. Swap the env var in
// Netlify once you have it — no code changes needed.
const CALENDAR_IDS = {
  liz:      process.env.GOOGLE_CALENDAR_ID,
  johanna:  process.env.JOHANNA_CALENDAR_ID,  // placeholder — set in Netlify when available
};

// Fallback hours, used ONLY if schedules.json is ever missing/malformed,
// so the calendar never breaks entirely. Keep schedules.json as the real
// source of truth — this is a safety net, not something to edit routinely.
const DEFAULT_HOURS = {
  1: [9, 19],  // Mon
  3: [9, 19],  // Wed
  4: [9, 19],  // Thu
  5: [9, 19],  // Fri
  6: [7, 16],  // Sat
};

function getArtistHours(artistId) {
  if (SCHEDULES && SCHEDULES[artistId]) return SCHEDULES[artistId];
  return DEFAULT_HOURS;
}

// ── SLOT + BUFFER CONFIG ──
// Slots are offered every 30 minutes (":00" and ":30"). After any booked
// appointment, an additional buffer is blocked so the artist has turnaround
// time between clients — cleanup, sanitizing, reset. The buffer is added on
// top of the appointment's real duration (a 90-min set at 10:00 blocks until
// 11:30 + buffer). Applies to ALL artists.
const SLOT_STEP_MIN = 30;      // minutes between offered start times
const BUFFER_MIN     = 60;     // turnaround blocked after each appointment ends

// Build every "HH:MM" start time from `start` (inclusive) to `end`
// (exclusive) in SLOT_STEP_MIN increments. `start`/`end` are whole-hour
// numbers from schedules.json (e.g. 9 → "09:00", "09:30", ...).
function buildSlots(start, end) {
  const slots = [];
  for (let mins = start * 60; mins < end * 60; mins += SLOT_STEP_MIN) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }
  return slots;
}

// Checks an artist's optional "blackout" date ranges in schedules.json
// (e.g. Wendy unavailable for all of August). dateStr and range bounds
// are YYYY-MM-DD, which compares correctly as plain strings.
function isDateBlackedOut(artistId, dateStr) {
  const schedule = SCHEDULES && SCHEDULES[artistId];
  if (!schedule || !Array.isArray(schedule.blackout)) return false;
  return schedule.blackout.some(r => dateStr >= r.from && dateStr <= r.to);
}

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

    const HOURS = getArtistHours(artistId);

    // Check it's a work day
    const date = new Date(dateStr + 'T00:00:00');
    const dow  = date.getDay();
    if (!HOURS[dow]) {
      return { statusCode: 200, headers, body: JSON.stringify({ takenSlots: [] }) };
    }

    // Blackout override (e.g. Wendy unavailable all of August) — mark every
    // slot on this date as taken so nothing can be booked, even if a
    // request bypasses the calendar UI's greyed-out day.
    if (isDateBlackedOut(artistId, dateStr)) {
      const [bStart, bEnd] = HOURS[dow];
      const blockedSlots = buildSlots(bStart, bEnd);
      return { statusCode: 200, headers, body: JSON.stringify({ takenSlots: blockedSlots, blackout: true }) };
    }

    // Auth
    const auth = new google.auth.JWT({
      email: CLIENT_EMAIL,
      key:   PRIVATE_KEY,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });

    const calendar = google.calendar({ version: 'v3', auth });

    // Query events for the full day, widened by one day on each side.
    //
    // Why the padding: Google Calendar stores all-day events using a
    // date-only boundary in UTC, not a timezone-aware timestamp. When the
    // query window is built from Eastern Time offsets (-04:00), an all-day
    // event can fall just outside that shifted window and get silently
    // excluded from the API response — even though it visually belongs to
    // this date on the calendar. Padding the query by a day on each side
    // guarantees the event is included in the raw results; the explicit
    // date check below (isAllDayEventOnDate) then filters back down to
    // only events that actually apply to dateStr.
    const dayBefore = new Date(dateStr + 'T00:00:00-04:00');
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    const dayAfter = new Date(dateStr + 'T23:59:59-04:00');
    dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);

    const timeMin = dayBefore.toISOString();
    const timeMax = dayAfter.toISOString();

    const res = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = res.data.items || [];

    // Generate all slots for the day — every 30 minutes.
    const [start, end] = HOURS[dow];
    const allSlots = buildSlots(start, end);

    // An all-day event's start.date/end.date are plain YYYY-MM-DD strings
    // (end.date is EXCLUSIVE per Google's API — a single-day all-day event
    // spanning just "today" has end.date equal to tomorrow). This checks
    // whether dateStr genuinely falls within that range, independent of
    // the padded query window above.
    function isAllDayEventOnDate(ev) {
      if (!ev.start || !ev.start.date || ev.start.dateTime) return false;
      const startDate = ev.start.date;
      const endDate = (ev.end && ev.end.date) || startDate;
      return dateStr >= startDate && dateStr < endDate;
    }

    // Mark slots as taken if any calendar event overlaps them.
    //
    // Each slot is a 30-minute window [slotStart, slotStart + SLOT_STEP_MIN).
    // A timed event blocks not just its own span but an extra BUFFER_MIN
    // afterward, giving the artist turnaround time — so the event's blocking
    // window is [evStart, evEnd + BUFFER_MIN). Any slot that overlaps that
    // extended window is unavailable.
    const takenSlots = allSlots.filter(slot => {
      const [slotH, slotM] = slot.split(':').map(Number);
      const slotStart = new Date(`${dateStr}T${String(slotH).padStart(2,'0')}:${String(slotM).padStart(2,'0')}:00-04:00`);
      const slotEnd   = new Date(slotStart.getTime() + SLOT_STEP_MIN * 60 * 1000);

      return events.some(ev => {
        if (!ev.start) return false;
        // All-day events block the whole day — but only if the event's
        // own date range actually includes dateStr (the padded query
        // window can return neighboring days' all-day events too).
        if (ev.start.date && !ev.start.dateTime) return isAllDayEventOnDate(ev);
        const evStart = new Date(ev.start.dateTime);
        // Extend the event's blocking window by the turnaround buffer.
        const evEnd   = new Date(new Date(ev.end.dateTime).getTime() + BUFFER_MIN * 60 * 1000);
        // Overlap check against the buffered window.
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
