import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp, loadConfig } from '../src/server.mjs';
import { ReviewStore } from '../src/state.mjs';

const env = {
  PUBLIC_MCP_URL: 'https://customer-mcp.wooter.com/mcp',
  WOOTER_INTROSPECTION_URL: 'https://wooter.com/api/test-introspection',
  WOOTER_INTROSPECTION_CLIENT_ID: 'test-id',
  WOOTER_INTROSPECTION_CLIENT_SECRET: 'test-secret',
  REVIEW_KEY_HEX: '01'.repeat(32), DB_PATH: ':memory:',
};
const config = loadConfig(env);
const address = { country_id: 1, address_1: 'Example street', city_name: 'Miami', state: 'FL', zip: '33127' };
const item = { sku_id: 1353, quantity: 22 };
const profile = id => ({ customer_id: id, user_role: 'Customer', first_name: 'Test', email: 'customer@example.invalid',
  get_full_phone: '+13055550000', country_calling: { two_letter_code: 'US' } });
const sku = { id: 1353, name: 'Crew Neck Soccer Jersey', slug: 'soccer-jersey', published: true,
  minimum_order_quantity: 10, category_id: 2, subcategory_id: 1 };
function fixture() {
  const state = { writes: [], guestCalls: 0, slow: false, failDesign: false, partialCart: false, cart: {
    id: 12, items: [], prices: { total: 0 },
  } };
  const data = value => Response.json({ data: value });
  const fetcher = async (url, init) => {
    assert.equal(init.redirect, 'manual');
    const u = new URL(url);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    const token = init.headers.Authorization?.split(' ')[1];
    if (u.pathname === '/api/test-introspection') {
      assert.match(init.headers.Authorization, /^Basic /);
      const v = init.body.get('token');
      return Response.json({ active: v !== 'inactive', iss: config.issuer,
        aud: v === 'wrong-audience' ? 'https://other.example/mcp' : config.publicMcpUrl,
        scope: v === 'no-scope' ? 'staff' : 'customer', exp: (Date.now() / 1000) + (v === 'expired' ? -30 : 900) });
    }
    if (u.pathname === '/api/get-user') return Response.json({ user: {
      ...profile(token === 'other' ? 9 : 7), ...(token === 'staff' ? { user_role: 'Admin' } : {}),
    } });
    if (u.pathname === '/api/apparel-skus/1353') return data(sku);
    if (u.pathname === '/api/apparel-skus/1369') return data({ ...sku, id: 1369, name: 'Soccer Shorts' });
    if (u.pathname === '/api/apparel-skus/100') return data({ ...sku, id: 100, published: false });
    if (u.pathname === '/api/apparel-skus') return data({ items: [sku, { id: 100, published: false }] });
    if (u.pathname === '/api/countries') return data({ items: [{ id: 1, name: 'United States', two_letter_code: 'US' }] });
    if (u.pathname === '/api/apparel-builder-skus') {
      assert.equal(u.searchParams.get('virtual_product_slugs[]'), sku.slug);
      return data({ items: [
        { sku_id: sku.id, texture_id: 41, title: 'Classic', preview_url: 'https://apparel-media.s3-accelerate.amazonaws.com/preview.png',
          product_url: 'https://wooter.com/products/soccer-jersey' },
        { sku_id: 999, texture_id: 42, title: 'Wrong garment' },
      ] });
    }
    if (u.pathname === '/api/cart' && u.searchParams.get('preview') === 'true') {
      state.guestCalls++;
      assert.equal(init.method, 'POST');
      assert.equal(token, undefined);
      return data({ prices: { subtotal: 100, shipping_cost: 12, tax: 0, total: 117, profit: 12345,
        items: body.items.map(i => ({ type_id: i.sku_id, type: 'sku', quantity: i.quantity, price_single: 5, cost: 1 })) } });
    }
    if (u.pathname === '/api/apparel-colors') return Response.json({ reds: [{ id: 50, name: 'Red' }] });
    assert(token, 'Private upstream action requires the caller’s bearer token');
    if (u.pathname === '/api/cart') return data(state.cart);
    if (u.pathname === '/api/apparel-customers/shipping-locations') return data([address]);
    const order = { id: 22, customer_id: 7, name: 'Soccer set', status: 'unpaid', shipping_address: address,
      items: [{ ...item, sku: { name: sku.name } }], total: 123 };
    if (u.pathname === '/api/apparel-orders/22') return data(order);
    if (u.pathname === '/api/apparel-orders') return data({ items: [order] });
    const design = { id: 86900, name: 'Team kit', customer: { id: 7 }, drafts: [] };
    if (u.pathname === '/api/apparel-design-requests/86900') return data(design);
    if (u.pathname === '/api/apparel-design-requests' && init.method === 'GET') return data({ items: [design] });
    assert.equal(init.method, 'POST');
    state.writes.push({ path: u.pathname, body });
    if (state.slow) await delay(50);
    if (u.pathname === '/api/cart/items') {
      for (const i of state.partialCart ? body.items.slice(0, 1) : body.items) {
        assert.equal(i.model_id, i.sku_id);
        const line = state.cart.items.find(line => line.sku_id === i.sku_id);
        if (line) line.quantity += i.quantity;
        else state.cart.items.push({ ...i, id: i.sku_id, sku: { name: sku.name } });
      }
      return data({ saved: true });
    }
    if (u.pathname === '/api/form-submissions') return data({ form_id: 77 });
    if (u.pathname === '/api/apparel-design-requests') {
      if (state.failDesign) return new Response(null, { status: 500 });
      assert.equal(body.form_id, 77);
      assert.equal(body.due_date, '2027-01-08');
      assert.equal(body.description, 'Classic red kit');
      return data(design);
    }
    if (['/api/cart/order', '/api/cart/instant-quote', '/api/apparel-orders/22/re-order'].includes(u.pathname)) {
      return data({ id: 77, total: 123 });
    }
    throw new Error('Unexpected mock URL ' + u.pathname);
  };
  return { state, fetcher };
}

async function withServer(fn) {
  const { state, fetcher } = fixture();
  const { app, store } = createApp(config, { fetcher });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  let requestId = 0;
  const rpc = async (method, params = {}, token, headers = {}) => {
    const res = await fetch(base + '/mcp', { method: 'POST', headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers,
    }, body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }) });
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert(!body.error, JSON.stringify(body.error));
    return body.result;
  };
  const call = (name, args = {}, token, headers) => rpc('tools/call', { name, arguments: args }, token, headers);
  const run = async (...args) => {
    const result = await call(...args);
    assert(!result.isError, JSON.stringify(result.content));
    return result.structuredContent;
  };
  const prepare = async (name, args) => {
    const r = await run(name, args, 'customer');
    const widget = await call('show_action_review', { action_id: r.action_id }, 'customer');
    assert.equal(widget.structuredContent.status, 'pending');
    assert(!JSON.stringify(widget.structuredContent).includes(widget._meta.proof));
    assert(!JSON.stringify(widget.content).includes(widget._meta.proof));
    return { action_id: r.action_id, proof: widget._meta.proof, review: widget._meta.review };
  };
  const submit = ({ action_id, proof }, token = 'customer') => run('submit_reviewed_action', { action_id, proof }, token);
  try { await fn({ state, base, rpc, call, run, prepare, submit }); }
  finally { await new Promise(resolve => server.close(resolve)); store.close(); }
}

test('MCP discovery, resource metadata, app-only confirmation and no staff tools', async () => withServer(async ({ base, rpc }) => {
  const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.serverInfo.name, 'Wooter Apparel');
  const { tools } = await rpc('tools/list');
  assert.equal(tools.find(t => t.name === 'get_quote').securitySchemes[0].type, 'noauth');
  assert.equal(tools.find(t => t.name === 'get_cart').securitySchemes[0].type, 'oauth2');
  assert.deepEqual(tools.find(t => t.name === 'submit_reviewed_action')._meta.ui.visibility, ['app']);
  assert(!tools.some(t => /commission|lead|deal|crm/i.test(t.name)));
  const { resources: [resource] } = await rpc('resources/list');
  const { contents } = await rpc('resources/read', { uri: resource.uri });
  assert.match(contents[0].text, /event\.isTrusted/);
  assert.match(contents[0].text, /ui\/notifications\/tool-result/);
  const meta = await fetch(base + '/.well-known/oauth-protected-resource/mcp').then(r => r.json());
  assert.equal(meta.resource, config.publicMcpUrl);
  assert.deepEqual(meta.authorization_servers, ['https://wooter.com']);
  const rejected = await fetch(base + '/mcp', { method: 'POST', headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(rejected.status, 403);
}));

test('guest quote keeps USD and pricing discrepancy; blocks unpublished SKUs and low quantities', async () => withServer(async ({ run, call, state }) => {
  const products = await run('search_products', { q: 'soccer' });
  assert.equal(products.items.length, 1);
  const result = await run('get_quote', { items: [item], postal_code: '33127', country_code: 'US' });
  assert.equal(result.currency, 'USD');
  assert.equal(result.saved, false);
  assert.equal(result.shipping.postcode_based, false);
  assert.equal(result.prices.total, 117);
  assert.equal(result.reconciliation.total_verified, false);
  assert.equal(result.reconciliation.unexplained_difference, 5);
  assert(!JSON.stringify(result).includes('profit'));
  assert((await call('get_quote', { items: [{ ...item, quantity: 1 }] })).isError);
  assert((await call('get_quote', { items: [{ ...item, sku_id: 100 }] })).isError);
  assert.equal(state.guestCalls, 1);
  assert.equal(state.writes.length, 0);
}));

test('rejects untrusted identity headers, invalid tokens, wrong audience, staff and foreign records', async () => withServer(async ({ run, call }) => {
  for (const token of [undefined, 'inactive', 'wrong-audience', 'no-scope', 'expired', 'staff']) {
    const result = await call('get_cart', {}, token, { 'oai-authenticated-user-id': 'forged' });
    assert(result.isError);
    assert.match(result._meta['mcp/www_authenticate'][0], /resource_metadata=/);
  }
  assert((await run('connection_status', {}, 'customer')).connected);
  assert.equal((await run('shipping_addresses', {}, 'customer')).items[0].zip, '33127');
  assert.equal((await run('order_history', {}, 'customer')).items[0].id, 22);
  assert((await call('order_details', { order_id: 22 }, 'other')).isError);
  assert((await call('design_requests', {}, 'other')).isError);
  assert((await call('design_request_details', { design_request_id: 86900 }, 'other')).isError);
}));

test('cart, saved quote, order and reorder only write after review; duplicate confirm does not re-submit', async () => withServer(async ({ run, call, state, prepare, submit }) => {
  const p = await prepare('prepare_cart_items', { items: [item] });
  assert.equal(state.writes.length, 0);
  assert.equal(p.review.payload.items[0].name, sku.name);
  assert((await call('action_status', { action_id: p.action_id }, 'other')).isError);
  assert((await call('submit_reviewed_action', { action_id: p.action_id, proof: 'A'.repeat(43) }, 'customer')).isError);
  assert((await call('submit_reviewed_action', { action_id: p.action_id, proof: p.proof }, 'other')).isError);
  const first = await submit(p);
  assert.equal(first.status, 'completed');
  assert.equal(first.result.cart.items[0].quantity, 22);
  assert.equal((await submit(p)).status, 'completed');
  assert.equal(state.writes.length, 1);
  const quote = await prepare('prepare_quote', { name: 'Team quote' });
  assert.equal((await submit(quote)).status, 'completed');
  const order = await prepare('prepare_order', { name: 'Team order', location: address });
  assert.equal((await submit(order)).result.payment_charged, false);
  const reorder = await prepare('prepare_reorder', { order_id: 22, is_same_design: false });
  assert.equal((await submit(reorder)).status, 'completed');
  assert.deepEqual(state.writes.at(-1).body, { is_same_design: false });
  assert.equal((await run('action_status', { action_id: order.action_id }, 'customer')).status, 'completed');
}));

test('changed cart rejects review before write; simultaneous confirmations serialize', async () => withServer(async ({ state, prepare, submit, call }) => {
  const stale = await prepare('prepare_cart_items', { items: [item] });
  state.cart.prices.total = 42;
  assert.equal((await submit(stale)).status, 'rejected');
  assert.equal(state.writes.length, 0);
  const p = await prepare('prepare_cart_items', { items: [item] });
  state.slow = true;
  const replies = await Promise.all(Array.from({ length: 2 }, () =>
    call('submit_reviewed_action', { action_id: p.action_id, proof: p.proof }, 'customer')));
  assert(replies.some(r => r.structuredContent?.status === 'completed'));
  assert.equal(state.writes.length, 1);
}));

test('partial cart additions are not reported as success and are not retried', async () => withServer(async ({ state, prepare, submit }) => {
  state.partialCart = true;
  const p = await prepare('prepare_cart_items', { items: [item, { ...item, sku_id: 1369 }] });
  assert.equal((await submit(p)).status, 'unknown');
  assert.equal((await submit(p)).status, 'unknown');
  assert.equal(state.writes.length, 1);
}));

test('human design uses intake then request and the exact link; unknown results retain intake ID', async () => withServer(async ({ state, prepare, submit, run }) => {
  const brief = { name: 'Team kit', team_name: 'Team', primary_colors: ['Red'], description: 'Classic red kit',
    due_date: '2027-01-08', items: [item] };
  const p = await prepare('prepare_design_request', brief);
  assert.equal(p.review.payload.input.items[0].name, sku.name);
  assert.equal(state.writes.length, 0);
  const confirmed = await submit(p);
  assert.equal(confirmed.result.url, 'https://wooter.com/platform/design/request/86900/view');
  assert.equal(confirmed.result.instant_design_url, 'https://wooter.com/platform/instant-design/request/86900/view');
  assert.equal((await run('design_requests', {}, 'customer')).items[0].url, confirmed.result.url);
  state.failDesign = true;
  const second = await prepare('prepare_design_request', brief);
  const failure = await submit(second);
  assert.equal(failure.status, 'unknown');
  assert.equal(failure.result.form_id, 77);
  await submit(second);
  assert.equal(state.writes.length, 4);
}));

test('instant designs are Wooter templates, builder links and AI designer handoffs do not place an order', async () => withServer(async ({ state, run }) => {
  const styles = await run('list_instant_designs', { sku_id: sku.id });
  assert.equal(styles.designs.length, 1);
  assert.equal(styles.designs[0].texture_id, 41);
  assert.equal(styles.designs[0].preview_url, 'https://apparel-media.s3-accelerate.amazonaws.com/preview.png');
  assert.equal(styles.generated, false);
  assert.equal((await run('apparel_builder', { sku_id: sku.id })).builder_available, true);
  assert.equal((await run('wooter_designer', { brief: 'Red and black kit' })).generated, false);
  assert.equal(state.writes.length, 0);
}));

test('review data is encrypted and expires; retention removes only local records', () => {
  let now = 1_000_000;
  const store = new ReviewStore(':memory:', config.key, () => now);
  const owner = store.owner(7), p = store.prepare(owner, 'test', { address: 'Private shipping street' });
  assert(!Buffer.from(store.db.prepare('SELECT payload FROM reviews').get().payload).includes('Private shipping street'));
  assert.equal(store.get(store.owner(9), p.action_id), null);
  assert.equal(store.checkProof(owner, p.action_id, store.proof(owner, p.action_id)), true);
  now += 20 * 60_000;
  store.cleanup();
  assert.equal(store.get(owner, p.action_id).status, 'expired');
  assert.equal(store.db.prepare('SELECT payload FROM reviews').get().payload, null);
  now += 30 * 86_400_000;
  store.cleanup();
  assert.equal(store.get(owner, p.action_id), null);
  store.close();
});

test('config fails closed without introspection, exact resource or strong key', () => {
  assert.throws(() => loadConfig({ ...env, WOOTER_INTROSPECTION_URL: '' }));
  assert.throws(() => loadConfig({ ...env, PUBLIC_MCP_URL: config.publicMcpUrl + '/' }));
  assert.throws(() => loadConfig({ ...env, REVIEW_KEY_HEX: '1234' }));
});
