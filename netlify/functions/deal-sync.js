// netlify/functions/deal-sync.js
// Pulls all active deals from HubSpot and writes them to deals_cache in Supabase.
// Called manually during setup, and will be triggered on a schedule in Phase 2.
//
// POST /.netlify/functions/deal-sync
// Body: { "client_id": "<uuid>" }

const { fetchAllDeals, fetchLastActivityForDeal } = require("./_utils/hubspot");
const { getSupabaseClient } = require("./_utils/supabase");
const { logAction, logError } = require("./_utils/logger");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed. Use POST." });
  }

  // Parse client_id from request body
  let client_id;
  try {
    const body = JSON.parse(event.body || "{}");
    client_id = body.client_id;
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

  try {
    // ── Step 1: Fetch all deals from HubSpot ──────────────────
    console.log("[deal-sync] Fetching deals from HubSpot...");
    const deals = await fetchAllDeals();
    console.log(`[deal-sync] Fetched ${deals.length} deals from HubSpot`);

    if (deals.length === 0) {
      await logAction({
        client_id,
        action_type: "deal_sync",
        notes: "Sync completed — no active deals found in HubSpot",
        success: true,
      });
      return respond(200, {
        success: true,
        deals_synced: 0,
        message: "No active deals found in HubSpot.",
        duration_ms: Date.now() - startTime,
      });
    }

    // ── Step 2: Transform deals into deals_cache rows ─────────
    const now = new Date().toISOString();
    const rows = await Promise.all(deals.map(async (deal) => {
      const props = deal.properties || {};

      const lastModified = props.hs_lastmodifieddate
        ? new Date(props.hs_lastmodifieddate)
        : null;

      const closeDate = props.closedate
        ? new Date(props.closedate)
        : null;

      // Fetch latest engagement timestamp for accurate stall detection
      let lastActivityMs = null;
      try {
        lastActivityMs = await fetchLastActivityForDeal(deal.id);
      } catch (err) {
        console.warn(`[deal-sync] Could not fetch activity for deal ${deal.id}: ${err.message}`);
      }

      // Use engagement timestamp if available, fall back to hs_lastmodifieddate
      const activityDate = lastActivityMs
        ? new Date(lastActivityMs)
        : lastModified;

      const daysSinceActivity = activityDate
        ? Math.floor((Date.now() - activityDate.getTime()) / (1000 * 60 * 60 * 24))
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
        stage_probability: props.hs_deal_stage_probability
          ? parseFloat(props.hs_deal_stage_probability)
          : null,
        last_modified_date: lastModified ? lastModified.toISOString() : null,
        days_since_activity: daysSinceActivity,
        raw_properties: props,
        synced_at: now,
      };
    }));

    // ── Step 3: Upsert into deals_cache ───────────────────────
    // UPSERT: update existing rows, insert new ones.
    // The UNIQUE constraint on (client_id, hubspot_deal_id) handles deduplication.
    console.log(`[deal-sync] Upserting ${rows.length} deals into Supabase...`);
    const supabase = getSupabaseClient();

    const { error: upsertError } = await supabase
      .from("deals_cache")
      .upsert(rows, {
        onConflict: "client_id,hubspot_deal_id",
        ignoreDuplicates: false,
      });

    if (upsertError) {
      throw new Error(`Supabase upsert failed: ${upsertError.message}`);
    }

    // ── Step 4: Remove deals no longer in HubSpot ─────────────
    // Any deal in deals_cache that wasn't in this sync is closed/deleted.
    const activeIds = deals.map((d) => d.id);
    const { error: deleteError } = await supabase
      .from("deals_cache")
      .delete()
      .eq("client_id", client_id)
      .not("hubspot_deal_id", "in", `(${activeIds.join(",")})`);

    if (deleteError) {
      // Non-fatal — log but don't fail the sync
      console.warn("[deal-sync] Cleanup delete failed:", deleteError.message);
    }

    const duration = Date.now() - startTime;
    console.log(`[deal-sync] Sync complete. ${rows.length} deals in ${duration}ms`);

    // ── Step 5: Log the action ────────────────────────────────
    await logAction({
      client_id,
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
