// netlify/functions/submit-estimate.js
// Receives a completed estimate from the web form, uploads any photos
// to Supabase Storage, saves the estimate to the estimates table, and
// returns a unique link the tech can send to the customer.
//
// Also automatically emails the business owner (e.g. Pappas) a copy of
// every save — new estimate or edit — via Resend, so their own record
// (see the HVAC Estimates folder instructions) is always accurate
// without depending on anyone remembering to forward anything.
//
// POST /.netlify/functions/submit-estimate
// Body: {
//   id (optional — present when editing an existing estimate),
//   business_id, customer_name, site_address, proposal_date,
//   current_system, diagnosis, technician,
//   good: { brand, seer, price, warranty, features, photo_data_url, existing_photo_url },
//   better: { ...same },
//   best:   { ...same }
// }

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

  const { id, business_id, customer_name, site_address, proposal_date, current_system, diagnosis, technician, scope_of_work, financing_options, expires_date } = body;

  if (!business_id) {
    return respond(400, { error: "Missing business_id." });
  }

  const isEdit = Boolean(id);
  console.log(`[submit-estimate] ${isEdit ? `Editing estimate ${id}` : "New submission"} for business ${business_id}`);
  const supabase = getSupabaseClient();

  try {
    // ── Step 1: Upload any new photos, tier by tier ─────────────
    // If a new photo was chosen, upload it. Otherwise, keep whatever
    // photo URL the form already had on file for that tier (used when
    // editing an estimate and the tech doesn't touch the photo).
    const photoUrls = {};
    for (const tier of ["good", "better", "best"]) {
      const tierData = body[tier] || {};
      if (tierData.photo_data_url) {
        photoUrls[tier] = await uploadPhoto(supabase, business_id, tier, tierData.photo_data_url);
      } else if (tierData.existing_photo_url) {
        photoUrls[tier] = tierData.existing_photo_url;
      }
    }

    // ── Step 2: Build the estimate row ───────────────────────────
    const row = {
      business_id,
      customer_name: customer_name || null,
      site_address: site_address || null,
      proposal_date: proposal_date || null,
      current_system: current_system || null,
      diagnosis: diagnosis || null,
      technician: technician || null,
      scope_of_work: scope_of_work || null,
      financing_options: financing_options || null,
      expires_date: expires_date || null,

      good_brand: body.good?.brand || null,
      good_seer: body.good?.seer || null,
      good_price: body.good?.price || null,
      good_warranty: body.good?.warranty || null,
      good_features: body.good?.features || null,
      good_photo_url: photoUrls.good || null,

      better_brand: body.better?.brand || null,
      better_seer: body.better?.seer || null,
      better_price: body.better?.price || null,
      better_warranty: body.better?.warranty || null,
      better_features: body.better?.features || null,
      better_photo_url: photoUrls.better || null,

      best_brand: body.best?.brand || null,
      best_seer: body.best?.seer || null,
      best_price: body.best?.price || null,
      best_warranty: body.best?.warranty || null,
      best_features: body.best?.features || null,
      best_photo_url: photoUrls.best || null,
    };

    // ── Step 3: Insert (new estimate) or update (editing one) ────
    let estimateId;
    if (isEdit) {
      const { data, error } = await supabase
        .from("estimates")
        .update(row)
        .eq("id", id)
        .select("id")
        .single();

      if (error) {
        throw new Error(`Failed to update estimate: ${error.message}`);
      }
      estimateId = data.id;
      console.log(`[submit-estimate] Updated estimate ${estimateId}`);
    } else {
      const { data, error } = await supabase
        .from("estimates")
        .insert(row)
        .select("id")
        .single();

      if (error) {
        throw new Error(`Failed to save estimate: ${error.message}`);
      }
      estimateId = data.id;
      console.log(`[submit-estimate] Saved estimate ${estimateId}`);
    }

    const baseUrl = process.env.SITE_URL || "https://your-site.netlify.app";
    const estimateUrl = `${baseUrl}/estimate/${estimateId}`;
    const editUrl = `${baseUrl}/estimate-form.html?id=${estimateId}`;

    // ── Step 4: Notify the business owner ─────────────────────────
    // Awaited on purpose — Netlify can freeze this function's execution
    // the instant a response is returned, which would silently kill a
    // true fire-and-forget call before the Resend request completed.
    // A failure here is caught and logged, but never fails the save
    // itself — the estimate is already safely stored either way.
    try {
      await notifyBusinessOwner(supabase, business_id, estimateUrl, editUrl, customer_name, isEdit);
    } catch (err) {
      console.error("[submit-estimate] Owner notification failed:", err.message);
    }

    return respond(200, {
      success: true,
      estimate_id: estimateId,
      estimate_url: estimateUrl,
      edited: isEdit,
    });

  } catch (err) {
    console.error("[submit-estimate] Error:", err.message);
    return respond(500, {
      success: false,
      error: err.message,
      message: "Could not save this estimate. Please try again.",
    });
  }
};

/**
 * Emails the business's on-file notification_email (if any) a copy of
 * every estimate save, with both the customer view link and the
 * private edit link. Silently does nothing if no notification_email
 * is configured or RESEND_API_KEY is missing — this is a convenience
 * feature, not required for the core save to succeed.
 */
async function notifyBusinessOwner(supabase, business_id, estimateUrl, editUrl, customerName, isEdit) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.warn("[submit-estimate] RESEND_API_KEY not configured — skipping owner notification.");
    return;
  }

  const { data: business, error } = await supabase
    .from("estimate_businesses")
    .select("business_name, notification_email")
    .eq("id", business_id)
    .single();

  if (error) {
    console.warn(`[submit-estimate] Could not look up business ${business_id} for owner notification:`, error.message);
    return;
  }
  if (!business || !business.notification_email) {
    console.warn(`[submit-estimate] No notification_email on file for business ${business_id} — skipping owner notification.`);
    return;
  }

  console.log(`[submit-estimate] Sending owner notification to ${business.notification_email}...`);

  const fromEmail = process.env.ESTIMATE_FROM_EMAIL || process.env.REPORT_FROM_EMAIL || "pia@buy-mos.com";
  const subject = `${isEdit ? "Updated" : "New"} Estimate${customerName ? " — " + customerName : ""}`;
  const html = `
    <p>${isEdit ? "An estimate was updated" : "A new estimate was created"}${customerName ? ` for ${escapeHtml(customerName)}` : ""}.</p>
    <p><strong>View it (what the customer sees):</strong><br><a href="${estimateUrl}">${estimateUrl}</a></p>
    <p><strong>Edit this estimate:</strong><br><a href="${editUrl}">${editUrl}</a></p>
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

  console.log(`[submit-estimate] Owner notification sent successfully to ${business.notification_email}`);
}

/**
 * Decodes a base64 data URL (from the browser's FileReader) and
 * uploads it to the estimate-photos bucket. Returns the public URL.
 */
async function uploadPhoto(supabase, business_id, tier, dataUrl) {
  const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) {
    throw new Error(`Invalid photo data for ${tier} option — expected a base64 image data URL.`);
  }
  const mimeType = match[1];
  const base64Data = match[2];
  const buffer = Buffer.from(base64Data, "base64");
  const ext = mimeType.split("/")[1] || "jpg";
  const path = `${business_id}/${Date.now()}-${tier}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from("estimate-photos")
    .upload(path, buffer, { contentType: mimeType, upsert: false });

  if (uploadError) {
    throw new Error(`Photo upload failed for ${tier} option: ${uploadError.message}`);
  }

  const { data: urlData } = supabase.storage.from("estimate-photos").getPublicUrl(path);
  return urlData.publicUrl;
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
