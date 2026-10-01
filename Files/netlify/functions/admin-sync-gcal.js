const { google } = require('googleapis');

exports.handler = async (event, context) => {
  try {
    let credentials = null;

    // Check if whole JSON blob is stored in one env variable
    const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || 
                    process.env.GOOGLE_CREDENTIALS || 
                    process.env.GOOGLE_SERVICE_ACCOUNT ||
                    process.env.GOOGLE_APPLICATION_CREDENTIALS;

    if (rawJson) {
      try {
        credentials = JSON.parse(rawJson);
      } catch (e) {
        // Handle unescaped base64 or literal strings
        credentials = JSON.parse(Buffer.from(rawJson, 'base64').toString('utf8'));
      }
    } else {
      // Fallback to split variables
      credentials = {
        client_email: process.env.GOOGLE_CLIENT_EMAIL || process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      };
    }

    if (!credentials || !credentials.client_email) {
      throw new Error("No Google Service Account credentials found in environment variables.");
    }

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });
    const calendar = google.calendar({ version: 'v3', auth });

    // Look for calendar ID
    const calendarId = process.env.GOOGLE_CALENDAR_ID || 
                       process.env.CALENDAR_ID || 
                       'primary';

    // Fetch upcoming events from start of today
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    const res = await calendar.events.list({
      calendarId,
      timeMin: now.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 150
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: res.data.items || [] })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
