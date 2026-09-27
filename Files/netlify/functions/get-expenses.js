/**
 * GET /api/get-expenses (→ /.netlify/functions/get-expenses)
 * Retrieves expenses ordered by expense_date descending.
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

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/expenses?select=*&order=expense_date.desc,created_at.desc`, {
      method: 'GET',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
    });

    const data = await res.json();
    if (!res.ok) {
      console.error('get-expenses failed:', res.status, data);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not fetch expenses.' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify(data || []) };
  } catch (err) {
    console.error('get-expenses error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Unexpected error.' }) };
  }
};
