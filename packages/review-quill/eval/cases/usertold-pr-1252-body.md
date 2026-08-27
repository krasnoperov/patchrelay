The session record used to play itself in — a veil sweeping across the lanes while pins, moment cards and chain nodes faded in over five seconds. A bar moving directly under the headline competes with the headline, and until it finished the page looked unfinished. **The card now renders complete.** The only thing still moving is the REC dot, because the interview is live, and the playhead sits where a running session currently is rather than travelling there.

What replaces the motion is something to do.

## Inspectable marks

Marks we can caption honestly — the four page paths, the two scans, the quote, the debrief answer — respond to hover **and to keyboard focus** with the second they happened and what happened there. The decorative texture stays inert: captioning it would mean inventing detail we do not have.

Two things worth reviewing:

- **Notes are siblings of their marks, not children.** As a direct child of the lane a note can size against the whole track, which is what lets it span the full width on a phone instead of overflowing the card. Shown via `.markLive:hover + .trackNote`, positioned from a `--note-left` custom property so the phone rule can override it.
- **Nothing lives on hover alone.** Every note repeats a fact the moment cards below already state, so pointer-only users lose nothing. Marks are keyboard-reachable, the lanes are no longer `aria-hidden`, and a padded `::before` gives the 10px-tall screen blocks a hit box a pointer can actually hold.

## Typography and rhythm, same pass

- `struggling_moment · confidence 0.91` was dropping `0.91` onto its own line and burying the number. The signal type goes; the score stays and takes the emphasis.
- `.chainNode > b` — direct child only. The old `.chainNode b` turned *every* `<b>` into a block, which is what split `confidence` from its value once the value was emphasised.
- `text-wrap: pretty` on the moment and chain copy, retiring orphans like a lone "attached." on the last line.
- `.chainNode` takes the same box as `.moment` above it (`12 / 12 / 16`), so the two rows read as one ledger rather than two grids with different bottoms.

Vertical rhythm inside the card measures 24 / 24 either side of the track, and the card sits 24px from both the hero above and the section below — unchanged.

## Verification

- `pnpm test` — 4212 passed, 0 failed
- `pnpm test:ui:local` — 29 marketing specs passed, full suite green
- `pnpm test:integration` — 106 passed, 7 skipped
- `pnpm lint`, `pnpm typecheck`, `pnpm lint:css-modules` — clean
- Rendered at 1400 / 390 / 320px, hover and focus states checked at each

New spec asserts the card has exactly one animated element (the REC dot), that a focused mark reveals its note with the right quote in it, and that no note escapes the card at 320px.

## Public changelog

- [x] Skip — no durable public outcome

Marketing-page presentation; no capability change.
