// _utils/hubspot.js
// Shared HubSpot API helper.
// All HubSpot calls go through here so rate-limit handling,
// auth headers, and base URL are defined in one place.

const HUBSPOT_BASE = "https://api.hubapi.com";

// Default deal properties we pull on every sync.
// Add to this list as we need more fields — keep it lean.
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
 * Fetch a single page of deals from HubSpot.
 * Returns { results, paging } where paging.next.after is the cursor for the next page.
 */
async function fetchDealsPage(after = null) {
  const params = new URLSearchParams({
    limit: "100",
    properties: DEFAULT_DEAL_PROPERTIES,
    archived: "false",
  });
  if (after) params.set("after", after);

  const url = `${HUBSPOT_BASE}/crm/v3/objects/deals?${params.toString()}`;
  const response = await fetch(url, { headers: getHeaders() });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HubSpot deals fetch failed [${response.status}]: ${body}`);
  }

  return response.json();
}

/**
 * Fetch ALL active deals, handling pagination automatically.
 * HubSpot caps each page at 100 records; this loops until exhausted.
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
 *
 * Uses v1 API because notes posted via v1 are not visible via v3 associations endpoint.
 */
async function fetchLastActivityForDeal(dealId) {
  const url =
    `${HUBSPOT_BASE}/engagements/v1/engagements/associated/deal/${dealId}/paged?limit=10`;

  const response = await fetch(url, { headers: getHeaders() });

  if (response.status === 404) return null; // Deal has no engagements
  if (!response.ok) return null;

  const data = await response.json();
  if (!data.results?.length) return null;

  // Each result has engagement.timestamp — extract and return the most recent
  const timestamps = data.results
    .map((r) => r.engagement?.timestamp)
    .filter(Boolean);

  return timestamps.length ? Math.max(...timestamps) : null;
}

/**
 * Fetch a HubSpot owner by ID.
 * Returns { id, email, firstName, lastName, fullName } or null if not found.
 */
async function fetchOwnerById(ownerId) {
  if (!ownerId) return null;
  try {
    const response = await fetch(
      `${HUBSPOT_BASE}/crm/v3/owners/${ownerId}`,
      { headers: getHeaders() }
    );
    if (!response.ok) return null;
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
 * Returns { valid: true, owner } or { valid: false, error }.
 */
async function verifyAccessToken() {
  try {
    const response = await fetch(`${HUBSPOT_BASE}/crm/v3/owners?limit=1`, {
      headers: getHeaders(),
    });

    if (response.status === 401) {
      return { valid: false, error: "Token rejected — 401 Unauthorized" };
    }
    if (!response.ok) {
      return { valid: false, error: `Unexpected status ${response.status}` };
    }

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
