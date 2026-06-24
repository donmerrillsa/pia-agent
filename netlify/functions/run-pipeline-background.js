// netlify/functions/run-pipeline-background.js
//
// Background-function wrapper around run-pipeline.js.
//
// Used exclusively by on-demand-trigger.js so the customer-facing
// confirmation page can respond in well under a second instead of
// waiting ~30s for the full pipeline (deal-sync → activity-sync →
// stall-detect → generate-report → send-report) to finish.
//
// The "-background" suffix is a Netlify naming convention: when invoked,
// Netlify immediately returns a 202 to whoever called this function,
// then keeps this code running independently for up to 15 minutes.
// Nothing reads this function's return value, since the caller has
// already moved on by the time it would arrive — all the real work
// happens as a side effect (Supabase writes, the email send).
//
// scheduled-pipeline.js (the Monday cron run) intentionally still calls
// the synchronous run-pipeline.js directly — there's no browser waiting
// on a cron job, so there was never a reason to change that path.

const runPipeline = require("./run-pipeline");

exports.handler = async (event, context) => {
  try {
    await runPipeline.handler(event, context);
  } catch (err) {
    // run-pipeline.js already logs its own errors and sends an admin
    // alert internally on failure. This catch just prevents an
    // unhandled rejection in the background invocation — there's no
    // caller left to report a failure to.
    console.error("[run-pipeline-background] Unhandled error:", err);
  }
};
