# Checklist 2 collaborator handoff — round 2 review and next implementation

Updated 2026-10-09. This is the canonical owner-to-collaborator handoff. It replaces this file's initial instructions to start packet 1. Read it with the revised `CONTRIBUTING.md`; no separate chat snippet is needed. Keep future round-two decisions/results here rather than creating another competing handoff.

## Published main integration and fresh live run (2026-10-09)

This section supersedes the earlier statements that Checklist 1 is unpublished or unavailable to integrate. Published main `9a43bdd` (PR #2; production publication `35abce9`) is merged into `codex/checklist-2`. The unpublished reference and other session's untracked files remain outside this integration.

The merge preserves main's live collectors, provenance validation, saved settings, qualified social/shared inputs and schema-v2 replay. Checklist 2 keeps its position ledger, successor plan basis, exact exit-proof requests and v5–v7 behavior. New LIVE management snapshots use `thesis-management-v8` to freeze qualified attention/social evaluation alongside the v7 execution rules; manual and fixture paths remain v7. Published v0–v4 management dependencies are frozen separately rather than relabeled as v5. Five snapshots captured from an independently built tree of published main protect their original qualified results and persisted replay. Existing v0/v5/v6 goldens were not regenerated. The executable also waits for provider promises before exiting and reports position/quote context in human output.

Validation: `npm run typecheck` passed; `npm test` passed **745/745**, zero failures. This combines main's 701-test suite with Checklist 2 regressions, updated explicit successor-basis/JSON contracts and the new historical replay regression. Mocked LIVE reassessment persists v8 and replays unchanged. Fixture acceptance remains separate from real-token acceptance.

A fresh actual merged CLI run used `analyze 3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump --chain solana --full --json --entry` with the approved $25/six-hour starter profile: fee 1%, entry impact 2%, exit impact 3%, round-trip loss 10%, direct control and removable liquidity 10%, ALL_AGES. Snapshot `458d87b9-532b-4244-bf70-49280b84239c`, cutoff `2026-10-09T15:10:02.296Z`, hash `85410724eb39c5c19ed779ef364f746bfff1d0d5b7e812550b8be0f68de0f743` replayed identically after reopening.

| Current merged LIVE entry | PASS | FAIL | UNKNOWN | Required known |
|---|---:|---:|---:|---:|
| Approved full available-source collection | 17 | 7 | 9 | 23/27 |

Four required unknowns remain: `SOC-02`, `DAT-01`, `DAT-02`, `DAT-03`. Five advisory checks remain unknown. Social integrity review is UNRESOLVED with missing ACCOUNT_HISTORY, ENGAGEMENT and COMPARABLE_HISTORY. The shared audit is deliberately gated until all semantic witnesses are known; its sole unresolved witness is SOC-02, so the three DAT rows cannot claim qualified audit coverage. This is an evidence limitation, not a reason to supply fixture values or convert UNKNOWN to PASS. RPC and DEX were observed (five pairs); web acquisition was truncated with `ATT_FETCH_URL_ERROR` and 23 initial retained pages, plus bounded recovery evidence.

Known failures: `ATT-01`, `ATT-02`, `CAN-01`, `NAR-03`, `OWN-02`, `SEC-03`, `SOC-03`. The entry is REJECTED and its case remains INITIAL_RESEARCH. A direct reassessment attempt correctly fails with `NO_ACTIVE_THESIS`: all **15 management rows are NOT_RUN** for this token. Zero-UNKNOWN real-CA acceptance remains **INCOMPLETE**. A failed entry is a known result, not an admissible live management baseline. Live exact-position exit-proof production, an admitted thesis, applicable observations and the agreed acceptance case list still govern the full management gate. No transaction was signed or broadcast.

Raw receipts, database and verification are retained locally in the private temporary run directory; credentials remain in ignored `.env`. Neither those artifacts nor the unpublished checkpoint repair patch are published. Previous reference/experimental run counts below are historical and are not combined with this current frozen snapshot.

## Historical owner Checklist 1 checkpoint (2026-10-08)

The owner has completed accepted Checklist 1 work through Shared evidence qualification on `codex/entry-workflow-production`. The latest independent implementation review returned PASS; typecheck/build and the full suite passed, with 701/701 tests. The accepted implementation remains bounded by the provider, evidence and calibration limits recorded in `agentic/architecture.md`. The owner topic branch is being published separately; it is not merged into `main` or `codex/checklist-2`. Use the exact published topic-branch SHA for any later integration. This does not satisfy Checklist 2's separate real-CA zero-UNKNOWN acceptance gate or declare Checklist 2 complete.

## API-enabled diagnostic continuation (2026-10-09)

The user supplied local Gemini and TinyFish credentials and confirmed the $25 / six-hour starter research profile with its existing risk limits. Credentials are retained only in the ignored local environment. TinyFish CLI fetching works in the existing session; restarting the MCP session was unnecessary for direct API collection. No trade was signed or broadcast.

The unchanged supplied Checklist 1 checkpoint, with the same `fe1ba9358ecdf6f8a795bc3737469fc0b93755396dc3f8c5f3ece3cbed33cb13` source fingerprint, completed a fresh full LIVE entry collection at `2026-10-09T14:40:17.763Z`. Checklist 2 typecheck/tests passed (80/80); reference typecheck/tests passed (653/653). The resulting frozen snapshot replayed identically after reopening, and the eight reused safety/exit decisions matched Checklist 2.

| Collection | PASS | FAIL | UNKNOWN | Required known |
|---|---:|---:|---:|---:|
| Previous partial collection | 13 | 2 | 18 | 14/27 |
| Unchanged checkpoint, full API collection | 18 | 3 | 12 | 20/27 |
| Isolated social-schema repair | 20 | 7 | 6 | 26/27 |
| Fresh repeat with social and conflict-schema repairs | 15 | 7 | 11 | 21/27 |

The unchanged checkpoint resolved `NAR-01..03`, `CAN-01..02` and `ATT-01`; the last resolved to FAIL rather than PASS. Its remaining required unknowns are `ATT-02`, `SOC-01..03` and `DAT-01..03`. Five advisory rows remain unknown. The entry remains REJECTED with `SEC-03`, `OWN-02` and `ATT-01` failed, so management admission remains `NO_ACTIVE_THESIS`, all 15 management rows remain NOT_RUN, and the combined zero-unknown gate remains INCOMPLETE.

Two actual model-contract defects were investigated in isolated copies, without editing or publishing the supplied checkpoint. The first social review omitted nine required account decisions. An exact decision-ID object makes those omissions reject at the response boundary, rather than invalidating the entire downstream social assessment. The repaired live run at `2026-10-09T14:46:45.301Z` resolved the social rows and `ATT-02` to FAIL and resolved `DAT-01..02` to PASS. Its sole required unknown, `DAT-03`, remained unknown because the conflict review asserted two conflicts with only one cited side each. A second schema repair requires two explicit references for each CONFLICT and preserves local literal-citation checks. Existing fixtures were migrated to the new wire shape; omission regressions were added. These are experiments, not integrated production changes.

The fresh repeat at `2026-10-09T14:53:13.085Z` did not reproduce the best count. `NAR-02` lacked qualified origin evidence following a fetch error; `CAN-01..02` had unresolved comparison leads/binding/representation, which kept `DAT-01..03` unknown. Thus source acquisition and model qualification remain variable; no result has achieved zero unknowns, and the best experimental count must not be presented as the current production result. Additional advisory collectors, qualified stable source scopes, an accepted entry baseline, management context and the exact exit-quote producer remain prerequisites.

The final isolated repair suite passed **655/655**, with zero failures, including explicit missing-decision and one-sided-conflict rejection tests. Both experimental snapshots replayed identically after reopening. The private repair patch is retained locally under the ignored `.data/checklist1-schema-experiment/repair.patch`; it includes unpublished checkpoint changes and must not be added to public Git. Raw receipts, databases and test logs remain in the local temporary diagnostic directories. The supplied checkpoint's original fingerprints were verified unchanged.

The public diagnostic runner now awaits the exported reference CLI promise with a keep-alive handle, applies a bounded process timeout, and validates nonempty JSON before reporting collection success. The original reference entrypoint exited zero with no JSON on the first full attempt; that attempt is excluded from all result counts. Run a new unchanged-checkpoint diagnostic securely with:

```sh
node --env-file=.env scripts/checklist1-reference-run.mjs --ca <user-supplied-Solana-mint> --full
```

## Round-two results from the collaborator (2026-10-07)

The Checklist 2 collaborator wrote this section. The owner's round-two review follows it unchanged, and every reference here (R1–R6, §A–D) points into that review.

**Outcome.** The foundations part of the round-two contract is implemented and offline-tested under a new management policy label, `thesis-management-v7`. It covers:

- the v6 golden;
- the R2 execution-basis fingerprint;
- R3 explicit successor reconciliation;
- the corrected packet 3 for R1, with exact exit proof for both the step being sold and the whole remaining holding;
- R4 position context on every position-derived amount.

Checklist 2 as a whole is **not** complete. The timed HOLD/EXIT_NOW/DCA-out plan, stage parameters (R6), the owner v1–v4 route (R5) and every real-CA run are still open.

- Branch: `codex/checklist-2`, built on reviewed HEAD `9d8c218`. Result commit, holding the round-two code and tests: `92fe0f93a8185884ea08322d216d137370669e5f`. The documentation commit carrying this section sits directly above it.
- Checklist 1 checkpoint: **NOT_INTEGRATED**. No owner checkpoint was available to merge.
- **REAL_CA = NOT_RUN; INCOMPLETE.** No real-CA acceptance case ran, because this clone has neither the agreed case list nor a published Checklist 1 checkpoint. There are no per-case tables, since no case ran; inventing them would be exactly the fabricated count the gate forbids. An exploratory, evidence-free CLI run on one real pump.fun address is recorded under "Did this round clear all the unknowns?"; it is not the gate.
- Independent review: the foundations passed their first fresh Bridgecode review (**PASS**). The later early next-step quote (MG-15 while holding) had its own cycle. Its first review found the code correct but three overstatements in this section (now corrected), and the terminal review gave **PASS**.

### Did this round clear all the unknowns?

**No.** The owner asked whether this handoff leaves every pillar with zero UNKNOWN rows. It does not, and it cannot yet: the gate counts only fresh reassessments of real contract addresses, and none has run. On this branch a real CA cannot even start legitimately, for three reasons:

- Typed real-CA data cannot pass the entry check, because typed direct-only safety features count as missing (`src/app/service.ts:27`).
- Market cap and creation time are ignored outside fixtures (`src/app/service.ts:29`).
- No certified exit-quote adapter exists.

Those three are the binding constraint, and all of them sit with Checklist 1.

On the Checklist 2 side, this round removed the last row that stayed UNKNOWN by design. Before, every "keep holding" result left MG-15 UNKNOWN (`NO_ELIGIBLE_LEG`) even with perfect inputs, because MG-15 only looked at a due step. Under v7 it now quotes the next planned step early (`NEXT_LEG`, below). The readiness test in `tests/management-execution.test.ts` checks the result: with every requested proof supplied, each fully specified synthetic scenario has 0 UNKNOWN rows. That covers DCA, keep holding, and invalidated with a position. The real CLI shows the same for a hold. This is readiness, not the gate.

The table lists, for each row, what makes it known on a real CA and who supplies it. "Consumer ready" means the Checklist 2 logic resolves the row once the input arrives.

| Row | Pillar group | Known on a real CA when… | Supplied by | State |
|---|---|---|---|---|
| MG-01 baseline | Baseline | A genuine entry PASS for that CA is saved through the live entry pipeline | Checklist 1 | Impossible on this branch (typed entry data cannot pass) |
| MG-02 integrity | On-chain | SEC-01..05 and LIQ-01 come from direct live sources, and the profile sets the matching risk limits (such as `maxTransferFeeBps` and `maxRemovableLiquidityShare`) | Checklist 1 sources; the user's profile | Consumer ready; no live source here |
| MG-03 exit | On-chain | EXE-01/02 are live, the profile sets `maxEntryImpactBps`, `maxExitImpactBps`, `maxRoundTripLossBps` and `exitProofLevel`, and a certified quote covers the whole remaining holding | Checklist 1 (sources and quote producer); the user's profile | Consumer ready; no certified producer |
| MG-04 coherence | Baseline | Every feature the thesis references is present and current | Checklist 1 | Consumer ready |
| MG-05 stage | Baseline | Qualified circulating cap and token creation time reach the evaluation, and the profile has age bands | Checklist 1 sources; integration wiring; the user picks age bands | Blocked: ignored outside fixtures here, and null on the owner's live path (R6) |
| MG-06 support | Attention | The support predicates' features are live | Checklist 1 | Consumer ready |
| MG-07 invalidation | Baseline | The invalidation predicates' features are live | Checklist 1 | Consumer ready |
| MG-08 catalyst | Attention | N/A when the frozen thesis has no catalyst; otherwise live features | Thesis author; Checklist 1 | Consumer ready |
| MG-09 on-chain traction | On-chain | The thesis names an on-chain traction predicate and qualified traction features exist | User's plan; Checklist 1 | UNKNOWN (`PLAN_UNSPECIFIED`) if the thesis names none |
| MG-10 external traction | Social | The thesis names an external traction predicate and qualified social features exist | User's plan; Checklist 1 | Same as MG-09 |
| MG-11 warning | Attention | N/A when no warning is configured; otherwise live features | Thesis author; Checklist 1 | Consumer ready |
| MG-12 trigger | Position | A position exists (a practice one is allowed), an unsold step is left, no sale is unattributed, and trigger features are live | User; Checklist 1 | Consumer ready |
| MG-13 plan/quantity | Position | The position has a known cost, the plan has steps, and any successor declares its basis | User | Consumer ready |
| MG-14 horizon | Baseline | N/A without an expiry; otherwise decided by the clock | Thesis author | Consumer ready |
| MG-15 step feasibility | Position | A position exists, the profile sets `exitProofLevel` and `risk.maxExitImpactBps`, and a certified quote covers the due step (`CANDIDATE_LEG`) or, while holding, the next step (`NEXT_LEG`) | Checklist 1 quote producer; the user (position and profile) | Consumer ready; hold gap closed this round |

The UNKNOWNs left in the offline sweep fall into three groups, by who can clear them:

- **The operator:** no plan or no position; every step already sold (save a successor plan); an unattributed sale (attribute it); an unknown cost.
- **The user's profile and thesis:** missing risk limits, `exitProofLevel` or age bands; a thesis that names no traction predicate.
- **Checklist 1 sources:** evidence that is missing or not yet available at the cutoff (for example a catalyst feature, or a support feature published after the cutoff), and missing stage inputs.

Reaching the gate takes four steps, in this order:

1. The owner publishes a Checklist 1 checkpoint and the agreed CA list.
2. Checklist 1 provides a certified exit-quote producer, or the owner agrees that Checklist 2 builds one.
3. Both sides integrate, including stage inputs.
4. We run the mandatory real-CA procedure and report each case's 15 rows and gate line.

#### Exploratory real-address run (not the gate)

On 2026-10-08 at 15:41:41 UTC, the CLI at commit `92fe0f9` ran on one real pump.fun token: Solana `3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump` (address supplied by the user). The run used a throwaway database and placed no trade.

- Live market lookup (DEX Screener, uncertified diagnostic): OBSERVED, 5 pairs; first pair dexId `pumpswap`, liquidity approximately $30,762.59.
- Entry check with no evidence (`MANUAL_EMPTY`): INSUFFICIENT_DATA, binary FAIL, 33 of 33 entry checks UNKNOWN, coverage 0/27. Replay was identical.
- Management: not run. The case stays in initial research with no tracked thesis, and `reassess` was refused with `NO_ACTIVE_THESIS` (exit 2). A legitimate baseline needs the owner's Checklist 1 live evidence (see the table above).

Gate line for this case: `REAL_CA management = NOT_RUN; INCOMPLETE`. The run shows the CLI accepts a real pump.fun address; it does not count toward the zero-UNKNOWN gate.

#### Supplied Checklist 1 reference: fresh live test (2026-10-08)

The user subsequently supplied the unpublished Checklist 1 working snapshot in `memehunt-incomplete` and authorized using it as a read-only reference. It was tested in a separate temporary copy; none of its 81 files changed, and its source was not added to the collaborator branch. This changes what can be tested locally, but is not a published integration checkpoint or a completed combined Service merge. The SHA-256 of the sorted `sha256  relative-path\n` manifest for its `src`, `tests`, `examples`, `package.json`, `package-lock.json` and `tsconfig.json` is `fe1ba9358ecdf6f8a795bc3737469fc0b93755396dc3f8c5f3ece3cbed33cb13`.

At `2026-10-08T15:57:53.316Z`, that reference performed an actual `LIVE` Solana entry collection for the same user-supplied address, `3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump`. The run used public finalized RPC, DEX data and the reference's read-only PumpSwap inspection/simulation. No transaction was signed or broadcast. TinyFish and Gemini were not requested: neither checkout nor the process supplied their credentials.

The documented starter profile was used provisionally: $25, six hours, transfer fee 1%, entry impact 2%, exit impact 3%, round-trip friction 10%, direct control 10%, removable liquidity 10%, and `ALL_AGES`. It is an uncalibrated diagnostic input, not an agreed final acceptance profile. It supplies neither an operator position nor an ordered realization plan.

Results:

- Checklist 1 reference: `npm run typecheck` exit 0; `npm test` **653/653**, fail 0.
- Checklist 2 branch: `npm run typecheck` exit 0; `npm test` **76/76**, fail 0.
- RPC and DEX collection: OBSERVED, with 5 retained market pairs. Entry: **13 PASS, 2 FAIL, 18 UNKNOWN** across all 33 rows; required coverage **14/27**. Classification **REJECTED**, binary FAIL. The earlier MANUAL_EMPTY result above remains the result of that earlier, different run.
- The two known hard-gate failures were `SEC-03` and `OWN-02`. Under the reference's shared-program immutability rule, the Token-2022 program has an observed upgrade authority. Under the provisional concentration limit, the measured largest-owner/control share was `0.25980756516871645566` (about 25.98%) versus 10%. The collector records no verified system-owner exclusions; these findings do not establish fraud or a token-specific rug authority.
- Reopened database replay was identical. Checklist 1's and Checklist 2's reused `SEC-01..05`, `LIQ-01`, `EXE-01` and `EXE-02` statuses agreed on the frozen live feature inputs. This checks those eight consumer decisions, not combined historical dispatch or all 15 management rows.
- The case remained `INITIAL_RESEARCH`, with no episode. Both Services refused an evidence-free reassessment with `NO_ACTIVE_THESIS`. No baseline was fabricated and no management row was evaluated. HOLD, DCA and EXIT lifecycle acceptance paths remain NOT_EXERCISED.

All remaining entry UNKNOWN rows are retained:

| Rows | Missing input or implementation | Next action / owner |
|---|---|---|
| NAR-01, NAR-02, NAR-03 | Qualified narrative/origin evidence; hosted sources were not requested | Configure TinyFish/Gemini and run the bounded full collector / Checklist 1 |
| CAN-01, CAN-02 | Qualified representation/origin/comparison evidence | Same full collection and independent review / Checklist 1 |
| ATT-01, ATT-02 | Qualified post/account/attention sample | Same full collection and independent review / Checklist 1 |
| SOC-01, SOC-02, SOC-03 | Qualified social identity/integrity/community sample | Same full collection and independent review / Checklist 1 |
| DAT-01, DAT-02, DAT-03 | Fresh complete baseline, semantic qualification and conflict inspection depend on the absent source scopes | Complete those scopes; unavailable/rejected review remains UNKNOWN / Checklist 1 |
| ADV-01, ADV-02, ADV-03, ADV-04, ADV-05 | Additional on-chain/chart/attention/social/shared features are missing; the reference does not implement every advisory feature | Named collector/qualification work where supported / Checklist 1; advisory omissions remain visible |

The 18 UNKNOWN count includes five advisory rows; 13 required rows remain UNKNOWN. Full-mode invocation without credentials fails with `FULL_PASS_KEYS_MISSING` before collection. More partial runs cannot fill attention/social evidence. A complete full pass may still yield UNKNOWN or FAIL and must preserve those outcomes.

Checklist 2 still needs a legitimate saved entry PASS before real management can begin. The reference's stage inputs remain null for circulating cap and token creation time; pool age and FDV were not substituted. Its entry-sized PumpSwap receipts were not reclassified as exact remaining-holding or candidate-leg proofs. A certified quantity-specific producer, approved profile/position/thesis inputs, stage provenance and deliberate shared Service/replay integration remain required.

`scripts/checklist1-reference-run.mjs` makes this diagnostic repeatable without modifying or publishing the supplied checkpoint:

```sh
node scripts/checklist1-reference-run.mjs --reference memehunt-incomplete --ca <user-supplied-Solana-mint>
```

It copies an explicit source allowlist to a fresh temporary directory, runs both repositories' checks, collects with an isolated database, verifies reopen/replay and the eight reused consumer statuses, and saves a per-row report plus receipts locally. The default is an explicit partial run; `--profile <file>` supplies reviewed settings. `--full` explicitly requests the bounded hosted collector and requires both provider keys in the process environment. `--inspect <run-directory>` rechecks saved output without provider calls. Raw responses, local database IDs, credentials and private endpoint values stay outside this public handoff. The runner is diagnostic tooling, not a live v7 integration or an acceptance certificate.

**Entry: UNKNOWN = 18; INCOMPLETE — ZERO-UNKNOWN GATE NOT MET. Management: REAL_CA management = NOT_RUN; INCOMPLETE.** The supplied reference resolves the previous absence of local Checklist 1 code; it does not resolve the missing hosted credentials, known entry rejection or remaining management integration requirements.

#### Free public acquisition attempt (2026-10-08)

The user authorized trying free collection without additional credentials or operator inputs. `src/providers/public-research.ts` now acquires a bounded set of DEX-linked public pages, plus an explicitly linked same-origin documentation page. It retains exact response bodies, content hashes, retrieval times and discovery edges. It does not create a reviewed import, supply policy booleans, certify account identity, interpret source claims as on-chain truth or change any saved evaluation. Credentials and hosted providers are not required. Requests are HTTPS-only, capped at four unique page leads, 500,000 bytes per response and two redirects; nonpublic destination addresses, oversize responses and outages remain explicit failures. Discovery is limited to exact base-token/chain matches, so a quote-side pair cannot import the other token's website.

At `2026-10-08T21:03:47.114Z`, the collector ran on the supplied mint. The DEX endpoint and three pages returned HTTP 200:

| Source | Exact mint text in retained response | Qualification |
|---|---|---|
| `https://parasiteonsol.fun/` | No | UNREVIEWED discovery lead |
| `https://x.com/parasitedotfun` | Yes | UNREVIEWED binding lead; not authenticated identity or a complete post sample |
| `https://parasiteonsol.fun/docs` | No | UNREVIEWED documentation lead |

No source cap was reached. This describes the bounded fetched leads only; it does not establish complete social/search coverage. The website and docs discuss the project's protocol, but neither retained response included this mint. The X response's literal address match is saved without promoting it to semantic or independent identity qualification. No wallet connection, signing, trade or paid service was used. Raw pages and local receipts remain outside the repository.

Validation: typecheck exit 0; **80/80 tests**, fail 0. The four new tests cover hash-preserved receipts without false qualification, rejected quote-side/wrong-chain discovery, private-host redirects/oversize responses and explicit source caps. Existing management, execution, ledger and replay tests remain unchanged and pass. The read-only Checklist 1 reference is unchanged.

```sh
npm run build
node scripts/free-public-research.mjs --ca <user-supplied-Solana-mint>
```

The standalone command saves an isolated local `public-research.json`. The reference runner also supports `--free-sources` after its fresh entry run. `--inspect` remains offline and does not collect new sources. The new acquisition output deliberately has `qualifiedFeatures: []` and `completeSocialSample: false`; it is not a fabricated `human-adjudication-v1` packet or an automatic substitute for the owner's independent reviews.

**Additional checklist rows resolved by this attempt: 0.** The most recent saved entry result remains 13 PASS, 2 FAIL and 18 UNKNOWN; it was not silently re-evaluated with unqualified pages. This narrows the earlier suggestion that free collection could close these rows: it can acquire more raw evidence, but the supplied reference's remaining required narrative/social/data rows require qualified review, and its advisory rows also lack named detectors. Paid acquisition is not inherently necessary, but acquisition alone is insufficient. The two known entry failures were not weakened and no management baseline was fabricated. **ZERO-UNKNOWN GATE NOT MET.**

### What changed

**v6 golden (§A).** Before any source edit, the `9d8c218` build was run on all 28 management scenarios and 4 persisted v6 rows. Their hashes and summaries are stored in `tests/fixtures/management-v6-golden.json`. A test re-evaluates every scenario and replays every row against that file. It was not regenerated afterwards, and the v0/v5 goldens were not touched.

**R2: execution-basis fingerprint.** `executionBasis(...)` in `src/domain/ledger.ts` returns `{ version: 'execution-basis-v1', fingerprint }`. The fingerprint is a SHA-256 of one fixed-order JSON array containing:

- the token and case;
- the position terms: id, case, mode, initial quantity and cost, quote currency, decimals, entry and recorded times;
- the episode id and its leg shapes;
- the plan basis, or `UNRESOLVED`;
- every event effective at the cutoff, after corrections are overlaid: id, kind, quantity, quote amount, times, leg, fee inclusion and direction;
- the resulting ledger state: remaining quantity, known cost, net cash flow, sold-by-leg and the unreconciled flag.

Instants are written as UTC ISO strings, decimals use `toFixed()`, and maps are sorted by key. The cutoff itself is excluded, so an unchanged as-of state keeps its fingerprint.

The owner's reproduction now separates cleanly. The 200→100 same-timestamp correction changes the fingerprint, and so does the 100→200 initial cost, while the legacy `revision` stays identical in both cases. The legacy `revision` and every v0/v5/v6 hash are unchanged.

**R3: successor basis.** `Service.successor(caseId, thesis, at, basis)` now requires `'CONTINUE'` or `'FRESH_START'`. Anything else throws `SUCCESSOR_PLAN_BASIS_REQUIRED`. The CLI form is `thesis successor <case> --file f --basis continue|fresh-start`. The new episode stores `planBasis: { mode, anchorAt }`.

- **FRESH_START** anchors at the successor's time. The step base becomes the inventory effective at that moment, and only sales after it count.
- **CONTINUE** keeps the predecessor's anchor (the origin if there is none), so carried fills keep counting.
- **Root episodes** are the origin under v7.
- **Legacy successors.** A successor saved before this change has no basis and is `UNRESOLVED`. MG-12, MG-13 and MG-15 report `PLAN_RECONCILIATION_REQUIRED` and no sized proposal is made, but a known invalidation still gives EXIT_REVIEW. Stored episodes are never rewritten; to resolve a legacy successor, the operator saves a new successor with an explicit basis.

**R1: corrected packet 3.** Every v7 result with a known position lists its exact quote requests in `exitQuotes`, even when no proof was supplied. There are three kinds:

- `REMAINING_POSITION` covers the whole remaining holding (`legId: null`).
- `CANDIDATE_LEG` covers the due step.
- `NEXT_LEG` covers the next planned step while no step is due. It is quoted early so that a hold result can be fully known.

Each request carries the token, case, episode, position, leg, atomic quantity, decimals and the execution-basis fingerprint. A proof (`exitProofSchema`, strict, either `FILLABLE` or `BLOCKED`) must match all of them exactly.

`checkExitQuote` in the new `src/domain/exit-proof.ts` then checks, in this order:

1. The profile names `exitProofLevel` and `risk.maxExitImpactBps`.
2. Time: `asOf` and `availableAt` are at or before the cutoff, and the cutoff is before `expiresAt`.
3. Every cited evidence record resolves and was available by the proof's time.
4. Trust.
5. The required proof level.
6. Fee conversion.
7. The outcome.

Results follow three rules:

- **Unusable proof is UNKNOWN.** Missing, mismatched, stale, unsupported, under-qualified, incomplete or contradictory proof is UNKNOWN. It is never turned into a fabricated BLOCKED.
- **Agreeing usable proofs decide.** All fillable within limits gives PASS, reporting the most cautious quote. All negative gives FAIL, with the reason `TOKEN_EXIT_RESTRICTED` > `EXIT_ROUTE_BLOCKED` > `EXIT_LIMIT_EXCEEDED`.
- **Over the limit.** A proof is over the limit when its price impact is above the profile limit, or when the worst case is at or below zero. The worst case is the minimum output minus any fees not already included in it.

Under v7, MG-03 combines the entry-sized exit rows with the remaining-holding check. A proven blocked holding therefore invalidates the thesis, and the EXIT_REVIEW carries `executionFeasibility`. MG-15 is the step check alone. For a due step (`CANDIDATE_LEG`), a blocked or over-limit result gives REASSESS_REQUIRED without invalidating the thesis. While holding with no step due, MG-15 checks the next planned step early (`NEXT_LEG`). Its PASS or FAIL is reported, but the hold decision (MAINTAIN_THESIS) does not change, since nothing is being sold yet. A due or not-yet-due next step larger than the remaining inventory is `QUANTITY_CONFLICT`, where v6 reported `NO_ELIGIBLE_LEG`. The owner should confirm the `NEXT_LEG` reading of MG-15, because it changes what that row means while holding. v7 rows cite `EXECUTION_BASIS` and `EXIT_PROOF` references instead of the old ledger revision.

Trust follows the existing import boundary:

- **Typed quotes.** A proof citing any `USER_IMPORT` evidence is a scenario quote, labeled `"scenario quote, not verified"`. It is accepted only for a HYPOTHETICAL position, and in both directions (the user's decision): a typed fillable quote can unlock a practice step, and a typed blocked or over-limit quote fails it. For a MANUAL_REPORTED position it stays UNKNOWN (`EXIT_PROOF_UNVERIFIED`). A typed fillable quote unlocks a practice sale only when the rest of the evidence comes from a trusted source: fixtures on this branch, Checklist 1's qualified collectors after integration. In an all-typed `USER_IMPORT` bundle, the existing import rule (`policyFeatures`, `src/app/service.ts:27`, unchanged since `9d8c218`) treats typed direct-only safety features as missing. The thesis then stays UNVERIFIABLE and no sale is suggested, though a typed "cannot sell the holding" still triggers EXIT_REVIEW.
- **Verified proofs.** A verified proof needs an adapter listed in `SUPPORTED_EXIT_QUOTE_ADAPTERS` that produced one of the cited evidence records. That list holds only the synthetic `fixture-exit-quote-v1`. As a result, **every real position's MG-03 and MG-15 stay UNKNOWN until Checklist 1 publishes a certified quote producer.**

**R4: position context.** Every v7 result carries `position`. It is either `{ status: 'NONE' }`, or `KNOWN` with:

- position id and mode, with `units: 'ATOMIC'` and decimals;
- initial and remaining quantity;
- known cost (or null) and quote currency;
- plan basis and execution basis.

DCA_OUT_PROPOSED now adds `positionMode`, as EXIT_REVIEW already did. No principal, profit or recovery field is emitted.

### Sanitized example (synthetic fixture token, real CLI)

This example was produced by `node dist/src/cli.js` against a temporary database, using inputs from `examples/fixtures.ts`. No market data is involved. The position is HYPOTHETICAL, 1000 units, with one due 40% step. The JSON is an excerpt.

First reassessment, with no proof supplied:

```json
{ "thesisState": "UNVERIFIABLE", "proposal": "REASSESS_REQUIRED",
  "rows": { "MG-03": "UNKNOWN EXIT_PROOF_MISSING", "MG-15": "UNKNOWN EXIT_PROOF_MISSING" },
  "position": { "status": "KNOWN", "mode": "HYPOTHETICAL", "units": "ATOMIC", "decimals": 0,
    "initialQuantityAtomic": "1000", "remainingQuantityAtomic": "1000",
    "planBasis": { "mode": "ORIGIN", "anchorAt": null, "baseQuantityAtomic": "1000" },
    "executionBasis": { "version": "execution-basis-v1", "fingerprint": "afe6034d…813c" } },
  "exitQuotes": [
    { "purpose": "REMAINING_POSITION", "legId": null, "quantityAtomic": "1000", "status": "UNKNOWN", "reasonCode": "EXIT_PROOF_MISSING" },
    { "purpose": "CANDIDATE_LEG", "legId": "leg-1", "quantityAtomic": "400", "status": "UNKNOWN", "reasonCode": "EXIT_PROOF_MISSING" } ] }
```

Second reassessment, with both requests answered by fixture proofs:

```json
{ "thesisState": "VALIDATED", "proposal": "DCA_OUT_PROPOSED", "proposedLegId": "leg-1",
  "proposedQuantityAtomic": "400", "positionMode": "HYPOTHETICAL",
  "rows": { "MG-03": "PASS RULE_SATISFIED", "MG-15": "PASS RULE_SATISFIED" },
  "exitQuotes": [ "…REMAINING_POSITION also PASS…",
    { "purpose": "CANDIDATE_LEG", "status": "PASS", "feasibility": "FILLABLE", "trust": "VERIFIED",
      "quote": { "expectedOutputAtomic": "1000", "minimumOutputAtomic": "990", "feesInOutputAtomic": "0", "priceImpactBps": "10" } } ] }
```

Three more CLI results from the same run:

- `replay` of the second snapshot returned byte-identical output.
- `thesis successor` without `--basis` exited with code 2 and `SUCCESSOR_PLAN_BASIS_REQUIRED`.
- `--basis fresh-start` stored `planBasis.mode = FRESH_START`, anchored at the successor's time.

Here `trust: VERIFIED` only means the synthetic fixture adapter is on this branch's allowlist. The quote numbers are fixture values, not a market observation.

### Validation

Run on Node v26.0.0 (macOS), on `9d8c218` plus these changes:

- `npm run typecheck`: exit 0.
- `npm test`: **76 passed, 0 failed**. That is 55 existing tests (some adapted, as listed below) plus 21 new ones in `tests/management-execution.test.ts`.
- **Planted bugs.** 18 deliberate bugs were planted one at a time in a scratch copy, and the suite caught all 18. Examples: the fingerprint ignoring initial cost, the cutoff leaking into the fingerprint, proof matching that ignores the fingerprint, scenario quotes accepted for reported positions, conflicting proofs cherry-picked, an off-by-one expiry, a missing fee conversion treated as free, a worst case computed from expected output, a legacy successor treated as the origin, an oversized step hidden, v6 gaining v7 behavior, replay dropping proofs, and an optional successor basis. The first run missed three of them, so tests were added before the final run. The scratch copy was discarded. Three more bugs were then planted for the early next-step quote, and all three were caught: MG-15 ignoring that quote, an oversized not-yet-due step hidden as no eligible step, and an early quote requested for a step that does not fit.
- **CLI walkthrough.** A disposable script ran 31 steps through the built CLI (`dist/src/cli.js`) on synthetic fixtures, each with its own throwaway database and working folder, and all 31 matched their expected results. Among them, a "keep holding" case with both quotes supplied had zero UNKNOWN rows. The steps covered every proof outcome above, replay and show, a reported sale changing the fingerprint, continue versus fresh start (step 1 becomes 40% of 600 = 240), the quantity conflict, typed quotes (all-typed and mixed with trusted data, practice and reported), and the four saved v6 rows replaying identically through `replay`.

The new tests cover the owner's round-two matrix in four groups:

- **Proof checks:** no proof; exact proof; wrong token, chain, position, episode, leg, quantity, decimals or basis; missing evidence; future, unavailable, stale and expired proofs; contradictory proofs; unsupported adapter; under-qualified level; fee units and conversion; blocked; over limit; scenario versus verified.
- **Fingerprint and successors:** same-timestamp corrections to quantity, cost/fee and leg; distinct initial positions; stability of an unchanged state; a future-recorded correction excluded; carried partial fills; continue; fresh start with reused IDs; fresh IDs; an oversize remaining plan; legacy successors.
- **Output:** HYPOTHETICAL and MANUAL_REPORTED modes in both DCA and EXIT_REVIEW; absent position; unknown cost.
- **Boundaries:** Service boundary rejections; v7 replay from a reopened database; the real CLI.

Not exercised this round: stage boundaries, missing cap or creation time, pool migration and cap decrease (R6, unchanged); v1–v4 replay with qualified inputs (R5); clock-boundary tests for the timed plan (not built yet); backup/restore (the persistence layout did not change).

### Version and interface changes

| Change | Where | Compatibility |
|---|---|---|
| Fresh label `thesis-management-v7` (`MANAGEMENT_POLICY_VERSION`). `MANAGEMENT_RULES` gains `executionBasis` (false for v5/v6, true for v7) | `management-trace.ts` | v0/v5/v6 results and hashes unchanged. Unknown labels still fail closed. v1–v4 stay reserved for the owner |
| `execution-basis-v1` fingerprint | `ledger.ts` | New. Legacy `revision` unchanged |
| `Service.successor(caseId, thesis, at, basis)`: `basis` is required; episodes gain optional `planBasis` | `service.ts`, `contracts.ts` | **Breaking for callers**: the owner's Service must pass a basis when merging. Stored inside the existing `episodes.payload` JSON, so no database migration |
| CLI `thesis successor … --basis continue\|fresh-start` | `cli.ts` | New required flag |
| Optional `bundle.exitProofs` (at most 16, strict) | `contracts.ts`, `service.ts` | Absent means old behavior. Rejected on `analyze` (`EXIT_PROOFS_REQUIRE_REASSESSMENT`), in MANUAL_EMPTY bundles, with duplicate IDs, with unknown evidence references, or with future times (`FUTURE_EXIT_PROOF`) |
| Optional `profile.exitProofLevel: 'QUOTED' \| 'SIMULATED'` | `contracts.ts` | No default. Without it, v7 MG-03/MG-15 report `POLICY_PARAMETER_MISSING` |
| Results gain optional `position`, `exitQuotes` and `executionFeasibility`; DCA gains `positionMode` | `contracts.ts`, `policy.ts` | v7 only. Older labels emit none of these |
| Quote request and proof `purpose` gains `NEXT_LEG` (leg proofs name their leg); MG-15 uses it while holding | `contracts.ts`, `policy.ts`, `management-trace.ts`, `ledger.ts` (`upcomingLeg`) | v7 only, additive. Proposals unchanged |
| Basis-reference kinds `EXECUTION_BASIS` and `EXIT_PROOF`; reason codes `PLAN_RECONCILIATION_REQUIRED`, `QUANTITY_CONFLICT` and the `EXIT_*` family | `contracts.ts`, `management-trace.ts`, `exit-proof.ts` | Additive |
| The v7 snapshot semantic also freezes `token` and `exitProofs`, and replay passes them back | `service.ts` | Older snapshots replay as before |
| `evaluateManagement(…, rules, execution)` and `evaluateManagementAs(…, execution)` accept execution inputs | `policy.ts`, `management-trace.ts` | Optional, defaulting to no proof |
| Snapshot `schemaVersion` | — | Unchanged |

### Shared tests changed

Shared tests changed only where a test asserted the legacy positive result that R1 removes, or where an API gained a required argument:

- `tests/successor-cutoff.test.ts`: the 10 `successor(...)` calls now pass `'CONTINUE'`, the meaning those tests already assumed. No assertion changed.
- `tests/policy.test.ts`, "due realization…": pinned to v6 rules with a comment. The v7 behavior for the same case is tested in the new file.
- `tests/service.test.ts`, "historical reassessment…": now asserts the CANDIDATE_LEG request quantities 400/300/150 with REASSESS_REQUIRED, instead of DCA proposals made without proof.
- `tests/management-sell-order.test.ts`:
  - The packet-2 scenarios are pinned to v6.
  - The invariant test runs under both v6 and the current label.
  - The Service maintain test uses the two-pass flow. It reads the requests (the remaining holding, 600, and the early quote for step two, 300), supplies proofs for both, and asserts MAINTAIN_THESIS with MG-15 PASS.
  - `nextLeg` calls wrap `originBasis(...)` for the new signature.

### Collector and integration dependencies

1. **Certified exit-quote producer (Checklist 1).** The producer must answer each `exitQuotes[].request` with an `ExitProof` that copies the request's identity and `executionBasis`. It must cite evidence records whose `adapterVersion` equals `route.adapter`, and set honest `asOf`, `availableAt` and `expiresAt` times. Its adapter id joins `SUPPORTED_EXIT_QUOTE_ADAPTERS` only after certification. Until then, real positions stay UNKNOWN on MG-03 and MG-15 by design.
2. **Real-CA case list and a published Checklist 1 checkpoint (owner).** Both are needed before the mandatory real-CA procedure can start.
3. **Owner Service merge.** Dispatch v5/v6/v7 beside the owner's v0–v4 route, pass `{ token, evidence, exitProofs }` into `evaluateManagementAs`, and carry the `basis` argument through `successor`. Also decide whether a live reassessment may carry operator-typed quote evidence beside qualified live evidence. Today a non-fixture bundle must be entirely `USER_IMPORT` (`src/app/service.ts:71`), so the user's "typed quotes count for practice positions" decision only takes full effect once that is settled. Do not overwrite whole shared files from this branch.
4. **Profile choice (user).** Each real profile needs an explicit `exitProofLevel`. There is deliberately no default.

### Pillar summary

No real-CA reassessment ran, so no row has an observed result. The observed column records that, rather than inventing counts. The row counts reconcile to MG-01…MG-15: 3 + 3 + 1 + 5 + 3 = 15.

| Reporting group | MG rows | Implementation | Validation | Observed PASS/FAIL/UNKNOWN/N/A | Changed this round | Unresolved work (owner) |
|---|---|---|---|---|---|---|
| On-chain integrity, sellability and traction | MG-02, MG-03, MG-09 | PARTIAL: MG-03 exact-quantity consumer implemented; MG-02/MG-09 unchanged; not integrated | OFFLINE_TESTED | Not observed (no run) | v7 MG-03 needs exact proof for the whole remaining holding | Certified quote producer (Checklist 1); live integration (owner + collaborator) |
| Attention, narrative and thesis durability | MG-06, MG-08, MG-11 | PARTIAL (unchanged) | OFFLINE_TESTED | Not observed (no run) | None | Stage parameters and comparable windows (R6, Checklist 2); qualified current evidence (Checklist 1) |
| Social and external confirmation | MG-10 | PARTIAL (unchanged) | OFFLINE_TESTED | Not observed (no run) | None | Source-qualified social integration (Checklist 1 / owner) |
| Baseline, evidence coherence, stage and invalidation | MG-01, MG-04, MG-05, MG-07, MG-14 | PARTIAL (unchanged) | OFFLINE_TESTED | Not observed (no run) | None | Stage sources and parameters (R6); timed horizon (§D) |
| Position, ordered realization and proposal feasibility | MG-12, MG-13, MG-15 | IMPLEMENTED offline; not integrated | OFFLINE_TESTED | Not observed (no run) | Fingerprint, successor basis, exact candidate proof, early next-step quote while holding, `QUANTITY_CONFLICT`, position context | Certified quote producer (Checklist 1); timed plan (Checklist 2, next) |

Gate line: `REAL_CA = NOT_RUN; INCOMPLETE`.

### Original-plan traceability

This table was checked against the maintained mappings in `plans/backend-v1/06`, `07` and `09`. The raw pre-plan and transcripts are not in this public clone and were not reread. It covers the Checklist 2 management requirements. Rows owned by Checklist 1 are marked, and they were not verified here. No row has real-CA evidence, so that column says NOT_RUN throughout.

| Accepted Phase 1 requirement | Source | Owner | Implementation symbols | Offline proof | Real-CA evidence | Remaining gap |
|---|---|---|---|---|---|---|
| Saved entry PASS opens a tracked thesis episode atomically; management runs at the next manual reassessment | 09 §1 | C1 verdict, C2 lifecycle (owner custodian) | `Service.analyze`, `episodes` table | `service.test.ts` | NOT_RUN | Live entry path is the owner's unpublished Checklist 1 |
| Separate 15-row management manifest with roles and requiredness | 09 §4 | C2 | `managementDefinitions` (`catalog.ts`), `traceManagementRows` | management and policy tests | NOT_RUN | Live inputs |
| Thesis-state and proposal precedence | 09 §5 | C2 | `evaluateManagement` (`policy.ts`) | `policy.test.ts`, scenario tests, v0/v5/v6 goldens | NOT_RUN | None offline |
| Ordered legs in ORIGINAL_ACQUIRED bps; only recorded, attributed fills consume a leg | 07 §6, 09 §5 | C2 | `nextLeg`, `proposeLeg`, `reduceLedger` | `management-sell-order.test.ts`, ledger tests | NOT_RUN | None offline |
| Optional manual/hypothetical ledger with append-only events and corrections | 09 §5 | C2 | `reduceLedger` (`asOf` + `account`), `Service.recordPosition`, `appendPositionEvent` | ledger and Service tests | NOT_RUN | None offline |
| Rebasing needs an explicit successor with carried fills; nothing silently reset | 09 §5, 07 §6 | C2 | `Service.successor(…, basis)`, `declaredPlanBasis`, `quantityBasis`, CLI `--basis` | successor tests in `management-execution.test.ts` | NOT_RUN | None offline (R3 closed) |
| Quantity-bound proposal feasibility; proposal quantities expire with the quote | 09 §4 MG-15, §5 | C2 consumer, C1 producer | `checkExitQuote`, `exactFeasibilityRow`, `executionBasis`, `upcomingLeg` (`NEXT_LEG`) | proof-matrix, hold and readiness tests | NOT_RUN | Certified producer. Proof expiry is frozen in the snapshot but not repeated in the result (§D) |
| Exit route for the relevant remaining or scenario quantity | 09 §4 MG-03 | C2 consumer, C1 producer | `holdingExitRow`, `REMAINING_POSITION` request | holding-block tests | NOT_RUN | Certified producer |
| Invalidation is an observation, not a filled stop; EXIT_REVIEW discloses feasibility | 07 §6, 09 §5 | C2 | `executionFeasibility` | holding-block test | NOT_RUN | None offline |
| HYPOTHETICAL/MANUAL_REPORTED on every position-derived amount; no actual-profit claim for scenarios | 07 §7, 09 §5 | C2 | `PositionContext`, `positionMode`, `SCENARIO_QUOTE_LABEL` | position-context, import-trust and CLI tests | NOT_RUN | Net proceeds and principal intent not shown yet (§D) |
| `principalRecovered` stays UNKNOWN without cost basis | 07 §6 | C2 | No principal field is emitted | "…without profit or principal claims" test | NOT_RUN | Principal-recovery arithmetic not implemented (§D) |
| Point-in-time knowledge: nothing recorded after the cutoff is used | 07 §4, 09 §2 | C2 (shared) | `asOf` cutoff, proof time checks, `FUTURE_EXIT_PROOF` | `successor-cutoff.test.ts`, future-correction fingerprint test | NOT_RUN | None offline |
| Old snapshots unchanged; versioned replay | 09 §2, 06 §44 | C2 + owner | `MANAGEMENT_RULES`, `evaluateManagementAs`, `Service.replay` | v0/v5/v6 goldens, v7 replay from disk | NOT_RUN | Owner v1–v4 route (R5) |
| Cap × age × attention-style stage cell selects parameters | 09 §3, 07 §3 | C2 rules, C1 sources | `resolveStage` (cap and age only) | stage tests in `policy.test.ts` | NOT_RUN | R6: parameter selection, attention style, observation references |
| Time-bounded HOLD/EXIT_NOW and DCA-out plan with horizon, deadlines and cadence | Core decision contract above; 07 §3, §6 | C2 | Not implemented | None | NOT_RUN | Next round; user decisions recorded below |
| Plan readiness (`INCOMPLETE \| SPECIFIED \| UNVERIFIABLE`) | 07 §6 | C2 | Not implemented as a field; missing plan parts surface as UNKNOWN rows | missing-plan rows in `management-trace.test.ts` | NOT_RUN | Explicit readiness field |
| Phase 1 journal | 07 §7, 09 §5 | C2 | `Service.journal`, CLI `journal` (free text) | None found | NOT_RUN | Structured journal fields; a test |
| Comparison with the previous comparable snapshot | 09 §2, §6 | C2 | `Service.diff` (coarse) | None found | NOT_RUN | Comparable windows and changed-check explanation (R6) |
| MG-09/MG-10 traction from qualified on-chain and social sources | 09 §4 | C1 sources, C2 predicates | Traction predicates in `evaluateManagement` | Scenario tests | NOT_RUN | Live qualified sources (Checklist 1) |
| Entry checklist (33 checks) and live collectors | 09 §1; 06 §13–30 | C1 | Owner's unpublished work | Not verified here | NOT_RUN | NOT_INTEGRATED |

### Progress estimate

These scores use the owner's eleven areas and 0/1/2 scale:

- **Position and successor-plan reconciliation: 1 → 2.** Explicit basis, the fingerprint, legacy successors blocked from sized proposals, and tests.
- **Exact-quantity exit/proposal proof: 0 → 2,** for the Checklist 2 consumer (strict proof contract, full offline matrix). The live producer belongs to Checklist 1 and falls under combined live acceptance, which stays at 0.
- **Operator context stays at 1.** Mode, units, basis and quote requests now appear on every sized result. Proof expiry, net-proceeds/principal intent and comparable longitudinal changes are still missing.
- **Historical preservation stays at 1.** The v6 golden and v7 replay were added, but the owner's v1–v4 route is still unverified.
- All other areas are unchanged.

The total is about **15/22 ≈ 68%**. This is the collaborator's estimate, offered for the owner to confirm. It is not a real-CA result, and it does not affect the gate above.

### Housekeeping

At the user's request, four collaborator notes and one old copy were removed so that this file is the single handoff:

- `handoffs/checklist-2-handoff.md`
- `handoffs/checklist-2-packet-1.md`
- `handoffs/checklist-2-packet-2.md`
- `handoffs/checklist-2-packet-3-proposal.md`
- the round-one copy `docs/checklist-2-collaborator.md`

They remain readable at `9d8c218`, for example with `git show 9d8c218:handoffs/checklist-2-handoff.md`. `CONTRIBUTING.md` still names them as earlier delivery; that owner text was left as written.

### Next bounded action

1. **Timed HOLD/EXIT_NOW/DCA-out plan** (core decision contract), using decisions the user has already made:
   - The operator writes the holding time, step deadlines and check-in interval into the plan, and code does the date arithmetic.
   - A missed step deadline makes that step due.
   - `expiryAt` means exit everything.
   - Weakening is sized only by an optional frozen plan rule.

   This step adds clock-boundary tests for hours, days, weeks and calendar months, and shows proof expiry and net-proceeds context on sized results (§D).
2. **R6 stage parameters**, with explicit versioned profile data and observation references.
3. **Integration** with an owner-published Checklist 1 checkpoint, including the v1–v4 route (R5).
4. **Real-CA acceptance run** on the owner's case list, with the full 15-row table and gate line for each case.

*The owner's round-two review follows, unchanged.*

## Verdict and exact reviewed state

**Packets 1 and 2 are useful, implemented and verified on the collaborator branch. The complete Phase 1 Checklist 2 is not finished, and the branch is not yet integrated with the owner's newer Checklist 1.** Continue from your work; do not rebuild those packets or restart from the old main commit.

- Repository: https://github.com/LycurgusxLycurgus/MemeHunt
- Reviewed branch: `codex/checklist-2`.
- Reviewed HEAD: **9d8c218781c3dfd3b781805772179ccc79d6afd9**.
- Common published starting base: `27273cff16b334c6ba54187bd0170efad611f446`.
- Packet 1: `c314cd2` predicate explanations, `e6b45f4` management traceability/v5.
- Packet 2: `b784f9c` ordered ledger selection, `f90601a` management v6.
- The collaborator's `handoffs/checklist-2-handoff.md` and packet notes were inspected. Their packet 3 is explicitly a proposal with no implementation. Their delivered documentation is historical context; this file supplies the next instructions and resolves/corrects their integration recommendations.

At the time of this 2026-10-06 review, the owner reviewed a separate clone. Nothing was merged into the dirty owner checkout, and no production code was repaired in this review. The owner branch then contained unpublished Checklist 1 source, qualified live policy/Service changes and an unfinished social task. That dated state is superseded by the current owner checkpoint above; the Checklist 2 implementation and review findings below remain specific to the reviewed `9d8c218` branch.

## Independently observed validation

On Node **24.15.0**, in an isolated clone at the reviewed SHA:

- `npm ci --ignore-scripts --no-audit --no-fund`: completed; five locked dependencies installed.
- `npm run typecheck`: passed.
- `npm test`: **55 passed, zero failed/skipped**; includes build, management, ledger, Service and successor-cutoff tests.
- Built the original base separately and verified **all 18 v0 golden scenario results** against its actual evaluator. This supports the legitimacy of the preserved baseline rather than merely trusting checked-in expectations.
- Actual CLI `analyze -> reassess -> replay`, using synthetic examples and a dedicated database: RESEARCH_ELIGIBLE entry, EXIT_REVIEW management, byte-identical replay.
- Targeted production-function/Service probes reproduced the gaps below. These were additional probes, not part of the branch's 55 tests.

No live provider calls, real trades, owner-database inspection or combined-owner-tree tests were performed. Earlier collaborator test/review claims are corroborated only to the extent stated above. One trailing whitespace occurrence in their old copied document is cosmetic and is not a blocker or a percentage deduction.

## Progress estimate: about 55% of the full Phase 1 management scope

This is a transparent **requirements-maturity estimate**, not time spent, lines written, calibrated financial reliability or permission to release. Eleven scope areas receive 0 = absent/unverified, 1 = partial, 2 = implemented with relevant inspected/offline evidence. Equal weighting is a rough communication aid; blockers remain blockers regardless of the score. It includes foundation work inherited from the base, not only the collaborator's contribution.

| Scope area | Score | Evidence and remaining boundary |
|---|---:|---|
| Case, baseline and thesis lifecycle | 2/2 | Saved PASS activation, frozen baseline, historical episode selection, close/replay foundation tested; quantity-plan reconciliation is scored separately |
| Thesis states and proposal precedence | 2/2 | Separate management manifest, invalidation/unknown/weakening/validation paths and manual proposals |
| Row explanations and references | 2/2 | Packet 1 adds decisive predicate refs, usable evidence and structural basis; stage observation provenance awaits the stage contract |
| Ordered unconsumed sell steps | 2/2 | Packet 2 covers consumed, partial, later-unknown, unattributed and exhausted cases within a plan |
| Position and successor-plan reconciliation | 1/2 | Ledger/cutoffs exist; successors still accept ambiguous reused IDs, and execution revision is incomplete |
| Historical policy preservation across both workstreams | 1/2 | v0/v5/v6 goldens/replay pass; owner v1-v4/qualified-input integration remains unverified |
| Exact-quantity exit/proposal proof | 0/2 | MG-15 still passes on generic entry-sized exit rows; packet 3 is only a proposal |
| Cap/age-dependent management parameters | 1/2 | Cap/age resolver exists; full parameter selection, source binding and live inputs are incomplete |
| Operator context and interpretation | 1/2 | Row inspection and EXIT_REVIEW inventory/mode exist; DCA mode, quote/cost context and meaningful longitudinal comparisons remain incomplete |
| Combined live Checklist 1 -> Checklist 2 acceptance | 0/2 | Not integrated or exercised against the owner live path |
| Time-bounded HOLD/DCA-out management plan | 0/2 | Explicit holding duration, dated/conditional sell schedule, reassessment cadence and invalidation override are not implemented as a complete plan |
| **Total** | **12/22 = about 55%** | **Incomplete; quantified DCA is not yet release-ready** |

The initial review estimated 60% across ten areas. The user then explicitly required the HOLD/EXIT_NOW decision plus a timed DCA-out plan; its missing implementation is now a separate 0/2 area, producing about55%. This is an expanded acceptance denominator, not lost work.

Packets 1 and 2 can reasonably be called complete **within their stated offline scope**. They do not make all Checklist 2 complete. Live source dependencies belong jointly to integration/Checklist 1; do not describe their absence as poor implementation of those two packets.

## Required pillar map and STRICT real-CA completion gate

**Production-quality acceptance requirement, explicitly reiterated by the user on 2026-10-06: the next delivery must report the Checklist 2 pillars, what is known/unknown in each, and actual fresh tests with real contract addresses. Production-ready completion requires ZERO UNKNOWN rows, not merely zero unexplained unknowns. A code-complete or offline-tested packet with unknown real-CA results is unfinished against this requirement. An explained unknown still fails the completion gate.**

Use these five reporting groups. The first three preserve the project's on-chain, attention and social evidence pillars; the last two expose the management context and position/exit responsibilities that those inputs alone cannot settle. These are reporting/ownership groups over the existing 15-row manifest, not five replacement checklists or new duplicated checks. Predicates may depend on several evidence pillars; list their real dependencies instead of forcing exclusive source ownership.

| Reporting pillar/group | MG rows (each row counted once) | What must become known | State at this reviewed branch |
|---|---|---|---|
| On-chain integrity, sellability and traction | MG-02, MG-03, MG-09 | Current controls/liquidity, relevant-quantity exit evidence, configured qualified on-chain traction and comparable windows where required | Logic/fixtures present; relevant-quantity proof incomplete; live integration NOT_RUN |
| Attention, narrative and thesis durability | MG-06, MG-08, MG-11 | Saved support, required catalyst/representation conditions, and configured crowding/decay warnings against current qualified evidence | Predicate evaluation/traceability tested offline; real current evidence with owner pipeline NOT_RUN |
| Social and external confirmation | MG-10 | Configured qualified external traction, with actual social/attention source breadth, timeliness, binding and integrity prerequisites | Predicate consumer exists; owner source-qualified social/attention integration NOT_RUN; a count of mentions alone is insufficient |
| Baseline, evidence coherence, stage and invalidation | MG-01, MG-04, MG-05, MG-07, MG-14 | Correct saved thesis, coherent inputs, evidenced cap/creation-age/profile context, invalidation predicates and applicable horizon | Lifecycle and invalidation tested offline; stage sources/parameter coverage incomplete; live NOT_RUN |
| Position, ordered realization and proposal feasibility | MG-12, MG-13, MG-15 | Next unconsumed trigger, explicit position/scenario and reconciled quantities/cost, exact candidate proof | Ordered selection tested; reconciliation/fingerprint/output gaps and exact-proof implementation remain; live NOT_RUN |

The manifest union is exactly MG-01 through MG-15, with no omissions or duplicates. A resolved management row can depend on several source pillars; its report must identify which qualified on-chain, attention and social facts supported the determination. Do not invent additional numeric MG rows merely to fit these headings. If the present frozen predicates do not substantively use an intended source pillar, declare that coverage gap; do not claim the pillar is complete from a vacuous predicate.

Distinguish three independent axes in every report:

1. **Implementation:** NOT_IMPLEMENTED / PARTIAL / IMPLEMENTED / INTEGRATED.
2. **Validation:** NOT_RUN / OFFLINE_TESTED / REAL_CA_TESTED, with actual evidence and run identity.
3. **Observed result:** PASS / FAIL / UNKNOWN / genuine NOT_APPLICABLE, only after the check actually ran. Never label an untested row PASS or invent fifteen observed UNKNOWNs for a run that never happened.

At review time there are **no fresh real-CA Checklist 2 runs for the combined branch to credit**. Live acceptance is NOT_RUN and the zero-UNKNOWN gate is NOT ACHIEVED. The approximately55% implementation-maturity estimate above must always be presented separately from this gate. Passing 55 offline tests does not raise real-CA coverage.

### What zero UNKNOWN means

For each agreed real-CA acceptance case, persist and report **all 15 management rows** from one coherent fresh reassessment. Every row must be PASS or FAIL, except a documented NOT_APPLICABLE allowed by the actual policy and frozen thesis. UNKNOWN count must equal **0**, including contextual rows; "the unknown is explained" is not completion. Each pillar/group must also have zero UNKNOWNs. A token may legitimately fail checks or invalidate its thesis: known does not mean positive, safe or profitable.

Use NOT_APPLICABLE only where the check's contract permits it and the frozen thesis genuinely has no dependency, such as an absent optional catalyst, warning or expiry. A missing collector, quote, position basis, stage input, desired measurement needed by an active predicate, unresolved proof or exhausted plan is not automatically N/A. Preserve the intended user's thesis/risk settings. Do not remove checks, weaken predicates, set trivial thresholds, relabel missing features, change source completeness claims or alter the thesis after seeing results merely to reach zero.

For a fully quantified acceptance case, supply a valid explicit plan and position basis. The user has allowed HYPOTHETICAL positions: an honestly labeled scenario is acceptable for exercising quantity rules with actual real-market evidence and a quantity-bound quote. Do not claim an actual buy/sale or principal recovery without manual records. A synthetic position input does not turn a fabricated market quote into real-CA evidence.

This strict success target does not authorize manufacturing facts. If any row stays UNKNOWN, the next report must say **INCOMPLETE — ZERO-UNKNOWN GATE NOT MET**, include that row and cause, and identify the next corrective action and owner. Continue authorized collector/qualification/integration work where feasible. A persistent external outage/access limit can be a real blocker, but cannot be presented as a finished delivery or silently removed from the report. No infinite retry loop, paid escalation or unauthorized provider substitution is required to pretend the gate passed.

### Mandatory real-CA validation procedure

1. **Freeze the acceptance cases and profile before judging outcomes.** Start with the real CA(s) already being used in the owner's Checklist 1 acceptance workflow, once their nonsecret identifiers and supported-chain context are available. Record chain+CA explicitly. If that case list is unavailable in your clone, obtain it from the owner rather than guessing the intended tokens. A documented additional manually selected case may exercise another lifecycle path; do not create Phase 2 automatic discovery or quietly replace a failing case with an easier one.
2. **Use the actual supported pipeline.** Integrate the owner's published Checklist 1 checkpoint, or an explicitly agreed qualified live-evidence interface, before claiming a live end-to-end result. If neither exists yet, deterministic packets may be delivered as partial progress, but real-CA acceptance remains NOT_RUN/INCOMPLETE. Copying a real address into a fixture is not a real-CA test.
3. **Use a legitimate frozen baseline.** Reassess an existing saved eligible thesis or save a genuinely passing current entry and freeze its thesis/profile. Do not fabricate an earlier PASS, backdate observations or force a rejected token into tracking to demonstrate management. If the selected CA cannot legitimately establish a baseline, report that dependency and obtain an agreed additional case without hiding the original result.
4. **Collect a fresh coherent reassessment.** Use current supported chain/venue, attention and social evidence, qualified stage observations, current relevant quantities and real source-bound quotes where required. Retain cutoff, profile/plan versions, policy versions, source receipts and quote expiry. All rows must belong to the same persisted management snapshot; do not combine the best known rows from different runs.
5. **Exercise management over time.** Keep at least the baseline plus a later real reassessment. Show changed evidence and thesis/position/proposal consequences. Test the supported DCA path with a valid hypothetical/manual position and actual quantity-specific proof when the frozen trigger is genuinely due. Test invalidation/exit review on a real case when its evidence genuinely triggers it. If a desired branch is not naturally observed, retain its deterministic regression evidence and mark that live path NOT_EXERCISED; do not manufacture its outcome or call all live paths proven.
6. **Inspect and replay.** Reopen the database, show the saved rows/evidence, and replay offline with the identical saved result/hash. Replay proves reproducibility of that snapshot, not that an expired quote remains current. Run another fresh reassessment when current validity is required.
7. **Publish the coverage result in the next response.** Include the report below whether all cases pass the completion gate or not. A partial response must say what is implemented, what was actually exercised on real CAs, and exactly why the strict gate remains unmet.

### Required results in your NEXT delivery response

Put the same sanitized result summary in this handoff when updating it. Do not end the next turn with only a test count or "packet finished."

- Reviewed/result commit SHA and branch; integrated Checklist 1 checkpoint SHA or explicit NOT_INTEGRATED.
- For each case: chain, **actual CA**, baseline/episode ID and time, current snapshot/cutoff/hash, policy/profile versions, manual/hypothetical/absent position mode, quote/proof identity and expiry when relevant. Keep private position details and credentials out of public documentation; retain full local proof securely.
- One pillar summary table with implementation state, validation state, PASS/FAIL/UNKNOWN/N/A counts and unresolved work/owner. Counts must reconcile to the exact 15 rows below.
- One full table per case: `MG ID | pillar/group | status | measured fact/predicate and configured threshold | evidence/basis references | unknown cause and next action if any`. Missing source data remains UNKNOWN, never zero by default.
- Source-level on-chain, attention and social coverage and rejected/unavailable evidence. A known aggregate row cannot justify claiming unavailable underlying indicators were measured. Report incomplete source scopes and whether they are actually required by the frozen rule.
- Verdict/proposal with its reasons, HOLD/reduction/EXIT_NOW urgency, relevant amount/units/mode, execution limitations and changed checks compared with a genuinely comparable prior snapshot. For HOLD/reduction include the frozen DCA-out legs, chosen duration/start/end, next reassessment and invalidation/deadline overrides. Include the original-plan traceability table required below.
- Exact offline validation commands/results, fresh real-run evidence, reopen/replay outcome and any live paths NOT_EXERCISED.
- A final explicit gate line for each case: `UNKNOWN = 0; ZERO-UNKNOWN GATE MET` or `UNKNOWN = N; INCOMPLETE — ZERO-UNKNOWN GATE NOT MET`. If no real run was possible, report `REAL_CA = NOT_RUN; INCOMPLETE` rather than a fabricated count. Overall completion cannot be claimed while any agreed acceptance case fails the gate or a mandatory acceptance path remains untested.

Scope completion and case validity are separate: zero UNKNOWN on one snapshot does not establish future availability, every chain, every venue or profitability. Name the supported scope and retain all agreed-case failures. The user requires a real, observable zero-UNKNOWN delivery on that scope, not a promise that future external data can never fail.

## Core decision contract: validate the entry thesis, HOLD or EXIT_NOW, and plan the exit over time

The user explicitly reaffirmed that Checklist 2 is the management half of the original strategy: **take the saved Checklist 1 thesis, determine whether current evidence validates or invalidates it, decide whether to keep holding or recommend exiting immediately, and, if holding, determine how DCA-out should proceed and over what duration.** A diagnostic row list without that decision and plan is incomplete.

Separate these concepts in the saved result:

- **Thesis assessment:** the actual frozen support/invalidation/catalyst and horizon predicates, baseline/current evidence, and what changed. A new generic entry PASS is not validation of an old thesis.
- **Management decision:** HOLD, a specified partial reduction while holding the remainder, or EXIT_NOW_RECOMMENDED, with a deterministic reason chain. Preserve the existing proposal enums for historical snapshots; a versioned additional action/urgency field may express the operator-facing meaning. REASSESS_REQUIRED is truthful when prerequisites are missing, but does not meet the zero-UNKNOWN production acceptance target.
- **Execution feasibility:** fillable, proven blocked, or unavailable proof for the relevant amount. Urgent exit recommendation is not a promise of a fill. A known blocked route can be a known negative result; unavailable evidence remains UNKNOWN and prevents completion.
- **Time-bounded realization plan:** the holding/reduction horizon, sell legs, deadlines and reassessment schedule, rather than only a quantity percentage or a generic `expiryAt`.

If the thesis is invalidated, recommend EXIT_NOW with urgency NOW and the specific triggering evidence; it overrides waiting for future profit targets or DCA dates. If sellability is blocked, state that beside the urgent recommendation without inventing a route or transaction. A supported weakening/reduction rule can recommend a partial exit without falsely declaring complete invalidation. If the thesis remains validated, HOLD must include the current DCA-out plan, including when no leg is due yet; when a leg is due, state that reduction and the plan for the remaining inventory.

### Required duration and schedule contract

The user's examples — 3 hours, 3 days, 3 weeks, 3 months — express the required range of horizons, not an instruction to hardcode those four outcomes or infer a fixed age-to-duration relationship. An expiry timestamp alone is not a DCA schedule.

For each supported HOLD/reduction decision, freeze and expose:

| Plan element | Required information |
|---|---|
| Identity/basis | Plan version, baseline thesis episode, current assessment/cutoff, manual/hypothetical position, reconciled original/remaining quantity basis |
| Chosen horizon | Duration with explicit units, start/anchor and end time (or documented calendar arithmetic/timezone), rationale and supporting stage/attention/social/on-chain inputs |
| Sell legs | Ordered amounts/percentages and their basis, unfilled remainder, price/market-cap/traction/time predicates actually used, and any time window/deadline; never assume mcap substitutes for executable price |
| Timing | Earliest action and latest deadline where configured, next reassessment time/cadence and reasons. The time horizon is separate from quote expiry and source freshness |
| Conditional behavior | Trigger-based, time-based, or an explicit combination; what happens when a target is never reached, a deadline expires, traction decays, or evidence invalidates the thesis |
| Partial execution | How reported partial/unattributed fills change future legs; no leg is consumed merely because its time arrived or a proposal was emitted |
| Override/cancellation | Immediate invalidation overrides the optimistic schedule. Changed thesis/basis requires an explicit successor/reconciled plan, not silently extending a deadline to avoid admitting failure |
| Availability | Missing required selection input/settings, stale quote or unobserved elapsed-time event stays explicit; never invent a known future market outcome |

Code owns deterministic policy selection, arithmetic, precedence, clocks and due-leg computation. LLMs may classify source-grounded narrative longevity/attention style and explain or propose within a versioned policy, with the existing independent qualification rules. They cannot invent numeric targets, fabricate volume/duration measurements, override risk limits, or return an unconstrained prose-only holding period. Strategy settings must be explicit and frozen; engineering heuristics are labeled as such, never represented as calibrated profitability or transcript-prescribed thresholds.

Respect the Checklist 1 thesis's horizon and risk profile. If current evidence changes the recommended duration, report the reason and the requested successor-plan change; do not silently rewrite the baseline. Never classify "we recommend holding for three weeks" as knowledge that the token will appreciate over three weeks. The known output is an evidence-grounded conditional plan, not a known future return.

Phase 1 recommends actions and records manual reports. It does not run an unattended stop-loss, wait months inside a CLI command, or execute scheduled trades. The output must say when the operator needs to reassess and that no new evidence is observed until another manual run. Phase 3 owns automatic execution.

### Temporal-plan validation and original-plan coverage

Add deterministic clock-boundary regressions for hours, days, weeks and documented calendar-month behavior; exact deadlines; late/missed reassessment; target never reached; invalidation before the first leg and between legs; early profit trigger; partial fill; revised position; unsupported horizon input; and unchanged historical replay. Do not wait three months to test date arithmetic, and do not present a simulated clock or future fixture as observed market history.

For the real-CA acceptance cases, show the actual current HOLD/reduction/EXIT_NOW decision and its saved horizon/plan based on real evidence, then at least a later real reassessment where available. The operator-facing plan and required selection inputs must be known at delivery. Unobserved future legs are conditional future actions, not UNKNOWN current facts and not fabricated executed fills. Cover natural live outcomes without forcing markets to hit a chosen test target; mark any mandatory live path that was not exercised as incomplete.

Before claiming both checklists cover the original plan, add a traceability table to your next result: `accepted Phase1 requirement | source section | Checklist1/Checklist2 owner | implementation symbols | offline proof | real-CA snapshot/evidence | remaining gap`. Use `plans/backend-v1/06-preplan-traceability.md`, `07-round-two-lessons-and-contracts.md` (especially the three-part thesis/invalidation/profit-realization plan and duration/attention-style material), and `09-two-checklist-lifecycle.md`. If raw transcripts are not supplied in your clone, state that you checked the maintained mappings rather than pretending to reread the originals. Coordinate Checklist 1 entries with its owner and do not mark unpublished or unverified work done.

Cover the accepted manual due-diligence/management scope. Existing explicit exclusions for experimental actor research, Phase 2 discovery and Phase 3 trading are not secretly added to this task. Conversely, do not claim literally every transcript idea is implemented while declared deferrals remain. Report scope coverage honestly and name any unresolved Phase 1 item before calling the two-checklist workflow ready for real-life testing.

## Confirmed findings and boundaries

Source line references below refer to reviewed SHA `9d8c218`, not the owner's divergent working files.

### R1 — exact sale feasibility is still unimplemented (release blocker; planned packet 3)

`src/domain/policy.ts:138` makes MG-15 PASS when `candidate && exit === 'PASS'`. The exit comes from EXE-01/EXE-02, whose profile-sized round trip does not prove this proposed sale. The existing `dca-proposed` scenario yields DCA_OUT_PROPOSED for **400 atomic units** with MG-15 PASS and no candidate proof input.

This is an inherited, explicitly deferred gap, not a newly introduced packet-2 regression. It must be closed before describing quantities as execution-supported. Preserve historical v0/v5/v6 outputs on replay; the new policy must make missing proof UNKNOWN/REASSESS_REQUIRED rather than silently continuing the legacy positive result.

MG-03 also needs quantity context: reusing entry-sized route features does **not** prove exit for the original holding or current remaining holding. Correct the collaborator proposal's description of those rows as judging the "original position." Separate the relevant remaining/scenario-quantity safety proof from the exact planned-reduction proof. Neither substitutes for the other.

### R2 — the proposed quote-binding ledger revision can collide (packet-3 prerequisite)

`src/domain/ledger.ts:67` constructs `revision` only from effective event IDs and recorded/effective timestamps. Packet 1 hashes that string as a basis reference; the packet-3 proposal would reuse it as an execution binding. It excludes the initial position and event economic payload.

Reproduction with allowed inputs: start at 1000 units, record a 200-unit sale, then add a CORRECTION replacing it with 100 units at the same accepted effective/recorded timestamps. Remaining inventory changes **800 -> 900**, while `revision` and its SHA-256 stay identical. Changing the initial cost from 100 to 200 likewise changes remaining cost **80 -> 160** without changing that revision. These are content-identity collisions, not cryptographic hash failures.

The ledger revision predates these packets; the new trace exposes it and the proposed proof would rely on it. Do not change legacy hashes in place. Add a versioned canonical **execution-basis fingerprint** covering token/case/position identity and initial position terms, episode/frozen plan and quantity basis, effective as-of event/correction payloads, and reconciled resulting inventory/attribution. Binding must change when decision-relevant basis changes, while excluding facts unavailable at the historical cutoff. Keep legacy `revision` behavior for existing policy results unless separately versioned. Quote freshness is a separate time check, not a substitute for this binding.

### R3 — successor plans can silently inherit another plan's leg consumption (unfinished lifecycle requirement)

`src/app/service.ts:164` accepts successor theses without quantity-plan reconciliation; `soldByLeg` is keyed only by leg ID. A Service probe saved a 40% leg, recorded its 400-unit sale, then accepted a successor with the same leg ID/shape. The new episode's MG-12 became PLAN_EXHAUSTED with 600 units still present.

That result may be correct for an explicitly continued plan, but the API does not distinguish continuation from replacement. Conversely, fresh IDs alone do not solve it: percentages still use original q0, not automatically the remaining inventory. The collaborator already disclosed the limitation. Complete it through explicit reconciliation, not a documentation-only instruction to choose fresh IDs.

For the smallest sufficient design, distinguish continuing a leg with carried fills from replacing/rebasing a plan. Freeze the chosen quantity basis and attribution. Reject ambiguous successors, or persist their unresolved reconciliation and block quantified proposals, while still reporting known invalidation. Never silently reset fills. Do not retroactively reject or rewrite historical accepted episodes. Specify this contract before editing shared persistence.

### R4 — hypothetical DCA output lacks its mode (operator-output requirement)

`src/domain/policy.ts:145-149` emits `positionMode` only for EXIT_REVIEW. A HYPOTHETICAL `dca-proposed` input returns quantity 400 with no `positionMode`. The management snapshot's normal result does not otherwise expose that position record. This omission predates the new DCA behavior; packet 2 addressed only exit-review display.

The next output version must identify MANUAL_REPORTED versus HYPOTHETICAL for **every position-derived quantity or financial estimate**, including DCA, plus position/basis reference, decimals/units and relevant remaining quantity. No position means explicit unavailable context. Scenario results never assert the operator's actual profit, principal recovery or guaranteed protective sale. Add a real Service/CLI output test, not only a type assertion.

### R5 — current branch is not yet compatible with owner v1-v4 replay (expected integration gap)

`src/domain/management-trace.ts:20,172-181` knows v0/v5/v6 and accepts only the old input list. A v4 call fails UNSUPPORTED_POLICY_VERSION. That is an appropriate fail-closed response on this isolated old-base branch, not a reason to weaken it.

The owner's `Service` stores schema-v2 frozen `policyFeatures`, details/social facts, and dispatches qualifier modes for v1-v4. Merely adding those labels to `LEGACY_MANAGEMENT_POLICY_VERSIONS` is insufficient proof of compatibility, even if MG-12 matches: preserve each label's input qualification, reused entry rules, result shape, feature version, and hash dependencies. Keep the owner's existing v0-v4 replay route until explicit equivalence is tested. Never feed raw features to a historical qualified snapshot.

### R6 — stage and longitudinal output remain partial (remaining planned scope)

`resolveStage` currently selects cap/age bands; `evaluateManagement` uses them for MG-05 context, not the full cap x age x attention-style rule parameters in plan 09. On the owner live path, qualified cap and token-creation values currently remain null. StageInputs carries no observation references. Comparison output is a coarse diff rather than the planned prior-comparable volume/attention windows and changed-check explanation.

Implement stage-dependent rule selection with explicit versioned profile data and honest missing values; do not fabricate chronological thresholds, volume feeds, cap, creation time or history. Independent safety/invalidation must keep working when stage-dependent rules cannot. Numeric trends require actual comparable measurements, not boolean O28/A18 qualifications or two arbitrary snapshots.

## Architecture and scope that remain binding

Checklist 1 owns acquisition/qualification of on-chain, attention and social facts. Checklist 2 owns deterministic management, position/plan accounting and its tests. Owner coordinates shared contracts, policy helpers, Service/replay, CLI and schema integration while Checklist 1 is unpublished. Use existing TypeScript/ESM, Zod, Decimal/bigint and `node:sqlite`. No new frontend, service framework, Convex migration, scanner or trading engine.

Read `CONTRIBUTING.md`, verified source, `agentic/architecture.md` and `plans/backend-v1/09-two-checklist-lifecycle.md`. The plan is the intended contract, not proof every proposed command exists. `AGENTS.md`, `bridgecode/` and the active task board may be local-only; use applicable supplied instructions and required specialists, but no private files/chats/keys are dependencies. Main agent does planning; only Bridgecode-required independent reviewers are requested.

A saved passing entry activates reassessment immediately. Cap/age select rules and cannot postpone early invalidation. Late first inspection does not reconstruct an earlier thesis. The cap bands are MICRO [0,100k), SMALL [100k,1m), ESTABLISHED [1m,10m), LARGE [10m,infinity); FDV is not circulating cap and pool age is not token creation age. Exact age bands, trading windows and profit/risk settings are explicit profile choices, not invented course rules.

Thesis state precedence remains INVALIDATED for known prohibited safety/invalidation/expiry, otherwise UNVERIFIABLE for required missing evidence, otherwise WEAKENING for failed support, otherwise VALIDATED. Proposals remain EXIT_REVIEW, REASSESS_REQUIRED, REDUCE_REVIEW, DCA_OUT_PROPOSED or MAINTAIN_THESIS under the documented prerequisites. Provider failure never proves an unsellable token. No continuous monitoring or order execution exists in Phase 1. Missing position restricts quantification, not all thesis evaluation.

User's intended initial chain set is Solana/BSC/Base/Robinhood, with explicit partial support. Free data first, configurable budget/size/horizon. Neither four chain names nor fixture PASS establishes live coverage. The owner's unpublished Solana/attention/social work cannot be recreated from assumptions.

## Round-two implementation decisions and sequence

These are the technical directions for the next handoff, not changes already implemented. Resolve ordinary implementation details within this contract; ask only for genuinely user-owned strategy choices. No need to reopen ten general approval questions before starting deterministic work.

### A. Keep the delivered work and protect its history

Retain v5/v6 as the identifiers already used by these delivered packets; reserve them for those semantics. Owner v1-v4 remain reserved too. Use a distinct next policy version (v7 if still unused at implementation time) for changed feasibility/output behavior. Snapshot schema, management-rule version and entry/qualification version are distinct concerns. A rules table is acceptable if it preserves the full behavior required by each historical label; it is not enough to parameterize only sell order.

Do not regenerate v0/v5 golden expectations from newer code. Add a v6 capture from the reviewed implementation before changing fresh semantics. Preserve old hashes, late-report cutoffs, baseline/episode lineage and operator databases. The owner remains shared integration custodian. No date is promised for publishing Checklist 1; proceed with deterministic packets in your own branch meanwhile.

### B. Build the fingerprint and reconciliation foundation

Implement R2's new execution-basis fingerprint and R3's explicit successor reconciliation. Keep each patch bounded and separately reviewable where their persistence dependencies differ. A temporary unknown/reconciliation-required outcome is acceptable where a plan has not explicitly resolved its basis; a silent reset or fictitious proof is not.

Tests must cover same-timestamp corrections changing quantity, cost/fee or leg attribution; distinct initial positions; repeated unchanged as-of state; future-recorded corrections excluded; carried partial fills; successor continuation; replacement with reused IDs; fresh IDs with old q0; oversize remaining plan; and no change to legacy replay. Decide and document deterministic canonical ordering, without hashing mutable presentation strings as identity.

### C. Implement packet 3 with a corrected proof contract

The collaborator's CandidateExitProof direction is suitable, with the following corrections. Use a strict typed schema and a discriminated result: a BLOCKED route need not invent positive proceeds, and an unsupported/unavailable provider never fabricates a BLOCKED proof.

| Boundary | Required contract |
|---|---|
| Identity | Chain/token, case/position and episode/plan binding, candidate leg, exact atomic input quantity and decimals; match current reconciled execution basis |
| Basis | New versioned execution-basis fingerprint, not hash of the old metadata-only ledger revision |
| Time | Quote/state as-of, local observation/availability and expiry; enforce as-of/available <= cutoff < expiry. Evidence acquired after cutoff cannot be backdated |
| Evidence | Nonempty resolvable evidence IDs, supported adapter/route and actual source binding. A claimed level/string or hash alone is not authentication |
| Qualification | QUOTED versus SIMULATED with explicit required policy/profile level; research-only profile may allow QUOTED, but no silent general live certification or upgrade of imported data |
| Economics | Explicit quote asset and units, positive/finite amounts where applicable, coherent gross/net costs, declared fee inclusion and source-supported conversion for fees in another asset. Missing conversion is unknown, not free |
| Slippage | Define `minOut` as a minimum output amount with asset/units, distinct from any slippage tolerance in bps; validate relevant inequalities and configured limits |
| Outcome | Fillable within limits, proven blocked on a supported path, or insufficient/unavailable evidence. Conflicting matching proofs cannot be cherry-picked into PASS |
| Persistence | Strict optional bundle/assessment field and frozen proof/request in snapshots, versioned replay and bounded collections; no forged LIVE provenance from imports |

A user import can supply a labeled scenario/claimed quote, but cannot certify live selling simply by asserting QUOTED/SIMULATED, FILLABLE or evidence IDs. Follow existing import versus trusted-live boundaries. Synthetic tests may exercise all outcomes without claiming market reality. Checklist 2 validates and consumes proof; Checklist 1 produces real supported receipts and quantity-specific observations. Until such a producer exists, live MG-15 stays UNKNOWN with an explicit cause.

Expose the exact quote request even when proof is missing: token/case/episode/position, leg, atomic amount, decimals and execution-basis fingerprint. No trade is placed. Missing, stale, mismatched, insufficient or conflicting proof => UNKNOWN and no positive DCA. Due but oversized candidate => QUANTITY_CONFLICT/reconciliation required; do not let an earlier generic NO_ELIGIBLE_LEG branch hide it. Supported blocked/over-limit proof => MG-15 FAIL. Coherent fresh fillable proof within configured limits can PASS.

Reuse `risk.maxExitImpactBps` unless an evidenced requirement needs a distinct limit. All other costs/minimums required by the selected profile must be explicit and enforced. Do not add strategy defaults through an LLM. Classify no-liquidity/quantity-specific failure separately from token-wide restrictions. Candidate infeasibility alone gives REASSESS_REQUIRED; independently established forbidden token-wide safety or relevant-position exit restriction follows the existing INVALIDATED/EXIT_REVIEW precedence. EXIT_REVIEW must still say if execution is BLOCKED/UNKNOWN, never promise a protective fill.

Correct MG-03 separately through relevant remaining/scenario-quantity proof. Positive candidate proof does not override failed safety; entry-sized route evidence does not certify remaining holdings. Coordinate this shared proof production contract with Checklist 1 while building pure deterministic consumers now.

### D. Finish timed management plans, operator context, stage behavior and combined acceptance

Implement the HOLD/EXIT_NOW and timed DCA-out contract above, then apply R4 to every sized proposal and financial estimate. Save/display case/token/episode/baseline/current cutoff, thesis state and proposal reasons, decisive changed rows, position mode/basis/remaining inventory, exact candidate/proof/expiry and execution limitations. Net proceeds/principal-recovery intent only when the required recorded costs and comparable quote evidence exist. Make missing context explicit.

Implement stage-dependent parameters with explicit profile versions, cap/creation provenance and source availability. Bind a previous comparable snapshot when a rule needs change over time; distinguish evidence change, policy/profile change and intentional successor-thesis change. Missing comparable history stays UNKNOWN. Do not demand an unsupported live feed to test deterministic behavior; track the collector dependency separately.

Finally merge an owner-published checkpoint into a clean collaborator branch and coordinate shared wiring. Preserve `analyzeLive`/`reassessLive`, schema-v2 frozen qualified inputs, details/social facts, qualifier modes and v0-v4 replay; add v5/v6/new-version dispatch deliberately. Do not overwrite whole Service/policy/contracts/CLI files from the older base. Test actual combined CLI paths and offline replay, including safe missing-proof behavior. Live provider acceptance is separate from fixture acceptance and can remain a precisely stated external dependency rather than invented proof.

## Required regression and completion gates

For each packet, run its focused tests and the established `npm run typecheck` / `npm test` block when stable. New tests belong to the management owner and must exercise production functions/Service/CLI, not an independent implementation of the same equations.

The round-two acceptance matrix must include:

- No candidate proof; exact matching proof; wrong token/chain/position/episode/leg/quantity/decimals/basis; missing evidence; future/unavailable/stale/expired quote; contradictory proofs; unsupported provider; costs/units inconsistent; blocked route; over-limit impact; valid scenario versus trusted live proof.
- Same-timestamp correction fingerprint changes, unchanged-state stability, no future-information leakage, and carried/replaced successor plans.
- HYPOTHETICAL and MANUAL_REPORTED mode in DCA and EXIT_REVIEW output, plus absent position and unknown cost. No false principal-protection claim.
- Consumed/partial/unattributed/exhausted legs, due quantity larger than remaining, known invalidation despite unrelated missing data, and missing stage without lost safety.
- Exact cap boundaries, missing creation/cap, pool migration, cap decrease, selected parameter versions and missing prior comparable measurements.
- v0/v5/v6/new-version saved replay in your branch; v1-v4 with actual qualified frozen inputs after owner integration. Unknown versions still fail closed. Goldens never silently updated to hide a regression.
- CLI save/reopen/show/replay and backup/restore if persistence changes; tests always use dedicated temporary database/artifact directories.

Definition of done for **all Checklist 2**, rather than one packet: required management and position semantics and the timed HOLD/EXIT_NOW/DCA-out plan implemented, no unsupported positive quantity/financial claims, clear inspectable output, compatible historical replay, demonstrated combined manual entry-to-management flow, and the strict real-CA ZERO-UNKNOWN gate above met for every agreed acceptance case. Explicit explanations of unknowns are useful diagnostics but do not satisfy completion. A deliberately unsupported chain need not be falsely certified to finish the supported scope; the support boundary must be named.

## Delivery, ownership and single source of truth

Continue on `codex/checklist-2` or a topic branch descended from reviewed HEAD. Do not reset to the original base. A clean new clone can check out reviewed HEAD detached to reproduce this review, then create a new topic branch. Preserve your existing work before any switch/merge.

Update this file with the result SHA, completed acceptance items, actual commands/results, sanitized examples, migration/version changes, known collector dependencies and next bounded action. Use `CONTRIBUTING.md` for the ownership/merge agreement. Older collaborator packet files can remain historical references; they must not continue directing a new agent to restart packet 1 or use the old ledger revision as execution proof.

Keep `agentic/architecture.md` current in your clone, scoped to verified management behavior. Do not overwrite active owner work. Public commits exclude credentials, private endpoints, operator positions/journal, source transcripts and raw model material. Do not publish or trade without authorization in your own session.

**Next action:** preserve a v6 golden baseline, implement the execution-basis/reconciliation prerequisites and corrected packet 3, with explicit scenario/live separation and mode-labeled output. Coordinate shared live integration with the owner when a Checklist 1 checkpoint is available, then run the mandatory real-CA pillar/row acceptance and include its complete results in your next delivery; if blocked before then, report partial progress and NOT_RUN/INCOMPLETE. This review requests further implementation; it does not merge the current branch or declare Checklist 2 complete.
