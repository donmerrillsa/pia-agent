// netlify/functions/on-demand-trigger.js
//
// GET /.netlify/functions/on-demand-trigger?client_id=<uuid>&token=<uuid>
//
// Customer-facing "Run my Pipeline Report now" link. Designed to be
// clicked directly from a browser (GET, not POST), unlike run-pipeline
// which expects a POST with a JSON body.
//
// Flow:
//   1. Validate client_id + token against the clients table in Supabase
//   2. If valid, internally call run-pipeline (POST) for that client
//   3. Return a friendly HTML confirmation page
//   4. If invalid, return a generic "invalid link" page — no hints
//      about why, so it can't be used to probe for valid client_ids
//
// This link is meant to be durable: given once during onboarding,
// it should keep working indefinitely (unlike an emailed report,
// which can be deleted). The customer should bookmark it.

const { createClient } = require('@supabase/supabase-js');

const BASE_URL = "https://pia-agent.netlify.app/.netlify/functions";

exports.handler = async function (event) {
  if (event.httpMethod !== "GET") {
    return htmlResponse(405, "Method not allowed.");
  }

  const { client_id, token } = event.queryStringParameters || {};

  if (!client_id || !token) {
    return htmlResponse(400, "This link is missing required information. Please use the exact link provided to you.");
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error("Missing Supabase environment variables.");
    return htmlResponse(500, "Something went wrong on our end. Please try again later.");
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Look up the client and verify the token matches
  const { data: client, error } = await supabase
    .from('clients')
    .select('id, company_name, on_demand_token, active')
    .eq('id', client_id)
    .single();

  if (error || !client) {
    console.warn(`[on-demand-trigger] No client found for id ${client_id}`);
    return invalidLinkResponse();
  }

  if (!client.on_demand_token || client.on_demand_token !== token) {
    console.warn(`[on-demand-trigger] Token mismatch for client ${client_id}`);
    return invalidLinkResponse();
  }

  if (!client.active) {
    return htmlResponse(403, "This account is not currently active. Please contact us if you believe this is an error.");
  }

  // Token is valid — kick off the real pipeline run as a background job
  // so this confirmation page responds in well under a second instead
  // of making the customer wait ~30s for the full pipeline to finish.
  // Background functions return an instant 202 and then keep running
  // independently for up to 15 minutes — the email arrives once it's done.
  try {
    const response = await fetch(`${BASE_URL}/run-pipeline-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: client.id, send_email: true }),
    });

    if (response.status !== 202) {
      console.error(`[on-demand-trigger] Unexpected status starting background pipeline for ${client_id}: ${response.status}`);
      return htmlResponse(500, "We hit a problem starting your report. Our team has been notified. Please try again shortly.");
    }

    return successResponse(client.company_name);
  } catch (err) {
    console.error("[on-demand-trigger] Unexpected error starting background pipeline:", err);
    return htmlResponse(500, "We hit a problem starting your report. Our team has been notified. Please try again shortly.");
  }
};

function successResponse(companyName) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html" },
    body: `
      <html>
        <head><title>Pipeline Report Running</title></head>
        <body style="font-family: Arial, sans-serif; background:#0D1B2A; color:#fff; text-align:center; padding: 60px 20px;">
          <h1 style="color:#F5A623;">Your Pipeline Integrity Report is running</h1>
          <p>Thanks${companyName ? `, ${companyName}` : ""} &mdash; we are reviewing your pipeline now.</p>
          <p>Your report will arrive by email shortly. You can close this page.</p>
        </body>
      </html>
    `,
  };
}

function invalidLinkResponse() {
  return htmlResponse(403, "This link is invalid or no longer active. Please contact us for a new one.");
}

function htmlResponse(statusCode, message) {
  return {
    statusCode,
    headers: { "Content-Type": "text/html" },
    body: `
      <html>
        <head><title>Pipeline Integrity Agent</title></head>
        <body style="font-family: Arial, sans-serif; background:#0D1B2A; color:#fff; text-align:center; padding: 60px 20px;">
          <h1 style="color:#F5A623;">Pipeline Integrity Agent</h1>
          <p>${message}</p>
        </body>
      </html>
    `,
  };
}
