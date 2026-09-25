# Phase 1: entry thesis and management checklist

This document records the user's explicit round-two scope expansion: manual due diligence includes **two linked checklists per chain-qualified contract**. Checklist 1 assesses an entry thesis. Checklist 2 compares later manually collected evidence with that saved thesis and proposes maintaining, reducing or exiting exposure. Phase 2 discovers new pairs automatically. Phase 3 adds automated execution. No code or trades are implemented in this planning task.

Confirmed by the user: saving a passing entry thesis activates management immediately; age and market cap select applicable rules and cannot postpone detecting an early invalidation. Phase 1 includes optional manual entry and sale records. Without them, proposals are explicitly hypothetical and cannot claim to describe the user's actual profit/loss. These decisions govern the whole package.

## 1. One case, two different questions

Use a `ResearchCase` keyed by case ID and TokenRef. TokenRef remains chain-qualified: the same EVM address on Base and BSC is not the same case. A token may have multiple explicitly named thesis episodes, but never silently pick among them. A default active case supports the paste-contract workflow; ambiguous active episodes require selection.

Checklist 1 answers: **Does current evidence support establishing this entry thesis for this size, horizon and risk profile?** It reuses the existing 33 checks and v0 precedence. Its PASS remains `RESEARCH_ELIGIBLE`, not an executed entry. The interface may call this “Entry thesis eligible”; do not claim ownership or fill from a PASS.

Checklist 2 answers: **Does the saved thesis still hold, and is there evidence supporting a planned reduction or exit?** It has its own check manifest, state summary and proposal. It reuses current security, liquidity, volume, attention and social observations without turning Checklist 1's original PASS into a permanent safety certificate.

Do not rerun Checklist 1 and call its new result thesis validation. A token can pass a generic screen while its particular catalyst has expired, its representation lost leadership, or its planned profit target has been reached. Conversely, a mature community can fail v0's new-entry growth test without invalidating a previously frozen retention thesis. Both cases require the second checklist's own predicates.

The store contains both checklist definitions from the outset. An initial-only case has management lifecycle `NOT_STARTED`, no fabricated management result and no rows marked NOT_APPLICABLE merely because it has not run. Full saved checklists are available on demand; default output selects the relevant one and names the baseline thesis.

On a saved ENTRY PASS, persist the evidence-grounded thesis and open a THESIS_TRACKED episode atomically. Management is now available even below $100k and within minutes of creation; it runs on the next manual reassessment, not as an implicit background monitor. Persist unresolved management predicates/plan settings as missing, so management can report known safety changes while refusing an unsupported positive proposal. A failed entry stays INITIAL_RESEARCH and can be analyzed again. Repeated entry runs cannot replace an existing active thesis without an explicit successor-episode operation.

## 2. Case and snapshot contracts

```text
ResearchCase
  caseId, tokenRef, createdAt, activeThesisEpisodeId?
  status: INITIAL_RESEARCH | THESIS_TRACKED | CLOSED
  entrySnapshotIds[], managementSnapshotIds[]

ThesisEpisode
  episodeId, caseId, baselineEntrySnapshotId, frozenThesisRevision
  entryPolicyHash, managementPolicyHash, stageProfileHash
  thesisPredicates[], invalidationPredicates[], realizationPlan?, missingPlanFields[]
  createdAt, acceptedAt?, expiresAt?, supersedesEpisodeId?

ManagementSnapshot
  snapshotId, caseId, episodeId, baselineEntrySnapshotId, previousManagementSnapshotId?
  currentEvidenceManifest, versions, evaluatedAt, knowledgeCutoff
  stageContext, featureResults[], managementChecks[]
  thesisState, proposal, evidenceCoverage, limitations[]
```

Reuse the existing immutable snapshot envelope and hash scheme, adding `checklistKind = ENTRY | MANAGEMENT` and the required references. Entry and management policies have separate namespaces/hashes. Preserve old entry snapshots and support versioned decoding; never reinterpret their `verdict` field as a management action. Management JSON has a typed `managementResult` rather than a misleading binary entry verdict.

Every management result compares to a frozen baseline and, where a rate/change requires it, the previous comparable management observation. Store both references; missing baseline cannot be reconstructed from today's marketing copy. New evidence or changed policy creates a new revision. An intentionally changed thesis creates a successor episode and states what changed; it does not erase the prior invalidation.

## 3. Market-cap and creation-age rule selection

Use the market-cap examples from notes 2148–2152 as a **proposed profile**, with precise disjoint intervals:

| Cap band | Circulating market cap USD | Note-derived chart candidates |
|---|---|---|
| MICRO | `[0,100000)` | 1m, 5m, 15m |
| SMALL | `[100000,1000000)` | 30m, 1h |
| ESTABLISHED | `[1000000,10000000)` | 4h, 1d |
| LARGE | `[10000000,infinity)` | No value prescribed in notes; explicit profile setting |
| UNKNOWN | Missing, conflicting, unverified or stale cap | No FDV substitution; cap-dependent rules UNKNOWN |

Exact $100k belongs to SMALL, $1m to ESTABLISHED and $10m to LARGE. “Around $100k” is not an executable interval without boundaries. The names describe profile bins, not proven economic maturity. Market cap remains a contextual proxy; executable depth and requested size remain authoritative for loss/impact checks. Chart candidates are not mandatory bars if a token lacks the history; insufficient history produces UNKNOWN rather than fabricated candles.

Creation age uses evidenced token deployment/mint creation time as of the snapshot, not first API discovery. Store `tokenCreatedAt`, verification/coverage, `firstTradableAt` where known, `marketCreatedAt` and `firstObservedAt` separately. Pool migration does not reset token age. An old mint with a new tradable launch has both ages and cannot masquerade as a newly created token. Missing creation time gives AGE_UNKNOWN even if the pool is young.

The notes prescribe no exact chronological age thresholds. `stageProfile.ageBands[]` therefore requires explicit versioned boundaries in seconds before age-specific branches can activate. Bands must be ordered, nonoverlapping and cover the configured domain with an UNKNOWN branch; names and boundaries are saved with the profile. The system may still show raw age and evaluate age-independent checks before those parameters are selected. Never invent “under 24 hours” as a course rule.

Resolve a `stageCell = capBand × ageBand × attentionStyle`, with the chosen timeframe, minimum history, freshness, volume/attention windows and applicable predicate parameter sets. Avoid maintaining dozens of copy-pasted checklists: the two stable checklists consume versioned parameter sets. Security and acquired-quantity exit checks remain active across cells. Missing cap or age disables only predicates dependent on that value; it cannot suppress a known safety/invalidation finding.

Record observed and effective stage separately. A profile can require consecutive fresh observations or a hysteresis margin before a noncritical stage transition; those settings must be explicit and default to no hidden smoothing. Cap decline can move the effective cap band down, but cannot erase a thesis episode or reset an invalidated case into fresh-entry eligibility. Age is derived monotonically from the frozen creation observation except when a documented correction creates a new revision.

## 4. Management check manifest

Use the same four row states PASS/FAIL/UNKNOWN/NOT_APPLICABLE and evidence/parameter references as the entry checklist. A PASS means the row's stated condition holds, not always “hold the coin.” Group rows by role to avoid counting target attainment as a safety failure. Management evaluations do not use the entry verdict aggregator.

Define a separate `ManagementCheckResult`: common check ID/version/status/measured/threshold/featureRefs/evidenceRefs/explanation fields, `checklistKind: MANAGEMENT`, `managementRole` from the table below, `requiredFor: THESIS | QUANTIFIED_PROPOSAL | CONTEXT | WARNING`, and applicability. Do not assign new role strings to the entry `CheckResult.role` enum. Share field schemas, not the entry aggregation function.

| ID | Role | PASS predicate; other states |
|---|---|---|
| MG-01 baseline linkage | REQUIRED_EVIDENCE | Saved eligible entry snapshot, frozen thesis and case identity match. Missing/mismatched baseline => UNKNOWN; do not invent one |
| MG-02 current integrity | SAFETY | Current supported control/provenance checks remain acceptable. Proven disallowed authority or mechanism => FAIL; unavailable inspection => UNKNOWN |
| MG-03 exit feasibility | SAFETY | Fresh supported exit route for relevant remaining/scenario quantity, with costs and configured tolerances. Proven blocked exit => FAIL; absent setup/provider data => UNKNOWN |
| MG-04 evidence coherence | REQUIRED_EVIDENCE | Dependencies are timely, comparable and conflict-resolved; missing/stale/conflicting => UNKNOWN |
| MG-05 stage resolution | CONTEXT | Required cap/creation-age profile cell resolves. Missing fields/parameters => UNKNOWN; independent rows still run |
| MG-06 thesis support | VALIDATION | All configured required support predicates TRUE. Any FALSE => FAIL; otherwise any UNKNOWN => UNKNOWN |
| MG-07 invalidation clear | INVALIDATION | All configured invalidation predicates FALSE. Any TRUE => FAIL; otherwise any UNKNOWN => UNKNOWN. Empty unspecified invalidation set => UNKNOWN |
| MG-08 catalyst/representation | VALIDATION | Frozen catalyst/origin/leadership conditions still hold where required. Verified expiry/displacement violating predicate => FAIL; insufficient competitor evidence => UNKNOWN |
| MG-09 on-chain traction | TRACTION | Configured comparable volume/participation predicate TRUE with integrity/coverage qualifiers. Known predicate FALSE => FAIL; unqualified apparent volume => UNKNOWN |
| MG-10 external traction | TRACTION | Configured qualified attention/source-breadth predicate TRUE. Copied/price-only noise cannot substitute; missing source coverage => UNKNOWN |
| MG-11 crowding/decay | WARNING | No configured crowding/decay warning predicate TRUE. Trigger => FAIL warning, not automatic invalidation unless frozen invalidation explicitly references it; missing => UNKNOWN |
| MG-12 profit trigger | REALIZATION | At least one unconsumed, specified realization trigger TRUE. All known FALSE => FAIL (not due); unresolved triggers => UNKNOWN |
| MG-13 plan/quantity | REQUIRED_FOR_QUANTIFIED_PROPOSAL | Exit plan quantities/cost basis/context valid for requested proposal. Missing position/scenario or unspecified plan => UNKNOWN |
| MG-14 horizon validity | INVALIDATION | Frozen horizon/expiry conditions remain valid. Observed configured expiry => FAIL; unspecified required expiry => UNKNOWN |
| MG-15 proposal feasibility | REQUIRED_FOR_QUANTIFIED_PROPOSAL | Proposed remaining-quantity reduction is within inventory, cost/route assumptions and profile limits. Unfillable supported case => FAIL; insufficient evidence => UNKNOWN |

Rows are independently inspectable. MG-09/MG-10 traction thresholds must be profile data: window lengths, volume type, minimum sample/notional, growth comparison, author/source independence and integrity prerequisites. More raw volume is not necessarily healthy demand. Twitter is one source; no platform-name shortcut satisfies MG-10. The LLM classifies bounded evidence; code evaluates thresholds and propositions.

The baseline traction profile can require trustworthy source/market binding, comparable windows, known bot-flow attribution where available and no unresolved material conflict, using O28/O30 and social provenance. It must not demand the unimplemented full O26/O27 research detectors as a hidden Phase 1 prerequisite. Claim only covered observable volume/participation, not proven universally organic flow. Stronger integrity predicates can be selected later and remain UNKNOWN when unsupported.

Support/invalidation predicates use a typed AST over saved features, with three-valued logic: all is FALSE if any FALSE, TRUE if all TRUE, otherwise UNKNOWN; any is TRUE if any TRUE, FALSE if all FALSE, otherwise UNKNOWN. An empty required predicate list is invalid config rather than vacuous truth. References must resolve to a frozen schema/version and known units. Historical windows use actual availability cutoffs.

MG-08 or MG-14 may be NOT_APPLICABLE only when the frozen thesis explicitly has no such dependency. A community need not have an external event expiry, but still needs an explicit invalidation plan. Price decline, weaker support and invalidation are not synonyms unless the saved predicates define that relationship.

For management policy `thesis-management-v0`, current SEC/LIQ/EXE checks reuse their selected risk limits. The management manifest must name the exact predicate IDs behind each row and requiredness. A user-selected stage profile supplies time windows and tolerances before a dependent row can PASS. Missing settings => UNKNOWN, never an LLM-selected threshold. Any critical entry safety FAIL maps to MG-02 or MG-03 with original check/evidence references; a known unavailable exit route is a safety finding even if the original narrative still holds. A provider outage remains UNKNOWN, never proven blocked selling.

## 5. Thesis state and deterministic proposal

Compute thesis state independently from action feasibility:

1. A known forbidden safety change, proven unacceptable exit restriction, TRUE frozen invalidation condition, or configured horizon expiry => `INVALIDATED`.
2. Otherwise, missing required thesis evidence/predicates => `UNVERIFIABLE`.
3. Otherwise, known failed support condition without an invalidation trigger => `WEAKENING`.
4. All required support/invalidation-clear predicates satisfied => `VALIDATED`.

A missing position record does not make a factual thesis unknowable. It prevents a position-specific quantified proposal. Conversely, a complete position record cannot compensate for missing social or chain evidence.

Proposal precedence is explicit:

| Condition | Proposal | Required explanation |
|---|---|---|
| INVALIDATED or proven dangerous structural change | `EXIT_REVIEW` | Cite triggering predicate; estimate loss/prevention context only with valid position/scenario evidence; disclose exit feasibility separately |
| Thesis UNVERIFIABLE | `REASSESS_REQUIRED` | Missing/stale evidence and what to refresh; never imply “safe to keep holding” |
| Thesis WEAKENING | `REDUCE_REVIEW` | Explain weakening; quantify only if a frozen reduction rule and valid position/scenario exist |
| VALIDATED, MG-09 and MG-10 PASS, an unconsumed profit trigger PASS, quantified-proposal prerequisites PASS | `DCA_OUT_PROPOSED` | Named exit leg, amount/basis, remaining quantity, estimated net proceeds/costs and expiry |
| VALIDATED, specified profit trigger due, but traction or required proposal evidence unresolved/contradictory | `REASSESS_REQUIRED` | Do not fabricate a DCA proposal; show due trigger and missing/conflicting support |
| VALIDATED with all necessary proposal-decision evidence known and no profit trigger due | `MAINTAIN_THESIS` | Thesis remains supported at this snapshot; no order or guarantee |
| Any other unresolved combination, including a due trigger with invalid quantities or infeasible route assumptions | `REASSESS_REQUIRED` | Name blocking rows; no default positive action |

An unspecified realization plan or unknown trigger cannot resolve to MAINTAIN_THESIS. An optional warning can appear beside any result; if a configured warning requires action, encode that as an explicit frozen predicate rather than a hidden override. Known invalidation is reported even if unrelated evidence is missing. If the route is blocked, the proposal reports `executionFeasibility = BLOCKED` and cannot promise a protective exit.

Exit legs have an explicit order and predecessor-completion predicate. Select the earliest eligible unconsumed leg whose trigger is TRUE; do not propose all legs merely because their price thresholds are currently exceeded. Partial fills propose only the unfilled amount. If a later leg can execute independently, that exception must be frozen in the plan. A later manual purchase does not enlarge original-q0 percentage legs; rebasing quantities requires an explicit successor plan with carried-forward fills and reconciled inventory. Reject quantity conflicts rather than hiding them by clipping.

“Stop-loss/prevent-loss” is a proposal intent, not an order type this backend places. `LOSS_LIMIT`, `PRINCIPAL_PROTECTION`, `PROFIT_REALIZATION` and `UNDETERMINED` depend on recorded cost basis, net liquidation estimate and configured plan. Quote-positive proceeds are estimated, never guaranteed. Proposal quantities expire with the relevant quote and become stale after a reported sale or balance revision. DCA-out here means staged reduction, not automatic buys or averaging down.

### Optional manual position ledger

Add `PositionRecord` linked to case/episode with mode `MANUAL_REPORTED | HYPOTHETICAL`, quote currency, token decimals, initial acquired quantity, total entry cost including disclosed fees, entry time, source/provenance and revision. An input of unit entry price must reconcile to quantity/notional; do not derive total cost from market cap. Hypothetical scenarios never imply a real holding. Missing entry quantity/cost basis permits general thesis/exit review but prevents position-specific recovery/loss arithmetic.

`PositionEvent` is append-only: BUY_REPORTED, SELL_REPORTED, FEE_REPORTED, TRANSFER_ADJUSTMENT or CORRECTION, with effective/recorded times, atomic quantity, net quote proceeds/cost, fee assets, evidence and idempotency key. Enforce nonnegative remaining inventory, duplicate-event protection, unit consistency and no double-subtraction of included fees. Corrections reference the replaced event and recompute a new ledger revision; existing snapshots stay frozen. A later buy changes cost basis and remaining quantity under a declared cost-basis method, not by rewriting the original plan. Token-denominated taxes/fees affect inventory explicitly.

Use weighted-average cost as the initial accounting method for a single manually reported position, with deposits/transfers lacking acquisition cost marked UNKNOWN rather than free profit. Preserve gross costs/proceeds and total net cash flows so principal-recovery arithmetic remains auditable. FIFO or lot-specific accounting is a separate future version. Portfolio-wide accounting is not required.

A proposal does not consume an exit leg. Only a recorded filled sale, explicitly allocated to the leg, consumes its filled quantity; partial fills preserve the remainder. A sale without leg attribution reduces inventory but leaves the plan reconciliation unresolved, blocking further quantified legs until resolved. Closing a case does not fabricate a sale or realize PnL. Reject a filled amount exceeding ledger inventory; record conflicts for corrections rather than silently clipping.

The ledger and optional user feelings/postmortem form the Phase 1 journal. They stay local and out of public model packets by default. Read-only receipt imports may corroborate user reports later, but signing, wallet connection and automatic transaction discovery are not prerequisites.

## 6. Manual workflow and observability

Proposed Phase 1 commands extend the existing CLI:

```text
dd analyze <contract> --chain <chain>              # resolve existing case or start entry research
dd case show <case-id>
dd thesis accept <entry-snapshot-id> --plan <file>
dd reassess <case-id>                            # manually collect current evidence, run checklist 2
dd position record <case-id> --file <entry.json>
dd position event <position-id> --file <sale-or-correction.json>
dd explain <snapshot-id> --checklist entry
dd explain <snapshot-id> --checklist management
dd diff <management-snapshot-a> <management-snapshot-b>
dd case close <case-id> --reason <reason>
```

These are proposed contracts, not installed commands. `thesis accept` validates and attaches explicit plan settings or creates an explicitly requested successor episode; it is not a required second approval for the automatic tracking of a saved PASS. JSON modes remain noninteractive. If a pasted contract resolves to a tracked thesis, the response identifies that case and runs the management workflow; `--checklist entry` explicitly requests fresh entry research without replacing the saved thesis. Late first inspection cannot validate a nonexistent early thesis: run current entry research, state late-first-observation, and establish a baseline only from evidence actually available then.

Default management output includes case/token, baseline and current times, age/cap bands, thesis state, proposal, top changed checks, volume/attention changes with windows, quantity basis when available, and missing evidence. Full entry and management checklists remain saved and inspectable by snapshot ID. No prose-only LLM judgment can override the recorded management result.

No continuous monitoring is promised in Phase 1. The system learns from repeated manual analyses and explicit refreshes, with a journal of thesis/proposal changes. If no one runs reassessment, it cannot discover an invalidation or claim an active stop. Saved results visibly expire under the selected freshness/horizon rules.

## 7. Delivery and validation changes

Phase 1 is complete only when both checklist workflows operate. P00–P07 delivers the entry engine and shared context. P11 now belongs to Phase 1 for case/thesis/management/journal contracts; it is no longer merely a future proposal. Implement the deterministic management flow before experimental actor scoring. P08 historical evaluations and P10 calibration improve the process as manual cases accumulate; they do not replace the management checklist with a backtest.

Phase 2 supplies automatically discovered pairs to the same entry service and retains candidate-selection provenance. Phase 3 needs a separate execution/risk system and paper validation; no current proposal is an authorization to transact. P12 remains a later paper-simulator proposal, not a condition that Phase 1 needs a trading engine.

Required examples include: early saved thesis invalidates before cap growth; mature first-time input has no fabricated baseline; exactly $100k/$1m boundaries; missing cap/creation age; pool migration; cap falls after management activation; no operator refresh; missing volume/attention; duplicate posts; known invalidation despite unrelated missing data; DCA target already consumed; stale quote; partial manual sale; policy migration; multiple active episodes; no actual position; and frozen baseline unchanged after a new extraction.

Structural acceptance: two distinct checklist manifests and outputs; saved PASS activation; immutable evidence/lineage; deterministic management precedence; explicit stage selection and unresolved settings; optional audited manual position ledger; no duplicate ingestion; manual operations only; no silent transition to discovery or execution. Exact age bands and live risk/realization thresholds remain user-selected configuration, not missing architectural decisions or invented course rules.
