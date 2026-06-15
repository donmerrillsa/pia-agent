// netlify/functions/send-report.js
// Sends the Pipeline Integrity Report via Resend email.
// Pulls the most recent report from report_archive and emails it
// to all recipients configured on the client record.
//
// POST /.netlify/functions/send-report
// Body: { "client_id": "<uuid>", "report_html": "<optional — if provided, sends this instead of archive>" }

const { getSupabaseClient } = require("./_utils/supabase");
const { logAction, logError } = require("./_utils/logger");

const RESEND_API_URL = "https://api.resend.com/emails";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed. Use POST." });
  }

  let client_id, report_html_override;
  try {
    const body = JSON.parse(event.body || "{}");
    client_id = body.client_id;
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

  console.log(`[send-report] Sending report for client ${client_id}`);
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
      // Pull most recent report from archive
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
        subject: `Pipeline Integrity Report — ${reportDate}`,
        html: reportHtml,
      }),
    });

    if (!resendResponse.ok) {
      const errBody = await resendResponse.text();
      throw new Error(`Resend API failed [${resendResponse.status}]: ${errBody}`);
    }

    const resendData = await resendResponse.json();
    console.log("[send-report] Email sent successfully. ID:", resendData.id);

    // ── Step 5: Update report_archive with send status ────────
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
      action_type: "report_sent",
      recipient: recipients.join(", "),
      status: "sent",
      notes: `Report emailed to ${recipients.join(", ")} in ${duration}ms. Resend ID: ${resendData.id}`,
      success: true,
    });

    return respond(200, {
      success: true,
      recipients,
      resend_id: resendData.id,
      duration_ms: duration,
      message: `Report sent to ${recipients.join(", ")}`,
    });

  } catch (err) {
    console.error("[send-report] Error:", err.message);
    await logError(
      { client_id, action_type: "report_sent", notes: "Report send failed" },
      err
    ).catch(() => {});

    return respond(500, {
      success: false,
      error: err.message,
      message: "Report send failed. Check logs for details.",
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

/**
 * Send an admin alert email when a pipeline run fails.
 * Called from run-pipeline.js catch block.
 */
async function sendAdminAlert({ client_id, failed_step, error_message }) {
  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.REPORT_FROM_EMAIL || "pia@buy-mos.com";
  const adminEmail = process.env.ADMIN_ALERT_EMAIL;

  if (!resendKey || !adminEmail) {
    console.warn("[send-report] Admin alert skipped — RESEND_API_KEY or ADMIN_ALERT_EMAIL not configured.");
    return;
  }

  const now = new Date();
  const timestamp = now.toLocaleString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short"
  });

  const subject = `[PIA ALERT] Pipeline run failed — ${now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} ${now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #c0392b; padding: 16px 24px;">
        <h2 style="color: white; margin: 0;">⚠️ PIA Pipeline Run Failed</h2>
      </div>
      <div style="padding: 24px; border: 1px solid #e0e0e0;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px 0; font-weight: bold; width: 140px;">Timestamp</td>
            <td style="padding: 8px 0;">${timestamp}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; font-weight: bold;">Client ID</td>
            <td style="padding: 8px 0; font-family: monospace;">${client_id}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; font-weight: bold;">Failed Step</td>
            <td style="padding: 8px 0;">${failed_step}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; font-weight: bold; vertical-align: top;">Error</td>
            <td style="padding: 8px 0; font-family: monospace; color: #c0392b;">${error_message}</td>
          </tr>
        </table>
        <hr style="margin: 16px 0; border: none; border-top: 1px solid #e0e0e0;">
        <p style="color: #666; font-size: .85rem; margin: 0;">
          This is an automated alert from Pipeline Integrity Agent. Check Supabase action_log and Netlify function logs for full details.
        </p>
      </div>
    </div>
  `;

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: `PIA — Pipeline Integrity Agent <${fromEmail}>`,
        to: [adminEmail],
        subject,
        html,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`[send-report] Admin alert send failed [${response.status}]: ${errBody}`);
    } else {
      console.log("[send-report] Admin alert sent to:", adminEmail);
    }
  } catch (err) {
    console.error("[send-report] Admin alert exception:", err.message);
  }
}

module.exports.sendAdminAlert = sendAdminAlert;
