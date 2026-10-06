import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { decisionHash, Service } from '../src/app/service.js';
import { featureMetadata } from '../src/domain/catalog.js';
import type { ManagementCheckResult, ManagementResult } from '../src/domain/contracts.js';
import { legCandidate, nextLeg, proposeLeg, reduceLedger } from '../src/domain/ledger.js';
import { MANAGEMENT_POLICY_VERSION } from '../src/domain/management-trace.js';
import { usable } from '../src/domain/policy.js';
import {
  completeFixtureEntryFeatures as full, FIXTURE_CUTOFF as C, fixtureBundle, fixtureEpisode as ep, fixturePosition as pos,
  fixturePositionEvent as evt, fixtureStageObservations, illustrativeFixtureThesis,
} from '../examples/fixtures.js';
import { LATER, leg, p, runAs, scenarios, traction } from './management-scenarios.js';

const current = (name: string) => runAs(MANAGEMENT_POLICY_VERSION, scenarios[name]!());
const row = (r: ManagementResult, id: string) => r.checks.find(c => c.checkId === id)!;
const trace = (c: ManagementCheckResult) => ({ status: c.status, reasonCode: c.reasonCode, featureRefs: c.featureRefs, basisRefs: c.basisRefs });
const exitLeg = (ref: string) => ({ kind: 'EXIT_LEG', ref });
const ledgerRef = (r: ManagementResult) => row(r, 'MG-13').basisRefs!.find(b => b.kind === 'LEDGER_REVISION')!;
const outcome = (r: ManagementResult) => ({ proposal: r.proposal, proposedLegId: r.proposedLegId, proposedQuantityAtomic: r.proposedQuantityAtomic });

type GoldenRow = { id: string; kind: string; payload: string; hash: string; semantic: string };
const golden = JSON.parse(readFileSync('tests/fixtures/management-v5-golden.json', 'utf8')) as {
  policyVersion: string; snapshots: GoldenRow[];
  scenarios: Array<{ name: string; inputsHash: string; resultHash: string; thesisState: string; proposal: string; proposedQuantityAtomic: string | null; statuses: Record<string, string> }>;
};

test('the next sell step is the first one not fully sold, and later steps never jump the queue', () => {
  const notDue = current('consumed-leg-then-not-due');
  assert.deepEqual(trace(row(notDue, 'MG-12')), { status: 'FAIL', reasonCode: 'TRIGGER_NOT_DUE', featureRefs: ['O01'], basisRefs: [exitLeg('leg-2'), ledgerRef(notDue)] });
  assert.deepEqual(outcome(notDue), { proposal: 'MAINTAIN_THESIS', proposedLegId: undefined, proposedQuantityAtomic: undefined });

  const due = current('consumed-leg-then-due');
  assert.deepEqual(trace(row(due, 'MG-12')), { status: 'PASS', reasonCode: 'RULE_SATISFIED', featureRefs: ['O02'], basisRefs: [exitLeg('leg-2'), ledgerRef(due)] });
  assert.deepEqual(outcome(due), { proposal: 'DCA_OUT_PROPOSED', proposedLegId: 'leg-2', proposedQuantityAtomic: '300' });

  const waiting = current('first-not-due-later-due');
  assert.deepEqual(trace(row(waiting, 'MG-12')), { status: 'FAIL', reasonCode: 'TRIGGER_NOT_DUE', featureRefs: ['O02'], basisRefs: [exitLeg('leg-1'), ledgerRef(waiting)] });
  assert.equal(waiting.proposal, 'MAINTAIN_THESIS');

  const laterUnknown = current('later-leg-unknown');
  assert.deepEqual(trace(row(laterUnknown, 'MG-12')), { status: 'PASS', reasonCode: 'RULE_SATISFIED', featureRefs: ['O02'], basisRefs: [exitLeg('leg-1'), ledgerRef(laterUnknown)] });
  assert.deepEqual(outcome(laterUnknown), { proposal: 'DCA_OUT_PROPOSED', proposedLegId: 'leg-1', proposedQuantityAtomic: '400' });
});

test('a finished sell plan asks for a successor plan and never maintains', () => {
  const consumed = current('all-legs-consumed');
  assert.deepEqual(trace(row(consumed, 'MG-12')), { status: 'UNKNOWN', reasonCode: 'PLAN_EXHAUSTED', featureRefs: [], basisRefs: [exitLeg('leg-1'), ledgerRef(consumed)] });
  assert.equal(consumed.proposal, 'REASSESS_REQUIRED');
  const sold = current('fully-sold-plan');
  assert.deepEqual(trace(row(sold, 'MG-12')), { status: 'UNKNOWN', reasonCode: 'PLAN_EXHAUSTED', featureRefs: [], basisRefs: [exitLeg('leg-1'), exitLeg('leg-2'), ledgerRef(sold)] });
  assert.equal(sold.proposal, 'REASSESS_REQUIRED');
});

test('a sale not matched to a step makes the next step unknown until it is reconciled', () => {
  for (const name of ['unreconciled-not-due', 'unreconciled-sale']) {
    const r = current(name);
    assert.deepEqual(trace(row(r, 'MG-12')), {
      status: 'UNKNOWN', reasonCode: 'UNRECONCILED_SALE', featureRefs: [], basisRefs: [{ kind: 'POSITION', ref: 'fixture-position-001' }, ledgerRef(r)],
    }, name);
    assert.equal(r.proposal, 'REASSESS_REQUIRED', name);
  }
});

test('invalidation or an expired deadline sends any point of the plan to exit review with the remaining quantity', () => {
  const exit = (name: string) => { const r = current(name); return { thesisState: r.thesisState, proposal: r.proposal, remainingQuantityAtomic: r.remainingQuantityAtomic, positionMode: r.positionMode, proposedQuantityAtomic: r.proposedQuantityAtomic }; };
  const review = { thesisState: 'INVALIDATED', proposal: 'EXIT_REVIEW', proposedQuantityAtomic: undefined };
  assert.deepEqual(exit('invalidated-with-position'), { ...review, remainingQuantityAtomic: '1000', positionMode: 'HYPOTHETICAL' });
  assert.deepEqual(exit('invalidated-after-partial-sale'), { ...review, remainingQuantityAtomic: '800', positionMode: 'HYPOTHETICAL' });
  assert.deepEqual(exit('expired-with-manual-position'), { ...review, remainingQuantityAtomic: '1000', positionMode: 'MANUAL_REPORTED' });
  assert.equal(row(current('expired-with-manual-position'), 'MG-14').reasonCode, 'HORIZON_EXPIRED');
  assert.deepEqual(exit('invalidated-position-recorded-later'), { ...review, remainingQuantityAtomic: undefined, positionMode: undefined });
  assert.deepEqual(exit('invalidated-examples'), { ...review, remainingQuantityAtomic: undefined, positionMode: undefined });
  const v5 = runAs('thesis-management-v5', scenarios['invalidated-with-position']!());
  assert.deepEqual([v5.proposal, 'remainingQuantityAtomic' in v5, 'positionMode' in v5], ['EXIT_REVIEW', false, false]);
});

test('under the current label MG-12, MG-15 and the proposal always name the same step, and every reference is real', () => {
  const known = new Set(featureMetadata.map(f => f.id));
  for (const [name, build] of Object.entries(scenarios)) {
    const i = build(), r = runAs(MANAGEMENT_POLICY_VERSION, i);
    const mg12 = row(r, 'MG-12'), mg15 = row(r, 'MG-15');
    if (r.proposal === 'DCA_OUT_PROPOSED') {
      assert.equal(mg12.status, 'PASS', name);
      assert.deepEqual(mg12.basisRefs?.find(b => b.kind === 'EXIT_LEG'), exitLeg(r.proposedLegId!), name);
      assert.deepEqual(mg15.basisRefs?.find(b => b.kind === 'EXIT_LEG'), exitLeg(r.proposedLegId!), name);
    }
    if (mg15.status === 'PASS') assert.deepEqual(mg15.basisRefs?.find(b => b.kind === 'EXIT_LEG'), mg12.basisRefs?.find(b => b.kind === 'EXIT_LEG'), name);
    if (r.proposal === 'MAINTAIN_THESIS') assert.equal(mg12.reasonCode, 'TRIGGER_NOT_DUE', name);
    const knownPosition = !!i.position && Date.parse(i.position.entryAt) <= Date.parse(i.cutoff) && Date.parse(i.position.recordedAt) <= Date.parse(i.cutoff);
    assert.equal(r.remainingQuantityAtomic !== undefined, r.proposal === 'EXIT_REVIEW' && knownPosition, name);
    assert.equal(r.positionMode !== undefined, r.remainingQuantityAtomic !== undefined, name);
    for (const c of r.checks) {
      assert.ok(c.featureRefs.every(id => known.has(id)), `${name} ${c.checkId}: unknown feature ref`);
      const cited = new Set(c.featureRefs.flatMap(id => { const f = i.features.find(x => x.id === id); return f && usable(f, i.cutoff) ? f.evidenceIds : []; }));
      assert.ok(c.evidenceRefs.every(id => cited.has(id)), `${name} ${c.checkId}: evidence not from a usable cited feature`);
      if (c.status === 'PASS') assert.equal(c.reasonCode, 'RULE_SATISFIED', `${name} ${c.checkId}`);
      if (c.status === 'UNKNOWN' || c.status === 'FAIL') assert.notEqual(c.reasonCode, 'RULE_SATISFIED', `${name} ${c.checkId}`);
    }
  }
});

test('nextLeg reports where the plan stands, and proposeLeg sizes only a due step that fits the inventory', () => {
  const twoSteps = traction(ep(p('O01', true, 'bool'), p('O03', false, 'bool'), [leg('leg-1', p('O02', true, 'bool')), leg('leg-2', p('A30', true, 'bool'), null, true)]));
  const features = full().filter(f => f.id !== 'A30');
  const fresh = reduceLedger(pos(), []);
  assert.deepEqual(nextLeg(ep(p('O01', true, 'bool'), p('O03', false, 'bool')), fresh, features, C), { kind: 'NO_PLAN' });
  assert.deepEqual(nextLeg(twoSteps, null, features, C), { kind: 'DUE', legId: 'leg-1', quantityAtomic: null });
  assert.deepEqual(nextLeg(twoSteps, fresh, features, C), { kind: 'DUE', legId: 'leg-1', quantityAtomic: '400' });
  const stepOneSold = reduceLedger(pos(), [evt({ quantityAtomic: '400' })]);
  assert.deepEqual(nextLeg(twoSteps, stepOneSold, features, LATER), { kind: 'UNKNOWN', legId: 'leg-2' });
  const allSold = reduceLedger(pos(), [evt({ quantityAtomic: '400' }), evt({ id: 'sale-2', idempotencyKey: 'sale-2', quantityAtomic: '600', legId: 'leg-2' })]);
  assert.deepEqual(nextLeg(twoSteps, allSold, features, LATER), { kind: 'EXHAUSTED' });
  const movedOut = reduceLedger(pos(), [evt({ kind: 'TRANSFER_ADJUSTMENT', direction: 'OUT', quantityAtomic: '700', quoteAmount: '0', legId: undefined })]);
  assert.deepEqual(nextLeg(twoSteps, movedOut, features, LATER), { kind: 'DUE', legId: 'leg-1', quantityAtomic: null });
  for (const state of [fresh, stepOneSold, allSold, movedOut]) {
    assert.deepEqual(proposeLeg(twoSteps, state, features, LATER), legCandidate(nextLeg(twoSteps, state, features, LATER)));
  }
});

test('every v5 golden scenario still evaluates exactly as captured under its own label', () => {
  assert.equal(golden.policyVersion, 'thesis-management-v5');
  assert.deepEqual(golden.scenarios.map(s => s.name).sort(), Object.keys(scenarios).sort());
  for (const g of golden.scenarios) {
    const i = scenarios[g.name]!();
    assert.equal(decisionHash(i), g.inputsHash, `${g.name}: rebuilt inputs differ from the captured inputs`);
    const r = runAs('thesis-management-v5', i);
    const summary = { thesisState: r.thesisState, proposal: r.proposal, proposedQuantityAtomic: r.proposedQuantityAtomic ?? null, statuses: Object.fromEntries(r.checks.map(c => [c.checkId, c.status])) };
    assert.deepEqual(summary, { thesisState: g.thesisState, proposal: g.proposal, proposedQuantityAtomic: g.proposedQuantityAtomic, statuses: g.statuses }, g.name);
    assert.equal(decisionHash(r), g.resultHash, `${g.name}: v5 explanation changed`);
  }
});

test('saved v5 snapshots replay unchanged, and the same inputs under the current label would differ', () => {
  assert.equal(golden.snapshots.length, 3);
  const directory = mkdtempSync(join(tmpdir(), 'management-sell-order-'));
  const file = join(directory, 'dd.sqlite');
  try {
    new Service(file).close();
    const db = new DatabaseSync(file);
    try {
      for (const s of golden.snapshots) {
        db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?)').run(s.id, s.kind, s.payload, s.hash, s.semantic);
        const relabeled = { ...JSON.parse(s.semantic), policyVersion: MANAGEMENT_POLICY_VERSION };
        db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?)').run(`${s.id}-relabeled`, s.kind, s.payload, decisionHash(relabeled), JSON.stringify(relabeled));
      }
    } finally { db.close(); }
    const service = new Service(file);
    try {
      for (const s of golden.snapshots) {
        assert.equal(JSON.parse(s.semantic).policyVersion, 'thesis-management-v5');
        assert.deepEqual(service.replay(s.id), JSON.parse(s.payload));
        assert.throws(() => service.replay(`${s.id}-relabeled`), /REPLAY_RESULT_MISMATCH/, `${s.id}: the label must select the rules`);
      }
    } finally { service.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a saved reassessment after step one is sold maintains under the current label and replays', () => {
  const service = new Service(':memory:');
  try {
    const thesis = {
      ...illustrativeFixtureThesis, invalidation: [p('O03', false, 'bool')], onchainTraction: p('O02', true, 'bool'), externalTraction: p('A01', true, 'bool'),
      legs: [leg('leg-1', p('O02', true, 'bool')), leg('leg-2', p('O01', false, 'bool'), 3000)],
    };
    const entry = service.analyze(fixtureBundle(full(), thesis));
    const position = pos({ caseId: entry.caseId });
    service.recordPosition(position);
    service.appendPositionEvent(position.id, evt({ quantityAtomic: '400' }));
    const management = service.reassess(entry.caseId, { ...fixtureBundle(full(), undefined, fixtureStageObservations), cutoff: LATER });
    assert.equal(management.result.proposal, 'MAINTAIN_THESIS');
    assert.deepEqual(row(management.result, 'MG-12').basisRefs?.[0], exitLeg('leg-2'));
    assert.deepEqual(service.replay(management.id), management);
  } finally { service.close(); }
});
