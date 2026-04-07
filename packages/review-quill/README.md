# review-quill

`review-quill` is the dedicated PR review service for the PatchRelay stack.

It is responsible for one narrow loop:

- detect PRs whose latest head SHA is ready for review
- run a readonly review pass for that exact SHA
- publish a normal GitHub PR review on the PR
- publish a machine-facing `review-quill/verdict` check run
- cancel stale in-flight attempts when a newer PR head lands before publication

In the current production shape, `review-quill` uses its GitHub App identity
for the whole loop:

- webhook intake
- repository reads
- `APPROVE` / `REQUEST_CHANGES` reviews
- `review-quill/verdict` check runs

`review-quill/verdict` is optional. A repository can rely on normal GitHub
review gating alone, or it can also require the verdict check in branch
protection. `merge-steward` admits on GitHub's PR review/check truth and then
does its own speculative integrated-branch validation before landing.

It complements:

- `patchrelay` — delegated implementation and branch upkeep
- `merge-steward` — merge admission and landing

## Status

This package now includes a working service skeleton, a review attempt store,
the `review-quill watch` TUI, and the public URL wiring needed for GitHub
webhooks and check-run detail links.

Authoritative design:

- [../../docs/design-docs/review-quill.md](../../docs/design-docs/review-quill.md)
- [../../docs/design-docs/pr-automation-loop.md](../../docs/design-docs/pr-automation-loop.md)

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

## GitHub App permissions

This is the current known-good permission set for `review-quill`. After moving
the app to this shape, GitHub started counting `review-quill` approvals toward
the branch review gate on live PRs.

Repository permissions:

- `Contents: Read and write`
- `Issues: Read and write`
- `Pull requests: Read and write`
- `Actions: Read-only`
- `Metadata: Read-only`

Webhook events:

- `Pull request`
- `Check run`
- `Check suite`

Notes:

- `Pull requests: Read and write` is what lets `review-quill` submit ordinary
  `APPROVE` / `REQUEST_CHANGES` reviews and create review comments.
- `Actions: Read-only` lets it observe CI state cleanly.
- `Contents: Read and write` is part of the currently validated working setup.
  We have not minimized this below the known-good set yet.

## CLI

`review-quill` now follows the same operator pattern as PatchRelay and
`merge-steward`:

- `init` bootstraps the local home and systemd unit
- `attach` adds or updates one watched repository
- `repos` shows what is configured
- `doctor` verifies readiness and, when possible, checks whether GitHub is counting recent `review-quill` reviews
- `service status|logs|restart|install` handles systemd operations
- `dashboard` opens the live review watch UI

The dashboard/watch UI is mainly for operators. It shows:

- active queued/running review attempts
- completed, failed, cancelled, and superseded attempts in `all` mode
- recent webhook wakeups
- latest reconcile status

Happy path:

1. `review-quill init https://patchrelay.example.com/review`
2. Fill in `~/.config/review-quill/service.env`
3. Install encrypted credentials for the webhook secret and GitHub App key
4. `review-quill attach krasnoperov/mafia`
5. `review-quill doctor --repo mafia`
6. `review-quill service status`
7. `review-quill dashboard`
