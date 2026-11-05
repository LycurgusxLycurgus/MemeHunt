/**
 * Synthetic and pinned-SDK differential checks adapted from the actual Claude quote proposal.
 * All constants are labelled arbitrary small synthetic values, not C5 rows, follower sizes or outcomes. Expected values were
 * derived by hand from the pinned SDK 1.20.0 formulas. The SDK comparison passes rates through its fallback globalConfig with
 * feeConfig null, as calibrate-sdk-observed.mjs does, only to expose arithmetic; a value the SDK returns is not thereby a
 * natively admitted trade.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { buyBaseInput, buyQuoteInput, sellBaseInput } from '@pump-fun/pump-swap-sdk';
import {
  ceilDiv, fee, quoteBuyExactBase, quoteBuyExactQuoteBudget, quoteSellExactBase, U64_MAX,
  type DirectKernelErrorCode, type DirectKernelResult, type DirectPrestate,
} from '../src/providers/advisory-copy-quote.js';

const RATES = { lpBps: 20n, protocolBps: 5n, creatorBps: 300n, buybackBps: 5_000n };
const NO_PROTOCOL = { ...RATES, protocolBps: 0n };
/** Synthetic prestate: B = 1e6, Q = 5e4, V = 1e4, so Qe = 6e4. */
const S1: DirectPrestate = {
  baseReserve: 1_000_000n, quoteReserve: 50_000n, virtualQuoteReserve: 10_000n, rates: RATES, rateWitnessSide: 'BUY', creatorActive: true,
  holderRewardMode: 'NONE', cashbackBps: 0n, quoteTransferFee: 'ZERO_WITNESSED', baseTransferFee: 'ZERO_DECLARED_PREMISE',
};
/** Synthetic thin physical vault under a large V: Qe-priced output can exceed real Q. */
const S2 = { baseReserve: 1_000_000n, quoteReserve: 1_000n, virtualQuoteReserve: 1_000_000n };
/** Synthetic pool whose base reserve is too small for any whole base unit at moderate budgets. */
const TINY_BASE = { baseReserve: 10n, quoteReserve: 1_000_000n, virtualQuoteReserve: 0n };
const buyState = (patch: Partial<DirectPrestate> = {}): DirectPrestate => ({ ...S1, ...patch });
const sellState = (patch: Partial<DirectPrestate> = {}): DirectPrestate => ({ ...S1, rateWitnessSide: 'SELL', ...patch });
const REMAINDER = buyState({ rates: NO_PROTOCOL, creatorActive: false });

function value<T>(r: DirectKernelResult<T>): T {
  if (!r.ok) return assert.fail('unexpected ' + r.code);
  return r.value;
}
function code(r: DirectKernelResult<unknown>): DirectKernelErrorCode {
  if (r.ok) return assert.fail('expected a typed domain error');
  return r.code;
}

test('ceilDiv and fee mirror the pinned SDK helpers', () => {
  assert.deepEqual([ceilDiv(0n, 7n), ceilDiv(14n, 7n), ceilDiv(15n, 7n)], [0n, 2n, 3n]);
  assert.deepEqual([fee(61n, 300n), fee(0n, 300n), fee(10_000n, 1n)], [2n, 0n, 1n]);
  assert.throws(() => ceilDiv(1n, 0n), RangeError);
  assert.throws(() => ceilDiv(-1n, 2n), RangeError);
});

test('exact-base buy: ceil core, then independently ceiled fees on core', () => {
  const q = value(quoteBuyExactBase(S1, 1_000n));
  assert.equal(q.coreQuote, 61n); // floor(60_000*1_000/999_000) would be 60
  assert.deepEqual([q.fees.lp, q.fees.protocol, q.fees.creator, q.fees.total], [1n, 1n, 2n, 4n]);
  assert.equal(q.userQuoteIn, 65n);
  assert.deepEqual(q.pool, { baseDelta: -1_000n, physicalQuoteDelta: 62n, postBaseReserve: 999_000n, postPhysicalQuoteReserve: 50_062n });
  assert.deepEqual([q.domain.effectiveQuoteReserve, q.domain.virtualQuoteSign], [60_000n, 'POSITIVE']);
});

test('buyback and holder reward are subsets, never extra charges', () => {
  const plain = value(quoteBuyExactBase(S1, 100_000n));
  assert.deepEqual([plain.coreQuote, plain.fees.lp, plain.fees.protocol, plain.fees.creator, plain.fees.total], [6_667n, 14n, 4n, 201n, 219n]);
  assert.deepEqual([plain.fees.buybackSubsetOfProtocol, plain.fees.holderRewardSubsetOfCreator, plain.userQuoteIn], [2n, 0n, 6_886n]);
  const holder = value(quoteBuyExactBase(buyState({ holderRewardMode: 'DUPLICATES_CREATOR_FEE' }), 100_000n));
  assert.equal(holder.fees.holderRewardSubsetOfCreator, 201n);
  assert.deepEqual([holder.fees.total, holder.userQuoteIn], [219n, 6_886n]); // not 6_886 + 201 + 2
  assert.deepEqual(holder.pool, { baseDelta: -100_000n, physicalQuoteDelta: 6_681n, postBaseReserve: 900_000n, postPhysicalQuoteReserve: 56_681n });
});

test('inactive coin creator charges no creator fee', () => {
  const q = value(quoteBuyExactBase(buyState({ creatorActive: false }), 100_000n));
  assert.deepEqual([q.fees.creator, q.userQuoteIn], [0n, 6_685n]);
});

test('curve prices with Qe = Q + V, including admissible uncalibrated zero and negative V', () => {
  const zero = value(quoteBuyExactBase(buyState({ virtualQuoteReserve: 0n }), 1_000n));
  assert.deepEqual([zero.coreQuote, zero.domain.virtualQuoteSign], [51n, 'ZERO']); // physical-Q pricing differs from 61
  const negative = value(quoteBuyExactBase(buyState({ virtualQuoteReserve: -10_000n }), 1_000n));
  assert.deepEqual([negative.coreQuote, negative.userQuoteIn, negative.domain.effectiveQuoteReserve, negative.domain.virtualQuoteSign], [41n, 45n, 40_000n, 'NEGATIVE']);
  assert.equal(code(quoteBuyExactBase(buyState({ virtualQuoteReserve: -50_000n }), 1_000n)), 'EFFECTIVE_QUOTE_NONPOSITIVE');
  assert.equal(code(quoteBuyExactBase(buyState({ virtualQuoteReserve: 1n << 127n }), 1_000n)), 'VIRTUAL_QUOTE_NOT_I128');
});

test('exact budget: fees once on e0, correction without recompute, conservative e - 1 on the curve', () => {
  const q = value(quoteBuyExactQuoteBudget(S1, 518n));
  assert.deepEqual([q.initialEffectiveCore, q.coreQuote, q.conservativeCurveInput], [501n, 499n, 498n]);
  assert.deepEqual([q.fees.lp, q.fees.protocol, q.fees.creator, q.fees.total], [2n, 1n, 16n, 19n]);
  assert.deepEqual([fee(499n, 20n), fee(499n, 300n)], [1n, 15n]); // a recompute on the corrected core would differ
  assert.equal(q.baseOut, 8_231n);
  assert.equal(1_000_000n * 499n / (60_000n + 499n), 8_248n); // the non-conservative floor(B*e/(Qe+e)) differs
  assert.deepEqual([q.bookedQuote, q.unspentBudget], [518n, 0n]);
  assert.deepEqual(q.pool, { baseDelta: -8_231n, physicalQuoteDelta: 501n, postBaseReserve: 991_769n, postPhysicalQuoteReserve: 50_501n });
});

test('exact budget remainder is explicit unspent budget, never flow; inactive creator stays out of the denominator', () => {
  const q = value(quoteBuyExactQuoteBudget(REMAINDER, 502n));
  assert.equal(q.initialEffectiveCore, 500n); // with creator bps in 10000 + bps it would be 486
  assert.deepEqual([q.coreQuote, q.fees.total, q.bookedQuote, q.unspentBudget, q.baseOut], [500n, 1n, 501n, 1n, 8_248n]);
  assert.equal(q.pool.physicalQuoteDelta, 501n); // not 502
});

test('tiny and empty budgets: admissible minimum and typed rejections', () => {
  const q = value(quoteBuyExactQuoteBudget(S1, 5n));
  assert.deepEqual([q.initialEffectiveCore, q.coreQuote, q.conservativeCurveInput, q.fees.total, q.baseOut, q.bookedQuote, q.unspentBudget], [4n, 2n, 1n, 3n, 16n, 5n, 0n]);
  for (const budget of [1n, 2n, 3n, 4n]) assert.equal(code(quoteBuyExactQuoteBudget(S1, budget)), 'BUDGET_TOO_SMALL');
  assert.equal(code(quoteBuyExactQuoteBudget(S1, 0n)), 'AMOUNT_ZERO');
  assert.equal(code(quoteBuyExactQuoteBudget(S1, -1n)), 'AMOUNT_NOT_U64');
  assert.equal(code(quoteBuyExactQuoteBudget(S1, U64_MAX + 1n)), 'AMOUNT_NOT_U64');
  assert.equal(code(quoteBuyExactQuoteBudget(buyState(TINY_BASE), 1_000n)), 'BASE_OUTPUT_ZERO');
});

test('exact-base sell: floor core, independently ceiled fees, user net and physical debit', () => {
  const q = value(quoteSellExactBase(sellState(), 100_000n));
  assert.equal(q.coreQuote, 5_454n); // ceil would be 5_455
  assert.deepEqual([q.fees.lp, q.fees.protocol, q.fees.creator, q.fees.total, q.fees.buybackSubsetOfProtocol], [11n, 3n, 164n, 178n, 1n]);
  assert.deepEqual([q.userNetQuote, q.physicalPoolDebit], [5_276n, 5_443n]);
  assert.deepEqual(q.pool, { baseDelta: 100_000n, physicalQuoteDelta: -5_443n, postBaseReserve: 1_100_000n, postPhysicalQuoteReserve: 44_557n });
});

test('sell backing uses physical Q, not Q + V', () => {
  const backed = value(quoteSellExactBase(sellState(S2), 1_000n));
  assert.deepEqual([backed.coreQuote, backed.physicalPoolDebit, backed.userNetQuote, backed.pool.postPhysicalQuoteReserve], [1_000n, 998n, 967n, 2n]);
  assert.equal(code(quoteSellExactBase(sellState(S2), 100_000n)), 'SELL_PHYSICAL_BACKING_INSUFFICIENT'); // core 91_000, debit 90_818 > Q 1_000
});

test('sell rejections: zero core, fees above core, zero net', () => {
  assert.equal(code(quoteSellExactBase(sellState(), 1n)), 'SELL_CORE_ZERO');
  assert.equal(code(quoteSellExactBase(sellState(), 17n)), 'SELL_FEES_EXCEED_CORE');
  assert.equal(code(quoteSellExactBase(sellState({ creatorActive: false }), 34n)), 'SELL_NET_ZERO');
});

test('u64 amounts, u64 outputs, reserve overflow and u128 intermediates', () => {
  assert.equal(code(quoteBuyExactBase(S1, 0n)), 'AMOUNT_ZERO');
  assert.equal(code(quoteBuyExactBase(S1, U64_MAX + 1n)), 'AMOUNT_NOT_U64');
  assert.equal(code(quoteBuyExactBase(S1, 1_000_000n)), 'BUY_BASE_NOT_BELOW_RESERVE');
  assert.equal(code(quoteBuyExactBase(buyState({ baseReserve: 2n, quoteReserve: U64_MAX, virtualQuoteReserve: 0n }), 1n)), 'OUTPUT_NOT_U64');
  assert.equal(code(quoteBuyExactBase(buyState({ quoteReserve: U64_MAX - 10n, virtualQuoteReserve: 0n }), 1_000n)), 'POOL_RESERVE_OVERFLOW');
  assert.equal(code(quoteSellExactBase(sellState({ baseReserve: U64_MAX - 5n }), 10n)), 'POOL_RESERVE_OVERFLOW');
  assert.equal(code(quoteBuyExactBase(buyState({ baseReserve: U64_MAX, quoteReserve: 1n, virtualQuoteReserve: 1n << 126n }), 1n << 63n)), 'ARITHMETIC_RANGE');
  assert.equal(code(quoteBuyExactBase(buyState({ baseReserve: U64_MAX + 1n }), 1n)), 'RESERVE_NOT_U64');
  assert.equal(code(quoteBuyExactBase(buyState({ quoteReserve: 0n }), 1n)), 'RESERVE_ZERO');
});

test('unsupported or unresolved admission is a typed error, never a default', () => {
  const cases: Array<[Partial<DirectPrestate>, DirectKernelErrorCode]> = [
    [{ cashbackBps: 1n }, 'CASHBACK_UNSUPPORTED'],
    [{ quoteTransferFee: 'NONZERO' }, 'TRANSFER_FEE_UNSUPPORTED'],
    [{ baseTransferFee: 'UNKNOWN' }, 'TRANSFER_FEE_UNRESOLVED'],
    [{ holderRewardMode: 'UNKNOWN' }, 'HOLDER_REWARD_UNRESOLVED'],
    [{ rates: { ...RATES, lpBps: 10_001n } }, 'BPS_OUT_OF_RANGE'],
    [{ rates: { ...RATES, buybackBps: 10_001n } }, 'BPS_OUT_OF_RANGE'],
    [{ rateWitnessSide: 'SELL' }, 'RATE_WITNESS_SIDE_MISMATCH'],
  ];
  for (const [patch, expected] of cases) assert.equal(code(quoteBuyExactBase(buyState(patch), 1_000n)), expected);
  assert.equal(code(quoteSellExactBase(S1, 1_000n)), 'RATE_WITNESS_SIDE_MISMATCH');
});

const ACTIVE_CREATOR = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 1 : 0)));
const bn = (x: bigint) => new BN(x.toString());
const big = (x: BN) => BigInt(x.toString());
type SdkBuyBase = Parameters<typeof buyBaseInput>[0];
type SdkBuyQuote = Parameters<typeof buyQuoteInput>[0];
type SdkSell = Parameters<typeof sellBaseInput>[0];
/** Fallback globalConfig with feeConfig null exposes arithmetic only; slippage 0 selects no policy. */
const sdkArgs = (s: DirectPrestate) => ({
  slippage: 0, baseReserve: bn(s.baseReserve), quoteReserve: bn(s.quoteReserve), virtualQuoteReserves: bn(s.virtualQuoteReserve),
  globalConfig: { lpFeeBasisPoints: bn(s.rates.lpBps), protocolFeeBasisPoints: bn(s.rates.protocolBps), coinCreatorFeeBasisPoints: bn(s.rates.creatorBps) },
  baseMintAccount: { supply: 1n }, baseMint: PublicKey.default, coinCreator: s.creatorActive ? ACTIVE_CREATOR : PublicKey.default,
  creator: PublicKey.default, feeConfig: null, quoteMint: PublicKey.default,
});

type Case = {
  readonly name: string; readonly kind: 'BUY_BASE' | 'BUY_BUDGET' | 'SELL'; readonly s: DirectPrestate; readonly amount: bigint;
  readonly kernel: 'OK' | DirectKernelErrorCode; readonly sdk: 'EQUAL' | 'THROWS' | 'BASE_NOT_POSITIVE' | 'NET_ZERO';
};
/** BASE_NOT_POSITIVE and NET_ZERO rows are intended strictness differences: the SDK returns a zero or negative quantity, the kernel a typed error. */
const CASES: readonly Case[] = [
  { name: 'buy base', kind: 'BUY_BASE', s: S1, amount: 1_000n, kernel: 'OK', sdk: 'EQUAL' },
  { name: 'buy base larger', kind: 'BUY_BASE', s: S1, amount: 100_000n, kernel: 'OK', sdk: 'EQUAL' },
  { name: 'buy base inactive creator', kind: 'BUY_BASE', s: buyState({ creatorActive: false }), amount: 100_000n, kernel: 'OK', sdk: 'EQUAL' },
  { name: 'buy base zero V', kind: 'BUY_BASE', s: buyState({ virtualQuoteReserve: 0n }), amount: 1_000n, kernel: 'OK', sdk: 'EQUAL' },
  { name: 'buy base negative V', kind: 'BUY_BASE', s: buyState({ virtualQuoteReserve: -10_000n }), amount: 1_000n, kernel: 'OK', sdk: 'EQUAL' },
  { name: 'buy base equal to B', kind: 'BUY_BASE', s: S1, amount: 1_000_000n, kernel: 'BUY_BASE_NOT_BELOW_RESERVE', sdk: 'THROWS' },
  { name: 'buy base above B', kind: 'BUY_BASE', s: S1, amount: 1_000_001n, kernel: 'BUY_BASE_NOT_BELOW_RESERVE', sdk: 'THROWS' },
  { name: 'budget fee order', kind: 'BUY_BUDGET', s: S1, amount: 518n, kernel: 'OK', sdk: 'EQUAL' },
  { name: 'budget remainder', kind: 'BUY_BUDGET', s: REMAINDER, amount: 502n, kernel: 'OK', sdk: 'EQUAL' },
  { name: 'budget negative V', kind: 'BUY_BUDGET', s: buyState({ virtualQuoteReserve: -10_000n }), amount: 518n, kernel: 'OK', sdk: 'EQUAL' },
  { name: 'budget admissible tiny', kind: 'BUY_BUDGET', s: S1, amount: 5n, kernel: 'OK', sdk: 'EQUAL' },
  { name: 'budget e - 1 = 0', kind: 'BUY_BUDGET', s: S1, amount: 4n, kernel: 'BUDGET_TOO_SMALL', sdk: 'BASE_NOT_POSITIVE' },
  { name: 'budget negative e', kind: 'BUY_BUDGET', s: S1, amount: 2n, kernel: 'BUDGET_TOO_SMALL', sdk: 'BASE_NOT_POSITIVE' },
  { name: 'budget zero base', kind: 'BUY_BUDGET', s: buyState(TINY_BASE), amount: 1_000n, kernel: 'BASE_OUTPUT_ZERO', sdk: 'BASE_NOT_POSITIVE' },
  { name: 'sell', kind: 'SELL', s: sellState(), amount: 100_000n, kernel: 'OK', sdk: 'EQUAL' },
  { name: 'sell negative V', kind: 'SELL', s: sellState({ virtualQuoteReserve: -10_000n }), amount: 100_000n, kernel: 'OK', sdk: 'EQUAL' },
  { name: 'sell backed by thin Q', kind: 'SELL', s: sellState(S2), amount: 1_000n, kernel: 'OK', sdk: 'EQUAL' },
  { name: 'sell unbacked', kind: 'SELL', s: sellState(S2), amount: 100_000n, kernel: 'SELL_PHYSICAL_BACKING_INSUFFICIENT', sdk: 'THROWS' },
  { name: 'sell fees above core', kind: 'SELL', s: sellState(), amount: 17n, kernel: 'SELL_FEES_EXCEED_CORE', sdk: 'THROWS' },
  { name: 'sell zero core', kind: 'SELL', s: sellState(), amount: 1n, kernel: 'SELL_CORE_ZERO', sdk: 'NET_ZERO' },
  { name: 'sell zero net', kind: 'SELL', s: sellState({ creatorActive: false }), amount: 34n, kernel: 'SELL_NET_ZERO', sdk: 'NET_ZERO' },
];
function kernelSide<T>(c: Case, k: DirectKernelResult<T>): T | null {
  if (c.kernel === 'OK') return value(k);
  assert.equal(code(k), c.kernel, c.name);
  return null;
}
function compare(c: Case): void {
  const args = sdkArgs(c.s);
  if (c.kind === 'BUY_BASE') {
    const run = () => buyBaseInput({ ...args, base: bn(c.amount) } as unknown as SdkBuyBase), q = kernelSide(c, quoteBuyExactBase(c.s, c.amount));
    if (c.sdk === 'THROWS') return void assert.throws(run, Error, c.name);
    const r = run();
    assert.deepEqual([big(r.internalQuoteAmount), big(r.uiQuote)], [q?.coreQuote, q?.userQuoteIn], c.name);
  } else if (c.kind === 'BUY_BUDGET') {
    const r = buyQuoteInput({ ...args, quote: bn(c.amount) } as unknown as SdkBuyQuote), q = kernelSide(c, quoteBuyExactQuoteBudget(c.s, c.amount));
    if (c.sdk === 'BASE_NOT_POSITIVE') return void assert.ok(!r.base.gtn(0), c.name); // SDK returns 0 or a negative BN quotient
    assert.deepEqual([big(r.internalQuoteWithoutFees), big(r.base)], [q?.coreQuote, q?.baseOut], c.name);
  } else {
    const run = () => sellBaseInput({ ...args, base: bn(c.amount) } as unknown as SdkSell), q = kernelSide(c, quoteSellExactBase(c.s, c.amount));
    if (c.sdk === 'THROWS') return void assert.throws(run, Error, c.name);
    const r = run();
    if (c.sdk === 'NET_ZERO') return void assert.equal(big(r.uiQuote), 0n, c.name); // kernel rejects a zero-output sell instead
    assert.deepEqual([big(r.internalQuoteAmountOut), big(r.uiQuote)], [q?.coreQuote, q?.userNetQuote], c.name);
  }
}
test('differential against pinned SDK 1.20.0, with intended strictness differences explicit', () => {
  for (const c of CASES) compare(c);
});

