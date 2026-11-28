const nodemailer = require('nodemailer');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY;

const GMAIL_USER         = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const STUDIO_EMAIL       = process.env.STUDIO_EMAIL;
const JOHANNA_EMAIL      = process.env.JOHANNA_EMAIL;
const CRON_SECRET        = process.env.CRON_SECRET;
const SITE_URL           = process.env.SITE_URL || 'https://lizwendybeautystudiollc.com';

const DEFAULT_EXCLUDED_EMAILS = new Set([
  'ramonlopez30798@gmail.com',
  'franyelisbatista21@gmail.com',
  'mrodriguez0808@hotmail.com',
]);

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

function formatDateReadable(dateStr) {
  const [y, m, d] = String(dateStr || '').split('-').map(Number);
  if (!y || !m || !d) return dateStr || 'Upcoming Date';
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return `${DAYS[dt.getUTCDay()]}, ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}, ${dt.getUTCFullYear()}`;
}

function formatTime12h(timeStr) {
  const raw = String(timeStr || '').trim();
  if (/am|pm/i.test(raw)) return raw;
  const [h, m = 0] = raw.split(':').map(Number);
  if (!Number.isFinite(h)) return raw;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 || 12;
  return `${hour12}:${String(m || 0).padStart(2, '0')} ${ampm}`;
}

function formatArtistName(artistId) {
  const key = String(artistId || '').toLowerCase();
  if (key === 'johanna') return 'Johanna';
  return 'Liz Wendy Cedeño';
}

function formatServicesText(services) {
  if (Array.isArray(services)) {
    return services
      .map((s) => (typeof s === 'string' ? s : s?.name))
      .filter(Boolean)
      .join(', ');
  }
  if (typeof services === 'string' && services.trim()) {
    try {
      const parsed = JSON.parse(services);
      if (Array.isArray(parsed)) {
        return parsed
          .map((s) => (typeof s === 'string' ? s : s?.name))
          .filter(Boolean)
          .join(', ');
      }
    } catch (_) {
      // plain text fallback
    }
    return services.trim();
  }
  return 'Studio Service';
}

async function fetchUpcomingConfirmedAppointments() {
  const endpoint =
    `appointments?status=eq.confirmed` +
    `&appointment_date=gte.2026-11-28` +
    `&customer_email=not.is.null` +
    `&id=neq.101ea577-55a5-4ffc-8c92-3c15e7855b25` +
    `&order=appointment_date.asc,appointment_time.asc` +
    `&select=id,artist_id,customer_name,customer_email,appointment_date,appointment_time,services`;

  const res = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    method: 'GET',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase fetch error [${res.status}]: ${txt}`);
  }
  return res.json();
}

function buildGroupedRecipients(rows, extraExcluded = new Set()) {
  const grouped = new Map();

  for (const row of rows || []) {
    const email = String(row.customer_email || '').trim().toLowerCase();
    if (!email || DEFAULT_EXCLUDED_EMAILS.has(email) || extraExcluded.has(email)) {
      continue;
    }

    const cleanName = String(row.customer_name || 'Client')
      .replace(/^💅\s*/, '')
      .split('—')[0]
      .trim();
    const firstName = cleanName.split(/\s+/)[0] || 'Client';

    if (!grouped.has(email)) {
      grouped.set(email, {
        email,
        firstName,
        customerName: cleanName,
        appointments: [],
      });
    }

    grouped.get(email).appointments.push({
      id: row.id,
      date: row.appointment_date,
      dateFormatted: formatDateReadable(row.appointment_date),
      timeFormatted: formatTime12h(row.appointment_time),
      artistName: formatArtistName(row.artist_id),
      servicesText: formatServicesText(row.services),
    });
  }

  return Array.from(grouped.values());
}

function renderApologyEmail(recipient) {
  const apptItemsHtml = recipient.appointments
    .map(
      (a) => `
      <li style="margin-bottom:8px;">
        <strong>Date:</strong> ${a.dateFormatted}<br/>
        <strong>Time:</strong> ${a.timeFormatted} — <strong>Artist:</strong> ${a.artistName}<br/>
        <strong>Service(s):</strong> ${a.servicesText}
      </li>`
    )
    .join('');

  const apptItemsText = recipient.appointments
    .map((a) => `- Date: ${a.dateFormatted} | Time: ${a.timeFormatted} | Artist: ${a.artistName} | Service(s): ${a.servicesText}`)
    .join('\n');

  const subject =
    recipient.appointments.length > 1
      ? `Important Update: Your Upcoming Appointments Remain Confirmed (${recipient.appointments.map((a) => a.dateFormatted).join(' & ')})`
      : `Important Update: Your Appointment on ${recipient.appointments[0].dateFormatted} Remains Confirmed`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;padding:24px;border:1px solid #E8DEC8;border-radius:10px;background:#FCFBF8;color:#2B2620;">
      <h2 style="margin:0 0 12px;color:#947234;">Liz Wendy Beauty Studio</h2>
      <p style="margin:0 0 12px;font-size:14px;line-height:1.55;">
        Hi ${recipient.firstName},
      </p>
      <p style="margin:0 0 12px;font-size:14px;line-height:1.55;">
        We are writing to sincerely apologize for an automated system issue earlier that sent an erroneous cancellation notice. Please disregard that message — <strong>your appointment(s) were never cancelled and remain open and confirmed on our schedule.</strong>
      </p>
      <div style="background:#FFFFFF;border:1px solid #E8DEC8;border-radius:8px;padding:14px 16px;margin:14px 0;font-size:13px;line-height:1.6;">
        <div style="font-weight:bold;margin-bottom:8px;color:#947234;">Confirmed Appointment Details:</div>
        <ul style="margin:0;padding-left:18px;">
          ${apptItemsHtml}
        </ul>
        <div style="margin-top:8px;"><strong>Location:</strong> 76 Livingston Ave, New Brunswick, NJ 08901</div>
      </div>
      <p style="margin:0 0 12px;font-size:14px;line-height:1.55;">
        <strong>Hola ${recipient.firstName},</strong> te pedimos una sincera disculpa por un error automático del sistema que envió un aviso de cancelación por equivocación. Por favor ignora ese mensaje: <strong>tu(s) cita(s) sigue(n) activa(s) y confirmada(s) en nuestro calendario.</strong>
      </p>
      <p style="margin:0;font-size:13px;color:#7A7060;line-height:1.5;">
        No action is needed on your part. If you have any questions, reply to this email or visit <a href="${SITE_URL}" style="color:#947234;">${SITE_URL}</a>.
      </p>
    </div>
  `;

  const text = [
    `Hi ${recipient.firstName},`,
    '',
    'We sincerely apologize for an automated system issue earlier that sent an erroneous cancellation notice. Your appointment(s) remain open and confirmed:',
    apptItemsText,
    'Location: 76 Livingston Ave, New Brunswick, NJ 08901',
    '',
    `Hola ${recipient.firstName}, disculpa por el aviso de cancelación por error del sistema. Tu(s) cita(s) sigue(n) activa(s) y confirmada(s).`,
    '',
    `Liz Wendy Beauty Studio — ${SITE_URL}`,
  ].join('\n');

  return { subject, html, text };
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  try {
    const qs = event.queryStringParameters || {};
    const providedSecret =
      event.headers?.['x-cron-secret'] ||
      event.headers?.['X-Cron-Secret'] ||
      qs.secret ||
      '';

    if (CRON_SECRET && providedSecret !== CRON_SECRET) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const confirmSend = qs.confirmSend === 'true' && qs.dryRun !== 'true';
    const extraExcluded = new Set(
      String(qs.exclude || '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)
    );

    const rows = await fetchUpcomingConfirmedAppointments();
    const recipients = buildGroupedRecipients(rows, extraExcluded);

    const preview = recipients.map((r) => ({
      email: r.email,
      name: r.customerName,
      dates: r.appointments.map((a) => `${a.date} (${a.dateFormatted} at ${a.timeFormatted})`),
      subject: renderApologyEmail(r).subject,
    }));

    if (!confirmSend) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(
          {
            mode: 'DRY_RUN_PREVIEW_ONLY',
            note: 'No emails were sent. Pass ?confirmSend=true (with your secret) to actually send.',
            recipient_count: preview.length,
            excluded_default: Array.from(DEFAULT_EXCLUDED_EMAILS),
            excluded_extra: Array.from(extraExcluded),
            recipients: preview,
          },
          null,
          2
        ),
      };
    }

    const transporter = getGmailTransport();
    if (!transporter || !GMAIL_USER) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Gmail SMTP not configured' }) };
    }

    const results = [];
    for (const r of recipients) {
      const { subject, html, text } = renderApologyEmail(r);
      try {
        const info = await transporter.sendMail({
          from: `"Liz Wendy Beauty Studio" <${GMAIL_USER}>`,
          to: r.email,
          cc: STUDIO_EMAIL && STUDIO_EMAIL.toLowerCase() !== r.email ? STUDIO_EMAIL : undefined,
          subject,
          html,
          text,
        });
        results.push({ email: r.email, status: 'sent', messageId: info.messageId });
      } catch (err) {
        results.push({ email: r.email, status: 'failed', error: err.message });
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(
        {
          mode: 'APOLOGY_EMAILS_SENT',
          sent_count: results.filter((x) => x.status === 'sent').length,
          failed_count: results.filter((x) => x.status === 'failed').length,
          results,
        },
        null,
        2
      ),
    };
  } catch (err) {
    console.error('send-apology-emails error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
