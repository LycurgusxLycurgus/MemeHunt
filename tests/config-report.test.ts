import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { starterConfig, starterProfile, presetDescription, validateConfig, validateThesis, loadConfig, saveConfig, guideConfig, guideThesis, materializeThesis } from '../src/app/config.js';
import { buildEntryReport, cleanText, explainChecks, renderSnapshot } from '../src/app/report.js';
import { entryDefinitionsFor, featureMetadata } from '../src/domain/catalog.js';
import type { AssessmentDetails, EntryGroupFacts, EntrySnapshot, EvidenceRecord, FeatureResult } from '../src/domain/contracts.js';
import { deriveEntryGroups } from '../src/domain/entry-groups.js';
import { deriveShared } from '../src/domain/shared.js';
import { evaluateEntry } from '../src/domain/policy.js';
import { resolveOriginEntryCriterion } from '../src/domain/attention.js';
import { EMPTY_DAMM_METHOD, EMPTY_DAMM_VERSION } from '../src/domain/venue-entry.js';
import type { BaselineAssessment } from '../src/domain/baseline.js';
import { completeFixtureEntryFeatures, illustrativeUncalibratedProfile } from '../examples/fixtures.js';
import { SHARED_CUTOFF, SHARED_TOKEN, sharedFixture } from './shared-fixtures.js';
import { attentionBoundsFixture } from './attention-bounds-fixtures.js';
import { freshOriginAssessment, type OriginDecision } from './origin-constitution-fixtures.js';

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

function allRequiredReportSnapshot(): EntrySnapshot {
  const snapshot = sampleSnapshot();
  const definitions = entryDefinitionsFor(true);
  snapshot.features = completeFixtureEntryFeatures();
  snapshot.result = {
    checks: definitions.map(definition => ({
      checkId: definition.checkId, checklistKind: 'ENTRY' as const, role: definition.role, pillar: definition.pillar,
      required: definition.required, status: 'PASS' as const, reasonCode: 'RULE_SATISFIED',
      featureRefs: [...definition.featureIds], evidenceRefs: [],
    })),
    binary: 'PASS', classification: 'RESEARCH_ELIGIBLE', coverage: { known: definitions.length, total: definitions.length },
  };
  const groupIds = ['ADV-01', 'ADV-02', 'ADV-03', 'ADV-04', 'ADV-05'] as const;
  snapshot.details!.groups = {
    method: 'mandatory-entry-groups-v1', token: snapshot.token!, cutoff: snapshot.cutoff,
    groups: groupIds.map(checkId => ({
      checkId, status: 'PASS', rationale: `The current ${checkId} criterion has a completed synthetic fixture.`,
      code: `${checkId}_CURRENT_FIXTURE`, featureIds: [`${checkId}-feature`], evidenceIds: [`${checkId}-evidence`],
      availableAt: snapshot.cutoff, metrics: {}, limitations: [],
    })),
  };
  snapshot.details!.baseline = [];
  return snapshot;
}

function emptyVenueReportSnapshot(): EntrySnapshot {
  const snapshot = allRequiredReportSnapshot();
  const profile = { ...starterProfile(), sizeUsd: '25', horizonSeconds: 3600 };
  const pool = 'FixtureEmptyPool';
  const evidenceIds = ['damm-state'];
  const availableAt = snapshot.cutoff;
  const expiresAt = new Date(Date.parse(availableAt) + 30_000).toISOString();
  const screening = {
    method: EMPTY_DAMM_METHOD, version: EMPTY_DAMM_VERSION, token: snapshot.token!, pool,
    minSlot: 100, slot: 100, assetSide: 'B' as const, assetProgram: 'fixture-token-program',
    assetVault: 'fixture-asset-vault', nativeVault: 'fixture-native-vault',
    liquidityAtomic: '0' as const, permanentLockLiquidityAtomic: '0' as const,
    availableAt, expiresAt, evidenceIds,
  };
  const venue: BaselineAssessment = {
    id: 'O08', version: 'baseline-v1', evaluator: 'IMPLEMENTED', collector: 'IMPLEMENTED', quality: 'KNOWN', unit: 'bool',
    data: { version: EMPTY_DAMM_VERSION, bindingVerified: true, certificateId: `meteora-damm-v2-native-empty:${pool}`,
      token: snapshot.token, poolAddress: pool, screening },
    observationIds: [], evidenceIds, limitations: [], causes: [],
    projection: { id: 'O08', value: true, unit: 'bool', quality: 'KNOWN', availableAt, evidenceIds, applicability: 'APPLICABLE' },
  };
  const auxiliaryVenueFact: BaselineAssessment = {
    id: 'C02', version: 'baseline-v1', evaluator: 'IMPLEMENTED', collector: 'UNIMPLEMENTED', quality: 'MISSING', unit: 'bool',
    data: null, observationIds: [], evidenceIds, limitations: [],
    causes: [{ category: 'EVIDENCE_UNAVAILABLE', code: 'VENUE_INSPECTED', featureId: 'C02', evidenceIds,
      action: 'A route certificate was not produced.' }],
    projection: { id: 'C02', value: null, unit: 'bool', quality: 'MISSING', availableAt, evidenceIds, applicability: 'APPLICABLE' },
  };
  snapshot.details!.profile = profile;
  snapshot.details!.baseline = [venue, auxiliaryVenueFact];
  snapshot.evidence.push({ id: 'damm-state', sourceId: 'meteora-damm-direct', sourceType: 'JSON_RPC',
    retrievedAt: availableAt, availableAt, contentHash: 'c'.repeat(64), adapterVersion: 'live-v1',
    accessMode: 'PUBLIC_API', scope: { minSlot: 100, slot: 100 } });

  const decisions = { 'CAP-01': 'PASS', 'SEC-05': 'PASS', 'LIQ-01': 'FAIL', 'EXE-01': 'FAIL',
    'EXE-02': 'FAIL', 'EXE-03': 'FAIL', 'ADV-05': 'FAIL' } as const;
  for (const [checkId, status] of Object.entries(decisions)) {
    const row = snapshot.result.checks.find(item => item.checkId === checkId);
    assert.ok(row, `fixture includes ${checkId}`);
    row.status = status;
    row.reasonCode = status === 'PASS' ? 'RULE_SATISFIED' : 'RULE_FAILED';
  }
  return snapshot;
}

function setEmptyVenueRowsUnknown(snapshot: EntrySnapshot): void {
  for (const checkId of ['CAP-01', 'SEC-05', 'LIQ-01', 'EXE-01', 'EXE-02', 'EXE-03', 'ADV-05']) {
    const row = snapshot.result.checks.find(item => item.checkId === checkId);
    assert.ok(row, `fixture includes ${checkId}`);
    row.status = 'UNKNOWN';
    row.reasonCode = 'FEATURE_UNKNOWN';
  }
  const required = snapshot.result.checks.filter(row => row.required);
  snapshot.result.coverage = { known: required.filter(row => row.status !== 'UNKNOWN').length, total: required.length };
}

function auxiliaryValues(report: ReturnType<typeof buildEntryReport>) {
  return report.auxiliaryFacts.map(({ id, outcome, quality, value, featureRefs, evidenceRefs }) =>
    ({ id, outcome, quality, value, featureRefs, evidenceRefs }));
}

test('auxiliary venue explanation requires a current verified empty-pool screening', () => {
  const valid = emptyVenueReportSnapshot();
  const validBefore = JSON.stringify(valid);
  const validReport = buildEntryReport(valid);
  const validFact = validReport.auxiliaryFacts.find(fact => fact.id === 'C02')!;
  assert.deepEqual([validFact.value, validFact.quality, validFact.reason], [null, 'MISSING',
    'The empty-pool screening is verified; an executable quote and round-trip simulation are unavailable.']);
  const validText = renderSnapshot(valid);
  assert.match(validText, /The selected pool has no active liquidity\. No quote, fee estimate, removable-liquidity fraction or round-trip simulation was produced\./);
  assert.doesNotMatch(validText, /quote (?:is available|was produced)|round-trip simulation (?:is available|was performed)/i);
  assert.equal(JSON.stringify(valid), validBefore, 'reporting preserves the input snapshot, checks, evidence, and stored hash');

  const invalid = structuredClone(valid);
  const invalidVenue = invalid.details!.baseline.find(row => row.id === 'O08')!;
  (invalidVenue.data as { bindingVerified: boolean }).bindingVerified = false;
  setEmptyVenueRowsUnknown(invalid);
  const invalidBefore = JSON.stringify(invalid);
  const invalidReport = buildEntryReport(invalid);
  const invalidFact = invalidReport.auxiliaryFacts.find(fact => fact.id === 'C02')!;
  assert.equal(invalidFact.reason, 'Venue inspection completed, but an executable route certificate is unavailable.');
  const invalidText = renderSnapshot(invalid);
  assert.doesNotMatch(invalidText, /empty-pool screening is verified|The selected pool has no active liquidity/i);
  assert.equal(JSON.stringify(invalid), invalidBefore, 'invalid proof remains unchanged by report rendering');

  const expired = structuredClone(valid);
  const expiredVenue = expired.details!.baseline.find(row => row.id === 'O08')!;
  const expiredScreening = (expiredVenue.data as { screening: { availableAt: string; expiresAt: string } }).screening;
  expiredScreening.availableAt = new Date(Date.parse(expired.cutoff) - 60_000).toISOString();
  expiredScreening.expiresAt = new Date(Date.parse(expired.cutoff) - 30_000).toISOString();
  setEmptyVenueRowsUnknown(expired);
  const expiredBefore = JSON.stringify(expired);
  const expiredReport = buildEntryReport(expired);
  const expiredFact = expiredReport.auxiliaryFacts.find(fact => fact.id === 'C02')!;
  assert.equal(expiredFact.reason, 'Venue inspection completed, but an executable route certificate is unavailable.');
  assert.doesNotMatch(renderSnapshot(expired), /empty-pool screening is verified|The selected pool has no active liquidity/i);
  assert.equal(JSON.stringify(expired), expiredBefore, 'expired proof remains unchanged by report rendering');

  assert.deepEqual(auxiliaryValues(validReport), auxiliaryValues(invalidReport),
    'verification changes only the C02 explanation, not auxiliary values, quality, evidence, or IDs');
  assert.deepEqual(auxiliaryValues(invalidReport), auxiliaryValues(expiredReport));
  assert.deepEqual(invalidReport.checks, expiredReport.checks);
  assert.deepEqual(invalidReport.pillars, expiredReport.pillars);
  assert.deepEqual(invalidReport.coverage, expiredReport.coverage);
  assert.deepEqual(invalidReport.policyCoverage, expiredReport.policyCoverage);
  assert.equal(valid.hash, validBefore && JSON.parse(validBefore).hash, 'the retained snapshot hash is unchanged');
});

test('live stage gaps explain unimplemented collection without changing the entry decisions', () => {
  const live = emptyVenueReportSnapshot();
  live.analysisKind = 'LIVE';
  const imported = emptyVenueReportSnapshot();
  imported.analysisKind = 'USER_IMPORT';
  const liveBefore = JSON.stringify(live);
  const importedBefore = JSON.stringify(imported);
  const liveReport = buildEntryReport(live);
  const importedReport = buildEntryReport(imported);
  const stageReasons = (report: ReturnType<typeof buildEntryReport>) => Object.fromEntries(
    report.auxiliaryFacts.filter(fact => fact.id.startsWith('stage:')).map(fact => [fact.id, [fact.value, fact.quality, fact.reason]]));
  assert.deepEqual(stageReasons(liveReport), {
    'stage:circulatingMarketCapUsd': [null, 'MISSING', 'Live collection of qualified circulating market cap is not implemented; FDV is not circulating cap.'],
    'stage:tokenCreatedAt': [null, 'MISSING', 'Live collection of qualified token creation time is not implemented; pool age is not token age.'],
  });
  assert.deepEqual(stageReasons(importedReport), {
    'stage:circulatingMarketCapUsd': [null, 'MISSING', 'Stage fact not established; pool age is not token age.'],
    'stage:tokenCreatedAt': [null, 'MISSING', 'Stage fact not established; pool age is not token age.'],
  });
  assert.deepEqual(liveReport.checks, importedReport.checks);
  assert.deepEqual(liveReport.pillars, importedReport.pillars);
  assert.deepEqual(liveReport.coverage, importedReport.coverage);
  assert.deepEqual(liveReport.policyCoverage, importedReport.policyCoverage);
  assert.deepEqual(auxiliaryValues(liveReport), auxiliaryValues(importedReport));
  assert.equal(JSON.stringify(live), liveBefore);
  assert.equal(JSON.stringify(imported), importedBefore);
});

test('entry report marks completion only with all 33 decisions and five completed live phases', () => {
  const snapshot = allRequiredReportSnapshot();
  snapshot.details!.baseline = attentionBoundsFixture();
  const stages = ['PREFLIGHT', 'ATTENTION', 'SOCIAL', 'SHARED', 'FINALIZE'].map(phase => ({ phase, status: 'COMPLETED' }));
  const phaseProjection = {
    id: 'live-run-scope', sourceId: 'live-orchestrator', sourceType: 'SAMPLE_SCOPE',
    retrievedAt: snapshot.cutoff, availableAt: snapshot.cutoff, contentHash: 'd'.repeat(64),
    adapterVersion: 'live-v1', accessMode: 'LOCAL_DERIVED' as const,
    scope: { completionMethod: 'entry-completion-v1', stages },
  };
  snapshot.evidence.push(phaseProjection);

  const complete = buildEntryReport(snapshot);
  assert.equal(complete.coverage.known, 33);
  assert.equal(complete.coverage.total, 33);
  assert.deepEqual(complete.completion, { method: 'entry-completion-v1', state: 'COMPLETE', blockers: [], phases: stages });
  assert.ok(complete.auxiliaryFacts.some(fact => fact.id === 'A16' && fact.quality === 'MISSING'),
    'an unresolved exact post count remains auxiliary when the required criterion has a qualified decision');
  assert.match(renderSnapshot(snapshot), /Analysis completion: COMPLETE/);

  const unresolved = structuredClone(snapshot);
  unresolved.result.checks.find(check => check.checkId === 'ATT-01')!.status = 'UNKNOWN';
  unresolved.result.coverage = { known: 32, total: 33 };
  const blockedDecision = buildEntryReport(unresolved);
  assert.equal(blockedDecision.completion.state, 'INCOMPLETE');
  assert.ok(blockedDecision.completion.blockers.some(blocker => blocker.checkId === 'ATT-01'));

  const unfinishedPhase = structuredClone(snapshot);
  const runScope = unfinishedPhase.evidence.find(record => record.id === 'live-run-scope')!;
  (runScope.scope.stages as Array<{ phase: string; status: string }>)[2]!.status = 'CANCELLED';
  const blockedPhase = buildEntryReport(unfinishedPhase);
  assert.equal(blockedPhase.completion.state, 'INCOMPLETE');
  assert.deepEqual(blockedPhase.completion.blockers.map(blocker => blocker.checkId), ['SOCIAL']);

  const legacy = allRequiredReportSnapshot();
  const legacyReport = buildEntryReport(legacy);
  assert.deepEqual(legacyReport.completion, { method: 'entry-completion-v1', state: 'UNVERIFIED', blockers: [], phases: null },
    'historical snapshots without the phase projection remain unverified and retain their policy rows');
  assert.deepEqual(legacy.result.coverage, legacyReport.policyCoverage);
});

type AttentionSample =
  | { kind: 'MEASURED'; posts: string; accounts: string }
  | { kind: 'UNFINISHED' }
  | { kind: 'CLOSED_GAP' };

function attentionReportSnapshot(sample: AttentionSample, narrativeInadequate = true): EntrySnapshot {
  const fixture = sharedFixture();
  const setFeature = (id: string, value: string | boolean | null, quality: FeatureResult['quality'] = 'KNOWN') => {
    const feature = fixture.features.find(item => item.id === id);
    const assessment = fixture.baseline.find(item => item.id === id);
    assert.ok(feature && assessment?.projection, `fixture includes projected feature ${id}`);
    feature.value = value;
    feature.quality = quality;
    assessment.quality = quality;
    assessment.projection.value = value;
    assessment.projection.quality = quality;
  };
  const record = (id: string, sourceId: string): EvidenceRecord => ({
    id, sourceId, sourceType: 'PUBLIC_API', retrievedAt: fixture.cutoff, availableAt: fixture.cutoff,
    contentHash: 'c'.repeat(64), adapterVersion: 'config-report-attention-v1', accessMode: 'PUBLIC_API', scope: { sanitized: true },
  });

  setFeature('A01', !narrativeInadequate);
  setFeature('A02', true);
  setFeature('A05', true);
  const narrative = fixture.baseline.find(item => item.id === 'A01')!;
  narrative.data = narrativeInadequate
    ? { method: 'narrative-public-support-v1', reason: 'The completed current sample lacks sufficient narrative support.' }
    : { summary: 'The qualified current narrative is supported.' };
  if (sample.kind === 'MEASURED') {
    setFeature('A15', true);
    setFeature('A16', sample.posts);
    setFeature('A17', sample.accounts);
  } else if (sample.kind === 'UNFINISHED') {
    setFeature('A15', null, 'MISSING');
    setFeature('A16', null, 'MISSING');
    setFeature('A17', null, 'MISSING');
    fixture.baseline.find(item => item.id === 'A15')!.data = {
      method: 'entry-evidence-gate-v1', entryCriterion: 'ATT-01', verdict: 'UNRESOLVED',
      postSampleScope: { method: 'reviewed-empty-post-scope-v1', complete: false, sourceIds: [] },
    };
  } else {
    setFeature('A15', false);
    setFeature('A16', null, 'MISSING');
    setFeature('A17', null, 'MISSING');
    fixture.baseline.find(item => item.id === 'A15')!.data = {
      method: 'entry-evidence-gate-v1', entryCriterion: 'ATT-01', verdict: 'FAIL',
      postSampleScope: { method: 'reviewed-empty-post-scope-v1', complete: true, sourceIds: [] },
    };
  }

  fixture.evidence.push(record('dex-pairs', 'dexscreener'), record('holders', 'solana-rpc'), record('venue-proof', 'solana-rpc'));
  const venue = fixture.baseline.find(item => item.id === 'O08')!;
  venue.data = { poolAddress: 'current-pool', version: 'fixture-current-route', bindingVerified: true };
  venue.evidenceIds = ['venue-proof'];
  fixture.baseline.find(item => item.id === 'S02')!.data = {
    accounts: 3, qualifiedOriginals: 4, copyGroups: ['author-a', 'author-b'],
  };
  const market: NonNullable<EntrySnapshot['market']> = {
    reportedPairCount: 1, retainedPairCount: 1, truncated: false,
    pairs: [{
      pairAddress: 'current-pool', dexId: 'fixture-dex', url: null, mintSide: 'base', baseAddress: fixture.token.address,
      quoteAddress: 'quote', priceUsd: '0.0001', liquidityUsd: '100', volume24hUsd: '10', buys24h: 2, sells24h: 1,
      pairCreatedAt: new Date(Date.parse(fixture.cutoff) - 300_000).toISOString(),
    }],
  };
  const groups = deriveEntryGroups({
    token: fixture.token, cutoff: fixture.cutoff, profile: fixture.profile,
    baseline: fixture.baseline, evidence: fixture.evidence, social: fixture.social,
    collection: { rpc: { state: 'OBSERVED' }, dex: { state: 'OBSERVED' }, web: { state: 'OBSERVED' } },
    holders: {
      complete: true, supplyAtomic: '100', slot: 120, evidenceIds: ['holders'],
      accounts: Array.from({ length: 10 }, (_, index) => ({ address: `wallet-account-${index}`, owner: `wallet-owner-${index}`, amount: '10' })),
    },
    market,
  });

  const snapshot = allRequiredReportSnapshot();
  snapshot.token = fixture.token;
  snapshot.cutoff = fixture.cutoff;
  snapshot.features = fixture.features;
  snapshot.evidence = fixture.evidence;
  snapshot.market = market;
  snapshot.details!.profile = fixture.profile;
  snapshot.details!.baseline = fixture.baseline;
  snapshot.details!.social = fixture.social;
  snapshot.details!.groups = groups;
  snapshot.result = evaluateEntry(
    fixture.features, fixture.profile, fixture.cutoff, 'QUALIFIED_V4', fixture.social, false, undefined,
    sample.kind === 'CLOSED_GAP' ? { sample: false } : undefined, groups,
  );
  return snapshot;
}

function assertReportProjection(snapshot: EntrySnapshot, expected: 'SUPPORTED' | 'CONTRADICTED' | 'INSUFFICIENT' | 'UNKNOWN') {
  const before = JSON.stringify(snapshot);
  const rawRow = snapshot.result.checks.find(row => row.checkId === 'ADV-03')!;
  const report = buildEntryReport(snapshot);
  const reportRow = report.checks.find(row => row.checkId === 'ADV-03')!;
  assert.equal(reportRow.policyStatus, rawRow.status);
  assert.equal(reportRow.outcome, expected);

  for (const pillar of ['ONCHAIN', 'ATTENTION', 'SOCIAL', 'SHARED'] as const) {
    const rows = report.checks.filter(row => row.required && row.pillar === pillar);
    assert.deepEqual(report.pillars[pillar], {
      supported: rows.filter(row => row.outcome === 'SUPPORTED').length,
      contradicted: rows.filter(row => row.outcome === 'CONTRADICTED').length,
      insufficient: rows.filter(row => row.outcome === 'INSUFFICIENT').length,
      unknown: rows.filter(row => row.outcome === 'UNKNOWN').length,
      total: rows.length,
    });
  }
  const required = report.checks.filter(row => row.required && row.policyStatus !== 'NOT_APPLICABLE');
  assert.deepEqual(report.coverage, {
    known: required.filter(row => row.outcome !== 'UNKNOWN').length,
    total: required.length,
  });
  assert.deepEqual(report.policyCoverage, snapshot.result.coverage);

  const explained = explainChecks(snapshot).find(row => row.checkId === 'ADV-03')!;
  assert.deepEqual([explained.status, explained.policyStatus, explained.outcome], [rawRow.status, rawRow.status, expected]);
  assert.match(renderSnapshot(snapshot, { check: 'ADV-03' }), new RegExp(`^ADV-03 Attention context: ${expected}`));
  assert.match(renderSnapshot(snapshot, { checklist: true }), new RegExp(`\\s${expected}(?: \\([A-Z]+\\))?\\s+ADV-03 Attention context`));

  const roundTripped = JSON.parse(JSON.stringify(snapshot)) as EntrySnapshot;
  assert.deepEqual(JSON.parse(JSON.stringify(buildEntryReport(roundTripped))), JSON.parse(JSON.stringify(report)));
  assert.equal(JSON.stringify(snapshot), before, 'normalization, explanation and rendering do not mutate the raw policy snapshot');
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
  assert.match(summary, /Required decisions resolved: 0\/1/);
  assert.match(summary, /sizeUsd=SAVED_DEFAULT/);
  assert.match(summary, /friction is not a price stop/i);
  assert.match(summary, /COLLECTION_UNIMPLEMENTED|collection not implemented/i);
  assert.throws(() => renderSnapshot(snapshot, { check: 'NO-SUCH-CHECK' }), /CHECK_NOT_FOUND/);
  assert.equal(cleanText('  a\n\t b\u0085c  '), 'a b c');
});

test('entry report keeps typed outcomes separate from frozen policy coverage and auxiliary facts', () => {
  const snapshot = allRequiredReportSnapshot();
  const setStatus = (checkId: string, status: 'FAIL' | 'UNKNOWN') => {
    const row = snapshot.result.checks.find(item => item.checkId === checkId);
    assert.ok(row, `fixture contains ${checkId}`);
    row.status = status;
  };
  const setFeature = (id: string, value: boolean) => {
    const feature = snapshot.features.find(item => item.id === id);
    assert.ok(feature, `fixture contains ${id}`);
    feature.value = value;
  };
  const assessment = (id: string, data: unknown) => snapshot.details!.baseline.push({
    id, version: 'baseline-v1', evaluator: 'IMPLEMENTED', collector: 'IMPLEMENTED', quality: 'KNOWN', unit: 'bool', data,
    observationIds: [], evidenceIds: [], limitations: [], causes: [],
  });
  setStatus('NAR-02', 'FAIL');
  setStatus('CAN-02', 'FAIL');
  setStatus('ATT-02', 'FAIL');
  setStatus('DAT-03', 'FAIL');
  setStatus('SOC-01', 'FAIL');
  setStatus('ADV-02', 'FAIL');
  snapshot.result.checks.find(item => item.checkId === 'NAR-02')!.featureRefs = ['A03'];
  snapshot.details!.groups!.groups.find(group => group.checkId === 'ADV-02')!.status = 'FAIL';
  snapshot.details!.groups!.groups.find(group => group.checkId === 'ADV-02')!.code = 'REPORTED_ACTIVITY_CONTEXT';

  setFeature('A03', false);
  assessment('A03', {
    outcomeBasisMethod: 'entry-outcome-basis-v1', entryDecisionMethod: 'binary-public-support-v4',
    decision: { verdict: 'FAIL', basis: 'EVIDENCE_INADEQUACY', negativeBasis: 'PUBLIC_SUPPORT_INADEQUATE' },
  });
  setFeature('A14', false);
  assessment('A14', {
    originRelationship: { status: 'UNKNOWN' }, measuredAttention: { status: 'UNKNOWN', shares: [] },
    leadershipScreening: { rationale: 'The bounded public sample does not establish measured leadership.' },
  });
  setFeature('A18', false);
  assessment('A18', { method: 'entry-evidence-gate-v1', reason: 'The complete sample lacks the required public support.' });
  setFeature('S10', false);
  snapshot.details!.social = {
    version: 'social-policy-v1', method: 'social-source-review-v1', token: TOKEN,
    start: '2026-09-29T11:00:00.000Z', end: '2026-09-29T11:59:00.000Z', availableAt: CUTOFF, evidenceIds: [],
    postCorpusObserved: true, sampleComplete: true, lineageComplete: true, qualifiedOriginalCount: 2,
    accountUpperBound: 2, independentGroupCount: 1, independentCommunityCount: 1,
    identityReview: { method: 'source-transparency-review-v1', verdict: 'CONTRADICTED', rationale: 'The retained historical judgment has no typed basis.',
      citations: [{ sourceId: 'historical-profile', quote: 'Retained profile record without a typed outcome basis.' }], missingIndicators: [] },
  };

  const before = JSON.stringify(snapshot);
  const report = buildEntryReport(snapshot);
  const rows = new Map(report.checks.map(row => [row.checkId, row]));
  assert.equal(report.method, 'entry-outcomes-v1');
  assert.equal(report.checks.length, 33, 'the normalized report contains all 33 policy-required rows');
  assert.equal(rows.get('NAR-02')?.policyStatus, 'FAIL');
  assert.deepEqual([rows.get('NAR-02')?.outcome, rows.get('NAR-02')?.basis], ['INSUFFICIENT', 'PUBLIC_SUPPORT_INADEQUATE']);
  assert.equal(rows.get('CAN-02')?.outcome, 'INSUFFICIENT', 'factual origin and attention UNKNOWN do not become false leadership facts');
  assert.equal(rows.get('ATT-02')?.outcome, 'INSUFFICIENT', 'one support-shortfall branch plus one factual shortfall remains an insufficient compound outcome');
  assert.deepEqual([rows.get('DAT-03')?.outcome, rows.get('DAT-03')?.basis], ['UNKNOWN', 'EVALUATION_INCOMPLETE'],
    'a failed policy row without a completed audit remains an unresolved evaluation');
  assert.deepEqual([rows.get('SOC-01')?.outcome, rows.get('SOC-01')?.basis], ['UNKNOWN', 'LEGACY_NEGATIVE_BASIS_UNSPECIFIED'],
    'legacy overloaded social negatives are not inferred from their prose');
  assert.deepEqual([rows.get('ADV-02')?.outcome, rows.get('ADV-02')?.basis], ['CONTRADICTED', 'FACTUAL_COUNTEREVIDENCE'],
    'a completed direct activity predicate remains an affirmative factual contradiction');

  const sum = (key: 'supported' | 'contradicted' | 'insufficient' | 'unknown' | 'total') =>
    Object.values(report.pillars).reduce((total, pillar) => total + pillar[key], 0);
  assert.equal(sum('total'), 33);
  assert.deepEqual([sum('supported'), sum('contradicted'), sum('insufficient'), sum('unknown')], [27, 1, 3, 2]);
  assert.deepEqual(report.coverage, { known: 31, total: 33 });
  assert.deepEqual(report.policyCoverage, { known: 33, total: 33 }, 'historical policy coverage is retained separately');
  assert.ok(report.auxiliaryFacts.every(fact => fact.outcome === 'UNKNOWN'));
  assert.ok(report.auxiliaryFacts.some(fact => fact.id === 'A14:originRelationship'));
  assert.ok(report.auxiliaryFacts.some(fact => fact.id === 'A14:measuredAttention'));
  assert.ok(report.auxiliaryFacts.some(fact => fact.id === 'stage:tokenCreatedAt'));

  const explained = new Map(explainChecks(snapshot).map(row => [row.checkId, row]));
  assert.deepEqual([explained.get('NAR-02')?.status, explained.get('NAR-02')?.policyStatus,
    explained.get('NAR-02')?.outcome], ['FAIL', 'FAIL', 'INSUFFICIENT']);
  const detail = renderSnapshot(snapshot, { check: 'NAR-02' });
  assert.match(detail, /^NAR-02 Origin and catalyst: INSUFFICIENT/);
  const checklist = renderSnapshot(snapshot, { checklist: true });
  assert.match(checklist, /All checklist UNKNOWN rows: 2 \(2 required;/);
  assert.match(checklist, /INSUFFICIENT\s+NAR-02 Origin and catalyst/);
  assert.equal(JSON.stringify(snapshot), before, 'report construction, explanation, and rendering do not mutate the frozen snapshot');

  const freshSocial = allRequiredReportSnapshot();
  const socialCheck = freshSocial.result.checks.find(item => item.checkId === 'SOC-01')!;
  socialCheck.status = 'FAIL';
  freshSocial.details!.social = {
    ...snapshot.details!.social!, outcomeBasisMethod: 'entry-outcome-basis-v1',
    identityReview: {
      method: 'source-transparency-review-v1', verdict: 'CONTRADICTED', negativeBasis: 'PUBLIC_SUPPORT_INADEQUATE',
      rationale: 'The completed review lacks independent exact-token identity support.',
      citations: [{ sourceId: 'public-profile', quote: 'Public profile record for the named account.' }], missingIndicators: [],
    },
  };
  const freshSocialRow = buildEntryReport(freshSocial).checks.find(row => row.checkId === 'SOC-01');
  assert.deepEqual([freshSocialRow?.policyStatus, freshSocialRow?.outcome, freshSocialRow?.basis],
    ['FAIL', 'INSUFFICIENT', 'PUBLIC_SUPPORT_INADEQUATE']);
});

test('fresh origin report mirrors the selected NAR-02 decision and refuses stale or future provenance', () => {
  const makeReport = (decision?: OriginDecision, availableAt = CUTOFF, quality: 'KNOWN' | 'STALE' | 'MISSING' = 'KNOWN') => {
    const snapshot = allRequiredReportSnapshot();
    const a03 = snapshot.features.find(feature => feature.id === 'A03')!;
    const a04 = snapshot.features.find(feature => feature.id === 'A04')!;
    a04.value = null;
    a04.quality = 'MISSING';
    a04.applicability = 'UNRESOLVED';
    const owner = freshOriginAssessment({
      evidenceIds: a03.evidenceIds,
      citation: { sourceId: 'origin-source', quote: 'A dated original project source identifies this exact token relationship.' },
      availableAt,
      start: '2026-09-29T11:00:00.000Z',
      end: CUTOFF,
      decision,
      quality,
    });
    snapshot.details!.baseline = [owner];
    const resolution = resolveOriginEntryCriterion(snapshot.details!.baseline)!;
    snapshot.result = evaluateEntry(snapshot.features, snapshot.details!.profile, snapshot.cutoff,
      'QUALIFIED_V4', undefined, false, undefined, { originResolution: resolution }, snapshot.details!.groups);
    return { snapshot, report: buildEntryReport(snapshot) };
  };
  const pass = makeReport({ verdict: 'PASS', rationale: 'The qualified original source supports the bounded origin relationship.' });
  const passRow = pass.report.checks.find(row => row.checkId === 'NAR-02')!;
  assert.equal(passRow.policyStatus, 'PASS');
  assert.equal(passRow.outcome, 'SUPPORTED');
  assert.deepEqual(passRow.featureRefs, ['A03']);
  assert.equal(pass.snapshot.features.find(feature => feature.id === 'A04')?.value, null);
  assert.match(renderSnapshot(pass.snapshot), /Entry evidence NAR-02: SUPPORTED — The qualified original source supports the bounded origin relationship\./);

  const insufficient = makeReport({ verdict: 'FAIL', negativeBasis: 'PUBLIC_SUPPORT_INADEQUATE', rationale: 'The completed public review lacks the required primary relationship support.' });
  assert.equal(insufficient.report.checks.find(row => row.checkId === 'NAR-02')?.outcome, 'INSUFFICIENT');
  const counterevidence = makeReport({ verdict: 'FAIL', negativeBasis: 'FACTUAL_COUNTEREVIDENCE', rationale: 'A qualified primary source directly contradicts this origin relationship.' });
  assert.equal(counterevidence.report.checks.find(row => row.checkId === 'NAR-02')?.outcome, 'CONTRADICTED');

  const stale = makeReport({ verdict: 'PASS', rationale: 'The qualified original source supports the bounded origin relationship.' }, CUTOFF, 'STALE');
  assert.equal(stale.report.checks.find(row => row.checkId === 'NAR-02')?.policyStatus, 'UNKNOWN');
  assert.equal(stale.report.checks.find(row => row.checkId === 'NAR-02')?.outcome, 'UNKNOWN');
  const future = makeReport({ verdict: 'PASS', rationale: 'The qualified original source supports the bounded origin relationship.' }, '2026-09-29T12:01:00.000Z');
  assert.equal(future.report.checks.find(row => row.checkId === 'NAR-02')?.policyStatus, 'UNKNOWN');
  assert.equal(future.report.checks.find(row => row.checkId === 'NAR-02')?.outcome, 'UNKNOWN');
  assert.match(renderSnapshot(future.snapshot), /Entry evidence NAR-02: UNKNOWN — The recorded decision is not usable at this cutoff\./);
});

test('ADV-03 combines production-derived narrative and sample outcomes with unknown precedence', () => {
  const belowThreshold = attentionReportSnapshot({ kind: 'MEASURED', posts: '1', accounts: '1' });
  const belowGroup = belowThreshold.details!.groups!.groups.find(group => group.checkId === 'ADV-03')!;
  assert.equal(belowGroup.status, 'FAIL');
  assert.deepEqual([belowGroup.metrics.qualifiedOriginals, belowGroup.metrics.sourceAccounts], ['1', '1']);
  assert.equal(belowThreshold.result.checks.find(row => row.checkId === 'ADV-03')?.status, 'FAIL');
  const beforeBelow = JSON.stringify(belowThreshold);
  const belowReport = buildEntryReport(belowThreshold);
  assert.deepEqual([belowReport.checks.find(row => row.checkId === 'ADV-03')?.outcome,
    belowReport.checks.find(row => row.checkId === 'ADV-03')?.basis], ['CONTRADICTED', 'FACTUAL_COUNTEREVIDENCE']);
  assertReportProjection(belowThreshold, 'CONTRADICTED');
  assert.equal(JSON.stringify(belowThreshold), beforeBelow);

  const unfinished = attentionReportSnapshot({ kind: 'UNFINISHED' });
  const unfinishedGroup = unfinished.details!.groups!.groups.find(group => group.checkId === 'ADV-03')!;
  assert.equal(unfinishedGroup.status, 'FAIL', 'the known narrative support shortfall keeps the frozen group policy failure');
  assert.deepEqual([unfinishedGroup.metrics.qualifiedOriginals, unfinishedGroup.metrics.sourceAccounts], [null, null]);
  const unfinishedRow = buildEntryReport(unfinished).checks.find(row => row.checkId === 'ADV-03')!;
  assert.deepEqual([unfinishedRow.policyStatus, unfinishedRow.outcome, unfinishedRow.basis],
    ['FAIL', 'UNKNOWN', 'EVALUATION_INCOMPLETE']);
  assertReportProjection(unfinished, 'UNKNOWN');

  const exactThreshold = attentionReportSnapshot({ kind: 'MEASURED', posts: '3', accounts: '3' });
  const exactGroup = exactThreshold.details!.groups!.groups.find(group => group.checkId === 'ADV-03')!;
  assert.equal(exactGroup.status, 'FAIL', 'the inadequate narrative still fails the combined screen');
  assert.deepEqual([exactGroup.metrics.qualifiedOriginals, exactGroup.metrics.sourceAccounts], ['3', '3']);
  const exactRow = buildEntryReport(exactThreshold).checks.find(row => row.checkId === 'ADV-03')!;
  assert.deepEqual([exactRow.outcome, exactRow.basis], ['INSUFFICIENT', 'PUBLIC_SUPPORT_INADEQUATE'],
    'meeting both measured sample thresholds does not erase the independent narrative support shortfall');
  assertReportProjection(exactThreshold, 'INSUFFICIENT');

  const supportedBoundary = attentionReportSnapshot({ kind: 'MEASURED', posts: '3', accounts: '3' }, false);
  const supportedGroup = supportedBoundary.details!.groups!.groups.find(group => group.checkId === 'ADV-03')!;
  assert.equal(supportedGroup.status, 'PASS', 'exactly three qualified originals and three accounts meet the producer threshold');
  assert.deepEqual([supportedGroup.metrics.qualifiedOriginals, supportedGroup.metrics.sourceAccounts], ['3', '3']);
  assertReportProjection(supportedBoundary, 'SUPPORTED');

  const completedGate = attentionReportSnapshot({ kind: 'CLOSED_GAP' });
  const completedGateGroup = completedGate.details!.groups!.groups.find(group => group.checkId === 'ADV-03')!;
  assert.equal(completedGateGroup.status, 'FAIL');
  assert.deepEqual([completedGateGroup.metrics.qualifiedOriginals, completedGateGroup.metrics.sourceAccounts], [null, null]);
  const completedGateRow = buildEntryReport(completedGate).checks.find(row => row.checkId === 'ADV-03')!;
  assert.deepEqual([completedGateRow.policyStatus, completedGateRow.outcome, completedGateRow.basis],
    ['FAIL', 'INSUFFICIENT', 'PUBLIC_SUPPORT_INADEQUATE'],
    'a completed reviewed gate with no exact counts is inadequate support, not an unfinished judgment');
  assertReportProjection(completedGate, 'INSUFFICIENT');
});

test('a qualified same-subject observation conflict is contradictory even when the semantic conflict audit is unfinished', () => {
  const sharedInput = sharedFixture();
  sharedInput.qualityMode = 'ENTRY_GATES_V1';
  sharedInput.audit = null;
  sharedInput.observations = [
    { id: 'obs-supply-a', subject: SHARED_TOKEN, field: 'supply', value: '100', unit: 'token',
      evidenceIds: ['feature-evidence-O01'], observedAt: SHARED_CUTOFF, availableAt: SHARED_CUTOFF, quality: 'KNOWN' },
    { id: 'obs-supply-b', subject: SHARED_TOKEN, field: 'supply', value: '99', unit: 'token',
      evidenceIds: ['feature-evidence-O02'], observedAt: SHARED_CUTOFF, availableAt: SHARED_CUTOFF, quality: 'KNOWN' },
  ];
  const shared = deriveShared(sharedInput).facts;
  assert.equal(shared.auditQualified, false);
  assert.equal(shared.values.C06, false, 'the required policy gate remains failed');
  assert.equal(shared.conflicts.length, 1, 'both values are qualified for the same subject, field, unit, and instant');

  const snapshot = allRequiredReportSnapshot();
  snapshot.result.checks.find(row => row.checkId === 'DAT-03')!.status = 'FAIL';
  snapshot.details!.shared = shared;
  const check = buildEntryReport(snapshot).checks.find(row => row.checkId === 'DAT-03')!;
  assert.deepEqual([check.policyStatus, check.outcome, check.basis], ['FAIL', 'CONTRADICTED', 'FACTUAL_COUNTEREVIDENCE']);
});

test('v4 completed uncertain Shared review reports DAT-03 as insufficient rather than contradictory', () => {
  const sharedInput = sharedFixture();
  sharedInput.qualityMode = 'ENTRY_GATES_V1';
  sharedInput.completionMethod = 'reviewed-audit-completion-v1';
  sharedInput.sourceInspectionMethod = 'acquired-text-inspection-v1';
  sharedInput.decisionMethod = 'independent-final-dispositions-v1';
  const uncertain = sharedInput.claims[0]!;
  sharedInput.audit = {
    decisionMethod: sharedInput.decisionMethod,
    claims: sharedInput.claims.map(claim => ({
      id: claim.id,
      disposition: claim.id === uncertain.id ? 'UNCLEAR' : 'CLEAR',
      rationale: claim.id === uncertain.id
        ? 'The fully inspected retained sources do not resolve this claim.'
        : 'The fully inspected retained sources show no incompatible assertion.',
      citations: claim.citations,
    })),
    review: sharedInput.claims.map(claim => ({ id: claim.id, accepted: false })),
    sources: sharedInput.sources.map(source => ({ id: source.id, complete: true })),
  };
  const shared = deriveShared(sharedInput).facts;
  const snapshot = allRequiredReportSnapshot();
  snapshot.result.checks.find(row => row.checkId === 'DAT-03')!.status = 'FAIL';
  snapshot.details!.shared = shared;

  const check = buildEntryReport(snapshot).checks.find(row => row.checkId === 'DAT-03')!;
  assert.deepEqual([check.policyStatus, check.outcome, check.basis], ['FAIL', 'INSUFFICIENT', 'PUBLIC_SUPPORT_INADEQUATE']);
  assert.equal(shared.auditCompleted, true);
  assert.deepEqual(shared.conflicts, []);
});

test('entry summary counts every UNKNOWN row while preserving required coverage and the legacy single-row explanation', () => {
  const snapshot = sampleSnapshot();
  const excludedRows: Array<{ checkId: string; pillar: 'ONCHAIN' | 'ATTENTION' | 'SOCIAL' | 'SHARED' }> = [
    { checkId: 'EXE-03', pillar: 'ONCHAIN' },
    { checkId: 'ADV-01', pillar: 'ONCHAIN' },
    { checkId: 'ADV-02', pillar: 'ONCHAIN' },
    { checkId: 'ADV-03', pillar: 'ATTENTION' },
    { checkId: 'ADV-04', pillar: 'SOCIAL' },
    { checkId: 'ADV-05', pillar: 'SHARED' },
  ];
  snapshot.result.checks.push(...excludedRows.map(({ checkId, pillar }) => ({
    checkId, checklistKind: 'ENTRY' as const, role: 'ADVISORY' as const, pillar, required: false,
    status: 'UNKNOWN' as const, reasonCode: 'FEATURE_UNKNOWN', featureRefs: [], evidenceRefs: [],
  })));
  const before = { ...snapshot.result, coverage: { ...snapshot.result.coverage } };

  const summary = renderSnapshot(snapshot);
  assert.match(summary, /Required decisions resolved: 0\/1/);
  assert.match(summary, /All checklist UNKNOWN rows: 7 \(1 required; 6 outside required coverage\)\./);
  assert.match(summary, /Entry checklist:/);
  assert.doesNotMatch(summary, /ADV-0[1-5]/, 'the ordinary checklist still omits advisory rows');
  assert.equal(snapshot.result.binary, before.binary);
  assert.equal(snapshot.result.classification, before.classification);
  assert.deepEqual(snapshot.result.coverage, before.coverage);

  const expanded = renderSnapshot(snapshot, { checklist: true });
  assert.match(expanded, /ADV-\* groups are outside the current required manifest and pillar totals/);
  for (const { checkId } of excludedRows.filter(row => row.checkId.startsWith('ADV-'))) assert.match(expanded, new RegExp(checkId));

  const single = renderSnapshot(snapshot, { check: 'ID-01' });
  assert.match(single, /^ID-01 Token identity: UNKNOWN/);
  assert.doesNotMatch(single, /All checklist UNKNOWN rows|ADV-\*/,
    'the concise single-row explanation remains independent of optional checklist totals');
});

test('new entry-group report shows all required rows and explains current group evidence without the legacy advisory legend', () => {
  const snapshot = sampleSnapshot();
  const ids = ['ADV-01','ADV-02','ADV-03','ADV-04','ADV-05'] as const;
  const groups: EntryGroupFacts = {
    method: 'mandatory-entry-groups-v1', token: snapshot.token!, cutoff: snapshot.cutoff,
    groups: ids.map((checkId, index) => ({
      checkId, status: index === 4 ? 'UNKNOWN' : 'PASS', rationale: `${checkId} evaluates the current declared criterion and bounded source window.`,
      code: `${checkId}_CURRENT_SCREEN`, featureIds: [`${checkId}-current-feature`], evidenceIds: [`${checkId}-current-evidence`],
      availableAt: snapshot.cutoff, metrics: index === 0 ? { ownerClusters: 8, topShare: '0.24' } : {},
      limitations: ['Prior-day history was not observed and is not required.'],
    })),
  };
  snapshot.details!.groups = groups;
  snapshot.features = completeFixtureEntryFeatures();
  snapshot.result = evaluateEntry(snapshot.features, illustrativeUncalibratedProfile, snapshot.cutoff,
    'LEGACY', undefined, false, undefined, undefined, groups);

  const summary = renderSnapshot(snapshot);
  assert.match(summary, /Required decisions resolved: 32\/33/);
  for (const id of ids) assert.match(summary, new RegExp(id), `${id} is visible in the ordinary required checklist`);
  assert.match(summary, /All five entry groups are required in this policy/);
  assert.match(summary, /ADV-01 evaluates the current declared criterion/);
  assert.doesNotMatch(summary, /ADV-\* groups are outside the current required manifest/);

  const explanation = renderSnapshot(snapshot, { check: 'ADV-01' });
  assert.match(explanation, /Current group criterion: ADV-01 evaluates the current declared criterion/);
  assert.match(explanation, /Current metrics: ownerClusters=8; topShare="0\.24"/);
  assert.match(explanation, /Limitation: Prior-day history was not observed and is not required/);

  const unknown = renderSnapshot(snapshot, { check: 'ADV-05' });
  assert.match(unknown, /UNKNOWN \(DATA\)/);
  assert.match(unknown, /ADV-05_CURRENT_SCREEN: ADV-05 evaluates the current declared criterion/);
  assert.doesNotMatch(unknown, /FEATURE_ABSENT|unimplemented collector/i);
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
  assert.match(rendered, /Factual origin relationship: SUPPORTED/);
  assert.match(rendered, /Factual measured attention leadership: UNKNOWN/);
  assert.match(rendered, /CAN-02 basis: origin-supported representation/);
  assert.doesNotMatch(rendered, /Factual origin relationship: SUPPORTED[^\n]*Factual measured attention leadership: SUPPORTED/);
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

test('persistent Pump quote rejection reports only the execution-cost judgment', () => {
  const snapshot = sampleSnapshot();
  snapshot.details!.baseline.push({
    id: 'O16', version: 'baseline-v1', evaluator: 'IMPLEMENTED', collector: 'IMPLEMENTED',
    quality: 'KNOWN', unit: 'bool',
    data: { method: 'pump-budget-rejection-v1', code: 'PUMP_SIMULATION_SLIPPAGE' },
    observationIds: [], evidenceIds: [], limitations: [], causes: [],
    projection: { id: 'O16', value: false, unit: 'bool', quality: 'KNOWN', availableAt: CUTOFF, evidenceIds: [], applicability: 'APPLICABLE' },
  });

  const rendered = renderSnapshot(snapshot);
  assert.match(rendered, /both unsigned buys exceeded their exact quoted spending limit/);
  assert.match(rendered, /entry execution-cost standard was not met/);
  assert.match(rendered, /fees, sellability and fraud are not established/);
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
    participationReview: {
      verdict: 'CONTRADICTED', rationale: 'The reviewed public sample does not establish the participation threshold.',
      citations: [{ sourceId: 'social-post', quote: 'The collected source shows a bounded public post sample.' }],
      method: 'source-transparency-review-v1', missingIndicators: [],
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
  assert.match(identityExplanation, /Public-evidence review: UNKNOWN/);
  assert.match(identityExplanation, /neither label alone proves impersonation/i);
  assert.doesNotMatch(identityExplanation, /fraud|bots|manipulation/i);
  const integrityExplanation = renderSnapshot(snapshot, { check: 'SOC-02' });
  assert.match(integrityExplanation, /Public-evidence review: UNKNOWN/);
  assert.match(integrityExplanation, /Desired indicators unavailable: ACCOUNT_HISTORY, ENGAGEMENT, COMPARABLE_HISTORY/);
  assert.match(integrityExplanation, /visibility risks, not proof of fraud, bots or manipulation/);
  assert.match(renderSnapshot(snapshot), /entry evidence reviewed; exact participation counts remain unqualified/,
    'a completed adverse participation judgment is not reported as an incomplete collection scope');

  const legacy = structuredClone(snapshot);
  delete legacy.details!.social;
  const legacyNames = explainChecks(legacy).find(row => row.checkId === 'SOC-02')?.values.map(row => row.name);
  assert.deepEqual(legacyNames, ['S04', 'S05'].map(id => featureMetadata.find(row => row.id === id)?.name ?? id));
});

test('live report projects only consumed attention/social outages and preserves the four-state outcomes', () => {
  const setMissingFeature = (snapshot: EntrySnapshot, id: string) => {
    const feature = snapshot.features.find(item => item.id === id);
    assert.ok(feature, `the report fixture includes ${id}`);
    feature.value = null;
    feature.quality = 'MISSING';
  };
  const setUnknownRow = (snapshot: EntrySnapshot, checkId: string, featureRefs?: string[]) => {
    const row = snapshot.result.checks.find(item => item.checkId === checkId);
    assert.ok(row, `the report fixture includes ${checkId}`);
    row.status = 'UNKNOWN';
    row.reasonCode = 'FEATURE_UNKNOWN';
    if (featureRefs) row.featureRefs = featureRefs;
  };
  const addAssessment = (snapshot: EntrySnapshot, id: string, codes: string[]) => {
    snapshot.details!.baseline.push({
      id, version: 'baseline-v1', evaluator: 'IMPLEMENTED', collector: 'IMPLEMENTED', quality: 'MISSING', unit: 'bool',
      data: { ...(id === 'A14' ? { method: 'representation-routes-v2' } : {}), codes },
      observationIds: [], evidenceIds: [`${id.toLowerCase()}-scope`], limitations: [],
      causes: codes.map(code => ({ category: 'EVIDENCE_UNAVAILABLE' as const, code, featureId: id,
        evidenceIds: [`${id.toLowerCase()}-scope`], action: `Retry the unfinished ${id} source operation.` })),
    });
  };
  const setPhases = (snapshot: EntrySnapshot, attention: { status: string; code?: string }, social: { status: string; code?: string }) => {
    const stages = [
      { phase: 'PREFLIGHT', status: 'COMPLETED' },
      { phase: 'ATTENTION', ...attention },
      { phase: 'SOCIAL', ...social },
      { phase: 'SHARED', status: 'COMPLETED' },
      { phase: 'FINALIZE', status: 'COMPLETED' },
    ];
    const projection: EvidenceRecord = {
      id: 'live-run-scope', sourceId: 'live-orchestrator', sourceType: 'SAMPLE_SCOPE', retrievedAt: CUTOFF,
      availableAt: CUTOFF, contentHash: 'c'.repeat(64), adapterVersion: 'live-v1', accessMode: 'LOCAL_DERIVED',
      scope: { completionMethod: 'entry-completion-v1', stages },
    };
    const existing = snapshot.evidence.findIndex(item => item.id === projection.id);
    if (existing < 0) snapshot.evidence.push(projection);
    else snapshot.evidence[existing] = projection;
  };

  const outage = allRequiredReportSnapshot();
  setMissingFeature(outage, 'A14');
  setUnknownRow(outage, 'CAN-02', ['A14']);
  addAssessment(outage, 'A14', ['TARGET_EMPTY', 'ATT_MODEL_HTTP_503']);
  setPhases(outage, { status: 'FAILED', code: 'ATT_MODEL_HTTP_503' }, { status: 'COMPLETED' });
  const frozenBefore = JSON.stringify(outage);
  const report = buildEntryReport(outage);
  const row = report.checks.find(item => item.checkId === 'CAN-02')!;
  const codes = row.causes.map(cause => cause.code);
  assert.deepEqual([row.policyStatus, row.outcome, row.unknownKind], ['UNKNOWN', 'UNKNOWN', 'INFRA']);
  assert.ok(codes.includes('ATT_MODEL_HTTP_503'), 'the relevant final ATTENTION attempt remains visible');
  assert.ok(codes.includes('TARGET_EMPTY'), 'the consumed acquisition gap remains visible beside the model outage');
  assert.equal(report.completion.blockers.find(blocker => blocker.checkId === 'CAN-02')?.code, 'ATT_MODEL_HTTP_503',
    'the actionable terminal model cause leads the row blocker');
  const explained = explainChecks(outage).find(item => item.checkId === 'CAN-02')!;
  assert.deepEqual([explained.outcome, explained.unknownKind, explained.causes.map(cause => cause.code)], ['UNKNOWN', 'INFRA', codes]);
  assert.match(renderSnapshot(outage, { check: 'CAN-02' }), /^CAN-02 .*UNKNOWN \(INFRA\)/);
  assert.match(renderSnapshot(outage, { checklist: true }), /UNKNOWN \(INFRA\)\s+CAN-02/);
  assert.deepEqual(JSON.parse(JSON.stringify(buildEntryReport(JSON.parse(JSON.stringify(outage)) as EntrySnapshot))),
    JSON.parse(JSON.stringify(report)), 'JSON round-trip report projection retains the same causal interpretation');
  assert.equal(JSON.stringify(outage), frozenBefore, 'current cause recovery does not rewrite the frozen input snapshot');

  const collectionOnly = structuredClone(outage);
  const collectionAssessment = collectionOnly.details!.baseline.find(item => item.id === 'A14')!;
  collectionAssessment.data = { method: 'representation-routes-v2', codes: ['TARGET_EMPTY'] };
  collectionAssessment.causes = collectionAssessment.causes.filter(cause => cause.code === 'TARGET_EMPTY');
  collectionOnly.evidence.pop();
  setPhases(collectionOnly, { status: 'COMPLETED' }, { status: 'FAILED', code: 'SOC_MODEL_HTTP_503' });
  setMissingFeature(collectionOnly, 'S01');
  setUnknownRow(collectionOnly, 'SOC-01', ['S01']);
  addAssessment(collectionOnly, 'S01', ['SOC_MODEL_HTTP_503']);
  const collectionReport = buildEntryReport(collectionOnly);
  const collectionRow = collectionReport.checks.find(item => item.checkId === 'CAN-02')!;
  assert.equal(collectionRow.unknownKind, 'COLLECTION', 'TARGET_EMPTY alone is a collection gap');
  assert.deepEqual(collectionRow.causes.map(cause => cause.code), ['TARGET_EMPTY'],
    'a failed Social phase does not become an unrelated CAN-02 cause');
  assert.equal(collectionReport.checks.find(item => item.checkId === 'SOC-01')?.unknownKind, 'INFRA',
    'the same actual Social outage remains visible on its owned unresolved row');

  const downstream = structuredClone(outage);
  setMissingFeature(downstream, 'S01');
  setUnknownRow(downstream, 'SOC-01', ['S01']);
  addAssessment(downstream, 'S01', ['SOC_MODEL_HTTP_503']);
  const shared = deriveShared(sharedFixture()).facts;
  downstream.details!.shared = { ...shared, unresolved: ['CAN-02'] };
  setUnknownRow(downstream, 'DAT-01');
  setPhases(downstream, { status: 'FAILED', code: 'ATT_MODEL_HTTP_503' }, { status: 'FAILED', code: 'SOC_MODEL_HTTP_503' });
  const downstreamRow = buildEntryReport(downstream).checks.find(item => item.checkId === 'DAT-01')!;
  assert.equal(downstreamRow.unknownKind, 'INFRA');
  assert.ok(downstreamRow.causes.some(cause => cause.code === 'ATT_MODEL_HTTP_503'),
    'DAT-01 follows its actual unresolved Shared witness CAN-02');
  assert.ok(!downstreamRow.causes.some(cause => cause.code === 'SOC_MODEL_HTTP_503'),
    'an unrelated Social failure is not propagated through the Shared report');

  const attentionOr = allRequiredReportSnapshot();
  setMissingFeature(attentionOr, 'A18');
  attentionOr.features.find(item => item.id === 'S10')!.value = true;
  attentionOr.features.find(item => item.id === 'S10')!.quality = 'KNOWN';
  attentionOr.result.checks.find(item => item.checkId === 'ATT-02')!.status = 'FAIL';
  attentionOr.details!.baseline.push({
    id: 'A18', version: 'baseline-v1', evaluator: 'IMPLEMENTED', collector: 'IMPLEMENTED', quality: 'MISSING', unit: 'bool',
    data: { codes: ['ATT_MODEL_HTTP_503'] }, observationIds: [], evidenceIds: [], limitations: [], causes: [],
  });
  setPhases(attentionOr, { status: 'FAILED', code: 'ATT_MODEL_HTTP_503' }, { status: 'FAILED', code: 'SOC_MODEL_HTTP_503' });
  const attentionOrRow = buildEntryReport(attentionOr).checks.find(item => item.checkId === 'ATT-02')!;
  assert.deepEqual([attentionOrRow.policyStatus, attentionOrRow.outcome, attentionOrRow.unknownKind], ['FAIL', 'SUPPORTED', null],
    'a supported community-breadth OR route does not inherit an irrelevant attention outage');
  assert.deepEqual(attentionOrRow.causes, []);
});

test('unknown kinds come from each row’s causal code and render alongside UNKNOWN status', () => {
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

  const typedCauses = [
    ['INFRA', 'EVIDENCE_UNAVAILABLE', 'SOC_SEARCH_HTTP_503'],
    ['INFRA', 'EVIDENCE_UNAVAILABLE', 'LIVE_PHASE_DEADLINE'],
    ['INFRA', 'EVIDENCE_UNAVAILABLE', 'LIVE_HARD_DEADLINE'],
    ['INFRA', 'EVIDENCE_UNAVAILABLE', 'LIVE_CALLER_CANCELLED'],
    ['INFRA', 'EVIDENCE_UNAVAILABLE', 'LIVE_OPERATION_LIMIT'],
    ['INFRA', 'EVIDENCE_UNAVAILABLE', 'LIVE_DEPENDENCY_SKIPPED'],
    ['COLLECTION', 'EVIDENCE_UNAVAILABLE', 'TARGET_EMPTY'],
    ['COLLECTION', 'EVIDENCE_UNAVAILABLE', 'TARGET_BLOCKED'],
    ['COLLECTION', 'EVIDENCE_UNAVAILABLE', 'SOC_TEXT_CAP'],
    ['MODEL', 'CLAIM_UNVALIDATED', 'SOC_REVIEW_INVALID'],
    ['IMPLEMENTATION', 'COLLECTION_UNIMPLEMENTED', 'SOC_COLLECTOR_UNIMPLEMENTED'],
    ['INPUT', 'USER_INPUT_MISSING', 'SOC_PROFILE_FIELD_MISSING'],
    ['EXECUTION', 'EVIDENCE_UNAVAILABLE', 'PUMP_SIMULATION_SLIPPAGE'],
    ['EXECUTION', 'EVIDENCE_UNAVAILABLE', 'DAMM_SIMULATION_REJECTED'],
    ['EXECUTION', 'EVIDENCE_UNAVAILABLE', 'DAMM_TRANSACTION_COSTS_UNAVAILABLE'],
    ['DATA', 'EVIDENCE_UNAVAILABLE', 'SOC_PUBLIC_RECORD_MISSING'],
  ] as const;
  for (const [kind, category, code] of typedCauses) {
    const id = `CAUSE_${kind}`;
    snapshot.details!.baseline.push({
      id, version: 'baseline-v1', evaluator: 'IMPLEMENTED', collector: 'IMPLEMENTED', quality: 'MISSING', unit: 'bool', data: null,
      observationIds: [], evidenceIds: [], limitations: [],
      causes: [{ category, code, featureId: id, evidenceIds: [], action: `Resolve ${code} using its supported workflow.` }],
    });
    snapshot.result.checks.push({
      checkId: `ROW-${kind}`, checklistKind: 'ENTRY', role: 'REQUIRED_EVIDENCE', pillar: 'SOCIAL', required: true,
      status: 'UNKNOWN', reasonCode: 'FEATURE_UNKNOWN', featureRefs: [id], evidenceRefs: [],
    });
  }
  const rows = new Map(explainChecks(snapshot).map(row => [row.checkId, row]));
  for (const [kind] of typedCauses) assert.equal(rows.get(`ROW-${kind}`)?.unknownKind, kind);
  for (const id of ['ADV01', 'OWN01', 'OWN02']) {
    snapshot.details!.baseline.push({
      id, version: 'baseline-v1', evaluator: 'IMPLEMENTED', collector: 'IMPLEMENTED', quality: 'MISSING', unit: 'bool', data: null,
      observationIds: [], evidenceIds: [], limitations: [],
      causes: [{ category: 'EVIDENCE_UNAVAILABLE', code: 'RPC_REMOTE_-32016', featureId: id, evidenceIds: [],
        action: 'Retry the finalized read after the node reaches the requested minimum context slot.' }],
    });
    snapshot.result.checks.push({ checkId: `ROW-${id}`, checklistKind: 'ENTRY', role: 'REQUIRED_EVIDENCE', pillar: 'ONCHAIN',
      required: true, status: 'UNKNOWN', reasonCode: 'FEATURE_UNKNOWN', featureRefs: [id], evidenceRefs: [] });
  }
  const rpcRows = new Map(explainChecks(snapshot).map(row => [row.checkId, row]));
  for (const id of ['ADV01', 'OWN01', 'OWN02']) assert.equal(rpcRows.get(`ROW-${id}`)?.unknownKind, 'INFRA');
  assert.equal(rpcRows.get('ROW-DATA')?.unknownKind, 'DATA', 'ordinary missing public records remain data gaps');
  const rendered = renderSnapshot(snapshot);
  for (const [kind] of typedCauses) assert.match(rendered, new RegExp(`UNKNOWN \\(${kind}\\)\\s+ROW-${kind}`));
  for (const id of ['ADV01', 'OWN01', 'OWN02']) assert.match(rendered, new RegExp(`UNKNOWN \\(INFRA\\)\\s+ROW-${id}`));
});
