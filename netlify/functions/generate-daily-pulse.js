// netlify/functions/generate-daily-pulse.js
// Generates the Daily Pipeline Pulse — a DELTA report, not a full pipeline restate.
// Three sections, all sourced from stall_events:
//   1. Newly stalled today   — flagged_at is today
//   2. Back on track today   — resolved_at is today (resolved = true)
//   3. Still stalled, no action taken — unresolved, flagged_at BEFORE today
//
// Mirrors generate-report.js's structure and styling conventions.
// No AI call — pure data query and HTML template, same as generate-report.js.
//
// Automated-daily only (Mon-Thu) — no on-demand trigger, per v1.4 spec decision.
//
// POST /.netlify/functions/generate-daily-pulse
// Body: { "client_id": "<uuid>", "dry_run": true/false }

const { getSupabaseClient } = require("./_utils/supabase");
const { logAction, logError } = require("./_utils/logger");

const STAGE_NAMES = {
  "3749122780": "Connected",
  "3752325847": "Conversation Started",
  "3752325848": "Demo Scheduled",
  "3749122783": "Demo Completed",
  "3749122784": "Proposal Sent",
  "3755051726": "Negotiating",
  "appointmentscheduled": "Appointment Scheduled",
  "qualifiedtobuy": "Qualified to Buy",
  "presentationscheduled": "Presentation Scheduled",
  "decisionmakerboughtin": "Decision Maker Bought In",
  "contractsent": "Contract Sent",
  "closedwon": "Closed Won",
  "closedlost": "Closed Lost",
};

const stageName = (stage) => STAGE_NAMES[stage] || stage;

// Returns start-of-day and end-of-day ISO timestamps (UTC) for "today",
// used to filter flagged_at / resolved_at to today's date only.
function getTodayBounds() {
  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  const endOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
  return { startOfDay: startOfDay.toISOString(), endOfDay: endOfDay.toISOString() };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed. Use POST." });
  }

  let client_id, run_id, dry_run;
  try {
    const body = JSON.parse(event.body || "{}");
    client_id = body.client_id;
    run_id = body.run_id ?? null;
    dry_run = body.dry_run ?? false;
  } catch {
    return respond(400, { error: "Invalid JSON body." });
  }

  if (!client_id) {
    return respond(400, { error: "Missing client_id." });
  }

  console.log(`[generate-daily-pulse] Starting Daily Pipeline Pulse for client ${client_id} (dry_run: ${dry_run})`);
  const startTime = Date.now();
  const supabase = getSupabaseClient();

  try {
    // ── Step 1: Load client record ──────────────────────────────────────────
    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select("*")
      .eq("id", client_id)
      .single();

    if (clientError || !client) {
      throw new Error(`Client not found: ${clientError?.message}`);
    }

    const { startOfDay, endOfDay } = getTodayBounds();

    // ── Step 2: Check if this client has ANY stall_events history at all ────
    // v1.3 decision: a client with no prior snapshot sees "no changes yet,
    // check back tomorrow" rather than an arbitrary fallback.
    const { count: historyCount, error: historyError } = await supabase
      .from("stall_events")
      .select("id", { count: "exact", head: true })
      .eq("client_id", client_id)
      .lt("flagged_at", startOfDay);

    if (historyError) throw new Error(`Failed to check history: ${historyError.message}`);

    const isFirstPulse = (historyCount ?? 0) === 0;

    // ── Step 3: Newly stalled today ─────────────────────────────────────────
    const { data: newlyStalled, error: newError } = await supabase
      .from("stall_events")
      .select("*")
      .eq("client_id", client_id)
      .gte("flagged_at", startOfDay)
      .lte("flagged_at", endOfDay)
      .order("days_stalled", { ascending: false });

    if (newError) throw new Error(`Failed to load newly stalled: ${newError.message}`);

    // ── Step 4: Back on track today (resolved today) ────────────────────────
    const { data: backOnTrack, error: resolvedError } = await supabase
      .from("stall_events")
      .select("*")
      .eq("client_id", client_id)
      .eq("resolved", true)
      .gte("resolved_at", startOfDay)
      .lte("resolved_at", endOfDay)
      .order("resolved_at", { ascending: false });

    if (resolvedError) throw new Error(`Failed to load resolved: ${resolvedError.message}`);

    // ── Step 5: Still stalled, no action taken (unresolved, flagged before today) ──
    const { data: stillStalled, error: stillError } = await supabase
      .from("stall_events")
      .select("*")
      .eq("client_id", client_id)
      .eq("resolved", false)
      .lt("flagged_at", startOfDay)
      .order("days_stalled", { ascending: false });

    if (stillError) throw new Error(`Failed to load still-stalled: ${stillError.message}`);

    const reportDate = new Date().toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric"
    });

    // ── Step 6: Build HTML report ────────────────────────────────────────────
    const tdStyle = `style="padding:10px 12px;border-bottom:1px solid #e0e0e0;"`;
    const thStyle = `style="padding:10px 12px;text-align:left;background:#0D1B2A;color:#fff;font-size:13px;"`;

    function dealRow(s, opts = {}) {
      const sevColor = opts.resolvedRow ? "#2e7d32" : "#b71c1c";
      return `
        <tr style="background:${opts.resolvedRow ? "#EDF7ED" : "#FFF8EC"};">
          <td ${tdStyle} style="font-weight:bold;">${s.deal_name || "Unnamed Deal"}</td>
          <td ${tdStyle}>${stageName(s.deal_stage)}</td>
          <td ${tdStyle}>$${(s.amount || 0).toLocaleString()}</td>
          <td ${tdStyle} style="text-align:center;">${s.days_stalled}</td>
          ${opts.resolvedRow
            ? `<td ${tdStyle} style="font-weight:bold;color:${sevColor};">Back on track</td>`
            : `<td ${tdStyle} style="font-weight:bold;color:${sevColor};">${s.severity || "STALLED"}</td>`
          }
          <td ${tdStyle}>${opts.resolvedRow ? "Rep re-engaged — activity resumed." : (s.recommended_action || "Review and re-engage.")}</td>
        </tr>`;
    }

    function sectionTable(title, rows, emptyMessage, opts = {}) {
      const rowsHtml = rows.length === 0
        ? `<tr><td colspan="6" style="padding:12px;text-align:center;color:#666;border-bottom:1px solid #e0e0e0;">${emptyMessage}</td></tr>`
        : rows.map(r => dealRow(r, opts)).join("");

      return `
        <h2 style="font-size:15px;color:#0D1B2A;border-bottom:2px solid #0D1B2A;padding-bottom:6px;margin-bottom:12px;">${title}</h2>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:32px;">
          <thead>
            <tr>
              <th ${thStyle}>Deal Name</th>
              <th ${thStyle}>Stage</th>
              <th ${thStyle}>Amount</th>
              <th ${thStyle}>Days Stalled</th>
              <th ${thStyle}>Status</th>
              <th ${thStyle}>${opts.resolvedRow ? "Note" : "Recommended Action"}</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>`;
    }

    let bodyHtml;

    if (isFirstPulse) {
      // v1.3 decision: no prior snapshot to compare against.
      bodyHtml = `
        <p style="font-size:14px;line-height:1.6;margin-bottom:28px;">
          This is your first Daily Pipeline Pulse. No changes yet — check back tomorrow for what's moved since today.
        </p>`;
    } else if (newlyStalled.length === 0 && backOnTrack.length === 0 && stillStalled.length === 0) {
      bodyHtml = `
        <p style="font-size:14px;line-height:1.6;margin-bottom:28px;">
          No changes since yesterday. Nothing newly stalled, nothing resolved, no deals sitting untouched.
        </p>`;
    } else {
      bodyHtml =
        sectionTable(
          `Newly Stalled Today (${newlyStalled.length})`,
          newlyStalled,
          "No deals newly stalled today."
        ) +
        sectionTable(
          `Back on Track Today (${backOnTrack.length})`,
          backOnTrack,
          "No deals resolved today.",
          { resolvedRow: true }
        ) +
        sectionTable(
          `Still Stalled — No Action Taken (${stillStalled.length})`,
          stillStalled,
          "No outstanding stalled deals without action."
        );
    }

    const reportHtml = `
<div style="font-family:Arial,sans-serif;max-width:900px;margin:0 auto;color:#1a1a1a;background:#fff;">

  <!-- Header -->
  <div style="background:#0D1B2A;padding:24px 32px;margin-bottom:24px;">
    <p style="margin:0;font-size:12px;color:#F5A623;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">Pipeline Integrity Agent</p>
    <h1 style="margin:6px 0 4px 0;font-size:22px;color:#fff;">Daily Pipeline Pulse</h1>
    <p style="margin:0;font-size:13px;color:#adb5bd;">${client.company_name} &nbsp;|&nbsp; ${reportDate}</p>
  </div>

  <div style="padding:0 32px 32px 32px;">
    ${bodyHtml}
  </div>
</div>`;

    console.log("[generate-daily-pulse] Pulse report generated successfully.");

    // ── Step 7: Store in report_archive (reuses existing table) ─────────────
    const reportJson = {
      is_first_pulse: isFirstPulse,
      newly_stalled_count: newlyStalled.length,
      back_on_track_count: backOnTrack.length,
      still_stalled_count: stillStalled.length,
    };

    if (!dry_run) {
      const { error: archiveError } = await supabase
        .from("report_archive")
        .insert({
          client_id,
          report_date: new Date().toISOString().split("T")[0],
          report_html: reportHtml,
          report_json: reportJson,
          deals_reviewed: null, // N/A for a delta report
          stalls_flagged: newlyStalled.length,
          pipeline_value: null, // N/A for a delta report
          forecast_confidence: null, // N/A for a delta report
          created_at: new Date().toISOString(),
        });

      if (archiveError) {
        console.warn("[generate-daily-pulse] Archive write failed:", archiveError.message);
      }
    }

    const duration = Date.now() - startTime;
    console.log(`[generate-daily-pulse] Complete in ${duration}ms`);

    await logAction({
      client_id,
      run_id,
      action_type: "daily_pulse_generated",
      notes: isFirstPulse
        ? `First Daily Pulse for this client — no comparison data yet. dry_run: ${dry_run}`
        : `Pulse generated in ${duration}ms. Newly stalled: ${newlyStalled.length}, Back on track: ${backOnTrack.length}, Still stalled: ${stillStalled.length}. dry_run: ${dry_run}`,
      success: true,
    });

    return respond(200, {
      success: true,
      dry_run,
      is_first_pulse: isFirstPulse,
      newly_stalled_count: newlyStalled.length,
      back_on_track_count: backOnTrack.length,
      still_stalled_count: stillStalled.length,
      report_html: reportHtml,
      duration_ms: duration,
    });

  } catch (err) {
    console.error("[generate-daily-pulse] Error:", err.message);
    await logError(
      { client_id, run_id, action_type: "daily_pulse_generated", notes: "Daily Pulse generation failed" },
      err
    ).catch(() => {});

    return respond(500, {
      success: false,
      error: err.message,
      message: "Daily Pipeline Pulse generation failed. Check logs for details.",
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
