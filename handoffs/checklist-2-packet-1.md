# Checklist 2 · packet 1 hand-back: traceable management rows

Branch `codex/checklist-2`, based on `27273cff16b334c6ba54187bd0170efad611f446` (published `main`). The result is the branch head; the commits after the base are listed below. Nothing on `main` changed. The new management policy label `thesis-management-v5` is **provisional until you confirm it** (question 1 below).

Every management row now says why it has its status, and no status, thesis state, proposal or proposed quantity changed. Before this packet, all 15 MG rows emitted `featureRefs: []`, `evidenceRefs: []` and one of three generic reason codes. MG-07 could say FAIL without naming the rule or evidence that fired it.

## Commits

1. `feat(policy): explain predicate outcomes with decisive features` changes only shared seams and no behavior. `explainPredicate` returns the same three-valued truth plus the features that decided it, and `combineExplanations` holds the all/any semantics. `evaluatePredicate` now wraps `explainPredicate`, so explanation and truth come from one function. `usable` and `predicateRefs` are exported, and `contracts.ts` gains `ManagementBasisRef` and an optional `basisRefs` on `ManagementCheckResult`. This commit builds on its own and passes the 37 original tests.
2. `feat(management): traceable MG row explanations (thesis-management-v5)` adds the new `src/domain/management-trace.ts`, one wiring line in `evaluateManagement`, the label and replay dispatch in `Service`, `tests/management-trace.test.ts`, the golden fixture, and the management notes in `agentic/architecture.md`.
3. `docs(handoff): …` is this note.

## What a row contains now

| Field | Meaning |
|---|---|
| `featureRefs` | The *decisive* features. `all` FALSE cites its FALSE children; `any` TRUE cites its TRUE children; UNKNOWN cites the unknown leaves, which are exactly what to refresh; otherwise every child is cited. Row lists combine the same way: support as `all`, invalidation as `any`. |
| `evidenceRefs` | Evidence IDs of cited features that were usable at the cutoff (KNOWN, APPLICABLE, available by the cutoff, non-null). Unlike entry rows, evidence of MISSING or future features is never cited. |
| `basisRefs` | Typed non-feature basis: `EPISODE`, `BASELINE_SNAPSHOT`, `THESIS_FIELD`, `EXIT_LEG`, `PROFILE_FIELD`, `STAGE_INPUT`, `POSITION`, `LEDGER_REVISION` (sha256 of the ledger revision), `ENTRY_CHECK`. These are never disguised as features or evidence. |
| `reasonCode` | PASS is `RULE_SATISFIED` and NOT_APPLICABLE is `NOT_CONFIGURED`. FAIL is row-specific: `SAFETY_RULE_FAILED`, `EXIT_RULE_FAILED`, `SUPPORT_CONTRADICTED`, `INVALIDATION_TRIGGERED`, `CATALYST_CONTRADICTED`, `TRACTION_NOT_MET`, `WARNING_TRIGGERED`, `TRIGGER_NOT_DUE`, `HORIZON_EXPIRED`. UNKNOWN is cause-specific: `INSUFFICIENT_EVIDENCE`, `POLICY_PARAMETER_MISSING`, `PLAN_UNSPECIFIED`, `BASELINE_MISSING`, `STAGE_INPUT_MISSING`, `POSITION_MISSING`, `COST_UNKNOWN`, `UNRECONCILED_SALE`, `NO_ELIGIBLE_LEG`, `EXIT_NOT_CONFIRMED`. |

MG-02 and MG-03 cite the reused entry rows that decided them as `ENTRY_CHECK` basis: the failing rows on FAIL, the non-passing rows on UNKNOWN, and all rows on PASS. When a row is UNKNOWN only because a profile limit is missing (SEC-04, LIQ-01, EXE-02), it cites the `PROFILE_FIELD` (for example `risk.maxTransferFeeBps`) with `POLICY_PARAMETER_MISSING`, and it cites no features.

Example from the published fixtures, `examples/entry.json` then `examples/reassessment.json` (synthetic, not live evidence). Statuses are identical to the base run.

```json
{ "checkId": "MG-07", "status": "FAIL", "reasonCode": "INVALIDATION_TRIGGERED",
  "featureRefs": ["O03"], "evidenceRefs": ["fixture-evidence-001"],
  "basisRefs": [{ "kind": "THESIS_FIELD", "ref": "invalidation" }] }
{ "checkId": "MG-13", "status": "UNKNOWN", "reasonCode": "POSITION_MISSING",
  "featureRefs": [], "evidenceRefs": [], "basisRefs": [{ "kind": "THESIS_FIELD", "ref": "legs" }] }
```

## Versions and replay

At the base, `Service.replay` recomputed management results with the current evaluator, with no dispatch, so any change to the result shape would have broken every saved v0 snapshot. Now:

- `Service.reassess` records `MANAGEMENT_POLICY_VERSION` (`thesis-management-v5`).
- `Service.replay` passes the recomputed result through `managementResultForVersion(policyVersion, result)`. The current label compares the full result. Labels in `LEGACY_MANAGEMENT_POLICY_VERSIONS` (currently `thesis-management-v0`) compare the result projected to the pre-traceability shape: empty refs, no `basisRefs`, three generic codes. Any other label throws `UNSUPPORTED_POLICY_VERSION` rather than being reinterpreted.
- That projection is exact only because this packet changes no status. A packet that changes statuses must keep the old behavior for old labels.

## Integrating into your tree

View every shared-file change with `git diff 27273cff16b334c6ba54187bd0170efad611f446..codex/checklist-2 -- src/domain/contracts.ts src/domain/policy.ts src/app/service.ts` (about 120 lines). Notes for your newer code:

- **Legacy labels.** Your v1–v4 must join `LEGACY_MANAGEMENT_POLICY_VERSIONS`, or be routed through your dispatcher to the same projection. Otherwise their replay throws.
- **Trace inputs.** `traceManagementRows` only explains: it reads the statuses, `entryChecks`, features, stage, ledger and candidate that `evaluateManagement` already computed. In your version, which passes qualification mode and social facts into safety evaluation, call it with the same `entryChecks` and features your evaluator used, and MG-02/03 will cite them consistently.
- **Import cycle.** `policy.ts` and `management-trace.ts` import each other, the same pattern as the existing `policy.ts`/`ledger.ts` cycle. Neither uses the other's exports at module load.
- **Risk-limit map.** `ENTRY_RISK_LIMITS` in `management-trace.ts` mirrors which profile limits `evaluateEntry` reads for SEC-04, LIQ-01 and EXE-02. If you change those rules, update the map; a test covers it.

## Evidence

Typecheck exit 0 and `npm test` 46/46 (37 existing + 9 new) on Node v26.0.0, run on the working tree that became these commits. Before any source edit, `tests/fixtures/management-v0-golden.json` was captured from the base build. It holds 18 scenarios, each stored as an `inputsHash` plus its v0 result: invalidation, safety and exit failures, expiry, missing catalyst, missing risk limits, future-available evidence, nested unknown invalidation, weakening, DCA 400 and DCA 200 after an attributed partial sale, maintain, an unreconciled sale, unknown cost, an unknown later leg, and nothing known. It also holds two real persisted v0 MANAGEMENT rows. The tests:

- rebuild each scenario and check that its `inputsHash` still matches;
- assert that the legacy projection of the new result equals the v0 result exactly;
- assert that every cited feature exists and every cited evidence ID comes from a usable cited feature;
- assert that both persisted v0 rows still replay, and that an unknown label fails closed.

A probe showed the projection is load-bearing: compared raw, both v0 rows mismatch; through the projection, both match. The reproduction test was red at the base. An independent first review returned PASS.

## Not covered by this packet

- MG-05 cites `STAGE_INPUT` names but no observation evidence, because `StageInputs` carries no evidence IDs.
- MG-02/03 cite every feature of a failing entry row.
- The overall thesis state and proposal are not explained; only the rows are.
- MG-12 still evaluates consumed legs (packet 2), and MG-15 still has no quantity-bound proof (packet 3).
- Fixture checks are not live acceptance. Live stage inputs are still null.

## Questions for you

1. May packet 1 use `thesis-management-v5`, or which label should it take?
2. Does your replay dispatcher accept a per-version shaping step like `managementResultForVersion`, with v1–v4 in the legacy list, or how should it be shaped?
3. Who integrates the shared-file changes into your tree?
4. When will you publish a Checklist 1 checkpoint for me to merge?

## Collaborator decisions for packet 2 (next)

These were decided by the Checklist 2 owner on 2026-10-06. Packet 2 implements them; see `handoffs/checklist-2-packet-2.md`, which also replaces `managementResultForVersion` with `evaluateManagementAs`.

- **Ordered sell steps.** MG-12 will follow the same order as `proposeLeg`: skip fully sold (attributed) steps, and let the first unfinished step decide. It is due (PASS), not due (FAIL) or UNKNOWN by that step's trigger. Later steps never jump the queue, and no per-step independence flag will be added.
- **Exhausted plan.** When every sell step is used up but inventory remains, the result is `REASSESS_REQUIRED` with a "plan finished" reason, prompting a successor plan. An exhausted plan never yields MAINTAIN_THESIS.
- **"The goal will not be reached."** This is expressed through the thesis's invalidation rules or its `expiryAt` deadline, not through sell steps. Either one yields INVALIDATED → EXIT_REVIEW at any point in the sell plan. Packet 2 adds tests for that, and EXIT_REVIEW will state the remaining quantity, with manual/hypothetical mode, when a position exists.
- Packet 2 changes statuses, so it gets its own label. Results saved under v0 and v5 keep their old MG-12 behavior on replay.
