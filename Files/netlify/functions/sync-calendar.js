const { google } = require('googleapis');
const { recordLedgerEvent, toE164, toCents } = require('./_lib/ledger');

const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  const isDryRun = event.queryStringParameters?.dryRun === 'true';
  const fromDate = event.queryStringParameters?.from || '2026-08-01T00:00:00Z';

  try {
    const auth = new google.auth.JWT({
      email: CLIENT_EMAIL,
      key: PRIVATE_KEY,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });

    const calendar = google.calendar({ version: 'v3', auth });

    const calRes = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: new Date(fromDate).toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    });

    const items = calRes.data.items || [];
    const matched = [];
    const skipped = [];

    for (const ev of items) {
      if (!ev.start?.dateTime) {
        skipped.push({ summary: ev.summary, reason: 'All-day or no start time' });
        continue;
      }

      const summary = ev.summary || '';
      const description = ev.description || '';
      const creatorEmail = ev.creator?.email || '';
      const extProps = ev.extendedProperties?.private || {};

      // STRICT FILTER: Only accept bookings created by the booking system
      const isSystemBooking =
        summary.startsWith('💅') ||
        description.includes('Booked via lizwendybeautystudiollc.com') ||
        creatorEmail.includes('gserviceaccount.com') ||
        Boolean(extProps.cancelToken || extProps.ledgerRef);

      if (!isSystemBooking) {
        skipped.push({ summary, reason: 'Manual or personal block' });
        continue;
      }

      // 1. Stable booking ref
      const bookingRef = extProps.cancelToken || extProps.ledgerRef || `gcal_${ev.id}`;

      // 2. Client Name
      let name = extProps.customerFirst || '';
      if (!name) {
        const nameMatch = description.match(/Client:\s*([^\n\r]+)/i);
        if (nameMatch) {
          name = nameMatch[1].trim();
        } else {
          name = summary.replace(/^💅\s*/, '').split('—')[0].split('-')[0].trim();
        }
      }

      // 3. Client Phone
      let phone = extProps.customerPhone || '';
      if (!phone) {
        const phoneMatch = description.match(/Phone:\s*([^\n\r]+)/i);
        phone = phoneMatch ? phoneMatch[1].trim() : '';
      }
      const normalizedPhone = phone ? toE164(phone) : `+1000${ev.id.slice(-7)}`;

      // 4. Client Email
      let email = extProps.customerEmail || '';
      if (!email) {
        const emailMatch = description.match(/Email:\s*([^\n\r\s]+@[^\n\r\s]+)/i);
        email = emailMatch ? emailMatch[1].trim() : null;
      }

      // 5. Service Summary
      let serviceSummary = extProps.serviceList || '';
      if (!serviceSummary) {
        const servMatch = description.match(/Services:\s*([^\n\r]+)/i);
        if (servMatch) {
          serviceSummary = servMatch[1].trim();
        } else if (summary.includes('—')) {
          serviceSummary = summary.split('—')[1].trim();
        } else {
          serviceSummary = summary.replace(/^💅\s*/, '').trim();
        }
      }

      // 6. Price
      let priceCents = 0;
      if (extProps.priceCents) {
        priceCents = parseInt(extProps.priceCents, 10) || 0;
      } else {
        const totalMatch = description.match(/Estimated Total:\s*\$?([0-9]+(?:\.[0-9]{2})?)/i) ||
                           description.match(/Total:\s*\$?([0-9]+(?:\.[0-9]{2})?)/i);
        if (totalMatch) {
          priceCents = toCents(parseFloat(totalMatch[1]));
        }
      }

      // 7. Duration
      const startTime = new Date(ev.start.dateTime);
      const endTime = new Date(ev.end.dateTime);
      const durationMinutes = Math.max(15, Math.round((endTime - startTime) / (1000 * 60)));

      const record = {
        booking_ref: bookingRef,
        customer_phone: normalizedPhone,
        customer_name: name || 'Client',
        customer_email: email,
        service_summary: serviceSummary || 'Beauty Service',
        price_cents: priceCents,
        duration_minutes: durationMinutes,
        appointment_at: startTime.toISOString(),
      };

      if (!isDryRun) {
        await recordLedgerEvent({
          event_type: 'created',
          idempotency_key: `import:${bookingRef}`,
          booking_ref: bookingRef,
          customer_phone: normalizedPhone,
          customer_name: name || 'Client',
          customer_email: email,
          locale: 'es',
          artist_ref: 'liz',
          service_summary: serviceSummary || 'Beauty Service',
          channel: 'calendar_import',
          price_cents: priceCents,
          duration_minutes: durationMinutes,
          appointment_at: startTime.toISOString(),
          actor: 'staff',
        });
      }

      matched.push(record);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        mode: isDryRun ? 'DRY_RUN (safe preview, no DB writes)' : 'LIVE_SYNC (written to database)',
        total_scanned: items.length,
        system_bookings_matched: matched.length,
        personal_blocks_skipped: skipped.length,
        matched_sample: matched,
        skipped_list: skipped.map(s => s.summary),
      }, null, 2),
    };
  } catch (err) {
    console.error('sync-calendar error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
