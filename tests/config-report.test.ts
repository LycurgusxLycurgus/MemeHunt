import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { starterConfig, starterProfile, presetDescription, validateConfig, validateThesis, loadConfig, saveConfig, guideConfig, guideThesis, materializeThesis } from '../src/app/config.js';
import { cleanText, explainChecks, renderSnapshot } from '../src/app/report.js';
import { featureMetadata } from '../src/domain/catalog.js';
import type { AssessmentDetails, EntrySnapshot, EvidenceRecord, FeatureResult } from '../src/domain/contracts.js';
import type { BaselineAssessment } from '../src/domain/baseline.js';

const CUTOFF = '2026-09-29T12:00:00.000Z';
const TOKEN = { chain: 'solana' as const, address: 'FixtureMint' };

function withTempDirectory(body: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'dd-config-report-'));
  try { body(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function sampleSnapshot(): EntrySnapshot {
  const evidence: EvidenceRecord = {
    id: 'rpc-mint-raw', sourceId: 'solana-rpc', sourceType: 'PUBLIC_API', retrievedAt: CUTOFF,
    availableAt: CUTOFF, contentHash: 'a'.repeat(64), adapterVersion: 'solana-v1', accessMode: 'PUBLIC_API', scope: {},
  };
  const feature: FeatureResult = {
    id: 'O01', value: null, unit: 'bool', quality: 'MISSING', availableAt: CUTOFF,
    evidenceIds: [], applicability: 'UNRESOLVED',
  };
  const cause = {
    category: 'COLLECTION_UNIMPLEMENTED' as const, code: 'DIRECT_COLLECTOR_REQUIRED', featureId: 'O01',
    sourceId: 'solana-rpc', evidenceIds: [], action: 'Complete the named evidence collector.',
  };
  const assessment: BaselineAssessment = {
    id: 'O01', version: 'baseline-v1', evaluator: 'IMPLEMENTED', collector: 'UNIMPLEMENTED',
    quality: 'MISSING', unit: 'bool', data: { identity: null }, observationIds: [], evidenceIds: ['rpc-mint-raw'],
    limitations: ['Fixture only.'], causes: [cause],
  };
  const details: AssessmentDetails = {
    version: 1, profile: starterProfile(), thesis: null, baseline: [assessment],
    origins: { sizeUsd: 'SAVED_DEFAULT', horizonSeconds: 'SAVED_DEFAULT' },
    stageInputs: { circulatingMarketCapUsd: null, tokenCreatedAt: null },
  };
  return {
    id: 'snapshot-fixture', caseId: 'case-fixture', checklistKind: 'ENTRY', token: TOKEN, cutoff: CUTOFF,
    analysisKind: 'USER_IMPORT', features: [feature], evidence: [evidence],
    result: {
      checks: [{ checkId: 'ID-01', checklistKind: 'ENTRY', role: 'REQUIRED_EVIDENCE', pillar: 'ONCHAIN', required: true,
        status: 'UNKNOWN', reasonCode: 'FEATURE_UNKNOWN', featureRefs: ['O01'], evidenceRefs: [] }],
      binary: 'FAIL', classification: 'INSUFFICIENT_DATA', coverage: { known: 0, total: 1 },
    }, hash: 'b'.repeat(64), details,
  };
}

test('starter config is a real strict Profile preset with visible uncalibrated scope', () => {
  const config = validateConfig(starterConfig());
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.profile.id, 'memecoin-research-starter-v1');
  assert.equal(config.profile.sizeUsd, '25');
  assert.equal(config.profile.horizonSeconds, 21600);
  assert.deepEqual(config.profile.risk, {
    maxTransferFeeBps: '100', maxEntryImpactBps: '200', maxExitImpactBps: '300',
    maxRoundTripLossBps: '1000', maxDirectControlShare: '0.10', maxRemovableLiquidityShare: '0.10',
  });
  assert.deepEqual(config.profile.stage.ageBands, [{ name: 'ALL_AGES', minSeconds: 0, maxSeconds: null }]);
  assert.equal(config.preset?.calibration, 'UNCALIBRATED');
  assert.equal(config.preset?.selectedBy, 'USER_REQUEST');
  assert.equal(config.thesisTemplate, undefined);
  assert.match(presetDescription, /Uncalibrated/);
  assert.match(presetDescription, /not a price stop or a maximum-loss guarantee/);
  assert.equal(Object.hasOwn(config.profile, 'exitPlan'), false);
});

test('config validation rejects profile drift, embedded secrets, and oversized or malformed saved files', () => {
  const base = starterConfig();
  assert.throws(() => validateConfig({ ...base, apiKey: 'must-not-persist' }), /INVALID_CONFIG/);
  assert.throws(() => validateConfig({ ...base, profile: { ...base.profile, exitPlan: [] } }), /INVALID_CONFIG/);
  assert.throws(() => validateConfig({ ...base, profile: { ...base.profile, sizeUsd: '0' } }), /INVALID_CONFIG/);
  withTempDirectory(directory => {
    const path = join(directory, 'config.json');
    writeFileSync(path, '{broken', 'utf8');
    assert.throws(() => loadConfig(path), /INVALID_CONFIG/);
    writeFileSync(path, ' '.repeat(200_001), 'utf8');
    assert.throws(() => loadConfig(path), /INVALID_CONFIG/);
  });
});

test('saveConfig is explicit about overwrite and round-trips only validated settings', () => {
  withTempDirectory(directory => {
    const path = join(directory, 'nested', 'config.json');
    const first = starterConfig();
    const saved = saveConfig(path, first);
    assert.deepEqual(loadConfig(path), saved);
    const before = readFileSync(path, 'utf8');
    assert.throws(() => saveConfig(path, { ...first, profile: { ...first.profile, sizeUsd: '40' } }), /CONFIG_EXISTS/);
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.throws(() => saveConfig(path, { ...first, apiKey: 'secret' }, true), /INVALID_CONFIG/);
    assert.equal(readFileSync(path, 'utf8'), before);
    const edited = { ...first, profile: { ...first.profile, sizeUsd: '40' }, preset: { ...first.preset!, selectedBy: 'USER_EDIT' as const } };
    assert.deepEqual(saveConfig(path, edited, true), edited);
    assert.equal(loadConfig(path)?.profile.sizeUsd, '40');
    assert.equal(readFileSync(path, 'utf8').includes('secret'), false);
  });
});

test('guided config retries invalid input and returns the selected values with user-edit provenance', async () => {
  const answers = ['0', '40', '0', '8', '100', '250', '350', '1800', '0.2', '0.3'];
  const prompts: string[] = [];
  const result = await guideConfig(async prompt => { prompts.push(prompt); return answers.shift(); });
  assert.ok(result);
  assert.equal(result.profile.sizeUsd, '40');
  assert.equal(result.profile.horizonSeconds, 28800);
  assert.equal(result.profile.risk.maxEntryImpactBps, '250');
  assert.equal(result.profile.risk.maxRemovableLiquidityShare, '0.3');
  assert.equal(result.preset?.selectedBy, 'USER_EDIT');
  assert.ok(prompts.length > 8, 'invalid entries should be prompted again');

  const initial = starterConfig();
  let calls = 0;
  const cancelled = await guideConfig(async () => ++calls === 1 ? '50' : undefined, initial);
  assert.equal(cancelled, undefined);
  assert.equal(initial.profile.sizeUsd, '25', 'a cancelled draft must not mutate saved input');
});

test('materialized starter thesis freezes cutoff-relative expiry and leaves unsupported plans incomplete', () => {
  const profile = starterProfile();
  const thesis = materializeThesis(profile, CUTOFF);
  assert.equal(thesis.expiryAt, '2026-09-29T18:00:00.000Z');
  assert.deepEqual(thesis.support.map(p => 'feature' in p ? p.feature : 'compound'), ['O01', 'O03', 'O04', 'O06', 'A01', 'A02']);
  assert.deepEqual(thesis.invalidation.slice(0, 4).map(p => 'feature' in p ? [p.feature, p.value] : []), [
    ['O01', false], ['O03', false], ['O04', false], ['O06', false],
  ]);
  assert.deepEqual(thesis.invalidation.at(-1), { op: 'gt', feature: 'O15', value: '1000', unit: 'bps' });
  assert.deepEqual(thesis.legs, []);
  assert.equal(thesis.onchainTraction, null);
  assert.equal(thesis.externalTraction, null);

  const template = structuredClone(thesis);
  const materialized = materializeThesis(profile, CUTOFF, template);
  assert.deepEqual(materialized, template);
  assert.notEqual(materialized, template);
  assert.equal(materializeThesis(profile, CUTOFF, template, 'HORIZON').expiryAt, thesis.expiryAt);
  assert.equal(materializeThesis(profile, CUTOFF, template, 'NONE').expiryAt, null);
});

test('explicit and guided thesis inputs validate boolean feature units and types before saving', async () => {
  const initial = materializeThesis(starterProfile(), CUTOFF);
  const withSupport = (predicate: { op: string; feature: string; value: string | boolean; unit: string }) => ({ ...initial, support: [predicate] });

  assert.throws(() => validateThesis(withSupport({ op: 'gt', feature: 'O03', value: '1', unit: 'count' })), /PREDICATE_UNIT/,
    'a known boolean feature rejects a numeric count predicate before collection');
  assert.throws(() => validateThesis(withSupport({ op: 'eq', feature: 'O03', value: 'true', unit: 'bool' })), /PREDICATE_TYPE/,
    'a boolean predicate requires a boolean JSON value');
  const validBoolean = validateThesis(withSupport({ op: 'eq', feature: 'O03', value: true, unit: 'bool' }));
  assert.deepEqual(validBoolean.support, [{ op: 'eq', feature: 'O03', value: true, unit: 'bool' }]);

  const validBps = validateThesis({ ...initial, invalidation: [{ op: 'lte', feature: 'O15', value: '1000', unit: 'bps' }] });
  assert.deepEqual(validBps.invalidation, [{ op: 'lte', feature: 'O15', value: '1000', unit: 'bps' }],
    'numeric features retain their declared unit and decimal threshold');

  const answers = ['yes', 'O03', 'gt', 'count', '1', 'O03', 'eq', 'bool', 'true', 'n', 'n', 'n', 'n', 'n', 'n'];
  const prompts: string[] = [];
  const guided = await guideThesis(async prompt => { prompts.push(prompt); return answers.shift(); }, starterProfile(), CUTOFF, initial);
  assert.ok(guided);
  assert.deepEqual(guided.support, [{ op: 'eq', feature: 'O03', value: true, unit: 'bool' }]);
  assert.ok(prompts.filter(prompt => /Threshold/.test(prompt)).length >= 2, 'invalid boolean input is rejected and asked again');
});

test('guided thesis edits preserve ordered original-quantity legs and cancel without mutating the template', async () => {
  const profile = starterProfile();
  const initial = materializeThesis(profile, CUTOFF);
  const answers = ['n','n','n','n','n','n','yes','6000','O15','lte','bps','1000','ALL_REMAINING','A16','gte','count','10','done'];
  const prompts: string[] = [];
  const configured = await guideThesis(async prompt => { prompts.push(prompt); return answers.shift(); }, profile, CUTOFF, initial);
  assert.ok(configured);
  assert.deepEqual(configured.legs.map(leg => [leg.quantityBps, leg.allRemaining]), [[6000, false], [null, true]]);
  assert.equal(configured.legs[0]?.trigger.op, 'lte');
  assert.equal(configured.legs[1]?.trigger.op, 'gte');
  assert.ok(prompts.some(prompt => /Original quantity/.test(prompt)));
  assert.deepEqual(initial.legs, [], 'guided editing uses a draft and leaves the saved thesis untouched');

  const cancelled = await guideThesis(async () => undefined, profile, CUTOFF, initial);
  assert.equal(cancelled, undefined);
  assert.deepEqual(initial.legs, []);
});

test('explanations preserve baseline causes, refs, and settings origins; rendered values are terminal-safe', () => {
  const snapshot = sampleSnapshot();
  const [row] = explainChecks(snapshot);
  assert.equal(row?.checkId, 'ID-01');
  assert.deepEqual(row?.featureRefs, ['O01']);
  assert.deepEqual(row?.evidenceRefs, ['rpc-mint-raw']);
  assert.equal(row?.causes[0]?.category, 'COLLECTION_UNIMPLEMENTED');

  const withUnsafeValue = { ...snapshot, features: [{ ...snapshot.features[0]!, value: 'injected\n\u001b[31mvalue\r' }] };
  const single = renderSnapshot(withUnsafeValue, { check: 'ID-01', evidence: true });
  assert.match(single, /ID-01 Token identity: UNKNOWN/);
  assert.match(single, /Complete the named evidence collector/);
  assert.match(single, /SHA256 a{64}/);
  assert.doesNotMatch(single.replace(/\n/g, ''), /[\u0000-\u001f\u007f-\u009f]/);
  const summary = renderSnapshot(snapshot);
  assert.match(summary, /Required coverage: 0\/1/);
  assert.match(summary, /sizeUsd=SAVED_DEFAULT/);
  assert.match(summary, /friction is not a price stop/i);
  assert.match(summary, /COLLECTION_UNIMPLEMENTED|collection not implemented/i);
  assert.throws(() => renderSnapshot(snapshot, { check: 'NO-SUCH-CHECK' }), /CHECK_NOT_FOUND/);
  assert.equal(cleanText('  a\n\t b\u0085c  '), 'a b c');
});

test('v2 reports origin relationship and measured attention leadership as separate judgments', () => {
  const snapshot = sampleSnapshot();
  snapshot.details!.baseline.push({
    id: 'A14', version: 'baseline-v1', evaluator: 'IMPLEMENTED', collector: 'IMPLEMENTED',
    quality: 'KNOWN', unit: 'bool',
    data: {
      method: 'representation-routes-v2',
      originRelationship: { status: 'SUPPORTED', rationale: 'A dated project account post identifies this exact contract.', citations: [] },
      measuredAttention: { status: 'UNKNOWN', rationale: 'The common-query post sample does not meet its leadership threshold.', shares: [] },
      basis: 'ORIGIN',
    },
    observationIds: [], evidenceIds: [], limitations: ['automated-source-review-v1'], causes: [],
    projection: { id: 'A14', value: true, unit: 'bool', quality: 'KNOWN', availableAt: CUTOFF, evidenceIds: [], applicability: 'APPLICABLE' },
  });

  const rendered = renderSnapshot(snapshot);
  assert.match(rendered, /Origin relationship: SUPPORTED/);
  assert.match(rendered, /Measured attention leadership: UNKNOWN/);
  assert.match(rendered, /CAN-02 basis: origin-supported representation/);
  assert.doesNotMatch(rendered, /Origin relationship: SUPPORTED[^\n]*Measured attention leadership: SUPPORTED/);
});

test('inadequate representation report stays bounded and does not imply fraud or a competing token', () => {
  const snapshot = sampleSnapshot();
  const reason = 'The current fetched profile describes stablecoin lending, not the indexed neighborhood-art project.';
  const attentionFeature = (id: 'A09' | 'A10', value: boolean | null, quality: FeatureResult['quality']): FeatureResult => ({
    id, value, unit: 'bool', quality, availableAt: CUTOFF, evidenceIds: ['attention-qualified-receipt'], applicability: 'APPLICABLE',
  });
  const assessment = (id: 'A09' | 'A10', value: boolean | null, quality: BaselineAssessment['quality']): BaselineAssessment => ({
    id, version: 'baseline-v1', evaluator: 'IMPLEMENTED', collector: 'IMPLEMENTED', quality, unit: 'bool',
    data: id === 'A09' ? { method: 'public-representation-screen-v1', evidenceAdequacy: { rationale: reason } } : { candidates: [] },
    observationIds: [], evidenceIds: ['attention-qualified-receipt'], limitations: ['automated-source-review-v1; bounded sample'], causes: [],
    projection: { id, value, unit: 'bool', quality, availableAt: CUTOFF, evidenceIds: ['attention-qualified-receipt'], applicability: 'APPLICABLE' },
  });
  snapshot.features.push(attentionFeature('A09', false, 'KNOWN'), attentionFeature('A10', null, 'MISSING'));
  snapshot.details!.baseline.push(assessment('A09', false, 'KNOWN'), assessment('A10', null, 'MISSING'));
  snapshot.result.checks.push({
    checkId: 'CAN-01', checklistKind: 'ENTRY', role: 'REQUIRED_EVIDENCE', pillar: 'ATTENTION', required: true,
    status: 'FAIL', reasonCode: 'RULE_FAILED', featureRefs: ['A09'], evidenceRefs: ['attention-qualified-receipt'],
  });

  const rendered = renderSnapshot(snapshot);
  assert.match(rendered, /Public representation evidence: inadequate after independent source review/);
  assert.match(rendered, /current fetched profile describes stablecoin lending/);
  assert.match(rendered, /does not prove another competing token or fraud/);
  assert.doesNotMatch(rendered, /Known entry contradictions:[^\n]*fraud/i);
});

test('social explanations label synchrony and account history while legacy snapshots keep catalog names', () => {
  const snapshot = sampleSnapshot();
  const feature = (id: 'S04' | 'S05'): FeatureResult => ({
    id, value: null, unit: 'bool', quality: 'MISSING', availableAt: CUTOFF, evidenceIds: [], applicability: 'APPLICABLE',
  });
  const assessment = (id: 'S04' | 'S05'): BaselineAssessment => ({
    id, version: 'baseline-v1', evaluator: 'IMPLEMENTED', collector: 'IMPLEMENTED', quality: 'MISSING', unit: 'bool',
    data: { method: 'social-source-review-v1' }, observationIds: [], evidenceIds: [], limitations: [],
    causes: [{ category: 'EVIDENCE_UNAVAILABLE', code: `${id}_MISSING`, featureId: id, evidenceIds: [], action: 'Supply qualified public-source evidence.' }],
    projection: { id, value: null, unit: 'bool', quality: 'MISSING', availableAt: CUTOFF, evidenceIds: [], applicability: 'APPLICABLE' },
  });
  snapshot.features.push(feature('S04'), feature('S05'));
  snapshot.details!.baseline.push(assessment('S04'), assessment('S05'));
  snapshot.details!.social = {
    version: 'social-policy-v1', method: 'social-source-review-v1', token: TOKEN,
    start: '2026-09-28T00:00:00.000Z', end: '2026-09-29T00:00:00.000Z', availableAt: CUTOFF, evidenceIds: [],
    postCorpusObserved: false, sampleComplete: false, lineageComplete: false,
    qualifiedOriginalCount: null, accountUpperBound: null, independentGroupCount: null, independentCommunityCount: null,
    identityReview: {
      verdict: 'CONTRADICTED', rationale: 'The reviewed public pages do not independently bind the claimed account to the exact contract.',
      citations: [{ sourceId: 'identity-page', quote: 'The public page lists the project but no official account.' }],
      method: 'source-transparency-review-v1', missingIndicators: [],
    },
    integrityReview: {
      verdict: 'CONTRADICTED', rationale: 'The available source trail is too incomplete for a clear integrity assessment.',
      citations: [{ sourceId: 'social-post', quote: 'The collected source shows a bounded public post sample.' }],
      method: 'source-transparency-review-v1', missingIndicators: ['ACCOUNT_HISTORY', 'ENGAGEMENT', 'COMPARABLE_HISTORY'],
    },
  };
  snapshot.result.checks.push({
    checkId: 'SOC-01', checklistKind: 'ENTRY', role: 'REQUIRED_EVIDENCE', pillar: 'SOCIAL', required: true,
    status: 'FAIL', reasonCode: 'RULE_FAILED', featureRefs: ['S01'], evidenceRefs: [],
  });
  snapshot.result.checks.push({
    checkId: 'SOC-02', checklistKind: 'ENTRY', role: 'REQUIRED_EVIDENCE', pillar: 'SOCIAL', required: true,
    status: 'UNKNOWN', reasonCode: 'FEATURE_UNKNOWN', featureRefs: ['S04', 'S05'], evidenceRefs: [],
  });

  const socialNames = explainChecks(snapshot).find(row => row.checkId === 'SOC-02')?.values.map(row => row.name);
  assert.deepEqual(socialNames, ['Sampled synchrony contrast', 'Public account age and activity']);
  assert.equal(explainChecks(snapshot).find(row => row.checkId === 'SOC-01')?.socialJudgment?.verdict, 'CONTRADICTED');
  const identityExplanation = renderSnapshot(snapshot, { check: 'SOC-01' });
  assert.match(identityExplanation, /Public-evidence review: CONTRADICTED/);
  assert.match(identityExplanation, /does not prove impersonation/i);
  assert.doesNotMatch(identityExplanation, /fraud|bots|manipulation/i);
  const integrityExplanation = renderSnapshot(snapshot, { check: 'SOC-02' });
  assert.match(integrityExplanation, /Public-evidence review: CONTRADICTED/);
  assert.match(integrityExplanation, /Desired indicators unavailable: ACCOUNT_HISTORY, ENGAGEMENT, COMPARABLE_HISTORY/);
  assert.match(integrityExplanation, /visibility risks, not proof of fraud, bots or manipulation/);

  const legacy = structuredClone(snapshot);
  delete legacy.details!.social;
  const legacyNames = explainChecks(legacy).find(row => row.checkId === 'SOC-02')?.values.map(row => row.name);
  assert.deepEqual(legacyNames, ['S04', 'S05'].map(id => featureMetadata.find(row => row.id === id)?.name ?? id));
});

test('all four unknown-cause families survive per-check explanation', () => {
  const snapshot = sampleSnapshot();
  const causeRow = (id: string, category: BaselineAssessment['causes'][number]['category']): BaselineAssessment => ({
    id, version: 'baseline-v1', evaluator: 'IMPLEMENTED', collector: 'IMPLEMENTED', quality: 'MISSING', unit: 'bool', data: null,
    observationIds: [], evidenceIds: [], limitations: [], causes: [{
      category, code: `CAUSE_${id}`, featureId: id, evidenceIds: [], action: `Resolve ${id} using its correct workflow.`,
    }],
  });
  const check = (checkId: string, featureId: string): EntrySnapshot['result']['checks'][number] => ({
    checkId, checklistKind: 'ENTRY', role: 'REQUIRED_EVIDENCE', pillar: 'SHARED', required: true,
    status: 'UNKNOWN', reasonCode: 'FEATURE_UNKNOWN', featureRefs: [featureId], evidenceRefs: [],
  });
  snapshot.details = {
    ...snapshot.details!, profile: { id: 'incomplete-profile', risk: {}, stage: { ageBands: [] } },
    baseline: [...snapshot.details!.baseline, causeRow('O05', 'EVIDENCE_UNAVAILABLE'), causeRow('A16', 'CLAIM_UNVALIDATED'), causeRow('C01', 'USER_INPUT_MISSING')],
  };
  snapshot.result.checks.push(check('SEC-01', 'O05'), check('ATT-01', 'A16'), check('CTX-01', 'C01'));
  const categories = new Set(explainChecks(snapshot).flatMap(row => row.causes.map(cause => cause.category)));
  assert.deepEqual([...categories].sort(), ['CLAIM_UNVALIDATED', 'COLLECTION_UNIMPLEMENTED', 'EVIDENCE_UNAVAILABLE', 'USER_INPUT_MISSING']);
});
