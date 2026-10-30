# PatrolTech TypeScript SDK

Official TypeScript client for the **PatrolTech public REST API**: integrate guard tour workflows (routes, checkpoints, rounds, scans, incidents) into your own applications.

![PatrolTech — QR/NFC checkpoints, offline patrols and incident reports](https://raw.githubusercontent.com/PatrolTech/.github/main/02-patroltech-banner.svg)

[![CI](https://github.com/PatrolTech/sdk-api/actions/workflows/ci.yml/badge.svg)](https://github.com/PatrolTech/sdk-api/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@patroltech/sdk-api)](https://www.npmjs.com/package/@patroltech/sdk-api)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

- **Generated from the public contract** [`openapi/openapi.public.json`](./openapi/openapi.public.json), the same document the API serves at [`https://api.patroltech.online/openapi.public.json`](https://api.patroltech.online/openapi.public.json).
- **Typed** requests and responses, ESM and CommonJS builds, no runtime dependencies (it uses the platform `fetch`).
- Works in Node.js 22+ (which loads the CommonJS build, for `require` and `import` alike) and in browsers through a bundler (ESM build). Types need TypeScript 5.0+.

## Install

```bash
npm install @patroltech/sdk-api
```

## Authentication (OAuth 2.1)

PatrolTech uses the OAuth authorization code flow with PKCE (S256) and public clients (no client secret). The discovery document is at `https://api.patroltech.online/.well-known/oauth-authorization-server`.

1. **Register your client** once with dynamic client registration (`registerOAuthClient`, RFC 7591), or use the URL of a Client ID Metadata Document as `client_id`.
2. **Send the user to the consent screen** built with `getStartOAuthAuthorizationUrl`. Scopes: `read`, `write`. PatrolTech redirects back to your `redirect_uri` with `code` and `state`; check that `state` is the one you sent.
3. **Exchange the code** for an access and refresh token with `requestOAuthToken` (`grant_type: 'authorization_code'`). Rotate them later with `grant_type: 'refresh_token'`; revoke them with `revokeOAuthToken`.
4. **Open an API session**: `createOAuthAgentSession`, called with the OAuth access token as Bearer, returns a short-lived `token` (and `expires_at`) for the `/api/*` endpoints. Open a new one before it expires.

The whole flow, step by step and type-checked in CI, is in [`examples/oauth.ts`](./examples/oauth.ts). What a session can do is decided by the API: the user's role in the organization and the scopes they granted. The SDK grants no access by itself.

Keep tokens out of logs, URLs and source control. Store the refresh token server-side.

## Quick start

```ts
import { configureApiSdk, listRoutes } from '@patroltech/sdk-api';

let session = await openApiSession(oauthAccessToken); // step 4

configureApiSdk({
  baseUrl: 'https://api.patroltech.online',
  getAccessToken: () => session.token,
  // Optional. On a 401 the SDK calls this once and retries with what getAccessToken()
  // returns now: update the session it reads and return its token, or null to give up.
  onUnauthorized: async () => {
    session = await openApiSession(oauthAccessToken);
    return session.token;
  },
});

const response = await listRoutes({ organizationId, page: 1, limit: 20 });
if (response.status === 200) {
  console.log(response.data.results.map((route) => route.name));
}
```

If several requests can fail at once, share one refresh between them (keep the pending promise) instead of opening a session per 401.

See [`examples/quick-start.ts`](./examples/quick-start.ts).

### Responses and errors

- Every function returns `{ data, status, headers }`. For `/api/*` the `{ success, message, data }` envelope is unwrapped, so `data` is the payload described by the contract. `/oauth/*` responses are plain JSON, as in the OAuth RFCs.
- A non-2xx response throws an `ApiError` with `status`, `message` and the response body in `data` (its type is exported as `ApiErrorBody`). Checking `response.status === 200` only narrows the TypeScript type.
- A `423` for a suspended organization also calls `onSuspended(body)` if you configured it.
- Path parameters are percent-encoded (`x/details` stays one segment), and an id that is exactly `.` or `..` is refused with a `TypeError` before any request, so untrusted input cannot reach another endpoint with your token.

### One configuration per request

`configureApiSdk` sets a global configuration. A server acting for several users can bind one per call instead:

```ts
import { createApiClient, listScans } from '@patroltech/sdk-api';

const client = createApiClient({ baseUrl, getAccessToken: () => tokenOfThisUser });
await listScans({ organizationId }, client.init());
```

`init()` accepts extra `RequestInit` options, such as `signal` for an `AbortController`. Pass `headers` as a plain object (`{ 'X-Request-Id': id }`), not a `Headers` instance.

## Versioning

- The contract has its own semantic version (`info.version`). A breaking change in the API requires a new major version of the contract.
- The SDK version follows its public TypeScript surface (exports, function signatures and exported types), not only the contract: a contract change that is compatible over HTTP can still change a signature (a new query parameter goes before `options`), and that is a new major version of the SDK. `scripts/api-surface.mjs` compares the built package with the published one; the `Public API surface` check fails a pull request whose version goes up less than its change needs. A new major version of the contract also means a new major version of the SDK.
- Each contract change reaches this repository automatically as a pull request with that version bump and the list of signatures that change. When its CI passes, a minor or patch release merges itself and is published to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements); a major one waits for a maintainer's review.

## Contributing

The client is generated with [orval](https://orval.dev) from the contract: do not edit `src/generated/` (it is not committed) or `openapi/` (it comes from the PatrolTech API). Bug reports and improvements to the hand-written parts (`src/mutator.ts`, examples, docs) are welcome.

```bash
npm ci
npm run build          # generate + compile ESM and CJS
npm test
npm run test:scripts   # tests of scripts/ (node --test)
npm run examples:check
npm run format:check
npm run api-surface -- report   # what changes against the latest version on npm
```

Security issues: see [SECURITY.md](./SECURITY.md). Do not include credentials, tokens or customer data in public issues.

## About PatrolTech

PatrolTech is guard tour and security patrol software developed by Ingenieros Web SL in Madrid, Spain. It combines QR/NFC checkpoint recording, offline patrol records, incident reports and a management dashboard.

- [Product overview](https://patroltech.online/en)
- [Pricing and free plan](https://patroltech.online/en/pricing)
- [Product tutorials](https://patroltech.online/en/tutorials)
- [PatrolTech on GitHub](https://github.com/PatrolTech)

Integration enquiries: **info@patroltech.app**.

## En español

SDK oficial en TypeScript de la API pública de PatrolTech, generado desde el contrato OpenAPI público. Instálalo con `npm install @patroltech/sdk-api`; la autenticación es OAuth con PKCE (ver [`examples/oauth.ts`](./examples/oauth.ts)). Contacto: [info@patroltech.app](mailto:info@patroltech.app).

## License

[MIT](./LICENSE) © Ingenieros Web SL
