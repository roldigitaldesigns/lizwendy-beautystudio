const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ADMIN_PIN = process.env.ADMIN_SECRET_PIN || '1234';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-pin',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const incomingPin = event.headers['x-admin-pin'];
  if (incomingPin !== ADMIN_PIN) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized PIN' }) };
  }

  try {
    if (event.httpMethod === 'GET') {
      const [{ data: artists }, { data: services }] = await Promise.all([
        supabase.from('studio_artists').select('*').order('created_at', { ascending: true }),
        supabase.from('studio_services').select('*').order('name', { ascending: true })
      ]);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ artists: artists || [], services: services || [] })
      };
    }

    const { action, table, record, id } = JSON.parse(event.body || '{}');

    if (table === 'services') {
      if (action === 'save') {
        const { data, error } = await supabase.from('studio_services').upsert(record).select();
        if (error) throw error;
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, data }) };
      }
      if (action === 'delete') {
        const { error } = await supabase.from('studio_services').delete().eq('id', id);
        if (error) throw error;
        return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
      }
    }

    if (table === 'artists') {
      if (action === 'save') {
        const { data, error } = await supabase.from('studio_artists').upsert(record).select();
        if (error) throw error;
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, data }) };
      }
      if (action === 'delete') {
        const { error } = await supabase.from('studio_artists').update({ is_active: false }).eq('id', id);
        if (error) throw error;
        return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
      }
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid operation' }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
