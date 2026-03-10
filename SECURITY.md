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
- expose only `/`, `/health`, `/ready`, and `POST /webhooks/linear`
- leave `operator_api.enabled` disabled unless you explicitly need the HTTP operator endpoints
- require `PATCHRELAY_OPERATOR_TOKEN` if you enable the operator API on a non-loopback bind
- treat workflow files and Codex runtime access as privileged automation policy
