// netlify/functions/generate-report.js
// Generates the Pipeline Integrity Report from data only — no AI call.
// Pulls stall events and deal data, builds HTML report from template,
// stores in report_archive, and returns the HTML report.
//
// POST /.netlify/functions/generate-report
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

const CLOSED_STAGES = new Set(["closedwon", "closedlost"]);

const stageName = (stage) => STAGE_NAMES[stage] || stage;

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

  console.log(`[generate-report] Starting report for client ${client_id} (dry_run: ${dry_run})`);
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

    // ── Step 2: Load deals from cache ───────────────────────────────────────
    const { data: deals, error: dealsError } = await supabase
      .from("deals_cache")
      .select("*")
      .eq("client_id", client_id)
      .order("days_since_activity", { ascending: false });

    if (dealsError) throw new Error(`Failed to load deals: ${dealsError.message}`);

    // Lookup map so stall rows (which don't store stage_probability directly)
    // can pull it from the matching deals_cache row at render time.
    const probabilityByDealId = new Map(
      deals.map(d => [d.hubspot_deal_id, d.stage_probability])
    );

    // ── Step 3: Load unresolved stall events ────────────────────────────────
    const { data: stalls, error: stallsError } = await supabase
      .from("stall_events")
      .select("*")
      .eq("client_id", client_id)
      .eq("resolved", false)
      .order("days_stalled", { ascending: false });

    if (stallsError) throw new Error(`Failed to load stalls: ${stallsError.message}`);

    // ── Step 4: Compute metrics ─────────────────────────────────────────────
    const activeDeals = deals.filter(d => !CLOSED_STAGES.has((d.deal_stage || "").toLowerCase()));
    const totalPipelineValue = activeDeals.reduce((sum, d) => sum + (d.amount || 0), 0);
    const stalledValue = stalls.reduce((sum, s) => sum + (s.amount || 0), 0);
    const stalledPct = totalPipelineValue > 0 ? (stalledValue / totalPipelineValue) : 0;
    const forecastConfidence = stalledPct < 0.10 ? "High" : stalledPct <= 0.30 ? "Medium" : "Low";
    const stalledPctDisplay = Math.round(stalledPct * 100);

    const reportDate = new Date().toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric"
    });

    // ── Step 5: Build HTML report ───────────────────────────────────────────
    const confidenceColor = forecastConfidence === "High" ? "#2e7d32" : forecastConfidence === "Medium" ? "#e65100" : "#b71c1c";

    const confidenceExplanation = forecastConfidence === "High"
      ? `Forecast confidence is <strong style="color:${confidenceColor};">High</strong>. Less than 10% of pipeline value is stalled — pipeline is healthy.`
      : forecastConfidence === "Medium"
      ? `Forecast confidence is <strong style="color:${confidenceColor};">Medium</strong>. ${stalledPctDisplay}% of pipeline value ($${stalledValue.toLocaleString()} of $${totalPipelineValue.toLocaleString()}) is stalled, which is above the 10% threshold for High confidence. Stalled value must fall below 10% to reach High confidence.`
      : `Forecast confidence is <strong style="color:${confidenceColor};">Low</strong>. ${stalledPctDisplay}% of pipeline value ($${stalledValue.toLocaleString()} of $${totalPipelineValue.toLocaleString()}) is stalled — more than three times the 10% threshold for High confidence. Forecast is unreliable until stalled deals are resolved or removed from the pipeline.`;

    const executiveSummary = stalls.length === 0
      ? `Pipeline contains ${activeDeals.length} active deals totaling $${totalPipelineValue.toLocaleString()}. No stalled deals detected this period. ${confidenceExplanation}`
      : `Pipeline contains ${activeDeals.length} active deals totaling $${totalPipelineValue.toLocaleString()}. <strong>${stalls.length} deal${stalls.length > 1 ? "s are" : " is"} stalled</strong>, representing $${stalledValue.toLocaleString()} (${stalledPctDisplay}% of pipeline value). ${confidenceExplanation} All ${stalls.length} stalled deal${stalls.length > 1 ? "s require" : " requires"} attention — see the Stalled Deals table below for deal-by-deal status and recommended actions.`;

    const thStyle = `style="padding:10px 12px;text-align:left;background:#0D1B2A;color:#fff;font-size:13px;"`;
    const tdStyle = `style="padding:10px 12px;border-bottom:1px solid #e0e0e0;"`;
    const tdBoldStyle = `style="padding:10px 12px;border-bottom:1px solid #e0e0e0;font-weight:bold;"`;

    const stalledRowsHtml = stalls.length === 0
      ? `<tr><td colspan="8" style="padding:12px;text-align:center;color:#666;border-bottom:1px solid #e0e0e0;">No stalled deals detected.</td></tr>`
      : stalls.map(s => {
        const prob = probabilityByDealId.get(s.hubspot_deal_id);
        const hasProb = typeof prob === "number" && !Number.isNaN(prob);
        const probPct = hasProb ? Math.round(prob * 100) : null;
        // A deal both stalled (it's in this table at all) and self-reported
        // as high-probability is a contradiction worth calling out visually —
        // this does not change the rep's number, only flags it for review.
        const isContradiction = hasProb && probPct >= 60;
        const probCell = !hasProb
          ? `<span style="color:#999;">&mdash;</span>`
          : isContradiction
          ? `<strong style="color:#b71c1c;">${probPct}%&nbsp;&#9888;</strong>`
          : `${probPct}%`;
        return `
        <tr style="background:#FFF8EC;">
          <td style="padding:10px 12px;border-bottom:1px solid #e0e0e0;font-weight:bold;">${s.deal_name || "Unnamed Deal"}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #e0e0e0;">${s.owner_id || "Unassigned"}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #e0e0e0;">${stageName(s.deal_stage)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #e0e0e0;">$${(s.amount || 0).toLocaleString()}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #e0e0e0;text-align:center;">${probCell}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #e0e0e0;text-align:center;">${s.days_stalled}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #e0e0e0;font-weight:bold;color:#b71c1c;">${s.severity || "AT RISK"}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #e0e0e0;">${s.recommended_action || "Review and re-engage."}</td>
        </tr>`;
      }).join("");

    const allDealsRowsHtml = activeDeals.length === 0
      ? `<tr><td colspan="4" style="padding:12px;text-align:center;color:#666;border-bottom:1px solid #e0e0e0;">No active deals in pipeline.</td></tr>`
      : activeDeals.map(d => `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #e0e0e0;">${d.deal_name || "Unnamed Deal"}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #e0e0e0;">${stageName(d.deal_stage)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #e0e0e0;">$${(d.amount || 0).toLocaleString()}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #e0e0e0;text-align:center;">${d.days_since_activity ?? "Unknown"}</td>
        </tr>`).join("");

    const reportHtml = `
<div style="font-family:Arial,sans-serif;max-width:900px;margin:0 auto;color:#1a1a1a;background:#fff;">

  <!-- Header -->
  <div style="background:#0D1B2A;padding:24px 32px;margin-bottom:24px;">
    <p style="margin:0;font-size:12px;color:#F5A623;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">Pipeline Integrity Agent</p>
    <h1 style="margin:6px 0 4px 0;font-size:22px;color:#fff;">Pipeline Integrity Report</h1>
    <p style="margin:0;font-size:13px;color:#adb5bd;">${client.company_name} &nbsp;|&nbsp; ${reportDate}</p>
  </div>

  <div style="padding:0 32px 32px 32px;">

    <!-- Executive Summary -->
    <h2 style="font-size:15px;color:#0D1B2A;border-bottom:2px solid #0D1B2A;padding-bottom:6px;margin-bottom:12px;">Executive Summary</h2>
    <p style="font-size:14px;line-height:1.6;margin-bottom:28px;">${executiveSummary}</p>

    <!-- Stalled Deals Table -->
    <h2 style="font-size:15px;color:#0D1B2A;border-bottom:2px solid #0D1B2A;padding-bottom:6px;margin-bottom:12px;">Stalled Deals</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:32px;">
      <thead>
        <tr>
          <th ${thStyle}>Deal Name</th>
          <th ${thStyle}>Rep</th>
          <th ${thStyle}>Stage</th>
          <th ${thStyle}>Amount</th>
          <th ${thStyle}>Stated Probability</th>
          <th ${thStyle}>Days Stalled</th>
          <th ${thStyle}>Severity</th>
          <th ${thStyle}>Recommended Action</th>
        </tr>
      </thead>
      <tbody>${stalledRowsHtml}</tbody>
    </table>

    <!-- All Active Deals Table -->
    <h2 style="font-size:15px;color:#0D1B2A;border-bottom:2px solid #0D1B2A;padding-bottom:6px;margin-bottom:12px;">All Active Deals</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:32px;">
      <thead>
        <tr>
          <th ${thStyle}>Deal Name</th>
          <th ${thStyle}>Stage</th>
          <th ${thStyle}>Amount</th>
          <th ${thStyle}>Days Since Activity</th>
        </tr>
      </thead>
      <tbody>${allDealsRowsHtml}</tbody>
    </table>

    <!-- PIA Roadmap -->
    <div style="background:#f8f9fa;border-left:4px solid #F5A623;padding:16px 20px;margin-top:8px;">
      <p style="margin:0 0 10px 0;font-size:13px;font-weight:bold;color:#0D1B2A;">What's Coming in PIA</p>
      <p style="margin:0 0 6px 0;font-size:12px;color:#333;"><strong>Phase 1 (now):</strong> PIA identifies stalled deals and tells you what action to take.</p>
      <p style="margin:0 0 6px 0;font-size:12px;color:#333;"><strong>Phase 2:</strong> PIA drafts the follow-up and notifies the rep directly — no manual forwarding required.</p>
      <p style="margin:0 0 6px 0;font-size:12px;color:#333;"><strong>Phase 3:</strong> PIA monitors whether the rep acted and escalates to you if they didn't.</p>
      <p style="margin:0;font-size:12px;color:#333;"><strong>Phase 4:</strong> PIA executes follow-ups autonomously within rules you define — you set the guardrails once, PIA operates within them.</p>
    </div>

  </div>
</div>`;

    console.log("[generate-report] Report generated successfully.");

    // ── Step 6: Store in report_archive ────────────────────────────────────
    const reportJson = {
      deals_count: deals.length,
      stalls_count: stalls.length,
      total_pipeline_value: totalPipelineValue,
      stalled_deals: stalls.map(s => ({
        deal_name: s.deal_name,
        deal_stage: s.deal_stage,
        amount: s.amount,
        days_stalled: s.days_stalled,
        recommended_action: s.recommended_action,
      })),
    };

    if (!dry_run) {
      const { error: archiveError } = await supabase
        .from("report_archive")
        .insert({
          client_id,
          report_date: new Date().toISOString().split("T")[0],
          report_html: reportHtml,
          report_json: reportJson,
          deals_reviewed: deals.length,
          stalls_flagged: stalls.length,
          pipeline_value: totalPipelineValue,
          forecast_confidence: forecastConfidence,
          created_at: new Date().toISOString(),
        });

      if (archiveError) {
        console.warn("[generate-report] Archive write failed:", archiveError.message);
      }
    }

    const duration = Date.now() - startTime;
    console.log(`[generate-report] Complete in ${duration}ms`);

    await logAction({
      client_id,
      run_id,
      action_type: "report_generated",
      notes: `Report generated in ${duration}ms. Deals: ${deals.length}, Stalls: ${stalls.length}, Forecast: ${forecastConfidence}. dry_run: ${dry_run}`,
      success: true,
    });

    return respond(200, {
      success: true,
      dry_run,
      deals_reviewed: deals.length,
      stalls_flagged: stalls.length,
      forecast_confidence: forecastConfidence,
      pipeline_value: totalPipelineValue,
      report_html: reportHtml,
      duration_ms: duration,
    });

  } catch (err) {
    console.error("[generate-report] Error:", err.message);
    await logError(
      { client_id, run_id, action_type: "report_generated", notes: "Report generation failed" },
      err
    ).catch(() => {});

    return respond(500, {
      success: false,
      error: err.message,
      message: "Report generation failed. Check logs for details.",
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
