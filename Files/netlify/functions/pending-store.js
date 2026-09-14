/**
 * pending-store.js
 *
 * Storage layer for PENDING appointments — the safety-net record that lets
 * a booking be rescued if the customer's browser dies after they pay.
 *
 * ── WHY THIS EXISTS ──
 * Today, an appointment's details (artist, service, date, time, contact
 * info) live only in the customer's browser until the booking completes.
 * If they pay on Clover and then close the tab before the browser finishes
 * the booking, those details are gone — a background process could see the
 * payment in Clover but would have no idea what appointment it was for.
 *
 * This store fixes that: the moment the customer clicks "Pay $20", the
 * frontend saves the appointment details here FIRST, before sending them
 * to Clover. Later phases (a background sweep) read these records to finish
 * any booking the browser failed to complete.
 *
 * ── DELIBERATELY SEPARATE FROM clover-store.js ──
 * This uses its OWN store ("pending-bookings"), completely separate from
 * the "clover-deposits" payment store. A pending appointment is not a
 * payment and must never be confused with one. Keeping them apart means
 * nothing in this file can ever affect the live payment/booking logic.
 *
 * ── STORE SHAPE ──
 * Store name: "pending-bookings"
 * Key:   a unique pendingId we generate (random hex)
 * Value: {
 *   pendingId:  string,      // unique id (also the key)
 *   createdAt:  number,      // epoch ms when saved (before Clover redirect)
 *   status:     string,      // "pending" | "completed" | "expired"
 *                            //   Phase 1 only ever writes "pending".
 *   booking: {               // everything needed to complete the booking later
 *     firstName, lastName, email, phone, notes,
 *     date, time, services, total, artist, durationMinutes
 *   }
 * }
 *
 * Phase 1 scope: this file only WRITES pending records (and provides read
 * helpers for later phases). Nothing reads or acts on them yet.
 */

const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

const STORE_NAME = 'pending-bookings';

// A pending record older than this is considered stale. Phase 1 does not
// act on this yet; it's defined here as the single source of truth so the
// background sweep (Phase 2+) and any cleanup use the same value. Wide
// enough to comfortably cover the whole pay-then-rescue window.
const PENDING_TTL_MIN = 60;

function store() {
  // Mirror clover-store.js exactly: prefer explicit BLOBS_SITE_ID /
  // BLOBS_TOKEN env vars (the reliable manual path), fall back to
  // @netlify/blobs auto-detection otherwise.
  const siteID = process.env.BLOBS_SITE_ID;
  const token  = process.env.BLOBS_TOKEN;
  if (siteID && token) {
    return getStore({ name: STORE_NAME, siteID, token });
  }
  return getStore(STORE_NAME);
}

/**
 * Save a pending appointment before the customer leaves for Clover.
 * Returns the generated pendingId so the frontend could correlate later
 * if desired (not required for the rescue flow to work).
 *
 * @param {object} booking  appointment details captured at pay-time
 * @returns {Promise<object>} the stored pending record
 */
async function savePending(booking = {}) {
  const pendingId = crypto.randomBytes(16).toString('hex');

  const record = {
    pendingId,
    createdAt: Date.now(),
    status: 'pending',
    booking: {
      firstName:       booking.firstName || '',
      lastName:        booking.lastName || '',
      email:           booking.email || '',
      phone:           booking.phone || '',
      notes:           booking.notes || '',
      date:            booking.date || '',
      time:            booking.time || '',
      services:        Array.isArray(booking.services) ? booking.services : [],
      total:           Number.isFinite(booking.total) ? booking.total : 0,
      artist:          booking.artist || 'Liz Wendy Cedeño',
      durationMinutes: Number.isFinite(booking.durationMinutes) ? booking.durationMinutes : 60,
    },
  };

  await store().setJSON(pendingId, record);
  return record;
}

/**
 * Read one pending record by id. (For later phases.)
 * @param {string} pendingId
 * @returns {Promise<object|null>}
 */
async function getPending(pendingId) {
  if (!pendingId) return null;
  return store().get(pendingId, { type: 'json' });
}

/**
 * List all pending records. (For the background sweep in later phases.)
 * Returns the full record objects, not just keys.
 * @returns {Promise<object[]>}
 */
async function listPending() {
  const s = store();
  const { blobs } = await s.list();
  const out = [];
  for (const b of blobs) {
    const rec = await s.get(b.key, { type: 'json' });
    if (rec) out.push(rec);
  }
  return out;
}

/**
 * Mark a pending record's status. (For later phases — e.g. "completed"
 * once a rescue books it, or "expired" during cleanup.) Direct write by
 * key. Returns the updated record, or null if not found.
 * @param {string} pendingId
 * @param {string} status
 * @returns {Promise<object|null>}
 */
async function setPendingStatus(pendingId, status) {
  if (!pendingId) throw new Error('setPendingStatus: pendingId is required');
  const s = store();
  const rec = await s.get(pendingId, { type: 'json' });
  if (!rec) return null;
  rec.status = status;
  await s.setJSON(pendingId, rec);
  return rec;
}

/**
 * Mark a pending record as a slot CONFLICT (permanently done — never
 * retried). Stores the exact payment id so the resume flow can reconfirm
 * that specific payment later, and a conflictAt timestamp that starts the
 * resume-link countdown. (The 2-hour cutoff is enforced by the resume
 * endpoint in Phase 4b, using this timestamp.)
 *
 * @param {string} pendingId
 * @param {string} paymentId   the exact Clover payment id to reuse on resume
 * @returns {Promise<object|null>} the updated record, or null if not found
 */
async function markConflict(pendingId, paymentId) {
  if (!pendingId) throw new Error('markConflict: pendingId is required');
  const s = store();
  const rec = await s.get(pendingId, { type: 'json' });
  if (!rec) return null;
  rec.status = 'conflict';
  rec.paymentId = paymentId || null;
  rec.conflictAt = Date.now();
  await s.setJSON(pendingId, rec);
  return rec;
}

module.exports = {
  savePending,
  getPending,
  listPending,
  setPendingStatus,
  markConflict,
  PENDING_TTL_MIN,
  _STORE_NAME: STORE_NAME,
};
