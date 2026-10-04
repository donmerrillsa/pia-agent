Pappas estimate price fix

Replace the included files at their matching paths in the existing source project, then deploy through the existing Netlify deployment process. This is a source patch, not a standalone drag-and-drop site.

Accepts US dollar entries such as 13150, 13,150, $13,150, and $13,150.00. All three tier prices are validated before saving; invalid text, malformed comma groups, negative prices, and more than two decimal places are rejected. Blank optional prices remain blank. Saved prices use a canonical two-decimal string. Existing comma-formatted records display correctly without resaving. Invalid legacy prices display Price requires confirmation instead of a guessed amount.

Run: node scripts/test-estimate-prices.cjs
After deploy, verify the existing Keishla customer link displays Better $13,150.00. Verify a disposable test estimate with comma-formatted prices and edits. No live customer record was changed while preparing this patch. The separately reported update issue remains unconfirmed.
