import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveShared, expireSharedWitnesses, sharedAuditSchema, sharedClaimSchema, sharedClaims } from '../src/domain/shared.js';
import { SHARED_CUTOFF, SHARED_TOKEN, requalifyAudit, sharedFixture } from './shared-fixtures.js';

const assessment = (rows: ReturnType<typeof deriveShared>['assessments'], id: string) => rows.find(row => row.id === id)!;

test('shared claims preserve qualified narrative, exact-contract candidate, origin, and social judgments', () => {
  const input = sharedFixture();
  const claims = sharedClaims(input.baseline, input.social);
  assert.deepEqual(claims.map(claim => claim.id), [
    'A01', 'A02', 'A03', 'A04', 'A05', 'A09:0', 'A14:origin', 'SOC-01', 'SOC-02',
  ]);
  for (const claim of claims) assert.deepEqual(sharedClaimSchema.parse(claim), claim);
  assert.equal(claims.find(claim => claim.id === 'A09:0')?.citations[0]?.quote, input.sources[0]?.text.split('\n')[5]);
  assert.equal(claims.find(claim => claim.id === 'A14:origin')?.citations[0]?.quote, input.sources[0]?.text.split('\n')[6]);
  assert.deepEqual(sharedClaims(input.baseline, { ...input.social!, identityReview: { ...input.social!.identityReview!, verdict: 'UNRESOLVED' } })
    .map(claim => claim.id).includes('SOC-01'), false, 'unresolved social judgments do not become claims');
});

test('complete source-qualified decision coverage produces four known shared results', () => {
  const input = sharedFixture();
  const result = deriveShared(input);
  assert.deepEqual(result.facts.unresolved, []);
  assert.equal(result.facts.semanticQualified, true);
  assert.equal(result.facts.auditQualified, true);
  assert.deepEqual(result.facts.values, { C03: true, C04: true, C05: true, C06: true });
  assert.deepEqual(result.assessments.map(row => row.id), ['C03', 'C04', 'C05', 'C06']);
  for (const row of result.assessments) {
    assert.equal(row.quality, 'KNOWN', row.id);
    assert.equal(row.projection?.value, true, row.id);
    assert.equal(row.projection?.quality, row.quality, row.id);
  }
  assert.deepEqual(sharedAuditSchema.parse(input.audit), input.audit);
});

test('shared completeness preserves a qualified failure but leaves failed required acquisition unknown', () => {
  const measuredFailure = sharedFixture();
  measuredFailure.features = measuredFailure.features.map(feature => ['A18', 'S10'].includes(feature.id)
    ? { ...feature, value: false } : feature);
  const deficient = deriveShared(measuredFailure);
  assert.equal(deficient.facts.witnesses.find(item => item.checkId === 'ATT-02')?.status, 'FAIL');
  assert.deepEqual(deficient.facts.values, { C03: true, C04: true, C05: true, C06: true },
    'a fully inspected negative can be known; it does not turn into a missing-data result');

  const unavailable = sharedFixture();
  unavailable.features = unavailable.features.map(feature => feature.id === 'O01'
    ? { ...feature, value: null, quality: 'MISSING' as const } : feature);
  const partial = deriveShared(unavailable);
  assert.ok(partial.facts.unresolved.includes('ID-01'));
  assert.equal(partial.facts.values.C03, null);
  assert.equal(partial.facts.values.C04, null);
});

test('semantic qualification requires exact regenerated claims, literal sources, and both normalized receipts', () => {
  const missingReceipt = sharedFixture();
  missingReceipt.semanticReceiptIds = ['attention-qualified-receipt'];
  assert.equal(deriveShared(missingReceipt).facts.values.C05, null);

  const forgedClaim = sharedFixture();
  forgedClaim.claims[0]!.statement += ' altered';
  assert.equal(deriveShared(forgedClaim).facts.values.C05, null);

  const absentQuote = sharedFixture();
  absentQuote.claims[0]!.citations[0]!.quote = 'A fabricated assertion absent from retained sources.';
  assert.equal(deriveShared(absentQuote).facts.values.C05, null);

  const hostedReceipt = sharedFixture();
  hostedReceipt.evidence.find(item => item.id === 'social-qualified-receipt')!.accessMode = 'FREE_ACCOUNT';
  assert.equal(deriveShared(hostedReceipt).facts.values.C05, null,
    'provider responses alone do not impersonate code-normalized local qualification receipts');
});

test('conflict audit is unknown when incomplete, passes complete clear coverage, and records qualified contradictions', () => {
  const absentAudit = sharedFixture();
  absentAudit.audit = null;
  const missing = deriveShared(absentAudit);
  assert.equal(missing.facts.values.C06, null);
  assert.equal(assessment(missing.assessments, 'C06').quality, 'MISSING');

  const unclear = sharedFixture();
  unclear.audit = requalifyAudit(unclear, 'UNCLEAR');
  assert.equal(deriveShared(unclear).facts.values.C06, null);

  const conflict = sharedFixture();
  conflict.audit = requalifyAudit(conflict, 'CONFLICT');
  const disputed = deriveShared(conflict);
  assert.equal(disputed.facts.values.C06, false, JSON.stringify(disputed.facts));
  assert.equal(assessment(disputed.assessments, 'C06').quality, 'KNOWN');
  assert.equal(disputed.facts.conflicts.some(item => item.field === conflict.claims[0]?.id), true);

  const incompleteSource = sharedFixture();
  incompleteSource.audit!.sources[0]!.complete = false;
  assert.equal(deriveShared(incompleteSource).facts.values.C06, null);
});

test('observed conflicts compare the same token, field, unit, and instant with numeric normalization', () => {
  const equivalent = sharedFixture();
  equivalent.observations = [
    { id: 'obs-1', subject: SHARED_TOKEN, field: 'supply', value: '100.0', unit: 'token', evidenceIds: ['feature-evidence-O01'], observedAt: SHARED_CUTOFF, availableAt: SHARED_CUTOFF, quality: 'KNOWN' },
    { id: 'obs-2', subject: SHARED_TOKEN, field: 'supply', value: '100.00', unit: 'token', evidenceIds: ['feature-evidence-O02'], observedAt: SHARED_CUTOFF, availableAt: SHARED_CUTOFF, quality: 'KNOWN' },
    { id: 'obs-3', subject: SHARED_TOKEN, field: 'supply', value: '101', unit: 'token', evidenceIds: ['feature-evidence-O03'], observedAt: '2026-10-01T11:59:59.999Z', availableAt: SHARED_CUTOFF, quality: 'KNOWN' },
  ];
  assert.equal(deriveShared(equivalent).facts.conflicts.length, 0);

  equivalent.observations.push({
    id: 'obs-4', subject: SHARED_TOKEN, field: 'supply', value: '99', unit: 'token',
    evidenceIds: ['feature-evidence-O04'], observedAt: SHARED_CUTOFF, availableAt: SHARED_CUTOFF, quality: 'KNOWN',
  });
  const conflict = deriveShared(equivalent).facts.conflicts;
  assert.equal(conflict.length, 1);
  assert.match(conflict[0]!.field, /supply/);
  assert.deepEqual(conflict[0]!.evidenceIds, ['feature-evidence-O01', 'feature-evidence-O02', 'feature-evidence-O04']);
});

test('an audited A09 inadequacy claim is source-bound and yields a CAN-01 failure without A10', () => {
  const input = sharedFixture();
  const descriptor = 'The indexed River Lantern descriptor identifies a neighborhood-art project token.';
  const currentProfile = 'The current account now publishes OUSD reserve backing and stablecoin lending updates; its fetched publications do not reflect the indexed River Lantern project.';
  input.sources.push(
    { id: 'indexed-lead-metadata', url: 'https://x.com/river_lantern', text: `River Lantern neighborhood art project\n${descriptor}`, publishedAt: null, authorId: null, availableAt: SHARED_CUTOFF, kind: 'INDEXED_METADATA' },
    { id: 'current-profile', url: 'https://x.com/river_lantern', text: currentProfile, publishedAt: null, authorId: null, availableAt: SHARED_CUTOFF, kind: 'PAGE' },
  );
  const citations = [
    { sourceId: 'indexed-lead-metadata', quote: descriptor },
    { sourceId: 'current-profile', quote: 'The current account now publishes OUSD reserve backing and stablecoin lending updates' },
  ];
  const representation = input.baseline.find(item => item.id === 'A09')!;
  representation.quality = 'KNOWN';
  representation.data = {
    method: 'public-representation-screen-v1',
    evidenceAdequacy: { rationale: 'The bounded public evidence does not connect this indexed project descriptor to the current fetched account subject.', citations },
  };
  representation.projection = { ...representation.projection!, value: false, quality: 'KNOWN' };
  const binding = input.baseline.find(item => item.id === 'A10')!;
  binding.quality = 'MISSING';
  binding.projection = { ...binding.projection!, value: null, quality: 'MISSING' };
  const representationFeature = input.features.find(item => item.id === 'A09')!;
  representationFeature.value = false;
  representationFeature.quality = 'KNOWN';
  const bindingFeature = input.features.find(item => item.id === 'A10')!;
  bindingFeature.value = null;
  bindingFeature.quality = 'MISSING';
  input.claims = sharedClaims(input.baseline, input.social);
  input.audit = requalifyAudit(input);

  const adequacy = input.claims.find(claim => claim.id === 'A09:adequacy');
  assert.ok(adequacy);
  assert.deepEqual(adequacy.citations.map(citation => citation.sourceId), ['indexed-lead-metadata', 'current-profile']);
  assert.equal(input.claims.some(claim => /^A09:\d+$/.test(claim.id)), false,
    'the known negative is represented as an adequacy judgment, not an asserted competitor');
  const derived = deriveShared(input);
  const can01 = derived.facts.witnesses.find(witness => witness.checkId === 'CAN-01');
  assert.equal(can01?.status, 'FAIL');
  assert.deepEqual(can01?.featureIds, ['A09'], 'the independent negative is sufficient without A10');
  assert.equal(derived.facts.semanticQualified, true);
  assert.equal(derived.facts.auditQualified, true);
  assert.equal(derived.facts.values.C05, true);
  assert.equal(derived.facts.values.C06, true);
});

test('freshness keeps 30, 300, and 900 second witnesses inclusive and expires selected evidence one millisecond later', () => {
  const targets = [
    { featureId: 'O13', ttl: 30_000 },
    { featureId: 'O01', ttl: 300_000 },
    { featureId: 'A01', ttl: 900_000 },
  ];
  for (const target of targets) {
    for (const excess of [0, 1]) {
      const input = sharedFixture();
      const at = new Date(Date.parse(SHARED_CUTOFF) - target.ttl - excess).toISOString();
      const feature = input.features.find(item => item.id === target.featureId)!;
      feature.availableAt = at;
      const evidenceId = feature.evidenceIds[0]!;
      const evidence = input.evidence.find(item => item.id === evidenceId)!;
      evidence.availableAt = at;
      evidence.retrievedAt = at;
      const result = deriveShared(input);
      const record = result.facts.freshness.find(item => item.featureId === target.featureId);
      assert.ok(record, `${target.featureId} is a sufficient policy witness`);
      assert.equal(record.ttlSeconds * 1000, target.ttl);
      assert.equal(record.fresh, excess === 0, `${target.featureId} at +${excess}ms`);
      if (excess === 1) {
        const expired = expireSharedWitnesses(input);
        assert.equal(expired.features.find(item => item.id === target.featureId)?.quality, 'STALE');
        const assessmentRow = expired.baseline.find(item => item.id === target.featureId)!;
        assert.equal(assessmentRow.quality, 'STALE');
        assert.equal(assessmentRow.projection?.quality, 'STALE');
        assert.ok(assessmentRow.causes.some(cause => cause.code === 'FEATURE_TTL_EXCEEDED'));
      }
    }
  }
});

test('an expired event cannot be laundered by a fresh retrieval, and unused alternatives remain unchanged', () => {
  const input = sharedFixture();
  const target = input.features.find(feature => feature.id === 'A01')!;
  target.availableAt = '2026-10-01T11:40:00.000Z';
  const referenced = input.evidence.find(item => item.id === target.evidenceIds[0])!;
  referenced.retrievedAt = SHARED_CUTOFF;
  referenced.availableAt = SHARED_CUTOFF;
  const result = deriveShared(input);
  assert.equal(result.facts.freshness.find(item => item.featureId === 'A01')?.fresh, false,
    'the source/event time remains part of the freshness witness');
  const expired = expireSharedWitnesses(input);
  assert.equal(expired.features.find(feature => feature.id === 'A01')?.quality, 'STALE');
  assert.equal(expired.features.find(feature => feature.id === 'S10')?.quality, input.features.find(feature => feature.id === 'S10')?.quality,
    'unused policy alternatives keep their original state');
});
