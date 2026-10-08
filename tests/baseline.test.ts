import assert from 'node:assert/strict';
import test from 'node:test';
import { starterProfile } from '../src/app/config.js';
import { evaluateEntry } from '../src/domain/policy.js';
import {
  baselineIds, deriveBaseline, deriveExecution, deriveHolderBounds,
  type BaselineInputs, type ControlFacts, type HolderFacts, type VenueFacts, type VenueInspection,
} from '../src/domain/baseline.js';
import type { EvidenceRecord, FeatureResult, Thesis, TokenRef } from '../src/domain/contracts.js';

const TOKEN: TokenRef = { chain: 'solana', address: 'FixtureMint' };
const CUTOFF = '2026-09-29T12:00:00.000Z';
const EVIDENCE: EvidenceRecord = {
  id: 'fixture-rpc', sourceId: 'solana-rpc', sourceType: 'PUBLIC_API', retrievedAt: CUTOFF, availableAt: CUTOFF,
  contentHash: 'd'.repeat(64), adapterVersion: 'fixture-v1', accessMode: 'PUBLIC_API', scope: { fixture: true },
};
function base(overrides: Partial<BaselineInputs> = {}): BaselineInputs {
  return { token: TOKEN, cutoff: CUTOFF, profile: starterProfile(), features: [], evidence: [], observations: [], ...overrides };
}
const get = (rows: ReturnType<typeof deriveBaseline>, id: string) => rows.find(row => row.id === id)!;

test('the frozen baseline catalog emits all 61 IDs once and missing direct evidence stays unresolved', () => {
  const rows = deriveBaseline(base());
  assert.equal(baselineIds.length, 61);
  assert.deepEqual(rows.map(row => row.id), baselineIds);
  assert.equal(new Set(rows.map(row => row.id)).size, 61);
  for (const row of rows) {
    assert.equal(row.version, 'baseline-v1', row.id);
    assert.equal(row.evaluator, 'IMPLEMENTED', row.id);
    if (row.quality !== 'KNOWN') {
      assert.ok(row.causes.length > 0, `${row.id} explains why the evidence is missing`);
      if (row.projection) assert.equal(row.projection.quality, row.quality, `${row.id} descriptive projections keep their missing quality`);
    }
  }
  for (const id of ['O03','O04','O05','O06','O08','O09','O10','O11','O12','O13','O14','O15','O16','O17','O18','O19','O20']) {
    assert.equal(get(rows, id).quality, 'MISSING', `${id} must not PASS from an absent collector`);
  }
  assert.equal(get(rows, 'O03').causes[0]?.category, 'COLLECTION_UNIMPLEMENTED');
  assert.equal(get(rows, 'A16').causes[0]?.category, 'CLAIM_UNVALIDATED');
});

test('baseline preserves qualified feature quality, evidence refs, settings origins, and missing-profile ownership', () => {
  const partial: FeatureResult = {
    id: 'O01', value: true, unit: 'bool', quality: 'TRUNCATED', availableAt: CUTOFF,
    evidenceIds: ['fixture-rpc'], applicability: 'APPLICABLE',
  };
  const rows = deriveBaseline(base({
    features: [partial], evidence: [EVIDENCE], origins: { profile: 'SAVED_DEFAULT' },
    profile: { id: 'incomplete-profile', risk: {}, stage: { ageBands: [] } },
  }));
  const identity = get(rows, 'O01');
  assert.equal(identity.quality, 'TRUNCATED');
  assert.equal(identity.projection?.quality, 'TRUNCATED');
  assert.deepEqual(identity.evidenceIds, ['fixture-rpc']);
  assert.deepEqual(identity.projection?.evidenceIds, ['fixture-rpc']);
  const context = get(rows, 'C01');
  assert.equal(context.quality, 'MISSING');
  assert.equal(context.projection?.value, false);
  assert.equal(context.causes[0]?.category, 'USER_INPUT_MISSING');
  assert.equal((context.data as { origins: Record<string, string> }).origins.profile, 'SAVED_DEFAULT');
});

test('shared capability coverage binds the direct inspection evidence while legacy baseline shape stays fixed', () => {
  const inspection = venueInspection({ evidenceIds: [EVIDENCE.id] });
  const legacy = get(deriveBaseline(base({ evidence: [EVIDENCE], venueInspection: inspection })), 'C02');
  const shared = get(deriveBaseline(base({ sharedMode: true, evidence: [EVIDENCE], venueInspection: inspection })), 'C02');

  assert.deepEqual(legacy.evidenceIds, [], 'legacy C02 retains its established empty reference list');
  assert.deepEqual(shared.evidenceIds, [EVIDENCE.id], 'shared C02 freshness must use the actual venue inspection source');
  assert.deepEqual(shared.projection?.evidenceIds, [EVIDENCE.id]);
});

test('C10 freezes ordered thesis predicates with their cutoff-specific truth and plan scope', () => {
  const thesis: Thesis = {
    support: [{ op: 'eq', feature: 'O01', value: true, unit: 'bool' }],
    invalidation: [{ op: 'eq', feature: 'O03', value: false, unit: 'bool' }],
    catalyst: { op: 'gt', feature: 'A16', value: '10', unit: 'count' },
    expiryAt: '2026-09-29T13:00:00.000Z',
    onchainTraction: { op: 'eq', feature: 'O06', value: true, unit: 'bool' },
    externalTraction: { op: 'gt', feature: 'A16', value: '10', unit: 'count' },
    warning: { op: 'eq', feature: 'O05', value: true, unit: 'bool' },
    legs: [
      { id: 'first', quantityBps: 6000, allRemaining: false, trigger: { op: 'gte', feature: 'O15', value: '1000', unit: 'bps' } },
      { id: 'remainder', quantityBps: null, allRemaining: true, trigger: { op: 'eq', feature: 'A18', value: true, unit: 'bool' } },
    ],
  };
  const feature = (id: string, value: boolean | string, unit: string): FeatureResult => ({
    id, value, unit, quality: 'KNOWN', availableAt: CUTOFF, evidenceIds: [], applicability: 'APPLICABLE',
  });
  const row = get(deriveBaseline(base({ thesis, features: [
    feature('O01', true, 'bool'), feature('O03', false, 'bool'), feature('O06', true, 'bool'),
    feature('A16', '12', 'count'), feature('O15', '1200', 'bps'),
  ] })), 'C10');
  const data = row.data as {
    support: Array<{ predicate: Thesis['support'][number]; truth: string }>;
    invalidation: Array<{ predicate: Thesis['invalidation'][number]; truth: string }>;
    expiryAt: string; expired: boolean;
    catalyst: { predicate: Thesis['support'][number]; truth: string };
    onchainTraction: { predicate: Thesis['support'][number]; truth: string };
    externalTraction: { predicate: Thesis['support'][number]; truth: string };
    warning: { predicate: Thesis['support'][number]; truth: string };
    legs: Array<{ id: string; truth: string }>;
    planReadiness: string;
  };
  assert.deepEqual(data.support, [{ predicate: thesis.support[0], truth: 'TRUE' }]);
  assert.deepEqual(data.invalidation, [{ predicate: thesis.invalidation[0], truth: 'TRUE' }]);
  assert.equal(data.expiryAt, thesis.expiryAt);
  assert.equal(data.expired, false);
  assert.deepEqual(data.catalyst, { predicate: thesis.catalyst, truth: 'TRUE' });
  assert.deepEqual(data.onchainTraction, { predicate: thesis.onchainTraction, truth: 'TRUE' });
  assert.deepEqual(data.externalTraction, { predicate: thesis.externalTraction, truth: 'TRUE' });
  assert.deepEqual(data.warning, { predicate: thesis.warning, truth: 'UNKNOWN' });
  assert.deepEqual(data.legs, [{ ...thesis.legs[0], truth: 'TRUE' }, { ...thesis.legs[1], truth: 'UNKNOWN' }]);
  assert.equal(data.planReadiness, 'SPECIFIED');
});

test('holder bounds aggregate account owners with bigint math and retain the unsampled supply tail', () => {
  const complete: HolderFacts = {
    supplyAtomic: '1000000000000000000000000000000', slot: 123, complete: true, evidenceIds: ['holders'],
    accounts: [
      { address: 'token-account-a', owner: 'owner-a', amount: '250000000000000000000000000000' },
      { address: 'token-account-b', owner: 'owner-a', amount: '250000000000000000000000000000' },
      { address: 'token-account-c', owner: 'owner-b', amount: '500000000000000000000000000000' },
    ],
  };
  const full = deriveHolderBounds(complete);
  assert.equal(full.sampleAccounts, 3);
  assert.equal(full.ownerCountLowerBound, 2);
  assert.equal(full.sampledAtomic, complete.supplyAtomic);
  assert.equal(full.sampledSupplyFraction, '1');
  assert.equal(full.top1LowerBound, '0.5');
  assert.equal(full.top5LowerBound, '1');
  assert.equal(full.top1UpperBound, '0.5');
  assert.deepEqual(full.exclusions, [], 'no owner exclusions are inferred from account structure');

  const partialHolder: HolderFacts = {
    ...complete, complete: false, supplyAtomic: '1000',
    accounts: [
      { address: 'sample-1', owner: 'owner-a', amount: '200' },
      { address: 'sample-2', owner: 'owner-a', amount: '100' },
      { address: 'sample-3', owner: 'owner-b', amount: '100' },
    ],
  };
  const partial = deriveHolderBounds(partialHolder);
  assert.equal(partial.sampledSupplyFraction, '0.4');
  assert.equal(partial.unresolvedTailAtomic, '600');
  assert.equal(partial.top1LowerBound, '0.3');
  assert.equal(partial.top1UpperBound, '0.9');

  const projected = get(deriveBaseline(base({ evidence: [EVIDENCE], holders: partialHolder })), 'O19');
  assert.equal(projected.quality, 'TRUNCATED');
  assert.equal(projected.projection?.value, '0.3');
  assert.equal(projected.projection?.quality, 'KNOWN', 'a sampled concentration lower bound above the selected limit is already adverse evidence');
  assert.match(projected.limitations.join(' '), /lower bound alone exceeds the selected limit/i);
  const unsafeOwner = deriveBaseline(base({ evidence: [EVIDENCE], holders: partialHolder }));
  const rejectingOwnerResult = evaluateEntry(unsafeOwner.flatMap(row => row.id === 'O19' || row.id === 'O20' ? row.projection ? [row.projection] : [] : []), starterProfile(), CUTOFF);
  assert.equal(rejectingOwnerResult.checks.find(row => row.checkId === 'OWN-02')?.status, 'FAIL');

  const lowSample: HolderFacts = { ...partialHolder, accounts: [{ address: 'small-sample', owner: 'owner-small', amount: '50' }] };
  const unresolvedOwners = deriveBaseline(base({ evidence: [EVIDENCE], holders: lowSample }));
  assert.equal(get(unresolvedOwners, 'O19').projection?.quality, 'TRUNCATED');
  const unknownOwnerResult = evaluateEntry(unresolvedOwners.flatMap(row => row.id === 'O19' || row.id === 'O20' ? row.projection ? [row.projection] : [] : []), starterProfile(), CUTOFF);
  assert.equal(unknownOwnerResult.checks.find(row => row.checkId === 'OWN-02')?.status, 'UNKNOWN', 'an incomplete favorable sample cannot establish acceptable ownership');
});

test('holder inputs reject duplicate accounts, invalid atomic values, oversupply, and false completeness', () => {
  const valid: HolderFacts = { supplyAtomic: '100', slot: 1, complete: false, evidenceIds: [], accounts: [{ address: 'acct', owner: 'owner', amount: '30' }] };
  assert.throws(() => deriveHolderBounds({ ...valid, accounts: [...valid.accounts, { ...valid.accounts[0]! }] }), /HOLDER_SHAPE/);
  assert.throws(() => deriveHolderBounds({ ...valid, accounts: [{ ...valid.accounts[0]!, amount: '-1' }] }), /HOLDER_SHAPE/);
  assert.throws(() => deriveHolderBounds({ ...valid, accounts: [{ ...valid.accounts[0]!, amount: '101' }] }), /HOLDER_SUPPLY/);
  assert.throws(() => deriveHolderBounds({ ...valid, complete: true }), /HOLDER_SUPPLY/);
  assert.throws(() => deriveHolderBounds({ ...valid, supplyAtomic: '0' }), /HOLDER_SHAPE/);
});

function venue(overrides: Partial<VenueFacts> = {}): VenueFacts {
  return {
    certificateId: 'fixture-route-certificate', bindingVerified: true, version: 'fixture-route-v1', token: TOKEN,
    availableAt: CUTOFF, expiresAt: '2026-09-29T20:00:00.000Z', removableLiquidityFraction: '0.08',
    lockExpiresAt: '2026-09-29T15:00:00.000Z', entryQuoteUsd: '25', acquiredAtomic: '1000000', decimals: 6,
    exitQuantityAtomic: '1000000', exitQuoteUsd: '22', referencePriceUsd: '25', entryExternalCostUsd: '1',
    exitExternalCostUsd: '1', embeddedFeesUsd: '0.25', costsReconciled: true, method: 'INDEPENDENT_QUOTES',
    evidenceIds: ['fixture-route'], ...overrides,
  };
}

function venueInspection(overrides: Partial<VenueInspection> = {}): VenueInspection {
  return {
    token: TOKEN, poolAddress: 'FixturePool', certificateId: 'fixture-route-certificate', version: 'fixture-route-v1',
    availableAt: CUTOFF, bindingVerified: true, evidenceIds: ['fixture-route'], removableLiquidityFraction: '0.08',
    errors: { execution: 'PUMP_TRANSACTION_COSTS_UNAVAILABLE', simulation: 'PUMP_SIMULATION_PAYER_UNAVAILABLE' },
    limitations: ['Canonical pool identity was read directly; setup costs and unsigned execution remained unavailable.'],
    ...overrides,
  };
}

test('execution derives acquisition size, quote impact, round-trip cost, and horizon lock exposure with decimals', () => {
  const result = deriveExecution(venue(), TOKEN, starterProfile(), CUTOFF);
  assert.equal(result.quantityTokens, '1');
  assert.equal(result.entryImpactBps, '0');
  assert.equal(result.exitImpactBps, '1200');
  assert.equal(result.totalEntryCostUsd, '26');
  assert.equal(result.netExitUsd, '21');
  assert.equal(result.roundTripLossBps, '1923.0769230769230769');
  assert.equal(result.embeddedFeesUsd, '0.25');
  assert.equal(result.costsReconciled, true);
  assert.equal(result.removableLiquidityFraction, '1', 'a lock shorter than the selected horizon is treated as fully removable');
  assert.throws(() => deriveExecution(venue({ token: { chain: 'base', address: 'FixtureMint' } }), TOKEN, starterProfile(), CUTOFF), /VENUE_SCOPE/);
  assert.throws(() => deriveExecution(venue({ expiresAt: '2026-09-29T11:59:59.000Z' }), TOKEN, starterProfile(), CUTOFF), /VENUE_SCOPE/);
  assert.throws(() => deriveExecution(venue({ entryQuoteUsd: '24' }), TOKEN, starterProfile(), CUTOFF), /VENUE_SCOPE/);
});

test('same-bank LP fraction of 0.0625 fails a 0.055 removable-liquidity limit', () => {
  const profile = starterProfile();
  profile.risk.maxRemovableLiquidityShare = '0.055';
  const rows = deriveBaseline(base({
    profile,
    evidence: [EVIDENCE],
    venueInspection: venueInspection({ evidenceIds: [EVIDENCE.id], removableLiquidityFraction: '0.0625' }),
  }));
  assert.equal(get(rows, 'O09').projection?.value, '0.0625');
  const result = evaluateEntry(rows.flatMap(row => row.projection ? [row.projection] : []), profile, CUTOFF);
  assert.equal(result.checks.find(check => check.checkId === 'LIQ-01')?.status, 'FAIL',
    'the current fraction rejects the threshold that a mixed 50/1000 state would incorrectly pass');
});

test('verified pool and liquidity facts survive execution failures while quotes, cost reconciliation, and simulation retain their own causes', () => {
  const rows = deriveBaseline(base({
    evidence: [EVIDENCE], venueInspection: venueInspection(),
    venue: venue({ costsReconciled: false, entryExternalCostUsd: '0', exitExternalCostUsd: '0' }),
  }));
  assert.equal(get(rows, 'O08').quality, 'KNOWN', 'direct canonical pool binding survives payer/setup failures');
  assert.equal(get(rows, 'O09').quality, 'KNOWN', 'the LP supply fraction survives unrelated simulation failure');
  assert.equal(get(rows, 'O10').quality, 'KNOWN');
  assert.equal(get(rows, 'O11').quality, 'KNOWN');
  assert.equal(get(rows, 'O12').quality, 'MISSING');
  assert.equal(get(rows, 'O12').collector, 'IMPLEMENTED');
  assert.equal(get(rows, 'O12').causes[0]?.code, 'PUMP_SIMULATION_PAYER_UNAVAILABLE');
  assert.equal(get(rows, 'O15').quality, 'MISSING', 'round-trip loss cannot be qualified until external transaction costs are reconciled');
  assert.equal(get(rows, 'O15').causes[0]?.code, 'PUMP_TRANSACTION_COSTS_UNAVAILABLE');
  assert.equal(get(rows, 'O16').quality, 'MISSING', 'unreconciled network fees cannot appear as zero-cost known evidence');
  assert.equal(get(rows, 'O16').causes[0]?.code, 'PUMP_TRANSACTION_COSTS_UNAVAILABLE');

  const reconciled = deriveBaseline(base({ evidence: [EVIDENCE], venueInspection: venueInspection(), venue: venue({
    costsReconciled: true,
    entryExternalCostUsd: '0.3270848',
    exitExternalCostUsd: '0.0008',
    simulation: { setupVerified: true, buySucceeded: true, sellSucceeded: true },
  }) }));
  assert.equal(get(reconciled, 'O12').quality, 'KNOWN');
  assert.equal(get(reconciled, 'O12').projection?.value, true, 'the exact observed round trip validates buy/sell simulation');
  assert.equal(get(reconciled, 'O15').quality, 'KNOWN', 'the total round-trip loss is qualified only after costs reconcile');
  assert.equal(get(reconciled, 'O16').quality, 'KNOWN');
  assert.equal(get(reconciled, 'O16').projection?.value, true);

  const disabled = deriveBaseline(base({ evidence: [EVIDENCE], venueInspection: venueInspection({ executionDisabled: true }), venue: undefined }));
  assert.equal(get(disabled, 'O08').quality, 'KNOWN');
  assert.equal(get(disabled, 'O10').quality, 'KNOWN');
  assert.equal(get(disabled, 'O10').projection?.value, false, 'a directly observed disabled route is an invalidation, not a collector gap');
  assert.equal(get(disabled, 'O11').projection?.value, false);
});

test('an expired acquired-size quote becomes named missing evidence while fresh pool and LP facts remain usable', () => {
  const expired = venue({ expiresAt: '2026-09-29T11:59:59.999Z' });
  const inspection = venueInspection({
    errors: { execution: 'PUMP_QUOTE_EXPIRED' },
    availableAt: CUTOFF,
  });
  const rows = deriveBaseline(base({ evidence: [EVIDENCE], venueInspection: inspection, venue: expired }));
  assert.equal(get(rows, 'O08').quality, 'KNOWN');
  assert.equal(get(rows, 'O09').quality, 'KNOWN');
  for (const id of ['O10', 'O11', 'O13', 'O14', 'O15', 'O16']) {
    assert.equal(get(rows, id).quality, 'STALE', `${id} requires a current route quote`);
    assert.equal(get(rows, id).collector, 'IMPLEMENTED');
    assert.equal(get(rows, id).causes[0]?.code, 'PUMP_QUOTE_EXPIRED');
  }
});

test('direct controls and program state never turn partial authority inspection into a favorable projection', () => {
  const partial: ControlFacts = {
    complete: false, supplyAllowed: true, transferAllowed: true, surfaceSupported: true, currentFeeBps: '0',
    feeImmutable: false, controls: ['TRANSFER_FEE_AUTHORITY'], unsupported: ['EXTENSION_99'], evidenceIds: ['raw-mint'],
  };
  const rows = deriveBaseline(base({ evidence: [EVIDENCE], controls: partial, program: {
    address: 'program', loader: 'upgradeable-loader', upgradeAuthority: 'authority', immutable: false, evidenceIds: ['program'],
  } }));
  for (const id of ['O03','O04','O06']) {
    assert.equal(get(rows, id).quality, 'UNSUPPORTED');
    assert.equal(get(rows, id).projection?.value, true);
    assert.equal(get(rows, id).projection?.quality, 'UNSUPPORTED');
  }
  assert.equal(get(rows, 'O07').quality, 'MISSING', 'zero current fee is insufficient while future fee changes remain possible');
  assert.equal(get(rows, 'O07').projection?.value, '0', 'the observed current fee remains descriptive while its safety quality is unresolved');
  assert.equal(get(rows, 'O07').projection?.quality, 'MISSING');
  assert.equal(get(rows, 'O05').quality, 'MISSING', 'an upgradeable program is not silently treated as immutable');
  assert.equal(get(rows, 'O05').causes[0]?.code, 'PROGRAM_UPGRADE_AUTHORITY');
  assert.equal(get(rows, 'O05').causes[0]?.category, 'EVIDENCE_UNAVAILABLE');
  assert.equal(get(rows, 'O07').causes[0]?.category, 'EVIDENCE_UNAVAILABLE');

  const complete = deriveBaseline(base({ evidence: [EVIDENCE], controls: { ...partial, complete: true, feeImmutable: true, unsupported: [] } }));
  assert.equal(get(complete, 'O03').quality, 'KNOWN');
  assert.equal(get(complete, 'O03').projection?.value, true);
  assert.equal(get(complete, 'O07').projection?.value, '0');
  assert.equal(get(complete, 'O07').quality, 'KNOWN');

  const excessiveFee = deriveBaseline(base({ evidence: [EVIDENCE], controls: { ...partial, currentFeeBps: '150' } }));
  assert.equal(get(excessiveFee, 'O07').quality, 'KNOWN', 'an observed fee above the selected limit is adverse even while future mutability is unresolved');
  assert.equal(get(excessiveFee, 'O07').projection?.value, '150');
  const feeDecision = evaluateEntry([get(excessiveFee, 'O07').projection!], starterProfile(), CUTOFF);
  assert.equal(feeDecision.checks.find(row => row.checkId === 'SEC-04')?.status, 'FAIL');
});

test('scoped activity and verified attribution keep counts, net flow, and unknown denominators separate', () => {
  const rows = deriveBaseline(base({
    evidence: [EVIDENCE],
    flow: { buysUsd: '9007199254740993', sellsUsd: '9007199254740994', complete: true, start: '2026-09-29T11:00:00.000Z', end: CUTOFF, evidenceIds: ['flow'] },
    bots: { coveredVolumeUsd: '100000000000000000000', attributedVolumeUsd: '1', verifiedIdentities: ['reviewed-address'], evidenceIds: ['attribution'] },
  }));
  assert.equal((get(rows, 'O28').data as { netQuoteFlowUsd: string }).netQuoteFlowUsd, '-1');
  assert.equal(get(rows, 'O28').quality, 'KNOWN');
  assert.equal((get(rows, 'O30').data as { attributedFraction: string }).attributedFraction, '0.00000000000000000001');
  assert.equal(get(rows, 'O30').quality, 'KNOWN');
  assert.throws(() => deriveBaseline(base({ bots: { coveredVolumeUsd: '10', attributedVolumeUsd: '11', verifiedIdentities: ['id'], evidenceIds: [] } })), /BOT_ATTRIBUTION/);
  assert.throws(() => deriveBaseline(base({ bots: { coveredVolumeUsd: '0', attributedVolumeUsd: '0', verifiedIdentities: ['id'], evidenceIds: [] } })), /BOT_ATTRIBUTION/);
});

const quoteIds = new Set(['O10', 'O11', 'O13', 'O14', 'O15', 'O16']);
function freshRequiredInputs(): BaselineInputs {
  const features: FeatureResult[] = [];
  const evidence: EvidenceRecord[] = [];
  for (const id of baselineIds) {
    const ageSeconds = quoteIds.has(id) ? 30 : /^[AS]/.test(id) ? 900 : 300;
    const at = new Date(Date.parse(CUTOFF) - ageSeconds * 1000).toISOString();
    const evidenceId = `e-${id}`;
    evidence.push({ ...EVIDENCE, id: evidenceId, retrievedAt: at, availableAt: at });
    features.push({ id, value: true, unit: 'bool', quality: 'KNOWN', availableAt: at, evidenceIds: [evidenceId], applicability: 'APPLICABLE' });
  }
  return {
    ...base({ features, evidence }),
    flow: { buysUsd: '1', sellsUsd: '0', complete: true, start: '2026-09-29T11:00:00.000Z', end: CUTOFF, evidenceIds: ['e-O28'] },
  };
}

test('freshness checks use bounded state, quote, and social TTLs and require source references', () => {
  const good = deriveBaseline(freshRequiredInputs());
  const current = get(good, 'C03');
  assert.equal(current.quality, 'KNOWN');
  const data = current.data as { stateTtlSeconds: number; quoteTtlSeconds: number; socialTtlSeconds: number; records: Array<{ id: string; ttlSeconds: number; fresh: boolean }> };
  assert.deepEqual([data.stateTtlSeconds, data.quoteTtlSeconds, data.socialTtlSeconds], [300, 30, 900]);
  const freshness = new Map(data.records.map(row => [row.id, row]));
  assert.deepEqual([freshness.get('O01')?.ttlSeconds, freshness.get('O01')?.fresh], [300, true]);
  assert.deepEqual([freshness.get('O15')?.ttlSeconds, freshness.get('O15')?.fresh], [30, true]);
  assert.deepEqual([freshness.get('A16')?.ttlSeconds, freshness.get('A16')?.fresh], [900, true]);

  for (const [staleId, excessSeconds] of [['O15', 1], ['O01', 1], ['A16', 1]] as const) {
    const stale = freshRequiredInputs();
    const evidenceId = `e-${staleId}`;
    const staleAt = new Date(Date.parse(CUTOFF) - ((quoteIds.has(staleId) ? 30 : /^[AS]/.test(staleId) ? 900 : 300) + excessSeconds) * 1000).toISOString();
    stale.evidence = stale.evidence!.map(item => item.id === evidenceId ? { ...item, retrievedAt: staleAt, availableAt: staleAt } : item);
    stale.features = stale.features!.map(feature => feature.id === staleId ? { ...feature, availableAt: staleAt } : feature);
    const staleRows = deriveBaseline(stale);
    const staleC03 = get(staleRows, 'C03');
    assert.equal(staleC03.quality, 'MISSING', `${staleId} must become stale beyond its boundary`);
    assert.equal((staleC03.data as { records: Array<{ id: string; fresh: boolean }> }).records.find(row => row.id === staleId)?.fresh, false);
    assert.equal(get(staleRows, staleId).projection?.quality, 'STALE', 'a resolved old source must not keep a favorable scalar projection');
  }

  const noReference = freshRequiredInputs();
  noReference.features = noReference.features!.map(feature => feature.id === 'O01' ? { ...feature, evidenceIds: [] } : feature);
  const unreferenced = get(deriveBaseline(noReference), 'C03');
  assert.equal(unreferenced.quality, 'MISSING');
  assert.equal((unreferenced.data as { records: Array<{ id: string; fresh: boolean }> }).records.find(row => row.id === 'O01')?.fresh, false);
  assert.equal(get(deriveBaseline(noReference), 'O01').projection?.quality, 'KNOWN', 'missing refs must not manufacture a stale projection');
});

test('either known attention or community growth row can satisfy the shared coverage alternative', () => {
  for (const [missingId, knownId] of [['A18', 'S10'], ['S10', 'A18']] as const) {
    const input = freshRequiredInputs();
    input.features = input.features!.map(feature => feature.id === missingId
      ? { ...feature, quality: 'MISSING' as const }
      : feature.id === knownId ? { ...feature, value: true, quality: 'KNOWN' as const } : feature);
    const rows = deriveBaseline(input);
    const coverage = get(rows, 'C04');
    const conflict = get(rows, 'C06');
    assert.equal(coverage.quality, 'KNOWN');
    assert.equal(conflict.quality, 'KNOWN');
    assert.equal((coverage.data as { missing: string[] }).missing.includes(missingId), false);
    assert.equal((conflict.data as { uninspected: string[] }).uninspected.includes(missingId), false);
  }
});
