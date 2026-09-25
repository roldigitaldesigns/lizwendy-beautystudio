const { google } = require('googleapis');

exports.handler = async (event, context) => {
  // 1. CORS headers so your Command Center can fetch this data securely
  const headers = {
    'Access-Control-Allow-Origin': '*', // Update this to your Command Center URL in production
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    // 2. Set up Google API Authentication using your existing service account credentials
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
    
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });

    const calendar = google.calendar({ version: 'v3', auth });

    // 3. Define the timeframe: Calculate the last 30 days
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));

    // 4. Fetch the events from the Liz Wendy Beauty Studio calendar
    const response = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID, // Ensure this env variable is set in Netlify
      timeMin: thirtyDaysAgo.toISOString(),
      timeMax: now.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = response.data.items;

    // 5. Parse and Aggregate the Data
    const serviceStats = {};

    events.forEach(item => {
      const desc = item.description || "";
      
      const servicesMatch = desc.match(/Services:\s*(.+)/);
      const totalMatch = desc.match(/Estimated Total:\s*\$(\d+)/);

      if (servicesMatch) {
        // Handle comma-separated multiple services
        const bookedServices = servicesMatch[1].split(',').map(s => s.trim());
        const eventRevenue = totalMatch ? parseInt(totalMatch[1], 10) : 0;
        const revenuePerService = eventRevenue / bookedServices.length;

        bookedServices.forEach(serviceName => {
          if (!serviceStats[serviceName]) {
            serviceStats[serviceName] = { count: 0, revenue: 0 };
          }
          serviceStats[serviceName].count += 1;
          serviceStats[serviceName].revenue += revenuePerService;
        });
      }
    });

    // 6. Format the data for the frontend table
    const trendingArray = Object.keys(serviceStats).map((name, index) => {
      return {
        id: `svc-${index}`, 
        name: name,
        cat: 'Service', // You could expand this to map specific names to categories
        count: serviceStats[name].count,
        revenue: `$${Math.round(serviceStats[name].revenue)}`,
        velocity: '+0%', // Placeholder for now, requires comparing periods
        status: serviceStats[name].count > 5 ? 'Surge' : 'Steady' // Simple threshold logic
      };
    });

    // Sort by highest booking count
    trendingArray.sort((a, b) => b.count - a.count);

    // Assign ranks
    trendingArray.forEach((item, index) => {
      item.rank = index + 1;
    });

    // 7. Return the structured JSON to the Command Center
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(trendingArray)
    };

  } catch (error) {
    console.error('Error fetching calendar data:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to fetch trending data' })
    };
  }
};
