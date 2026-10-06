# Checklist 2 · packet 3 proposal: proof that the proposed sale can fill

**Status: proposal for owner approval. No code yet.** The packet 3 brief asks the owner to define this shape with the collaborator before implementation. It builds on packet 2 (`handoffs/checklist-2-packet-2.md`).

## The gap

MG-15 ("proposal feasibility") passes today when two things hold: a candidate exists, and the entry rows EXE-01/EXE-02, recomputed from the reassessment bundle, pass. Those rows judge the entry-sized round trip (O10–O16, for the profile's requested size). They say nothing about selling *this* step's quantity against *this* ledger revision.

In the `dca-proposed` fixture, the system proposes selling 400 units of leg-1. MG-15 passes on route features sized for the profile's $10 round trip. No evidence shows that 400 units, after the current ledger revision, can be sold through a real route within the profile's limits. Plan 09 asks for exactly that: MG-15 PASS only when the "proposed remaining-quantity reduction is within inventory, cost/route assumptions and profile limits", with proposals that "expire with the relevant quote and become stale after a reported sale or balance revision".

## Proposed shape: `CandidateExitProof`

A proof is evidence about one hypothetical sale. Checklist 1 produces it from a supported quote or simulation, and Checklist 2 only validates and consumes it. Nothing here fetches, signs or sends anything.

| Field | Meaning | MG-15 checks |
|---|---|---|
| `id` | Stable proof ID | Cited in MG-15 `basisRefs` as a new `EXIT_PROOF` kind |
| `token` | `{ chain, address }` | Equals the case token |
| `legId` | The exit leg the quantity was computed for | Equals the candidate's leg |
| `quantityAtomic`, `decimals` | Exact sell input in atomic units | Equal the candidate quantity and the position's decimals. Never scaled or clipped. |
| `ledgerRevision` | sha256 of the ledger revision the quantity came from, the same value MG-13 already cites | Equals the revision at the cutoff, so any later sale makes the proof stale automatically |
| `level` | `QUOTED` or `SIMULATED` (plan 01 evidence levels; `INDICATIVE` is not accepted) | At least the policy's required level |
| `outcome` | `FILLABLE`, or `BLOCKED` with `blockedCause`: `NO_LIQUIDITY` or `TOKEN_RESTRICTION` | `BLOCKED` is allowed only on a supported, certified path. Provider failure or an unsupported route produces no proof at all. |
| `asOf`, `expiresAt` | State/quote time and quote expiry | `asOf ≤ cutoff < expiresAt` |
| `route` | `{ venueId, routeId, method }`, where `method` is `DIRECT_QUOTE`, `AGGREGATOR_QUOTE` or `STATEFUL_SIMULATION` | Recorded for traceability |
| `quoteAsset` | Currency of the proceeds | Recorded; no conversion in this packet |
| `exitImpactBps` | Exit impact for this quantity, with fee treatment stated (O14 definition) | ≤ `risk.maxExitImpactBps`; a missing limit gives UNKNOWN |
| `grossProceeds`, `netProceeds`, `costs` | Decimal quote amounts; `costs` = `{ routeFee, tokenTax, networkFee }`, kept separate as plan 01 requires | `netProceeds > 0`; the breakdown is stored for packet 4 display |
| `minOut` | Slippage tolerance assumed by the quote | Recorded |
| `evidenceIds` | Non-empty evidence record IDs | Each record is in the bundle and available by the cutoff |

Proofs would travel in the reassessment bundle as an optional `exitProofs` array, so they are frozen into the snapshot and replay deterministically, like features.

## How MG-15 would decide

The candidate reasons that exist today stay first, unchanged: `POSITION_MISSING`, `PLAN_UNSPECIFIED`, `UNRECONCILED_SALE`, `NO_ELIGIBLE_LEG`. After them, in order:

| Situation | MG-15 | Reason (new) | Proposal |
|---|---|---|---|
| Next due step is larger than remaining inventory | UNKNOWN | `QUANTITY_CONFLICT` | REASSESS_REQUIRED: reconcile, or write a successor plan |
| No proof for the candidate | UNKNOWN | `EXIT_PROOF_MISSING` | REASSESS_REQUIRED |
| Proof bound to another token, leg, quantity, decimals or ledger revision | UNKNOWN | `EXIT_PROOF_MISMATCH` | REASSESS_REQUIRED |
| Expired, future-dated, or evidence not available by the cutoff | UNKNOWN | `EXIT_PROOF_STALE` | REASSESS_REQUIRED |
| Level below the policy's minimum | UNKNOWN | `EXIT_PROOF_INSUFFICIENT` | REASSESS_REQUIRED |
| Exit-impact limit not configured | UNKNOWN | `POLICY_PARAMETER_MISSING` | REASSESS_REQUIRED |
| Supported path proves the sale cannot fill | FAIL | `EXIT_BLOCKED` | See question 3 |
| Impact above the limit, or net proceeds ≤ 0 | FAIL | `EXIT_COST_EXCEEDS_LIMIT` | REASSESS_REQUIRED |
| Bound, fresh, sufficient, fillable and within limits | PASS | `RULE_SATISFIED` | DCA_OUT_PROPOSED, now also stating `exitProofId` and `proposalExpiresAt` |

`QUANTITY_CONFLICT` replaces today's silent fallback to `NO_ELIGIBLE_LEG` (packet 2's `nextLeg` already reports a due step whose quantity cannot fit). It is a row reason, not a thrown error, so a known invalidation in the same reassessment stays visible.

## What stays separate

MG-02 and MG-03 keep judging the *original position's* safety and exit from Checklist 1's entry rows. The candidate proof feeds MG-15 only. A fillable proof never repairs a failing MG-03, and an MG-03 failure still invalidates the thesis whatever the proof says.

## Operator flow

1. Reassess. A due step with no proof returns REASSESS_REQUIRED and MG-15 `EXIT_PROOF_MISSING`. The result also states the exact request the proof must match: token, leg, quantity, decimals, ledger revision (question 4).
2. Obtain a quote or simulation for exactly that request. Checklist 1's adapters do this, or a user import while those don't exist.
3. Reassess again with the proof in the bundle. MG-15 now decides, and a DCA proposal carries the proof ID and expiry. Any recorded sale changes the ledger revision, which retires the proof.

## Who builds what

- **Checklist 2 (collaborator):** the proof schema (a shared `contracts.ts` change, to be coordinated), binding/freshness/limit validation in a focused management module, the MG-15 decision and trace, the new reason codes and basis kind, a new policy label (it changes statuses: DCA without a proof becomes REASSESS), and deterministic fixtures and tests for every row of the table above.
- **Checklist 1 (owner):** provider adapters that produce real proofs for an exact quantity, venue certification, evidence records, and the rule that provider failure or an unsupported route yields no proof, with its cause recorded on your side.

Saved v0, v5 and v6 results keep replaying under their own labels, as in packet 2.

## Decisions needed from you

1. **Shape.** Approve the fields above and the `exitProofs` bundle array, or say what to change.
2. **Minimum level.** Recommendation: a profile/policy setting that defaults to `QUOTED` under `research-screen-v0`, with `SIMULATED` reserved for `execution-verified-v0`, following plan 02.
3. **Proven blocked sale.** Recommendation: MG-15 FAIL `EXIT_BLOCKED` with REASSESS_REQUIRED. Should a `TOKEN_RESTRICTION` cause also count against safety (MG-02), which would turn the result into EXIT_REVIEW? That is a Checklist 1 safety call.
4. **Quote request.** Recommendation: show the exact proof request on the result while MG-15 is waiting for a proof. Without it, the operator cannot tell what to quote, because today the quantity appears only on a DCA proposal.
5. **Limit.** Recommendation: reuse `risk.maxExitImpactBps` for the candidate rather than adding a separate management limit.
