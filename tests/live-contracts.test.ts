import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bundleSchema,
  entryGroupFactsSchema,
  liveBundleSchema,
  liveMarketSummarySchema,
  providerStatusSchema,
  semanticResultSchema,
  type LiveBundle,
} from '../src/domain/contracts.js';

const HASH = 'a'.repeat(64);
const LIVE_BUNDLE: LiveBundle = {
  token: { chain: 'solana', address: '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump' },
  cutoff: '2026-09-29T12:00:00.000Z',
  analysisKind: 'LIVE',
  evidence: [],
  rawArtifacts: {},
  observations: [],
  features: [],
  profile: { id: 'unconfigured-live', risk: {}, stage: { ageBands: [] } },
  collection: {
    rpc: { state: 'OBSERVED', count: 1 },
    dex: { state: 'OBSERVED', count: 1 },
    web: { state: 'KEY_MISSING' },
  },
  semantic: { status: 'NOT_REQUESTED', claims: [] },
  market: {
    reportedPairCount: 1,
    retainedPairCount: 1,
    truncated: false,
    pairs: [{
      pairAddress: 'PoolAddress',
      dexId: 'raydium',
      url: 'https://dexscreener.com/solana/PoolAddress',
      mintSide: 'base',
      baseAddress: '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump',
      quoteAddress: 'QuoteMint',
      priceUsd: '0.001',
      liquidityUsd: '1000',
      volume24hUsd: null,
      buys24h: 2,
      sells24h: 1,
      pairCreatedAt: null,
    }],
  },
};

test('external bundle imports reject LIVE while the internal live contract requires its provenance fields', () => {
  assert.throws(() => bundleSchema.parse(LIVE_BUNDLE));
  assert.deepEqual(liveBundleSchema.parse(LIVE_BUNDLE), LIVE_BUNDLE);
  assert.throws(() => liveBundleSchema.parse({ ...LIVE_BUNDLE, collection: undefined }));
  assert.throws(() => liveBundleSchema.parse({ ...LIVE_BUNDLE, rawArtifacts: undefined }));
  assert.throws(() => liveBundleSchema.parse({ ...LIVE_BUNDLE, fabricated: true }));
});

test('provider statuses and semantic results reject unknown keys and out-of-contract sizes', () => {
  assert.deepEqual(providerStatusSchema.parse({ state: 'UNAVAILABLE', code: 'HTTP_429' }), { state: 'UNAVAILABLE', code: 'HTTP_429' });
  assert.throws(() => providerStatusSchema.parse({ state: 'OBSERVED', secret: 'must not pass' }));
  assert.throws(() => providerStatusSchema.parse({ state: 'OBSERVED', count: -1 }));

  const claim = {
    kind: 'NARRATIVE',
    value: 'A community token',
    evidenceId: 'web-1',
    quote: 'The project describes itself as a community token.',
    assertion: 'SOURCE_STATES',
  } as const;
  assert.deepEqual(semanticResultSchema.parse({
    status: 'CANDIDATE', claims: [claim], model: 'gemini-3.5-flash-lite',
    promptHash: HASH, responseHash: HASH, schemaVersion: 1,
  }).status, 'CANDIDATE');
  assert.throws(() => semanticResultSchema.parse({ status: 'CANDIDATE', claims: Array(21).fill(claim) }));
  assert.throws(() => semanticResultSchema.parse({ status: 'CANDIDATE', claims: [{ ...claim, quote: 'short' }] }));
  assert.throws(() => semanticResultSchema.parse({ status: 'CANDIDATE', claims: [], unexpected: true }));
});

test('market summary caps displayed pairs while keeping total retained count separate', () => {
  const pair = LIVE_BUNDLE.market!.pairs[0]!;
  const summary = { reportedPairCount: 30, retainedPairCount: 30, truncated: true, pairs: Array(20).fill(pair) };
  assert.equal(liveMarketSummarySchema.parse(summary).pairs.length, 20);
  assert.throws(() => liveMarketSummarySchema.parse({ ...summary, pairs: Array(21).fill(pair) }));
  assert.throws(() => liveMarketSummarySchema.parse({ ...summary, provider: 'DEX' }));
});

test('assessment details accept strict optional entry-group facts and the new Shared quality mode', () => {
  const groupIds = ['ADV-01','ADV-02','ADV-03','ADV-04','ADV-05'] as const;
  const groups = {
    method: 'mandatory-entry-groups-v1' as const, token: LIVE_BUNDLE.token, cutoff: LIVE_BUNDLE.cutoff,
    groups: groupIds.map(checkId => ({
      checkId, status: 'UNKNOWN' as const, rationale: 'The current criterion is not qualified.', code: 'CURRENT_EVIDENCE_UNAVAILABLE',
      featureIds: [], evidenceIds: [], availableAt: LIVE_BUNDLE.cutoff, metrics: { measured: null }, limitations: ['The needed source was unavailable.'],
    })),
  };
  assert.deepEqual(entryGroupFactsSchema.parse(groups), groups);
  assert.equal(entryGroupFactsSchema.safeParse({ ...groups, groups: groups.groups.slice(1) }).success, false);
  assert.equal(entryGroupFactsSchema.safeParse({ ...groups, groups: [...groups.groups.slice(0, 4), { ...groups.groups[4]!, extra: true }] }).success, false);

  const details = {
    version: 1 as const, profile: LIVE_BUNDLE.profile, thesis: null, baseline: [], origins: {},
    stageInputs: { circulatingMarketCapUsd: null, tokenCreatedAt: null }, groups,
    shared: {
      method: 'shared-evidence-v1' as const, qualityMode: 'ENTRY_GROUPS_V1' as const,
      token: LIVE_BUNDLE.token, cutoff: LIVE_BUNDLE.cutoff, witnesses: [], freshness: [], unresolved: [],
      semanticQualified: false, auditQualified: false, conflicts: [],
      values: { C03: null, C04: null, C05: null, C06: null },
    },
  };
  const parsed = liveBundleSchema.parse({ ...LIVE_BUNDLE, details });
  assert.deepEqual(parsed.details, details);
  const legacy = liveBundleSchema.parse(LIVE_BUNDLE);
  assert.equal(legacy.details, undefined, 'legacy detailed facts remain optional');
});
