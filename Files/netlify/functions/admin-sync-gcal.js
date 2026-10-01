const { google } = require('googleapis');

exports.handler = async (event, context) => {
  try {
    const credentials = {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    };
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });
    const calendar = google.calendar({ version: 'v3', auth });
    
    // Fetch events from today onwards
    const now = new Date();
    now.setHours(0,0,0,0);
    
    const res = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      timeMin: now.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });
    
    return {
      statusCode: 200,
      body: JSON.stringify({ events: res.data.items || [] })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
