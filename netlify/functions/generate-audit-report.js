// netlify/functions/generate-audit-report.js
//
// Stateless by design: receives one client's audit answers, returns the
// filled report as base64. Does NOT touch Google Drive, does NOT send any
// email, does NOT know who "the client" is beyond the data it's given.
// All of that — saving the draft, notifying Don, and any eventual send —
// lives in the Apps Script side, deliberately, so this function can never
// accidentally email a client even if it's called wrong.

const path = require("path");
const fs = require("fs");
const { computeScores } = require("./lib/scoring");
const { fillReport } = require("./lib/docx-fill");
const { buildOnePager } = require("./lib/what-you-should-do-now");

const TEMPLATE_FILES = {
  "Attract & Convert": "Attract_Convert_Leads_90-Day_Action_Plan.docx",
  "Engage & Retain": "Engage_Retain_90-Day_Action_Plan.docx",
  "Expand Client Value": "Expand_Client_Value_90-Day_Action_Plan.docx",
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  // Simple shared-secret check — the Apps Script sends this header.
  // Set AUDIT_WEBHOOK_SECRET in Netlify's environment variables and in the
  // Apps Script's Script Properties to the same value.
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
    const templateFile = TEMPLATE_FILES[results.primary];
    const templatePath = path.join(__dirname, "templates", templateFile);
    const templateBuffer = fs.readFileSync(templatePath);

    const filledBuffer = await fillReport(templateBuffer, answers, results);
    const onePagerBuffer = await buildOnePager(answers, results);

    const safeBusiness = (answers.business_name || "Client").replace(/[^a-z0-9]+/gi, "_");

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        primary: results.primary,
        secondary: results.secondary,
        strongest: results.strongest,
        scores: results.scores,
        docxBase64: filledBuffer.toString("base64"),
        filename: `${safeBusiness}_Revenue_Leak_Audit_Report.docx`,
        onePagerBase64: onePagerBuffer.toString("base64"),
        onePagerFilename: `${safeBusiness}_What_You_Should_Do_Now.docx`,
      }),
    };
  } catch (err) {
    console.error("generate-audit-report error:", err);
    return { statusCode: 500, body: `Internal error: ${err.message}` };
  }
};
