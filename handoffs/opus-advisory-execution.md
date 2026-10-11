# Accepted execution result — opus-execution-2026-10-11

The O26 complete-window collector is integrated and verified. Claude Code `claude-opus-5-5` implemented the acquisition/decoder/integration slice; Codex executed the unrestricted tests and fresh token runs, corrected the runtime execution filter, and completed independent native review. The earlier mediated CLI timeout did not produce code; the later direct execution in the isolated checkout did.

- Typecheck/build PASS; full regression **893/893 PASS**; focused account tests **11/11 PASS**.
- First review FIX: caught failed CPIs could contribute cancelling transfers. The one correction binds instruction positions, programs, depths and successful ancestors to runtime logs; missing/inconsistent logs fail closed. Terminal review **PASS**, root acceptance verified.
- Fresh approved-profile token snapshot `744d0138-4739-40e4-a566-0ac21d8e6315`, cutoff `2026-10-11T21:14:25.417Z`, hash `45a48f412bbbf19f0df7af16df4ca7eb6e2fe4dd3ffca12673de906e78fa461b`: retained raw-bundle reconstruction, idempotent persistence, show and replay PASS.
- **O26 newly KNOWN**: complete 20:00–21:00 UTC selected-pool hour, all 16 trader token accounts, 18 account receipts, zero qualifying buy/sell inventory-return motifs. Zero is a scoped measured count, not proof of organic activity or human ownership.
- Advisory **16/50 KNOWN**, 32 MISSING, 2 TRUNCATED: **34 unresolved**, down from 35 in the accepted baseline. All five advisory groups remain UNKNOWN. Required checks **27/27 known**, zero required UNKNOWN in this run. Management 15 NOT_RUN / NO_ACTIVE_THESIS.
- O28 remains KNOWN with fee-exclusive net 3.684219670 WSOL in the new hour. The earlier hour's 2.508872602 WSOL is preserved, not overwritten. Saved baseline 4809bbbb show/replay remains identical.

New source: `src/providers/advisory-window-accounts.ts`; integration in app advisory/live/service and domain version labels. Proof/facts/policy advance to v7/v8/v8, preserving saved v1–v7 replay and current O28 window-v3 fee semantics. The shared 150-request allowance remains; account acquisition has a dedicated 64-request allowance under the same deadline. Actual raw receipts and operator DBs remain private.

The assignment below records the original baseline and execution instructions. This cycle is complete; the next acquisition cycle should target another evidenced missing prerequisite rather than rerun this accepted slice. Reference `agentic/architecture.md` for maintained boundaries.

---

# Opus 5.5 execution handoff: acquire missing evidence, then implement

## Assignment and completion

You are the Claude Code execution worker for cycle `opus-execution-2026-10-11`. Use the exact installed model `claude-opus-5-5`, with high effort and no fallback model. The user called it “Opus 2 5.5”; the available, previously verified executor is Claude Code Opus 5.5. Report the resolved model from the CLI result rather than claiming an unavailable model name.

Your deliverable is one tested, evidence-backed vertical slice that resolves a remaining advisory measurement on the user's actual token, or materially acquires its missing historical inputs with an explicit explanation of what still prevents resolution. You have authority to run public-source probes, write collectors and reconstruction logic, and run local tests. This is an execution assignment. Once you demonstrate a usable source and freeze the exact measurement contract, implement the slice instead of ending with suggestions for another agent.

**Observed executor limits and coordination:** this Codex-hosted Claude CLI confirmed `claude-opus-5-5` but denied Write and Node/Bash execution even when edits were requested by launch flags. Its managed worktree under `~/.codex` was also unreadable; the allowed isolated checkout is now the parent repository's ignored `.data/opus-execution-checkout/`. Root will not override those denials. In this harness, use Read/Grep/Glob for repository inspection and return precise public acquisition requests, then complete source patches and test commands to the root. Root performs those authorized actions with its own tools and returns actual responses/results to this same Opus session. Opus remains the acquisition/implementation lead; root is the command/file executor and independent integration owner. Do not claim an action ran merely because you supplied it. In an independently launched Claude Code session where the owner grants these tools, the direct execution instructions below apply without mediation.

For root-mediated steps, return an `execution_requests` array containing each action's purpose, exact command or public HTTP/RPC request, worktree-relative output path, expected evidence fields and failure/completeness conditions. Keep requests free of credentials and unrelated files. After root returns actual evidence, author complete patches for your owned files rather than requesting another research-only handoff. Root writes progress/result files and the local board on your behalf. Flag any required scope extension explicitly. This mode changes the available executor, not the metric acceptance requirements.

The long-term goal is zero unknowns. This cycle must make measurable progress without changing what a metric means. A lower count obtained by relabeling absent evidence, redefining a denominator, or manufacturing an identity is a failure. If no investigated target can be completed, return the retained acquisition evidence and exact blocker; do not add speculative production code to make the cycle appear productive.

The root Codex agent owns integration, the final real-token run, native implementation review, commits, pushing and PR updates. You are not the independent reviewer. Do not launch another reviewer or child agent, commit, stage, push, merge, edit the PR, or change branches. You are not alone in this repository; preserve other agents' work and do not revert changes you did not make.

## Inputs and starting state

- Token: `3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump`, Solana mainnet.
- Approved research profile: $25 position, six-hour horizon, maximum transfer fee 1%, entry impact 2%, exit impact 3%, round-trip friction 10%, direct-control and removable-liquidity limits 10%, `ALL_AGES`.
- Integration branch: `camilo_work`; baseline commit `ded455992311dcfbe9f126c6743a18962f7ad3c7`.
- Existing draft PR: https://github.com/LycurgusxLycurgus/MemeHunt/pull/3.
- You execute in the isolated worktree supplied by the launcher. Confirm `pwd`, `git rev-parse HEAD` and the empty tracked diff before changing source. A detached HEAD is expected. The parent checkout is not your editing workspace.
- The launcher provides ignored `.data/opus-execution/baseline/` with the accepted real run, its retained artifacts and SQLite database. These are immutable evidence. Make a separate temporary database for new experiments.
- Accepted snapshot: `4809bbbb-8a73-41b6-b268-335b992230c8`; cutoff `2026-10-11T16:56:52.258Z`; hash `5ee9888bfcbd37236f36cf548dc202ba76c6a5804cb91859d2b3515dbcffe453`.
- Baseline: **15/50 advisory measurements KNOWN; 32 MISSING and 3 TRUNCATED; 35 unresolved**. All five advisory groups remain UNKNOWN. Required coverage is 22/27. Management checks remain 15 NOT_RUN with `NO_ACTIVE_THESIS`. A known descriptive measurement is not a PASS investment signal.
- Known advisory IDs: `O28 A07 A08 A19 A20 A22 S07 S08 S12 C08 C10 C11 C13 C14 C15`.
- Baseline typecheck/build and 880/880 tests passed. The preceding fee-basis cycle ended with native PASS and root acceptance. This is a fresh acquisition cycle; do not reopen the completed review or spend the cycle polishing O28.

Read the complete local `AGENTS.md`, then `bridgecode/best-agent.md`, the active section in `agentic/analysis.md`, and relevant parts of `agentic/architecture.md`. Load any specialist actually triggered by your actions. Package-owned Bridgecode files are instructions, not editing targets. Your board must put the three-move decision brief first and record this cycle's actual acquisition/implementation state. Do not erase unrelated task sections if they are present.

The authoritative definitions are `plans/backend-v1/03-feature-registry.md`, clarified by `07-round-two-lessons-and-contracts.md` and `02-contracts-and-policy.md` in that directory. The runtime reason codes identify current gaps; they do not replace the feature definitions. `handoffs/checklist-2-collaborator.md` contains useful history but also older snapshots and old version labels. Use the accepted baseline above and current code for present claims.

## Ownership and permitted actions

You own changes within your isolated worktree to:

- New narrowly named historical/attribution collectors under `src/providers/` and their adjacent `tests/` files.
- Existing `src/providers/advisory-chain.ts`, `advisory-trades.ts`, `advisory-wallet-history.ts`, `advisory-context-history.ts`, `advisory-semantic.ts`, `advisory-social.ts` and `advisory-market.ts`, only as needed for the selected measurement.
- `src/domain/advisory.ts`, `src/domain/advisory-demand.ts`, `src/domain/advisory-contracts.ts`, `src/app/advisory.ts`, `src/app/live.ts` and advisory integration/regression tests, only for that complete slice.
- The smallest required provenance/version changes in `src/app/service.ts`, with saved replay compatibility tests. Do not alter unrelated service or management behavior.
- Your local `agentic/analysis.md` and ignored `.data/opus-execution/` acquisition evidence, progress and result files.

The root owns public handoffs, `agentic/architecture.md`, README, integration-board condensation and publication. Put proposed documentation corrections in your result rather than editing these owned files. Ask the root through `.data/opus-execution/progress.json` and your result if a necessary source change lies outside your ownership. Continue independent acquisition while waiting; do not extend scope silently.

Do not touch `.env`, credentials, auth settings, MCP/plugin configuration, `AGENTS.md`, `bridgecode/`, `.git/`, lockfiles or package manifests. Dependencies are already available. Keep public acquisition credential-free in this worker. If a credentialed hosted or full-token run becomes necessary, give the root the exact input/request contract; the root will run it without exposing secrets. Do not read parent checkout secrets or traverse user home directories.

Do not sign transactions, trade, fund wallets, register paid services, bypass access controls, or change the approved profile/thesis. Public RPC/HTTP reads and existing local fixture/replay checks are authorized. Use request timeouts, response-size bounds and cancellation. Preserve provider error responses as evidence, with sanitized messages. No secrets or private paths belong in public fixtures or docs.

Other-session paths excluded from this task are `.codex/`, `README_HUMAN.txt`, `agentic/design/`, `docs/`, and `memehunt-incomplete/`. Earlier local Opus research packets are historical context, not permission to edit these paths or treat partial observations as resolved metrics.

## Remaining measurements and their actual missing evidence

The launcher also writes `baseline/unresolved.json` directly from the accepted snapshot. Verify its 35 IDs and reasons against this table before choosing a target. State changes below are baseline-specific, not permanent assertions that a source is unavailable.

| ID | Baseline state | Evidence required by the existing definition |
| --- | --- | --- |
| O21 | MISSING | Versioned strong control-association edges, candidate groups, supply shares and sensitivity after removing weak edges. Inference must remain separate from ownership. |
| O22 | TRUNCATED | Holder-weighted fresh-wallet exposure under a declared age threshold and defensible earliest-activity coverage. Two sampled traders with older references are not holder-population coverage. |
| O23 | MISSING | Complete declared trade bins, independently specified funding/behavior indicators, null baseline and bin sensitivity. |
| O24 | MISSING | Fixed, evidenced creator/early-owner cohort; balances at two pinned states; decoded buys/sells and transfer separation over that same interval. |
| O25 | MISSING | Transfer-aware entry-cost and holding-age bands, realized fraction and current sells for a covered inventory cohort. |
| O26 | TRUNCATED | Bounded repeated inventory-return trade/transfer motifs with transaction-level proof and covered volume; declared coverage and arbitrage alternatives. |
| O27 | MISSING | Volume whose two ends belong to the same evidenced related-party group, divided by covered decoded volume; shared routers/pools do not establish related parties. |
| O29 | MISSING | Same-window price, quote notional, reserves/defined depth and impact plus a defensible comparable cohort baseline before flagging an anomaly. |
| O30 | MISSING | Official evidence identifying protocol bot addresses or attributable automated programs, bound to executed transactions and a covered-flow denominator; unidentified automation remains unknown. |
| A06 | MISSING | Independently reviewed cited style and persistence mechanism with history, proposed horizon, renewal/expiry evidence and contradictions. It is a hypothesis, not fitted lifespan. |
| A12 | MISSING | Comparable executable exit capacity across the validated competitor set, using identical size/impact methods and no duplicate routes. TVL is not capacity. |
| A13 | MISSING | Comparable positive net new economic participants across competitors; decreases separate; zero denominator undefined. |
| A21 | MISSING | Qualified, classified origins outside declared crypto/caller sources and a positive eligible post denominator; unclassified origins retained. |
| A23 | MISSING | Classified relevant price/chart posts and a positive classified relevant denominator; topic does not prove temporal price leadership. |
| A24 | MISSING | Same-scope repeated-author share, caller breadth, source novelty, mention/holder growth and paid visibility vector. |
| A25 | MISSING | Aligned differenced attention/market series, preregistered lags and sign convention, overlap, null test and uncertainty. |
| A26 | MISSING | Meaningful first-observed buyers and positive qualified posts over the same window with adequate buyer-history coverage. |
| A27 | MISSING | Comparable buyer/post changes with positive post growth; zero or negative denominator is undefined. |
| A28 | MISSING | Identifiable post-peak catalyst-free decay interval, declared fit, residuals and censoring. No identified regime means UNKNOWN. |
| A29 | MISSING | Same-window fixed-cohort selling, price, new-buyer growth, depth and concentration changes; descriptive association, not causation. |
| A30 | MISSING | Declared complete demand windows with meaningful new buyers and nonnegative decoded net quote flow; pre-window buyer baseline and missing buckets explicit. |
| S09 | MISSING | Positive independently qualified forward-call inventory; top1/top5 public-account event shares, without summing follower reach. |
| S11 | MISSING | Earlier/later comparable author windows, positive earlier denominator, intersections, churn/new shares and censoring. |
| S13 | TRUNCATED | Signed or explicitly verified public actor-wallet relationship with method/validity dates, or a separately labeled inferred edge. Co-signing alone does not certify actor identity. |
| S14 | MISSING | Bound actor's first relevant trade and first eligible call, with sign convention and adequate earlier-history coverage; otherwise a bound only. |
| S15 | MISSING | Bound actor's transfer/deposit/withdrawal/trade/fee history under declared cost basis, with realized/unrealized decomposition and censoring. |
| S16 | MISSING | Preregistered follower latency, size and exit rule with executable historical cost/liquidity constraints; hindsight best exits are upper bounds only. |
| S17 | MISSING | Bound public actor's pinned pre/post-call inventory and decoded subsequent sales, separating transfers and association certainty. |
| S18 | MISSING | Measured tracker-list inclusion, public repost delay and post-entry follow flow. Unmeasured true tracker population remains unknown. |
| S19 | MISSING | Historically covered entering actor groups after evidenced association collapse; no inferred independent people from distinct wallets. |
| S20 | MISSING | Repeated ordered promotion sequences across tokens, spacing/text/flow evidence, minimum repeated examples and null model. |
| C07 | MISSING | Recorded feature windows with lifecycle rules, persistence/hysteresis and reversibility; no lifecycle label from one current snapshot. |
| C09 | MISSING | Complete declared C11/C12/C15/C16 context and separate coverage. HOT/NORMAL/COLD requires experimental preregistered history/rules. |
| C12 | MISSING | Completed covered bridge in/out/net, canonical transfer deduplication, directions, independent finality and valuation. Provider “completed” and gross totals alone are insufficient. |
| C16 | MISSING | Covered launch/migration counts and distinct volume/fees/revenue series; matured-cohort survival needs specified complete follow-up. |

The present social sample has zero eligible denominators for several ratios. More arithmetic does not solve this. New authentic, token-bound, time-qualified source records might; unrelated ticker matches, promotional snippets without source pages, retrospective calls and duplicated posts do not.

### Execution checkpoint: actual O26 acquisition

Root-mediated public mainnet reads obtained all 16 requested token-account indexes and three additional successful transaction receipts. Every index reached an older-than-window witness or provider exhaustion. The independent Sol computation verified 22/22 pool instruction/account/signature bindings, 21/21 new response hashes, 24 raw balance transitions, three explicitly proved creation/closure transitions and 11 cross-transaction continuities. Raw receipt locations and exact vectors are in the isolated `.data/opus-execution/probes/o26/primary/` and `sol-mechanical-verification.md`. This is new acquisition evidence; **35 measurements remain unresolved until implementation and a fresh run certify the result**.

Two demonstrated implementation conditions now govern the selected slice. Some token accounts have zero net transaction balance change despite executed incoming/outgoing transfers, so a net-delta-only detector cannot certify inventory-return motif coverage; retain ordered executed legs and avoid counting a pool leg twice. Missing raw pre/post balances remain null, with separately bound initialization/closure proof where available. Also, the accepted live run admitted145 of150 network requests. Adding the account-history collector needs an explicit bounded allocation, not a hidden fetcher bypass. Root may allocate at most the new collector's64-receipt maximum in additional wrapped requests for advisory mode, while preserving the150-request limit for other modes and the existing deadlines. Record the actual current limit in diagnostics and test the global and collector bounds. Exact immutable-response reuse may reduce requests further; required canonical-state/semantic paths must remain usable.

## Acquisition-first execution sequence

1. Inspect the existing end-to-end flow and baseline unresolved reasons. Write a compact feasibility matrix for at most three candidate slices. For each identify the exact absent input, primary source candidate, interval/population, what a successful response must contain, and the smallest production integration. Do not spend the first phase rechecking all 880 tests or making an unfocused list of providers.
2. Prioritize **O26 complete bounded motif evidence**, **O30 officially attributable automated flow**, or **O24 pinned fixed-cohort inventory**, according to actual source feasibility. These are candidates, not orders to force a KNOWN result. O28's completed pool tape is a reusable acquisition primitive; inspect whether it truly supplies the selected metric's separate prerequisites. It supplies neither whole-wallet transfer history nor identity automatically.
3. Probe the fragile acquisition assumption before writing production code. Retain the exact public request, raw response, retrieval time, event/state times, mainnet/mint/pool binding, pagination and completion boundary. A success requires the measurement's actual fields and required coverage, not HTTP 200 or a provider summary. Inspect official current documentation/IDL before relying on unfamiliar or changed endpoints/program meanings.
4. Try a small number of genuinely different source paths. Public Solana finalized RPC is appropriate for executed transactions, cursor indexes and account states; official Pump IDLs/docs can identify instruction/program semantics; source pages or signed statements can bind a public wallet. An explorer can discover a signature, but its label is not sufficient evidence of automation/identity. RPC alternatives must verify mainnet genesis and comparable finalized context. Do not silently splice providers with different clocks or coverage assumptions.
5. After two distinct failed acquisition paths for a candidate, record why they fail and assess the next candidate. A single bounded retry may recover a transient timeout/429; do not hammer a rate-limited endpoint or repeat the same request indefinitely. Keep a total initial feasibility phase of approximately 30 minutes unless a demonstrated source is already yielding the necessary data. This is a decision checkpoint, not a requirement to abandon working pagination at a clock boundary.
6. If historical reads need new ongoing state, initialize a collector only when it has a defined production consumer, durable raw provenance, comparable window rules, and an observable future completion condition. Label baseline-only observations honestly; a new empty history table does not close a historical metric. Prefer retained existing receipts over a parallel history system.
7. Once feasible, freeze the selected measurement's unchanged definition, sample/population, input completeness rules, units, provenance schema and observable acceptance criteria in the local board. Implement one coherent collector → strict decoder → reconstruction → derivation → live ingestion → validation → regression slice. Do not broaden into all five groups.
8. Run the focused regression block, then typecheck and the full repository test suite. Use the actual newly retained public responses for a targeted real-token measurement probe. Send the root the precise proof of new acquisition and the integration-ready diff; request its credentialed full-token run if needed. Iterate only within the stable contract and this cycle's correction policy.

When all candidate acquisitions are blocked, finish with `BLOCKED_ACQUISITION`, exact requests/statuses/coverage gaps, any newly retained useful raw evidence, and the smallest prerequisite that would change the result. Do not convert a source outage into an adverse-token finding. When evidence is obtained but insufficient for KNOWN, distinguish `NEW_EVIDENCE_PARTIAL` from a resolved measurement and show the remaining condition.

## Relevant implementation map

- `src/app/live.ts`, `collectLiveToken` and `collectLiveSolana`: live collection order, frozen window end, raw receipt ingestion, current proof creation and final reconstruction. Use the existing injected fetcher/clock/cancellation mechanism.
- `src/app/advisory.ts`, `advisoryProofSchema` and `reconstructAdvisory`: request/artifact/evidence binding, strict namespace limits, deterministic reconstruction from raw responses, thesis context, additional metrics. A claimed normalized cache cannot certify a metric.
- `src/app/service.ts`, bundle validation and `replay`: current proof enforcement, source allowlist, normalized-cache equality, policy-version handling and saved semantic replay.
- `src/domain/advisory.ts`, `deriveAdvisory`: 50-metric defaults, evidence/time binding, aggregation and current measurement version. `src/domain/advisory-contracts.ts`: strict facts/metric/group schema. Groups remain UNKNOWN while any of their measurements is unresolved.
- `src/providers/advisory-chain.ts`: bounded mint/pool signature pages, parsed transactions and token movements. An indexed account reference is not necessarily a trade or signature by that account.
- `src/providers/advisory-trades.ts`, `decodeAdvisoryTrades` / `deriveAdvisoryTrades`: retained sampled pool trades, O26 motif components, O29 vectors and A30 hourly components. Inspect why sample completeness currently prevents certification.
- `src/providers/advisory-wallet-history.ts`: two lexicographically selected trader histories and older-reference bounds for O22; separate co-signing edges for S13. The source explicitly does not establish holder-population exposure or public actor binding.
- `src/providers/advisory-window.ts`, `collectAdvisoryWindow`, `decodeAdvisoryWindow`, `deriveO28Window`: complete selected finalized PumpSwap hour and fee-exclusive accounting. Reuse exact retained requests where appropriate; preserve all existing fail-closed conditions. These are read/reuse boundaries; request a root ownership extension before editing them.
- `src/providers/pumpswap-window-abi.ts`, `reconcileWindowQuote`: compact pinned official PumpSwap v2 methods, fee sweeps and instruction-specific quote accounting; no need to replace the pinned SDK for acquisition. Request a root ownership extension before editing this file.
- `src/providers/advisory-semantic.ts`: identical-corpus independent proposal/review, exact source/span and canonical-author qualification, persistence and forward-call classification. The worker has no hosted-model credentials; root owns credentialed calls.
- `src/providers/advisory-context-history.ts`: bounded Wormholescan records; canonical deduplication is implemented but independent finality/valuation/completeness is not established.
- `src/domain/advisory-demand.ts`: sampled buyers/post and marginal ratios, with explicit incomplete history and undefined denominators.
- `tests/advisory-*.test.ts`: repository-native collector, decoder, demand, wallet, semantic and integration regression patterns.

## Contracts to preserve

Preserve the 27 required checks, all 50 advisory definitions, five advisory groups and management separation. Advisory measurements remain descriptive; do not turn a detector into a hidden rejection predicate. The user's profile is a research configuration, not an active management episode or calibrated profitability claim.

Current versions are `advisory-provenance-v6`, `advisory-measurements-v7` and `research-screen-advisory-v7`; current O28 raw decoding is `window-v3`. If you change the meaning/shape of reconstructed saved evidence, introduce the minimum explicit new version at the responsible boundary and preserve old saved-version replay from stored facts. Do not reinterpret old raw receipts with new fee rules or weaken current live-bundle proof enforcement. New provenance needs forged-request/cache rejection tests. Increment versions only for a demonstrated changed contract, not automatically for documentation or a new failed probe.

For a new proof version, inspect every version-dependent dispatch rather than only adding an enum member. In `reconstructAdvisory`, the current ABI selection lists v5/v6 and fee-exclusive selection checks v6; a new current version must still select the existing window-v3 behavior while historical versions retain their exact old behavior. Append a new metric after older derivations of the same ID so it is not overwritten. Update all replay policy membership/attention/shared/advisory inclusion lists consistently. Ingest new receipts before the shared derivation freezes its complete parent-evidence list. Root integration support has traced these boundaries; verify them against your final implementation.

O28's accepted selected-pool hour was `[2026-10-11T15:00:00Z,2026-10-11T16:00:00Z)`: 25/25 successful transactions decoded, 22 trade events, 53 failed references and 30 non-swap invocations. Fee-exclusive buys were 3,393,902,299 and sells 885,029,697 WSOL atomic; net **2,508,872,602 atomic = 2.508872602 WSOL**. This is observed flow in one verified WSOL pool, not whole-token new capital, people or organic volume.

Preserve finalized-tip anchoring, cursor order/dedup, older-boundary or provider-exhaustion witnesses, post-tape pool binding and incomplete-on-cap/error behavior. Unknown instructions, failed fee identities, unsupported fee/reward fields and invalid event bindings remain fail-closed. Avoid adding unbounded public-RPC concurrency or making one collector's failure erase an unrelated known measurement.

Quote reconciliation is instruction-specific and uses exact atomic integers:

- Ordinary buy/buy_v2: core quote is `quoteAmountIn`; user gross is core plus LP/protocol/creator fees.
- Exact-quote buy variants: `quoteAmountIn` is gross; `userQuoteAmountIn` is fee-exclusive core; verify gross = core + fees.
- Sell variants: core `quoteAmountOut` = `userQuoteAmountOut` + fees; apply the declared fee-exclusive basis.
- Buyback is included within protocol fees, not added twice. Accrued unclaimed creator fees are stock, not a new charge. Unknown cashback/holder reward semantics remain unsupported.

Retain raw immutable evidence and both event/state and retrieval clocks. Data available after the analysis cutoff cannot enter that historical snapshot. Never graft a new response into an old failed run and claim the original snapshot passed. Current live probes get new temporary run directories and snapshots.

## Validation and reporting

Use Node >=24 and the existing package scripts:

```sh
npm run typecheck
npm test
```

`npm test` builds and runs `node --test dist/tests/*.test.js`. After relevant source changes use a focused command such as `npm run build` followed by the exact affected `node --test` paths. The historical baseline is 880 tests, not the obsolete 76 in early handoffs. State the observed current count and failures. Do not rerun an already passing broad block without a new change or unresolved concern.

Test the real collector/decoder/reconstruction functions, not only a helper that repeats implementation. Cover observed success, missing/truncated acquisition, wrong mainnet/mint/pool or interval, cursor duplicates/caps, malformed numbers/units, forged request/receipt/cache and out-of-cutoff evidence as appropriate. Add deterministic public-response-shaped fixtures with private information removed. Preserve saved replay and the O28 fee-exclusive regressions.

Write `.data/opus-execution/progress.json` at each material boundary: chosen target, source acquisition success/failure, acceptance freeze, implementation complete, focused tests and final result. Include `cycle`, `phase`, `targetIds`, `newEvidence`, `changedFiles`, `blocker`, and `nextAction`. Keep it factual and secret-free; no private deliberation. Root can inspect it while you work.

Write `.data/opus-execution/result.md` and finish your CLI response with the same report:

1. **Status:** `READY_FOR_ROOT_REVIEW`, `NEW_EVIDENCE_PARTIAL` or `BLOCKED_ACQUISITION`; exact resolved model.
2. **Target and delta:** baseline/current state for each touched ID; newly KNOWN separately from partial acquisition, implementation repairs and transient source recovery.
3. **Evidence:** exact public source URLs/RPC method and sanitized parameters, raw artifact paths/hashes, event/state/retrieval times, mainnet/token/pool binding, page/population/window completeness, units and exclusions.
4. **Mechanism:** exact changed files/symbols, caller/reconstruction path, version changes and old replay protection; proposed architecture notes.
5. **Validation:** commands, exit status, exact observed test counts, actual-token measurement probe and its limitations. A targeted public probe is not the root's full-token run.
6. **Unresolved prerequisites:** what remains missing, which probes falsified candidate sources, why another identical retry would not help and what concrete input would unlock the next step.
7. **Root next action:** how to inspect/apply your diff, focused/full regression paths, exact credentialed run needed, and any open scope decision.

The root applies Bridgecode's fresh native review after integration and stable tests: first PASS ends review; first FIX/REPLAN permits one coherent correction and one terminal reviewer; terminal UNRESOLVED stops implementation in this cycle. You do not issue a simulated PASS, consume that independent review budget or initiate another correction cycle. If a root terminal verdict arrives, preserve recovery state and follow it.

Stop when the selected slice is implemented and validated for root review, or when distinct acquisition probes establish the precise external blocker. The handoff succeeds through usable evidence and execution, not a long provider list or repeated green test output.
