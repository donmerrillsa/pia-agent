// netlify/functions/stall-detect.js
// Scores every deal in deals_cache for stall risk.
// Flags stalled deals by writing to stall_events.
// A deal is stalled when days_since_activity exceeds the threshold for its stage.
//
// POST /.netlify/functions/stall-detect
// Body: { "client_id": "<uuid>" }

const { getSupabaseClient } = require("./_utils/supabase");
const { logAction, logError } = require("./_utils/logger");

// ── Stall thresholds by deal stage ───────────────────────────
// Days of inactivity before a deal is flagged as stalled.
// These are defaults — will be configurable per client in Phase 3.
const STALL_THRESHOLDS = {
  // Early stages — shorter tolerance
  "appointmentscheduled":     7,
  "qualifiedtobuy":          10,
  "presentationscheduled":   10,
  "decisionmakerboughtin":   14,
  // Late stages — more time allowed for procurement/legal
  "contractsent":            14,
  "closedwon":               null, // never stalls
  "closedlost":              null, // never stalls
  // Default for any unrecognized stage
  "default":                 14,
};

function getStallThreshold(dealStage) {
  if (!dealStage) return STALL_THRESHOLDS.default;
  const key = dealStage.toLowerCase().replace(/\s+/g, "");
  return STALL_THRESHOLDS[key] ?? STALL_THRESHOLDS.default;
}

function getStallReason(deal, threshold) {
  const days = deal.days_since_activity;
  if (days === null) return `No activity recorded. Deal may be orphaned.`;
  return `No activity for ${days} days (threshold: ${threshold} days for stage "${deal.deal_stage}").`;
}

function getRecommendedAction(deal) {
  const days = deal.days_since_activity ?? 0;
  const stage = (deal.deal_stage || "").toLowerCase();

  if (stage.includes("contract")) {
    return "Follow up on contract status. Ask if legal review is complete or if there are blocking concerns.";
  }
  if (stage.includes("decision")) {
    return "Re-engage decision maker. Send value reminder or case study. Request a 15-minute check-in.";
  }
  if (stage.includes("presentation")) {
    return "Follow up on presentation feedback. Ask what questions remain before moving forward.";
  }
  if (days > 30) {
    return "Deal critically stalled. Consider marking lost or scheduling a direct conversation to assess viability.";
  }
  return "Re-engage contact with a value-add touchpoint. Ask an open question about their current priority.";
}

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
    return respond(400, { error: "Missing client_id." });
  }

  console.log(`[stall-detect] Starting stall detection for client ${client_id}`);
  const startTime = Date.now();
  const supabase = getSupabaseClient();

  try {
    // ── Step 1: Load all active deals from deals_cache ────────
    const { data: deals, error: fetchError } = await supabase
      .from("deals_cache")
      .select("*")
      .eq("client_id", client_id);

    if (fetchError) throw new Error(`Failed to load deals: ${fetchError.message}`);

    if (!deals || deals.length === 0) {
      return respond(200, {
        success: true,
        stalls_flagged: 0,
        message: "No deals in cache. Run deal-sync first.",
        duration_ms: Date.now() - startTime,
      });
    }

    console.log(`[stall-detect] Evaluating ${deals.length} deals...`);

    // ── Step 2: Score each deal ───────────────────────────────
    const stalledDeals = [];

    for (const deal of deals) {
      const threshold = getStallThreshold(deal.deal_stage);

      // Skip stages that never stall
      if (threshold === null) continue;

      const daysStalled = deal.days_since_activity;

      // Flag if over threshold
      if (daysStalled !== null && daysStalled >= threshold) {
        stalledDeals.push({
          deal,
          threshold,
          daysStalled,
        });
      }
    }

    console.log(`[stall-detect] ${stalledDeals.length} stalled deals found`);

    if (stalledDeals.length === 0) {
      await logAction({
        client_id,
        action_type: "stall_detect",
        notes: `Evaluated ${deals.length} deals — no stalls detected`,
        success: true,
      });

      return respond(200, {
        success: true,
        deals_evaluated: deals.length,
        stalls_flagged: 0,
        message: "No stalled deals detected.",
        duration_ms: Date.now() - startTime,
      });
    }

    // ── Step 3: Write stall_events ────────────────────────────
    // Check for existing unresolved stall events to avoid duplicates
    const stalledDealIds = stalledDeals.map((s) => s.deal.hubspot_deal_id);

    const { data: existingStalls } = await supabase
      .from("stall_events")
      .select("hubspot_deal_id")
      .eq("client_id", client_id)
      .eq("resolved", false)
      .in("hubspot_deal_id", stalledDealIds);

    const alreadyFlagged = new Set(
      (existingStalls || []).map((s) => s.hubspot_deal_id)
    );

    // Only insert NEW stall events
    const newStalls = stalledDeals.filter(
      (s) => !alreadyFlagged.has(s.deal.hubspot_deal_id)
    );

    if (newStalls.length > 0) {
      const stallRows = newStalls.map(({ deal, threshold, daysStalled }) => ({
        client_id,
        hubspot_deal_id: deal.hubspot_deal_id,
        deal_name: deal.deal_name,
        deal_stage: deal.deal_stage,
        amount: deal.amount,
        days_stalled: daysStalled,
        stall_reason: getStallReason(deal, threshold),
        recommended_action: getRecommendedAction(deal),
        resolved: false,
      }));

      const { error: insertError } = await supabase
        .from("stall_events")
        .insert(stallRows);

      if (insertError) {
        throw new Error(`Failed to insert stall events: ${insertError.message}`);
      }
    }

    const duration = Date.now() - startTime;

    await logAction({
      client_id,
      action_type: "stall_detect",
      notes: `Evaluated ${deals.length} deals — ${stalledDeals.length} stalled, ${newStalls.length} newly flagged`,
      success: true,
    });

    // ── Step 4: Return summary ────────────────────────────────
    return respond(200, {
      success: true,
      deals_evaluated: deals.length,
      stalls_flagged: stalledDeals.length,
      new_stall_events: newStalls.length,
      existing_stalls: alreadyFlagged.size,
      stalled_deals: stalledDeals.map(({ deal, daysStalled, threshold }) => ({
        deal_name: deal.deal_name,
        deal_stage: deal.deal_stage,
        amount: deal.amount,
        days_stalled: daysStalled,
        threshold,
        recommended_action: getRecommendedAction(deal),
      })),
      duration_ms: duration,
    });

  } catch (err) {
    console.error("[stall-detect] Error:", err.message);
    await logError(
      { client_id, action_type: "stall_detect", notes: "Stall detection failed" },
      err
    ).catch(() => {});

    return respond(500, {
      success: false,
      error: err.message,
      message: "Stall detection failed. Check logs for details.",
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
