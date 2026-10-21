import assert from 'node:assert/strict';
import test from 'node:test';
import { entryDefinitions } from '../src/domain/catalog.js';
import { evaluateEntry } from '../src/domain/policy.js';
import { attentionEntryGates, deriveShared, sharedWitnesses } from '../src/domain/shared.js';
import { SHARED_CUTOFF, sharedFixture } from './shared-fixtures.js';

function setFeature(input: ReturnType<typeof sharedFixture>, id: string, changes: Record<string, unknown>) {
  const feature = input.features.find(item => item.id === id);
  assert.ok(feature, `fixture has feature ${id}`);
  Object.assign(feature, changes);
}

function witness(input: ReturnType<typeof sharedFixture>, checkId: string) {
  return sharedWitnesses(input.features, input.profile, input.cutoff, input.social).find(item => item.checkId === checkId)!;
}

test('shared witnesses match required non-DAT policy statuses and keep every genuine unknown visible', () => {
  const input = sharedFixture();
  const expected = evaluateEntry(input.features, input.profile, input.cutoff, 'QUALIFIED_V4', input.social).checks
    .filter(check => check.required && !check.checkId.startsWith('DAT-'));
  const actual = sharedWitnesses(input.features, input.profile, input.cutoff, input.social);
  assert.deepEqual(actual.map(item => item.checkId), expected.map(item => item.checkId));
  assert.deepEqual(actual.map(item => item.status), expected.map(item => item.status));
  assert.equal(actual.some(item => item.checkId.startsWith('DAT-')), false, 'DAT rows do not recursively enter their own denominator');
  assert.equal(actual.some(item => entryDefinitions.find(definition => definition.checkId === item.checkId)?.role === 'ADVISORY'), false);

  setFeature(input, 'O01', { quality: 'MISSING', value: null });
  const partial = sharedWitnesses(input.features, input.profile, input.cutoff, input.social);
  assert.equal(partial.find(item => item.checkId === 'ID-01')?.status, 'UNKNOWN');
  assert.ok(partial.find(item => item.checkId === 'ID-01')?.featureIds.includes('O01'));
});

test('AND and numeric checks preserve qualified failures and unresolved alternatives', () => {
  const andFailure = sharedFixture();
  setFeature(andFailure, 'O04', { value: false });
  assert.equal(witness(andFailure, 'SEC-02').status, 'FAIL', 'one adverse required input is sufficient for the AND gate');

  const andUnknown = sharedFixture();
  setFeature(andUnknown, 'O04', { quality: 'MISSING', value: null });
  assert.equal(witness(andUnknown, 'SEC-02').status, 'UNKNOWN', 'an unavailable required peer prevents a complete AND judgment');

  const numericFailure = sharedFixture();
  setFeature(numericFailure, 'O13', { value: '101' });
  assert.equal(witness(numericFailure, 'EXE-02').status, 'FAIL', 'a measured over-limit execution value remains a qualified negative');

  const numericUnknown = sharedFixture();
  setFeature(numericUnknown, 'O16', { quality: 'MISSING', value: null });
  assert.equal(witness(numericUnknown, 'EXE-02').status, 'UNKNOWN', 'missing required cost evidence does not become zero');
});

test('OR witnesses use the exact required truth table for attention or community growth', () => {
  const oneAlternative = sharedFixture();
  setFeature(oneAlternative, 'A18', { value: false });
  assert.equal(witness(oneAlternative, 'ATT-02').status, 'PASS');
  assert.deepEqual(witness(oneAlternative, 'ATT-02').featureIds, ['S10'], 'the sufficient witness names only the passing branch');

  const measuredShortfall = sharedFixture();
  setFeature(measuredShortfall, 'A18', { value: false });
  setFeature(measuredShortfall, 'S10', { value: false });
  assert.equal(witness(measuredShortfall, 'ATT-02').status, 'FAIL');
  assert.deepEqual(new Set(witness(measuredShortfall, 'ATT-02').featureIds), new Set(['A18', 'S10']));

  const oneUnknown = sharedFixture();
  setFeature(oneUnknown, 'A18', { quality: 'MISSING', value: null });
  assert.equal(witness(oneUnknown, 'ATT-02').status, 'PASS');

  const unresolved = sharedFixture();
  setFeature(unresolved, 'A18', { quality: 'MISSING', value: null });
  setFeature(unresolved, 'S10', { quality: 'MISSING', value: null });
  assert.equal(witness(unresolved, 'ATT-02').status, 'UNKNOWN');
});

test('CAN-02 uses the qualified A14 origin route while CAN-01 keeps its distinct representation scope', () => {
  const originRoute = sharedFixture();
  setFeature(originRoute, 'A11', { quality: 'MISSING', value: null });
  assert.equal(witness(originRoute, 'CAN-02').status, 'PASS');
  assert.equal(witness(originRoute, 'CAN-02').route, 'qualified-representation');
  assert.deepEqual(witness(originRoute, 'CAN-02').featureIds, ['A14']);

  const candidateGap = sharedFixture();
  setFeature(candidateGap, 'A09', { quality: 'MISSING', value: null });
  assert.equal(witness(candidateGap, 'CAN-01').status, 'UNKNOWN');
  assert.ok(witness(candidateGap, 'CAN-01').featureIds.includes('A09'));
});

test('qualified social negatives use v4 judgments without requiring legacy scalar proxies', () => {
  const social = sharedFixture();
  for (const id of ['S04', 'S05', 'S06']) setFeature(social, id, { quality: 'MISSING', value: null });
  assert.equal(witness(social, 'SOC-02').status, 'PASS');
  assert.equal(witness(social, 'SOC-02').route, 'qualified-social');
  assert.deepEqual(witness(social, 'SOC-02').featureIds, []);
  assert.deepEqual(witness(social, 'SOC-02').evidenceIds, ['social-evidence']);

  social.social!.integrityReview!.verdict = 'CONTRADICTED';
  assert.equal(witness(social, 'SOC-02').status, 'FAIL', 'a supported adverse judgment is a known negative');
  assert.equal(witness(social, 'SOC-02').route, 'qualified-social');

  const legacy = sharedFixture();
  setFeature(legacy, 'S04', { quality: 'MISSING', value: null });
  const legacyWitnesses = sharedWitnesses(legacy.features, legacy.profile, SHARED_CUTOFF);
  const legacySocial = legacyWitnesses.find(item => item.checkId === 'SOC-02')!;
  assert.equal(legacySocial.status, 'UNKNOWN',
    'without validated v4 social facts, missing scalar coverage stays unresolved');
  assert.ok(legacySocial.featureIds.includes('S04'), 'the legacy scalar denominator still includes its historical proxy');
});

test('fresh terminal post-gap markers grade only negative attention gates and leave factual projections unknown', () => {
  const input = { ...sharedFixture(), qualityMode: 'ENTRY_GATES_V1' as const };
  const gapScope = {
    method: 'terminal-post-gap-v1', complete: true, sourceIds: ['retained-post'],
    gaps: [{ url: 'https://x.com/community/status/904', code: 'HTTP_404' }], blockers: [],
  };
  for (const [id, entryCriterion] of [['A15', 'ATT-01'], ['A18', 'ATT-02']] as const) {
    const row = input.baseline.find(item => item.id === id)!;
    row.data = { method: 'entry-evidence-gate-v1', entryCriterion, verdict: 'FAIL', postSampleScope: gapScope };
  }
  for (const id of ['A15', 'A16', 'A17', 'A18', 'S10']) setFeature(input, id, { value: null, quality: 'MISSING' });
  setFeature(input, 'S10', { value: false, quality: 'KNOWN' });

  assert.deepEqual(attentionEntryGates(input.baseline), { sample: false, growth: false });
  const reviewed = deriveShared(input);
  assert.equal(reviewed.facts.witnesses.find(item => item.checkId === 'ATT-01')?.status, 'FAIL');
  assert.equal(reviewed.facts.witnesses.find(item => item.checkId === 'ATT-02')?.status, 'FAIL');
  assert.equal(input.features.find(item => item.id === 'A16')?.value, null, 'post count remains unknown');
  assert.equal(input.features.find(item => item.id === 'A17')?.value, null, 'author count remains unknown');
  assert.equal(input.features.find(item => item.id === 'A18')?.value, null, 'growth remains unknown');

  const communityAlternative = { ...sharedFixture(), qualityMode: 'ENTRY_GATES_V1' as const };
  communityAlternative.baseline.find(item => item.id === 'A18')!.data = {
    method: 'entry-evidence-gate-v1', entryCriterion: 'ATT-02', verdict: 'FAIL', postSampleScope: gapScope,
  };
  setFeature(communityAlternative, 'A18', { value: null, quality: 'MISSING' });
  setFeature(communityAlternative, 'S10', { value: true, quality: 'KNOWN' });
  assert.equal(deriveShared(communityAlternative).facts.witnesses.find(item => item.checkId === 'ATT-02')?.status, 'PASS',
    'qualified community growth remains an independent passing route');

  const measuredGrowth = { ...sharedFixture(), qualityMode: 'ENTRY_GATES_V1' as const };
  measuredGrowth.baseline.find(item => item.id === 'A18')!.data = {
    method: 'entry-evidence-gate-v1', entryCriterion: 'ATT-02', verdict: 'FAIL', postSampleScope: gapScope,
  };
  setFeature(measuredGrowth, 'A18', { value: true, quality: 'KNOWN' });
  setFeature(measuredGrowth, 'S10', { value: false, quality: 'KNOWN' });
  assert.equal(deriveShared(measuredGrowth).facts.witnesses.find(item => item.checkId === 'ATT-02')?.status, 'PASS',
    'a measured positive growth result takes precedence over a negative-only marker');

  const noCarrier = sharedFixture();
  assert.equal(attentionEntryGates(noCarrier.baseline), undefined);
  const staleCarrier = sharedFixture();
  const staleRow = staleCarrier.baseline.find(item => item.id === 'A15')!;
  staleRow.quality = 'STALE';
  staleRow.data = { method: 'entry-evidence-gate-v1', entryCriterion: 'ATT-01', verdict: 'FAIL', postSampleScope: gapScope };
  staleCarrier.baseline.find(item => item.id === 'A18')!.data = {
    method: 'entry-evidence-gate-v1', entryCriterion: 'ATT-02', verdict: 'FAIL', postSampleScope: gapScope,
  };
  assert.deepEqual(attentionEntryGates(staleCarrier.baseline), { growth: false }, 'stale markers cannot supply a gate');
});
