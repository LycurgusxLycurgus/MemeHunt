# Domain contracts, checklist, and verdict policy

These contracts are normative for the proposed v1 entry checklist and shared evidence spine. [09](09-two-checklist-lifecycle.md) defines the separate management checklist required to complete Phase 1. Encode both as runtime schemas and generated/inferred types. Illustrative JSON is labeled; enum semantics and rule precedence are requirements. Entry verdict aggregation must not be reused to infer a management action.

## 1. Identity and units

`ChainRef` contains `namespace`, `reference`, `environment`, and a registry key. EVM uses namespace `eip155` and decimal chain ID strings; Solana uses namespace `solana` and a registry-verified genesis identity. Display aliases such as `bsc` and `solana` are not primary keys. `TokenRef = ChainRef + normalizedAddress`. Pools, wallets, and transactions are chain-qualified too. A bridged representation is a separate token linked by evidence, never merged by ticker.

All raw token amounts are base-10 integer strings at API/storage boundaries and bigint inside arithmetic. A token amount carries token reference and decimals. USD/quote values use decimal strings and a valuation source/time. Ratios use decimal strings in [0,1] unless explicitly signed or unbounded. Basis points are integer fields. No NaN, Infinity, sentinel -1, or floating-point token balances.

Time is ISO-8601 UTC at boundaries, epoch milliseconds internally where useful. Durations are explicit seconds. Intervals are half-open `[start,end)`. Blockchain positions include network, block/slot number, block hash when obtainable, finality/commitment, and transaction/log/instruction indices where relevant.

## 2. Analysis request

```ts
type AnalyzeRequest = {
  input: string;
  chain?: string;
  size?: { amount: string; currency: "USD" | string };
  horizonSeconds?: number;
  policyId: string;                  // default: research-screen-v0
  depth: "baseline" | "full";
  budgetProfile: string;             // default: free-local
  semanticMode: "off" | "import" | "local" | "hosted";
  evidenceBundleIds: string[];
  idempotencyKey?: string;
};
```

Currency codes other than USD must resolve through a configured quote-asset registry; arbitrary user strings are not prices. Reject nonpositive/nonfinite size, invalid horizon, conflicting URL/chain identifiers, malformed addresses, unknown policies, and path traversal. Context omitted in a bare-contract request is represented as missing; it is not quietly replaced with a suggested trade size.

The user may save defaults with a separate explicit config command. Each resolved request stores `inputOrigin` for parameters: argument, saved default, or policy default. Historical `asOf` is not accepted by live analysis in v1. Offline historical evaluation uses a saved evidence manifest and its actual availability timestamps; it cannot ask current APIs to pretend to know the past.

## 3. Evidence, observation, feature, and check are different objects

### EvidenceRecord

Required fields: `id`, `sourceId`, `sourceType`, sanitized request/query fingerprint, source record IDs, `retrievedAt`, `availableAt`, `contentHash`, `adapterVersion`, `accessMode`, `retentionClass`, and `scope`. Optional fields: source URL, publication/event time, block context, artifact path, excerpt spans, licensing/retention expiry, parent evidence IDs, original provider revision, and redaction/tombstone status.

`accessMode` is `PUBLIC_API | FREE_ACCOUNT | USER_IMPORT | LOCAL_DERIVED | PAID_API`. USER_IMPORT is provenance, not independent verification. A screenshot or pasted quote must retain the supplied URL/time and verification state; importing it cannot turn a claim into an authenticated platform API event.

`scope` includes query, time range, networks, source/channel set, page limit, fetched count, pagination completion, filters, and capture gaps. Keep counts and amounts in raw evidence if allowed. A URL alone does not preserve what the system saw.

### Observation

Required fields: `id`, subject reference/type, semantic field name, typed value or null, units, evidence IDs, `eventAt?`, `observedAt`, `availableAt`, method/version, and quality state. Observations say what a source reported or a decoder observed. They do not claim the source is infallible.

Quality contains:

- `state`: `KNOWN | MISSING | STALE | CONFLICT | UNSUPPORTED | TRUNCATED | INVALID`.
- `reasonCode` and bounded explanation.
- `coverage`: population scope, completeness status, sampled fraction only when denominator known.
- `provenanceGrade`: `DIRECT | CORROBORATED | SINGLE_SOURCE | INFERRED | USER_SUPPLIED`.
- `confidenceBasis`: concrete evidence or a named evaluated classifier; no arbitrary probability from the extractor.

### FeatureResult

Required fields: feature ID/version, subject, window/context, applicability, value/unit, observation IDs, method, quality, and limitations. `applicability = APPLICABLE | NOT_APPLICABLE | UNRESOLVED`. A zero value requires known data. A truncated dataset may yield a valid lower bound or descriptive sample statistic; it cannot silently satisfy a rule requiring the complete population.

### CheckResult

```ts
type CheckResult = {
  checkId: string;
  checkVersion: string;
  pillar: "ONCHAIN" | "ATTENTION" | "SOCIAL" | "SHARED";
  role: "HARD_GATE" | "REQUIRED_EVIDENCE" | "OPPORTUNITY" | "ADVISORY";
  required: boolean;
  status: "PASS" | "FAIL" | "UNKNOWN" | "NOT_APPLICABLE";
  reasonCode: string;
  measured: Record<string, unknown>;
  threshold: Record<string, unknown> | null;
  featureRefs: string[];
  evidenceRefs: string[];
  explanation: string;
};
```

Feature quality and check status are orthogonal. A KNOWN concentration of 60% can produce FAIL; MISSING concentration produces UNKNOWN. A feature omitted by a short-circuit produces UNKNOWN with `SKIPPED_DEPENDENCY`, not NOT_APPLICABLE. Unknown venue applicability is UNKNOWN, not exemption from security.

## 4. Quality rules and time coherence

Required freshness limits are policy data. Proposed screening operational defaults: identity/control and holder snapshot age ≤300 seconds; quotes ≤30 seconds when verdict finalized; social search retrieval ≤900 seconds; latest fully closed attention bucket ≤900 seconds. These are engineering freshness defaults, not tested market-optimal thresholds. An imported historical corpus can still be described, but cannot pass a current freshness check outside its declared scope.

Freshly fetching an old source does not reset event freshness. Conversely, a token's creation date does not become stale because the event is old. Each feature declares whether freshness concerns state time, collection time, or evidence availability.

For a derived feature, dependencies must cover the required interval with comparable query/channel definitions. If the denominator is zero or unknown, output undefined plus the exact reason. Do not replace the denominator with an epsilon and present the ratio as observed. New-token series use token-age-aware applicability: absent precreation periods are not zero-attention observations.

Conflicting observations are retained. Prefer direct pinned chain state for contract values when scopes match; differences from different times are temporal changes, not contradictions. Unresolved material conflict yields UNKNOWN. Do not average a “honeypot yes” and “honeypot no” vendor response into safety.

## 5. Two named policies, one honest default

The default `research-screen-v0` is a conservative **research screening policy**, not a verified execution or entry policy. It can use supported route quotes and explicit model assumptions. Its PASS is always labeled `RESEARCH_ELIGIBLE`; execution evidence remains QUOTED or SIMULATED in the output.

`execution-verified-v0` adds mandatory stateful buy/approve-if-needed/sell simulation for the requested size and supported venue. It is available only after the relevant simulator is certified. A QUOTED result cannot pass its simulation requirement. Neither policy submits a transaction.

Both policies use the same feature contracts and substantive security gates. Free access affects evidence availability, not the meaning of a check. Do not create a hidden “free pass” threshold. Users can author explicit policy variants, each with a new hash and visible identity; no runtime LLM-generated threshold is allowed.

### Required policy configuration

Policy manifests specify: supported contexts/game types; venue-specific control allowlists; freshness/skew limits; required holder coverage; entry/exit and round-trip loss limits; maximum fees/taxes; direct control concentration limit; acceptable liquidity-control mechanisms; evidence minimums; opportunity checks; and advisory features. Hash a canonical representation.

Mechanical loss/concentration tolerances are user-owned risk parameters. Supply a named **illustrative research fixture profile** for tests, never silently activate its numeric limits for live use. In a live run without a selected risk profile, affected checks are UNKNOWN (`POLICY_PARAMETER_MISSING`), producing an informative report and FAIL/INSUFFICIENT_DATA. This makes configurable risk management real instead of embedding arbitrary trading advice in code.

The free-local operational budget is different: its zero paid-call limit is the user's confirmed preference and is active by default. API request/page caps and evidence minimum sample sizes are engineering settings documented below.

## 6. Initial checklist

This table defines the initial evaluators. Feature IDs are defined in the registry. PASS always also requires acceptable quality for the feature's intended use. Unless shown conditional, each row applies to all accepted token analyses. Research-depth features do not become hidden launch requirements.

| Check | Role | Inputs | PASS condition / failure behavior |
|---|---|---|---|
| ID-01 identity | HARD_GATE | O01 | Chain and supported token identity verified; known wrong object FAIL; ambiguity is a request error before token verdict |
| CTX-01 context | REQUIRED_EVIDENCE | C01 | Positive size, horizon, selected policy risk parameters and quote asset resolved; missing => UNKNOWN |
| CAP-01 support | REQUIRED_EVIDENCE | C02, O08 | Requested chain/token/venue capabilities supported at the level required by policy; unsupported required path => UNKNOWN/UNSUPPORTED_CAPABILITY |
| SEC-01 supply control | HARD_GATE | O03 | No mint/supply change authority outside certified venue policy allowlist; proven disallowed authority FAIL; incomplete control inspection UNKNOWN |
| SEC-02 transfer control | HARD_GATE | O04, O06 | No active freeze/pause/blacklist/confiscation mechanism disallowed by policy; unknown code/extension behavior UNKNOWN |
| SEC-03 upgrades | HARD_GATE | O05 | Nonupgradeable or explicitly approved constrained upgrade mechanism; unresolved proxy/control path UNKNOWN; disallowed upgrade authority FAIL |
| SEC-04 transfer economics | HARD_GATE | O07 | Observed/configured transfer taxes/fees within risk profile and no unresolved mutable fee mechanism; excessive/disallowed => FAIL |
| SEC-05 venue provenance | HARD_GATE | O08 | Factory/program, pool/mint binding, deployment version, and migration state verified; proven fake binding FAIL; unsupported version UNKNOWN |
| LIQ-01 liquidity control | HARD_GATE | O09 | Supported policy can account for withdrawal control through the horizon; removable exposure within risk profile; unverified locker/position UNKNOWN |
| EXE-01 entry/exit route | HARD_GATE | O10, O11 | Fresh supported quote for entry and acquired-quantity exit, correct token/quote orientation, usable route; provider failure UNKNOWN; proven no executable liquidity FAIL |
| EXE-02 size feasibility | HARD_GATE | O13–O16 | Entry impact, exit impact, costs, and loss model within configured limits; missing limits or model inputs UNKNOWN |
| EXE-03 simulation | ADVISORY by default; HARD_GATE in execution-verified | O12 | Supported stateful simulation succeeds; setup errors UNKNOWN; supported reproducible token restriction FAIL; quote-only is UNKNOWN |
| OWN-01 holder evidence | REQUIRED_EVIDENCE | O17, O18 | Coverage sufficient for the requested top-owner/bounds check, owner aggregation and exclusions valid; no full-population claim from a top-account sample |
| OWN-02 direct control | HARD_GATE | O19, O20 | Verified largest economic owner/directly proven control share below configured maximum; lower bound exceeding max FAIL; uncertain bound spanning max UNKNOWN |
| MKT-01 observable market | REQUIRED_EVIDENCE | O02, O28 | Usable market provenance, price/quote valuation, and activity interval; FDV is not required to be market cap |
| NAR-01 evidenced narrative | REQUIRED_EVIDENCE | A01, A02 | At least one retrievable relevant evidence item supports a specific narrative/game classification; unsupported asserted origin UNKNOWN |
| NAR-02 source relationship | OPPORTUNITY | A03, A04 | Relevant external origin/event evidence, or documented crypto/community origin for those game types; known mismatched source FAIL |
| NAR-03 understandable claim | OPPORTUNITY | A05 | Structured explanation names the narrative and token relationship with evidence, no unresolved basic semantic ambiguity; rubric FAIL otherwise |
| CAN-01 candidate competition | REQUIRED_EVIDENCE | A09, A10 | Bounded competitor search recorded; comparisons explicitly restricted to discovered set; empty failed search UNKNOWN, not sole winner |
| CAN-02 representation | OPPORTUNITY | A11, A14 | Token is observed leader by bound explicit-mention share, or independently supported origin relationship; ties/contested associations FAIL/WATCH, inadequate sample UNKNOWN |
| ATT-01 measurable attention | REQUIRED_EVIDENCE | A15, A16, A17 | Declared corpus has at least 10 relevant original/deduplicated posts from at least 3 independent authors within the configured interval; below sample minimum UNKNOWN |
| ATT-02 propagation support | OPPORTUNITY | A18 or S10 | Comparable two-window qualified attention is increasing, OR three independently evidenced communities participate in-window; known neither FAIL; unavailable both UNKNOWN |
| SOC-01 identity binding | REQUIRED_EVIDENCE | S01 | Official-account claims clearly labeled verified/claimed and contract mentions disambiguated; no minimum requirement for an official account to exist |
| SOC-02 duplication/provenance | REQUIRED_EVIDENCE | S02–S06 | Post IDs/copies deduplicated, author/source scope stated, paid/price/coordinated labels distinguished; undisclosed classifier/corpus gaps UNKNOWN |
| SOC-03 independent participation | OPPORTUNITY | S03, S10 | At least 3 authors from at least 2 evidenced source communities after known copies/shared-source collapse; known concentrated corpus FAIL; unresolved independence UNKNOWN |
| DAT-01 current evidence | REQUIRED_EVIDENCE | C03, C04 | All required checks use fresh observations with acceptable time coherence; stale dependencies UNKNOWN |
| DAT-02 semantic validity | REQUIRED_EVIDENCE | C05 | Required extraction/import schemas, evidence refs, and consistency checks pass; invalid output UNKNOWN |
| DAT-03 material conflicts | REQUIRED_EVIDENCE | C06 | No unresolved conflict in a dependency of a required check; conflict UNKNOWN |
| ADV-01 control topology | ADVISORY | O21–O25 | Descriptive evidence only in v0; never infer named ownership or a hard reject from weak cluster associations |
| ADV-02 integrity | ADVISORY | O26–O30 | Report pattern flags, method, coverage and alternatives; new detector cannot silently become a gate |
| ADV-03 deeper opportunity | ADVISORY | A06–A08, A12–A13, A19–A30 | A06 includes baseline style/persistence hypothesis; show remaining features only when their data requirements are met |
| ADV-04 actor dossier | ADVISORY | S07–S09, S11–S20 | Historical/identity limitations explicit; no invented actor reputation |
| ADV-05 lifecycle/regime | ADVISORY | C07–C16 | Baseline descriptive chart/macro/rotation context under [07](07-round-two-lessons-and-contracts.md); historical lifecycle and fitted regime labels remain later; no hidden score multiplier |

The attention and social sample minima are provisional data-quality choices, not evidence that ten posts or three authors predict returns. Candidate ranking with fewer than ten bound original token mentions in the competitor set is UNKNOWN unless a verified source relationship satisfies the alternative. “Independent” means independently evidenced under the recorded source-grouping method, not proof of unrelated humans. Revision 0.2 preserves v0 ATT-02: stable communities may fail its growth/propagation screen. A06 style labels do not waive it. A later style-specific policy requires explicit predicates, versioning and P10 evaluation as specified in [07](07-round-two-lessons-and-contracts.md).

NOT_APPLICABLE is permitted only from a known applicability predicate. For example, EVM proxy-slot inspection is not applicable to a standard Solana mint, but Solana program/authority checks still apply; security coverage is not waived. Game type changes which evidence can support an opportunity, not the immutable safety gates.

## 7. Verdict derivation and precedence

Evaluate every required applicable check whose dependencies are available. Preserve all outcomes. Derive the headline in this order:

```text
1. A required HARD_GATE is FAIL:
     FAIL / REJECTED
2. No hard failure, but a required path has UNSUPPORTED_CAPABILITY:
     FAIL / UNSUPPORTED
3. No above condition, but any required applicable check is UNKNOWN:
     FAIL / INSUFFICIENT_DATA
4. No above condition, but any required OPPORTUNITY check is FAIL:
     FAIL / WATCH
5. All required applicable checks are PASS:
     PASS / RESEARCH_ELIGIBLE
```

Required evidence checks use PASS/UNKNOWN; they do not label missing data as a detected token defect. A missing numeric risk profile can coexist with a known disallowed freeze authority: REJECTED wins, and missing settings remain in the checklist. Advisory failures/unknowns remain visible but do not change the default verdict. The simulation check becomes required only under execution-verified-v0.

Return an ordered reason list, primary reason, and all material limitations. Sort checks by stable ID; use deterministic tie ordering. Do not count NOT_APPLICABLE in coverage denominators. Required-check coverage is `known required applicable checks / all required applicable checks`; report the numerator and denominator. This is evidence completion, not probability of correctness.

Pillar status uses the same local principle: failed hard gate => FAIL; any required unknown => UNKNOWN; failed opportunity => FAIL; otherwise PASS. Overall PASS cannot mask an UNKNOWN required pillar. Free-first means more honest unknowns, not a different aggregation rule.

## 8. Snapshot contract

Required fields:

```text
schemaVersion, snapshotId, runId, parentSnapshotId?, analysisKind
token, resolvedRequest, collectionStartedAt, collectionCompletedAt, decidedAt
policy { id, version, hash, calibrationStatus }
versions { application, registry, adapters, featureSet, semantic }
evidenceManifest { ids, hash, blockContexts, knowledgeCutoff, retentionStatus }
collectionSummary { sourceScope, errors, truncations, budget, temporalSkew }
features[], checks[], pillarSummaries[]
verdict { binary, classification, primaryReasonCode, reasonCheckIds[] }
executionEvidenceLevel, coverage, limitations[], thesis?
contentHash
```

`analysisKind` distinguishes `LIVE`, `OFFLINE_REPLAY`, `POLICY_REEVALUATION`, `RECONSTRUCTED_HISTORY`, and `FIXTURE`. A synthetic fixture is conspicuously marked. Schema versions are independent from policy/model versions. Consumers reject unknown breaking schema versions rather than guessing.

Create the deterministic decision hash from canonical request/context, evidence and semantic manifests, feature/policy versions, computed values, and checks. Exclude incidental run ID, wall-clock render time, and nonsemantic JSON key order. Stable offline replay must produce the same decision hash. File/snapshot IDs can still be unique run identifiers.

## 9. CLI contract

Proposed commands, to be implemented in delivery order:

```text
dd analyze <address-or-supported-url> --chain <alias> --size-usd 500 --horizon 6h
dd analyze <address> --chain robinhood --json --budget free-local
dd show <snapshot-id> --json
dd explain <snapshot-id> --checklist
dd explain <snapshot-id> --check EXE-02 --evidence
dd replay <snapshot-id> --offline
dd reevaluate <snapshot-id> --policy <id>
dd refresh <snapshot-id>
dd diff <snapshot-a> <snapshot-b> --json
dd capabilities --chain robinhood --json
dd doctor --offline
dd doctor --live --budget free-local
dd evidence import <bundle.json>
dd semantic export <run-or-snapshot-id> --out <packet.json>
dd semantic import <packet-id> <observations.json>
dd config validate
```

`semantic export/import` supports a Codex-friendly evidence packet without requiring a paid inference API. A user/agent reads only the packet and returns observations against its evidence IDs. The importer validates the packet hash, model/tool provenance if supplied, references and schema; it creates a new analysis revision. Missing provenance is labeled USER_SUPPLIED, not a model evaluation result. Local inference uses the same schema. Hosted Gemini/high may be enabled in free-local only after verified free entitlement, public-packet handling and quality checks in [08](08-technology-decisions.md); import is the bootstrap mode. No silent provider/model fallback.

`--json` emits exactly one JSON document to stdout. Progress and diagnostics go to stderr. No colors, prompts, terminal escapes, or prose surround JSON. Human rendering uses the same finalized snapshot. Command arguments shown here are examples; placeholder addresses are never sent to providers.

Exit codes: `0` command completed and returned a valid result, including FAIL verdicts; `2` invalid/ambiguous input; `3` run could not be finalized because of system/storage error; `4` requested saved record not found. Optional `--fail-on-verdict` returns `10` for a finalized binary FAIL. Provider timeouts with a saved partial verdict do not become process crashes.

Concise human example, hypothetical fixture only:

```text
FAIL — INSUFFICIENT_DATA
Token: <address> | Chain: Robinhood | Snapshot: dd_example
Context: $500 / 6h | Policy: research-screen-v0
On-chain: UNKNOWN   Attention: PASS   Social: PASS
Execution evidence: QUOTED
Reason: Holder coverage cannot establish the configured control limit.
Known: supported route quoted; narrative and sources linked.
Missing: sufficient holder snapshot; requested-size simulation (advisory).
Inspect: dd explain dd_example --checklist
```

There is no LLM-generated “BUY” line. An optional explanatory paragraph can restate cited findings but cannot alter the stored verdict or invent metrics. If explanation validation fails, use deterministic templates.

## 10. LLM extraction contract

Semantic tasks are bounded: narrative summary/game type; relationship to an external event; token-narrative association proposals; post role (`CALL`, `NEWS`, `JOKE`, `WARNING`, `RETROSPECTIVE`, `PRICE_ONLY`, `OTHER`, `UNCLEAR`); contextual meaning; and supported contradictions.

Every output claim includes `claimId`, `claimType`, `subjectIds`, structured value, evidence references with spans, alternative interpretations, and `support = EXPLICIT | INFERRED | INSUFFICIENT`. Numeric fields are limited to rubric counts that code can verify; the extractor does not invent cultural-recognition percentages, bot probabilities, reach, price predictions, or confidence scores.

Game taxonomy: `EMERGENT_VIRAL`, `ESTABLISHED_MEME`, `EVENT_NEWS`, `PERSONALITY`, `COMMUNITY`, `CRYPTO_META`, `CREATOR`, `DERIVATIVE`, `MIXED`, `UNKNOWN`. Allow multiple supported associations and uncertainty; do not force every coin into exactly one causal story.

Attention style is separate: `SPARK | WAVE | COMMUNITY | MIXED | UNKNOWN`, with cited persistence/renewal and expiry hypotheses under A06. It is not a price prediction or measured lifespan. Preferred primary extraction is Gemini 3.5 Flash-Lite at high thinking; the exact SDK configuration awaits the user's model document and P06 verification. Store requested/resolved settings; model availability or schema failure yields explicit UNKNOWN rather than an invented substitute.

Store model identifier/digest where available, runtime/provider, prompt version/hash, input manifest hash, generation parameters, raw output, validated output, validation failures, and cost. A local model is an optional execution path with hardware/quality prerequisites, not an assumed free source of equivalent intelligence. Imported observations make the complete loop usable without installing a model in this planning task.

Run deterministic checks for unknown IDs, invented competitor addresses, quotes absent from source text, event dates after the run cutoff, unsupported numerical claims, and inconsistent enums. Citation existence does not prove entailment; a labeled evaluation set and targeted human review assess that separately. At most one bounded schema-repair attempt uses the same evidence packet; failure returns UNKNOWN. No autonomous web/tool loop.

## 11. Thesis and invalidation

A thesis is a structured explanation, not a trading position. It may be absent in failed/incomplete diagnostic entry runs; saving a passing entry result in Phase 1 also saves its evidence-grounded thesis and activates the linked management case under [09](09-two-checklist-lifecycle.md). It contains a causal hypothesis, supporting/contradicting check IDs, game/style associations and typed conditions. Missing management-specific conditions remain explicit unresolved fields and do not rewrite the entry verdict.

Allowed predicates reference feature/check IDs and typed comparators (`lt`, `lte`, `gt`, `gte`, `eq`, `all`, `any`) plus a window and, where needed, consecutive-window count. Arbitrary code/SQL/expression evaluation is prohibited. LLM proposals must resolve to allowlisted predicates and policy parameters before activation; otherwise they remain prose hypotheses.

Each condition evaluates TRUE/FALSE/UNKNOWN. Missing updates are not “thesis still active.” Entry explanation may be FORMING or SUPPORTED_AT_SNAPSHOT; management state is exactly VALIDATED, WEAKENING, INVALIDATED or UNVERIFIABLE under [09](09-two-checklist-lifecycle.md), with expiry as a reason. Phase 1 includes manual validation/invalidation and exit proposals; continuous monitoring and execution remain deferred. [07](07-round-two-lessons-and-contracts.md) specifies ResearchPlan/journal/quantity contracts. Plan readiness is separate from entry eligibility; incomplete management parameters cannot silently become a positive management proposal.

## 12. Storage and idempotency detail

Core tables: `chains`, `tokens`, `markets`, `runs`, `evidence`, `observations`, `semantic_extractions`, `narratives`, `token_narrative_links`, `features`, `checks`, `snapshots`, and `snapshot_evidence`. Research-depth tables add `actors`, `actor_identities`, `relationship_edges`, `calls`, `outcomes`, and `collection_jobs` when those packets are implemented.

Unique keys use chain-qualified IDs. Source event uniqueness is `(source, sourceRecordId, revision)`; trades also retain transaction plus log/instruction index. A run idempotency key maps to an exact normalized request hash: same key/same request returns the existing run; same key/different request is rejected. Collection restart uses source cursors and content hashes to avoid double ingestion.

Normalized data is append-only by revision. Materialized latest views may update, but snapshots pin exact observation IDs. Reevaluation uses frozen semantic outputs; requesting a new extraction changes semantic revision and cannot masquerade as deterministic replay.

P11 adds `research_cases`, `thesis_episodes`, `research_plans`, `position_records`, `position_events` and `journal_entries`; reuse snapshots/features/checks with checklistKind and required management references rather than copying evidence. The management result and ledger revision must participate in its decision hash. Its 15 MG checks and total proposal precedence are defined in 09. Optional position records are not a portfolio or custody subsystem.
