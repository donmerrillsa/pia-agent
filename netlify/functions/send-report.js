// netlify/functions/send-report.js
// Sends the Monday Morning Pipeline Report via Resend email.
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
        subject: `Monday Morning Pipeline Report — ${reportDate}`,
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
