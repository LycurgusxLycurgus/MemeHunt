import assert from 'node:assert/strict';
import test from 'node:test';
import { completeFixtureEntryFeatures, illustrativeUncalibratedProfile } from '../examples/fixtures.js';
import { evaluateEntry } from '../src/domain/policy.js';
import type { SocialPolicyFacts } from '../src/domain/contracts.js';
import { SOCIAL_AVAILABLE, SOCIAL_CUTOFF, SOCIAL_END, SOCIAL_START, SOCIAL_TOKEN } from './social-fixtures.js';

function facts(overrides: Partial<SocialPolicyFacts> = {}): SocialPolicyFacts {
  return {
    version: 'social-policy-v1', method: 'social-source-review-v1', token: SOCIAL_TOKEN,
    start: SOCIAL_START, end: SOCIAL_END, availableAt: SOCIAL_AVAILABLE, evidenceIds: ['synthetic-social-proof'],
    postCorpusObserved: true, sampleComplete: true, lineageComplete: true,
    qualifiedOriginalCount: 6, accountUpperBound: 3, independentGroupCount: 2, independentCommunityCount: 2,
    ...overrides,
  };
}

function status(features: ReturnType<typeof completeFixtureEntryFeatures>, checkId: string, policy: 'QUALIFIED_V2' | 'QUALIFIED_V3' | 'QUALIFIED_V4', social?: SocialPolicyFacts) {
  const result = evaluateEntry(features, illustrativeUncalibratedProfile, SOCIAL_CUTOFF, policy, social);
  const row = result.checks.find(check => check.checkId === checkId);
  assert.ok(row, `missing ${checkId}`);
  return { row, result };
}

function qualifiedJudgment(verdict: 'SUPPORTED' | 'CONTRADICTED' | 'UNRESOLVED', missingIndicators: Array<'ACCOUNT_HISTORY' | 'ENGAGEMENT' | 'COMPARABLE_HISTORY'> = []) {
  return {
    verdict, rationale: 'The independent reviewer assessed the bounded source record and its specific omissions.',
    citations: [{ sourceId: 'synthetic-social-proof', quote: 'The retained public source supports this exact bounded judgment.' }],
    method: 'source-transparency-review-v1' as const, missingIndicators,
  };
}

test('QUALIFIED_V3 keeps SOC-03 at three accounts and two communities while ATT-02 still uses S10 at three communities', () => {
  const f = facts();
  const features = completeFixtureEntryFeatures({ A18: false, S03: true, S10: false });
  const soc03 = status(features, 'SOC-03', 'QUALIFIED_V3', f).row;
  const soc02 = status(features, 'SOC-02', 'QUALIFIED_V3', f).row;
  const att02 = status(features, 'ATT-02', 'QUALIFIED_V3', f).row;
  assert.equal(soc03.status, 'PASS', '3 accounts, 2 independently evidenced origins and 2 communities meet SOC-03');
  assert.equal(soc02.status, 'PASS');
  assert.equal(att02.status, 'FAIL', 'S10 remains a separate three-community input to ATT-02');
});

test('complete low account coverage can fail SOC-03 while S03=false does not fail source integrity SOC-02', () => {
  const f = facts({ accountUpperBound: 2, independentGroupCount: 2, independentCommunityCount: 2 });
  const features = completeFixtureEntryFeatures({ S03: false, S10: false });
  const { row: soc02 } = status(features, 'SOC-02', 'QUALIFIED_V3', f);
  const { row: soc03, result } = status(features, 'SOC-03', 'QUALIFIED_V3', f);
  assert.equal(soc02.status, 'PASS', 'integrity requires S02/S04/S05/S06 and complete lineage, not S03 participation breadth');
  assert.equal(soc03.status, 'FAIL', 'a complete nonempty corpus with an upper bound below three is adverse');
  assert.equal(result.classification, 'WATCH');
  assert.equal(result.binary, 'FAIL');
});

test('stale or absent social facts remain unknown, and legacy V2 does not consume V3 social policy facts', () => {
  const features = completeFixtureEntryFeatures({ S01: false, S02: false, S03: false, S04: false, S05: false, S06: false, S10: false });
  const stale = facts({ availableAt: '2026-10-03T23:54:59.999Z' });
  for (const id of ['SOC-01', 'SOC-02', 'SOC-03']) {
    assert.equal(status(features, id, 'QUALIFIED_V3', stale).row.status, 'UNKNOWN', `${id} cannot use stale facts`);
    assert.equal(status(features, id, 'QUALIFIED_V3').row.status, 'UNKNOWN', `${id} requires frozen facts`);
  }
  assert.equal(status(features, 'SOC-01', 'QUALIFIED_V2', facts()).row.status, 'UNKNOWN', 'V2 keeps its existing required-evidence treatment for social false');
});

test('a social hard failure cannot be hidden by another missing pillar, and hard-gate precedence is preserved', () => {
  const socialFalse = facts();
  const features = completeFixtureEntryFeatures({ S01: false });
  const { row, result } = status(features, 'SOC-01', 'QUALIFIED_V3', socialFalse);
  assert.equal(row.status, 'FAIL');
  assert.equal(result.classification, 'WATCH');

  const hardGateFeatures = completeFixtureEntryFeatures({ S01: false, O03: false });
  const hardGate = status(hardGateFeatures, 'SOC-01', 'QUALIFIED_V3', socialFalse);
  assert.equal(hardGate.result.classification, 'REJECTED');
});

test('QUALIFIED_V4 consumes accepted source-qualified judgments for SOC-01 and SOC-02 while keeping missing indicators descriptive', () => {
  const features = completeFixtureEntryFeatures({ S01: true, S02: true, S03: true, S04: true, S05: true, S06: true, S10: true });
  const social = facts({
    identityReview: qualifiedJudgment('CONTRADICTED'),
    integrityReview: qualifiedJudgment('SUPPORTED', ['ACCOUNT_HISTORY', 'ENGAGEMENT', 'COMPARABLE_HISTORY']),
  });
  assert.equal(status(features, 'SOC-01', 'QUALIFIED_V4', social).row.status, 'FAIL', 'inadequate public identity verifiability is an independently reviewed negative');
  assert.equal(status(features, 'SOC-02', 'QUALIFIED_V4', social).row.status, 'PASS', 'desired missing statistics do not block a guarded supported judgment');

  const negativeIntegrity = facts({ integrityReview: qualifiedJudgment('CONTRADICTED', ['ENGAGEMENT']) });
  assert.equal(status(features, 'SOC-02', 'QUALIFIED_V4', negativeIntegrity).row.status, 'FAIL');
  assert.equal(status(features, 'SOC-02', 'QUALIFIED_V4', facts()).row.status, 'UNKNOWN', 'legacy optional facts do not fall through to V3 for SOC-02');
  assert.equal(status(features, 'SOC-01', 'QUALIFIED_V4', facts({ identityReview: qualifiedJudgment('UNRESOLVED') })).row.status, 'UNKNOWN');
  assert.equal(status(features, 'SOC-01', 'QUALIFIED_V4', facts({ identityReview: qualifiedJudgment('CONTRADICTED'), availableAt: '2026-10-03T23:54:59.999Z' })).row.status, 'UNKNOWN', 'stale judgments stay unusable');
});
