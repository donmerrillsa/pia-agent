// netlify/functions/onboard-client.js
// Onboards a new PIA client:
// 1. Validates required fields
// 2. Verifies HubSpot token works
// 3. Inserts client record into Supabase
// 4. Runs initial deal sync
// 5. Sends welcome/confirmation email
//
// POST /.netlify/functions/onboard-client
// Body: {
//   company_name: string,
//   contact_name: string,
//   contact_email: string,
//   hubspot_access_token: string,
//   hubspot_portal_id: string (optional),
//   report_recipients: string[] (optional — defaults to contact_email),
//   timezone: string (optional — defaults to America/Chicago),
//   pilot_start_date: string (optional — YYYY-MM-DD),
// }

const { getSupabaseClient } = require("./_utils/supabase");
const { logAction, logError } = require("./_utils/logger");
const { randomUUID } = require("crypto");

const BASE_URL = "https://pia-agent.netlify.app/.netlify/functions";
const RESEND_API_URL = "https://api.resend.com/emails";

async function callFunction(name, body) {
  const response = await fetch(`${BASE_URL}/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
}

async function verifyHubSpotToken(token) {
  const response = await fetch("https://api.hubapi.com/crm/v3/owners?limit=1", {
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.ok;
}

async function sendWelcomeEmail(client) {
  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.REPORT_FROM_EMAIL || "pia@buy-mos.com";
  if (!resendKey) return;

  const onDemandLink = `${BASE_URL}/on-demand-trigger?client_id=${client.id}&token=${client.on_demand_token}`;

  const html = `
    <div style="font-family: Arial, sans-serif; color: #0D1B2A; max-width: 600px;">
      <h1 style="color: #0D1B2A;">Welcome to PIA — Pipeline Integrity Agent</h1>
      <p>Hi ${client.contact_name || client.company_name},</p>
      <p>Your Pipeline Integrity Agent pilot is now active. Here's what happens next:</p>
      <ul>
        <li><strong>Every Friday at 7:00 AM CDT</strong> — you'll receive your Pipeline Integrity Report</li>
        <li><strong>Stalled deals</strong> — any deal over the activity threshold for its stage will be flagged with a recommended action</li>
        <li><strong>Pipeline Health Score</strong> — a 1–10 score with rationale, every week</li>
      </ul>
      <p>Want a report sooner? Use this link any time — it's yours, and it doesn't expire:</p>
      <p style="margin: 20px 0;">
        <a href="${onDemandLink}" style="background: #F5A623; color: #0D1B2A; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold; display: inline-block;">Run My Pipeline Report Now</a>
      </p>
      <p>Bookmark it — it'll always trigger a fresh report on demand.</p>
      <p>Your first scheduled report will arrive this Friday. If you have questions before then, reply to this email.</p>
      <p style="margin-top: 32px; color: #666;">
        PIA — Pipeline Integrity Agent<br>
        Merrill & Associates<br>
        <a href="mailto:don@buy-mos.com">don@buy-mos.com</a>
      </p>
    </div>
  `;

  await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resendKey}`,
    },
    body: JSON.stringify({
      from: `PIA — Pipeline Integrity Agent <${fromEmail}>`,
      to: [client.contact_email],
      subject: "Welcome to PIA — Your Pipeline Integrity Agent is Active",
      html,
    }),
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed. Use POST." });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return respond(400, { error: "Invalid JSON body." });
  }

  const {
    company_name,
    contact_name,
    contact_email,
    hubspot_access_token,
    hubspot_portal_id,
    report_recipients,
    timezone,
    pilot_start_date,
  } = body;

  // ── Validate required fields ──────────────────────────────
  if (!company_name || !contact_email || !hubspot_access_token) {
    return respond(400, {
      error: "Missing required fields: company_name, contact_email, hubspot_access_token",
    });
  }

  console.log(`[onboard-client] Onboarding: ${company_name}`);
  const startTime = Date.now();
  const supabase = getSupabaseClient();

  try {
    // ── Step 1: Check for duplicate ───────────────────────────
    const { data: existing } = await supabase
      .from("clients")
      .select("id")
      .eq("contact_email", contact_email)
      .single();

    if (existing) {
      return respond(409, {
        error: `A client with email ${contact_email} already exists.`,
        client_id: existing.id,
      });
    }

    // ── Step 2: Verify HubSpot token ──────────────────────────
    console.log("[onboard-client] Verifying HubSpot token...");
    const tokenValid = await verifyHubSpotToken(hubspot_access_token);

    if (!tokenValid) {
      return respond(400, {
        error: "HubSpot token verification failed. Check the access token and try again.",
      });
    }

    console.log("[onboard-client] HubSpot token verified.");

    // ── Step 3: Insert client record ──────────────────────────
    const recipients = report_recipients?.length
      ? report_recipients
      : [contact_email];

    const { data: client, error: insertError } = await supabase
      .from("clients")
      .insert({
        company_name,
        contact_name: contact_name || null,
        contact_email,
        hubspot_access_token,
        hubspot_portal_id: hubspot_portal_id || null,
        report_recipients: recipients,
        timezone: timezone || "America/Chicago",
        pilot_start_date: pilot_start_date || new Date().toISOString().split("T")[0],
        on_demand_token: randomUUID(),
        active: true,
      })
      .select()
      .single();

    if (insertError) {
      throw new Error(`Failed to create client record: ${insertError.message}`);
    }

    console.log(`[onboard-client] Client created: ${client.id}`);

    // ── Step 4: Run initial deal sync ─────────────────────────
    console.log("[onboard-client] Running initial deal sync...");
    const syncResult = await callFunction("deal-sync", { client_id: client.id });
    const dealsFound = syncResult.deals_synced ?? 0;
    console.log(`[onboard-client] Initial sync: ${dealsFound} deals found`);

    // ── Step 5: Send welcome email ────────────────────────────
    console.log("[onboard-client] Sending welcome email...");
    await sendWelcomeEmail(client).catch((err) => {
      console.warn("[onboard-client] Welcome email failed:", err.message);
    });

    const duration = Date.now() - startTime;

    await logAction({
      client_id: client.id,
      action_type: "client_onboarded",
      notes: `${company_name} onboarded in ${duration}ms. Initial sync: ${dealsFound} deals.`,
      success: true,
    });

    return respond(201, {
      success: true,
      client_id: client.id,
      company_name: client.company_name,
      contact_email: client.contact_email,
      report_recipients: recipients,
      initial_deals_found: dealsFound,
      pilot_start_date: client.pilot_start_date,
      duration_ms: duration,
      message: `${company_name} successfully onboarded. Welcome email sent. First report arrives Friday at 7:00 AM CDT.`,
    });

  } catch (err) {
    console.error("[onboard-client] Error:", err.message);
    await logError(
      { action_type: "client_onboarded", notes: `Onboarding failed for ${company_name}` },
      err
    ).catch(() => {});

    return respond(500, {
      success: false,
      error: err.message,
      message: "Onboarding failed. Check logs for details.",
    });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body, null, 2),
  };
}
