import assert from 'node:assert/strict';
import test from 'node:test';
import { proposeLeg, reduceLedger } from '../src/domain/ledger.js';
import { FIXTURE_CUTOFF, fixtureEpisode, fixtureFeature, fixturePosition, fixturePositionEvent } from '../examples/fixtures.js';

test('ledger applies an attributed partial sale and preserves remaining cost basis', () => {
  const state = reduceLedger(fixturePosition(), [fixturePositionEvent()]);
  assert.equal(state.initialQuantityAtomic, '1000');
  assert.equal(state.remainingQuantityAtomic, '800');
  assert.equal(state.knownCost, '80');
  assert.equal(state.netCashFlow, '-70');
  assert.deepEqual(state.soldByLeg, { 'leg-1': '200' });
  assert.equal(state.unreconciledSale, false);
});

test('ledger rejects a reported sale larger than remaining inventory', () => {
  const oversale = fixturePositionEvent({ quantityAtomic: '1001', id: 'fixture-oversale', idempotencyKey: 'fixture-oversale-key' });
  assert.throws(() => reduceLedger(fixturePosition(), [oversale]), /OVERSELL/);
});

test('proposal quantity follows the frozen original position and subtracts allocated partial fills', () => {
  const position = fixturePosition();
  const partialFill = fixturePositionEvent({ quantityAtomic: '100', quoteAmount: '20' });
  const state = reduceLedger(position, [partialFill]);
  const episode = fixtureEpisode(
    { op: 'eq', feature: 'O01', value: true, unit: 'bool' },
    { op: 'eq', feature: 'O03', value: true, unit: 'bool' },
    [{ id: 'leg-1', quantityBps: 4000, allRemaining: false, trigger: { op: 'gte', feature: 'O02', value: '2', unit: 'quote/token' } }],
  );

  assert.deepEqual(proposeLeg(episode, state, [fixtureFeature('O02', '2', { unit: 'quote/token' })], FIXTURE_CUTOFF), {
    legId: 'leg-1', quantityAtomic: '300',
  });
});

test('an unallocated sale blocks further quantified legs until reconciled', () => {
  const state = reduceLedger(fixturePosition(), [fixturePositionEvent({ legId: undefined })]);
  const episode = fixtureEpisode(
    { op: 'eq', feature: 'O01', value: true, unit: 'bool' },
    { op: 'eq', feature: 'O03', value: true, unit: 'bool' },
    [{ id: 'leg-1', quantityBps: 4000, allRemaining: false, trigger: { op: 'gte', feature: 'O02', value: '2', unit: 'quote/token' } }],
  );
  assert.equal(state.unreconciledSale, true);
  assert.equal(proposeLeg(episode, state, [fixtureFeature('O02', '2', { unit: 'quote/token' })], FIXTURE_CUTOFF), null);
});

test('ledger orders offset timestamps by instant with deterministic ID ties', () => {
  const position = fixturePosition({ initialQuantityAtomic: '1', initialCost: '1', entryAt: '2025-12-31T22:00:00.000Z', recordedAt: '2025-12-31T22:00:00.000Z' });
  const buy = fixturePositionEvent({ id: 'a-buy', idempotencyKey: 'offset-buy', kind: 'BUY_REPORTED', quantityAtomic: '1', quoteAmount: '1', effectiveAt: '2026-01-01T01:00:00.000+02:00', recordedAt: '2026-01-01T00:10:00.000Z' });
  const sale = fixturePositionEvent({ id: 'z-sale', idempotencyKey: 'offset-sale', quantityAtomic: '2', quoteAmount: '3', effectiveAt: '2026-01-01T00:00:00.000Z', recordedAt: '2026-01-01T00:10:00.000Z' });
  assert.equal(reduceLedger(position,[sale,buy]).remainingQuantityAtomic,'0');
  const equalTimeSale = { ...sale, effectiveAt: '2026-01-01T01:00:00.000+02:00' };
  assert.equal(reduceLedger(position,[equalTimeSale,buy]).remainingQuantityAtomic,'0');
});
