// _utils/hubspot.js
// Shared HubSpot API helper.
// All HubSpot calls go through here so rate-limit handling,
// auth headers, and base URL are defined in one place.

const HUBSPOT_BASE = "https://api.hubapi.com";

// Default deal properties we pull on every sync.
const DEFAULT_DEAL_PROPERTIES = [
  "dealname",
  "amount",
  "dealstage",
  "pipeline",
  "closedate",
  "createdate",
  "hs_lastmodifieddate",
  "hubspot_owner_id",
  "hs_deal_stage_probability",
  "notes_last_contacted",
  "notes_last_updated",
  "num_contacted_notes",
  "hs_next_step",
].join(",");

function getHeaders(token) {
  if (!token) {
    throw new Error(
      "Missing HubSpot access token. Each call must pass the requesting client's own token — " +
      "there is no longer a shared fallback token."
    );
  }
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

/**
 * Fetch wrapper with retry logic for rate limits (D-01) and auth failure handling (D-02).
 * - 429: exponential backoff, retries up to 3 times
 * - 401: throws immediately with clear auth error message
 * - Other errors: throws with status and body
 */
async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  let attempt = 0;

  while (attempt <= maxRetries) {
    const response = await fetch(url, options);

    // D-02: Auth failure — throw immediately, do not retry
    if (response.status === 401) {
      throw new Error(
        "HubSpot authentication failed (401 Unauthorized) for this client. " +
        "The client's stored hubspot_access_token in the Supabase clients table " +
        "may be invalid, expired, or missing. Check that row and reissue the token if needed."
      );
    }

    // D-01: Rate limit — exponential backoff and retry
    if (response.status === 429) {
      if (attempt === maxRetries) {
        throw new Error(
          `HubSpot rate limit (429) exceeded after ${maxRetries} retries. ` +
          "Consider reducing sync frequency or batching requests."
        );
      }
      const waitMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
      console.warn(`[hubspot] Rate limited (429). Retrying in ${waitMs}ms... (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      attempt++;
      continue;
    }

    // All other non-OK responses
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HubSpot API error [${response.status}]: ${body}`);
    }

    return response;
  }
}

/**
 * Fetch a single page of deals from HubSpot, using the given client's token.
 */
async function fetchDealsPage(token, after = null) {
  const params = new URLSearchParams({
    limit: "100",
    properties: DEFAULT_DEAL_PROPERTIES,
    archived: "false",
  });
  if (after) params.set("after", after);

  const url = `${HUBSPOT_BASE}/crm/v3/objects/deals?${params.toString()}`;
  const response = await fetchWithRetry(url, { headers: getHeaders(token) });
  return response.json();
}

/**
 * Fetch ALL active deals for the given client, handling pagination automatically.
 * @param {string} token - The client's own HubSpot access token.
 */
async function fetchAllDeals(token) {
  const allDeals = [];
  let after = null;

  do {
    const page = await fetchDealsPage(token, after);
    allDeals.push(...page.results);
    after = page.paging?.next?.after ?? null;
  } while (after);

  return allDeals;
}

/**
 * Fetch engagement (activity) data for a single deal using the v1 engagements API.
 * Returns the most recent engagement timestamp (ms), or null if none found.
 * @param {string} token - The client's own HubSpot access token.
 * @param {string} dealId
 */
async function fetchLastActivityForDeal(token, dealId) {
  const url =
    `${HUBSPOT_BASE}/engagements/v1/engagements/associated/deal/${dealId}/paged?limit=10`;

  try {
    const response = await fetchWithRetry(url, { headers: getHeaders(token) });
    const data = await response.json();
    if (!data.results?.length) return null;

    const timestamps = data.results
      .map((r) => r.engagement?.timestamp)
      .filter(Boolean);

    return timestamps.length ? Math.max(...timestamps) : null;
  } catch (err) {
    // 404 means no engagements — not an error
    if (err.message.includes("404")) return null;
    console.warn(`[hubspot] fetchLastActivityForDeal failed for deal ${dealId}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch a HubSpot owner by ID, using the given client's token.
 * Returns { id, email, firstName, lastName, fullName } or null if not found.
 * @param {string} token - The client's own HubSpot access token.
 * @param {string} ownerId
 */
async function fetchOwnerById(token, ownerId) {
  if (!ownerId) return null;
  try {
    const response = await fetchWithRetry(
      `${HUBSPOT_BASE}/crm/v3/owners/${ownerId}`,
      { headers: getHeaders(token) }
    );
    const data = await response.json();
    return {
      id: data.id,
      email: data.email || null,
      firstName: data.firstName || null,
      lastName: data.lastName || null,
      fullName: `${data.firstName || ""} ${data.lastName || ""}`.trim() || null,
    };
  } catch {
    return null;
  }
}

/**
 * Verify a PAT is valid by hitting the owners endpoint (lightweight call).
 * Defaults to the global HUBSPOT_ACCESS_TOKEN env var when no token is
 * passed — used by hubspot-auth-verify.js as a general system health check,
 * separate from the per-client validation onboard-client.js does inline.
 * @param {string} [token]
 * Returns { valid: true, ownerCount } or { valid: false, error }.
 */
async function verifyAccessToken(token = process.env.HUBSPOT_ACCESS_TOKEN) {
  try {
    const response = await fetchWithRetry(
      `${HUBSPOT_BASE}/crm/v3/owners?limit=1`,
      { headers: getHeaders(token) }
    );
    const data = await response.json();
    return { valid: true, ownerCount: data.results?.length ?? 0 };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

module.exports = {
  fetchAllDeals,
  fetchLastActivityForDeal,
  fetchOwnerById,
  verifyAccessToken,
  DEFAULT_DEAL_PROPERTIES,
};
