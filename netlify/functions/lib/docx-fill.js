// docx-fill.js — fills a .docx template's [bracket] placeholders using the same
// paragraph-context logic as the Python fill_report.py. Matches python-docx's
// actual run.text semantics: a <w:br/> inside a run reads as "\n" and a "\n"
// written back becomes a <w:br/> between <w:t> segments in that same run.

const JSZip = require("jszip");
const { interpret, DEFAULT_METRICS } = require("./scoring");

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlUnescape(str) {
  return String(str)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function splitParagraphs(documentXml) {
  const parts = [];
  const re = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
  let lastIndex = 0;
  let m;
  while ((m = re.exec(documentXml)) !== null) {
    if (m.index > lastIndex) {
      parts.push({ xml: documentXml.slice(lastIndex, m.index), isParagraph: false, start: lastIndex, end: m.index });
    }
    const pXml = m[0];
    parts.push({ xml: pXml, isParagraph: true, text: extractText(pXml), start: m.index, end: re.lastIndex });
    lastIndex = re.lastIndex;
  }
  parts.push({ xml: documentXml.slice(lastIndex), isParagraph: false, start: lastIndex, end: documentXml.length });
  return parts;
}

function splitRuns(paragraphXml) {
  const parts = [];
  const re = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g;
  let lastIndex = 0;
  let m;
  while ((m = re.exec(paragraphXml)) !== null) {
    if (m.index > lastIndex) parts.push({ xml: paragraphXml.slice(lastIndex, m.index), isRun: false });
    parts.push({ xml: m[0], isRun: true });
    lastIndex = re.lastIndex;
  }
  parts.push({ xml: paragraphXml.slice(lastIndex), isRun: false });
  return parts;
}

function runText(runXml) {
  let text = "";
  const tokenRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\s*\/?>|<w:cr\s*\/?>|<w:tab\s*\/?>/g;
  let m;
  while ((m = tokenRe.exec(runXml)) !== null) {
    if (m[0].startsWith("<w:t")) text += xmlUnescape(m[1]);
    else if (m[0].startsWith("<w:br") || m[0].startsWith("<w:cr")) text += "\n";
    else if (m[0].startsWith("<w:tab")) text += "\t";
  }
  return text;
}

function extractText(paragraphXml) {
  return splitRuns(paragraphXml)
    .filter((p) => p.isRun)
    .map((p) => runText(p.xml))
    .join("");
}

function buildRunWithText(runXml, text) {
  const rPrMatch = runXml.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
  const rPr = rPrMatch ? rPrMatch[0] : "";
  const rAttrsMatch = runXml.match(/^<w:r(\s[^>]*)?>/);
  const rAttrs = rAttrsMatch && rAttrsMatch[1] ? rAttrsMatch[1] : "";
  if (text === "") {
    return `<w:r${rAttrs}>${rPr}</w:r>`;
  }
  const segments = text.split("\n").map((seg) => `<w:t xml:space="preserve">${xmlEscape(seg)}</w:t>`);
  return `<w:r${rAttrs}>${rPr}${segments.join("<w:br/>")}</w:r>`;
}

function setParagraphText(paragraphXml, newText) {
  const runs = splitRuns(paragraphXml);
  let firstRunSeen = false;
  const rebuilt = runs.map((part) => {
    if (!part.isRun) return part.xml;
    if (!firstRunSeen) {
      firstRunSeen = true;
      return buildRunWithText(part.xml, newText);
    }
    return buildRunWithText(part.xml, "");
  });
  if (!firstRunSeen) return paragraphXml;
  return rebuilt.join("");
}

function firstTableRange(documentXml) {
  const start = documentXml.indexOf("<w:tbl>");
  if (start === -1) return null;
  const end = documentXml.indexOf("</w:tbl>", start);
  return end === -1 ? null : [start, end + "</w:tbl>".length];
}

async function fillReport(templateBuffer, answers, results) {
  const zip = await JSZip.loadAsync(templateBuffer);
  const docPath = "word/document.xml";
  const xml = await zip.file(docPath).async("string");

  const tableRange = firstTableRange(xml);
  const parts = splitParagraphs(xml);

  const { primary, secondary, strongest, scores, pcts } = results;
  const ptsPct = (b) => [String(scores[b]), `${Math.round(pcts[b] * 100)}%`];
  const [pPts, pPct] = ptsPct(primary);
  const [sPts, sPct] = ptsPct(secondary);
  const [stPts, stPct] = ptsPct(strongest);
  const [acPts, acPct] = ptsPct("Attract & Convert");
  const [erPts, erPct] = ptsPct("Engage & Retain");
  const [ecvPts, ecvPct] = ptsPct("Expand Client Value");
  const metrics = DEFAULT_METRICS[primary];

  for (const part of parts) {
    if (!part.isParagraph) continue;
    const text = part.text;
    const inFirstTable = tableRange && part.start >= tableRange[0] && part.end <= tableRange[1];

    if (inFirstTable && text.includes("[Client Name]")) {
      part.xml = setParagraphText(part.xml, text.replace("[Client Name]", answers.client_name || ""));
    } else if (inFirstTable && text.includes("[Business Name]")) {
      part.xml = setParagraphText(part.xml, text.replace("[Business Name]", answers.business_name || ""));
    } else if (inFirstTable && text.includes("[Your Name]")) {
      part.xml = setParagraphText(part.xml, text.replace("[Your Name]", answers.prepared_by || ""));
    } else if (inFirstTable && text.includes("[Date]")) {
      part.xml = setParagraphText(part.xml, text.replace("[Date]", answers.audit_date || ""));
    } else if (text.includes("Your score in this area was [Points]/24")) {
      part.xml = setParagraphText(part.xml, text.replace("[Points]", pPts).replace("[Percentage]", pPct));
    } else if (text.includes("[Secondary Revenue Leak]")) {
      part.xml = setParagraphText(
        part.xml,
        text.replace("[Secondary Revenue Leak]", secondary).replace("[Points]", sPts).replace("[Percentage]", sPct)
      );
    } else if (text.includes("[Strongest Area]")) {
      part.xml = setParagraphText(
        part.xml,
        text.replace("[Strongest Area]", strongest).replace("[Points]", stPts).replace("[Percentage]", stPct)
      );
    } else if (text.includes("[Attract Points]") || text.includes("[Attract %]") || text.includes("[Attract interpretation]")) {
      const t = text
        .replace("[Attract Points]", acPts)
        .replace("[Attract %]", acPct)
        .replace("[Attract interpretation]", interpret(pcts["Attract & Convert"]));
      part.xml = setParagraphText(part.xml, t);
    } else if (text.includes("[Retain Points]") || text.includes("[Retain %]") || text.includes("[Retention interpretation]")) {
      const t = text
        .replace("[Retain Points]", erPts)
        .replace("[Retain %]", erPct)
        .replace("[Retention interpretation]", interpret(pcts["Engage & Retain"]));
      part.xml = setParagraphText(part.xml, t);
    } else if (text.includes("[Value Points]") || text.includes("[Value %]") || text.includes("[Value interpretation]")) {
      const t = text
        .replace("[Value Points]", ecvPts)
        .replace("[Value %]", ecvPct)
        .replace("[Value interpretation]", interpret(pcts["Expand Client Value"]));
      part.xml = setParagraphText(part.xml, t);
    } else if (text.includes("[Specific client problem from audit]")) {
      part.xml = setParagraphText(part.xml, results.problemText);
    } else if (text.includes("[REAL_CONVERSION_ESTIMATE]")) {
      part.xml = setParagraphText(part.xml, results.conversionText);
    } else if (text.includes("[REAL_RETAIN_ESTIMATE]")) {
      part.xml = setParagraphText(part.xml, results.retainText);
    } else if (text.includes("[REAL_EXPAND_ESTIMATE]")) {
      part.xml = setParagraphText(part.xml, results.expandText);
    } else if (text.includes("[CLIENT_OPPORTUNITY_INTRO]") && results.ecvOpportunity) {
      part.xml = setParagraphText(part.xml, results.ecvOpportunity.intro);
    } else if (text.includes("[CLIENT_OPPORTUNITY_PRIMARY]") && results.ecvOpportunity) {
      part.xml = setParagraphText(part.xml, results.ecvOpportunity.primaryBullet);
    } else if (text.includes("[CLIENT_OPPORTUNITY_OTHERS]") && results.ecvOpportunity) {
      part.xml = setParagraphText(part.xml, results.ecvOpportunity.othersBullet);
    } else if (text.includes("[Metric 1]")) {
      part.xml = setParagraphText(part.xml, text.replace("[Metric 1]", metrics[0]));
    } else if (text.includes("[Metric 2]")) {
      part.xml = setParagraphText(part.xml, text.replace("[Metric 2]", metrics[1]));
    } else if (text.includes("[Metric 3]")) {
      part.xml = setParagraphText(part.xml, text.replace("[Metric 3]", metrics[2]));
    } else if (text.includes("[Metric 4]")) {
      part.xml = setParagraphText(part.xml, text.replace("[Metric 4]", metrics[3]));
    } else if (text.includes("[Metric 5]")) {
      part.xml = setParagraphText(part.xml, text.replace("[Metric 5]", metrics[4]));
    }
  }

  const newXml = parts.map((p) => p.xml).join("");
  zip.file(docPath, newXml);
  return zip.generateAsync({ type: "nodebuffer" });
}

module.exports = { fillReport };
