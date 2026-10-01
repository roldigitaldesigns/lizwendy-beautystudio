/**
 * GET /.netlify/functions/get-availability?date=YYYY-MM-DD&artistId=liz
 */

const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

// ── SUPABASE CONFIG (with direct fallbacks from admin.html) ──
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dayyxufmvxqxobjxdxzv.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRheXl4dWZtdnhxeG9ianhkeHp2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3ODAxNjQsImV4cCI6MjEwNTM1NjE2NH0.Oaqg-UIEYlob64MYMypadVjRcMSDowZ9BshhJKO6PEc';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── GOOGLE CREDENTIALS PARSER (Matches working admin-sync-gcal.js) ──
function getGoogleAuth() {
  let credentials = null;
  const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || 
                  process.env.GOOGLE_CREDENTIALS || 
                  process.env.GOOGLE_SERVICE_ACCOUNT ||
                  process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (rawJson) {
    try {
      credentials = JSON.parse(rawJson);
    } catch (e) {
      credentials = JSON.parse(Buffer.from(rawJson, 'base64').toString('utf8'));
    }
  } else {
    credentials = {
      client_email: process.env.GOOGLE_CLIENT_EMAIL || process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    };
  }

  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  });
}

// ── CALENDAR ROUTING ──
const CALENDAR_IDS = {
  liz:     process.env.GOOGLE_CALENDAR_ID || process.env.CALENDAR_ID,
  johanna: process.env.JOHANNA_CALENDAR_ID || process.env.GOOGLE_CALENDAR_ID || process.env.CALENDAR_ID,
};

const DEFAULT_HOURS = {
  liz: {
    1: [9, 19], // Mon
    2: [9, 19], // Tue
    3: [9, 19], // Wed
    4: [9, 19], // Thu
    5: [9, 19], // Fri
    6: [8, 16], // Sat
    0: null     // Sun
  },
  johanna: {
    1: [9, 19],
    2: [10, 18],
    3: [10, 18],
    4: [10, 18],
    5: [10, 18],
    6: [10, 18],
    0: null
  }
};

const BUFFER_MIN = 0;

async function getDynamicArtistAvailability(artistId, dateStr, dow) {
  try {
    const { data: blackouts } = await supabase
      .from('artist_blackouts')
      .select('id')
      .eq('artist_id', artistId)
      .lte('start_date', dateStr)
      .gte('end_date', dateStr);

    if (blackouts && blackouts.length > 0) {
      return { isBlackedOut: true, shift: null };
    }

    const { data: schedules } = await supabase
      .from('artist_schedules')
      .select('start_hour, end_hour, is_active')
      .eq('artist_id', artistId)
      .eq('day_of_week', dow)
      .maybeSingle();

    if (schedules && schedules.is_active) {
      return { isBlackedOut: false, shift: [schedules.start_hour, schedules.end_hour] };
    }

    if (schedules && !schedules.is_active) {
      return { isBlackedOut: false, shift: null };
    }

    // Safety fallback
    const fallback = DEFAULT_HOURS[artistId] || DEFAULT_HOURS.liz;
    return { isBlackedOut: false, shift: fallback[dow] || null };
  } catch (err) {
    console.warn('Supabase query failed, using safety defaults:', err.message);
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

    const CALENDAR_ID = CALENDAR_IDS[artistId] || process.env.GOOGLE_CALENDAR_ID || process.env.CALENDAR_ID;
    if (!CALENDAR_ID) {
      return { statusCode: 200, headers, body: JSON.stringify({ isFullyBlocked: false, busyIntervals: [], shiftStart: 9, shiftEnd: 19 }) };
    }

    // Parse Day of Week using UTC date parts to prevent timezone drift
    const [y, m, d] = dateStr.split('-').map(Number);
    const targetDate = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const dow = targetDate.getUTCDay();

    const { isBlackedOut, shift } = await getDynamicArtistAvailability(artistId, dateStr, dow);

    if (isBlackedOut || !shift) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ isFullyBlocked: true, busyIntervals: [], blackout: isBlackedOut }),
      };
    }

    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: 'v3', auth });

    function getNYOffset(dStr) {
      const dt = new Date(`${dStr}T12:00:00Z`);
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).formatToParts(dt);
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
      body: JSON.stringify({ error: err.message, busyIntervals: [], isFullyBlocked: true }),
    };
  }
};
