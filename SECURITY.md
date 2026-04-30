# Security Policy

## Reporting vulnerabilities

Please do not open a public issue for suspected security vulnerabilities.

Report vulnerabilities privately to the maintainers with:

- a description of the issue
- affected versions or commits
- reproduction steps or proof of concept
- any mitigations you have already identified

We will acknowledge the report, investigate it, and coordinate a fix and disclosure plan.

## Deployment posture

PatchRelay is designed for infrastructure you control. Recommended production posture:

- bind to loopback unless you have a strong reason not to
- expose only `/`, `/health`, `/ready`, `/oauth/linear/callback`, `POST /webhooks/linear`, and `POST /webhooks/github`
- leave `operator_api.enabled` disabled unless you explicitly need the HTTP operator endpoints
- require `PATCHRELAY_OPERATOR_TOKEN` if you enable the operator API on a non-loopback bind
- treat workflow files and Codex runtime access as privileged automation policy
- configure `projects[].trusted_actors` so only trusted Linear owners or trusted domains can trigger automation

## Configuration model

PatchRelay separates trust into three layers:

- Network trust: the public server surface should only accept signed Linear and GitHub webhooks plus the Linear OAuth callback.
- Operator trust: local setup and inspection routes are for the operator, not the public internet.
- Linear actor trust: a valid webhook is still ignored if its actor is not trusted for the routed project.

`trusted_actors` is evaluated per project. When configured, unmatched issue and comment events are ignored before they can change desired stage state or inject comment context into an active turn.
