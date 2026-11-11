import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { UserError, amount, currency, designUrl, fields, orderUrl, positiveId, prices,
  previewLink, reconciliation, studioUrl, unwrap, wooterLink } from './wooter.mjs';

const id = z.number().int().positive();
const qty = id.max(10_000);
const str = (max = 150) => z.string().trim().min(1).max(max);
const page = id.max(1000).default(1);
const action = z.uuid();
const item = z.strictObject({ sku_id: id, quantity: qty });
const items = z.array(item).min(1).max(20);
const location = z.strictObject({
  country_id: id, address_1: str(250), address_2: str(250).optional(),
  city_name: str(), state: str(), zip: str(30), name: str().optional(),
});
const cartFields = 'id,items{id,sku_id,model_id,quantity,sku{id,name}},prices{subtotal,tax,total,shipping_cost,discount,duties_cost}';
const orderFields = 'id,name,customer_id,status,total,subtotal,tax,shipping_cost,placement_date,shipping_address,items{id,sku_id,quantity,sku{id,name}}';
const designFields = 'id,name,status,due_date,team_name,customer{id},drafts{id,items{id,sku_id,quantity,sku{id,name}}}';
const productFields = 'id,name,slug,published,minimum_order_quantity,category_id,subcategory_id';
const quoteFields = 'prices{subtotal,total,tax,shipping_cost,bulk_discount,addon_cost,discount,processing_fees,shipping_method_adds,marketplace_customer_service_charge,coupon_discount,duties_cost,items{type_id,type,quantity,price_single}}';
const info = 'Prices are USD. Shipping and tax are not verified for the destination.';
const review = ' No Wooter change is made until the customer confirms the review card. Call show_action_review with the returned action_id.';

const list = (data, label) => {
  if (!Array.isArray(data?.items)) throw new UserError(`Wooter did not return a valid ${label} list.`);
  return data.items;
};
const duplicate = lines => new Set(lines.map(x => x.sku_id)).size !== lines.length;
const cleanText = (s, max = 500) => typeof s === 'string' ? s.slice(0, max) : null;
const validSlug = s => typeof s === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(s);
const orderLine = i => ({ sku_id: i.sku_id, quantity: i.quantity, name: cleanText(i.sku?.name) });
const safeAddress = a => a && typeof a === 'object' ? Object.fromEntries(
  ['name', 'address_1', 'address_2', 'city_name', 'state', 'zip', 'country_id'].filter(k => ['string','number'].includes(typeof a[k])).map(k => [k, a[k]])
) : cleanText(a);

function cartData(raw) {
  const cart = unwrap(raw);
  const lines = list(cart, 'cart item');
  if (lines.some(i => !positiveId(i.id) || !positiveId(i.quantity))) throw new UserError('Wooter returned invalid cart items.');
  return {
    id: cart.id ?? null,
    items: lines.map(i => ({ id: i.id, ...orderLine(i), model_id: i.model_id ?? null })),
    prices: prices(cart.prices),
  };
}
function checkAddition(before, after, items) {
  const counts = lines => {
    const m = new Map();
    for (const l of lines) {
      if (!positiveId(l.sku_id)) throw new UserError('Wooter returned an unsupported cart item.');
      m.set(l.sku_id, (m.get(l.sku_id) ?? 0) + l.quantity);
    }
    return m;
  };
  const expected = counts(before.items), actual = counts(after.items);
  for (const i of items) expected.set(i.sku_id, (expected.get(i.sku_id) ?? 0) + i.quantity);
  if (!positiveId(after.id) || expected.size !== actual.size || [...expected].some(([k, v]) => actual.get(k) !== v)) {
    throw new UserError('Wooter did not confirm every cart addition. Check your cart before trying again.');
  }
}

export function createTools({ api, store, signupUrl }) {
  const tools = Object.create(null);
  const add = (name, schema, description, run, opts = {}) => {
    tools[name] = { schema, description, run, guest: false, readOnly: true, ...opts };
  };
  const read = async (path, options) => unwrap(await api(path, options));
  const customer = c => ({ token: c.token });
  const cart = async c => cartData(await api(fields('cart', cartFields), customer(c)));
  const product = async sku => {
    const p = await read(fields('apparel-skus/' + sku, productFields));
    if (p?.id !== sku || p.published !== true) throw new UserError('Choose a published product from search_products.');
    return p;
  };
  const verifiedItems = async input => {
    if (duplicate(input)) throw new UserError('Combine duplicate SKUs into one line.');
    return Promise.all(input.map(async line => {
      const p = await product(line.sku_id);
      if (positiveId(p.minimum_order_quantity) && line.quantity < p.minimum_order_quantity) {
        throw new UserError(`${p.name} requires at least ${p.minimum_order_quantity} units.`);
      }
      return { ...line, name: cleanText(p.name), category_id: p.category_id ?? null, subcategory_id: p.subcategory_id ?? null };
    }));
  };
  const ownOrder = async (orderId, c) => {
    const o = await read(fields('apparel-orders/' + orderId, orderFields), customer(c));
    if (o?.id !== orderId || o.customer_id !== c.customerId) throw new UserError('Wooter did not confirm this order belongs to your account.');
    return formatOrder(o);
  };
  const formatOrder = o => ({
    id: o.id, name: cleanText(o.name), status: o.status ?? null, currency,
    prices: prices(o), shipping_address: safeAddress(o.shipping_address), placement_date: o.placement_date ?? null,
    items: Array.isArray(o.items) ? o.items.map(orderLine) : [], url: orderUrl(o.id),
  });
  const formatDesign = d => ({
    id: d.id, name: cleanText(d.name), team_name: cleanText(d.team_name), status: d.status,
    requested_due_date: d.due_date, items: (d.drafts?.[0]?.items ?? []).map(orderLine),
    url: designUrl(d.id), instant_design_url: studioUrl(d.id),
  });
  const ownDesign = async (designId, c) => {
    const d = await read(fields('apparel-design-requests/' + designId, designFields), customer(c));
    if (d?.id !== designId || d.customer?.id !== c.customerId) throw new UserError('Wooter did not confirm this design request belongs to your account.');
    return formatDesign(d);
  };
  const palette = async () => {
    const raw = await read('apparel-colors');
    const rows = Array.isArray(raw) ? raw : Object.values(raw ?? {}).flat();
    return rows.filter(c => positiveId(c?.id) && typeof c.name === 'string').map(c => ({
      id: c.id, name: c.name, hex: cleanText(c.hex, 12), pantone_code: cleanText(c.pantone_code, 30),
    }));
  };
  const prep = (kind, schema, description, prepare) => add(kind, schema, description + review,
    async (a, c) => store.prepare(c.owner, kind, await prepare(a, c)), { readOnly: false });

  add('search_products', z.strictObject({ q: str().optional(), page }), 'Find published Wooter products. Resolve the exact styles and use returned SKU IDs.', async a => {
    const raw = await read(fields('apparel-skus', productFields, { published: 1, limit: 12, offset: (a.page - 1) * 12, q: a.q ?? '' }));
    return { items: list(raw, 'product').filter(p => positiveId(p.id) && p.published === true).map(p => ({
      sku_id: p.id, name: cleanText(p.name), minimum_order_quantity: p.minimum_order_quantity,
    })), page: a.page };
  }, { guest: true });
  add('product_details', z.strictObject({ sku_id: id }), 'Check a published Wooter SKU and its minimum quantity.', async a => {
    const p = await product(a.sku_id);
    return { sku_id: p.id, name: cleanText(p.name), minimum_order_quantity: p.minimum_order_quantity };
  }, { guest: true });
  add('countries', z.strictObject({}), 'Find Wooter shipping country IDs.', async () => {
    const raw = await read('countries');
    return { items: (Array.isArray(raw) ? raw : list(raw, 'country')).map(c => ({
      id: c.id, name: c.name, code: c.two_letter_code ?? c.code,
    })) };
  }, { guest: true });
  add('design_colors', z.strictObject({}), 'Find exact Wooter color names, hex and Pantone codes.', async () => ({ colors: await palette() }), { guest: true });
  add('get_quote', z.strictObject({ items, postal_code: str(20).optional(), country_code: z.string().regex(/^[A-Z]{2}$/).optional() }),
    'Live USD guest estimate. Include each garment in a set. No cart changes. Do not claim destination-verified shipping or present an unreconciled total as final; bulk discounts are already included.', async a => {
      const products = await verifiedItems(a.items);
      const raw = await read(fields('cart', quoteFields, { preview: 'true' }), { method: 'POST', body: {
        items: a.items.map((i, k) => ({ ...i, id: k + 1, model_id: i.sku_id, model_type: 'sku' })),
      } });
      const p = prices(raw?.prices);
      const rawLines = raw?.prices?.items;
      const lines = a.items.map(i => {
        const matches = (Array.isArray(rawLines) ? rawLines : []).filter(x =>
          Number(x.type_id) === i.sku_id && Number(x.quantity) === i.quantity && (x.type == null || x.type === 'sku'));
        const unit = matches.length === 1 ? amount(matches[0].price_single) : null;
        if (unit === null || unit < 0) throw new UserError('Wooter did not return a verifiable price for every requested SKU.');
        return { sku_id: i.sku_id, quantity: i.quantity, price_single: unit };
      });
      if (p.total == null || rawLines.length !== a.items.length) throw new UserError('Wooter did not return a complete estimate.');
      return { currency, estimate: true, saved: false, products, prices: { ...p, items: lines },
        destination: { postal_code: a.postal_code ?? null, country_code: a.country_code ?? null },
        shipping: { amount: p.shipping_cost ?? null, postcode_based: false, destination_verified: false },
        reconciliation: reconciliation(p), notice: info };
    }, { guest: true });
  add('connection_status', z.strictObject({}), 'Verify the active Wooter customer OAuth connection. Reconnect when needed.', async () => ({
    connected: true, guest_quotes_available: true,
  }));
  add('account_help', z.strictObject({}), 'Give secure Wooter links for customer sign-in and account creation. Never ask for passwords in chat.',
    async () => ({ sign_in_url: 'https://wooter.com/platform/sign-in', signup_url: signupUrl ?? null,
      next_step: 'Create or sign in to your account on Wooter, then connect the Wooter app in ChatGPT.' }), { guest: true });
  add('get_cart', z.strictObject({}), 'Read the connected Wooter customer’s cart. Do not invent missing prices.', async (_, c) => ({ ...await cart(c), currency }));
  add('shipping_addresses', z.strictObject({}), 'Read saved shipping addresses of the connected customer; use only for the requested checkout.', async (_, c) => {
    const raw = await read('apparel-customers/shipping-locations', customer(c));
    return { items: (Array.isArray(raw) ? raw : list(raw, 'shipping address')).map(safeAddress) };
  });
  add('order_history', z.strictObject({ page }), 'List only the connected customer’s Wooter orders and statuses.', async (a, c) => {
    const raw = await read(fields('apparel-orders', orderFields, { customer_id: c.customerId, limit: 12, offset: (a.page - 1) * 12 }), customer(c));
    const rows = list(raw, 'order');
    if (rows.some(x => x.customer_id !== c.customerId || !positiveId(x.id))) throw new UserError('Wooter did not verify ownership of the order list.');
    return { items: rows.map(formatOrder), page: a.page };
  });
  add('order_details', z.strictObject({ order_id: id }), 'Read a single order only if it belongs to the connected customer.', (a, c) => ownOrder(a.order_id, c));
  add('design_requests', z.strictObject({ page }), 'List the connected customer’s design requests. Check for duplicates after an unknown submission.', async (a, c) => {
    const raw = await read(fields('apparel-design-requests', designFields, { customer_id: c.customerId, limit: 12, offset: (a.page - 1) * 12 }), customer(c));
    const rows = list(raw, 'design request');
    if (rows.some(x => x.customer?.id !== c.customerId || !positiveId(x.id))) throw new UserError('Wooter did not verify ownership of the design request list.');
    return { items: rows.map(formatDesign), page: a.page };
  });
  add('design_request_details', z.strictObject({ design_request_id: id }), 'Read a verified customer-owned design request and its studio link.',
    (a, c) => ownDesign(a.design_request_id, c));
  add('list_instant_designs', z.strictObject({ sku_id: id, limit: id.max(8).default(6) }),
    'Browse Wooter’s real Instant Design templates for a product. Does not generate artwork, attach a design or place an order.', async a => {
      const p = await product(a.sku_id);
      if (!validSlug(p.slug)) throw new UserError('Wooter did not provide a builder slug for this product.');
      const params = new URLSearchParams({
        model_dimension: '2d', limit: String(a.limit), offset: '0', order_by: 'top_sold', order_direction: 'asc',
        'virtual_product_slugs[]': p.slug,
        return_only: 'sku_id,texture_id,title,preview_url,sku{id,name,slug}',
      });
      const raw = await read('apparel-builder-skus?' + params);
      const rows = list(raw, 'instant design').filter(x =>
        positiveId(x.texture_id) && Number(x.sku_id ?? x.sku?.id) === p.id);
      return { sku_id: p.id, product_name: cleanText(p.name), designs: rows.slice(0, a.limit).map(x => ({
        texture_id: x.texture_id, title: cleanText(x.title), preview_url: previewLink(x.preview_url),
      })), ai_designer_url: 'https://mcp.wooter.com/chat/', generated: false, saved: false,
      notice: 'Browse styles here. Open Wooter’s designer to customize. If you already have a design request, use its Instant Design Studio link.' };
    }, { guest: true });
  add('apparel_builder', z.strictObject({ sku_id: id }), 'Check Wooter builder availability and link to the exact product page or builder entry.', async a => {
    const p = await product(a.sku_id);
    if (!validSlug(p.slug)) throw new UserError('Wooter did not provide a product link for this SKU.');
    const params = new URLSearchParams({ limit: '8', 'virtual_product_slugs[]': p.slug, return_only: 'sku_id,sku{id,slug},product_url' });
    const raw = await read('apparel-builder-skus?' + params);
    const match = list(raw, 'builder product').find(x => Number(x.sku_id ?? x.sku?.id) === p.id);
    const url = wooterLink(match?.product_url) ?? 'https://wooter.com/products/' + p.slug;
    return { sku_id: p.id, name: p.name, builder_available: !!match, url,
      notice: match ? 'Open Wooter to customize this product.' : 'Builder support was not verified. This is the Wooter product page.' };
  }, { guest: true });
  add('wooter_designer', z.strictObject({ brief: str(5000) }), 'Send the customer to Wooter’s own AI designer with their draft brief. Do not say it generated a design in ChatGPT.',
    async a => ({ url: 'https://mcp.wooter.com/chat/', brief: a.brief, generated: false, saved: false,
      notice: 'Open the Wooter AI designer and paste your brief.' }), { guest: true });

  prep('prepare_cart_items', z.strictObject({ items }), 'Review adding one or several published SKUs to the current cart.',
    async (a, c) => ({ items: await verifiedItems(a.items), cart: await cart(c) }));
  prep('prepare_quote', z.strictObject({ name: str(), location: location.optional(), notes: str(2000).optional() }),
    'Review saving a quote for the entire current cart, separate from the guest estimate.', async (a, c) => {
      const snapshot = await cart(c);
      if (!snapshot.items.length) throw new UserError('Your cart is empty.');
      return { input: a, cart: snapshot };
    });
  prep('prepare_order', z.strictObject({ name: str(), location, notes: str(2000).optional() }),
    'Review an unpaid order for the entire cart and the supplied shipping address. Does not charge payment or approve production.', async (a, c) => {
      const snapshot = await cart(c);
      if (!snapshot.items.length) throw new UserError('Your cart is empty.');
      return { input: a, cart: snapshot };
    });
  prep('prepare_reorder', z.strictObject({ order_id: id, is_same_design: z.boolean() }),
    'Review duplicating the full original order. Ask the customer to choose same or new designs. Original quantities and shipping carry forward; current prices and production are not confirmed.', async (a, c) => {
      const order = await ownOrder(a.order_id, c);
      if (!order.items.length || !order.shipping_address) throw new UserError('Wooter did not return enough original order details for a safe reorder.');
      return { input: a, order };
    });
  prep('prepare_design_request', z.strictObject({
    team_name: str(), name: str(), due_date: z.iso.date().optional(), description: str(5000),
    primary_colors: z.array(str(40)).min(1).max(8), secondary_colors: z.array(str(40)).max(8).optional(), items,
  }), 'Review a brief for Wooter’s human designers. Keep due_date separate from the artwork description. It is not a guaranteed delivery date.', async (a, c) => {
    const colors = await palette();
    const resolve = names => names.map(name => {
      const match = colors.filter(x => x.name.toLowerCase() === name.toLowerCase());
      if (match.length !== 1) throw new UserError('Choose the exact Wooter color name from design_colors.');
      return { id: match[0].id };
    });
    intakeProfile(c);
    return { input: { ...a, items: await verifiedItems(a.items) },
      primary_colors: resolve(a.primary_colors), secondary_colors: resolve(a.secondary_colors ?? []) };
  });
  function intakeProfile(c) {
    const u = c.user, phone = String(u?.get_full_phone ?? '').replace(/\D/g, '');
    const country = u?.country_calling?.two_letter_code;
    if (!u?.email || !/^[0-9]{7,20}$/.test(phone) || !/^[A-Z]{2}$/.test(country ?? '')) {
      throw new UserError('Add a valid email, phone and phone country in your Wooter profile before sending a design request.');
    }
    return { email: u.email, name: [u.first_name, u.last_name].filter(Boolean).join(' '),
      phone_number: phone, phone_country_calling_alpha2: country };
  }
  function ownedAction(c, actionId) {
    const row = store.get(c.owner, actionId);
    if (!row) throw new UserError('Review not found for this customer.');
    return row;
  }
  add('show_action_review', z.strictObject({ action_id: action }), 'Show the current customer’s action review card. Only its confirmation button can submit.',
    async (a, c) => {
      const row = ownedAction(c, a.action_id);
      // Review contents and confirmation proof are for the UI only.
      return { output: { action_id: row.action_id, kind: row.kind, status: row.status },
        meta: { review: row, ...(row.status === 'pending' ? { proof: store.proof(c.owner, a.action_id) } : {}) } };
    }, { widget: 'review' });
  add('action_status', z.strictObject({ action_id: action }), 'Check verified action status. Never retry an unknown outcome automatically.', async (a, c) => {
    const { payload, ...result } = ownedAction(c, a.action_id);
    return result;
  });
  add('submit_reviewed_action', z.strictObject({ action_id: action, proof: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
    'UI only: Submit after the customer clicks Confirm on the review card.', async (a, c) => {
      if (!store.checkProof(c.owner, a.action_id, a.proof)) throw new UserError('Confirm from the original review card.');
      const row = ownedAction(c, a.action_id);
      if (row.status !== 'pending') return { status: row.status, result: row.result };
      if (!store.claim(c.owner, a.action_id)) throw new UserError('A review is processing or has expired. Check its status before trying again.');
      const p = row.payload;
      let writeStarted = false, formId = null;
      const post = (route, body) => {
        writeStarted = true;
        return read(route, { token: c.token, method: 'POST', body });
      };
      try {
        if (p.cart && !isDeepStrictEqual(await cart(c), p.cart)) throw new UserError('Your cart changed. Prepare a fresh review.');
        if (p.order && !isDeepStrictEqual(await ownOrder(p.input.order_id, c), p.order)) throw new UserError('The original order changed. Prepare a fresh review.');
        let result;
        if (row.kind === 'prepare_cart_items') {
          await post('cart/items', { items: p.items.map(i => ({
            sku_id: i.sku_id, quantity: i.quantity, model_type: 'sku', model_id: i.sku_id,
          })) });
          const after = await cart(c);
          checkAddition(p.cart, after, p.items);
          result = { cart_id: after.id, cart: after, currency, added: true, order_created: false };
        } else if (row.kind === 'prepare_design_request') {
          const input = p.input;
          const intake = await post('form-submissions', { form_type_id: 3, ...intakeProfile(c),
            organization_name: input.team_name, ...(input.due_date ? { due_date: input.due_date } : {}),
            min_quantity: Math.min(...input.items.map(i => i.quantity)), max_quantity: Math.max(...input.items.map(i => i.quantity)) });
          if (!positiveId(intake?.form_id)) throw new UserError('Wooter did not confirm the design intake.');
          formId = intake.form_id;
          const created = await post(fields('apparel-design-requests', 'id,name,status'), { ...input,
            form_id: formId, primary_colors: p.primary_colors, secondary_colors: p.secondary_colors });
          if (!positiveId(created?.id)) throw new UserError('Wooter did not return a design request ID.');
          result = { id: created.id, name: cleanText(created.name ?? input.name), sent: true,
            url: designUrl(created.id), instant_design_url: studioUrl(created.id) };
        } else {
          const route = { prepare_order: 'cart/order', prepare_quote: 'cart/instant-quote',
            prepare_reorder: 'apparel-orders/' + p.input.order_id + '/re-order' }[row.kind];
          if (!route) throw new Error('Unexpected review kind');
          const created = await post(fields(route, 'id,name,status,total,subtotal,tax,shipping_cost'),
            row.kind === 'prepare_reorder' ? { is_same_design: p.input.is_same_design } : p.input);
          if (!positiveId(created?.id) || created.id === p.input.order_id) throw new UserError('Wooter did not return a new order or quote ID.');
          result = { id: created.id, name: cleanText(created.name), currency, prices: prices(created),
            payment_charged: false, url: orderUrl(created.id),
            notice: 'Review current prices, shipping, artwork and roster on Wooter before payment or production.' };
        }
        store.finish(c.owner, a.action_id, 'completed', result);
        return { status: 'completed', result };
      } catch (err) {
        const status = writeStarted ? 'unknown' : 'rejected';
        const result = { message: writeStarted
          ? 'Wooter did not return a verified result. Check Wooter or contact support before submitting again.'
          : err instanceof UserError ? err.message : 'Wooter could not verify the review. No write was attempted.',
          ...(formId ? { form_id: formId } : {}) };
        store.finish(c.owner, a.action_id, status, result);
        return { status, result };
      }
    }, { readOnly: false, widget: 'submit' });
  return tools;
}
