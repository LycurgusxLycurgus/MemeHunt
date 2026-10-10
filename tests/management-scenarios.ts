import type { FeatureResult, ManagementResult, PositionEvent, PositionRecord, Predicate, Profile, ThesisEpisode } from '../src/domain/contracts.js';
import { evaluateManagementAs } from '../src/domain/management-trace.js';
import type { StageInputs } from '../src/domain/policy.js';
import {
  completeFixtureEntryFeatures as full, FIXTURE_CUTOFF as C, fixtureEpisode as ep, fixtureFeature as ff,
  fixturePosition as pos, fixturePositionEvent as evt, illustrativeUncalibratedProfile as prof,
} from '../examples/fixtures.js';

export const p = (feature: string, value: string | boolean, unit: string, op: 'eq' | 'gt' | 'lt' = 'eq'): Predicate => ({ op, feature, value, unit });
export const LATER = '2026-01-01T01:00:00.000Z';
export const stage: StageInputs = { circulatingMarketCapUsd: '90000', tokenCreatedAt: '2025-12-31T23:00:00.000Z' };
const noStage: StageInputs = { circulatingMarketCapUsd: null, tokenCreatedAt: null };
export const leg = (id: string, trigger: Predicate, quantityBps: number | null = 4000, allRemaining = false) => ({ id, quantityBps, allRemaining, trigger });
export const traction = (e: ThesisEpisode) => { e.thesis.onchainTraction = p('O02', true, 'bool'); e.thesis.externalTraction = p('A01', true, 'bool'); return e; };
const dueLegEpisode = () => traction(ep(p('O01', true, 'bool'), p('O03', false, 'bool'), [leg('leg-1', p('O02', true, 'bool'))]));
const twoLegs = (first: ThesisEpisode['thesis']['legs'][number], second: ThesisEpisode['thesis']['legs'][number]) => traction(ep(p('O01', true, 'bool'), p('O03', false, 'bool'), [first, second]));
const invalidatedWithLeg = () => traction(ep(p('O01', true, 'bool'), p('O03', true, 'bool'), [leg('leg-1', p('O02', true, 'bool'))]));
const unattributed = (): PositionEvent => { const { legId: _leg, ...rest } = evt(); return rest; };
const secondSale = evt({ id: 'fixture-sale-002', idempotencyKey: 'fixture-event-key-002', quantityAtomic: '600', legId: 'leg-2', effectiveAt: '2026-01-01T00:20:00.000Z', recordedAt: '2026-01-01T00:21:00.000Z' });

export type Inputs = { episode: ThesisEpisode; features: FeatureResult[]; position: PositionRecord | null; events: PositionEvent[]; profile: Profile; cutoff: string; stageInputs: StageInputs };
const inputs = (episode: ThesisEpisode, features: FeatureResult[], position: PositionRecord | null, events: PositionEvent[], profile: Profile, stageInputs: StageInputs, cutoff = C): Inputs =>
  ({ episode, features, position, events, profile, cutoff, stageInputs });
export const runAs = (policyVersion: string, i: Inputs): ManagementResult =>
  evaluateManagementAs(policyVersion, i.episode, i.features, i.position, i.events, i.profile, i.cutoff, i.stageInputs);

/**
 * Rebuilds exactly the inputs captured in tests/fixtures/management-v0-golden.json (first 18) and
 * tests/fixtures/management-v5-golden.json (all), checked there by inputsHash. Never change a definition; add new names instead.
 */
export const scenarios: Record<string, () => Inputs> = {
  'invalidated-examples': () => inputs(ep(p('O01', true, 'bool'), p('O03', true, 'bool')), full(), null, [], prof, stage),
  'invalidated-despite-missing-support': () => inputs(ep(p('A01', true, 'bool'), p('O03', true, 'bool')), ['O03', 'O04', 'O05', 'O08', 'O10', 'O11'].map(id => ff(id, true)), null, [], prof, noStage),
  'validated-no-plan': () => inputs(ep(p('A01', true, 'bool'), p('O01', true, 'bool')), full({ O01: false }), null, [], prof, stage),
  'weakening': () => inputs(ep(p('A01', true, 'bool'), p('O02', false, 'bool')), full({ A01: false }), null, [], prof, stage),
  'dca-proposed': () => inputs(dueLegEpisode(), full(), pos(), [], prof, stage),
  'maintain': () => inputs(traction(ep(p('O01', true, 'bool'), p('O03', false, 'bool'), [leg('leg-1', p('O02', false, 'bool'))])), full(), pos(), [], prof, stage),
  'unverifiable-missing-catalyst': () => { const e = dueLegEpisode(); e.thesis.catalyst = p('A30', true, 'bool'); return inputs(e, full().filter(f => f.id !== 'A30'), pos(), [], prof, stage); },
  'safety-fail': () => inputs(ep(p('O01', true, 'bool'), p('O02', false, 'bool')), full({ O03: false }), null, [], prof, stage),
  'exit-fail': () => inputs(ep(p('O01', true, 'bool'), p('O02', false, 'bool')), full({ O14: '500' }), null, [], prof, stage),
  'risk-limits-missing': () => inputs(ep(p('O01', true, 'bool'), p('O02', false, 'bool')), full(), null, [], { ...prof, risk: {} }, stage),
  'expired-with-catalyst-and-warning': () => {
    const e = ep(p('O01', true, 'bool'), p('O02', false, 'bool'));
    e.thesis.catalyst = p('A01', true, 'bool'); e.thesis.warning = p('A03', true, 'bool'); e.thesis.expiryAt = '2025-12-31T00:00:00.000Z';
    return inputs(e, full(), null, [], prof, stage);
  },
  'future-available-support': () => inputs(ep(p('O01', true, 'bool'), p('O02', false, 'bool')), full().map(f => f.id === 'O01' ? { ...f, availableAt: '2026-01-01T00:00:01.000Z' } : f), null, [], prof, stage),
  'unreconciled-sale': () => inputs(dueLegEpisode(), full(), pos(), [unattributed()], prof, stage, LATER),
  'attributed-partial-sale': () => inputs(dueLegEpisode(), full(), pos(), [evt()], prof, stage, LATER),
  'unknown-cost': () => inputs(dueLegEpisode(), full(), pos({ initialCost: null }), [], prof, stage),
  'later-leg-unknown': () => inputs(traction(ep(p('O01', true, 'bool'), p('O03', false, 'bool'), [leg('leg-1', p('O02', true, 'bool')), leg('leg-2', p('A30', true, 'bool'), null, true)])), full().filter(f => f.id !== 'A30'), pos(), [], prof, stage),
  'nested-invalidation-unknown': () => inputs(ep(p('O01', true, 'bool'), { op: 'any', children: [p('O02', false, 'bool'), { op: 'all', children: [p('A01', true, 'bool'), p('A30', true, 'bool')] }] }), full().filter(f => f.id !== 'A30'), null, [], prof, stage),
  'nothing-known': () => inputs(ep(p('O01', true, 'bool'), p('O03', true, 'bool')), [], null, [], { id: 'unconfigured-live', risk: {}, stage: { ageBands: [] } }, noStage),
  // Packet 2: sell-step order and exit review with a position.
  'consumed-leg-then-not-due': () => inputs(twoLegs(leg('leg-1', p('O02', true, 'bool')), leg('leg-2', p('O01', false, 'bool'), 3000)), full(), pos(), [evt({ quantityAtomic: '400' })], prof, stage, LATER),
  'consumed-leg-then-due': () => inputs(twoLegs(leg('leg-1', p('O02', true, 'bool')), leg('leg-2', p('O02', true, 'bool'), 3000)), full(), pos(), [evt({ quantityAtomic: '400' })], prof, stage, LATER),
  'all-legs-consumed': () => inputs(dueLegEpisode(), full(), pos(), [evt({ quantityAtomic: '400' })], prof, stage, LATER),
  'fully-sold-plan': () => inputs(twoLegs(leg('leg-1', p('O02', true, 'bool')), leg('leg-2', p('O01', false, 'bool'), null, true)), full(), pos(), [evt({ quantityAtomic: '400' }), secondSale], prof, stage, LATER),
  'first-not-due-later-due': () => inputs(twoLegs(leg('leg-1', p('O02', false, 'bool')), leg('leg-2', p('O01', true, 'bool'), 3000)), full(), pos(), [], prof, stage),
  'unreconciled-not-due': () => inputs(traction(ep(p('O01', true, 'bool'), p('O03', false, 'bool'), [leg('leg-1', p('O02', false, 'bool'))])), full(), pos(), [unattributed()], prof, stage, LATER),
  'invalidated-with-position': () => inputs(invalidatedWithLeg(), full(), pos(), [], prof, stage),
  'invalidated-after-partial-sale': () => inputs(invalidatedWithLeg(), full(), pos(), [evt()], prof, stage, LATER),
  'invalidated-position-recorded-later': () => inputs(invalidatedWithLeg(), full(), pos({ recordedAt: LATER }), [], prof, stage),
  'expired-with-manual-position': () => {
    const e = traction(ep(p('O01', true, 'bool'), p('O03', false, 'bool'), [leg('leg-1', p('O02', false, 'bool'))]));
    e.thesis.expiryAt = '2025-12-31T00:00:00.000Z';
    return inputs(e, full(), pos({ mode: 'MANUAL_REPORTED' }), [], prof, stage);
  },
};
