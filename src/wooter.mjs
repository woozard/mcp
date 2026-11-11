import { Buffer } from 'node:buffer';

export class UserError extends Error {}
export class AuthError extends UserError {}
export const currency = 'USD';
export const orderUrl = id => `https://wooter.com/platform/orders/${id}/order-form/overview`;
export const designUrl = id => `https://wooter.com/platform/design/request/${id}/view`;
export const studioUrl = id => `https://wooter.com/platform/instant-design/request/${id}/view`;
export const positiveId = n => Number.isSafeInteger(n) && n > 0;
export const unwrap = raw => raw?.data?.data ?? raw?.data ?? raw;
export const fields = (path, projection, params = {}) => {
  const qs = new URLSearchParams({ ...params, fields: projection });
  return path + '?' + qs;
};

export function safeHttps(value) {
  try {
    const u = new URL(value);
    if (u.protocol === 'https:' && !u.username && !u.password) return u;
  } catch {}
  return null;
}
export function wooterLink(value) {
  const u = safeHttps(value);
  return u && (u.hostname === 'wooter.com' || u.hostname.endsWith('.wooter.com') ||
    u.hostname === 'wooterapparel.com' || u.hostname.endsWith('.wooterapparel.com')) ? u.href : null;
}
export function previewLink(value) {
  const u = safeHttps(value);
  if (u?.hostname === 'apparel-media.s3-accelerate.amazonaws.com') return u.href;
  return wooterLink(value);
}
async function json(fetcher, url, init, timeout = 12_000) {
  const res = await fetcher(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
  if (!res.ok) return { status: res.status, data: null };
  // Limit upstream payloads and never surface/log upstream error bodies or credentials.
  const reader = res.body?.getReader();
  if (!reader) return { status: res.status, data: null };
  let bytes = 0;
  const chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 2_000_000) {
      await reader.cancel();
      throw new UserError('Wooter returned an unexpectedly large response.');
    }
    chunks.push(value);
  }
  const buffer = Buffer.concat(chunks);
  return { status: res.status, data: buffer.length ? JSON.parse(buffer.toString('utf8')) : null };
}

export function createWooter(config, fetcher = fetch) {
  async function api(path, { token, method = 'GET', body } = {}) {
    const base = new URL(config.apiBase);
    const url = new URL(path, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new Error('Invalid upstream route');
    const res = await json(fetcher, url, {
      method,
      headers: {
        Accept: 'application/json',
        Origin: new URL(config.issuer).origin,
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401 && token) throw new AuthError('Reconnect your Wooter account.');
    if (res.status < 200 || res.status >= 300) throw new UserError(`Wooter could not complete the request (HTTP ${res.status}).`);
    return res.data;
  }
  async function authenticate(header) {
    const match = /^Bearer ([A-Za-z0-9._~+/-]{1,4096}={0,2})$/i.exec(header ?? '');
    if (!match) throw new AuthError('Connect your Wooter customer account to continue.');
    const token = match[1];
    const basic = Buffer.from([config.introspectionId, config.introspectionSecret]
      .map(x => new URLSearchParams({ x }).toString().slice(2)).join(':')).toString('base64');
    const res = await json(fetcher, config.introspectionUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + basic, Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ token, token_type_hint: 'access_token' }),
    });
    if (res.status !== 200) throw new UserError('Wooter sign-in verification is temporarily unavailable.');
    const info = res.data;
    const audience = Array.isArray(info?.aud) ? info.aud : [info?.aud];
    if (info?.active !== true || info.iss !== config.issuer ||
        !audience.includes(config.publicMcpUrl) || typeof info.scope !== 'string' ||
        !info.scope.split(/\s+/).includes('customer') ||
        !Number.isFinite(info.exp) || info.exp <= Date.now() / 1000) {
      throw new AuthError('This connection is expired or is not authorized for the Wooter customer app.');
    }
    const profile = await api(fields('get-user',
      'id,email,first_name,last_name,customer_id,factory_id,user_role,customer{id},get_full_phone,country_calling{two_letter_code}'), { token });
    const user = profile?.user ?? unwrap(profile)?.user;
    const customerId = user?.customer_id ?? user?.customer?.id;
    if (!positiveId(customerId) || (user?.customer?.id != null && user.customer.id !== customerId) || user?.factory_id ||
        !config.customerRoles.includes(String(user?.user_role ?? '').toLowerCase())) {
      throw new AuthError('Sign in with a Wooter customer account.');
    }
    return { token, customerId, user };
  }
  return { api, authenticate };
}

const priceKeys = ['subtotal', 'total', 'tax', 'shipping_cost', 'bulk_discount', 'addon_cost',
  'discount', 'processing_fees', 'shipping_method_adds', 'marketplace_customer_service_charge', 'coupon_discount', 'duties_cost'];
export function amount(value) {
  const n = typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e9 ? n : null;
}
export function prices(record) {
  return Object.fromEntries(priceKeys.map(k => [k, amount(record?.[k])]).filter(([, v]) => v !== null));
}
export function reconciliation(p) {
  const keys = ['subtotal', 'shipping_cost', 'tax', 'addon_cost', 'shipping_method_adds',
    'processing_fees', 'marketplace_customer_service_charge'];
  if (p.duties_cost != null) keys.push('duties_cost');
  const missing_components = keys.filter(key => p[key] == null);
  const sum = keys.reduce((total, key) => total + Math.round((p[key] ?? 0) * 100), 0);
  const diff = Math.round(p.total * 100) - sum;
  return {
    total_verified: missing_components.length === 0 && Math.abs(diff) <= 1,
    returned_components_total: sum / 100, unexplained_difference: diff / 100, missing_components,
  };
}
