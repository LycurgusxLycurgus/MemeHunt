# C5 executable sell capacity

For `C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump` (Big Titty Coin/BTC), the accepted snapshot at **2026-10-26 15:31:41.782 UTC (16:31:41.782 CET)** reports **$7,161.24 of net quoted sell proceeds within 3% fee-inclusive average price impact**, across the measured direct cash routes. The actual output is **70.168339863 WSOL**, requiring **1,019,139.433912 tokens** at the independently optimized route inputs. Each route uses its own pretrade onchain price as the reference. This is a dated depth measurement; fresh analysis must collect new state.

The reference value of all observed output vault balances is **$371,170.30**. Those balances include fees, dust and liquidity unavailable within this price-impact limit, so they are separate backing context. Market capitalization is also distinct. Increasing the allowed impact would define a different capacity; the present result preserves the approved300bps limit.

## Scope and evidence

Six finalized discovery frames cover both mint orientations of the pinned PumpSwap, Meteora DLMM and DAMM v2 prefixes. They return56unique pools:17cash routes and39other-asset conversions retained with explicit exclusions. Cash outputs are exact WSOL, USDC, USDT and Wormhole WBTC mint addresses. The fresh set defines scope;17 is not hardcoded.

All17cash routes are KNOWN at this cutoff:1PumpSwap,7DLMM and9DAMM. Three DLMM routes and one DAMM route contribute positive capacity. The remaining routes have proved zero within300bps. In particular the canonical WBTC Pump route's325bps trading-fee floor already exceeds the limit. No failed read counts as an empty route set: four retained discovery RPCerrors precede successful frames.

All math uses the same finalized85account bank at slot461715741, with decoded Clock.slot equal to that response context. Exact per-asset rational amounts use the actual output-asset provider USD reference; there is no stablecoin peg assumption. Mutable route states are disjoint and the summed hypothetical input domain is unbinding. These conditions permit the finite direct-route sum.

Snapshot: `bbdb7f8e-53ac-4fb1-8a0f-6c1d76fb103c`; hash `ab3d1a6f92ef06af297542b3a495dbe0fb1b762f2270007023fe55e450633fcd`. State freshness expired at2026-10-26T15:32:11.000Z; replay proves the original observation, never renews its market validity. Entry remains **REJECTED**, with OWN-02 concentration and SEC-03 upgradeability checks still failing. This descriptive indicator does not relax entry policy or silently close A12/O10–O16.

## Meaning and limits

`executable-sell-capacity-v1` maximizes net trading output within fee-inclusive average impact relative to each route's own starting price. It records the minimum input attaining the maximum and maximum admissible input separately; integer fee rounding can make admissibility nonmonotone. It does not sum token atoms of different quote mints.

Proof level is **QUOTED**, with no signing, broadcast or simulation. It does not establish a wallet's holdings, all-program recall, a global common-price or multihop optimum, guaranteed fills, future liquidity or fiat redemption. Network fees, rent, setup, priority, unwrap and redemption costs remain unmodeled. Positive/reverse Pump cases without the supported fee-floor proof remain explicitly unsupported and block a primary-known aggregate when present.

## Run and replay

With the configured Helius RPC, first copy the existing approved configuration to the chosen separate config path, then collect into a new database:

```sh
npm run cli -- analyze C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump \
  --chain solana --partial --executable-liquidity \
  --db /absolute/path/to/new-capacity.sqlite \
  --config /absolute/path/to/approved-config-copy.json --json
```

This version fixes the sell-capacity limit at300bps independently of the entry profile. `SOLANA_RPC_URL` selects base RPC; configure Helius rather than relying on an API-key variable alone. Secrets stay in environment/local ignored configuration and never in saved proof. `--executable-liquidity` is live-Solana-only and independent of `--advisory`. Omission or explicit false preserves ordinary behavior.

A saved snapshot can be shown/replayed with `node dist/src/cli.js show SNAPSHOT_ID --db PATH --json` and `node dist/src/cli.js replay SNAPSHOT_ID --db PATH --json` after building. Select the snapshot's own copied database/artifacts. Acceptance used actual working-checkout CLI commands in a PATH-only environment under OS-level network denial, with byte-identical output.

## Maintained files and validation

- `src/domain/executable-liquidity.ts`: report, plan, bank, unit and outcome contracts.
- `src/providers/executable-liquidity.ts`: fresh acquisition, Pump binding/fee-floor proof, exact aggregation, raw reconstruction and validation.
- `src/providers/executable-liquidity-{dlmm,damm}.ts`: current venue admission, quote loops and maximum certificates.
- `src/app/{live,service,report}.ts`, `src/cli.ts`, `src/domain/contracts.ts`: opt-in, independently validated persistence and reporting.
- `tests/executable-liquidity{,-integration,-dlmm,-damm}.test.ts` and three fixtures: raw admission, exact independent oracles, SDK parity, boundaries, persistence and legacy protection.

Pinned dependency added: `@meteora-ag/dlmm@1.9.14`; existing locked versions/integrities preserved. Build plus the full corrected suite passed **2,138tests, zero failures, one existing optional skip**. The copied test tree and disposable CWD avoid existing memory-Service fixtures writing operator artifacts. The current capture passed55production checks+6assertions and397independent raw/arithmetic checks. Latest-bank DLMM parity:71SDK quotes,4,558bin checks,19arrays,30witnesses, zero differences. DAMM:9routes,21witnesses,144SDK cases; exhaustive independent Ca oracle through input14,652 plus an above-bound proof gives985lamports max net,13,968minimum input and13,981maximum admissible input.

Seven copied historical cases (A24proof38,A29proof39,O08venue,executor43–45,A29proof40) pass raw reconstruction, Service save/reopen and actual offline CLI replay;525original historical files and all1093protected operator paths remain unchanged. Ordinaryproof40/facts39/policy37, exact40A29recovery, frozen39/41–46 and `advisoryPool` are preserved.

Cycle `exec-liq-C5-2026-10-26`: first native review FIX for Clock/bank-slot admission, one coherent actual-Claude-authored correction; terminal native review PASS and root verification PASS, cycle CLOSED with no further implementation review. The correction keeps globalClock injection in core and Clock-free perroute plans; direct Pump quote/solve also require the matching raw Sysvar Clock before any zero result. Actual Claude Code performed heavy contract/math/code/test authorship; Codex performed internet/Helius acquisition and local execution/validation.

Private evidence index (excluded from Git): `.data/executable-liquidity-C5-2026-10-26/sell-capacity/` contains `frozen-contract-v2.json`, `review/evidence-terminal-review.json`, corrected source/runtime/publication pins, first/terminal verdicts, `regression-block-correction-v1/`, `acceptance/live-corrected-v1/`, corrected SDK diagnostics, historical replay and operator-preservation receipts. No credentials or private raw populations belong in Git. The durable map is `agentic/architecture.md`; required process specialists are `bridgecode/best-agent.md` and `bridgecode/writing.md` (Taste loaded for factual claim boundaries). No unresolved user-owned decision remains within the accepted finite metric.
