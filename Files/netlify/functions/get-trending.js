const { google } = require('googleapis');

const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;

// Canonical mapping: Merges bilingual variations into standard English display names
const SERVICE_CANONICAL_MAP = {
  // Pedicures
  'pedicura regular': 'Regular Pedicure',
  'regular pedicure': 'Regular Pedicure',
  'pedicura spa / deluxe': 'Spa / Deluxe Pedicure',
  'spa / deluxe pedicure': 'Spa / Deluxe Pedicure',

  // Manicures
  'gel manicure': 'Gel Manicure',
  'manicura gel': 'Gel Manicure',
  'regular manicure': 'Regular Manicure',
  'manicura regular': 'Regular Manicure',
  'dip powder / sns': 'Dip Powder / SNS',
  'gel x / soft gel tips': 'Gel X / Soft Gel Tips',
  'gel x / tips de gel suave': 'Gel X / Soft Gel Tips',

  // Acrylics
  'acrylic refill': 'Acrylic Refill',
  'relleno acrílico': 'Acrylic Refill',
  'acrylic full set': 'Acrylic Full Set',
  'juego completo acrílico': 'Acrylic Full Set',
  'nail art / design': 'Nail Art / Design',
  'nail art / designs': 'Nail Art / Design',
  'arte de uñas / diseños': 'Nail Art / Design',

  // Beauty / Makeup / PMU / Waxing
  'maquillaje de ocasión': 'Occasion Makeup',
  'occasion makeup': 'Occasion Makeup',
  'bridal makeup': 'Bridal Makeup',
  'deep cleansing facial': 'Deep Cleansing Facial',
  'brazilian wax': 'Brazilian Wax',
  'depilación brasileña': 'Brazilian Wax',
  'línea de bikini': 'Bikini Line Wax',
  'combo brows': 'Combo Brows',
  'cejas polvo / ombré': 'Powder / Ombré Brows',
  'retoque pmu 6–8 semanas': 'PMU Touch-up (6-8 Wks)',
  'delineado de ojos permanente': 'Permanent Eyeliner'
};

function normalizeServiceName(rawName) {
  const cleaned = rawName.trim().toLowerCase();
  return SERVICE_CANONICAL_MAP[cleaned] || rawName.trim();
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
    const auth = new google.auth.JWT(
      CLIENT_EMAIL,
      null,
      PRIVATE_KEY,
      ['https://www.googleapis.com/auth/calendar.readonly']
    );

    const calendar = google.calendar({ version: 'v3', auth });

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
    const sevenDaysAgo = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000));
    const fourteenDaysAgo = new Date(now.getTime() - (14 * 24 * 60 * 60 * 1000));

    const response = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: thirtyDaysAgo.toISOString(),
      timeMax: now.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = response.data.items || [];
    const serviceStats = {};

    events.forEach(item => {
      const desc = item.description || '';
      const eventDate = new Date(item.start?.dateTime || item.start?.date || 0);

      const isCurrentWeek = eventDate >= sevenDaysAgo && eventDate <= now;
      const isPriorWeek = eventDate >= fourteenDaysAgo && eventDate < sevenDaysAgo;

      const servicesMatch = desc.match(/Services:\s*(.+)/);
      const totalMatch = desc.match(/Estimated Total:\s*\$(\d+)/);

      if (servicesMatch) {
        const rawServices = servicesMatch[1].split(',').map(s => s.trim());
        const eventRevenue = totalMatch ? parseInt(totalMatch[1], 10) : 0;
        const revenuePerService = rawServices.length > 0 ? (eventRevenue / rawServices.length) : 0;

        rawServices.forEach(rawName => {
          const canonical = normalizeServiceName(rawName);

          if (!serviceStats[canonical]) {
            serviceStats[canonical] = {
              count: 0,
              revenue: 0,
              currWeekCount: 0,
              priorWeekCount: 0
            };
          }

          serviceStats[canonical].count += 1;
          serviceStats[canonical].revenue += revenuePerService;

          if (isCurrentWeek) serviceStats[canonical].currWeekCount += 1;
          if (isPriorWeek) serviceStats[canonical].priorWeekCount += 1;
        });
      }
    });

    const trendingArray = Object.keys(serviceStats).map((name, index) => {
      const stat = serviceStats[name];
      
      // Calculate week-over-week velocity
      let velocityStr = '0%';
      let status = 'Steady';

      if (stat.priorWeekCount === 0) {
        if (stat.currWeekCount > 0) {
          velocityStr = `+${stat.currWeekCount * 100}%`;
          status = 'Surge';
        }
      } else {
        const diff = stat.currWeekCount - stat.priorWeekCount;
        const pct = Math.round((diff / stat.priorWeekCount) * 100);
        velocityStr = pct >= 0 ? `+${pct}%` : `${pct}%`;
        if (pct >= 25) status = 'Surge';
        else if (pct <= -25) status = 'Cooling';
      }

      return {
        id: `svc-${index}`,
        name: name,
        cat: 'Service',
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
    console.error('Error in get-trending function:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message || 'Failed to fetch trending data' })
    };
  }
};
