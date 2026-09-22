// scoring.js — ported from the Python fill_report.py, same logic, same field names.

const RANGE_MIDPOINTS = {
  "Under $2,000.": 1000, "$2,000–$4,999.": 3500, "$5,000–$9,999.": 7500,
  "$10,000–$19,999.": 15000, "$20,000 or more.": 25000,
  "0–5.": 2.5, "6–10.": 8, "11–25.": 18, "26–50.": 38, "More than 50.": 60,
  "0–10.": 5, "51–100.": 75, "More than 100.": 120,
  "None.": 0, "1–2.": 1.5, "3–5.": 4, "More than 10.": 12,
  "Under $100.": 75, "$100–$249.": 175, "$250–$499.": 375, "$500–$999.": 750,
  "$1,000–$1,999": 1500, "$2,000 or more.": 2500,
};

const BUCKET_NAMES = ["Attract & Convert", "Engage & Retain", "Expand Client Value"];

const DEFAULT_METRICS = {
  "Attract & Convert": [
    "Leads received per week", "Average first-response time", "Follow-up completion rate",
    "Booking rate from inquiry", "Lead-to-client conversion rate",
  ],
  "Engage & Retain": [
    "New-client onboarding completion rate", "% of clients with scheduled check-ins",
    "Declining-engagement flags per month", "90-day cancellation rate",
    "Renewal-conversation completion rate",
  ],
  "Expand Client Value": [
    "% of clients on a recurring-revenue offer", "Average revenue per active client",
    "Referrals generated per month", "Reactivated former clients per month",
    "% of clients offered a next-step program",
  ],
};

// Real quick-start action titles, pulled directly from each Word template's
// "Next 7 Days" section — not paraphrased, so the one-pager and the full
// report never say two different things about what to do first.
const QUICK_START_ACTIONS = {
  "Attract & Convert": [
    "Create one simple lead-tracking spreadsheet.",
    "Review the most recent 20-50 leads and find where they stopped moving.",
    "Set one response-and-follow-up standard for every new lead.",
  ],
  "Engage & Retain": [
    "Create one simple client-retention spreadsheet.",
    "Review the most recent 20-50 cancellations, non-renewals, or inactive clients.",
    "Set one early-warning and outreach rule.",
  ],
  "Expand Client Value": [
    "Create one simple client-value spreadsheet.",
    "Review 20-50 current clients and look for missed value opportunities.",
    "Set one simple offer trigger and conversation rule.",
  ],
};

const PROBLEM_TEXT_FIELDS = {
  "Attract & Convert": ["ac_open2", "ac_open3"],
  "Engage & Retain": ["er_open1"],
  "Expand Client Value": ["ecv_open1"],
};

const ECV_OPPORTUNITY_LABELS = [
  ["ecv_q1", "a recurring-revenue offer", "you don't yet have a service or product that creates predictable, ongoing revenue — everything is one-off."],
  ["ecv_q2", "scalable, non-1:1 value", "clients can't get more value from you without buying another one-to-one hour of your time."],
  ["ecv_q3", "a next-step / continuation offer", "when a client finishes their initial program, there's no clear next step offered."],
  ["ecv_q4", "additional service formats", "you don't yet offer other formats (hybrid, remote, group, semi-private, or maintenance coaching) that could fit a wider range of clients."],
  ["ecv_q5", "referral generation", "referrals from happy clients aren't being systematically asked for or generated."],
  ["ecv_q6", "reactivation & complementary offers", "former clients aren't being reactivated, and there's no complementary product or service offered to them."],
];

function leadingDigit(answerText) {
  const m = String(answerText || "").match(/^\s*([1-4])/);
  if (!m) throw new Error(`Could not find a leading 1-4 digit in answer: ${JSON.stringify(answerText)}`);
  return parseInt(m[1], 10);
}

function midpoint(rangeText) {
  if (rangeText == null) return null;
  const key = String(rangeText).trim();
  if (key in RANGE_MIDPOINTS) return RANGE_MIDPOINTS[key];
  const stripped = key.replace(/\.$/, "");
  for (const [k, v] of Object.entries(RANGE_MIDPOINTS)) {
    if (k.replace(/\.$/, "") === stripped) return v;
  }
  return null; // "I do not track this." / "I'm not sure." / etc.
}

function interpret(pct) {
  if (pct < 0.40) return "Significant, consistent gaps here — the biggest source of the leak.";
  if (pct < 0.70) return "Some structure exists, but it isn't consistent yet.";
  return "This is a relative strength — protect it while you fix the other areas.";
}

function computeEcvOpportunityTypes(answers) {
  const scored = ECV_OPPORTUNITY_LABELS.map(([code, label, reason]) => [code, label, reason, leadingDigit(answers[code])]);
  scored.sort((a, b) => a[3] - b[3]);
  const lowestScore = scored[0][3];
  let lowest = scored.filter((s) => s[3] === lowestScore);
  const primaryItems = lowest.length >= 2 ? lowest.slice(0, 2) : scored.slice(0, 2);
  const primaryCodes = new Set(primaryItems.map((s) => s[0]));
  const others = scored.filter((s) => !primaryCodes.has(s[0]));

  const intro = "Based on your answers, your specific opportunity is:";
  const primaryBullet = primaryItems.map(([, label, reason]) => `${label[0].toUpperCase()}${label.slice(1)} — ${reason}`).join("; ");
  const othersBullet = others.map(([, label]) => `${label[0].toUpperCase()}${label.slice(1)}`).join("; ");
  return { intro, primaryBullet, othersBullet };
}

function computeScores(answers) {
  const acCodes = ["ac_q1", "ac_q2", "ac_q3", "ac_q4", "ac_q5", "ac_q6"];
  const erCodes = ["er_q1", "er_q2", "er_q3", "er_q4", "er_q5", "er_q6"];
  const ecvCodes = ["ecv_q1", "ecv_q2", "ecv_q3", "ecv_q4", "ecv_q5", "ecv_q6"];

  const sumPoints = (codes) => codes.reduce((sum, c) => sum + leadingDigit(answers[c]), 0);

  const scores = {
    "Attract & Convert": sumPoints(acCodes),
    "Engage & Retain": sumPoints(erCodes),
    "Expand Client Value": sumPoints(ecvCodes),
  };
  const pcts = Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, v / 24]));

  const ranked = [...BUCKET_NAMES].sort((a, b) => scores[a] - scores[b]);
  const [primary, secondary, strongest] = ranked;

  const weakestMap = {
    "Attract & Convert": "Attract & Convert New Clients.",
    "Engage & Retain": "Engage & Retain Clients.",
    "Expand Client Value": "Expand Client Value.",
  };
  const matches = (raw, bucket) => {
    const r = raw || "";
    return r.includes(weakestMap[bucket].replace(/\.$/, "")) || r.includes(bucket);
  };
  const weakestMatch = matches(answers.self_weakest, primary);
  const impactMatch = matches(answers.self_impact, primary);

  const cancelMid = midpoint(answers.cancellations_90d);
  const revclientMid = midpoint(answers.revenue_per_client);
  const leadsMid = midpoint(answers.leads_per_month);
  const reactivatable = answers.reactivatable_clients != null ? parseFloat(answers.reactivatable_clients) : null;
  const newClientsLastMonth = answers.new_clients_last_month != null ? parseFloat(answers.new_clients_last_month) : null;

  let retainEstimate = null, retainText;
  if (cancelMid != null && revclientMid != null) {
    retainEstimate = cancelMid * revclientMid * 3;
    retainText = `Your numbers: roughly ${cancelMid.toFixed(1)} cancellations per 90 days at an estimated $${revclientMid.toLocaleString()}/month average client value — that's about $${Math.round(retainEstimate).toLocaleString()} in revenue at risk over the next 90 days if that pattern continues.`;
  } else {
    retainText = `We don't have enough data yet to estimate your real revenue at risk — this needs both your cancellation count and your average client value answered as more than "not sure."`;
  }

  let expandEstimate = null, expandText;
  if (reactivatable != null && !Number.isNaN(reactivatable) && revclientMid != null) {
    expandEstimate = reactivatable * revclientMid * 3;
    expandText = `Your numbers: ${reactivatable.toFixed(0)} reactivatable former clients at an estimated $${revclientMid.toLocaleString()}/month average client value — that's roughly $${Math.round(expandEstimate).toLocaleString()} in recoverable revenue over 90 days if you reactivate all of them, scaled down proportionally for however many you actually win back.`;
  } else {
    expandText = `We don't have enough data yet to estimate your reactivation opportunity — this needs both your reactivatable-client count and your average client value answered as more than "not sure."`;
  }

  let conversionText;
  if (leadsMid && leadsMid > 0 && newClientsLastMonth != null && !Number.isNaN(newClientsLastMonth) && revclientMid != null) {
    const currentRate = newClientsLastMonth / leadsMid;
    const improvedRate = Math.min(currentRate + 0.03, 1.0);
    const extraClients = (improvedRate - currentRate) * leadsMid;
    const extraRevenue90d = extraClients * revclientMid * 3;
    conversionText = `Your numbers: about ${leadsMid.toFixed(0)} leads/month at roughly ${(currentRate * 100).toFixed(0)}% conversion (${newClientsLastMonth.toFixed(0)} new clients last month). Improving that to ${(improvedRate * 100).toFixed(0)}% — without a single extra lead — would mean about ${extraClients.toFixed(1)} more clients per month, worth an estimated $${Math.round(extraRevenue90d).toLocaleString()} over the next 90 days at your current average client value.`;
  } else {
    conversionText = `We don't yet have enough data to calculate your actual conversion rate — add "how many new clients did you sign last month" to get a real number here instead of an illustrative one.`;
  }

  let problemText = null;
  for (const code of PROBLEM_TEXT_FIELDS[primary]) {
    const val = answers[code];
    if (val && String(val).trim() && !["na", "n/a", "none"].includes(String(val).trim().toLowerCase())) {
      problemText = String(val).trim();
      break;
    }
  }
  if (!problemText) {
    problemText = "[Reviewer: no usable open-text answer captured for this bucket — write in the specific problem manually.]";
  }

  const result = {
    scores, pcts, primary, secondary, strongest,
    weakestMatch, impactMatch, retainEstimate, expandEstimate,
    retainText, expandText, conversionText, problemText,
  };

  if (primary === "Expand Client Value") {
    result.ecvOpportunity = computeEcvOpportunityTypes(answers);
  }

  return result;
}

module.exports = { computeScores, interpret, DEFAULT_METRICS, QUICK_START_ACTIONS, leadingDigit, midpoint };
