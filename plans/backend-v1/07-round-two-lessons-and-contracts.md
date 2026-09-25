# Round two: complete course, notes, and operational contracts

Revision 0.2, 2026-09-24. This document extends the canonical plan. Existing entry gates, chain targets, evidence lineage and entry verdict precedence remain in [02](02-contracts-and-policy.md). New descriptive features are advisory for entry. The user's confirmed two-checklist requirement is specified in [09](09-two-checklist-lifecycle.md): manual thesis management, exit proposals and optional position journal now belong to Phase 1. Paper simulation and actual execution remain later scope.

## 1. Source and attribution

The complete supplied text used during planning was 96,514 bytes, SHA256 `99B29C18FB62F873DA6964346EB133CF24503FCFFB3F64F8D600C968BC296869`. The raw source file is intentionally excluded from this public repository, so transcript line references below point to local-only planning material. The eight transcripts and the user's notes were distinct sources. Original audiovisual recordings were not independently checked; malformed transcript timestamps are not silently repaired into asserted precise timings.

Use attribution tags `TRANSCRIPT`, `USER_NOTE`, `ENGINEERING_RULE`, and `EMPIRICAL_RESULT` in source-to-rule records. The last requires actual evaluation and is not present merely because a lesson sounds plausible. The original [pre-plan mapping](06-preplan-traceability.md) remains historical provenance. This revision removes its former assumption that VI–VIII have not been supplied.

The largest additions are: chart confirmation without hindsight, two separate market thermometers, cross-chain activity versus capital movement, attention persistence independent of narrative category, and precommitted thesis/management/journal contracts. Most security, canonicality and actor ideas already had useful contracts and should be strengthened rather than duplicated.

## 2. Chapter and annotation coverage

| Source | Disposition | Responsible contract / proof |
|---|---|---|
| I; notes 1989–2007: attention, asymmetry, no token cash-flow thesis | Retain attention/inventory research hypothesis and distinction between valuation and realizable proceeds. Macro context is allowed; project revenue is not invented as intrinsic memecoin valuation. | O02/O10–O16, A01–A30; no numerical expected return from a narrative label |
| II; notes 2009–2017: mechanics and chain selection | Preserve chain/venue separation and amount-sensitive execution. Add cross-chain comparison requested in notes 2013–2015. | C11/C12 below; DEX activity is not bridge flow |
| III; notes 2018–2027: bundles, rugs, coordinated attention | Already substantially covered. Keep proven control separate from inferred bundling; a supposedly good bundle cannot waive a control cap. | O20 versus O21–O27, S03–S06; direct/inferred fixtures |
| IV; notes 2029–2074: origin, duration, simplicity, representation | Add explicit spark/wave/community axis; keep narrative category separate. Treat “bumping”/“vamping” as source vocabulary for competing representation/displacement, not separate invented algorithms. | A06 revision, A03/A05/A09–A14; duration unknown allowed |
| V; notes 2076–2131: where signals originate, actors, calls | Preserve curated source scope, incentives, edited/deleted calls, latency, horizon-specific actor results. Add source-role and saturation interpretation below. | S07–S20/A24; discovery source is not an automatic purchase signal |
| VI transcript 1421–1505, 1541–1648; notes 2133–2156 | Replace unspecified-chart placeholder with causal completed-candle/pivot contracts. Narrative precedes chart interpretation. | C08/C13/C14; appending future candles cannot alter historical knowledge |
| VI transcript 1694–1767; notes 2158–2161 | Separate BTC/ETH/SOL macro observations from launch activity and eventual fitted regime labels. | C09/C15/C16; sparse data cannot become COLD or zero |
| VII transcript 1808–1812; notes 2171–2173 | Add three-part pre-entry research plan: thesis, invalidation, profit realization. Entry eligibility and management readiness are separate. | ResearchPlan below and two-checklist lifecycle in 09 |
| VII transcript 1815–1839; notes 2175–2184 | Preserve risk sizing and tranches as configurable future hypotheses. 1/3/5% and 40/30/30 are notes examples, not course-wide constants. | Position context, quantity-conserving exit legs, net-recovery arithmetic |
| VII transcript 1850–1880; notes 2189–2203 | Invalidation is an observation, not a guaranteed stop fill. Journal precommitment, deviations, outcomes and user-reported feelings. | Journal proposal and point-in-time outcome contracts |
| VIII transcript 1898–1936; notes 2206–2214 | Reinforce no custody/signing, trusted URLs, bounded experimentation. Three weeks/paper mode are the user's extension of the learning process. | Existing security boundary; future paper packet requires separate scope |

### Specific notes that need interpretation rather than literal automation

“If viral on X, too late” is a saturation hypothesis. A verified origin or new audience on X can still be informative. Store source novelty, caller repetition, attention/price timing and participation conversion; do not hard-reject by platform. Likewise, 40 mentions becoming 50 means little without equal windows, comparable collection, independent authors and an earlier baseline. Positive growth can coexist with deceleration.

Telegram is an operating source with separate channel roles: `ORIGIN`, `CURATED_RESEARCH`, `CALLER`, `AGGREGATOR`, `COMMUNITY`, `UNKNOWN`. Roles may overlap and require evidence. Public channel, authorized private export and search results have different access and coverage. Paid membership is not a quality label. Private group access is not presumed from possession of an account.

A trader's strong history in minute-scale launches does not establish skill in month-long community holdings. Reuse S15/S16 cohorts by chain, venue, age, size, horizon and strategy. Record calls before their outcomes, retain edits/deletions, and distinguish public claims from observable activity. Do not promote a wallet because of one winning token or clean-looking PnL.

## 3. Attention persistence is a separate axis

`A02.gameType` continues to describe the referent: event, personality, established meme, community, crypto meta and so on. `A06` adds `attentionStyle = SPARK | WAVE | COMMUNITY | MIXED | UNKNOWN` alongside the existing persistence mechanism labels. A celebrity event can be a spark or a wave; a token with COMMUNITY branding has not necessarily demonstrated renewal.

Baseline A06 produces a cited hypothesis, with `observedHistorySeconds`, `proposedHorizonSeconds`, `renewalMechanisms[]`, `expiryDependencies[]`, `contradictions[]`, and `support`. Hours/days, days/weeks, and months/years describe the course's conceptual ranges; they are not automatic measured lifetimes. Longitudinal observed persistence and fitted decay remain later features.

The four-question ritual becomes a structured thesis aid:

1. What is the earliest evidenced origin, and when was it available to this run?
2. What could sustain or renew attention, and what could end it?
3. Can one supported sentence explain the referent and this token's relationship?
4. Which competing contracts represent it, and why does this one lead within the observed set?

The current v0 ATT-02 gate remains an explicit conservative growth/propagation screen. It may reject a mature community with stable attention. Report this policy limitation; do not quietly modify a saved policy to force a PASS. A later `research-style-v1` proposal may compare spark acceleration, wave propagation and community retention/creation, but requires defined evidence minima and evaluation first. Style classification alone never relaxes security or evidence requirements. In P10 compare false-rejection rates by style before promoting a new branch.

## 4. Chart context: code-owned, time-correct, and thesis-relative

### Input contract

`CandleSeries` carries chain-qualified token and market, venue/version, base/quote orientation, quote valuation series, interval seconds, `[start,end)`, provider, collection/availability times, completed status, trade coverage, gap policy and revision. Every candle contains OHLC, base and quote volume where genuinely available, and trade count with explicit units. Provider USD volume must retain the provider's valuation convention.

Reject negative quantities, impossible OHLC bounds and duplicate conflicting bars. Out-of-order rows can be sorted without changing event identity. Do not combine unrelated pools into synthetic candles by summing OHLC. Select a market by a deterministic supported-market rule and state it. A venue migration splits the series unless a declared continuity method validates units and price relationships. A zero-trade candle is valid only with sufficient coverage; an absent candle is a gap. A carried-forward display price is synthetic and cannot silently count as an observed price for pivot/volume calculations.

Store requested and resolved timeframe, token age, covered age, completed-bar count, gaps and minimum-bar config. Configure minimum history per calculation. A fifteen-minute-old token cannot supply an observed month-long trend. Market cap bands in the notes are examples; actual exit depth and requested size determine fragility. If a profile later uses bands, intervals must be disjoint, e.g. `[0,100k)`, `[100k,1m)`, `[1m,10m)`, `[10m,infinity)`, plus UNKNOWN. FDV cannot fill missing circulating market cap. No band automatically grants a larger allocation.

### Deterministic baseline trend algorithm

Use one causal baseline, `confirmed-fractal-pivots-v1`, rather than an unspecified chart-reading LLM. Configure positive integers `leftBars`, `rightBars`, and nonnegative decimal `comparisonToleranceBps`. A high pivot at completed bar i requires its high to be strictly greater than every high in the configured left/right windows; a low pivot analogously strictly lower. Equal extrema produce no pivot under this version. Complete windows with no gaps are required. A bar satisfying both predicates is retained as two extrema with ambiguous intrabar order and is excluded from directional sequence classification.

The pivot event time is bar i's close; confirmation time is the close of bar i+rightBars. Its `availableAt` is the maximum availability of all dependency bars. A run may consume it only after both confirmation and availability. Terminal candidates are provisional and excluded from confirmed trend. Save evidence indices and algorithm/config hash. Later source corrections create a revised series; they never mutate a frozen decision.

Compare the latest two eligible confirmed highs and latest two eligible confirmed lows known at the cutoff. For positive earlier price p, change bps is `(new-p)/p*10000`. Above tolerance is HIGHER, below negative tolerance LOWER, otherwise EQUAL. Both HIGHER => UP; both LOWER => DOWN; both EQUAL => RANGE; all other complete combinations => MIXED. Insufficient eligible pivots or invalid/gapped dependencies => UNKNOWN. This is one declared trend estimator, not a universal definition of market structure. Report extrema times and staleness; do not call an old confirmed trend current without the configured age check.

The user's ZigZag suggestion remains an optional alternative algorithm, not an unspecified mandatory library. If selected later, define reversal threshold, initialization, high/low ordering, gaps and confirmation before coding. Its current endpoint usually remains provisional. Require the same future-candle invariance proof. Do not backfill an old verdict with a repainted final ZigZag line.

### What chart corroboration can mean

C08 retains returns, drawdown, VWAP when trades support it, and flow components. C13 owns confirmed structure; C14 evaluates a user/policy-authored typed chart predicate against those values. `CORROBORATES | CONTRADICTS | UNKNOWN | NOT_REQUESTED` describes the predicate result, with evidence. No predicate selected => NOT_REQUESTED, not corroboration. Price rising alone cannot establish a cultural origin or organic attention.

“Consolidation before rising” and “distribution before falling” describe outcomes if the labels rely on a future breakout. At time t report RANGE/MIXED, plus separately evidenced inventory changes. A distribution hypothesis can reference known cohort sales; it cannot use tomorrow's decline. Breakout confirmation similarly needs a named reference level fixed before the confirming bar, completed-bar rules and optional volume conditions. Vague “big breakout” remains an inactive hypothesis until parameters are explicit.

Volume corroboration uses comparable completed buckets, retained raw values and coverage. “Real volume” requires the independent integrity evidence in O26–O30; green candles cannot prove it. All chart context is baseline advisory in revision 0.2. New hard entry signals are outside this revision.

## 5. Market thermometers and cross-chain rotation

### Four measurements with separate meanings

| Measurement | Code definition | Interpretation boundary |
|---|---|---|
| Chain DEX activity C11 | Covered spot DEX USD volume V(c,w), same window/source definition; share `V(c,w)/sum V(c,w)` over the declared covered chain set; change in percentage points against comparable previous window | Relative trading activity; wash/incentive effects possible; not net new capital |
| Bridge flow C12 | Completed covered transfers into chain minus completed transfers out, each valued under declared asset/time convention; retain gross inflow/outflow separately | Movement through covered bridges; not all chain inflow and not memecoin demand |
| Macro C15 | Returns and drawdown for separately identified BTC, ETH and SOL instruments, quote source, completed interval and known cutoff | Context, not a universal SOL multiplier or causal explanation for every coin |
| Launch activity C16 | Counts of launches/migrations and separately named volume/fees/revenue series for a declared launchpad cohort; survival only for matured cohorts with follow-up | Market participation context; revenue and fees cannot substitute for volume |

The comparison universe always lists Solana, BSC, Base and Robinhood, including UNKNOWN entries. A share denominator can include only fully covered, comparable entries; label it `shareOfCoveredChains` and list excluded chains. If coverage changes, do not report the difference as capital rotation. Comparing providers requires reconciling definitions and scope first. Do not use the top 20 token-discovery pairs as if they were total chain activity.

Bridge records retain source/destination chain, bridge/version, asset, quantity, transaction/message ID, source initiation time, destination completion time, finality and valuation evidence. Deduplicate aggregator and underlying bridge records by canonical transfer identity; when identity cannot be reconciled, keep provider series separate. For a completed-flow convention, record both inflow and outflow at completion with the same valuation for reconciliation; initiated-but-pending flows are a separate series. A single bridged amount observed at both ends is not two independent inflows. Do not sum bridge TVL as flow.

Where only aggregate bridge volume is available, C12 cannot infer direction or net flow. Return gross reported volume with its provenance in observations; net feature UNKNOWN. Stablecoin supply changes, CEX movements and token price appreciation are distinct mechanisms; do not add them to bridge flow under a general “new money” label. Cross-chain actor linkage is unnecessary for baseline context.

C09 becomes a baseline descriptive container of C11/C12/C15/C16 and relevant depth/history coverage. HOT/NORMAL/COLD classification remains experimental, with a fixed universe, history length, percentile/threshold rule and evaluation before activation. No complete context => UNKNOWN label. A weak macro backdrop is advisory in v0: the transcript explicitly allows isolated strong narratives. A future user-selected abstention rule must be a named policy, not an invisible multiplier.

### Free source feasibility

Use the supplied [Jupiter launchpad view](https://jup.ag/spot/launchpads?metric=total_vol_dollars) and [DefiLlama launchpad table](https://defillama.com/protocols/launchpad) as research pointers. The Jupiter page did not return inspectable content through the planning browser; automated endpoint/metric access is unverified. DefiLlama publishes [API documentation](https://defillama.com/docs/api) and distinguishes free/paid access, but a visible dashboard or paid download is not a free API entitlement. P03b must verify each desired series, window, field semantics and chain coverage individually. If unavailable, use a labeled evidence import or UNKNOWN. Do not invent internal endpoints or build a browser dependency just to make an unavailable number appear.

## 6. Research plan and readiness: separate from entry verdict

The `Thesis` records the entry rationale; a passing saved thesis activates manual management under 09. `ResearchPlan`, linked to immutable snapshot and policy hashes, specifies the hypothetical/manual position's conditions. Phase 1 supports this plan and a local journal. It contains:

| Field | Requirement |
|---|---|
| Identity | Plan ID/revision, token, snapshot ID, author/origin, createdAt and availableAt |
| Thesis | Why this candidate, evidence/check references, contradictions, game/style and intended horizon |
| Entry scenario | Hypothetical size/quote, entry rule, expiry, latency/fee/route assumptions; never an order |
| Invalidation | Typed predicate AST, thresholds/windows, evaluation cadence and missing-data behavior |
| Profit realization | Ordered exit legs with explicit triggers and quantity semantics |
| Risk context | Optional portfolio base/as-of, maximum-loss assumption, selected profile; no private keys or credentials |
| Versioning | Freeze at case activation; later edits create successors. If an actual entry predates recorded plan, label retrospective rather than claim precommitment |

`planReadiness = INCOMPLETE | SPECIFIED | UNVERIFIABLE` assesses whether fields/inputs are usable. Entry PASS activates a thesis episode but does not invent missing management parameters. Incomplete plan settings leave dependent management rows UNKNOWN without rewriting the entry verdict. A specified plan is not an endorsed profitable strategy. LLMs may draft cited hypotheses; code validates predicates and quantities. No LLM-derived conviction score maps automatically to an allocation.

The note's weak/medium/strong allocations below 1%, below 3%, or 5% are uncalibrated user examples. A profile using them must define percentage base (e.g. declared portfolio equity), valuation time, available capital, correlated exposure and what maximum loss means. Without an enforceable stop, potential loss can be the full committed amount plus costs. Phase 1 uses requested size and optional manual position records; portfolio construction remains excluded.

### Exit-leg quantities and principal recovery

For Phase 1 exit proposals and later paper evaluation choose `quantityBasis = ORIGINAL_ACQUIRED`. Store atomic acquired quantity q0. Each nonfinal leg uses integer basis points of q0, flooring to token atoms; total percentages must not exceed 10,000 bps. An explicit final `ALL_REMAINING` targets residual quantity. Only recorded fills consume quantities; a proposal does not. Partial fills preserve the unfilled leg amount; idempotent events cannot repeat a filled amount. Fees charged in tokens reduce inventory separately. Quantity conservation includes sold amount, remaining amount, token-denominated costs and documented transfers. See 09 for manual ledger reconciliation.

The user's 40/30/30 example is represented as 4,000 bps, 3,000 bps, ALL_REMAINING for the simple no-token-fee case. It is not a shipped live default. If percentage-of-remaining is ever supported, it must be a different explicit basis; 40%, then 30%, then 30% of remaining sells only 70.6% of original inventory, leaving 29.4%.

Recovering principal means cumulative net proceeds at least total entry cost in the same quote/valuation basis. Ignoring costs, selling fraction f at price multiple m recovers fraction f*m of principal. For f=0.4, break-even recovery needs m=2.5. At 2x it recovers only 80%. Fees, taxes, price impact and gas change this threshold. A chart market-cap multiple cannot substitute for actual estimated or recorded proceeds. Preserve `principalRecovered` as UNKNOWN if cost basis is missing.

An invalidation event is not a filled stop. Future paper evaluation records observation time, trigger time, execution attempt time, route/price evidence, fill assumptions and failure/censoring. If both take-profit and invalidation thresholds fall within one OHLC bar and event ordering is unknown, retain an ambiguous/censored outcome or reported bounds. Do not pick the favorable ordering. Explicit tick/trade evidence or a preregistered conservative simulation rule is needed for a single modeled result, labeled accordingly.

## 7. Phase 1 journal and later outcome evaluation

`JournalEntry` links snapshot, frozen plan revision, mode `HYPOTHETICAL | MANUAL_REPORTED` in Phase 1, event IDs, quantities/costs, evidence, reasons, deviations and optional user-reported emotional notes. Later P12 adds PAPER results with actual simulator provenance. Imported real activity remains MANUAL_REPORTED unless independently reconciled; it is not evidence the app executed a trade. Do not pool hypothetical, paper, manual and independently observed outcomes without mode filters.

Store original intent before results, missed/abandoned opportunities, invalidations, source outages and route failures. Postmortems are new records linked to the original, not rewritten entry explanations. Missing historical execution state remains censored under P08. Screenshots and user statements have provenance but do not become verified receipts. Private journal details are local by default; explicit export applies field-level redaction.

Separate execution round-trip friction O15 from **profit giveback**: a future outcome may compare peak marked PnL to final net PnL under a stated valuation/execution method. A spot-price peak is not achievable liquidation value. Percentage giveback needs a positive peak denominator and complete comparable cost basis; otherwise report amounts/bounds or UNKNOWN.

Win rate alone is inadequate. With p win probability, conditional mean net win W and mean net loss magnitude L, expected net result is `p*W-(1-p)*L`. If W/L exclude costs, subtract costs separately once. At p=0.3, W/L must exceed 7/3 before costs for positive expectation. This arithmetic is explanatory, not a claim the strategy achieves those numbers. Review after twenty trades is a learning cadence, not a valid statistical sample guarantee. Three weeks of paper activity is a user-proposed practice period, not permission to graduate to money automatically.

Future evaluation reports include sample/censoring counts, costs, latency, tail loss, drawdown, concentration of results in a few winners, coverage by chain/style/horizon, plan deviations and uncertainty. Portfolio drawdown requires an actual portfolio path; do not calculate it from unordered independent trade returns. Operator emotion is self-report, not something Gemini diagnoses from a loss.

## 8. Ownership, delivery and acceptance examples

| Increment | Concrete outcome | Dependencies and stopping point |
|---|---|---|
| P03a | C08/C13/C14 completed-candle and causal trend context | P03 market identity/history; baseline advisory; no entry strategy engine |
| P03b | C09/C11/C12/C15/C16 bounded macro/rotation/launch context | Free endpoint/import feasibility, coverage contracts; unavailable series stay UNKNOWN |
| P06 revision | A06 style/persistence and preferred Gemini extractor | P05 evidence, schema/import path; hosted use only under capability/budget/data rules |
| P08 revision | Longitudinal context, time-correct joins and outcomes | Existing snapshots; no invented historical availability |
| P10 revision | Compare v0 selection bias by style; test proposed alternative rules | Preregistered evaluation; no automatic threshold promotion |
| P11 Phase 1 | Linked management checklist, frozen plans, manual position/journal and exit proposals | After shared entry engine; exact lifecycle/15 checks in 09; no execution |
| P12 proposal only | Bounded paper execution/outcome simulator | Separate explicit scope, reliable historical state/cost model and P11; never signing |

P03a/P03b are baseline subpackets before P07. Their features are advisory for entry; selected management predicates may depend on them and become UNKNOWN when missing. P11 completes the user's manual two-checklist Phase 1. P12 remains future scope requiring a separate implementation packet; the current task still edits plans only.

Required implementation examples:

- Candle i is a candidate peak at 12:00, confirms at 12:02, dependencies arrive at 12:03: a 12:01 or 12:02 decision cannot use it. A 12:03 decision can if all other conditions hold.
- Appending tomorrow's candles changes a new analysis but leaves a stored 12:03 decision hash unchanged. Historical recomputation filters by availability, not merely candle timestamp.
- A flat range followed tomorrow by a fall does not retrospectively classify today's range as known distribution.
- DEX share rises while bridge net flow is negative: show both observations without synthesizing “new money entering.” Missing Robinhood data appears in comparison coverage.
- A bridge transfer seen by aggregator and underlying bridge counts once when reconciled; unresolved duplicate identities are not summed.
- A launchpad revenue series cannot satisfy a trade-volume feature. An immature cohort cannot produce seven-day survival.
- A community passes security but fails v0 propagation: report WATCH and the named policy limitation; do not reinterpret ATT-02 in place.
- A saved entry PASS activates its thesis episode even with an incomplete management plan; missing parameters remain UNKNOWN and cannot authorize a positive management proposal.
- A 40% sale at 2x has not recovered principal even before costs. A 40/30/remaining sequence never oversells after rounding or a repeated event.
- Paper profit/invalidation touching the same bar with unknown order is ambiguous; a failed route cannot be a filled exit at the trigger price.

No backend was built or strategy backtested in this planning revision. These examples define observable proofs for the implementation task.
