/**
 * GET /.netlify/functions/get-availability?date=YYYY-MM-DD&artistId=liz
 */

const { google } = require('googleapis');

exports.handler = async (event) => {
  const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    // 1. SUPABASE CONFIG
    const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dayyxufmvxqxobjxdxzv.supabase.co';
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRheXl4dWZtdnhxeG9ianhkeHp2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3ODAxNjQsImV4cCI6MjEwNTM1NjE2NH0.Oaqg-UIEYlob64MYMypadVjRcMSDowZ9BshhJKO6PEc';

    // 2. PARSE REQUEST
    const dateStr  = event.queryStringParameters && event.queryStringParameters.date;
    const artistId = (event.queryStringParameters && event.queryStringParameters.artistId) || 'liz';

    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid date' }) };
    }

    // 3. CALENDAR ROUTING
    let CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || process.env.CALENDAR_ID;
    if (artistId === 'johanna' && process.env.JOHANNA_CALENDAR_ID) {
      CALENDAR_ID = process.env.JOHANNA_CALENDAR_ID;
    }

    if (!CALENDAR_ID) {
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ isFullyBlocked: false, busyIntervals: [], shiftStart: 9, shiftEnd: 19 }) };
    }

    // 4. GET TARGET DATE DAY OF WEEK
    const partsDate = dateStr.split('-');
    const y = parseInt(partsDate[0], 10);
    const m = parseInt(partsDate[1], 10);
    const d = parseInt(partsDate[2], 10);
    const targetDate = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const dow = targetDate.getUTCDay();

    // 5. FETCH SUPABASE HOURS (Using native fetch to bypass WebSocket crash)
    let isBlackedOut = false;
    let shift = null;

    const DEFAULT_HOURS = {
      liz: { 1: [9, 19], 2: [9, 19], 3: [9, 19], 4: [9, 19], 5: [9, 19], 6: [8, 16], 0: null },
      johanna: { 1: [9, 19], 2: [10, 18], 3: [10, 18], 4: [10, 18], 5: [10, 18], 6: [10, 18], 0: null }
    };

    let fallbackHours = DEFAULT_HOURS[artistId] ? DEFAULT_HOURS[artistId][dow] : DEFAULT_HOURS.liz[dow];

    try {
      const sbHeaders = {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      };

      // Check Blackouts via raw fetch
      const boRes = await fetch(`${SUPABASE_URL}/rest/v1/artist_blackouts?artist_id=eq.${artistId}&start_date=lte.${dateStr}&end_date=gte.${dateStr}&select=id,start_time,end_time`, { headers: sbHeaders });
    const blackouts = await boRes.json();

   if (blackouts && blackouts.length > 0) {
      for (const b of blackouts) {
        if (!b.start_time || !b.end_time) {
          isBlackedOut = true;
          break;
        } else {
          const [sh, sm] = b.start_time.split(':').map(Number);
          const [eh, em] = b.end_time.split(':').map(Number);
          // America/New_York EDT = UTC-4 (add 4 to hour to get UTC)
          const bStart = new Date(Date.UTC(y, m - 1, d, sh + 4, sm || 0)).getTime();
          const bEnd = new Date(Date.UTC(y, m - 1, d, eh + 4, em || 0)).getTime();
          busyIntervals.push({ start: bStart, end: bEnd });
        }
      }
    }

    // Check Schedules via raw fetch
    const scRes = await fetch(`${SUPABASE_URL}/rest/v1/artist_schedules?artist_id=eq.${artistId}&day_of_week=eq.${dow}&select=start_hour,end_hour,is_active`, { headers: sbHeaders });
    const schedulesData = await scRes.json();
    const schedules = schedulesData.length > 0 ? schedulesData[0] : null;

    if (schedules && schedules.is_active) {
      shift = [schedules.start_hour, schedules.end_hour];
    } else if (schedules && !schedules.is_active) {
      shift = null;
    } else {
      shift = fallbackHours || null;
    }
  } catch (dbErr) {
    shift = fallbackHours || null;
  }

    if (isBlackedOut || !shift) {
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ isFullyBlocked: true, busyIntervals: [], blackout: isBlackedOut }) };
    }

    // 6. GOOGLE AUTH
    let credentials = {};
    const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CREDENTIALS || process.env.GOOGLE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS;

    if (rawJson) {
      try {
        credentials = JSON.parse(rawJson);
      } catch (e) {
        credentials = JSON.parse(Buffer.from(rawJson, 'base64').toString('utf8'));
      }
    } else {
      credentials = {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
      };
    }

    const auth = new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly']
    });
    const calendar = google.calendar({ version: 'v3', auth });

    // 7. TIMEZONE OFFSET
    function getNYOffset(dStr) {
      const dt = new Date(dStr + 'T12:00:00Z');
      const partsTz = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).formatToParts(dt);
      const nyHour = parseInt(partsTz.find(p => p.type === 'hour').value, 10);
      let diff = nyHour - 12;
      if (diff > 0) diff -= 24;
      return (diff < 0 ? '-' : '+') + String(Math.abs(diff)).padStart(2, '0') + ':00';
    }
    const offset = getNYOffset(dateStr);

    const dayBefore = new Date(dateStr + 'T00:00:00' + offset);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    const dayAfter = new Date(dateStr + 'T23:59:59' + offset);
    dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);

    // 8. FETCH EVENTS
    const res = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: dayBefore.toISOString(),
      timeMax: dayAfter.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = res.data.items || [];
    let isFullyBlocked = false;
    const busyIntervals = [];

    events.forEach(ev => {
      if (!ev.start) return;
      if (ev.start.date && !ev.start.dateTime) {
        const summary = (ev.summary || '').toLowerCase();
        const isClosure = summary.includes('closed') || summary.includes('off') || summary.includes('vacation') || summary.includes('holiday') || summary.includes('cerrado');
        if (isClosure) {
          const startDate = ev.start.date;
          const endDate = (ev.end && ev.end.date) || startDate;
          if (dateStr >= startDate && dateStr < endDate) {
            isFullyBlocked = true;
          }
        }
      } else {
        const evStart = new Date(ev.start.dateTime);
        const evEnd   = new Date(new Date(ev.end.dateTime).getTime());
        const targetDayStart = new Date(dateStr + 'T00:00:00' + offset);
        const targetDayEnd   = new Date(dateStr + 'T23:59:59' + offset);

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
      headers: corsHeaders,
      body: JSON.stringify({ isFullyBlocked, busyIntervals: mergedIntervals, shiftStart: shift[0], shiftEnd: shift[1] }),
    };

  } catch (err) {
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message, stack: err.stack, isFullyBlocked: true, busyIntervals: [] })
    };
  }
};
