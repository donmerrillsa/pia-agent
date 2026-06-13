// netlify/functions/stall-detect.js
// Scores every deal in deals_cache for stall risk.
// Flags stalled deals by writing to stall_events.
// A deal is stalled when days_since_activity exceeds the threshold for its stage.
//
// POST /.netlify/functions/stall-detect
// Body: { "client_id": "<uuid>" }

const { getSupabaseClient } = require("./_utils/supabase");
const { logAction, logError } = require("./_utils/logger");

// Stall thresholds by deal stage.
// Supports both HubSpot default stage keys AND numeric portal-specific IDs.
// Days of inactivity before a deal is flagged as stalled.
// null = never stalls (closed stages).
const STALL_THRESHOLDS = {
  // HubSpot default stage keys
  "appointmentscheduled":     7,
  "qualifiedtobuy":          10,
  "presentationscheduled":   10,
  "decisionmakerboughtin":   14,
  "contractsent":            14,
  "closedwon":               null,
  "closedlost":              null,

  // Portal-specific numeric stage IDs (pia-agent portal)
  "3749122780":               7,   // Connected
  "3752325847":               7,   // Conversation Started
  "3752325848":              10,   // Demo Scheduled
  "3749122783":              10,   // Demo Completed
  "3749122784":              14,   // Proposal Sent
  "3755051726":              14,   // Negotiating

  // Default for any unrecognized stage
  "default":                 14,
};

// Stages that should never be evaluated for stalls
const CLOSED_STAGES = new Set(["closedwon", "closedlost"]);

function getStallThreshold(dealStage) {
  if (!dealStage) return STALL_THRESHOLDS.default;

  const stageLower = dealStage.toLowerCase().trim();
  if (CLOSED_STAGES.has(stageLower)) return null;

  return STALL_THRESHOLDS[dealStage]
    ?? STALL_THRESHOLDS[stageLower]
    ?? STALL_THRESHOLDS.default;
}

function isClosedStage(dealStage) {
  if (!dealStage) return false;
  const lower = dealStage.toLowerCase().trim();
  return CLOSED_STAGES.has(lower) || STALL_THRESHOLDS[dealStage] === null;
}

/**
 * D-04: Severity tiering.
 * CRITICAL: days stalled > 2x the stage threshold (severely overdue)
 * STALLED:  days stalled > threshold but <= 2x threshold
 */
function getSeverity(daysStalled, threshold) {
  if (daysStalled > threshold * 2) return "CRITICAL";
  return "STALLED";
}

function getStallReason(deal, threshold) {
  const days = deal.days_since_activity;
  if (days === null) return `No activity recorded. Deal may be orphaned.`;
  return `No activity for ${days} days (threshold: ${threshold} days for stage "${deal.deal_stage}").`;
}

function getRecommendedAction(deal) {
  const days = deal.days_since_activity ?? 0;
  const stage = (deal.deal_stage || "").toLowerCase();

  if (stage.includes("contract") || stage === "3749122784") {
    return "Follow up on contract status. Ask if legal review is complete or if there are blocking concerns.";
  }
  if (stage.includes("decision") || stage === "3755051726") {
    return "Re-engage decision maker. Send value reminder or case study. Request a 15-minute check-in.";
  }
  if (stage.includes("presentation") || stage === "3752325848" || stage === "3749122783") {
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
    // Step 1: Fetch all deals for this client from deals_cache
    const { data: deals, error: fetchError } = await supabase
      .from("deals_cache")
      .select("*")
      .eq("client_id", client_id);

    if (fetchError) {
      throw new Error(`Failed to fetch deals: ${fetchError.message}`);
    }

    if (!deals || deals.length === 0) {
      return respond(200, {
        success: true,
        deals_evaluated: 0,
        stalls_flagged: 0,
        message: "No deals found for this client.",
        duration_ms: Date.now() - startTime,
      });
    }

    // Step 2: Evaluate each deal for stalls
    const stalledDeals = [];

    for (const deal of deals) {
      if (isClosedStage(deal.deal_stage)) continue;

      const threshold = getStallThreshold(deal.deal_stage);
      if (threshold === null) continue;

      const daysStalled = deal.days_since_activity;
      if (daysStalled === null || daysStalled <= threshold) continue;

      stalledDeals.push({ deal, threshold, daysStalled });
    }

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

    // Step 3: Write stall_events (skip already-flagged deals)
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
        severity: getSeverity(daysStalled, threshold),
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

    // Step 4: Return summary
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
        severity: getSeverity(daysStalled, threshold),
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
