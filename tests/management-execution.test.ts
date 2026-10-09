import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { decisionHash, Service } from '../src/app/service.js';
import type { Bundle, EvidenceRecord, ExitProof, ExitQuoteRequest, ManagementResult, PositionEvent, PositionRecord, TokenRef } from '../src/domain/contracts.js';
import { SCENARIO_QUOTE_LABEL } from '../src/domain/exit-proof.js';
import { executionBasis, ORIGIN_PLAN, quantityBasis, reduceLedger } from '../src/domain/ledger.js';
import { evaluateManagementAs, MANAGEMENT_POLICY_VERSION } from '../src/domain/management-trace.js';
import {
  completeFixtureEntryFeatures as full, FIXTURE_CUTOFF as C, fixtureBlockedExitProof, fixtureBundle, fixtureEpisode as ep, fixtureExitProof,
  fixtureExitQuoteEvidence, fixturePosition as pos, fixturePositionEvent as evt, fixtureStageObservations, illustrativeFixtureThesis,
  illustrativeQuotedExitProfile as quoted, illustrativeUncalibratedProfile as prof,
} from '../examples/fixtures.js';
import { LATER, leg, p, runAs, scenarios, traction, type Inputs } from './management-scenarios.js';

type Fillable = Extract<ExitProof, { outcome: 'FILLABLE' }>;
type GoldenRow = { id: string; kind: string; payload: string; hash: string; semantic: string };
const golden = JSON.parse(readFileSync('tests/fixtures/management-v6-golden.json', 'utf8')) as {
  policyVersion: string; snapshots: GoldenRow[];
  scenarios: Array<{ name: string; inputsHash: string; resultHash: string; thesisState: string; proposal: string; proposedQuantityAtomic: string | null; remainingQuantityAtomic: string | null; positionMode: string | null; statuses: Record<string, string> }>;
};

const V6 = 'thesis-management-v6';
const TOKEN: TokenRef = { chain: 'solana', address: 'FIXTURE_TOKEN' };
const EVIDENCE: EvidenceRecord[] = [fixtureBundle().evidence[0]!, fixtureExitQuoteEvidence];
const run = (i: Inputs, exitProofs: ExitProof[] = [], profile = quoted, evidence = EVIDENCE) =>
  evaluateManagementAs(MANAGEMENT_POLICY_VERSION, i.episode, i.features, i.position, i.events, profile, i.cutoff, i.stageInputs, { token: TOKEN, evidence, exitProofs });
/** Runs once for the exact quote requests, then again with the proofs `answer` gives each (default: one fillable fixture proof). */
const prove = (i: Inputs, answer: (r: ExitQuoteRequest) => ExitProof[] = r => [fixtureExitProof(r)], profile = quoted, evidence = EVIDENCE) =>
  run(i, (run(i, [], profile, evidence).exitQuotes ?? []).flatMap(q => answer(q.request)), profile, evidence);
/** Answers the candidate-leg request with `make` and the remaining-position request with a fillable proof. */
const candidateAs = (make: (r: ExitQuoteRequest) => ExitProof[]) => (r: ExitQuoteRequest) => r.purpose === 'CANDIDATE_LEG' ? make(r) : [fixtureExitProof(r)];
const holdingAs = (make: (r: ExitQuoteRequest) => ExitProof[]) => (r: ExitQuoteRequest) => r.purpose === 'REMAINING_POSITION' ? make(r) : [fixtureExitProof(r)];
const withOutput = (r: ExitQuoteRequest, output: Partial<Fillable['output']>, overrides: Partial<Fillable> = {}) =>
  fixtureExitProof(r, { output: { ...(fixtureExitProof(r) as Fillable).output, ...output }, ...overrides });
const row = (r: ManagementResult, id: string) => r.checks.find(c => c.checkId === id)!;
const verdict = (r: ManagementResult, id: string) => [row(r, id).status, row(r, id).reasonCode];
const quoteFor = (r: ManagementResult, purpose: ExitQuoteRequest['purpose']) => r.exitQuotes?.find(q => q.request.purpose === purpose);
const dca = () => scenarios['dca-proposed']!();
const manual = (i: Inputs): Inputs => ({ ...i, position: { ...i.position!, mode: 'MANUAL_REPORTED' } });

test('every v6 golden scenario still evaluates exactly as captured, and saved v6 rows replay unchanged', () => {
  assert.equal(MANAGEMENT_POLICY_VERSION, 'thesis-management-v7');
  assert.equal(golden.policyVersion, V6);
  assert.deepEqual(golden.scenarios.map(s => s.name).sort(), Object.keys(scenarios).sort());
  for (const g of golden.scenarios) {
    const i = scenarios[g.name]!();
    assert.equal(decisionHash(i), g.inputsHash, `${g.name}: rebuilt inputs differ from the captured inputs`);
    const r = runAs(V6, i);
    const summary = {
      thesisState: r.thesisState, proposal: r.proposal, proposedQuantityAtomic: r.proposedQuantityAtomic ?? null, remainingQuantityAtomic: r.remainingQuantityAtomic ?? null,
      positionMode: r.positionMode ?? null, statuses: Object.fromEntries(r.checks.map(c => [c.checkId, c.status])),
    };
    const { name: _name, inputsHash: _inputs, resultHash: _result, ...expected } = g;
    assert.deepEqual(summary, expected, g.name);
    assert.equal(decisionHash(r), g.resultHash, `${g.name}: v6 result changed`);
  }
  assert.equal(golden.snapshots.length, 4);
  const directory = mkdtempSync(join(tmpdir(), 'management-execution-v6-'));
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
        assert.equal(JSON.parse(s.semantic).policyVersion, V6);
        assert.deepEqual(service.replay(s.id), JSON.parse(s.payload));
        assert.throws(() => service.replay(`${s.id}-relabeled`), /REPLAY_RESULT_MISMATCH/, `${s.id}: v7 must not reproduce a v6 result`);
      }
    } finally { service.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the execution-basis fingerprint changes with every fact a quote depends on, where the legacy revision did not', () => {
  const episode = ep(p('O01', true, 'bool'), p('O03', false, 'bool'), [leg('leg-1', p('O02', true, 'bool')), leg('leg-2', p('O02', true, 'bool'), 3000)]);
  const fp = (position: PositionRecord = pos(), events: PositionEvent[] = [evt()], cutoff = LATER, token: TokenRef | null = TOKEN, e = episode) =>
    executionBasis(token, e, position, events, cutoff, quantityBasis(position, events, cutoff, ORIGIN_PLAN)).fingerprint;
  const revision = (position: PositionRecord, events: PositionEvent[]) => reduceLedger(position, events, LATER).revision;
  const base = fp();
  assert.match(base, /^[a-f0-9]{64}$/);

  // The owner's reproduction: a same-timestamp correction from 200 to 100 changes inventory, not the legacy revision.
  const correctedSale = (o: Partial<PositionEvent>) => [evt(), evt({ id: 'fix-1', idempotencyKey: 'fix-1', kind: 'CORRECTION', replacesId: 'fixture-sale-001', ...o })];
  const halved = correctedSale({ quantityAtomic: '100' });
  assert.equal(revision(pos(), halved), revision(pos(), [evt()]));
  assert.deepEqual([reduceLedger(pos(), [evt()], LATER).remainingQuantityAtomic, reduceLedger(pos(), halved, LATER).remainingQuantityAtomic], ['800', '900']);
  const changed: Record<string, string> = {
    'quantity correction': fp(pos(), halved),
    'proceeds correction': fp(pos(), correctedSale({ quoteAmount: '45' })),
    'leg attribution correction': fp(pos(), correctedSale({ legId: 'leg-2' })),
    'initial cost': fp(pos({ initialCost: '200' })),
    'initial quantity': fp(pos({ initialQuantityAtomic: '2000' })),
    'position identity': fp(pos({ id: 'other-position' })),
    'position mode': fp(pos({ mode: 'MANUAL_REPORTED' })),
    'token': fp(pos(), [evt()], LATER, { chain: 'solana', address: 'OTHER_TOKEN' }),
    'unknown token': fp(pos(), [evt()], LATER, null),
    'plan quantities': fp(pos(), [evt()], LATER, TOKEN, ep(p('O01', true, 'bool'), p('O03', false, 'bool'), [leg('leg-1', p('O02', true, 'bool'), 5000)])),
  };
  assert.equal(revision(pos({ initialCost: '200' }), [evt()]), revision(pos(), [evt()]));
  for (const [name, value] of Object.entries(changed)) assert.notEqual(value, base, name);
  assert.equal(new Set(Object.values(changed)).size, Object.keys(changed).length);

  // Fees: a same-timestamp correction of a fee's amount or inclusion changes the basis, not the revision.
  const fee = evt({ id: 'fee-1', idempotencyKey: 'fee-1', kind: 'FEE_REPORTED', quantityAtomic: '0', quoteAmount: '2', feeIncluded: false, legId: undefined });
  const feeFix = (o: Partial<PositionEvent>) => [evt(), fee, evt({ id: 'fee-fix', idempotencyKey: 'fee-fix', kind: 'CORRECTION', replacesId: 'fee-1', quantityAtomic: '0', quoteAmount: '2', legId: undefined, feeIncluded: false, ...o })];
  assert.equal(revision(pos(), feeFix({ quoteAmount: '5' })), revision(pos(), feeFix({})));
  assert.notEqual(fp(pos(), feeFix({ quoteAmount: '5' })), fp(pos(), feeFix({})));
  assert.notEqual(fp(pos(), feeFix({ feeIncluded: true })), fp(pos(), feeFix({})));
  // Facts the computed inventory and cost no longer reflect still belong to the basis: a fee already included in a sale's proceeds,
  // and the initial cost once a transfer in has made the remaining cost unknown.
  assert.notEqual(fp(pos(), feeFix({ feeIncluded: true, quoteAmount: '5' })), fp(pos(), feeFix({ feeIncluded: true })));
  const transferIn = [evt({ id: 'in-1', idempotencyKey: 'in-1', kind: 'TRANSFER_ADJUSTMENT', direction: 'IN', quantityAtomic: '50', quoteAmount: '0', legId: undefined })];
  assert.equal(reduceLedger(pos({ initialCost: '200' }), transferIn, LATER).knownCost, null);
  assert.notEqual(fp(pos({ initialCost: '200' }), transferIn), fp(pos(), transferIn));

  // Plan basis: the same ledger measured from a fresh start, or with an unresolved basis, is a different basis.
  const fresh = quantityBasis(pos(), [evt()], LATER, { mode: 'FRESH_START', anchorAt: '2026-01-01T00:30:00.000Z' });
  assert.notEqual(executionBasis(TOKEN, episode, pos(), [evt()], LATER, fresh).fingerprint, base);
  assert.notEqual(executionBasis(TOKEN, episode, pos(), [evt()], LATER, null).fingerprint, base);

  // Stable: repeated, at a later cutoff with nothing new, and across equivalent spellings of the same amounts and instants.
  assert.equal(fp(), base);
  assert.equal(fp(pos(), [evt()], '2026-01-01T05:00:00.000Z'), base);
  assert.equal(fp(pos({ initialCost: '100.00', entryAt: '2026-01-01T00:00:00Z' }), [evt({ quoteAmount: '30.0' })]), base);

  // No future information: a correction recorded after the cutoff does not enter the basis until it is known.
  const late = correctedSale({ quantityAtomic: '100', recordedAt: '2026-01-01T03:00:00.000Z' });
  assert.equal(fp(pos(), late, '2026-01-01T02:00:00.000Z'), fp(pos(), [evt()], '2026-01-01T02:00:00.000Z'));
  assert.notEqual(fp(pos(), late, '2026-01-01T04:00:00.000Z'), fp(pos(), [evt()], '2026-01-01T04:00:00.000Z'));
});

const T = '2026-01-01T00:30:00.000Z';
const managedThesis = (legs: ReturnType<typeof leg>[]) => ({ ...illustrativeFixtureThesis, invalidation: [p('O03', false, 'bool')], onchainTraction: p('O02', true, 'bool'), externalTraction: p('A01', true, 'bool'), legs });
const firstPlan = managedThesis([leg('leg-1', p('O02', true, 'bool'))]);
/** A tracked case holding 1000 units under a first plan with one due 40% step; `sold` units of it are reported sold at 00:10. */
function trackedCase(service: Service, sold: string | null, extra: PositionEvent[] = []) {
  const entry = service.analyze(fixtureBundle(full(), firstPlan));
  const position = pos({ caseId: entry.caseId });
  service.recordPosition(position);
  if (sold) service.appendPositionEvent(position.id, evt({ quantityAtomic: sold }));
  for (const e of extra) service.appendPositionEvent(position.id, e);
  return { caseId: entry.caseId, positionId: position.id };
}
const reassessAt = (service: Service, caseId: string, cutoff = LATER) => service.reassess(caseId, { ...fixtureBundle(full(), undefined, fixtureStageObservations), cutoff, profile: quoted });
const candidateOf = (r: ManagementResult) => { const q = quoteFor(r, 'CANDIDATE_LEG')?.request; return q && [q.legId, q.quantityAtomic]; };
const planOf = (r: ManagementResult) => r.position?.status === 'KNOWN' ? r.position.planBasis : null;
const withService = (fn: (service: Service) => void) => { const service = new Service(':memory:'); try { fn(service); } finally { service.close(); } };

test('a successor must declare continue or fresh start, and that declaration decides which sales its steps count', () => {
  withService(service => {
    const { caseId } = trackedCase(service, '400');
    for (const basis of [undefined, 'continue', 'RESET']) {
      assert.throws(() => service.successor(caseId, firstPlan, T, basis as never), { message: 'SUCCESSOR_PLAN_BASIS_REQUIRED' });
    }
    const unchanged = service.episode(service.showCase(caseId).episodeId!);
    // Continue with the same step: its earlier sale carries over, so the finished plan asks for a successor instead of selling twice.
    const continued = service.successor(caseId, firstPlan, T, 'CONTINUE');
    assert.deepEqual(continued.planBasis, { mode: 'CONTINUE', anchorAt: null });
    const r = reassessAt(service, caseId).result;
    assert.deepEqual(verdict(r, 'MG-12'), ['UNKNOWN', 'PLAN_EXHAUSTED']);
    assert.deepEqual(planOf(r), { mode: 'CONTINUE', anchorAt: null, baseQuantityAtomic: '1000' });
    assert.deepEqual(service.episode(unchanged.id), unchanged, 'saved episodes are never rewritten');
  });
  withService(service => {
    // Continue with a reused and a new step: shares stay on the original 1000.
    const { caseId } = trackedCase(service, '400');
    service.successor(caseId, managedThesis([leg('leg-1', p('O02', true, 'bool')), leg('leg-2', p('O02', true, 'bool'), 3000)]), T, 'CONTINUE');
    assert.deepEqual(candidateOf(reassessAt(service, caseId).result), ['leg-2', '300']);
  });
  withService(service => {
    // Continue with fresh IDs: by declaration, still shares of the original 1000.
    const { caseId } = trackedCase(service, '400');
    service.successor(caseId, managedThesis([leg('leg-x', p('O02', true, 'bool'))]), T, 'CONTINUE');
    assert.deepEqual(candidateOf(reassessAt(service, caseId).result), ['leg-x', '400']);
  });
  withService(service => {
    // Continue carries a partial fill: 200 of the step's 400 are already sold.
    const { caseId } = trackedCase(service, '200');
    service.successor(caseId, firstPlan, T, 'CONTINUE');
    assert.deepEqual(candidateOf(reassessAt(service, caseId).result), ['leg-1', '200']);
  });
  withService(service => {
    // A continued step larger than what is left is a quantity conflict, never a silent "no eligible step".
    const { caseId } = trackedCase(service, '400');
    service.successor(caseId, managedThesis([leg('leg-big', p('O02', true, 'bool'), 7000)]), T, 'CONTINUE');
    const r = reassessAt(service, caseId).result;
    assert.deepEqual([verdict(r, 'MG-12'), verdict(r, 'MG-15'), candidateOf(r), r.proposal], [['PASS', 'RULE_SATISFIED'], ['UNKNOWN', 'QUANTITY_CONFLICT'], undefined, 'REASSESS_REQUIRED']);
  });
  withService(service => {
    // Fresh start with the reused ID: the earlier sale does not count, and shares rebase to the 600 held at the successor's time.
    const { caseId, positionId } = trackedCase(service, '400');
    const fresh = service.successor(caseId, firstPlan, T, 'FRESH_START');
    assert.deepEqual(fresh.planBasis, { mode: 'FRESH_START', anchorAt: T });
    let r = reassessAt(service, caseId).result;
    assert.deepEqual([candidateOf(r), planOf(r)], [['leg-1', '240'], { mode: 'FRESH_START', anchorAt: T, baseQuantityAtomic: '600' }]);
    service.appendPositionEvent(positionId, evt({ id: 'after-1', idempotencyKey: 'after-1', quantityAtomic: '100', effectiveAt: '2026-01-01T00:40:00.000Z', recordedAt: '2026-01-01T00:41:00.000Z' }));
    assert.deepEqual(candidateOf(reassessAt(service, caseId).result), ['leg-1', '140']);
    // A later successor that continues keeps the fresh start's anchor.
    const next = service.successor(caseId, managedThesis([leg('leg-1', p('O02', true, 'bool')), leg('leg-2', p('O02', true, 'bool'), 2000)]), '2026-01-01T00:50:00.000Z', 'CONTINUE');
    assert.deepEqual(next.planBasis, { mode: 'CONTINUE', anchorAt: T });
    assert.deepEqual(candidateOf(reassessAt(service, caseId).result), ['leg-1', '140']);
    // An unattributed sale after the anchor leaves the plan unreconciled.
    service.appendPositionEvent(positionId, evt({ id: 'after-2', idempotencyKey: 'after-2', quantityAtomic: '50', effectiveAt: '2026-01-01T00:55:00.000Z', recordedAt: '2026-01-01T00:56:00.000Z', legId: undefined }));
    r = reassessAt(service, caseId).result;
    assert.deepEqual([verdict(r, 'MG-12'), r.proposal], [['UNKNOWN', 'UNRECONCILED_SALE'], 'REASSESS_REQUIRED']);
  });
  withService(service => {
    // An unattributed sale before a fresh start blocks the first plan, but the fresh plan is measured from what is held after it.
    const { caseId } = trackedCase(service, null, [evt({ legId: undefined, quantityAtomic: '100' })]);
    assert.deepEqual(verdict(reassessAt(service, caseId, '2026-01-01T00:20:00.000Z').result, 'MG-12'), ['UNKNOWN', 'UNRECONCILED_SALE']);
    service.successor(caseId, firstPlan, T, 'FRESH_START');
    assert.deepEqual(candidateOf(reassessAt(service, caseId).result), ['leg-1', '360']);
  });
});

test('a successor saved without a declared basis blocks sized proposals but not a known invalidation', () => {
  const legacy = (invalidated: boolean): Inputs => {
    const e = traction(ep(p('O01', true, 'bool'), p('O03', invalidated, 'bool'), [leg('leg-1', p('O02', true, 'bool'))]));
    return { ...dca(), episode: { ...e, supersedesEpisodeId: 'fixture-episode-000' }, events: [evt({ quantityAtomic: '400' })], cutoff: LATER };
  };
  const r = prove(legacy(false));
  for (const id of ['MG-12', 'MG-13', 'MG-15']) assert.deepEqual(verdict(r, id), ['UNKNOWN', 'PLAN_RECONCILIATION_REQUIRED'], id);
  assert.deepEqual([r.proposal, planOf(r), r.exitQuotes?.map(q => q.request.purpose)], ['REASSESS_REQUIRED', { mode: 'UNRESOLVED' }, ['REMAINING_POSITION']]);
  const invalidated = run(legacy(true));
  assert.deepEqual([invalidated.thesisState, invalidated.proposal, invalidated.remainingQuantityAtomic], ['INVALIDATED', 'EXIT_REVIEW', '600']);
  // The same legacy episode under v6 keeps its original reading (the leg's sale carries over).
  assert.deepEqual(row(runAs(V6, legacy(false)), 'MG-12').reasonCode, 'PLAN_EXHAUSTED');
});

test('without exact proof management shows the quotes it needs and proposes nothing', () => {
  const r = run(dca());
  assert.deepEqual([r.thesisState, r.proposal, r.proposedQuantityAtomic], ['UNVERIFIABLE', 'REASSESS_REQUIRED', undefined]);
  assert.deepEqual([verdict(r, 'MG-03'), verdict(r, 'MG-15')], [['UNKNOWN', 'EXIT_PROOF_MISSING'], ['UNKNOWN', 'EXIT_PROOF_MISSING']]);
  const fingerprint = r.position?.status === 'KNOWN' ? r.position.executionBasis : null;
  assert.match(fingerprint!.fingerprint, /^[a-f0-9]{64}$/);
  const common = { token: TOKEN, caseId: 'fixture-case-001', episodeId: 'fixture-episode-001', positionId: 'fixture-position-001', decimals: 0, executionBasis: fingerprint! };
  assert.deepEqual(r.exitQuotes!.map(q => q.request), [
    { purpose: 'REMAINING_POSITION', legId: null, quantityAtomic: '1000', ...common },
    { purpose: 'CANDIDATE_LEG', legId: 'leg-1', quantityAtomic: '400', ...common },
  ]);
  assert.ok(r.checks.every(c => !c.basisRefs?.some(b => b.kind === 'LEDGER_REVISION')), 'v7 cites the execution basis, not the legacy revision');
});

test('exact proof for the holding and the step proposes the sale with its position mode', () => {
  const r = prove(dca());
  assert.deepEqual([r.thesisState, r.proposal, r.proposedLegId, r.proposedQuantityAtomic, r.positionMode], ['VALIDATED', 'DCA_OUT_PROPOSED', 'leg-1', '400', 'HYPOTHETICAL']);
  assert.deepEqual([verdict(r, 'MG-03'), verdict(r, 'MG-15')], [['PASS', 'RULE_SATISFIED'], ['PASS', 'RULE_SATISFIED']]);
  const step = quoteFor(r, 'CANDIDATE_LEG')!;
  assert.deepEqual([step.feasibility, step.trust, step.label, step.proofIds], ['FILLABLE', 'VERIFIED', null, ['fixture-exit-proof-leg-1']]);
  assert.deepEqual(step.quote, { outputAsset: 'FIXTURE_QUOTE', outputDecimals: 0, expectedOutputAtomic: '1000', minimumOutputAtomic: '990', feesInOutputAtomic: '0', priceImpactBps: '10' });
  assert.deepEqual(row(r, 'MG-15').basisRefs, [
    { kind: 'EXIT_LEG', ref: 'leg-1' }, { kind: 'POSITION', ref: 'fixture-position-001' },
    { kind: 'EXECUTION_BASIS', ref: step.request.executionBasis.fingerprint }, { kind: 'EXIT_PROOF', ref: 'fixture-exit-proof-leg-1' },
  ]);
  // Neither proof substitutes for the other.
  const stepOnly = prove(dca(), r => r.purpose === 'CANDIDATE_LEG' ? [fixtureExitProof(r)] : []);
  assert.deepEqual([verdict(stepOnly, 'MG-03'), stepOnly.proposal], [['UNKNOWN', 'EXIT_PROOF_MISSING'], 'REASSESS_REQUIRED']);
  const holdingOnly = prove(dca(), r => r.purpose === 'REMAINING_POSITION' ? [fixtureExitProof(r)] : []);
  assert.deepEqual([holdingOnly.thesisState, verdict(holdingOnly, 'MG-15'), holdingOnly.proposal], ['VALIDATED', ['UNKNOWN', 'EXIT_PROOF_MISSING'], 'REASSESS_REQUIRED']);
});

test('a proof for anything other than the exact request and basis is a mismatch', () => {
  const mismatches: Array<[string, (r: ExitQuoteRequest) => ExitProof]> = [
    ['chain', r => fixtureExitProof(r, { token: { chain: 'base', address: 'FIXTURE_TOKEN' } })],
    ['token', r => fixtureExitProof(r, { token: { chain: 'solana', address: 'OTHER_TOKEN' } })],
    ['case', r => fixtureExitProof(r, { caseId: 'other-case' })],
    ['position', r => fixtureExitProof(r, { positionId: 'other-position' })],
    ['episode', r => fixtureExitProof(r, { episodeId: 'other-episode' })],
    ['leg', r => fixtureExitProof(r, { legId: 'leg-2' })],
    ['quantity', r => fixtureExitProof(r, { quantityAtomic: '401' })],
    ['decimals', r => fixtureExitProof(r, { decimals: 6 })],
    ['fingerprint', r => fixtureExitProof(r, { executionBasis: { ...r.executionBasis, fingerprint: '0'.repeat(64) } })],
    ['basis version', r => fixtureExitProof(r, { executionBasis: { ...r.executionBasis, version: 'execution-basis-v0' } })],
  ];
  for (const [name, make] of mismatches) {
    const r = prove(dca(), candidateAs(q => [make(q)]));
    assert.deepEqual([verdict(r, 'MG-15'), r.proposal], [['UNKNOWN', 'EXIT_PROOF_MISMATCH'], 'REASSESS_REQUIRED'], name);
  }
});

test('stale, future, unresolved, unsupported or under-qualified proofs stay unknown and never become a blocked route', () => {
  const unknown: Array<[string, (r: ExitQuoteRequest) => ExitProof[], string, typeof quoted?]> = [
    ['expired at the cutoff', r => [fixtureExitProof(r, { expiresAt: C })], 'EXIT_PROOF_NOT_CURRENT'],
    ['available after the cutoff', r => [fixtureExitProof(r, { availableAt: '2026-01-01T00:00:01.000Z' })], 'EXIT_PROOF_NOT_CURRENT'],
    ['quoted after the cutoff', r => [fixtureExitProof(r, { asOf: '2026-01-01T00:00:01.000Z', availableAt: '2026-01-01T00:00:01.000Z' })], 'EXIT_PROOF_NOT_CURRENT'],
    ['unknown evidence', r => [fixtureExitProof(r, { evidenceIds: ['missing-evidence'] })], 'EXIT_PROOF_INCOMPLETE'],
    ['evidence newer than the proof', r => [fixtureExitProof(r, { asOf: '2025-12-31T23:59:00.000Z', availableAt: '2025-12-31T23:59:30.000Z' })], 'EXIT_PROOF_INCOMPLETE'],
    ['unsupported adapter', r => [fixtureExitProof(r, { route: { adapter: 'unlisted-dex-v1', venue: 'x' } })], 'EXIT_PROOF_UNSUPPORTED'],
    ['unsupported adapter claiming a block', r => [fixtureBlockedExitProof(r, 'TOKEN', { route: { adapter: 'unlisted-dex-v1', venue: 'x' } })], 'EXIT_PROOF_UNSUPPORTED'],
    ['adapter not behind the cited evidence', r => [fixtureExitProof(r, { evidenceIds: ['fixture-evidence-001'] })], 'EXIT_PROOF_UNSUPPORTED'],
    ['quote where a simulation is required', r => [fixtureExitProof(r)], 'EXIT_PROOF_UNSUPPORTED', { ...quoted, exitProofLevel: 'SIMULATED' }],
    ['fee in another asset without conversion', r => [fixtureExitProof(r, { fees: [{ asset: 'SOL', decimals: 9, amountAtomic: '5000', includedInOutput: false, outputAmountAtomic: null, conversionEvidenceIds: [] }] })], 'EXIT_PROOF_INCOMPLETE'],
    ['fee conversion citing unknown evidence', r => [fixtureExitProof(r, { fees: [{ asset: 'SOL', decimals: 9, amountAtomic: '5000', includedInOutput: false, outputAmountAtomic: '5', conversionEvidenceIds: ['missing-evidence'] }] })], 'EXIT_PROOF_INCOMPLETE'],
  ];
  for (const [name, make, reason, profile] of unknown) {
    const r = prove(dca(), candidateAs(make), profile ?? quoted);
    assert.deepEqual([verdict(r, 'MG-15'), quoteFor(r, 'CANDIDATE_LEG')!.feasibility, r.proposal], [['UNKNOWN', reason], 'UNKNOWN', 'REASSESS_REQUIRED'], name);
  }
  // Evidence that really came from an unlisted adapter still does not make that adapter supported.
  const unlisted: EvidenceRecord = { ...fixtureExitQuoteEvidence, id: 'unlisted-evidence', adapterVersion: 'unlisted-dex-v1' };
  const bound = prove(dca(), candidateAs(r => [fixtureExitProof(r, { evidenceIds: [unlisted.id], route: { adapter: 'unlisted-dex-v1', venue: 'x' } })]), quoted, [...EVIDENCE, unlisted]);
  assert.deepEqual(verdict(bound, 'MG-15'), ['UNKNOWN', 'EXIT_PROOF_UNSUPPORTED']);
  const simulated = prove(dca(), r => [fixtureExitProof(r, { level: 'SIMULATED' })], { ...quoted, exitProofLevel: 'SIMULATED' });
  assert.equal(simulated.proposal, 'DCA_OUT_PROPOSED');
  const noLevel = prove(dca(), r => [fixtureExitProof(r)], prof);
  assert.deepEqual([verdict(noLevel, 'MG-15'), row(noLevel, 'MG-15').basisRefs?.at(-1)], [['UNKNOWN', 'POLICY_PARAMETER_MISSING'], { kind: 'PROFILE_FIELD', ref: 'exitProofLevel' }]);
  const { maxExitImpactBps: _limit, ...risk } = quoted.risk;
  const noLimit = prove(dca(), r => [fixtureExitProof(r)], { ...quoted, risk });
  assert.deepEqual([verdict(noLimit, 'MG-15'), row(noLimit, 'MG-15').basisRefs?.at(-1)], [['UNKNOWN', 'POLICY_PARAMETER_MISSING'], { kind: 'PROFILE_FIELD', ref: 'risk.maxExitImpactBps' }]);
});

test('fees count against the worst-case output, and converted fees need conversion evidence', () => {
  const sol = { asset: 'SOL', decimals: 9, amountAtomic: '5000' };
  const converted = prove(dca(), candidateAs(r => [fixtureExitProof(r, { fees: [{ ...sol, includedInOutput: false, outputAmountAtomic: '5', conversionEvidenceIds: [fixtureExitQuoteEvidence.id] }] })]));
  assert.deepEqual([converted.proposal, quoteFor(converted, 'CANDIDATE_LEG')!.quote?.feesInOutputAtomic], ['DCA_OUT_PROPOSED', '5']);
  const included = prove(dca(), candidateAs(r => [fixtureExitProof(r, { fees: [{ ...sol, includedInOutput: true, outputAmountAtomic: null, conversionEvidenceIds: [] }] })]));
  assert.deepEqual([included.proposal, quoteFor(included, 'CANDIDATE_LEG')!.quote?.feesInOutputAtomic], ['DCA_OUT_PROPOSED', '0']);
  const sameAsset = (amountAtomic: string) => prove(dca(), candidateAs(r => [fixtureExitProof(r, { fees: [{ asset: 'FIXTURE_QUOTE', decimals: 0, amountAtomic, includedInOutput: false, outputAmountAtomic: null, conversionEvidenceIds: [] }] })]));
  assert.equal(sameAsset('989').proposal, 'DCA_OUT_PROPOSED');
  const eaten = sameAsset('990');
  assert.deepEqual([verdict(eaten, 'MG-15'), quoteFor(eaten, 'CANDIDATE_LEG')!.feasibility, eaten.thesisState, eaten.proposal], [['FAIL', 'EXIT_LIMIT_EXCEEDED'], 'OVER_LIMIT', 'VALIDATED', 'REASSESS_REQUIRED']);
});

test('a blocked or over-limit step fails MG-15 and asks for reassessment without invalidating the thesis', () => {
  const cases: Array<[string, (r: ExitQuoteRequest) => ExitProof[], string, string]> = [
    ['impact above the profile limit', r => [withOutput(r, { priceImpactBps: '150' })], 'EXIT_LIMIT_EXCEEDED', 'OVER_LIMIT'],
    ['no route for this quantity', r => [fixtureBlockedExitProof(r, 'QUANTITY')], 'EXIT_ROUTE_BLOCKED', 'BLOCKED'],
    ['token-wide restriction', r => [fixtureBlockedExitProof(r, 'TOKEN')], 'TOKEN_EXIT_RESTRICTED', 'BLOCKED'],
  ];
  for (const [name, make, reason, feasibility] of cases) {
    const r = prove(dca(), candidateAs(make));
    assert.deepEqual([verdict(r, 'MG-15'), quoteFor(r, 'CANDIDATE_LEG')!.feasibility, r.thesisState, r.proposal, r.proposedQuantityAtomic], [['FAIL', reason], feasibility, 'VALIDATED', 'REASSESS_REQUIRED', undefined], name);
  }
});

test('matching proofs that disagree are a conflict; agreeing proofs report the most cautious quote', () => {
  const conflict = prove(dca(), candidateAs(r => [fixtureExitProof(r), fixtureBlockedExitProof(r)]));
  assert.deepEqual([verdict(conflict, 'MG-15'), quoteFor(conflict, 'CANDIDATE_LEG')!.proofIds, conflict.proposal], [['UNKNOWN', 'EXIT_PROOF_CONFLICT'], ['fixture-exit-proof-leg-1', 'fixture-exit-proof-leg-1-blocked'], 'REASSESS_REQUIRED']);
  const overLimit = prove(dca(), candidateAs(r => [fixtureExitProof(r), withOutput(r, { priceImpactBps: '150' }, { id: 'steep' })]));
  assert.deepEqual(verdict(overLimit, 'MG-15'), ['UNKNOWN', 'EXIT_PROOF_CONFLICT']);
  const agreeing = prove(dca(), candidateAs(r => [fixtureExitProof(r), withOutput(r, { minimumAtomic: '980' }, { id: 'cautious' })]));
  const step = quoteFor(agreeing, 'CANDIDATE_LEG')!;
  assert.deepEqual([agreeing.proposal, step.proofIds, step.quote?.minimumOutputAtomic], ['DCA_OUT_PROPOSED', ['cautious', 'fixture-exit-proof-leg-1'], '980']);
});

test('typed quotes count both ways for practice positions only, and are labeled as unverified', () => {
  const typed: EvidenceRecord = { ...fixtureExitQuoteEvidence, id: 'typed-quote-001', accessMode: 'USER_IMPORT', sourceType: 'OPERATOR_TYPED', adapterVersion: 'operator-entry' };
  const evidence = [...EVIDENCE, typed];
  const scenario = (r: ExitQuoteRequest) => [fixtureExitProof(r, { evidenceIds: [typed.id], route: { adapter: 'typed-by-operator', venue: 'operator' } })];
  const practice = prove(dca(), scenario, quoted, evidence);
  const step = quoteFor(practice, 'CANDIDATE_LEG')!;
  assert.deepEqual([practice.proposal, practice.positionMode, step.trust, step.label], ['DCA_OUT_PROPOSED', 'HYPOTHETICAL', 'SCENARIO', SCENARIO_QUOTE_LABEL]);
  assert.equal(SCENARIO_QUOTE_LABEL, 'scenario quote, not verified');
  const real = prove(manual(dca()), scenario, quoted, evidence);
  assert.deepEqual([verdict(real, 'MG-03'), verdict(real, 'MG-15'), real.proposal], [['UNKNOWN', 'EXIT_PROOF_UNVERIFIED'], ['UNKNOWN', 'EXIT_PROOF_UNVERIFIED'], 'REASSESS_REQUIRED']);
  const verified = prove(manual(dca()));
  assert.deepEqual([verified.proposal, verified.positionMode, quoteFor(verified, 'CANDIDATE_LEG')!.trust], ['DCA_OUT_PROPOSED', 'MANUAL_REPORTED', 'VERIFIED']);
  // A typed "cannot sell the holding" also counts for a practice position: an exit review of the practice holding, still labeled.
  const blockedPractice = prove(dca(), holdingAs(r => [fixtureBlockedExitProof(r, 'QUANTITY', { evidenceIds: [typed.id] })]), quoted, evidence);
  assert.deepEqual([blockedPractice.proposal, blockedPractice.executionFeasibility, quoteFor(blockedPractice, 'REMAINING_POSITION')!.label], ['EXIT_REVIEW', 'BLOCKED', SCENARIO_QUOTE_LABEL]);
});

test('a holding that cannot be sold invalidates the thesis and the exit review says so; missing proof never hides invalidation', () => {
  const blocked = prove(dca(), holdingAs(r => [fixtureBlockedExitProof(r, 'QUANTITY')]));
  assert.deepEqual([verdict(blocked, 'MG-03'), blocked.thesisState, blocked.proposal, blocked.remainingQuantityAtomic, blocked.positionMode, blocked.executionFeasibility],
    [['FAIL', 'EXIT_ROUTE_BLOCKED'], 'INVALIDATED', 'EXIT_REVIEW', '1000', 'HYPOTHETICAL', 'BLOCKED']);
  const invalidated = run(scenarios['invalidated-with-position']!());
  assert.deepEqual([invalidated.thesisState, invalidated.proposal, invalidated.remainingQuantityAtomic, invalidated.executionFeasibility, verdict(invalidated, 'MG-07')],
    ['INVALIDATED', 'EXIT_REVIEW', '1000', 'UNKNOWN', ['FAIL', 'INVALIDATION_TRIGGERED']]);
  const exitRowsFail = run({ ...dca(), features: full({ O14: '500' }) });
  assert.deepEqual([verdict(exitRowsFail, 'MG-03'), exitRowsFail.proposal], [['FAIL', 'EXIT_RULE_FAILED'], 'EXIT_REVIEW']);
});

test('a due step larger than the inventory is a quantity conflict under v7, where v6 said no eligible step', () => {
  const movedOut = { ...dca(), events: [evt({ kind: 'TRANSFER_ADJUSTMENT', direction: 'OUT', quantityAtomic: '700', quoteAmount: '0', legId: undefined })], cutoff: LATER };
  const r = prove(movedOut);
  assert.deepEqual([verdict(r, 'MG-12'), verdict(r, 'MG-15'), r.exitQuotes?.map(q => [q.request.purpose, q.request.quantityAtomic]), r.proposal],
    [['PASS', 'RULE_SATISFIED'], ['UNKNOWN', 'QUANTITY_CONFLICT'], [['REMAINING_POSITION', '300']], 'REASSESS_REQUIRED']);
  assert.equal(row(runAs(V6, movedOut), 'MG-15').reasonCode, 'NO_ELIGIBLE_LEG');
});

test('while holding with no step due, v7 quotes the next step early, so MG-15 is known and the hold decision is unchanged', () => {
  const quotesOf = (r: ManagementResult) => r.exitQuotes?.map(q => [q.request.purpose, q.request.legId, q.request.quantityAtomic]);
  const cases: Array<[string, unknown[]]> = [
    ['maintain', [['REMAINING_POSITION', null, '1000'], ['NEXT_LEG', 'leg-1', '400']]],
    // Step two is due, but step one comes first: the early quote is for step one.
    ['first-not-due-later-due', [['REMAINING_POSITION', null, '1000'], ['NEXT_LEG', 'leg-1', '400']]],
    ['consumed-leg-then-not-due', [['REMAINING_POSITION', null, '600'], ['NEXT_LEG', 'leg-2', '300']]],
  ];
  for (const [name, expected] of cases) {
    const i = scenarios[name]!();
    const asked = run(i);
    assert.deepEqual([quotesOf(asked), verdict(asked, 'MG-15'), asked.proposal], [expected, ['UNKNOWN', 'EXIT_PROOF_MISSING'], 'REASSESS_REQUIRED'], name);
    const proven = prove(i);
    const step = (expected[1] as string[])[1]!;
    assert.deepEqual([verdict(proven, 'MG-15'), row(proven, 'MG-15').basisRefs?.[0], proven.thesisState, proven.proposal, proven.proposedQuantityAtomic],
      [['PASS', 'RULE_SATISFIED'], { kind: 'EXIT_LEG', ref: step }, 'VALIDATED', 'MAINTAIN_THESIS', undefined], name);
    const blocked = prove(i, r => r.purpose === 'NEXT_LEG' ? [fixtureBlockedExitProof(r)] : [fixtureExitProof(r)]);
    assert.deepEqual([verdict(blocked, 'MG-15'), quoteFor(blocked, 'NEXT_LEG')!.feasibility, blocked.thesisState, blocked.proposal],
      [['FAIL', 'EXIT_ROUTE_BLOCKED'], 'BLOCKED', 'VALIDATED', 'MAINTAIN_THESIS'], name);
    const v6 = runAs(V6, i);
    assert.deepEqual([verdict(v6, 'MG-15'), 'exitQuotes' in v6], [['UNKNOWN', 'NO_ELIGIBLE_LEG'], false], name);
  }
  // A step that is not due but no longer fits what is left is a quantity conflict, not a quote request.
  const movedOut = { ...scenarios['maintain']!(), events: [evt({ kind: 'TRANSFER_ADJUSTMENT', direction: 'OUT', quantityAtomic: '700', quoteAmount: '0', legId: undefined })], cutoff: LATER };
  const conflict = prove(movedOut);
  assert.deepEqual([verdict(conflict, 'MG-15'), quotesOf(conflict)], [['UNKNOWN', 'QUANTITY_CONFLICT'], [['REMAINING_POSITION', null, '300']]]);
});

test('offline readiness: with every requested proof supplied, each fully specified v7 scenario has no unknown row', () => {
  // Synthetic inputs only. This shows no row is stuck unknown by design; the owner's zero-UNKNOWN gate still needs real-CA runs.
  const specified = ['dca-proposed', 'attributed-partial-sale', 'consumed-leg-then-due', 'later-leg-unknown', 'maintain', 'first-not-due-later-due',
    'consumed-leg-then-not-due', 'invalidated-with-position', 'invalidated-after-partial-sale', 'expired-with-manual-position'];
  for (const name of specified) {
    const r = prove(scenarios[name]!());
    assert.deepEqual(r.checks.filter(c => c.status === 'UNKNOWN').map(c => `${c.checkId} ${c.reasonCode}`), [], name);
  }
});

test('every v7 result states its position context, or explicitly that there is none, without profit or principal claims', () => {
  const known = run(dca());
  assert.deepEqual({ ...known.position, executionBasis: undefined }, {
    status: 'KNOWN', positionId: 'fixture-position-001', mode: 'HYPOTHETICAL', units: 'ATOMIC', decimals: 0, initialQuantityAtomic: '1000', remainingQuantityAtomic: '1000',
    knownCost: '100', quoteCurrency: 'FIXTURE_QUOTE', planBasis: { mode: 'ORIGIN', anchorAt: null, baseQuantityAtomic: '1000' }, executionBasis: undefined,
  });
  const partial = run(scenarios['attributed-partial-sale']!());
  assert.deepEqual(partial.position?.status === 'KNOWN' && [partial.position.remainingQuantityAtomic, partial.position.knownCost], ['800', '80']);
  const unknownCost = run(scenarios['unknown-cost']!());
  assert.deepEqual(unknownCost.position?.status === 'KNOWN' && unknownCost.position.knownCost, null);
  assert.equal(run(scenarios['expired-with-manual-position']!()).position?.status === 'KNOWN' && run(scenarios['expired-with-manual-position']!()).positionMode, 'MANUAL_REPORTED');
  for (const name of ['validated-no-plan', 'invalidated-position-recorded-later']) {
    const none = run(scenarios[name]!());
    assert.deepEqual([none.position, 'exitQuotes' in none], [{ status: 'NONE' }, false], name);
  }
  for (const r of [known, prove(dca()), unknownCost]) {
    assert.ok(Object.keys(r).every(k => ['checks', 'thesisState', 'proposal', 'proposedQuantityAtomic', 'proposedLegId', 'positionMode', 'remainingQuantityAtomic', 'executionFeasibility', 'position', 'exitQuotes'].includes(k)), Object.keys(r).join());
  }
});

test('the Service rejects malformed, future, unreferenced or misplaced exit proofs at its boundary', () => {
  withService(service => {
    const { caseId } = trackedCase(service, null);
    const bundle: Bundle = { ...fixtureBundle(full(), undefined, fixtureStageObservations), profile: quoted, evidence: EVIDENCE };
    const [holding, step] = reassessAt(service, caseId, C).result.exitQuotes!.map(q => q.request);
    const reassess = (exitProofs: unknown[], extra: Partial<Bundle> = {}) => service.reassess(caseId, { ...bundle, ...extra, exitProofs } as Bundle);
    assert.throws(() => reassess([fixtureExitProof(step!, { evidenceIds: ['missing-evidence'] })]), { message: 'UNKNOWN_EVIDENCE_REF' });
    assert.throws(() => reassess([fixtureExitProof(step!, { asOf: '2026-01-01T00:00:01.000Z', availableAt: '2026-01-01T00:00:01.000Z' })]), { message: 'FUTURE_EXIT_PROOF' });
    assert.throws(() => reassess([fixtureExitProof(step!), fixtureExitProof(step!)]), { message: 'DUPLICATE_BUNDLE_ID' });
    assert.throws(() => reassess([withOutput(step!, { minimumAtomic: '1001' })]), /minimum output exceeds expected output/);
    assert.throws(() => reassess([withOutput(step!, { minimumAtomic: '900', slippageToleranceBps: 50 })]), /below the declared slippage tolerance/);
    assert.throws(() => reassess([fixtureExitProof(holding!, { legId: 'leg-1' })]), /names its leg/);
    assert.throws(() => reassess([fixtureExitProof(step!, { expiresAt: '2025-12-31T00:00:00.000Z' })]), /asOf <= availableAt < expiresAt/);
    assert.throws(() => reassess([{ ...fixtureExitProof(step!), extra: true }]), /Unrecognized key/);
    assert.throws(() => service.analyze({ ...fixtureBundle(full(), firstPlan), token: { chain: 'base', address: 'OTHER_FIXTURE' }, evidence: EVIDENCE, exitProofs: [fixtureExitProof(step!)] }), { message: 'EXIT_PROOFS_REQUIRE_REASSESSMENT' });
    const address = { chain: 'solana' as const, address: '11111111111111111111111111111111' };
    assert.throws(() => service.reassess(caseId, { ...bundle, token: address, analysisKind: 'MANUAL_EMPTY', evidence: [], observations: [], features: [], exitProofs: [fixtureExitProof(step!, { token: address })] }), { message: 'MANUAL_EMPTY_MUST_BE_EMPTY' });
  });
});

test('an imported quote can only be a labeled scenario: it never confirms a reported position', () => {
  const token: TokenRef = { chain: 'solana', address: '11111111111111111111111111111111' };
  const raw = 'operator-typed exit quote', typed: EvidenceRecord = {
    id: 'typed-quote-001', sourceId: 'operator', sourceType: 'OPERATOR_TYPED', retrievedAt: C, availableAt: C,
    contentHash: createHash('sha256').update(raw).digest('hex'), adapterVersion: 'operator-entry', accessMode: 'USER_IMPORT', scope: {},
  };
  const imported = (exitProofs: ExitProof[] = []): Bundle => ({
    token, cutoff: C, analysisKind: 'USER_IMPORT', evidence: [typed], rawArtifacts: { [typed.id]: raw }, observations: [],
    features: full().map(f => ({ ...f, evidenceIds: [typed.id] })), profile: quoted, exitProofs,
  });
  // Imports persist their raw artifacts beside the database, so this test uses a temporary directory rather than ':memory:'.
  for (const mode of ['MANUAL_REPORTED', 'HYPOTHETICAL'] as const) {
    const directory = mkdtempSync(join(tmpdir(), 'management-execution-import-'));
    const service = new Service(join(directory, 'dd.sqlite'));
    try {
      const entry = service.analyze({ ...fixtureBundle(full(), firstPlan), token });
      service.recordPosition(pos({ caseId: entry.caseId, mode }));
      const step = service.reassess(entry.caseId, imported()).result.exitQuotes!.find(q => q.request.purpose === 'REMAINING_POSITION')!.request;
      const r = service.reassess(entry.caseId, imported([fixtureExitProof(step, { evidenceIds: [typed.id], route: { adapter: 'operator-entry', venue: 'operator' } })])).result;
      const quote = quoteFor(r, 'REMAINING_POSITION')!;
      assert.equal(r.checks.find(c=>c.checkId==='MG-03')?.status,'UNKNOWN');
      assert.notEqual(r.proposal,'DCA_OUT_PROPOSED');
      if (mode === 'MANUAL_REPORTED') assert.deepEqual([quote.status,quote.reasonCode], ['UNKNOWN', 'EXIT_PROOF_UNVERIFIED']);
      else assert.deepEqual([quote.status, quote.trust, quote.label], ['PASS', 'SCENARIO', SCENARIO_QUOTE_LABEL]);
    } finally { service.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});

test('a v7 snapshot freezes its proofs and token, replays from disk, and differs under v6', () => {
  const directory = mkdtempSync(join(tmpdir(), 'management-execution-replay-'));
  const file = join(directory, 'dd.sqlite');
  try {
    let id = '', saved: ManagementResult | null = null;
    const service = new Service(file);
    try {
      const { caseId } = trackedCase(service, null);
      const bundle: Bundle = { ...fixtureBundle(full(), undefined, fixtureStageObservations), profile: quoted, evidence: EVIDENCE };
      const requests = service.reassess(caseId, bundle).result.exitQuotes!.map(q => q.request);
      const snapshot = service.reassess(caseId, { ...bundle, exitProofs: requests.map(r => fixtureExitProof(r)) });
      assert.deepEqual([snapshot.result.proposal, snapshot.result.positionMode], ['DCA_OUT_PROPOSED', 'HYPOTHETICAL']);
      id = snapshot.id; saved = snapshot.result;
    } finally { service.close(); }
    const db = new DatabaseSync(file);
    try {
      const row = db.prepare('SELECT payload,semantic FROM snapshots WHERE id=?').get(id) as { payload: string; semantic: string };
      const semantic = JSON.parse(row.semantic) as Record<string, unknown>;
      assert.deepEqual([semantic.policyVersion, semantic.token, (semantic.exitProofs as ExitProof[]).map(p => p.id)], [MANAGEMENT_POLICY_VERSION, TOKEN, ['fixture-exit-proof-remaining', 'fixture-exit-proof-leg-1']]);
      const relabeled = { ...semantic, policyVersion: V6 };
      db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?)').run('relabeled', 'MANAGEMENT', row.payload, decisionHash(relabeled), JSON.stringify(relabeled));
    } finally { db.close(); }
    const reopened = new Service(file);
    try {
      const replayed = reopened.replay(id);
      assert.deepEqual(replayed.checklistKind === 'MANAGEMENT' && replayed.result, saved);
      assert.throws(() => reopened.replay('relabeled'), /REPLAY_RESULT_MISMATCH/);
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the CLI shows the quote request, proposes the proven sale with its position mode, replays it, and requires a successor basis', () => {
  const directory = mkdtempSync(join(tmpdir(), 'management-execution-cli-'));
  try {
    const db = join(directory, 'dd.sqlite');
    const cli = (...args: string[]) => {
      const r = spawnSync(process.execPath, ['dist/src/cli.js', ...args, '--json', '--db', db], { encoding: 'utf8' });
      return { status: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr.replace(/^bigint: Failed to load bindings, pure JS will be used \(try npm run rebuild\?\)\r?\n/, '') };
    };
    const file = (name: string, value: unknown) => { const f = join(directory, name); writeFileSync(f, JSON.stringify(value)); return f; };
    const entry = cli('analyze', 'FIXTURE_TOKEN', '--chain', 'solana', '--bundle', file('entry.json', fixtureBundle(full(), firstPlan)));
    assert.equal(entry.status, 0, entry.err);
    const caseId = entry.out.caseId as string;
    assert.equal(cli('position', 'record', '--file', file('position.json', pos({ caseId }))).status, 0);
    const bundle = { ...fixtureBundle(full(), undefined, fixtureStageObservations), profile: quoted, evidence: EVIDENCE };
    const first = cli('reassess', caseId, '--bundle', file('first.json', bundle));
    assert.equal(first.status, 0, first.err);
    const result = first.out.result as ManagementResult;
    assert.deepEqual([result.proposal, result.position?.status === 'KNOWN' && result.position.mode, result.exitQuotes?.map(q => [q.request.purpose, q.request.quantityAtomic])],
      ['REASSESS_REQUIRED', 'HYPOTHETICAL', [['REMAINING_POSITION', '1000'], ['CANDIDATE_LEG', '400']]]);
    const proven = cli('reassess', caseId, '--bundle', file('proven.json', { ...bundle, exitProofs: result.exitQuotes!.map(q => fixtureExitProof(q.request)) }));
    assert.equal(proven.status, 0, proven.err);
    assert.deepEqual([proven.out.result.proposal, proven.out.result.proposedQuantityAtomic, proven.out.result.positionMode], ['DCA_OUT_PROPOSED', '400', 'HYPOTHETICAL']);
    assert.deepEqual(cli('replay', proven.out.id).out, proven.out);
    const missing = cli('thesis', 'successor', caseId, '--file', file('successor.json', firstPlan));
    assert.deepEqual([missing.status, missing.err.trim()], [2, 'SUCCESSOR_PLAN_BASIS_REQUIRED']);
    const fresh = cli('thesis', 'successor', caseId, '--file', file('successor.json', firstPlan), '--basis', 'fresh-start');
    assert.equal(fresh.status, 0, fresh.err);
    assert.deepEqual(fresh.out.planBasis, { mode: 'FRESH_START', anchorAt: fresh.out.createdAt });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
