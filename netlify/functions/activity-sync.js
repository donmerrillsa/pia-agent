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

/**
 * D-06: Calculate business days between two timestamps.
 * Excludes Saturdays (day 6) and Sundays (day 0).
 * Does not exclude holidays (v1.0 scope â€” holiday exclusion deferred to v1.1).
 *
 * @param {number} fromTs - Start timestamp in ms (last activity)
 * @param {number} toTs   - End timestamp in ms (now)
 * @returns {number} Number of business days elapsed
 */
function calcBusinessDays(fromTs, toTs) {
  if (fromTs >= toTs) return 0;

  let count = 0;
  const start = new Date(fromTs);
  const end = new Date(toTs);

  // Normalize to midnight to count whole days only
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);

  const current = new Date(start);
  current.setDate(current.getDate() + 1); // Start counting from the day after last activity

  while (current <= end) {
    const day = current.getDay();
    if (day !== 0 && day !== 6) { // 0 = Sunday, 6 = Saturday
      count++;
    }
    current.setDate(current.getDate() + 1);
  }

  return count;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed. Use POST." });
  }

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

  console.log(`[activity-sync] Starting activity sync for client ${client_id}`);
  const startTime = Date.now();
  const supabase = getSupabaseClient();

  try {
    // Step 0: Look up this client's own HubSpot token — same as deal-sync,
    // never a shared/global token.
    const { data: clientRow, error: clientError } = await supabase
      .from("clients")
      .select("hubspot_access_token")
      .eq("id", client_id)
      .single();

    if (clientError || !clientRow?.hubspot_access_token) {
      throw new Error(
        `No HubSpot token found for client ${client_id}. Cannot sync activity without it.`
      );
    }
    const hubspotToken = clientRow.hubspot_access_token;

    // Step 1: Load all deals for this client from deals_cache
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

    // Step 2: Fetch last activity for each deal
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
              hubspotToken,
              deal.hubspot_deal_id
            );

            const now = Date.now();
            const lastActivityDate = lastActivityTs
              ? new Date(lastActivityTs).toISOString()
              : null;

            // D-06: Use business days only â€” exclude weekends
            const daysSinceActivity = lastActivityTs
              ? calcBusinessDays(lastActivityTs, now)
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

      // No sleep needed at current deal volumes (<50 deals)
    }

    const duration = Date.now() - startTime;
    console.log(
      `[activity-sync] Complete. Updated: ${updated}, Failed: ${failed}, Duration: ${duration}ms`
    );

    await logAction({
      client_id,
      run_id,
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
        run_id,
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
