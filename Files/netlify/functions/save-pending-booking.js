/**
 * POST /.netlify/functions/save-pending-booking
 *
 * Saves an appointment's details the instant the customer clicks
 * "Pay $20 Deposit to Book," BEFORE they're sent to Clover.
 *
 * ── WHY ──
 * This is the first half of the "rescue" safety net. Appointment details
 * normally live only in the customer's browser until the booking completes.
 * If they pay and then close the tab, those details vanish and a background
 * process would see the payment but not know what to book. Saving them here
 * first gives the (later-phase) background sweep something to complete.
 *
 * ── DESIGN RULES ──
 * - Best-effort and fast: the customer is on their way to Clover. This must
 *   never block or slow that down. The frontend calls it "fire and forget"
 *   and does not wait on the result.
 * - Writes ONLY. It creates a pending record and returns. It does not read
 *   payments, touch the calendar, send email, or affect any existing flow.
 * - Isolated storage: uses pending-store.js ("pending-bookings" store),
 *   entirely separate from the payment store. Nothing here can affect the
 *   live payment/booking logic.
 *
 * Request body (JSON): the same booking shape the frontend already builds
 * for create-booking.js:
 *   { firstName, lastName, email, phone, notes,
 *     date, time, services, total, artist, durationMinutes }
 *
 * Response: { ok: true, pendingId } on success.
 */

const { savePending } = require('./pending-store');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  // Minimal validation only. We deliberately do NOT hard-reject partial
  // data here: this is a best-effort safety net, and a partial record is
  // still more useful to a later rescue than no record at all. The real
  // booking validation stays where it belongs, in create-booking.js.
  try {
    const record = await savePending({
      firstName:       body.firstName,
      lastName:        body.lastName,
      email:           body.email,
      phone:           body.phone,
      notes:           body.notes,
      date:            body.date,
      time:            body.time,
      services:        body.services,
      total:           body.total,
      artist:          body.artist,
      durationMinutes: body.durationMinutes,
    });

    console.log('save-pending-booking: saved pending', record.pendingId,
      '|', record.booking.artist, record.booking.date, record.booking.time);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, pendingId: record.pendingId }),
    };
  } catch (err) {
    // A save failure must never surface as a customer-facing error — they're
    // already heading to Clover. Log it and return a soft failure the
    // frontend can safely ignore.
    console.error('save-pending-booking: save failed (non-blocking):', err);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: false }),
    };
  }
};
