# A29 resolved for C5 / WBTC

A29 is **KNOWN**, with all five components resolved for `C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump`. The rerun uses the original capture, fixed top-five cohort and 602-second interval: **2026-10-25 22:05:50–22:15:52 UTC**, slots461420492–461423335. It is imported historical evidence, not a new A29 observation.

The original19 measured-window gaps are resolved. The complete audit found60 required gaps across warmup, baseline and measured windows; all60 now resolve. All2523 transactions decode into2477 swaps, including772 measured swaps with unambiguous account-owner bindings. Four additional selected events are fee sweeps, not swaps.

| Component | Observed result |
|---|---|
| Fixed-cohort selected-pool selling | Net318,862.492675 base tokens sold across114 cohort trades. Sells591,554.438260; buys272,691.945585. |
| Pool-mid price in WBTC | −11.260865%. |
| New qualifying buyer addresses | Baseline124 → measured118: −6, or −4.838710%. |
| Quoted exit capacity within300bps | 0WBTC at both endpoints; modelled fees total325bps. The ratio is undefined because baseline capacity is zero. |
| Concentration | Largest owner's raw supply share57.795136% →57.798746%; top-five raw share69.976220% →70.091396%. |

The window shows a price decline alongside fewer new qualifying buyers. A29 supplies the measurements; it does not classify absorption, predict prices or approve an entry. Buyer addresses are not people. The fixed meaningful-purchase threshold remains1266WBTC atomic units (0.00001266WBTC), equivalent to0.01SOL at the frozen E0 marginal exchange rate, before fees.

Cohort selling uses actual pool trades and account owners. Cohort inventory separately fell13,104.403324 tokens; its305,758.089351-token reconciliation residual is retained without assigning a cause. Inventory change alone is not the selling measurement.

## Implementation and compatibility

Fresh proof40/facts39/advisory-policy37 enables the new recovery profile. The shared runtime proof binds the recorded instruction tree and log prefix, distinguishes ordinary SBF execution from native-host uncertainty, and rejects contradictory failure traces. Recovery consumes canonical swap/event witnesses before classifying the unconsumed foreign remainder. Three exact-in buys retain their one-atomic unspent budget remainder, backed by exact typed token debits. Ownership permits a proven terminal close after the trade leg.

Saved proof39 and earlier retain their original behavior. The prior C5 proof39 snapshot remains MISSING and replays byte-identically. The original source capture SHA256 remains `bf547474d74e6c18201239b7289acc568518bcb5fcf1aede40281ddd662e31fe`.

Build/typecheck,1931 tests (zero failures, one existing skip),38 focused tests and seven independent oracle tests pass. The independently authored raw oracle matches all2523 transaction results and all five saved components across46 value checks. Historical proofs25–39 and O08 preserve accepted outputs;1167 operator paths and422 historical inputs remain unchanged. Actual CLI save/reopen,72 raw hashes, raw reconstruction, two idempotent revalidations and keyless offline CLI replay pass.

Snapshot `ff8142f6-7803-4408-ab29-6bb9e7fac3b9`, saved cutoff2026-10-26T09:21:44.552Z, imports the historical window above. Three fresh actual Claude Code Opus5.5 contexts performed intensive authorship and independent arithmetic. Fresh native first review PASS; root verification PASS; correction stage unused, cycle `a29-trace-gaps-2026-10-26`.

The reviewed implementation is isolated on `codex/a29-trace-gaps`, based on accepted9428d31, to preserve another chat's pending main-source review. It has not been published. Private evidence and failed attempts remain in the original workspace under `.data/a29-trace-gaps-2026-10-26/`; `a29-result.json` and `acceptance/acceptance-summary.json` index the result. No raw holder populations or credentials are committed.

Standard validation from this worktree: `npm ci`, `npm run typecheck`, `npm test`.
