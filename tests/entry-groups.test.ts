import assert from 'node:assert/strict';
import test from 'node:test';
import type { EvidenceRecord } from '../src/domain/contracts.js';
import { deriveEntryGroups, type EntryGroupInputs } from '../src/domain/entry-groups.js';
import { SHARED_CUTOFF, sharedFixture } from './shared-fixtures.js';

const tokenTime = (secondsAgo: number) => new Date(Date.parse(SHARED_CUTOFF) - secondsAgo * 1000).toISOString();
function evidence(id: string, sourceId: string, availableAt = SHARED_CUTOFF): EvidenceRecord {
  return {
    id, sourceId, sourceType: 'PUBLIC_API', retrievedAt: availableAt, availableAt, contentHash: 'a'.repeat(64),
    adapterVersion: 'entry-groups-test-v1', accessMode: 'PUBLIC_API', scope: { sanitized: true },
  };
}
function currentInput(): EntryGroupInputs {
  const fixture = sharedFixture();
  fixture.evidence.push(evidence('dex-pairs', 'dexscreener'), evidence('holders', 'solana-rpc'), evidence('venue-proof', 'solana-rpc'));
  fixture.baseline.find(item => item.id === 'O08')!.data = { poolAddress: 'current-pool', version: 'fixture-current-route', bindingVerified: true };
  fixture.baseline.find(item => item.id === 'O08')!.evidenceIds = ['venue-proof'];
  fixture.baseline.find(item => item.id === 'S02')!.data = { accounts: 3, qualifiedOriginals: 4, copyGroups: ['author-a', 'author-b'] };
  return {
    token: fixture.token, cutoff: fixture.cutoff, profile: fixture.profile,
    baseline: fixture.baseline, evidence: fixture.evidence, social: fixture.social,
    collection: {
      rpc: { state: 'OBSERVED' as const }, dex: { state: 'OBSERVED' as const }, web: { state: 'OBSERVED' as const },
    },
    holders: {
      complete: true, supplyAtomic: '100', slot: 120, evidenceIds: ['holders'],
      accounts: Array.from({ length: 10 }, (_, index) => ({ address: `wallet-account-${index}`, owner: `wallet-owner-${index}`, amount: '10' })),
    },
    market: {
      reportedPairCount: 1, retainedPairCount: 1, truncated: false,
      pairs: [{
        pairAddress: 'current-pool', dexId: 'fixture-dex', url: null, mintSide: 'base', baseAddress: fixture.token.address,
        quoteAddress: 'quote', priceUsd: '0.0001', liquidityUsd: '100', volume24hUsd: '10', buys24h: 2, sells24h: 1,
        pairCreatedAt: tokenTime(300),
      }],
    },
  };
}

test('a five-minute-old token can pass all five current group screens without prior-day history', () => {
  const input = currentInput();
  const groups = deriveEntryGroups(input);
  assert.deepEqual(groups.groups.map(group => group.status), ['PASS','PASS','PASS','PASS','PASS']);
  const attention = groups.groups.find(group => group.checkId === 'ADV-03')!;
  assert.deepEqual([attention.metrics.qualifiedOriginals, attention.metrics.sourceAccounts, attention.metrics.historyRequired], ['12', '4', false]);
  assert.match(attention.limitations.join(' '), /prior-window.*not mandatory/i);
  const flow = groups.groups.find(group => group.checkId === 'ADV-02')!;
  assert.deepEqual([flow.metrics.window, flow.metrics.buys, flow.metrics.sells, flow.metrics.volumeUsd], ['reported rolling 24h', 2, 1, '10']);
  assert.equal(flow.metrics.buyCountFraction, '0.66666666666666666667');
  assert.equal(flow.metrics.volumeToDisplayedLiquidity, '0.1');
  assert.equal(Object.hasOwn(flow.metrics, 'netFlowUsd'), false);
  assert.match(flow.limitations.join(' '), /not net capital flow, unique traders, organic volume/i);
  const lifecycle = groups.groups.find(group => group.checkId === 'ADV-05')!;
  assert.deepEqual([lifecycle.metrics.poolAgeSeconds, lifecycle.metrics.minimumAgeSeconds], [300, null]);
  assert.match(lifecycle.limitations.join(' '), /not token creation age/i);
});

test('completed inadequate current narrative support fails its group while keeping older history optional', () => {
  const input = currentInput();
  const narrative = input.baseline.find(item => item.id === 'A01')!;
  narrative.projection!.value = false;
  narrative.projection!.quality = 'KNOWN';
  narrative.quality = 'KNOWN';
  narrative.data = { summary: 'The complete reviewed scope does not support a relevant current narrative.' };
  const groups = deriveEntryGroups(input);
  const attention = groups.groups.find(group => group.checkId === 'ADV-03')!;
  assert.equal(attention.status, 'FAIL');
  assert.match(attention.rationale, /does not establish sufficient current narrative/);
  assert.equal(attention.metrics.historyRequired, false);
  assert.match(attention.limitations.join(' '), /does not measure platform-wide/);
  assert.equal(groups.groups.find(group => group.checkId === 'ADV-04')?.status, 'PASS',
    'a current attention failure does not rewrite separate actor evidence');
});

test('a reviewed closed post-sample gap fails current attention while narrative facts stay unknown', () => {
  const input = currentInput();
  for (const id of ['A01','A02','A05']) {
    const row = input.baseline.find(item => item.id === id)!;
    row.quality = 'MISSING';
    row.projection!.quality = 'MISSING';
    row.projection!.value = null;
  }
  const attentionGate = input.baseline.find(item => item.id === 'A15')!;
  attentionGate.quality = 'KNOWN';
  attentionGate.data = {
    method: 'entry-evidence-gate-v1', entryCriterion: 'ATT-01', verdict: 'FAIL',
    postSampleScope: { method: 'reviewed-empty-post-scope-v1', complete: true, sourceIds: [] },
  };
  attentionGate.projection!.quality = 'KNOWN';
  attentionGate.projection!.value = false;

  const group = deriveEntryGroups(input).groups.find(item => item.checkId === 'ADV-03')!;
  assert.equal(group.status, 'FAIL', 'the completed negative sample gate is already a failed necessary entry condition');
  assert.equal(group.metrics.narrativeSupported, null, 'an unqualified narrative is not represented as a negative finding');
  assert.equal(group.metrics.qualifiedOriginals, null);
  assert.equal(group.metrics.sourceAccounts, null);
  assert.match(group.rationale, /does not establish sufficient current narrative/);
});

test('collection outage and unfinished attention or actor review remain UNKNOWN with their causes', () => {
  const input = currentInput();
  input.market = null;
  input.marketCode = 'HTTP_503';
  input.collection.dex = { state: 'UNAVAILABLE', code: 'HTTP_503' };
  const narrative = input.baseline.find(item => item.id === 'A01')!;
  narrative.quality = 'MISSING';
  narrative.projection!.quality = 'MISSING';
  narrative.projection!.value = null;
  narrative.causes = [{ category: 'EVIDENCE_UNAVAILABLE', code: 'ATT_MODEL_HTTP_503', featureId: 'A01', evidenceIds: [], action: 'Retry the unavailable source review.' }];
  input.social!.sampleComplete = false;
  input.social!.participationReview = {
    method: 'source-transparency-review-v1', verdict: 'UNRESOLVED', rationale: 'The current actor review is unfinished.',
    citations: [{ sourceId: 'social-source', quote: 'Synthetic account integrity evidence is independently qualified.' }], missingIndicators: [],
  };
  for (const id of ['O08','O02','C01']) input.baseline.find(item => item.id === id)!.causes = [];

  const groups = deriveEntryGroups(input);
  for (const checkId of ['ADV-02','ADV-03','ADV-04','ADV-05']) {
    assert.equal(groups.groups.find(group => group.checkId === checkId)?.status, 'UNKNOWN', `${checkId} is not a negative finding`);
  }
  assert.equal(groups.groups.find(group => group.checkId === 'ADV-02')?.code, 'HTTP_503');
  assert.equal(groups.groups.find(group => group.checkId === 'ADV-03')?.code, 'ATT_MODEL_HTTP_503');
  assert.equal(groups.groups.find(group => group.checkId === 'ADV-04')?.code, 'SOC_ACTOR_REVIEW_INCOMPLETE');
  assert.equal(groups.groups.find(group => group.checkId === 'ADV-05')?.code, 'HTTP_503');
});

test('valid but inadequate current market responses are failures while acquisition outages stay unknown', () => {
  const incompleteActivity = currentInput();
  incompleteActivity.collection.dex = { state: 'OBSERVED', count: 1 };
  const pair = incompleteActivity.market!.pairs[0]!;
  pair.volume24hUsd = null;
  pair.buys24h = null;
  pair.sells24h = null;
  const activity = deriveEntryGroups(incompleteActivity).groups.find(group => group.checkId === 'ADV-02')!;
  assert.equal(activity.status, 'FAIL', 'valid exact-token market acquisition with missing activity fields is inadequate current evidence');
  assert.equal(activity.code, 'ACTIVITY_FIELDS_MISSING');

  const unavailableMarket = currentInput();
  unavailableMarket.market = null;
  unavailableMarket.marketCode = 'HTTP_503';
  unavailableMarket.collection.dex = { state: 'UNAVAILABLE', code: 'HTTP_503' };
  const outageActivity = deriveEntryGroups(unavailableMarket).groups.find(group => group.checkId === 'ADV-02')!;
  assert.equal(outageActivity.status, 'UNKNOWN');
  assert.equal(outageActivity.code, 'HTTP_503');

  const noUsablePrice = currentInput();
  noUsablePrice.collection.dex = { state: 'OBSERVED', count: 1 };
  noUsablePrice.market!.pairs[0]!.priceUsd = null;
  const marketContext = deriveEntryGroups(noUsablePrice).groups.find(group => group.checkId === 'ADV-05')!;
  assert.equal(marketContext.status, 'FAIL', 'verified route plus valid acquisition without a usable exact-token price is inadequate');

  const noPriceAfterOutage = currentInput();
  noPriceAfterOutage.market = null;
  noPriceAfterOutage.marketCode = 'HTTP_503';
  noPriceAfterOutage.collection.dex = { state: 'UNAVAILABLE', code: 'HTTP_503' };
  const outageContext = deriveEntryGroups(noPriceAfterOutage).groups.find(group => group.checkId === 'ADV-05')!;
  assert.equal(outageContext.status, 'UNKNOWN', 'source outage is not converted into a negative market finding');
});

test('only exact adapter-supplied vault addresses leave the current owner-share calculation', () => {
  const input = currentInput();
  input.holders!.accounts = [
    { address: 'target-token-vault', owner: 'verified-pool', amount: '40' },
    { address: 'ordinary-account-a', owner: 'owner-a', amount: '20' },
    { address: 'ordinary-account-b', owner: 'owner-b', amount: '20' },
    { address: 'ordinary-account-c', owner: 'owner-c', amount: '20' },
  ];
  input.profile.risk.maxDirectControlShare = '0.2';
  const included = deriveEntryGroups(input).groups.find(group => group.checkId === 'ADV-01')!;
  assert.equal(included.status, 'FAIL', 'pool-owned inventory is still a visible cluster without an exact vault exclusion');

  const excluded = deriveEntryGroups({ ...input, excludedVaults: ['target-token-vault'], exclusionEvidenceIds: ['venue-proof'] })
    .groups.find(group => group.checkId === 'ADV-01')!;
  assert.equal(excluded.status, 'PASS');
  assert.deepEqual([excluded.metrics.largestOwnerSupplyFraction, excluded.metrics.protocolVaultSupplyFraction], ['0.2', '0.4']);
  assert.deepEqual(excluded.metrics.excludedVaults, ['target-token-vault']);
  assert.equal(typeof excluded.metrics.herfindahlSupplyFraction, 'string');
});
