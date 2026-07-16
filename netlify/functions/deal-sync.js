// netlify/functions/deal-sync.js
// Pulls all active deals from HubSpot and writes them to deals_cache in Supabase.
// Called manually during setup, and will be triggered on a schedule in Phase 2.
//
// POST /.netlify/functions/deal-sync
// Body: { "client_id": "<uuid>" }

const { fetchAllDeals, fetchOwnerById } = require("./_utils/hubspot");
const { getSupabaseClient } = require("./_utils/supabase");
const { logAction, logError } = require("./_utils/logger");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed. Use POST." });
  }

  // Parse client_id from request body
  let client_id, run_id;
  try {
    const body = JSON.parse(event.body || "{}");
    client_id = body.client_id;
    run_id = body.run_id ?? null;
  } catch {
    return respond(400, { error: "Invalid JSON body." });
  }

  if (!client_id) {
    return respond(400, {
      error: "Missing client_id. Body must include { client_id: '<uuid>' }",
    });
  }

  console.log(`[deal-sync] Starting sync for client ${client_id}`);
  const startTime = Date.now();
  const supabase = getSupabaseClient();

  try {
    // â”€â”€ Step 1: Fetch all deals from HubSpot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    console.log("[deal-sync] Fetching deals from HubSpot...");

    // Every client connects their own HubSpot portal at onboarding —
    // we never use a shared/global token here.
    const { data: clientRow, error: clientError } = await supabase
      .from("clients")
      .select("hubspot_access_token")
      .eq("id", client_id)
      .single();

    if (clientError || !clientRow?.hubspot_access_token) {
      throw new Error(
        `No HubSpot token found for client ${client_id}. Cannot sync without it.`
      );
    }
    const hubspotToken = clientRow.hubspot_access_token;

    const deals = await fetchAllDeals(hubspotToken);
    console.log(`[deal-sync] Fetched ${deals.length} deals from HubSpot`);

    if (deals.length === 0) {
      await logAction({
        client_id,
        run_id,
        action_type: "deal_sync",
        notes: "Sync completed â€” no active deals found in HubSpot",
        success: true,
      });
      return respond(200, {
        success: true,
        deals_synced: 0,
        message: "No active deals found in HubSpot.",
        duration_ms: Date.now() - startTime,
      });
    }

    // â”€â”€ Step 2: Build owner cache to avoid redundant API calls â”€â”€â”€â”€â”€â”€â”€â”€
    // Collect unique owner IDs, then fetch them all once.
    const ownerIds = [...new Set(
      deals.map(d => d.properties?.hubspot_owner_id).filter(Boolean)
    )];
    const ownerCache = {};
    for (const ownerId of ownerIds) {
      ownerCache[ownerId] = await fetchOwnerById(hubspotToken, ownerId);
    }
    console.log(`[deal-sync] Resolved ${Object.keys(ownerCache).length} owner(s)`);

    // â”€â”€ Step 3: Transform deals into deals_cache rows â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const now = new Date().toISOString();
    const rows = await Promise.all(deals.map(async (deal) => {
      const props = deal.properties || {};

      const lastModified = props.hs_lastmodifieddate
        ? new Date(props.hs_lastmodifieddate)
        : null;

      const closeDate = props.closedate
        ? new Date(props.closedate)
        : null;

      // Fetch latest engagement timestamp for accurate stall detection — activity-sync handles this separately
      // daysSinceActivity is populated by activity-sync, not here
      const daysSinceActivity = null;

      // Resolve owner name and email from cache
      const owner = props.hubspot_owner_id
        ? ownerCache[props.hubspot_owner_id] || null
        : null;

      return {
        client_id,
        hubspot_deal_id: deal.id,
        deal_name: props.dealname || null,
        amount: props.amount ? parseFloat(props.amount) : null,
        deal_stage: props.dealstage || null,
        pipeline: props.pipeline || null,
        close_date: closeDate ? closeDate.toISOString().split("T")[0] : null,
        owner_id: props.hubspot_owner_id || null,
        owner_name: owner?.fullName || null,
        owner_email: owner?.email || null,
        stage_probability: props.hs_deal_stage_probability
          ? parseFloat(props.hs_deal_stage_probability)
          : null,
        last_modified_date: lastModified ? lastModified.toISOString() : null,
        days_since_activity: daysSinceActivity,
        raw_properties: props,
        synced_at: now,
      };
    }));

    // â”€â”€ Step 4: Upsert into deals_cache â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // UPSERT: update existing rows, insert new ones.
    // The UNIQUE constraint on (client_id, hubspot_deal_id) handles deduplication.
    console.log(`[deal-sync] Upserting ${rows.length} deals into Supabase...`);

    const { error: upsertError } = await supabase
      .from("deals_cache")
      .upsert(rows, {
        onConflict: "client_id,hubspot_deal_id",
        ignoreDuplicates: false,
      });

    if (upsertError) {
      throw new Error(`Supabase upsert failed: ${upsertError.message}`);
    }

    // â”€â”€ Step 5: Remove deals no longer in HubSpot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Any deal in deals_cache that wasn't in this sync is closed/deleted.
    const activeIds = deals.map((d) => d.id);
    const { error: deleteError } = await supabase
      .from("deals_cache")
      .delete()
      .eq("client_id", client_id)
      .not("hubspot_deal_id", "in", `(${activeIds.join(",")})`);

    if (deleteError) {
      // Non-fatal â€” log but don't fail the sync
      console.warn("[deal-sync] Cleanup delete failed:", deleteError.message);
    }

    const duration = Date.now() - startTime;
    console.log(`[deal-sync] Sync complete. ${rows.length} deals in ${duration}ms`);

    // â”€â”€ Step 6: Log the action â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    await logAction({
      client_id,
      run_id,
      action_type: "deal_sync",
      notes: `Synced ${rows.length} deals in ${duration}ms`,
      success: true,
    });

    return respond(200, {
      success: true,
      deals_synced: rows.length,
      duration_ms: duration,
      message: `Successfully synced ${rows.length} deals from HubSpot.`,
    });

  } catch (err) {
    console.error("[deal-sync] Error:", err.message);

    await logError(
      {
        client_id,
        run_id,
        action_type: "deal_sync",
        notes: "Deal sync failed",
      },
      err
    ).catch(() => {});

    return respond(500, {
      success: false,
      error: err.message,
      message: "Deal sync failed. Check logs for details.",
    });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body, null, 2),
  };
}
