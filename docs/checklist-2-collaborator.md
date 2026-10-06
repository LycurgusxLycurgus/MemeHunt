# Checklist 2 collaborator handoff

Prepared 2026-10-05. Send this document together with the revised `CONTRIBUTING.md`. It is self-contained with respect to the original chats and private transcripts; referenced source and plans exist in the published repository unless explicitly marked local-only or proposed.

## Your assignment and starting revision

Develop and iterate **Phase 1 Checklist 2: reassess a saved entry thesis, detect validation/invalidation, and propose maintaining, reducing or exiting exposure**. The project owner is concurrently finishing and improving Checklist 1, including on-chain, attention and socials. You own management behavior and its regression evidence; the owner coordinates integration into shared files while their newer work is unpublished.

Repository: https://github.com/LycurgusxLycurgus/MemeHunt

Verified published `main` at handoff time: **27273cff16b334c6ba54187bd0170efad611f446**, `docs: record history cleanup limits`. Start your independent clone/topic branch there. The owner's `codex/entry-workflow-production` has the same HEAD plus substantial uncommitted source/tests. Cloning this commit will not give you that runtime work. These two documents may reach you before they are committed; retain the supplied copies and apply the new collaboration agreement rather than the older one in the checkout.

Checklist 2 already has an offline implementation. Extend it; do not restart Phase 1, rebuild Checklist 1, add a frontend, change database platforms, create an automated token scanner or implement trading. Phase 2 discovers new pairs; Phase 3 executes. A Phase 1 reassessment runs when the operator requests it. No background protection exists between requests.

## Product decisions already settled

The workflow is contract address plus chain, current evidence, deterministic checklist results, and a semideterministic verdict/explanation. Code owns numeric rules, thresholds, statuses and aggregation; independently qualified LLM interpretation can supply bounded semantic facts. The three evidence pillars are on-chain, attention and social. They are shared inputs to two different questions, not three separate trading engines.

Checklist 1 asks whether current evidence supports establishing an entry thesis for a configured size/horizon/risk profile. Checklist 2 asks whether that particular saved thesis still holds and whether a specified reduction or exit is supported now. A new generic entry PASS cannot replace management of the frozen thesis.

Confirmed decisions:

1. Saving a passing entry with a frozen thesis activates management immediately. Age and cap select rules; they never postpone known invalidation. An early token can invalidate below $100k. A mature first inspection has no fabricated earlier baseline.
2. Optional manual position and completed-sale records are in scope. Without a real record, any scenario is hypothetical; do not claim the operator's loss prevention, profit or recovered principal. Missing position does not by itself make the thesis unknowable.
3. Circulating-cap bands are MICRO `[0,100000)`, SMALL `[100000,1000000)`, ESTABLISHED `[1000000,10000000)`, LARGE `[10000000,infinity)`. Exact boundaries enter the higher band. They are configurable research bins, not validated profitability thresholds. Missing qualified cap stays UNKNOWN; no FDV substitution.
4. Token creation time differs from first trade, pool creation and first observation. Pool migration does not reset token age. No exact age thresholds were prescribed by the course notes. Explicit age profiles are required for dependent rules; do not invent a 24-hour course rule.
5. Free data first; API budgets, position size and holding horizon are configurable. Intended initial chains are Solana, BSC, Base and Robinhood, with honest partial support. Do not assume live coverage from a chain enum.
6. Exit proposals remain advisory. Invalidated thesis does not guarantee sellability. DCA-out means staged selling, never automatic buying or averaging down. A proposal is not a fill.

## Read these files before choosing the first patch

Read applicable `AGENTS.md` if supplied, then revised `CONTRIBUTING.md`, `agentic/architecture.md`, and `plans/backend-v1/09-two-checklist-lifecycle.md`. Read source before trusting historical memory or plan syntax. Plans `02-contracts-and-policy.md`, `03-feature-registry.md`, `05-implementation-and-validation.md` and `07-round-two-lessons-and-contracts.md` supply supporting contracts. Plan `10-implementation-handoff.md` describes an older foundation-build sequence; do not start from its P00/P01 instructions as though no backend exists.

Repository-local Bridgecode files and `agentic/analysis.md` are ignored and may not be in your clone. Their absence is not a dependency blocker. If they are provided and applicable, load required specialists: `best-agent.md` for consequential design, `writing.md` for substantial docs, and `monoprompting.md` for reusable instruction work; follow their review policy. No extra planning agents are requested. Keep an active local checklist and record verified management ownership/data flow in the durable architecture map when done. Do not copy the owner's private board or credentials.

| Published file/symbol | What exists and what you should preserve |
|---|---|
| `src/domain/contracts.ts` | TokenRef, FeatureResult, typed Predicate AST, Profile, Thesis/ExitLeg, management checks/results, PositionRecord/Event, ThesisEpisode and snapshots. Zod validation; string quantities and explicit units |
| `src/domain/catalog.ts::managementDefinitions` | Stable MG-01 through MG-15 metadata; separate from 33 entry definitions |
| `src/domain/policy.ts::evaluatePredicate` | Three-valued evaluation over qualified available features; all/any semantics and unit checks |
| `src/domain/policy.ts::resolveStage` | Cap bins and configured age bands; broader parameter-cell design is not fully implemented |
| `src/domain/policy.ts::evaluateManagement` | Existing state/proposal computation, safety/exit reuse and all 15 rows |
| `src/domain/ledger.ts::reduceLedger` | Bigint inventory, Decimal weighted-average cost, effective/recorded cutoffs, correction overlay, idempotency/oversell checks, attributed sales and unresolved reconciliation |
| `src/domain/ledger.ts::proposeLeg` | Ordered legs, original-quantity percentages, partial attributed fills, first uncompleted non-due leg stops selection |
| `src/app/service.ts::Service` | SQLite snapshots/cases/episodes/positions/events/journal, hashes/artifacts, `analyze`, `reassess`, `episodeAt`, `successor`, `replay`, position operations, `closeCase`, `backup` |
| `src/cli.ts` | Fixture/import entry and reassessment, inspection/replay/diff, thesis successor, position/journal/case commands |
| `tests/policy.test.ts`, `ledger.test.ts`, `service.test.ts`, `successor-cutoff.test.ts` | Existing regression patterns and chronology/ledger contracts; inspect actual assertions |
| `examples/entry.json`, `reassessment.json`, `fixtures.ts` | Offline examples; not certified live evidence |

The base signature is `evaluateManagement(episode, features, position, events, profile, cutoff, stageInputs?)`. `FeatureResult.value` is a string, boolean or null, with unit, quality, availability, applicability and evidence IDs. A KNOWN value still needs the correct semantic meaning and unit. For example, the newer local O28/A18 policy projections are boolean qualifications, not numeric volume or attention counts. Do not derive trends from those booleans or treat baseline context as a live measurement feed.

## What Checklist 1 has accomplished, and what you do not yet have

The owner working tree adds saved configuration/thesis templates, CLI live routing, 61-feature baseline derivation, qualified source/model boundaries, inspection reports and retained evidence receipts. It includes bounded Solana mint/control/holder acquisition and a canonical WSOL PumpSwap path with amount/cost/simulation evidence. This is venue-specific support, not certification of every pool/program/route. EVM readers and several chart/context feeds are still unavailable.

Attention work includes exact source grounding, independent qualification, comparison recovery and source completeness accounting. Recorded local acceptance includes a fresh case with five supported attention checks, one contradicted and no required attention unknowns; the whole entry was still rejected. That is bounded evidence for that case, not a strategy performance claim or universal coverage.

The latest supplied implementation turn concerns unfinished social completion. It identified attention consuming social capacity, invalid model-authored quotations, invented comparison-pair review IDs and account self-claims mistaken for corroboration. Local repairs introduce bounded social supplements, code-owned citation selectors/body ranges, closed review membership and stronger identity grounding. The last fresh run was still pending in that handoff: do not describe the social pillar or all Checklist 1 as finished. Desired account/history/engagement statistics cannot become compulsory invented zeros; collection/model failures remain UNKNOWN. A source-qualified independently reviewed negative public-verifiability finding may FAIL without proving fraud.

Local-only files include `src/app/config.ts`, `live.ts`, `report.ts`; `src/domain/baseline.ts`, `research.ts`, `attention.ts`, `social.ts`; and Solana/PumpSwap/TinyFish/attention/social provider modules and tests. `LiveBundle`, `AssessmentDetails`, live receipts, `analyzeLive` and `reassessLive` are absent at your starting SHA. Do not recreate guessed versions. The owner's newer `evaluateManagement` forwards qualification mode and social facts into safety evaluation, while Service uses frozen qualified policy features and management versions v0 through v4.

Current local stage inputs still supply null circulating cap and null token-creation time to live assessment. Implement/test stage semantics with truthful fixtures, but report live MG-05/source gaps until the owner provides qualified observations. The local starter profile's $25/6h and ALL_AGES settings are explicit uncalibrated starter configuration, not course facts or authorization to invent profit targets.

This handoff is based on source/history inspection and the supplied implementation record. Runtime tests and live providers were not rerun for this documentation task. Historical counts in architecture are recorded results of their own revisions, not certification of today's changing working tree.

## Management behavior to preserve and complete

The complete intended definition is plan 09. The following is the working map; rows retain independent references/reasons and do not aggregate as an entry verdict.

| Row | Meaning |
|---|---|
| MG-01 | Correct case/baseline/frozen-thesis linkage |
| MG-02 | Current integrity/security still acceptable |
| MG-03 | Current exit feasible for relevant quantity and configured tolerances |
| MG-04 | Required evidence available, timely, comparable and coherent |
| MG-05 | Cap/creation-age stage context resolved; missing stage does not gate independent safety |
| MG-06 | Frozen support predicates hold |
| MG-07 | Frozen invalidation predicates are clear; TRUE invalidation makes this FAIL |
| MG-08 | Required catalyst/representation condition still holds, or explicitly not applicable |
| MG-09 | Qualified on-chain traction under configured windows/integrity conditions |
| MG-10 | Qualified external traction under configured breadth/window conditions |
| MG-11 | No configured crowding/decay warning; warning alone is not automatic invalidation |
| MG-12 | Applicable unconsumed realization trigger due, respecting ordered plan semantics |
| MG-13 | Position/scenario, quantity and cost-plan prerequisites support quantification |
| MG-14 | Configured horizon valid, or explicitly not applicable |
| MG-15 | Exact proposed reduction feasible under current inventory/route/quote assumptions |

State precedence: known prohibited safety change, proven unacceptable exit restriction, TRUE invalidation or expiry => INVALIDATED; otherwise missing required thesis evidence => UNVERIFIABLE; otherwise failed support/catalyst => WEAKENING; otherwise VALIDATED. Keep source failure separate from proven dangerous restrictions.

Proposal precedence: INVALIDATED => EXIT_REVIEW; UNVERIFIABLE => REASSESS_REQUIRED; WEAKENING => REDUCE_REVIEW. DCA_OUT_PROPOSED requires validated thesis, both traction rows, due eligible leg and complete quantity/execution prerequisites. MAINTAIN_THESIS requires a supported thesis and known no-due-trigger decision, not unspecified or unknown plan data. Due triggers with unresolved feasibility remain REASSESS_REQUIRED. Warnings and execution limitations remain visible beside the result.

Use three-valued predicate logic. Required empty sets are invalid configuration, not vacuous success. Profile thresholds/windows must be explicit; missing ones stay UNKNOWN. Do not require unimplemented full bot/actor research detectors as hidden prerequisites for otherwise supported Phase 1 observations. Do not claim measured volume is universally organic.

Preserve weighted-average cost and append-only events. Reported partial sales consume only attributed amounts; unallocated sales reduce inventory but leave plan reconciliation unresolved. Later purchases do not enlarge original-q0 percentage legs. Case closure does not fabricate a sale. Successor plans must reconcile carried fills and inventory, especially when reusing leg IDs. Separate effective and recorded time so late reports/corrections cannot rewrite an older snapshot.

## First implementation packet: make management explanations traceable

Start here rather than attempting every gap in one PR:

1. Establish the published baseline with Node >=24, `npm ci`, `npm run typecheck`, `npm test` in your isolated checkout. Report actual results and failures.
2. Reproduce the existing empty management references in a focused test. `evaluateManagement` currently emits empty `featureRefs` and `evidenceRefs` for every row, including safety failures and frozen predicate violations.
3. Implement source-supported dependencies and specific reason codes for management rows. Copy actual qualifying safety/exit dependencies where reused; walk frozen predicates for predicate rows; distinguish missing evidence from known contradiction. Structural/context rows with no feature evidence should identify their actual episode/profile/position basis in an agreed shape rather than invent evidence IDs.
4. Keep statuses and numeric behavior unchanged in this first packet unless a separately reproduced blocker makes that impossible. Store any changed saved-result semantics under agreed version dispatch; traceability additions can change hashed output too.
5. Use a focused management module/test if necessary for safe independence. Its conceptual inputs are qualified features, frozen thesis/profile/cutoff, optional ledger, stage context and explicitly supplied safety/exit evaluations. This is a proposed seam, not an installed interface. Do not extract a generic framework or maintain two equivalent fresh management paths.
6. Supply the small integration patch for shared policy/contracts/Service. On the older base, prove the new behavior through production domain functions and tests. It is an offline domain milestone until connected to the owner's newer live/replay path and validated on the combined tree.

Definition of done for this first packet: reproducible row-level provenance/reasons, focused positive/negative/missing tests, preserved old result replay, no changes to entry semantics/providers, and an explicit integration packet. If preserving hashed legacy results requires shared dispatcher changes, agree them before implementation; do not silently reinterpret old snapshots. Do not call the entire Checklist 2 complete at this milestone.

## Next prioritized packets, after first review

**Ordered unconsumed trigger consistency.** Current MG-12 evaluates every leg, including consumed legs, while `proposeLeg` skips consumed legs. Any unknown leg can make MG-12 UNKNOWN despite an earlier eligible candidate. Reproduce consumed-first, partial-fill, later-unknown and all-consumed cases; specify ordered semantics and align management row/candidate selection. Do not use a broad rewrite as a substitute for this precise correction. Version changed results and preserve old ledger/replay behavior.

**Quantity-bound feasibility.** Current MG-15 checks a candidate plus generic exit PASS; it does not establish a fresh route/quote for that exact candidate and ledger revision. Define the minimum management-side proof shape with the owner: token/chain, quantity and units, position/ledger revision, as-of/expiry, route/source binding, costs/tolerances and evidence references. Candidate quantity exceeding inventory is an error/conflict, never silently clipped. Missing/stale/mismatched proof stays UNKNOWN; proven blocked execution is distinct. You implement validation/consumption and deterministic fixtures; Checklist 1 supplies real provider proof. Keep original-position safety and candidate-reduction proof appropriately distinguished.

**Inspectability and stage context.** Expose only evidenced manual/hypothetical mode, remaining inventory, quantity/cost basis, stage, prior comparable snapshot, quote expiry and execution limitations. The base result lacks many of these fields. Full cap x age x attention-style parameter cells, episode policy/profile IDs and successor-plan reconciliation remain broader follow-ons. Add fields incrementally with versioned defaults and tests. Missing live source feeds are a capability limitation, not permission to use FDV/pool age or made-up attention/volume.

Exact age bands, traction windows, risk tolerances and realization targets beyond existing explicit config remain operator decisions. Make them configurable/unknown and ask only when a specific live profile needs those choices. They do not block deterministic implementation against supplied test profiles. Database/platform, paid provider and strategy changes require separate scope.

## Compatibility, branching and validation

Use the commands and ownership map in `CONTRIBUTING.md`. A suggested branch is `codex/checklist-2`, starting at the pinned commit. Keep your own clone, node_modules and database/artifact directories. Do not use the owner's databases or copy their uncommitted files. Coordinate edits to contracts, shared predicate helpers, policy, catalog, Service, CLI, manifests and mixed tests. Ledger and focused new management files are your main independent lane, with signature/replay changes communicated.

Agree policy IDs before emitting new snapshots; v1-v4 are already used in the owner's unpublished work. Changing only the recorded policy name while old replay calls the changed function is insufficient. Test frozen prior results/hashes, and preserve the old evaluator dependency behavior as needed. Do not backfill old results, rewrite evidence, or make historical episode resolution choose the latest head. The base successor-cutoff suite is especially important.

After build, useful focused commands at the starting commit are:

```powershell
node --test dist/tests/ledger.test.js dist/tests/policy.test.js dist/tests/service.test.js dist/tests/successor-cutoff.test.js
```

Add your new compiled management test file to the focused command. `npm test` discovers `dist/tests/*.test.js` and builds first. Use a fresh isolated directory and substitute its DB path in these offline CLI examples:

```text
node dist/src/cli.js analyze FIXTURE_TOKEN --chain solana --bundle examples/entry.json --db <isolated-directory>/smoke.sqlite
node dist/src/cli.js reassess <case-id> --bundle examples/reassessment.json --db <isolated-directory>/smoke.sqlite
node dist/src/cli.js show <snapshot-id> --db <isolated-directory>/smoke.sqlite
node dist/src/cli.js replay <snapshot-id> --db <isolated-directory>/smoke.sqlite
node dist/src/cli.js diff <snapshot-a> <snapshot-b> --db <isolated-directory>/smoke.sqlite
```

Replace placeholders with returned IDs/paths. The published CLI also has `thesis successor`, `position record --file`, `position event`, `case show/close`, `journal` and `backup`. Read parser/help for their full arguments. Plan syntax such as `thesis accept` and `--checklist entry` is proposed, not installed; the current entry override is `--entry`.

For the completed management workflow, cover early invalidation despite missing cap/age or unrelated social data; mature first inspection; exact cap edges and migration age; no auto-refresh; support failure versus invalidation; unknown volume/attention; unknown/hypothetical cost; ordered and consumed legs; partial/unattributed sale; stale quote/revised ledger; late-recorded buy/event/correction; successor cutoff and carried fills; immutable baseline and old policy replay. Add meaningful cases for the current packet, not a large unrelated suite up front. Use synthetic/redacted evidence with truthful provenance; imported bundles cannot claim LIVE.

When Checklist 1 becomes available, exchange exact published SHAs, merge its checkpoint into your branch, resolve shared seams jointly and run combined typecheck/tests. The owner can merge your reviewed checkpoint back or integrate through `main`. Normal merges preserve ancestry; no blind old-file replacement, reset of someone else's work or unagreed history rewriting. Unavailable provider prerequisites remain explicit and listed.

## Required delivery back to the owner

Provide: base and result commit/branch (or clearly labeled uncommitted patch); changed symbols/contracts/version IDs; behavior implemented and unsupported cases; a redacted example management result; exact tests/results; historical replay and migration evidence where applicable; the shared integration patch; and the next bounded packet. Do not claim live acceptance from mocks or test counts from another revision.

Update the management portion of `agentic/architecture.md` after verifying code. Keep your active checklist recoverable locally. Preserve existing public exclusions and keep credentials, private endpoints, transcripts, positions/journal and raw model material out of commits. No publication or trade execution is implied by this document; follow explicit authorization in your own work session.

The first next action is to inspect the pinned base and run its isolated baseline checks, then implement the traceable management-row packet with preserved historical behavior. You can make useful progress before the owner publishes Checklist 1; final live integration waits for that checkpoint.
