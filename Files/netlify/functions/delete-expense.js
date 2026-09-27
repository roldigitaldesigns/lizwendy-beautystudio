/**
 * POST /api/delete-expense (→ /.netlify/functions/delete-expense)
 * Deletes an expense by its ID via PostgREST.
 */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error.' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON.' }) };
  }

  const { id } = body;
  if (!id) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing expense id.' }) };
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/expenses?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('delete-expense failed:', res.status, errText);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not delete expense.' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, id }) };
  } catch (err) {
    console.error('delete-expense error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Unexpected error.' }) };
  }
};
