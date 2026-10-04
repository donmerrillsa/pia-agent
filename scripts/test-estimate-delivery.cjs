const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'estimate-form.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const valid = s => !s || /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(s);
function form(query = '') {
  const elements = new Map(); const calls = []; const alerts = [];
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', style: {}, dataset: {}, src: '',
      classList: {add() {}}, addEventListener() {}, focus() {}, setCustomValidity() {},
      checkValidity() { return valid(this.value); }, reportValidity() {},
    });
    return elements.get(id);
  }
  const ctx = vm.createContext({document: {getElementById: element},
    window: {location: {search: query}}, URLSearchParams, Date, EstimatePrices: require('../price-utils'),
    localStorage: {getItem() {return null;}, setItem() {}, removeItem() {}},
    alert: m => alerts.push(m), confirm: () => false, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      calls.push({url, body: options && JSON.parse(options.body)});
      return {ok: true, json: async () => ({success: true, estimate: {scope_of_work: 'Install system', customer_email: 'old@example.com'}, estimate_url: 'https://example.com/estimate/test'})};
    },
  });
  vm.runInContext(script, ctx);
  return {ctx, element, calls, alerts};
}
async function run() {
  assert.match(html, /label for="customer_email"/);
  assert.match(html, /id="sendBtn"[^>]*>Save Estimate/);
  const f = form();
  f.element('customer_name').value = 'Test Customer'; f.element('site_address').value = 'Test Address';
  f.element('customer_email').value = 'bad-address';
  await vm.runInContext('handleSend()', f.ctx);
  assert.equal(f.calls.length, 0, 'Invalid recipient must stop saving');
  f.element('customer_email').value = ' customer@example.com ';
  for (const tier of ['good', 'better', 'best']) {
    f.element(tier + '_price').value = '13,115';
    vm.runInContext(`formatPriceField('${tier}')`, f.ctx);
    assert.equal(f.element(tier + '_price').value, '$13,115.00');
  }
  await vm.runInContext('handleSend()', f.ctx);
  assert.equal(f.calls.length, 1, 'Save alone must not email customer');
  for (const tier of ['good', 'better', 'best']) {
    assert.equal(f.calls[0].body[tier].price, '13115.00');
    assert.equal(f.element(tier + '_price').value, '$13,115.00');
  }
  assert.equal(f.element('send_to_email').value, 'customer@example.com');
  assert.match(f.element('emailStatus').textContent, /has not been emailed/);
  await vm.runInContext('emailCustomer()', f.ctx);
  assert.equal(f.calls[1].body.customer_email, 'customer@example.com');
  assert.equal(f.calls[1].body.estimate_url, 'https://example.com/estimate/test');
  assert.match(f.element('emailStatus').textContent, /accepted for sending/);
  f.ctx.fetch = async () => ({ok: false, json: async () => ({error: 'Provider unavailable'})});
  await vm.runInContext('emailCustomer()', f.ctx);
  assert.match(f.element('emailStatus').textContent, /estimate is saved/);
  assert.equal(f.element('emailCustomerBtn').disabled, false);
  const manual = form(); manual.element('customer_name').value = 'Test'; manual.element('site_address').value = 'Test';
  await vm.runInContext('handleSend()', manual.ctx);
  assert.equal(manual.calls.length, 1, 'Blank email still permits manual link sharing');
  const duplicate = form('?duplicate=test');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(duplicate.element('customer_email').value, '', 'Template must not copy old recipient');
  duplicate.element('customer_email').value = 'stale@example.com';
  await vm.runInContext('loadForDuplicate()', duplicate.ctx);
  assert.equal(duplicate.element('customer_email').value, '');
  const edited = form('?id=test');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(edited.element('sendBtn').textContent, 'Save Changes');
  assert.equal(edited.element('customer_email').value, '', 'Editing must not invent a stored recipient');

  const sent = [];
  const module = {exports: {}};
  const backend = vm.createContext({module, exports: module.exports, console,
    process: {env: {RESEND_API_KEY: 'test-key'}},
    require: () => ({getSupabaseClient: () => ({from: () => ({select: () => ({eq: () => ({single: async () => ({data: {business_name: 'Test Business'}})})})})})}),
    fetch: async (url, options) => {sent.push(JSON.parse(options.body)); return {ok: true, json: async () => ({id: 'test-email'})};},
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'netlify/functions/send-estimate-email.js'), 'utf8'), backend);
  for (const email of ['invalid', 'a@example.com,b@example.com', 'a@example.com\n', ['a@example.com']]) {
    const r = await module.exports.handler({httpMethod: 'POST', body: JSON.stringify({business_id: 'test', customer_email: email, estimate_url: 'https://example.com/estimate/test'})});
    assert.equal(r.statusCode, 400);
  }
  const r = await module.exports.handler({httpMethod: 'POST', body: JSON.stringify({business_id: 'test', customer_email: ' customer@example.com ', estimate_url: 'https://example.com/estimate/test'})});
  assert.equal(r.statusCode, 200);
  assert.deepEqual(sent[0].to, ['customer@example.com']);
  assert.equal(sent.length, 1);
  console.log('PASS: new, duplicate, edit, manual sharing, validation, correct recipient, and email failure paths (mocked; no live email sent).');
}
run().catch(err => {console.error(err); process.exitCode = 1;});
