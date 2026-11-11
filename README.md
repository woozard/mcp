# Wooter Apparel Customer MCP

A standalone customer MCP server for ChatGPT. This is server source, not a plugin submission ZIP. It does not replace the existing Wooter staff MCP, the working private ChatGPT app, or the Wooter storefront. The server has no customer-facing website and no access to the staff database, CRM, sales tools, or service-account token minting.

| Customer task | Behavior |
| --- | --- |
| Browse or quote | Published SKU search, minimum quantities, live USD guest estimates. Cart preview is not a write. Shipping is not a ZIP-specific rate and inconsistent totals are flagged. |
| Connect an account | ChatGPT's OAuth flow uses Wooter's hosted login. Guest browsing and quotes do not require sign-in. Account creation, passwords, and payment stay on Wooter. |
| Build a cart | Read the signed-in customer's cart and saved addresses. Add one or several products after reviewing names and quantities. Verify the resulting quantities. |
| Save a quote or order | Review the full cart, notes and shipping. Create a saved quote or an unpaid order after confirmation. Payment and production approval happen on Wooter. |
| Track or reorder | List customer-owned orders, view order details, and review a full reorder with same or new designs. Current prices and delivery are not guaranteed. |
| Instant Design | Fetch real Wooter templates and preview links by verified SKU. An owned design request links to Wooter's Instant Design Studio. Selecting a template here does not create an order or attach artwork. |
| Design Request | Review the artwork brief, exact Wooter colors, products and a separate requested date. Submit Wooter's intake and design request only after confirmation. Show the verified request link and status. |
| Apparel Builder and AI designer | Return the verified Wooter product link for DIY customization and the Wooter designer link with a brief. New AI artwork generation runs on Wooter, not through this MCP. |

## Run locally

Node.js 24 or newer. Copy `.env.example` to `.env`, fill the settings below, and use a dedicated Wooter staging issuer/API for authenticated integration testing.

```sh
npm ci
npm test
npm start
```

The tests start a real local HTTP MCP server and mock Wooter's OAuth and API. They do not create live orders, quotes or design requests.

## Wooter OAuth deployment contract

1. Choose a **dedicated** public HTTPS endpoint, for example `https://customer-mcp.wooter.com/mcp`. Set that exact URL as `PUBLIC_MCP_URL` and register it as an allowed OAuth resource in Wooter. The existing staff endpoint is not the customer server.
2. Wooter must serve OAuth Authorization Server Metadata for the configured issuer (production: `https://wooter.com/.well-known/oauth-authorization-server`). It should advertise the actual authorization and token endpoints, authorization code with PKCE S256, supported client authentication, and the `customer` scope. The Wooter authorization page should send logged-out users to the Wooter sign-in page and resume OAuth on success.
3. This server serves RFC 9728 Protected Resource Metadata at `/.well-known/oauth-protected-resource/mcp` and advertises mixed guest/customer authorization by tool. Register the **exact redirect URI shown by the ChatGPT connection setup** with Wooter. Do not reuse the old Sites callback or assume its client credentials apply to this app. Configure the new ChatGPT OAuth client in the connection editor, never in the source or ZIP.
4. Configure a Wooter-hosted **RFC 7662 introspection endpoint** and dedicated client credentials in the server's secret manager. The server authenticates introspection with HTTP Basic and sends only the caller's access token to that Wooter endpoint. Active responses must include `active: true`, `iss` equal to `WOOTER_ISSUER`, `aud` containing the exact MCP URL, `scope` containing `customer`, and numeric Unix-seconds `exp`. Issuance and introspection must exclude staff/factory roles, including users with overlapping staff and customer roles. The server fails closed if any check is missing. The introspection URL and credentials are deployment inputs, not claims that Wooter has provisioned them.
5. The same access token must work against Wooter's `GET /api/get-user` and the customer API. Confirm the returned effective `user_role` string and customer ID against a real staging customer. The server allows `customer` by default and can allow the supported `wholesaler` or `vip customer` values via `WOOTER_CUSTOMER_ROLES` only after Wooter verifies those names and permissions. Wooter remains responsible for checking customer ownership on **every** upstream read and write, including cart and shipping endpoints; the MCP also checks the owner of returned orders and designs before exposing them.

See [OpenAI's Apps SDK authentication guide](https://developers.openai.com/apps-sdk/build/auth) for the ChatGPT OAuth setup. Set `WOOTER_SIGNUP_URL` only when Wooter provides the exact customer registration URL. The app never uses passwords or unverified email addresses to create accounts in chat.

## Host and test

Run one instance with a persistent private volume for `DB_PATH` (the Docker default is `/app/state/reviews.sqlite`). Set `REVIEW_KEY_HEX` to an independently generated 32-byte key and keep it in the secret manager. Rotate it only with a planned review-store migration or cleanup. Use a trusted HTTPS reverse proxy, forward `Authorization` and standard MCP headers, rate-limit by connection/IP at the edge, and do not log request headers, tool arguments or bodies. Health endpoint: `GET /health`.

Use ChatGPT development mode with the dedicated server before changing any public submission. Run the following on the exact staging setup:

1. Anonymous catalog search, 22 jersey-and-short sets in USD, and instant-design previews. Check that guest browsing does not trigger OAuth.
2. Connect with a staging customer, confirm ChatGPT returns and the app shows connected. Confirm a staff login and attempts to open a second customer's order/design are rejected. Disconnect/revoke and verify the old connection no longer works.
3. Verify the actual ChatGPT review card renders. Add a jersey and shorts, save a quote, place one unpaid test order, and reorder it. Check every confirmation against Wooter before creating another. Make sure navigation and status updates work in ChatGPT, including an expired or stale review.
4. Send a staged design request and follow its correct `/platform/design/request/<id>/view` link. Check the separate due date, ownership and Instant Design Studio link. Confirm the DIY and AI designer links open on Wooter.
5. Verify interruption and partial cart-write behavior. A timeout after a Wooter write is **unknown**, not a safe retry. The local store serializes submissions per customer and prevents duplicate use of a review. For changes made from another client between the cart read and order write, Wooter should enforce an atomic cart revision check and idempotency in its API before relying on this in production.

Private review data is encrypted at rest in the local store. Unsubmitted review payloads expire after 20 minutes; finalization drops the payload immediately. Abandoned in-flight records become unknown after 10 minutes. A startup/periodic cleanup removes local reviews/results after 30 days. It does not delete Wooter records, logs, backups or ChatGPT conversations. The server does not store OAuth tokens. Confirm the actual OAuth profile, quote and checkout API shapes, and the host card end to end before public review.

Once the dedicated endpoint works, declare its exact HTTPS URL in the public submission's MCP configuration. If the portal rejects changing servers on the old draft, use the supported migration/new-submission path rather than removing the working private connection.
