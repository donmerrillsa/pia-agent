// netlify/functions/scheduled-daily-pulse.js
// Netlify scheduled function — runs Monday-Thursday at 12:00 PM UTC (7:00 AM CDT).
// No Pulse on Friday — clients receive the full weekly Pipeline Integrity
// Report that day instead (scheduled-pipeline.js).
//
// Loops through ALL active clients and runs the DAILY pipeline for each,
// via run-pipeline-daily.js. Mirrors scheduled-pipeline.js's structure exactly.
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

  console.log(`[scheduled-daily-pulse] Starting scheduled Daily Pulse run. Manual: ${isManual}`);
  const startTime = Date.now();
  const supabase = getSupabaseClient();

  // ── Load all active clients ───────────────────────────────
  const { data: clients, error: clientsError } = await supabase
    .from("clients")
    .select("id, company_name, contact_email")
    .eq("active", true);

  if (clientsError) {
    console.error("[scheduled-daily-pulse] Failed to load clients:", clientsError.message);
    return respond(500, { error: `Failed to load clients: ${clientsError.message}` });
  }

  if (!clients || clients.length === 0) {
    console.log("[scheduled-daily-pulse] No active clients found.");
    return respond(200, {
      success: true,
      message: "No active clients to process.",
      clients_processed: 0,
    });
  }

  console.log(`[scheduled-daily-pulse] Processing ${clients.length} active clients...`);

  const results = [];

  // ── Run daily pipeline for each client ────────────────────
  for (const client of clients) {
    console.log(`[scheduled-daily-pulse] Running Daily Pulse for: ${client.company_name}`);

    try {
      const result = await callFunction("run-pipeline-daily", {
        client_id: client.id,
        send_email: true,
      });

      results.push({
        client_id: client.id,
        company_name: client.company_name,
        success: result.data.success,
        deals_synced: result.data.summary?.deals_synced ?? 0,
        stalls_flagged: result.data.summary?.stalls_flagged ?? 0,
        stalls_resolved: result.data.summary?.stalls_resolved ?? 0,
        is_first_pulse: result.data.summary?.is_first_pulse ?? null,
        newly_stalled_count: result.data.summary?.newly_stalled_count ?? 0,
        back_on_track_count: result.data.summary?.back_on_track_count ?? 0,
        email_sent: result.data.summary?.email_sent ?? false,
        duration_ms: result.data.duration_ms ?? 0,
        error: result.data.error ?? null,
      });

      console.log(
        `[scheduled-daily-pulse] ${client.company_name}: ` +
        `${result.data.success ? "✓" : "✗"} — ` +
        `${result.data.summary?.newly_stalled_count ?? 0} newly stalled, ` +
        `${result.data.summary?.back_on_track_count ?? 0} back on track`
      );

    } catch (err) {
      console.error(`[scheduled-daily-pulse] Failed for ${client.company_name}:`, err.message);
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
    `[scheduled-daily-pulse] Complete. ${succeeded} succeeded, ${failed} failed in ${duration}ms`
  );

  await logAction({
    client_id: clients[0]?.id ?? null,
    action_type: "scheduled_daily_run",
    notes: `Scheduled Daily Pulse run: ${succeeded}/${clients.length} clients succeeded in ${duration}ms`,
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
