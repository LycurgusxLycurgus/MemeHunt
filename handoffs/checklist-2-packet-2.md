# Checklist 2 · packet 2 hand-back: sell steps in order

Branch `codex/checklist-2`, on top of packet 1 (`f8d8f91`). Nothing on `main` changed. New management snapshots record `thesis-management-v6`, which is **provisional until you confirm it**, like v5 (question 1 below).

MG-12 used to ask "is *any* sell step due?" while the sale proposal (`proposeLeg`) asked "is the *next unsold* step due?". The two answers disagreed, and the disagreement surfaced as needless REASSESS_REQUIRED verdicts or, worse, a MAINTAIN while a sale was unmatched. MG-12 now asks the proposal's question, through the same function. These are the decisions recorded at the end of `handoffs/checklist-2-packet-1.md`.

## What changes for an operator

All rows use the synthetic fixtures: a 1000-unit position and a step selling 40% of the original quantity.

| Situation | v5 | v6 |
|---|---|---|
| Step 1 sold in full, step 2 not due | REASSESS_REQUIRED (MG-12 PASS from step 1's old trigger, nothing to size) | MAINTAIN_THESIS (MG-12 FAIL, `TRIGGER_NOT_DUE` on step 2) |
| Step 1 not due, step 2 due | REASSESS_REQUIRED | MAINTAIN_THESIS: step 2 waits its turn |
| Step 1 due, step 2's trigger unknown | REASSESS_REQUIRED (MG-12 UNKNOWN) | DCA_OUT_PROPOSED, 400 for step 1 |
| Every step sold | MG-12 PASS, REASSESS_REQUIRED | MG-12 UNKNOWN `PLAN_EXHAUSTED`, REASSESS_REQUIRED: write a successor plan |
| A sale not attributed to a step, trigger not due | MAINTAIN_THESIS | MG-12 UNKNOWN `UNRECONCILED_SALE`, REASSESS_REQUIRED |
| Invalidated or expired, position known at the cutoff | EXIT_REVIEW | EXIT_REVIEW plus `remainingQuantityAtomic` and `positionMode` |

"The goal will not be reached" stays the job of the thesis's invalidation rules and `expiryAt`, never of sell steps. The new tests show both rules reach EXIT_REVIEW before step 1 is sold and after a partial sale (1000 remaining, then 800).

## Commits

1. `refactor(ledger): ordered next-leg selection behind proposeLeg` touches only `src/domain/ledger.ts` and changes no behavior. `nextLeg` walks the legs in plan order. It skips any leg whose unfilled share is zero or less: `quantityBps` of the original quantity minus that leg's attributed sales, or, for an all-remaining leg, the remaining inventory. The first remaining leg's trigger then decides. `proposeLeg` becomes `legCandidate(nextLeg(…))`, with the same signature and results. The old and new walks differ in one case only, an all-remaining leg with zero inventory and an un-due trigger: the old walk returned null, and the new one skips the leg. With zero inventory no later leg can be sized, so every candidate is identical. This commit builds and passes the 46 earlier tests on its own.
2. `feat(management): MG-12 follows sell-step order (thesis-management-v6)` holds the rule change, the version table, the replay dispatch, the tests, the v5 golden fixture and the architecture notes.
3. `docs(handoff): …` is this note.

## Mechanism

- **One selection.** `evaluateManagement` calls `nextLeg` once. Its result sizes the candidate under every label and decides MG-12 under v6, so MG-12, MG-15 and `proposedLegId` always name the same step. A test checks this over all 28 scenarios.
- **Rules per label.** `management-trace.ts` owns `MANAGEMENT_RULES`:
  - v5 is `{ legSelection: 'ALL_TRIGGERS', exitReviewQuantity: false }`.
  - v6 is `{ legSelection: 'ORDERED', exitReviewQuantity: true }`.

  `evaluateManagement` takes them as an optional trailing `rules` argument, defaulting to the current label's rules.
- **Replay.** `evaluateManagementAs(label, …inputs)` replaces packet 1's `managementResultForVersion`. Packet 1 could reshape a result after evaluating it because no status had changed. Packet 2 changes statuses, so a saved result must be *re-evaluated* under its own rules. Replay therefore works per label:
  - v6 and v5 evaluate with their own rules.
  - Labels in `LEGACY_MANAGEMENT_POLICY_VERSIONS` (v0) evaluate with v5's rules, then take the pre-traceability projection.
  - Anything else throws `UNSUPPORTED_POLICY_VERSION`.

  `Service.reassess` and `Service.replay` both call it, so the recorded label and the applied rules cannot drift apart.
- **MG-12 explanation under v6.**
  - A step that decides cites its `EXIT_LEG` and the `LEDGER_REVISION` that proved the earlier steps sold.
  - `PLAN_EXHAUSTED` cites every leg and the ledger revision.
  - `UNRECONCILED_SALE` cites the position and the ledger revision.
- **Exit review quantity.**
  - `remainingQuantityAtomic` is the ledger's inventory at the cutoff, including later reported buys.
  - `positionMode` (`MANUAL_REPORTED` or `HYPOTHETICAL`) always sits beside it, so a hypothetical quantity is never read as a real holding.
  - Both appear only when the position was entered and recorded by the cutoff.
  - EXIT_REVIEW still proposes no sale size.

## Choices worth your eye

- **An unattributed sale makes MG-12 unknown.** Which step is next can't be known until the sale is attributed. An unmatched sale with an un-due trigger therefore moves from MAINTAIN to REASSESS, which prompts reconciliation.
- **A fully sold position is also `PLAN_EXHAUSTED`.** It gets REASSESS_REQUIRED, never MAINTAIN. Closing the case stays the operator's action.
- **A due step larger than the remaining inventory** (for example after a transfer out) gives MG-12 PASS but MG-15 `NO_ELIGIBLE_LEG`, so REASSESS. Candidate sizing is unchanged from v5.
- **Without a position, nothing counts as sold**, so the first step decides.

## Integrating into your tree

- **Dispatcher.** Packet 1's question 2 now concerns `evaluateManagementAs`, the per-label evaluation step.
- **Your v1–v4 labels.** If their MG-12 and proposal precedence match v5's all-triggers rule, they belong in `LEGACY_MANAGEMENT_POLICY_VERSIONS`: they will replay with v5's rules and the projection. If any of them changed MG-12 or the precedence, it needs its own `MANAGEMENT_RULES` entry instead.
- **Trailing argument.** If your `evaluateManagement` already has more trailing arguments (qualification mode, social facts), place `rules` wherever it fits and pass it from `evaluateManagementAs`.
- **`ledger.ts`.** `nextLeg`, `legCandidate` and `LegSelection` are new exports. Commit 1 isolates them for review.

## Evidence

- **Before any edit:** `tests/fixtures/management-v5-golden.json` was captured from the packet-1 build. It holds 28 scenarios, each stored as an `inputsHash`, the hash of its exact v5 result and a readable summary, plus three real persisted v5 rows whose results differ under v6.
- **After the change:** typecheck exits 0, and `npm test` passes 55/55 (46 earlier + 9 new) on Node v26.0.0.
- **Mutation probes on the build:**
  - Giving v6 the old rules fails 7 of the 9 new tests. The two survivors don't depend on v6.
  - Giving v5 the new rules fails the v0 and v5 goldens, the v5 row replay and the packet-1 sell-plan trace test.
- **Persisted-row test:** it relabels each saved v5 row as v6 and expects `REPLAY_RESULT_MISMATCH`, which proves the label really selects the rules.
- **Packet-1 tests:** only their setup changed. They now evaluate explicitly under v5, and the v0 golden goes through the real replay path. No expected value changed.
- **CLI smoke:** analyze → reassess → replay on the published examples was byte-identical.
- **Review:** an independent first review returned PASS.

## Not covered by this packet

- **No top-level reason on the proposal.** "Plan finished" is MG-12's `PLAN_EXHAUSTED`.
- **Reused leg IDs inherit old sales.** `soldByLeg` is keyed by leg ID alone, so a successor plan that reuses a leg ID counts that leg's earlier sales. This predates packet 2, but ordered selection now relies on it. Until you decide (question 3), successor plans should use fresh leg IDs.
- **MG-15 still has no quantity-bound sale proof.** That is packet 3, proposed separately.
- **Fixture checks are not live acceptance.**

## Questions for you

1. May packet 2 use `thesis-management-v6`, or which label should it take?
2. Does `evaluateManagementAs`, a per-label rules table plus the legacy projection, fit your replay dispatcher?
3. Should sales be scoped to a thesis episode, so that a successor plan may reuse a leg ID, or should leg IDs be unique across a case's plans?
