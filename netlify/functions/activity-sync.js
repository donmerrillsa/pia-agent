// netlify/functions/activity-sync.js
// For every deal in deals_cache, fetches the last activity date from HubSpot
// and updates last_activity_date and days_since_activity in Supabase.
// Runs after deal-sync on every cycle.
//
// POST /.netlify/functions/activity-sync
// Body: { "client_id": "<uuid>" }

const { fetchLastActivityForDeal } = require("./_utils/hubspot");
const { getSupabaseClient } = require("./_utils/supabase");
const { logAction, logError } = require("./_utils/logger");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed. Use POST." });
  }

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

  console.log(`[activity-sync] Starting activity sync for client ${client_id}`);
  const startTime = Date.now();
  const supabase = getSupabaseClient();

  try {
    // ── Step 1: Load all deals for this client from deals_cache ──
    const { data: deals, error: fetchError } = await supabase
      .from("deals_cache")
      .select("id, hubspot_deal_id, deal_name")
      .eq("client_id", client_id);

    if (fetchError) {
      throw new Error(`Failed to load deals from Supabase: ${fetchError.message}`);
    }

    if (!deals || deals.length === 0) {
      return respond(200, {
        success: true,
        deals_updated: 0,
        message: "No deals in cache. Run deal-sync first.",
        duration_ms: Date.now() - startTime,
      });
    }

    console.log(`[activity-sync] Processing ${deals.length} deals...`);

    // ── Step 2: Fetch last activity for each deal ─────────────
    // Process in batches of 10 to avoid HubSpot rate limits
    const BATCH_SIZE = 10;
    let updated = 0;
    let failed = 0;

    for (let i = 0; i < deals.length; i += BATCH_SIZE) {
      const batch = deals.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (deal) => {
          try {
            const lastActivityTs = await fetchLastActivityForDeal(
              deal.hubspot_deal_id
            );

            const now = Date.now();
            const lastActivityDate = lastActivityTs
              ? new Date(lastActivityTs).toISOString()
              : null;

            const daysSinceActivity = lastActivityTs
              ? Math.floor((now - lastActivityTs) / (1000 * 60 * 60 * 24))
              : null;

            // Update this deal's activity fields in deals_cache
            const { error: updateError } = await supabase
              .from("deals_cache")
              .update({
                last_activity_date: lastActivityDate,
                days_since_activity: daysSinceActivity,
              })
              .eq("id", deal.id);

            if (updateError) {
              console.warn(
                `[activity-sync] Update failed for deal ${deal.hubspot_deal_id}:`,
                updateError.message
              );
              failed++;
            } else {
              updated++;
            }
          } catch (err) {
            console.warn(
              `[activity-sync] Error fetching activity for deal ${deal.hubspot_deal_id}:`,
              err.message
            );
            failed++;
          }
        })
      );

      // Small delay between batches to respect HubSpot rate limits
      if (i + BATCH_SIZE < deals.length) {
        await sleep(500);
      }
    }

    const duration = Date.now() - startTime;
    console.log(
      `[activity-sync] Complete. Updated: ${updated}, Failed: ${failed}, Duration: ${duration}ms`
    );

    await logAction({
      client_id,
      action_type: "activity_sync",
      notes: `Updated ${updated} deals, ${failed} failed in ${duration}ms`,
      success: true,
    });

    return respond(200, {
      success: true,
      deals_updated: updated,
      deals_failed: failed,
      duration_ms: duration,
      message: `Activity sync complete. Updated ${updated} of ${deals.length} deals.`,
    });

  } catch (err) {
    console.error("[activity-sync] Error:", err.message);

    await logError(
      {
        client_id,
        action_type: "activity_sync",
        notes: "Activity sync failed",
      },
      err
    ).catch(() => {});

    return respond(500, {
      success: false,
      error: err.message,
      message: "Activity sync failed. Check logs for details.",
    });
  }
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body, null, 2),
  };
}
