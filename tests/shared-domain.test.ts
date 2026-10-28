import assert from 'node:assert/strict';
import test from 'node:test';
import { attentionEntryGates, deriveShared, expireSharedWitnesses, sharedAuditSchema, sharedClaimSchema, sharedClaims, sharedWitnesses } from '../src/domain/shared.js';
import { SHARED_CUTOFF, SHARED_TOKEN, requalifyAudit, sharedFixture } from './shared-fixtures.js';
import { attentionBoundsFixture } from './attention-bounds-fixtures.js';

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
  const socialStatement = claims.find(claim => claim.id === 'SOC-01')?.statement;
  assert.ok(socialStatement?.includes(`${input.social!.start} inclusive to ${input.social!.end} exclusive`));
  assert.match(socialStatement!, /retrieval time does not make an older post current/);
  assert.deepEqual(sharedClaims(input.baseline, { ...input.social!, identityReview: { ...input.social!.identityReview!, verdict: 'UNRESOLVED' } })
    .map(claim => claim.id).includes('SOC-01'), false, 'unresolved social judgments do not become claims');
});

test('fresh origin resolution selects a separate Shared entry claim and NAR-02 witness without factual A04', () => {
  const input = sharedFixture();
  const originRow = input.baseline.find(row => row.id === 'A03')!;
  const a04 = input.baseline.find(row => row.id === 'A04')!;
  const a04Feature = input.features.find(feature => feature.id === 'A04')!;
  const source = input.sources[0]!;
  const citation = { sourceId: source.id, quote: source.text.split('\n')[6]! };
  const evidenceId = originRow.evidenceIds[0]!;
  const originalFactual = originRow.data as { summary?: string; citations?: Array<{ sourceId: string; quote: string }> };
  originRow.data = {
    ...originalFactual,
    semanticJudgmentMethod: 'evidence-constitution-v1',
    entryCriterionDecision: {
      method: 'evidence-constitution-v1', criterion: 'NAR-02',
      decision: { verdict: 'PASS', rationale: 'The independently reviewed original supports the bounded observed-origin criterion.', citations: [citation] },
      availableAt: SHARED_CUTOFF, start: '2026-10-01T11:00:00.000Z', end: SHARED_CUTOFF,
      evidenceIds: [evidenceId],
    },
  };
  a04.quality = 'MISSING';
  a04.projection = { ...a04.projection!, value: null, quality: 'MISSING' };
  a04Feature.value = null;
  a04Feature.quality = 'MISSING';
  a04Feature.applicability = 'UNRESOLVED';

  const gates = attentionEntryGates(input.baseline, true)!;
  assert.equal(gates.originResolution?.outcome, 'SUPPORTED');
  const witness = sharedWitnesses(input.features, input.profile, input.cutoff, undefined, undefined, gates,
    undefined, input.baseline).find(row => row.checkId === 'NAR-02')!;
  assert.equal(witness.status, 'PASS');
  assert.deepEqual(witness.featureIds, ['A03']);
  assert.deepEqual(witness.evidenceIds, [evidenceId]);

  const claims = sharedClaims(input.baseline, input.social, 'source-support-and-conflict-v2');
  const selected = claims.find(claim => claim.id === 'A03:entry')!;
  assert.match(selected.statement, /^SUPPORTED:/);
  assert.deepEqual(selected.citations, [citation]);
  assert.notDeepEqual(selected.citations, originalFactual.citations,
    'the selected entry claim keeps its own final citation instead of borrowing the broader factual A03 summary');
  assert.ok(claims.some(claim => claim.id === 'A03'), 'the independently qualified factual A03 summary remains a separate Shared claim');
  assert.equal(claims.some(claim => claim.id === 'A04'), false, 'missing factual A04 is not needed for the origin criterion claim');
});

test('Shared claims retain the fresh criterion value, verdict basis, proof and original public decision', () => {
  const input = sharedFixture();
  const a05 = input.baseline.find(row => row.id === 'A05')!;
  const source = input.sources[0]!;
  const citation = { sourceId: source.id, quote: source.text.split('\n')[6]! };
  const decision = {
    verdict: 'FAIL' as const, negativeBasis: 'PUBLIC_SUPPORT_INADEQUATE' as const,
    rationale: 'The complete independent review lacks a required explanation premise.', citations: [citation],
    criterionProof: { kind: 'PUBLIC_SUPPORT_INADEQUATE' as const, criterion: 'NAR-03' as const,
      gap: 'The retained complete review lacks a grounded prerequisite assessment.' },
  };
  a05.quality = 'KNOWN';
  a05.projection = { ...a05.projection!, value: true, quality: 'KNOWN' };
  a05.data = {
    semanticPremiseMethod: 'criterion-premises-v1',
    summary: 'The factual thesis remains independently qualified.', citations: [citation],
    entryDecisionMethod: 'binary-public-support-v5', decision,
    entryCriterionDecision: { decision },
  };

  const claim = sharedClaims([a05]).find(item => item.id === 'A05')!;
  assert.deepEqual(claim.criterionContext, {
    method: 'criterion-premises-v1', criterion: 'NAR-03', value: true,
    publicDecision: decision, verdict: 'FAIL', negativeBasis: 'PUBLIC_SUPPORT_INADEQUATE', proof: decision.criterionProof,
  });
  assert.deepEqual(sharedClaimSchema.parse(claim), claim,
    'the typed Shared wire keeps the original criterion decision and factual value together without regrading either');
});

test('shared audit keeps public-support entry grade separate from factual origin', () => {
  const input = sharedFixture();
  const row = input.baseline.find(item => item.id === 'A14')!;
  const source = input.sources[0]!;
  const originQuote = source.text.split('\n')[6]!;
  row.data = {
    originRelationship: { status: 'UNKNOWN', rationale: 'No factual origin relationship is established.', citations: [] },
    measuredAttention: { status: 'UNKNOWN', shares: [] },
    leadershipScreening: {
      method: 'reviewed-public-support-v1', rationale: 'The bounded public evidence does not support the entry grade.',
      citations: [{ sourceId: source.id, quote: originQuote }],
    },
  };

  const claims = sharedClaims(input.baseline, input.social);
  assert.deepEqual(claims.filter(claim => claim.id.startsWith('A14:')).map(claim => claim.id), ['A14:adequacy']);
  assert.match(claims.find(claim => claim.id === 'A14:adequacy')!.statement, /does not establish factual non-origin/);

  row.data = {
    originRelationship: { status: 'SUPPORTED', rationale: 'A separate dated primary source supports origin.', citations: [{ sourceId: source.id, quote: originQuote }] },
    measuredAttention: { status: 'UNKNOWN', shares: [] },
  };
  const separate = sharedClaims(input.baseline, input.social).filter(claim => claim.id.startsWith('A14:'));
  assert.deepEqual(separate.map(claim => claim.id), ['A14:origin']);
  assert.match(separate.find(claim => claim.id === 'A14:origin')!.statement, /^SUPPORTED:/);
  assert.equal(separate.some(claim => claim.id === 'A14:adequacy'), false, 'a supported factual route must not produce a contrary entry-grade claim');
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

test('ENTRY_GATES_V1 returns known quality failures without inventing factual conflicts', () => {
  const complete = { ...sharedFixture(), qualityMode: 'ENTRY_GATES_V1' as const };
  const passed = deriveShared(complete);
  assert.deepEqual(passed.facts.values, { C03: true, C04: true, C05: true, C06: true });
  assert.equal(passed.facts.qualityMode, 'ENTRY_GATES_V1');

  const missingAudit = { ...sharedFixture(), qualityMode: 'ENTRY_GATES_V1' as const, audit: null };
  const unaudited = deriveShared(missingAudit);
  assert.equal(unaudited.facts.values.C06, false);
  assert.equal(assessment(unaudited.assessments, 'C06').quality, 'KNOWN');
  assert.equal((assessment(unaudited.assessments, 'C06').data as { conflictAssessment?: string }).conflictAssessment, 'INCOMPLETE_REVIEW');
  assert.deepEqual(unaudited.facts.conflicts, [], 'a missing audit fails the quality gate but does not claim a contradiction');

  const unqualified = { ...sharedFixture(), qualityMode: 'ENTRY_GATES_V1' as const };
  unqualified.claims[0]!.statement += ' altered';
  const unqualifiedResult = deriveShared(unqualified);
  assert.equal(unqualifiedResult.facts.values.C05, false);
  assert.equal(assessment(unqualifiedResult.assessments, 'C05').quality, 'KNOWN');
  assert.equal(unqualifiedResult.facts.conflicts.some(item => item.field === unqualified.claims[0]!.id), false);

  const actualConflict = { ...sharedFixture(), qualityMode: 'ENTRY_GATES_V1' as const };
  actualConflict.audit = requalifyAudit(actualConflict, 'CONFLICT');
  const conflicted = deriveShared(actualConflict);
  assert.equal(conflicted.facts.values.C06, false);
  assert.equal((assessment(conflicted.assessments, 'C06').data as { conflictAssessment?: string }).conflictAssessment, 'COMPLETED');
  assert.ok(conflicted.facts.conflicts.length > 0, 'only a completed audit contributes a factual conflict');
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

  const oneSidedConflict = sharedFixture();
  oneSidedConflict.audit = requalifyAudit(oneSidedConflict, 'CONFLICT');
  oneSidedConflict.audit!.claims[0]!.citations = oneSidedConflict.audit!.claims[0]!.citations.slice(0, 1);
  const oneSided = deriveShared(oneSidedConflict);
  assert.equal(oneSided.facts.values.C06, null, 'a single citation cannot establish both sides of a contradiction');
  assert.equal(oneSided.facts.auditQualified, false);
  assert.equal(oneSided.facts.conflicts.some(item => item.field === oneSidedConflict.claims[0]?.id), false);

  const duplicatedSideConflict = sharedFixture();
  duplicatedSideConflict.audit = requalifyAudit(duplicatedSideConflict, 'CONFLICT');
  const firstSide = duplicatedSideConflict.audit!.claims[0]!.citations[0]!;
  duplicatedSideConflict.audit!.claims[0]!.citations = [firstSide, { ...firstSide }];
  const duplicatedSide = deriveShared(duplicatedSideConflict);
  assert.equal(duplicatedSide.facts.values.C06, null, 'repeating the same source and quote does not create a second side');
  assert.equal(duplicatedSide.facts.auditQualified, false);

  const incompleteSource = sharedFixture();
  incompleteSource.audit!.sources[0]!.complete = false;
  assert.equal(deriveShared(incompleteSource).facts.values.C06, null);
});

test('fresh Shared audit separates completed unclear support from incomplete audit and factual conflict', () => {
  const fresh = sharedFixture();
  fresh.qualityMode = 'ENTRY_GATES_V1';
  fresh.completionMethod = 'reviewed-audit-completion-v1';
  const attention = attentionBoundsFixture({ posts: { lower: 2, upper: 4 }, accounts: { lower: 2, upper: 4 } });
  fresh.baseline = fresh.baseline.map(row => attention.find(item => item.id === row.id && ['A15', 'A16', 'A17', 'A18'].includes(item.id)) ?? row);
  fresh.features = fresh.features.map(feature => {
    const replacement = attention.find(row => row.id === feature.id && ['A15', 'A16', 'A17', 'A18'].includes(row.id));
    return replacement ? { ...feature, value: null, quality: 'MISSING' as const,
      availableAt: replacement.projection!.availableAt, evidenceIds: replacement.evidenceIds } : feature;
  });
  const posts = attention.find(row => row.id === 'A15')!.evidenceIds;
  const addedSources = posts.map((id, index) => ({
    id, url: `https://x.com/writer${index + 1}/status/${index + 1}`,
    text: `Retained exact token post ${index + 1}.`, publishedAt: null,
    authorId: `x.com:writer${index + 1}`, availableAt: fresh.cutoff, kind: 'POST' as const,
  }));
  fresh.sources.push(...addedSources);
  fresh.evidence.push(...posts.map(id => ({
    id, sourceId: 'attention-test-post', sourceType: 'WEB_PAGE', retrievedAt: fresh.cutoff,
    availableAt: fresh.cutoff, contentHash: 'e'.repeat(64), adapterVersion: 'shared-test-v1',
    accessMode: 'FREE_ACCOUNT' as const, scope: { fixture: true },
  })));
  const resetAudit = (disposition: 'CLEAR' | 'CONFLICT' | 'UNCLEAR' = 'CLEAR') => {
    fresh.claims = sharedClaims(fresh.baseline, fresh.social);
    const unclearClaim = fresh.claims.find(claim => claim.id.startsWith('attention-bounds:'));
    fresh.audit = {
      claims: fresh.claims.map(claim => ({
        id: claim.id, disposition: claim === unclearClaim ? disposition : 'CLEAR',
        rationale: 'The complete synthetic retained corpus was inspected for this claim.',
        citations: disposition === 'CONFLICT' && claim === unclearClaim && fresh.sources.length > 1
          ? [claim.citations[0]!, { sourceId: fresh.sources[1]!.id, quote: fresh.sources[1]!.text.split('\n')[0]! }]
          : claim.citations,
      })),
      review: fresh.claims.map(claim => ({ id: claim.id, accepted: true })),
      sources: fresh.sources.map(source => ({ id: source.id, complete: true })),
    };
    return unclearClaim;
  };

  const unclearClaim = resetAudit('UNCLEAR');
  assert.ok(unclearClaim?.id.startsWith('attention-bounds:'), 'the current marked route sends its selected interval claim to Shared');
  const completedUnclear = deriveShared(fresh);
  assert.equal(completedUnclear.facts.semanticQualified, true);
  assert.equal(completedUnclear.facts.auditCompleted, true,
    'all claims, accepted decisions and all retained source inspections establish operational completion');
  assert.equal(completedUnclear.facts.auditQualified, false,
    'an accepted UNCLEAR disposition does not become a clear audit');
  assert.equal(completedUnclear.facts.values.C06, false, 'the data-quality gate records completed but inadequate audit coverage');
  assert.deepEqual(completedUnclear.facts.conflicts, [], 'unclear evidence does not invent a factual contradiction');
  assert.equal((assessment(completedUnclear.assessments, 'C06').data as { conflictAssessment?: string }).conflictAssessment,
    'COMPLETED_INSUFFICIENT');
  const legacyUnclear = structuredClone(fresh);

  const unfinishedCases = [
    ['missing audit', (input: typeof fresh) => { input.audit = null; }],
    ['rejected review', (input: typeof fresh) => { input.audit!.review[0]!.accepted = false; }],
    ['uninspected source', (input: typeof fresh) => { input.audit!.sources[0]!.complete = false; }],
    ['malformed pair', (input: typeof fresh) => { input.audit = 'malformed' as never; }],
  ] as const;
  for (const [name, mutate] of unfinishedCases) {
    const candidate = structuredClone(fresh);
    mutate(candidate);
    const result = deriveShared(candidate);
    assert.equal(result.facts.auditCompleted, false, `${name}: unfinished work is not operational completion`);
    assert.equal(result.facts.auditQualified, false, `${name}: unfinished work does not qualify the audit`);
    assert.equal(result.facts.values.C06, false, `${name}: the configured quality gate records its failed audit requirement`);
    assert.deepEqual(result.facts.conflicts, [], `${name}: no actual two-sided contradiction exists`);
  }

  const conflicted = structuredClone(fresh);
  resetAudit('CONFLICT');
  conflicted.audit = structuredClone(fresh.audit);
  const conflictResult = deriveShared(conflicted);
  assert.equal(conflictResult.facts.auditCompleted, true, 'an accepted, fully inspected conflict is still a completed audit');
  assert.equal(conflictResult.facts.auditQualified, true);
  assert.equal(conflictResult.facts.values.C06, false);
  assert.ok(conflictResult.facts.conflicts.some(conflict => conflict.field.startsWith('attention-bounds:')),
    'only the independently accepted two-sided conflict becomes a factual audit conflict');

  const legacy = legacyUnclear;
  delete legacy.completionMethod;
  const legacyFacts = deriveShared(legacy).facts;
  assert.equal(legacyFacts.auditCompleted, undefined, 'marker-absent facts retain the historical wire shape');
  assert.equal(legacyFacts.auditQualified, false, 'legacy UNCLEAR behavior remains unqualified');
});

test('v4 Shared completion uses independently authored final dispositions while retaining rejected draft bits', () => {
  const fresh = sharedFixture();
  fresh.qualityMode = 'ENTRY_GATES_V1';
  fresh.completionMethod = 'reviewed-audit-completion-v1';
  fresh.sourceInspectionMethod = 'acquired-text-inspection-v1';
  fresh.decisionMethod = 'independent-final-dispositions-v1';
  const unclear = fresh.claims[0]!;
  fresh.audit = {
    decisionMethod: fresh.decisionMethod,
    claims: fresh.claims.map(claim => ({
      id: claim.id,
      disposition: claim.id === unclear.id ? 'UNCLEAR' : 'CLEAR',
      rationale: claim.id === unclear.id
        ? 'The fully inspected retained sources do not resolve this claim.'
        : 'The fully inspected retained sources show no incompatible assertion.',
      citations: claim.citations,
    })),
    review: fresh.claims.map(claim => ({ id: claim.id, accepted: false })),
    sources: fresh.sources.map(source => ({ id: source.id, complete: true })),
  };

  const result = deriveShared(fresh);
  assert.equal(result.facts.auditCompleted, true, 'the marked route requires final judgments and complete source inspection, not accepted draft bits');
  assert.equal(result.facts.auditQualified, false);
  assert.equal(result.facts.values.C06, false);
  assert.deepEqual(result.facts.conflicts, [], 'final UNCLEAR is not upgraded into an opposite factual claim');
  assert.equal(assessment(result.assessments, 'C06').data &&
    (assessment(result.assessments, 'C06').data as { conflictAssessment?: string }).conflictAssessment,
  'COMPLETED_INSUFFICIENT');

  const unfinished = structuredClone(fresh);
  unfinished.audit!.sources[0]!.complete = false;
  assert.equal(deriveShared(unfinished).facts.auditCompleted, false,
    'independent final decisions do not substitute for inspection of every retained source');

  const missingMarker = structuredClone(fresh);
  delete missingMarker.audit!.decisionMethod;
  assert.throws(() => deriveShared(missingMarker), /SHARED_DECISION_METHOD_INVALID/,
    'a v4 packet cannot be reinterpreted as a legacy accepted-draft audit');
  const missingInspection = structuredClone(fresh);
  delete missingInspection.sourceInspectionMethod;
  assert.throws(() => deriveShared(missingInspection), /SHARED_DECISION_METHOD_INVALID/,
    'final dispositions require the fresh complete-source inspection contract');
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
  equivalent.audit = null;
  const disputed = deriveShared(equivalent);
  assert.equal(disputed.facts.auditQualified, false, 'the independent semantic audit is still incomplete');
  assert.equal(disputed.facts.values.C06, null, 'an unfinished audit does not resolve the separate quality gate');
  assert.equal(disputed.facts.conflicts.length, 1, 'the qualified same-subject/time observation conflict remains factual evidence');
  assert.match(disputed.facts.conflicts[0]!.field, /supply/);
  assert.deepEqual(disputed.facts.conflicts[0]!.evidenceIds, ['feature-evidence-O01', 'feature-evidence-O02', 'feature-evidence-O04']);
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
