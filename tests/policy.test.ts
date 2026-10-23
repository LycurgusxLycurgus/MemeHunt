import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateEntry, evaluateManagement, evaluatePredicate, resolveStage } from '../src/domain/policy.js';
import { entryGroupFactsSchema, type EntryGroupFacts } from '../src/domain/contracts.js';
import {
  completeFixtureEntryFeatures, FIXTURE_CUTOFF, fixtureEpisode, fixtureFeature,
  fixturePosition, illustrativeUncalibratedProfile,
} from '../examples/fixtures.js';

const predicate = (feature: string, value: string | boolean, unit: string, op: 'eq' | 'gt' = 'eq') => ({ op, feature, value, unit } as const);
const entryGroupIds = ['ADV-01','ADV-02','ADV-03','ADV-04','ADV-05'] as const;
function entryGroups(statuses: Partial<Record<typeof entryGroupIds[number], 'PASS'|'FAIL'|'UNKNOWN'>> = {}): EntryGroupFacts {
  return {
    method: 'mandatory-entry-groups-v1', token: { chain: 'solana', address: 'FIXTURE_TOKEN' }, cutoff: FIXTURE_CUTOFF,
    groups: entryGroupIds.map(checkId => ({
      checkId, status: statuses[checkId] ?? 'PASS', rationale: `${checkId} current-screen rationale`, code: `${checkId}_CURRENT_SCREEN`,
      featureIds: [`${checkId}-feature`], evidenceIds: [`${checkId}-evidence`], availableAt: FIXTURE_CUTOFF,
      metrics: { currentWindowMinutes: 5 }, limitations: ['Prior-day history is unmeasured and not required.'],
    })),
  };
}

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

test('entry group facts are strict, versioned, and require each of the five exact IDs once', () => {
  const facts = entryGroups();
  assert.deepEqual(entryGroupFactsSchema.parse(facts), facts);
  assert.equal(entryGroupFactsSchema.safeParse({ ...facts, method: 'other' }).success, false);
  assert.equal(entryGroupFactsSchema.safeParse({ ...facts, unexpected: true }).success, false);
  assert.equal(entryGroupFactsSchema.safeParse({ ...facts, groups: facts.groups.slice(0, 4) }).success, false);
  assert.equal(entryGroupFactsSchema.safeParse({ ...facts, groups: [facts.groups[0]!, ...facts.groups.slice(1, 4), facts.groups[0]!] }).success, false);
  const group = facts.groups[0]!;
  assert.equal(entryGroupFactsSchema.safeParse({ ...facts, groups: [{ ...group, extra: true }, ...facts.groups.slice(1)] }).success, false);
});

test('new group facts override only their rows and preserve legacy 27-check replay behavior', () => {
  const features = completeFixtureEntryFeatures();
  const legacy = evaluateEntry(features, illustrativeUncalibratedProfile, FIXTURE_CUTOFF);
  assert.equal(legacy.coverage.total, 27);
  assert.equal(legacy.checks.find(row => row.checkId === 'ADV-01')?.required, false);
  assert.equal(legacy.checks.find(row => row.checkId === 'EXE-03')?.role, 'ADVISORY');

  const groups = entryGroups({ 'ADV-01': 'FAIL' });
  const current = evaluateEntry(features, illustrativeUncalibratedProfile, FIXTURE_CUTOFF,
    'LEGACY', undefined, false, undefined, undefined, groups);
  assert.equal(current.coverage.total, 33);
  const first = current.checks.find(row => row.checkId === 'ADV-01')!;
  assert.deepEqual([first.required, first.role, first.status, first.reasonCode], [true, 'OPPORTUNITY', 'FAIL', 'ADV-01_CURRENT_SCREEN']);
  assert.deepEqual(first.featureRefs, ['ADV-01-feature']);
  assert.deepEqual(first.evidenceRefs, ['ADV-01-evidence']);
  assert.equal(current.checks.find(row => row.checkId === 'ADV-02')?.status, 'PASS');
  assert.deepEqual(current.checks.find(row => row.checkId === 'EXE-03') && [
    current.checks.find(row => row.checkId === 'EXE-03')!.required,
    current.checks.find(row => row.checkId === 'EXE-03')!.role,
  ], [true, 'HARD_GATE']);
  assert.equal(current.classification, 'WATCH', 'a failed group opportunity is not reclassified as a hard-gate rejection');
});

test('new manifest makes O12 simulation a hard gate and cutoff-mismatched group facts unresolved', () => {
  const features = completeFixtureEntryFeatures({ O12: false });
  const current = evaluateEntry(features, illustrativeUncalibratedProfile, FIXTURE_CUTOFF,
    'LEGACY', undefined, false, undefined, undefined, entryGroups());
  assert.equal(current.checks.find(row => row.checkId === 'EXE-03')?.status, 'FAIL');
  assert.equal(current.classification, 'REJECTED');

  const staleFacts = { ...entryGroups(), cutoff: '2025-12-31T23:59:59.000Z' } as EntryGroupFacts;
  const invalid = evaluateEntry(completeFixtureEntryFeatures(), illustrativeUncalibratedProfile, FIXTURE_CUTOFF,
    'LEGACY', undefined, false, undefined, undefined, staleFacts);
  const groups = invalid.checks.filter(row => row.checkId.startsWith('ADV-'));
  assert.ok(groups.every(row => row.required && row.status === 'UNKNOWN' && row.reasonCode === 'ENTRY_GROUP_FACTS_INVALID'));
  assert.equal(invalid.classification, 'INSUFFICIENT_DATA');
});

test('a reviewed CAN-01 public PASS does not require unresolved factual A10 binding', () => {
  const features = completeFixtureEntryFeatures({ A09: true });
  const binding = features.find(feature => feature.id === 'A10')!;
  binding.value = null;
  binding.quality = 'MISSING';

  const factualOnly = evaluateEntry(features, illustrativeUncalibratedProfile, FIXTURE_CUTOFF, 'QUALIFIED_V2');
  assert.equal(factualOnly.checks.find(row => row.checkId === 'CAN-01')?.status, 'UNKNOWN',
    'without the separately reviewed entry grade, missing factual binding remains unresolved');

  const reviewedEntry = evaluateEntry(features, illustrativeUncalibratedProfile, FIXTURE_CUTOFF,
    'QUALIFIED_V2', undefined, false, true);
  const can01 = reviewedEntry.checks.find(row => row.checkId === 'CAN-01');
  assert.equal(can01?.status, 'PASS');
  assert.deepEqual(can01?.featureRefs, ['A09'], 'the reviewed entry judgment is scoped to A09');
  assert.equal(binding.value, null, 'the entry-grade override does not fill factual A10');
});

test('new origin review grades NAR-02 from canonical A03 without inventing the optional A04 fact', () => {
  const features = completeFixtureEntryFeatures({ A03: true });
  const catalyst = features.find(feature => feature.id === 'A04')!;
  catalyst.value = null;
  catalyst.quality = 'MISSING';

  const missingReceipt = evaluateEntry(features, illustrativeUncalibratedProfile, FIXTURE_CUTOFF, 'QUALIFIED_V4');
  assert.equal(missingReceipt.checks.find(row => row.checkId === 'NAR-02')?.status, 'UNKNOWN',
    'legacy and old-mode callers still need both static feature rules');

  const reviewedPass = evaluateEntry(features, illustrativeUncalibratedProfile, FIXTURE_CUTOFF,
    'QUALIFIED_V4', undefined, false, undefined, { originTraceability: true });
  const pass = reviewedPass.checks.find(row => row.checkId === 'NAR-02')!;
  assert.equal(pass.status, 'PASS');
  assert.deepEqual(pass.featureRefs, ['A03'], 'the reviewed whole origin/catalyst criterion is scoped to its canonical A03 grade');
  assert.equal(catalyst.value, null, 'the gate does not synthesize the optional catalyst dependency');

  const reviewedFail = evaluateEntry(completeFixtureEntryFeatures({ A03: false }), illustrativeUncalibratedProfile,
    FIXTURE_CUTOFF, 'QUALIFIED_V4', undefined, false, undefined, { originTraceability: false });
  assert.equal(reviewedFail.checks.find(row => row.checkId === 'NAR-02')?.status, 'FAIL');

  const mismatched = evaluateEntry(completeFixtureEntryFeatures({ A03: false }), illustrativeUncalibratedProfile,
    FIXTURE_CUTOFF, 'QUALIFIED_V4', undefined, false, undefined, { originTraceability: true });
  assert.equal(mismatched.checks.find(row => row.checkId === 'NAR-02')?.status, 'UNKNOWN',
    'a gate receipt that disagrees with the known canonical A03 projection cannot decide the row');
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

test('bounded negative entry gates grade only declared attention checks while factual counts stay unknown', () => {
  const features = completeFixtureEntryFeatures();
  for (const id of ['A15', 'A16', 'A17', 'A18', 'S10']) {
    const feature = features.find(item => item.id === id)!;
    feature.value = null;
    feature.quality = 'MISSING';
  }
  const reviewedGap = evaluateEntry(features, illustrativeUncalibratedProfile, FIXTURE_CUTOFF,
    'QUALIFIED_V4', undefined, false, undefined, { sample: false, growth: false });
  assert.equal(reviewedGap.checks.find(row => row.checkId === 'ATT-01')?.status, 'FAIL');
  assert.equal(reviewedGap.checks.find(row => row.checkId === 'ATT-02')?.status, 'UNKNOWN',
    'a negative growth review cannot fail ATT-02 while the community alternative is unknown');
  assert.equal(features.find(item => item.id === 'A16')?.value, null, 'a gate never fills the factual post count');
  assert.equal(features.find(item => item.id === 'A17')?.value, null, 'a gate never fills the factual author count');
  assert.equal(features.find(item => item.id === 'A18')?.value, null, 'a gate never fills measured growth');

  const reviewedGrowthAndKnownFalseCommunity = structuredClone(features);
  const community = reviewedGrowthAndKnownFalseCommunity.find(item => item.id === 'S10')!;
  community.value = false;
  community.quality = 'KNOWN';
  const bothAlternativesFail = evaluateEntry(reviewedGrowthAndKnownFalseCommunity, illustrativeUncalibratedProfile,
    FIXTURE_CUTOFF, 'QUALIFIED_V4', undefined, false, undefined, { sample: false, growth: false });
  assert.equal(bothAlternativesFail.checks.find(row => row.checkId === 'ATT-02')?.status, 'FAIL',
    'the reviewed growth gate plus a separately known-false community alternative makes ATT-02 fail');
  assert.equal(reviewedGrowthAndKnownFalseCommunity.find(item => item.id === 'A18')?.value, null,
    'the entry gate does not invent a measured growth value');

  const positive = evaluateEntry(completeFixtureEntryFeatures(), illustrativeUncalibratedProfile, FIXTURE_CUTOFF,
    'QUALIFIED_V4', undefined, false, undefined, { sample: false, growth: false });
  assert.equal(positive.checks.find(row => row.checkId === 'ATT-01')?.status, 'PASS', 'measured sample support takes precedence');
  assert.equal(positive.checks.find(row => row.checkId === 'ATT-02')?.status, 'PASS', 'measured growth or the community alternative takes precedence');

  const stale = completeFixtureEntryFeatures();
  for (const id of ['A15', 'A16', 'A17', 'A18', 'S10']) {
    const feature = stale.find(item => item.id === id)!;
    feature.value = null;
    feature.quality = 'STALE';
  }
  const staleResult = evaluateEntry(stale, illustrativeUncalibratedProfile, FIXTURE_CUTOFF,
    'QUALIFIED_V4', undefined, false, undefined, { sample: false, growth: false });
  assert.equal(staleResult.checks.find(row => row.checkId === 'ATT-01')?.status, 'UNKNOWN');
  assert.equal(staleResult.checks.find(row => row.checkId === 'ATT-02')?.status, 'UNKNOWN');
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
