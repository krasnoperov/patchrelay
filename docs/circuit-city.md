# Circuit City

Circuit City is a read-only web view of the software factory at `/factory`.
It renders an SVG project overview and readable task columns within each project, with a React inspector.
No 3D engine, generated artwork, or external asset CDN is required.

## Run a preview

```sh
pnpm install
pnpm factory:demo
```

Open `http://127.0.0.1:4317/factory?demo=1`. This server only serves the UI;
the explicitly labeled demo uses illustrative tasks. **Advance PR-142** moves
one sample task to its next station. It never connects to production services.
Set `FACTORY_PORT` to change the preview port.

## Connect the live factory

The normal `pnpm build` includes the browser assets in `dist/factory/assets`,
so they are also included in the published npm package. Start PatchRelay normally
and open `/factory` on its existing HTTP server. For source development, run
`pnpm build:factory` again after changing the frontend.

The existing operator API rules apply to `/api/factory` and
`/api/factory/stream`: loopback access works locally; a remote server needs the
operator API enabled and its bearer token. The browser requests that token when
needed and keeps it only in memory. It does not put credentials in URLs or local
storage. The HTML shell and demo contain no private data.

When publishing a loopback-bound service through a reverse proxy, authenticate
the factory at the proxy: loopback management requests intentionally bypass the
operator bearer check. Restrict the new proxy routes to `GET /factory`,
`GET /factory/assets/*`, `GET /api/factory`, `GET /api/factory/stream`, and
`GET /api/issues/:issueKey` for the inspector. Keep the other operator endpoints
private, including all write routes. Disable proxy response buffering for the
stream. The domain root can redirect to `/factory` without changing webhook,
OAuth, or health routes.

The backend reads configured projects and tracked issues from PatchRelay. Optional
service addresses can be set in the **PatchRelay service environment**:

```sh
PATCHRELAY_FACTORY_MERGE_STEWARD_URL=http://127.0.0.1:YOUR_STEWARD_PORT
PATCHRELAY_FACTORY_REVIEW_QUILL_URL=http://127.0.0.1:YOUR_QUILL_PORT
```

Use your existing service ports; the placeholders above are not defaults.
Merge-steward's `/health` supplies repository IDs, then each repository's
`/repos/:repoId/queue/watch` supplies queue entries and positions. Review-quill's
`/watch` supplies review attempts. These requests happen on the backend, with a
three-second timeout per request. Missing or failed services are labeled; no
positions or connectivity are fabricated.

GitHub PR lifecycle is read through the service's existing authenticated `gh` CLI,
with a shared 60-second cache and up to three repository reads at a time. Open PRs
remain visible regardless of age. Main shows only PRs merged in the last seven
days, using the merge date rather than later comments or queue updates. Closed,
unmerged PRs and older merges are omitted. Finished no-PR issues are omitted;
other no-PR work is shown when active or updated in the last seven days.
Queue and review history is matched to the current GitHub head before it can
supply attention signals. A repository that cannot be checked is labeled
unavailable and its PRs are temporarily omitted, rather than presenting old
history as current work. CI details remain stored PatchRelay observations.

One shared snapshot cache coalesces concurrent reads. `/api/factory/stream` emits
server-sent snapshots approximately every five seconds. The browser reconnects
after a disconnect, retains the last world, and labels it stale. Animation stops
while the feed is unavailable. Opening many tabs does not multiply service reads
within the cache interval.

## Explore

- Select a district in the sidebar, its heading, or the minimap to focus it.
- Drag the canvas to pan; use the zoom and fit buttons to change the camera.
- Zoom out to collapse task tokens into station counts; focus a district to
  inspect it. Large worlds start with counts to avoid crowding.
- Select task tokens with a pointer, or focus them with Tab and press Enter.
- Search by task key or title, or use **Needs me** to emphasize attention items.
- The inspector directory provides access to tasks beyond a station's three
  visible tokens. Source links and latest agent reports appear for live issues.
- **Pause motion** stops animation without stopping data updates. The operating
  system's reduced-motion preference is also respected.

Task movement represents an observed station change. Station lights indicate
activity. Queue positions and external review attempts apply only when their head
matches the tracked PR head; PatchRelay's native phase stays separate. Queue-only
PRs also appear, including repositories without Linear issues. Repairs remain at
implementation. A completed workflow without a merged PR stays out of Main.
Main represents a merge, not successful deployment.

This first version does not implement historical replay, change workflow state,
or initiate deployments. Live correctness depends on the freshness of each
service's underlying observations.

## Validation

```sh
pnpm lint
pnpm typecheck
node --experimental-transform-types --test test/factory-model.test.ts test/http.test.ts
pnpm exec playwright install chromium
pnpm test:factory:browser
pnpm build
```

Browser tests cover selection, project focus, filtering, zoom, sample movement,
motion controls, operator auth, interrupted streams, and mobile inspection. They
write screenshots to `/tmp/patchrelay-factory-*.png` and test artifacts under
`/tmp/patchrelay-factory-tests`; these are not committed.
