// netlify/functions/submit-estimate.js
// Receives a completed estimate from the web form, uploads any photos
// to Supabase Storage, saves the estimate to the estimates table, and
// returns a unique link the tech can send to the customer.
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

  const { id, business_id, customer_name, site_address, proposal_date, current_system, diagnosis, technician } = body;

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

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body, null, 2),
  };
}