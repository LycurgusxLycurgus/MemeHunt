# Due diligence backend (partial Phase 1)

This local CLI stores a manual token assessment and its two linked checklists. It does not place trades, monitor in the background, or certify a venue. Entry PASS means `RESEARCH_ELIGIBLE` for the supplied evidence and selected policy. A saved PASS with a frozen thesis opens management immediately; later `analyze` calls for that token route to reassessment. Imported evidence keeps its origin and must be checked before anyone relies on it.

## Run

Requires Node 24 or later. From this directory:

```powershell
npm ci
npm run typecheck
npm test
node dist/src/cli.js capabilities
node dist/src/cli.js profile options
node dist/src/cli.js analyze FIXTURE_TOKEN --chain solana --bundle examples/entry.json
node dist/src/cli.js analyze FIXTURE_TOKEN --chain solana --bundle examples/reassessment.json
node dist/src/cli.js analyze <real-address> --chain solana
node dist/src/cli.js show <snapshot-id>
node dist/src/cli.js replay <snapshot-id>
node dist/src/cli.js reassess <case-id> --bundle examples/reassessment.json
node dist/src/cli.js diff <snapshot-a> <snapshot-b>
node dist/src/cli.js backup .data/backup-001
```

Use `--db path/to/file.sqlite` with stateful commands to select a local database. Results are one JSON object on stdout; errors go to stderr. `capabilities` shows recognized chains separately from certified venues. `market probe <chain> <address>` makes one bounded read-only DEX Screener request. No live data is silently added to an imported bundle.

`backup <new-directory>` creates a SQLite-consistent copy plus any raw artifacts. To restore, stop all CLI processes, keep the old data directory, copy the backup database and artifacts into a new data directory, and run `show`/`replay` on a known snapshot with `--db <new-directory>/dd.sqlite` before switching paths.

Each bundle declares a chain-qualified token, UTC cutoff, evidence records, typed features, a profile, and optionally a frozen thesis. `analysisKind: FIXTURE` is for synthetic examples/tests. `USER_IMPORT` means the material was supplied by the user; it is not authenticated chain or platform evidence. Such imports require raw text artifacts whose SHA-256 hashes match the evidence records; imported control/route claims cannot become certified safety checks. A bare address uses `MANUAL_EMPTY` and records an incomplete checklist. Feature quality `KNOWN` describes the supplied value, not independent verification. Without adequate source coverage, age/size/risk/exit settings, rows remain UNKNOWN. `examples/` contains illustrative values, not calibrated live trading advice. Never use a fixture profile for live decisions.

The profile choices from the source notes are available through `profile options`: independent attention styles `SPARK`, `WAVE`, `COMMUNITY`; disjoint cap bands; MICRO 1m/5m/15m, SMALL 30m/1h, ESTABLISHED 4h/1d chart candidates; and an illustrative original-quantity 40%/30%/remaining exit sequence. The notes do not fix age thresholds, LARGE chart bars, position size, or risk tolerances. Set those explicitly; market cap does not replace liquidity or a quote. A proposal does not count as a sale. Manual events are recorded through `position record` and `position event` using JSON files, then reassessment computes from the revised ledger. A position JSON needs both `entryAt` (when the position began) and `recordedAt` (when this CLI learned of it). Events also carry effective and recorded times; reassessment at a historical cutoff excludes records learned later, including backdated corrections.

A thesis successor's `createdAt` is its declared creation and start of applicability. Reassessment selects the latest saved thesis at or before the requested cutoff; successors must be strictly later than their predecessors. The store has no separate timestamp for when a successor was entered into SQLite, so this is a declared-time history rather than a two-clock audit trail. Closing a case disables further reassessment, including historical cutoffs; saved snapshots can still be replayed.

## Provider choice and current limits

The first live diagnostic uses [DEX Screener's documented public token-pairs endpoint](https://docs.dexscreener.com/api/reference). It can show observed pairs and prices; it does not establish token controls, venue version, sellability, or an executable quote. For those later checks, use a pinned chain/RPC source and a venue-specific adapter before promoting a capability to certified.

For public web search and page extraction, [TinyFish Search/Fetch](https://www.tinyfish.ai/pricing) is the first zero-spend candidate: its published limits are 30 searches/minute, 500/hour and 150 fetched URLs/minute, 1,000/day, with no wallet draw. The competing [Parallel Search/Extract](https://parallel.ai/pricing) offers recurring free credits, but calls have prices; benchmark it only with confirmed overage controls. [GoPlus](https://docs.gopluslabs.io/reference/support) offers a free 30-calls/minute security signal, supplementary to direct chain inspection. No account credentials, live comparative quality, or full source coverage has been verified here.

The preferred semantic adapter is configured for [Gemini 3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite), 65,536 maximum output tokens, `high` thinking for the user-selected extraction scope (`medium` baseline elsewhere), and the four adjustable safety thresholds set to `OFF`. It uses the Developer API key in `GEMINI_API_KEY`. Hosted extraction stays disabled until the user's free entitlement, public/redacted packet policy and a labeled quality set are verified. The [pricing page](https://ai.google.dev/gemini-api/docs/pricing) describes a free tier for this model, while actual quota depends on the account. No fallback may incur paid use by default.

## Current capability boundary

The CLI and deterministic policy modules are an implementable offline slice. The feature catalog lists planned fields; a listed field is not a built collector or verified detector. The 33 entry and 15 management rows are persisted, with UNKNOWN where evidence or implemented evaluation is absent. Replay uses frozen inputs and local code. Full four-venue certification, chain control decoding, route simulation, live social retrieval, chart/macro detectors, semantic quality, and outcome calibration remain separate packets. See [the canonical plan](plans/backend-v1/README.md) and [the two-person ownership guide](CONTRIBUTING.md).

The plan records source-derived rationale. The original third-party transcripts, notes, and historical pre-plan are intentionally omitted from this public repository. Transcript line references in the plan refer to source material used during planning and are not available in this repository.
