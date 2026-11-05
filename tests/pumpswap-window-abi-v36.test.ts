import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileWindowQuote, decodePinnedWindowEvent } from '../src/providers/pumpswap-window-abi.js';
import { eventPrefix, payload } from './window-v36-fixtures.js';

// Proof36 extended-mode fee reconciliation (the v3 accounting object) plus the strict 16-byte historical
// holder appendix. CONSTRUCTED_SOURCE_CONFORMANCE: every vector is authored, not a mainnet capture. The
// taxed exact-in vector reproduces the real 249K-lamport census row and refutes the regressed Q==U+F /
// S>=Q+T formula: with core U, booked = U + lp + protocol + creator (+ cashback), the wallet debit is
// booked + tax and must fit inside the declared budget Q, with any remainder recorded as dust, never flow.
const LP = 100n, PROT = 50n, CREATOR = 25n, FEES = 175n, CORE = 10000n, TAX = 40n, CASH = 50n;
const holder0 = { holderRewardsBps: 0n, holderRewards: 0n, creatorFeeUnclaimed: 0n };
const buyFields = { lp_fee: LP, protocol_fee: PROT, coin_creator_fee: CREATOR, coin_creator_fee_basis_points: 0n, quote_amount_in: CORE, user_quote_amount_in: CORE + FEES, quote_amount_in_with_lp_fee: CORE + LP, base_amount_out: 5000n };
const base = (o: Record<string, unknown> = {}): any => ({ eventLayout: 'TRANSFER_FEE_APPENDIX', lpFee: LP, protocolFee: PROT, coinCreatorFee: CREATOR, lpFeeBasisPoints: 0n, protocolFeeBasisPoints: 0n, coinCreatorFeeBasisPoints: 0n, buybackFeeBasisPoints: 0n, cashbackFeeBasisPoints: 0n, buybackFee: 0n, cashback: 0n, ...holder0, quoteTransferFee: 0n, ...o });
const buyD = (o: Record<string, unknown> = {}): any => base({ ixName: 'buy', quoteAmountIn: CORE, userQuoteAmountIn: CORE + FEES, quoteAmountInWithLpFee: CORE + LP, ...o });
const sellD = (o: Record<string, unknown> = {}): any => base({ ixName: 'sell', quoteAmountOut: CORE, userQuoteAmountOut: CORE - FEES, quoteAmountOutWithoutLpFee: CORE - LP, ...o });

test('v3 reconcile prices a direct taxed BUY as core, booked = core + fees, wallet = booked + tax', () => {
  const q = reconcileWindowQuote('buy', buyD({ quoteTransferFee: TAX }), true, true);
  assert.equal(q.method, 'pumpswap-event-fee-exclusive-v3');
  assert.equal(q.basis, 'BUY_CORE');
  assert.equal(q.coreQuoteAtomic, String(CORE));
  assert.equal(q.bookedQuoteAtomic, String(CORE + FEES));
  assert.equal(q.walletQuoteAtomic, String(CORE + FEES + TAX));
  assert.equal(q.quoteTransferFeeAtomic, String(TAX));
});

test('v3 reconcile prices a direct taxed SELL: core = booked = gross quote out, payout = user - tax', () => {
  const s = reconcileWindowQuote('sell', sellD({ quoteTransferFee: TAX }), true, true);
  assert.equal(s.method, 'pumpswap-event-fee-exclusive-v3');
  assert.equal(s.basis, 'SELL_CORE');
  assert.equal(s.coreQuoteAtomic, String(CORE));
  assert.equal(s.bookedQuoteAtomic, String(CORE));
  assert.equal(s.walletQuoteAtomic, String(CORE - FEES - TAX));
  assert.equal(s.quoteTransferFeeAtomic, String(TAX));
});

test('v3 reconcile reproduces the real corrected taxed exact-in census row with exact budget dust 85', () => {
  const Q = 33940602n, U = 33500691n, L = 50252n, P = 30151n, C = 20101n, T = 339322n; // L+P+C = 100504
  const ex = reconcileWindowQuote('buy_exact_quote_in', base({ ixName: 'buy_exact_quote_in', lpFee: L, protocolFee: P, coinCreatorFee: C, quoteAmountIn: Q, userQuoteAmountIn: U, quoteAmountInWithLpFee: U + L, quoteTransferFee: T }), true, true);
  assert.equal(ex.method, 'pumpswap-event-fee-exclusive-v3');
  assert.equal(ex.basis, 'EXACT_QUOTE_BUY_GROSS');
  assert.equal(ex.coreQuoteAtomic, '33500691');
  assert.equal(ex.bookedQuoteAtomic, '33601195');
  assert.equal(ex.walletQuoteAtomic, '33940517');
  assert.equal(ex.quoteTransferFeeAtomic, '339322');
  assert.equal(ex.eventQuoteAtomic, '33940602');
  // Budget echoes the declared spendable; remainder = Q - (booked + tax) = 85, recorded but never counted.
  assert.equal(BigInt(ex.eventQuoteAtomic) - BigInt(ex.walletQuoteAtomic), 85n);
});

test('v3 reconcile rejects a taxed exact-in whose wallet debit (booked + tax) overflows the declared budget', () => {
  const U = 33500691n, L = 50252n, P = 30151n, C = 20101n, T = 339322n; // booked+tax = 33940517
  assert.throws(() => reconcileWindowQuote('buy_exact_quote_in', base({ ixName: 'buy_exact_quote_in', lpFee: L, protocolFee: P, coinCreatorFee: C, quoteAmountIn: 33940516n, userQuoteAmountIn: U, quoteAmountInWithLpFee: U + L, quoteTransferFee: T }), true, true), /ADVISORY_TRADE_FEE_BINDING/);
});

test('an untaxed exact-in keeps the frozen v2 object and the exact Q == booked identity even under extended', () => {
  const ok = reconcileWindowQuote('buy_exact_quote_in', base({ ixName: 'buy_exact_quote_in', quoteAmountIn: CORE + FEES, userQuoteAmountIn: CORE, quoteAmountInWithLpFee: CORE + LP, quoteTransferFee: 0n }), true, true);
  assert.equal(ok.method, 'pumpswap-event-fee-exclusive-v2');
  assert.equal(ok.coreQuoteAtomic, String(CORE));
  assert.equal(ok.quoteTransferFeeAtomic, '0');
  assert.throws(() => reconcileWindowQuote('buy_exact_quote_in', base({ ixName: 'buy_exact_quote_in', quoteAmountIn: CORE + FEES + 1n, userQuoteAmountIn: CORE, quoteAmountInWithLpFee: CORE + LP, quoteTransferFee: 0n }), true, true), /ADVISORY_TRADE_FEE_BINDING/);
});

test('v1 cashback is charged exactly once inside the fee total on a direct v1 buy (v3 object)', () => {
  const cb = reconcileWindowQuote('buy', base({ ixName: 'buy', eventLayout: 'CURRENT_APPENDIX', quoteAmountIn: CORE, userQuoteAmountIn: CORE + FEES + CASH, quoteAmountInWithLpFee: CORE + LP, cashback: CASH, cashbackFeeBasisPoints: 50n }), true, true);
  assert.equal(cb.method, 'pumpswap-event-fee-exclusive-v3');
  assert.equal(cb.coreQuoteAtomic, '10000');
  assert.equal(cb.bookedQuoteAtomic, '10225');
  assert.equal(cb.cashbackAtomic, '50');
  assert.equal(cb.totalFeeAtomic, '225');
});

test('cashback on a v2 instruction is protocol-invalid even under extended', () => {
  assert.throws(() => reconcileWindowQuote('buy_v2', base({ ixName: 'buy_v2', eventLayout: 'CURRENT_APPENDIX', quoteAmountIn: CORE, userQuoteAmountIn: CORE + FEES + CASH, quoteAmountInWithLpFee: CORE + LP, cashback: CASH, cashbackFeeBasisPoints: 50n }), true, true), /ADVISORY_TRADE_FEE_BINDING/);
});

test('v2 (extended off) still rejects any nonzero cashback, preserving proof 1-35 behaviour', () => {
  assert.throws(() => reconcileWindowQuote('buy', buyD({ eventLayout: 'CURRENT_APPENDIX', ...holder0, cashback: CASH, cashbackFeeBasisPoints: 50n }), true), /ADVISORY_TRADE_FEE_BINDING/);
});

test('v3 reconcile audits buyback-above-protocol, overflowing u64 and non-positive core with the fee error', () => {
  assert.throws(() => reconcileWindowQuote('buy', buyD({ quoteTransferFee: TAX, buybackFee: 51n }), true, true), /ADVISORY_TRADE_FEE_BINDING/);
  assert.throws(() => reconcileWindowQuote('buy', buyD({ quoteTransferFee: '18446744073709551616' }), true, true), /ADVISORY_TRADE_FEE_BINDING/);
  assert.throws(() => reconcileWindowQuote('sell', sellD({ quoteTransferFee: TAX, quoteAmountOut: 0n, userQuoteAmountOut: 0n, quoteAmountOutWithoutLpFee: 0n }), true, true), /ADVISORY_TRADE_FEE_BINDING/);
});

test('extended off is byte-identical to the frozen v1/v2 contract for an ordinary SDK_PREFIX buy', () => {
  assert.equal(reconcileWindowQuote('buy', buyD({ eventLayout: 'SDK_PREFIX' })).method, 'pumpswap-event-fee-exclusive-v1');
  assert.equal(reconcileWindowQuote('buy', buyD({ eventLayout: 'SDK_PREFIX' }), true).method, 'pumpswap-event-fee-exclusive-v2');
});

test('extended decode admits the strict 16-byte historical holder appendix with null creator/tax tail', () => {
  const prefix = eventPrefix('buyEvent', buyFields);
  const hist = decodePinnedWindowEvent(payload(prefix, 30n, 27n), true, true, true)!;
  assert.equal(hist.name, 'buyEvent');
  assert.equal(hist.data.eventLayout, 'HOLDER_APPENDIX');
  assert.equal(hist.data.holderRewardsBps, 30n);
  assert.equal(hist.data.holderRewards, 27n);
  assert.equal(hist.data.creatorFeeUnclaimed, null);
  assert.equal(hist.data.quoteTransferFee, null);
});

test('proof35 (non-extended) rejects the 16-byte appendix in both default and modern modes', () => {
  const prefix = eventPrefix('buyEvent', buyFields);
  assert.throws(() => decodePinnedWindowEvent(payload(prefix, 30n, 27n), true, true), /ADVISORY_TRADE_EVENT_ENCODING/);
  assert.throws(() => decodePinnedWindowEvent(payload(prefix, 30n, 27n), true), /ADVISORY_TRADE_EVENT_ENCODING/);
});

test('extended decode still accepts +24/+32 but rejects any other trailing length (no generic tail)', () => {
  const prefix = eventPrefix('buyEvent', buyFields);
  assert.equal(decodePinnedWindowEvent(payload(prefix, 0n, 0n, 0n), true, true, true)!.data.eventLayout, 'CURRENT_APPENDIX');
  const taxed = decodePinnedWindowEvent(payload(prefix, 0n, 0n, 0n, 9n), true, true, true)!;
  assert.equal(taxed.data.eventLayout, 'TRANSFER_FEE_APPENDIX');
  assert.equal(taxed.data.quoteTransferFee, 9n);
  assert.throws(() => decodePinnedWindowEvent(payload(prefix, 30n), true, true, true), /ADVISORY_TRADE_EVENT_ENCODING/);
  assert.throws(() => decodePinnedWindowEvent(payload(prefix, 1n, 2n, 3n, 4n, 5n), true, true, true), /ADVISORY_TRADE_EVENT_ENCODING/);
});
