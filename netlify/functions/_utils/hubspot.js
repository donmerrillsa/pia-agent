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

function getHeaders() {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "Missing HUBSPOT_ACCESS_TOKEN. Set it in Netlify environment variables."
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
        "HubSpot authentication failed (401 Unauthorized). " +
        "Check that HUBSPOT_ACCESS_TOKEN is valid and has not expired. " +
        "Admin alert: rotate or reissue the token in HubSpot Private Apps."
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
 * Fetch a single page of deals from HubSpot.
 */
async function fetchDealsPage(after = null) {
  const params = new URLSearchParams({
    limit: "100",
    properties: DEFAULT_DEAL_PROPERTIES,
    archived: "false",
  });
  if (after) params.set("after", after);

  const url = `${HUBSPOT_BASE}/crm/v3/objects/deals?${params.toString()}`;
  const response = await fetchWithRetry(url, { headers: getHeaders() });
  return response.json();
}

/**
 * Fetch ALL active deals, handling pagination automatically.
 */
async function fetchAllDeals() {
  const allDeals = [];
  let after = null;

  do {
    const page = await fetchDealsPage(after);
    allDeals.push(...page.results);
    after = page.paging?.next?.after ?? null;
  } while (after);

  return allDeals;
}

/**
 * Fetch engagement (activity) data for a single deal using the v1 engagements API.
 * Returns the most recent engagement timestamp (ms), or null if none found.
 */
async function fetchLastActivityForDeal(dealId) {
  const url =
    `${HUBSPOT_BASE}/engagements/v1/engagements/associated/deal/${dealId}/paged?limit=10`;

  try {
    const response = await fetchWithRetry(url, { headers: getHeaders() });
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
 * Fetch a HubSpot owner by ID.
 * Returns { id, email, firstName, lastName, fullName } or null if not found.
 */
async function fetchOwnerById(ownerId) {
  if (!ownerId) return null;
  try {
    const response = await fetchWithRetry(
      `${HUBSPOT_BASE}/crm/v3/owners/${ownerId}`,
      { headers: getHeaders() }
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
 * Verify the PAT is valid by hitting the owners endpoint (lightweight call).
 * Returns { valid: true, ownerCount } or { valid: false, error }.
 */
async function verifyAccessToken() {
  try {
    const response = await fetchWithRetry(
      `${HUBSPOT_BASE}/crm/v3/owners?limit=1`,
      { headers: getHeaders() }
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
