/**
 * GET or POST /.netlify/functions/lifecycle-emails
 *
 * Automated Customer Lifecycle Emails via Gmail SMTP:
 *  1. 24-Hour Reminder (20h–28h before start_time)
 *  2. Same-Day Reminder (2h–6h before start_time)
 *  3. Next-Day Check-In & Google Review Request (18h–30h after end_time)
 *
 * Protected by optional CRON_SECRET header/query param so external cron
 * runners (GitHub Actions / cron-job.org) can trigger it hourly on any
 * Netlify plan.
 */

const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY;

const supabase = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { enabled: false },
    })
  : null;

const GMAIL_USER         = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const SITE_URL           = process.env.SITE_URL || 'https://lizwendybeautystudiollc.com';
const GOOGLE_REVIEW_URL  = process.env.GOOGLE_REVIEW_URL || `${SITE_URL}`;
const CRON_SECRET        = process.env.CRON_SECRET || '';

const ARTIST_NAMES = {
  liz:     'Liz Wendy Cedeño',
  johanna: 'Johanna',
};

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
  const d = new Date(`${dateStr}T12:00:00`);
  if (isNaN(d.getTime())) return dateStr || '—';
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function formatTime12h(hhmm) {
  const [h, m = 0] = String(hhmm || '09:00').split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${ampm}`;
}

function formatServices(services) {
  if (Array.isArray(services)) {
    return services.map((s) => (typeof s === 'string' ? s : s.name)).join(', ');
  }
  return String(services || 'Beauty Service');
}

async function sendLifecycleEmail({ toEmail, subject, intro, rows, outro, ctaLabel, ctaUrl }) {
  const transporter = getGmailTransport();
  if (!transporter || !toEmail) {
    return { ok: false, skipped: 'gmail_not_configured_or_no_email' };
  }

  const rowsHtml = rows
    .map((r) => `<div><strong>${r.label}:</strong> ${r.value}</div>`)
    .join('');

  const ctaHtml = (ctaLabel && ctaUrl)
    ? `<p style="margin:18px 0 0;"><a href="${ctaUrl}" style="display:inline-block;padding:11px 20px;background:#947234;color:#FFFFFF;text-decoration:none;border-radius:6px;font-size:13px;font-weight:bold;">${ctaLabel}</a></p>`
    : '';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #E8DEC8;border-radius:10px;background:#FCFBF8;color:#2B2620;">
      <h2 style="margin:0 0 12px;color:#947234;">Liz Wendy Beauty Studio</h2>
      <p style="margin:0 0 14px;font-size:14px;line-height:1.5;">${intro}</p>
      <div style="background:#FFFFFF;border:1px solid #E8DEC8;border-radius:8px;padding:14px 16px;margin-bottom:14px;font-size:13px;line-height:1.6;">
        ${rowsHtml}
      </div>
      <p style="margin:0;font-size:13px;color:#7A7060;line-height:1.5;">${outro}</p>
      ${ctaHtml}
    </div>
  `;

  const info = await transporter.sendMail({
    from: `"Liz Wendy Beauty Studio" <${GMAIL_USER}>`,
    to: toEmail,
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
  if (process.env.PAUSE_EMAILS === 'true') {
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ paused: true, sent_24h: 0, sent_sameday: 0, sent_followup: 0 }),
  };
}

  if (CRON_SECRET) {
    const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
    const querySecret = event.queryStringParameters?.secret || '';
    if (authHeader !== `Bearer ${CRON_SECRET}` && querySecret !== CRON_SECRET) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'unauthorized' }) };
    }
  }

  if (!supabase) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'supabase_not_configured' }) };
  }

  const isDryRun = event.queryStringParameters?.dryRun === 'true';
  const nowMs = Date.now();
  const windowStartIso = new Date(nowMs - 36 * 60 * 60 * 1000).toISOString();
  const windowEndIso   = new Date(nowMs + 30 * 60 * 60 * 1000).toISOString();

  try {
    const { data: appts, error } = await supabase
      .from('appointments')
      .select('*')
      .in('status', ['confirmed', 'rescheduled'])
      .gte('start_time', windowStartIso)
      .lte('start_time', windowEndIso);

    if (error) throw new Error(error.message);

    const summary = {
      mode: isDryRun ? 'DRY_RUN' : 'LIVE',
      scanned: (appts || []).length,
      sent_24h: 0,
      sent_sameday: 0,
      sent_followup: 0,
      actions: [],
    };

    for (const appt of appts || []) {
      if (!appt.customer_email || !appt.start_time) continue;

      const startMs = new Date(appt.start_time).getTime();
      const durationMs = (Number(appt.duration_minutes) || 60) * 60 * 1000;
      const endMs = startMs + durationMs;
      const hoursUntilStart = (startMs - nowMs) / (1000 * 60 * 60);
      const hoursSinceEnd   = (nowMs - endMs) / (1000 * 60 * 60);

      const firstName   = String(appt.customer_name || 'Valued Client').split(' ')[0];
      const artistName  = ARTIST_NAMES[appt.artist_id] || 'Liz Wendy Cedeño';
      const dateStr     = formatDateReadable(appt.appointment_date);
      const timeStr     = formatTime12h(appt.appointment_time);
      const serviceList = formatServices(appt.services);
      const manageUrl   = `${SITE_URL}/cancel.html?token=${appt.cancel_token}&artist=${appt.artist_id || 'liz'}`;

      // 1. 24-Hour Reminder (20h to 28h before start)
      if (!appt.reminder_24h_sent && hoursUntilStart >= 20 && hoursUntilStart <= 28) {
        summary.sent_24h++;
        summary.actions.push({ stage: '24h_reminder', id: appt.id, email: appt.customer_email });

        if (!isDryRun) {
          await sendLifecycleEmail({
            toEmail: appt.customer_email,
            subject: `Reminder: Your Appointment Tomorrow — ${timeStr}`,
            intro: `Hi ${firstName}! This is a friendly reminder about your appointment tomorrow with <strong>${artistName}</strong>.`,
            rows: [
              { label: 'Artist', value: artistName },
              { label: 'Date', value: dateStr },
              { label: 'Time', value: timeStr },
              { label: 'Services', value: serviceList },
              { label: 'Location', value: '76 Livingston Ave, New Brunswick, NJ 08901' },
            ],
            outro: 'Please arrive 5 minutes early. Need to make a change? Use the button below to manage your booking.',
            ctaLabel: 'Manage Appointment',
            ctaUrl: manageUrl,
          });

          await supabase
            .from('appointments')
            .update({ reminder_24h_sent: true })
            .eq('id', appt.id);
        }
        continue;
      }

      // 2. Same-Day Reminder (2h to 6h before start)
      if (!appt.reminder_sameday_sent && hoursUntilStart >= 2 && hoursUntilStart <= 6) {
        summary.sent_sameday++;
        summary.actions.push({ stage: 'sameday_reminder', id: appt.id, email: appt.customer_email });

        if (!isDryRun) {
          await sendLifecycleEmail({
            toEmail: appt.customer_email,
            subject: `See You Today at ${timeStr} — Liz Wendy Beauty Studio`,
            intro: `Hi ${firstName}! We're excited to see you today for your appointment with <strong>${artistName}</strong>.`,
            rows: [
              { label: 'Artist', value: artistName },
              { label: 'Today at', value: timeStr },
              { label: 'Services', value: serviceList },
              { label: 'Studio Address', value: '76 Livingston Ave, New Brunswick, NJ 08901' },
            ],
            outro: 'Please plan to arrive 5 minutes early so we can start right on time.',
            ctaLabel: 'View Appointment Details',
            ctaUrl: manageUrl,
          });

          await supabase
            .from('appointments')
            .update({ reminder_sameday_sent: true })
            .eq('id', appt.id);
        }
        continue;
      }

      // 3. Next-Day Check-In & Review / Rebook Prompt (18h to 30h after end)
      if (!appt.followup_sent && hoursSinceEnd >= 18 && hoursSinceEnd <= 30) {
        summary.sent_followup++;
        const isNoShow = appt.attendance_status === 'no_show';
        summary.actions.push({
          stage: isNoShow ? 'noshow_rebook' : 'review_checkin',
          id: appt.id,
          email: appt.customer_email,
        });

        if (!isDryRun) {
          if (isNoShow) {
            await sendLifecycleEmail({
              toEmail: appt.customer_email,
              subject: 'We Missed You at Liz Wendy Beauty Studio',
              intro: `Hi ${firstName}, we missed seeing you for your recent appointment with <strong>${artistName}</strong>.`,
              rows: [
                { label: 'Missed Service', value: serviceList },
                { label: 'Original Date', value: `${dateStr} at ${timeStr}` },
              ],
              outro: 'Life happens! Whenever you are ready to get back on the schedule, you can book a new time online in seconds.',
              ctaLabel: 'Book a New Appointment',
              ctaUrl: SITE_URL,
            });
          } else {
            await sendLifecycleEmail({
              toEmail: appt.customer_email,
              subject: 'Thank You for Visiting Liz Wendy Beauty Studio ✨',
              intro: `Hi ${firstName}! Thank you so much for visiting <strong>${artistName}</strong> yesterday. We hope you love your ${serviceList}!`,
              rows: [
                { label: 'Artist', value: artistName },
                { label: 'Services', value: serviceList },
              ],
              outro: 'Your feedback means the world to our small studio. If you had a 5-star experience, would you take 30 seconds to leave us a Google review?',
              ctaLabel: 'Leave a Google Review',
              ctaUrl: GOOGLE_REVIEW_URL,
            });
          }

          await supabase
            .from('appointments')
            .update({ followup_sent: true })
            .eq('id', appt.id);
        }
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(summary, null, 2),
    };
  } catch (err) {
    console.error('lifecycle-emails error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
