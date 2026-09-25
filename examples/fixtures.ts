import type { Bundle, FeatureResult, Observation, PositionEvent, PositionRecord, Predicate, Profile, ThesisEpisode } from '../src/domain/contracts.js';
import { entryDefinitions } from '../src/domain/catalog.js';

export const fixtureProvenance = Object.freeze({
  kind: 'FIXTURE' as const,
  version: 1,
  description: 'Synthetic sanitized test data; no real token, wallet, provider response, or market observation.',
  calibratedForLiveUse: false,
});

export const illustrativeUncalibratedProfile: Profile = {
  id: 'fixture-illustrative-uncalibrated',
  sizeUsd: '10',
  horizonSeconds: 3600,
  risk: {
    maxTransferFeeBps: '100',
    maxDirectControlShare: '0.2',
    maxEntryImpactBps: '100',
    maxExitImpactBps: '100',
    maxRoundTripLossBps: '500',
    maxRemovableLiquidityShare: '0.5',
  },
  stage: { ageBands: [{ name: 'fixture-only', minSeconds: 0, maxSeconds: null }] },
};

export const FIXTURE_CUTOFF = '2026-01-01T00:00:00.000Z';
const fixtureEvidenceId = 'fixture-evidence-001';
const fixtureToken = { chain: 'solana' as const, address: 'FIXTURE_TOKEN' };

export const illustrativeFixtureThesis: NonNullable<Bundle['thesis']> = {
  support: [{ op: 'eq', feature: 'O01', value: true, unit: 'bool' }],
  invalidation: [{ op: 'eq', feature: 'O03', value: true, unit: 'bool' }],
  catalyst: null,
  expiryAt: null,
  onchainTraction: null,
  externalTraction: null,
  warning: null,
  legs: [],
};

export function fixtureFeature(
  id: string,
  value: string | boolean | null,
  overrides: Partial<FeatureResult> = {},
): FeatureResult {
  return {
    id,
    value,
    unit: typeof value === 'boolean' ? 'bool' : 'count',
    quality: 'KNOWN',
    availableAt: FIXTURE_CUTOFF,
    evidenceIds: [fixtureEvidenceId],
    applicability: 'APPLICABLE',
    ...overrides,
  };
}

export function completeFixtureEntryFeatures(overrides: Record<string, FeatureResult['value']> = {}): FeatureResult[] {
  const ids = [...new Set(entryDefinitions.flatMap(row => row.featureIds))];
  return ids.map(id => {
    const value = overrides[id] ?? (id === 'O07' || id === 'O13' || id === 'O14' ? '10'
      : id === 'O09' || id === 'O19' || id === 'O20' ? '0.1'
        : id === 'O15' ? '100'
          : id === 'A16' ? '10' : id === 'A17' ? '3' : true);
    const unit = id === 'O07' ? 'bps'
      : id === 'O09' || id === 'O19' || id === 'O20' ? 'fraction'
        : id === 'O13' || id === 'O14' || id === 'O15' ? 'bps'
          : id === 'A16' || id === 'A17' ? 'count'
            : typeof value === 'boolean' ? 'bool' : 'count';
    return fixtureFeature(id, value, { unit });
  });
}

export function fixtureBundle(features: FeatureResult[] = [], thesis?: Bundle['thesis'], observations: Observation[] = []): Bundle {
  return {
    token: fixtureToken,
    cutoff: FIXTURE_CUTOFF,
    analysisKind: 'FIXTURE',
    evidence: [{
      id: fixtureEvidenceId,
      sourceId: 'fixture-source',
      sourceType: 'FIXTURE',
      retrievedAt: FIXTURE_CUTOFF,
      availableAt: FIXTURE_CUTOFF,
      contentHash: '0'.repeat(64),
      adapterVersion: 'fixture-v1',
      accessMode: 'LOCAL_DERIVED',
      scope: { provenance: 'FIXTURE', fixtureVersion: 1, calibratedForLiveUse: false },
    }],
    observations,
    features,
    profile: illustrativeUncalibratedProfile,
    ...(thesis ? { thesis } : {}),
  };
}

export const fixtureStageObservations: Observation[] = [
  {
    id: 'fixture-cap-observation-001', subject: fixtureToken, field: 'circulatingMarketCapUsd', value: '90000', unit: 'USD',
    evidenceIds: [fixtureEvidenceId], observedAt: FIXTURE_CUTOFF, availableAt: FIXTURE_CUTOFF, quality: 'KNOWN',
  },
  {
    id: 'fixture-creation-observation-001', subject: fixtureToken, field: 'tokenCreatedAt', value: '2025-12-31T23:00:00.000Z', unit: 'ISO-8601',
    evidenceIds: [fixtureEvidenceId], observedAt: FIXTURE_CUTOFF, availableAt: FIXTURE_CUTOFF, quality: 'KNOWN',
  },
];

export function fixturePosition(overrides: Partial<PositionRecord> = {}): PositionRecord {
  return {
    id: 'fixture-position-001',
    caseId: 'fixture-case-001',
    mode: 'HYPOTHETICAL',
    initialQuantityAtomic: '1000',
    initialCost: '100',
    quoteCurrency: 'FIXTURE_QUOTE',
    decimals: 0,
    entryAt: FIXTURE_CUTOFF,
    recordedAt: FIXTURE_CUTOFF,
    ...overrides,
  };
}

export function fixturePositionEvent(overrides: Partial<PositionEvent> = {}): PositionEvent {
  return {
    id: 'fixture-sale-001',
    kind: 'SELL_REPORTED',
    quantityAtomic: '200',
    quoteAmount: '30',
    effectiveAt: '2026-01-01T00:10:00.000Z',
    recordedAt: '2026-01-01T00:11:00.000Z',
    idempotencyKey: 'fixture-event-key-001',
    legId: 'leg-1',
    ...overrides,
  };
}

export function fixtureEpisode(
  support: Predicate,
  invalidation: Predicate,
  legs: ThesisEpisode['thesis']['legs'] = [],
): ThesisEpisode {
  return {
    id: 'fixture-episode-001',
    caseId: 'fixture-case-001',
    baselineSnapshotId: 'fixture-entry-snapshot-001',
    createdAt: FIXTURE_CUTOFF,
    thesis: {
      support: [support],
      invalidation: [invalidation],
      catalyst: null,
      expiryAt: null,
      onchainTraction: null,
      externalTraction: null,
      warning: null,
      legs,
    },
  };
}
