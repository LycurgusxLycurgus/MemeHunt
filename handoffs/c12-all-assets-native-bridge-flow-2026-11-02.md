# C12: all-asset native covered bridge flow

C12 is accepted for the frozen Wormhole Token Bridge Solana–Ethereum pair, both directions, all canonical assets, over native destination completion time 2026-10-31 [13:00,14:00) UTC. This closes one original unknown; 15 cross-snapshot identities remain. Existing snapshots, other metrics and entry decisions are preserved.

## Runtime and ownership

Explicit Solana `--partial --advisory --c12-bridge-capture FILE` selects proof63/facts62/policy60 independently of semantic models or A01. Reconstruction uses the existing ordinary40 path and replaces C12 alone. Competing source/executor modes are rejected before collection.

- `src/providers/advisory-bridge-import.ts`: original-byte file import, NOFOLLOW, UTF8/hash/receipt/clock/schema checks; 8 MiB and 1,000 embedded records.
- `src/providers/advisory-bridge-native.ts`: deterministic scope, static pair indices, complete Solana dispositions, exact VAA/body/source publication, committed execution, canonical native units and native finality witnesses.
- `src/providers/advisory-bridge-flow.ts`: independent historical canonical-token reference marks, exact JSON number lexemes and BigInt decimal arithmetic; whole-result failure on an unpriced asset or conflicting witness.
- `src/app/c12-bridge.ts`: strict capture descriptor, source ownership and C12-only authority; rejects cached output tampering and entry/Shared/other-metric citations.
- App/live/service, CLI and domain versions complete collection, reconstruction, persistence and replay. Existing aggregate source/storage budgets, dependencies and DB schema are unchanged.

Every retained successful Solana account observation is validated. Conflicting states at the same bank and conflicting immutable message/metadata bytes across banks reject the whole result. Mint supply, lamports and permitted ProgramData fields may change across banks; immutable identity projections remain bound. Same-bank u64 metadata comparisons preserve original numeric lexemes.

## Observed result and limits

The original 1,997,128-byte capture contains 131 records, including required technical failures and matching recoveries. Its SHA256 is `bede7ff93d6c95f935a71ba38270d0b1f2553cb1ef49a1627b22fe98de48aa15`; the maintained fixture is `tests/fixtures/c12-all-assets-native-capture.json`.

Seventeen Solana references yield two in-pair and seven outside-pair completions, plus eight noncompletion transactions. Six Ethereum redemptions give eight admitted transfers across six canonical assets. Solana reference USD inflow is `963.8128477921427407863979831`, outflow `1642.46668133867237012916669311`, net `-678.65383354652962934276871001`; Ethereum is exactly opposite.

These are gross completed transfers and independent END-anchored historical reference marks. Pending transfers, other bridges and other chain pairs are unmeasured. The result is neither net new capital nor executable cash. Source message time, native block time and observation clocks remain distinct; absent type3 fees stay null. Faithful native RPC/index and published protocol semantics are explicit premises. Guardian signatures, independent consensus and deployed source-build identity are not verified. Current program/proxy observations corroborate provenance without proving an absence of transient upgrades. Current bridge metadata reports original units without independently certifying foreign origin or a market peg.

## Acceptance and recovery

Three genuine actual token analyses—C5 `f9acedc2`, Parasite `e23e24ae`, ClaudeCoin `718e263e`—share this one historical global context, with actual 1 November cutoffs. Raw reconstruction, all 49 other metrics, save/idempotence/reopen and OS-network-denied keyless CLI replay pass. Independent native and value oracles verify 2,845 checks/279 pins and 213 checks/68 pins. Six dated histories preserve all 50 facts, hashes, clocks and old missing states under original, latest accepted and corrected runtimes.

Build, 25 focused tests and full regression pass: 2,502 passed, zero failed, one existing optional skip. First native review returned FIX for ignored conflicting account witnesses; exactly one correction was used. Fresh terminal native review and root verification returned PASS. Cycle `c12-all-assets-native-flow-20261031` is CLOSED; do not reopen its review budget.

Private evidence: `.data/all-unknown-20261031/c12-implementation/{contract.md,review-cycle.json,root-verification.json,correction-final.diff}`, corrected three-token replay, independent comparison and `history/run-3-correction/validation.json`. Data oracles and Claude proposals are separate from native review. Claude CLI completed substantial analysis and an unrun codec proposal; Codex implemented the production native bindings after CLI host timeouts. No private model reasoning was inspected.

Run `npm run build`, then the three `dist/tests/advisory-bridge-*.test.js` files with Node's test runner. A new live target may import the maintained historical fixture with the explicit flag above; it does not refresh the bridge hour. The active umbrella checklist remains in `agentic/analysis.md`; durable ownership is in `agentic/architecture.md`. Next is a separate C09 descriptive composition cycle, preserving accepted profile63 and all component windows. C09 is not accepted by this change.
