// hs-scoring.js — Home Service Revenue Leak Audit scoring.
// Three areas scored 0–4 per question:
//   Attract & Convert  6 process questions + 3 missed-call questions = 36 max
//   Deliver & Retain   6 questions = 24 max
//   Expand Value       6 questions = 24 max
// Areas are compared by PERCENTAGE (points ÷ that area's max), never raw points,
// because the areas have different maximums. Submissions made before the
// missed-call questions existed have no answers for them; Attract & Convert is
// then scored on its original 6 questions (max 24), exactly as before.
// The fitness files are untouched; nothing here is shared with them.

const AC = "Attract & Convert New Customers";
const DR = "Deliver & Retain Customers";
const ECV = "Expand Customer Value";
const BUCKET_NAMES = [AC, DR, ECV];

// Answer ranges -> midpoints. Separate maps per question so identical range
// labels on different questions can never be confused with each other.
const LEADS_PER_MONTH = { "0–10": 5, "11–25": 18, "26–50": 38, "51–100": 75, "More than 100": 120 };
const LOST_90D = { "None": 0, "1–5": 3, "6–10": 8, "11–20": 15, "More than 20": 25 };
const AVG_JOB = {
  "Under $150": 100, "$150–$299": 225, "$300–$499": 400, "$500–$999": 750,
  "$1,000–$1,999": 1500, "$2,000 or more": 2500,
};

const DEFAULT_METRICS = {
  [AC]: [
    "Leads received per week", "Missed calls and average first-response time",
    "Estimate follow-up completion rate", "Booking rate from inquiry", "Estimate acceptance (close) rate",
  ],
  [DR]: [
    "% of completed jobs with a follow-up call or text", "Overdue or lapsed customers contacted, and how many booked",
    "Maintenance-plan renewals (renewed ÷ due)", "% of customers sent a service reminder when due",
    "Retention rate (booked again within 12 months — your long-term number)",
  ],
  [ECV]: [
    "% of customers on a maintenance plan", "Average ticket per job",
    "Referrals received per month", "Past customers reactivated per month",
    "% of jobs where a next-step offer was made",
  ],
};

// Must match the "Next 7 Days" titles in the HS_ Word templates word for word.
const QUICK_START_ACTIONS = {
  [AC]: [
    "Create one simple lead-tracking spreadsheet.",
    "Review the most recent 20-50 leads and find where they stopped moving.",
    "Set one response-and-follow-up standard for every new lead.",
  ],
  [DR]: [
    "Create one simple customer-retention spreadsheet.",
    "Review the most recent 20–50 cancelled plans, non-renewals, or customers who stopped calling.",
    "Set one early-warning and outreach rule.",
  ],
  [ECV]: [
    "Create one simple customer-value spreadsheet.",
    "Review 20–50 current customers and look for missed value opportunities.",
    "Set one simple offer trigger and conversation rule.",
  ],
};

// How close the owner's own pick must be to the lowest area for the owner's pick
// to lead the report, as a share of each area's maximum. 3/24 = 12.5 percentage
// points, the same as the original "within 3 points out of 24" rule.
const OWNER_PICK_MARGIN_PCT = 3 / 24;

// The three missed-call questions (Attract & Convert). Codes ac_mc1..3.
const MISSED_CALL_CODES = ["ac_mc1", "ac_mc2", "ac_mc3"];
const MISSED_CALL_MAX = 12;
// Plain-language finding for each low answer (0, 1 or 2). 3 and 4 are not gaps.
const MISSED_CALL_FINDINGS = {
  ac_mc1: {
    0: "Calls go to voicemail or go unanswered several times a day during business hours.",
    1: "Calls go to voicemail or go unanswered most days during business hours.",
    2: "Calls go to voicemail or go unanswered a few times a week during business hours.",
  },
  ac_mc2: {
    0: "When a call is missed, often no one calls back.",
    1: "Missed calls usually aren't returned until the next business day or later.",
    2: "Missed calls are returned the same day, but it can take a few hours.",
  },
  ac_mc3: {
    0: "After hours, callers reach voicemail and don't hear back until the next business day.",
    1: "After hours, callers reach voicemail and hear back that evening at the earliest.",
    2: "After hours, calls go to a personal cell phone, so whether they're answered depends on who is free.",
  },
};
const CONTACT_PHONE = "(210) 846-6685";

const START_HERE_REASON = {
  [AC]: "with little or no process for turning calls and leads into jobs, customers are being lost before they ever start, and that limits every other improvement.",
  [DR]: "with little or no process for keeping customers, many of the customers you win back or sell a plan to are likely to drift away again.",
  [ECV]: "you already have customers who trust you and could be buying more, and that is usually the fastest money to capture.",
};
// One sentence showing how the first steps here also help the area the owner picked.
const BRIDGE = {
  [AC]: { [DR]: "Your Week 1 lead list also shows which new customers to welcome and follow up with.",
          [ECV]: "Every new customer you win is also someone you can offer a maintenance plan to." },
  [DR]: { [ECV]: "Your Week 1 list includes past and lost customers, so it also starts the work of bringing them back.",
          [AC]: "Customers who keep coming back also send referrals, one of the cheapest sources of new leads." },
  [ECV]: { [DR]: "Maintenance plans are also one of the best ways to keep customers coming back.",
           [AC]: "Referrals from existing customers are also one of the cheapest sources of new leads." },
};

const PROBLEM_TEXT_FIELDS = {
  [AC]: ["ac_open2", "ac_open3"],
  [DR]: ["dr_open1"],
  [ECV]: ["ecv_open1"],
};

const ECV_OPPORTUNITY_LABELS = [
  ["ecv_q1", "a recurring-revenue offer", "you don't yet have a maintenance plan or other service that brings in predictable, repeat revenue, so most work is one job at a time."],
  ["ecv_q2", "value between service calls", "customers can't get anything from you (plan perks, priority scheduling, reminders) without booking another full service call."],
  ["ecv_q3", "a next step after every job", "when a job is finished, there's no clear next step offered, such as a tune-up, plan, upgrade, or inspection."],
  ["ecv_q4", "additional service formats", "you don't yet offer formats such as seasonal, priority/emergency, maintenance, or inspection services that would fit more customers."],
  ["ecv_q5", "referral generation", "referrals from happy customers aren't being systematically asked for or rewarded."],
  ["ecv_q6", "reactivation & complementary services", "past customers aren't being brought back, and complementary services aren't being offered to them."],
];

function leadingDigit(answerText) {
  const m = String(answerText || "").match(/^\s*([0-4])/);
  if (!m) throw new Error(`Could not find a leading 0-4 digit in answer: ${JSON.stringify(answerText)}`);
  return parseInt(m[1], 10);
}

function lookup(map, text) {
  if (text == null) return null;
  const key = String(text).trim().replace(/\.$/, "");
  return key in map ? map[key] : null; // "I do not track this", "I'm not sure", etc.
}

// First number found in a free-text answer ("Roughly 400 past customers" -> 400).
function firstNumber(text) {
  if (text == null) return null;
  const m = String(text).replace(/,/g, "").match(/\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

const money = (n) => `$${Math.round(n).toLocaleString("en-US")}`;

function interpret(pct) {
  if (pct < 0.40) return "Significant gaps. Little or no process in place.";
  if (pct < 0.70) return "Some structure exists, but it isn't consistent yet.";
  return "This is a relative strength — protect it while you fix the other areas.";
}

function computeEcvOpportunityTypes(answers) {
  const scored = ECV_OPPORTUNITY_LABELS.map(([code, label, reason]) => [code, label, reason, leadingDigit(answers[code])]);
  scored.sort((a, b) => a[3] - b[3]);
  const lowestScore = scored[0][3];
  const lowest = scored.filter((s) => s[3] === lowestScore);
  const primaryItems = lowest.length >= 2 ? lowest.slice(0, 2) : scored.slice(0, 2);
  const primaryCodes = new Set(primaryItems.map((s) => s[0]));
  const others = scored.filter((s) => !primaryCodes.has(s[0]));
  const cap = (t) => `${t[0].toUpperCase()}${t.slice(1)}`;
  return {
    intro: "Based on your answers, your specific opportunity is:",
    primaryBullet: primaryItems.map(([, label, reason]) => `${cap(label)} — ${reason.replace(/\.$/, "")}`).join("; ") + ".",
    othersBullet: others.map(([, label]) => cap(label)).join("; "),
  };
}

// Missed-call answers: all three present (new form), or all three blank
// (submitted before the questions existed). Anything in between is an error,
// so a half-answered set can never be scored silently.
function missedCallAnswers(answers) {
  const filled = MISSED_CALL_CODES.filter((c) => String(answers[c] || "").trim() !== "");
  if (filled.length === 0) return null;
  if (filled.length !== MISSED_CALL_CODES.length) {
    const missing = MISSED_CALL_CODES.filter((c) => !filled.includes(c));
    throw new Error(`Missed-call answers incomplete; missing: ${missing.join(", ")}`);
  }
  return Object.fromEntries(MISSED_CALL_CODES.map((c) => [c, leadingDigit(answers[c])]));
}

function computeMissedCalls(points) {
  if (!points) return null;
  const score = MISSED_CALL_CODES.reduce((s, c) => s + points[c], 0);
  const findings = MISSED_CALL_CODES.filter((c) => points[c] <= 2).map((c) => MISSED_CALL_FINDINGS[c][points[c]]);
  const gap = findings.length > 0;
  const scoreLine = `Your three missed-call answers scored ${score} out of ${MISSED_CALL_MAX}. They are part of your Attract & Convert score above.`;
  const note = gap
    ? `${findings.join(" ")} Many callers who reach voicemail don't leave a message; they call the next company on the list, and the job is lost before anyone knows they called. The usual fix is simple: an automatic text to every missed call within a minute, then a person calls back within the hour. ${scoreLine}`
    : `Your answers show calls are answered and returned quickly, including after hours. That's a strength; keep it in place as call volume grows. ${scoreLine}`;
  const emailLine = gap
    ? `One more thing from your answers: missed calls. ${findings[0]} Your report has a short section on it called "Missed calls."`
    : "";
  return { points, score, max: MISSED_CALL_MAX, gap, findings, note, emailLine };
}

function computeScores(answers) {
  const codes = (p) => [1, 2, 3, 4, 5, 6].map((n) => `${p}_q${n}`);
  const sumPoints = (cs) => cs.reduce((sum, c) => sum + leadingDigit(answers[c]), 0);

  const mcPoints = missedCallAnswers(answers);
  const missedCalls = computeMissedCalls(mcPoints);
  const scores = {
    [AC]: sumPoints(codes("ac")) + (missedCalls ? missedCalls.score : 0),
    [DR]: sumPoints(codes("dr")),
    [ECV]: sumPoints(codes("ecv")),
  };
  const maxes = { [AC]: missedCalls ? 36 : 24, [DR]: 24, [ECV]: 24 };
  const pcts = Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, v / maxes[k]]));
  const outOf = (b) => `${scores[b]}/${maxes[b]}`;
  const pctText = (b) => `${Math.round(pcts[b] * 100)}%`;
  const unsure = (raw) => !String(raw || "").trim() || /not sure/i.test(String(raw));
  const areaOf = (raw) => BUCKET_NAMES.find((b) => String(raw || "").includes(b));

  // Rule 1: lowest PERCENTAGE wins (ties keep the order AC, DR, ECV), unless the
  // owner's own "biggest financial difference" pick is within
  // OWNER_PICK_MARGIN_PCT of it. Then the owner's pick leads, and the
  // lowest-scoring area becomes their next priority.
  const ranked = [...BUCKET_NAMES].sort((a, b) => pcts[a] - pcts[b]);
  const lowest = ranked[0];
  const ownerPick = unsure(answers.self_impact) ? null : areaOf(answers.self_impact);
  const ownerChose = !!ownerPick && ownerPick !== lowest && pcts[ownerPick] - pcts[lowest] <= OWNER_PICK_MARGIN_PCT + 1e-9;
  const order = ownerChose ? [ownerPick, ...ranked.filter((b) => b !== ownerPick)] : ranked;
  const [primary, secondary, strongest] = order;

  const matches = (raw) => String(raw || "").includes(primary);
  const weakestMatch = matches(answers.self_weakest);
  const impactMatch = matches(answers.self_impact);

  let agreementText = "";
  if (ownerChose) {
    agreementText = weakestMatch ? "You also picked this as your weakest area." : "";
  } else if (!unsure(answers.self_weakest)) {
    agreementText = weakestMatch
      ? "You also picked this as your weakest area, so your answers and your instincts agree."
      : `You picked ${areaOf(answers.self_weakest) || answers.self_weakest} as your weakest area. Your answers point here instead, because this area scored lowest of the three (${outOf(primary)}, ${pctText(primary)}).`;
  }

  const leads = lookup(LEADS_PER_MONTH, answers.leads_per_month);
  const lost = lookup(LOST_90D, answers.lost_customers_90d);
  const job = lookup(AVG_JOB, answers.avg_job_value);
  const newCust = firstNumber(answers.new_customers_last_30d);
  const reactivatable = firstNumber(answers.reactivatable_customers);

  // Lead-to-customer conversion
  let conversionText, convEstimate = null;
  if (leads && newCust != null && job != null) {
    const currentRate = Math.min(newCust / leads, 1);
    const improvedRate = Math.min(currentRate + 0.03, 1);
    const extra = (improvedRate - currentRate) * leads;
    convEstimate = extra * job * 3;
    conversionText = `About ${Math.round(leads)} leads a month and ${Math.round(newCust)} new customers in the last 30 days — roughly ${Math.round(currentRate * 100)}% of leads becoming customers. Improving that by 3 points, to ${Math.round(improvedRate * 100)}%, without a single extra lead would mean about ${extra.toFixed(1)} more jobs a month — roughly ${money(extra * job * 3)} over the next 90 days at your average job value of about ${money(job)}. (Estimates are revenue, not profit, and are based on the ranges you gave us. They are not a guarantee.)`;
  } else {
    conversionText = `We don't have enough data to calculate your own conversion rate yet. It needs your monthly lead count, your new customers in the last 30 days, and your average job value, each answered with a number or range rather than "not sure."`;
  }

  // Customers who did not book or return
  let retainEstimate = null, retainText;
  if (lost != null && job != null) {
    const low = lost * 0.25 * job, high = lost * 0.5 * job;
    retainEstimate = low;
    retainText = `About ${Math.round(lost)} customers did not book or return in the past 90 days. Not all of them needed service, so here is a realistic range at your average job of about ${money(job)}: winning back 1 in 4 is about ${money(low)} every 90 days (${money(low * 4)} a year); winning back 1 in 2 is about ${money(high)} every 90 days (${money(high * 4)} a year). Customers who join or renew a maintenance plan are worth more. (Estimates are revenue, not profit, and are based on the ranges you gave us. They are not a guarantee.)`;
  } else {
    retainText = `We don't have enough data to estimate your revenue at risk yet. It needs both the number of customers who did not book or return in the past 90 days and your average job value, answered as more than "not tracked" or "not sure."`;
  }

  // Reactivating past customers
  let expandEstimate = null, expandText;
  if (reactivatable != null && job != null) {
    const tenPct = Math.round(reactivatable * 0.10);
    expandEstimate = tenPct * job;
    expandText = `About ${Math.round(reactivatable).toLocaleString("en-US")} past customers who could potentially be reactivated. If just 10% of them (about ${tenPct}) booked one average job of about ${money(job)}, that's roughly ${money(expandEstimate)} in revenue from customers who already know you — before counting any who join a maintenance plan. (Estimates are revenue, not profit, and are based on the ranges you gave us. They are not a guarantee.)`;
  } else {
    expandText = `We don't have enough data to estimate your reactivation opportunity yet. It needs a count of past customers who could be reactivated and your average job value, answered as more than "not sure."`;
  }


  // When the owner picked a different area as the biggest financial opportunity,
  // show both numbers and explain why we still start here.
  const ESTIMATE = { [AC]: convEstimate, [DR]: retainEstimate, [ECV]: expandEstimate };
  let impactText = "";
  if (ownerChose) {
    impactText = `You said this area would make the biggest financial difference, and your scores are close (${pctText(primary)} here, ${pctText(lowest)} for ${lowest}), so your plan starts where you see the most value. ${lowest} is your next priority.`;
  } else if (!unsure(answers.self_impact)) {
    const other = areaOf(answers.self_impact);
    if (impactMatch) {
      impactText = "You also said improving this area would make the biggest financial difference.";
    } else if (other) {
      const est = ESTIMATE[other];
      impactText = `You said ${other} would make the biggest financial difference` +
        (est ? `, and your numbers suggest a real opportunity there (about ${money(est)})` : "") +
        `. It scored ${outOf(other)} (${pctText(other)}), compared with ${outOf(primary)} (${pctText(primary)}) here. We'd still start here: ${START_HERE_REASON[primary]}` +
        (BRIDGE[primary][other] ? ` ${BRIDGE[primary][other]}` : "") +
        ` If you'd still rather start with ${other}, call me at ${CONTACT_PHONE} or reply to my email, and I'll send you that plan too.`;
    } else {
      impactText = `You said ${answers.self_impact} would make the biggest financial difference. We'd still start here: ${START_HERE_REASON[primary]}`;
    }
  }

  const feats = String(answers.software_features || "").split(",").map((s) => s.trim())
    .filter((s) => s && !/not sure|^none$/i.test(s));
  const softwareNote = feats.length
    ? `Your software already has ${(feats.length > 1 ? feats.slice(0, -1).join(", ") + " and " + feats[feats.length - 1] : feats[0]).toLowerCase()}. Before building a spreadsheet, check whether it can produce this list as a saved report or filtered view. Use the spreadsheet only if it can't.`
    : "If you use field-service software, first check whether it can produce this list as a saved report. If not, a simple spreadsheet works fine.";

  let problemText = null;
  for (const code of PROBLEM_TEXT_FIELDS[primary]) {
    const v = String(answers[code] || "").trim();
    if (v && !["na", "n/a", "none"].includes(v.toLowerCase())) { problemText = v; break; }
  }
  if (!problemText) {
    problemText = "[Reviewer: no usable open-text answer captured for this area — write in the specific problem manually.]";
  }

  const result = {
    scores, maxes, pcts, missedCalls, primary, secondary, strongest, weakestMatch, impactMatch, agreementText, impactText, softwareNote, ownerChose, lowest,
    retainEstimate, expandEstimate, retainText, expandText, conversionText, problemText,
  };
  if (primary === ECV) result.ecvOpportunity = computeEcvOpportunityTypes(answers);
  return result;
}

module.exports = {
  computeScores, interpret, DEFAULT_METRICS, QUICK_START_ACTIONS, leadingDigit,
  MISSED_CALL_CODES, MISSED_CALL_MAX, OWNER_PICK_MARGIN_PCT,
  BUCKETS: { AC, DR, ECV }, BUCKET_NAMES,
};
