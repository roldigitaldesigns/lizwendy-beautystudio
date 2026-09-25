const { google } = require('googleapis');

const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;

// Canonical mapping: Merges bilingual variants and tags proper business categories
const SERVICE_META = {
  // Nails
  'pedicura regular': { name: 'Regular Pedicure', cat: 'Nails' },
  'regular pedicure': { name: 'Regular Pedicure', cat: 'Nails' },
  'pedicura spa / deluxe': { name: 'Spa / Deluxe Pedicure', cat: 'Nails' },
  'spa / deluxe pedicure': { name: 'Spa / Deluxe Pedicure', cat: 'Nails' },
  'gel manicure': { name: 'Gel Manicure', cat: 'Nails' },
  'manicura gel': { name: 'Gel Manicure', cat: 'Nails' },
  'regular manicure': { name: 'Regular Manicure', cat: 'Nails' },
  'manicura regular': { name: 'Regular Manicure', cat: 'Nails' },
  'dip powder / sns': { name: 'Dip Powder / SNS', cat: 'Nails' },
  'gel x / soft gel tips': { name: 'Gel X / Soft Gel Tips', cat: 'Nails' },
  'gel x / tips de gel suave': { name: 'Gel X / Soft Gel Tips', cat: 'Nails' },
  'acrylic refill': { name: 'Acrylic Refill', cat: 'Nails' },
  'relleno acrílico': { name: 'Acrylic Refill', cat: 'Nails' },
  'acrylic full set': { name: 'Acrylic Full Set', cat: 'Nails' },
  'juego completo acrílico': { name: 'Acrylic Full Set', cat: 'Nails' },
  'nail art / design': { name: 'Nail Art / Design', cat: 'Nails' },
  'nail art / designs': { name: 'Nail Art / Design', cat: 'Nails' },
  'arte de uñas / diseños': { name: 'Nail Art / Design', cat: 'Nails' },

  // Makeup
  'maquillaje de ocasión': { name: 'Occasion Makeup', cat: 'Makeup' },
  'occasion makeup': { name: 'Occasion Makeup', cat: 'Makeup' },
  'bridal makeup': { name: 'Bridal Makeup', cat: 'Makeup' },
  'maquillaje de novia': { name: 'Bridal Makeup', cat: 'Makeup' },

  // Waxing
  'brazilian wax': { name: 'Brazilian Wax', cat: 'Waxing' },
  'depilación brasileña': { name: 'Brazilian Wax', cat: 'Waxing' },
  'línea de bikini': { name: 'Bikini Line Wax', cat: 'Waxing' },
  'bikini line': { name: 'Bikini Line Wax', cat: 'Waxing' },
  'eyebrow wax': { name: 'Eyebrow Wax', cat: 'Waxing' },
  'depilación de cejas': { name: 'Eyebrow Wax', cat: 'Waxing' },

  // Facials
  'deep cleansing facial': { name: 'Deep Cleansing Facial', cat: 'Facials' },
  'limpieza facial profunda': { name: 'Deep Cleansing Facial', cat: 'Facials' },
  'hydrafacial': { name: 'HydraFacial', cat: 'Facials' },

  // PMU (Permanent Makeup)
  'combo brows': { name: 'Combo Brows', cat: 'PMU' },
  'cejas polvo / ombré': { name: 'Powder / Ombré Brows', cat: 'PMU' },
  'powder / ombré brows': { name: 'Powder / Ombré Brows', cat: 'PMU' },
  'retoque pmu 6–8 semanas': { name: 'PMU Touch-up (6–8 Wks)', cat: 'PMU' },
  'pmu touch-up': { name: 'PMU Touch-up (6–8 Wks)', cat: 'PMU' },
  'delineado de ojos permanente': { name: 'Permanent Eyeliner', cat: 'PMU' },
  'permanent eyeliner': { name: 'Permanent Eyeliner', cat: 'PMU' },
  'lip blush': { name: 'Lip Blush', cat: 'PMU' },

  // Lash Ext
  'classic lash set': { name: 'Classic Lash Set', cat: 'Lash Ext' },
  'volume lash set': { name: 'Volume Lash Set', cat: 'Lash Ext' },
  'lash refill': { name: 'Lash Refill', cat: 'Lash Ext' },
  'extensiones de pestañas': { name: 'Classic Lash Set', cat: 'Lash Ext' }
};

function resolveService(rawName) {
  const key = rawName.trim().toLowerCase();
  if (SERVICE_META[key]) return SERVICE_META[key];
  
  // Smart fallback categorization if unmapped
  let guessedCat = 'Other';
  if (/nail|pedicur|manicur|acryl|gel|dip/i.test(rawName)) guessedCat = 'Nails';
  else if (/makeup|maquill/i.test(rawName)) guessedCat = 'Makeup';
  else if (/wax|depila/i.test(rawName)) guessedCat = 'Waxing';
  else if (/facial|limpieza/i.test(rawName)) guessedCat = 'Facials';
  else if (/pmu|brow|ceja|delineado|lip blush/i.test(rawName)) guessedCat = 'PMU';
  else if (/lash|pestañ/i.test(rawName)) guessedCat = 'Lash Ext';

  return { name: rawName.trim(), cat: guessedCat };
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const rangeDays = parseInt(event.queryStringParameters?.range || '30', 10);
    const validRange = [7, 14, 30, 60].includes(rangeDays) ? rangeDays : 30;

    const auth = new google.auth.JWT(
      CLIENT_EMAIL,
      null,
      PRIVATE_KEY,
      ['https://www.googleapis.com/auth/calendar.readonly']
    );

    const calendar = google.calendar({ version: 'v3', auth });

    const now = new Date();
    const currentWindowStart = new Date(now.getTime() - (validRange * 24 * 60 * 60 * 1000));
    const priorWindowStart = new Date(now.getTime() - (2 * validRange * 24 * 60 * 60 * 1000));

    // Fetch double the window with maxResults 2500 to prevent pagination clipping
    const response = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: priorWindowStart.toISOString(),
      timeMax: now.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 2500
    });

    const events = response.data.items || [];
    const stats = {};

    events.forEach(item => {
      const desc = item.description || '';
      const eventDate = new Date(item.start?.dateTime || item.start?.date || 0);

      const isInCurrentWindow = eventDate >= currentWindowStart && eventDate <= now;
      const isInPriorWindow = eventDate >= priorWindowStart && eventDate < currentWindowStart;

      const servicesMatch = desc.match(/Services:\s*(.+)/);
      const totalMatch = desc.match(/Estimated Total:\s*\$(\d+)/);

      if (servicesMatch) {
        const rawServices = servicesMatch[1].split(',').map(s => s.trim());
        const eventRevenue = totalMatch ? parseInt(totalMatch[1], 10) : 0;
        const revenuePerService = rawServices.length > 0 ? (eventRevenue / rawServices.length) : 0;

        rawServices.forEach(rawName => {
          const resolved = resolveService(rawName);
          const serviceName = resolved.name;

          if (!stats[serviceName]) {
            stats[serviceName] = {
              name: serviceName,
              cat: resolved.cat,
              count: 0,
              revenue: 0,
              priorCount: 0
            };
          }

          if (isInCurrentWindow) {
            stats[serviceName].count += 1;
            stats[serviceName].revenue += revenuePerService;
          } else if (isInPriorWindow) {
            stats[serviceName].priorCount += 1;
          }
        });
      }
    });

   // Format table items
      const trendingArray = Object.values(stats)
        .filter(s => s.count > 0)
        .map((stat, index) => {
          let velocityStr = '0%';
          let status = 'Steady';

          if (stat.priorCount === 0) {
            // If there are zero prior events:
            // For established services with significant volume, show baseline pending (—)
            // For lower volume services, tag as New
            if (stat.count >= 5) {
              velocityStr = '—';
              status = stat.count >= 15 ? 'Surge' : 'Steady';
            } else {
              velocityStr = 'New';
              status = 'Surge';
            }
          } else {
            const diff = stat.count - stat.priorCount;
            const pct = Math.round((diff / stat.priorCount) * 100);
            velocityStr = pct > 0 ? `+${pct}%` : `${pct}%`;

            if (pct >= 25) {
              status = 'Surge';
            } else if (pct <= -20) {
              status = 'Cooling';
            } else {
              status = 'Steady';
            }
          }

          return {
            id: `svc-${index}`,
            name: stat.name,
            cat: stat.cat,
            count: stat.count,
            revenue: `$${Math.round(stat.revenue).toLocaleString()}`,
            velocity: velocityStr,
            status: status
          };
        });

    trendingArray.sort((a, b) => b.count - a.count);
    trendingArray.forEach((item, idx) => { item.rank = idx + 1; });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(trendingArray)
    };

  } catch (error) {
    console.error('Error in get-trending:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message || 'Failed to fetch trending data' })
    };
  }
};
