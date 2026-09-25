import assert from 'node:assert/strict';
import test from 'node:test';
import { Service } from '../src/app/service.js';
import {
  completeFixtureEntryFeatures, fixtureBundle, fixturePosition, fixturePositionEvent,
  fixtureProvenance, fixtureStageObservations, illustrativeFixtureThesis,
} from '../examples/fixtures.js';

test('fixture analysis is stored once and can be shown and replayed by snapshot ID', () => {
  assert.equal(fixtureProvenance.kind, 'FIXTURE');
  assert.equal(fixtureProvenance.calibratedForLiveUse, false);
  const service = new Service(':memory:');
  try {
    const input = fixtureBundle();
    const first = service.analyze(input);
    const repeated = service.analyze(input);

    assert.equal(first.analysisKind, 'FIXTURE');
    assert.match(first.hash, /^[a-f0-9]{64}$/);
    assert.equal(repeated.id, first.id);
    assert.deepEqual(service.show(first.id), first);
    assert.deepEqual(service.replay(first.id), first);
  } finally {
    service.close();
  }
});

test('passing entry activates a frozen thesis and reassessment preserves the baseline link', () => {
  const service = new Service(':memory:');
  try {
    const entry = service.analyze(fixtureBundle(completeFixtureEntryFeatures(), illustrativeFixtureThesis));
    const tracked = service.caseFor(entry.token);
    assert.equal(entry.result.classification, 'RESEARCH_ELIGIBLE');
    assert.equal(tracked?.status, 'THESIS_TRACKED');
    assert.ok(tracked?.id);

    const currentFeatures = completeFixtureEntryFeatures({ O02: '100000' });
    const management = service.reassess(tracked!.id, fixtureBundle(currentFeatures, undefined, fixtureStageObservations));
    assert.equal(management.baselineSnapshotId, entry.id);
    assert.equal(management.result.thesisState, 'INVALIDATED');
    assert.equal(management.result.proposal, 'EXIT_REVIEW');
    assert.equal(management.result.checks.find(row => row.checkId === 'MG-05')?.status, 'PASS');
    assert.deepEqual(service.replay(management.id), management);
  } finally {
    service.close();
  }
});

test('reassessment does not treat FDV as circulating market cap for stage resolution', () => {
  const service = new Service(':memory:');
  try {
    const entry = service.analyze(fixtureBundle(completeFixtureEntryFeatures(), illustrativeFixtureThesis));
    const tracked = service.caseFor(entry.token);
    assert.ok(tracked?.id);
    const fdvOnly = fixtureStageObservations.map(row => row.field === 'circulatingMarketCapUsd' ? { ...row, field: 'fdvUsd' } : row);
    const management = service.reassess(
      tracked!.id,
      fixtureBundle(completeFixtureEntryFeatures(), undefined, fdvOnly),
    );
    assert.equal(management.result.checks.find(row => row.checkId === 'MG-05')?.status, 'UNKNOWN');
    assert.equal(management.result.thesisState, 'INVALIDATED');
  } finally {
    service.close();
  }
});

test('failed and duplicate position events leave persisted inventory unchanged', () => {
  const service = new Service(':memory:');
  try {
    const entry = service.analyze(fixtureBundle(completeFixtureEntryFeatures(), illustrativeFixtureThesis));
    const tracked = service.caseFor(entry.token);
    assert.ok(tracked?.id);
    const position = fixturePosition({ caseId: tracked!.id });
    service.recordPosition(position);

    const event = fixturePositionEvent({
      id: 'fixture-persistence-event',
      idempotencyKey: 'fixture-persistence-key',
      quantityAtomic: '1001',
    });
    assert.throws(() => service.appendPositionEvent(position.id, event), /OVERSELL/);

    const accepted = { ...event, quantityAtomic: '100', quoteAmount: '20' };
    const first = service.appendPositionEvent(position.id, accepted);
    assert.equal(first.remainingQuantityAtomic, '900');
    assert.equal(service.appendPositionEvent(position.id, accepted).remainingQuantityAtomic, '900');
    assert.throws(() => service.appendPositionEvent(position.id, { ...accepted, quoteAmount: '21' }), /IDEMPOTENCY_CONFLICT/);

    const next = fixturePositionEvent({
      id: 'fixture-persistence-event-2',
      idempotencyKey: 'fixture-persistence-key-2',
      quantityAtomic: '50',
      quoteAmount: '5',
      effectiveAt: '2026-01-01T00:12:00.000Z',
    });
    assert.equal(service.appendPositionEvent(position.id, next).remainingQuantityAtomic, '850');
  } finally {
    service.close();
  }
});

const eligibleManagementThesis = {
  ...illustrativeFixtureThesis,
  invalidation: [{ op: 'eq' as const, feature: 'O03', value: false, unit: 'bool' }],
  onchainTraction: { op: 'eq' as const, feature: 'O01', value: true, unit: 'bool' },
  externalTraction: { op: 'eq' as const, feature: 'A01', value: true, unit: 'bool' },
  legs: [{ id: 'leg-1', quantityBps: 4000, allRemaining: false, trigger: { op: 'eq' as const, feature: 'O02', value: true, unit: 'bool' } }],
};

test('a position recorded after the reassessment cutoff cannot produce a historical exit quantity', () => {
  const service = new Service(':memory:');
  try {
    const entry = service.analyze(fixtureBundle(completeFixtureEntryFeatures(), eligibleManagementThesis));
    service.recordPosition(fixturePosition({ caseId: entry.caseId, recordedAt: '2026-01-01T00:11:00.000Z' }));
    const bundle = { ...fixtureBundle(completeFixtureEntryFeatures()), cutoff: '2026-01-01T00:10:00.000Z' };
    const management = service.reassess(entry.caseId, bundle);
    assert.equal(management.result.checks.find(row => row.checkId === 'MG-13')?.status, 'UNKNOWN');
    assert.equal(management.result.proposal, 'REASSESS_REQUIRED');
    assert.equal(management.result.proposedQuantityAtomic, undefined);
    assert.deepEqual(service.replay(management.id), management);
  } finally {
    service.close();
  }
});

test('historical reassessment excludes later sales and corrections while preserving earlier snapshots', () => {
  const service = new Service(':memory:');
  try {
    const entry = service.analyze(fixtureBundle(completeFixtureEntryFeatures(), eligibleManagementThesis));
    const position = fixturePosition({ caseId: entry.caseId });
    service.recordPosition(position);
    const bundle = { ...fixtureBundle(completeFixtureEntryFeatures()), cutoff: '2026-01-01T00:10:00.000Z' };
    const before = service.reassess(entry.caseId, bundle);
    assert.equal(before.result.proposal, 'DCA_OUT_PROPOSED');
    assert.equal(before.result.proposedQuantityAtomic, '400');

    const sale = fixturePositionEvent({ id: 'historical-sale', idempotencyKey: 'historical-sale-key', quantityAtomic: '100', quoteAmount: '20', effectiveAt: '2026-01-01T00:05:00.000Z', recordedAt: '2026-01-01T00:05:00.000Z' });
    service.appendPositionEvent(position.id, sale);
    const afterSale = service.reassess(entry.caseId, bundle);
    assert.equal(afterSale.result.proposedQuantityAtomic, '300');

    const laterSale = fixturePositionEvent({ id: 'later-sale', idempotencyKey: 'later-sale-key', quantityAtomic: '50', quoteAmount: '10', effectiveAt: '2026-01-01T00:07:00.000Z', recordedAt: '2026-01-01T00:15:00.000Z' });
    service.appendPositionEvent(position.id, laterSale);
    assert.equal(service.reassess(entry.caseId, bundle).id, afterSale.id);

    const correction = fixturePositionEvent({ id: 'sale-correction', idempotencyKey: 'sale-correction-key', kind: 'CORRECTION', replacesId: sale.id, quantityAtomic: '200', quoteAmount: '40', effectiveAt: sale.effectiveAt, recordedAt: '2026-01-01T00:20:00.000Z' });
    service.appendPositionEvent(position.id, correction);
    assert.equal(service.reassess(entry.caseId, bundle).id, afterSale.id);
    const replayed = service.replay(afterSale.id);
    assert.equal(replayed.checklistKind, 'MANAGEMENT');
    if (replayed.checklistKind === 'MANAGEMENT') assert.equal(replayed.result.proposedQuantityAtomic, '300');

    const later = service.reassess(entry.caseId, { ...bundle, cutoff: '2026-01-01T00:30:00.000Z' });
    assert.equal(later.result.proposedQuantityAtomic, '150');
  } finally {
    service.close();
  }
});
