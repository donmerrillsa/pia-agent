// netlify/functions/send-daily-pulse.js
// Sends the Daily Pipeline Pulse via Resend email.
// Mirrors send-report.js's pattern closely.
//
// IMPORTANT: report_html should be passed directly by the daily orchestrator
// (scheduled-daily-pulse.js), not left to fall back on the archive lookup.
// report_archive is shared between generate-report.js (weekly) and
// generate-daily-pulse.js (daily) — "most recent row" is safe today because
// the two never run on the same day (weekly = Friday only, daily = Mon-Thu
// only), but that's a schedule-dependent assumption, not a guarantee. Passing
// report_html directly sidesteps the risk entirely. The archive fallback
// below exists for manual/ad-hoc testing only.
//
// POST /.netlify/functions/send-daily-pulse
// Body: { "client_id": "<uuid>", "report_html": "<optional override>" }

const { getSupabaseClient } = require("./_utils/supabase");
const { logAction, logError } = require("./_utils/logger");

const RESEND_API_URL = "https://api.resend.com/emails";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed. Use POST." });
  }

  let client_id, run_id, report_html_override;
  try {
    const body = JSON.parse(event.body || "{}");
    client_id = body.client_id;
    run_id = body.run_id ?? null;
    report_html_override = body.report_html ?? null;
  } catch {
    return respond(400, { error: "Invalid JSON body." });
  }

  if (!client_id) {
    return respond(400, { error: "Missing client_id." });
  }

  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.REPORT_FROM_EMAIL || "pia@buy-mos.com";

  if (!resendKey) {
    return respond(500, { error: "RESEND_API_KEY not configured." });
  }

  console.log(`[send-daily-pulse] Sending Daily Pipeline Pulse for client ${client_id}`);
  const startTime = Date.now();
  const supabase = getSupabaseClient();

  try {
    // ── Step 1: Load client record ────────────────────────────
    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select("*")
      .eq("id", client_id)
      .single();

    if (clientError || !client) {
      throw new Error(`Client not found: ${clientError?.message}`);
    }

    // ── Step 2: Get report HTML ───────────────────────────────
    let reportHtml = report_html_override;

    if (!reportHtml) {
      // Fallback for manual/ad-hoc testing only — see file header note above
      // about why the orchestrator should pass report_html directly instead.
      console.warn("[send-daily-pulse] No report_html passed — falling back to most recent archive row. This is intended for manual testing only.");

      const { data: archive, error: archiveError } = await supabase
        .from("report_archive")
        .select("*")
        .eq("client_id", client_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (archiveError || !archive) {
        throw new Error("No report found in archive. Run generate-daily-pulse first.");
      }

      reportHtml = archive.report_html;
    }

    if (!reportHtml) {
      throw new Error("Report HTML is empty.");
    }

    // ── Step 3: Determine recipients ──────────────────────────
    const recipients = client.report_recipients?.length
      ? client.report_recipients
      : [client.contact_email];

    if (!recipients.length) {
      throw new Error("No recipients configured for this client.");
    }

    const reportDate = new Date().toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric"
    });

    // ── Step 4: Send via Resend ───────────────────────────────
    console.log(`[send-daily-pulse] Sending to ${recipients.join(", ")}...`);

    const resendResponse = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: `PIA — Pipeline Integrity Agent <${fromEmail}>`,
        to: recipients,
        subject: `Daily Pipeline Pulse — ${reportDate}`,
        html: reportHtml,
      }),
    });

    if (!resendResponse.ok) {
      const errBody = await resendResponse.text();
      throw new Error(`Resend API failed [${resendResponse.status}]: ${errBody}`);
    }

    const resendData = await resendResponse.json();
    console.log("[send-daily-pulse] Email sent successfully. ID:", resendData.id);

    // ── Step 5: Update report_archive with send status ────────
    // Only updates if we used the archive fallback in Step 2 — if report_html
    // was passed directly, the orchestrator's own generate-daily-pulse call
    // already wrote that archive row and this would be redundant.
    if (!report_html_override) {
      await supabase
        .from("report_archive")
        .update({
          sent_at: new Date().toISOString(),
          send_success: true,
        })
        .eq("client_id", client_id)
        .order("created_at", { ascending: false })
        .limit(1);
    }

    const duration = Date.now() - startTime;

    await logAction({
      client_id,
      run_id,
      action_type: "daily_pulse_sent",
      recipient: recipients.join(", "),
      status: "sent",
      notes: `Daily Pipeline Pulse emailed to ${recipients.join(", ")} in ${duration}ms. Resend ID: ${resendData.id}`,
      success: true,
    });

    return respond(200, {
      success: true,
      recipients,
      resend_id: resendData.id,
      duration_ms: duration,
      message: `Daily Pipeline Pulse sent to ${recipients.join(", ")}`,
    });

  } catch (err) {
    console.error("[send-daily-pulse] Error:", err.message);
    await logError(
      { client_id, run_id, action_type: "daily_pulse_sent", notes: "Daily Pipeline Pulse send failed" },
      err
    ).catch(() => {});

    return respond(500, {
      success: false,
      error: err.message,
      message: "Daily Pipeline Pulse send failed. Check logs for details.",
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
