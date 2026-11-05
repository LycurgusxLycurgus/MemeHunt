# O22 holder-weighted observed-reference age completed

O22 now derives the full original C5 holder population as KNOWN, with zero unclassified holding weight. First native review and root verification passed; the correction stage was unused. Cycle `o22-holder-weighted-reference-age-20261030` is CLOSED. This completes O22's accepted historical measurement, while the broader checkpoint remains incomplete.

## Result and meaning

The original C5 population contains 35,168 token accounts and 15,875 positive owner addresses at slot461595081, blocktime2026-10-26T08:24:12Z. The fixed24h boundary is Oct25T08:24:12Z. All owners remain included, including program custody and passive, nonsigning or failed-transaction references. Raw mint slot461595080 is adjacent rather than identical; exact supply equality is a measured sanity check, not a no-issuance attestation.

13,076 owners have positive dated OLD references. Another2,799 have positive first observations inside the interval and their own empty older-prefix and canonical-before queries. Recent held weight12671173872863 /total991154089933080 gives fraction0.01278426230750712317, approximately1.278426%. The one NULL earliest timestamp uses a separate dated older witness; no timestamp was imputed.

FRESH is conditional on the declared complete provider direct-address index over slot0..populationbank, ANYstatus and tokenAccountsnone. The two same-provider negative queries corroborate that premise; they do not independently authenticate it. This measures observed address references, not wallet birth, signing, first-ever activity, people or common control. Hashes bind retained bytes, not provider transport, completeness or deployed binaries.

## Implementation and operation

`src/providers/advisory-holder-age-source.ts` validates the full source container, original evidence and raw population, exact owner roster, native requests, bytes, clocks and role joins. `advisory-holder-age-import.ts` imports only the exact bounded regular-file directory. `advisory-holder-age.ts::validateHolderReference/deriveO22HolderAge` validates native address references and computes complete BigInt weights and a once-rounded fraction. Parsed writable flags retain effective sanitized semantics; they are not inverted into raw header readonly counts.

`src/app/{live,advisory,service}.ts`, CLI and domain versions select proof57/facts56/policy54 through the explicit option. Its sources authorize only O22. Existing<=56/default outputs, ordinary quotas, entry policy and dependencies remain preserved. Missing or contradictory source/owner weight never becomes partial KNOWN or zero.

After `npm run build`, use an actual capture directory and the repository's normal profile/database options:

```sh
node dist/src/cli.js analyze C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump \
  --chain solana --partial --advisory --o28-expanded \
  --o22-holder-age-capture DIRECTORY --profile PROFILE --db DATABASE --json
```

The directory contains strict `capture.json` and all catalogued `chunk-N.deflate` files. Purpose limits are33 outer artifacts/32 chunks,500KB manifest,32MB inflated per chunk,768MiB total chunkJSON,512MiB decoded native,128MiB stored wrappers,32768 records,20000 owners and100000 population accounts. New allowance applies only after exact own-source validation. Ordinary24/64MB, evidence1000, details8MB and original holder archive limits are unchanged. There is no trading, signing, broadcast or push authority.

## Acceptance evidence

Actual native snapshot `7f35fad9-7ac4-4395-b363-4dbfd501764d`, hash `bb92a7476e491d28acdedfee4a2dccf9d2e9dda10c4581c513510653736b4dfc`, cutoff2026-10-30T11:40:57.675Z.72 ordinary HTTP reads plus the retained container; actual CLI save, complete raw reconstruction, idempotence, reopen and OS-network-denied CLI replay pass. Entry remains FAIL.

Full C5 sources contain21,478 records,229,109,363 decoded native bytes,9 chunks and50,069,222 stored wrapper bytes. OriginalOct26 population clocks, actualOct30 history/banktime retrieval and local11:40:15.486Z packaging remain separate. Original holder query wire was not retained and is explicitly disclosed. Acquisition journals preserve the actual429 and unmatched interrupted dispatch; neither is relabeled as a successful native RPC response.

An independently authored Python raw oracle checks every owner and matches63,504 production fields. The genuine full ClaudeCoin115-owner control is all positively OLD/fraction0, with separate actual57CLI persistence/offline acceptance. Seven frozen snapshots across C5, Parasite and ClaudeCoin preserve old facts, hashes, clocks, copied DB, offline replay and fresh-ingress fences. Historical MISSING controls stay missing; this is not three fresh positive captures. C5 and ClaudeCoin same-source57vsfrozen51 comparisons preserve all49 other metrics exactly.

Build,23 focused and2,329 full tests pass, with0 failures and1 existing optional skip.16 source/test files,118 runtime/test-copy files and483 outside-owned tracked pins passed before authorized condensation. Maintained tests cover positive/negative/NULL histories, exact weights, source integrity and bounds, source-purpose quarantine, mode guards and persistence. Claude fixture is a genuine complete115-owner population; the mixed fixture labels its small constructed population/weights separately from unchanged genuine history preimages and clocks.

Actual Claude Code CLI planning used Opus5.5, session9a7c7cde-fd53-4ef2-8c22-590c185541e6, tools[], exit0. That consultation informs the work and is separate from the fresh native implementation review, which returned PASS. Root verification also passed; no correction or terminal second review was required.

## Recovery and next item

Durable map: `agentic/architecture.md`. Active umbrella checklist: `agentic/analysis.md`. Exact private contract, acceptance, review-cycle, root verification, native/oracle/history and source/runtime evidence are in `.data/all-unknown-20261029/o22-implementation/`; portable original C5 source is `.data/all-unknown-20261029/o22-portable-c5-capture/`. Specialists best-agent and writing were loaded. Relevant source symbols and test ownership are listed above; no unresolved user decision blocks the next action.

Continue A12 with a fresh complete qualified factual catalog and a separately accepted comparison mechanism. Research proves zero target capacity and positive mandatory peer capacity at one shared bank, but that is not catalog qualification or A12 closure. Preserve new linked token leads and all genuine supported members. After this O22 commit, the cross-snapshot unresolved-identity ledger contains26; that count is not a simultaneous all-metric snapshot result.
