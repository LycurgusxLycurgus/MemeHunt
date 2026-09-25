# Implementation packets and acceptance evidence

This document is the execution handoff for a separate implementation task. This architecture task creates documents only. Packet estimates are deliberately expressed as bounded outcomes and prerequisites rather than speculative dates or model token counts.

## 1. Delivery strategy

Implement one vertical slice at a time. Make an offline result observable before connecting many vendors. Then connect real chain/market data across **Solana, BSC, Base, and Robinhood**, while adding social/semantic inputs through the same contracts. The initial source budget is zero paid API spend; optional hosted services cannot be a prerequisite for the core commands.

Completion labels distinguish an entry engine from the user's complete manual phase:

- **Foundation complete:** offline input-to-verdict, persistence and replay proven; no claim of live due diligence.
- **Entry engine complete (P07):** first-class requests/capabilities for all four launch chains; certified named paths where feasible; three pillars evaluated from live/free/imported evidence; saved entry checklist and failure explanations. Any uncertified venue is an explicit limitation.
- **Phase 1 complete (P07 + P11):** both entry and management checklists work on manual input, with saved thesis activation, age/cap rule context, optional entry/sale records, deterministic validation/invalidation and exit/DCA-out proposals, and journal/replay. No paid service, scanner or order execution is required.
- **Research-depth complete:** selected longitudinal features, point-in-time outcomes, and evaluation tools validated. This is a separate increment, not required to prove the initial workflow.

The large registry is a roadmap. B features are implemented for baseline behavior; R/E features remain absent/unsupported until their packets and evidence are ready. Baseline advisory features may return UNKNOWN when free sources cannot supply them. Required checks cannot be made advisory merely to obtain a PASS.

Recommended order: P00/P01 -> P02/P03 -> P03a/P03b/P04 -> P05/P06 -> P07 -> P11. P08–P10 deepen history/actors/calibration as evidence accumulates; their packet numbers do not make them prerequisites for P11. Phase 2 new-pair discovery and Phase 3 automated trading remain separate future projects. The current task produces the plan, not any runtime implementation.

## 2. P00 — feasibility and contract lock

**Outcome:** a reproducible local skeleton and an evidence-backed capability matrix before substantial integrations.

**Inputs:** this package, current repository instructions, target Windows environment, and official references. No existing app should be assumed. Inspect current local state rather than relying on this plan's initial inventory.

**Work:**

1. Select/pin Node LTS patch, TypeScript and the minimal dependency set; create package lock, strict compiler config, build/test/CLI scripts, `.gitignore`, `.env.example` with names only, and a concise README.
2. Confirm SQLite driver works on Windows; verify atomic artifact writes and UTC/decimal/bigint boundary conversions.
3. Define launch chain IDs/genesis identifiers, quote-asset registry, and public/free endpoints from current primary sources. Read-only bounded probes verify actual network identity.
4. Test DEX Screener, GeckoTerminal and GoPlus response shapes/rate behavior for an explicitly selected public sample; evaluate free Blockscout access/Robinhood coverage. Do not sign up for paid plans or use demo credentials as permanent production access.
5. Pin first venue deployment references: Pump/PumpSwap, Pancake V2, Base Uniswap V3, Robinhood Uniswap V4. Robinhood V4 support must specify PoolKey and hook handling, not reuse the Base V3 adapter.
6. Determine viable simulation paths without real funds: local pinned fork where free state access permits; supported Solana simulation/state setup; quotation fallback otherwise. Record where full simulation remains unavailable.
7. Record free social access actually available. Evidence imports are required regardless; X/Telegram live collection requires valid access and the user's source scope. Assess TinyFish Search/Fetch first and Parallel Search/Extract as an alternative using [08's benchmark](08-technology-decisions.md), without enabling metered overage. Record free macro/launch/bridge series individually; no endpoint invented from a dashboard.
8. Preserve Gemini 3.5 Flash-Lite/high as preferred primary extraction. Record free account/API feasibility; actual integration/quality proof belongs to P06 after reading the user's forthcoming model document. No hosted call is needed to complete P01. Import mode remains required; local inference is an explicit alternative, not a mandatory download.

**Owned files:** initial package/config files, capability documentation, chain/venue registries, schema skeleton only as needed for probes, and durable sanitized fixtures. Do not create empty provider implementations.

**Proof:** clean `npm ci`, typecheck/build/test; SQLite round trip; identity probe per launch chain or exact provider failure; recorded primary deployment references; zero paid calls; adapter feasibility table distinguishing documented, probed, supported, and blocked.

**Stop condition:** enough evidence exists to implement P01–P04 without inventing endpoints, venue IDs, entitlement or simulation behavior. If a free provider is blocked, complete unaffected foundation work and document the supported alternative. Do not claim launch-chain certification from docs alone.

## 3. P01 — offline contract-to-verdict spine

**Outcome:** a real CLI command consumes sanitized fixtures and produces a persisted, explainable verdict with no network access.

**Work:** encode identity/request/evidence/observation/feature/check/snapshot schemas; build SQL migrations and artifact storage; implement request normalization, policy evaluator, deterministic report, JSON renderer, `show`, `explain`, and error/exit conventions. Fixture provider returns stored observations through the same application service future live adapters use.

Implement all verdict branches and precedence with minimal representative features. Define the initial checklist manifest now; unsupported/unimplemented feature dependencies yield UNKNOWN rather than fake green checks. Parse policy config and validate every required parameter. Add `dd config init` to create a free-local config with live risk parameters unset, and `dd config validate` to report what remains to select. Tests may use the explicitly named fixture risk profile.

**Proof:** synthetic PASS, hard FAIL, missing-data FAIL, unsupported FAIL, and opportunity WATCH cases; persistence/read-back; no network in offline mode; `--json` one document; hidden checklist retrievable; secret/terminal-control redaction.

**Stop:** command and decision contracts work end to end. Do not begin actor intelligence, real-time collection, scoring ML, or provider sprawl.

## 4. P02 — chain identity and token controls

**Outcome:** live read-only token identity and baseline safety observations for both Solana and EVM families.

**Work:** implement chain resolution with ambiguity handling; endpoint identity checks; mint/standard parsing; supported Token-2022 extensions; EVM code/token semantics, known proxy patterns and controls; numeric normalization; observed control allowlists by venue. Return unresolved control surface where inspection cannot establish supported behavior. Verify account-vs-mint, EOA-vs-token, and wrong-network cases.

**Owned features:** O01–O07, C01–C03 and relevant conflict handling. GoPlus is supplementary corroboration with explicit missing flags, not a code audit replacement.

**Proof:** Solana normal mint, mint/freeze authority, transfer hook/delegate/unsupported extension; EVM ordinary token, supported proxy, changing implementation, unknown proxy, mutable tax, revert and non-token cases; identical address on two EVM chains requires chain selection; testnet cannot pass mainnet identity.

**Stop:** supported token-control observations are exact and uncertainty is preserved. Do not attempt a universal bytecode decompiler or invent static proof of all possible transfer paths.

## 5. P03 — markets, holders, and free provider normalization

**Outcome:** verified market discovery, price/supply semantics, baseline holder bounds, and meaningful coverage reporting.

**Work:** integrate DEX Screener and GeckoTerminal for distinct market/history purposes; normalize price, pool orientation, market cap versus FDV, quote valuations and timestamp units. Add selected free holder/explorer access where available. Implement account-owner aggregation and annotated system-owner exclusions. Reconcile top balances against direct chain reads where possible. Observe provider truncation/rate errors rather than inferring a complete universe.

**Owned features:** O02, O08 discovery portion, O17–O20, O28 baseline, O30 where publicly attributable, C04 and C06. Inferred clustering remains P09.

**Proof:** missing market cap does not become FDV; duplicate pairs do not double liquidity; counterfeit quote asset is not $1 by symbol; top-account list is not total holders; missing tail supports a lower bound or UNKNOWN; string flags/large integers are correctly decoded; partial pagination and stale explorer state visible.

**Stop:** no baseline feature reports population completeness it did not establish. Save free-access gaps by check and chain.

### P03a and P03b — round-two baseline context, after P03 and before P07

These are baseline advisory subpackets, specified in [07](07-round-two-lessons-and-contracts.md), not hidden trade-signal requirements. Implement only useful local modules under existing providers/features and versioned schemas; no market-context service.

**P03a outcome:** completed-candle normalization and C08/C13/C14. Prove market/quote orientation, missing/zero-trade distinctions, migration boundaries, strict pivot tie behavior, simultaneous extrema exclusion, confirmation versus availability time, minimum history, and future-candle invariance. No chart-reading LLM. User-requested ZigZag remains an alternative requiring an explicit causal definition, not an unpinned dependency. Stop when descriptive context and typed corroboration work with honest UNKNOWNs.

**P03b outcome:** C09/C11/C12/C15/C16 from verified free feeds/imports. Prove chain-set coverage, comparable window shares, bridge direction/dedup/completion/finality, USD valuation, pending transfers, volume-versus-fees/revenue, macro instrument identity and immature-cohort UNKNOWN. Test Robinhood absent from a provider without removing it from the comparison universe. Fitted regime labels remain P10; prospective survival requires P08. Stop when available context is observable and unavailable series are identified without blocking unrelated DD.

## 6. P04 — venue-specific execution and liquidity checks

**Outcome:** amount-sensitive entry/exit analysis on certified launch venues, with distinct quoted and simulated levels.

**Work:** complete venue provenance and withdrawal-control adapters, fee handling, acquired-quantity sell, diagnostic size grid, and conservative cost accounting. Implement direct supported quoting and optional maintained aggregator fallback where free. Add read-only stateful simulation only on a supported path with valid balance/allowance/account setup.

Subpackets are independently reviewable:

| Packet | Venue | Main mechanism to prove |
|---|---|---|
| P04a | BSC Pancake V2 | Reserve orientation, protocol fee rounding, supported transfer taxes, LP control |
| P04b | Base Uniswap V3 | Tick/liquidity-aware quote, positions/withdrawal model, correct deployed quoter |
| P04c | Solana Pump/PumpSwap | Curve real/virtual reserves, mode/version, fees, migration and canonical pool state |
| P04d | Robinhood Uniswap V4 | PoolKey/manager identity, hooks/fee support, quoter and supported simulation path |

**Owned features:** O08–O16 and execution policy checks.

**Proof:** boundary/large sizes, integer rounding, fees and taxes not double-counted, buy-then-sell reserve effects, no route vs provider error, wrong pool binding, noncanonical pool, stale quote, unknown V4 hook, withdrawal lock expiring inside horizon, curve migration during collection, simulator setup failure vs actual transfer restriction. Network guard must prove no broadcast/sign method is available.

**Stop:** each venue has a certificate describing exactly supported paths. If one chain's free simulation cannot be established, its QUOTED or PARTIAL status remains explicit. The research-screen policy can use valid quotes; execution-verified cannot. An entirely uncertified Robinhood venue remains an unresolved launch limitation to report to this planning task, not a reason to pretend generic EVM support is enough.

## 7. P05 — social evidence, provenance, and imports

**Outcome:** social and external evidence can be ingested at zero API spend with stable IDs, temporal metadata and auditable scope.

**Work:** implement an evidence-bundle schema and CLI importer; sanitized public webpage/RSS collection where allowed; exact-address, ticker and narrative query classes; dedup/repost groups; authors/source communities; paid visibility data; provenance and truncation manifests. Import public-channel exports or user-curated sources without assuming they represent all Telegram/X activity. Live X/Telegram adapters are conditional subpackets, not launch requirements under an unavailable entitlement.

An import bundle contains source identity, URL/record ID, publication time, captured time, author/source-community references, content/excerpt, user-provided scope, and verification state. Malformed timestamps, duplicate conflicting records, invented platform metrics and invalid URLs are rejected or explicitly quarantined. Never fabricate original source IDs for a paste; assign a local import ID.

**Owned features:** A15, S01–S06, S08, S10, and deterministic ingredients of A16–A18/A22–A23.

**Proof:** exact address vs ticker collision, cross-chain duplicate ticker, quoted criticism vs endorsement, repeated copies across channels, unknown author fields, missing original timestamp, deletions, edited posts, Spanish/English content, budget truncation, and injected instructions.

**Stop:** imported evidence and at least one available free collection path produce the same normalized contracts. No global attention or unique-human reach claim.

## 8. P06 — semantic extraction and narrative competition

**Outcome:** narrative and social meanings become structured, cited observations that code can use.

**Work:** implement deterministic packet construction, semantic schema, export/import, preferred Gemini 3.5 Flash-Lite/high adapter under [08](08-technology-decisions.md), provenance validation and bounded repair. Read the user's model document before locking API settings. Extract narrative/game/style/persistence/origin/post role/association, then compute qualified counts and baseline attention windows. Implement bounded competitor lookup/contract validation and observed canonicality components. Local inference is an explicit optional alternative, not the primary recommendation.

**Owned features:** A01–A06, A09–A11, A14, A16–A18, A22–A23; C05. The extractor cannot invent a source/competitor or set the final verdict. It may return unknown. A06 game-independent style does not silently change ATT-02.

**Proof:** false narrative match, same meme with multiple chain-qualified contracts, satire/news/retrospective calls, conflicting origin claims, unsupported quote/citation, prompt injection, numeric hallucination, insufficient corpus, local model unavailable, invalid imported packet hash, and deterministic replay of frozen extraction. Test that adding unrelated promotional prose cannot override a security failure.

**Stop:** complete imported-semantic flow works without a paid API. Gemini/high is enabled as primary only after free access, exact configuration, public/redacted packet and labeled quality proof; absent prerequisites remain a reported integration limitation, not grounds for silent model substitution. If selected, local mode needs its own tests. No assertion that any thinking/temperature setting makes fresh generation perfectly repeatable.

## 9. P07 — integrated free-first release

**Outcome:** the actual product loop works, across the agreed chains, with truthful limitations.

**Work:** integrate all baseline checks; finalization and quote refresh/staleness; `capabilities`, `doctor`, `refresh`, `diff`, cost/error summaries and concise default output. Document one-time configuration of size/horizon/risk profile so future interaction can be just a pasted contract. Include a fully offline demo and a live/free/import-assisted walkthrough.

**Acceptance:**

1. A contract input on each of Solana/BSC/Base/Robinhood produces a persisted valid analysis attempt or precise identity error; chain support is not inferred from address format alone.
2. At least one certified route path per launch chain is the target. Any unproven path is an explicit release blocker for claiming that chain quote-supported, though the partial-result workflow still ships as partial.
3. All three pillars have real evaluators; imported evidence is labeled, not silently presented as live platform coverage.
4. Synthetic fixtures prove every verdict branch, and live diagnostics never use fixture evidence to fill gaps.
5. The checklist is saved and retrievable; explanation does not recollect or change the decision.
6. Missing required data cannot PASS. Costs are bounded and paid calls are disabled by default.
7. Replay is offline and hash-stable; refresh creates a new snapshot; diff identifies evidence, policy and semantic changes separately.
8. No wallet signing, broadcast, posting, autonomous scanner, or frontend has been added.

**Stop:** the entry workflow works and its limits can be measured. This is not complete Phase 1 until P11's management workflow passes. Return missing-capability statistics to this planning task; no profitability claim is required.

## 10. P08 — historical storage and outcome measurement

**Outcome:** repeated analyses can be evaluated without hindsight leakage.

**Work:** optional explicit watched-set collection with durable cursors/jobs; point-in-time joins; outcome windows; descriptive attention/market series; future labels kept separate from feature inputs. Record every submitted candidate, including failures, abandoned tokens, and missing-data cases, to reduce survivorship bias.

**Owned features:** A19–A21, A24, A26, A29–A30, C07, longitudinal C08/C09/C16 enrichment and selected thesis predicates. Baseline C08/C09 already belongs to P03a/P03b. Some historical results require accumulated data.

**Proof:** late-arriving social data, actor label corrections, reorg invalidation, overlapping windows, event time vs availability time, token death/no market, missing exit state, and queue restart. Longitudinal data cannot be forged by repeating a current snapshot with different timestamps.

**Stop:** outcome joins are time-correct and censoring is explicit. No fitted score is promoted yet.

## 11. P09 — control graph and actor dossiers

**Outcome:** selected control/actor hypotheses are measured from sufficient history.

**Work:** evidence-bearing relationship tables, bounded wallet neighborhood collection, creator/early-wallet cohorts, public identity mapping, strategy/horizon-specific actor history, inventory/association and call-event metrics. Start with a small curated actor set only after the user supplies/selects legitimate sources; the pre-plan's 20–50 actors is a research-size suggestion, not a compulsory launch database.

**Owned features:** O21–O27, A07–A08, A12–A13, S07, S09, S11–S15, S17, S19; deepen A06 with observed history. C10's baseline manual predicates belong to P11 and do not require graph/actor research. Reuse existing evidence rather than building shadow histories.

**Proof:** exchange/common-funder false positives, weak-edge transitivity, owner exclusions, transfer cost basis, partial transaction history, same actor across platforms, duplicate calls, public-label availability time, and normal arbitrage alternatives.

**Stop:** outputs are bounded observations with provenance; no guaranteed “smart money” or named hidden-wallet inference.

## 12. P10 — empirical evaluation and policy revisions

**Outcome:** determine which features improve a clearly defined selection objective.

**Work:** implement experimental features only when their data contract is satisfied: O29, A25/A27/A28, S16/S18/S20 and C09's optional fitted regime classifier. Define target and baseline before fitting; preserve dataset hashes, time cutoffs and evaluation code. Evaluate safety detection, data coverage and opportunity ranking separately. Measure v0 ATT-02 false rejection by spark/wave/community style before proposing a named style-sensitive policy; no retrospective threshold selection on winners.

Compare to simple baselines: all eligible candidates, mechanical gates only, liquidity/age matched candidates, and attention-only screening. An elaborate narrative score should not be retained just because it tells a compelling story.

**Proof:** chronological train/validation/test split; group related tokens/narratives/creators to reduce leakage; walk-forward evaluation; sensitivity by chain, venue, game, horizon, size and market regime; performance including costs/censored outcomes; ablation of correlated attention/social features; sample size and uncertainty reported.

**Stop:** publish an evaluation report with supported conclusions, including “insufficient evidence” or “feature adds no measurable value.” Promote thresholds only under a new policy version. No trading system is part of this packet.

## 13. Coordinated validation block

Run affected checks after each packet; run the integrated regression block after the final baseline code is stable. Do not repeatedly rerun passed unrelated suites without new evidence.

| Layer | Required tests and evidence |
|---|---|
| Type/schema | Requests, observations, features, check manifests, snapshot versioning, semantic imports |
| Pure policy | Full precedence truth table; advisory independence; NOT_APPLICABLE validity; unknown propagation |
| Arithmetic | Atomic amounts, decimals 0/6/9/18 and larger supported bounds, rounding, signed flow, zero denominators, fee reconciliation |
| Identity | Same address across EVM chains, wrong endpoint, non-token, ambiguous URL, Solana case/mint ownership |
| Adapter contracts | Sanitized recorded responses; omitted/null/false/zero; pagination; rate/auth/schema errors; provider time semantics |
| Venue | Official implementation/test-vector parity for supported mechanics; unsupported pool/hook/extension refusal |
| Storage | Real temporary SQLite DB, artifact atomicity, crash recovery, migrations, duplicate ingest, backups/restoration |
| Time | Frozen clock; delayed data; reorgs; stale quote at finalization; missing windows; evolving actor labels |
| Semantic | Labeled mixed-language packet set; citation precision; invented entity rejection; injection resilience; model unavailable |
| CLI | stdout JSON purity, stderr progress, exit codes, inspect/replay/refresh/diff, cancellation and Windows quoting |
| Security | No signing/broadcast method; secret redaction; safe URL fetching; path validation; malicious terminal content |
| Live opt-in | Bounded free calls on each launch chain and available social source; exact capability result, never run in default CI |

Meaningful invariant tests: adding an advisory positive cannot overcome a hard failure; deleting required evidence cannot convert FAIL to PASS; a larger requested size reuses neither a smaller-size quote nor its decision; source ordering/JSON key ordering does not change replay; duplicate social copies do not increase independent-source count; testnet evidence cannot satisfy mainnet checks; present-day labels cannot enter an earlier knowledge cutoff.

Do not assert global monotonic price impact across arbitrary route selection: a different route may legitimately improve a larger quote. Test monotonic behavior only under a fixed model/path where mathematically justified.

## 14. Evaluation dataset and outcomes

For every snapshot, record outcome windows such as 5m, 15m, 1h, 6h, 24h and 7d where useful. Windows are configurable and fixed before evaluation. Store observed spot MFE/MAE separately from executable outcomes; both can be useful, but they answer different questions.

Executable outcome requires historical entry and exit state or a documented approximation. Evaluate a fixed-size position with acquisition quantity, fees, gas, tax, liquidity and latency. OHLCV alone cannot reconstruct V3/V4 liquidity or prove a follower could exit at the candle high. Missing historical state produces a censored executable label; it does not produce zero return or a fictional perfect fill.

Track liquidity collapse, route disappearance, authority changes, canonicality retention, narrative persistence, new-buyer/flow response, and adjudicated incidents. Distinguish observed failure from source outage. “Token dead” should be a measurable inactive/unroutable condition with observation coverage, not a story assigned after a price decline.

Use the actually observed candidate population as the evaluation universe and document selection bias. Historical backfills are labeled reconstructed, because deleted posts, edited calls and survivorship may make them unlike live decision-time data. Include rejected candidates in future sampling to estimate false rejection; manually selecting only winners invalidates the experiment.

Threshold fitting must use training data only. Reserve later periods for validation/test and group related assets so a copied narrative does not leak across folds. Report number of tokens, narratives, unique source days and outcome coverage; ten correlated tokens are not ten independent experiments. Measure false PASS/false FAIL for defined safety labels, unknown rate, cost/latency, and conditional executable outcome distributions. Do not report a calibrated success probability without demonstrating calibration.

## 15. Free-first configuration shape

Illustrative structure, not live investment settings:

```yaml
profile: free-local
chains: [solana, bsc, base, robinhood]
budget:
  paidApiUsdPerRun: "0"
  paidApiUsdPerMonth: "0"
  externalRequestsPerRun: 150
  socialRecordsPerRun: 200
  competitorTokensPerRun: 10
  collectionDeadlineSeconds: 120
semantic:
  mode: import
  preferredProvider: google
  preferredModel: gemini-3.5-flash-lite
  preferredThinking: high
  automaticModelFallback: false
  externalPacketClass: public-redacted
  toolsEnabled: false
defaults:
  sizeUsd: null
  horizonSeconds: null
risk:
  maxEntryImpactBps: null
  maxExitImpactBps: null
  maxRoundTripLossBps: null
  maxTransferFeeBps: null
  maxDirectControlShare: null
  maxRemovableLiquidityShare: null
sources:
  x: { enabled: false }
  telegramLive: { enabled: false }
  hostedLlm: { enabled: false }
  publicWeb: { candidate: tinyfish, enabled: false }
```

P00/P01 resolve the exact supported config schema. This is bootstrap config: P05 enables the selected free public-web adapter after proof; P06 enables hosted Gemini/high and selects hosted mode after its prerequisites pass. No credentials means explicit import mode, not an unavailable hidden dependency. Venue control allowlists, coverage predicates and freshness policies are shipped versioned manifests, not omitted user settings. Null risk fields prevent a contextual PASS; they do not prevent useful collection and explanation. A one-time explicit user profile selection then enables the intended paste-contract interaction.

## 16. Handoff prompt for the implementation task

Use [10-implementation-handoff.md](10-implementation-handoff.md) for the full ready-to-paste instruction. The compact version below has the same initial P00/P01 scope.

> Implement P00 and P01 from `plans/backend-v1/05-implementation-and-validation.md`. First read `agentic/architecture.md` and all canonical plan documents indexed by README, including 07/08/09. Follow the executing host's agent instructions; the author's AGENTS.md and Bridgecode materials are local-only and not part of this public repository. Verify current local state and version-sensitive details. Deliver the TypeScript CLI foundation, schemas, SQLite/artifacts, fixture-backed entry-checklist flow, explanation/offline replay groundwork and free-source feasibility. Phase 1 ultimately has two linked checklists: preserve a versioned checklistKind boundary now; P11 later implements manual management/position records. Target Solana/BSC/Base/Robinhood and explicit UNKNOWNs. Monetary API budget is zero. Gemini 3.5 Flash-Lite/high is preferred, but P01 uses fixtures/import; P06 awaits the user's model document and verified free setup. TinyFish Search/Fetch is the first web candidate; Parallel is an evidence-backed alternative. Do not add UI, signing/broadcast, posting, automatic discovery, portfolio construction, paper execution or paid dependencies. P03a/P03b/P11 belong to later Phase 1 packets; P12 remains future scope. Complete this packet's acceptance/tests and repository review, then stop. Return changed files, validation evidence, capability findings and missing access. Update architecture memory with implemented facts and proposals distinguished. Resolve feasibility conflicts with the smallest evidenced revision; finish unaffected work and return consequential scope changes to the planning task.

Later mini-plan prompts should name exactly one packet/subpacket, its prerequisites and any accepted revisions. They should reference canonical contracts instead of pasting divergent copies into every task. Model names do not alter required acceptance evidence.

## 17. Review and change discipline

Follow the root repository's bounded independent review cycle for implemented changes. Supply reviewers the packet's acceptance contract, final diff, relevant surrounding modules, test evidence and limitations. Review blockers against actual requirements; do not expand the packet into optional improvements.

When a later video changes a concept, update the source-to-rule mapping, feature/check version, tests and policy only where supported. Save before/after replay results. Never rewrite old snapshots to make a revised theory look as if it had always worked. Architecture decisions remain in this planning task; implementation evidence comes back from the implementation task.

## 18. P11 — complete Phase 1 manual thesis management

**Outcome:** a saved passing entry thesis and later manual evidence produce a separate management checklist and auditable proposal under [09](09-two-checklist-lifecycle.md). Include optional manual positions/sales and the journal. Prerequisites: P07 shared entry/evidence engine; P08–P10 are not prerequisites. Implement in four coherent subpackets:

| Subpacket | Owned work | Observable proof |
|---|---|---|
| P11a case and thesis | ResearchCase/ThesisEpisode schemas, snapshot kind, atomic saved-PASS activation, baseline lineage, explicit successor and late first inspection | Initial-only and tracked cases, multiple episodes/ambiguity, no baseline rewriting, no activation delayed by low cap/age |
| P11b management policy | C10 typed AST, stage profile/schema, MG-01–MG-15, separate thesis/proposal derivation, cost-aware exit estimate | All precedence branches including known invalidation with missing data, unknown settings, volume/social traction, no positive fallthrough |
| P11c manual position/journal | Entry/events/corrections, weighted-average cost, inventory, leg allocations, private journal and hypothetical distinction | Duplicate/partial sales, oversell refusal, fees/taxes, added buys/transfers, cost unknown, stale ledger revision, principal recovery and correction replay |
| P11d CLI/integration | Analyze dispatch, reassess, position commands, explain both checklists, management diff/replay, close case | Full manual early-to-traction-to-DCA and early-to-invalidation scenarios, no network during replay, no background monitoring or order methods |

**Owned boundaries:** existing application case/reassess services, domain schemas, pure policy/feature functions, storage migrations and reporting; no separate service. New check manifest is `thesis-management-v0`. Source adapters/evidence are reused, not duplicated. Store policy/profile/ledger hashes and baseline/current manifests in each management snapshot.

**Acceptance:** (1) new contract evaluates entry; (2) saved passing thesis activates management at any age/cap; (3) repeated manual contract input uses its tracked case; (4) known invalidation yields EXIT_REVIEW despite unrelated missing evidence; (5) DCA_OUT_PROPOSED requires configured unconsumed trigger plus validated thesis, qualified on-chain and external traction, valid quantity/cost/route inputs; (6) missing settings/evidence cannot produce a fabricated maintain/reduction quantity; (7) optional manual entries/sales change a new proposal without altering old snapshots; (8) source/policy/model and stage/position changes appear separately in diff; (9) no signing, scanner or continuous stop exists. Exercise both chain families and shared four-chain registry, without representing uncertified venue data as complete.

**Stop:** both Phase 1 checklist workflows are inspectable/replayable and manual position corrections are auditable. Exact live age/risk/realization parameters require explicit user configuration; fixtures may use clearly labeled profiles. Return coverage/unknown statistics and qualitative journal feedback for subsequent policy refinement. Do not auto-tune thresholds from a handful of winners.

## 19. Later scope and revision-specific regression

P12 paper simulator remains a separate proposal in 07. A future mini-plan must select supported historical execution models, latency, retention and acceptance before implementation. Phase 2 autonomous pair analysis and Phase 3 execution are not added by P11.

For P03a/P03b/P06/P08/P10 add the applicable [07 acceptance examples](07-round-two-lessons-and-contracts.md): cutoff-qualified pivots; gaps/ties/future-candle invariance; flow/volume/fees; bridge dedup; missing chain coverage; style separate from game and unchanged entry v0; model failure without silent substitution. P11 proves saved-thesis activation, stage boundaries, total management precedence, plan/readiness independence, ledger conservation/costs/idempotency and hypothetical/manual provenance. P12 additionally proves intrabar ambiguity/censoring and paper provenance before executable outcome claims.

