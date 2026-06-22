// netlify/functions/keep-alive.js
//
// Purpose: Weekly heartbeat to prevent Supabase free-tier auto-pause
// due to inactivity. Runs on a schedule via Netlify Scheduled Functions.
//
// Setup required:
// 1. Place this file at: netlify/functions/keep-alive.js
// 2. Add the schedule config below to your netlify.toml
// 3. Ensure SUPABASE_URL and SUPABASE_ANON_KEY (or SERVICE_ROLE_KEY)
//    are already set as environment variables in Netlify
//    (they should already exist since pia-agent already talks to Supabase)

const { createClient } = require('@supabase/supabase-js');

exports.handler = async function (event, context) {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY/SERVICE_ROLE_KEY environment variables.');
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Missing Supabase environment variables' }),
      };
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Trivial read query — just enough to register as activity.
    // Adjust table name if needed; this assumes a table exists.
    // If unsure, a harmless alternative is querying a system table:
    const { data, error } = await supabase
      .from('pg_tables') // built-in Postgres system table, always exists
      .select('tablename')
      .limit(1);

    if (error) {
      console.error('Supabase keep-alive query failed:', error.message);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: error.message }),
      };
    }

    console.log('Supabase keep-alive ping successful:', new Date().toISOString());

    return {
      statusCode: 200,
      body: JSON.stringify({
        status: 'ok',
        message: 'Supabase keep-alive ping successful',
        timestamp: new Date().toISOString(),
      }),
    };
  } catch (err) {
    console.error('Keep-alive function error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
