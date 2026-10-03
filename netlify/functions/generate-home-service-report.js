// netlify/functions/generate-home-service-report.js
//
// Home Service version of generate-audit-report.js. Same contract and the same
// safety design: stateless, receives one business's audit answers, returns the
// filled report, the Start Here page, and the tracking sheet as base64. Does NOT touch Google Drive and does
// NOT send any email — that all lives in the Apps Script side.
//
// Separate from the fitness function on purpose, so changes here can never
// break the fitness audit.

const path = require("path");
const fs = require("fs");
const { computeScores, BUCKETS } = require("./lib/hs-scoring");
const { fillReport } = require("./lib/hs-docx-fill");
const { buildStartHere, startMessage } = require("./lib/hs-start-here");

const TEMPLATE_FILES = {
  [BUCKETS.AC]: "HS_Attract_Convert_90-Day_Action_Plan.docx",
  [BUCKETS.DR]: "HS_Deliver_Retain_90-Day_Action_Plan.docx",
  [BUCKETS.ECV]: "HS_Expand_Customer_Value_90-Day_Action_Plan.docx",
};

// Static tracking sheet for each area, sent as-is (not personalized).
const TRACKER_FILES = {
  [BUCKETS.AC]: "HS_Tracking_Sheet_Attract_Convert.xlsx",
  [BUCKETS.DR]: "HS_Tracking_Sheet_Deliver_Retain.xlsx",
  [BUCKETS.ECV]: "HS_Tracking_Sheet_Expand_Value.xlsx",
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  // Same shared secret as the fitness function (AUDIT_WEBHOOK_SECRET).
  const expectedSecret = process.env.AUDIT_WEBHOOK_SECRET;
  if (expectedSecret && event.headers["x-webhook-secret"] !== expectedSecret) {
    return { statusCode: 401, body: "Unauthorized" };
  }

  let answers;
  try {
    answers = JSON.parse(event.body || "{}");
  } catch (err) {
    return { statusCode: 400, body: "Invalid JSON body" };
  }

  if (!answers.client_name || !answers.business_name) {
    return { statusCode: 400, body: "Missing required fields: client_name, business_name" };
  }

  try {
    const results = computeScores(answers);
    const templatePath = path.join(__dirname, "templates", TEMPLATE_FILES[results.primary]);
    const templateBuffer = fs.readFileSync(templatePath);

    const filledBuffer = await fillReport(templateBuffer, answers, results);
    const startHereBuffer = await buildStartHere(answers, results);
    const trackerBuffer = fs.readFileSync(path.join(__dirname, "templates", TRACKER_FILES[results.primary]));

    const safeBusiness = (answers.business_name || "Business").replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "");

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        primary: results.primary,
        secondary: results.secondary,
        strongest: results.strongest,
        scores: results.scores,
        ownerChose: results.ownerChose,
        lowest: results.lowest,
        docxBase64: filledBuffer.toString("base64"),
        filename: `${safeBusiness}_Home_Service_Revenue_Leak_Audit_Report.docx`,
        startHereBase64: startHereBuffer.toString("base64"),
        startHereFilename: `${safeBusiness}_Start_Here_Guide.docx`,
        trackerBase64: trackerBuffer.toString("base64"),
        trackerFilename: `${safeBusiness}_Tracking_Sheet.xlsx`,
        startMessage: startMessage(results.primary, answers.business_name).message,
        startMessageNote: startMessage(results.primary, answers.business_name).note,
      }),
    };
  } catch (err) {
    console.error("generate-home-service-report error:", err);
    return { statusCode: 500, body: `Internal error: ${err.message}` };
  }
};
