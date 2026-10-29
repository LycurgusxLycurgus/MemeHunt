# O29: complete historical reserve path

O29 is **KNOWN** for C5’s canonical WBTC pool over **2026-10-25 20:00–2026-10-26 08:00 UTC**. The complete financial reconstruction covers all57,642 successful transactions and42,846 selected-pool trades. Every trade matches the pinned integer curve; all42,845 consecutive reserve pairs are continuous.

This completes the existing descriptive reserve-path measurement. Defined-size depth, a matched cohort and a thin-liquidity anomaly remain unmeasured, as required by the existing O29 contract. This result does not authorize entry or establish executable capacity.

| Check | Result |
| --- | ---: |
| Financially decoded successful transactions | 57,642 |
| Exact curve matches | 42,846 / 42,846 |
| Exact continuity checks | 42,845 / 42,845 |
| Unresolved financial transactions | 0 |
| Effective reserve discontinuities | 0 |
| Ordered pairs of transactions in the same slot | 8,406 |
| Physical quote offsets cancelled exactly by opposite virtual changes | 42,031 |

Net fee-exclusive flow is−40,399,904 WBTC atomic units. LP fees are916,840 atoms, giving an effective quote reserve change of−39,483,064 atoms. The physical quote change is−39,579,468 and the virtual change+96,404. These are reserve-path accounting values; offset causes are unattributed. Last post-trade values are modelled curve endpoints at the last event, not observed vault balances or window-edge states.

## Implementation and preserved boundaries

Explicit `--advisory --o28-expanded --o23-bulk-capture DIRECTORY --o29-reserve-path` selects proof53/facts52/policy50. The new financial decoder independently validates retained monetary fields, actual signed virtual reserves, arguments, fees, transfers and execution. O23’s count-only facts do not provide financial authority.

The same227 retained source records support separate O23 and O29 reconstructions. No source duplication, additional namespace allowance, profile change, dependency or database schema was introduced. Source records remain `USER_IMPORT` / `RETAINED_PROVIDER_RPC_IMPORT`: hashes bind bytes and original clocks, not provider authentication or deployed binary attestation. Ordinary fetch/storage budgets and the accepted import bounds stay unchanged.

Canonical index time fixes the historical cohort and twelve hours. Verified program time remains separate, including five hour seams. Compiled recovery must also satisfy the earliest native source clock. Canonical invocation provenance determines multihop order; legacy instruction indexes remain preserved observations. Selected-hop financial amounts never become whole-route endpoint amounts.

Only proof53 grants these source IDs O29 authority; proof52 retains O23-only authority. Features, baseline, entry, other advisory metrics and older/default financial behavior remain unchanged.

## Validation and review

- Build and40 focused tests pass. Full suite:2,246 passed, zero failures, one existing optional skip.
- An independent raw-event oracle matches all42,846 curves,42,845 continuity checks and every whole-window/hourly summary. All28 projected fields of every trade match independently decoded raw occurrences:1,199,688 comparisons, zero differences.
- All57,642 default financial decoder proofs/errors match the accepted52 runtime exactly. On identical actual sources and cutoff, all49 other advisory metrics are unchanged.
- Actual CLI analysis, full-source Service reconstruction, persistence, idempotence, reopening and OS-network-denied CLI replay pass.
- Three actual tokens checked: new C5 financial result plus dated Parasite and ClaudeCoin controls. Their missing O29 values remain missing. Accepted52 C5/O23 full-source replay is unchanged. These are not three new positive tapes. The original Oct12 temporary database is unavailable; mismatched derivative periods are explicitly excluded from full-source compatibility evidence.
- Fresh native first review **PASS**; root verification **PASS**; correction stage unused. Cycle `o29-complete-quote-reserve-path-20261029` is closed.

Snapshot `14938b9d-22de-4c6d-8f7a-4e1111889ee5`, cutoff `2026-10-29T16:10:13.882Z`, hash `1638e0aabb5613cbf3886c46c3d2f159890eb685bb6c5ae9b67d0d522d96444d`. The later analysis cutoff does not change the historical observation window.

Replay:

```sh
node dist/src/cli.js replay 14938b9d-22de-4c6d-8f7a-4e1111889ee5 \
  --db .data/all-unknown-20261029/o29-implementation/native/live.sqlite --json
```

Repeat analysis with retained sources and the approved profile:

```sh
node --env-file=.env dist/src/cli.js analyze \
  C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump --chain solana \
  --partial --advisory --o28-expanded --o29-reserve-path \
  --o23-bulk-capture .data/all-unknown-20261029/o23-portable-capture \
  --profile .data/cycle2-main-integration-20261026/live/profile.json \
  --db .data/o29-repeat/live.sqlite --json
```

Durable source map: `agentic/architecture.md`. Private acceptance index: `.data/all-unknown-20261029/o29-implementation/acceptance.json`; complete source package remains in `o23-portable-capture/`. The active all-unknown checklist remains in `agentic/analysis.md`. Required specialist: `bridgecode/best-agent.md`; technical handoff uses `writing.md` with factual criteria. No unresolved O29 implementation decision remains.

The cross-snapshot checkpoint ledger contains30 unresolved identities. O24 is next: its canonical account chain is small, while whole-wallet exclusion still needs a complete source-backed proof. Nine newly retained index pages reach creation; indexes alone do not establish that proof.
