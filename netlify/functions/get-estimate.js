// netlify/functions/get-estimate.js
// Returns a single estimate's raw data as JSON, used to pre-fill the
// edit form when a tech opens estimate-form.html?id=<id>.
//
// GET /.netlify/functions/get-estimate?id=<estimate_id>

const { getSupabaseClient } = require("./_utils/supabase");

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return respond(405, { error: "Method not allowed. Use GET." });
  }

  const id = event.queryStringParameters && event.queryStringParameters.id;
  if (!id) {
    return respond(400, { error: "Missing id." });
  }

  const supabase = getSupabaseClient();

  try {
    const { data: estimate, error } = await supabase
      .from("estimates")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !estimate) {
      return respond(404, { error: "Estimate not found." });
    }

    return respond(200, { success: true, estimate });

  } catch (err) {
    console.error("[get-estimate] Error:", err.message);
    return respond(500, { error: "Could not load this estimate." });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body, null, 2),
  };
}