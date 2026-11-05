# Check creator position performance with a contract address

## Closed-position S15 v2 is KNOWN, October 23

Latest isolated snapshot **7e17663b-9df2-482c-a2c6-4244d60fe460**, cutoff **2026-10-23T17:37:00.074Z**, is **KNOWN / S15V2_CLOSED_EPISODE_OBSERVED** under proof32 / facts31 / policy29. It covers the same nxPq target and S13 creation signer, with all **7,327 creator references inspected** (6,656 successful and 671 failed). Every failed row is after the closed episode; the 0.013686838 SOL creator-paid failed-fee census remains unallocated outside it.

The executed SOL-to-quote acquisition immediately precedes the target buy in the same block. Its 9.67 SOL bought 4.931006 quote units; the target consumed 2.040452 of those units. The declared single-lot unit-cost policy gives:

| Closed target position | SOL |
|---|---:|
| Allocated executed purchase basis | 4.001449367533 |
| Gross sell proceeds, excluding returned rent | 7.571226605 |
| Principal result before separately reported costs | +3.569777237467 |

The exact fractions in `S15.data.closedTargetEpisode` are authoritative. Network/native payments, deposits/refunds, incoming funding and outside-episode failed fees are reported separately. **This is a closed-position principal result before those costs, not all-in net or lifetime profit.** Funding from other wallets is not deducted from the purchase basis. The old October20 snapshot remains MISSING under its original definition.

Replay the accepted result offline:

```sh
node dist/src/cli.js replay 7e17663b-9df2-482c-a2c6-4244d60fe460 --db .data/s15-completion-2026-10-23/live-v2-acceptance/live.sqlite --config .data/s15-completion-2026-10-23/live-v2-acceptance/config.json --json
```

Raw hashes, reconstruction, save/reopen, idempotence and CLI replay agree; fresh native review and root verification PASS. Original operator files are unchanged. Evidence: `.data/s15-completion-2026-10-23/{acceptance.json,validation-v2.json,report.md}`. Missing evidence, unsupported routes, another lot, held tokens, reopening or in-episode failures leave v2 unresolved.

## Helius routes integrated, October 20

October20 isolated capture: **60294baf-f99c-46fe-ac3a-115507375124**, cutoff **2026-10-20T11:19:37.113Z**, for `nxPqZ4F7ux8Vph5NFu25rEP6Kx9Gr1U6Fmj36Rjpump`. Production proof31 / facts30 / policy28 retains all seven finalized Helius Parsed Events responses alongside the original RPC evidence. `S15.data.nativeRouteAccounting.routeCoverageComplete` is **true**: the buy, five sells and zero-account close reconcile all 373 native-account instances and 95 token-account instances. Complete creator source/exclusion/payer census is still required for that flag. Missing packets and unsupported route forms leave it false.

| Verified flow | Native amount |
|---|---:|
| Pump buy debit, including embedded fees | 2.040452 quote units |
| Extra buy quote payments, unallocated | 2.890554 quote units |
| Five sell routes, gross SOL settled | 7.571226605 SOL |
| Sell wallet increase after outgoing native payments and direct network fees | 7.467311275 SOL |
| Temporary WSOL funding, fully returned | 0.007442200 SOL each way |
| Direct network fees across six trades | 0.000535 SOL |
| Full creator failed-fee census, unallocated | 0.009500148 SOL |

Quote mint: `TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo` (six decimals). Each sell follows target → quote → USDC → WSOL → SOL. Exact raw Raydium CLMM `swap_v2` layout, pool/account roles, linked amounts, executed transfer children and all account balances must agree. Helius summaries are not used as wallet profit. The original buy log remains truncated; the existing committed-transfer witness proves its selected transfers without inventing runtime logs.

`unallocatedCosts` keeps extra quote payments, direct native payments, funding/shared refunds and creator failed-fee evidence separate. **Sell wallet net already deducts the observed sell payments and network fees; do not subtract those payments again.** It is a cashflow, not target profit. The batch close refunds 0.001513840 SOL for the target account and 0.019771360 SOL for shared/other accounts. The creator pays 0.000285499 SOL to the batch fee payer; that other account pays the transaction's 0.000051826 SOL network fee. Refunds are not sale proceeds; the network fee is not charged to the creator twice. Holder rewards remain an included fee subset.

**S15 remains MISSING / S15_NATIVE_LEDGER_COMPLETE_UNALLOCATED_COSTS**, with `completeCreatorPerformance:false`, `realizedProfit:null` and historical conversion null. Route acquisition and settlement are resolved for this capture. Full all-in target profit still needs defensible allocation of the extra/shared costs and verified historical conversion for a combined denomination. This release supports the observed Pump custom-quote/Raydium CLMM/WSOL route family; other Solana venues can remain unsupported.

Replay the saved result without API requests:

```sh
node dist/src/cli.js replay 60294baf-f99c-46fe-ac3a-115507375124 --db .data/s15-helius-integration-2026-10-20/live-initial/live.sqlite --config .data/s15-helius-integration-2026-10-20/live-initial/config.json --json
```

For a fresh joint check, use **Run it together** below and a new isolated directory. Configure `HELIUS_API_KEY` privately in `.env`; the CLI passes it only for advisory collection. No key leaves the authenticated request URL or enters retained request metadata. Without the key, `creatorRoutes` and `nativeRouteAccounting` are null; this is not a known zero. Inspect the route flags, per-row settlement/funding/refunds, separate unallocated costs, creator coverage and S15 quality/reason. Free-plan Parsed Events uses ten credits per request, with a maximum here of64 requests,500KB/body and6MB total; seven successful requests cost70 documented credits, excluding transport retries and other RPC sources. [Helius Parsed Events](https://www.helius.dev/docs/parsed-events/quickstart), [credit documentation](https://www.helius.dev/docs/billing/credits).

Typecheck/build and **1,181 tests pass**. All4,617raw hashes, raw reconstruction and Service/CLI replay agree; accepted actual proofs25–30 reconstruct/replay identically. Default logical/physical database, WAL/SHM, configuration and all925artifacts are unchanged. Fresh native Bridgecode first review **PASS**, root verification **PASS**, correction unused; cycle closed. Evidence: `.data/s15-helius-integration-2026-10-20/{acceptance.json,report.md,reconstruction-validation.json}`. Earlier results retain their original interpretation.

## Earlier buy and creator-coverage audit, October 20

For `nxPqZ4F7ux8Vph5NFu25rEP6Kx9Gr1U6Fmj36Rjpump`, snapshot `b010b1ff-8bc8-4d0f-b36c-c46633518857` at `2026-10-20T08:27:04.376Z` verifies the original truncated buy and all five sells from untouched public receipts. The seven canonical references form a continuous balance chain from zero through acquisition/disposal to a proved zero-account close. The distinct buy basis is `POSITIVE_COMMITTED_TRANSFER_BALANCES_WITH_BOUND_TRUNCATED_TRACE`; no replacement runtime logs are generated.

The fresh complete primary creator index has **4,505 references: 4,206 successful and 299 failed**. Every receipt is retained and inspected. `creatorCoverage.sourceComplete`, `wholeWalletComplete` (target-account exclusion), and `failedFees.payerCensusComplete` are true; no other nonzero current target account or unresolved successful-account touch remains. Of299 failures,211 were paid by other accounts and88 were creator-paid with target association unproved. The whole unallocated creator fee census is **9,500,148 lamports (0.009500148 SOL)**; `targetAssociatedChargedLamports` remains null. These fees are not assigned to this token's profit.

**S13 is KNOWN; S15 is MISSING / S15_NATIVE_ECONOMICS_UNRESOLVED; entry is REJECTED.** The named buy and acquisition gaps are resolved. Final route settlement/economic attribution remains unproved. The Pump buy leg debits2.040452quote units while the whole buy transaction debits4.931006quote units. Five sell legs receive3.880224quote units and immediately route them onward. The quote mint is `TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo`, six decimals. Holder fees0.017837quote units are already included across the six trades; direct trade network fees535,000lamports are separate. Neither `entryAtomic`/`proceedsAtomic` nor their difference is certified final profit. `realizedResultAtomic`, `solConversion` and `completeCreatorPerformance` remain null/null/false.

Proof30 / facts29 / policy27 adds the native execution witness, canonical continuity and complete creator census. The census allows8192successful/512failed references,16pages,500KBresponses and32MB archived source; trusted populated proof30 alone admits64MB raw artifacts,8MB details and8724coverage records alongside the existing ordinary1000. Missing/capped/invalid evidence still blocks completion. Older proofs25–29 retain their original interpretation. The existing full SOL-position S15 gate is unchanged.

This capture revalidates the previously recorded signed birth-role packet with its original receipt clocks. Exact immutable transaction responses are reused from primary and separately mainnet-checked secondary RPC; **mutable primary head/catalog/index are freshly fetched**. The secondary's recent-only address index is never used for completeness. The accepted source premise remains provider index/attempted-trace completeness, not a cryptographic archive attestation. No prior snapshot was modified.

Replay this exact result offline, using the isolated database:

```sh
node dist/src/cli.js replay b010b1ff-8bc8-4d0f-b36c-c46633518857 --db .data/s15-buy-creator-coverage-2026-10-19/audited-final-acceptance/live.sqlite --config .data/s15-buy-creator-coverage-2026-10-19/audited-final-acceptance/config.json --json
```

For a fresh address, use **Run it together** below with a new output directory. Inspect `S15.data.nativeQuoteAccounting.coverage`, `canonicalContinuity`, `creatorCoverage`, its `failedFees` subreport, and the final S15 quality/reason pair. A complete payer census can coexist with incomplete target fee attribution. The native canonical subreport deliberately retains its own canonical-only scope flags; the creator-wide exclusion proof lives in the separate `creatorCoverage` object.

Typecheck/build and **1,163 tests pass**. Actual hashes, raw reconstruction, saved Service/CLI replay and default isolation evidence are in `.data/s15-buy-creator-coverage-2026-10-19/`. Bridgecode first review returned FIX for an incorrect economics-only reason after a failed canonical index. The correction requires complete canonical index and continuity; its production regression passes. Fresh terminal review and root verification returned PASS; the cycle is closed with its single correction stage used. Test/review success validates these changes; numeric S15 performance remains unresolved.

**Earlier isolation correction, October 19:** the CLI test helper now isolates omitted database/config flags, every creator-history test uses explicit temporary paths, and a sandbox regression catches the original bug. The two fixture snapshots have been removed from the default database with a recoverable backup; both original snapshots, all other table rows, schema and immutable guards are preserved. Typecheck and all 1,115 tests pass; fresh independent Bridgecode review returned PASS with no correction stage. The full suite left the default database, configuration and all 925 artifacts unchanged.

The complete SOL-position S15 contract describes the publicly signed token creator's fully disposed position in the target token, priced in SOL. It reports buy cost, sale proceeds, embedded trade fees, direct network fees and account funding separately. It does not estimate the creator's whole wallet profit or identify a person.

The October 13 reference run had a complete creator position and 140 failed transaction references, but collection stopped at 130. Fresh proof v25 allows up to 256 failed receipts. It still requires every indexed receipt and keeps the existing two concurrent reads, 500 KB response limit, 1 MB stored failed-receipt limit and 24 MB overall artifact limit. Older proofs keep their 130 limit and saved results.

## Earlier native-asset accounting, October 19

The preceding proof29 audited capture: snapshot `17775e88-2a45-478d-875d-804b41f1f616`, cutoff `2026-10-19T16:08:49.991Z`, in `.data/custom-quote-holder-reward-s15-2026-10-19/live-final/`. All seven canonical references were acquired: five verified sells, one unresolved buy and an executed zero-account close. Five sells give 3.880224 intermediate quote units, 0.011791 included holder-fee units and 525,000 lamports of verified direct trade network fees. Every quote receipt is routed onward; no final proceeds or profit is inferred. The buy remains `ADVISORY_ACCOUNTS_LOG_INCOMPLETE`. S15 is `MISSING / S15_NATIVE_ACCOUNTING_EXECUTION_INCOMPLETE`, entry `REJECTED`; complete creator-account and failed-fee coverage remain false. The first capture's transient RPC 429 recovered in this separate unchanged-code retry; neither snapshot was modified.

All 113 raw hashes, exact raw reconstruction, Service replay and CLI JSON replay pass for each new capture. Historical proofs 25–28 also reconstruct/replay identically. Final default DB/schema/rows/WAL/SHM/config/all 925 artifact fingerprints are unchanged. First review PASS and root acceptance PASS close this implementation cycle, correction unused. These outcomes validate native ledger support; complete audited S15 and universal Solana accounting remain unresolved.

For the retained latest result:

```sh
node dist/src/cli.js replay 17775e88-2a45-478d-875d-804b41f1f616 --db .data/custom-quote-holder-reward-s15-2026-10-19/live-final/live.sqlite --config .data/custom-quote-holder-reward-s15-2026-10-19/live-final/config.json --json
```

Fresh proof29 / facts28 / policy26 adds `S15.data.nativeQuoteAccounting` for verified creator canonical-account MainPump v2 custom-quote trades. This follows the selected native-asset ledger contract: quote amounts keep their mint and decimals; SOL network fees remain separate. `solConversion` stays null without verified historical prices. The existing complete SOL-position S15 contract remains available on its supported path.

Each accepted trade binds its successful runtime frame, event and instruction, account/PDA/token-program roles, exact base/quote transfer legs and metadata balance changes. Holder rewards equal the already-included creator fee: count them once as trader cost. They are not signed-creator income or proof of received holder distributions. Accrued unclaimed fees are separate state.

**Interpret the ledger before using any amount.** `assets[].entryAtomic` and `proceedsAtomic` sum only verified records; `totalsBasis` is `VERIFIED_RECORDS_ONLY_NOT_COMPLETE_POSITION`. Zero verified buys and `entryAtomic: "0"` do not establish zero entry cost. Routed quote receipts have `proceedsBasis: PUMP_LEG_QUOTE_BEFORE_OTHER_ROUTE_LEGS`; inspect `transactionNetAtomic` and `routedFlowsOutsideTrade`. These intermediate receipts are not final proceeds or realized profit. `realizedResultAtomic` remains null.

The canonical source allows one exhausted 1,000-reference index and up to 64 successful receipts, two reads in flight, 500KB per response and 6 MB stored bodies, within the existing 600-second/24 MB run limits. Index, source or runtime gaps remain explicit. A closed zero account requires its executed owner-bound close receipt. This source does not establish historical other creator accounts or complete failed-network-fee coverage; `completeCreatorPerformance`, `wholeWalletComplete` and `failedNetworkFeesComplete` remain false. It cannot alone promote S15 to KNOWN.

Portable actual receipts verify five sells disposing 123,909,950.351188 target tokens. Their intermediate Pump legs receive 3.880224 units of `TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo` (six decimals), immediately routed onward. Holder fees of 0.011791 quote units are already included. The initial buy's runtime logs truncate before the trade closes, so its executed cost remains unverified. A constructed complete-runtime variant is a positive codec test only; it does not repair that real receipt.

Typecheck/build and all **1,144 tests passed**; fresh native independent first review returned **PASS**, correction unused. Historical proofs 25–28 reconstruct and replay identically. Default database/configuration/all 925 artifacts are protected by exact before/after fingerprints. Live capture and replay evidence is in `.data/custom-quote-holder-reward-s15-2026-10-19/`; software validation does not certify complete creator performance or universal audited Solana coverage.

## Creation verification and tape acquisition, October 19

The preceding proof28 isolated audited run is snapshot `e915ba77-a3ae-4500-bc2f-179630a1f4ba`, cutoff `2026-10-19T15:30:28.879Z`, in `.data/audited-s15-creation-tape-2026-10-19/live-final/`. **S13 is now KNOWN; S15 remains MISSING.**

Proof28 / facts27 / policy25 verifies the complete successful creation frame before later log truncation, optional quote accounts and holder-reward flags. The signed creation wallet is `FFdBLYqL9rs5fUT38ArE8GV2L3BziEgG5LJUu6sshfkF`. The holder-reward event fee recipient is a separate verified PDA; it is not attributed to that wallet. A positive unique, non-closeable mint initialization no longer depends on classifying unrelated retained transactions as non-creations. Missing candidates and contradictions still block verification. Older proofs retain their original interpretation.

The selected-hour collector now follows at most 16 cursor-linked 1,000-row pages, with 1,024 successful transaction reads, two concurrent downloads, 500 KB response and 8 MB stored namespace limits, under the existing 600-second/24 MB overall ceilings. Every selected transaction must decode for complete flow. A verified pool quote check runs before transaction admission; unsupported quotes are reported without downloading unsupported trade receipts.

For this address, **8,000 references reach the older witness; the selected-hour index is complete**, containing 1,943 successful references. The pool is quoted in `TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo`, so O28 reports `ADVISORY_WINDOW_QUOTE_UNSUPPORTED`. No complete decoded trade tape, A30, O24, O25 or numeric S15 is certified. Even a supported quote with 1,943 references would exceed the 1,024 transaction bound. Supporting this token's economic position requires custom-quote/venue accounting, historical valuation and holder-reward/transfer reconciliation; simply increasing caps cannot establish SOL profit.

Typecheck/build and all **1,136 tests passed**; independent Bridgecode first review and root verification returned **PASS**, with no correction stage. Default DB/config/all 925 artifacts remained unchanged. All 96 evidence hashes, exact raw reconstruction and saved replay passed; historical proofs25–27 reconstruct identically. The result report and runnable validation script are in `.data/audited-s15-creation-tape-2026-10-19/`. Use the existing isolated command below for another capture. For this retained result:

```sh
node dist/src/cli.js replay e915ba77-a3ae-4500-bc2f-179630a1f4ba --db .data/audited-s15-creation-tape-2026-10-19/live-final/live.sqlite --config .data/audited-s15-creation-tape-2026-10-19/live-final/config.json --json
```

## Creator-history pagination correction, October 19

Typecheck/build and all **1,123 tests passed**; fresh independent Bridgecode first review returned **PASS**, with no correction stage. Current and prior saved replay/raw reconstruction passed. The default database, configuration and all 925 artifacts remained unchanged.

Fresh proof v26 / facts v25 / policy v23 follows up to **16 cursor-linked index pages**, each with at most 1,000 rows. The page lookup and eight candidate transactions bring the maximum creator namespace to 25 receipts. Creator receipts stay within six MB; shared 150-request admission, the 600-second deadline and 24 MB overall artifact ceiling remain. Replay verifies each page request/cursor, receipt clock, signature uniqueness and descending slot/time order. A full capped chain, repeated/invalid pages or missing receipts remains unresolved. Proofs through v25 keep their single-page interpretation and saved snapshots.

The fresh check for `nxPqZ4F7ux8Vph5NFu25rEP6Kx9Gr1U6Fmj36Rjpump` followed four pages / 4,000 rows and reached the October 11 creation-discovery window. It found **nine successful candidates**, exceeding the unchanged eight-candidate limit: S13's diagnostic is `TRUNCATED / CREATOR_CANDIDATES_OVER_CAP`; S13, O24, O25 and S15 remain `MISSING`. No signed creator, position performance or failed-fee total is established. A30's complete demand tape is also unavailable in this capture. This is a successful pagination check with an unresolved S15 evidence result.

Snapshot `72588a7f-c677-477a-845d-397c07d0c792`, cutoff `2026-10-19T07:15:23.507Z`, is retained in `.data/creator-pagination-2026-10-19/live/`; validation/report: `.data/creator-pagination-2026-10-19/live-report.json`. Candidate-cap changes or narrower, independently justified candidate discovery require an explicit acceptance change and new evidence; retrying unchanged will not remove this cap.

## Broader Solana creator-position lookup

For a venue-independent **provider-reported** position, use the new database-free lookup. Any valid Solana mint can be queried; a numeric answer is subject to the provider's coverage. Configure `SOLANA_TRACKER_API_KEY` privately in the existing environment or `.env`. No Gemini, TinyFish, database, configuration write, signing or broadcast is used by these two commands.

```sh
npm run build
mkdir -p .data/creator-position-check
node dist/src/cli.js creator-position YOUR_SOLANA_MINT --json > .data/creator-position-check/position.json
node dist/src/cli.js creator-position-replay --file .data/creator-position-check/position.json --json > .data/creator-position-check/replay.json
```

Use a new output directory for each capture. The packet contains two exact bounded source receipts, request URLs, completion clocks, source hashes and the derived report. Offline replay verifies those retained bytes and recomputes the report; hashes are integrity checks, not provider signatures or independent chain verification.

`report.reported` contains **USD** values from Solana Tracker's strict position view. `creator.binding` is a provider claim and `verifiedOnChain` is false; `validatedS15` remains null. Fees/account funding remain unestablished. `OBSERVED_PROVIDER_REPORT` means a source report was observed; it never certifies complete S15 performance. `INCOMPLETE_REPORTED_INVENTORY` / `TRANSFER_OR_INDEX_GAP_UNRESOLVED` means reported buys minus sells do not match the reported balance. Transfers or gaps must be reconciled before interpreting the PnL as complete. Missing/invalid data never become zero.

The [provider documents](https://docs.solanatracker.io/guides/pnl-v2/overview) indexed coverage from December 2023 and excludes SOL/stablecoins from positions. Position amounts default to USD; this command does not substitute current FX for historical SOL cost. Coverage is broader than the audited PumpSwap/WSOL path, with different evidence strength. It does not promote S13 or S15.

For `nxPqZ4F7ux8Vph5NFu25rEP6Kx9Gr1U6Fmj36Rjpump`, the new lookup captured a claimed creator position with **$429.44 invested**, **$0 proceeds**, **123,909,950.351188 tokens bought**, **0 recorded sold** and **0 reported balance**. The inventory does not reconcile; the provider's reported zero PnL is not verified creator profit. Exact capture/replay is `.data/creator-candidates-tape-2026-10-19/indexed-live.json` and `indexed-replay.json`.

## Candidate and DEX acquisition correction, October 19

Fresh proof27 / facts26 / policy24 expands complete creator acquisition to **32 candidates**,16 index pages and49 maximum creator receipts. All candidates are required; two concurrent reads,6MB creator storage, shared150 requests,600 seconds and24MB total caps stay. Proof26 retains8 candidates/paginated replay; older proofs retain8/single-page behavior. Creator-history mode can now reuse the existing literal-JSON TinyFish DEX fallback, with its exact request/response/selection evidence and receipt clocks; ordinary partial mode still skips it. Failed recovery cannot retain an unbound empty market summary, and recovered market baseline evidence binds the accepted canonical receipt.

The fresh strict run saved `2e4b45cc-2b6b-4e4a-a029-cfaa22c8511f` at `2026-10-19T15:00:57.511Z`. It collected all9 candidates: one is NON_CREATE, seven have unsupported critical semantics, and the apparent20-account creation has truncated logs. S13creator diagnostic is `CREATOR_CANDIDATE_UNVERIFIED`; the old8-candidate cap is no longer the blocker. DEX discovery found the token's non-WSOL PumpSwap pool. The selected-hour tape exhausted4pages/1024references, all newer than the frozen end, so complete O28/A30 and downstream S15 remain missing. No transaction subset or quote/venue conversion is substituted. Numeric audited S15 for this address and universal audited Solana coverage remain unresolved.

Typecheck/build and all **1,130 tests passed**. Independent Bridgecode first review returned **PASS**, with no correction stage. Both actual outputs replay identically; all90 strict raw hashes verify, old proofs25/26 reconstruct identically, and defaultDB/config/all 925 artifacts stayed unchanged. These checks validate the shipped changes; they do not establish audited S15 for this address. Full tests, replay/default-isolation evidence and review status are retained in `.data/creator-candidates-tape-2026-10-19/`. The broad lookup and strict metric are distinct modes; a reported provider number must not be presented as an independently reconstructed S15 result.

## Run it together

Send the Solana mint address in this chat. Complete SOL-position S15 uses its canonical PumpSwap/WSOL path and signed creator prerequisites. Verified MainPump v2 custom-quote creation can additionally produce the scoped native ledger described above. Other venues and incomplete sources may remain unresolved; neither path guarantees a numeric answer for every mint.

The command below explicitly authorizes the existing bounded TinyFish creator-page lookup and public RPC/DEX reads. TinyFish may consume your account quota. It does not call Gemini. Set `TINYFISH_API_KEY` in the existing local `.env` or environment; keep the key private. `SOLANA_RPC_URL` may select your mainnet RPC endpoint. It must provide the required historical address index: the October 16 probe returned 223 creator references from `https://api.mainnet-beta.solana.com`, while `https://public.rpc.solanavibestation.com` returned only two recent references and could not establish the creation candidate. The command reads public chain state and uses unsigned simulation; it never signs or broadcasts a transaction.

From the repository root, using Node 24 or newer:

```sh
npm run build
mkdir -p .data/s15-check
node dist/src/cli.js analyze YOUR_SOLANA_MINT --chain solana --partial --advisory --creator-history --entry --db .data/s15-check/live.sqlite --config .data/s15-check/config.json --json > .data/s15-check/result.json 2> .data/s15-check/stderr.log
```

The starter configuration is the existing uncalibrated $25/six-hour research profile. The command uses an isolated database and config directory; review any existing `.data/s15-check/config.json` before reusing it. Allow up to thirty minutes in creator-history mode. A command exit code of zero means the assessment was saved; inspect S15's quality to determine whether this measurement resolved. If the command fails, inspect stderr first; an empty output file is not a saved result and cannot be replayed. An overall rejected entry can still contain a known S15.

Inspect the four prerequisite measurements and S15's separate amounts:

```sh
node --input-type=module - <<'JS'
import { readFileSync } from 'node:fs';
const s = JSON.parse(readFileSync('.data/s15-check/result.json', 'utf8'));
console.log({ snapshot: s.id, cutoff: s.cutoff, entry: s.result.classification });
for (const id of ['S13', 'O24', 'O25', 'S15']) {
  const m = s.details.advisory.metrics.find(m => m.id === id);
  console.log(id, m.quality, m.reasonCode);
  if (id === 'S15') console.log(JSON.stringify(m.data, null, 2));
}
JS
```

Copy the snapshot ID from that output and verify saved replay:

```sh
node dist/src/cli.js replay SNAPSHOT_ID --db .data/s15-check/live.sqlite --config .data/s15-check/config.json --json
```

In the joint check we will inspect the supplied mint, four quality/reason pairs, complete failed-receipt coverage, position amounts, separate fees, immutable replay and entry verdict. Share the address and output or snapshot ID; do not paste `.env` or credentials.

## Read the result

| Result | Meaning and next step |
| --- | --- |
| `KNOWN / S15_CREATOR_POSITION_PERFORMANCE_OBSERVED` | The bounded creator-only contract resolved. Inspect `position`, `networkFees`, `accountFunding`, `indexCompleteness` and `failedTransactionsReferencingCreator.coverage`. |
| `S15_NATIVE_ACCOUNTING_EXECUTION_INCOMPLETE` | Inspect `nativeQuoteAccounting.coverage.unresolved`. A receipt, runtime or accounting gap remains; verified-record sums are partial. |
| `S15_COMPLETE_CREATOR_COVERAGE_REQUIRED` | Inspect `creatorCoverage`: source acquisition, target-account exclusion or payer-fee census is incomplete. |
| `S15_NATIVE_ECONOMICS_UNRESOLVED` | Native trades, complete creator target-account coverage and payer-fee census qualify. Final routed proceeds, target fee allocation or other economic inputs remain unproved; no profit is reported. |
| `CREATOR_INDEX_PAGE_CAP` | Sixteen full pages did not reach the discovery window. Retained history is incomplete; no creation claim is made. |
| `CREATOR_CANDIDATES_OVER_CAP` | More than32 successful transactions fall in the current discovery window (older proofs retain8). No candidate subset is accepted. |
| S13 missing | Current public evidence did not establish the original signed creator role. Inspect its retained page/index/transaction diagnostics. More failed-fee reads cannot repair identity evidence. |
| O24 or O25 missing/truncated | Creator inventory, transaction semantics, lifetime history or tape coverage is incomplete. S15 must wait for those prerequisites. |
| `S15_FAILED_INDEX_CAP` | More than 256 failed references in the complete index. This implementation intentionally stops before collecting that set. |
| `S15_FAILED_FEES_INCOMPLETE` | At least one receipt was missing, unavailable or unresolved, or collection reached a storage/deadline/request limit. No partial performance is reported. |
| `S15_HELD_VALUATION_UNSUPPORTED` | Creator still holds target tokens; this implementation has no supported valuation for them. It leaves S15 unresolved. |
| `S15_TARGET_TRANSFER_UNSUPPORTED` | Transfers, mints or burns prevent the supported trade-only performance calculation. |
| `COMMAND_FAILED` with no snapshot | The run did not produce a result. Retain stderr; the generic code does not establish the underlying cause. Do not count it as a successful check. |
| Missing key or mode error | Use the exact flags above and configure `TINYFISH_API_KEY` privately before collection. Ordinary `--partial` does not authorize that lookup. |

## Validation for this change

```sh
npm run typecheck
npm test
```

Regression checks include a real CLI sandbox that protects default DB/config sentinels and catches the old missing-flag helper bug. They also exercise the real O25 receipt fixtures, expanded 140-row collection, complete 256-row fee classification, missing/unavailable/tampered receipts, the unchanged legacy 130 limit, namespace/version admission, CLI authorization and snapshot persistence/replay. Synthetic responses in regression tests establish software behavior; they are separate from the actual public observations below.

On October 16, a newly dated historical reconstruction resolved the reference token's **October 13** retained position and complete **140-row** failed index as S15 `KNOWN`. It reused identical immutable receipts with their original clocks and fetched missing receipts with their actual later clocks. Gross entry cost was **1.7 SOL**, realized sale proceeds **3.049721804 SOL**, and their difference **1.349721804 SOL**; the **0.000837757 SOL** successful network fees remain separate. All 140 failed rows were paid by other accounts, so their direct creator-charged overhead was measured as zero. This is not a replacement for the October 13 snapshot or a current holding statement.

The independent fresh October 16 run saved snapshot `4a86cba4-3082-4520-85bf-ff4a94144fd8`; it left S13 and S15 missing because current creator-role evidence did not qualify. Passing software checks does not guarantee that every supplied address has complete supported evidence.

A second fresh run against the public mainnet endpoint ended near the ten-minute boundary with `COMMAND_FAILED` and saved no snapshot. Its exact cause is not established by sanitized CLI output. Neither fresh attempt establishes a current S15 `KNOWN` result for the reference address. Typecheck/build and all **1,114 tests pass**, and fresh native Bridgecode review returned **PASS**, with no correction stage.

The original October 16 cycle ended UNRESOLVED after root verification found the CLI isolation defect. The user authorized a new correction cycle on October 19. Recovery removed only fixture IDs `27686072-0b57-4382-812f-e77b05d3c844` and `cb669c53-9b18-4fe4-8474-66ee54ca1e17`, after checking their exact hashes and contents against the prior recovery evidence. The transaction restored the original immutable trigger before commit, and both original snapshots replay identically. The database-and-artifact backup is `.data/s15-isolation-recovery-2026-10-19/recovery-before/`; the recovery report and validation evidence are in its parent directory.

S15 was revalidated through the complete production advisory reconstruction: all 140 historical receipts give `KNOWN`; removing one gives `TRUNCATED` with no position result; the older proof version rejects the expanded descriptor. This validates the historical measurement and supported code paths. A fresh result for your supplied mint will be checked using the commands above.
