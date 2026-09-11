// GET /.netlify/functions/list-estimates?business_id=<business_id>

const { getSupabaseClient } = require("./_utils/supabase");

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return respond(405, { error: "Method not allowed. Use GET." });
  }

  const businessId = event.queryStringParameters && event.queryStringParameters.business_id;
  if (!businessId) {
    return respond(400, { error: "Missing business_id." });
  }

  const supabase = getSupabaseClient();

  try {
    const { data: estimates, error } = await supabase
      .from("estimates")
      .select("id, customer_name, site_address, proposal_date, expires_date, created_at, approved_tier, approved_at, good_price, better_price, best_price")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false });

    if (error) {
      throw error;
    }

    return respond(200, { success: true, estimates: estimates || [] });

  } catch (err) {
    console.error("[list-estimates] Error:", err.message);
    return respond(500, { error: "Could not load estimates." });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body, null, 2),
  };
}
