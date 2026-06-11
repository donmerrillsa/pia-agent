// _utils/supabase.js
// Shared Supabase client — imported by all Netlify functions.
// Uses the SERVICE ROLE key (bypasses RLS) because all writes
// are server-side agent actions, never direct user requests.

const { createClient } = require("@supabase/supabase-js");

let _client = null;

function getSupabaseClient() {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing Supabase credentials. " +
      "Ensure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set in Netlify env."
    );
  }

  _client = createClient(url, key, {
    auth: {
      // Service role — no session management needed
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return _client;
}

module.exports = { getSupabaseClient };
