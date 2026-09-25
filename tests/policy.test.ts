import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateEntry, evaluateManagement, evaluatePredicate, resolveStage } from '../src/domain/policy.js';
import {
  completeFixtureEntryFeatures, FIXTURE_CUTOFF, fixtureEpisode, fixtureFeature,
  fixturePosition, illustrativeUncalibratedProfile,
} from '../examples/fixtures.js';

const predicate = (feature: string, value: string | boolean, unit: string, op: 'eq' | 'gt' = 'eq') => ({ op, feature, value, unit } as const);

test('typed predicates use three-valued logic, cutoff availability, and decimal comparisons', () => {
  const observed = [
    fixtureFeature('O01', false),
    fixtureFeature('A01', true),
    fixtureFeature('O02', '9007199254740993', { unit: 'count' }),
    fixtureFeature('S01', true, { quality: 'STALE' }),
    fixtureFeature('C01', true, { availableAt: '2026-01-01T00:00:01.000Z' }),
  ];
  assert.equal(evaluatePredicate({ op: 'all', children: [predicate('O01', true, 'bool'), predicate('O03', true, 'bool')] }, observed, FIXTURE_CUTOFF), 'FALSE');
  assert.equal(evaluatePredicate({ op: 'any', children: [predicate('A01', true, 'bool'), predicate('O03', true, 'bool')] }, observed, FIXTURE_CUTOFF), 'TRUE');
  assert.equal(evaluatePredicate(predicate('O02', '9007199254740992', 'count', 'gt'), observed, FIXTURE_CUTOFF), 'TRUE');
  assert.equal(evaluatePredicate(predicate('S01', true, 'bool'), observed, FIXTURE_CUTOFF), 'UNKNOWN');
  assert.equal(evaluatePredicate(predicate('C01', true, 'bool'), observed, FIXTURE_CUTOFF), 'UNKNOWN');
  assert.throws(() => evaluatePredicate(predicate('O01', true, 'count'), observed, FIXTURE_CUTOFF), /PREDICATE_UNIT/);
});

test('entry policy emits the stable 33 rows and fails closed when required evidence is absent', () => {
  const result = evaluateEntry([], illustrativeUncalibratedProfile, FIXTURE_CUTOFF);
  assert.equal(result.checks.length, 33);
  assert.equal(result.classification, 'INSUFFICIENT_DATA');
  assert.equal(result.binary, 'FAIL');
  assert.ok(result.checks.every(row => row.status === 'UNKNOWN'));
});

test('complete evidence cannot fill missing user-owned size, horizon, or risk settings', () => {
  const profile = { id: 'unconfigured-live', risk: {}, stage: { ageBands: [] } };
  const result = evaluateEntry(completeFixtureEntryFeatures(), profile, FIXTURE_CUTOFF);
  assert.equal(result.checks.find(row => row.checkId === 'CTX-01')?.status, 'UNKNOWN');
  assert.equal(result.classification, 'INSUFFICIENT_DATA');
});

test('cap bands use disjoint exact boundaries and missing creation time stays unresolved', () => {
  const profile = illustrativeUncalibratedProfile;
  assert.equal(resolveStage('99999.99', '2025-12-31T23:00:00.000Z', FIXTURE_CUTOFF, profile).capBand, 'MICRO');
  assert.equal(resolveStage('100000', '2025-12-31T23:00:00.000Z', FIXTURE_CUTOFF, profile).capBand, 'SMALL');
  assert.equal(resolveStage('1000000', '2025-12-31T23:00:00.000Z', FIXTURE_CUTOFF, profile).capBand, 'ESTABLISHED');
  assert.equal(resolveStage('10000000', '2025-12-31T23:00:00.000Z', FIXTURE_CUTOFF, profile).capBand, 'LARGE');
  const unknown = resolveStage(null, null, FIXTURE_CUTOFF, profile);
  assert.equal(unknown.capBand, 'UNKNOWN');
  assert.equal(unknown.ageBand, null);
});

test('a known hard-gate failure outranks unrelated missing evidence', () => {
  const result = evaluateEntry([fixtureFeature('O03', false)], illustrativeUncalibratedProfile, FIXTURE_CUTOFF);
  assert.equal(result.checks.find(row => row.checkId === 'SEC-01')?.status, 'FAIL');
  assert.equal(result.classification, 'REJECTED');
});

test('an explicitly unsupported required capability has its own classification', () => {
  const result = evaluateEntry([fixtureFeature('C02', false)], illustrativeUncalibratedProfile, FIXTURE_CUTOFF);
  assert.equal(result.checks.find(row => row.checkId === 'CAP-01')?.reasonCode, 'UNSUPPORTED_CAPABILITY');
  assert.equal(result.classification, 'UNSUPPORTED');
});

test('a failed opportunity row produces WATCH after required checks are known', () => {
  const features = completeFixtureEntryFeatures({ A03: false });
  const result = evaluateEntry(features, illustrativeUncalibratedProfile, FIXTURE_CUTOFF);
  assert.equal(result.checks.find(row => row.checkId === 'NAR-02')?.status, 'FAIL');
  assert.equal(result.checks.find(row => row.checkId === 'NAR-02')?.required, true);
  assert.equal(result.classification, 'WATCH');
});

test('attention sample needs qualified posts and independent authors', () => {
  const features = completeFixtureEntryFeatures({ A17: '2' });
  const result = evaluateEntry(features, illustrativeUncalibratedProfile, FIXTURE_CUTOFF);
  assert.equal(result.checks.find(row => row.checkId === 'ATT-01')?.status, 'UNKNOWN');
});

test('known thesis invalidation outranks missing support evidence', () => {
  const episode = fixtureEpisode(
    predicate('A01', true, 'bool'),
    predicate('O03', true, 'bool'),
  );
  const features = [
    fixtureFeature('O03', true), fixtureFeature('O04', true), fixtureFeature('O05', true), fixtureFeature('O08', true),
    fixtureFeature('O10', true), fixtureFeature('O11', true),
  ];
  const result = evaluateManagement(episode, features, null, [], illustrativeUncalibratedProfile, FIXTURE_CUTOFF);
  assert.equal(result.thesisState, 'INVALIDATED');
  assert.equal(result.proposal, 'EXIT_REVIEW');
  assert.equal(result.checks.find(row => row.checkId === 'MG-07')?.status, 'FAIL');
});

test('unconfigured profit realization cannot become a positive maintain decision', () => {
  const episode = fixtureEpisode(predicate('A01', true, 'bool'), predicate('O01', true, 'bool'));
  const features = completeFixtureEntryFeatures({ O01: false });
  const result = evaluateManagement(episode, features, null, [], illustrativeUncalibratedProfile, FIXTURE_CUTOFF);
  assert.equal(result.thesisState, 'VALIDATED');
  assert.equal(result.checks.find(row => row.checkId === 'MG-12')?.status, 'UNKNOWN');
  assert.equal(result.proposal, 'REASSESS_REQUIRED');
});

test('failed support without an invalidation condition recommends reduction review', () => {
  const episode = fixtureEpisode(predicate('A01', true, 'bool'), predicate('O02', false, 'bool'));
  const features = completeFixtureEntryFeatures({ A01: false });
  const result = evaluateManagement(episode, features, null, [], illustrativeUncalibratedProfile, FIXTURE_CUTOFF);
  assert.equal(result.thesisState, 'WEAKENING');
  assert.equal(result.proposal, 'REDUCE_REVIEW');
});

test('a due realization with qualified traction and a position yields one sized leg proposal', () => {
  const leg = { id: 'leg-1', quantityBps: 4000, allRemaining: false, trigger: predicate('O02', true, 'bool') };
  const episode = fixtureEpisode(predicate('O01', true, 'bool'), predicate('O03', false, 'bool'), [leg]);
  episode.thesis.onchainTraction = predicate('O02', true, 'bool');
  episode.thesis.externalTraction = predicate('A01', true, 'bool');
  const result = evaluateManagement(
    episode,
    completeFixtureEntryFeatures(),
    fixturePosition(),
    [],
    illustrativeUncalibratedProfile,
    FIXTURE_CUTOFF,
  );
  assert.equal(result.thesisState, 'VALIDATED');
  assert.equal(result.proposal, 'DCA_OUT_PROPOSED');
  assert.equal(result.proposedLegId, 'leg-1');
  assert.equal(result.proposedQuantityAtomic, '400');
});

test('missing frozen catalyst and required coherence block a quantified positive proposal', () => {
  const episode = fixtureEpisode(predicate('O01', true, 'bool'), predicate('O03', false, 'bool'), [
    { id: 'leg-1', quantityBps: 4000, allRemaining: false, trigger: predicate('O02', true, 'bool') },
  ]);
  episode.thesis.catalyst = predicate('A30', true, 'bool');
  episode.thesis.onchainTraction = predicate('O02', true, 'bool');
  episode.thesis.externalTraction = predicate('A01', true, 'bool');
  const features = completeFixtureEntryFeatures().filter(f => f.id !== 'A30');
  const result = evaluateManagement(episode, features, fixturePosition(), [], illustrativeUncalibratedProfile, FIXTURE_CUTOFF);
  assert.equal(result.checks.find(c => c.checkId === 'MG-08')?.status, 'UNKNOWN');
  assert.equal(result.checks.find(c => c.checkId === 'MG-04')?.status, 'UNKNOWN');
  assert.equal(result.thesisState, 'UNVERIFIABLE');
  assert.equal(result.proposal, 'REASSESS_REQUIRED');
});

test('direct control requires both bounded fraction inputs with valid units', () => {
  const complete = completeFixtureEntryFeatures();
  const withoutControl = evaluateEntry(complete.filter(f => f.id !== 'O20'), illustrativeUncalibratedProfile, FIXTURE_CUTOFF);
  assert.equal(withoutControl.checks.find(c => c.checkId === 'OWN-02')?.status, 'UNKNOWN');
  assert.equal(withoutControl.classification, 'INSUFFICIENT_DATA');
  const excessive = evaluateEntry(completeFixtureEntryFeatures({ O20: '0.3' }), illustrativeUncalibratedProfile, FIXTURE_CUTOFF);
  assert.equal(excessive.checks.find(c => c.checkId === 'OWN-02')?.status, 'FAIL');
  assert.equal(excessive.classification, 'REJECTED');
  const wrongUnit = evaluateEntry(complete.map(f => f.id === 'O20' ? { ...f, unit: 'bps' } : f), illustrativeUncalibratedProfile, FIXTURE_CUTOFF);
  assert.equal(wrongUnit.checks.find(c => c.checkId === 'OWN-02')?.status, 'UNKNOWN');
  assert.equal(wrongUnit.classification, 'INSUFFICIENT_DATA');
});
