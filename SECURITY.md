# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately, never in a public issue or pull request:

- **GitHub:** [report a vulnerability](https://github.com/PatrolTech/sdk-api/security/advisories/new) from the Security tab of this repository.
- **Support bot:** WhatsApp [wa.me/34624085772](https://wa.me/34624085772) or Telegram [@patroltechbot](https://t.me/patroltechbot).
- **Email:** [info@patroltech.app](mailto:info@patroltech.app).

Include the affected version, the steps to reproduce and the impact you expect. Do not send credentials, access tokens or customer data: if a report needs them, say so and we will agree on a safe channel.

We acknowledge reports within 3 working days and keep you informed until the fix is released.

## Scope

This repository contains the TypeScript SDK and the public OpenAPI contract it is generated from. Vulnerabilities in the PatrolTech API or apps found while using the SDK are welcome through the same channels.

The SDK grants no access by itself: every request is authorised by the PatrolTech API with the caller's OAuth token, scopes and role.

## Supported versions

Only the latest published version of `@patroltech/sdk-api` receives security fixes.
