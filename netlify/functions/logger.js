// _utils/logger.js
// Writes every significant agent action to the action_log table in Supabase.
// This is the audit trail — every deal touched, every stall flagged,
// every report generated gets a row here.

const { getSupabaseClient } = require("./supabase");

/**
 * Log an agent action.
 *
 * @param {object} entry
 * @param {string} entry.client_id       - UUID of the client record
 * @param {string} entry.action_type     - e.g. "deal_sync", "stall_flagged", "report_generated"
 * @param {string} [entry.run_id]        - UUID shared by all log entries for a single pipeline run
 * @param {string} [entry.deal_id]       - HubSpot deal ID if action is deal-specific
 * @param {string} [entry.deal_name]     - Human-readable deal name for log readability
 * @param {string} [entry.notes]         - Any additional context
 * @param {boolean} [entry.success]      - Did the action succeed? Default true
 * @param {string} [entry.error_message] - Error details if success=false
 * @param {string} [entry.recipient]     - Email recipient if action is report delivery
 * @param {string} [entry.status]        - Delivery status e.g. "sent", "failed"
 */
async function logAction(entry) {
  const supabase = getSupabaseClient();

  const row = {
    client_id: entry.client_id,
    action_type: entry.action_type,
    run_id: entry.run_id ?? null,
    deal_id: entry.deal_id ?? null,
    deal_name: entry.deal_name ?? null,
    notes: entry.notes ?? null,
    success: entry.success ?? true,
    error_message: entry.error_message ?? null,
    recipient: entry.recipient ?? null,
    status: entry.status ?? null,
    created_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("action_log").insert(row);

  if (error) {
    // Don't throw — logging failure should never crash the main function
    console.error("[logger] Failed to write action_log:", error.message, row);
  }
}

/**
 * Convenience: log a failed action with error details.
 */
async function logError(entry, error) {
  return logAction({
    ...entry,
    success: false,
    error_message: error?.message ?? String(error),
  });
}

module.exports = { logAction, logError };
