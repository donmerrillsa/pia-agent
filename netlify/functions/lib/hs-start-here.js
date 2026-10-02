// hs-start-here.js — the one-page "Start Here" working plan (replaces the old
// "What You Should Do Now" page). Built fresh with the docx library. Uses the
// same computeScores() results as the full report, so the two can't disagree.
//
// Everything area-specific lives in START_HERE below, so wording can be
// changed without touching the layout code.

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, ShadingType, AlignmentType, BorderStyle,
} = require("docx");
const { BUCKETS } = require("./hs-scoring");

const NAVY = "1B3A5C";
const AMBER = "F5A623";
const SLATE = "5B6470";
const FONT = "Arial";
const PAGE_W = 10800; // 8.5" minus 0.5" margins, in DXA

const START_HERE = {
  [BUCKETS.AC]: {
    focus: "Stop losing leads and open estimates to slow or missed follow-up.",
    list: "your last 25 leads, plus every estimate from the last 60 days that hasn’t been accepted",
    actions: [
      ["Today: send the message below to up to 10 people with open estimates. Short on time? Use the “Write my messages” link in your email and we’ll write them for you.", "Owner or office", "Day 1"],
      ["Put the rest of your last 25 leads and open estimates from the last 60 days on the tracking sheet. Mark where each one stopped and contact them the same way.", "Office / CSR (owner calls the big jobs)", "Days 2–10"],
      ["Start the follow-up rule for every new lead: respond within 15 minutes during business hours, then follow up on Day 1, 3, 7, and 14.", "Owner sets it; whoever answers the phone follows it", "Day 3 on"],
    ],
    message: "Hi [Name], this is [your name] with {business}. I’m checking in on the estimate we gave you for [job]. Do you have any questions I can answer, or would you like to get it on the schedule? Happy to help either way.",
    messageNote: "Text first. If there’s no reply in 2 days, call.",
    score: ["Open leads and estimates contacted", "Reached (they answered)", "Of those, booked or accepted", "New leads that got the follow-up rule"],
    verb: "contacted", yes: "booked",
  },
  [BUCKETS.DR]: {
    focus: "Bring back customers who are overdue, drifting, or upset before they go to someone else.",
    list: "25 recent customers not on a maintenance plan, 10 lapsed or cancelled plans, and every open callback or complaint from the last 60 days",
    actions: [
      ["Today: send the message below to up to 10 customers who are overdue for service or let their plan lapse. Short on time? Use the “Write my messages” link in your email and we’ll write them for you.", "Owner or office", "Day 1"],
      ["Put the rest of the list on the tracking sheet and contact them the same way, open callbacks and complaints first (call those). Note why they drifted.", "Office / CSR (owner takes complaints)", "Days 2–10"],
      ["Start the warning-sign rule: overdue service, an open callback, a renewal with no conversation, or a missed appointment gets a personal call or text within 1 business day.", "Owner sets it; office runs it", "Day 3 on"],
    ],
    message: "Hi [Name], this is [your name] with {business}. It’s been a while since we were out, and your [system] is about due for a check. Would you like us to get you on the schedule? And if anything wasn’t right last time, tell me and I’ll make it right.",
    messageNote: "Open callbacks and complaints: call, don’t text.",
    score: ["Customers on the list contacted", "Reached (they answered)", "Of those, booked or renewed", "Warning signs handled within 1 business day"],
    verb: "contacted", yes: "booked",
  },
  [BUCKETS.ECV]: {
    focus: "Offer the next step (maintenance plan, tune-up, or upgrade) to customers who would genuinely benefit.",
    list: "your last 25 completed jobs for customers who aren’t on a maintenance plan",
    actions: [
      ["Today: send the message below to up to 10 recent customers not on a plan who would genuinely benefit from one. Short on time? Use the “Write my messages” link in your email and we’ll write them for you.", "Owner or office", "Day 1"],
      ["Put the rest of your last 25 completed jobs for customers not on a plan on the tracking sheet. Mark who would benefit and contact them the same way.", "Office / CSR or lead tech", "Days 2–10"],
      ["Start the offer rule: after every completed job for a satisfied customer not on a plan, offer the plan once and record the answer.", "Owner sets it; techs make the offer", "Day 3 on"],
    ],
    message: "Hi [Name], this is [your name] with {business}. Thanks again for having us out for [job]. A lot of our customers with [equipment] use our maintenance plan to catch problems early and avoid emergency calls. Want me to send you the details? No pressure either way.",
    messageNote: "Only send it to customers it would actually help. No maintenance plan yet? Offer a seasonal tune-up instead.",
    score: ["Customers offered the plan or next step", "Reached (they answered)", "Of those, said yes", "Completed jobs where the offer was made"],
    verb: "offered", yes: "said yes",
  },
};

// ---------- small layout helpers ----------
const run = (text, o = {}) => new TextRun({ text, font: FONT, size: o.size ?? 21, bold: !!o.bold, italics: !!o.italics, color: o.color ?? "000000" });
const para = (children, o = {}) => new Paragraph({
  spacing: { before: o.before ?? 0, after: o.after ?? 80 },
  alignment: o.center ? AlignmentType.CENTER : AlignmentType.LEFT,
  shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill } : undefined,
  keepNext: !!o.keepNext,
  children: Array.isArray(children) ? children : [run(children, o)],
});
const heading = (text) => para([run(text, { bold: true, size: 24, color: NAVY })], { before: 140, after: 60, keepNext: true });
const line = { style: BorderStyle.SINGLE, size: 4, color: "C8CED6" };
const borders = { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: line };
const cell = (children, w, o = {}) => new TableCell({
  width: { size: w, type: WidthType.DXA },
  shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill } : undefined,
  margins: { top: 50, bottom: 50, left: 90, right: 90 },
  children: Array.isArray(children) ? children : [para([run(children, o)], { after: 0, center: o.center })],
});
const table = (widths, rows) => new Table({ width: { size: PAGE_W, type: WidthType.DXA }, columnWidths: widths, borders, rows });

async function buildStartHere(answers, results) {
  const { primary } = results;
  const s = START_HERE[primary];
  const business = answers.business_name || "[your business]";
  const kids = [];

  // Title block
  kids.push(
    para([run("HOME SERVICE REVENUE LEAK AUDIT™", { bold: true, size: 16, color: AMBER })], { after: 20 }),
    para([run("Start Here: Your First Two Weeks", { bold: true, size: 34, color: NAVY })], { after: 40 }),
    para([run(`Prepared for ${answers.client_name || ""}, ${business}`, { size: 18, color: SLATE })], { after: 120 }),
  );

  // Priority
  kids.push(
    para([run("Your starting priority:  ", { bold: true, size: 21, color: NAVY }), run(primary, { bold: true, size: 21 })], { fill: "FFF3D6", after: 0, before: 0 }),
    para([run(s.focus, { size: 21 })], { fill: "FFF3D6", after: 60 }),
    para([run("Work on this one thing for the next two weeks. Everything else in your full report can wait.", { italics: true, size: 17, color: SLATE })], { after: 60 }),
  );

  // Who + time
  kids.push(
    heading("Who and how much time"),
    para([
      run("Pick one person to own the list. ", { bold: true }),
      run(`Suggested: your office manager or CSR, or you if you don’t have office staff. Plan on 30–45 minutes a day. The list: ${s.list}. Roles and days below are suggestions; adjust them to your team.`),
    ], { after: 40 }),
  );

  // Three actions
  kids.push(heading("Do these 3 things"));
  const W = [520, 6080, 2600, 1600];
  const hdr = (t) => cell([para([run(t, { bold: true, size: 17, color: "FFFFFF" })], { after: 0 })], 0, { fill: NAVY });
  kids.push(table(W, [
    new TableRow({ tableHeader: true, children: [hdr("#"), hdr("Action"), hdr("Who (suggested)"), hdr("When")] }),
    ...s.actions.map(([a, who, when], i) => new TableRow({
      children: [
        cell(String(i + 1), W[0], { bold: true, center: true }),
        cell(a, W[1]),
        cell(who, W[2], { size: 17 }),
        cell(when, W[3], { size: 17 }),
      ],
    })),
  ]));
  kids.push(para([run("Use the attached tracking sheet, or your scheduling software if it already tracks this.", { italics: true, size: 17, color: SLATE })], { before: 40, after: 0 }));

  // Message
  kids.push(heading("Message to send (copy, fill in the brackets, and send)"));
  kids.push(table([PAGE_W], [new TableRow({ children: [cell([
    para([run(`“${s.message.replace("{business}", business)}”`, { size: 21 })], { after: 40 }),
    para([run(s.messageNote, { italics: true, size: 17, color: SLATE })], { after: 0 }),
  ], PAGE_W, { fill: "F5F7F9" })] })]));

  // Scorecard
  kids.push(heading("Weekly scorecard"));
  const SW = [6400, 2200, 2200];
  kids.push(table(SW, [
    new TableRow({ tableHeader: true, children: [hdr("Track these numbers"), hdr("Week 1"), hdr("Week 2")] }),
    ...s.score.map((m) => new TableRow({ children: [cell(m, SW[0]), cell("", SW[1]), cell("", SW[2])] })),
  ]));
  kids.push(para([run("The Scorecard tab in the tracking sheet fills in the first three numbers for you.", { italics: true, size: 17, color: SLATE })], { before: 40, after: 0 }));

  // Checkpoint
  kids.push(heading("Day 14 checkpoint: look at your scorecard and pick one"));
  const opts = [
    ["Didn\u2019t get through the list?", " That\u2019s a time problem, not a plan problem. Give it to one person at a set time each day and run two more weeks."],
    ["Few people answered?", " That\u2019s a reach problem. Call instead of text, try a different time of day, and run two more weeks."],
    [`They answered, but almost nobody ${s.yes}?`, " Keep the process. Change the message or the offer, and run two more weeks. The Response column in your tracking sheet shows you why."],
    [`People ${s.yes}?`, " It\u2019s working. Keep going and move on to Weeks 2\u20134 in your full report."],
  ];
  opts.forEach(([a, b]) => kids.push(new Paragraph({
    bullet: { level: 0 }, spacing: { after: 40 },
    children: [run(a, { bold: true }), run(b)],
  })));

  kids.push(para([
    run("Your full report has the complete 90-day plan and the reasons behind it. This page is what to do in the next two weeks. Questions or stuck? Call Don Merrill at (210) 846-6685.", { size: 17, color: SLATE }),
  ], { before: 120, after: 0 }));

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: 19 } } } },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 620, bottom: 560, left: 720, right: 720 } } },
      children: kids,
    }],
  });
  return Packer.toBuffer(doc);
}

// The ready-to-send message with the business name filled in (used in Email 1).
function startMessage(primary, businessName) {
  const s = START_HERE[primary];
  return { message: s.message.replace("{business}", businessName || "[your business]"), note: s.messageNote };
}

module.exports = { buildStartHere, startMessage, START_HERE };
