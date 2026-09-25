# Chains, free-first sources, and feasibility

Original chain/provider research checked on 2026-09-16; round-two retrieval/model/context research checked on 2026-09-24 in [07](07-round-two-lessons-and-contracts.md) and [08](08-technology-decisions.md). This document distinguishes published capabilities from live access. No account was registered, paid API called, RPC probed, SDK installed, or token analyzed in the planning task. Implementation packet P00 must verify access, response shape and practical limits before promising a supported capability.

The user selected **Solana, BSC, Base, and Robinhood first**, configurable size/horizon, and free data/API services before paid upgrades. These are fixed requirements for this plan. Arc and later chains should return explicit capability/partial-support information when recognized.

## 1. Support is a matrix

A chain registry entry is not a promise to analyze every token on that chain. Track these independent capabilities:

| Level | Required evidence | Product behavior |
|---|---|---|
| Recognized | Verified network identity/configuration | Can name the chain; cannot issue a positive DD verdict by recognition alone |
| State-readable | Token identity and supported control/metadata reads | Reports mechanical observations; unavailable remaining pillars stay UNKNOWN |
| Market-readable | Verified venues plus market/holder/trade coverage | Reports scoped market analysis and limitations |
| Quote-supported | Entry/acquired-quantity exit estimates for named venues | Can satisfy the research-screen execution evidence requirement if other checks pass |
| Simulation-supported | Certified read-only sequence with supported state setup | Can satisfy execution-verified policy on those paths |
| History-supported | Time-correct holder/trade/social archives | Enables specified longitudinal features; does not itself establish predictive quality |

Capability manifests are keyed by `(network, token standard, venue version, operation, provider)`, with `SUPPORTED | PARTIAL | UNSUPPORTED | UNVERIFIED`, verified date, evidence, known limits, and expiry/recheck trigger. Query-time errors can degrade a previously supported capability for that run.

## 2. Initial chains and venue targets

| Chain | Identity and baseline | First venue target | Important boundary |
|---|---|---|---|
| Solana | Mainnet verified by registry/genesis; SPL and supported Token-2022 parsing | Pump bonding curve and canonical PumpSwap | Token accounts must be aggregated by owner; custom extensions/unsupported programs remain unresolved |
| BSC | EVM chain 56 | PancakeSwap V2 certified deployment | ERC-20 controls, proxies, taxes and LP ownership; Four.meme/custom launch paths are not implicitly covered |
| Base | EVM chain 8453 | Uniswap V3 certified deployment | Concentrated liquidity positions/ticks differ from V2 reserves; Aerodrome and custom pools need separate adapters |
| Robinhood | EVM chain 4663 | Uniswap V4 documented deployment, initially no-hook or explicitly certified hook paths | First-release priority; V4 PoolKey/pool ID, hooks and fee behavior must be handled explicitly; do not reuse a V3 pool-address assumption |
| Arc | EVM mainnet 5042; testnet 5042002 distinct | No production venue certification in initial scope | Recognized extension; native USDC representation and gas accounting require special handling |

Chain IDs and endpoint metadata should be rechecked at implementation and compared with RPC responses. Public docs establish intended connection details, not endpoint health or token-market liquidity. [BSC endpoints](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/), [Base connection guide](https://docs.base.org/get-started/connect-to-base), [Robinhood connections](https://docs.robinhood.com/chain/connecting/), [Arc connections](https://docs.arc.io/integrate/connect-to-arc)

Robinhood's official ecosystem page lists Uniswap, and Uniswap's V4 deployment reference lists Robinhood chain 4663. This is enough to select a concrete research target, not to assert that all Robinhood tokens are routable. Pin deployment addresses and code evidence during P00; validate actual discovered pools and hooks during P04. [Robinhood ecosystem](https://docs.robinhood.com/chain/), [Uniswap V4 deployments](https://developers.uniswap.org/docs/protocols/v4/deployments)

Arc research illustrates why current pages matter: search excerpts emphasized testnet, while the fetched connection document includes mainnet. The adapter must keep native and ERC-20 USDC representations from being double-counted and preserve their unit conventions. No Arc launch-readiness claim is made here. [Arc connection and balance guidance](https://docs.arc.io/integrate/connect-to-arc)

### Venue certification checklist

For each listed launch venue: verify deployment source, chain ID, factory/program/code identity, token ordering, pool identifier, fee model, liquidity ownership model, quote implementation, supported token mechanics, simulation method/limitations, and at least one positive plus one negative fixture. Pin the source/deployment version. Fetching a pair from a market aggregator alone does not certify the venue.

V4 requires pool identity including currencies, fee, tick spacing, and hooks under its manager; different pools can share one manager address. Only allowlisted hooks with understood execution/control effects can pass the strict supported-venue path. Hookless support does not imply arbitrary hooks are safe. An uncertified hook returns PARTIAL/UNSUPPORTED for the affected checks.

## 3. Free-first provider portfolio

Use a small set of sources with distinct responsibilities. Do not collect everything twice merely because two vendors exist. Fallbacks can improve availability, but correlated upstream providers do not necessarily provide independent corroboration.

| Source | Initial job | Free-first status and limit | What it cannot establish by itself |
|---|---|---|---|
| DEX Screener public API | Market discovery, pairs, reported prices/liquidity, token links, paid visibility | Public endpoints; apply documented per-endpoint limits and current terms | Full holder history, effective ownership, historical state, successful selling, organic reach |
| GeckoTerminal public API | Pool/candle history and market cross-check where covered | Documented free beta, no authentication; FAQ currently states 30 calls/minute | Complete trade/holder history, unbiased competitor universe, venue safety |
| GoPlus Security API | Supplemental token/control risk flags | Support docs currently state free access at 30 calls/minute; test account/chain/endpoint behavior | Exhaustive code audit, complete support for all chains, guaranteed sellability |
| Official public RPCs | Network identity, token state, supported reads and basic simulation | No metered subscription assumed; rate/concurrency/history limits apply | Economical full indexing, complete holders on all tokens, unlimited archive/fork access |
| Blockscout free API where network supported | Explorer metadata, verified source/implementation info, paginated holders/transfers | Free plan documented; per-instance endpoints are being deprecated; use current supported API | Universal chain coverage, complete economic ownership, consistent archive timestamps |
| Curated evidence imports | Social posts, calls, transcripts, external origin evidence | No new provider subscription; requires user/agent-supplied legitimate content and metadata | Global social coverage, authenticated truth from an unverified paste |
| Public websites/RSS and permitted platform feeds | External source verification and bounded narrative evidence | Source-specific access; no general search API assumed free | Comprehensive X/TikTok/Instagram attention or total audience size |
| Local LLM through a structured adapter | Semantic extraction from collected evidence | No hosted token charge; hardware/model/license/quality prerequisites | Free compute, equal quality across models, deterministic fresh generation |
| TinyFish Search/Fetch | First candidate for bounded public source discovery/content | Documented free operations; verify account/limits and benchmark under 08 | Complete platform history; browser/agent operations are separate metered products |
| Parallel Search/Extract | Alternative retrieval candidate if measured need | Current recurring credits; verify product units and prevent overage under 08 | Unlimited free research or exact facts from generated summaries |
| Gemini 3.5 Flash-Lite/high | Preferred primary cited semantic extraction | Documented free tier; enable only after access, public-packet and quality proof under 08 | Deterministic fresh generation, trading authority or unrestricted private-data use |
| DefiLlama and supported macro/launch feeds | C11/C12/C15/C16 context | Endpoint-by-endpoint free feasibility; supplied dashboards are not API proof | Net flows from gross volume; launch volume from fees/revenue; full four-chain coverage |

The public DEX reference exposes token/pair and promotion-related endpoints. Keep market values nullable and paid visibility distinct from organic interest; treat unknown chain aliases and empty responses explicitly. [DEX API reference](https://docs.dexscreener.com/api/reference), [API terms](https://docs.dexscreener.com/api/api-terms-and-conditions)

GeckoTerminal documents public price/volume/liquidity and pool OHLCV endpoints. Its FAQ explains that reported token price follows a selected pool and market cap may be null. Preserve those semantics rather than renaming FDV to market cap. [Introduction](https://apiguide.geckoterminal.com/), [Authentication](https://apiguide.geckoterminal.com/authentication), [FAQ](https://apiguide.geckoterminal.com/faq)

GoPlus is a useful free enrichment candidate; its token-security endpoint and support page do not establish every network/feature combination. Record supported-chain discovery and distinguish omitted flags from false values. [Token security endpoint](https://docs.gopluslabs.io/reference/tokensecurityusingget_1), [Free access and rate limit](https://docs.gopluslabs.io/reference/support)

Blockscout publishes a free PRO API tier and warns of per-instance endpoint deprecation. Avoid building the initial adapter around an endpoint promised to disappear without a migration path. Verify Robinhood coverage under the selected free access method instead of inferring it from the existence of a Blockscout explorer. [Requests and limits](https://docs.blockscout.com/devs/apis/requests-and-limits), [Holder endpoint and deprecation notice](https://docs.blockscout.com/api-reference/get-token-holders)

## 4. Sources to keep optional

**GMGN:** official tooling documents token/wallet/market research and chain-specific enrichment. Use a read-only adapter only if legitimate access works under the selected free allowance. Its demo key is for testing, not a production entitlement; do not make it the backbone of a supposedly free release. Never install its trading workflow just to access labels. Vendor sniper/bundler/smart-wallet labels remain attributed vendor claims. [Official GMGN repository](https://github.com/GMGNAI/gmgn-skills), [Due diligence workflow](https://github.com/GMGNAI/gmgn-skills/blob/main/docs/workflow-token-due-diligence.md)

**X:** exact-contract search is valuable, but free automation is not assumed. Documentation distinguishes seven-day recent search from full archive and lists access conditions. Build imports and the social contract first; enable API search only when the user's actual entitlement and cost policy permit it. Do not replace unavailable access with undocumented scraping or treat zero fetched posts as zero platform activity. [X search documentation](https://docs.x.com/x-api/posts/search/introduction)

**Telegram:** curated public-channel evidence and user-provided exports can support the first iteration. Global `channels.searchPosts` is a user-account method with quota/payment mechanics, not a bot endpoint. The default adapter never spends Stars and never reads private chats without explicit source authorization. A user session is sensitive credential material. Start with imports; authorized live curated ingestion is an optional packet. [Telegram method documentation](https://core.telegram.org/method/channels.searchPosts)

**FOMO:** preserve a future actor-provider capability, but do not depend on an unofficial profile/wallet API for v1. The pre-plan's cited FomoLens page identifies its API as unofficial; access and data consistency would need separate validation. Curated public identity evidence is sufficient to establish the domain contract now. [FomoLens API description](https://fomolens.app/fomo-api)

**Jupiter:** useful for supported Solana route discovery, subject to actual API entitlement. Current legacy Metis documentation says it is superseded by Swap V2. Select a maintained read-only quote/build path during feasibility work and forbid execution endpoints. Direct venue reads/quoters remain available for supported initial venues when aggregator access is not free. [Legacy notice](https://developers.jup.ag/docs/swap/v1/get-quote), [Current Swap documentation](https://developers.jup.ag/docs/swap)

**Hosted LLMs:** revision 0.2 selects Gemini 3.5 Flash-Lite/high as preferred primary extraction after its free entitlement and quality are verified; [08](08-technology-decisions.md) defines activation and privacy/cost handling. Import remains the explicit bootstrap/offline path. A chat subscription does not grant API access. Local Ollama is an optional separately selected adapter, not an installation requirement. [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs)

## 5. Free-first collection plan

For a single resolved token, baseline collection should be bounded approximately as follows. These are proposed application ceilings, not provider entitlements:

| Budget item | Initial ceiling | Action at ceiling |
|---|---|---|
| Paid data/inference spend | $0 per run and month | Do not dispatch paid/unknown-price request |
| Parallel requests per provider | 2, lower if provider requires | Queue within run deadline |
| Total external HTTP/RPC operations | 150 per run | Stop optional work; mark skipped required dependencies |
| Market discovery | Up to 20 candidate pools | Record truncation and rank method |
| Competitor investigation | Up to 10 validated token candidates | Report observed set; no global canonicality claim |
| Social corpus | Up to 200 original evidence records per run | Deterministic sampling manifest; no total-platform extrapolation |
| Holder pagination | Up to 10 pages, bounded by provider | Compute valid bounds or UNKNOWN, never assert completeness |
| RPC log history | Provider-specific bounded block span and pages | Use saved cursor; no unbounded from-genesis scan |
| Semantic extraction | One packet plus at most one schema repair | Preserve failure; use deterministic report |
| Route sizes | Requested size plus up to four configured diagnostic sizes | Deduplicate, prioritize requested size |
| External origin fetches | Up to 10 safe public URLs | Record unresolved origin if insufficient |

Application counters are reserved atomically before requests so concurrency cannot overspend. Free providers still incur rate limits, CPU, storage, bandwidth, and operator time. Cache immutable or slow-changing metadata by content/version; cache quotes only within their short policy TTL. Do not pool source responses across chains because addresses match.

The 150-operation ceiling includes search, extraction, macro and model requests, plus repairs/retries; provider-specific counters also apply. Current TinyFish Search/Fetch and Parallel credit options are detailed in [08](08-technology-decisions.md). Credit-metered operations qualify only with a proven zero-spend boundary, not assumed credits. C11/C12/C15/C16 may reuse sufficiently fresh, source-scoped context; stale context stays advisory UNKNOWN. Hosted inference tools/grounding remain disabled, so one semantic request cannot launch unbudgeted retrieval.

The initial social workflow is intentionally explicit: automatic permitted collection where available, otherwise an importable corpus. A user can paste a contract and get a complete machine-readable analysis attempt with missing-evidence reasons immediately. They can add an evidence bundle and rerun/revise the verdict. Full unattended social coverage is not promised under zero API spend.

## 6. Source hierarchy is field-specific

For authority state, prefer correctly decoded pinned chain state. For social text, prefer a platform record or verifiable primary page over a vendor summary. For narrative origin, prefer the actual event/creator source over token marketing. For liquidity/fees, prefer supported venue state and simulation over a displayed liquidity number.

An aggregator can be fresher than a slowly indexed explorer; chain data cannot tell us what a joke means. Do not implement a universal “RPC always beats everything” rank. Each normalizer records field meaning, source time, confidence basis, and required corroboration. Conflicts remain inspectable.

## 7. Protocol sources the implementation must consult

| Boundary | Primary reference | Decision it supports |
|---|---|---|
| Solana extensions | [Token extensions](https://solana.com/docs/tokens/extensions) | Inspect supported extension/control surface beyond mint/freeze |
| Solana holder sample | [getTokenLargestAccounts](https://solana.com/docs/rpc/http/gettokenlargestaccounts) | Largest token accounts are not complete owner distribution |
| Solana simulation | [simulateTransaction](https://solana.com/docs/rpc/http/simulatetransaction) | Simulation setup/state is part of evidence |
| EVM RPC | [Ethereum JSON-RPC](https://ethereum.org/developers/docs/apis/json-rpc/) | Pin reads and record actual chain/block/call context |
| Standard proxy slots | [ERC-1967](https://eips.ethereum.org/EIPS/eip-1967) | Inspect supported implementation/admin/beacon patterns; do not infer all patterns covered |
| Pump curve/migration | [Bonding curve](https://pump.fun/docs/bonding-curve) | Venue and lifecycle-specific liquidity rules |
| Pump automated flow | [Mayhem Mode](https://pump.fun/docs/mayhem-mode) | Known automated activity and supply mechanics affect interpretation |
| Pump fees | [Fee schedule](https://pump.fun/docs/fees) | Fee rules must be versioned/read rather than hardcoded forever |
| BSC V2 deployment | [PancakeSwap V2 addresses](https://developer.pancakeswap.finance/contracts/v2/addresses) | Certify factory/router deployment and protocol-specific math |
| Base V3 deployment | [Uniswap Base V3 deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments) | Verify deployment and concentrated-liquidity mechanism |
| Robinhood V4 deployment | [Uniswap V4 deployments](https://developers.uniswap.org/docs/protocols/v4/deployments) | Use PoolKey/hook-aware support, not V3 assumptions |
| Manipulation research | [USENIX study](https://www.usenix.org/conference/usenixsecurity26/presentation/mongardini) | Motivate pattern research; do not generalize sample prevalence into a token score |

Pump's documentation describes curve migration and protocol-owned canonical liquidity. Its Mayhem description also includes extra supply/automated trading behavior and a curve-liquidity caveat. Consequently, “known Pump token” is not a universal safety exemption. Capture the exact mode and version, supported reserve semantics, and available selling evidence. Marketing claims on protocol pages are not substituted for runtime verification.

## 8. Paid upgrades should answer measured gaps

After real use, aggregate unknown reasons by check and chain. Prioritize purchases by how many decision-blocking gaps they remove, their latency/history quality, and whether independent verification remains possible.

Likely candidates are a reliable indexer/archive RPC for ownership and simulations, legitimate X search/history, deeper historical market state, then curated actor labels. They are candidates, not a subscription shopping list. Run a small before/after benchmark on frozen candidates and measure coverage gain, result changes, latency, and cost before adopting a provider.

Keep per-run and monthly limits configurable even after spending is enabled. Price and entitlement changes belong to provider metadata and deployment config; they must not silently change a snapshot's feature semantics or policy.
