# review-quill

`review-quill` is the dedicated PR review service for the PatchRelay stack.

It is responsible for one narrow loop:

- detect PRs whose latest head SHA is ready for review
- run a readonly review pass for that exact SHA
- publish a human-facing GitHub review
- publish a machine-facing `review-quill/verdict` check run

It complements:

- `patchrelay` — delegated implementation and branch upkeep
- `merge-steward` — merge admission and landing

## Status

This package now includes a working service skeleton, a review attempt store,
the `review-quill watch` TUI, and the public URL wiring needed for GitHub
webhooks and check-run detail links.

Authoritative design:

- [../../docs/design-docs/review-quill.md](../../docs/design-docs/review-quill.md)

## Public ingress

`review-quill` follows the same shared-host ingress pattern as PatchRelay and
`merge-steward`.

Recommended public base URL:

- `https://patchrelay.example.com/review`

That gives these public endpoints:

- `POST /review/webhooks/github` for the GitHub App webhook
- `GET /review/health` for external health checks
- `GET /review/attempts/:id` for check-run detail links

Intentionally not public:

- `/review/watch`
- `/review/attempts`
- `/review/admin/*`

The package ships an example Caddy config at
[`infra/Caddyfile`](./infra/Caddyfile) that matches the live layout used by
PatchRelay and `merge-steward`.

## Config model

Planned config layout:

- `~/.config/review-quill/runtime.env`
- `~/.config/review-quill/service.env`
- `~/.config/review-quill/review-quill.json`
- `/etc/systemd/system/review-quill.service`

Planned encrypted credentials:

- `review-quill-webhook-secret`
- `review-quill-github-app-pem`

## CLI

- `review-quill serve`
- `review-quill watch`
- `review-quill version`
