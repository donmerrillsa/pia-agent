// netlify/functions/view-estimate.js
// Renders the customer-facing estimate page for a single submitted estimate.
//
// Layout: the three tier cards (Good/Better/Best) render in a responsive
// grid — 3 equal columns on wider screens (laptop/desktop), automatically
// collapsing to a single column below the breakpoint (phones). Pure CSS,
// no JS — same HTML markup works for both.
//
// GET /.netlify/functions/view-estimate?id=<estimate_id>
// (Reached via the /estimate/:id redirect defined in netlify.toml)

const { getSupabaseClient } = require("./_utils/supabase");

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return respondHtml(405, renderMessagePage("Method Not Allowed", "This page can only be viewed, not submitted to."));
  }

  let id = event.queryStringParameters && event.queryStringParameters.id;
  if (!id) {
    const segments = event.path.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && last !== "view-estimate") {
      id = last;
    }
  }

  if (!id) {
    return respondHtml(400, renderMessagePage("Estimate Not Found", "No estimate ID was provided in this link."));
  }

  const supabase = getSupabaseClient();

  try {
    const { data: estimate, error: estError } = await supabase
      .from("estimates")
      .select("*")
      .eq("id", id)
      .single();

    if (estError || !estimate) {
      console.warn(`[view-estimate] Estimate not found: ${id}`, estError?.message);
      return respondHtml(404, renderMessagePage(
        "Estimate Not Found",
        "This estimate link doesn't match anything in our system. It may have been entered incorrectly, or the estimate may no longer exist."
      ));
    }

    const { data: business, error: bizError } = await supabase
      .from("estimate_businesses")
      .select("*")
      .eq("id", estimate.business_id)
      .single();

    if (bizError || !business) {
      console.warn(`[view-estimate] Business not found for estimate ${id}`, bizError?.message);
      return respondHtml(500, renderMessagePage(
        "Something Went Wrong",
        "We couldn't load the business information for this estimate. Please contact them directly."
      ));
    }

    const html = renderEstimatePage(estimate, business);
    return respondHtml(200, html);

  } catch (err) {
    console.error("[view-estimate] Error:", err.message);
    return respondHtml(500, renderMessagePage(
      "Something Went Wrong",
      "We couldn't load this estimate right now. Please try again in a moment."
    ));
  }
};

// ── HTML rendering ──────────────────────────────────────────────

function esc(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function featuresListHtml(featuresText) {
  if (!featuresText) return "";
  const lines = featuresText.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return "";
  return `<ul class="features">` + lines.map(l => `<li>${esc(l)}</li>`).join("") + `</ul>`;
}

function tierCardHtml(label, tier, data, accentColor) {
  const hasContent = data.brand || data.price || data.warranty || data.features;
  if (!hasContent) return "";

  return `
    <div class="tier-card">
      <div class="tier-label">${esc(label)}</div>
      ${data.brand ? `<div class="tier-brand">${esc(data.brand)}</div>` : ""}
      <div class="tier-meta">
        ${data.seer ? `<span>${esc(data.seer)} SEER2</span>` : ""}
      </div>
      ${data.price ? `<div class="tier-price" style="color:${esc(accentColor)}">${esc(data.price)}</div>` : ""}
      ${data.warranty ? `<div class="tier-warranty">${esc(data.warranty)}</div>` : ""}
      ${featuresListHtml(data.features)}
      ${data.photo_url ? `<div class="tier-photo"><img src="${esc(data.photo_url)}" alt="Photo of ${esc(data.brand || label)}"></div>` : ""}
    </div>`;
}

function renderEstimatePage(estimate, business) {
  const primary = business.primary_color || "#12283C";
  const accent = business.accent_color || "#FE8D00";

  const goodCard = tierCardHtml("Good", "good", {
    brand: estimate.good_brand, seer: estimate.good_seer, price: estimate.good_price,
    warranty: estimate.good_warranty, features: estimate.good_features, photo_url: estimate.good_photo_url,
  }, accent);

  const betterCard = tierCardHtml("Better", "better", {
    brand: estimate.better_brand, seer: estimate.better_seer, price: estimate.better_price,
    warranty: estimate.better_warranty, features: estimate.better_features, photo_url: estimate.better_photo_url,
  }, accent);

  const bestCard = tierCardHtml("Best", "best", {
    brand: estimate.best_brand, seer: estimate.best_seer, price: estimate.best_price,
    warranty: estimate.best_warranty, features: estimate.best_features, photo_url: estimate.best_photo_url,
  }, accent);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Estimate for ${esc(estimate.customer_name || "Your Home")} — ${esc(business.business_name)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Zilla+Slab:wght@600;700&family=Inter:wght@400;500;600;700&family=Roboto+Mono:wght@500&display=swap" rel="stylesheet">
<style>
  :root{
    --primary:${esc(primary)};
    --accent:${esc(accent)};
    --slate:#4C6478;
    --paper:#EAF3F7;
    --card:#FFFFFF;
    --hairline:#DCE7ED;
    --ink:#1A1A1A;
  }
  *{box-sizing:border-box;}
  body{
    margin:0;
    background:var(--paper);
    color:var(--ink);
    font-family:'Inter',sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  header{
    background:var(--primary);
    color:#fff;
    padding:26px 20px 22px;
    border-bottom:4px solid var(--accent);
  }
  .wrap{ max-width:980px; margin:0 auto; padding:0 16px 40px; }
  header .wrap{ padding:0 4px; max-width:600px; }
  header .eyebrow{
    font-family:'Roboto Mono',monospace;
    font-size:11px; letter-spacing:.1em; text-transform:uppercase;
    color:var(--accent); margin-bottom:4px;
  }
  header h1{ font-family:'Zilla Slab',serif; font-size:24px; margin:0 0 4px; }
  header .tagline{ font-size:13px; color:rgba(255,255,255,.7); font-style:italic; }

  .job-info{
    background:var(--card);
    border:1px solid var(--hairline);
    border-radius:6px;
    padding:18px 20px;
    margin-top:20px;
    max-width:600px;
    margin-left:auto;
    margin-right:auto;
  }
  .job-info .row{ display:flex; justify-content:space-between; font-size:14px; padding:6px 0; border-bottom:1px solid var(--hairline); }
  .job-info .row:last-child{ border-bottom:none; }
  .job-info .label{ color:var(--slate); }
  .job-info .value{ font-weight:600; text-align:right; }
  .diagnosis{ margin-top:12px; padding-top:12px; border-top:1px solid var(--hairline); font-size:13px; color:var(--slate); }

  h2.section-title{
    font-family:'Zilla Slab',serif;
    font-size:20px;
    color:var(--primary);
    margin:32px 0 14px;
    padding-bottom:8px;
    border-bottom:2px solid var(--accent);
  }

  .tiers-grid{
    display:grid;
    grid-template-columns: repeat(3, 1fr);
    gap:16px;
  }
  @media (max-width: 760px){
    .tiers-grid{ grid-template-columns: 1fr; }
    .wrap{ max-width:600px; }
  }

  .tier-card{
    background:var(--card);
    border:1px solid var(--hairline);
    border-radius:6px;
    padding:20px;
  }
  .tier-label{
    font-family:'Roboto Mono',monospace;
    font-size:11px; letter-spacing:.1em; text-transform:uppercase;
    color:var(--accent); font-weight:600; margin-bottom:6px;
  }
  .tier-brand{ font-family:'Zilla Slab',serif; font-size:19px; font-weight:700; color:var(--primary); }
  .tier-meta{ font-size:13px; color:var(--slate); margin:4px 0 10px; }
  .tier-price{ font-family:'Zilla Slab',serif; font-size:28px; font-weight:700; margin-bottom:8px; }
  .tier-warranty{ font-size:13px; color:var(--slate); margin-bottom:10px; }
  .features{ margin:0 0 14px; padding-left:20px; font-size:14px; }
  .features li{ margin-bottom:4px; }
  .tier-photo img{ width:100%; border-radius:5px; border:1px solid var(--hairline); display:block; }

  footer{
    text-align:center;
    padding:24px 16px 40px;
    font-size:12.5px;
    color:var(--slate);
    max-width:600px;
    margin:0 auto;
  }
  footer .biz-name{ font-weight:600; color:var(--primary); margin-bottom:4px; }
</style>
</head>
<body>

  <header>
    <div class="wrap">
      <div class="eyebrow">Replacement Estimate</div>
      <h1>${esc(business.business_name)}</h1>
      ${business.tagline ? `<div class="tagline">${esc(business.tagline)}</div>` : ""}
    </div>
  </header>

  <div class="wrap">

    <div class="job-info">
      ${estimate.customer_name ? `<div class="row"><span class="label">Prepared for</span><span class="value">${esc(estimate.customer_name)}</span></div>` : ""}
      ${estimate.site_address ? `<div class="row"><span class="label">Site Address</span><span class="value">${esc(estimate.site_address)}</span></div>` : ""}
      ${estimate.proposal_date ? `<div class="row"><span class="label">Date</span><span class="value">${esc(formatDate(estimate.proposal_date))}</span></div>` : ""}
      ${estimate.current_system ? `<div class="row"><span class="label">Current System</span><span class="value">${esc(estimate.current_system)}</span></div>` : ""}
      ${estimate.technician ? `<div class="row"><span class="label">Technician</span><span class="value">${esc(estimate.technician)}</span></div>` : ""}
      ${estimate.diagnosis ? `<div class="diagnosis">${esc(estimate.diagnosis)}</div>` : ""}
    </div>

    <h2 class="section-title">Your Options</h2>
    <div class="tiers-grid">
      ${goodCard}
      ${betterCard}
      ${bestCard}
    </div>

  </div>

  <footer>
    <div class="biz-name">${esc(business.business_name)}</div>
    ${business.license_number ? `Licensed #${esc(business.license_number)}<br>` : ""}
    ${business.phone ? `${esc(business.phone)}` : ""}
  </footer>

</body>
</html>`;
}

function renderMessagePage(title, message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<style>
  body{ font-family:Arial,sans-serif; background:#EAF3F7; color:#1A1A1A; margin:0; padding:60px 20px; text-align:center; }
  .box{ max-width:420px; margin:0 auto; background:#fff; border:1px solid #DCE7ED; border-radius:8px; padding:32px 24px; }
  h1{ font-size:20px; color:#12283C; margin:0 0 12px; }
  p{ font-size:14px; color:#4C6478; line-height:1.6; margin:0; }
</style>
</head>
<body>
  <div class="box">
    <h1>${esc(title)}</h1>
    <p>${esc(message)}</p>
  </div>
</body>
</html>`;
}

function respondHtml(statusCode, html) {
  return {
    statusCode,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: html,
  };
}
