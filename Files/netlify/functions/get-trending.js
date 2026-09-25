const { google } = require('googleapis');

const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;

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
    // 1. Authenticate with Google JWT using your project's exact env vars
    const auth = new google.auth.JWT(
      CLIENT_EMAIL,
      null,
      PRIVATE_KEY,
      ['https://www.googleapis.com/auth/calendar.readonly']
    );

    const calendar = google.calendar({ version: 'v3', auth });

    // 2. Fetch the past 30 days of appointments
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));

    const response = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: thirtyDaysAgo.toISOString(),
      timeMax: now.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = response.data.items || [];

    // 3. Aggregate service data from descriptions
    const serviceStats = {};

    events.forEach(item => {
      const desc = item.description || '';
      
      const servicesMatch = desc.match(/Services:\s*(.+)/);
      const totalMatch = desc.match(/Estimated Total:\s*\$(\d+)/);

      if (servicesMatch) {
        const bookedServices = servicesMatch[1].split(',').map(s => s.trim());
        const eventRevenue = totalMatch ? parseInt(totalMatch[1], 10) : 0;
        const revenuePerService = bookedServices.length > 0 ? (eventRevenue / bookedServices.length) : 0;

        bookedServices.forEach(serviceName => {
          if (!serviceStats[serviceName]) {
            serviceStats[serviceName] = { count: 0, revenue: 0 };
          }
          serviceStats[serviceName].count += 1;
          serviceStats[serviceName].revenue += revenuePerService;
        });
      }
    });

    // 4. Format for dashboard table
    const trendingArray = Object.keys(serviceStats).map((name, index) => {
      const count = serviceStats[name].count;
      return {
        id: `svc-${index}`,
        name: name,
        cat: 'Service',
        count: count,
        revenue: `$${Math.round(serviceStats[name].revenue).toLocaleString()}`,
        velocity: '+0%',
        status: count >= 5 ? 'Surge' : 'Steady'
      };
    });

    // Sort descending by booking count
    trendingArray.sort((a, b) => b.count - a.count);

    // Assign ranking
    trendingArray.forEach((item, idx) => {
      item.rank = idx + 1;
    });

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
