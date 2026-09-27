/**
 * GET /api/get-financials (→ /.netlify/functions/get-financials)
 * Calls the Supabase RPC function `get_ytd_financials()` for the active year.
 */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error.' }) };
  }

  const currentYear = new Date().getFullYear();

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_ytd_financials`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fiscal_year: currentYear }),
    });

    const data = await res.json();
    if (!res.ok) {
      console.error('get_ytd_financials failed:', res.status, data);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not fetch financials.' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify(data || {}) };
  } catch (err) {
    console.error('get-financials error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Unexpected error.' }) };
  }
};
