// verify-audit-code.js
// Checks a one-time access code for the Stalled Proposal Audit tool.
// Receives ONLY the code string — never any deal/pipeline data.
// On first valid use, marks the code as used so it cannot be reused.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ valid: false, message: 'Method not allowed.' }) };
  }

  let code;
  try {
    const body = JSON.parse(event.body);
    code = (body.code || '').trim();
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ valid: false, message: 'Invalid request.' }) };
  }

  if (!code) {
    return { statusCode: 400, body: JSON.stringify({ valid: false, message: 'No code provided.' }) };
  }

  try {
    const { data: row, error: fetchError } = await supabase
      .from('audit_codes')
      .select('id, used')
      .eq('code', code)
      .single();

    if (fetchError || !row) {
      return { statusCode: 200, body: JSON.stringify({ valid: false, message: 'That code was not recognized. Contact Don for a new one.' }) };
    }

    if (row.used) {
      return { statusCode: 200, body: JSON.stringify({ valid: false, message: 'That code has already been used. Contact Don for a new one.' }) };
    }

    const { error: updateError } = await supabase
      .from('audit_codes')
      .update({ used: true, used_at: new Date().toISOString() })
      .eq('id', row.id);

    if (updateError) {
      return { statusCode: 500, body: JSON.stringify({ valid: false, message: 'Something went wrong verifying that code. Try again in a moment.' }) };
    }

    return { statusCode: 200, body: JSON.stringify({ valid: true }) };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ valid: false, message: 'Something went wrong. Try again in a moment.' }) };
  }
};
