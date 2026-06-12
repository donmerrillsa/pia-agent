// netlify/functions/client-status.js
// Returns current state of a client — deals, stalls, last report, last sync.
// Use this to check on a client's pipeline health at any time.
//
// GET /.netlify/functions/client-status?client_id=<uuid>

const { getSupabaseClient } = require("./_utils/supabase");

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return respond(405, { error: "Method not allowed. Use GET." });
  }

  const client_id = event.queryStringParameters?.client_id;

  if (!client_id) {
    return respond(400, { error: "Missing client_id query parameter." });
  }

  const supabase = getSupabaseClient();

  try {
    // ── Load client ───────────────────────────────────────────
    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select("id, company_name, contact_email, active, pilot_start_date, timezone, report_recipients")
      .eq("id", client_id)
      .single();

    if (clientError || !client) {
      return respond(404, { error: "Client not found." });
    }

    // ── Load deals summary ────────────────────────────────────
    const { data: deals } = await supabase
      .from("deals_cache")
      .select("id, deal_name, deal_stage, amount, days_since_activity, last_activity_date, synced_at")
      .eq("client_id", client_id)
      .order("days_since_activity", { ascending: false });

    // ── Load unresolved stalls ────────────────────────────────
    const { data: stalls } = await supabase
      .from("stall_events")
      .select("id, deal_name, deal_stage, amount, days_stalled, stall_reason, recommended_action, flagged_at")
      .eq("client_id", client_id)
      .eq("resolved", false)
      .order("days_stalled", { ascending: false });

    // ── Load last report ──────────────────────────────────────
    const { data: lastReport } = await supabase
      .from("report_archive")
      .select("id, report_date, deals_reviewed, stalls_flagged, pipeline_value, forecast_confidence, sent_at")
      .eq("client_id", client_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    // ── Load last action log entry ────────────────────────────
    const { data: lastAction } = await supabase
      .from("action_log")
      .select("action_type, created_at, success")
      .eq("client_id", client_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    // ── Calculate pipeline value ──────────────────────────────
    const totalPipelineValue = (deals || []).reduce(
      (sum, d) => sum + (d.amount || 0), 0
    );

    const stalledDeals = (deals || []).filter(
      (d) => d.days_since_activity !== null && d.days_since_activity >= 14
    );

    return respond(200, {
      client: {
        id: client.id,
        company_name: client.company_name,
        contact_email: client.contact_email,
        active: client.active,
        pilot_start_date: client.pilot_start_date,
        timezone: client.timezone,
        report_recipients: client.report_recipients,
      },
      pipeline_summary: {
        total_deals: (deals || []).length,
        total_pipeline_value: totalPipelineValue,
        stalled_deals: (stalls || []).length,
        last_synced: deals?.[0]?.synced_at ?? null,
      },
      stalled_deals: (stalls || []).map((s) => ({
        deal_name: s.deal_name,
        stage: s.deal_stage,
        amount: s.amount,
        days_stalled: s.days_stalled,
        recommended_action: s.recommended_action,
        flagged_at: s.flagged_at,
      })),
      all_deals: (deals || []).map((d) => ({
        deal_name: d.deal_name,
        stage: d.deal_stage,
        amount: d.amount,
        days_since_activity: d.days_since_activity,
        last_activity_date: d.last_activity_date,
      })),
      last_report: lastReport
        ? {
            report_date: lastReport.report_date,
            deals_reviewed: lastReport.deals_reviewed,
            stalls_flagged: lastReport.stalls_flagged,
            pipeline_value: lastReport.pipeline_value,
            forecast_confidence: lastReport.forecast_confidence,
            sent_at: lastReport.sent_at,
          }
        : null,
      last_action: lastAction
        ? {
            action_type: lastAction.action_type,
            created_at: lastAction.created_at,
            success: lastAction.success,
          }
        : null,
    });

  } catch (err) {
    console.error("[client-status] Error:", err.message);
    return respond(500, {
      error: err.message,
      message: "Failed to load client status.",
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
