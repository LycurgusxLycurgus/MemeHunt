# Storage, web retrieval and primary model decisions

Checked against primary documentation on 2026-09-24. These are proposed integration choices, not live account/endpoint tests. Recheck entitlement, versions and response contracts during P00/P06. No service was installed, account created, credit consumed or paid API called in this planning task.

## 1. SQLite now; reconsider Convex when the operating model changes

Recommend SQLite for this release. The immediate workflow is one researcher, one local CLI, inspectable records and offline replay. SQLite runs in the application and supports relational constraints and transactions without another backend service. Its documented deployment limits include concurrent-writer and networked-use considerations; this plan already serializes writes and keeps transactions short. [SQLite deployment guidance](https://www.sqlite.org/whentouse.html)

“Convex CLI” is a way to develop/control a Convex backend, not an embedded database driver. Convex supports local development, including functions and scheduled work, but its documentation distinguishes local development from production cloud or self-hosted deployment. A local development process should not be treated as a production hosting architecture. [Convex local deployments](https://docs.convex.dev/cli/local-deployments)

| Need | SQLite design | Convex alternative |
|---|---|---|
| Paste contract, save and inspect result | In-process SQL/artifacts, existing proposed CLI | CLI/client calls backend functions; additional service boundary |
| Offline reproducible fixtures/replay | Native fit; all inputs local | Feasible with local deployment and self-contained inputs, but different lifecycle |
| Relational evidence lineage and export | Explicit SQL keys/migrations, JSON export | Re-express persistence through Convex schema/functions and exports |
| Always-on scheduled collection | Later local worker with durable job table; machine must run | Managed scheduling/functions can justify a hosted deployment |
| Multiple users and live UI subscriptions | Requires a later server/auth/concurrency design | Strong reason to evaluate Convex's platform as a whole |
| Operations | Backups, local disk, one writer and artifact integrity owned here | Deployment, quotas, authentication and function boundaries also become decisions |

Do not add both databases or generic storage abstractions now. Keep persistence in narrowly scoped repositories, with domain objects independent of SQL rows. A future migration should export versioned entities/manifests, preserve stable IDs and hashes, import transactionally in bounded batches, and compare snapshot/replay results before cutover. Database portability does not mean an automatic driver swap: scheduling, transactions, file storage and retention need deliberate mapping.

Reconsider when measured needs include unattended cloud operation, multiple writers/users, realtime subscriptions or remote access with authentication. Compare Convex and a conventional server database against those actual requirements; PostgreSQL is not a predetermined migration destination. UI plans alone do not require replacing SQLite. No Convex scaffold is needed for the current DD plan.

## 2. TinyFish versus Parallel: choose by capability and measured evidence

The comparison has changed from a simple browser-versus-search distinction. TinyFish now documents Search, Fetch, Agent and Browser APIs. Search/Fetch are free; Agent/Browser are metered. Its current pricing lists Search at 30 requests/minute and 500/hour, Fetch at 150 URLs/minute and 1,000/day. These are documented ceilings, not promised access from this environment. [TinyFish overview](https://docs.tinyfish.ai/), [TinyFish pricing](https://www.tinyfish.ai/pricing)

Parallel provides Search and Extract as well as higher-level research products. Its current pricing advertises $5 recurring monthly credits and up to 5,000 requests/month depending on product mix; search and extraction consume different billable units. Do not interpret the headline as 5,000 arbitrary research jobs. [Parallel overview](https://docs.parallel.ai/getting-started/overview), [Parallel pricing](https://parallel.ai/pricing)

**Proposed selection:** TinyFish Search/Fetch is the first free-first web candidate; Parallel Search/Extract is a viable alternative to benchmark when a free account is available. Pick one initial adapter after a bounded test. Keep imports and direct public HTTP/RSS working independently. Do not implement both by default simply to appear comprehensive. This recommendation follows the user's zero-spend constraint, not an untested claim that TinyFish retrieves better evidence.

Use this collection ladder:

1. Direct supported chain/RPC/provider APIs for quantities, token state and market mechanics.
2. Safe direct fetch/RSS for known public primary URLs.
3. Selected search/extraction API for candidate-scoped origin, representation and public source discovery.
4. Browser automation only for a specifically justified public page that simpler retrieval cannot handle, under a separately enabled budget/capability.
5. A labeled import or UNKNOWN when access fails.

TinyFish Agent/Browser is optional later, not a required hidden fallback. Parallel Task/Responses/FindAll/Monitor is likewise outside the initial retrieval adapter. Autonomous research products must not replace the auditable feature and checklist engine. Provider-generated summaries remain attributed derived evidence, never primary post text or exact on-chain truth.

The supplied affiliate link `https://soydev.link/parallel` did not resolve through the planning browser. Decisions use the official documentation above; no affiliate installation instruction was executed.

### Common retrieval contract

Define two small capabilities, `searchPublicEvidence(request)` and `fetchPublicEvidence(urls)`. Request includes bounded queries/URLs, token/narrative context, language, target window, result/byte ceilings and request ID. Application code chooses scope and budget; the semantic model cannot launch uncontrolled searches.

Response retains query fingerprint, provider/request ID, canonical and final URLs, title, excerpt/full-content distinction, source timestamp if present, retrievedAt/availableAt, content hash, source spans, truncation, access errors, cached/live status if known, and observed usage/cost. A search excerpt's time is not automatically publication time. If extraction is compressed, preserve its derived status and fetch the primary source where required. A source absent from search results is not disproven.

Token websites and fetched text are untrusted. Apply URL/redirect/private-address limits, byte/time caps and redaction. No wallet connections, logins to private chats, form submission, CAPTCHA bypass design or write actions are part of this retrieval contract. Search and browser access do not imply a complete X/Telegram dataset. Store provider failure separately from zero matches.

### P00/P05 benchmark

Use a fixed packet of 12 publicly accessible cases: three primary-origin lookups, three same-name/competing-token cases, three Spanish/English contextual pages, and three known difficult/expired/JavaScript pages. Include expected primary URLs or an explicitly unresolved answer, independently labeled before comparison. Respect free request limits and user-owned account access; the absence of credentials must not block offline work.

Measure exact-source recovery, usable citation spans, wrong-token associations, timestamp accuracy, content completeness, duplication, latency, errors and billed/free usage. Repeat only enough to resolve a material failure. Vendor rankings are not quality evidence. Select the first candidate meeting the required source contracts; report unsupported page classes. If both qualify, prefer the simpler and reliably zero-spend path. An optional later second adapter requires a measured coverage gap.

### Zero-spend enforcement

Distinguish `RECURRING_FREE`, `CREDIT_METERED`, `PAID`, `UNKNOWN_PRICE` per operation, not just per vendor. Reserve request and credit budgets before dispatch. A metered service qualifies for zero monetary spend only when verified free credit covers the bounded worst-case request and paid overage/auto-recharge cannot occur under the configured account policy. Otherwise stop before dispatch. Failed requests/retries can consume credits and must be counted. Unknown usage is not reconciled to zero.

Do not share limits between different products without evidence of provider billing semantics. Cache reused macro/origin evidence with its timestamps and permitted retention; fresh quotes use their own short TTL. Free quota exhaustion returns an inspectable source failure, without silently buying more access or switching providers.

## 3. Gemini 3.5 Flash-Lite, high thinking, as preferred primary extractor

Accept the user's proposed primary model. Google's model page identifies `gemini-3.5-flash-lite` and supports structured outputs and thinking. Its thinking table explicitly includes `high`. These are documented capabilities; suitability for this corpus still needs a labeled test. [Model reference](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite), [Thinking reference](https://ai.google.dev/gemini-api/docs/thinking)

Current Standard pricing lists a free tier for this model. The paid rate is $0.30 per million input tokens and $2.50 per million output tokens including thinking; grounding is separately constrained/priced. This is a dated feasibility observation, not authorization for paid fallback. [Google pricing](https://ai.google.dev/gemini-api/docs/pricing)

Keep application settings distinct from SDK syntax:

```yaml
semantic:
  preferredProvider: google
  preferredModel: gemini-3.5-flash-lite
  preferredThinking: high
  mode: import                 # bootstrap until credentials/free access are verified
  automaticModelFallback: false
  externalPacketClass: public-redacted
  toolsEnabled: false
```

These are proposed application fields. P06 translates them to the exact supported API/SDK configuration after reading the user's forthcoming model document and current official reference. Do not mix configuration names from different Google API surfaces. Select a supported request/structured-output path and record its version. Do not silently substitute Gemini Flash, an older Lite model, a different thinking level or a different provider.

Once free access and the extraction evaluation pass, the configured main workflow uses hosted Gemini/high. Import remains an explicitly selected operational mode for no credentials, exhausted quota, private evidence or reproducible offline work. A blocked hosted run records the reason and can export its packet; it does not secretly generate a substitute result. Paid mode requires a later nonzero user-selected budget. No model document is needed to finish this architecture revision; it is an explicit integration prerequisite.

The model receives bounded evidence and returns narrative/style classifications, origin relationships, post roles and supported contradictions under [02's schema](02-contracts-and-policy.md). It does not calculate portfolio allocations, choose trading actions, fetch uncontrolled URLs, set thresholds or decide PASS. Thinking level is not confidence. Fresh high-thinking runs can differ; offline replay uses frozen validated observations.

### Evaluation and data handling

P06 uses a small, independently labeled multilingual corpus with satire, ambiguous tickers, duplicated calls, conflicting origins, Spanish slang, prompt injections, missing timestamps and competing contracts. Evaluate schema validity, evidence entailment, unsupported claims, post-role/style classification and UNKNOWN behavior separately. Define acceptance tolerances before inspecting results; report counts and reviewed failures rather than a single opaque accuracy. A valid citation that does not support a claim is still a semantic failure. High thinking remains the preferred baseline; any comparison with lower levels is an evaluation experiment, not silent runtime routing.

Save provider/model and returned version metadata, requested/resolved settings, input/prompt/schema hashes, validated output, bounded raw response, usage, latency and validation errors. Save concise evidence rationales, not a requirement to expose private reasoning. One schema-repair attempt is allowed under the same packet/budget; it cannot add evidence. A changing stable alias can change future results, so preserve returned version information where supplied and evaluate changes before adoption.

Google's pricing page distinguishes free versus paid data-use treatment. Consequently, start external packets with public, permitted, redacted evidence; private Telegram exports, personal wallet associations and journals are excluded by default. Provider privacy terms and source permissions must be checked before enabling a private packet. This restriction belongs at packet construction for every external provider, not only Gemini. Read-only RPC keys and session secrets never enter semantic packets. The local database is not automatically encrypted; use OS access controls and deliberate backup/export handling rather than claiming it is a secret vault.

## 4. Implementation decision record

| Decision | Current state | Evidence needed before activation |
|---|---|---|
| SQLite/artifact store | Recommended, unchanged | Driver/runtime compatibility, backup/restore and transaction tests in P00/P01 |
| Convex | Deferred alternative | Actual cloud/multiuser/always-on requirement and concrete migration design |
| TinyFish Search/Fetch | First web candidate | Free authentication, source-contract benchmark, rate/error handling |
| Parallel Search/Extract | Alternative candidate | Verified credit/overage policy and same benchmark if needed |
| Browser/research agents | Deferred | Specific unmet source need and bounded authorized cost/capability |
| Gemini Lite/high | User-preferred primary semantic provider | Forthcoming document, exact SDK configuration, free access and labeled quality proof |
| Import/local mode | Explicit alternatives | Import validation required; local runtime only if selected and evaluated |

No current technology choice requires creating a new service, workflow engine, autonomous agent or UI. The end product remains an observable contract-to-checklist backend.
