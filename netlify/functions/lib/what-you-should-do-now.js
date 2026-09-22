// what-you-should-do-now.js — generates a one-page companion doc, built fresh
// (not templated) since there's no existing base to preserve. Reuses the same
// computeScores() results as the full report, so the two documents can never
// disagree with each other.

const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, ShadingType, AlignmentType } = require("docx");
const { QUICK_START_ACTIONS, DEFAULT_METRICS, interpret } = require("./scoring");

const NAVY = "1B3A5C";
const AMBER = "F5A623";
const SLATE = "5B6470";
const FONT = "Arial";

function P(text, opts = {}) {
  return new Paragraph({
    spacing: { after: opts.after ?? 160, before: opts.before ?? 0 },
    alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT,
    children: [
      new TextRun({
        text,
        bold: !!opts.bold,
        italics: !!opts.italics,
        size: opts.size ?? 21,
        font: FONT,
        color: opts.color ?? "000000",
      }),
    ],
  });
}

function Bullet(text) {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 100 },
    children: [new TextRun({ text, size: 21, font: FONT })],
  });
}

async function buildOnePager(answers, results) {
  const { primary, scores, pcts, problemText } = results;
  const actions = QUICK_START_ACTIONS[primary];
  const metrics = DEFAULT_METRICS[primary].slice(0, 2);

  const children = [];

  children.push(
    new Paragraph({
      spacing: { after: 60 },
      children: [new TextRun({ text: "FITNESS REVENUE LEAK AUDIT\u2122", bold: true, size: 18, font: FONT, color: AMBER })],
    }),
    new Paragraph({
      spacing: { after: 200 },
      children: [new TextRun({ text: "What You Should Do Now", bold: true, size: 40, font: FONT, color: NAVY })],
    })
  );

  children.push(
    new Table({
      width: { size: 9600, type: WidthType.DXA },
      rows: [
        new TableRow({
          children: [
            new TableCell({
              width: { size: 4800, type: WidthType.DXA },
              shading: { type: ShadingType.CLEAR, fill: "F5F7F9" },
              children: [
                P("PREPARED FOR", { size: 16, color: "667788", bold: true, after: 20 }),
                P(answers.client_name || "", { size: 21, bold: true, after: 0 }),
              ],
            }),
            new TableCell({
              width: { size: 4800, type: WidthType.DXA },
              shading: { type: ShadingType.CLEAR, fill: "F5F7F9" },
              children: [
                P("BUSINESS", { size: 16, color: "667788", bold: true, after: 20 }),
                P(answers.business_name || "", { size: 21, bold: true, after: 0 }),
              ],
            }),
          ],
        }),
      ],
    })
  );

  children.push(P("", { after: 200 }));

  children.push(P("Your #1 Priority", { bold: true, size: 26, color: NAVY, before: 100 }));
  children.push(
    new Paragraph({
      spacing: { after: 200, before: 60 },
      shading: { type: ShadingType.CLEAR, fill: "FFF3D6" },
      children: [
        new TextRun({ text: `${primary}  \u2014  ${scores[primary]}/24 (${Math.round(pcts[primary] * 100)}%)`, bold: true, size: 24, font: FONT, color: NAVY }),
      ],
    })
  );

  children.push(P("The specific problem your answers point to:", { bold: true, size: 21, after: 60 }));
  children.push(P(problemText, { italics: true, color: SLATE, after: 240 }));

  children.push(P("Do These 3 Things First", { bold: true, size: 26, color: NAVY, before: 100, after: 140 }));
  actions.forEach((a) => children.push(Bullet(a)));

  children.push(P("", { after: 120 }));
  children.push(P("Track These 2 Numbers Weekly", { bold: true, size: 26, color: NAVY, before: 100, after: 140 }));
  metrics.forEach((m) => children.push(Bullet(m)));

  children.push(P("", { after: 240 }));
  children.push(
    new Paragraph({
      spacing: { after: 0 },
      children: [
        new TextRun({ text: "The full report has the complete 90-day plan, your full scorecard, and why this is the right place to start. ", size: 19, font: FONT, color: SLATE }),
        new TextRun({ text: "This page is just the part to act on this week.", size: 19, font: FONT, color: SLATE, bold: true }),
      ],
    })
  );

  const doc = new Document({
    sections: [
      {
        properties: { page: { margin: { top: 720, bottom: 720, left: 720, right: 720 } } },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

module.exports = { buildOnePager };
