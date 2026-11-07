# Architecture map

Local TypeScript CLI for research-only due diligence on a token contract address (Solana live; BSC, Base and Robinhood bundle-only). It collects public chain, market and web evidence, asks a model only for judgments of meaning, and reports a checklist where every row has an outcome and a reason. It never signs, broadcasts, trades or custodies. Two live modes share most code: **`--fast`** (20-row research screen, stable, the reference shape) and **`--full`** (33-row entry checklist, older shape, next to be moved onto the `--fast` shape). Saved snapshots are immutable and replay offline.

Design rules for all work: `agentic/requisite-complexity.md` (every mechanism traces to the problem; real input judges) and `agentic/auto-llm-engineering.md` (a cold agent must be able to understand, verify and correct the code; laws below have real checkers). Dated cycle history up to 2026-11-03 is archived locally at `.data/cycle-c/architecture-full-history.md` and `.data/cycle-b/architecture-fast-pre-cycle-b.md`; read them only for archaeology.

## `--fast` — minimum-step research screen

Policy `research-fast-v3`. Older FAST snapshots (`research-fast-v2` and before) are refused on replay with `FAST_POLICY_RETIRED` (`isRetiredFastPolicy`, `domain/fast-checklist.ts`).

**Measured (2026-11-03, cycle B).** 10 fresh tokens by the fixed `scripts/fast-sample.mjs` rule (`.data/cycle-b/live2`): 10/10 zero UNKNOWN, 200/200 rows known, no lost report, median 32.6 s (25.4–72.5); prior design 9/10, 199/200, 56 s. Model prompt median 14.8k characters (was 50–80k).

### Flow and owners

1. **Identify** mint and market: `app/live.ts` preflight, `providers/solana.ts`, `providers/dexscreener.ts`.
2. **Metadata JSON**: one direct bounded GET; for an IPFS CID one fallback through `ipfs.filebase.io` (`fetchFastMetadata`, `providers/token-discovery.ts`). Failure is the value `METADATA_FETCH_UNAVAILABLE`.
3. **TinyFish** search and fetch (`providers/attention.ts`, `providers/tinyfish.ts`); unread targets become per-row read gaps.
4. **One Gemini call** (`providers/gemini.ts`; packet in `providers/attention-model.ts`) for `NAR-01` and `ADV-03`, no repair. Code owns the `ADV-03` post set and count (`measureCriterionPosts`, `domain/criterion-review.ts`); an omitted post is not counted and is disclosed. `NAR-01` SUPPORTED without an eligible citation becomes INSUFFICIENT; an invalid decode is UNKNOWN (about 1 in 17 runs, model nondeterminism).
5. **Final chain**, after the model call because quotes live 30 s and state 300 s: `fastRouteFacts` (`app/live.ts`, exported, pure over captured artifacts) runs the Jupiter route (`providers/jupiter-route.ts` quotes, swap builds, RPC simulation; transport `providers/jupiter.ts`) and RugCheck (`providers/rugcheck.ts`, parsed by `domain/rugcheck.ts`), fetched in parallel. The final chain runs even when the RPC preflight failed: quotes (Jupiter HTTP, SOL price from DexScreener, atomic amounts, no mint decimals) and RugCheck need no RPC; payer choice, account reads and simulations do. FAST does not call the PumpSwap, pump-curve or DAMM adapters.
6. **Rows and report**: `domain/baseline.ts` observations, `domain/entry-groups.ts`, `domain/fast-checklist.ts`, `app/report.ts`. Route cause → reason text is the typed table `routeCauseReason` (`app/report.ts`), keyed by `jupiterCauses` (`providers/jupiter-route.ts`): a new cause code does not compile until its reason is chosen. Admission (`app/service.ts`) is integrity-only: artifact hash and size (`ARTIFACT_HASH_OR_SIZE` on tamper), no re-derivation.

### Rules (rules 2–11 also bind the `--full` move)

1. Six steps, owners as above. A new step needs a problem-side reason and a fresh-token measurement.
2. **The route defines the traded pool.** `LIQ-01` judges the RugCheck market whose pool matches the Jupiter route `ammKey`. A route pool owned by the Meteora DBC program `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` or the pump curve program `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` has 0 removable liquidity (reserves are program-held until curve completion; verified from Meteora source). The largest market is used only when there is no route. A route pool absent from the report is UNKNOWN `JUPITER_LIQUIDITY_UNAVAILABLE`.
3. **Dependencies are per row and per leg.** Buy leg: `SEC-05`, `CAP-01`, `ADV-05`, entry parts of `EXE-01`–`03`, `LIQ-01`. Sell leg: exit parts of `EXE-01`–`03`. `EXE-03` needs both simulations. RugCheck: `LIQ-01`, `OWN-02`, `ADV-01` (labels). No route is the value `JUPITER_NO_ROUTE`; no exit route at the acquired size makes `EXE-01`–`03` INSUFFICIENT; no wallet holding the token makes `EXE-03` UNKNOWN `JUPITER_SELL_PAYER_UNAVAILABLE`. Payment is native SOL plus wSOL change. **RPC outage** (decided 2026-11-03): quote rows `SEC-05`, `CAP-01`, `EXE-01`, `EXE-02` are still judged from quotes; `EXE-03` is UNKNOWN `JUPITER_HOLDERS_UNAVAILABLE` (no holder data to pick a simulation wallet); `LIQ-01` uses the RugCheck route-pool market (the program-owner check needs RPC account reads); RPC rows (`SEC-01`–`04`, `OWN-01`, `ID-01`, `OWN-02`, `ADV-01`) carry the RPC cause.
4. **Code owns enumeration and facts**; the model judges meaning only.
5. **No repair passes.** A model or provider failure is a named value.
6. **At most one bounded retry, transient faults only**: Jupiter/RugCheck 429 pacing in transport; one re-quote plus re-simulation on slippage (Custom 6001 / `0x1771`), both recorded; a second slippage is UNKNOWN `JUPITER_SLIPPAGE_MOVED_TWICE`.
7. **Direct structured fetch** for structured data before any scraping service.
8. **Integrity-only admission.**
9. **Third-party evidence is labeled** (RugCheck) in reasons.
10. **Reasons name the measured cause** (law V2).
11. **No version branches** for internal forms; change in place, retire old policies by refusal.
12. **Measure on fresh tokens** with `scripts/fast-sample.mjs`. Unknown is a measured cause, never a silent default and never a negative.

## Verification laws and checkers

A law is a required property; its checker is what fails when the property breaks. Expected values come from the rule text, never from the implementation. Change a law only with a contract change. `npm test` runs every test checker; "live" checkers need the network.

| # | Law | Checker | Status |
|---|---|---|---|
| V1 | 20 rows, each with an outcome and one reason; no early stop | `deriveFastChecklist` throws `FAST_CHECKLIST_SCOPE_INVALID`; `tests/live-cli.test.ts` "FAST CLI captures chain evidence and reports all twenty decisions after an attention failure" | checked |
| V2 | A route/RugCheck failure code reaches every dependent row's cause and reason; never `LIVE_DEPENDENCY_SKIPPED` | same live-cli test (runs production `collectLiveSolana`); `tests/live-providers.test.ts` "... cause reaches ..." (call production `fastRouteFacts`) | checked; mutation-proven 2026-11-03 at both sites (venueOutcome wiring, `fastRouteFacts` cause) |
| V3 | A fault changes only its dependent rows (rule 3 sets) | `tests/live-cli.test.ts` "FAST live glue keeps unrelated rows stable when one provider fails" | checked (not mutation-proven) |
| V4 | No UNKNOWN without a named cause code | V2 tests; `fast-sample` records each UNKNOWN row's codes | checked (tests) / live |
| V5 | Code owns enumeration, counts, citation eligibility; one generation, no repair | `tests/fast-single.test.ts` post-set, ADV-03, NAR-01 tests; `criterion-schema.ts` `semanticRepairAttempts` literal 0 | checked |
| V6 | At most one bounded retry, transient faults only | 429 pacing tests; Slingoor slippage tests (`tests/live-providers.test.ts`) | checked |
| V7 | Route defines the pool; DBC/pump-curve route pool = 0 removable | COVENA, FUN and uncovered-pool tests (`tests/live-providers.test.ts`) | checked |
| V8 | Metadata fetched directly; failure is a value | `tests/live-providers.test.ts` "FAST metadata retries an IPFS gateway once and keeps non-IPFS failures as read gaps" | checked |
| V9 | Integrity-only admission; retired policies refused | `ARTIFACT_HASH_OR_SIZE` and retired-replay tests | checked |
| V10 | A FAST change leaves FAST outcomes on real captures unchanged, and FULL test outcomes unchanged | `node scripts/fast-rederive.mjs .data/cycle-b/live2 .data/cycle-b/live3 --db-dir <empty dir>` → all diffs (rows, reasons, display, hash, route O08–O16) 0, errors 0, network 0; `npm test` exit code | checked (local captures; all 117 captured route observations are KNOWN, so cause-code diffs are exercised only by V2) |
| V11 | Real-input outcome: UNKNOWN count, no lost report, seconds, no check with the same non-positive outcome (CONTRADICTED, INSUFFICIENT, UNKNOWN) on every token | `scripts/fast-sample.mjs` (`summary.json` `sameNegativeEveryToken`; `--rebuild-summary <dir>` recomputes from captures). On live2 it flags `ADV-03` INSUFFICIENT 10/10 (known gap) | live |
| V12 | No unused code left behind after a removal | `tsconfig.json` `noUnusedLocals`/`noUnusedParameters` (build fails). Does not catch constant-false branches: review-only | checked |
| V13 | When the RPC preflight fails, FAST still captures Jupiter quotes and RugCheck; only RPC-dependent rows carry the RPC/holder cause | `tests/live-cli.test.ts` "FAST still runs Jupiter and RugCheck when the RPC preflight fails" | checked |
| V14 | Public FAST route fixtures exclude captured source/model envelopes, thought signatures and local `.data` paths | `tests/live-providers.test.ts` "public FAST route fixtures omit raw source/model envelopes and local capture paths" | checked |

Review-only (no mechanical checker): constant-false branches after a removal. Fixture privacy and provenance boundaries are checked by V14; new fixture categories require explicit review before publication.

## `--full` as it runs today

`--full` runs the older shape on shared files: per-venue adapters (`providers/pumpswap.ts`, `pumpcurve.ts`, `meteora-damm-v2.ts`), draft/final/correction model passes, deep proof validators (`app/criterion-proof.ts`, Shared/Social proofs), Firecrawl and origin recovery, Gecko/DEX supplements, and the `SEC-03`/`OWN-02` always-fail gates. 16 FULL tests are marked `todo` ("FULL baseline before cycle B; resolve in --full move"); the `--full` move is done when 0 todo remain. Open: the attempt-sequence tamper finding in `app/criterion-proof.ts` (validating only the highest transport attempt lets an invented timeout after a terminal HTTP 200 suppress a completed judgment).

**Shared hotspots** (a FAST edit here can change FULL, and the reverse; run V10 and full `npm test`): `collectLiveToken` in `app/live.ts` (many `options.fast` branches), `domain/baseline.ts` (adapter `venueInspection` vs Jupiter `venue` branches), `app/report.ts` (FAST early return), `app/service.ts` (`projectFast`, admission).

**Mistakes made so far — do not repeat** (each with its checker or "review-only"):
1. One unread URL vetoed the whole token → per-row read gaps (V1).
2. Early stop hid rows → all rows always evaluated (V1).
3. Extra model passes and repair calls added cost, not judgment → one generation (V5).
4. The model was asked for facts code held → code owns counts (V5).
5. A silent `catch` on an eligibility path (TinyFish markdown escapes broke metadata parsing) → review-only; a lost cause is caught by V2.
6. Provider refusal treated as temporary (`ipfs.io` 429) → direct fetch plus one gateway (V8).
7. Always-failing gates (`OWN-02` counted the pool, `SEC-03` failed on the token program) → V11 `sameNegativeEveryToken`.
8. Codes instead of reasons → typed `routeCauseReason` (compile-time) and V2.
9. Measured cause swallowed between provider and row (cycle B F1–F3, found only by review) → V2 through production glue.
10. Dead leftovers after removals (cycle B F4) → V12.
11. Stacked validators, version branches, adapters able to sink a report → rules 5, 8, 11 (review).
12. Edited fixture values and fixture inflation → review-only rule above.
13. Tests that rebuilt production glue in the test helper (passed with the real bug present) → helpers call `fastRouteFacts`; V2.
14. Live samples lost to harness memory kills → `fast-sample --resume`.

## Maintained tree

| Path | Responsibility |
|---|---|
| `package.json`, `tsconfig.json` | Pinned Node/TypeScript build and test entry points; strict unused-symbol flags. |
| `src/cli.ts` | CLI: analyze (bare CA alias), `--fast`/`--full`/`--partial` consent, show/explain/replay/diff, cases, thesis, positions, journal, backup, profile/config, doctor, capabilities. |
| `src/app/live.ts` | Live orchestration (`collectLiveSolana`/`collectLiveToken`): preflight, web acquisition, model stage, final chain; exports `fastRouteFacts`. |
| `src/app/live-phases.ts` | Live stage records, deadlines and stop origins. |
| `src/app/service.ts` | SQLite persistence, artifact hashing, admission (FAST integrity-only, FULL deep validation), snapshots, replay/diff, cases/episodes, positions, backup. |
| `src/app/report.ts` | Report building, `explainChecks`, `renderSnapshot`, cause → reason text (`routeCauseReason`). |
| `src/app/criterion-proof.ts` | FULL criterion proof validation (attempt sequence, source bindings); refuses retired FAST policies. |
| `src/app/config.ts` | Saved config and starter profiles, thesis validation. |
| `src/domain/contracts.ts` | Zod schemas and domain types (tokens, evidence, features, profiles, theses, positions, snapshots). |
| `src/domain/catalog.ts` | Stable 33 entry and 15 management row catalogs; `entryDefinitions.featureIds` is the row → feature map. |
| `src/domain/fast-checklist.ts` | FAST policy ids, the 20 FAST check ids, retired-policy refusal, FAST checklist derivation. |
| `src/domain/baseline.ts` | Observations O01+ from chain/route/RugCheck facts with typed missing causes. |
| `src/domain/entry-groups.ts`, `src/providers/entry-groups.ts` | Entry group resolution (attention context, owner/pool certification) and its bundle adapter. |
| `src/domain/policy.ts` | Pure entry/management predicates, stage resolution, precedence. |
| `src/domain/ledger.ts` | Bigint quantity/cost ledger, corrections, cutoff filtering, exit-leg proposals. |
| `src/domain/rugcheck.ts` | RugCheck market selection by route pool, program-held bonding-curve rule. |
| `src/domain/criterion-review.ts`, `criterion-schema.ts` | Criterion input building, source bindings, code-owned post measurement; wire/proof schemas. |
| `src/domain/attention.ts`, `acquisition-purpose.ts`, `research.ts` | Grounded attention projections and metadata unescaping; acquisition purpose/target state; research packet schema. |
| `src/domain/shared.ts`, `social.ts`, `leadership.ts`, `venue-entry.ts` | FULL Shared claims/audits, Social inputs/reviews, leadership grades, empty-DAMM screening. |
| `src/providers/solana.ts`, `dexscreener.ts`, `http.ts`, `token-discovery.ts` | RPC mint/control/holder evidence; exact-mint pairs; bounded transport; metadata URI discovery and `fetchFastMetadata`. |
| `src/providers/jupiter.ts`, `jupiter-route.ts` | Jupiter transport (pacing, bounded 429 retry); route derivation, `jupiterCauses`, per-leg causes, one slippage re-quote. |
| `src/providers/rugcheck.ts` | Third-party RugCheck fetch with raw bytes kept. |
| `src/providers/tinyfish.ts`, `attention.ts`, `attention-model.ts`, `acquisition-evidence.ts` | Search/fetch, source discovery, model packets and decoding, acquisition ledger. |
| `src/providers/gemini.ts`, `gemini-pacing.ts`, `source-model.ts`, `openrouter.ts`, `nvidia.ts` | Model transport, pacing, response ownership, FULL fallbacks. |
| `src/providers/pumpswap.ts`, `pumpcurve.ts`, `meteora-damm-v2.ts` | FULL-only venue adapters. |
| `src/providers/firecrawl.ts`, `criterion-firecrawl.ts`, `origin-recovery.ts` | FULL-only page recovery and origin/Gecko supplements. |
| `src/providers/shared-model.ts`, `social-model.ts`, `social.ts` | FULL Shared and Social model stages and social collection. |
| `scripts/fast-sample.mjs`, `fast-rederive.mjs`, `capture-cli.mjs` | Fresh-token FAST measurement (V11), offline re-admission and route diff (V10), capturing CLI harness. |
| `tests/` | Production-facing tests; `tests/fixtures/fast/` holds public route-provider bytes only, with no captured source/model envelopes or local capture paths. |
| `README.md`, `CONTRIBUTING.md`, `plans/backend-v1/` | Operator commands and limits; two-person ownership contract; proposed policy source (documented ≠ implemented). |
| Local-only: `AGENTS.md`, `bridgecode/`, `agentic/analysis.md`, `.data/`, `.env`, `artifacts/` | Agent instructions, task board, operator data, keys, raw evidence store; never committed. |

## Run and test

- `npm ci`; `npm run build`; `npm test` (exit 0; the 16 FULL-baseline tests are marked `todo`, which Node reports as 23 because 7 nested subtests inherit it).
- One token: `node dist/src/cli.js <CA> --fast --config .data/config.json` (`--json` for machine output). `.env` loads from the project root.
- Fresh sample: `node --env-file=.env scripts/fast-sample.mjs --out <dir> --n 10 --exclude-dirs <earlier dirs>`; resume a killed run with `--resume <dir>`; own CAs with `--mints <file>`.
- Offline FAST check: `node scripts/fast-rederive.mjs .data/cycle-b/live2 .data/cycle-b/live3 --db-dir <empty dir>`. Only `live2`/`live3` are v3 captures; v2 captures (r13, r14, recheck3) are refused (`FAST_POLICY_RETIRED`) unless run with `--dist .data/cycle-b/dist-base`. Read `summary.errors`: a refused bundle is an error, not a zero-diff pass.
- Codex sandboxes have no network; live runs happen from the user's terminal or the root session (the harness may kill long background shells under memory pressure; `--resume` recovers).

## Known gaps (with trigger)

- **DBC/pump-curve pool without RPC**: on an RPC outage (or a failed buy simulation) the program-owner check cannot run, so `LIQ-01` is judged from RugCheck's `lpLockedPct` for the route pool (labeled third-party) instead of the program-held 0 rule, or is UNKNOWN when the pool is absent. Trigger: first such token observed live.
- **RugCheck cause collapse** (`rugLiquidity`, `domain/rugcheck.ts`): with HTTP 200, a malformed body, wrong mint, non-array markets and an absent route pool all render "Route pool not covered". Unobserved. Trigger: first such report.
- `ADV-03` rarely reaches 3 in-window posts from 3 authors; same-ticker tokens can be counted via `$SYMBOL`. `Qm` IPFS CIDs not on filebase stay unread.

## Durable constraints

- **Scope.** Research only: no frontend, signing, custody, trade execution, discovery monitor or calibrated profit claim. Missing risk, age, size, horizon and exit settings are user-owned UNKNOWNs. Circulating cap is not FDV; pool age is not token age. A known invalidation stays visible despite unrelated missing evidence. Later buys do not expand original-quantity exit legs. Fixture values are never used for live analysis.
- **Secrets and consent.** `.env` loads only at CLI startup (process variables win); `.env.example` has blank keys; doctor reports presence only. Hosted calls need visible consent: interactive y/yes, or `--full`/`--fast` in automation; `--partial` is RPC/DEX only. Never print or copy key values.
- **Evidence.** Raw provider bytes are stored under SHA-256 names and replay never re-fetches; user imports cannot claim LIVE provenance; an INVALID snapshot is never reparsed into a new result. Only exact-mint source text binds a page.
- **Ownership.** `CONTRIBUTING.md` is the two-person contract: the project owner owns Checklist 1 (entry) and shared contracts/Service/CLI; the collaborator owns Checklist 2 (management/ledger). The public GitHub repo excludes the local-only paths above; branch work uses `codex/` branches, no force push. Repository visibility is the user's choice (issue #1).
- **Agents.** Root orchestrates and reviews; Terra edits `src`, Luna edits tests/scripts/fixtures, via codex with persistent drivers; the task board is `agentic/analysis.md` (local).
