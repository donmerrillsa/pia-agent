// netlify/functions/generate-report.js
// Generates the Monday Morning Pipeline Report using OpenAI.
// Pulls stall events and deal data, sends to GPT-4o, formats the output,
// stores in report_archive, and returns the HTML report.
//
// POST /.netlify/functions/generate-report
// Body: { "client_id": "<uuid>", "dry_run": true/false }

const { getSupabaseClient } = require("./_utils/supabase");
const { logAction, logError } = require("./_utils/logger");

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed. Use POST." });
  }

  let client_id, dry_run;
  try {
    const body = JSON.parse(event.body || "{}");
    client_id = body.client_id;
    dry_run = body.dry_run ?? false;
  } catch {
    return respond(400, { error: "Invalid JSON body." });
  }

  if (!client_id) {
    return respond(400, { error: "Missing client_id." });
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    return respond(500, { error: "OPENAI_API_KEY not configured." });
  }

  console.log(`[generate-report] Starting report for client ${client_id} (dry_run: ${dry_run})`);
  const startTime = Date.now();
  const supabase = getSupabaseClient();

  try {
    // â”€â”€ Step 1: Load client record â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select("*")
      .eq("id", client_id)
      .single();

    if (clientError || !client) {
      throw new Error(`Client not found: ${clientError?.message}`);
    }

    // â”€â”€ Step 2: Load deals from cache â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const { data: deals, error: dealsError } = await supabase
      .from("deals_cache")
      .select("*")
      .eq("client_id", client_id)
      .order("days_since_activity", { ascending: false });

    if (dealsError) throw new Error(`Failed to load deals: ${dealsError.message}`);

    // â”€â”€ Step 3: Load unresolved stall events â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const { data: stalls, error: stallsError } = await supabase
      .from("stall_events")
      .select("*")
      .eq("client_id", client_id)
      .eq("resolved", false)
      .order("days_stalled", { ascending: false });

    if (stallsError) throw new Error(`Failed to load stalls: ${stallsError.message}`);

    const totalPipelineValue = deals.reduce((sum, d) => sum + (d.amount || 0), 0);

    // Forecast confidence based on stalled value as % of total pipeline
    // High: stalled value < 10% of pipeline
    // Medium: stalled value 10-30% of pipeline
    // Low: stalled value > 30% of pipeline
    const stalledValue = stalls.reduce((sum, s) => sum + (s.amount || 0), 0);
    const stalledPct = totalPipelineValue > 0 ? (stalledValue / totalPipelineValue) : 0;
    const forecastConfidence = stalledPct < 0.10 ? "High"
      : stalledPct <= 0.30 ? "Medium" : "Low";

    const reportDate = new Date().toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric"
    });

    // â”€â”€ Step 4: Build the prompt â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Stage ID to readable name mapping
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

    // Filter closed deals from active deals display
    const CLOSED_STAGES = new Set(["closedwon", "closedlost"]);
    const activeDeals = deals.filter(d => !CLOSED_STAGES.has((d.deal_stage || "").toLowerCase()));

    const dealsSummary = activeDeals.length === 0
      ? "No active deals in pipeline."
      : activeDeals.map(d =>
          `- ${d.deal_name || "Unnamed Deal"} | Stage: ${stageName(d.deal_stage)} | Amount: $${(d.amount || 0).toLocaleString()} | Days since activity: ${d.days_since_activity ?? "Unknown"}`
        ).join("\n");

    const stallsSummary = stalls.length === 0
      ? "No stalled deals detected."
      : stalls.map(s =>
          `- ${s.deal_name || "Unnamed Deal"} | Stage: ${stageName(s.deal_stage)} | Amount: $${(s.amount || 0).toLocaleString()} | Days stalled: ${s.days_stalled} | Severity: ${s.severity || "AT RISK"} | Recommended action: ${s.recommended_action}`
        ).join("\n");

    const systemPrompt = `You are PIA, the Pipeline Integrity Agent. You are a no-nonsense B2B sales pipeline analyst writing the Monday Morning Pipeline Report for a sales leader.

Your report style:
- Direct, executive-level language. No fluff, no filler.
- Always cite specific deal names, dollar amounts, and days stalled.
- Recommended actions are concrete and stage-specific, never generic.
- Format as clean HTML using inline styles only. Navy (#0D1B2A) headers, amber (#F5A623) accent for stalled deal rows, white background, Arial font.
- Keep the report scannable. Tables for deal data, short bullets for actions.
- Do NOT include a signature line or closing statement. The report ends after the priority actions section.
- Do NOT include a Pipeline Health Score. Forecast Confidence is provided separately.
- CRITICAL: Use the Severity value exactly as provided in the stall data (AT RISK or CRITICAL). Do not recalculate or override it.
- CRITICAL: Use the Stage name exactly as provided in the data. Do not substitute or rephrase stage names.`;
    const userPrompt = `Generate the Monday Morning Pipeline Report for ${client.company_name}.

Report Date: ${reportDate}
Total Pipeline Value: $${totalPipelineValue.toLocaleString()}
Total Active Deals: ${activeDeals.length} (excluding Closed Won/Lost)
Stalled Deals: ${stalls.length}
Stalled Pipeline Value: $${stalledValue.toLocaleString()} (${Math.round(stalledPct * 100)}% of total pipeline)
Forecast Confidence: ${forecastConfidence} — ${Math.round(stalledPct * 100)}% of pipeline value is currently stalled (target: below 10% for High confidence)

ACTIVE DEALS:
${dealsSummary}

STALLED DEALS (require immediate attention):
${stallsSummary}

Write the full HTML report with these sections in this exact order:
1. Executive Summary (3-4 sentences — pipeline status, stall count, forecast confidence, one key risk)
2. Forecast Confidence: ${forecastConfidence} — one sentence explaining why, referencing the stalled value percentage
3. Stalled Deals Table with columns: Deal Name | Stage | Amount | Business Days Stalled | Severity | Recommended Action. Severity values: AT RISK or CRITICAL only. Use the Severity value exactly as provided — do not recalculate.
4. This Week\'s Priority Actions (top 3, numbered, specific to the stalled deals above)
5. All Active Deals Summary Table with columns: Deal Name | Stage | Amount | Days Since Activity

Do not include a Pipeline Health Score. Do not include a signature. End the report after the All Active Deals table.`;
    // â”€â”€ Step 5: Call OpenAI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    console.log("[generate-report] Calling OpenAI...");
    const openaiResponse = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 3000,
        temperature: 0.3,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!openaiResponse.ok) {
      const errBody = await openaiResponse.text();
      throw new Error(`OpenAI API failed [${openaiResponse.status}]: ${errBody}`);
    }

    const openaiData = await openaiResponse.json();
    let reportHtml = openaiData.choices?.[0]?.message?.content;
// Strip markdown code fences if OpenAI wraps the HTML
if (reportHtml) {
  reportHtml = reportHtml.replace(/^```html\s*/i, "").replace(/```\s*$/i, "").trim();
}

    if (!reportHtml) {
      throw new Error("OpenAI returned empty response.");
    }

    // Inject hardcoded sections — guaranteed to appear regardless of AI output
    const roadmapHtml = `
<div style="background:#f8f9fa;border-left:4px solid #F5A623;padding:16px 20px;margin-top:32px;font-family:Arial,sans-serif;">
  <p style="margin:0 0 10px 0;font-size:13px;font-weight:bold;color:#0D1B2A;">What's Coming in PIA</p>
  <p style="margin:0 0 6px 0;font-size:12px;color:#333;"><strong>Phase 1 (now):</strong> PIA identifies stalled deals and tells you what action to take.</p>
  <p style="margin:0 0 6px 0;font-size:12px;color:#333;"><strong>Phase 2:</strong> PIA drafts the follow-up and notifies the rep directly — no manual forwarding required.</p>
  <p style="margin:0 0 6px 0;font-size:12px;color:#333;"><strong>Phase 3:</strong> PIA monitors whether the rep acted and escalates to you if they didn't.</p>
  <p style="margin:0;font-size:12px;color:#333;"><strong>Phase 4:</strong> PIA executes follow-ups autonomously within rules you define — you set the guardrails once, PIA operates within them.</p>
</div>`;

    // Append roadmap at end of report
    reportHtml = reportHtml + roadmapHtml;

    console.log("[generate-report] Report generated successfully.");

    // â”€â”€ Step 6: Store in report_archive â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    await logAction({
      client_id,
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
      { client_id, action_type: "report_generated", notes: "Report generation failed" },
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
