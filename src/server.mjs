import express from 'express';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AuthError, UserError, createWooter, safeHttps, wooterLink } from './wooter.mjs';
import { ReviewStore } from './state.mjs';
import { createTools } from './tools.mjs';

const uri = 'ui://wooter/customer-review.html';
const mimeType = 'text/html;profile=mcp-app';
const html = readFileSync(new URL('./review.html', import.meta.url), 'utf8');
const oauth = { type: 'oauth2', scopes: ['customer'] };
const instructions = [
  'Help customers browse, quote, design and order Wooter apparel in ChatGPT.',
  'Use get_quote for live guest USD estimates. Do not claim ZIP-based shipping. If totals do not reconcile, label prices estimates.',
  'Connect via Wooter OAuth for private records and cart/order/design actions. Never ask for a password, OAuth token or card information in chat.',
  'Resolve real published SKUs, prepare the requested change and always display show_action_review. Do not invoke the UI-only confirmation tool.',
  'The customer clicks Confirm. Use action_status for confirmed outcomes. Unknown results may have written to Wooter. Do not retry them automatically.',
  'For instant designs use list_instant_designs. For a Wooter AI concept use wooter_designer. For DIY use apparel_builder. Do not claim artwork was generated in chat.',
  'Orders are unpaid. Wooter handles payment, artwork approvals and production.',
].join(' ');

export function loadConfig(env = process.env) {
  const required = key => {
    if (!env[key]?.trim()) throw new Error(key + ' is required.');
    return env[key].trim();
  };
  const url = (key, value) => {
    const parsed = safeHttps(value);
    if (!parsed || parsed.hash || parsed.search) throw new Error(key + ' must be an HTTPS URL without query, fragment or credentials.');
    return parsed;
  };
  const publicMcpUrl = required('PUBLIC_MCP_URL');
  const resource = url('PUBLIC_MCP_URL', publicMcpUrl);
  if (resource.href !== publicMcpUrl || resource.pathname !== '/mcp') throw new Error('PUBLIC_MCP_URL must end in exactly /mcp, no trailing slash.');
  const issuer = env.WOOTER_ISSUER ?? 'https://wooter.com';
  const issuerUrl = url('WOOTER_ISSUER', issuer);
  if (issuerUrl.origin !== issuer) throw new Error('WOOTER_ISSUER must be an HTTPS origin, with no trailing slash.');
  const apiBase = url('WOOTER_API_BASE', env.WOOTER_API_BASE ?? 'https://wooter.com/api/').href;
  if (!apiBase.endsWith('/')) throw new Error('WOOTER_API_BASE must end with a slash.');
  const introspectionUrl = url('WOOTER_INTROSPECTION_URL', required('WOOTER_INTROSPECTION_URL'));
  if (introspectionUrl.origin !== issuer) throw new Error('Introspection must be hosted by the configured Wooter issuer.');
  const keyHex = required('REVIEW_KEY_HEX');
  if (!/^[a-fA-F0-9]{64}$/.test(keyHex)) throw new Error('REVIEW_KEY_HEX must contain exactly 64 hex digits.');
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  const signupUrl = env.WOOTER_SIGNUP_URL ? wooterLink(env.WOOTER_SIGNUP_URL) : null;
  if (env.WOOTER_SIGNUP_URL && !signupUrl) throw new Error('WOOTER_SIGNUP_URL must use a Wooter HTTPS domain.');
  const roles = (env.WOOTER_CUSTOMER_ROLES ?? 'customer').split(',').map(s => s.trim().toLowerCase());
  if (roles.some(r => !['customer', 'wholesaler', 'vip customer'].includes(r))) throw new Error('Only supported customer roles may be configured.');
  return {
    publicMcpUrl, issuer, apiBase, signupUrl, port, customerRoles: roles,
    introspectionUrl: introspectionUrl.href,
    introspectionId: required('WOOTER_INTROSPECTION_CLIENT_ID'),
    introspectionSecret: required('WOOTER_INTROSPECTION_CLIENT_SECRET'),
    key: Buffer.from(keyHex, 'hex'), dbPath: env.DB_PATH ?? './state/reviews.sqlite',
    bindHost: env.BIND_HOST ?? '127.0.0.1',
  };
}

export function createApp(config, { store = new ReviewStore(config.dbPath, config.key), fetcher = fetch } = {}) {
  const app = express();
  app.disable('x-powered-by');
  const { api, authenticate } = createWooter(config, fetcher);
  const tools = createTools({ api, store, signupUrl: config.signupUrl });
  const resource = new URL(config.publicMcpUrl);
  const metaPath = '/.well-known/oauth-protected-resource/mcp';
  const challenge = `Bearer resource_metadata="${resource.origin + metaPath}", scope="customer"`;
  const descriptors = Object.entries(tools).map(([name, t]) => {
    const securitySchemes = [t.guest ? { type: 'noauth' } : oauth];
    const ui = t.widget === 'review' ? { resourceUri: uri, visibility: ['model'] }
      : t.widget === 'submit' ? { visibility: ['app'] } : undefined;
    return {
      name, description: t.description, inputSchema: z.toJSONSchema(t.schema, { target: 'draft-07', io: 'input' }),
      securitySchemes, annotations: {
        readOnlyHint: t.readOnly, destructiveHint: t.widget === 'submit',
        idempotentHint: t.readOnly, openWorldHint: true,
      },
      _meta: { securitySchemes, ...(ui ? { ui } : {}),
        ...(t.widget === 'review' ? { 'openai/outputTemplate': uri } : {}),
        ...(t.widget === 'submit' ? { 'openai/widgetAccessible': true } : {}) },
    };
  });
  const result = (output, meta) => ({ structuredContent: output,
    content: [{ type: 'text', text: JSON.stringify(output) }], ...(meta ? { _meta: meta } : {}) });
  const failure = (message, meta) => ({ isError: true, content: [{ type: 'text', text: message }], ...(meta ? { _meta: meta } : {}) });

  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    next();
  });
  app.get([metaPath, '/.well-known/oauth-protected-resource'], (_req, res) => res.json({
    resource: config.publicMcpUrl, authorization_servers: [config.issuer],
    scopes_supported: ['customer'], bearer_methods_supported: ['header'], resource_name: 'Wooter Apparel',
  }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.post('/mcp', (req, res, next) => {
    // A browser Origin is optional for normal server-to-server MCP. Reject cross-origin browser posts.
    const origin = req.get('origin');
    if (origin && origin !== resource.origin) return res.status(403).json({ error: 'Origin not allowed' });
    if (!req.is('application/json')) return res.status(415).json({ error: 'Use application/json' });
    next();
  }, express.json({ limit: '64kb' }), async (req, res) => {
    if (Array.isArray(req.body)) return res.status(400).json({
      jsonrpc: '2.0', id: null, error: { code: -32600, message: 'JSON-RPC batching is not supported' },
    });
    // Fresh transport per request: no shared session or identity state.
    const server = new Server({ name: 'Wooter Apparel', version: '1.0.0' },
      { capabilities: { tools: {}, resources: {} }, instructions });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void server.close().catch(() => {}); });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: descriptors }));
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri, name: 'Wooter action review', mimeType }] }));
    server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
      if (params.uri !== uri) throw new Error('Unknown resource');
      return { contents: [{ uri, mimeType, text: html,
        _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [], baseUriDomains: [] } } } }] };
    });
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const tool = tools[params.name];
      if (!tool) return failure('Unknown Wooter tool.');
      const parsed = tool.schema.safeParse(params.arguments ?? {});
      if (!parsed.success) return failure('Check the required tool fields and try again.');
      try {
        let context;
        if (!tool.guest) {
          const profile = await authenticate(req.get('authorization'));
          context = { ...profile, owner: store.owner(profile.customerId) };
        }
        const out = await tool.run(parsed.data, context);
        return tool.widget === 'review' ? result(out.output, out.meta) : result(out);
      } catch (error) {
        if (error instanceof AuthError) return failure(error.message, { 'mcp/www_authenticate': [challenge] });
        if (error instanceof UserError) return failure(error.message);
        console.warn('wooter_tool_failed', { tool: params.name });
        return failure('Wooter could not complete the request. Try again later.');
      }
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({
        jsonrpc: '2.0', id: null, error: { code: -32603, message: 'MCP request failed' },
      });
    }
  });
  app.all('/mcp', (_req, res) => res.set('Allow', 'POST').status(405).end());
  app.use((error, _req, res, _next) => {
    const status = error.status === 413 ? 413 : 400;
    res.status(status).json({ jsonrpc: '2.0', id: null,
      error: { code: -32700, message: status === 413 ? 'Request too large' : 'Invalid request' } });
  });
  return { app, store };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  const config = loadConfig();
  const { app, store } = createApp(config);
  store.cleanup();
  const cleanup = setInterval(() => {
    try { store.cleanup(); } catch { console.warn('wooter_review_cleanup_failed'); }
  }, 5 * 60_000);
  cleanup.unref();
  const server = app.listen(config.port, config.bindHost, () => console.log('Wooter customer MCP listening'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    clearInterval(cleanup);
    server.close(() => store.close());
  });
}
