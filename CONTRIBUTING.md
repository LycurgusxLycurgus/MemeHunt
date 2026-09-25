# Two-person backend ownership and merge contract

Assign the two people by role at the start of work. **A (Core and release)** owns `src/domain/contracts.ts`, `policy.ts`, `ledger.ts`, `src/app/`, `src/cli.ts`, database migrations, `package.json`/lockfile, release documentation and integration. **B (Evidence and validation)** owns `src/providers/`, `src/domain/catalog.ts`, `tests/`, `examples/`, provider/venue certificates and labeled semantic evaluation. A owns any shared schema/API decision; B owns whether provider evidence supports a certification claim. For a boundary change, the owner proposes the interface and the other reviews its impact before either edits dependent files.

This directory had no Git repository or remote when backend implementation began. The current Sol/Luna pass used disjoint files in one directory; it was not a branch merge. For ongoing work, `main` is the integration branch and each packet uses its own topic branch. A merges only after the other person reviews the packet and both run `npm ci`, `npm run typecheck`, and `npm test` against the combined tree. A PR or merge handoff states its changed contracts/migrations, reproducible commands, results, capability gaps and redacted fixture. The owner of a conflict resolves the code; both check the assumptions and rerun affected tests. Do not merge a failing cross-boundary contract or a migration without a backup/restore check.

## Branch and pull request workflow

Use `main` as the integration branch. Start each packet from the latest `main` on a short topic branch, for example `work/p08-history`. Do not put packet work directly on `main`.

```sh
git switch main
git pull --ff-only
git switch -c work/p08-history
```

Push the topic branch and open a pull request targeting `main`. The person in the other ownership role reviews the boundary and its effect on their area. Discuss shared contract changes before editing dependent code. The PR describes changed contracts or migrations, the exact validation commands and results, capability gaps, and a redacted fixture when it helps reproduce behavior. Both people run `npm ci`, `npm run typecheck`, and `npm test` against the combined tree before A merges. The owner of a conflict resolves the code, then both verify the assumptions and rerun affected checks.

The reviewer remains selected by the people working on each packet. GitHub required-review protection is not enabled, so this process depends on the team following the review step.

| Symptom | First owner | Who waits / what may continue |
|---|---|---|
| Wrong entry/management verdict, thesis lineage, quantity/cost, replay, data loss, schema/CLI | A | B supplies a minimal redacted fixture and waits on the frozen contract; independent provider work can continue. |
| API response shape, source timing/provenance, chain/venue coverage, semantic extraction, flaky external fixture | B | A keeps the last certified interface and can continue unrelated policy work. |
| Cross-boundary mismatch or uncertain source of failure | A coordinates; assign one root-cause owner after reproduction | Neither changes the other's boundary until a failing case and corrected contract are agreed. |

An incorrect positive result, oversell or missing saved evidence blocks release of the affected capability. Preserve the record, disable or mark the capability UNKNOWN, add a regression, and repair the responsible boundary. Missing coverage that already reports UNKNOWN is a backlog item. Every bug report carries the version, chain/token, snapshot and policy hashes, a redacted reproduction bundle, expected/actual behavior, severity, one owner and the command that proves repair.

Remaining ownership packets: B leads chain/venue evidence adapters and certificates (P02–P06), direct provider comparisons and labeled semantic quality; A leads their typed contracts and integration. A leads advisory chart/macro primitives (P03a/P03b), historical case/ledger correctness (P08), and policy revisions after measured results (P10); B supplies recorded evidence and regression fixtures. Phase 2 discovery, Phase 3 trading and P12 paper simulation require separate authorization and contracts.
