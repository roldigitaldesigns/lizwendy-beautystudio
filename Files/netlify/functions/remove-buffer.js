/**
 * GET /.netlify/functions/remove-buffer?key=YOUR_SECRET
 * GET /.netlify/functions/remove-buffer?key=YOUR_SECRET&dry=true
 *
 * ONE-TIME function — removes the 60-minute post-appointment buffer from
 * all upcoming site-booked events on Wendy's Google Calendar.
 *
 * USAGE:
 *   1. Deploy this file to Files/netlify/functions/ on GitHub
 *   2. Set REMOVE_BUFFER_KEY env var in Netlify to any secret word you choose
 *   3. Visit the URL with ?key=YOUR_SECRET&dry=true first to preview
 *   4. Visit with ?key=YOUR_SECRET to apply
 *   5. Delete this file from GitHub when done
 *
 * SAFETY:
 *   - Only touches events containing "Booked via lizwendybeautystudiollc.com"
 *   - Only touches events with duration > 60 min (nothing to remove otherwise)
 *   - Never changes start times — only trims the end by exactly 60 min
 *   - Never touches past appointments
 */

const { google } = require('googleapis');

const CLIENT_EMAIL  = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY   = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const CALENDAR_ID   = process.env.GOOGLE_CALENDAR_ID;
const ALLOWED_KEY   = process.env.REMOVE_BUFFER_KEY;  // secret you set in Netlify

const BUFFER_MS       = 60 * 60 * 1000;
const SITE_MARKER     = 'Booked via lizwendybeautystudiollc.com';
const MIN_DURATION_MS = 30 * 60 * 1000;

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'text/plain; charset=utf-8' };

  // ── AUTH GUARD ──
  const params = event.queryStringParameters || {};
  if (!ALLOWED_KEY || params.key !== ALLOWED_KEY) {
    return { statusCode: 401, headers, body: 'Unauthorized.' };
  }

  const dryRun = String(params.dry || '').toLowerCase() === 'true';
  const lines = [];
  const log = (msg) => { lines.push(msg); console.log(msg); };

  log(dryRun ? '=== DRY RUN — no changes will be written ===' : '=== LIVE RUN — changes will be applied ===');
  log('');

  try {
    const auth = new google.auth.JWT({
      email:  CLIENT_EMAIL,
      key:    PRIVATE_KEY,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    const calendar = google.calendar({ version: 'v3', auth });

    // Fetch all upcoming events (today onward)
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    let allEvents = [];
    let pageToken;
    do {
      const res = await calendar.events.list({
        calendarId:   CALENDAR_ID,
        timeMin:      now.toISOString(),
        singleEvents: true,
        orderBy:      'startTime',
        maxResults:   250,
        pageToken,
      });
      allEvents = allEvents.concat(res.data.items || []);
      pageToken = res.data.nextPageToken;
    } while (pageToken);

    log(`Total upcoming events found: ${allEvents.length}`);
    log('');

    let updated = 0, skipped = 0, errors = 0;

    for (const ev of allEvents) {
      const title = ev.summary || '(no title)';
      const desc  = ev.description || '';

      if (!desc.includes(SITE_MARKER)) {
        log(`SKIP  [not site-booked] "${title}"`);
        skipped++; continue;
      }
      if (!ev.start?.dateTime || !ev.end?.dateTime) {
        log(`SKIP  [all-day event] "${title}"`);
        skipped++; continue;
      }

      const startMs    = new Date(ev.start.dateTime).getTime();
      const endMs      = new Date(ev.end.dateTime).getTime();
      const durationMs = endMs - startMs;
      const newEndMs   = endMs - BUFFER_MS;

      if (durationMs <= 60 * 60 * 1000) {
        log(`SKIP  [already ≤60min, no buffer to remove] "${title}" | ${durationMs/60000}min`);
        skipped++; continue;
      }
      if (newEndMs - startMs < MIN_DURATION_MS) {
        log(`SKIP  [would go below 30min — inspect manually] "${title}"`);
        skipped++; continue;
      }

      const newEnd = new Date(newEndMs).toISOString();
      log(`${dryRun ? 'DRY   ' : 'UPDATE'} "${title}"`);
      log(`       Start:  ${ev.start.dateTime}`);
      log(`       Before: ${ev.end.dateTime} (${durationMs/60000}min)`);
      log(`       After:  ${newEnd} (${(newEndMs-startMs)/60000}min)`);

      if (!dryRun) {
        try {
          await calendar.events.patch({
            calendarId: CALENDAR_ID,
            eventId:    ev.id,
            resource:   { end: { dateTime: newEnd, timeZone: ev.end.timeZone || 'America/New_York' } },
          });
          log(`       ✅ Updated`);
          updated++;
        } catch (err) {
          log(`       ❌ ERROR: ${err.message}`);
          errors++;
        }
      } else {
        updated++;
      }
      log('');
    }

    log('─'.repeat(50));
    log(`${dryRun ? 'Would update' : 'Updated'}: ${updated}`);
    log(`Skipped:  ${skipped}`);
    if (!dryRun) log(`Errors:   ${errors}`);
    if (dryRun)  log('');
    if (dryRun)  log('Remove &dry=true from the URL to apply changes.');

    return { statusCode: 200, headers, body: lines.join('\n') };

  } catch (err) {
    log(`Fatal error: ${err.message}`);
    return { statusCode: 500, headers, body: lines.join('\n') };
  }
};
