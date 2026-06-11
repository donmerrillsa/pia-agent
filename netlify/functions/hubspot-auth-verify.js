// netlify/functions/hubspot-auth-verify.js
// Verifies that the HUBSPOT_ACCESS_TOKEN env variable is set and valid.
// Call this endpoint after setting up a new client to confirm
// the PAT is working before any sync runs.
//
// GET /.netlify/functions/hubspot-auth-verify

const { verifyAccessToken } = require("./_utils/hubspot");
const { logError } = require("./_utils/logger");

exports.handler = async (event) => {
  // Only allow GET requests
  if (event.httpMethod !== "GET") {
    return respond(405, { error: "Method not allowed" });
  }

  console.log("[hubspot-auth-verify] Starting token verification...");

  try {
    const result = await verifyAccessToken();

    if (!result.valid) {
      console.error("[hubspot-auth-verify] Token invalid:", result.error);

      await logError(
        {
          action_type: "hubspot_auth_verify",
          notes: "Token verification failed",
        },
        { message: result.error }
      ).catch(() => {});

      return respond(401, {
        valid: false,
        error: result.error,
        message:
          "HubSpot token verification failed. Check HUBSPOT_ACCESS_TOKEN in Netlify environment variables.",
      });
    }

    console.log("[hubspot-auth-verify] Token valid. Owners found:", result.ownerCount);

    return respond(200, {
      valid: true,
      message: "HubSpot connection verified successfully.",
      owners_found: result.ownerCount,
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    console.error("[hubspot-auth-verify] Unexpected error:", err.message);

    return respond(500, {
      valid: false,
      error: err.message,
      message: "Unexpected error during token verification.",
    });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(body, null, 2),
  };
}
