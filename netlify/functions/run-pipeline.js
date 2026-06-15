// netlify/functions/run-pipeline.js
// The PIA orchestrator. Runs the full pipeline sequence:
// 1. deal-sync       — pull deals from HubSpot into Supabase
// 2. activity-sync   — update last activity dates
// 3. stall-detect    — flag stalled deals
// 4. generate-report — build the Monday Morning Pipeline Report
// 5. send-report     — email it to recipients
//
// POST /.netlify/functions/run-pipeline
// Body: { "client_id": "<uuid>", "send_email": true/false }

const { getSupabaseClient } = require("./_utils/supabase");
const { fetchAllDeals, fetchLastActivityForDeal } = require("./_utils/hubspot");
const { logAction, logError } = require("./_utils/logger");
const { sendAdminAlert } = require("./send-report");

const BASE_URL = "https://pia-agent.netlify.app/.netlify/functions";

// Internal function caller — calls our own Netlify functions
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
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed. Use POST." });
  }

  let client_id, send_email;
  try {
    const body = JSON.parse(event.body || "{}");
    client_id = body.client_id;
    send_email = body.send_email ?? true;
  } catch {
    return respond(400, { error: "Invalid JSON body." });
  }

  if (!client_id) {
    return respond(400, { error: "Missing client_id." });
  }

  console.log(`[run-pipeline] Starting full pipeline run for client ${client_id}`);
  const startTime = Date.now();
  const results = {};

  try {
    // ── Step 1: Deal Sync ─────────────────────────────────────
    console.log("[run-pipeline] Step 1: deal-sync...");
    const dealSync = await callFunction("deal-sync", { client_id });
    results.deal_sync = {
      success: dealSync.data.success,
      deals_synced: dealSync.data.deals_synced ?? 0,
      error: dealSync.data.error ?? null,
    };

    if (!dealSync.data.success) {
      throw new Error(`deal-sync failed: ${dealSync.data.error}`);
    }
    console.log(`[run-pipeline] deal-sync complete: ${results.deal_sync.deals_synced} deals`);

    // ── Step 2: Activity Sync ─────────────────────────────────
    console.log("[run-pipeline] Step 2: activity-sync...");
    const activitySync = await callFunction("activity-sync", { client_id });
    results.activity_sync = {
      success: activitySync.data.success,
      deals_updated: activitySync.data.deals_updated ?? 0,
      error: activitySync.data.error ?? null,
    };

    if (!activitySync.data.success) {
      console.warn("[run-pipeline] activity-sync failed — continuing:", activitySync.data.error);
    }
    console.log(`[run-pipeline] activity-sync complete: ${results.activity_sync.deals_updated} updated`);

    // ── Step 3: Stall Detection ───────────────────────────────
    console.log("[run-pipeline] Step 3: stall-detect...");
    const stallDetect = await callFunction("stall-detect", { client_id });
    results.stall_detect = {
      success: stallDetect.data.success,
      stalls_flagged: stallDetect.data.stalls_flagged ?? 0,
      new_stall_events: stallDetect.data.new_stall_events ?? 0,
      error: stallDetect.data.error ?? null,
    };

    if (!stallDetect.data.success) {
      console.warn("[run-pipeline] stall-detect failed — continuing:", stallDetect.data.error);
    }
    console.log(`[run-pipeline] stall-detect complete: ${results.stall_detect.stalls_flagged} stalls`);

    // ── Step 4: Generate Report ───────────────────────────────
    console.log("[run-pipeline] Step 4: generate-report...");
    const generateReport = await callFunction("generate-report", {
      client_id,
      dry_run: false,
    });
    results.generate_report = {
      success: generateReport.data.success,
      deals_reviewed: generateReport.data.deals_reviewed ?? 0,
      forecast_confidence: generateReport.data.forecast_confidence ?? null,
      pipeline_value: generateReport.data.pipeline_value ?? 0,
      error: generateReport.data.error ?? null,
    };

    if (!generateReport.data.success) {
      throw new Error(`generate-report failed: ${generateReport.data.error}`);
    }
    console.log(`[run-pipeline] generate-report complete. Confidence: ${results.generate_report.forecast_confidence}`);

    // ── Step 5: Send Report (optional) ───────────────────────
    if (send_email) {
      console.log("[run-pipeline] Step 5: send-report...");
      const sendReport = await callFunction("send-report", { client_id });
      results.send_report = {
        success: sendReport.data.success,
        recipients: sendReport.data.recipients ?? [],
        resend_id: sendReport.data.resend_id ?? null,
        error: sendReport.data.error ?? null,
      };

      if (!sendReport.data.success) {
        console.warn("[run-pipeline] send-report failed:", sendReport.data.error);
      } else {
        console.log(`[run-pipeline] send-report complete: sent to ${results.send_report.recipients.join(", ")}`);
      }
    } else {
      results.send_report = { skipped: true };
      console.log("[run-pipeline] Step 5: send-report skipped (send_email: false)");
    }

    const duration = Date.now() - startTime;
    console.log(`[run-pipeline] Full pipeline complete in ${duration}ms`);

    await logAction({
      client_id,
      action_type: "pipeline_run",
      notes: `Full pipeline run complete in ${duration}ms. Deals: ${results.deal_sync.deals_synced}, Stalls: ${results.stall_detect.stalls_flagged}, Confidence: ${results.generate_report.forecast_confidence}`,
      success: true,
    });

    return respond(200, {
      success: true,
      client_id,
      duration_ms: duration,
      summary: {
        deals_synced: results.deal_sync.deals_synced,
        stalls_flagged: results.stall_detect.stalls_flagged,
        forecast_confidence: results.generate_report.forecast_confidence,
        pipeline_value: results.generate_report.pipeline_value,
        email_sent: send_email && results.send_report.success,
        recipients: results.send_report.recipients ?? [],
      },
      steps: results,
    });

  } catch (err) {
    console.error("[run-pipeline] Fatal error:", err.message);

    await logError(
      { client_id, action_type: "pipeline_run", notes: "Pipeline run failed" },
      err
    ).catch(() => {});

    // Determine which step failed based on results
    const failed_step = !results.deal_sync?.success ? "deal-sync (Step 1)"
      : !results.generate_report?.success ? "generate-report (Step 4)"
      : "unknown step";

    await sendAdminAlert({
      client_id,
      failed_step,
      error_message: err.message,
    }).catch(() => {});

    return respond(500, {
      success: false,
      error: err.message,
      steps: results,
      message: "Pipeline run failed. See steps for details.",
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
