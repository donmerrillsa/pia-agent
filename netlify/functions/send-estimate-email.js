// netlify/functions/send-estimate-email.js
// Emails a customer their estimate link. Triggered by the "Send Email"
// button on the confirmation screen after an estimate is saved.
//
// The business owner's own copy is handled separately and automatically
// by submit-estimate.js on every save — this function only ever sends
// to the customer, and only when a tech chooses to use it.
//
// POST /.netlify/functions/send-estimate-email
// Body: { business_id, customer_email, customer_name, estimate_url }

const { getSupabaseClient } = require("./_utils/supabase");

const RESEND_API_URL = "https://api.resend.com/emails";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed. Use POST." });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return respond(400, { error: "Invalid JSON body." });
  }

  const { business_id, customer_email, customer_name, estimate_url } = body;

  if (!business_id || !customer_email || !estimate_url) {
    return respond(400, { error: "Missing business_id, customer_email, or estimate_url." });
  }

  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.ESTIMATE_FROM_EMAIL || process.env.REPORT_FROM_EMAIL || "pia@buy-mos.com";

  if (!resendKey) {
    return respond(500, { error: "RESEND_API_KEY not configured." });
  }

  const supabase = getSupabaseClient();

  try {
    const { data: business } = await supabase
      .from("estimate_businesses")
      .select("business_name")
      .eq("id", business_id)
      .single();

    const bizName = business?.business_name || "Your HVAC Provider";
    const subject = `Your HVAC Replacement Estimate — ${bizName}`;
    const html = `
      <p>Hi${customer_name ? " " + escapeHtml(customer_name) : ""},</p>
      <p>Here's your estimate: <a href="${estimate_url}">${estimate_url}</a></p>
      <p>Let us know if you have any questions.</p>
      <p>${escapeHtml(bizName)}</p>
    `;

    const resendResponse = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: `${bizName} <${fromEmail}>`,
        to: [customer_email],
        subject,
        html,
      }),
    });

    if (!resendResponse.ok) {
      const errBody = await resendResponse.text();
      throw new Error(`Resend API failed [${resendResponse.status}]: ${errBody}`);
    }

    const resendData = await resendResponse.json();

    return respond(200, {
      success: true,
      resend_id: resendData.id,
      message: `Estimate emailed to ${customer_email}`,
    });

  } catch (err) {
    console.error("[send-estimate-email] Error:", err.message);
    return respond(500, {
      success: false,
      error: err.message,
      message: "Could not send this estimate email. Please try again.",
    });
  }
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body, null, 2),
  };
}
