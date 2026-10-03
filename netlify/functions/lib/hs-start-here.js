// hs-start-here.js — the step-by-step "Start Here" guide (replaces the old
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

// Average-job ranges from the audit form -> [low, high] dollars (high null = open-ended).
const JOB_RANGES = {
  "Under $150": [null, 150], "$150–$299": [150, 299], "$300–$499": [300, 499],
  "$500–$999": [500, 999], "$1,000–$1,999": [1000, 1999], "$2,000 or more": [2000, null],
};
const money = (n) => "$" + Math.round(n).toLocaleString("en-US");
function resultMath(avgJobText) {
  const r = JOB_RANGES[String(avgJobText || "").trim()];
  if (!r) return null;
  const [lo, hi] = r;
  let range;
  if (lo == null) range = `up to about ${money(hi * 2)}`;
  else if (hi == null) range = `${money(lo)} to ${money(lo * 2)} or more`;
  else range = `roughly ${money(lo)} to ${money(Math.round(hi * 2 / 50) * 50)}`;
  return { label: avgJobText.trim(), range };
}

// Area-specific wording for the step-by-step guide.
const GUIDE = {
  [BUCKETS.AC]: {
    who: "people who got an estimate from you in the last 60 days and haven’t said yes, plus recent leads that went quiet. Start with the biggest jobs.",
    why: "They already asked you for a price. Often they haven’t said no — nobody followed up.",
    yesVerb: "book or accept the estimate",
    extra: "Open estimates are often larger than your average job, so one yes can be worth more than this.",
    learn: "Even the ones who don’t book will tell you what stopped them: price, timing, or that nobody called back.",
  },
  [BUCKETS.DR]: {
    who: "customers who are overdue for service, let a maintenance plan lapse, or have an open callback or complaint.",
    why: "They already know and trust you. If nobody reaches out, the next time something breaks they may call whoever shows up first online.",
    yesVerb: "book",
    extra: "A customer you win back is also likely to call you again next time, so the value goes beyond one job.",
    learn: "Even the ones who don’t book will tell you why they drifted. That is your leak, in your customers’ own words.",
  },
  [BUCKETS.ECV]: {
    who: "recent customers who aren’t on a maintenance plan and would genuinely benefit: older equipment, repeat repairs, or a job that went well.",
    why: "They just had a good experience with you. That’s the easiest moment to offer the next step.",
    yesVerb: "say yes to a plan, tune-up, or other next step",
    extra: "A maintenance-plan sign-up also brings repeat visits, so its value keeps going after the first year.",
    learn: "Even the ones who say no will tell you what they care about, which helps you shape a better offer.",
  },
};

async function buildStartHere(answers, results) {
  const { primary } = results;
  const s = START_HERE[primary];
  const g = GUIDE[primary];
  const business = answers.business_name || "[your business]";
  const kids = [];
  const P = (children, o = {}) => para(Array.isArray(children) ? children : [run(children, o)], o);
  const bullet = (children) => new Paragraph({ bullet: { level: 0 }, spacing: { after: 50 },
    children: Array.isArray(children) ? children : [run(children)] });
  const step = (label, title, time) => para([
    run(label + "  ", { bold: true, size: 26, color: AMBER }),
    run(title, { bold: true, size: 26, color: NAVY }),
    ...(time ? [run("   " + time, { size: 18, color: SLATE })] : []),
  ], { before: 220, after: 80, keepNext: true });
  const sub = (label, title) => para([
    run(label + "  ", { bold: true, size: 22, color: AMBER }),
    run(title, { bold: true, size: 22, color: NAVY }),
  ], { before: 140, after: 50, keepNext: true });
  const box = (children, fill) => table([PAGE_W], [new TableRow({ children: [cell(children, PAGE_W, { fill })] })]);

  // ---------- Title + priority ----------
  kids.push(
    P([run("HOME SERVICE REVENUE LEAK AUDIT™", { bold: true, size: 16, color: AMBER })], { after: 20 }),
    P([run("Start Here: How to Use Your Audit Results", { bold: true, size: 34, color: NAVY })], { after: 40 }),
    P([run(`Prepared for ${answers.client_name || ""}, ${business}`, { size: 18, color: SLATE })], { after: 140 }),
    P([run("Your biggest opportunity:  ", { bold: true, color: NAVY }), run(primary, { bold: true })], { fill: "FFF3D6", after: 0 }),
    P([run(s.focus)], { fill: "FFF3D6", after: 160 }),
  );

  // ---------- The files ----------
  kids.push(P([run("Your email has 3 files. Here’s what each one is for:", { bold: true, size: 22, color: NAVY })], { after: 70, keepNext: true }));
  const FW = [2700, 5100, 3000];
  const hdr = (t) => cell([P([run(t, { bold: true, size: 17, color: "FFFFFF" })], { after: 0 })], 0, { fill: NAVY });
  const frow = (name, what, when) => new TableRow({ children: [
    cell([P([run(name, { bold: true, size: 19 })], { after: 0 })], FW[0]),
    cell([P([run(what, { size: 19 })], { after: 0 })], FW[1]),
    cell([P([run(when, { size: 19 })], { after: 0 })], FW[2]),
  ] });
  kids.push(table(FW, [
    new TableRow({ tableHeader: true, children: [hdr("File"), hdr("What it is"), hdr("When you use it")] }),
    frow("Start Here (this guide)", "Step-by-step instructions for using your results.", "Now. Keep it handy for the next two weeks."),
    frow("Revenue Leak Audit Report (Word)", "Your three scores, why your biggest opportunity is where to start, and your full 90-Day Action Plan.", "Step 1."),
    frow("Tracking Sheet (Excel)", "A ready-made list for the customers you contact. Its Scorecard tab counts your results for you.", "Step 2, the shortcut. No Excel? Upload it to Google Drive and open it with Google Sheets."),
  ]));

  // ---------- Step 1 ----------
  kids.push(step("STEP 1", "Review your Leak Report", "about 20–30 minutes"));
  kids.push(
    bullet("Open the Revenue Leak Audit Report."),
    bullet([run("Read the first pages: your three scores, why "), run(primary, { bold: true }), run(" is the place to start, and what it may be worth to you.")]),
    bullet("Then look over the 90-Day Action Plan that follows. It’s the complete fix, week by week, starting with Week 1."),
    bullet([run("Questions about anything in it? ", { bold: true }), run("Call me at (210) 846-6685, reply to the email, or book a free 30-minute call with the link in the email.")]),
  );
  kids.push(P([run("If the plan looks doable, follow it, starting with Week 1. If it looks like too much right now, go to Step 2.", { italics: true })], { before: 60 }));

  // ---------- Step 2 ----------
  kids.push(step("STEP 2", "Too much right now? Use this shortcut instead", "about 2 hours over two weeks"));
  kids.push(P([run("Instead of the full plan, contact up to 10 customers who are most likely to bring in work quickly: "), run(g.who, { bold: true })]));
  kids.push(P([run("Why these customers? ", { bold: true }), run(g.why)], { after: 120 }));

  // Results box
  const m = resultMath(answers.avg_job_value);
  const resultLines = [
    P([run("What results can you expect?", { bold: true, size: 22, color: NAVY })], { after: 60 }),
    P([run("The honest answer: it depends on your customers and how you follow up, so we can’t promise a number. Some lists produce no bookings; others produce several. Here’s how to think about it:")], { after: 60 }),
  ];
  if (m) {
    resultLines.push(bullet([run("The math: ", { bold: true }), run(`your average job is ${m.label}. If even 1 or 2 of the 10 ${g.yesVerb}, that’s ${m.range} in work from about two hours of effort. ${g.extra}`)]));
  } else {
    resultLines.push(bullet([run("The math: ", { bold: true }), run(`multiply your average job by 1 or 2. If even 1 or 2 of the 10 ${g.yesVerb}, that’s the payoff for about two hours of effort. ${g.extra}`)]));
  }
  resultLines.push(
    bullet([run("What you learn: ", { bold: true }), run(g.learn)]),
    bullet([run("Real numbers in two weeks: ", { bold: true }), run("how many you contacted, how many answered, and how many booked. That tells you whether to keep going, fix the message, or get help.")]),
  );
  kids.push(box(resultLines, "F5F7F9"));

  // 2A..2F
  kids.push(sub("2A", "Pick your 10 customers (Day 1, about 15 minutes)"));
  kids.push(
    bullet("Write down up to 10 names from the group described above. Your scheduling software, invoices, or estimate folder from the last 60\u201390 days is the quickest place to find them."),
    bullet("Decide who does it: you, or one person in your office. One owner keeps it from slipping."),
  );

  kids.push(sub("2B", "Send each one this message (Days 1–2)"));
  kids.push(box([
    P([run(`“${s.message.replace("{business}", "[your company name]")}”`)], { after: 40 }),
    P([run(s.messageNote, { italics: true, size: 18, color: SLATE })], { after: 0 }),
  ], "FFF3D6"));
  kids.push(
    bullet("Copy it, fill in the [brackets], and send it from your business phone."),
    bullet([run("Short on time? ", { bold: true }), run("Click the “Write my messages” link in your email. Enter each customer’s first name and situation, and within about a minute you’ll get a personal message for each one, ready to send. No phone numbers needed.")]),
  );

  kids.push(sub("2C", "Log each one on the Tracking Sheet (2 minutes each)"));
  kids.push(
    bullet("Open the Tracking Sheet and go to the Tracking List tab. Use one row per customer: name, phone, date contacted, Response (pick from the list), and Booked (Yes or No)."),
    bullet("On the Scorecard tab, type the date you started in the yellow box. It counts contacted, answered, and booked for you."),
    bullet("Already have scheduling software that tracks this? Use it instead."),
  );

  kids.push(sub("2D", "Follow up (Days 3–10)"));
  kids.push(
    bullet("No reply after 2 days? Call."),
    bullet("Callbacks and complaints: always call, never text. Listen first and agree on a next step."),
  );

  kids.push(sub("2E", "Day 14: check your results and decide"));
  kids.push(P("Open the Scorecard tab and pick the one that fits:", { after: 50 }));
  [
    ["Didn’t get through the list?", " That’s a time problem, not a plan problem. Give it to one person at a set time each day and run two more weeks."],
    ["Few people answered?", " That’s a reach problem. Call instead of text, try a different time of day, and run two more weeks."],
    [`They answered, but almost nobody ${s.yes}?`, " Keep going, but change the message or the offer. The Response column shows you why."],
    [`People ${s.yes}?`, " It’s working. Go to 2F."],
  ].forEach(([a, b]) => kids.push(bullet([run(a, { bold: true }), run(b)])));
  kids.push(P("I’ll email you on Day 14. Reply with your numbers and I’ll tell you what I’d do next.", { before: 40, italics: true }));

  kids.push(sub("2F", "Make it a habit"));
  kids.push(bullet(s.actions[2][0]));
  kids.push(bullet("When you’re ready for more, open your report and pick up the 90-Day Action Plan at Weeks 2–4."));

  kids.push(P([
    run("Questions or stuck at any step? ", { bold: true, size: 19, color: NAVY }),
    run("Call Don Merrill at (210) 846-6685 or reply to the email.", { size: 19, color: NAVY }),
  ], { before: 240, after: 0 }));

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: 21 } } } },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 720, bottom: 720, left: 720, right: 720 } } },
      children: kids,
    }],
  });
  return Packer.toBuffer(doc);
}

// The ready-to-send message with the business name filled in (used in Email 1).
function startMessage(primary, businessName) {
  const s = START_HERE[primary];
  return { message: s.message.replace("{business}", "[your company name]"), note: s.messageNote };
}

module.exports = { buildStartHere, startMessage, START_HERE };
