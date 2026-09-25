# Feature registry: 96 candidate measurements

The registry specifies what to measure, not 96 independent reasons to buy. Only the checks in the policy document govern the initial verdict. A feature's implementation stage and data availability are distinct: a baseline evaluator can be implemented and honestly return UNKNOWN for a token. Revision 0.2 preserves all original IDs, adds C11–C16, and revises A06/C08/C09; changed definitions receive new feature versions without rewriting snapshots. Detailed new contracts are in [07](07-round-two-lessons-and-contracts.md).

## 1. Shared definitions

**Method:** D = deterministic computation/decoding; L = structured semantic extraction/import; H = semantic labels or inferred associations followed by deterministic measurement. D does not imply certainty: a deterministic clustering heuristic remains an inference.

**Stage:** B = baseline live release; R = research-depth release after longitudinal data exists; E = experimental, definition/validation before policy use. An E feature is not a mandatory v1 evaluator. Its raw ingredients should be retained where economical. No placeholder value is allowed.

**Role:** G = feeds a potential mechanical gate; Q = evidence/quality; O = opportunity evidence; A = advisory. The exact check manifest, rather than this shorthand, determines whether a feature changes a verdict.

**Scope:** ALL = every supported game/chain where applicable; SOL/EVM = chain-family restriction; VEN = recognized venue only; EVENT, VIRAL, COMMUNITY, CREATOR, DERIVATIVE = relevant narrative types. Other games can produce descriptive values without pretending the same interpretation applies.

**Input codes:** CH = pinned chain state/logs; VN = verified venue state/route; MK = market aggregator; HD = holder/indexed transfer snapshot; TR = decoded trade history; SO = social corpus with query/coverage manifest; EX = external primary-source evidence; SM = validated semantic extraction; AC = curated actor/identity records; HS = this system's prior snapshots; CF = resolved config/policy. Providers and free-access constraints are detailed in the source document.

**Quality rules:** Q1 = direct decoding with state/finality and supported mechanism; Q2 = finite population/sample with explicit coverage and exclusions; Q3 = same-query comparable time series with gaps and bucket completeness; Q4 = cited semantic evidence with ambiguity/alternatives; Q5 = inferred graph/actor relation with method, provenance, and no unearned ownership certainty. If an applicable quality rule is unmet, the feature is UNKNOWN or explicitly a bounded/sample-only value. A required check may consume a sample-only result only if its own predicate is defined for that sample.

**Validation targets:** SAFE = test against known control/simulation fixtures and independently adjudicated supported incidents; EXEC = compare estimates against pinned venue computation and simulated receipts; SEM = labeled evidence/association/post-classification accuracy; DATA = coverage, deduplication, unit, temporal and missingness correctness; DEMAND = prospective new-buyer/flow/attention and narrative survival outcomes; RETURN = future size-specific executable returns/drawdown with costs; COPY = follower-latency results with censored history. DEMAND/RETURN/COPY are research outcomes, not launch performance claims.

Every implemented feature also needs: schema/version, owner function, window, unit, dependencies, applicability function, minimum evidence, invalid-input behavior, deterministic fixture, and source-contract test. Table entries plus these shared rules are the feature contract. Changes to formula, denominator, exclusions, time window, classifier, or source universe require a new feature version.

## 2. On-chain & market structure — O01–O30

| ID / feature | Definition, formula or extraction rule | Inputs | Method / stage / role / scope | Quality; validation |
|---|---|---|---|---|
| O01 token identity | Verify network and supported token account/bytecode semantics; return chain, address, standard, code/program identity, existence and supported-object flag. | CH | D / B / G / ALL | Q1; SAFE, DATA |
| O02 supply and valuation | Raw total supply and decimals; FDV = supply × usable spot price; circulating market cap only with separately evidenced circulating supply. Preserve vendor FDV/market cap separately. | CH, MK | D / B / Q / ALL | Q1–2; DATA |
| O03 supply authority | Enumerate mint/supply-changing authorities and reachable supported mechanisms; compare with venue policy allowlist. Null mint authority has a specific meaning only in its token standard. | CH, VN, CF | D / B / G / ALL | Q1; SAFE |
| O04 transfer restrictions | Enumerate freeze, pause, deny/allowlist and confiscation controls under supported contract/program parsing; store active status and controller. Opaque behavior remains unresolved. | CH | D / B / G / ALL | Q1; SAFE |
| O05 upgrade/control reachability | Resolve supported proxy/admin/beacon paths and role authority, or approved Solana program deployment authority; record implementation IDs and controller constraints. An empty ERC-1967 slot alone does not prove nonupgradeability. | CH, CF | D / B / G / ALL | Q1; SAFE |
| O06 extension/custom logic surface | Token-2022 extensions, transfer hooks, permanent delegates, default account state, nontransferability, or EVM custom transfer semantics; unsupported extension => unresolved. | CH | D / B / G / ALL | Q1; SAFE |
| O07 fee/tax mutability | Current transfer/buy/sell fee parameters, caps, update authority, next effective config and observed simulation tax; keep configured fee and observed balance delta separate. | CH, VN | D / B / G / ALL | Q1; SAFE, EXEC |
| O08 venue and lifecycle provenance | Match market factory/program/version, token bindings and curve/migration state against registry. Return all discovered markets with certification level. | CH, VN, MK | D / B / G / VEN | Q1; SAFE |
| O09 liquidity withdrawal exposure | Identify who can withdraw/alter liquidity, amount affected, lock expiry, locker/position proof and protocol controls; evaluate the applicable venue model through horizon. | CH, VN, CF | D / B / G / VEN | Q1–2; SAFE, EXEC |
| O10 entry route | Best supported bounded route quote for requested quote input; return acquired atomic amount, route legs, exact fees and state/quote expiry. Best means within searched routes, not globally optimal. | VN, CF | D / B / G / VEN | Q1; EXEC |
| O11 acquired-quantity exit | Sell the quantity estimated in O10 through a supported route; retain stateful versus independent-quote method and quote-asset output. | VN, O10 | D / B / G / VEN | Q1; EXEC |
| O12 execution simulation | Supported read-only buy/approval/sell sequence results, balance deltas, restrictions, setup context and logs. No signer/broadcast path. | CH, VN, O10–11 | D / B / A or G / VEN | Q1; EXEC, SAFE |
| O13 entry impact | `1 - acquired_quantity / (quote_input / pretrade_reference_price)` under matched units; distinguish fee-inclusive effective loss from provider fee-exclusive impact. | O10, MK/VN | D / B / G / VEN | Q1–2; EXEC |
| O14 exit impact | `1 - gross_exit_quote / (sold_quantity × pretrade_reference_price)`; state orientation and fee treatment; undefined reference price => UNKNOWN. | O11, MK/VN | D / B / G / VEN | Q1–2; EXEC |
| O15 round-trip loss curve | For each configured size, `1 - net_exit_value / total_entry_cost`; net values subtract only costs not already embedded in quotes. Stateful and independent-quote curves are separately labeled. | O10–16 | D / B / G / VEN | Q1; EXEC |
| O16 full cost breakdown | Entry/exit gas, priority/relay charges, AMM/protocol fees, creator fees and taxes in native and valued quote units; reconciliation prevents double subtraction. | CH, VN, CF | D / B / G / ALL | Q1–2; EXEC |
| O17 holder data coverage | Block/state, indexed range, pagination, eligible supply denominator, known balances sum, unresolved tail and exclusion manifest. No claimed fraction without known denominator. | HD, CH | D / B / Q / ALL | Q1–2; DATA |
| O18 economic holder count | Count owners with positive or policy-dust-exceeding balance after account-owner aggregation; retain raw count, cutoff and excluded system owners. Transfers/dust are not new buyers. | HD, CH, CF | D / B / Q / ALL | Q2; DATA, DEMAND |
| O19 visible concentration | Top 1/5/10 owner balances divided by declared raw and adjusted supply denominators; report both views and unknown-tail bounds. | HD, O17 | D / B / G / ALL | Q2; SAFE, RETURN |
| O20 proven control concentration | Sum nonoverlapping balances linked by explicit ownership/control evidence; return largest proven group, lower/upper bounds and provenance. Do not include weak behavioral edges as proven control. | HD, CH, AC | D / B / G / ALL | Q1–2, Q5; SAFE |
| O21 inferred control topology | Candidate connected groups under a versioned strong-evidence rule; supply shares, edge evidence and sensitivity with weak edges removed. Explicitly inferred, not true ownership. | CH, HD, TR | D / R / A / ALL | Q2, Q5; SAFE, RETURN |
| O22 fresh-wallet exposure | Share held by wallets whose first observed on-chain activity is within configured age; record history start so newly observed does not imply newly created. | HD, CH | D / R / A / ALL | Q2–3; RETURN |
| O23 synchronized entry/exit | Fraction of trades within declared time/slot bins sharing independently specified funding/behavior indicators; preserve null baseline and bin sensitivity. | TR, CH | D / R / A / ALL | Q3, Q5; SAFE, RETURN |
| O24 tracked inventory change | Net token balance change and decoded buys/sells of a fixed creator/early-owner cohort between pinned states; distinguish transfers from sales. | HD, TR, HS | D / R / A / ALL | Q1–3; DEMAND, RETURN |
| O25 inventory overhang proxies | Holdings by entry-cost/holding-age bands, known realized fraction and current sells; output a vector, not invented `P(sell)` or expected supply. | HD, TR, HS | D / R / A / ALL | Q2–3, Q5; RETURN |
| O26 circular/round-trip patterns | Detect bounded repeated inventory-return trade/transfer motifs with transaction-level proof; report count and covered volume, allow arbitrage alternatives. | TR, CH | D / R / A / ALL | Q2, Q5; SAFE |
| O27 related-party volume | Volume with both ends attributed to the same evidenced group / covered decoded volume; avoid equating shared router or pool with shared owner. | TR, O21 | D / R / A / ALL | Q2, Q5; SAFE, RETURN |
| O28 directional flow | Quote-denominated buys minus sells over a window, plus unique economic buyers/sellers when available; exclude LP adds/removes and deduplicate router legs. This is observed DEX flow, not total new capital. | TR, MK | D / B / Q / ALL | Q2–3; DEMAND |
| O29 thin-liquidity price inflation | Price change alongside quote notional, reserve/depth change and price impact for the same window; flag a defined anomaly only after cohort baseline exists. | TR, VN, HS | D / E / A / VEN | Q2–3; SAFE, RETURN |
| O30 known automated flow | Transactions/volume associated with officially evidenced protocol bot addresses or attributable programs divided by covered flow; unknown automated volume is not zero. | CH, TR, VN | D / B / A / ALL | Q1–2; DATA, DEMAND |

For O15, the dependency notation means O10, O11, O12 when available, O13, O14, and O16; it does not include O15 itself. Implement the dependency graph without cycles.

## 3. Attention & narrative — A01–A30

| ID / feature | Definition, formula or extraction rule | Inputs | Method / stage / role / scope | Quality; validation |
|---|---|---|---|---|
| A01 narrative identity | Evidence-grounded description of the meme/event/community; stable narrative ID is assigned by code after association review, never by free-form model slug alone. | SO, EX, SM | L / B / Q / ALL | Q4; SEM |
| A02 game taxonomy | Supported game labels plus rationale and unresolved alternatives; MIXED/UNKNOWN valid. Code selects applicable policy branches. | A01, SM | L / B / Q / ALL | Q4; SEM |
| A03 origin provenance | Earliest observed primary source, origin category, publication/first-seen times and verification state. Earliest collected source is not automatically the true origin. | SO, EX, SM | H / B / O / ALL | Q3–4; SEM |
| A04 catalyst dependency | Event identity, verified date if any, temporal relation and expiry condition; distinguish scheduled fact, announced claim, and rumor. Community/crypto-native origin can be event-independent. | EX, SM | H / B / O / EVENT, ALL | Q4; SEM, DEMAND |
| A05 semantic compressibility | One evidence-supported sentence with rubric flags: identifies referent, explains interest, explains token relationship, lists prerequisite concepts; no invented cultural-recognition percentage. | A01, SM | L / B / O / ALL | Q4; SEM |
| A06 persistence class | Baseline cited SPARK/WAVE/COMMUNITY/MIXED/UNKNOWN style plus FLASH/EVENT_BOUND/SHORT_CYCLE/RECURRING/GENERATIVE/EVERGREEN/UNKNOWN mechanism; history length, proposed horizon, renewal and expiry evidence. Separate from A02 game; not a fitted half-life. | EX, SO, SM | L / B / A / ALL | Q4; SEM, DEMAND |
| A07 narrative generativity | Count distinct observed derivative artifact themes/creators after semantic clustering, with concrete examples and fixed sampling budget. Potential creativity remains a qualitative hypothesis. | SO, SM | H / R / A / VIRAL, COMMUNITY | Q2, Q4; DEMAND |
| A08 community artifact production | New original artifacts per unit time and independent creators, excluding copied content and price-only posts; corpus-scoped. | SO, SM | H / R / A / COMMUNITY | Q2–4; DEMAND |
| A09 competitor candidate set | Candidate-scoped query results, validated chain-qualified contracts, search scope and semantic association decisions. Empty/error/truncated search explicitly distinct. | MK, SO, EX, SM, CH | H / B / Q / ALL | Q2, Q4; SEM |
| A10 token-narrative binding | Evidence for each contract representing this narrative; exact address/link versus ticker-only relation; origin endorsement labeled separately from popularity. | A09, SO, EX, SM | H / B / Q / ALL | Q4; SEM |
| A11 observed attention share | Bound original qualified posts for token / sum across discovered associated tokens, over identical source/window; deduplicate multi-token posts with fractional allocation `1/k`. | A10, A16 | H / B / O / ALL | Q2–4; DEMAND, RETURN |
| A12 executable-liquidity share | Sum comparable executable exit capacity under the same size/impact method per token / competitor-set total; do not sum TVL as capacity or duplicate shared routes. | A09, VN | D / R / A / ALL | Q1–2; EXEC, RETURN |
| A13 participation-growth share | Positive net new economic participants per candidate / sum of positive growth across observed competitors; report decreases separately and zero denominator as undefined. | A09, HD, TR, HS | D / R / A / ALL | Q2–3; DEMAND |
| A14 representation leadership | Rank by A11 within observed set; tie status, margin, rank change, competitor coverage, and independently verified origin relationship. No arbitrary combined canonicality score. | A03, A10–11, HS | H / B / O / ALL | Q2–4; DEMAND, SEM |
| A15 raw mention sample | Count records returned per query/source/window before dedup and number after exact-ID dedup; preserve page cap and sample size. | SO | D / B / Q / ALL | Q2; DATA |
| A16 qualified mention sample | Relevant token/narrative-bound original posts after exact/near-copy grouping and excluded price-only/spam labels; record classifier uncertainty and both raw/qualified counts. | SO, SM, S02 | H / B / Q / ALL | Q2, Q4; SEM, DATA |
| A17 author breadth | Unique source-qualified author IDs in A16, plus posts/author distribution; cross-platform identities merged only with evidence. | SO, A16 | D / B / Q / ALL | Q2; DATA, DEMAND |
| A18 attention velocity | `(count_current - count_previous) / bucket_duration` for equally sized, comparably collected windows; both counts retained. No growth estimate from different query budgets. | A16, HS | H / B / O / ALL | Q3–4; DEMAND |
| A19 attention acceleration | `(velocity_current - velocity_previous) / bucket_duration`, requiring three comparable count buckets; high noise and small denominators flagged. | A18, HS | H / R / A / ALL | Q3; DEMAND |
| A20 propagation breadth | Number of evidenced source communities/platforms contributing qualified original content, with copied propagation branches separate. | SO, S03, S10 | H / R / A / ALL | Q2, Q4–5; DEMAND |
| A21 external-attention fraction | Qualified observed posts originating outside configured crypto/caller sources / eligible classified posts; UNKNOWN category reported, not treated as crypto or organic. | SO, EX, SM | H / R / A / VIRAL, EVENT | Q2, Q4; SEM, DEMAND |
| A22 paid visibility | DEX paid-order/boost presence and disclosed paid posts, separately enumerated by time/venue. Absence of a disclosure is not proof of organic activity. | MK, SO, SM | H / B / A / ALL | Q2, Q4; DATA, SEM |
| A23 price-reflexive fraction | Classified price/chart-focused posts / classified relevant posts; retain unclassified share. A temporal price lead is separate from a post's topic. | SO, SM | H / B / A / ALL | Q2, Q4; SEM, DEMAND |
| A24 observed saturation proxies | Vector: repeated-author share, caller breadth, source novelty rate, mention/holder growth, paid visibility; no estimate of “everyone already knows.” | SO, HD, HS | H / R / A / ALL | Q2–4; DEMAND, RETURN |
| A25 attention/price lead-lag | Cross-correlation of aligned differenced attention and price/flow series over preregistered lags; positive lag convention means attention precedes market response. Report peak, overlap, null test and uncertainty. | SO, SM, TR, HS | H / E / A / ALL | Q3–4; DEMAND, RETURN |
| A26 attention-to-buyer proxy | Economically meaningful first-observed buyers in a window / qualified observed posts in that window; units are buyers/post, not person-level conversion probability. | TR, HD, A16 | H / R / A / ALL | Q2–4; DEMAND |
| A27 marginal attention efficiency | Change in first-observed buyers between windows / change in qualified posts; denominator zero/negative => undefined for growth interpretation, with component values preserved. | A26, HS | H / E / A / ALL | Q3–4; DEMAND, RETURN |
| A28 observed decay half-life | Fit a declared decay model only after a detected peak with no observed new catalyst; return fit interval, residuals and censoring. Failure to identify a decay regime => UNKNOWN. | A04, A16, HS | H / E / A / ALL | Q3–4; DEMAND |
| A29 distribution absorption | Vector of tracked-cohort net selling, price change, new-buyer growth, depth change and concentration change over same interval; avoid converting co-occurrence into causation. | O24, O28, VN, HD, HS | D / R / A / ALL | Q2–3, Q5; DEMAND, RETURN |
| A30 demand persistence | Number/share of observed windows with new meaningful buyers and nonnegative net decoded quote flow; describe window selection and missing buckets. | TR, HS | D / R / A / ALL | Q2–3; DEMAND |

## 4. Social & actor intelligence — S01–S20

| ID / feature | Definition, formula or extraction rule | Inputs | Method / stage / role / scope | Quality; validation |
|---|---|---|---|---|
| S01 social identity binding | Contract-bound links, claimed official accounts, public proof status, redirects and impersonation contradictions. An official account is optional; a claimed identity must not be silently treated as verified. | CH, MK, SO, EX | H / B / Q / ALL | Q1, Q4; SEM, SAFE |
| S02 duplication structure | Exact ID/repost/canonical-URL groups, then normalized-text similarity groups with versioned threshold; distinguish quoted criticism from copied endorsement using labels. | SO, SM | H / B / Q / ALL | Q2, Q4; DATA, SEM |
| S03 independent source groups | Explicit repost/forward/origin links first; uncertain similarity edges remain separate. Output group count plus method and unresolved lineage, not exact number of independent people. | SO, SM | H / B / Q / ALL | Q2, Q4–5; SEM |
| S04 coordinated-post pattern | Time-binned posting synchrony and near-copy concentration within source groups; compare to declared baseline before using “unusual.” No automatic human identity inference. | SO, S02–03 | D / B / Q / ALL | Q2–3, Q5; SEM, DATA |
| S05 bot-like account indicators | Observable account age/activity regularity/text reuse and missing-account fields; produce indicators, not binary bot ground truth or unvalidated bot probability. | SO | D / B / Q / ALL | Q2; SEM |
| S06 engagement integrity | Medians/quantiles of observed replies/reposts/likes and concentration, captured at metric observation time; unavailable views/followers are missing, and counts are platform-specific. | SO | D / B / Q / ALL | Q2–3; DATA, SEM |
| S07 call-event extraction | Identify forward-looking explicit promotion/call versus warning, joke, retrospective claim, or news; record contract, timestamp, edits, source evidence and uncertainty. | SO, SM | H / R / A / ALL | Q4; SEM, COPY |
| S08 promotional incentives | Disclosed compensation, creator fee rights, public holdings or affiliations with evidence/time; no claim of hidden payment from price movement alone. | SO, EX, CH, SM | H / B / A / CREATOR, ALL | Q1, Q4; SEM |
| S09 caller concentration | Top 1/5 caller shares of observed call events/propagation; follower counts not summed into unique reach. | SO, S07 | H / R / A / ALL | Q2, Q4; COPY, DEMAND |
| S10 participating communities | Count independently evidenced channel/group/community origins after copy collapse; author identities within each. Platform count alone does not establish community independence. | SO, S03, AC | H / B / O / ALL | Q2, Q5; SEM, DEMAND |
| S11 returning participants | Authors active in both earlier and later comparable windows / earlier-window authors; record churn/new shares separately and deletion/censoring. | SO, HS | D / R / A / COMMUNITY, ALL | Q2–3; DEMAND |
| S12 independent creators | Distinct creators of original evidenced artifacts after association grouping; relationship uncertainty carried forward. | SO, SM, AC | H / R / A / COMMUNITY | Q2, Q4–5; DEMAND |
| S13 public wallet association | Public signed/explicitly verified wallet relationship or a separate inferred association edge; method and validity dates mandatory. No automatic doxxing/name inference. | AC, EX, CH | H / R / A / ALL | Q1, Q4–5; DATA, SEM |
| S14 actor entry lead | First observed relevant trade minus first eligible call/propagation event, with sign convention and availability time. Missing earlier history gives a bound, not exact first entry. | TR, S07, S13 | D / R / A / ALL | Q2–3, Q5; COPY |
| S15 actor performance decomposition | Realized/unrealized value, deposits/withdrawals/transfers and fees under declared cost-basis method; sample/censoring and strategy/horizon cohort retained. Do not equate wallet net deposits with profit. | TR, HD, AC, HS | D / R / A / ALL | Q1–3, Q5; COPY, RETURN |
| S16 copyable outcome | Simulated follower entry after predefined detection/execution latency and size, exit under a preregistered rule, costs and liquidity constraints; hindsight optimal exit only as an upper bound. | S07, TR, VN, HS | D / E / A / ALL | Q1–3; COPY |
| S17 actor/follower alignment | Change in publicly associated actor inventory before/after calls; value/volume of sales into ensuing window. Association and transfer-vs-sale certainty shown. | S07, S13, TR, HD | D / R / A / ALL | Q2–3, Q5; COPY |
| S18 actor observability proxies | Known tracker-list inclusions, public repost delay and post-entry follow flow; true tracker population UNKNOWN unless supplied by a measured source. | SO, AC, TR, HS | H / E / A / ALL | Q2–5; COPY |
| S19 independent actor convergence | Number of historically covered actor groups entering in a fixed interval after collapsing evidenced shared-control/campaign groups; report “independence not disproven” separately from verified relationship evidence. | AC, TR, S13, O21 | D / R / A / ALL | Q2–3, Q5; COPY, RETURN |
| S20 promotion sequence recurrence | Recurring ordered caller set, time spacing, similar text and pre/post-call cohort flow across tokens; minimum repeated examples and null model required before a campaign flag. | S07, SO, TR, HS | H / E / A / ALL | Q2–5; SEM, COPY |

## 5. Shared context and evidence — C01–C16

| ID / feature | Definition, formula or extraction rule | Inputs | Method / stage / role / scope | Quality; validation |
|---|---|---|---|---|
| C01 analysis context | Resolved size, horizon, quote asset, risk profile, origin of defaults, analysis kind and policy hash; missing fields explicit. | CF | D / B / Q / ALL | Schema validation; DATA |
| C02 capability coverage | Required capabilities versus certified chain/venue/provider support and active credentials/free limits; each gap has source and reason. | CF, provider manifests | D / B / Q / ALL | Current capability probe; DATA |
| C03 evidence freshness | Age of each required dependency against feature-specific event/state/retrieval TTL; worst required age and staleness causes. | evidence, CF | D / B / Q / ALL | Q1–3; DATA |
| C04 completeness/coherence | Required-check denominator/numerator, truncation, time skew, comparable-window status and provenance distribution; not a single probability. | all manifests | D / B / Q / ALL | Q1–3; DATA |
| C05 semantic validation | Schema/reference/span/time/entity validation results, extractor mode/version and evaluated quality status; no semantic observations => unmet dependent checks. | SM, evidence | D / B / Q / ALL | Q4; SEM, DATA |
| C06 conflict register | Contradictions among temporally/comparably scoped observations, resolution rule or unresolved state; dependencies affected listed. | observations | D / B / Q / ALL | Q1–4; DATA |
| C07 lifecycle hypothesis | UNKNOWN/DISCOVERY/CANONICALIZATION/EXPANSION/CROWDING/DISTRIBUTION/DECAY/INACTIVE rules over recorded feature windows; require persistence/hysteresis and allow reversal. | A18, A24, A29, O24, HS | D / R / A / ALL | Q3; DEMAND, RETURN |
| C08 market-state context | Completed-window returns, drawdown, trade VWAP where supported, flow and history/depth quality; fixed market/quote/timeframe and gap policy per 07. Baseline descriptive calculation; longitudinal evaluation remains later. | TR, MK, CF | D / B / A / ALL | Q2–3; DATA, RETURN |
| C09 chain-market regime | Baseline descriptive context from C11/C12/C15/C16 with separate coverage; HOT/NORMAL/COLD classification remains experimental and absent until its preregistered history/rules exist. No universal SOL multiplier. | C11, C12, C15, C16, CF | D / B / A / ALL | Q2–3; DATA, RETURN |
| C10 thesis conditions | Evaluate frozen typed support/invalidation/realization predicates with TRUE/FALSE/UNKNOWN; Phase 1 management under 09 uses baseline/current references and comparable windows. Missing settings/history remains UNKNOWN. | features, CF, HS | D / B / A for entry, management input / ALL | Q3–4; DATA, RETURN |
| C11 chain DEX activity share | Same-window covered spot DEX volumes and shares across declared comparable chains; current-minus-prior share in percentage points. Unknown/excluded chains named; never net capital flow. | MK, CF | D / B / A / ALL | Q2–3; DATA, DEMAND |
| C12 observed bridge flow | Completed covered bridge inflow/outflow/net by chain and asset with canonical-transfer dedup, direction/finality and valuation; gross-only data cannot establish net. | CH, provider bridge records, CF | D / B / A / ALL | Q1–3; DATA, DEMAND |
| C13 confirmed chart structure | Causal confirmed-fractal-pivots-v1 per 07, cutoff-qualified extrema and UP/DOWN/RANGE/MIXED/UNKNOWN; provisional terminal extrema excluded. | completed candles, CF | D / B / A / ALL | Q2–3; DATA, RETURN |
| C14 chart-thesis corroboration | Evaluate a named typed chart predicate against C08/C13; CORROBORATES/CONTRADICTS/UNKNOWN/NOT_REQUESTED, with exact dependency times. No chosen predicate => NOT_REQUESTED. | C08, C13, CF | D / B / A / ALL | Q3; DATA, RETURN |
| C15 macro reference context | Separate BTC/ETH/SOL instrument returns and drawdowns with source, quote, completed interval and availability; no causal multiplier or inferred memecoin flow. | MK, CF | D / B / A / ALL | Q2–3; DATA, RETURN |
| C16 launchpad activity context | Covered launch/migration counts and distinct volume/fees/revenue series; matured-cohort survival only with complete specified follow-up, otherwise UNKNOWN. Never substitute one metric for another. | CH, MK, provider launch records, CF | D / B / A / ALL | Q2–3; DATA, DEMAND |

C09 is an aggregation of context, not an independent score. C08/C13/C14 belong to P03a; C09/C11/C12/C15/C16 to P03b; A06 to P06; C10 to P11 manual management. C16 prospective survival requires P08 history; available descriptive series are baseline. These features remain advisory under v0 entry policies; [09](09-two-checklist-lifecycle.md) defines separate management dependencies. No portfolio metric silently enters the entry checklist.

## 6. Measurement rules that prevent attractive but false metrics

### Comparable windows

Baseline attention uses two completed equal-duration buckets, default 15 minutes, within a recorded collection range. Three buckets are necessary for acceleration. This default is a sampling choice; make it configurable and store it in feature identity. Historical bucket values may be reconstructed from a currently obtained corpus for description, but are not retrospectively “known then.”

Do not build a 24-hour volume series by repeatedly adding overlapping provider 24-hour windows. Either persist nonoverlapping decoded trades/candles or retain rolling-window measurements as rolling windows. Align independent market/social series to UTC bins and mark gaps; forward-fill does not create observed activity.

### Economic participation

Define a minimum quote notional for meaningful buyers in a named profile and preserve raw counts too. Dust transfers, airdrops, LP vault changes, and token-account creation are not buys. First observed buyer means first in the covered history, not a proven new person or new capital entrant. If only aggregator buy/sell counts are available, O28 returns those counts with trade-count units; A26 remains UNKNOWN because distinct buyer identity is unavailable.

### Attention qualification

The qualification policy is reproducible: exact ID deduplication, explicit repost/copy grouping, token/narrative binding, role classification, and a declared inclusion set. Preserve excluded counts by reason and an unclassified bucket. Do not discard skeptical posts merely because they are negative; warning/contradiction evidence must remain available to the thesis even if excluded from a promotional-attention count.

### Canonicality

Report component measurements, not an unvalidated weighted average. A11 shares sum to one only within the explicit competitor sample, with consistent fractional treatment of posts mentioning several candidates. A token may lead social mentions while another leads executable depth; that is a meaningful disagreement. Cross-chain candidates remain distinct, and bridges/official deployments need association evidence rather than ticker matching.

### Clustering and actor intelligence

Keep observed edges and inference methods independent from scores. Known custodial funders should suppress shared-funder evidence, not erase all relationships. Keep node/edge/balance time validity. Using present-day actor labels in an old snapshot can leak future knowledge; replay uses the label version available at that cutoff.

### Predictions and confidence

No initial feature estimates a universal probability of rug, future demand, or profitable return. Where statistical models are introduced, save target definition, training cutoff, data manifest, cohort, calibration metrics and out-of-sample results. Uncertainty intervals need an actual estimation method. Display exact counts and bounded claims before introducing numerical confidence.

## 7. Promoting a feature into the checklist

A candidate starts as descriptive/advisory. Promote it only after its source contract is reliable, minimum evidence is achievable, labeled/prospective evaluation is adequate for its claim, and sensitivity tests show it is not merely duplicating another feature. Record its expected effect and false-rejection cost before choosing a threshold.

Mechanical authority restrictions may be policy preferences without predictive training; label them as risk constraints. Opportunity thresholds need empirical evaluation before being advertised as selection skill. All promotions create a new policy version, a changed-check explanation, a replay comparison over frozen snapshots, and a documented rollback path.
