# Release Checklist

- Run `npm ci`
- Run `npm run check`
- Run `npm test`
- Run `npm run build`
- Confirm `.env.example` and `config/patchrelay.example.yaml` match the current config surface
- Confirm README and self-hosting docs reflect the public routes and operator API defaults
- Confirm `/api` operator routes are disabled by default
- Confirm `/ready` behavior matches the startup model
- Review webhook archival and logging behavior for sensitive data handling
