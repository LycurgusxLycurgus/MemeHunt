# Checklist 2 collaborator handoff — round 2 review and next implementation

Updated 2026-10-08. This is the canonical owner-to-collaborator handoff. It replaces this file's initial instructions to start packet 1. Read it with the revised `CONTRIBUTING.md`; no separate chat snippet is needed. Keep future round-two decisions/results here rather than creating another competing handoff.

## Current owner Checklist 1 checkpoint (2026-10-08)

The owner has completed accepted Checklist 1 work through Shared evidence qualification on `codex/entry-workflow-production`. The latest independent implementation review returned PASS; typecheck/build and the full suite passed, with 701/701 tests. The accepted implementation remains bounded by the provider, evidence and calibration limits recorded in `agentic/architecture.md`. The owner topic branch is being published separately; it is not merged into `main` or `codex/checklist-2`. Use the exact published topic-branch SHA for any later integration. This does not satisfy Checklist 2's separate real-CA zero-UNKNOWN acceptance gate or declare Checklist 2 complete.

## Verdict and exact reviewed state

**Packets 1 and 2 are useful, implemented and verified on the collaborator branch. The complete Phase 1 Checklist 2 is not finished, and the branch is not yet integrated with the owner's newer Checklist 1.** Continue from your work; do not rebuild those packets or restart from the old main commit.

- Repository: https://github.com/LycurgusxLycurgus/MemeHunt
- Reviewed branch: `codex/checklist-2`.
- Reviewed HEAD: **9d8c218781c3dfd3b781805772179ccc79d6afd9**.
- Common published starting base: `27273cff16b334c6ba54187bd0170efad611f446`.
- Packet 1: `c314cd2` predicate explanations, `e6b45f4` management traceability/v5.
- Packet 2: `b784f9c` ordered ledger selection, `f90601a` management v6.
- The collaborator's `handoffs/checklist-2-handoff.md` and packet notes were inspected. Their packet 3 is explicitly a proposal with no implementation. Their delivered documentation is historical context; this file supplies the next instructions and resolves/corrects their integration recommendations.

At the time of this 2026-10-06 review, the owner reviewed a separate clone. Nothing was merged into the dirty owner checkout, and no production code was repaired in this review. The owner branch then contained unpublished Checklist 1 source, qualified live policy/Service changes and an unfinished social task. That dated state is superseded by the current owner checkpoint above; the Checklist 2 implementation and review findings below remain specific to the reviewed `9d8c218` branch.

## Independently observed validation

On Node **24.15.0**, in an isolated clone at the reviewed SHA:

- `npm ci --ignore-scripts --no-audit --no-fund`: completed; five locked dependencies installed.
- `npm run typecheck`: passed.
- `npm test`: **55 passed, zero failed/skipped**; includes build, management, ledger, Service and successor-cutoff tests.
- Built the original base separately and verified **all 18 v0 golden scenario results** against its actual evaluator. This supports the legitimacy of the preserved baseline rather than merely trusting checked-in expectations.
- Actual CLI `analyze -> reassess -> replay`, using synthetic examples and a dedicated database: RESEARCH_ELIGIBLE entry, EXIT_REVIEW management, byte-identical replay.
- Targeted production-function/Service probes reproduced the gaps below. These were additional probes, not part of the branch's 55 tests.

No live provider calls, real trades, owner-database inspection or combined-owner-tree tests were performed. Earlier collaborator test/review claims are corroborated only to the extent stated above. One trailing whitespace occurrence in their old copied document is cosmetic and is not a blocker or a percentage deduction.

## Progress estimate: about 55% of the full Phase 1 management scope

This is a transparent **requirements-maturity estimate**, not time spent, lines written, calibrated financial reliability or permission to release. Eleven scope areas receive 0 = absent/unverified, 1 = partial, 2 = implemented with relevant inspected/offline evidence. Equal weighting is a rough communication aid; blockers remain blockers regardless of the score. It includes foundation work inherited from the base, not only the collaborator's contribution.

| Scope area | Score | Evidence and remaining boundary |
|---|---:|---|
| Case, baseline and thesis lifecycle | 2/2 | Saved PASS activation, frozen baseline, historical episode selection, close/replay foundation tested; quantity-plan reconciliation is scored separately |
| Thesis states and proposal precedence | 2/2 | Separate management manifest, invalidation/unknown/weakening/validation paths and manual proposals |
| Row explanations and references | 2/2 | Packet 1 adds decisive predicate refs, usable evidence and structural basis; stage observation provenance awaits the stage contract |
| Ordered unconsumed sell steps | 2/2 | Packet 2 covers consumed, partial, later-unknown, unattributed and exhausted cases within a plan |
| Position and successor-plan reconciliation | 1/2 | Ledger/cutoffs exist; successors still accept ambiguous reused IDs, and execution revision is incomplete |
| Historical policy preservation across both workstreams | 1/2 | v0/v5/v6 goldens/replay pass; owner v1-v4/qualified-input integration remains unverified |
| Exact-quantity exit/proposal proof | 0/2 | MG-15 still passes on generic entry-sized exit rows; packet 3 is only a proposal |
| Cap/age-dependent management parameters | 1/2 | Cap/age resolver exists; full parameter selection, source binding and live inputs are incomplete |
| Operator context and interpretation | 1/2 | Row inspection and EXIT_REVIEW inventory/mode exist; DCA mode, quote/cost context and meaningful longitudinal comparisons remain incomplete |
| Combined live Checklist 1 -> Checklist 2 acceptance | 0/2 | Not integrated or exercised against the owner live path |
| Time-bounded HOLD/DCA-out management plan | 0/2 | Explicit holding duration, dated/conditional sell schedule, reassessment cadence and invalidation override are not implemented as a complete plan |
| **Total** | **12/22 = about 55%** | **Incomplete; quantified DCA is not yet release-ready** |

The initial review estimated 60% across ten areas. The user then explicitly required the HOLD/EXIT_NOW decision plus a timed DCA-out plan; its missing implementation is now a separate 0/2 area, producing about55%. This is an expanded acceptance denominator, not lost work.

Packets 1 and 2 can reasonably be called complete **within their stated offline scope**. They do not make all Checklist 2 complete. Live source dependencies belong jointly to integration/Checklist 1; do not describe their absence as poor implementation of those two packets.

## Required pillar map and STRICT real-CA completion gate

**Production-quality acceptance requirement, explicitly reiterated by the user on 2026-10-06: the next delivery must report the Checklist 2 pillars, what is known/unknown in each, and actual fresh tests with real contract addresses. Production-ready completion requires ZERO UNKNOWN rows, not merely zero unexplained unknowns. A code-complete or offline-tested packet with unknown real-CA results is unfinished against this requirement. An explained unknown still fails the completion gate.**

Use these five reporting groups. The first three preserve the project's on-chain, attention and social evidence pillars; the last two expose the management context and position/exit responsibilities that those inputs alone cannot settle. These are reporting/ownership groups over the existing 15-row manifest, not five replacement checklists or new duplicated checks. Predicates may depend on several evidence pillars; list their real dependencies instead of forcing exclusive source ownership.

| Reporting pillar/group | MG rows (each row counted once) | What must become known | State at this reviewed branch |
|---|---|---|---|
| On-chain integrity, sellability and traction | MG-02, MG-03, MG-09 | Current controls/liquidity, relevant-quantity exit evidence, configured qualified on-chain traction and comparable windows where required | Logic/fixtures present; relevant-quantity proof incomplete; live integration NOT_RUN |
| Attention, narrative and thesis durability | MG-06, MG-08, MG-11 | Saved support, required catalyst/representation conditions, and configured crowding/decay warnings against current qualified evidence | Predicate evaluation/traceability tested offline; real current evidence with owner pipeline NOT_RUN |
| Social and external confirmation | MG-10 | Configured qualified external traction, with actual social/attention source breadth, timeliness, binding and integrity prerequisites | Predicate consumer exists; owner source-qualified social/attention integration NOT_RUN; a count of mentions alone is insufficient |
| Baseline, evidence coherence, stage and invalidation | MG-01, MG-04, MG-05, MG-07, MG-14 | Correct saved thesis, coherent inputs, evidenced cap/creation-age/profile context, invalidation predicates and applicable horizon | Lifecycle and invalidation tested offline; stage sources/parameter coverage incomplete; live NOT_RUN |
| Position, ordered realization and proposal feasibility | MG-12, MG-13, MG-15 | Next unconsumed trigger, explicit position/scenario and reconciled quantities/cost, exact candidate proof | Ordered selection tested; reconciliation/fingerprint/output gaps and exact-proof implementation remain; live NOT_RUN |

The manifest union is exactly MG-01 through MG-15, with no omissions or duplicates. A resolved management row can depend on several source pillars; its report must identify which qualified on-chain, attention and social facts supported the determination. Do not invent additional numeric MG rows merely to fit these headings. If the present frozen predicates do not substantively use an intended source pillar, declare that coverage gap; do not claim the pillar is complete from a vacuous predicate.

Distinguish three independent axes in every report:

1. **Implementation:** NOT_IMPLEMENTED / PARTIAL / IMPLEMENTED / INTEGRATED.
2. **Validation:** NOT_RUN / OFFLINE_TESTED / REAL_CA_TESTED, with actual evidence and run identity.
3. **Observed result:** PASS / FAIL / UNKNOWN / genuine NOT_APPLICABLE, only after the check actually ran. Never label an untested row PASS or invent fifteen observed UNKNOWNs for a run that never happened.

At review time there are **no fresh real-CA Checklist 2 runs for the combined branch to credit**. Live acceptance is NOT_RUN and the zero-UNKNOWN gate is NOT ACHIEVED. The approximately55% implementation-maturity estimate above must always be presented separately from this gate. Passing 55 offline tests does not raise real-CA coverage.

### What zero UNKNOWN means

For each agreed real-CA acceptance case, persist and report **all 15 management rows** from one coherent fresh reassessment. Every row must be PASS or FAIL, except a documented NOT_APPLICABLE allowed by the actual policy and frozen thesis. UNKNOWN count must equal **0**, including contextual rows; "the unknown is explained" is not completion. Each pillar/group must also have zero UNKNOWNs. A token may legitimately fail checks or invalidate its thesis: known does not mean positive, safe or profitable.

Use NOT_APPLICABLE only where the check's contract permits it and the frozen thesis genuinely has no dependency, such as an absent optional catalyst, warning or expiry. A missing collector, quote, position basis, stage input, desired measurement needed by an active predicate, unresolved proof or exhausted plan is not automatically N/A. Preserve the intended user's thesis/risk settings. Do not remove checks, weaken predicates, set trivial thresholds, relabel missing features, change source completeness claims or alter the thesis after seeing results merely to reach zero.

For a fully quantified acceptance case, supply a valid explicit plan and position basis. The user has allowed HYPOTHETICAL positions: an honestly labeled scenario is acceptable for exercising quantity rules with actual real-market evidence and a quantity-bound quote. Do not claim an actual buy/sale or principal recovery without manual records. A synthetic position input does not turn a fabricated market quote into real-CA evidence.

This strict success target does not authorize manufacturing facts. If any row stays UNKNOWN, the next report must say **INCOMPLETE — ZERO-UNKNOWN GATE NOT MET**, include that row and cause, and identify the next corrective action and owner. Continue authorized collector/qualification/integration work where feasible. A persistent external outage/access limit can be a real blocker, but cannot be presented as a finished delivery or silently removed from the report. No infinite retry loop, paid escalation or unauthorized provider substitution is required to pretend the gate passed.

### Mandatory real-CA validation procedure

1. **Freeze the acceptance cases and profile before judging outcomes.** Start with the real CA(s) already being used in the owner's Checklist 1 acceptance workflow, once their nonsecret identifiers and supported-chain context are available. Record chain+CA explicitly. If that case list is unavailable in your clone, obtain it from the owner rather than guessing the intended tokens. A documented additional manually selected case may exercise another lifecycle path; do not create Phase 2 automatic discovery or quietly replace a failing case with an easier one.
2. **Use the actual supported pipeline.** Integrate the owner's published Checklist 1 checkpoint, or an explicitly agreed qualified live-evidence interface, before claiming a live end-to-end result. If neither exists yet, deterministic packets may be delivered as partial progress, but real-CA acceptance remains NOT_RUN/INCOMPLETE. Copying a real address into a fixture is not a real-CA test.
3. **Use a legitimate frozen baseline.** Reassess an existing saved eligible thesis or save a genuinely passing current entry and freeze its thesis/profile. Do not fabricate an earlier PASS, backdate observations or force a rejected token into tracking to demonstrate management. If the selected CA cannot legitimately establish a baseline, report that dependency and obtain an agreed additional case without hiding the original result.
4. **Collect a fresh coherent reassessment.** Use current supported chain/venue, attention and social evidence, qualified stage observations, current relevant quantities and real source-bound quotes where required. Retain cutoff, profile/plan versions, policy versions, source receipts and quote expiry. All rows must belong to the same persisted management snapshot; do not combine the best known rows from different runs.
5. **Exercise management over time.** Keep at least the baseline plus a later real reassessment. Show changed evidence and thesis/position/proposal consequences. Test the supported DCA path with a valid hypothetical/manual position and actual quantity-specific proof when the frozen trigger is genuinely due. Test invalidation/exit review on a real case when its evidence genuinely triggers it. If a desired branch is not naturally observed, retain its deterministic regression evidence and mark that live path NOT_EXERCISED; do not manufacture its outcome or call all live paths proven.
6. **Inspect and replay.** Reopen the database, show the saved rows/evidence, and replay offline with the identical saved result/hash. Replay proves reproducibility of that snapshot, not that an expired quote remains current. Run another fresh reassessment when current validity is required.
7. **Publish the coverage result in the next response.** Include the report below whether all cases pass the completion gate or not. A partial response must say what is implemented, what was actually exercised on real CAs, and exactly why the strict gate remains unmet.

### Required results in your NEXT delivery response

Put the same sanitized result summary in this handoff when updating it. Do not end the next turn with only a test count or "packet finished."

- Reviewed/result commit SHA and branch; integrated Checklist 1 checkpoint SHA or explicit NOT_INTEGRATED.
- For each case: chain, **actual CA**, baseline/episode ID and time, current snapshot/cutoff/hash, policy/profile versions, manual/hypothetical/absent position mode, quote/proof identity and expiry when relevant. Keep private position details and credentials out of public documentation; retain full local proof securely.
- One pillar summary table with implementation state, validation state, PASS/FAIL/UNKNOWN/N/A counts and unresolved work/owner. Counts must reconcile to the exact 15 rows below.
- One full table per case: `MG ID | pillar/group | status | measured fact/predicate and configured threshold | evidence/basis references | unknown cause and next action if any`. Missing source data remains UNKNOWN, never zero by default.
- Source-level on-chain, attention and social coverage and rejected/unavailable evidence. A known aggregate row cannot justify claiming unavailable underlying indicators were measured. Report incomplete source scopes and whether they are actually required by the frozen rule.
- Verdict/proposal with its reasons, HOLD/reduction/EXIT_NOW urgency, relevant amount/units/mode, execution limitations and changed checks compared with a genuinely comparable prior snapshot. For HOLD/reduction include the frozen DCA-out legs, chosen duration/start/end, next reassessment and invalidation/deadline overrides. Include the original-plan traceability table required below.
- Exact offline validation commands/results, fresh real-run evidence, reopen/replay outcome and any live paths NOT_EXERCISED.
- A final explicit gate line for each case: `UNKNOWN = 0; ZERO-UNKNOWN GATE MET` or `UNKNOWN = N; INCOMPLETE — ZERO-UNKNOWN GATE NOT MET`. If no real run was possible, report `REAL_CA = NOT_RUN; INCOMPLETE` rather than a fabricated count. Overall completion cannot be claimed while any agreed acceptance case fails the gate or a mandatory acceptance path remains untested.

Scope completion and case validity are separate: zero UNKNOWN on one snapshot does not establish future availability, every chain, every venue or profitability. Name the supported scope and retain all agreed-case failures. The user requires a real, observable zero-UNKNOWN delivery on that scope, not a promise that future external data can never fail.

## Core decision contract: validate the entry thesis, HOLD or EXIT_NOW, and plan the exit over time

The user explicitly reaffirmed that Checklist 2 is the management half of the original strategy: **take the saved Checklist 1 thesis, determine whether current evidence validates or invalidates it, decide whether to keep holding or recommend exiting immediately, and, if holding, determine how DCA-out should proceed and over what duration.** A diagnostic row list without that decision and plan is incomplete.

Separate these concepts in the saved result:

- **Thesis assessment:** the actual frozen support/invalidation/catalyst and horizon predicates, baseline/current evidence, and what changed. A new generic entry PASS is not validation of an old thesis.
- **Management decision:** HOLD, a specified partial reduction while holding the remainder, or EXIT_NOW_RECOMMENDED, with a deterministic reason chain. Preserve the existing proposal enums for historical snapshots; a versioned additional action/urgency field may express the operator-facing meaning. REASSESS_REQUIRED is truthful when prerequisites are missing, but does not meet the zero-UNKNOWN production acceptance target.
- **Execution feasibility:** fillable, proven blocked, or unavailable proof for the relevant amount. Urgent exit recommendation is not a promise of a fill. A known blocked route can be a known negative result; unavailable evidence remains UNKNOWN and prevents completion.
- **Time-bounded realization plan:** the holding/reduction horizon, sell legs, deadlines and reassessment schedule, rather than only a quantity percentage or a generic `expiryAt`.

If the thesis is invalidated, recommend EXIT_NOW with urgency NOW and the specific triggering evidence; it overrides waiting for future profit targets or DCA dates. If sellability is blocked, state that beside the urgent recommendation without inventing a route or transaction. A supported weakening/reduction rule can recommend a partial exit without falsely declaring complete invalidation. If the thesis remains validated, HOLD must include the current DCA-out plan, including when no leg is due yet; when a leg is due, state that reduction and the plan for the remaining inventory.

### Required duration and schedule contract

The user's examples — 3 hours, 3 days, 3 weeks, 3 months — express the required range of horizons, not an instruction to hardcode those four outcomes or infer a fixed age-to-duration relationship. An expiry timestamp alone is not a DCA schedule.

For each supported HOLD/reduction decision, freeze and expose:

| Plan element | Required information |
|---|---|
| Identity/basis | Plan version, baseline thesis episode, current assessment/cutoff, manual/hypothetical position, reconciled original/remaining quantity basis |
| Chosen horizon | Duration with explicit units, start/anchor and end time (or documented calendar arithmetic/timezone), rationale and supporting stage/attention/social/on-chain inputs |
| Sell legs | Ordered amounts/percentages and their basis, unfilled remainder, price/market-cap/traction/time predicates actually used, and any time window/deadline; never assume mcap substitutes for executable price |
| Timing | Earliest action and latest deadline where configured, next reassessment time/cadence and reasons. The time horizon is separate from quote expiry and source freshness |
| Conditional behavior | Trigger-based, time-based, or an explicit combination; what happens when a target is never reached, a deadline expires, traction decays, or evidence invalidates the thesis |
| Partial execution | How reported partial/unattributed fills change future legs; no leg is consumed merely because its time arrived or a proposal was emitted |
| Override/cancellation | Immediate invalidation overrides the optimistic schedule. Changed thesis/basis requires an explicit successor/reconciled plan, not silently extending a deadline to avoid admitting failure |
| Availability | Missing required selection input/settings, stale quote or unobserved elapsed-time event stays explicit; never invent a known future market outcome |

Code owns deterministic policy selection, arithmetic, precedence, clocks and due-leg computation. LLMs may classify source-grounded narrative longevity/attention style and explain or propose within a versioned policy, with the existing independent qualification rules. They cannot invent numeric targets, fabricate volume/duration measurements, override risk limits, or return an unconstrained prose-only holding period. Strategy settings must be explicit and frozen; engineering heuristics are labeled as such, never represented as calibrated profitability or transcript-prescribed thresholds.

Respect the Checklist 1 thesis's horizon and risk profile. If current evidence changes the recommended duration, report the reason and the requested successor-plan change; do not silently rewrite the baseline. Never classify "we recommend holding for three weeks" as knowledge that the token will appreciate over three weeks. The known output is an evidence-grounded conditional plan, not a known future return.

Phase 1 recommends actions and records manual reports. It does not run an unattended stop-loss, wait months inside a CLI command, or execute scheduled trades. The output must say when the operator needs to reassess and that no new evidence is observed until another manual run. Phase 3 owns automatic execution.

### Temporal-plan validation and original-plan coverage

Add deterministic clock-boundary regressions for hours, days, weeks and documented calendar-month behavior; exact deadlines; late/missed reassessment; target never reached; invalidation before the first leg and between legs; early profit trigger; partial fill; revised position; unsupported horizon input; and unchanged historical replay. Do not wait three months to test date arithmetic, and do not present a simulated clock or future fixture as observed market history.

For the real-CA acceptance cases, show the actual current HOLD/reduction/EXIT_NOW decision and its saved horizon/plan based on real evidence, then at least a later real reassessment where available. The operator-facing plan and required selection inputs must be known at delivery. Unobserved future legs are conditional future actions, not UNKNOWN current facts and not fabricated executed fills. Cover natural live outcomes without forcing markets to hit a chosen test target; mark any mandatory live path that was not exercised as incomplete.

Before claiming both checklists cover the original plan, add a traceability table to your next result: `accepted Phase1 requirement | source section | Checklist1/Checklist2 owner | implementation symbols | offline proof | real-CA snapshot/evidence | remaining gap`. Use `plans/backend-v1/06-preplan-traceability.md`, `07-round-two-lessons-and-contracts.md` (especially the three-part thesis/invalidation/profit-realization plan and duration/attention-style material), and `09-two-checklist-lifecycle.md`. If raw transcripts are not supplied in your clone, state that you checked the maintained mappings rather than pretending to reread the originals. Coordinate Checklist 1 entries with its owner and do not mark unpublished or unverified work done.

Cover the accepted manual due-diligence/management scope. Existing explicit exclusions for experimental actor research, Phase 2 discovery and Phase 3 trading are not secretly added to this task. Conversely, do not claim literally every transcript idea is implemented while declared deferrals remain. Report scope coverage honestly and name any unresolved Phase 1 item before calling the two-checklist workflow ready for real-life testing.

## Confirmed findings and boundaries

Source line references below refer to reviewed SHA `9d8c218`, not the owner's divergent working files.

### R1 — exact sale feasibility is still unimplemented (release blocker; planned packet 3)

`src/domain/policy.ts:138` makes MG-15 PASS when `candidate && exit === 'PASS'`. The exit comes from EXE-01/EXE-02, whose profile-sized round trip does not prove this proposed sale. The existing `dca-proposed` scenario yields DCA_OUT_PROPOSED for **400 atomic units** with MG-15 PASS and no candidate proof input.

This is an inherited, explicitly deferred gap, not a newly introduced packet-2 regression. It must be closed before describing quantities as execution-supported. Preserve historical v0/v5/v6 outputs on replay; the new policy must make missing proof UNKNOWN/REASSESS_REQUIRED rather than silently continuing the legacy positive result.

MG-03 also needs quantity context: reusing entry-sized route features does **not** prove exit for the original holding or current remaining holding. Correct the collaborator proposal's description of those rows as judging the "original position." Separate the relevant remaining/scenario-quantity safety proof from the exact planned-reduction proof. Neither substitutes for the other.

### R2 — the proposed quote-binding ledger revision can collide (packet-3 prerequisite)

`src/domain/ledger.ts:67` constructs `revision` only from effective event IDs and recorded/effective timestamps. Packet 1 hashes that string as a basis reference; the packet-3 proposal would reuse it as an execution binding. It excludes the initial position and event economic payload.

Reproduction with allowed inputs: start at 1000 units, record a 200-unit sale, then add a CORRECTION replacing it with 100 units at the same accepted effective/recorded timestamps. Remaining inventory changes **800 -> 900**, while `revision` and its SHA-256 stay identical. Changing the initial cost from 100 to 200 likewise changes remaining cost **80 -> 160** without changing that revision. These are content-identity collisions, not cryptographic hash failures.

The ledger revision predates these packets; the new trace exposes it and the proposed proof would rely on it. Do not change legacy hashes in place. Add a versioned canonical **execution-basis fingerprint** covering token/case/position identity and initial position terms, episode/frozen plan and quantity basis, effective as-of event/correction payloads, and reconciled resulting inventory/attribution. Binding must change when decision-relevant basis changes, while excluding facts unavailable at the historical cutoff. Keep legacy `revision` behavior for existing policy results unless separately versioned. Quote freshness is a separate time check, not a substitute for this binding.

### R3 — successor plans can silently inherit another plan's leg consumption (unfinished lifecycle requirement)

`src/app/service.ts:164` accepts successor theses without quantity-plan reconciliation; `soldByLeg` is keyed only by leg ID. A Service probe saved a 40% leg, recorded its 400-unit sale, then accepted a successor with the same leg ID/shape. The new episode's MG-12 became PLAN_EXHAUSTED with 600 units still present.

That result may be correct for an explicitly continued plan, but the API does not distinguish continuation from replacement. Conversely, fresh IDs alone do not solve it: percentages still use original q0, not automatically the remaining inventory. The collaborator already disclosed the limitation. Complete it through explicit reconciliation, not a documentation-only instruction to choose fresh IDs.

For the smallest sufficient design, distinguish continuing a leg with carried fills from replacing/rebasing a plan. Freeze the chosen quantity basis and attribution. Reject ambiguous successors, or persist their unresolved reconciliation and block quantified proposals, while still reporting known invalidation. Never silently reset fills. Do not retroactively reject or rewrite historical accepted episodes. Specify this contract before editing shared persistence.

### R4 — hypothetical DCA output lacks its mode (operator-output requirement)

`src/domain/policy.ts:145-149` emits `positionMode` only for EXIT_REVIEW. A HYPOTHETICAL `dca-proposed` input returns quantity 400 with no `positionMode`. The management snapshot's normal result does not otherwise expose that position record. This omission predates the new DCA behavior; packet 2 addressed only exit-review display.

The next output version must identify MANUAL_REPORTED versus HYPOTHETICAL for **every position-derived quantity or financial estimate**, including DCA, plus position/basis reference, decimals/units and relevant remaining quantity. No position means explicit unavailable context. Scenario results never assert the operator's actual profit, principal recovery or guaranteed protective sale. Add a real Service/CLI output test, not only a type assertion.

### R5 — current branch is not yet compatible with owner v1-v4 replay (expected integration gap)

`src/domain/management-trace.ts:20,172-181` knows v0/v5/v6 and accepts only the old input list. A v4 call fails UNSUPPORTED_POLICY_VERSION. That is an appropriate fail-closed response on this isolated old-base branch, not a reason to weaken it.

The owner's `Service` stores schema-v2 frozen `policyFeatures`, details/social facts, and dispatches qualifier modes for v1-v4. Merely adding those labels to `LEGACY_MANAGEMENT_POLICY_VERSIONS` is insufficient proof of compatibility, even if MG-12 matches: preserve each label's input qualification, reused entry rules, result shape, feature version, and hash dependencies. Keep the owner's existing v0-v4 replay route until explicit equivalence is tested. Never feed raw features to a historical qualified snapshot.

### R6 — stage and longitudinal output remain partial (remaining planned scope)

`resolveStage` currently selects cap/age bands; `evaluateManagement` uses them for MG-05 context, not the full cap x age x attention-style rule parameters in plan 09. On the owner live path, qualified cap and token-creation values currently remain null. StageInputs carries no observation references. Comparison output is a coarse diff rather than the planned prior-comparable volume/attention windows and changed-check explanation.

Implement stage-dependent rule selection with explicit versioned profile data and honest missing values; do not fabricate chronological thresholds, volume feeds, cap, creation time or history. Independent safety/invalidation must keep working when stage-dependent rules cannot. Numeric trends require actual comparable measurements, not boolean O28/A18 qualifications or two arbitrary snapshots.

## Architecture and scope that remain binding

Checklist 1 owns acquisition/qualification of on-chain, attention and social facts. Checklist 2 owns deterministic management, position/plan accounting and its tests. Owner coordinates shared contracts, policy helpers, Service/replay, CLI and schema integration while Checklist 1 is unpublished. Use existing TypeScript/ESM, Zod, Decimal/bigint and `node:sqlite`. No new frontend, service framework, Convex migration, scanner or trading engine.

Read `CONTRIBUTING.md`, verified source, `agentic/architecture.md` and `plans/backend-v1/09-two-checklist-lifecycle.md`. The plan is the intended contract, not proof every proposed command exists. `AGENTS.md`, `bridgecode/` and the active task board may be local-only; use applicable supplied instructions and required specialists, but no private files/chats/keys are dependencies. Main agent does planning; only Bridgecode-required independent reviewers are requested.

A saved passing entry activates reassessment immediately. Cap/age select rules and cannot postpone early invalidation. Late first inspection does not reconstruct an earlier thesis. The cap bands are MICRO [0,100k), SMALL [100k,1m), ESTABLISHED [1m,10m), LARGE [10m,infinity); FDV is not circulating cap and pool age is not token creation age. Exact age bands, trading windows and profit/risk settings are explicit profile choices, not invented course rules.

Thesis state precedence remains INVALIDATED for known prohibited safety/invalidation/expiry, otherwise UNVERIFIABLE for required missing evidence, otherwise WEAKENING for failed support, otherwise VALIDATED. Proposals remain EXIT_REVIEW, REASSESS_REQUIRED, REDUCE_REVIEW, DCA_OUT_PROPOSED or MAINTAIN_THESIS under the documented prerequisites. Provider failure never proves an unsellable token. No continuous monitoring or order execution exists in Phase 1. Missing position restricts quantification, not all thesis evaluation.

User's intended initial chain set is Solana/BSC/Base/Robinhood, with explicit partial support. Free data first, configurable budget/size/horizon. Neither four chain names nor fixture PASS establishes live coverage. The owner's unpublished Solana/attention/social work cannot be recreated from assumptions.

## Round-two implementation decisions and sequence

These are the technical directions for the next handoff, not changes already implemented. Resolve ordinary implementation details within this contract; ask only for genuinely user-owned strategy choices. No need to reopen ten general approval questions before starting deterministic work.

### A. Keep the delivered work and protect its history

Retain v5/v6 as the identifiers already used by these delivered packets; reserve them for those semantics. Owner v1-v4 remain reserved too. Use a distinct next policy version (v7 if still unused at implementation time) for changed feasibility/output behavior. Snapshot schema, management-rule version and entry/qualification version are distinct concerns. A rules table is acceptable if it preserves the full behavior required by each historical label; it is not enough to parameterize only sell order.

Do not regenerate v0/v5 golden expectations from newer code. Add a v6 capture from the reviewed implementation before changing fresh semantics. Preserve old hashes, late-report cutoffs, baseline/episode lineage and operator databases. The owner remains shared integration custodian. No date is promised for publishing Checklist 1; proceed with deterministic packets in your own branch meanwhile.

### B. Build the fingerprint and reconciliation foundation

Implement R2's new execution-basis fingerprint and R3's explicit successor reconciliation. Keep each patch bounded and separately reviewable where their persistence dependencies differ. A temporary unknown/reconciliation-required outcome is acceptable where a plan has not explicitly resolved its basis; a silent reset or fictitious proof is not.

Tests must cover same-timestamp corrections changing quantity, cost/fee or leg attribution; distinct initial positions; repeated unchanged as-of state; future-recorded corrections excluded; carried partial fills; successor continuation; replacement with reused IDs; fresh IDs with old q0; oversize remaining plan; and no change to legacy replay. Decide and document deterministic canonical ordering, without hashing mutable presentation strings as identity.

### C. Implement packet 3 with a corrected proof contract

The collaborator's CandidateExitProof direction is suitable, with the following corrections. Use a strict typed schema and a discriminated result: a BLOCKED route need not invent positive proceeds, and an unsupported/unavailable provider never fabricates a BLOCKED proof.

| Boundary | Required contract |
|---|---|
| Identity | Chain/token, case/position and episode/plan binding, candidate leg, exact atomic input quantity and decimals; match current reconciled execution basis |
| Basis | New versioned execution-basis fingerprint, not hash of the old metadata-only ledger revision |
| Time | Quote/state as-of, local observation/availability and expiry; enforce as-of/available <= cutoff < expiry. Evidence acquired after cutoff cannot be backdated |
| Evidence | Nonempty resolvable evidence IDs, supported adapter/route and actual source binding. A claimed level/string or hash alone is not authentication |
| Qualification | QUOTED versus SIMULATED with explicit required policy/profile level; research-only profile may allow QUOTED, but no silent general live certification or upgrade of imported data |
| Economics | Explicit quote asset and units, positive/finite amounts where applicable, coherent gross/net costs, declared fee inclusion and source-supported conversion for fees in another asset. Missing conversion is unknown, not free |
| Slippage | Define `minOut` as a minimum output amount with asset/units, distinct from any slippage tolerance in bps; validate relevant inequalities and configured limits |
| Outcome | Fillable within limits, proven blocked on a supported path, or insufficient/unavailable evidence. Conflicting matching proofs cannot be cherry-picked into PASS |
| Persistence | Strict optional bundle/assessment field and frozen proof/request in snapshots, versioned replay and bounded collections; no forged LIVE provenance from imports |

A user import can supply a labeled scenario/claimed quote, but cannot certify live selling simply by asserting QUOTED/SIMULATED, FILLABLE or evidence IDs. Follow existing import versus trusted-live boundaries. Synthetic tests may exercise all outcomes without claiming market reality. Checklist 2 validates and consumes proof; Checklist 1 produces real supported receipts and quantity-specific observations. Until such a producer exists, live MG-15 stays UNKNOWN with an explicit cause.

Expose the exact quote request even when proof is missing: token/case/episode/position, leg, atomic amount, decimals and execution-basis fingerprint. No trade is placed. Missing, stale, mismatched, insufficient or conflicting proof => UNKNOWN and no positive DCA. Due but oversized candidate => QUANTITY_CONFLICT/reconciliation required; do not let an earlier generic NO_ELIGIBLE_LEG branch hide it. Supported blocked/over-limit proof => MG-15 FAIL. Coherent fresh fillable proof within configured limits can PASS.

Reuse `risk.maxExitImpactBps` unless an evidenced requirement needs a distinct limit. All other costs/minimums required by the selected profile must be explicit and enforced. Do not add strategy defaults through an LLM. Classify no-liquidity/quantity-specific failure separately from token-wide restrictions. Candidate infeasibility alone gives REASSESS_REQUIRED; independently established forbidden token-wide safety or relevant-position exit restriction follows the existing INVALIDATED/EXIT_REVIEW precedence. EXIT_REVIEW must still say if execution is BLOCKED/UNKNOWN, never promise a protective fill.

Correct MG-03 separately through relevant remaining/scenario-quantity proof. Positive candidate proof does not override failed safety; entry-sized route evidence does not certify remaining holdings. Coordinate this shared proof production contract with Checklist 1 while building pure deterministic consumers now.

### D. Finish timed management plans, operator context, stage behavior and combined acceptance

Implement the HOLD/EXIT_NOW and timed DCA-out contract above, then apply R4 to every sized proposal and financial estimate. Save/display case/token/episode/baseline/current cutoff, thesis state and proposal reasons, decisive changed rows, position mode/basis/remaining inventory, exact candidate/proof/expiry and execution limitations. Net proceeds/principal-recovery intent only when the required recorded costs and comparable quote evidence exist. Make missing context explicit.

Implement stage-dependent parameters with explicit profile versions, cap/creation provenance and source availability. Bind a previous comparable snapshot when a rule needs change over time; distinguish evidence change, policy/profile change and intentional successor-thesis change. Missing comparable history stays UNKNOWN. Do not demand an unsupported live feed to test deterministic behavior; track the collector dependency separately.

Finally merge an owner-published checkpoint into a clean collaborator branch and coordinate shared wiring. Preserve `analyzeLive`/`reassessLive`, schema-v2 frozen qualified inputs, details/social facts, qualifier modes and v0-v4 replay; add v5/v6/new-version dispatch deliberately. Do not overwrite whole Service/policy/contracts/CLI files from the older base. Test actual combined CLI paths and offline replay, including safe missing-proof behavior. Live provider acceptance is separate from fixture acceptance and can remain a precisely stated external dependency rather than invented proof.

## Required regression and completion gates

For each packet, run its focused tests and the established `npm run typecheck` / `npm test` block when stable. New tests belong to the management owner and must exercise production functions/Service/CLI, not an independent implementation of the same equations.

The round-two acceptance matrix must include:

- No candidate proof; exact matching proof; wrong token/chain/position/episode/leg/quantity/decimals/basis; missing evidence; future/unavailable/stale/expired quote; contradictory proofs; unsupported provider; costs/units inconsistent; blocked route; over-limit impact; valid scenario versus trusted live proof.
- Same-timestamp correction fingerprint changes, unchanged-state stability, no future-information leakage, and carried/replaced successor plans.
- HYPOTHETICAL and MANUAL_REPORTED mode in DCA and EXIT_REVIEW output, plus absent position and unknown cost. No false principal-protection claim.
- Consumed/partial/unattributed/exhausted legs, due quantity larger than remaining, known invalidation despite unrelated missing data, and missing stage without lost safety.
- Exact cap boundaries, missing creation/cap, pool migration, cap decrease, selected parameter versions and missing prior comparable measurements.
- v0/v5/v6/new-version saved replay in your branch; v1-v4 with actual qualified frozen inputs after owner integration. Unknown versions still fail closed. Goldens never silently updated to hide a regression.
- CLI save/reopen/show/replay and backup/restore if persistence changes; tests always use dedicated temporary database/artifact directories.

Definition of done for **all Checklist 2**, rather than one packet: required management and position semantics and the timed HOLD/EXIT_NOW/DCA-out plan implemented, no unsupported positive quantity/financial claims, clear inspectable output, compatible historical replay, demonstrated combined manual entry-to-management flow, and the strict real-CA ZERO-UNKNOWN gate above met for every agreed acceptance case. Explicit explanations of unknowns are useful diagnostics but do not satisfy completion. A deliberately unsupported chain need not be falsely certified to finish the supported scope; the support boundary must be named.

## Delivery, ownership and single source of truth

Continue on `codex/checklist-2` or a topic branch descended from reviewed HEAD. Do not reset to the original base. A clean new clone can check out reviewed HEAD detached to reproduce this review, then create a new topic branch. Preserve your existing work before any switch/merge.

Update this file with the result SHA, completed acceptance items, actual commands/results, sanitized examples, migration/version changes, known collector dependencies and next bounded action. Use `CONTRIBUTING.md` for the ownership/merge agreement. Older collaborator packet files can remain historical references; they must not continue directing a new agent to restart packet 1 or use the old ledger revision as execution proof.

Keep `agentic/architecture.md` current in your clone, scoped to verified management behavior. Do not overwrite active owner work. Public commits exclude credentials, private endpoints, operator positions/journal, source transcripts and raw model material. Do not publish or trade without authorization in your own session.

**Next action:** preserve a v6 golden baseline, implement the execution-basis/reconciliation prerequisites and corrected packet 3, with explicit scenario/live separation and mode-labeled output. Coordinate shared live integration with the owner when a Checklist 1 checkpoint is available, then run the mandatory real-CA pillar/row acceptance and include its complete results in your next delivery; if blocked before then, report partial progress and NOT_RUN/INCOMPLETE. This review requests further implementation; it does not merge the current branch or declare Checklist 2 complete.
