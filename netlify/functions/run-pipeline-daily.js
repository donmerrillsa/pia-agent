// netlify/functions/run-pipeline-daily.js
// The Daily Pipeline Pulse orchestrator — mirrors run-pipeline.js's structure,
// but runs the DAILY sequence for a single client:
// 1. deal-sync              — pull deals from HubSpot into Supabase
// 2. activity-sync          — update last activity dates
// 3. stall-detect           — flag stalled deals AND resolve deals back under threshold
// 4. generate-daily-pulse   — build the delta report (newly stalled / back on track / still stalled)
// 5. send-daily-pulse       — email it, passing report_html DIRECTLY (not via archive lookup —
//                              see send-daily-pulse.js header comment for why)
//
// POST /.netlify/functions/run-pipeline-daily
// Body: { "client_id": "<uuid>", "send_email": true/false }

const { randomUUID } = require("crypto");
const { getSupabaseClient } = require("./_utils/supabase");
const { logAction, logError } = require("./_utils/logger");
const { sendAdminAlert } = require("./send-report");

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

  console.log(`[run-pipeline-daily] Starting Daily Pipeline Pulse run for client ${client_id}`);
  const startTime = Date.now();
  const run_id = randomUUID();
  const results = {};
  console.log(`[run-pipeline-daily] run_id: ${run_id}`);

  try {
    // ── Step 1: Deal Sync ─────────────────────────────────────
    console.log("[run-pipeline-daily] Step 1: deal-sync...");
    const dealSync = await callFunction("deal-sync", { client_id, run_id });
    results.deal_sync = {
      success: dealSync.data.success,
      deals_synced: dealSync.data.deals_synced ?? 0,
      error: dealSync.data.error ?? null,
    };

    if (!dealSync.data.success) {
      throw new Error(`deal-sync failed: ${dealSync.data.error}`);
    }
    console.log(`[run-pipeline-daily] deal-sync complete: ${results.deal_sync.deals_synced} deals`);

    // ── Step 2: Activity Sync ─────────────────────────────────
    console.log("[run-pipeline-daily] Step 2: activity-sync...");
    const activitySync = await callFunction("activity-sync", { client_id, run_id });
    results.activity_sync = {
      success: activitySync.data.success,
      deals_updated: activitySync.data.deals_updated ?? 0,
      error: activitySync.data.error ?? null,
    };

    if (!activitySync.data.success) {
      console.warn("[run-pipeline-daily] activity-sync failed — continuing:", activitySync.data.error);
    }
    console.log(`[run-pipeline-daily] activity-sync complete: ${results.activity_sync.deals_updated} updated`);

    // ── Step 3: Stall Detection (also resolves deals back under threshold) ──
    console.log("[run-pipeline-daily] Step 3: stall-detect...");
    const stallDetect = await callFunction("stall-detect", { client_id, run_id });
    results.stall_detect = {
      success: stallDetect.data.success,
      stalls_flagged: stallDetect.data.stalls_flagged ?? 0,
      new_stall_events: stallDetect.data.new_stall_events ?? 0,
      stalls_resolved: stallDetect.data.stalls_resolved ?? 0,
      error: stallDetect.data.error ?? null,
    };

    if (!stallDetect.data.success) {
      console.warn("[run-pipeline-daily] stall-detect failed — continuing:", stallDetect.data.error);
    }
    console.log(`[run-pipeline-daily] stall-detect complete: ${results.stall_detect.stalls_flagged} stalled, ${results.stall_detect.stalls_resolved} resolved`);

    // ── Step 4: Generate Daily Pulse ──────────────────────────
    console.log("[run-pipeline-daily] Step 4: generate-daily-pulse...");
    const generatePulse = await callFunction("generate-daily-pulse", {
      client_id,
      run_id,
      dry_run: false,
    });
    results.generate_daily_pulse = {
      success: generatePulse.data.success,
      is_first_pulse: generatePulse.data.is_first_pulse ?? null,
      newly_stalled_count: generatePulse.data.newly_stalled_count ?? 0,
      back_on_track_count: generatePulse.data.back_on_track_count ?? 0,
      still_stalled_count: generatePulse.data.still_stalled_count ?? 0,
      error: generatePulse.data.error ?? null,
    };

    if (!generatePulse.data.success) {
      throw new Error(`generate-daily-pulse failed: ${generatePulse.data.error}`);
    }
    console.log(`[run-pipeline-daily] generate-daily-pulse complete. Newly stalled: ${results.generate_daily_pulse.newly_stalled_count}, Back on track: ${results.generate_daily_pulse.back_on_track_count}`);

    // ── Step 5: Send Daily Pulse (optional) ───────────────────
    // report_html is passed DIRECTLY from Step 4's response — do not rely on
    // send-daily-pulse.js's archive fallback here. See that file's header
    // comment for why this matters (report_archive is shared with the
    // weekly report and "most recent row" is a schedule-dependent assumption).
    if (send_email) {
      console.log("[run-pipeline-daily] Step 5: send-daily-pulse...");
      const sendPulse = await callFunction("send-daily-pulse", {
        client_id,
        run_id,
        report_html: generatePulse.data.report_html,
      });
      results.send_daily_pulse = {
        success: sendPulse.data.success,
        recipients: sendPulse.data.recipients ?? [],
        resend_id: sendPulse.data.resend_id ?? null,
        error: sendPulse.data.error ?? null,
      };

      if (!sendPulse.data.success) {
        console.warn("[run-pipeline-daily] send-daily-pulse failed:", sendPulse.data.error);
      } else {
        console.log(`[run-pipeline-daily] send-daily-pulse complete: sent to ${results.send_daily_pulse.recipients.join(", ")}`);
      }
    } else {
      results.send_daily_pulse = { skipped: true };
      console.log("[run-pipeline-daily] Step 5: send-daily-pulse skipped (send_email: false)");
    }

    const duration = Date.now() - startTime;
    console.log(`[run-pipeline-daily] Full daily run complete in ${duration}ms`);

    await logAction({
      client_id,
      run_id,
      action_type: "daily_pipeline_run",
      notes: `Daily Pulse run complete in ${duration}ms. Newly stalled: ${results.generate_daily_pulse.newly_stalled_count}, Back on track: ${results.generate_daily_pulse.back_on_track_count}, Still stalled: ${results.generate_daily_pulse.still_stalled_count}`,
      success: true,
    });

    return respond(200, {
      success: true,
      client_id,
      duration_ms: duration,
      summary: {
        deals_synced: results.deal_sync.deals_synced,
        stalls_flagged: results.stall_detect.stalls_flagged,
        stalls_resolved: results.stall_detect.stalls_resolved,
        is_first_pulse: results.generate_daily_pulse.is_first_pulse,
        newly_stalled_count: results.generate_daily_pulse.newly_stalled_count,
        back_on_track_count: results.generate_daily_pulse.back_on_track_count,
        still_stalled_count: results.generate_daily_pulse.still_stalled_count,
        email_sent: send_email && results.send_daily_pulse.success,
        recipients: results.send_daily_pulse.recipients ?? [],
      },
      steps: results,
    });

  } catch (err) {
    console.error("[run-pipeline-daily] Fatal error:", err.message);

    await logError(
      { client_id, run_id, action_type: "daily_pipeline_run", notes: "Daily Pulse run failed" },
      err
    ).catch(() => {});

    const failed_step = !results.deal_sync?.success ? "deal-sync (Step 1)"
      : !results.generate_daily_pulse?.success ? "generate-daily-pulse (Step 4)"
      : "unknown step";

    await sendAdminAlert({
      client_id,
      failed_step: `[Daily Pulse] ${failed_step}`,
      error_message: err.message,
    }).catch(() => {});

    return respond(500, {
      success: false,
      error: err.message,
      steps: results,
      message: "Daily Pulse run failed. See steps for details.",
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
