# Checklist 2 handoff: collaborator → owner

Branch `codex/checklist-2`, based on published `main` at `27273cff16b334c6ba54187bd0170efad611f446`. Nothing on `main` changed. This one document covers everything delivered so far and everything that needs your decision.

## At a glance

- **Done: packet 1, traceable rows.** Every management row now says *why* it has its status: decisive features, usable evidence, a typed basis and a specific reason code. No status changed.
- **Done: packet 2, sell steps in order.** MG-12 now asks the same question as the sale proposal: is the *next unsold* step due? A finished plan asks for a successor plan, and an exit review states the remaining quantity.
- **Proposed: packet 3, proof that a sale can fill.** This is the record MG-15 should require before a sale is proposed. It needs your approval and has no code yet.
- **Evidence:** typecheck exits 0, `npm test` passes 55/55, and an independent review passed each packet.
- **Most urgent for you:** decision 1 (policy labels) and decision 6 (the packet 3 shape). All ten decisions are listed in the last section.

## Commits

| Commit | What it does |
|---|---|
| `c314cd2` feat(policy): explain predicate outcomes with decisive features | Shared seams only, no behavior change. Builds and passes the 37 base tests on its own. |
| `e6b45f4` feat(management): traceable MG row explanations | Packet 1. Label `thesis-management-v5`. |
| `f8d8f91` docs(handoff) | Packet 1 note, superseded by this document. |
| `b784f9c` refactor(ledger): ordered next-leg selection behind proposeLeg | No behavior change. Builds and passes the 46 tests that existed then. |
| `f90601a` feat(management): MG-12 follows sell-step order | Packet 2. Label `thesis-management-v6`. |
| `15c5766`, `c8e69c1` docs(handoff) | Packet 2 note and packet 3 proposal, superseded by this document. |

## 1. Packet 1: every row says why

Before, all 15 MG rows emitted `featureRefs: []`, `evidenceRefs: []` and one of three generic reason codes. MG-07 could say FAIL without naming the rule or evidence that fired it.

| Field | Meaning |
|---|---|
| `featureRefs` | The *decisive* features. An `all` that is FALSE cites its FALSE children, and an `any` that is TRUE cites its TRUE children. UNKNOWN cites the unknown leaves, which are exactly what to refresh. Otherwise every child is cited. Row lists combine the same way: support as `all`, invalidation as `any`. |
| `evidenceRefs` | Evidence IDs of cited features that were usable at the cutoff: KNOWN, APPLICABLE, available by the cutoff, and non-null. Evidence of missing or future features is never cited. |
| `basisRefs` | Typed non-feature basis, never disguised as evidence. The kinds are `EPISODE`, `BASELINE_SNAPSHOT`, `THESIS_FIELD`, `EXIT_LEG`, `PROFILE_FIELD`, `STAGE_INPUT`, `POSITION`, `LEDGER_REVISION` (sha256 of the ledger revision) and `ENTRY_CHECK`. |
| `reasonCode` | PASS is `RULE_SATISFIED`, and NOT_APPLICABLE is `NOT_CONFIGURED`. FAIL codes are row-specific: `SAFETY_RULE_FAILED`, `EXIT_RULE_FAILED`, `SUPPORT_CONTRADICTED`, `INVALIDATION_TRIGGERED`, `CATALYST_CONTRADICTED`, `TRACTION_NOT_MET`, `WARNING_TRIGGERED`, `TRIGGER_NOT_DUE`, `HORIZON_EXPIRED`. UNKNOWN codes name the cause: `INSUFFICIENT_EVIDENCE`, `POLICY_PARAMETER_MISSING`, `PLAN_UNSPECIFIED`, `BASELINE_MISSING`, `STAGE_INPUT_MISSING`, `POSITION_MISSING`, `COST_UNKNOWN`, `UNRECONCILED_SALE`, `NO_ELIGIBLE_LEG`, `EXIT_NOT_CONFIRMED`, and since packet 2 `PLAN_EXHAUSTED`. |

MG-02 and MG-03 cite the reused entry rows that decided them as `ENTRY_CHECK` basis: the failing rows on FAIL, the non-passing rows on UNKNOWN, and all rows on PASS. When a row is UNKNOWN only because a profile limit is missing (SEC-04, LIQ-01, EXE-02), it cites the `PROFILE_FIELD`, for example `risk.maxTransferFeeBps`, with `POLICY_PARAMETER_MISSING`.

Example from `examples/entry.json` followed by `examples/reassessment.json` (synthetic, not live evidence):

```json
{ "checkId": "MG-07", "status": "FAIL", "reasonCode": "INVALIDATION_TRIGGERED",
  "featureRefs": ["O03"], "evidenceRefs": ["fixture-evidence-001"],
  "basisRefs": [{ "kind": "THESIS_FIELD", "ref": "invalidation" }] }
```

## 2. Packet 2: sell steps in order

MG-12 used to ask "is *any* step due?", while `proposeLeg` asked "is the *next unsold* step due?". When the two answers disagreed, the result was a needless REASSESS_REQUIRED, or a MAINTAIN while a sale was unmatched. Now one function, `nextLeg`, answers for both. It walks the legs in plan order and skips any leg whose original-quantity share is sold, or an all-remaining leg once inventory is zero. The first remaining leg's trigger then decides. Later steps never jump the queue.

All rows below use the synthetic fixtures: a 1000-unit position and a step selling 40% of the original quantity.

| Situation | v5 | v6 |
|---|---|---|
| Step 1 sold in full, step 2 not due | REASSESS_REQUIRED | MAINTAIN_THESIS (MG-12 `TRIGGER_NOT_DUE` on step 2) |
| Step 1 not due, step 2 due | REASSESS_REQUIRED | MAINTAIN_THESIS: step 2 waits its turn |
| Step 1 due, step 2's trigger unknown | REASSESS_REQUIRED | DCA_OUT_PROPOSED, 400 for step 1 |
| Every step sold | MG-12 PASS, REASSESS_REQUIRED | MG-12 UNKNOWN `PLAN_EXHAUSTED`, REASSESS_REQUIRED: write a successor plan |
| A sale not attributed to a step, trigger not due | MAINTAIN_THESIS | MG-12 UNKNOWN `UNRECONCILED_SALE`, REASSESS_REQUIRED |
| Invalidated or expired, position known at the cutoff | EXIT_REVIEW | EXIT_REVIEW plus `remainingQuantityAtomic` and `positionMode` |

For a price ladder (2x, then 3x), order never delays a sale: at 3x the 2x trigger is also true. The program proposes step 1, then step 2 at the next reassessment after step 1's sale is recorded. That is one step at a time, as plan 09 requires.

"The goal will not be reached" stays the job of the invalidation rules and `expiryAt`. Either one reaches EXIT_REVIEW at any point in the plan. Tests cover the cases before step 1 is sold and after a partial sale, where 1000 and then 800 remain.

**Choices worth your eye:**

- **An unattributed sale makes MG-12 unknown.** The next step can't be known until the sale is attributed.
- **A fully sold position is also `PLAN_EXHAUSTED`.** It gets REASSESS_REQUIRED, never MAINTAIN. Closing the case stays the operator's action.
- **A due step larger than the remaining inventory** gives MG-12 PASS but MG-15 `NO_ELIGIBLE_LEG`. Candidate sizing is unchanged from before.
- **Without a position, nothing counts as sold.**
- **EXIT_REVIEW sizes no sale.** `remainingQuantityAtomic` is the ledger's inventory at the cutoff. `positionMode` (`MANUAL_REPORTED` or `HYPOTHETICAL`) always sits beside it, so a hypothetical quantity is never read as a real holding.

`proposeLeg` keeps its signature and results; it is now `legCandidate(nextLeg(…))`. The old and new walks differ in one case only, an all-remaining leg with zero inventory and an un-due trigger. With zero inventory no later leg can be sized, so every candidate is identical. One `nextLeg` result feeds the candidate, MG-12 and MG-15, so the three always name the same step.

## 3. Versions and replay

`Service.replay` recomputes a saved result from its frozen inputs and compares hashes. At the base it used whatever evaluator was current, so any change in rules or shape would have broken every saved snapshot. Now `Service.reassess` and `Service.replay` both call `evaluateManagementAs(policyVersion, …inputs)`, which re-evaluates with the rules of the label recorded on the snapshot.

| Label | Rules | Result shape |
|---|---|---|
| `thesis-management-v0` (base) | v5 rules | Projected to the pre-packet-1 shape: empty refs, no basis, three generic codes |
| `thesis-management-v5` (packet 1) | `{ legSelection: 'ALL_TRIGGERS', exitReviewQuantity: false }` | Full trace |
| `thesis-management-v6` (packet 2, recorded on new snapshots) | `{ legSelection: 'ORDERED', exitReviewQuantity: true }` | Full trace |
| Any other label | none | Throws `UNSUPPORTED_POLICY_VERSION` |

The rules live in `MANAGEMENT_RULES` in `src/domain/management-trace.ts`. Packet 1's post-hoc reshaping (`managementResultForVersion`) was replaced: once statuses change, reshaping a result cannot restore an old status, so a saved result has to be re-evaluated under its own rules. v5 and v6 are **provisional until you confirm them** (decision 1).

## 4. Integrating into your tree

The shared-file changes, about 220 diff lines, are shown by:

`git diff 27273cff16b334c6ba54187bd0170efad611f446..codex/checklist-2 -- src/domain/contracts.ts src/domain/policy.ts src/app/service.ts src/domain/ledger.ts`

The new collaborator-owned files are:

- `src/domain/management-trace.ts`;
- `tests/management-trace.test.ts`, `tests/management-sell-order.test.ts`, and `tests/management-scenarios.ts` (shared scenario inputs, not a test file);
- `tests/fixtures/management-v0-golden.json` and `tests/fixtures/management-v5-golden.json`. Never regenerate these from newer code.

- **Your v1–v4 labels.** If their MG-12 and proposal precedence match v5's all-triggers rule, add them to `LEGACY_MANAGEMENT_POLICY_VERSIONS`: they will replay with v5's rules and the legacy projection. If one of them changed MG-12 or the precedence, it needs its own `MANAGEMENT_RULES` entry. Otherwise their replay throws.
- **Trailing `rules` argument.** `evaluateManagement` gained an optional trailing `rules`, defaulting to the current label's rules. If your version already has more trailing arguments (qualification mode, social facts), place `rules` wherever it fits and pass it from `evaluateManagementAs`.
- **Trace inputs.** `traceManagementRows` only explains statuses `evaluateManagement` already decided; it never changes one. Call it with the same `entryChecks` and features your evaluator used, and MG-02/03 will cite them consistently.
- **Import cycle.** `policy.ts` ↔ `management-trace.ts` follows the existing `policy.ts` ↔ `ledger.ts` pattern. Neither uses the other's exports at module load.
- **Risk-limit map.** `ENTRY_RISK_LIMITS` mirrors which profile limits `evaluateEntry` reads for SEC-04, LIQ-01 and EXE-02. If you change those rules, update the map; a test covers it.
- **`ledger.ts`.** `nextLeg`, `legCandidate` and `LegSelection` are new exports. Commit `b784f9c` isolates them for review.

## 5. Evidence

All checks ran on Node v26.0.0 against fixture data.

- **Golden captures, before any edit.**
  - `tests/fixtures/management-v0-golden.json` came from the base build: 18 scenarios with exact v0 results, plus 2 persisted v0 rows.
  - `tests/fixtures/management-v5-golden.json` came from the packet 1 build: 28 scenarios as result hashes with readable summaries, plus 3 persisted v5 rows whose results differ under v6.
  - Each scenario's `inputsHash` proves the tests rebuild exactly the captured inputs.
- **Replay.** All saved v0 and v5 rows replay unchanged.
  - Relabeling a v5 row as v6 makes replay fail with `REPLAY_RESULT_MISMATCH`, which proves the label selects the rules.
  - Compared raw, the v0 rows mismatch; through the projection they match.
  - Unknown labels fail closed.
- **Mutation probes on the build.**
  - Giving v6 the old rules fails 7 of the 9 packet 2 tests. The two that survive don't depend on v6.
  - Giving v5 the new rules fails the v0 and v5 goldens, the v5 row replay and the packet 1 sell-plan trace test.
- **Invariants over all 28 scenarios:**
  - MG-12, MG-15 and the proposal name the same step.
  - Every cited feature exists, and every cited evidence ID comes from a usable cited feature.
  - The exit-review quantity appears exactly when a position is known.
- **Totals and reviews.**
  - Typecheck exits 0, and `npm test` passes 55/55.
  - The two seam commits build alone.
  - CLI analyze → reassess → replay on the published examples is byte-identical.
  - An independent first review returned PASS for packet 1 and for packet 2.

## 6. Not covered yet

- **MG-05** cites stage-input names but no observation evidence IDs, because `StageInputs` carries none.
- **MG-02/03** cite every feature of a failing entry row.
- **No top-level reason** explains the thesis state or proposal; only the rows do. "Plan finished" is MG-12's `PLAN_EXHAUSTED`.
- **Reused leg IDs inherit old sales.** `soldByLeg` is keyed by leg ID alone, so a successor plan that reuses a leg ID inherits that leg's earlier sales. This predates these packets, but ordered selection now relies on it. Until decision 5, successor plans should use fresh leg IDs.
- **MG-15 has no quantity-bound sale proof.** That is section 7.
- **Fixture checks are not live acceptance.** Live stage inputs are still null.

## 7. Packet 3 proposal: proof that the proposed sale can fill

**Status: needs your approval. No code yet.**

**The gap.** MG-15 passes today when a candidate exists and EXE-01/EXE-02, recomputed from the reassessment bundle, pass. Those rows judge the entry-sized round trip (O10–O16, for the profile's requested size). They say nothing about selling *this* step's quantity against *this* ledger revision. In the `dca-proposed` fixture, the system proposes selling 400 units on route features sized for a $10 round trip. Plan 09 asks for MG-15 PASS only when the "proposed remaining-quantity reduction is within inventory, cost/route assumptions and profile limits", with proposals that "expire with the relevant quote and become stale after a reported sale or balance revision".

**Proposed shape: `CandidateExitProof`.** A proof is evidence about one hypothetical sale. Checklist 1 produces it from a supported quote or simulation, and Checklist 2 only validates and consumes it. Nothing fetches, signs or sends anything. Proofs travel in the reassessment bundle as an optional `exitProofs` array, so they are frozen into the snapshot and replay deterministically.

| Field | Meaning | MG-15 checks |
|---|---|---|
| `id` | Stable proof ID | Cited as a new `EXIT_PROOF` basis kind |
| `token` | `{ chain, address }` | Equals the case token |
| `legId` | The leg the quantity was computed for | Equals the candidate's leg |
| `quantityAtomic`, `decimals` | Exact sell input in atomic units | Equal the candidate and the position's decimals. Never scaled or clipped. |
| `ledgerRevision` | sha256 of the ledger revision, as MG-13 already cites | Equals the revision at the cutoff, so any later sale retires the proof |
| `level` | `QUOTED` or `SIMULATED` (`INDICATIVE` is not accepted) | At least the policy's minimum |
| `outcome` | `FILLABLE`, or `BLOCKED` with `blockedCause` (`NO_LIQUIDITY` or `TOKEN_RESTRICTION`) | `BLOCKED` only on a supported, certified path. Provider failure or an unsupported route yields no proof at all. |
| `asOf`, `expiresAt` | State/quote time and quote expiry | `asOf ≤ cutoff < expiresAt` |
| `route` | `{ venueId, routeId, method }`, where `method` is `DIRECT_QUOTE`, `AGGREGATOR_QUOTE` or `STATEFUL_SIMULATION` | Recorded |
| `quoteAsset` | Currency of the proceeds | Recorded; no conversion |
| `exitImpactBps` | Exit impact for this quantity (O14 definition) | ≤ `risk.maxExitImpactBps` |
| `grossProceeds`, `netProceeds`, `costs` | Decimal quote amounts; `costs` = `{ routeFee, tokenTax, networkFee }` | `netProceeds > 0`; the breakdown is kept for display |
| `minOut` | Slippage tolerance assumed by the quote | Recorded |
| `evidenceIds` | Non-empty evidence record IDs | In the bundle and available by the cutoff |

**How MG-15 would decide.** Today's reasons stay first, in this order: `POSITION_MISSING`, `PLAN_UNSPECIFIED`, `UNRECONCILED_SALE`, `NO_ELIGIBLE_LEG`. After them:

| Situation | MG-15 | New reason | Proposal |
|---|---|---|---|
| Next due step larger than the remaining inventory | UNKNOWN | `QUANTITY_CONFLICT` | REASSESS_REQUIRED |
| No proof for the candidate | UNKNOWN | `EXIT_PROOF_MISSING` | REASSESS_REQUIRED |
| Proof bound to another token, leg, quantity, decimals or ledger revision | UNKNOWN | `EXIT_PROOF_MISMATCH` | REASSESS_REQUIRED |
| Expired, future-dated, or evidence not available by the cutoff | UNKNOWN | `EXIT_PROOF_STALE` | REASSESS_REQUIRED |
| Level below the policy's minimum | UNKNOWN | `EXIT_PROOF_INSUFFICIENT` | REASSESS_REQUIRED |
| Exit-impact limit not configured | UNKNOWN | `POLICY_PARAMETER_MISSING` | REASSESS_REQUIRED |
| Supported path proves the sale cannot fill | FAIL | `EXIT_BLOCKED` | See decision 8 |
| Impact above the limit, or net proceeds ≤ 0 | FAIL | `EXIT_COST_EXCEEDS_LIMIT` | REASSESS_REQUIRED |
| Bound, fresh, sufficient, fillable and within limits | PASS | `RULE_SATISFIED` | DCA_OUT_PROPOSED, now also stating `exitProofId` and `proposalExpiresAt` |

`QUANTITY_CONFLICT` replaces today's silent fallback to `NO_ELIGIBLE_LEG`. It is a row reason, not a thrown error, so a known invalidation in the same reassessment stays visible.

**What stays separate.** MG-02 and MG-03 keep judging the *original position's* safety and exit from your entry rows. The candidate proof feeds MG-15 only. A fillable proof never repairs a failing MG-03.

**Operator flow:**

1. Reassess. A due step without a proof returns REASSESS_REQUIRED with MG-15 `EXIT_PROOF_MISSING`, plus the exact request the proof must match (decision 9).
2. Obtain a quote or simulation for exactly that request.
3. Reassess with the proof in the bundle. Any recorded sale changes the ledger revision and retires the proof.

**Who builds what.**

- **Checklist 2:** the proof schema (a shared `contracts.ts` change, to be coordinated), binding/freshness/limit validation, the MG-15 decision and trace, the new reason codes and basis kind, a new label (DCA without a proof becomes REASSESS), and deterministic fixtures and tests.
- **Checklist 1:** provider adapters that produce real proofs for an exact quantity, venue certification and evidence records.

## 8. Decisions needed from you

Most urgent first. Recommendations are marked.

1. **Policy labels.** May Checklist 2 use `thesis-management-v5` (packet 1) and `thesis-management-v6` (packet 2), given your unpublished v1–v4? If not, which labels should they take?
2. **Replay dispatcher.** Does `evaluateManagementAs` (a per-label rules table plus the legacy projection) fit your dispatcher, with v1–v4 placed as described in section 4?
3. **Integration.** Who integrates the shared-file changes into your tree?
4. **Checklist 1 checkpoint.** When will you publish one for me to merge?
5. **Leg-ID reuse.** Should sales be scoped to a thesis episode, so a successor plan may reuse a leg ID, or should leg IDs be unique across a case's plans?
6. **Packet 3 shape.** Approve the `CandidateExitProof` fields and the `exitProofs` bundle array, or say what to change.
7. **Minimum proof level.** *Recommended:* a profile/policy setting that defaults to `QUOTED` under `research-screen-v0`, with `SIMULATED` reserved for `execution-verified-v0`, as in plan 02.
8. **Proven blocked sale.** *Recommended:* MG-15 FAIL `EXIT_BLOCKED` with REASSESS_REQUIRED. Should a `TOKEN_RESTRICTION` cause also count against safety (MG-02), which would turn the result into EXIT_REVIEW? That is your call.
9. **Quote request on the result.** *Recommended:* yes. While MG-15 waits for a proof, show the exact request (token, leg, quantity, decimals, ledger revision). Today the quantity appears only on a DCA proposal.
10. **Exit-impact limit.** *Recommended:* reuse `risk.maxExitImpactBps` for the candidate rather than adding a separate management limit.
