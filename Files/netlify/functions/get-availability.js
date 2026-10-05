/**
 * GET /.netlify/functions/get-availability?date=YYYY-MM-DD&artistId=liz
 */

const { google } = require('googleapis');

exports.handler = async (event) => {
  const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
   // 1. SUPABASE CONFIG
    // Strip trailing slashes and quotes from the URL
    const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://dayyxufmvxqxobjxdxzv.supabase.co').replace(/\/$/, '').replace(/['"]/g, '').trim();
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRheXl4dWZtdnhxeG9ianhkeHp2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3ODAxNjQsImV4cCI6MjEwNTM1NjE2NH0.Oaqg-UIEYlob64MYMypadVjRcMSDowZ9BshhJKO6PEc';
    
    // Strip hidden quotes and spaces from the key
    const rawAuth = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
    const authKey = rawAuth.replace(/['"]/g, '').trim();

    // 2. PARSE REQUEST
    const dateStr = event.queryStringParameters && event.queryStringParameters.date;
    const artistId = (event.queryStringParameters && event.queryStringParameters.artistId) || 'liz';

    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid date' }) };
    }

    // 3. CALENDAR ROUTING
    let CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || process.env.CALENDAR_ID;
    if (artistId === 'johanna' && process.env.JOHANNA_CALENDAR_ID) {
      CALENDAR_ID = process.env.JOHANNA_CALENDAR_ID;
    }

    // 4. GET TARGET DATE DAY OF WEEK & NY OFFSET
    const partsDate = dateStr.split('-');
    const y = parseInt(partsDate[0], 10);
    const m = parseInt(partsDate[1], 10);
    const d = parseInt(partsDate[2], 10);
    const targetDate = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const dow = targetDate.getUTCDay();

    function getNYOffset(dStr) {
      const dt = new Date(dStr + 'T12:00:00Z');
      const partsTz = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).formatToParts(dt);
      const nyHour = parseInt(partsTz.find(p => p.type === 'hour').value, 10);
      let diff = nyHour - 12;
      if (diff > 0) diff -= 24;
      return (diff < 0 ? '-' : '+') + String(Math.abs(diff)).padStart(2, '0') + ':00';
    }
    const offset = getNYOffset(dateStr);

    const busyIntervals = [];
    const takenSlotsSet = new Set();

    // 5. FETCH SUPABASE HOURS & BLACKOUTS
    let isBlackedOut = false;
    let shift = null;

    const DEFAULT_HOURS = {
      liz: { 1: [9, 19], 2: [9, 19], 3: [9, 19], 4: [9, 19], 5: [9, 19], 6: [8, 16], 0: null },
    johanna: { 1: [17, 20], 2: [17, 20], 3: null, 4: [17, 20], 5: [17, 20], 6: [8, 15], 0: [8, 12] }
    };

    let fallbackHours = DEFAULT_HOURS[artistId] ? DEFAULT_HOURS[artistId][dow] : (DEFAULT_HOURS.liz[dow] || null);

    const sbHeaders = {
      'apikey': authKey,
      'Authorization': `Bearer ${authKey}`,
      'Content-Type': 'application/json'
    };

    try {
      // 5a. Check Blackouts
      const boRes = await fetch(`${SUPABASE_URL}/rest/v1/artist_blackouts?artist_id=eq.${artistId}&start_date=lte.${dateStr}&end_date=gte.${dateStr}&select=id,start_time,end_time`, { headers: sbHeaders });
      const blackouts = await boRes.json();

      if (Array.isArray(blackouts) && blackouts.length > 0) {
        for (const b of blackouts) {
          if (!b.start_time || !b.end_time) {
            isBlackedOut = true;
            break;
          } else {
            const [sh, sm] = b.start_time.split(':').map(Number);
            const [eh, em] = b.end_time.split(':').map(Number);
            const bStart = new Date(Date.UTC(y, m - 1, d, sh + 4, sm || 0)).getTime();
            const bEnd = new Date(Date.UTC(y, m - 1, d, eh + 4, em || 0)).getTime();
            busyIntervals.push({ start: bStart, end: bEnd });
          }
        }
      }

      // 5b. Check Schedules
      const scRes = await fetch(`${SUPABASE_URL}/rest/v1/artist_schedules?artist_id=eq.${artistId}&day_of_week=eq.${dow}&select=start_hour,end_hour,is_active`, { headers: sbHeaders });
      const schedulesData = await scRes.json();
      console.log("SUPABASE RESPONSE:", schedulesData);
      const schedules = (Array.isArray(schedulesData) && schedulesData.length > 0) ? schedulesData[0] : null;

      if (schedules && schedules.is_active) {
        shift = [schedules.start_hour, schedules.end_hour];
      } else if (schedules && !schedules.is_active) {
        shift = null;
      } else {
        shift = fallbackHours;
      }

      // 5c. Fetch Supabase Appointments (excluding cancelled)
      // Check both artist_id and artist_ref to support both column formats
      const apRes = await fetch(`${SUPABASE_URL}/rest/v1/appointments?appointment_date=eq.${dateStr}&status=neq.cancelled&select=appointment_time,duration_minutes,artist_id,artist_ref`, { headers: sbHeaders });
      const apptsData = await apRes.json();

      if (Array.isArray(apptsData)) {
        apptsData.forEach(apt => {
          const aptArtist = (apt.artist_id || apt.artist_ref || '').toLowerCase();
          if (aptArtist.includes(artistId.toLowerCase()) || artistId.toLowerCase().includes(aptArtist)) {
            if (apt.appointment_time) {
              let t = apt.appointment_time.trim();
              // Parse 12h or 24h formats to HH:MM
              const match12 = t.match(/(\d+):(\d+)\s*(am|pm)/i);
              if (match12) {
                let h = parseInt(match12[1], 10);
                const mn = match12[2];
                const isPm = match12[3].toLowerCase() === 'pm';
                if (isPm && h < 12) h += 12;
                if (!isPm && h === 12) h = 0;
                t = String(h).padStart(2, '0') + ':' + mn;
              } else {
                const match24 = t.match(/^(\d{1,2}):(\d{2})/);
                if (match24) {
                  t = match24[1].padStart(2, '0') + ':' + match24[2];
                }
              }
              takenSlotsSet.add(t);

              // Add to busy intervals
              const [ah, am] = t.split(':').map(Number);
              const dur = apt.duration_minutes || 60;
              const aStart = new Date(`${dateStr}T${String(ah).padStart(2, '0')}:${String(am).padStart(2, '0')}:00${offset}`).getTime();
              const aEnd = aStart + dur * 60 * 1000;
              busyIntervals.push({ start: aStart, end: aEnd });
            }
          }
        });
      }
    } catch (dbErr) {
      shift = fallbackHours;
    }

    if (isBlackedOut || !shift) {
      const allSlots = [];
      for (let h = 0; h < 24; h++) {
        allSlots.push(`${String(h).padStart(2, '0')}:00`, `${String(h).padStart(2, '0')}:15`, `${String(h).padStart(2, '0')}:30`, `${String(h).padStart(2, '0')}:45`);
      }
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ 
          isFullyBlocked: true, 
          busyIntervals: [{ start: 0, end: 9999999999999 }], 
          takenSlots: allSlots, 
          blackout: isBlackedOut 
        })
      };
    }

    // 6. GOOGLE AUTH & EVENTS
    let credentials = {};
    const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CREDENTIALS || process.env.GOOGLE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS;

    if (rawJson) {
      try { credentials = JSON.parse(rawJson); } catch (e) {
        credentials = JSON.parse(Buffer.from(rawJson, 'base64').toString('utf8'));
      }
    } else {
      credentials = {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
      };
    }

    if (CALENDAR_ID && credentials.client_email && credentials.private_key) {
      const auth = new google.auth.JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: ['https://www.googleapis.com/auth/calendar.readonly']
      });
      const calendar = google.calendar({ version: 'v3', auth });

      const dayBefore = new Date(dateStr + 'T00:00:00' + offset);
      dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
      const dayAfter = new Date(dateStr + 'T23:59:59' + offset);
      dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);

      const res = await calendar.events.list({
        calendarId: CALENDAR_ID,
        timeMin: dayBefore.toISOString(),
        timeMax: dayAfter.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      });

      const events = res.data.items || [];
      const targetDayStart = new Date(dateStr + 'T00:00:00' + offset);
      const targetDayEnd = new Date(dateStr + 'T23:59:59' + offset);

     events.forEach(ev => {
        if (!ev.start) return;

        // Check if it's an all-day event
        const isAllDay = ev.start.date && !ev.start.dateTime;

        // Ignore explicitly "Free" events, UNLESS it's an all-day event.
        // This ensures Wendy's all-day events block the calendar automatically.


        if (isAllDay) {
          // Any All-Day Event blocks the day without requiring keywords or "Busy" status
          const startDate = ev.start.date;
          const endDate = (ev.end && ev.end.date) || startDate;
          
          if (dateStr >= startDate && dateStr < endDate) {
            isBlackedOut = true;
            
            // Force block for interval-math frontends
            busyIntervals.push({ start: targetDayStart.getTime(), end: targetDayEnd.getTime() });
            
            // Force block for array-checking frontends
            for (let h = 0; h < 24; h++) {
              takenSlotsSet.add(`${String(h).padStart(2, '0')}:00`);
              takenSlotsSet.add(`${String(h).padStart(2, '0')}:15`);
              takenSlotsSet.add(`${String(h).padStart(2, '0')}:30`);
              takenSlotsSet.add(`${String(h).padStart(2, '0')}:45`);
            }
          }
        } else if (ev.start.dateTime && ev.end.dateTime) {
          const evStart = new Date(ev.start.dateTime);
          const evEnd = new Date(ev.end.dateTime);

          if (evEnd > targetDayStart && evStart < targetDayEnd) {
            busyIntervals.push({
              start: Math.max(evStart.getTime(), targetDayStart.getTime()),
              end: Math.min(evEnd.getTime(), targetDayEnd.getTime())
            });

            // Convert Google event start into HH:MM for takenSlots
            const tzParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(evStart);
            const h = tzParts.find(p => p.type === 'hour').value.padStart(2, '0');
            const mn = tzParts.find(p => p.type === 'minute').value.padStart(2, '0');
            takenSlotsSet.add(`${h}:${mn}`);
          }
        }
      });
      }

    // Merge busy intervals
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
      body: JSON.stringify({
        isFullyBlocked: isBlackedOut,
        busyIntervals: mergedIntervals,
        takenSlots: Array.from(takenSlotsSet),
        shiftStart: shift[0],
        shiftEnd: shift[1]
      }),
    };

  } catch (err) {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message, stack: err.stack, isFullyBlocked: true, busyIntervals: [], takenSlots: [] })
    };
  }
};
