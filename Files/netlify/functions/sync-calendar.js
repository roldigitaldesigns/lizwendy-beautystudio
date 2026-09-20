const { google } = require('googleapis');

const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

const TENANT_ID = '36f1a3fc-726b-4a30-b1c2-16e32be129b1';
const ARTIST_ID = 'ff5d2df5-b405-4b93-998d-60ae5b8b7926';

function toE164(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits ? `+${digits}` : '';
}

function toCents(dollars) {
  const num = parseFloat(dollars);
  return Number.isFinite(num) ? Math.round(num * 100) : 0;
}

async function supabaseFetch(endpoint, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=representation',
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase error [${res.status}]: ${text}`);
  }
  return res.json();
}

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
    const insertedBookings = [];
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

      const isSystemBooking =
        summary.startsWith('💅') ||
        description.includes('Booked via lizwendybeautystudiollc.com') ||
        creatorEmail.includes('gserviceaccount.com') ||
        Boolean(extProps.cancelToken || extProps.ledgerRef);

      if (!isSystemBooking) {
        skipped.push({ summary, reason: 'Manual or personal block' });
        continue;
      }

      // 1. External ref
      const externalRef = extProps.cancelToken || extProps.ledgerRef || `gcal_${ev.id}`;

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

      // 5. Price
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

      // 6. Timing
      const startTime = new Date(ev.start.dateTime);
      const endTime = new Date(ev.end.dateTime);
      const durationMinutes = Math.max(15, Math.round((endTime - startTime) / (1000 * 60)));

      // If live run, upsert via REST API
      if (!isDryRun) {
        if (normalizedPhone) {
          await supabaseFetch('customers?on_conflict=tenant_id,phone', {
            method: 'POST',
            body: JSON.stringify({
              tenant_id: TENANT_ID,
              phone: normalizedPhone,
              first_name: name || 'Client',
              email: email,
            }),
          }).catch(e => console.warn('Customer upsert note:', e.message));
        }

        await supabaseFetch('bookings?on_conflict=tenant_id,external_ref', {
          method: 'POST',
          body: JSON.stringify({
            tenant_id: TENANT_ID,
            external_ref: externalRef,
            customer_phone: normalizedPhone,
            artist_id: ARTIST_ID,
            channel: 'web',
            locale: 'es',
            price_cents: priceCents,
            status: 'booked',
            appointment_at: startTime.toISOString(),
            duration_minutes: durationMinutes,
            reschedule_count: 0,
            was_deflected: false,
          }),
        }).catch(e => console.error('Booking insert error:', e.message));
      }

      insertedBookings.push({
        external_ref: externalRef,
        client: name,
        phone: normalizedPhone,
        appointment_at: startTime.toISOString(),
        price_cents: priceCents,
      });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(
        {
          mode: isDryRun ? 'DRY_RUN' : 'DIRECT_SUPABASE_INSERT_COMPLETE',
          total_scanned: items.length,
          total_inserted: insertedBookings.length,
          skipped_blocks: skipped.length,
          sample: insertedBookings.slice(0, 5),
        },
        null,
        2
      ),
    };
  } catch (err) {
    console.error('sync-calendar fatal error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message, stack: err.stack }),
    };
  }
};
