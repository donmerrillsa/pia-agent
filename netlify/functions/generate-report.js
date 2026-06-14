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
    const reportDate = new Date().toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric"
    });

    // â”€â”€ Step 4: Build the prompt â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const dealsSummary = deals.length === 0
      ? "No active deals in pipeline."
      : deals.map(d =>
          `- ${d.deal_name || "Unnamed Deal"} | Stage: ${d.deal_stage || "Unknown"} | Amount: $${(d.amount || 0).toLocaleString()} | Days since activity: ${d.days_since_activity ?? "Unknown"}`
        ).join("\n");

    const stallsSummary = stalls.length === 0
      ? "No stalled deals detected."
      : stalls.map(s =>
          `- ${s.deal_name || "Unnamed Deal"} | Stage: ${s.deal_stage || "Unknown"} | Amount: $${(s.amount || 0).toLocaleString()} | Days stalled: ${s.days_stalled} | Reason: ${s.stall_reason} | Recommended action: ${s.recommended_action}`
        ).join("\n");

    const systemPrompt = `You are PIA â€” the Pipeline Integrity Agent. You are a no-nonsense B2B sales pipeline analyst. Your job is to write the Monday Morning Pipeline Report for a sales leader.

Your report style:
- Direct, executive-level language. No fluff.
- Specific deal names, amounts, and days stalled â€” always cite the data.
- Recommended actions are concrete and actionable, not generic.
- Forecast confidence is based on pipeline health: High (no stalls, strong activity), Medium (some stalls, mixed activity), Low (multiple stalls, low activity).
- Format as clean HTML using inline styles. Navy (#0D1B2A) headers, amber (#F5A623) highlights for stalled deals, white background.
- Keep the report scannable â€” use tables and bullet points where appropriate.`;

    const userPrompt = `Generate the Monday Morning Pipeline Report for ${client.company_name}.

Report Date: ${reportDate}
Total Pipeline Value: $${totalPipelineValue.toLocaleString()}
Total Active Deals: ${deals.length}
Stalled Deals: ${stalls.length}

ACTIVE DEALS:
${dealsSummary}

STALLED DEALS (require immediate attention):
${stallsSummary}

Write the full HTML report. Include:
1. Executive Summary (3-4 sentences max)
2. Pipeline Health Score (1-10 with brief rationale)
3. Stalled Deals Table (deal name, stage, amount, days stalled, severity, recommended action). Severity: AT RISK (exceeded threshold), CRITICAL (exceeded 2x threshold).
4. All Active Deals Summary Table
5. This Week\'s Priority Actions (top 3, numbered)
6. Forecast Confidence: High / Medium / Low with one-sentence rationale
7. What\'s Coming — include this exact HTML block at the bottom of the report before the signature:

<div style="background:#f8f9fa;border-left:4px solid #F5A623;padding:16px 20px;margin-top:32px;font-family:Arial,sans-serif;">
<p style="margin:0 0 8px 0;font-size:13px;font-weight:bold;color:#0D1B2A;">What\'s Coming in PIA</p>
<p style="margin:0 0 4px 0;font-size:12px;color:#333;"><strong>Phase 1 (now):</strong> PIA identifies stalled deals and tells you what action to take.</p>
<p style="margin:0 0 4px 0;font-size:12px;color:#333;"><strong>Phase 2:</strong> PIA drafts the follow-up and notifies the rep directly — no manual forwarding required.</p>
<p style="margin:0 0 4px 0;font-size:12px;color:#333;"><strong>Phase 3:</strong> PIA monitors whether the rep acted and escalates to you if they didn\'t.</p>
<p style="margin:0;font-size:12px;color:#333;"><strong>Phase 4:</strong> With your approval, PIA executes the follow-up autonomously — closing the loop without manager intervention.</p>
</div>

Sign it: "PIA — Pipeline Integrity Agent"`;
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

    const forecastConfidence = stalls.length === 0 ? "High"
      : stalls.length <= 2 ? "Medium" : "Low";

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
