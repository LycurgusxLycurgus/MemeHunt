# O23: complete historical fee-payer synchrony

O23 is **KNOWN** for C5's canonical WBTC pool over **2026-10-25 20:00–2026-10-26 08:00 UTC**. The measurement was reconstructed on October29; it does not replace the dates of the historical observations.

The complete index contains89,310 references:57,642 successful and31,668 failed transactions. All57,642 successful receipts are present and decoded, yielding42,846 selected-pool trades in42,836 transactions. Failed transactions contribute no swaps. The remaining14,806 successful receipts are proved to contain no selected-pool trade.

| Transaction-fee role | Trades |
| --- | ---: |
| User pays its own transaction fee | 33,760 |
| Another transaction signer pays the fee | 9,081 |
| Trade user is authorized through program execution | 5 |

These are account and transaction roles. A shared fee payer does not establish a shared person, incoming capital, common control or coordination.

| Slot-bin width | Offset | Synchronized trades |
| ---: | ---: | ---: |
| 1 | 0 | 396 |
| 10 | 0 | 2,633 |
| 10 | 5 | 2,620 |
| 150 | 0 | 8,448 |
| 150 | 75 | 8,424 |

Each count uses all42,846 trades as its denominator. All999 declared within-hour null permutations had at least the observed count in each bin. This is a descriptive comparison under that null model; the method makes no coordination determination.

## Implementation and source scope

`--advisory --o28-expanded --o23-bulk-capture DIRECTORY` selects proof52/facts51/policy49. The import contains exact provider responses, requests, hashes and original retrieval clocks. It is marked `USER_IMPORT` and `RETAINED_PROVIDER_RPC_IMPORT`: retained bytes are verified, while provider transport and deployed program binaries are not independently authenticated by the import.

The227 source records comprise90 complete index pages,117 full bulk pages,16 compiled companion receipts and four identity/anchor/final-state receipts. Source bodies total2.18GB; stored proof wrappers occupy418MB. Reconstruction inflates one bounded page at a time. The separate512MiB stored/3GB source limits apply only to this validated namespace; ordinary fetch and storage budgets stay unchanged.

Program event time and RPC index time remain separate. The index fixes the original cohort and permutation hours, including five events crossing an hour seam. Existing exact fee reconciliation and guarded compiled runtime proof resolve the remaining residual cases. Only count, side, user and fee-role witnesses leave this new decoder. Existing financial decoder outputs, A30 thresholds and entry authority are unchanged.

## Validation

- Build,42 focused tests and the full suite:2,230 passed, zero failures, one existing optional skip.
- Independent raw-source oracle matches every selected event count, user/fee role, seed, sponsor summary and999-permutation statistic.
- All57,642 default financial decoder proofs and errors match the accepted preceding runtime exactly.
- Actual CLI analysis, source reconstruction, persistence, full-source idempotence, reopening and OS-network-denied CLI replay pass.
- Three actual tokens checked: new complete C5 measurement plus dated Parasite/ClaudeCoin controls. Their missing O23 values remain missing; these are not three new positive measurements. Five frozen historical snapshots replay unchanged.
- Fresh native first review **PASS**, root verification **PASS**, correction stage unused. Cycle `o23-complete-quote-tape-20261029` is closed.

Snapshot: `277f2ad1-cb88-4b7d-a682-602fec1fa853`, analysis cutoff `2026-10-29T15:24:02.293Z`, hash `22c94526328bb81c9252d7a77416c857d24b39bcf055a5fc88a3dde994769c50`.

Private source package: `.data/all-unknown-20261029/o23-portable-capture/`. Acceptance and reproducibility index: `.data/all-unknown-20261029/o23-implementation/acceptance.json`. These receipts are retained in this workspace and are not committed as repository fixtures.

To replay the accepted snapshot without network access:

```sh
node dist/src/cli.js replay 277f2ad1-cb88-4b7d-a682-602fec1fa853 \
  --db .data/all-unknown-20261029/o23-implementation/native/live.sqlite --json
```

To repeat analysis with the retained portable capture and the existing approved profile:

```sh
node --env-file=.env dist/src/cli.js analyze \
  C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump --chain solana \
  --partial --advisory --o28-expanded \
  --o23-bulk-capture .data/all-unknown-20261029/o23-portable-capture \
  --profile .data/cycle2-main-integration-20261026/live/profile.json \
  --db .data/o23-repeat/live.sqlite --json
```

This completes the scoped O23 measurement. The cross-snapshot checkpoint ledger still contains31 unresolved metric identities.
