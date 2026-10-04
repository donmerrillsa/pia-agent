// Shared US-dollar parsing for form validation, storage, and customer display.
(function (root) {
  function normalizePrice(value) {
    if (value == null || String(value).trim() === '') return null;
    const text = String(value).trim();
    if (!/^\$?\s*(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) {
      throw new Error('Enter a price such as 13150, 13,150, or $13,150.00 (up to two decimal places).');
    }
    const clean = text.replace(/[$,\s]/g, '');
    const parts = clean.split('.');
    const cents = Number(parts[0]) * 100 + Number((parts[1] || '').padEnd(2, '0'));
    if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('Price is outside the supported range.');
    return (cents / 100).toFixed(2);
  }
  function formatPrice(value) {
    const normalized = normalizePrice(value);
    return normalized === null ? '' : '$' + Number(normalized).toLocaleString('en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: 2
    });
  }
  const api = { normalizePrice, formatPrice };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EstimatePrices = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
