# Contributing: Checklist 1 and Checklist 2 workstreams

This is the two-person agreement for MemeHunt's Phase 1 backend. The project owner develops and iterates **Checklist 1: entry due diligence**. The collaborator develops and iterates **Checklist 2: saved-thesis reassessment, invalidation and exit proposals**. Each owns implementation, fixtures, tests and documentation for their workstream. This replaces the previous Person A/core versus Person B/evidence allocation, including historical ownership references in architecture notes.

Both checklists belong to Phase 1: manual due diligence through the CLI. Phase 2 automatically discovers candidates; Phase 3 executes trades. Neither is authorized by this agreement. Checklist 2 proposes actions; it does not sign, broadcast, place orders or promise an active stop-loss.

## Starting point and publication boundary

Verified against GitHub `refs/heads/main` on 2026-10-05:

```text
27273cff16b334c6ba54187bd0170efad611f446
Docs commit: docs: record history cleanup limits
Repository: https://github.com/LycurgusxLycurgus/MemeHunt
```

The owner's current branch is `codex/entry-workflow-production`, with substantial **uncommitted** Checklist 1 work. Its HEAD still equals this published commit. A clone of that SHA does not receive the new work. This agreement and the [Checklist 2 handoff](handoffs/checklist-2-collaborator.md) may initially arrive out of band; use the supplied versions even when the old checkout contains the previous ownership agreement. Publishing these documents does not imply publishing the runtime work.

| Area | Published starting commit | Newer owner working tree; unavailable until published |
|---|---|---|
| Foundation | TypeScript/ESM, Zod contracts, Decimal/bigint arithmetic, Node SQLite persistence, CLI, immutable snapshots and fixture/import analysis | Additional live contracts, configuration and reports |
| Entry | 33-check catalog, feature/evidence bundles, evaluation and saved-thesis activation | Saved workflow profiles, 61-feature baseline derivation, live collection and qualified attention/social policies |
| Management | MG-01 through MG-15, evaluation, stage resolver, frozen episodes, reassessment, manual ledger, ordered exit proposals, successors, replay and journal | Qualified inputs, assessment details and newer shared policy dispatch; full plan remains incomplete |
| Acquisition | Some provider files; not today's live pipeline | Solana mint/control/holder acquisition, bounded canonical WSOL PumpSwap path, attention/comparison recovery and social work |
| Evidence of readiness | Existing offline foundation to extend | Recorded validations for prior local changes; latest supplied social completion cycle is unfinished |

Four chain identifiers do not imply complete live coverage. Solana, BSC, Base and Robinhood remain the intended first coverage set; unsupported chains and venues report partial support. Current local EVM acquisition is explicitly unimplemented. Free data first and configurable limits remain the direction. Acquisition failure is not a token-level negative finding.

## Ownership by behavior

**Checklist 1 owner (project owner)** owns entry rules/verdicts; on-chain, attention and social acquisition/qualification; existing `src/providers/`; `src/app/live.ts`; entry projection/configuration/reporting; and entry/provider/semantic tests. This includes finishing the active social cycle. The owner temporarily coordinates shared-file integration while the newer tree remains unpublished.

**Checklist 2 owner (collaborator)** owns management rules/explanations; frozen-thesis comparison; consumed exit-leg behavior; manual-position accounting; management scenarios/fixtures/tests; and management documentation. Extend the existing foundation. Add focused management modules/tests where that makes older-base work independently reviewable; do not build duplicate ingestion or a second permanent management engine.

The collaborator owns Checklist 2 end to end, including proposing its schema and CLI changes. Shared files need coordination because both workstreams use them, not because one person owns all backend logic.

| Boundary | Checklist 1 responsibility | Checklist 2 responsibility and coordination |
|---|---|---|
| `src/domain/contracts.ts` | Common evidence/feature/snapshot contracts and local live extensions | Management result, position, episode and execution-proof additions; agree shapes/defaults/version behavior before shared edits |
| `src/domain/policy.ts` | `evaluateEntry`, qualification modes and entry interpretation | `evaluateManagement`; coordinate shared predicate helpers and `resolveStage`; never replace the whole file from the old base |
| `src/domain/ledger.ts` | Consumer compatibility and source-bound execution inputs | `reduceLedger`, `proposeLeg`, inventory/cost/leg reconciliation and tests; notify owner before exported-signature or historical-behavior changes |
| `src/domain/catalog.ts` | Feature registry and `entryDefinitions` | `managementDefinitions`; preserve MG IDs; agree shared feature IDs/units |
| `src/app/service.ts` | Persistence, live qualification, hashes and replay/version dispatcher | Management, episode, position and journal changes through a small coordinated patch; preserve local live methods and historical replay |
| `src/cli.ts`, `src/app/config.ts`, `src/app/report.ts` | Shared command/config/output integration; latter files are local-only at the starting SHA | Management-facing behavior after agreement; do not recreate missing local files on the older branch |
| `tests/`, `examples/` | Entry/live/source/semantic coverage | Management/ledger coverage; mixed `policy.test.ts`, `service.test.ts`, `examples/fixtures.ts` are shared; prefer focused new files where useful |
| Schema and package manifests | Owner integrates agreed changes | Propose smallest justified change plus compatibility/migration proof; no database/framework replacement for convenience |
| Architecture, README, plans | Common map and entry sections | Management sections; preserve both sides' facts and distinguish intended from implemented behavior |

Before a shared patch, exchange affected symbols, old/new signatures, a small input/output example, missing-data behavior, replay/version effects and the designated integration writer. Agree one writer for that patch. Independent work continues while shared interfaces or collectors are pending. Temporary management-specific types may live beside the new module; remove duplication when integrating the shared contract.

## Contract between the checklists

Checklist 1 supplies qualified, chain-bound evidence/features. Checklist 2 consumes them with a frozen thesis, profile, cutoff, optional position/events, and available stage/execution evidence. Management does not fetch providers, let an LLM invent thresholds, or qualify raw claims itself.

A passing saved entry with a frozen thesis opens tracking atomically. Management is available immediately, even below $100k or minutes after creation. A later manual reassessment runs it. Age and circulating cap select parameters; they cannot delay known invalidation. Late first inspection has no invented earlier baseline. A PASS or proposal never proves a buy occurred.

[Plan 09](plans/backend-v1/09-two-checklist-lifecycle.md) defines the intended lifecycle. Verify installed fields and commands against source. Plan 10's original foundation-build starting point is superseded for this collaborator: that foundation already exists.

Preserve these invariants:

- Token identity includes chain and address. Pool age is not token creation age; FDV is not circulating cap. Missing stage cannot suppress independent safety findings.
- PASS, FAIL, UNKNOWN and NOT_APPLICABLE remain distinct. Acquisition/model failure is UNKNOWN, not proven fraud, blocked selling or zero activity. Independently qualified adverse evidence can FAIL a criterion.
- Management computes its own thesis state and proposal. Known invalidation wins over unrelated unknowns. Missing position blocks quantified position claims, not all thesis analysis.
- Manual and hypothetical positions stay distinct. Atomic inventory uses bigint and money uses Decimal. A proposal does not consume a leg; attributed reported fills do. Unknown cost is not zero cost.
- Effective time and recorded/available time both constrain historical results. Successors preserve baseline linkage and carried fills. Historical lookup must not substitute today's episode for the one at the cutoff.
- Snapshots, evidence and qualification remain inspectable and immutable. Preserve old replay results/hashes. A new policy label alone does not protect old behavior if shared evaluators/ledger functions change.
- Quantified exit feasibility must bind the proposed quantity, ledger revision, route, costs and valid quote. Original entry-size evidence cannot certify a later sale. Missing proof stays explicit.

Current local `evaluateManagement` has trailing qualification-mode and social arguments absent from the published base. Current Service dispatches management v0 through v4 with qualified features. Do not allocate those names independently or drop those arguments during merge. Agree a distinct new management policy identifier and retain the complete historical dependency behavior, including ledger/predicate semantics where needed.

## Start from the older commit in a separate clone

Use an independent clone, dependencies and data directory. Do not switch, reset or clean the owner's dirty checkout. These commands are for the collaborator's new clone:

```powershell
git clone https://github.com/LycurgusxLycurgus/MemeHunt.git MemeHunt-checklist2
Set-Location MemeHunt-checklist2
git fetch origin
git switch -c codex/checklist-2 27273cff16b334c6ba54187bd0170efad611f446
git rev-parse HEAD
npm ci
npm run typecheck
npm test
```

Use Node 24 or newer. `npm test` includes the build. SQLite uses `node:sqlite`; obsolete suggestions for another binding or Convex are not implementation instructions. Diagnose baseline failures and report them honestly. The SHA is a starting pin, not permission to reset existing work. If the branch already exists, inspect it and choose an agreed fresh name.

Build deterministic management/ledger behavior and redacted fixture/import cases available at the base. Keep shared integration edits in a small, separately identified commit/patch. Offline fixtures cannot authenticate a live route, controls or actual trading result. No keys or paid services are needed for the first management slice.

## Exchange work in both directions

Each person commits reviewed work from their own clone/branch. Inspect status and the explicit diff; stage named files/hunks. Never stage another person's uncommitted changes or publish secrets/local records. Push only when authorized in that person's task; this document is not an instruction for an assistant to publish immediately.

Every exchange supplies source branch, **exact commit SHA**, base SHA, changed shared contracts, actual validation, gaps and migration instructions. Preserve your own work before merging; do not merge into a dirty tree. Once the owner publishes a coherent Checklist 1 checkpoint, the collaborator merges that checkpoint into Checklist 2 and validates compatibility. The owner can similarly merge reviewed Checklist 2 advances into their topic branch, or integrate them through a PR to `main`.

```powershell
git status --short
git fetch origin
git show --stat <agreed-published-sha>
git merge <agreed-published-sha>
npm ci
npm run typecheck
npm test
```

Replace angle-bracket placeholders before running. Normal merges preserve shared ancestry. Do not copy entire older files onto the newer tree, force-push shared branches, or rebase exchanged history without agreement. Avoid independently cherry-picking the same patch into both branches and then treating the copies as shared ancestry.

Resolve conflicts by contract and behavior, never blanket "ours" or "theirs." The domain owner resolves the decision; both inspect schema, policy dispatch, CLI and persistence consequences. If a needed provider capability is unavailable, preserve explicit UNKNOWN/unsupported behavior. `main` receives the combined validated change through a reviewed PR. Do not assume GitHub branch protection enforces this agreement.

## Validation and release packet

Run baseline checks in the isolated clone, focused checks for each change, then `npm run typecheck` and `npm test` on the combined tree. Use `npm ci` with the agreed lockfile when dependencies change. Repeat live calls only for a justified acceptance need; fixture checks are not live acceptance.

Management regressions cover early invalidation; missing/exact-boundary stage; weakening versus invalidation; optional positions; consumed, partial and unattributed sales; ordered legs; stale quantity/quote proof; successor lineage; late-recorded events; and old-policy replay. If schema changes require migration, demonstrate backup/restore and old-data compatibility before integration. Tests use separate directories and explicit database paths: content artifacts are adjacent to the DB, so sharing its parent directory is unsafe too.

A release packet gives commit/base SHA, problem/resulting behavior, changed contracts/version IDs, actual commands/results, capability gaps and sanitized fixtures. Incorrect positive results, oversells, changed historical results or lost evidence block the affected capability. Explicit missing coverage remains a capability gap. Preserve evidence while repairing failures.

The repository is public. Keep credentials, `.env`, private endpoint URLs, operator positions/journal, raw model envelopes/thoughts, private transcripts and `.data/` out of commits and public handoffs. Share synthetic/redacted fixtures. Ignore rules also exclude `AGENTS.md`, `bridgecode/` and `agentic/analysis.md`; collaborators may not have them. Follow applicable supplied instructions, but do not depend on private files or add them to Git to make this handoff work.

Each clone maintains its own active checklist. Read `agentic/architecture.md`, verify it against checked-out source, and add management knowledge in scoped sections. Preserve unfinished social work if operating in the owner's directory. In this planning chat, the main agent does planning directly; use sub-agents only for reviews required by applicable Bridgecode instructions. Agent review does not replace the other person's integration review.
