/**
 * POST /api/create-expense   (→ /.netlify/functions/create-expense)
 *
 * Quick-Log Expense engine for the Command Center Accounting & Tax tab.
 *
 * Responsibilities (all server-side, no Supabase key ever reaches the browser):
 *   1. Validate the payload (date, vendor, amount, category allow-list,
 *      payment source, business miles).
 *   2. Convert the dollar amount → integer cents HERE — a client-sent cents
 *      value is never trusted.
 *   3. If a receipt is attached, upload it to the private `receipts` Storage
 *      bucket. A storage failure NEVER blocks the expense insert — the row is
 *      written with receipt_url: null instead.
 *   4. INSERT into public.expenses via PostgREST with return=representation, so
 *      the trigger-computed is_capex_review comes back and the UI can show the
 *      CapEx flag immediately with no second round-trip.
 *
 * is_capex_review is deliberately NOT accepted from the client — the Phase 1
 * BEFORE INSERT/UPDATE trigger computes it in Postgres from amount_cents.
 *
 * Env vars (set in Netlify — never in client code):
 *   SUPABASE_URL                 e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY    service_role key (bypasses RLS; keep secret)
 *   SUPABASE_RECEIPTS_BUCKET     optional, defaults to 'receipts'
 *
 * No new npm dependencies — uses the runtime's global fetch (Node 18+).
 */

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SERVICE_KEY       = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RECEIPTS_BUCKET   = process.env.SUPABASE_RECEIPTS_BUCKET || 'receipts';

// Must match the frontend dropdown EXACTLY and the Schedule C lines used in
// get_ytd_financials(). Anything outside this set is rejected.
const ALLOWED_CATEGORIES = new Set([
  'Line 22 - Supplies',
  'Line 8 - Advertising',
  'Line 20b - Rent/Lease',
  'Line 18 - Office/Software',
  'Line 27a - Other/Masterclasses',
]);

const ALLOWED_PAYMENT_SOURCES = new Set(['Card', 'Cash', 'Checking']);

// Decoded receipt size cap. Netlify synchronous functions cap the request body
// around 6 MB and base64 inflates ~33%, so the frontend caps the raw file at
// 4 MB; this is the server-side backstop.
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('create-expense: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured.');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server not configured for expense logging.' }) };
  }

  // ── Parse ──
  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
  }

  const {
    expense_date,
    vendor,
    amount,          // dollars (number or numeric string) — converted to cents here
    category,
    payment_source,
    business_miles,  // optional, defaults 0
    notes,           // optional
    receipt,         // optional { filename, contentType, dataBase64 }
  } = data;

  // ── Validate ──
  const errors = [];

  if (!expense_date || !/^\d{4}-\d{2}-\d{2}$/.test(expense_date)) {
    errors.push('expense_date is required (YYYY-MM-DD).');
  }

  const vendorClean = typeof vendor === 'string' ? vendor.trim() : '';
  if (!vendorClean) errors.push('vendor is required.');

  const amountNum = Number(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    errors.push('amount must be a positive number (dollars).');
  }

  if (!ALLOWED_CATEGORIES.has(category)) {
    errors.push('category must be one of the mapped Schedule C lines.');
  }

  if (!ALLOWED_PAYMENT_SOURCES.has(payment_source)) {
    errors.push('payment_source must be Card, Cash, or Checking.');
  }

  let milesNum = Number(business_miles);
  if (!Number.isFinite(milesNum) || milesNum < 0) milesNum = 0;

  if (errors.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: errors.join(' ') }) };
  }

  const amount_cents = Math.round(amountNum * 100);
  const notesClean   = (typeof notes === 'string' && notes.trim()) ? notes.trim().slice(0, 2000) : null;

  // ── Optional receipt upload (best-effort — never blocks the insert) ──
  let receipt_url = null;
  if (receipt && receipt.dataBase64 && receipt.filename) {
    try {
      const buffer = Buffer.from(receipt.dataBase64, 'base64');
      if (buffer.length === 0) throw new Error('empty file');
      if (buffer.length > MAX_RECEIPT_BYTES) throw new Error('file exceeds size limit');

      const year = expense_date.slice(0, 4);
      const safeName = String(receipt.filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
      const objectPath = `${year}/${cryptoRandomId()}_${safeName}`;
      const contentType = receipt.contentType || 'application/octet-stream';

     const cleanKey = String(SERVICE_KEY || '').trim().replace(/^["']|["']$/g, '');
      const upRes = await fetch(
        `${SUPABASE_URL}/storage/v1/object/${RECEIPTS_BUCKET}/${objectPath}`,
        {
          method: 'POST',
          headers: {
            apikey: cleanKey,
            Authorization: `Bearer ${cleanKey}`,
            'Content-Type': contentType,
            'x-upsert': 'false',
          },
          body: buffer,
        }
      );

      if (upRes.ok) {
        // Store the full public URL so the frontend can display/open it directly
        receipt_url = `${SUPABASE_URL}/storage/v1/object/public/${RECEIPTS_BUCKET}/${objectPath}`;
      } else {
        const t = await upRes.text();
        console.error('create-expense: receipt upload failed, continuing with null.', upRes.status, t.slice(0, 300));
      }
    } catch (upErr) {
      console.error('create-expense: receipt upload error, continuing with null:', upErr.message);
    }
  }

  // ── Insert (PostgREST). is_capex_review omitted — the trigger sets it. ──
  const row = {
    expense_date,
    vendor: vendorClean,
    amount_cents,
    category,
    payment_source,
    business_miles: milesNum,
    receipt_url,
    notes: notesClean,
  };

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/expenses`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(row),
    });

    const text = await res.text();
    if (!res.ok) {
      console.error('create-expense: insert failed:', res.status, text.slice(0, 500));
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not save the expense. Please try again.' }) };
    }

    let inserted;
    try { inserted = JSON.parse(text); } catch { inserted = null; }
    const record = Array.isArray(inserted) ? inserted[0] : inserted;

    console.log('create-expense: inserted', record && record.id, '| cents:', amount_cents, '| capex:', record && record.is_capex_review);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, expense: record }) };

  } catch (err) {
    console.error('create-expense error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Unexpected error saving the expense.' }) };
  }
};

// Small unique id for receipt object names (avoids collisions without a dep).
function cryptoRandomId() {
  try {
    return require('crypto').randomUUID();
  } catch {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
}
