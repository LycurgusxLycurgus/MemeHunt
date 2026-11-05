/**
 * S16 direct PumpSwap conditional quote kernel, adapted from the actual Claude proposal.
 *
 * Pure bigint mirror of the pinned @pump-fun/pump-swap-sdk 1.20.0 buyBaseInput, buyQuoteInput and sellBaseInput with its
 * fee() and ceilDiv(), evaluated at ONE supplied prestate: the event-reported pre-trade base reserve B and physical quote
 * reserve Q, that same event signed virtual quote reserve V (Qe = Q + V), and fee rates witnessed by a same-side event at that
 * same prestate. computeFeesBps receives no trade amount, so holding the witnessed rates fixed while the order size varies is an
 * SDK-consistent conditional model. It is not historical fee-config, fee-tier or deployed-binary authority.
 *
 * No IO, no SDK import, no current-bank V fallback, no slippage, size, latency, exit, horizon, profile or anchor choice.
 * Multi-hop routes and their masked fees, cashback, taxed transfers and account admission are outside this kernel: they are
 * rejected or left to the caller, never defaulted to zero.
 *
 * Arithmetic: amounts and reserves are u64, V is i128, bps are 0..10000. Every product and numerator/denominator sum must fit
 * u128, otherwise ARITHMETIC_RANGE; nothing is evaluated in unbounded bigint and nothing is clamped. Divisions run only on
 * nonnegative operands with a positive divisor, so bigint truncation is floor and no negative-floor accident is possible.
 */

export const DIRECT_KERNEL_VERSION = 'pumpswap-direct-conditional-kernel-v1' as const;
export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;
const I128_MIN = -(1n << 127n), I128_MAX = (1n << 127n) - 1n, BPS = 10_000n;

export const DIRECT_KERNEL_ERROR_CODES = [
  'RATE_WITNESS_SIDE_MISMATCH', 'CASHBACK_UNSUPPORTED', 'TRANSFER_FEE_UNSUPPORTED', 'TRANSFER_FEE_UNRESOLVED', 'HOLDER_REWARD_UNRESOLVED',
  'RESERVE_NOT_U64', 'RESERVE_ZERO', 'VIRTUAL_QUOTE_NOT_I128', 'EFFECTIVE_QUOTE_NONPOSITIVE', 'BPS_OUT_OF_RANGE',
  'AMOUNT_NOT_U64', 'AMOUNT_ZERO', 'BUY_BASE_NOT_BELOW_RESERVE', 'BUDGET_TOO_SMALL', 'BASE_OUTPUT_ZERO',
  'SELL_CORE_ZERO', 'SELL_PHYSICAL_BACKING_INSUFFICIENT', 'SELL_FEES_EXCEED_CORE', 'SELL_NET_ZERO',
  'ARITHMETIC_RANGE', 'OUTPUT_NOT_U64', 'POOL_RESERVE_OVERFLOW', 'INVARIANT_BUDGET_EXCEEDED',
] as const;
export type DirectKernelErrorCode = typeof DIRECT_KERNEL_ERROR_CODES[number];
export type DirectKernelError = { readonly ok: false; readonly code: DirectKernelErrorCode };
export type DirectKernelResult<T> = { readonly ok: true; readonly value: T } | DirectKernelError;

/** ZERO_WITNESSED: a source witness for this leg. ZERO_DECLARED_PREMISE: a labelled premise. NONZERO and UNKNOWN are never admitted. */
export type TransferFeeStatus = 'ZERO_WITNESSED' | 'ZERO_DECLARED_PREMISE' | 'NONZERO' | 'UNKNOWN';
/** NONE: the event holder fields are 0/0. DUPLICATES_CREATOR_FEE: the accepted decoder rule that holder rewards mirror the creator fee. Supplied by the caller, never inferred from equal bps. */
export type HolderRewardMode = 'NONE' | 'DUPLICATES_CREATOR_FEE' | 'UNKNOWN';
export type DirectFeeRates = { readonly lpBps: bigint; readonly protocolBps: bigint; readonly creatorBps: bigint; readonly buybackBps: bigint };
export type DirectPrestate = {
  /** B: event-reported pre-trade pool base reserve. */
  readonly baseReserve: bigint;
  /** Q: event-reported pre-trade physical pool quote reserve. */
  readonly quoteReserve: bigint;
  /** V: that same event signed i128 virtual_quote_reserves; never a later bank value. */
  readonly virtualQuoteReserve: bigint;
  /** Rates reported by a same-side event at this same prestate. */
  readonly rates: DirectFeeRates;
  readonly rateWitnessSide: 'BUY' | 'SELL';
  /** Event coin_creator is not the default key; otherwise the creator fee and its bps are 0 (pinned SDK rule). */
  readonly creatorActive: boolean;
  readonly holderRewardMode: HolderRewardMode;
  /** Must be 0: cashback is unsupported, never assumed absent. */
  readonly cashbackBps: bigint;
  readonly quoteTransferFee: TransferFeeStatus;
  readonly baseTransferFee: TransferFeeStatus;
};

/** The user bears lp + protocol + creator only. Buyback and holder reward are subsets, never added. Accrued CreatorFeeUnclaimed is pool state, not an input or charge. */
export type DirectFees = {
  readonly lp: bigint; readonly protocol: bigint; readonly creator: bigint; readonly total: bigint;
  readonly buybackSubsetOfProtocol: bigint; readonly holderRewardSubsetOfCreator: bigint;
};
/** Physical vault changes. V only prices the curve; no post-trade V is asserted. */
export type DirectPoolDelta = { readonly baseDelta: bigint; readonly physicalQuoteDelta: bigint; readonly postBaseReserve: bigint; readonly postPhysicalQuoteReserve: bigint };
export type DirectDomain = {
  readonly kernelVersion: typeof DIRECT_KERNEL_VERSION;
  readonly effectiveQuoteReserve: bigint;
  /** The S16 native calibration observed POSITIVE only; ZERO and NEGATIVE are mathematically admitted but uncalibrated. */
  readonly virtualQuoteSign: 'POSITIVE' | 'ZERO' | 'NEGATIVE';
  readonly rateWitnessSide: 'BUY' | 'SELL';
  readonly quoteTransferFee: TransferFeeStatus;
  readonly baseTransferFee: TransferFeeStatus;
};
export type BuyExactBaseQuote = {
  readonly kind: 'BUY_EXACT_BASE'; readonly baseOut: bigint; readonly coreQuote: bigint; readonly fees: DirectFees;
  readonly userQuoteIn: bigint; readonly pool: DirectPoolDelta; readonly domain: DirectDomain;
};
/** coreQuote is the corrected effective quote e; conservativeCurveInput = e - 1 prices the curve; unspentBudget is never trading flow. */
export type BuyExactBudgetQuote = {
  readonly kind: 'BUY_EXACT_QUOTE_BUDGET'; readonly budget: bigint; readonly initialEffectiveCore: bigint; readonly coreQuote: bigint;
  readonly conservativeCurveInput: bigint; readonly baseOut: bigint; readonly fees: DirectFees; readonly bookedQuote: bigint;
  readonly unspentBudget: bigint; readonly pool: DirectPoolDelta; readonly domain: DirectDomain;
};
export type SellExactBaseQuote = {
  readonly kind: 'SELL_EXACT_BASE'; readonly baseIn: bigint; readonly coreQuote: bigint; readonly fees: DirectFees;
  readonly userNetQuote: bigint; readonly physicalPoolDebit: bigint; readonly pool: DirectPoolDelta; readonly domain: DirectDomain;
};

const err = (code: DirectKernelErrorCode): DirectKernelError => ({ ok: false, code });
const isU64 = (x: bigint) => x >= 0n && x <= U64_MAX;
const inU128 = (...xs: bigint[]) => xs.every(x => x >= 0n && x <= U128_MAX);
const amountError = (x: bigint): DirectKernelError | null => (!isU64(x) ? err('AMOUNT_NOT_U64') : x === 0n ? err('AMOUNT_ZERO') : null);

/** Pinned SDK ceilDiv for a >= 0 and b > 0. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (a < 0n || b <= 0n) throw new RangeError('DIRECT_KERNEL_CEILDIV_DOMAIN');
  return (a + b - 1n) / b;
}
/** Pinned SDK fee(): ceil(amount * bps / 10000), one component at a time. */
export const fee = (amount: bigint, bps: bigint): bigint => ceilDiv(amount * bps, BPS);

type Admitted = { readonly B: bigint; readonly Q: bigint; readonly Qe: bigint; readonly creatorBps: bigint; readonly domain: DirectDomain };
function admit(s: DirectPrestate, side: 'BUY' | 'SELL'): DirectKernelResult<Admitted> {
  if (s.rateWitnessSide !== side) return err('RATE_WITNESS_SIDE_MISMATCH');
  if (s.cashbackBps !== 0n) return err('CASHBACK_UNSUPPORTED');
  const transfer = [s.quoteTransferFee, s.baseTransferFee];
  if (transfer.includes('NONZERO')) return err('TRANSFER_FEE_UNSUPPORTED');
  if (transfer.includes('UNKNOWN')) return err('TRANSFER_FEE_UNRESOLVED');
  if (s.holderRewardMode === 'UNKNOWN') return err('HOLDER_REWARD_UNRESOLVED');
  const { baseReserve: B, quoteReserve: Q, virtualQuoteReserve: V, rates: r } = s;
  if (!isU64(B) || !isU64(Q)) return err('RESERVE_NOT_U64');
  if (B === 0n || Q === 0n) return err('RESERVE_ZERO');
  if (V < I128_MIN || V > I128_MAX) return err('VIRTUAL_QUOTE_NOT_I128');
  const Qe = Q + V;
  if (Qe <= 0n) return err('EFFECTIVE_QUOTE_NONPOSITIVE');
  if ([r.lpBps, r.protocolBps, r.creatorBps, r.buybackBps].some(b => b < 0n || b > BPS)) return err('BPS_OUT_OF_RANGE');
  const domain: DirectDomain = {
    kernelVersion: DIRECT_KERNEL_VERSION, effectiveQuoteReserve: Qe, virtualQuoteSign: V > 0n ? 'POSITIVE' : V === 0n ? 'ZERO' : 'NEGATIVE',
    rateWitnessSide: side, quoteTransferFee: s.quoteTransferFee, baseTransferFee: s.baseTransferFee,
  };
  return { ok: true, value: { B, Q, Qe, creatorBps: s.creatorActive ? r.creatorBps : 0n, domain } };
}
function split(core: bigint, s: DirectPrestate, creatorBps: bigint): DirectFees {
  const lp = fee(core, s.rates.lpBps), protocol = fee(core, s.rates.protocolBps), creator = fee(core, creatorBps);
  return {
    lp, protocol, creator, total: lp + protocol + creator,
    buybackSubsetOfProtocol: protocol * s.rates.buybackBps / BPS,
    holderRewardSubsetOfCreator: s.holderRewardMode === 'DUPLICATES_CREATOR_FEE' ? creator : 0n,
  };
}

/** buy / buy_v2: exact base out. core = ceil(Qe*b/(B-b)); fees are ceiled independently on core; the pool receives core + lp. */
export function quoteBuyExactBase(s: DirectPrestate, baseOut: bigint): DirectKernelResult<BuyExactBaseQuote> {
  const a = admit(s, 'BUY');
  if (!a.ok) return a;
  const bad = amountError(baseOut);
  if (bad) return bad;
  const { B, Q, Qe, creatorBps, domain } = a.value;
  if (baseOut >= B) return err('BUY_BASE_NOT_BELOW_RESERVE');
  const numerator = Qe * baseOut, denominator = B - baseOut;
  if (!inU128(numerator, numerator + denominator)) return err('ARITHMETIC_RANGE');
  const coreQuote = ceilDiv(numerator, denominator);
  if (coreQuote > U64_MAX) return err('OUTPUT_NOT_U64');
  const fees = split(coreQuote, s, creatorBps), userQuoteIn = coreQuote + fees.total, credit = coreQuote + fees.lp;
  if (userQuoteIn > U64_MAX) return err('OUTPUT_NOT_U64');
  if (Q + credit > U64_MAX) return err('POOL_RESERVE_OVERFLOW');
  return {
    ok: true,
    value: { kind: 'BUY_EXACT_BASE', baseOut, coreQuote, fees, userQuoteIn, pool: { baseDelta: -baseOut, physicalQuoteDelta: credit, postBaseReserve: B - baseOut, postPhysicalQuoteReserve: Q + credit }, domain },
  };
}

/**
 * buy_exact_quote_in / _v2 at budget A, in pinned SDK order: e0 = floor(A*10000/(10000+lp+protocol+activeCreator)); each fee
 * ceiled ONCE on e0; e = e0 - max(e0 + F0 - A, 0) with fees NOT recomputed; base = floor(B*(e-1)/(Qe+e-1)). Booked quote is
 * e + F0 and the remainder A - booked is explicit unspent budget.
 */
export function quoteBuyExactQuoteBudget(s: DirectPrestate, budget: bigint): DirectKernelResult<BuyExactBudgetQuote> {
  const a = admit(s, 'BUY');
  if (!a.ok) return a;
  const bad = amountError(budget);
  if (bad) return bad;
  const { B, Q, Qe, creatorBps, domain } = a.value;
  const initialEffectiveCore = budget * BPS / (BPS + s.rates.lpBps + s.rates.protocolBps + creatorBps);
  const fees = split(initialEffectiveCore, s, creatorBps), over = initialEffectiveCore + fees.total - budget;
  const coreQuote = over > 0n ? initialEffectiveCore - over : initialEffectiveCore, conservativeCurveInput = coreQuote - 1n;
  if (conservativeCurveInput <= 0n) return err('BUDGET_TOO_SMALL');
  const numerator = B * conservativeCurveInput, denominator = Qe + conservativeCurveInput;
  if (!inU128(numerator, denominator)) return err('ARITHMETIC_RANGE');
  const baseOut = numerator / denominator;
  if (baseOut === 0n) return err('BASE_OUTPUT_ZERO');
  const bookedQuote = coreQuote + fees.total, unspentBudget = budget - bookedQuote, credit = coreQuote + fees.lp;
  if (unspentBudget < 0n) return err('INVARIANT_BUDGET_EXCEEDED');
  if (Q + credit > U64_MAX) return err('POOL_RESERVE_OVERFLOW');
  return {
    ok: true,
    value: {
      kind: 'BUY_EXACT_QUOTE_BUDGET', budget, initialEffectiveCore, coreQuote, conservativeCurveInput, baseOut, fees, bookedQuote, unspentBudget,
      pool: { baseDelta: -baseOut, physicalQuoteDelta: credit, postBaseReserve: B - baseOut, postPhysicalQuoteReserve: Q + credit }, domain,
    },
  };
}

/** sell / sell_v2: exact base in. core = floor(Qe*b/(B+b)); fees ceiled independently; the vault pays core - lp and must hold it in physical Q. */
export function quoteSellExactBase(s: DirectPrestate, baseIn: bigint): DirectKernelResult<SellExactBaseQuote> {
  const a = admit(s, 'SELL');
  if (!a.ok) return a;
  const bad = amountError(baseIn);
  if (bad) return bad;
  const { B, Q, Qe, creatorBps, domain } = a.value;
  const postBaseReserve = B + baseIn;
  if (postBaseReserve > U64_MAX) return err('POOL_RESERVE_OVERFLOW');
  const numerator = Qe * baseIn;
  if (!inU128(numerator)) return err('ARITHMETIC_RANGE');
  const coreQuote = numerator / postBaseReserve;
  if (coreQuote === 0n) return err('SELL_CORE_ZERO');
  if (coreQuote > U64_MAX) return err('OUTPUT_NOT_U64');
  const fees = split(coreQuote, s, creatorBps), physicalPoolDebit = coreQuote - fees.lp, userNetQuote = coreQuote - fees.total;
  // Pinned SDK order: real-vault backing (physical Q, never Q + V) before the sign of the user net.
  if (physicalPoolDebit > Q) return err('SELL_PHYSICAL_BACKING_INSUFFICIENT');
  if (userNetQuote < 0n) return err('SELL_FEES_EXCEED_CORE');
  if (userNetQuote === 0n) return err('SELL_NET_ZERO');
  return {
    ok: true,
    value: { kind: 'SELL_EXACT_BASE', baseIn, coreQuote, fees, userNetQuote, physicalPoolDebit, pool: { baseDelta: baseIn, physicalQuoteDelta: -physicalPoolDebit, postBaseReserve, postPhysicalQuoteReserve: Q - physicalPoolDebit }, domain },
  };
}

