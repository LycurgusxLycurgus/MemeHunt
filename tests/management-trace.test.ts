import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { decisionHash, Service } from '../src/app/service.js';
import { featureMetadata } from '../src/domain/catalog.js';
import type { ManagementCheckResult, ManagementResult, Predicate } from '../src/domain/contracts.js';
import { MANAGEMENT_POLICY_VERSION } from '../src/domain/management-trace.js';
import { evaluateManagement, evaluatePredicate, explainPredicate, usable } from '../src/domain/policy.js';
import {
  completeFixtureEntryFeatures as full, FIXTURE_CUTOFF as C, fixtureBundle, fixtureEpisode as ep, fixtureFeature as ff,
  fixtureStageObservations, illustrativeFixtureThesis, illustrativeUncalibratedProfile as prof,
} from '../examples/fixtures.js';
import { p, runAs, scenarios, stage, type Inputs } from './management-scenarios.js';

test('published main v0–v4 management snapshots replay under their original qualified rules', () => {
  // Captured from published main, not from this branch's compatibility evaluator.
  const published = JSON.parse(readFileSync('tests/fixtures/management-published-main-golden.json', 'utf8')) as {
    sourceCommit: string;
    snapshots: Array<{ id: string; kind: string; payload: string; hash: string; semantic: string }>;
  };
  assert.match(published.sourceCommit, /^9a43bdd[0-9a-f]{33}$/);
  assert.deepEqual(published.snapshots.map(s => JSON.parse(s.semantic).policyVersion),
    [0, 1, 2, 3, 4].map(v => `thesis-management-v${v}`));
  const temp = temporaryDatabase();
  try {
    new Service(temp.file).close();
    const db = new DatabaseSync(temp.file);
    try {
      for (const s of published.snapshots) db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?)').run(s.id, s.kind, s.payload, s.hash, s.semantic);
    } finally { db.close(); }
    const reopened = new Service(temp.file);
    try {
      for (const s of published.snapshots) assert.deepEqual(reopened.replay(s.id), JSON.parse(s.payload), s.id);
    } finally { reopened.close(); }
  } finally { rmSync(temp.directory, { recursive: true, force: true }); }
});

/** Packet 1 expectations are those of thesis-management-v5; the sell-order changes of v6 are covered in management-sell-order.test.ts. */
const run = (i: Inputs) => runAs('thesis-management-v5', i);
const row = (r: ManagementResult, id: string) => r.checks.find(c => c.checkId === id)!;
const trace = (c: ManagementCheckResult) => ({ status: c.status, reasonCode: c.reasonCode, featureRefs: c.featureRefs, evidenceRefs: c.evidenceRefs, basisRefs: c.basisRefs });

type GoldenRow = { id: string; kind: string; payload: string; hash: string; semantic: string };
const golden = JSON.parse(readFileSync('tests/fixtures/management-v0-golden.json', 'utf8')) as {
  capturedFromCommit: string; policyVersion: string; scenarios: Array<{ name: string; inputsHash: string; result: ManagementResult }>; snapshots: GoldenRow[];
};

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'management-trace-'));
  return { directory, file: join(directory, 'dd.sqlite') };
}

test('an invalidated management row names the feature and evidence that fired it', () => {
  const r = run(scenarios['invalidated-examples']!());
  assert.deepEqual(trace(row(r, 'MG-07')), {
    status: 'FAIL', reasonCode: 'INVALIDATION_TRIGGERED', featureRefs: ['O03'], evidenceRefs: ['fixture-evidence-001'],
    basisRefs: [{ kind: 'THESIS_FIELD', ref: 'invalidation' }],
  });
});

test('decisive features name what forced a predicate, or the missing inputs when it is unknown', () => {
  const features = [ff('O28', true), ff('A16', '3'), ff('O01', false)];
  const cases: Array<[Predicate, string, string[]]> = [
    [{ op: 'any', children: [p('O28', true, 'bool'), { op: 'all', children: [p('A16', '5', 'count', 'lt'), p('S10', false, 'bool')] }] }, 'TRUE', ['O28']],
    [{ op: 'all', children: [p('O01', true, 'bool'), p('S10', true, 'bool')] }, 'FALSE', ['O01']],
    [{ op: 'all', children: [p('O28', true, 'bool'), p('S10', true, 'bool')] }, 'UNKNOWN', ['S10']],
    [{ op: 'any', children: [p('O01', true, 'bool'), p('A16', '5', 'count', 'gt')] }, 'FALSE', ['O01', 'A16']],
    [{ op: 'all', children: [p('O28', true, 'bool'), p('A16', '5', 'count', 'lt')] }, 'TRUE', ['O28', 'A16']],
  ];
  for (const [ast, truth, featureRefs] of cases) {
    assert.deepEqual(explainPredicate(ast, features, C), { truth, featureRefs });
    assert.equal(evaluatePredicate(ast, features, C), truth);
  }
});

test('rows cite only evidence that was usable at the cutoff', () => {
  const features = full().map(f => f.id === 'O03' ? { ...f, evidenceIds: ['ev-o03'] } : f.id === 'O01' ? { ...f, availableAt: '2026-01-01T00:00:01.000Z', evidenceIds: ['ev-late'] } : f);
  const r = evaluateManagement(ep(p('O01', true, 'bool'), p('O03', true, 'bool')), features, null, [], prof, C);
  assert.deepEqual(trace(row(r, 'MG-06')), { status: 'UNKNOWN', reasonCode: 'INSUFFICIENT_EVIDENCE', featureRefs: ['O01'], evidenceRefs: [], basisRefs: [{ kind: 'THESIS_FIELD', ref: 'support' }] });
  assert.deepEqual(row(r, 'MG-07').evidenceRefs, ['ev-o03']);
  assert.deepEqual(trace(row(r, 'MG-04')), { status: 'UNKNOWN', reasonCode: 'INSUFFICIENT_EVIDENCE', featureRefs: ['O01'], evidenceRefs: [], basisRefs: [{ kind: 'THESIS_FIELD', ref: 'support' }, { kind: 'THESIS_FIELD', ref: 'invalidation' }] });
});

test('safety and exit rows name the failing entry checks, or the missing profile limits', () => {
  assert.deepEqual(trace(row(run(scenarios['safety-fail']!()), 'MG-02')), {
    status: 'FAIL', reasonCode: 'SAFETY_RULE_FAILED', featureRefs: ['O03'], evidenceRefs: ['fixture-evidence-001'], basisRefs: [{ kind: 'ENTRY_CHECK', ref: 'SEC-01' }],
  });
  assert.deepEqual(trace(row(run(scenarios['exit-fail']!()), 'MG-03')), {
    status: 'FAIL', reasonCode: 'EXIT_RULE_FAILED', featureRefs: ['O13', 'O14', 'O15', 'O16'], evidenceRefs: ['fixture-evidence-001'], basisRefs: [{ kind: 'ENTRY_CHECK', ref: 'EXE-02' }],
  });
  const unset = run(scenarios['risk-limits-missing']!());
  assert.deepEqual(trace(row(unset, 'MG-02')), {
    status: 'UNKNOWN', reasonCode: 'POLICY_PARAMETER_MISSING', featureRefs: [], evidenceRefs: [],
    basisRefs: [{ kind: 'ENTRY_CHECK', ref: 'LIQ-01' }, { kind: 'ENTRY_CHECK', ref: 'SEC-04' }, { kind: 'PROFILE_FIELD', ref: 'risk.maxRemovableLiquidityShare' }, { kind: 'PROFILE_FIELD', ref: 'risk.maxTransferFeeBps' }],
  });
  assert.deepEqual(row(unset, 'MG-03').basisRefs, [{ kind: 'ENTRY_CHECK', ref: 'EXE-02' }, { kind: 'PROFILE_FIELD', ref: 'risk.maxEntryImpactBps' }, { kind: 'PROFILE_FIELD', ref: 'risk.maxExitImpactBps' }, { kind: 'PROFILE_FIELD', ref: 'risk.maxRoundTripLossBps' }]);
  const missingEvidence = run(scenarios['invalidated-despite-missing-support']!());
  assert.equal(row(missingEvidence, 'MG-02').reasonCode, 'INSUFFICIENT_EVIDENCE');
  assert.ok(row(missingEvidence, 'MG-02').featureRefs.includes('O07'));
});

test('structural rows point at the episode, plan, stage and position instead of inventing evidence', () => {
  const episode = ep(p('O01', true, 'bool'), p('O03', false, 'bool'));
  const r = evaluateManagement(episode, full(), null, [], prof, C);
  const field = (ref: string) => [{ kind: 'THESIS_FIELD', ref }];
  assert.deepEqual(trace(row(r, 'MG-01')), { status: 'PASS', reasonCode: 'RULE_SATISFIED', featureRefs: [], evidenceRefs: [], basisRefs: [{ kind: 'EPISODE', ref: 'fixture-episode-001' }, { kind: 'BASELINE_SNAPSHOT', ref: 'fixture-entry-snapshot-001' }] });
  assert.deepEqual(trace(row(r, 'MG-05')), { status: 'UNKNOWN', reasonCode: 'STAGE_INPUT_MISSING', featureRefs: [], evidenceRefs: [], basisRefs: [{ kind: 'STAGE_INPUT', ref: 'circulatingMarketCapUsd' }, { kind: 'STAGE_INPUT', ref: 'tokenCreatedAt' }] });
  for (const [id, ref] of [['MG-08', 'catalyst'], ['MG-11', 'warning'], ['MG-14', 'expiryAt']] as const) {
    assert.deepEqual(trace(row(r, id)), { status: 'NOT_APPLICABLE', reasonCode: 'NOT_CONFIGURED', featureRefs: [], evidenceRefs: [], basisRefs: field(ref) });
  }
  assert.deepEqual([row(r, 'MG-09').reasonCode, row(r, 'MG-09').basisRefs], ['PLAN_UNSPECIFIED', field('onchainTraction')]);
  assert.deepEqual([row(r, 'MG-12').reasonCode, row(r, 'MG-12').basisRefs], ['PLAN_UNSPECIFIED', field('legs')]);
  assert.deepEqual([row(r, 'MG-13').reasonCode, row(r, 'MG-13').basisRefs], ['POSITION_MISSING', field('legs')]);
  assert.deepEqual([row(r, 'MG-15').reasonCode, row(r, 'MG-15').basisRefs], ['POSITION_MISSING', []]);
  const noBands = evaluateManagement(episode, full(), null, [], { ...prof, stage: { ageBands: [] } }, C, stage);
  assert.deepEqual([row(noBands, 'MG-05').reasonCode, row(noBands, 'MG-05').basisRefs], ['POLICY_PARAMETER_MISSING', [{ kind: 'PROFILE_FIELD', ref: 'stage.ageBands' }]]);
  const staged = evaluateManagement(episode, full(), null, [], prof, C, stage);
  assert.deepEqual([row(staged, 'MG-05').status, row(staged, 'MG-05').basisRefs?.map(b => b.ref)], ['PASS', ['circulatingMarketCapUsd', 'tokenCreatedAt', 'stage.ageBands']]);
});

test('sell-plan rows name the due leg, the ledger revision, and what blocks a sized proposal', () => {
  const dca = run(scenarios['dca-proposed']!());
  assert.deepEqual(trace(row(dca, 'MG-12')), { status: 'PASS', reasonCode: 'RULE_SATISFIED', featureRefs: ['O02'], evidenceRefs: ['fixture-evidence-001'], basisRefs: [{ kind: 'EXIT_LEG', ref: 'leg-1' }] });
  const revision = row(dca, 'MG-13').basisRefs?.find(b => b.kind === 'LEDGER_REVISION')?.ref;
  assert.match(revision ?? '', /^[a-f0-9]{64}$/);
  assert.deepEqual(row(dca, 'MG-13').basisRefs, [{ kind: 'POSITION', ref: 'fixture-position-001' }, { kind: 'LEDGER_REVISION', ref: revision }, { kind: 'THESIS_FIELD', ref: 'legs' }]);
  assert.deepEqual(trace(row(dca, 'MG-15')), {
    status: 'PASS', reasonCode: 'RULE_SATISFIED', featureRefs: ['O10', 'O11', 'O13', 'O14', 'O15', 'O16'], evidenceRefs: ['fixture-evidence-001'],
    basisRefs: [{ kind: 'EXIT_LEG', ref: 'leg-1' }, { kind: 'POSITION', ref: 'fixture-position-001' }, { kind: 'LEDGER_REVISION', ref: revision }, { kind: 'ENTRY_CHECK', ref: 'EXE-01' }, { kind: 'ENTRY_CHECK', ref: 'EXE-02' }],
  });
  const afterSale = run(scenarios['attributed-partial-sale']!());
  assert.notEqual(row(afterSale, 'MG-15').basisRefs?.find(b => b.kind === 'LEDGER_REVISION')?.ref, revision);
  assert.equal(row(run(scenarios['unreconciled-sale']!()), 'MG-15').reasonCode, 'UNRECONCILED_SALE');
  assert.equal(row(run(scenarios['unknown-cost']!()), 'MG-13').reasonCode, 'COST_UNKNOWN');
  assert.deepEqual(trace(row(run(scenarios['later-leg-unknown']!()), 'MG-12')), { status: 'UNKNOWN', reasonCode: 'INSUFFICIENT_EVIDENCE', featureRefs: ['A30'], evidenceRefs: [], basisRefs: [{ kind: 'EXIT_LEG', ref: 'leg-2' }] });
  assert.deepEqual([row(run(scenarios['maintain']!()), 'MG-12').reasonCode, row(run(scenarios['maintain']!()), 'MG-12').featureRefs], ['TRIGGER_NOT_DUE', ['O02']]);
  const expired = run(scenarios['expired-with-catalyst-and-warning']!());
  assert.equal(row(expired, 'MG-14').reasonCode, 'HORIZON_EXPIRED');
  assert.deepEqual([row(expired, 'MG-11').reasonCode, row(expired, 'MG-11').featureRefs], ['WARNING_TRIGGERED', ['A03']]);
  assert.deepEqual([row(expired, 'MG-08').reasonCode, row(expired, 'MG-08').featureRefs], ['RULE_SATISFIED', ['A01']]);
});

test('every v0 golden scenario keeps its exact statuses, verdict and quantity, and every reference is real', () => {
  assert.equal(golden.policyVersion, 'thesis-management-v0');
  assert.equal(golden.scenarios.length, 18);
  const known = new Set(featureMetadata.map(f => f.id));
  for (const g of golden.scenarios) {
    const i = scenarios[g.name]!();
    assert.equal(decisionHash(i), g.inputsHash, `${g.name}: rebuilt inputs differ from the captured inputs`);
    assert.deepEqual(runAs('thesis-management-v0', i), g.result, g.name);
    const r = run(i);
    for (const c of r.checks) {
      assert.ok(c.featureRefs.every(id => known.has(id)), `${g.name} ${c.checkId}: unknown feature ref`);
      const cited = new Set(c.featureRefs.flatMap(id => { const f = i.features.find(x => x.id === id); return f && usable(f, i.cutoff) ? f.evidenceIds : []; }));
      assert.ok(c.evidenceRefs.every(id => cited.has(id)), `${g.name} ${c.checkId}: evidence not from a usable cited feature`);
      assert.ok(Array.isArray(c.basisRefs), `${g.name} ${c.checkId}: missing basisRefs`);
      if (c.status === 'PASS') assert.equal(c.reasonCode, 'RULE_SATISFIED');
      if (c.status === 'NOT_APPLICABLE') assert.equal(c.reasonCode, 'NOT_CONFIGURED');
      if (c.status === 'UNKNOWN' || c.status === 'FAIL') assert.notEqual(c.reasonCode, 'RULE_SATISFIED', `${g.name} ${c.checkId}`);
    }
  }
});

test('saved v0 management snapshots still replay unchanged', () => {
  assert.ok(golden.snapshots.length >= 2);
  const temp = temporaryDatabase();
  try {
    new Service(temp.file).close();
    const db = new DatabaseSync(temp.file);
    try { for (const s of golden.snapshots) db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?)').run(s.id, s.kind, s.payload, s.hash, s.semantic); } finally { db.close(); }
    const service = new Service(temp.file);
    try {
      for (const s of golden.snapshots) {
        assert.equal(JSON.parse(s.semantic).policyVersion, 'thesis-management-v0');
        assert.deepEqual(service.replay(s.id), JSON.parse(s.payload));
      }
    } finally { service.close(); }
  } finally { rmSync(temp.directory, { recursive: true, force: true }); }
});

test('new management snapshots record the current label and replay; unknown labels fail closed', () => {
  const temp = temporaryDatabase();
  try {
    const service = new Service(temp.file);
    let id = '';
    try {
      const entry = service.analyze(fixtureBundle(full(), illustrativeFixtureThesis));
      const management = service.reassess(service.caseFor(entry.token)!.id, fixtureBundle(full({ O02: '100000' }), undefined, fixtureStageObservations));
      id = management.id;
      assert.deepEqual(trace(row(management.result, 'MG-07')).featureRefs, ['O03']);
      assert.deepEqual(service.replay(id), management);
    } finally { service.close(); }
    const db = new DatabaseSync(temp.file);
    try {
      const saved = db.prepare('SELECT payload,semantic FROM snapshots WHERE id=?').get(id) as { payload: string; semantic: string };
      const semantic = JSON.parse(saved.semantic) as Record<string, unknown>;
      assert.equal(semantic.policyVersion, MANAGEMENT_POLICY_VERSION);
      const relabeled = { ...semantic, policyVersion: 'thesis-management-unknown' };
      db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?)').run('relabeled', 'MANAGEMENT', saved.payload, decisionHash(relabeled), JSON.stringify(relabeled));
    } finally { db.close(); }
    const reopened = new Service(temp.file);
    try { assert.throws(() => reopened.replay('relabeled'), /UNSUPPORTED_POLICY_VERSION/); } finally { reopened.close(); }
  } finally { rmSync(temp.directory, { recursive: true, force: true }); }
});
