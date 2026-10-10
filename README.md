# Token entry and thesis CLI

Assess a supplied contract against saved trade size, holding horizon and risk settings. Results explain thesis support, contradictions and unknowns in a readable checklist. Eligible entries freeze a thesis; later analyses of the same contract assess that saved thesis. This backend does not trade or monitor in the background.

## Quick start

Requires Node.js 24 or later. Use `--partial` for an explicit RPC+DEX pass that needs no provider keys. A full available-source pass also uses TinyFish Search/Fetch and Gemini; it requires both provider keys and explicit per-run approval.

```powershell
npm ci
npm run typecheck
npm test
node dist/src/cli.js capabilities
node dist/src/cli.js profile options
node dist/src/cli.js analyze FIXTURE_TOKEN --chain solana --bundle examples/entry.json
node dist/src/cli.js analyze FIXTURE_TOKEN --chain solana --bundle examples/reassessment.json
node dist/src/cli.js analyze <real-address> --chain solana --partial
node dist/src/cli.js show <snapshot-id>
node dist/src/cli.js replay <snapshot-id>
node dist/src/cli.js reassess <case-id> --bundle examples/reassessment.json
node dist/src/cli.js thesis successor <case-id> --file thesis.json --basis continue
node dist/src/cli.js diff <snapshot-a> <snapshot-b>
node dist/src/cli.js backup .data/backup-001
node dist/src/cli.js doctor
npm run cli -- 3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump
```

The bare CA is an alias for `analyze`. The first interactive run offers saved settings and asks explicitly before TinyFish/Gemini calls; subsequent runs reuse the settings. In automation add `--full` to approve hosted calls or `--partial` for public RPC/DEX only. The executable loads `.env` from the project root. Solana is inferred only from a valid decoded key; EVM addresses require a saved chain choice or `--chain bsc|base|robinhood`.

The advisory update is pending acceptance: terminal review found that O28 still trusts normalized baseline data rather than reconstructing its exact DEX source. Do not rely on advisory completeness until that provenance defect and its regression are fixed; see the canonical collaborator handoff.

Add `--advisory` to a live Solana run for bounded public historical collection, for example:

```sh
npm run cli -- analyze 3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump --chain solana --full --advisory --entry
```

The opt-in pass retains finalized account movements, mint-bound completed hourly pool candles, BTC/ETH/SOL USD candles, matching completed daily Solana/BSC/Base DEX volumes, and exact-token paid orders/boosts. It inventories all 50 advisory metrics in `details.advisory` and reconstructs them from retained receipts before persistence. Historical observation times remain distinct from retrieval times. Token movements do not establish sales, wallet identity or bots; DEX activity does not establish bridge capital flow; a paid listing does not establish organic promotion. Missing history, undefined ratios and absent calibration retain explicit unresolved causes.

Fresh opt-in snapshots use `research-screen-advisory-v1`. An advisory group passes only when every declared metric is measured; this means complete descriptive coverage, not favorable investment quality. The 27 required entry gates and historical policy replay remain unchanged. `--partial --advisory` requires no hosted-provider keys; `--full --advisory` also qualifies the available social sources through the existing approved hosted pass.

Output is human-readable by default. Add `--json` for the full machine document. Save the printed snapshot ID to inspect the same frozen assessment offline:

```powershell
$snapshotId = Read-Host 'Snapshot ID'
node dist/src/cli.js show $snapshotId --db .data/live.sqlite
node dist/src/cli.js replay $snapshotId --db .data/live.sqlite
$olderSnapshotId = Read-Host 'Older snapshot ID'
$newerSnapshotId = Read-Host 'Newer snapshot ID'
node dist/src/cli.js diff $olderSnapshotId $newerSnapshotId --db .data/live.sqlite
```

`show`, `replay`, `diff`, and `backup` use stored data and make no provider requests. Replay recomputes the checklist from the saved input; it does not refresh live evidence. A new `analyze` call collects new evidence. For a token with a tracked thesis, it reassesses that case unless `--entry` is supplied.

For Solana, choose one mode on every analysis. `--partial` explicitly requests RPC and DEX only, even when optional keys are set. `--full` explicitly approves a bounded TinyFish Search/Fetch and Gemini pass and is required for non-interactive runs. An interactive run with both keys and no mode presents the full pass first and asks for `y` or `yes`; Enter or any other answer cancels without collecting or saving. If either key is missing, it stops and prints secure setup commands instead of falling back. To decline hosted sources and continue, rerun with `--partial`. A non-interactive run without either flag fails with guidance; it never silently saves a partial result.

A successor must say how its sell steps relate to sales already made. `--basis continue` keeps counting sales under the same step IDs, and percentages stay shares of the original quantity. `--basis fresh-start` starts a new book: percentages become shares of what you hold at the successor's time, and only later sales count. Without `--basis` the successor is refused. A successor saved before this choice existed blocks sized proposals until you save a new successor with a basis. Its invalidation is still reported, and saved theses are never rewritten.

Management (`thesis-management-v7`) proposes a sale amount only with exact exit proof. When you hold a position, every reassessment lists the quotes it needs in `exitQuotes`. One is for selling everything you still hold (`REMAINING_POSITION`), which MG-03 needs before the thesis can count as validated. The other is for the next due sell step (`CANDIDATE_LEG`), which MG-15 needs before a DCA-out amount is proposed. While you are holding and no step is due, MG-15 instead asks for an early quote for the next planned step (`NEXT_LEG`), so a hold result can be fully known too; it reports whether that step could be sold now without changing the hold decision. Each request names the token, case, episode, position, step, exact atomic quantity, decimals and an execution-basis fingerprint. Answer a request by adding a matching proof to the next reassessment bundle's `exitProofs`; the fingerprint changes whenever the position records it was made for change. Set the profile's `exitProofLevel` (`QUOTED` or `SIMULATED`) and `risk.maxExitImpactBps`; without both, no sale is confirmed. A proof must be current at the cutoff and cite evidence in the bundle. It must also come from a supported quote adapter: none is certified yet, and only the synthetic fixture adapter exists. Quotes typed into a `USER_IMPORT` bundle count only for `HYPOTHETICAL` positions and are labeled "scenario quote, not verified". A blocked route or a price impact over the limit fails the step, and proofs that disagree are reported as unknown. Every result carries a `position` block with mode, units, decimals, remaining quantity and known cost, or states that there is none. No result claims profit or recovered principal, and an exit review never promises a fill.

## Optional inputs

Settings are saved in `.data/config.json` (or `--config`; a custom `--db` defaults configuration beside that database). The requested starter uses **$25 and six hours**, transfer fee limit 1%, entry impact 2%, exit impact 3%, round-trip friction 10%, direct control 10%, removable liquidity 10%. These are editable, uncalibrated screening settings, not optimal trading parameters. Round-trip friction is not a price stop or maximum-loss guarantee. The ALL_AGES band introduces no invented age threshold.

```powershell
npm run cli -- config show
npm run cli -- config init --overwrite
npm run cli -- config thesis
npm run cli -- explain <snapshot-id> --check SEC-01 --evidence
npm run cli -- explain <snapshot-id> --checklist entry
```

The profile owns size/horizon/risk/age bands. The thesis owns support, invalidation, catalyst, expiry, traction, warnings and ordered realization legs; there is no profile `exitPlan` field. The guided thesis editor saves those actual fields. Starter traction and realization are incomplete until selected; no profit triggers or position quantities are invented. `--thesis file.json` selects a validated explicit thesis for a new entry; tracked management always uses its frozen episode. Saved HORIZON templates materialize expiry at each initial cutoff and never extend an existing episode.

To override saved profile choices for a single run:

```powershell
$mint = '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump'
node dist/src/cli.js profile options
node dist/src/cli.js analyze $mint --chain solana --partial --profile .data/my-profile.json --db .data/live.sqlite
```

`--profile` is only for live analysis. It is rejected with `--bundle`; imported evidence carries its own profile. Illustrative FIXTURE inputs are synthetic tests, not live token evidence.

### Interpreting unknowns and supplying reviewed evidence

Full runs discover sources automatically, including website and social links from DEX Screener pairs whose base token exactly matches the requested chain and contract. They also search for the exact contract and its common project name. A discovered project page can supply a bounded set of same-account X posts or same-host documentation pages. These links are discovery leads; their contents still need token binding and source review.

The attention sample uses two Gemini requests to propose and independently review source judgments. There is no mandatory human semantic approval. The model selects retained text spans; code supplies unchanged quotations before the second review. The output labels this **automated source review**: a citation and reviewed interpretation describe source claims, not verified real-world truth. Post counts use source publication metadata and account IDs; market pages do not count as social posts. Competitor shares use the common-name search sample and exclude searches anchored to the target mint. Search coverage is bounded; outages, missing metadata, unsupported origin/catalyst claims and inadequate comparison samples stay unknown with their specific cause.

New entry snapshots use attention policy v2. A complete measured sample below ten qualified posts or three source accounts fails that sample criterion. An empty search or page-only corpus leaves attention counts unknown. A nonempty, fully reviewed post corpus can establish zero qualifying posts in the selected window, including when all observed posts are older or excluded. Known adverse attention judgments also fail their criterion. Historical snapshots replay their original policy semantics. This is a screening policy change, not a calibrated return predictor. Full mode can use three attention searches, up to thirty-two page fetches and two Gemini requests within the existing total request/time budget.

CAN-01 evaluates a bounded discovered representation set, including the target contract, with separate collection and model coverage checks. Fresh full analyses may also FAIL for inadequate public representation evidence after independent review: a retained indexed subject conflicts with its fully retained current profile and bounded recovery cannot establish the association. Both judgments require exact indexed and fetched citations. Every discovered lead receives separate own-subject and evidence-adequacy judgments, with independent review; selected mutable profiles require explicit bounded recovery queries. An accepted deficiency may decide the screening without inventing the missing competing-token binding. This means inadequate public verifiability, not a proven competitor or fraud. Errors, missing citations and rejected or omitted judgments remain UNKNOWN. Shared review labels indexed title/snippet records as INDEXED_METADATA; they never stand in for fetched page contents. Its admission follows actual sufficient semantic decisions, including this reviewed negative, rather than demanding unused comparison scalars. A failed unrelated origin page does not invalidate a complete comparison scope. CAN-02 displays two distinct evaluations: **origin relationship** and **measured attention leadership**. An independently reviewed primary project endorsement can support the origin route; an explicit primary disavowal contradicts it. Neither a DEX link nor missing search evidence establishes endorsement. Measured leadership requires at least two qualified representations, ten qualifying original posts and three source accounts in the same common-query window; exact-target queries do not rank competitors. A tie contradicts unique leadership. CAN-02 can pass through either supported route and states its basis. Origin support does not imply popularity, real-world authenticity or safety. Missing comparative evidence remains visible even when origin support resolves CAN-02.

Each unknown row identifies missing settings, unavailable evidence, unimplemented collection or unvalidated claims. `explain --check <ID> --evidence` shows values, units, thresholds, causes and stored source references without new calls. Missing evidence is not a detected rug. A candidate claim with a valid citation remains unvalidated; it cannot certify safety.

Optional existing reviewed imports use the strict schema in `src/domain/research.ts` and validation/derivation in `src/domain/baseline.ts`. `research import packet.json` retains its hash-bound USER_IMPORT evidence for later runs. This compatibility path does not establish platform-wide verification and is not required for automated attention review. Raw imported policy booleans cannot certify controls or execution. See the automation amendment in `plans/backend-v1/README.md` for the intended remaining semantic workflow.

### Automated social assessment

Approved full runs also extract and independently review social source claims. This reuses retained pages and can collect bounded public identity/history supplements through free TinyFish Search/Fetch. Supplements do not become attention participants. Attention retains at most 32 sources. Social submits at most 32 sources and can recover up to eight additional identity/history records in two Fetch batches, so comparison-only attention pages cannot exhaust its recovery allowance. The full run still shares 150 outbound operations and ten minutes; social qualification uses the same bounded transient retry as attention. Fresh full Shared audits may reassess rejected dispositions once when the initial independent review inspected every source and no disposition is unclear. Accepted dispositions are preserved; the complete reassessment needs a fresh independent review before selection. Original and attempted responses remain retained, and unsuccessful reassessment leaves the original unknown result. No login, paid browser agent, signing or posting is involved.

Fresh social policy v4 evaluates two independently reviewed public-evidence judgments. SOC-01 assesses account-to-contract verifiability: inadequate corroboration can earn FAIL for poor public identity evidence, without proving impersonation. A positive judgment still needs the complete cited binding path. SOC-02 assesses attribution, copied endorsements, provenance, promotion and contradictions. Account age/history, engagement and comparable previous-window statistics are desired indicators, not mandatory gates. Their absence can contribute to a reviewed visibility-risk FAIL; it is never invented data or proof of fraud, bots or manipulation. Missing fields stay visible: a month-only creation date is not an exact timestamp, and views or unlabeled digits are not likes/replies/reposts. Incomplete collection, invalid citations, rejected judgments and provider/model failure stay UNKNOWN. Code resolves model-selected span IDs and post-line ranges into unchanged literal source quotes. An oversized or unresolved post body cannot contribute participants or copy evidence, even when the complete acquired page was inspected. Old saved policy versions retain their original grading on replay.

SOC-03 requires at least three accounts, two independent source groups and two evidenced communities in the complete bounded sample. A complete nonempty reviewed corpus with fewer than three possible qualified accounts can contradict this criterion even when lineage remains unresolved. An empty or incomplete corpus cannot. The separate attention community feature still requires three communities. These screening thresholds are uncalibrated.

Fresh independently qualified screening judgments freeze policy v4 and their source-derived facts for offline replay; legacy social inputs without these judgments retain policy v3, and older policies and optional reviewed imports retain their original semantics. Known adverse social findings remain FAIL, while unavailable evidence stays UNKNOWN. The summary and `explain <snapshot> --check SOC-01 --evidence` identify the actual limitation. A successful full run or model review does not guarantee all three social checks can be resolved from free public sources.

### Current collection limits

Full Shared analyses use a compact comparison-response array, then locally require every original lead and its exact source citations before storing canonical keyed decisions. A specifically rejected social identity claim can receive one reassessment plus a fresh full independent review; the original rejection remains retained, and failure leaves the original unknown unchanged. A fee RPC reporting minimum-context-slot error `-32016` may receive one identical request after an abortable one-second wait. Its finalized slot floor and the original quote expiry remain unchanged. These recoveries use the existing full-analysis deadline and request cap; they cannot guarantee provider availability.


Approved full analyses without a reviewed import can recover an empty or failed DEX response through free TinyFish Fetch. Each discovery, final-market and native-SOL price request permits one fallback to the same public URL, using live acquisition (`ttl: 0`) and literal HTML-format API JSON. The collector retains the original response, key-free request, Fetch response and selected body separately; it labels recovered data as TinyFish transport evidence. Malformed text, redirects, provider errors and wrong-token results cannot supply market facts. Partial analyses do not use this fallback. All calls share the existing ten-minute/150-request limit; recovery does not guarantee complete evidence or market accuracy.

Solana collects finalized mint controls, understood Token-2022 extensions and actual ProgramData upgrade controls. A bounded mint-filtered holder scan is complete only when balances reconcile to supply; provider denial falls back to a limited largest-account sample. The canonical WSOL PumpSwap adapter verifies direct pool/program/mint/vault binding, LP withdrawal exposure and exact-size independent quotes using the pinned official SDK. One unsigned read-only simulation supplies its executed fee and indexed pre/post native and token balances from the same response. Costs qualify only when those balances bind to the exact submitted message, returned accounts, and the matching buy/sell events. Setup is measured from retained payer balance change after event amounts and the simulation fee; entry and exit message fees are counted independently. Providers that omit required vectors or metadata leave execution and costs UNKNOWN. Unsupported modes, stale state and provider failures also remain explicit UNKNOWN. Other venues and direct EVM readers remain unsupported. DEX activity is scoped reported activity, not buyer identity. Candidate semantic claims still require qualification; a full pass may remain insufficient. No signing, broadcast or custody occurs.

To use a dedicated RPC endpoint, set SOLANA_RPC_URL in the local `.env` or in the process that runs the CLI. Existing process variables take precedence. The endpoint must be Solana mainnet; the collector checks the reported genesis hash before using account facts.

```powershell
$env:SOLANA_RPC_URL = [System.Net.NetworkCredential]::new('', (Read-Host 'Solana mainnet RPC URL' -AsSecureString)).Password
node dist/src/cli.js doctor
$mint = '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump'
node dist/src/cli.js analyze $mint --chain solana --partial --db .data/live.sqlite
```

The default public RPC is rate limited and has no availability guarantee. A key-bearing RPC URL is used for the request but must not be printed, saved in a bundle, or shared. `doctor` reports whether an override is configured, never its value.

### Check RPC connectivity

Plain `doctor` stays offline and checks configuration, not provider access. To test the configured mainnet RPC without saving a case or calling DEX, TinyFish or Gemini:

```powershell
node dist/src/cli.js doctor --network
```

This checks `getGenesisHash` with an eight-second timeout per attempt and the bounded read recovery described below (at most four attempts, up to 75 seconds). `rpcNetwork.state` is `OBSERVED` only when the response identifies Solana mainnet; the command exits 0 then, or 1 for an unavailable/invalid check. It prints safe state/code fields, never endpoint credentials or raw responses. Success proves this handshake at that time, not mint lookup, all-provider availability or token safety.

`RPC_TIMEOUT` means the bounded request timed out. Allowlisted read-only RPC operations first use up to three short attempts within 30 seconds. If those attempts end in a timeout, the app waits 30 seconds and retries the identical request once with a fresh timeout. Recovery is bounded to 75 seconds per operation and stops when the analysis deadline expires. Other transient HTTP/transport failures keep their existing short retries; permission failures, invalid responses and explicit cancellation do not receive the delayed fallback. The configured provider and request remain unchanged. If recovery still fails, the affected checks remain unknown; try the diagnostic later or select a dedicated mainnet endpoint.

`RPC_NETWORK_ACCESS_DENIED` identifies a structured permission failure; check sandbox/firewall network access. `RPC_DNS_ERROR` identifies a structured hostname-resolution failure. HTTP 401/403 indicate rejected provider access; 429 indicates rate limiting. Other failures remain `RPC_TRANSPORT` when their cause is not established. The app never automatically changes providers or DNS settings. A later successful diagnostic does not fill an old snapshot: run a fresh analysis to collect new facts, using the same explicit database path if you want to retain and replay it.

## Full available-source pass

`--full` authorizes one bounded TinyFish Search/Fetch and Gemini pass for the current analysis. It requires both keys; if either is missing, the command stops before collection, names the missing variable, and prints the secure setup command. `--partial` explicitly requests RPC and DEX only, including when the keys are present. No mode flag never silently saves partial work: an interactive terminal asks for `y` or `yes` before hosted providers are called; Enter or any other response cancels. A non-interactive run must specify `--full` or `--partial`.

Before running `--full`, create a TinyFish account at [agent.tinyfish.ai](https://agent.tinyfish.ai/) and confirm Search/Fetch access. The [Search API docs](https://docs.tinyfish.ai/search-api/reference) and [Fetch API docs](https://docs.tinyfish.ai/fetch-api/reference) describe the endpoints; current published pricing lists them as free at a zero wallet balance, but account access may still return 401, 402, or 429. The app sends bounded public Search/Fetch requests and does not use the metered browser agent.

Create a restricted Gemini Developer API key in [Google AI Studio](https://aistudio.google.com/app/apikey) and confirm the project has Free-tier access and available quota. A ChatGPT subscription does not grant Gemini API access. Check Google's current [pricing](https://ai.google.dev/gemini-api/docs/pricing) and [billing](https://ai.google.dev/gemini-api/docs/billing) pages; account quota can vary and there is no automatic paid-model fallback.

For a local file, open `.env` in the project root and paste each key after its `=` sign. On a fresh clone, copy `.env.example` to `.env` first. The real `.env` is ignored by Git; keep it private. `doctor` reports presence only. Existing PowerShell environment variables take precedence over `.env` values.

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
node dist/src/cli.js doctor
$mint = '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump'
node dist/src/cli.js analyze $mint --chain solana --full --db .data/live.sqlite
```

Alternatively, set both variables in the same PowerShell process that launches Node. `Read-Host -AsSecureString` avoids echoing the key in the command line or prompt:

```powershell
$env:TINYFISH_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'TinyFish API key' -AsSecureString)).Password
$env:GEMINI_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'Gemini API key' -AsSecureString)).Password
node dist/src/cli.js doctor
$mint = '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump'
node dist/src/cli.js analyze $mint --chain solana --full --db .data/live.sqlite
```

The current Gemini request uses Gemini 3.5 Flash-Lite with high semantic thinking and JSON output. It receives bounded text fetched from public pages, source IDs, and the mint address. It receives no API keys, RPC URL, local paths, or position journal. The Gemini key is sent in the provider authentication header; it is never stored with the result. Search results are discovery hints, and fetched claims do not authenticate an official account or prove ownership.

Hosted calls require visible per-run approval. `--full` is the explicit approval for a scripted run. In an interactive run without a mode flag, the CLI presents the full pass and asks for `y` or `yes`; a decline ends without saving a snapshot, and you can rerun with `--partial`. The legacy `DD_ENABLE_HOSTED_SEMANTIC=1` variable does not authorize calls. Raw model proposals remain candidates. The attention adapter adds an independent model review and strict citation/sample validation before projecting source-qualified criteria; the labeled evaluation runner is tests/attention-evaluation.ts. This does not authenticate real-world claims.

PowerShell variables last only for that process environment. Remove them when finished:

```powershell
Remove-Item Env:TINYFISH_API_KEY,Env:GEMINI_API_KEY,Env:SOLANA_RPC_URL,Env:DD_ENABLE_HOSTED_SEMANTIC -ErrorAction SilentlyContinue
```

The local `.env` file persists until you delete it; clearing PowerShell variables does not remove keys saved there. Launch the CLI from the project root to load that file. Do not put credentials in `--bundle`, source files, shell history, issue reports, or committed files. `doctor` reports key presence, missing full-pass keys, approval requirements, and setup commands; it never prints key or endpoint values. Use `help` to see CLI modes.

## On-chain source requirements

The one-command workflow attempts the supported on-chain collectors automatically. Set `SOLANA_RPC_URL` in your local `.env` to a mainnet endpoint that permits indexed `getProgramAccounts`, largest-account queries, finalized account reads and unsigned `simulateTransaction`. Leave it blank to use the public Solana endpoint, which may deny these methods or return HTTP 429. Helius lists an optional free plan for an operator endpoint; check its current limits for indexed account scans and simulation before relying on it. `--full` does not bypass RPC limits. No wallet or private key is needed. A missing publicly observed funded simulation owner leaves simulation and total costs unknown. Use `explain <snapshot-id> --check OWN-01 --evidence` or the relevant check ID to inspect the saved reason without provider calls.

Holder collection accepts a `getProgramAccounts` response up to 20,000,000 bytes and at most 50,000 token accounts. A larger response or population remains incomplete; it is not silently treated as a full holder list. Stored raw evidence is capped at 24,000,000 bytes for a live run, while imported bundles retain a 2,000,000-byte cap. An older RPC that omits simulation pre/post balances, fee, token metadata or loaded-address fields cannot qualify round-trip costs. `.env.example` includes a blank `SOLANA_RPC_URL` entry; put the endpoint only in your ignored local `.env` or process environment, never in a committed file or evidence bundle.

PumpSwap support is limited to the canonical WSOL pool, understood token controls and non-mayhem mode. Virtual quote reserves are included in SDK curve math and never counted as real withdrawable SOL; an exit exceeding actual reserves is rejected as unquotable. Pool configuration, fee settings, mints, vaults and LP supply are captured together from one finalized bank after address discovery. Provenance and LP facts survive execution failures. Independent quotes remain separate from the round-trip simulation. Simulation proves setup from its same-response payer vectors, event amounts and executed fee; entry and exit network message fees are added separately. Missing proof fields leave costs unknown.

The pinned official SDK introduces transitive npm advisories (the current audit reports 13 affected packages, including 6 high). This adapter uses offline SDK methods and bounded custom RPC: it does not parse Anchor workspace TOML or use SDK connection streaming, and SPL integer decoding uses fixed-width fields. This is a scoped reachability assessment, not a clean-audit claim. Reassess these dependencies before enabling online SDK clients, workspace parsing or arbitrary binary layouts.

## What the evidence means

The collector verifies mainnet before interpreting a mint account. Supported legacy SPL Token mint facts can establish the account's program, supply, decimals, and recorded mint/freeze authorities. Null mint and freeze authorities support only their corresponding limited checks. ProgramData inspection resolves the shared token program’s upgrade authority: immutable deployment supports SEC-03, while an observed authority can make SEC-03 FAIL under the shared-program immutability rule. That is a finding about the shared Token-2022 program, not a token-specific rug authority. Unresolved inspection remains UNKNOWN. Token-2022 extensions, unparsed accounts, wrong-cluster responses, and provider failures remain partial or unknown; they are not treated as safe defaults.

DEX Screener contributes reported pair and market values for pairs that contain the exact mint. The saved market view is capped at 20 pairs and reports the API count, retained count, and truncation separately. A quote-side pair does not establish the mint's USD price. `pairCreatedAt` is pool creation time, not token creation time. A pair, `dexId`, price, or liquidity number does not certify a venue, prove sellability, establish liquidity controls, provide an executable quote, or prove ownership distribution.

TinyFish pages and Gemini claims are untrusted source material. A cited quote can remain visible as a candidate without proving that it entails the claim. The automated attention adapter can qualify cited narrative/game, origin/catalyst and explainability judgments under its recorded rubric. Candidate extraction alone does not qualify them, and no semantic judgment certifies on-chain safety or official social identity. Failed, missing, blocked, truncated, or unsupported responses stay distinguishable from positive evidence.

`TRUNCATED` means collection is incomplete: DEX results can contain 30 pairs with only 20 retained, and a TinyFish batch can retain usable pages while another URL fails. A token address in a URL alone does not bind the page text to that mint. Gemini citations are checked against the same bounded excerpts sent to the model. A pure social handle can align with a uniquely matching Markdown-escaped handle, with the exact raw source quote saved. Unsupported or ambiguous citations still make the batch `INVALID`; a supported `CANDIDATE` remains unvalidated. `--full` runs all available collectors but does not guarantee complete due diligence.

The catalog contains 33 entry rows and 15 management rows; the presence of a row does not mean a collector or detector exists. Expect UNKNOWN where evidence, a user profile choice, source coverage, or a validated method is missing. `RESEARCH_ELIGIBLE` is a checklist classification for its supplied evidence and policy, not a safety or return claim. No venue is certified, and the implementation does not provide full holder aggregation, complete social history, chart or macro analysis, strategy calibration, or trading.

Coverage counts required checklist rows with PASS/FAIL, not the number of fetched observations or model claims. RPC failure can leave 0/27 known even with usable DEX pages and semantic candidates. A successful Token-2022 base-facts read can establish identity (1/27) while its extension/control checks remain unknown; supply/valuation alone also does not establish the market row's additional requirements. User-owned risk, horizon and exit choices must still be supplied through a profile. Inspect `result.checks` for each missing requirement and `profile options` for choices. `binary: FAIL` with `classification: INSUFFICIENT_DATA` means required evidence is missing, not that a rug or honeypot was detected. Analyze exits 0 when it successfully saves this incomplete assessment; this differs from the network diagnostic's 0/1 connectivity result. Use a retained database for analyses you need to show/replay; deleting a temporary database removes its snapshots.

## Offline bundles and saved cases

Use `--bundle` for an explicitly offline fixture or user import:

```powershell
node dist/src/cli.js analyze FIXTURE_TOKEN --chain solana --bundle examples/entry.json --db .data/fixtures.sqlite
node dist/src/cli.js analyze FIXTURE_TOKEN --chain solana --bundle examples/reassessment.json --db .data/fixtures.sqlite
```

External bundles accept `FIXTURE`, `USER_IMPORT`, or `MANUAL_EMPTY`; `LIVE` is reserved for the built-in collector and is rejected from a file. User-import artifacts must match their recorded SHA-256 hashes. An imported `KNOWN` value records what the bundle says, not independent verification. `examples/` contains synthetic, illustrative data and is not calibrated for live decisions. Non-Solana bare-address analysis remains a manual-empty assessment until a chain-specific collector exists. `market probe <chain> <address>` remains a separate one-request DEX diagnostic for the recognized chains.

Other local commands:

```powershell
$caseId = Read-Host 'Case ID'
$bundlePath = Read-Host 'Bundle path'
node dist/src/cli.js reassess $caseId --bundle $bundlePath --db .data/live.sqlite
$thesisPath = Read-Host 'Thesis JSON path'
node dist/src/cli.js thesis successor $caseId --file $thesisPath --db .data/live.sqlite
$positionPath = Read-Host 'Position JSON path'
node dist/src/cli.js position record --file $positionPath --db .data/live.sqlite
$positionId = Read-Host 'Position ID'
$eventPath = Read-Host 'Event JSON path'
node dist/src/cli.js position event $positionId --file $eventPath --db .data/live.sqlite
node dist/src/cli.js backup .data/backup-001 --db .data/live.sqlite
```

Position records and events are manual reports. A proposal is not a sale. They include when an event took effect and when it was recorded; historical reassessment excludes records learned after its cutoff. A thesis successor's `createdAt` is its declared start time, and reassessment selects the latest saved thesis at or before the cutoff. The store has no separate timestamp for when a successor was inserted. Closing a case disables new reassessment; saved snapshots remain replayable.

`backup <new-directory>` creates a SQLite-consistent database copy and copies raw artifacts. To restore, stop CLI processes, copy the backup into a new data directory, and verify a known snapshot with `show` and `replay` before switching paths.

For source plans and the two-person ownership guide, see [plans/backend-v1/README.md](plans/backend-v1/README.md) and [CONTRIBUTING.md](CONTRIBUTING.md). The planning transcripts and historical source notes are not included in this public repository.

Narrative and origin review use source prefixes of up to 6,000 characters. The collector retries transient per-page timeouts and missing results once, requesting only the failed URLs with a longer page timeout; permanent errors such as 404 or access denial remain visible. Original failed responses and recovery responses are retained. Comparison sources retain up to 120,000 characters each and 512,000 characters in total; other pages retain up to 12,000. Exceeding these bounds remains an explicit acquisition limitation.

Fresh full entry analyses use `research-screen-shared-v1`. Early DEX data supplies discovery only. Canonical RPC, holder/control and market evidence is collected after semantic review, with quotes last; original receipt times remain immutable. A final provider failure cannot fall back to old discovery observations. Shared coverage follows the evidence sufficient to resolve each required entry decision, including a supported negative and the policy's alternative routes. Optional statistics and unused alternatives do not become mandatory. Freshness, semantic qualification and conflict inspection remain separate checks; an unavailable required source still leaves the affected checks unknown. Historical entry policies and management routing retain their original behavior.

Attention growth compares two equal time bins within one complete, independently reviewed fixed search sample. Counts, post dispositions and exclusions are saved. Zero qualifying posts can establish a bounded negative only after the collected posts are inspected; a failed or clipped collection cannot establish zero. These counts do not measure platform-wide growth.

Shared semantic qualification requires the normalized attention and social review receipts. A separate proposal and independent review inspect the declared narrative, competing-representation, origin and social assertions against retained sources for conflicts. Validating a negative screening judgment does not establish fraud. A known material conflict fails the shared conflict check and prevents eligibility; omitted, rejected or unavailable review remains unknown. These additional model calls share the existing ten-minute/150-operation limit and use no paid browser service.

PumpSwap fee messages that receive a null fee retry once with a fresh finalized blockhash, rebuilding both entry and exit messages. Original and retry artifacts are retained. A second null remains unavailable; numeric fees, rent and read-only simulation reconciliation are still required for trade-cost validation. No transaction is signed or broadcast.

Fresh analyses retain a ledger of every original common-name search lead, including blocked pages and stale profile descriptors. Free-only recovery plans at most four leads, eight search queries and eight new URLs. A separate proposal and independent review can bind an alternate fetched exact-contract source, or positively identify an unrelated indexed subject with corroboration from another public source. Indexed-only findings are labeled as such: they do not assert that the blocked page was read. Original acquisition failures and the qualified identified-lead scope are both saved. Missing, conflicting or rejected proof keeps the lead unresolved. Recovery posts retain their real metadata but cannot inflate the original post sample or measured leadership. No paid TinyFish Agent/Browser calls are made.

The explainable-thesis check also saves a source-backed sentence identifying the narrative, its appeal and this token's relationship to it. The model lists any prior concepts indispensable to understanding that sentence; technical vocabulary alone does not establish such a requirement. A separate model review must accept the explanation and prerequisite assessment. Supported simple explanations pass, supported necessary prerequisites can fail, and rejected or insufficient claims remain unknown. The explanation, citations and review are retained in the saved result; historical results keep their original meaning.

Comparison sources are submitted completely as exact text spans, grouped into batches of at most eight pages and 120,000 characters (maximum sixteen batches). Each batch has extraction and independent coverage review, followed by final review of the merged, chain-qualified candidate set. The reviewer classifies each acquired page as relevant, context, unrelated or insufficient. An omitted observation must identify its exact contract and source span; code can add that grounded observation, including a different citation of an existing token, and request one independent repair review. An uncited context page alone is not an omitted token. Original comparison post roles use full retained text. Failed acquisition, rejected associations or unresolved omissions keep comparative coverage unknown; separately qualified origin remains visible. Pages, batch prompts/responses, repair reviews and a local coverage manifest are saved as evidence.

Gemini attention, social and Shared requests retry a local request timeout or HTTP408/503/504 at most twice: after 30 seconds, then after 60 seconds, with identical input and a fresh 90-second timeout. The three-attempt budget is shared across these failures. HTTP429 remains an explicit quota/rate-limit failure; HTTP503 indicates temporary provider unavailability, and a paid tier does not guarantee error-free service. The ten-minute analysis deadline cancels requests and waits; permanent errors and invalid responses are not retried. Raw HTTP responses and safe local attempt receipts remain available for diagnosis. Legacy short-source analysis uses two model requests; fresh lead-ledger analyses add comparison and lead review. The extreme bound is fifty-four logical model requests (base two, sixteen batches with one possible repair review each, final merge, optional recovery planner and two lead judgments), or one hundred sixty-two theoretical HTTP attempts with transient retries (the shared 150-operation cap stops admission earlier). Free TinyFish recovery shares its eight-page budget across unresolved leads and complementary query results, preferring independent hosts. Positive unrelated-subject qualification requires cited identity and mechanism evidence; a contract address is not required for that disposition. Free TinyFish recovery is bounded; alternate search hits outside the selected URL budget remain recorded without becoming a second exhaustive comparison universe. All calls remain subject to the existing full-run limit of 150 outbound operations and ten minutes. Typical runs use substantially fewer; complete source review can increase latency and provider quota use. Failed unseen pages cannot be silently labeled irrelevant or converted into token contradictions.
