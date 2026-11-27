const { google } = require('googleapis');
const nodemailer = require('nodemailer');

const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY  = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY;

const GMAIL_USER         = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const STUDIO_EMAIL       = process.env.STUDIO_EMAIL;
const JOHANNA_EMAIL      = process.env.JOHANNA_EMAIL;
const SITE_URL           = process.env.SITE_URL || 'https://lizwendybeautystudiollc.com';

const TENANT_ID = '36f1a3fc-726b-4a30-b1c2-16e32be129b1';

// Configure both artists' Google Calendar IDs and Supabase artist UUIDs
const ARTIST_CALENDARS = [
  {
    key: 'liz',
    name: 'Liz Wendy Cedeño',
    artistId: process.env.ARTIST_ID_WENDY || 'ff5d2df5-b405-4b93-998d-60ae5b8b7926',
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    email: STUDIO_EMAIL,
  },
  {
    key: 'johanna',
    name: 'Johanna',
    artistId: process.env.ARTIST_ID_JOHANNA || 'johanna',
    calendarId: process.env.JOHANNA_CALENDAR_ID || process.env.GOOGLE_CALENDAR_ID_JOHANNA,
    email: JOHANNA_EMAIL,
  },
].filter((a) => a.calendarId && a.artistId);

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

let gmailTransporter = null;
function getGmailTransport() {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) return null;
  if (!gmailTransporter) {
    gmailTransporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: GMAIL_USER,
        pass: GMAIL_APP_PASSWORD,
      },
    });
  }
  return gmailTransporter;
}

function toE164(raw) {
  
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits ? `+${digits}` : '';
}

function fallbackE164FromId(evId) {
  let hash = 0;
  for (const ch of String(evId || '0')) {
    hash = (hash * 31 + ch.charCodeAt(0)) % 10000000;
  }
  return `+1000${String(Math.abs(hash)).padStart(7, '0')}`;
}

function isUuid(val) {
  return typeof val === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(val);
}

function toCents(dollars) {
  const num = parseFloat(dollars);
  return Number.isFinite(num) ? Math.round(num * 100) : 0;
}

function formatTime12h(hhmm) {
  const [h, m = 0] = String(hhmm || '09:00').split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${ampm}`;
}

function formatDateReadable(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`);
  if (isNaN(d.getTime())) return dateStr || '—';
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function getNYDateAndTime(isoString) {
  const dt = new Date(isoString);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(dt);

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const dateStr = `${map.year}-${map.month}-${map.day}`;
  const hourNorm = map.hour === '24' ? '00' : map.hour;
  const timeStr = `${hourNorm}:${map.minute}`;
  return { dateStr, timeStr };
}

async function supabaseFetch(endpoint, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase error [${res.status}]: ${text}`);
  }
  return res.json();
}

async function sendCalendarChangeEmail({ toEmail, cc, subject, intro, detailRows, outro }) {
  if (process.env.PAUSE_EMAILS === 'true') {
  return { ok: false, skipped: 'emails_paused' };
}
  const transporter = getGmailTransport();
  if (!transporter || !toEmail) {
    return { ok: false, skipped: 'gmail_not_configured_or_no_email' };
  }

  const rowsHtml = detailRows
    .map((r) => `<div><strong>${r.label}:</strong> ${r.value}</div>`)
    .join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #E8DEC8;border-radius:10px;background:#FCFBF8;color:#2B2620;">
      <h2 style="margin:0 0 12px;color:#947234;">Liz Wendy Beauty Studio</h2>
      <p style="margin:0 0 14px;font-size:14px;line-height:1.5;">${intro}</p>
      <div style="background:#FFFFFF;border:1px solid #E8DEC8;border-radius:8px;padding:14px 16px;margin-bottom:14px;font-size:13px;line-height:1.6;">
        ${rowsHtml}
      </div>
      <p style="margin:0;font-size:13px;color:#7A7060;line-height:1.5;">${outro}</p>
    </div>
  `;

  const info = await transporter.sendMail({
    from: `"Liz Wendy Beauty Studio" <${GMAIL_USER}>`,
    to: toEmail,
    cc: cc || undefined,
    subject,
    html,
  });

  return { ok: true, messageId: info.messageId };
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
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });

    const calendar = google.calendar({ version: 'v3', auth });

    const customersToUpsert = [];
    const bookingsToUpsert = [];
    const skipped = [];
    const perArtistStats = {};
    const changeAlerts = [];

    for (const artist of ARTIST_CALENDARS) {
      const calRes = await calendar.events.list({
        calendarId: artist.calendarId,
        timeMin: new Date(fromDate).toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250,
      });

      const items = calRes.data.items || [];
      let insertedForArtist = 0;

      // Map active Google Calendar events by cancelToken so we can detect edits/deletes
      const activeEventsByToken = new Map();

      for (const ev of items) {
        if (!ev.start?.dateTime) {
          skipped.push({ artist: artist.name, summary: ev.summary, reason: 'All-day or no start time' });
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
          skipped.push({ artist: artist.name, summary, reason: 'Manual or personal block' });
          continue;
        }

        if (extProps.cancelToken && ev.status !== 'cancelled') {
          activeEventsByToken.set(extProps.cancelToken, ev);
        }

        const externalRef = extProps.cancelToken || extProps.ledgerRef || `gcal_${ev.id}`;

        let name = extProps.customerFirst || '';
        if (!name) {
          const nameMatch = description.match(/Client:\s*([^\n\r]+)/i);
          name = nameMatch
            ? nameMatch[1].trim()
            : summary.replace(/^💅\s*/, '').split('—')[0].split('-')[0].trim();
        }

        let phone = extProps.customerPhone || '';
        if (!phone) {
          const phoneMatch = description.match(/Phone:\s*([^\n\r]+)/i);
          phone = phoneMatch ? phoneMatch[1].trim() : '';
        }
const normalizedPhone = (phone && toE164(phone).length >= 8)
  ? toE164(phone)
  : fallbackE164FromId(ev.id);

        let email = extProps.customerEmail || '';
        if (!email) {
          const emailMatch = description.match(/Email:\s*([^\n\r\s]+@[^\n\r\s]+)/i);
          email = emailMatch ? emailMatch[1].trim() : null;
        }

        let priceCents = 0;
        if (extProps.priceCents) {
          priceCents = parseInt(extProps.priceCents, 10) || 0;
        } else {
          const totalMatch =
            description.match(/Estimated Total:\s*\$?([0-9]+(?:\.[0-9]{2})?)/i) ||
            description.match(/Total:\s*\$?([0-9]+(?:\.[0-9]{2})?)/i);
          if (totalMatch) priceCents = toCents(parseFloat(totalMatch[1]));
        }

        const startTime = new Date(ev.start.dateTime);
        const endTime = new Date(ev.end.dateTime);
        const durationMinutes = Math.max(15, Math.round((endTime - startTime) / (1000 * 60)));

        if (normalizedPhone) {
          customersToUpsert.push({
            tenant_id: TENANT_ID,
            phone: normalizedPhone,
            display_name: name || 'Client',
            email: email,
          });
        }
const bookingRow = {
  tenant_id: TENANT_ID,
  external_ref: externalRef,
  customer_phone: normalizedPhone,
  artist_id: isUuid(artist.artistId) ? artist.artistId : null,
  channel: 'web',
  locale: 'es',
  price_cents: priceCents,
  status: 'booked',
  appointment_at: startTime.toISOString(),
  duration_minutes: durationMinutes,
  reschedule_count: 0,
  was_deflected: false,
};
bookingsToUpsert.push(bookingRow);
        insertedForArtist++;
      }

      // Compare upcoming Supabase appointments for this artist against Google Calendar
      let cancelledSynced = 0;
      let timeUpdatedSynced = 0;

      if (SUPABASE_URL && SUPABASE_KEY) {
        const nowIso = new Date().toISOString();
        const query =
          `appointments?artist_id=eq.${encodeURIComponent(artist.key)}` +
          `&status=in.(confirmed,rescheduled)` +
          `&start_time=gte.${encodeURIComponent(nowIso)}` +
          `&select=id,cancel_token,customer_name,customer_email,appointment_date,appointment_time,start_time,services,status`;

        const appts = await supabaseFetch(query, {
          method: 'GET',
          headers: { Prefer: 'return=representation' },
        });

        for (const appt of appts || []) {
          if (!appt.cancel_token) continue;
          const gcalEv = activeEventsByToken.get(appt.cancel_token);
          const servicesText = Array.isArray(appt.services)
            ? appt.services.map((s) => (typeof s === 'string' ? s : s.name)).join(', ')
            : String(appt.services || 'Appointment');
          const firstName = String(appt.customer_name || 'Client').split(' ')[0];

          // 1. Deleted/cancelled directly on Google Calendar
          if (!gcalEv) {
            cancelledSynced++;
            changeAlerts.push({ type: 'cancelled_on_gcal', token: appt.cancel_token, email: appt.customer_email });

            if (!isDryRun) {
              await supabaseFetch(
                `appointments?id=eq.${encodeURIComponent(appt.id)}`,
                {
                  method: 'PATCH',
                  body: JSON.stringify({ status: 'cancelled' }),
                }
              );

              if (appt.customer_email) {
                await sendCalendarChangeEmail({
                  toEmail: appt.customer_email,
                  cc: STUDIO_EMAIL && appt.customer_email !== STUDIO_EMAIL ? STUDIO_EMAIL : undefined,
                  subject: `Appointment Update — ${formatDateReadable(appt.appointment_date)}`,
                  intro: `Hi ${firstName}, your upcoming appointment with <strong>${artist.name}</strong> has been cancelled/removed from the schedule.`,
                  detailRows: [
                    { label: 'Artist', value: artist.name },
                    { label: 'Date', value: formatDateReadable(appt.appointment_date) },
                    { label: 'Time', value: formatTime12h(appt.appointment_time) },
                    { label: 'Services', value: servicesText },
                  ],
                  outro: `If you would like to book a new time, visit <a href="${SITE_URL}" style="color:#947234;">${SITE_URL}</a> or reach out to the studio directly.`,
                });
              }
            }
            continue;
          }

          // 2. Moved/edited directly on Google Calendar
          const calStartIso = gcalEv.start?.dateTime;
          if (calStartIso) {
            const { dateStr: calDate, timeStr: calTime } = getNYDateAndTime(calStartIso);
            const oldDate = appt.appointment_date;
            const oldTime = String(appt.appointment_time || '').slice(0, 5);

            if (calDate !== oldDate || calTime !== oldTime) {
              timeUpdatedSynced++;
              changeAlerts.push({
                type: 'moved_on_gcal',
                token: appt.cancel_token,
                from: `${oldDate} ${oldTime}`,
                to: `${calDate} ${calTime}`,
              });

              if (!isDryRun) {
                await supabaseFetch(
                  `appointments?id=eq.${encodeURIComponent(appt.id)}`,
                  {
                    method: 'PATCH',
                    body: JSON.stringify({
                      appointment_date: calDate,
                      appointment_time: calTime,
                      start_time: new Date(calStartIso).toISOString(),
                    }),
                  }
                );

                if (appt.customer_email) {
                  await sendCalendarChangeEmail({
                    toEmail: appt.customer_email,
                    cc: STUDIO_EMAIL && appt.customer_email !== STUDIO_EMAIL ? STUDIO_EMAIL : undefined,
                    subject: `Appointment Time Updated — ${formatDateReadable(calDate)}`,
                    intro: `Hi ${firstName}, your appointment time with <strong>${artist.name}</strong> was updated on the studio calendar.`,
                    detailRows: [
                      { label: 'Artist', value: artist.name },
                      { label: 'Previous Slot', value: `${formatDateReadable(oldDate)} at ${formatTime12h(oldTime)}` },
                      { label: 'New Date', value: formatDateReadable(calDate) },
                      { label: 'New Time', value: formatTime12h(calTime) },
                      { label: 'Services', value: servicesText },
                      { label: 'Location', value: '76 Livingston Ave, New Brunswick, NJ 08901' },
                    ],
                    outro: `Please reach out to the studio if you have any questions about this updated time.`,
                  });
                }
              }
            }
          }
        }
      }

      perArtistStats[artist.name] = {
        scanned: items.length,
        synced: insertedForArtist,
        cancelled_on_gcal: cancelledSynced,
        moved_on_gcal: timeUpdatedSynced,
      };
    }

    if (!isDryRun) {
      const uniqueCustomers = Array.from(new Map(customersToUpsert.map((c) => [c.phone, c])).values());

      if (uniqueCustomers.length > 0) {
        await supabaseFetch('customers?on_conflict=tenant_id,phone', {
          method: 'POST',
          body: JSON.stringify(uniqueCustomers),
        });
      }

      if (bookingsToUpsert.length > 0) {
        await supabaseFetch('bookings?on_conflict=tenant_id,external_ref', {
          method: 'POST',
          body: JSON.stringify(bookingsToUpsert),
        });
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(
        {
          mode: isDryRun ? 'DRY_RUN' : 'MULTI_ARTIST_SYNC_COMPLETE',
          artists: perArtistStats,
          total_inserted: bookingsToUpsert.length,
          skipped_blocks: skipped.length,
          change_alerts: changeAlerts,
        },
        null,
        2
      ),
    };
  } catch (err) {
    console.error('sync-calendar fatal error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, stack: err.stack }) };
  }
};
