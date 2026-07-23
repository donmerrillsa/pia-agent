// netlify/functions/send-report.js
// Sends the Weekly Pipeline Integrity Report via Resend email.
// Mirrors send-daily-pulse.js's pattern closely.
//
// Also exports sendAdminAlert(), used by run-pipeline.js to notify
// the admin (Don) directly when a pipeline run fails outright — a
// separate, short internal alert, not the client-facing report.
//
// POST /.netlify/functions/send-report
// Body: { "client_id": "<uuid>", "run_id": "<uuid>" (optional) }

const { getSupabaseClient } = require("./_utils/supabase");
const { logAction, logError } = require("./_utils/logger");

const RESEND_API_URL = "https://api.resend.com/emails";
const ADMIN_ALERT_EMAIL = process.env.ADMIN_ALERT_EMAIL || "donmerrill.sa@gmail.com";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed. Use POST." });
  }

  let client_id, run_id;
  try {
    const body = JSON.parse(event.body || "{}");
    client_id = body.client_id;
    run_id = body.run_id ?? null;
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

  console.log(`[send-report] Sending Weekly Pipeline Integrity Report for client ${client_id}`);
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

    // ── Step 2: Get the most recent weekly report from the archive ──
    const { data: archive, error: archiveError } = await supabase
      .from("report_archive")
      .select("*")
      .eq("client_id", client_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (archiveError || !archive) {
      throw new Error("No report found in archive. Run generate-report first.");
    }

    const reportHtml = archive.report_html;
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
    console.log(`[send-report] Sending to ${recipients.join(", ")}...`);

    const resendResponse = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: `PIA — Pipeline Integrity Agent <${fromEmail}>`,
        to: recipients,
        subject: `Weekly Pipeline Integrity Report — ${reportDate}`,
        html: reportHtml,
      }),
    });

    if (!resendResponse.ok) {
      const errBody = await resendResponse.text();
      throw new Error(`Resend API failed [${resendResponse.status}]: ${errBody}`);
    }

    const resendData = await resendResponse.json();
    console.log("[send-report] Email sent successfully. ID:", resendData.id);

    // ── Step 5: Mark the archive row as sent ───────────────────
    await supabase
      .from("report_archive")
      .update({
        sent_at: new Date().toISOString(),
        send_success: true,
      })
      .eq("id", archive.id);

    const duration = Date.now() - startTime;

    await logAction({
      client_id,
      run_id,
      action_type: "weekly_report_sent",
      recipient: recipients.join(", "),
      status: "sent",
      notes: `Weekly Pipeline Integrity Report emailed to ${recipients.join(", ")} in ${duration}ms. Resend ID: ${resendData.id}`,
      success: true,
    });

    return respond(200, {
      success: true,
      recipients,
      resend_id: resendData.id,
      duration_ms: duration,
      message: `Weekly Pipeline Integrity Report sent to ${recipients.join(", ")}`,
    });

  } catch (err) {
    console.error("[send-report] Error:", err.message);
    await logError(
      { client_id, run_id, action_type: "weekly_report_sent", notes: "Weekly Pipeline Integrity Report send failed" },
      err
    ).catch(() => {});

    return respond(500, {
      success: false,
      error: err.message,
      message: "Weekly Pipeline Integrity Report send failed. Check logs for details.",
    });
  }
};

/**
 * Sends a short internal alert to the admin when a pipeline run fails
 * outright. Called directly by run-pipeline.js (not over HTTP) — best
 * effort, wrapped in .catch() by the caller, so a failure here never
 * masks the original pipeline error.
 */
async function sendAdminAlert({ client_id, failed_step, error_message }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.warn("[send-report] RESEND_API_KEY not configured — skipping admin alert.");
    return;
  }

  const fromEmail = process.env.REPORT_FROM_EMAIL || "pia@buy-mos.com";
  const subject = `PIA Pipeline Run Failed — ${failed_step || "unknown step"}`;
  const html = `
    <p><strong>A scheduled pipeline run failed.</strong></p>
    <p>Client ID: ${client_id || "unknown"}</p>
    <p>Failed step: ${failed_step || "unknown"}</p>
    <p>Error: ${error_message || "no error message provided"}</p>
  `;

  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: `PIA — Pipeline Integrity Agent <${fromEmail}>`,
        to: [ADMIN_ALERT_EMAIL],
        subject,
        html,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error(`[send-report] Admin alert failed to send [${res.status}]: ${errBody}`);
      return;
    }

    console.log(`[send-report] Admin alert sent to ${ADMIN_ALERT_EMAIL}`);
  } catch (err) {
    console.error("[send-report] Admin alert error:", err.message);
  }
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body, null, 2),
  };
}

module.exports.sendAdminAlert = sendAdminAlert;
