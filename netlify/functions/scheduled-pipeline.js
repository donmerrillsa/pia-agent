// netlify/functions/scheduled-pipeline.js
// Netlify scheduled function — runs every Friday at 12:00 PM UTC (7:00 AM CDT).
// Loops through ALL active clients and runs the full pipeline for each.
//
// Schedule is set in netlify.toml.
// Can also be triggered manually via POST for testing.

const { getSupabaseClient } = require("./_utils/supabase");
const { logAction, logError } = require("./_utils/logger");

const BASE_URL = "https://pia-agent.netlify.app/.netlify/functions";

async function callFunction(name, body) {
  const response = await fetch(`${BASE_URL}/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  return { status: response.status, data };
}

exports.handler = async (event) => {
  // Allow manual POST trigger for testing
  const isManual = event.httpMethod === "POST";
  const isScheduled = event.httpMethod === "GET" || !event.httpMethod;

  if (!isManual && !isScheduled) {
    return respond(405, { error: "Method not allowed." });
  }

  console.log(`[scheduled-pipeline] Starting scheduled run. Manual: ${isManual}`);
  const startTime = Date.now();
  const supabase = getSupabaseClient();

  // ── Load all active, non-test clients ─────────────────────
  // is_test rows (sandbox/dev clients with no real ongoing data hygiene)
  // are deliberately excluded so stale test credentials never trigger
  // a production-looking admin alert again.
  const { data: clients, error: clientsError } = await supabase
    .from("clients")
    .select("id, company_name, contact_email")
    .eq("active", true)
    .eq("is_test", false);

  if (clientsError) {
    console.error("[scheduled-pipeline] Failed to load clients:", clientsError.message);
    return respond(500, { error: `Failed to load clients: ${clientsError.message}` });
  }

  if (!clients || clients.length === 0) {
    console.log("[scheduled-pipeline] No active clients found.");
    return respond(200, {
      success: true,
      message: "No active clients to process.",
      clients_processed: 0,
    });
  }

  console.log(`[scheduled-pipeline] Processing ${clients.length} active clients...`);

  const results = [];

  // ── Run pipeline for each client ─────────────────────────
  for (const client of clients) {
    console.log(`[scheduled-pipeline] Running pipeline for: ${client.company_name}`);

    try {
      const result = await callFunction("run-pipeline", {
        client_id: client.id,
        send_email: true,
      });

      results.push({
        client_id: client.id,
        company_name: client.company_name,
        success: result.data.success,
        deals_synced: result.data.summary?.deals_synced ?? 0,
        stalls_flagged: result.data.summary?.stalls_flagged ?? 0,
        forecast_confidence: result.data.summary?.forecast_confidence ?? null,
        email_sent: result.data.summary?.email_sent ?? false,
        duration_ms: result.data.duration_ms ?? 0,
        error: result.data.error ?? null,
      });

      console.log(
        `[scheduled-pipeline] ${client.company_name}: ` +
        `${result.data.success ? "✓" : "✗"} — ` +
        `${result.data.summary?.deals_synced ?? 0} deals, ` +
        `${result.data.summary?.stalls_flagged ?? 0} stalls`
      );

    } catch (err) {
      console.error(`[scheduled-pipeline] Failed for ${client.company_name}:`, err.message);
      results.push({
        client_id: client.id,
        company_name: client.company_name,
        success: false,
        error: err.message,
      });
    }

    // Brief pause between clients to avoid rate limits
    if (clients.indexOf(client) < clients.length - 1) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const duration = Date.now() - startTime;
  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  console.log(
    `[scheduled-pipeline] Complete. ${succeeded} succeeded, ${failed} failed in ${duration}ms`
  );

  // Log the scheduled run summary
  await logAction({
    client_id: clients[0]?.id ?? null,
    action_type: "scheduled_run",
    notes: `Scheduled pipeline run: ${succeeded}/${clients.length} clients succeeded in ${duration}ms`,
    success: failed === 0,
  }).catch(() => {});

  return respond(200, {
    success: true,
    run_type: isManual ? "manual" : "scheduled",
    clients_processed: clients.length,
    succeeded,
    failed,
    duration_ms: duration,
    results,
  });
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body, null, 2),
  };
}
