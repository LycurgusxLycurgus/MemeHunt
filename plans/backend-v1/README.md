# Memecoin due diligence backend: architecture and delivery plan

Version: 0.2 — 2026-09-24. Status: proposed architecture, revised against all eight supplied transcripts and the user's notes. Nothing in this directory is an implemented backend or evidence of a profitable strategy.

The raw third-party transcripts, user annotations, and historical pre-plan used during planning are intentionally excluded from this public repository. Some transcript line references below point to that local-only source material; the original audiovisual recordings were not independently verified.

For this revision, start with [the two-checklist lifecycle](09-two-checklist-lifecycle.md), then [round-two lessons and contracts](07-round-two-lessons-and-contracts.md) and [technology decisions](08-technology-decisions.md). Phase 1 now includes entry/thesis assessment AND manual thesis validation/invalidation with exit/DCA-out proposals, plus optional actual entry/sale records. Saving a passing thesis activates reassessment; age and market cap select its rules without delaying early invalidation. SQLite remains recommended; TinyFish Search/Fetch is the first free web candidate, Parallel an alternative; Gemini 3.5 Flash-Lite/high is the preferred primary semantic model. Existing v0 entry-verdict semantics are preserved; management has its own 15 checks and deterministic result.

## The decision

Build a local, CLI-first due diligence engine. Give it a chain-qualified token address, an intended analysis size and horizon, and a named policy. It collects evidence, extracts observations, calculates features, and saves an immutable result from the relevant checklist: entry research for a new case, management for a tracked thesis. Both results can be explained or replayed later.

Organize the analysis into three user-facing pillars:

1. **On-chain & market structure:** token controls, venue mechanics, executable liquidity, ownership, inventory, and trading integrity.
2. **Attention & narrative:** what attracts interest, where it originates, how it spreads, which token captures it, and whether observed attention converts into participation.
3. **Social & actor intelligence:** who is participating or promoting, how independently, with what observable history and incentives.

Keep evidence quality and the verdict policy as shared infrastructure. Market regime and lifecycle provide context across the pillars. A social post can supply both attention and actor features, but it is ingested once and should not earn duplicated influence in scoring.

The key product contract is:

```text
Paste contract
  -> resolve chain and token identity
  -> collect bounded, timestamped evidence
  -> evaluate all three pillars
  -> new case: entry checklist -> PASS/FAIL + saved thesis
  -> tracked thesis: management checklist -> validation/invalidation + proposal
  -> retrieve either saved checklist only when wanted
```

PASS means **this snapshot satisfies this due diligence policy for the stated context**. It does not mean buy, predict a return, or authorize an order. FAIL distinguishes a detected problem, insufficient evidence, inadequate opportunity support, and unsupported analysis. That distinction is essential to debugging the checklist rather than merely changing its verdicts.

## Read this package in order

| Document | Purpose |
|---|---|
| [01-architecture.md](01-architecture.md) | System boundaries, flow, stack, chain/venue separation, storage, and operating behavior |
| [02-contracts-and-policy.md](02-contracts-and-policy.md) | Domain contracts, exact checklist semantics, initial policy, JSON/CLI behavior, replay, and LLM constraints |
| [03-feature-registry.md](03-feature-registry.md) | 96 candidate features, formulas/rubrics, input needs, missing-data rules, scope, and validation targets |
| [04-chains-and-sources.md](04-chains-and-sources.md) | Multichain support model, provider feasibility, evidence limitations, cost controls, and primary sources |
| [05-implementation-and-validation.md](05-implementation-and-validation.md) | Small implementation packets, acceptance tests, evaluation design, and a self-contained implementation-task handoff |
| [06-preplan-traceability.md](06-preplan-traceability.md) | Disposition of all 62 numbered pre-plan sections and a method for incorporating later video material |
| [07-round-two-lessons-and-contracts.md](07-round-two-lessons-and-contracts.md) | Complete-course/notes mapping, causal chart/rotation contracts and plan/journal arithmetic |
| [08-technology-decisions.md](08-technology-decisions.md) | SQLite/Convex, TinyFish/Parallel, Gemini/high, dated source evidence and activation gates |
| [09-two-checklist-lifecycle.md](09-two-checklist-lifecycle.md) | Phase 1 case lifecycle, 15 management checks, cap/age selection, optional position ledger and manual exit proposals |
| [10-implementation-handoff.md](10-implementation-handoff.md) | Ready-to-paste instruction for the separate implementation task, initial scope and continuation order |

The documents deliberately separate decisions from implementation detail. Read this index to understand the system; use the contracts and delivery packets to build it. A developer should not need the originating conversation to reconstruct the requirements.

## What changes from the pre-plan

The attention/inventory hypothesis remains the organizing theory. Its conceptual products, such as attention × canonicality × conversion × information edge, do not become mathematical forecasts. Their inputs have different units and uncertain coverage; multiplying them would manufacture precision.

The first release should demonstrate two chain families. The recommended launch target is Solana, BSC, Base, and Robinhood with explicitly named supported venues. Arc enters the extension registry; every chain receives full due diligence only for capabilities whose token state, execution paths, and history can actually be checked. EVM compatibility reduces adapter work; it does not establish market-data or sellability coverage.

The proposal of event sourcing becomes a simpler **append-only evidence and snapshot store**. There is no reason yet to introduce an event bus, multiple services, or a graph database. Relationships fit in relational tables; collection happens in one process. Replays operate on saved artifacts without contacting the network.

The initial product uses gates and explicit supporting checks before introducing aggregate scores. It can report many numerical features on day one. It should not claim that an invented “Edge 84” measures investment edge, or that “Confidence 88” is an 88% chance of success. Later score versions require a defined training/calibration population and an evaluation report.

LLMs output cited semantic observations and constrained classifications. Code controls token identity, quantities, feature arithmetic, rule outcomes, and the final verdict. A frozen LLM output is reproducible input to the deterministic pipeline; a fresh LLM call is a new analysis revision.

## Proposed delivery boundary

**Foundation milestone:** offline fixtures pass through the complete input-to-verdict flow; evidence, policy, checklist, snapshot, and replay contracts work. This is not a live-data product.

**Entry-engine milestone (P07):** selected Solana, BSC, Base, and Robinhood venues; free RPC/indexed data where available; size-sensitive estimates/simulations; configurable social corpus; semantic extraction; saved entry verdicts and refresh/diff. Partial or unavailable evidence is visible. There is no silent promise of every token or venue on those chains.

**Complete Phase 1 (P07 + P11):** manual contract input supports both entry and management checklists, saved thesis lineage, cap/creation-age rule selection, optional position/sale records, loss-prevention/exit and staged-reduction proposals, and inspectable historical changes. Reassessment is manually triggered; no continuous stop is promised. Phase 2 adds automatic new-pair discovery. Phase 3 adds automated trading behind its own risk/execution controls and paper validation.

**Research-depth milestone:** longitudinal attention, control graphs, actor dossiers, fitted regime rules and outcome evaluation. Baseline descriptive chart/macro context belongs in P03a/P03b; deterministic manual management/journal belongs in P11 within Phase 1. P08–P10 add deeper measurement/calibration as cases accumulate. P12 paper simulation remains a later separately scoped proposal.

**Explicit exclusions:** autonomous token hunting, posting/promoting tokens, portfolio construction, order execution, signing keys, private-message harvesting and a UI. All eight supplied chapters are now mapped; their lessons do not automatically authorize a trader or turn examples into validated thresholds. Candidate-scoped competitor lookup is allowed because it is necessary to evaluate the pasted contract; an ecosystem-wide discovery agent is separate work.

## Confirmed preferences and remaining operating defaults

The user selected Solana, BSC, Base, and Robinhood for the first release, configurable position size/horizon, and free data/API services for the first iteration. Paid sources are disabled by default with a zero monetary API budget. The plan assumes one researcher running locally. Gemini 3.5 Flash-Lite/high is the preferred primary model; verified free access enables it, while import remains the explicit bootstrap/offline alternative. Optional local inference requires its own quality check. A free-data run must not pretend it completes unavailable social or execution analysis.

Size and horizon are explicit inputs or saved user defaults. A bare contract can still produce an informative report, but absent context is shown and prevents a size/horizon-specific PASS. The examples use hypothetical sizes only to illustrate behavior.

The first iteration is useful even when some analyses return INSUFFICIENT_DATA: it identifies precisely which evidence is missing and lets the user improve the checklist. Later paid-provider decisions should be driven by measured missing-check frequency and value, while preserving the meaning of PASS. Robinhood is a first-release priority, not an optional someday adapter.

## How we keep working here

This task owns architecture revisions and later mini-plans. Implementation happens in a separate task and returns evidence: changed files, checks run, live capability results, and unresolved limitations. Update this package only when a requirement or observed implementation result changes the plan. The historical `pre-plan.txt` is not present in this checkout or the public repository; if it is supplied again, retain it unchanged outside the published tree.

The first useful implementation instruction is **packet P00 plus P01**, not “build the entire plan.” Each subsequent packet should begin from a passing, inspectable contract. Sol/Luna can implement those packets without being asked to rediscover the entire architecture.

