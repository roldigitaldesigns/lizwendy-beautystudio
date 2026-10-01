/**
 * GET /.netlify/functions/get-availability?date=YYYY-MM-DD&artistId=liz
 *
 * Dynamically queries Supabase for artist schedules & blackout dates,
 * then checks Google Calendar for busy intervals to offer continuous 30-min slots.
 */

const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

// ── SUPABASE CONFIG ──
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dayyxufmvxqxobjxdxzv.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRheXl4dWZtdnhxeG9ianhkeHp2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3ODAxNjQsImV4cCI6MjEwNTM1NjE2NH0.Oaqg-UIEYlob64MYMypadVjRcMSDowZ9BshhJKO6PEc';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY  = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

// ── ARTIST → CALENDAR ID ROUTING ──
const CALENDAR_IDS = {
  liz:     process.env.GOOGLE_CALENDAR_ID,
  johanna: process.env.JOHANNA_CALENDAR_ID,
};

// Safety net hours if DB lookup ever fails
const DEFAULT_HOURS = {
  liz: {
    1: [9, 19], // Mon
    3: [9, 19], // Wed
    4: [9, 19], // Thu
    5: [9, 19], // Fri
    6: [7, 16], // Sat
  },
  johanna: {
    2: [10, 18], // Tue
    3: [10, 18], // Wed
    4: [10, 18], // Thu
    5: [10, 18], // Fri
    6: [10, 18], // Sat
  }
};

const BUFFER_MIN = 0;

// Fetch artist shift hours and blackouts from Supabase
async function getDynamicArtistAvailability(artistId, dateStr, dow) {
  try {
    // 1. Check for active blackout on this date
    const { data: blackouts } = await supabase
      .from('artist_blackouts')
      .select('id')
      .eq('artist_id', artistId)
      .lte('start_date', dateStr)
      .gte('end_date', dateStr);

    if (blackouts && blackouts.length > 0) {
      return { isBlackedOut: true, shift: null };
    }

    // 2. Fetch shift hours for this day of week
    const { data: schedules } = await supabase
      .from('artist_schedules')
      .select('start_hour, end_hour')
      .eq('artist_id', artistId)
      .eq('day_of_week', dow)
      .eq('is_active', true)
      .maybeSingle();

    if (schedules) {
      return { isBlackedOut: false, shift: [schedules.start_hour, schedules.end_hour] };
    }

    // No row found means artist does not work this day
    return { isBlackedOut: false, shift: null };
  } catch (err) {
    console.warn('Supabase schedule query failed, using safety defaults:', err.message);
    const fallback = DEFAULT_HOURS[artistId] || DEFAULT_HOURS.liz;
    return { isBlackedOut: false, shift: fallback[dow] || null };
  }
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

    const date = new Date(dateStr + 'T00:00:00');
    const dow  = date.getDay();

    // Query Supabase for dynamic shift & blackout
    const { isBlackedOut, shift } = await getDynamicArtistAvailability(artistId, dateStr, dow);

    if (isBlackedOut || !shift) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ isFullyBlocked: true, busyIntervals: [], blackout: isBlackedOut }),
      };
    }

    // Auth with Google Calendar
    const auth = new google.auth.JWT({
      email: CLIENT_EMAIL,
      key:   PRIVATE_KEY,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });

    const calendar = google.calendar({ version: 'v3', auth });

    // Calculate precise DST offset for the requested date
    function getNYOffset(dStr) {
      const d = new Date(`${dStr}T12:00:00Z`);
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).formatToParts(d);
      const nyHour = parseInt(parts.find(p => p.type === 'hour').value, 10);
      let diff = nyHour - 12;
      if (diff > 0) diff -= 24;
      return `${diff < 0 ? '-' : '+'}${String(Math.abs(diff)).padStart(2, '0')}:00`;
    }
    const offset = getNYOffset(dateStr);

    const dayBefore = new Date(`${dateStr}T00:00:00${offset}`);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    const dayAfter = new Date(`${dateStr}T23:59:59${offset}`);
    dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);

    const res = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: dayBefore.toISOString(),
      timeMax: dayAfter.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = res.data.items || [];

    function isAllDayEventOnDate(ev) {
      if (!ev.start || !ev.start.date || ev.start.dateTime) return false;
      const startDate = ev.start.date;
      const endDate = (ev.end && ev.end.date) || startDate;
      return dateStr >= startDate && dateStr < endDate;
    }

    let isFullyBlocked = false;
    const busyIntervals = [];

    events.forEach(ev => {
      if (!ev.start) return;

      if (ev.start.date && !ev.start.dateTime) {
        if (isAllDayEventOnDate(ev)) isFullyBlocked = true;
      } else {
        const evStart = new Date(ev.start.dateTime);
        const evEnd   = new Date(new Date(ev.end.dateTime).getTime() + BUFFER_MIN * 60 * 1000);

        const targetDayStart = new Date(`${dateStr}T00:00:00${offset}`);
        const targetDayEnd   = new Date(`${dateStr}T23:59:59${offset}`);
        
        if (evEnd > targetDayStart && evStart < targetDayEnd) {
          busyIntervals.push({
            start: Math.max(evStart.getTime(), targetDayStart.getTime()),
            end: Math.min(evEnd.getTime(), targetDayEnd.getTime())
          });
        }
      }
    });

    busyIntervals.sort((a, b) => a.start - b.start);

    // Merge overlapping intervals
    const mergedIntervals = [];
    if (busyIntervals.length > 0) {
      let current = busyIntervals[0];
      for (let i = 1; i < busyIntervals.length; i++) {
        const next = busyIntervals[i];
        if (next.start <= current.end) {
          current.end = Math.max(current.end, next.end);
        } else {
          mergedIntervals.push(current);
          current = next;
        }
      }
      mergedIntervals.push(current);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        isFullyBlocked,
        busyIntervals: mergedIntervals,
        shiftStart: shift[0],
        shiftEnd: shift[1]
      }),
    };

  } catch (err) {
    console.error('get-availability error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to fetch availability', busyIntervals: [], isFullyBlocked: true }),
    };
  }
};
