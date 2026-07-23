// netlify/functions/approve-estimate.js
// Records which tier a customer approved and immediately notifies the
// business owner by email. This is NOT a legal signature — it's a
// timestamped, unambiguous record of what the customer clicked, meant
// to replace "customer called and said they want the Best option" with
// something in writing. Real binding acceptance still happens when the
// business re-keys the approved option into their own system (e.g.
// Housecall Pro).
//
// POST /.netlify/functions/approve-estimate
// Body: { estimate_id, tier }   tier is "good" | "better" | "best"

const { getSupabaseClient } = require("./_utils/supabase");

const RESEND_API_URL = "https://api.resend.com/emails";
const TIER_LABELS = { good: "A Good Option", better: "A Better Option", best: "The Best Option" };

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

  const { estimate_id, tier } = body;
  if (!estimate_id || !TIER_LABELS[tier]) {
    return respond(400, { error: "Missing or invalid estimate_id/tier." });
  }

  const supabase = getSupabaseClient();

  try {
    const approvedAt = new Date().toISOString();

    const { data: estimate, error: updateError } = await supabase
      .from("estimates")
      .update({ approved_tier: tier, approved_at: approvedAt })
      .eq("id", estimate_id)
      .select("*")
      .single();

    if (updateError || !estimate) {
      throw new Error(`Failed to record approval: ${updateError?.message}`);
    }

    console.log(`[approve-estimate] Estimate ${estimate_id} approved: ${tier}`);

    // Notify the business owner — best effort, doesn't fail the approval itself
    try {
      await notifyApproval(supabase, estimate, tier, approvedAt);
    } catch (err) {
      console.error("[approve-estimate] Owner notification failed:", err.message);
    }

    return respond(200, { success: true, approved_tier: tier, approved_at: approvedAt });

  } catch (err) {
    console.error("[approve-estimate] Error:", err.message);
    return respond(500, {
      success: false,
      error: err.message,
      message: "Could not record your approval. Please try again or contact us directly.",
    });
  }
};

async function notifyApproval(supabase, estimate, tier, approvedAt) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.warn("[approve-estimate] RESEND_API_KEY not configured — skipping approval notification.");
    return;
  }

  const { data: business, error } = await supabase
    .from("estimate_businesses")
    .select("business_name, notification_email")
    .eq("id", estimate.business_id)
    .single();

  if (error || !business || !business.notification_email) {
    console.warn(`[approve-estimate] No notification_email on file for business ${estimate.business_id} — skipping.`);
    return;
  }

  const fromEmail = process.env.ESTIMATE_FROM_EMAIL || process.env.REPORT_FROM_EMAIL || "pia@buy-mos.com";
  const baseUrl = process.env.SITE_URL || "https://your-site.netlify.app";
  const estimateUrl = `${baseUrl}/estimate/${estimate.id}`;
  const tierLabel = TIER_LABELS[tier];
  const when = new Date(approvedAt).toLocaleString("en-US", {
    dateStyle: "long", timeStyle: "short",
  });

  const subject = `Estimate Approved — ${estimate.customer_name || "Customer"} chose ${tierLabel}`;
  const html = `
    <p><strong>${escapeHtml(estimate.customer_name || "A customer")}</strong> approved <strong>${escapeHtml(tierLabel)}</strong> on this estimate.</p>
    <p>Approved: ${escapeHtml(when)}</p>
    <p>View the estimate: <a href="${estimateUrl}">${estimateUrl}</a></p>
    <p>Next step: re-key this into your scheduling/invoicing system to finalize it.</p>
  `;

  const res = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${resendKey}`,
    },
    body: JSON.stringify({
      from: `${business.business_name || "Estimate Tool"} <${fromEmail}>`,
      to: [business.notification_email],
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Resend API failed [${res.status}]: ${errBody}`);
  }

  console.log(`[approve-estimate] Approval notification sent to ${business.notification_email}`);
}

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
