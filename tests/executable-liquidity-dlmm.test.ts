import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type BN from 'bn.js';
import type { Bin, BinArrayAccount, LbPair, sParameters, vParameters } from '@meteora-ag/dlmm';
import type { PublicKey } from '@solana/web3.js';
import {
  DLMM_BPS,
  DLMM_KERNEL_VERSION,
  DLMM_PROGRAM_ID,
  DLMM_Q64,
  DLMM_U64_MAX,
  DlmmKernelError,
  dlmmAdmissibilityCoefficients,
  dlmmLocalBinQuote,
  evaluateDlmmNetClosedForm,
  prepareDlmmKernel,
  quoteDlmmExactIn,
  solveDlmmCapacity,
  verifyDlmmMaximalityCertificate,
  type DlmmCapacityKnown,
  type DlmmExactInQuote,
  type DlmmKernelErrorCode,
  type DlmmKernelInput,
  type DlmmPreparedKernel,
} from '../src/providers/executable-liquidity-dlmm.js';


// ===== BEGIN DLMM INDEPENDENT SOURCE ORACLE (@meteora-ag/dlmm 1.9.14 recovered source) =====
// Independent BigInt interpreter of helpers/bin.ts, helpers/fee.ts, helpers/lbPair.ts getFeeMode and
// DLMM.updateReference/updateVolatilityAccumulator. Import-free; never calls production code, segments,
// envelopes, or SDK swapExactInQuoteAtBin/swapQuote. Zero transfer tax is an explicit fixture precondition;
// transfer-tax/hook behaviour is not modeled.

const DLMM_ORACLE_FEE_PRECISION = 1_000_000_000n;
const DLMM_ORACLE_MAX_FEE_RATE = 100_000_000n;
const DLMM_ORACLE_Q64 = 1n << 64n;
const DLMM_ORACLE_BASIS_POINT_MAX = 10_000n;
const DLMM_ORACLE_VARIABLE_FEE_DIVISOR = 100_000_000_000n;
const DLMM_ORACLE_MAX_ENUMERATION_CAP = 4_096n;

type DlmmOracleCollectFeeMode = 'InputOnly' | 'OnlyY';

interface DlmmOracleBin {
  readonly id: bigint;
  readonly priceQ64: bigint;
  readonly amountX: bigint;
  readonly amountY: bigint;
  readonly limitOrderAskSide: boolean;
  readonly openOrderAmount: bigint;
  readonly processedOrderRemainingAmount: bigint;
}

interface DlmmOracleStaticParameters {
  readonly baseFactor: bigint;
  readonly baseFeePowerFactor: bigint;
  readonly variableFeeControl: bigint;
  readonly maxVolatilityAccumulator: bigint;
  readonly filterPeriod: bigint;
  readonly decayPeriod: bigint;
  readonly reductionFactor: bigint;
}

interface DlmmOracleVariableParameters {
  readonly volatilityAccumulator: bigint;
  readonly volatilityReference: bigint;
  readonly indexReference: bigint;
  readonly lastUpdateTimestamp: bigint;
}

interface DlmmOraclePool {
  readonly binStep: bigint;
  readonly activeId: bigint;
  readonly swapForY: boolean;
  readonly collectFeeMode: DlmmOracleCollectFeeMode;
  readonly supportLimitOrder: boolean;
  // Explicit quote clock (integer unix seconds); the oracle never reads Date.now().
  readonly currentTimestamp: bigint;
  readonly sParameters: DlmmOracleStaticParameters;
  readonly vParameters: DlmmOracleVariableParameters;
  // Complete liquidity: any id not listed (or listed with zero direction capacity) is empty.
  readonly bins: readonly DlmmOracleBin[];
  readonly zeroTransferTaxAdmitted: true;
}

interface DlmmOracleReference {
  readonly indexReference: bigint;
  readonly volatilityReference: bigint;
  readonly update: 'NONE' | 'FILTER_DECAYED' | 'DECAY_ZERO';
}

interface DlmmOracleLayers {
  readonly mmIn: bigint;
  readonly mmOut: bigint;
  readonly processedIn: bigint;
  readonly processedOut: bigint;
  readonly openIn: bigint;
  readonly openOut: bigint;
}

interface DlmmOracleBinStep {
  readonly binId: bigint;
  readonly volatilityAccumulator: bigint;
  readonly feeNumerator: bigint;
  readonly offeredIn: bigint;
  readonly consumedIn: bigint;
  readonly excludedFeeIn: bigint;
  readonly grossOut: bigint;
  readonly netOut: bigint;
  readonly tradingFee: bigint;
  readonly feePlusProtocolFee: bigint;
  readonly absorbedOffered: boolean;
  readonly layers: DlmmOracleLayers;
}

interface DlmmOracleQuote {
  readonly input: bigint;
  readonly consumed: bigint;
  readonly remainder: bigint;
  readonly complete: boolean;
  readonly grossOut: bigint;
  readonly net: bigint;
  readonly feeOnInput: boolean;
  readonly inputTradingFee: bigint;
  readonly outputTradingFee: bigint;
  // Source fee + protocolFee summed (partition not modeled); differs from tradingFee only in splitFee's zero branch.
  readonly feePlusProtocolFee: bigint;
  readonly reference: DlmmOracleReference;
  readonly steps: readonly DlmmOracleBinStep[];
}

interface DlmmOracleBenchmark {
  readonly num: bigint;
  readonly den: bigint;
  readonly impactBps: bigint;
}

interface DlmmOracleSolve {
  readonly scope: 'CAP_SCOPED_EXHAUSTIVE';
  readonly cap: bigint;
  // table[x] is the quote for input x, x = 0..cap.
  readonly table: readonly DlmmOracleQuote[];
  readonly admissibleInputs: readonly bigint[];
  readonly maxNet: bigint;
  readonly smallestInputAtMaxNet: bigint;
  readonly greatestAdmissibleInput: bigint;
  readonly largestFullyConsumableInput: bigint;
  // true => liquidity may extend beyond cap; results are NOT a physical maximum.
  readonly capFullyConsumable: boolean;
}

interface DlmmOracleBinSpec {
  readonly id: string;
  readonly priceQ64: string;
  readonly amountX: string;
  readonly amountY: string;
  readonly limitOrderAskSide: boolean;
  readonly openOrderAmount: string;
  readonly processedOrderRemainingAmount: string;
}

interface DlmmOraclePoolSpec {
  readonly binStep: string;
  readonly activeId: string;
  readonly swapForY: boolean;
  readonly collectFeeMode: DlmmOracleCollectFeeMode;
  readonly supportLimitOrder: boolean;
  readonly currentTimestamp: string;
  readonly sParameters: { readonly [K in keyof DlmmOracleStaticParameters]: string };
  readonly vParameters: { readonly [K in keyof DlmmOracleVariableParameters]: string };
  readonly bins: readonly DlmmOracleBinSpec[];
  readonly zeroTransferTaxAdmitted: true;
}

interface DlmmOracleExpectedPoint {
  readonly x: string;
  readonly consumed: string;
  readonly net: string;
  readonly remainder: string;
  readonly complete: boolean;
}

interface DlmmOracleExpectedSolve {
  readonly maxNet?: string;
  readonly smallestInputAtMaxNet?: string;
  readonly greatestAdmissibleInput?: string;
  readonly largestFullyConsumableInput?: string;
  readonly capFullyConsumable?: boolean;
  readonly admissibleInputs?: readonly string[];
}

interface DlmmOracleCaseSpec {
  readonly id: string;
  readonly covers?: readonly string[];
  readonly notes?: string;
  readonly bruteforce: boolean;
  readonly pool: DlmmOraclePoolSpec;
  readonly benchmark?: { readonly num: string; readonly den: string; readonly impactBps: string };
  readonly cap?: string;
  readonly expectedPoints: readonly DlmmOracleExpectedPoint[];
  readonly expectedSolve?: DlmmOracleExpectedSolve;
}

function dlmmOracleFail(message: string): never {
  throw new Error(`dlmm oracle: ${message}`);
}

function dlmmOracleRequire(condition: boolean, message: string): asserts condition {
  if (!condition) dlmmOracleFail(message);
}

// Non-negative mulDiv; roundUp mirrors Rounding.Up (ceil), otherwise floor.
function dlmmOracleDiv(numerator: bigint, denominator: bigint, roundUp: boolean): bigint {
  const quotient = numerator / denominator;
  return roundUp && quotient * denominator !== numerator ? quotient + 1n : quotient;
}

function dlmmOracleValidatePool(pool: DlmmOraclePool): void {
  dlmmOracleRequire(pool.zeroTransferTaxAdmitted === true, 'zero transfer-tax admission is a required fixture precondition');
  dlmmOracleRequire(pool.binStep > 0n, 'binStep must be positive');
  dlmmOracleRequire(pool.collectFeeMode === 'InputOnly' || pool.collectFeeMode === 'OnlyY', 'collectFeeMode must be InputOnly or OnlyY');
  const s = pool.sParameters;
  dlmmOracleRequire(
    s.baseFactor >= 0n && s.baseFeePowerFactor >= 0n && s.variableFeeControl >= 0n &&
      s.maxVolatilityAccumulator >= 0n && s.filterPeriod >= 0n && s.decayPeriod >= 0n && s.reductionFactor >= 0n,
    'sParameters must be non-negative',
  );
  dlmmOracleRequire(
    pool.vParameters.volatilityAccumulator >= 0n && pool.vParameters.volatilityReference >= 0n,
    'volatility state must be non-negative',
  );
  const ids = new Set<bigint>();
  for (const bin of pool.bins) {
    dlmmOracleRequire(!ids.has(bin.id), `duplicate bin id ${bin.id}`);
    ids.add(bin.id);
    dlmmOracleRequire(bin.priceQ64 > 0n, `bin ${bin.id} priceQ64 must be positive`);
    dlmmOracleRequire(
      bin.amountX >= 0n && bin.amountY >= 0n && bin.openOrderAmount >= 0n && bin.processedOrderRemainingAmount >= 0n,
      `bin ${bin.id} amounts must be non-negative`,
    );
  }
}

// helpers/lbPair.ts getFeeMode: InputOnly -> fee on input; OnlyY -> fee on input iff Y->X, on output (Y) iff X->Y.
function dlmmOracleFeeOnInput(mode: DlmmOracleCollectFeeMode, swapForY: boolean): boolean {
  return mode === 'InputOnly' ? true : !swapForY;
}

// DLMM.updateReference, applied once to a clone at the initial activeId; pool state is never mutated.
function dlmmOracleReference(pool: DlmmOraclePool): DlmmOracleReference {
  const s = pool.sParameters;
  const v = pool.vParameters;
  const elapsed = pool.currentTimestamp - v.lastUpdateTimestamp;
  if (elapsed >= s.filterPeriod) {
    if (elapsed < s.decayPeriod) {
      return {
        indexReference: pool.activeId,
        volatilityReference: (v.volatilityAccumulator * s.reductionFactor) / DLMM_ORACLE_BASIS_POINT_MAX,
        update: 'FILTER_DECAYED',
      };
    }
    return { indexReference: pool.activeId, volatilityReference: 0n, update: 'DECAY_ZERO' };
  }
  return { indexReference: v.indexReference, volatilityReference: v.volatilityReference, update: 'NONE' };
}

// DLMM.updateVolatilityAccumulator overwrites the accumulator from the reference only: a pure function of binId.
function dlmmOracleVolatilityAccumulator(reference: DlmmOracleReference, maxVolatilityAccumulator: bigint, binId: bigint): bigint {
  const delta = reference.indexReference - binId;
  const deltaId = delta < 0n ? -delta : delta;
  const next = reference.volatilityReference + deltaId * DLMM_ORACLE_BASIS_POINT_MAX;
  return next < maxVolatilityAccumulator ? next : maxVolatilityAccumulator;
}

// helpers/fee.ts getTotalFee = min(getBaseFee + getVariableFee, MAX_FEE_RATE).
function dlmmOracleTotalFeeNumerator(binStep: bigint, s: DlmmOracleStaticParameters, volatilityAccumulator: bigint): bigint {
  const baseFee = s.baseFactor * binStep * 10n * 10n ** s.baseFeePowerFactor;
  let variableFee = 0n;
  if (s.variableFeeControl > 0n) {
    const scaled = volatilityAccumulator * binStep;
    variableFee = dlmmOracleDiv(s.variableFeeControl * scaled * scaled, DLMM_ORACLE_VARIABLE_FEE_DIVISOR, true);
  }
  const total = baseFee + variableFee;
  return total > DLMM_ORACLE_MAX_FEE_RATE ? DLMM_ORACLE_MAX_FEE_RATE : total;
}

// getAmountIn(..., Rounding.Up): X->Y shlDiv(out, price, 64); Y->X mulShr(out, price, 64).
function dlmmOracleAmountIn(amountOut: bigint, priceQ64: bigint, swapForY: boolean): bigint {
  return swapForY
    ? dlmmOracleDiv(amountOut * DLMM_ORACLE_Q64, priceQ64, true)
    : dlmmOracleDiv(amountOut * priceQ64, DLMM_ORACLE_Q64, true);
}

// getAmountOut (Rounding.Down).
function dlmmOracleAmountOut(amountIn: bigint, priceQ64: bigint, swapForY: boolean): bigint {
  return swapForY ? (amountIn * priceQ64) / DLMM_ORACLE_Q64 : (amountIn * DLMM_ORACLE_Q64) / priceQ64;
}

interface DlmmOracleLayerFill {
  readonly amountIn: bigint;
  readonly amountLeft: bigint;
  readonly amountOut: bigint;
}

// calculateExactInFillAmount.
function dlmmOracleFillLayer(amount: bigint, maxAmountOut: bigint, priceQ64: bigint, swapForY: boolean): DlmmOracleLayerFill {
  const maxAmountIn = dlmmOracleAmountIn(maxAmountOut, priceQ64, swapForY);
  if (amount >= maxAmountIn) {
    return { amountIn: maxAmountIn, amountLeft: amount - maxAmountIn, amountOut: maxAmountOut };
  }
  return { amountIn: amount, amountLeft: 0n, amountOut: dlmmOracleAmountOut(amount, priceQ64, swapForY) };
}

// getLimitOrderAmountsBySwapDirection: bid orders serve X->Y, ask orders serve Y->X.
function dlmmOracleUsableOrders(bin: DlmmOracleBin, swapForY: boolean): { readonly open: bigint; readonly processed: bigint } {
  const usable = swapForY ? !bin.limitOrderAskSide : bin.limitOrderAskSide;
  return usable
    ? { open: bin.openOrderAmount, processed: bin.processedOrderRemainingAmount }
    : { open: 0n, processed: 0n };
}

// getBinMaxAmountOut via getLimitOrderLiquidity.
function dlmmOracleBinMaxAmountOut(bin: DlmmOracleBin, swapForY: boolean, supportLimitOrder: boolean): bigint {
  const orders = supportLimitOrder ? bin.openOrderAmount + bin.processedOrderRemainingAmount : 0n;
  const orderX = bin.limitOrderAskSide ? orders : 0n;
  const orderY = bin.limitOrderAskSide ? 0n : orders;
  return swapForY ? bin.amountY + orderY : bin.amountX + orderX;
}

interface DlmmOracleBinFill {
  readonly amountIn: bigint;
  readonly amountLeft: bigint;
  readonly amountOut: bigint;
  readonly layers: DlmmOracleLayers;
}

// getExactInFillAmountResult: MM -> processed -> open, each with its own ceil/floor.
function dlmmOracleFillBin(bin: DlmmOracleBin, amount: bigint, swapForY: boolean, supportLimitOrder: boolean): DlmmOracleBinFill {
  const mm = dlmmOracleFillLayer(amount, swapForY ? bin.amountY : bin.amountX, bin.priceQ64, swapForY);
  let processed: DlmmOracleLayerFill = { amountIn: 0n, amountLeft: 0n, amountOut: 0n };
  let open: DlmmOracleLayerFill = { amountIn: 0n, amountLeft: 0n, amountOut: 0n };
  if (supportLimitOrder && mm.amountLeft !== 0n) {
    const orders = dlmmOracleUsableOrders(bin, swapForY);
    processed = dlmmOracleFillLayer(mm.amountLeft, orders.processed, bin.priceQ64, swapForY);
    if (processed.amountLeft !== 0n) {
      open = dlmmOracleFillLayer(processed.amountLeft, orders.open, bin.priceQ64, swapForY);
    }
  }
  const amountIn = mm.amountIn + processed.amountIn + open.amountIn;
  return {
    amountIn,
    amountLeft: amount - amountIn,
    amountOut: mm.amountOut + processed.amountOut + open.amountOut,
    layers: {
      mmIn: mm.amountIn,
      mmOut: mm.amountOut,
      processedIn: processed.amountIn,
      processedOut: processed.amountOut,
      openIn: open.amountIn,
      openOut: open.amountOut,
    },
  };
}

type DlmmOracleBinQuote = Omit<DlmmOracleBinStep, 'binId' | 'volatilityAccumulator' | 'feeNumerator'>;

// swapExactInQuoteAtBin arithmetic, independently restated.
function dlmmOracleQuoteAtBin(
  bin: DlmmOracleBin,
  feeNumerator: bigint,
  offeredIn: bigint,
  swapForY: boolean,
  supportLimitOrder: boolean,
  feeOnInput: boolean,
): DlmmOracleBinQuote {
  const feeDenominator = DLMM_ORACLE_FEE_PRECISION - feeNumerator;
  let tradingFee = 0n;
  let excludedFeeIn = offeredIn;
  if (feeOnInput) {
    tradingFee = dlmmOracleDiv(offeredIn * feeNumerator, DLMM_ORACLE_FEE_PRECISION, true);
    excludedFeeIn = offeredIn - tradingFee;
  }
  const fill = dlmmOracleFillBin(bin, excludedFeeIn, swapForY, supportLimitOrder);
  // amountLeft == 0: the whole offered (fee-included) input is absorbed by this bin.
  // amountLeft != 0: the included amount is recomputed from the excluded amount actually filled.
  let consumedIn = offeredIn;
  if (fill.amountLeft !== 0n) {
    excludedFeeIn -= fill.amountLeft;
    if (feeOnInput) {
      consumedIn = dlmmOracleDiv(excludedFeeIn * DLMM_ORACLE_FEE_PRECISION, feeDenominator, true);
      tradingFee = consumedIn - excludedFeeIn;
    } else {
      consumedIn = excludedFeeIn;
    }
  }
  let netOut = fill.amountOut;
  if (!feeOnInput) {
    tradingFee = dlmmOracleDiv(fill.amountOut * feeNumerator, DLMM_ORACLE_FEE_PRECISION, true);
    netOut = fill.amountOut - tradingFee;
  }
  dlmmOracleRequire(consumedIn <= offeredIn && excludedFeeIn === fill.amountIn, `bin ${bin.id} fee/fill accounting violated`);
  return {
    offeredIn,
    consumedIn,
    excludedFeeIn,
    grossOut: fill.amountOut,
    netOut,
    tradingFee,
    // splitFee returns fee = protocolFee = 0 when the filled (fee-excluded) amount is zero.
    feePlusProtocolFee: fill.amountIn === 0n ? 0n : tradingFee,
    absorbedOffered: fill.amountLeft === 0n,
    layers: fill.layers,
  };
}

// Visit order: X->Y descending ids from activeId, Y->X ascending; bins with zero direction capacity are skipped.
function dlmmOracleTraversal(pool: DlmmOraclePool): readonly DlmmOracleBin[] {
  const visited = pool.bins.filter(
    (bin) =>
      (pool.swapForY ? bin.id <= pool.activeId : bin.id >= pool.activeId) &&
      dlmmOracleBinMaxAmountOut(bin, pool.swapForY, pool.supportLimitOrder) > 0n,
  );
  return visited.sort((a, b) => {
    const delta = pool.swapForY ? b.id - a.id : a.id - b.id;
    return delta < 0n ? -1 : delta > 0n ? 1 : 0;
  });
}

function dlmmOracleQuote(pool: DlmmOraclePool, input: bigint): DlmmOracleQuote {
  dlmmOracleValidatePool(pool);
  dlmmOracleRequire(input >= 0n, 'input must be non-negative');
  const feeOnInput = dlmmOracleFeeOnInput(pool.collectFeeMode, pool.swapForY);
  const reference = dlmmOracleReference(pool);
  const steps: DlmmOracleBinStep[] = [];
  let remaining = input;
  let grossOut = 0n;
  let net = 0n;
  let tradingFee = 0n;
  let feePlusProtocolFee = 0n;
  for (const bin of dlmmOracleTraversal(pool)) {
    if (remaining === 0n) break;
    const volatilityAccumulator = dlmmOracleVolatilityAccumulator(reference, pool.sParameters.maxVolatilityAccumulator, bin.id);
    const feeNumerator = dlmmOracleTotalFeeNumerator(pool.binStep, pool.sParameters, volatilityAccumulator);
    const binQuote = dlmmOracleQuoteAtBin(bin, feeNumerator, remaining, pool.swapForY, pool.supportLimitOrder, feeOnInput);
    // swapQuote accumulates only when amountIn != 0.
    if (binQuote.consumedIn === 0n) {
      dlmmOracleRequire(binQuote.grossOut === 0n, `bin ${bin.id} produced output without input`);
      continue;
    }
    remaining -= binQuote.consumedIn;
    grossOut += binQuote.grossOut;
    net += binQuote.netOut;
    tradingFee += binQuote.tradingFee;
    feePlusProtocolFee += binQuote.feePlusProtocolFee;
    steps.push({ binId: bin.id, volatilityAccumulator, feeNumerator, ...binQuote });
  }
  return {
    input,
    consumed: input - remaining,
    remainder: remaining,
    complete: remaining === 0n,
    grossOut,
    net,
    feeOnInput,
    inputTradingFee: feeOnInput ? tradingFee : 0n,
    outputTradingFee: feeOnInput ? 0n : tradingFee,
    feePlusProtocolFee,
    reference,
    steps,
  };
}

function dlmmOracleValidateBenchmark(benchmark: DlmmOracleBenchmark): void {
  dlmmOracleRequire(benchmark.num > 0n && benchmark.den > 0n, 'benchmark num/den must be positive');
  dlmmOracleRequire(
    benchmark.impactBps >= 0n && benchmark.impactBps <= DLMM_ORACLE_BASIS_POINT_MAX,
    'benchmark impactBps must be within 0..10000',
  );
}

// Admissible iff COMPLETE and N*den*10000 >= x*num*(10000-L).
function dlmmOracleBenchmarkAdmits(quote: DlmmOracleQuote, benchmark: DlmmOracleBenchmark): boolean {
  return (
    quote.complete &&
    quote.net * benchmark.den * DLMM_ORACLE_BASIS_POINT_MAX >=
      quote.input * benchmark.num * (DLMM_ORACLE_BASIS_POINT_MAX - benchmark.impactBps)
  );
}

// Exhaustive x = 0..cap; no monotonicity, binary search or envelope is assumed.
function dlmmOracleSolve(pool: DlmmOraclePool, benchmark: DlmmOracleBenchmark, cap: bigint): DlmmOracleSolve {
  dlmmOracleValidateBenchmark(benchmark);
  dlmmOracleRequire(cap >= 0n && cap <= DLMM_ORACLE_MAX_ENUMERATION_CAP, `cap must be within 0..${DLMM_ORACLE_MAX_ENUMERATION_CAP}`);
  const table: DlmmOracleQuote[] = [];
  const admissibleInputs: bigint[] = [];
  let maxNet = -1n;
  let smallestInputAtMaxNet = -1n;
  let greatestAdmissibleInput = -1n;
  let largestFullyConsumableInput = -1n;
  for (let x = 0n; x <= cap; x += 1n) {
    const quote = dlmmOracleQuote(pool, x);
    table.push(quote);
    if (quote.complete) largestFullyConsumableInput = x;
    if (dlmmOracleBenchmarkAdmits(quote, benchmark)) {
      admissibleInputs.push(x);
      greatestAdmissibleInput = x;
      if (quote.net > maxNet) {
        maxNet = quote.net;
        smallestInputAtMaxNet = x;
      }
    }
  }
  dlmmOracleRequire(admissibleInputs[0] === 0n, 'x=0 must be canonically admissible');
  const last = table[table.length - 1];
  dlmmOracleRequire(last !== undefined, 'empty quote table');
  return {
    scope: 'CAP_SCOPED_EXHAUSTIVE',
    cap,
    table,
    admissibleInputs,
    maxNet,
    smallestInputAtMaxNet,
    greatestAdmissibleInput,
    largestFullyConsumableInput,
    capFullyConsumable: last.complete,
  };
}

function dlmmOracleBigInt(text: string, field: string): bigint {
  dlmmOracleRequire(/^-?[0-9]+$/.test(text), `${field} must be a decimal integer string, got ${JSON.stringify(text)}`);
  return BigInt(text);
}

function dlmmOracleParsePool(spec: DlmmOraclePoolSpec): DlmmOraclePool {
  const s = spec.sParameters;
  const v = spec.vParameters;
  const pool: DlmmOraclePool = Object.freeze({
    binStep: dlmmOracleBigInt(spec.binStep, 'binStep'),
    activeId: dlmmOracleBigInt(spec.activeId, 'activeId'),
    swapForY: spec.swapForY,
    collectFeeMode: spec.collectFeeMode,
    supportLimitOrder: spec.supportLimitOrder,
    currentTimestamp: dlmmOracleBigInt(spec.currentTimestamp, 'currentTimestamp'),
    sParameters: Object.freeze({
      baseFactor: dlmmOracleBigInt(s.baseFactor, 'baseFactor'),
      baseFeePowerFactor: dlmmOracleBigInt(s.baseFeePowerFactor, 'baseFeePowerFactor'),
      variableFeeControl: dlmmOracleBigInt(s.variableFeeControl, 'variableFeeControl'),
      maxVolatilityAccumulator: dlmmOracleBigInt(s.maxVolatilityAccumulator, 'maxVolatilityAccumulator'),
      filterPeriod: dlmmOracleBigInt(s.filterPeriod, 'filterPeriod'),
      decayPeriod: dlmmOracleBigInt(s.decayPeriod, 'decayPeriod'),
      reductionFactor: dlmmOracleBigInt(s.reductionFactor, 'reductionFactor'),
    }),
    vParameters: Object.freeze({
      volatilityAccumulator: dlmmOracleBigInt(v.volatilityAccumulator, 'volatilityAccumulator'),
      volatilityReference: dlmmOracleBigInt(v.volatilityReference, 'volatilityReference'),
      indexReference: dlmmOracleBigInt(v.indexReference, 'indexReference'),
      lastUpdateTimestamp: dlmmOracleBigInt(v.lastUpdateTimestamp, 'lastUpdateTimestamp'),
    }),
    bins: Object.freeze(
      spec.bins.map((bin, i) =>
        Object.freeze({
          id: dlmmOracleBigInt(bin.id, `bins[${i}].id`),
          priceQ64: dlmmOracleBigInt(bin.priceQ64, `bins[${i}].priceQ64`),
          amountX: dlmmOracleBigInt(bin.amountX, `bins[${i}].amountX`),
          amountY: dlmmOracleBigInt(bin.amountY, `bins[${i}].amountY`),
          limitOrderAskSide: bin.limitOrderAskSide,
          openOrderAmount: dlmmOracleBigInt(bin.openOrderAmount, `bins[${i}].openOrderAmount`),
          processedOrderRemainingAmount: dlmmOracleBigInt(bin.processedOrderRemainingAmount, `bins[${i}].processedOrderRemainingAmount`),
        }),
      ),
    ),
    zeroTransferTaxAdmitted: spec.zeroTransferTaxAdmitted,
  });
  dlmmOracleValidatePool(pool);
  return pool;
}

function dlmmOracleParseBenchmark(spec: { readonly num: string; readonly den: string; readonly impactBps: string }): DlmmOracleBenchmark {
  const benchmark = {
    num: dlmmOracleBigInt(spec.num, 'benchmark.num'),
    den: dlmmOracleBigInt(spec.den, 'benchmark.den'),
    impactBps: dlmmOracleBigInt(spec.impactBps, 'benchmark.impactBps'),
  };
  dlmmOracleValidateBenchmark(benchmark);
  return benchmark;
}

// Self-check of a normalized case against its hand-derived expectations; returns the solve for bruteforce cases.
function dlmmOracleCheckCase(spec: DlmmOracleCaseSpec): DlmmOracleSolve | undefined {
  const pool = dlmmOracleParsePool(spec.pool);
  for (const point of spec.expectedPoints) {
    const quote = dlmmOracleQuote(pool, dlmmOracleBigInt(point.x, `${spec.id}.x`));
    dlmmOracleRequire(quote.consumed + quote.remainder === quote.input, `${spec.id} x=${point.x}: conservation violated`);
    const actual = JSON.stringify({
      consumed: quote.consumed.toString(),
      net: quote.net.toString(),
      remainder: quote.remainder.toString(),
      complete: quote.complete,
    });
    const expected = JSON.stringify({
      consumed: point.consumed,
      net: point.net,
      remainder: point.remainder,
      complete: point.complete,
    });
    dlmmOracleRequire(actual === expected, `${spec.id} x=${point.x}: expected ${expected}, got ${actual}`);
  }
  if (!spec.bruteforce) return undefined;
  dlmmOracleRequire(spec.benchmark !== undefined && spec.cap !== undefined, `${spec.id}: bruteforce case needs benchmark and cap`);
  const solved = dlmmOracleSolve(pool, dlmmOracleParseBenchmark(spec.benchmark), dlmmOracleBigInt(spec.cap, `${spec.id}.cap`));
  const e = spec.expectedSolve ?? {};
  const compare = (name: string, expected: string | boolean | undefined, actual: string | boolean): void => {
    if (expected !== undefined && expected !== actual) {
      dlmmOracleFail(`${spec.id} ${name}: expected ${String(expected)}, got ${String(actual)}`);
    }
  };
  compare('maxNet', e.maxNet, solved.maxNet.toString());
  compare('smallestInputAtMaxNet', e.smallestInputAtMaxNet, solved.smallestInputAtMaxNet.toString());
  compare('greatestAdmissibleInput', e.greatestAdmissibleInput, solved.greatestAdmissibleInput.toString());
  compare('largestFullyConsumableInput', e.largestFullyConsumableInput, solved.largestFullyConsumableInput.toString());
  compare('capFullyConsumable', e.capFullyConsumable, solved.capFullyConsumable);
  if (e.admissibleInputs !== undefined) {
    compare('admissibleInputs', e.admissibleInputs.join(','), solved.admissibleInputs.map(String).join(','));
  }
  return solved;
}
// ===== END DLMM INDEPENDENT SOURCE ORACLE =====


// Normalized hand-derived oracle cases, inserted verbatim. Their arbitrary-Q prices are independent arithmetic
// fixtures for the oracle self-checks only; production parity uses the canonical SDK-price transforms below.
const DLMM_INDEPENDENT_NORMALIZED_CASES: readonly DlmmOracleCaseSpec[] = [
  {
    "id": "DLMM_TRAP_IA_PREVIOUS_BIN_STEALS_NEXT_ENDPOINT",
    "covers": [
      "source-trap",
      "InputOnly-X2Y",
      "inputfee-absorption-I-A",
      "previous-bin-steals-next-endpoint",
      "mininput-plateau-tie",
      "nonreset-old-index-reference",
      "x0-canonical"
    ],
    "notes": "E9/I10/A11 at bin1 (fee 1e8 from va=10000), bin0 fee 0. Summed full outputs 10 unreachable with full consumption. priceQ64 of bin1 is floor(Q*101/100); trap holds for any Q<P<9Q/8 so SDK getQPriceFromId(1,100) parity is separate. L=2000 chosen so x=11 is admissible.",
    "bruteforce": true,
    "pool": {
      "binStep": "100",
      "activeId": "1",
      "swapForY": true,
      "collectFeeMode": "InputOnly",
      "supportLimitOrder": true,
      "currentTimestamp": "1000",
      "sParameters": {
        "baseFactor": "0",
        "baseFeePowerFactor": "0",
        "variableFeeControl": "10000000",
        "maxVolatilityAccumulator": "10000",
        "filterPeriod": "30",
        "decayPeriod": "600",
        "reductionFactor": "5000"
      },
      "vParameters": {
        "volatilityAccumulator": "0",
        "volatilityReference": "0",
        "indexReference": "0",
        "lastUpdateTimestamp": "1000"
      },
      "bins": [
        {
          "id": "1",
          "priceQ64": "18631211514446647132",
          "amountX": "0",
          "amountY": "9",
          "limitOrderAskSide": false,
          "openOrderAmount": "0",
          "processedOrderRemainingAmount": "0"
        },
        {
          "id": "0",
          "priceQ64": "18446744073709551616",
          "amountX": "0",
          "amountY": "1",
          "limitOrderAskSide": false,
          "openOrderAmount": "0",
          "processedOrderRemainingAmount": "0"
        }
      ],
      "zeroTransferTaxAdmitted": true
    },
    "benchmark": {
      "num": "1",
      "den": "1",
      "impactBps": "2000"
    },
    "cap": "30",
    "expectedPoints": [
      {
        "x": "0",
        "consumed": "0",
        "net": "0",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "1",
        "consumed": "1",
        "net": "0",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "9",
        "consumed": "9",
        "net": "8",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "10",
        "consumed": "10",
        "net": "9",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "11",
        "consumed": "11",
        "net": "9",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "12",
        "consumed": "11",
        "net": "10",
        "remainder": "1",
        "complete": false
      },
      {
        "x": "13",
        "consumed": "11",
        "net": "10",
        "remainder": "2",
        "complete": false
      }
    ],
    "expectedSolve": {
      "maxNet": "9",
      "smallestInputAtMaxNet": "10",
      "greatestAdmissibleInput": "11",
      "largestFullyConsumableInput": "11",
      "capFullyConsumable": false,
      "admissibleInputs": [
        "0",
        "5",
        "6",
        "7",
        "8",
        "9",
        "10",
        "11"
      ]
    }
  },
  {
    "id": "DLMM_ONLYY_X2Y_OUTPUT_FEE_3PCT_TIE_DEPTH100_L300",
    "covers": [
      "OnlyY-X2Y-output-fee",
      "forced-slope-tie",
      "exact-3pct-linear-point-x100-net97",
      "impactL300"
    ],
    "notes": "fee = 30000*100*10 = 3e7 (3%), price Q (p0=1). x=100 net 97 is an exact tie 970000>=970000.",
    "bruteforce": true,
    "pool": {
      "binStep": "100",
      "activeId": "0",
      "swapForY": true,
      "collectFeeMode": "OnlyY",
      "supportLimitOrder": true,
      "currentTimestamp": "1000",
      "sParameters": {
        "baseFactor": "30000",
        "baseFeePowerFactor": "0",
        "variableFeeControl": "0",
        "maxVolatilityAccumulator": "350000",
        "filterPeriod": "30",
        "decayPeriod": "600",
        "reductionFactor": "5000"
      },
      "vParameters": {
        "volatilityAccumulator": "0",
        "volatilityReference": "0",
        "indexReference": "0",
        "lastUpdateTimestamp": "1000"
      },
      "bins": [
        {
          "id": "0",
          "priceQ64": "18446744073709551616",
          "amountX": "0",
          "amountY": "100",
          "limitOrderAskSide": false,
          "openOrderAmount": "0",
          "processedOrderRemainingAmount": "0"
        }
      ],
      "zeroTransferTaxAdmitted": true
    },
    "benchmark": {
      "num": "1",
      "den": "1",
      "impactBps": "300"
    },
    "cap": "150",
    "expectedPoints": [
      {
        "x": "0",
        "consumed": "0",
        "net": "0",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "99",
        "consumed": "99",
        "net": "96",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "100",
        "consumed": "100",
        "net": "97",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "101",
        "consumed": "100",
        "net": "97",
        "remainder": "1",
        "complete": false
      }
    ],
    "expectedSolve": {
      "maxNet": "97",
      "smallestInputAtMaxNet": "100",
      "greatestAdmissibleInput": "100",
      "largestFullyConsumableInput": "100",
      "capFullyConsumable": false,
      "admissibleInputs": [
        "0",
        "100"
      ]
    }
  },
  {
    "id": "DLMM_ONLYY_X2Y_OUTPUT_FEE_3PCT_DEPTH1000_L300_CAP_CLIPPED",
    "covers": [
      "OnlyY-X2Y-output-fee",
      "impactL300",
      "domain-clipping",
      "cap-scoped-not-physical"
    ],
    "notes": "Admissible iff 100|x. capFullyConsumable=true: result is cap-scoped, not a physical maximum.",
    "bruteforce": true,
    "pool": {
      "binStep": "100",
      "activeId": "0",
      "swapForY": true,
      "collectFeeMode": "OnlyY",
      "supportLimitOrder": true,
      "currentTimestamp": "1000",
      "sParameters": {
        "baseFactor": "30000",
        "baseFeePowerFactor": "0",
        "variableFeeControl": "0",
        "maxVolatilityAccumulator": "350000",
        "filterPeriod": "30",
        "decayPeriod": "600",
        "reductionFactor": "5000"
      },
      "vParameters": {
        "volatilityAccumulator": "0",
        "volatilityReference": "0",
        "indexReference": "0",
        "lastUpdateTimestamp": "1000"
      },
      "bins": [
        {
          "id": "0",
          "priceQ64": "18446744073709551616",
          "amountX": "0",
          "amountY": "1000",
          "limitOrderAskSide": false,
          "openOrderAmount": "0",
          "processedOrderRemainingAmount": "0"
        }
      ],
      "zeroTransferTaxAdmitted": true
    },
    "benchmark": {
      "num": "1",
      "den": "1",
      "impactBps": "300"
    },
    "cap": "400",
    "expectedPoints": [
      {
        "x": "100",
        "consumed": "100",
        "net": "97",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "101",
        "consumed": "101",
        "net": "97",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "400",
        "consumed": "400",
        "net": "388",
        "remainder": "0",
        "complete": true
      }
    ],
    "expectedSolve": {
      "maxNet": "388",
      "smallestInputAtMaxNet": "400",
      "greatestAdmissibleInput": "400",
      "largestFullyConsumableInput": "400",
      "capFullyConsumable": true,
      "admissibleInputs": [
        "0",
        "100",
        "200",
        "300",
        "400"
      ]
    }
  },
  {
    "id": "DLMM_ONLYY_X2Y_OUTPUT_FEE_3PCT_DEPTH1000_L450_CAP_CLIPPED",
    "covers": [
      "OnlyY-X2Y-output-fee",
      "impactL450",
      "domain-clipping",
      "cap-scoped-not-physical"
    ],
    "bruteforce": true,
    "pool": {
      "binStep": "100",
      "activeId": "0",
      "swapForY": true,
      "collectFeeMode": "OnlyY",
      "supportLimitOrder": true,
      "currentTimestamp": "1000",
      "sParameters": {
        "baseFactor": "30000",
        "baseFeePowerFactor": "0",
        "variableFeeControl": "0",
        "maxVolatilityAccumulator": "350000",
        "filterPeriod": "30",
        "decayPeriod": "600",
        "reductionFactor": "5000"
      },
      "vParameters": {
        "volatilityAccumulator": "0",
        "volatilityReference": "0",
        "indexReference": "0",
        "lastUpdateTimestamp": "1000"
      },
      "bins": [
        {
          "id": "0",
          "priceQ64": "18446744073709551616",
          "amountX": "0",
          "amountY": "1000",
          "limitOrderAskSide": false,
          "openOrderAmount": "0",
          "processedOrderRemainingAmount": "0"
        }
      ],
      "zeroTransferTaxAdmitted": true
    },
    "benchmark": {
      "num": "1",
      "den": "1",
      "impactBps": "450"
    },
    "cap": "400",
    "expectedPoints": [
      {
        "x": "399",
        "consumed": "399",
        "net": "387",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "400",
        "consumed": "400",
        "net": "388",
        "remainder": "0",
        "complete": true
      }
    ],
    "expectedSolve": {
      "maxNet": "388",
      "smallestInputAtMaxNet": "400",
      "greatestAdmissibleInput": "400",
      "largestFullyConsumableInput": "400",
      "capFullyConsumable": true
    }
  },
  {
    "id": "DLMM_ONLYY_Y2X_INPUT_FEE_1PCT_ABSORPTION_L300",
    "covers": [
      "OnlyY-Y2X-input-fee",
      "inputfee-absorption-I-A",
      "irrelevant-opposite-side-orders",
      "wrong-direction-bin",
      "impactL300"
    ],
    "notes": "fee 1e7 (1%), price 2Q, full-bin maxIn 100, I=A=102. Bid-side orders on bin0 and bin -1 are irrelevant for Y->X.",
    "bruteforce": true,
    "pool": {
      "binStep": "100",
      "activeId": "0",
      "swapForY": false,
      "collectFeeMode": "OnlyY",
      "supportLimitOrder": true,
      "currentTimestamp": "1000",
      "sParameters": {
        "baseFactor": "10000",
        "baseFeePowerFactor": "0",
        "variableFeeControl": "0",
        "maxVolatilityAccumulator": "350000",
        "filterPeriod": "30",
        "decayPeriod": "600",
        "reductionFactor": "5000"
      },
      "vParameters": {
        "volatilityAccumulator": "0",
        "volatilityReference": "0",
        "indexReference": "0",
        "lastUpdateTimestamp": "1000"
      },
      "bins": [
        {
          "id": "0",
          "priceQ64": "36893488147419103232",
          "amountX": "50",
          "amountY": "500",
          "limitOrderAskSide": false,
          "openOrderAmount": "30",
          "processedOrderRemainingAmount": "30"
        },
        {
          "id": "-1",
          "priceQ64": "18446744073709551616",
          "amountX": "0",
          "amountY": "1000",
          "limitOrderAskSide": false,
          "openOrderAmount": "0",
          "processedOrderRemainingAmount": "0"
        }
      ],
      "zeroTransferTaxAdmitted": true
    },
    "benchmark": {
      "num": "1",
      "den": "2",
      "impactBps": "300"
    },
    "cap": "120",
    "expectedPoints": [
      {
        "x": "1",
        "consumed": "1",
        "net": "0",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "100",
        "consumed": "100",
        "net": "49",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "101",
        "consumed": "101",
        "net": "49",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "102",
        "consumed": "102",
        "net": "50",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "103",
        "consumed": "102",
        "net": "50",
        "remainder": "1",
        "complete": false
      }
    ],
    "expectedSolve": {
      "maxNet": "50",
      "smallestInputAtMaxNet": "102",
      "greatestAdmissibleInput": "102",
      "largestFullyConsumableInput": "102",
      "capFullyConsumable": false
    }
  },
  {
    "id": "DLMM_INPUTONLY_Y2X_INPUT_FEE_1PCT_MODE_PARITY",
    "covers": [
      "InputOnly-Y2X-input-fee",
      "fee-mode-mapping-parity"
    ],
    "notes": "Same as DLMM_ONLYY_Y2X_INPUT_FEE_1PCT_ABSORPTION_L300 with InputOnly; getFeeMode gives feeOnInput=true in both.",
    "bruteforce": true,
    "pool": {
      "binStep": "100",
      "activeId": "0",
      "swapForY": false,
      "collectFeeMode": "InputOnly",
      "supportLimitOrder": true,
      "currentTimestamp": "1000",
      "sParameters": {
        "baseFactor": "10000",
        "baseFeePowerFactor": "0",
        "variableFeeControl": "0",
        "maxVolatilityAccumulator": "350000",
        "filterPeriod": "30",
        "decayPeriod": "600",
        "reductionFactor": "5000"
      },
      "vParameters": {
        "volatilityAccumulator": "0",
        "volatilityReference": "0",
        "indexReference": "0",
        "lastUpdateTimestamp": "1000"
      },
      "bins": [
        {
          "id": "0",
          "priceQ64": "36893488147419103232",
          "amountX": "50",
          "amountY": "500",
          "limitOrderAskSide": false,
          "openOrderAmount": "30",
          "processedOrderRemainingAmount": "30"
        },
        {
          "id": "-1",
          "priceQ64": "18446744073709551616",
          "amountX": "0",
          "amountY": "1000",
          "limitOrderAskSide": false,
          "openOrderAmount": "0",
          "processedOrderRemainingAmount": "0"
        }
      ],
      "zeroTransferTaxAdmitted": true
    },
    "benchmark": {
      "num": "1",
      "den": "2",
      "impactBps": "300"
    },
    "cap": "120",
    "expectedPoints": [
      {
        "x": "102",
        "consumed": "102",
        "net": "50",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "103",
        "consumed": "102",
        "net": "50",
        "remainder": "1",
        "complete": false
      }
    ],
    "expectedSolve": {
      "maxNet": "50",
      "smallestInputAtMaxNet": "102",
      "greatestAdmissibleInput": "102",
      "largestFullyConsumableInput": "102",
      "capFullyConsumable": false
    }
  },
  {
    "id": "DLMM_X2Y_THREE_LAYERS_FLOOR_HOLES_OPPOSITE_ORDERS_L300",
    "covers": [
      "MM-processed-open-all3",
      "layer-boundaries",
      "ceiling-floor-dust-holes",
      "irrelevant-opposite-side-orders",
      "empty-bin-skip",
      "non-monotone-admissibility",
      "impactL300"
    ],
    "notes": "Fee 0, price 3Q/4. Layer full inputs 14/10/7 -> outputs 10/7/5. x=15 consumes 15 for net 10 (processed-layer hole); a merged linear bin would give 11. Bin -1 has only ask orders/X: zero X->Y capacity. Bin 1 is wrong direction.",
    "bruteforce": true,
    "pool": {
      "binStep": "100",
      "activeId": "0",
      "swapForY": true,
      "collectFeeMode": "OnlyY",
      "supportLimitOrder": true,
      "currentTimestamp": "1000",
      "sParameters": {
        "baseFactor": "0",
        "baseFeePowerFactor": "0",
        "variableFeeControl": "0",
        "maxVolatilityAccumulator": "350000",
        "filterPeriod": "30",
        "decayPeriod": "600",
        "reductionFactor": "5000"
      },
      "vParameters": {
        "volatilityAccumulator": "0",
        "volatilityReference": "0",
        "indexReference": "0",
        "lastUpdateTimestamp": "1000"
      },
      "bins": [
        {
          "id": "1",
          "priceQ64": "18631211514446647132",
          "amountX": "0",
          "amountY": "100",
          "limitOrderAskSide": false,
          "openOrderAmount": "0",
          "processedOrderRemainingAmount": "0"
        },
        {
          "id": "0",
          "priceQ64": "13835058055282163712",
          "amountX": "0",
          "amountY": "10",
          "limitOrderAskSide": false,
          "openOrderAmount": "5",
          "processedOrderRemainingAmount": "7"
        },
        {
          "id": "-1",
          "priceQ64": "18446744073709551616",
          "amountX": "100",
          "amountY": "0",
          "limitOrderAskSide": true,
          "openOrderAmount": "50",
          "processedOrderRemainingAmount": "50"
        }
      ],
      "zeroTransferTaxAdmitted": true
    },
    "benchmark": {
      "num": "3",
      "den": "4",
      "impactBps": "300"
    },
    "cap": "40",
    "expectedPoints": [
      {
        "x": "13",
        "consumed": "13",
        "net": "9",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "14",
        "consumed": "14",
        "net": "10",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "15",
        "consumed": "15",
        "net": "10",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "24",
        "consumed": "24",
        "net": "17",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "25",
        "consumed": "25",
        "net": "17",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "31",
        "consumed": "31",
        "net": "22",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "32",
        "consumed": "31",
        "net": "22",
        "remainder": "1",
        "complete": false
      }
    ],
    "expectedSolve": {
      "maxNet": "9",
      "smallestInputAtMaxNet": "12",
      "greatestAdmissibleInput": "12",
      "largestFullyConsumableInput": "31",
      "capFullyConsumable": false,
      "admissibleInputs": [
        "0",
        "4",
        "8",
        "12"
      ]
    }
  },
  {
    "id": "DLMM_INPUTONLY_Y2X_THREE_LAYERS_10PCT_ASK_ORDERS",
    "covers": [
      "InputOnly-Y2X-input-fee",
      "MM-processed-open-all3",
      "inputfee-absorption-I-A",
      "ceiling-floor-dust-holes",
      "mininput-plateau-tie"
    ],
    "notes": "fee 1e8 (base, capped value), price 2Q, ask orders usable for Y->X. Layer full inputs 6/4/8 -> 3/2/4. x=8 absorbs 1 into processed layer for 0 output. Plateau net 9 at x=20,21.",
    "bruteforce": true,
    "pool": {
      "binStep": "100",
      "activeId": "0",
      "swapForY": false,
      "collectFeeMode": "InputOnly",
      "supportLimitOrder": true,
      "currentTimestamp": "1000",
      "sParameters": {
        "baseFactor": "100000",
        "baseFeePowerFactor": "0",
        "variableFeeControl": "0",
        "maxVolatilityAccumulator": "350000",
        "filterPeriod": "30",
        "decayPeriod": "600",
        "reductionFactor": "5000"
      },
      "vParameters": {
        "volatilityAccumulator": "0",
        "volatilityReference": "0",
        "indexReference": "0",
        "lastUpdateTimestamp": "1000"
      },
      "bins": [
        {
          "id": "0",
          "priceQ64": "36893488147419103232",
          "amountX": "3",
          "amountY": "1000",
          "limitOrderAskSide": true,
          "openOrderAmount": "4",
          "processedOrderRemainingAmount": "2"
        },
        {
          "id": "-1",
          "priceQ64": "18446744073709551616",
          "amountX": "0",
          "amountY": "500",
          "limitOrderAskSide": false,
          "openOrderAmount": "0",
          "processedOrderRemainingAmount": "0"
        }
      ],
      "zeroTransferTaxAdmitted": true
    },
    "benchmark": {
      "num": "1",
      "den": "2",
      "impactBps": "1500"
    },
    "cap": "30",
    "expectedPoints": [
      {
        "x": "1",
        "consumed": "1",
        "net": "0",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "7",
        "consumed": "7",
        "net": "3",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "8",
        "consumed": "8",
        "net": "3",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "12",
        "consumed": "12",
        "net": "5",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "20",
        "consumed": "20",
        "net": "9",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "21",
        "consumed": "21",
        "net": "9",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "22",
        "consumed": "20",
        "net": "9",
        "remainder": "2",
        "complete": false
      }
    ],
    "expectedSolve": {
      "maxNet": "9",
      "smallestInputAtMaxNet": "20",
      "greatestAdmissibleInput": "21",
      "largestFullyConsumableInput": "21",
      "capFullyConsumable": false
    }
  },
  {
    "id": "DLMM_Y2X_LIMIT_ORDERS_DISABLED",
    "covers": [
      "supportLimitOrder-false",
      "inputfee-recompute-branch"
    ],
    "notes": "Same bins as previous case with supportLimitOrder=false: only MM (maxIn 6). x=8 recomputes included 7, remainder 1.",
    "bruteforce": true,
    "pool": {
      "binStep": "100",
      "activeId": "0",
      "swapForY": false,
      "collectFeeMode": "InputOnly",
      "supportLimitOrder": false,
      "currentTimestamp": "1000",
      "sParameters": {
        "baseFactor": "100000",
        "baseFeePowerFactor": "0",
        "variableFeeControl": "0",
        "maxVolatilityAccumulator": "350000",
        "filterPeriod": "30",
        "decayPeriod": "600",
        "reductionFactor": "5000"
      },
      "vParameters": {
        "volatilityAccumulator": "0",
        "volatilityReference": "0",
        "indexReference": "0",
        "lastUpdateTimestamp": "1000"
      },
      "bins": [
        {
          "id": "0",
          "priceQ64": "36893488147419103232",
          "amountX": "3",
          "amountY": "1000",
          "limitOrderAskSide": true,
          "openOrderAmount": "4",
          "processedOrderRemainingAmount": "2"
        }
      ],
      "zeroTransferTaxAdmitted": true
    },
    "benchmark": {
      "num": "1",
      "den": "2",
      "impactBps": "1500"
    },
    "cap": "20",
    "expectedPoints": [
      {
        "x": "7",
        "consumed": "7",
        "net": "3",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "8",
        "consumed": "7",
        "net": "3",
        "remainder": "1",
        "complete": false
      }
    ],
    "expectedSolve": {
      "maxNet": "3",
      "smallestInputAtMaxNet": "7",
      "greatestAdmissibleInput": "7",
      "largestFullyConsumableInput": "7",
      "capFullyConsumable": false,
      "admissibleInputs": [
        "0",
        "7"
      ]
    }
  },
  {
    "id": "DLMM_FEE_REF_NONRESET_OLD_INDEX_FALLING",
    "covers": [
      "nonreset-falling-fee-reference",
      "old-index-reference",
      "next-bin-dust-absorption",
      "multi-bin",
      "impactL300"
    ],
    "notes": "elapsed 10 < filter 30: indexReference 3 kept. Fees along 5->4->3: 2e7, 5e6, 0. x=104: bin5 consumes 103, bin4 absorbs remainder 1 for 0 output.",
    "bruteforce": true,
    "pool": {
      "binStep": "10",
      "activeId": "5",
      "swapForY": true,
      "collectFeeMode": "InputOnly",
      "supportLimitOrder": true,
      "currentTimestamp": "1010",
      "sParameters": {
        "baseFactor": "0",
        "baseFeePowerFactor": "0",
        "variableFeeControl": "50000000",
        "maxVolatilityAccumulator": "350000",
        "filterPeriod": "30",
        "decayPeriod": "600",
        "reductionFactor": "5000"
      },
      "vParameters": {
        "volatilityAccumulator": "20000",
        "volatilityReference": "0",
        "indexReference": "3",
        "lastUpdateTimestamp": "1000"
      },
      "bins": [
        {
          "id": "6",
          "priceQ64": "18446744073709551616",
          "amountX": "100",
          "amountY": "0",
          "limitOrderAskSide": false,
          "openOrderAmount": "0",
          "processedOrderRemainingAmount": "0"
        },
        {
          "id": "5",
          "priceQ64": "18446744073709551616",
          "amountX": "0",
          "amountY": "100",
          "limitOrderAskSide": false,
          "openOrderAmount": "0",
          "processedOrderRemainingAmount": "0"
        },
        {
          "id": "4",
          "priceQ64": "18446744073709551616",
          "amountX": "0",
          "amountY": "100",
          "limitOrderAskSide": false,
          "openOrderAmount": "0",
          "processedOrderRemainingAmount": "0"
        },
        {
          "id": "3",
          "priceQ64": "18446744073709551616",
          "amountX": "0",
          "amountY": "100",
          "limitOrderAskSide": false,
          "openOrderAmount": "0",
          "processedOrderRemainingAmount": "0"
        }
      ],
      "zeroTransferTaxAdmitted": true
    },
    "benchmark": {
      "num": "1",
      "den": "1",
      "impactBps": "300"
    },
    "cap": "320",
    "expectedPoints": [
      {
        "x": "50",
        "consumed": "50",
        "net": "49",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "103",
        "consumed": "103",
        "net": "100",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "104",
        "consumed": "104",
        "net": "100",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "105",
        "consumed": "105",
        "net": "101",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "204",
        "consumed": "204",
        "net": "200",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "205",
        "consumed": "205",
        "net": "201",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "304",
        "consumed": "304",
        "net": "300",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "305",
        "consumed": "304",
        "net": "300",
        "remainder": "1",
        "complete": false
      }
    ],
    "expectedSolve": {
      "maxNet": "300",
      "smallestInputAtMaxNet": "304",
      "greatestAdmissibleInput": "304",
      "largestFullyConsumableInput": "304",
      "capFullyConsumable": false
    }
  },
  {
    "id": "DLMM_FEE_REF_FILTER_RESET_DECAYED_VOLREF_RISING",
    "covers": [
      "reset-variant",
      "decayed-volatility-reference",
      "rising-fee"
    ],
    "notes": "elapsed 100 in [30,600): indexReference=5, volRef=floor(20000*5000/10000)=10000. Fees 5->4->3: 5e6, 2e7, 4.5e7.",
    "bruteforce": true,
    "pool": {
      "binStep": "10",
      "activeId": "5",
      "swapForY": true,
      "collectFeeMode": "InputOnly",
      "supportLimitOrder": true,
      "currentTimestamp": "1100",
      "sParameters": {
        "baseFactor": "0",
        "baseFeePowerFactor": "0",
        "variableFeeControl": "50000000",
        "maxVolatilityAccumulator": "350000",
        "filterPeriod": "30",
        "decayPeriod": "600",
        "reductionFactor": "5000"
      },
      "vParameters": {
        "volatilityAccumulator": "20000",
        "volatilityReference": "0",
        "indexReference": "3",
        "lastUpdateTimestamp": "1000"
      },
      "bins": [
        {
          "id": "5",
          "priceQ64": "18446744073709551616",
          "amountX": "0",
          "amountY": "100",
          "limitOrderAskSide": false,
          "openOrderAmount": "0",
          "processedOrderRemainingAmount": "0"
        },
        {
          "id": "4",
          "priceQ64": "18446744073709551616",
          "amountX": "0",
          "amountY": "100",
          "limitOrderAskSide": false,
          "openOrderAmount": "0",
          "processedOrderRemainingAmount": "0"
        },
        {
          "id": "3",
          "priceQ64": "18446744073709551616",
          "amountX": "0",
          "amountY": "100",
          "limitOrderAskSide": false,
          "openOrderAmount": "0",
          "processedOrderRemainingAmount": "0"
        }
      ],
      "zeroTransferTaxAdmitted": true
    },
    "benchmark": {
      "num": "1",
      "den": "1",
      "impactBps": "300"
    },
    "cap": "320",
    "expectedPoints": [
      {
        "x": "100",
        "consumed": "100",
        "net": "99",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "101",
        "consumed": "101",
        "net": "100",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "102",
        "consumed": "102",
        "net": "100",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "304",
        "consumed": "304",
        "net": "295",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "309",
        "consumed": "309",
        "net": "300",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "310",
        "consumed": "309",
        "net": "300",
        "remainder": "1",
        "complete": false
      }
    ],
    "expectedSolve": {
      "maxNet": "300",
      "smallestInputAtMaxNet": "309",
      "greatestAdmissibleInput": "309",
      "largestFullyConsumableInput": "309",
      "capFullyConsumable": false
    }
  },
  {
    "id": "DLMM_FEE_REF_DECAY_CLOCK_ZERO",
    "covers": [
      "decayClock-variant",
      "volatility-reference-zero"
    ],
    "notes": "elapsed 700 >= decay 600: indexReference=5, volRef=0. Fees 5->4->3: 0, 5e6, 2e7.",
    "bruteforce": true,
    "pool": {
      "binStep": "10",
      "activeId": "5",
      "swapForY": true,
      "collectFeeMode": "InputOnly",
      "supportLimitOrder": true,
      "currentTimestamp": "1700",
      "sParameters": {
        "baseFactor": "0",
        "baseFeePowerFactor": "0",
        "variableFeeControl": "50000000",
        "maxVolatilityAccumulator": "350000",
        "filterPeriod": "30",
        "decayPeriod": "600",
        "reductionFactor": "5000"
      },
      "vParameters": {
        "volatilityAccumulator": "20000",
        "volatilityReference": "0",
        "indexReference": "3",
        "lastUpdateTimestamp": "1000"
      },
      "bins": [
        {
          "id": "5",
          "priceQ64": "18446744073709551616",
          "amountX": "0",
          "amountY": "100",
          "limitOrderAskSide": false,
          "openOrderAmount": "0",
          "processedOrderRemainingAmount": "0"
        },
        {
          "id": "4",
          "priceQ64": "18446744073709551616",
          "amountX": "0",
          "amountY": "100",
          "limitOrderAskSide": false,
          "openOrderAmount": "0",
          "processedOrderRemainingAmount": "0"
        },
        {
          "id": "3",
          "priceQ64": "18446744073709551616",
          "amountX": "0",
          "amountY": "100",
          "limitOrderAskSide": false,
          "openOrderAmount": "0",
          "processedOrderRemainingAmount": "0"
        }
      ],
      "zeroTransferTaxAdmitted": true
    },
    "benchmark": {
      "num": "1",
      "den": "1",
      "impactBps": "300"
    },
    "cap": "320",
    "expectedPoints": [
      {
        "x": "100",
        "consumed": "100",
        "net": "100",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "101",
        "consumed": "101",
        "net": "100",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "102",
        "consumed": "102",
        "net": "101",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "304",
        "consumed": "304",
        "net": "300",
        "remainder": "0",
        "complete": true
      }
    ],
    "expectedSolve": {
      "maxNet": "300",
      "smallestInputAtMaxNet": "304",
      "greatestAdmissibleInput": "304",
      "largestFullyConsumableInput": "304",
      "capFullyConsumable": false
    }
  },
  {
    "id": "DLMM_FEE_REF_FILTER_RESET_MAXVOL_CLIP",
    "covers": [
      "maxVolatilityAccumulator-clip"
    ],
    "notes": "Reset variant with maxVol 25000: bin3 va clipped 30000->25000, fee 3.125e7 (vs 4.5e7): x=304 net 296 (vs 295 unclipped).",
    "bruteforce": false,
    "pool": {
      "binStep": "10",
      "activeId": "5",
      "swapForY": true,
      "collectFeeMode": "InputOnly",
      "supportLimitOrder": true,
      "currentTimestamp": "1100",
      "sParameters": {
        "baseFactor": "0",
        "baseFeePowerFactor": "0",
        "variableFeeControl": "50000000",
        "maxVolatilityAccumulator": "25000",
        "filterPeriod": "30",
        "decayPeriod": "600",
        "reductionFactor": "5000"
      },
      "vParameters": {
        "volatilityAccumulator": "20000",
        "volatilityReference": "0",
        "indexReference": "3",
        "lastUpdateTimestamp": "1000"
      },
      "bins": [
        {
          "id": "5",
          "priceQ64": "18446744073709551616",
          "amountX": "0",
          "amountY": "100",
          "limitOrderAskSide": false,
          "openOrderAmount": "0",
          "processedOrderRemainingAmount": "0"
        },
        {
          "id": "4",
          "priceQ64": "18446744073709551616",
          "amountX": "0",
          "amountY": "100",
          "limitOrderAskSide": false,
          "openOrderAmount": "0",
          "processedOrderRemainingAmount": "0"
        },
        {
          "id": "3",
          "priceQ64": "18446744073709551616",
          "amountX": "0",
          "amountY": "100",
          "limitOrderAskSide": false,
          "openOrderAmount": "0",
          "processedOrderRemainingAmount": "0"
        }
      ],
      "zeroTransferTaxAdmitted": true
    },
    "expectedPoints": [
      {
        "x": "304",
        "consumed": "304",
        "net": "296",
        "remainder": "0",
        "complete": true
      }
    ]
  },
  {
    "id": "DLMM_EMPTY_SIDE_X2Y",
    "covers": [
      "empty-side",
      "ask-orders-irrelevant-for-X2Y",
      "x0-canonical"
    ],
    "bruteforce": true,
    "pool": {
      "binStep": "100",
      "activeId": "0",
      "swapForY": true,
      "collectFeeMode": "InputOnly",
      "supportLimitOrder": true,
      "currentTimestamp": "1000",
      "sParameters": {
        "baseFactor": "0",
        "baseFeePowerFactor": "0",
        "variableFeeControl": "0",
        "maxVolatilityAccumulator": "350000",
        "filterPeriod": "30",
        "decayPeriod": "600",
        "reductionFactor": "5000"
      },
      "vParameters": {
        "volatilityAccumulator": "0",
        "volatilityReference": "0",
        "indexReference": "0",
        "lastUpdateTimestamp": "1000"
      },
      "bins": [
        {
          "id": "1",
          "priceQ64": "18446744073709551616",
          "amountX": "0",
          "amountY": "100",
          "limitOrderAskSide": false,
          "openOrderAmount": "0",
          "processedOrderRemainingAmount": "0"
        },
        {
          "id": "0",
          "priceQ64": "18446744073709551616",
          "amountX": "100",
          "amountY": "0",
          "limitOrderAskSide": true,
          "openOrderAmount": "50",
          "processedOrderRemainingAmount": "50"
        }
      ],
      "zeroTransferTaxAdmitted": true
    },
    "benchmark": {
      "num": "1",
      "den": "1",
      "impactBps": "300"
    },
    "cap": "10",
    "expectedPoints": [
      {
        "x": "0",
        "consumed": "0",
        "net": "0",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "5",
        "consumed": "0",
        "net": "0",
        "remainder": "5",
        "complete": false
      }
    ],
    "expectedSolve": {
      "maxNet": "0",
      "smallestInputAtMaxNet": "0",
      "greatestAdmissibleInput": "0",
      "largestFullyConsumableInput": "0",
      "capFullyConsumable": false,
      "admissibleInputs": [
        "0"
      ]
    }
  },
  {
    "id": "DLMM_HUGE_ABOVE_U64_FULL_BIN_NOT_BRUTEFORCED",
    "covers": [
      "huge-above-u64",
      "not-bruteforced"
    ],
    "notes": "amountY = 2^70; quote-only. On-chain u64 bounds are not modeled by the oracle.",
    "bruteforce": false,
    "pool": {
      "binStep": "100",
      "activeId": "0",
      "swapForY": true,
      "collectFeeMode": "InputOnly",
      "supportLimitOrder": true,
      "currentTimestamp": "1000",
      "sParameters": {
        "baseFactor": "0",
        "baseFeePowerFactor": "0",
        "variableFeeControl": "0",
        "maxVolatilityAccumulator": "350000",
        "filterPeriod": "30",
        "decayPeriod": "600",
        "reductionFactor": "5000"
      },
      "vParameters": {
        "volatilityAccumulator": "0",
        "volatilityReference": "0",
        "indexReference": "0",
        "lastUpdateTimestamp": "1000"
      },
      "bins": [
        {
          "id": "0",
          "priceQ64": "18446744073709551616",
          "amountX": "0",
          "amountY": "1180591620717411303424",
          "limitOrderAskSide": false,
          "openOrderAmount": "0",
          "processedOrderRemainingAmount": "0"
        }
      ],
      "zeroTransferTaxAdmitted": true
    },
    "expectedPoints": [
      {
        "x": "18446744073709551617",
        "consumed": "18446744073709551617",
        "net": "18446744073709551617",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "1180591620717411303424",
        "consumed": "1180591620717411303424",
        "net": "1180591620717411303424",
        "remainder": "0",
        "complete": true
      },
      {
        "x": "1180591620717411303425",
        "consumed": "1180591620717411303424",
        "net": "1180591620717411303424",
        "remainder": "1",
        "complete": false
      }
    ]
  }
];


// ===== BEGIN DLMM PART_A MAINTAINED MATH / ORACLE / SDK PARITY TESTS =====
// Expected values come only from the independent oracle above or from the published SDK running in an
// isolated child process; production kernel outputs never feed expectations. Helpers are prefixed dlmmMath.

const dlmmMathRequire = createRequire(import.meta.url);
const DlmmMathBN = dlmmMathRequire('bn.js') as typeof BN;
const DlmmMathPublicKey = (dlmmMathRequire('@solana/web3.js') as { readonly PublicKey: typeof PublicKey }).PublicKey;

// Pinned @meteora-ag/dlmm 1.9.14 CJS root (the DLMM class); its ESM entry fails on current Node.
interface DlmmMathSdkRoot {
  createProgram(connection: unknown): { readonly programId: PublicKey };
  decodeAccount(program: unknown, accountName: string, data: Buffer): unknown;
  getQPriceFromId(binId: BN, binStep: BN): BN;
  deriveBinArray(lbPair: PublicKey, index: BN, programId: PublicKey): [PublicKey, number];
  deriveBinArrayBitmapExtension(lbPair: PublicKey, programId: PublicKey): [PublicKey, number];
  getFeeMode(lbPair: LbPair, swapForY: boolean): { readonly feeOnInput: boolean; readonly feeOnTokenX: boolean };
  isSupportLimitOrder(lbPair: LbPair): boolean;
  updateReference(activeId: number, vParameter: vParameters, sParameter: sParameters, currentTimestamp: number): void;
  updateVolatilityAccumulator(vParameter: vParameters, sParameter: sParameters, activeId: number): void;
  swapExactInQuoteAtBin(
    bin: Bin,
    binStep: number,
    sParameter: sParameters,
    vParameter: vParameters,
    inAmount: BN,
    swapForY: boolean,
    supportLimitOrder: boolean,
    feeOnInput: boolean,
  ): { readonly amountIn: BN; readonly amountOut: BN; readonly fee: BN; readonly protocolFee: BN };
}

interface DlmmMathAccountInfo {
  readonly data: Buffer;
  readonly owner: PublicKey;
  readonly lamports: number;
  readonly executable: boolean;
  readonly rentEpoch: number;
}

interface DlmmMathSplToken {
  readonly TOKEN_PROGRAM_ID: PublicKey;
  readonly TOKEN_2022_PROGRAM_ID: PublicKey;
  unpackMint(address: PublicKey, info: DlmmMathAccountInfo, programId: PublicKey): unknown;
  getTransferFeeConfig(mint: unknown): unknown;
  getTransferHook(mint: unknown): unknown;
}

const dlmmMathSdkRootValue: unknown = dlmmMathRequire('@meteora-ag/dlmm');
const dlmmMathSdk = dlmmMathSdkRootValue as DlmmMathSdkRoot;
const dlmmMathSplToken = dlmmMathRequire('@solana/spl-token') as DlmmMathSplToken;

const DLMM_MATH_FIXTURE_PATH = fileURLToPath(new URL('../../tests/fixtures/executable-liquidity-dlmm.json', import.meta.url));
const DLMM_MATH_U64_MAX = (1n << 64n) - 1n;
const DLMM_MATH_BIN_ARRAY_SIZE = 70n;
const DLMM_MATH_BITMAP_OFFSET = 512n;
const DLMM_MATH_SDK_INSUFFICIENT = 'SWAP_QUOTE_INSUFFICIENT_LIQUIDITY';
const DLMM_MATH_TRAP_ID = 'DLMM_TRAP_IA_PREVIOUS_BIN_STEALS_NEXT_ENDPOINT';
const DLMM_MATH_TIE_ID = 'DLMM_ONLYY_X2Y_OUTPUT_FEE_3PCT_TIE_DEPTH100_L300';
const DLMM_MATH_LAYERS_ID = 'DLMM_X2Y_THREE_LAYERS_FLOOR_HOLES_OPPOSITE_ORDERS_L300';
const DLMM_MATH_EMPTY_ID = 'DLMM_EMPTY_SIDE_X2Y';
const DLMM_MATH_U64_GUARD_ID = 'DLMM_U64_GUARD_NEGATIVE_ID_PRICE_BELOW_ONE';

// Parent-process guards: any network attempt throws and is counted; Date is only ever frozen in the child.
let dlmmMathNetworkCalls = 0;
const dlmmMathOriginalDate = globalThis.Date;
const dlmmMathOriginalDateNow = Date.now;
const dlmmMathOriginalFetch = globalThis.fetch;
globalThis.fetch = ((): never => {
  dlmmMathNetworkCalls += 1;
  throw new Error('NO_NETWORK:fetch');
}) as unknown as typeof globalThis.fetch;
after(() => {
  globalThis.fetch = dlmmMathOriginalFetch;
});
const dlmmMathOfflineConnection: unknown = new Proxy(
  {},
  {
    get(_target, key) {
      if (key === 'commitment') return 'finalized';
      dlmmMathNetworkCalls += 1;
      throw new Error(`NO_NETWORK:${String(key)}`);
    },
  },
);

type DlmmMathRecord = Record<string, unknown>;

interface DlmmMathFixtureAccount {
  readonly owner: string;
  readonly data: readonly string[];
  readonly lamports?: number;
  readonly executable?: boolean;
  readonly rentEpoch?: number;
}

interface DlmmMathFixture {
  readonly accounts: Readonly<Record<string, DlmmMathFixtureAccount | null>>;
  readonly clock: Readonly<Record<string, string>>;
  readonly pools: readonly string[];
}

interface DlmmMathClockStrings {
  readonly slot: string;
  readonly epochStartTimestamp: string;
  readonly epoch: string;
  readonly leaderScheduleEpoch: string;
}

interface DlmmMathTemplate {
  readonly programId: PublicKey;
  readonly pool: PublicKey;
  readonly lbPair: LbPair;
  readonly binArray: BinArrayAccount['account'];
  readonly clock: DlmmMathClockStrings;
  readonly snapshot: string;
}

interface DlmmMathState {
  readonly programId: PublicKey;
  readonly pool: PublicKey;
  readonly lbPair: LbPair;
  readonly binArrays: readonly BinArrayAccount[];
}

interface DlmmMathCanonicalCase {
  readonly id: string;
  readonly sourceImpactBps: bigint;
  readonly cap: bigint;
  readonly spec: DlmmOraclePoolSpec;
  readonly oraclePool: DlmmOraclePool;
  readonly table: readonly DlmmOracleQuote[];
  readonly state: DlmmMathState;
  readonly snapshot: string;
  readonly prepared: DlmmPreparedKernel;
}

interface DlmmMathU64Guard {
  readonly spec: DlmmOraclePoolSpec;
  readonly oraclePool: DlmmOraclePool;
  readonly state: DlmmMathState;
  readonly snapshot: string;
  readonly prepared: DlmmPreparedKernel;
  readonly inputs: readonly bigint[];
}

interface DlmmMathChildRow {
  readonly x: string;
  readonly ok: boolean;
  readonly consumed?: string;
  readonly out?: string;
  readonly fee?: string;
  readonly protocolFee?: string;
  readonly feeOnInput?: boolean;
  readonly errorName?: string | null;
  readonly errorCode?: string | null;
  readonly message?: string;
}

interface DlmmMathChildOutput {
  readonly networkCalls: number;
  readonly dateFrozenInChildOnly: boolean;
  readonly results: readonly (readonly DlmmMathChildRow[])[];
}

interface DlmmMathSdkParity {
  readonly networkCalls: number;
  readonly dateFrozenInChildOnly: boolean;
  readonly rows: ReadonlyMap<string, readonly DlmmMathChildRow[]>;
}

function dlmmMathCompare(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function dlmmMathFloorDiv(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  return numerator % denominator !== 0n && (numerator < 0n) !== (denominator < 0n) ? quotient - 1n : quotient;
}

function dlmmMathDecimal(value: string | undefined, label: string): bigint {
  assert.ok(typeof value === 'string' && /^[0-9]+$/.test(value), `${label}: expected decimal string, got ${String(value)}`);
  return BigInt(value);
}

function dlmmMathIsPublicKey(value: unknown): value is PublicKey {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { readonly toBase58?: unknown }).toBase58 === 'function' &&
    typeof (value as { readonly toBuffer?: unknown }).toBuffer === 'function'
  );
}

// Tagged, exact encoding of decoded SDK account objects: BN stays decimal and is revived as BN, never hex JSON.
function dlmmMathEncodeSdkValue(value: unknown): unknown {
  if (typeof value === 'bigint') throw new Error('bigint is not a decoded SDK account value');
  if (DlmmMathBN.isBN(value)) return { $bn: value.toString(10) };
  if (dlmmMathIsPublicKey(value)) return { $pk: value.toBase58() };
  if (value instanceof Uint8Array) return { $u8: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(dlmmMathEncodeSdkValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, dlmmMathEncodeSdkValue(item)]));
  }
  return value;
}

function dlmmMathCloneValue(value: unknown): unknown {
  if (DlmmMathBN.isBN(value)) return value.clone();
  if (dlmmMathIsPublicKey(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (Array.isArray(value)) return value.map(dlmmMathCloneValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, dlmmMathCloneValue(item)]));
  }
  return value;
}

function dlmmMathZeroLike(value: unknown): unknown {
  if (DlmmMathBN.isBN(value)) return new DlmmMathBN(0);
  if (typeof value === 'number') return 0;
  if (typeof value === 'boolean') return false;
  if (value instanceof Uint8Array) return Buffer.alloc(value.length);
  if (Array.isArray(value)) return value.map(dlmmMathZeroLike);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, dlmmMathZeroLike(item)]));
  }
  return value;
}

// Overrides one decoded field, preserving its decoded kind: BN stays BN, numbers must be safe integers.
function dlmmMathSetField(record: DlmmMathRecord, key: string, decimal: string): void {
  assert.ok(Object.prototype.hasOwnProperty.call(record, key), `decoded template lacks field ${key}`);
  const current = record[key];
  if (DlmmMathBN.isBN(current)) {
    record[key] = new DlmmMathBN(decimal, 10);
    return;
  }
  assert.equal(typeof current, 'number', `field ${key} must decode as BN or number`);
  const value = Number(decimal);
  assert.ok(Number.isSafeInteger(value) && BigInt(value) === BigInt(decimal), `field ${key}=${decimal} is not a safe number`);
  record[key] = value;
}

function dlmmMathAccountInfo(fixture: DlmmMathFixture, address: string): DlmmMathAccountInfo | null {
  const account = fixture.accounts[address];
  if (account === null || account === undefined) return null;
  const [encoded, encoding] = account.data;
  assert.ok(typeof encoded === 'string' && encoding === 'base64', `fixture account ${address} must be base64 encoded`);
  return {
    data: Buffer.from(encoded, 'base64'),
    owner: new DlmmMathPublicKey(account.owner),
    lamports: account.lamports ?? 0,
    executable: account.executable ?? false,
    rentEpoch: account.rentEpoch ?? 0,
  };
}

// Ordinary admission: legacy SPL or Token-2022 mint without TransferFeeConfig or TransferHook extension.
function dlmmMathOrdinaryMint(fixture: DlmmMathFixture, mint: PublicKey): boolean {
  const info = dlmmMathAccountInfo(fixture, mint.toBase58());
  if (info === null) return false;
  if (!info.owner.equals(dlmmMathSplToken.TOKEN_PROGRAM_ID) && !info.owner.equals(dlmmMathSplToken.TOKEN_2022_PROGRAM_ID)) {
    return false;
  }
  const decoded = dlmmMathSplToken.unpackMint(mint, info, info.owner);
  return dlmmMathSplToken.getTransferFeeConfig(decoded) === null && dlmmMathSplToken.getTransferHook(decoded) === null;
}

let dlmmMathTemplateMemo: DlmmMathTemplate | null = null;

// Genuine decoded pair/bin shapes; only non-quote metadata (mints, reserves, padding, layout) is reused.
function dlmmMathTemplate(): DlmmMathTemplate {
  if (dlmmMathTemplateMemo !== null) return dlmmMathTemplateMemo;
  const fixture = JSON.parse(readFileSync(DLMM_MATH_FIXTURE_PATH, 'utf8')) as DlmmMathFixture;
  const program = dlmmMathSdk.createProgram(dlmmMathOfflineConnection);
  const programId = program.programId;
  assert.equal(programId.toBase58(), DLMM_PROGRAM_ID);
  const genuineArrays: BinArrayAccount['account'][] = [];
  for (const address of Object.keys(fixture.accounts)) {
    const info = dlmmMathAccountInfo(fixture, address);
    if (info !== null && info.owner.equals(programId) && info.data.length === 10_136) {
      genuineArrays.push(dlmmMathSdk.decodeAccount(program, 'binArray', info.data) as BinArrayAccount['account']);
    }
  }
  const clockField = (name: keyof DlmmMathClockStrings): string => {
    const value = fixture.clock[name];
    assert.ok(typeof value === 'string' && /^-?[0-9]+$/.test(value), `fixture clock.${name} must be a decimal string`);
    return value;
  };
  for (const address of fixture.pools) {
    const info = dlmmMathAccountInfo(fixture, address);
    if (info === null || !info.owner.equals(programId) || info.data.length !== 904) continue;
    const lbPair = dlmmMathSdk.decodeAccount(program, 'lbPair', info.data) as LbPair;
    const mints = lbPair as unknown as { readonly tokenXMint: PublicKey; readonly tokenYMint: PublicKey };
    if (!dlmmMathOrdinaryMint(fixture, mints.tokenXMint) || !dlmmMathOrdinaryMint(fixture, mints.tokenYMint)) continue;
    const pool = new DlmmMathPublicKey(address);
    const binArray = genuineArrays.find((candidate) => candidate.lbPair.equals(pool));
    if (binArray === undefined) continue;
    const [extension] = dlmmMathSdk.deriveBinArrayBitmapExtension(pool, programId);
    assert.equal(fixture.accounts[extension.toBase58()] ?? null, null, `${address}: bitmap extension must be absent in the genuine bank`);
    const memo: DlmmMathTemplate = {
      programId,
      pool,
      lbPair,
      binArray,
      clock: {
        slot: clockField('slot'),
        epochStartTimestamp: clockField('epochStartTimestamp'),
        epoch: clockField('epoch'),
        leaderScheduleEpoch: clockField('leaderScheduleEpoch'),
      },
      snapshot: JSON.stringify(dlmmMathEncodeSdkValue({ lbPair, binArray })),
    };
    dlmmMathTemplateMemo = memo;
    return memo;
  }
  assert.fail('fixture has no genuine DLMM pool with two ordinary mints and a decoded bin array');
}

const dlmmMathQPriceMemo = new Map<string, bigint>();

// Exact published getQPriceFromId.
function dlmmMathQPrice(binId: bigint, binStep: bigint): bigint {
  const key = `${binStep}:${binId}`;
  const known = dlmmMathQPriceMemo.get(key);
  if (known !== undefined) return known;
  const price = BigInt(
    dlmmMathSdk
      .getQPriceFromId(new DlmmMathBN(binId.toString(10), 10), new DlmmMathBN(binStep.toString(10), 10))
      .toString(10),
  );
  dlmmMathQPriceMemo.set(key, price);
  return price;
}

// u16 baseFactor: e.g. 100000*10^0 is restated as 10000*10^1, an identical base fee numerator.
function dlmmMathSourceBaseFee(
  baseFactor: string,
  baseFeePowerFactor: string,
): { readonly baseFactor: string; readonly baseFeePowerFactor: string } {
  let factor = BigInt(baseFactor);
  let power = BigInt(baseFeePowerFactor);
  while (factor > 65_535n && factor % 10n === 0n) {
    factor /= 10n;
    power += 1n;
  }
  assert.ok(factor <= 65_535n && power <= 255n, `base fee ${baseFactor}e${baseFeePowerFactor} is not source-representable`);
  return { baseFactor: factor.toString(10), baseFeePowerFactor: power.toString(10) };
}

// Canonical transform: every bin price becomes the published getQPriceFromId(id, binStep).
function dlmmMathCanonicalPoolSpec(spec: DlmmOraclePoolSpec): DlmmOraclePoolSpec {
  const binStep = BigInt(spec.binStep);
  return {
    ...spec,
    sParameters: {
      ...spec.sParameters,
      ...dlmmMathSourceBaseFee(spec.sParameters.baseFactor, spec.sParameters.baseFeePowerFactor),
    },
    bins: spec.bins.map((bin) => ({ ...bin, priceQ64: dlmmMathQPrice(BigInt(bin.id), binStep).toString(10) })),
  };
}

// Initial benchmark anchored at activeId: X->Y p/Q, Y->X Q/p.
function dlmmMathBenchmark(spec: DlmmOraclePoolSpec, impactBps: bigint): DlmmOracleBenchmark {
  const activePrice = dlmmMathQPrice(BigInt(spec.activeId), BigInt(spec.binStep));
  return spec.swapForY
    ? { num: activePrice, den: DLMM_ORACLE_Q64, impactBps }
    : { num: DLMM_ORACLE_Q64, den: activePrice, impactBps };
}

// Synthetic decoded state: source static/variable parameters and modes from the spec, exact bitmap and PDAs,
// every unlisted bin zero liquidity with its derived price, listed bins with the spec's stored price.
function dlmmMathBuildState(spec: DlmmOraclePoolSpec): DlmmMathState {
  const template = dlmmMathTemplate();
  const binStep = BigInt(spec.binStep);
  const lbPair = dlmmMathCloneValue(template.lbPair) as DlmmMathRecord;
  dlmmMathSetField(lbPair, 'activeId', spec.activeId);
  dlmmMathSetField(lbPair, 'binStep', spec.binStep);
  const parameters = lbPair['parameters'] as DlmmMathRecord;
  for (const key of [
    'baseFactor',
    'baseFeePowerFactor',
    'variableFeeControl',
    'maxVolatilityAccumulator',
    'filterPeriod',
    'decayPeriod',
    'reductionFactor',
  ] as const) {
    dlmmMathSetField(parameters, key, spec.sParameters[key]);
  }
  // Source enums: FunctionType LimitOrder=2 / LiquidityMining=1; CollectFeeMode InputOnly=0 / OnlyY=1.
  dlmmMathSetField(parameters, 'functionType', spec.supportLimitOrder ? '2' : '1');
  dlmmMathSetField(parameters, 'collectFeeMode', spec.collectFeeMode === 'InputOnly' ? '0' : '1');
  const vParams = lbPair['vParameters'] as DlmmMathRecord;
  for (const key of ['volatilityAccumulator', 'volatilityReference', 'indexReference', 'lastUpdateTimestamp'] as const) {
    dlmmMathSetField(vParams, key, spec.vParameters[key]);
  }
  const indices = [
    ...new Set([...spec.bins.map((bin) => BigInt(bin.id)), BigInt(spec.activeId)].map((id) => dlmmMathFloorDiv(id, DLMM_MATH_BIN_ARRAY_SIZE))),
  ].sort(dlmmMathCompare);
  const bitmap = lbPair['binArrayBitmap'];
  assert.ok(Array.isArray(bitmap) && bitmap.length === 16, 'decoded binArrayBitmap must have 16 u64 words');
  const words = Array.from({ length: 16 }, () => 0n);
  for (const index of indices) {
    const offset = index + DLMM_MATH_BITMAP_OFFSET;
    assert.ok(offset >= 0n && offset < 1024n, `bin array ${index} outside the internal bitmap`);
    const word = Number(offset / 64n);
    words[word] = (words[word] ?? 0n) | (1n << (offset % 64n));
  }
  lbPair['binArrayBitmap'] = words.map((word) => new DlmmMathBN(word.toString(10), 10));
  const binTemplate = template.binArray.bins[0];
  assert.ok(binTemplate !== undefined, 'genuine bin array has bins');
  const binArrays = indices.map((index): BinArrayAccount => {
    const account = dlmmMathCloneValue(template.binArray) as DlmmMathRecord;
    dlmmMathSetField(account, 'index', index.toString(10));
    account['lbPair'] = template.pool;
    const bins = Array.from({ length: Number(DLMM_MATH_BIN_ARRAY_SIZE) }, (_unused, offset) => {
      const bin = dlmmMathZeroLike(binTemplate) as DlmmMathRecord;
      dlmmMathSetField(bin, 'price', dlmmMathQPrice(index * DLMM_MATH_BIN_ARRAY_SIZE + BigInt(offset), binStep).toString(10));
      return bin;
    });
    for (const binSpec of spec.bins) {
      const id = BigInt(binSpec.id);
      if (dlmmMathFloorDiv(id, DLMM_MATH_BIN_ARRAY_SIZE) !== index) continue;
      const bin = bins[Number(id - index * DLMM_MATH_BIN_ARRAY_SIZE)];
      assert.ok(bin !== undefined);
      dlmmMathSetField(bin, 'price', binSpec.priceQ64);
      dlmmMathSetField(bin, 'amountX', binSpec.amountX);
      dlmmMathSetField(bin, 'amountY', binSpec.amountY);
      dlmmMathSetField(bin, 'openOrderAmount', binSpec.openOrderAmount);
      dlmmMathSetField(bin, 'processedOrderRemainingAmount', binSpec.processedOrderRemainingAmount);
      dlmmMathSetField(bin, 'limitOrderAskSide', binSpec.limitOrderAskSide ? '1' : '0');
    }
    account['bins'] = bins;
    const [publicKey] = dlmmMathSdk.deriveBinArray(template.pool, new DlmmMathBN(index.toString(10), 10), template.programId);
    return { publicKey, account: account as unknown as BinArrayAccount['account'] };
  });
  return { programId: template.programId, pool: template.pool, lbPair: lbPair as unknown as LbPair, binArrays };
}

function dlmmMathStateSnapshot(state: DlmmMathState): string {
  return JSON.stringify(dlmmMathEncodeSdkValue({ pool: state.pool, lbPair: state.lbPair, binArrays: state.binArrays }));
}

function dlmmMathStateBin(state: DlmmMathState, binId: number): DlmmMathRecord {
  const id = BigInt(binId);
  const index = dlmmMathFloorDiv(id, DLMM_MATH_BIN_ARRAY_SIZE);
  const array = state.binArrays.find((candidate) => BigInt(candidate.account.index.toString(10)) === index);
  assert.ok(array !== undefined, `state has no bin array for bin ${binId}`);
  const bin = array.account.bins[Number(id - index * DLMM_MATH_BIN_ARRAY_SIZE)];
  assert.ok(bin !== undefined, `bin ${binId} missing from its array`);
  return bin as unknown as DlmmMathRecord;
}

function dlmmMathBitmapIndices(lbPair: LbPair): bigint[] {
  const words = (lbPair as unknown as DlmmMathRecord)['binArrayBitmap'] as readonly BN[];
  const indices: bigint[] = [];
  words.forEach((word, wordIndex) => {
    const value = BigInt(word.toString(10));
    for (let bit = 0n; bit < 64n; bit += 1n) {
      if (((value >> bit) & 1n) !== 0n) indices.push(BigInt(wordIndex) * 64n + bit - DLMM_MATH_BITMAP_OFFSET);
    }
  });
  return indices;
}

function dlmmMathKernelInput(state: DlmmMathState, spec: DlmmOraclePoolSpec, inputDomainEnd: bigint): DlmmKernelInput {
  const template = dlmmMathTemplate();
  return {
    programId: state.programId,
    pool: state.pool,
    lbPair: state.lbPair,
    binArrays: state.binArrays,
    // Same-bank attestation: the genuine template bank holds null at the extension PDA.
    bitmapExtension: null,
    clock: { slot: BigInt(template.clock.slot), epoch: BigInt(template.clock.epoch), unixTimestamp: BigInt(spec.currentTimestamp) },
    direction: spec.swapForY ? 'X_TO_Y' : 'Y_TO_X',
    zeroTransferFeeAdmitted: true,
    inputDomainEnd,
  };
}

function dlmmMathRow(table: readonly DlmmOracleQuote[], x: bigint): DlmmOracleQuote {
  const row = table[Number(x)];
  assert.ok(row !== undefined && row.input === x, `oracle table lacks x=${x}`);
  return row;
}

let dlmmMathCanonicalMemo: readonly DlmmMathCanonicalCase[] | null = null;

function dlmmMathCanonicalCases(): readonly DlmmMathCanonicalCase[] {
  if (dlmmMathCanonicalMemo !== null) return dlmmMathCanonicalMemo;
  const cases = DLMM_INDEPENDENT_NORMALIZED_CASES.filter((source) => source.bruteforce).map((source): DlmmMathCanonicalCase => {
    assert.ok(source.cap !== undefined && source.benchmark !== undefined, `${source.id}: bruteforce case needs cap and benchmark`);
    const cap = BigInt(source.cap);
    assert.ok(cap > 0n && cap <= DLMM_ORACLE_MAX_ENUMERATION_CAP, `${source.id}: cap must be within 1..4096`);
    const spec = dlmmMathCanonicalPoolSpec(source.pool);
    const oraclePool = dlmmOracleParsePool(spec);
    // Full independent table x = 0..cap (the benchmark does not affect quotes).
    const table = dlmmOracleSolve(oraclePool, dlmmMathBenchmark(spec, 300n), cap).table;
    const state = dlmmMathBuildState(spec);
    const snapshot = dlmmMathStateSnapshot(state);
    const prepared = prepareDlmmKernel(dlmmMathKernelInput(state, spec, cap));
    return { id: source.id, sourceImpactBps: BigInt(source.benchmark.impactBps), cap, spec, oraclePool, table, state, snapshot, prepared };
  });
  dlmmMathCanonicalMemo = cases;
  return cases;
}

function dlmmMathCanonicalCase(id: string): DlmmMathCanonicalCase {
  const found = dlmmMathCanonicalCases().find((candidate) => candidate.id === id);
  assert.ok(found !== undefined, `canonical case ${id} missing`);
  return found;
}

let dlmmMathU64GuardMemo: DlmmMathU64Guard | null = null;

// Single canonical bin at id -20 (price < 1): amountY = u64::MAX but its full input exceeds u64::MAX.
function dlmmMathU64Guard(): DlmmMathU64Guard {
  if (dlmmMathU64GuardMemo !== null) return dlmmMathU64GuardMemo;
  const spec: DlmmOraclePoolSpec = {
    binStep: '100',
    activeId: '-20',
    swapForY: true,
    collectFeeMode: 'InputOnly',
    supportLimitOrder: true,
    currentTimestamp: '1000',
    sParameters: {
      baseFactor: '10000',
      baseFeePowerFactor: '0',
      variableFeeControl: '0',
      maxVolatilityAccumulator: '350000',
      filterPeriod: '30',
      decayPeriod: '600',
      reductionFactor: '5000',
    },
    vParameters: { volatilityAccumulator: '0', volatilityReference: '0', indexReference: '-20', lastUpdateTimestamp: '1000' },
    bins: [
      {
        id: '-20',
        priceQ64: dlmmMathQPrice(-20n, 100n).toString(10),
        amountX: '0',
        amountY: DLMM_MATH_U64_MAX.toString(10),
        limitOrderAskSide: false,
        openOrderAmount: '0',
        processedOrderRemainingAmount: '0',
      },
    ],
    zeroTransferTaxAdmitted: true,
  };
  const oraclePool = dlmmOracleParsePool(spec);
  const state = dlmmMathBuildState(spec);
  const snapshot = dlmmMathStateSnapshot(state);
  const prepared = prepareDlmmKernel(dlmmMathKernelInput(state, spec, DLMM_MATH_U64_MAX));
  const guard: DlmmMathU64Guard = {
    spec,
    oraclePool,
    state,
    snapshot,
    prepared,
    inputs: [1n, 1n << 63n, DLMM_MATH_U64_MAX - 1n, DLMM_MATH_U64_MAX],
  };
  dlmmMathU64GuardMemo = guard;
  return guard;
}

// Isolated child: the only place Date.now is frozen. Network access throws and is counted.
const DLMM_MATH_SDK_CHILD_SOURCE = `'use strict';
const fs = require('node:fs');
const { createRequire } = require('node:module');
const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
const load = createRequire(payload.requireBase);
let networkCalls = 0;
const offline = (what) => {
  networkCalls += 1;
  throw new Error('NO_NETWORK:' + what);
};
globalThis.fetch = () => offline('fetch');
const SDK = load('@meteora-ag/dlmm');
const BN = load('bn.js');
const { PublicKey } = load('@solana/web3.js');
const { unpackMint, unpackAccount } = load('@solana/spl-token');
const connection = new Proxy({}, {
  get(_target, key) {
    if (key === 'commitment') return 'finalized';
    return offline(String(key));
  },
});
const program = SDK.createProgram(connection);
const fixture = JSON.parse(fs.readFileSync(payload.fixturePath, 'utf8'));
const info = (key) => {
  const account = fixture.accounts[key.toBase58()];
  if (account == null) throw new Error('fixture account missing: ' + key.toBase58());
  return { ...account, owner: new PublicKey(account.owner), data: Buffer.from(account.data[0], 'base64') };
};
const revive = (value) => {
  if (Array.isArray(value)) return value.map(revive);
  if (value === null || typeof value !== 'object') return value;
  if (typeof value.$bn === 'string') return new BN(value.$bn, 10);
  if (typeof value.$pk === 'string') return new PublicKey(value.$pk);
  if (typeof value.$u8 === 'string') return Buffer.from(value.$u8, 'base64');
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item)]));
};
const token = (mint, reserve) => {
  const mintInfo = info(mint);
  const reserveInfo = info(reserve);
  return {
    publicKey: mint,
    reserve,
    mint: unpackMint(mint, mintInfo, mintInfo.owner),
    amount: unpackAccount(reserve, reserveInfo, reserveInfo.owner).amount,
    owner: mintInfo.owner,
    transferHookAccountMetas: [],
  };
};
const results = payload.requests.map((request) => {
  const lbPair = revive(request.lbPair);
  const binArrays = revive(request.binArrays);
  const clock = revive(request.clock);
  const frozenMs = Number(request.unixTimestamp) * 1000;
  Date.now = () => frozenMs;
  const dlmm = new SDK(new PublicKey(request.pool), program, lbPair, null, token(lbPair.tokenXMint, lbPair.reserveX), token(lbPair.tokenYMint, lbPair.reserveY), [], clock);
  return request.inputs.map((x) => {
    try {
      const quote = dlmm.swapQuote(new BN(x, 10), request.swapForY, new BN(0), binArrays, true);
      return { x, ok: true, consumed: quote.consumedInAmount.toString(10), out: quote.outAmount.toString(10), fee: quote.fee.toString(10), protocolFee: quote.protocolFee.toString(10), feeOnInput: quote.feeOnInput };
    } catch (error) {
      return { x, ok: false, errorName: error && error.name != null ? String(error.name) : null, errorCode: error && error.code != null ? String(error.code) : null, message: String((error && error.message) || error) };
    }
  });
});
process.stdout.write(JSON.stringify({ networkCalls, dateFrozenInChildOnly: true, results }));
`;

function dlmmMathChildRequest(state: DlmmMathState, spec: DlmmOraclePoolSpec, inputs: readonly bigint[]): unknown {
  const clock = dlmmMathTemplate().clock;
  return {
    pool: state.pool.toBase58(),
    lbPair: dlmmMathEncodeSdkValue(state.lbPair),
    binArrays: dlmmMathEncodeSdkValue(state.binArrays),
    clock: {
      slot: { $bn: clock.slot },
      epochStartTimestamp: { $bn: clock.epochStartTimestamp },
      epoch: { $bn: clock.epoch },
      leaderScheduleEpoch: { $bn: clock.leaderScheduleEpoch },
      unixTimestamp: { $bn: spec.currentTimestamp },
    },
    unixTimestamp: spec.currentTimestamp,
    swapForY: spec.swapForY,
    inputs: inputs.map((x) => x.toString(10)),
  };
}

let dlmmMathSdkParityMemo: DlmmMathSdkParity | null = null;

function dlmmMathSdkParity(): DlmmMathSdkParity {
  if (dlmmMathSdkParityMemo !== null) return dlmmMathSdkParityMemo;
  const jobs: { readonly id: string; readonly request: unknown }[] = dlmmMathCanonicalCases().map((c) => ({
    id: c.id,
    request: dlmmMathChildRequest(c.state, c.spec, Array.from({ length: Number(c.cap) + 1 }, (_unused, x) => BigInt(x))),
  }));
  const guard = dlmmMathU64Guard();
  jobs.push({ id: DLMM_MATH_U64_GUARD_ID, request: dlmmMathChildRequest(guard.state, guard.spec, guard.inputs) });
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['NODE_TEST_CONTEXT'];
  const run = spawnSync(process.execPath, ['-e', DLMM_MATH_SDK_CHILD_SOURCE], {
    input: JSON.stringify({ requireBase: import.meta.url, fixturePath: DLMM_MATH_FIXTURE_PATH, requests: jobs.map((job) => job.request) }),
    encoding: 'utf8',
    env,
    maxBuffer: 256 * 1024 * 1024,
    timeout: 300_000,
  });
  assert.equal(run.error, undefined, `SDK child failed to spawn: ${String(run.error)}`);
  assert.equal(run.status, 0, `SDK child exited ${String(run.status)}: ${run.stderr}`);
  const output = JSON.parse(run.stdout) as DlmmMathChildOutput;
  assert.equal(output.results.length, jobs.length);
  const parity: DlmmMathSdkParity = {
    networkCalls: output.networkCalls,
    dateFrozenInChildOnly: output.dateFrozenInChildOnly,
    rows: new Map<string, readonly DlmmMathChildRow[]>(jobs.map((job, index) => [job.id, output.results[index] ?? []])),
  };
  dlmmMathSdkParityMemo = parity;
  return parity;
}

function dlmmMathKernelErrorCode(code: DlmmKernelErrorCode): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof DlmmKernelError, `expected DlmmKernelError(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

// Root fee convention: source-reported fee + protocolFee (dust absorption reports 0), never pre-split inputTradingFee.
function dlmmMathAssertKernelQuote(label: string, quote: DlmmExactInQuote, oracle: DlmmOracleQuote): void {
  const at = `${label} x=${oracle.input}`;
  assert.equal(quote.input, oracle.input, at);
  assert.equal(quote.consumed, oracle.consumed, `${at} consumed`);
  assert.equal(quote.remainder, oracle.remainder, `${at} remainder`);
  assert.equal(quote.net, oracle.net, `${at} net`);
  assert.equal(quote.fullyConsumed, oracle.complete, `${at} complete`);
  assert.equal(quote.lpFee + quote.protocolFee, oracle.feePlusProtocolFee, `${at} fee+protocol`);
  assert.equal(quote.feeUnit, oracle.feeOnInput ? 'INPUT_TOKEN' : 'OUTPUT_TOKEN', `${at} fee unit`);
}

function dlmmMathAssertSdkRow(label: string, row: DlmmMathChildRow | undefined, oracle: DlmmOracleQuote, quote: DlmmExactInQuote): void {
  const at = `${label} x=${oracle.input}`;
  assert.ok(row !== undefined, `${at}: missing SDK row`);
  assert.equal(row.x, oracle.input.toString(10), at);
  if (oracle.consumed === 0n) {
    assert.equal(row.ok, false, `${at}: zero consumption must be the SDK insufficient-liquidity error, not a fabricated quote`);
    assert.ok(
      row.errorName === DLMM_MATH_SDK_INSUFFICIENT || row.errorCode === DLMM_MATH_SDK_INSUFFICIENT,
      `${at}: unexpected SDK error ${String(row.errorName)}/${String(row.errorCode)}: ${String(row.message)}`,
    );
    assert.equal(quote.consumed, 0n, at);
    return;
  }
  assert.equal(row.ok, true, `${at}: SDK error ${String(row.errorName)}: ${String(row.message)}`);
  const consumed = dlmmMathDecimal(row.consumed, at);
  const out = dlmmMathDecimal(row.out, at);
  const feeTotal = dlmmMathDecimal(row.fee, at) + dlmmMathDecimal(row.protocolFee, at);
  assert.equal(consumed, oracle.consumed, `${at} SDK consumed vs oracle`);
  assert.equal(out, oracle.net, `${at} SDK net vs oracle`);
  assert.equal(feeTotal, oracle.feePlusProtocolFee, `${at} SDK fee+protocol vs oracle`);
  assert.equal(row.feeOnInput, oracle.feeOnInput, `${at} SDK feeOnInput`);
  assert.equal(quote.consumed, consumed, `${at} kernel consumed vs SDK`);
  assert.equal(quote.net, out, `${at} kernel net vs SDK`);
  assert.equal(quote.lpFee + quote.protocolFee, feeTotal, `${at} kernel fee+protocol vs SDK`);
}

function dlmmMathAssertSolve(c: DlmmMathCanonicalCase, lossBps: number): DlmmCapacityKnown {
  const label = `${c.id} L=${lossBps}`;
  const benchmark = dlmmMathBenchmark(c.spec, BigInt(lossBps));
  const expected = dlmmOracleSolve(c.oraclePool, benchmark, c.cap);
  const result = solveDlmmCapacity(c.prepared, lossBps);
  assert.ok(result.status === 'KNOWN', `${label}: ${result.status === 'UNRESOLVED' ? `${result.reason} ${result.detail}` : ''}`);
  assert.equal(result.lossBps, lossBps, label);
  assert.equal(result.maxNet, expected.maxNet, `${label} maxNet`);
  assert.equal(result.smallestInputAttainingMax, expected.smallestInputAtMaxNet, `${label} smallest input attaining max`);
  assert.equal(result.greatestAdmissibleInput, expected.greatestAdmissibleInput, `${label} greatest admissible input`);
  assert.equal(result.zeroReason === null, expected.maxNet > 0n, `${label} zeroReason`);
  const coefficients = dlmmAdmissibilityCoefficients(c.prepared, lossBps);
  assert.equal(coefficients.admissibilityK, c.prepared.benchmarkDen * DLMM_BPS, `${label} K`);
  assert.equal(coefficients.admissibilityJ, c.prepared.benchmarkNum * (DLMM_BPS - BigInt(lossBps)), `${label} J`);
  const chosen = [
    [result.smallestInputAttainingMax, result.quoteAtSmallest],
    [result.greatestAdmissibleInput, result.quoteAtGreatest],
  ] as const;
  for (const [x, reported] of chosen) {
    const requote = quoteDlmmExactIn(c.prepared, x);
    assert.equal(requote.fullyConsumed, true, `${label} requote x=${x} complete`);
    assert.equal(requote.consumed, x, `${label} requote x=${x} consumed`);
    assert.ok(requote.net * coefficients.admissibilityK >= x * coefficients.admissibilityJ, `${label} kernel inequality x=${x}`);
    assert.ok(
      requote.net * benchmark.den * DLMM_ORACLE_BASIS_POINT_MAX >= x * benchmark.num * (DLMM_ORACLE_BASIS_POINT_MAX - benchmark.impactBps),
      `${label} independent inequality x=${x}`,
    );
    if (reported !== null) {
      assert.equal(reported.input, x, label);
      assert.equal(reported.consumed, requote.consumed, label);
      assert.equal(reported.net, requote.net, label);
      assert.equal(reported.fullyConsumed, true, label);
    }
  }
  assert.equal(quoteDlmmExactIn(c.prepared, result.smallestInputAttainingMax).net, result.maxNet, `${label} requoted maxNet`);
  const certificate = result.certificate;
  assert.equal(certificate.lossBps, lossBps, label);
  assert.equal(certificate.admissibilityK, coefficients.admissibilityK, label);
  assert.equal(certificate.admissibilityJ, coefficients.admissibilityJ, label);
  assert.equal(certificate.benchmarkNum, c.prepared.benchmarkNum, label);
  assert.equal(certificate.benchmarkDen, c.prepared.benchmarkDen, label);
  assert.equal(certificate.domainEnd, c.prepared.domainEnd, label);
  assert.equal(certificate.coverage, c.prepared.coverage, label);
  assert.equal(certificate.extensionState, 'ABSENT_ATTESTED', label);
  assert.equal(certificate.witnessNet, result.maxNet, label);
  assert.equal(verifyDlmmMaximalityCertificate(c.prepared, certificate).ok, true, `${label} certificate self-verifies`);
  const forged = verifyDlmmMaximalityCertificate(c.prepared, { ...certificate, witnessNet: certificate.witnessNet + 1n });
  assert.equal(forged.ok, false, `${label} forged witnessNet must be rejected`);
  return result;
}

test('DLMM oracle: all 15 normalized hand-derived self-checks pass (2293 enumerated inputs)', () => {
  assert.equal(DLMM_INDEPENDENT_NORMALIZED_CASES.length, 15);
  assert.equal(new Set(DLMM_INDEPENDENT_NORMALIZED_CASES.map((spec) => spec.id)).size, 15);
  let enumerated = 0;
  for (const spec of DLMM_INDEPENDENT_NORMALIZED_CASES) {
    const solved = dlmmOracleCheckCase(spec);
    assert.equal(solved !== undefined, spec.bruteforce, spec.id);
    if (solved === undefined) continue;
    assert.equal(solved.scope, 'CAP_SCOPED_EXHAUSTIVE', spec.id);
    assert.equal(solved.table.length, Number(solved.cap) + 1, spec.id);
    assert.equal(solved.admissibleInputs[0], 0n, spec.id);
    enumerated += solved.table.length;
  }
  assert.equal(enumerated, 2293);
  // Hand-derived source dust edge: one atom is absorbed entirely as fee and splitFee reports zero.
  const trap = DLMM_INDEPENDENT_NORMALIZED_CASES.find((spec) => spec.id === DLMM_MATH_TRAP_ID);
  assert.ok(trap !== undefined);
  const dust = dlmmOracleQuote(dlmmOracleParsePool(trap.pool), 1n);
  assert.equal(dust.consumed, 1n);
  assert.equal(dust.net, 0n);
  assert.equal(dust.inputTradingFee, 1n);
  assert.equal(dust.feePlusProtocolFee, 0n);
});

test('DLMM SDK root: CJS constructor carries pinned primitives and the genuine ordinary template is admitted offline', () => {
  assert.equal(typeof dlmmMathSdkRootValue, 'function');
  assert.equal((dlmmMathSdkRootValue as { readonly default?: unknown }).default, undefined);
  for (const name of [
    'createProgram',
    'decodeAccount',
    'getQPriceFromId',
    'deriveBinArray',
    'deriveBinArrayBitmapExtension',
    'getFeeMode',
    'isSupportLimitOrder',
    'updateReference',
    'updateVolatilityAccumulator',
    'swapExactInQuoteAtBin',
  ] as const) {
    assert.equal(typeof dlmmMathSdk[name], 'function', name);
  }
  assert.equal(DLMM_Q64, DLMM_ORACLE_Q64);
  assert.equal(DLMM_U64_MAX, DLMM_MATH_U64_MAX);
  assert.equal(dlmmMathQPrice(0n, 100n), DLMM_ORACLE_Q64);
  const template = dlmmMathTemplate();
  assert.equal(template.binArray.bins.length, 70);
  assert.ok(template.binArray.lbPair.equals(template.pool));
  assert.equal(dlmmMathNetworkCalls, 0);
});

test('DLMM canonical cases: SDK-derived prices, zeroed unused bins, exact bitmap/PDA and source enum mapping', () => {
  const template = dlmmMathTemplate();
  const flags = new Set<string>();
  for (const c of dlmmMathCanonicalCases()) {
    const binStep = BigInt(c.spec.binStep);
    const used = new Set(c.spec.bins.map((bin) => bin.id));
    for (const bin of c.spec.bins) {
      assert.equal(BigInt(bin.priceQ64), dlmmMathQPrice(BigInt(bin.id), binStep), `${c.id} bin ${bin.id} canonical price`);
    }
    const arrayIndices: bigint[] = [];
    for (const array of c.state.binArrays) {
      const index = BigInt(array.account.index.toString(10));
      arrayIndices.push(index);
      const [expectedKey] = dlmmMathSdk.deriveBinArray(template.pool, new DlmmMathBN(index.toString(10), 10), template.programId);
      assert.ok(array.publicKey.equals(expectedKey), `${c.id} array ${index} PDA`);
      assert.ok(array.account.lbPair.equals(template.pool), `${c.id} array ${index} parent`);
      assert.equal(array.account.bins.length, 70);
      array.account.bins.forEach((bin, offset) => {
        const id = index * DLMM_MATH_BIN_ARRAY_SIZE + BigInt(offset);
        const record = bin as unknown as DlmmMathRecord;
        assert.equal(BigInt((record['price'] as BN).toString(10)), dlmmMathQPrice(id, binStep), `${c.id} bin ${id} price`);
        if (!used.has(id.toString(10))) {
          for (const field of ['amountX', 'amountY', 'openOrderAmount', 'processedOrderRemainingAmount'] as const) {
            assert.ok((record[field] as BN).isZero(), `${c.id} unused bin ${id} ${field} must be zero`);
          }
        }
      });
    }
    assert.deepEqual(dlmmMathBitmapIndices(c.state.lbPair), [...arrayIndices].sort(dlmmMathCompare), `${c.id} bitmap`);
    const feeOnInput = dlmmOracleFeeOnInput(c.spec.collectFeeMode, c.spec.swapForY);
    assert.equal(dlmmMathSdk.isSupportLimitOrder(c.state.lbPair), c.spec.supportLimitOrder, `${c.id} source isSupportLimitOrder`);
    assert.equal(dlmmMathSdk.getFeeMode(c.state.lbPair, c.spec.swapForY).feeOnInput, feeOnInput, `${c.id} source getFeeMode`);
    const p = c.prepared;
    assert.equal(p.kernelVersion, DLMM_KERNEL_VERSION);
    assert.equal(p.poolAddress, template.pool.toBase58());
    assert.equal(p.direction, c.spec.swapForY ? 'X_TO_Y' : 'Y_TO_X');
    assert.equal(p.swapForY, c.spec.swapForY);
    assert.equal(p.feeOnInput, feeOnInput);
    assert.equal(p.feeUnit, feeOnInput ? 'INPUT_TOKEN' : 'OUTPUT_TOKEN');
    assert.equal(p.supportLimitOrder, c.spec.supportLimitOrder);
    assert.equal(p.binStep, Number(c.spec.binStep));
    assert.equal(p.activeId, Number(c.spec.activeId));
    assert.equal(p.activePriceQ64, dlmmMathQPrice(BigInt(c.spec.activeId), binStep));
    const benchmark = dlmmMathBenchmark(c.spec, 0n);
    assert.equal(p.benchmarkNum * benchmark.den, benchmark.num * p.benchmarkDen, `${c.id} activeId benchmark`);
    assert.equal(p.extensionState, 'ABSENT_ATTESTED');
    assert.equal(p.inputDomainCap, c.cap);
    assert.equal(p.clock.unixTimestamp, BigInt(c.spec.currentTimestamp));

    flags.add(c.spec.swapForY ? 'X_TO_Y' : 'Y_TO_X');
    flags.add(c.spec.collectFeeMode);
    flags.add(feeOnInput ? 'FEE_ON_INPUT' : 'FEE_ON_OUTPUT');
    flags.add(c.spec.supportLimitOrder ? 'LIMIT_ORDERS' : 'NO_LIMIT_ORDERS');
    flags.add(`REFERENCE_${dlmmMathRow(c.table, 0n).reference.update}`);
    for (const bin of p.bins) for (const layer of bin.layers) flags.add(layer.kind);
    if (
      c.spec.bins.some(
        (bin) => bin.limitOrderAskSide === c.spec.swapForY && BigInt(bin.openOrderAmount) + BigInt(bin.processedOrderRemainingAmount) > 0n,
      )
    ) {
      flags.add('OPPOSITE_ORDERS');
    }
    if (c.table.some((q) => q.consumed > 0n && !q.complete)) flags.add('PARTIAL');
    if (c.table.every((q) => q.consumed === 0n)) flags.add('EMPTY_SIDE');
    if (dlmmMathRow(c.table, c.cap).complete) flags.add('CAP_CLIPPED');
    if (c.table.some((q) => q.consumed > 0n && q.net === 0n && q.feePlusProtocolFee === 0n)) flags.add('DUST_ABSORPTION');
    const own = dlmmOracleSolve(c.oraclePool, dlmmMathBenchmark(c.spec, c.sourceImpactBps), c.cap);
    if (own.greatestAdmissibleInput > own.smallestInputAtMaxNet) flags.add('MIN_INPUT_TIE');
    const admissible = own.admissibleInputs;
    if (admissible.some((x, i) => i > 0 && x !== (admissible[i - 1] ?? x) + 1n)) flags.add('ADMISSIBILITY_HOLES');
  }
  for (const flag of [
    'X_TO_Y',
    'Y_TO_X',
    'InputOnly',
    'OnlyY',
    'FEE_ON_INPUT',
    'FEE_ON_OUTPUT',
    'LIMIT_ORDERS',
    'NO_LIMIT_ORDERS',
    'REFERENCE_NONE',
    'REFERENCE_FILTER_DECAYED',
    'REFERENCE_DECAY_ZERO',
    'MARKET_MAKER',
    'PROCESSED_LIMIT_ORDER',
    'OPEN_LIMIT_ORDER',
    'OPPOSITE_ORDERS',
    'PARTIAL',
    'EMPTY_SIDE',
    'CAP_CLIPPED',
    'DUST_ABSORPTION',
    'MIN_INPUT_TIE',
    'ADMISSIBILITY_HOLES',
  ]) {
    assert.ok(flags.has(flag), `canonical coverage lacks ${flag}`);
  }
});

test('DLMM kernel quote, closed form and envelopes match the independent oracle at every enumerated input', async (t) => {
  let constantEnvelopes = 0;
  let affineEnvelopes = 0;
  for (const c of dlmmMathCanonicalCases()) {
    await t.test(c.id, () => {
      const prepared = c.prepared;
      assert.ok(prepared.domainEnd >= 0n && prepared.domainEnd <= c.cap, `${c.id} domainEnd within the explicit cap`);
      const atCap = dlmmMathRow(c.table, c.cap);
      if (!atCap.complete) {
        assert.equal(prepared.coverage, 'COMPLETE', `${c.id} liquidity exhausted inside the cap`);
      } else if (dlmmOracleQuote(c.oraclePool, c.cap + 1n).complete) {
        assert.equal(prepared.coverage, 'DOMAIN_CAPPED', `${c.id} liquidity extends beyond the cap`);
      }
      for (let x = 0n; x <= c.cap; x += 1n) {
        dlmmMathAssertKernelQuote(c.id, quoteDlmmExactIn(prepared, x), dlmmMathRow(c.table, x));
      }
      assert.throws(() => quoteDlmmExactIn(prepared, c.cap + 1n), dlmmMathKernelErrorCode('INPUT_OUT_OF_PREPARED_DOMAIN'));
      for (let x = 1n; x <= prepared.domainEnd; x += 1n) {
        assert.equal(evaluateDlmmNetClosedForm(prepared, x), dlmmMathRow(c.table, x).net, `${c.id} closed form x=${x}`);
      }
      for (const segment of prepared.segments) {
        const { u0, u1, ud, betaNum } = segment.envelope;
        const label = `${c.id} segment ${segment.index} ${segment.kind}`;
        assert.ok(segment.xStart <= segment.xEnd && ud > 0n && betaNum >= 0n, label);
        if (u1 === 0n) constantEnvelopes += 1;
        else affineEnvelopes += 1;
        if (segment.xStart <= prepared.domainEnd) {
          assert.equal(segment.netAtStart, dlmmMathRow(c.table, segment.xStart).net, `${label} netAtStart`);
        }
        if (segment.xEnd <= prepared.domainEnd) {
          assert.equal(segment.netAtEnd, dlmmMathRow(c.table, segment.xEnd).net, `${label} netAtEnd`);
        }
        const lo = segment.xStart > 1n ? segment.xStart : 1n;
        const hi = segment.xEnd < prepared.domainEnd ? segment.xEnd : prepared.domainEnd;
        for (let x = lo; x <= hi; x += 1n) {
          const scaled = dlmmMathRow(c.table, x).net * ud;
          const upper = u0 + u1 * x;
          assert.ok(scaled <= upper && scaled >= upper - betaNum, `${label} envelope x=${x}`);
        }
      }
    });
  }
  assert.ok(constantEnvelopes > 0, 'a constant (absorption) envelope is exercised');
  assert.ok(affineEnvelopes > 0, 'an affine (layer) envelope is exercised');
});

test('DLMM kernel solve matches the exhaustive cap-scoped oracle at L300, L450 and each source impact', async (t) => {
  for (const c of dlmmMathCanonicalCases()) {
    await t.test(c.id, () => {
      for (const lossBps of new Set([300, 450, Number(c.sourceImpactBps)])) dlmmMathAssertSolve(c, lossBps);
    });
  }
  const empty = solveDlmmCapacity(dlmmMathCanonicalCase(DLMM_MATH_EMPTY_ID).prepared, 300);
  assert.ok(empty.status === 'KNOWN');
  assert.equal(empty.zeroReason, 'NO_SELL_SIDE_LIQUIDITY');
});

test('DLMM canonical trap, forced 3% tie and one-atom absorption edges', () => {
  const trap = dlmmMathCanonicalCase(DLMM_MATH_TRAP_ID);
  const bin1Price = dlmmMathQPrice(1n, 100n);
  assert.ok(bin1Price > DLMM_ORACLE_Q64 && 8n * bin1Price < 9n * DLMM_ORACLE_Q64, 'SDK price of bin 1 lies in the trap window Q < P < 9Q/8');
  const trapPoints: readonly (readonly [bigint, bigint, bigint, bigint, boolean])[] = [
    [1n, 1n, 0n, 0n, true],
    [10n, 10n, 9n, 0n, true],
    [11n, 11n, 9n, 0n, true],
    [12n, 11n, 10n, 1n, false],
  ];
  for (const [x, consumed, net, remainder, complete] of trapPoints) {
    const expected = { consumed, net, remainder, complete };
    const oracle = dlmmMathRow(trap.table, x);
    assert.deepEqual(
      { consumed: oracle.consumed, net: oracle.net, remainder: oracle.remainder, complete: oracle.complete },
      expected,
      `canonical trap oracle x=${x}`,
    );
    const kernel = quoteDlmmExactIn(trap.prepared, x);
    assert.deepEqual(
      { consumed: kernel.consumed, net: kernel.net, remainder: kernel.remainder, complete: kernel.fullyConsumed },
      expected,
      `canonical trap kernel x=${x}`,
    );
  }
  const dust = quoteDlmmExactIn(trap.prepared, 1n);
  assert.equal(dust.lpFee + dust.protocolFee, 0n, 'one-atom absorption reports zero source fee');
  assert.equal(dlmmMathRow(trap.table, 1n).inputTradingFee, 1n);
  const trapBin = trap.prepared.bins.find((bin) => bin.binId === 1);
  assert.ok(trapBin !== undefined);
  assert.equal(trapBin.fullInput, 10n, 'I = ceil(E*F/(F-f)) = 10');
  assert.equal(trapBin.absorbEnd, 11n, 'A = 11');
  const trapSolve = dlmmMathAssertSolve(trap, 2000);
  assert.equal(trapSolve.maxNet, 9n);
  assert.equal(trapSolve.smallestInputAttainingMax, 10n);
  assert.equal(trapSolve.greatestAdmissibleInput, 11n);

  const tie = dlmmMathCanonicalCase(DLMM_MATH_TIE_ID);
  assert.equal(tie.prepared.activePriceQ64, DLMM_ORACLE_Q64);
  const tieSolve = dlmmMathAssertSolve(tie, 300);
  assert.equal(tieSolve.maxNet, 97n);
  assert.equal(tieSolve.smallestInputAttainingMax, 100n);
  assert.equal(tieSolve.greatestAdmissibleInput, 100n);
  const tieQuote = quoteDlmmExactIn(tie.prepared, 100n);
  assert.equal(tieQuote.net, 97n);
  assert.equal(tieQuote.fullyConsumed, true);
  assert.equal(tieQuote.feeUnit, 'OUTPUT_TOKEN');
  const coefficients = dlmmAdmissibilityCoefficients(tie.prepared, 300);
  assert.equal(tieQuote.net * coefficients.admissibilityK, 100n * coefficients.admissibilityJ, 'x=100 net=97 is an exact L300 tie');
  const below = quoteDlmmExactIn(tie.prepared, 99n);
  assert.equal(below.net, 96n);
  assert.ok(below.net * coefficients.admissibilityK < 99n * coefficients.admissibilityJ, 'x=99 is inadmissible');
});

test('DLMM published SDK swapQuote (isolated frozen-clock child) matches kernel and oracle on every enumerated input', () => {
  const parity = dlmmMathSdkParity();
  assert.equal(parity.networkCalls, 0);
  assert.equal(parity.dateFrozenInChildOnly, true);
  assert.equal(Date.now, dlmmMathOriginalDateNow, 'parent Date.now must never be frozen');
  for (const c of dlmmMathCanonicalCases()) {
    const rows = parity.rows.get(c.id);
    assert.ok(rows !== undefined && rows.length === Number(c.cap) + 1, `${c.id} SDK rows`);
    const zero = rows[0];
    assert.ok(zero !== undefined && !zero.ok, `${c.id}: SDK x=0 is the explicit insufficient-liquidity error`);
    for (let x = 0n; x <= c.cap; x += 1n) {
      dlmmMathAssertSdkRow(`${c.id} SDK`, rows[Number(x)], dlmmMathRow(c.table, x), quoteDlmmExactIn(c.prepared, x));
    }
  }
  const empty = parity.rows.get(DLMM_MATH_EMPTY_ID);
  assert.ok(empty !== undefined && empty.length > 0 && empty.every((row) => !row.ok), 'empty side never yields an SDK quote');
  const trapRows = parity.rows.get(DLMM_MATH_TRAP_ID);
  assert.ok(trapRows !== undefined);
  const sdkTrap: readonly (readonly [number, string, string])[] = [
    [1, '1', '0'],
    [10, '10', '9'],
    [11, '11', '9'],
    [12, '11', '10'],
  ];
  for (const [x, consumed, out] of sdkTrap) {
    const row: DlmmMathChildRow = trapRows[x];
    assert.ok(row !== undefined && row.ok, `trap SDK x=${x} is a quote, partial consumption included`);
    assert.equal(row.consumed, consumed, `trap SDK x=${x} consumed`);
    assert.equal(row.out, out, `trap SDK x=${x} out`);
  }
  const dustRow = trapRows[1];
  assert.ok(dustRow !== undefined);
  assert.equal(dlmmMathDecimal(dustRow.fee, 'dust fee') + dlmmMathDecimal(dustRow.protocolFee, 'dust protocol'), 0n);
});

test('DLMM u64 guard: a canonical sub-unit-price bin is never mistaken for full at the u64 input domain', () => {
  const guard = dlmmMathU64Guard();
  const amountY = DLMM_MATH_U64_MAX;
  const price = dlmmMathQPrice(-20n, 100n);
  assert.ok(price < DLMM_ORACLE_Q64, 'negative-id price is below one');
  // Independent, non-enumerated oracle points; no exhaustive claim is made for this case.
  const saturated = dlmmOracleQuote(guard.oraclePool, 1n << 66n);
  assert.equal(saturated.net, amountY);
  assert.ok(saturated.consumed > DLMM_MATH_U64_MAX, 'draining the bin needs more than u64::MAX input');
  const atMax = dlmmOracleQuote(guard.oraclePool, DLMM_MATH_U64_MAX);
  assert.equal(atMax.complete, true);
  assert.equal(atMax.consumed, DLMM_MATH_U64_MAX);
  assert.ok(atMax.net < amountY);
  const prepared = guard.prepared;
  assert.equal(prepared.inputDomainCap, DLMM_MATH_U64_MAX);
  assert.equal(prepared.domainEnd, DLMM_MATH_U64_MAX);
  assert.equal(prepared.coverage, 'DOMAIN_CAPPED');
  const bin = prepared.bins.find((candidate) => candidate.binId === -20);
  assert.ok(bin !== undefined);
  assert.equal(bin.priceQ64, price);
  assert.ok(bin.fullInput > DLMM_MATH_U64_MAX, 'full-bin input lies beyond the u64 domain');
  assert.equal(bin.fullInput, saturated.consumed);
  for (const x of guard.inputs) {
    dlmmMathAssertKernelQuote(DLMM_MATH_U64_GUARD_ID, quoteDlmmExactIn(prepared, x), dlmmOracleQuote(guard.oraclePool, x));
  }
  const quote = quoteDlmmExactIn(prepared, DLMM_MATH_U64_MAX);
  assert.equal(quote.fullyConsumed, true);
  assert.equal(quote.remainder, 0n);
  assert.ok(quote.net < amountY, 'u64::MAX input must not report the full bin output');
  assert.equal(evaluateDlmmNetClosedForm(prepared, DLMM_MATH_U64_MAX), atMax.net);
  // Exact published per-bin primitive at the explicit clock (pure; no Date).
  const pair = guard.state.lbPair as unknown as {
    readonly parameters: sParameters;
    readonly vParameters: vParameters;
    readonly binStep: number;
    readonly activeId: number;
  };
  const vClone = { ...pair.vParameters };
  dlmmMathSdk.updateReference(pair.activeId, vClone, pair.parameters, Number(guard.spec.currentTimestamp));
  dlmmMathSdk.updateVolatilityAccumulator(vClone, pair.parameters, -20);
  const perBin = dlmmMathSdk.swapExactInQuoteAtBin(
    dlmmMathStateBin(guard.state, -20) as unknown as Bin,
    pair.binStep,
    pair.parameters,
    vClone,
    new DlmmMathBN(DLMM_MATH_U64_MAX.toString(10), 10),
    true,
    true,
    true,
  );
  const perBinFee = BigInt(perBin.fee.toString(10)) + BigInt(perBin.protocolFee.toString(10));
  assert.equal(BigInt(perBin.amountIn.toString(10)), DLMM_MATH_U64_MAX);
  assert.equal(BigInt(perBin.amountOut.toString(10)), quote.net);
  assert.equal(perBinFee, quote.lpFee + quote.protocolFee);
  assert.equal(perBinFee, atMax.feePlusProtocolFee);
  const local = dlmmLocalBinQuote(bin, true, DLMM_MATH_U64_MAX);
  assert.equal(local.amountIn, DLMM_MATH_U64_MAX);
  assert.equal(local.amountOut, BigInt(perBin.amountOut.toString(10)));
  assert.equal(local.tradingFee, perBinFee);
  // Complete published swapQuote loop at the same points, from the isolated child.
  const rows = dlmmMathSdkParity().rows.get(DLMM_MATH_U64_GUARD_ID);
  assert.ok(rows !== undefined && rows.length === guard.inputs.length);
  guard.inputs.forEach((x, i) => {
    dlmmMathAssertSdkRow(`${DLMM_MATH_U64_GUARD_ID} SDK`, rows[i], dlmmOracleQuote(guard.oraclePool, x), quoteDlmmExactIn(prepared, x));
  });
});

test('DLMM noncanonical stored prices fail ordinary prepare with BIN_PRICE_DERIVATION_MISMATCH', () => {
  const trap = dlmmMathCanonicalCase(DLMM_MATH_TRAP_ID);
  const shifted = dlmmMathBuildState(trap.spec);
  const bin = dlmmMathStateBin(shifted, 1);
  bin['price'] = (bin['price'] as BN).addn(1);
  assert.throws(
    () => prepareDlmmKernel(dlmmMathKernelInput(shifted, trap.spec, trap.cap)),
    dlmmMathKernelErrorCode('BIN_PRICE_DERIVATION_MISMATCH'),
  );
  // Hand-derived arbitrary prices (3Q/4 at id 0) are oracle arithmetic fixtures, never admitted state.
  const layers = DLMM_INDEPENDENT_NORMALIZED_CASES.find((spec) => spec.id === DLMM_MATH_LAYERS_ID);
  assert.ok(layers !== undefined && layers.cap !== undefined);
  const handPrice = layers.pool.bins.find((candidate) => candidate.id === '0')?.priceQ64;
  assert.ok(handPrice !== undefined);
  assert.notEqual(BigInt(handPrice), dlmmMathQPrice(0n, 100n));
  const handState = dlmmMathBuildState(layers.pool);
  assert.throws(
    () => prepareDlmmKernel(dlmmMathKernelInput(handState, layers.pool, BigInt(layers.cap!))),
    dlmmMathKernelErrorCode('BIN_PRICE_DERIVATION_MISMATCH'),
  );
});

test('DLMM kernel leaves decoded inputs untouched, uses no network and never changes the parent Date', () => {
  const layers = dlmmMathCanonicalCase(DLMM_MATH_LAYERS_ID);
  const state = dlmmMathBuildState(layers.spec);
  const before = dlmmMathStateSnapshot(state);
  const dateNow = Date.now;
  const prepared = prepareDlmmKernel(dlmmMathKernelInput(state, layers.spec, layers.cap));
  for (let x = 0n; x <= layers.cap; x += 1n) quoteDlmmExactIn(prepared, x);
  const solved = solveDlmmCapacity(prepared, 300);
  assert.ok(solved.status === 'KNOWN');
  assert.equal(verifyDlmmMaximalityCertificate(prepared, solved.certificate).ok, true);
  assert.equal(dlmmMathStateSnapshot(state), before, 'prepare/quote/solve must not mutate decoded state');
  assert.equal(Date.now, dateNow);
  assert.equal(Date.now, dlmmMathOriginalDateNow);
  assert.equal(globalThis.Date, dlmmMathOriginalDate);
  for (const c of dlmmMathCanonicalCases()) {
    assert.equal(dlmmMathStateSnapshot(c.state), c.snapshot, `${c.id} decoded state unchanged after all checks`);
  }
  const guard = dlmmMathU64Guard();
  assert.equal(dlmmMathStateSnapshot(guard.state), guard.snapshot);
  const template = dlmmMathTemplate();
  assert.equal(JSON.stringify(dlmmMathEncodeSdkValue({ lbPair: template.lbPair, binArray: template.binArray })), template.snapshot);
  assert.equal(dlmmMathNetworkCalls, 0);
});
// ===== END DLMM PART_A MAINTAINED MATH / ORACLE / SDK PARITY TESTS =====

import { test as dlmmRawTestCase } from 'node:test';
import { strict as dlmmRawTestAssert } from 'node:assert';
import { readFileSync as dlmmRawTestReadFileSync } from 'node:fs';
import { createRequire as dlmmRawTestCreateRequire } from 'node:module';
import { spawnSync as dlmmRawTestSpawnSync } from 'node:child_process';
import { pathToFileURL as dlmmRawTestPathToFileURL } from 'node:url';
import {
  EXEC_LIQ_DLMM_VERSION as dlmmRawTestAdapterVersion,
  planDlmmRoute as dlmmRawTestPlan,
  quoteDlmmRoute as dlmmRawTestQuote,
  solveDlmmRoute as dlmmRawTestSolve,
} from '../src/providers/executable-liquidity-dlmm.js';
import type {
  CoherentBank as RawDlmmTestBank,
  RawAccountMap as RawDlmmTestAccountMap,
  RoutePlan as RawDlmmTestRoutePlan,
  RouteQuote as RawDlmmTestRouteQuote,
  RouteSolve as RawDlmmTestRouteSolve,
  RpcAccount as RawDlmmTestRpcAccount,
  SolanaClock as RawDlmmTestClock,
} from '../src/domain/executable-liquidity.js';
import type { TokenRef as RawDlmmTestTokenRef } from '../src/domain/contracts.js';

// ===== BEGIN DLMM RAW BANK / ADMISSION / COVERAGE TESTS (PART_B) =====
// Drives the canonical planDlmmRoute/quoteDlmmRoute/solveDlmmRoute on the retained genuine bank and on one declared
// synthetic extension-crossing bank. Expectations come from raw bytes, PDA seeds, the independent oracle above and the
// exact published SDK, which quotes only inside a child process whose Date.now is frozen to the bank Clock.
/* eslint-disable @typescript-eslint/no-explicit-any */

const DLMM_RAW_TEST_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const DLMM_RAW_TEST_CLOCK_KEY = 'SysvarC1ock11111111111111111111111111111111';
const DLMM_RAW_TEST_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const DLMM_RAW_TEST_TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const DLMM_RAW_TEST_WSOL = 'So11111111111111111111111111111111111111112';
const DLMM_RAW_TEST_TARGET = 'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump';
const DLMM_RAW_TEST_IMPACT_BPS = 300;
const DLMM_RAW_TEST_BIG_INPUT = '1000000000000000';
const DLMM_RAW_TEST_U64_MAX = (1n << 64n) - 1n;
const DLMM_RAW_TEST_Q64 = 1n << 64n;
const DLMM_RAW_TEST_ATOMIC = /^(0|[1-9][0-9]*)$/;
const DLMM_RAW_TEST_GRID = ['1', '10', '100', '1000', '1000000', '1000000000', '1000000000000', DLMM_RAW_TEST_BIG_INPUT];
const DLMM_RAW_TEST_ZERO_QUOTE = {
  inputAtoms: '0',
  consumedAtoms: '0',
  netAtoms: '0',
  complete: true,
  fees: { tradingInputAtoms: '0', tradingOutputAtoms: '0', transferInputAtoms: '0', transferOutputAtoms: '0' },
};

const dlmmRawTestRequire = dlmmRawTestCreateRequire(import.meta.url);
const dlmmRawTestSdkPath = dlmmRawTestRequire.resolve('@meteora-ag/dlmm');
const dlmmRawTestSdkRequire = dlmmRawTestCreateRequire(dlmmRawTestSdkPath);
// Exact 1.9.14 CommonJS root (the DLMM constructor carrying the pure helpers); web3 and BN resolve beside it.
const DlmmRawTestSdk: any = dlmmRawTestRequire('@meteora-ag/dlmm');
const DlmmRawTestPublicKey: any = (dlmmRawTestSdkRequire('@solana/web3.js') as { readonly PublicKey: unknown }).PublicKey;
const DlmmRawTestBN: any = dlmmRawTestSdkRequire('bn.js');
const dlmmRawTestOriginalDateNow = Date.now;
let dlmmRawTestNetworkCalls = 0;
const dlmmRawTestProgram: any = DlmmRawTestSdk.createProgram(
  new Proxy({}, {
    get(_target, key) {
      if (key === 'commitment') return 'finalized';
      dlmmRawTestNetworkCalls += 1;
      throw new Error(`NO_NETWORK:${String(key)}`);
    },
  }),
);
const dlmmRawTestProgramKey: any = new DlmmRawTestPublicKey(DLMM_RAW_TEST_PROGRAM_ID);

type RawDlmmTestKnown = Extract<RawDlmmTestRouteSolve['outcome'], { readonly status: 'KNOWN' }>;

interface RawDlmmTestFixture {
  readonly context: { readonly slot: number };
  readonly sourceResponseSha256: string;
  readonly accounts: RawDlmmTestAccountMap;
  readonly clock: { readonly [K in keyof RawDlmmTestClock]: string };
  readonly pools: readonly string[];
}

interface RawDlmmTestPoolFacts {
  readonly pool: string;
  readonly tokenX: string;
  readonly tokenY: string;
  readonly reserveX: string;
  readonly reserveY: string;
  readonly extension: string;
  readonly activeId: bigint;
  readonly binStep: bigint;
  readonly pair: any;
}

interface RawDlmmTestRoute {
  readonly facts: RawDlmmTestPoolFacts;
  // Directional flagged array indices, nearest first (descending for X->Y).
  readonly indices: readonly bigint[];
  readonly arrays: readonly string[];
  readonly deepestArray: string | null;
  // MM plus directional limit orders, and MM principal only, over bins at or below activeId.
  readonly directionalOutput: bigint;
  readonly directionalPrincipal: bigint;
}

const dlmmRawTestFixture = JSON.parse(
  dlmmRawTestReadFileSync(new URL('../../tests/fixtures/executable-liquidity-dlmm.json', import.meta.url), 'utf8'),
) as RawDlmmTestFixture;

function dlmmRawTestClock(): RawDlmmTestClock {
  const field = (name: keyof RawDlmmTestClock): number => {
    const value = Number(dlmmRawTestFixture.clock[name]);
    dlmmRawTestAssert.ok(Number.isSafeInteger(value) && String(value) === dlmmRawTestFixture.clock[name], `fixture clock ${name}`);
    return value;
  };
  return {
    slot: field('slot'),
    epochStartTimestamp: field('epochStartTimestamp'),
    epoch: field('epoch'),
    leaderScheduleEpoch: field('leaderScheduleEpoch'),
    unixTimestamp: field('unixTimestamp'),
  };
}

function dlmmRawTestBank(
  accounts: RawDlmmTestAccountMap = dlmmRawTestFixture.accounts,
  clock: Partial<RawDlmmTestClock> = {},
  slot: number = dlmmRawTestFixture.context.slot,
): RawDlmmTestBank {
  return { slot, clock: { ...dlmmRawTestClock(), ...clock }, accounts };
}

const dlmmRawTestToken = (address: string = DLMM_RAW_TEST_TARGET): RawDlmmTestTokenRef =>
  ({ chain: 'solana', address }) as RawDlmmTestTokenRef;
const dlmmRawTestPlanAt = (pool: string, accounts: RawDlmmTestAccountMap, target: string = DLMM_RAW_TEST_TARGET): RawDlmmTestRoutePlan =>
  dlmmRawTestPlan({ token: dlmmRawTestToken(target), pool, accounts });
const dlmmRawTestSolveAt = (
  pool: string,
  bank: RawDlmmTestBank,
  impactBps: number = DLMM_RAW_TEST_IMPACT_BPS,
  target: string = DLMM_RAW_TEST_TARGET,
): RawDlmmTestRouteSolve => dlmmRawTestSolve({ token: dlmmRawTestToken(target), pool, bank, impactBps });
const dlmmRawTestQuoteAt = (pool: string, bank: RawDlmmTestBank, inputAtoms: string, target: string = DLMM_RAW_TEST_TARGET): RawDlmmTestRouteQuote =>
  dlmmRawTestQuote({ token: dlmmRawTestToken(target), pool, bank, inputAtoms });

// ---- raw account helpers (copy-on-write; the retained fixture is never mutated) ----

function dlmmRawTestAccount(accounts: RawDlmmTestAccountMap, key: string): RawDlmmTestRpcAccount {
  const body = accounts[key];
  if (body === undefined || body === null) return dlmmRawTestAssert.fail(`bank lacks body ${key}`);
  return body;
}
const dlmmRawTestData = (body: RawDlmmTestRpcAccount): Buffer => Buffer.from(body.data[0], 'base64');
function dlmmRawTestWithData(body: RawDlmmTestRpcAccount, bytes: Buffer, patch: Readonly<Record<string, unknown>> = {}): RawDlmmTestRpcAccount {
  const space = body.space === undefined ? {} : { space: bytes.length };
  return { ...body, ...space, data: [bytes.toString('base64'), 'base64'], ...patch } as RawDlmmTestRpcAccount;
}
function dlmmRawTestEdit(accounts: RawDlmmTestAccountMap, key: string, edit: (bytes: Buffer) => void): RawDlmmTestAccountMap {
  const body = dlmmRawTestAccount(accounts, key);
  const bytes = Buffer.from(dlmmRawTestData(body));
  edit(bytes);
  return { ...accounts, [key]: dlmmRawTestWithData(body, bytes) };
}
function dlmmRawTestReplace(accounts: RawDlmmTestAccountMap, key: string, bytes: Buffer, patch: Readonly<Record<string, unknown>> = {}): RawDlmmTestAccountMap {
  return { ...accounts, [key]: dlmmRawTestWithData(dlmmRawTestAccount(accounts, key), bytes, patch) };
}
function dlmmRawTestPatch(accounts: RawDlmmTestAccountMap, key: string, patch: Readonly<Record<string, unknown>>): RawDlmmTestAccountMap {
  return { ...accounts, [key]: { ...dlmmRawTestAccount(accounts, key), ...patch } as RawDlmmTestRpcAccount };
}
function dlmmRawTestWithout(accounts: RawDlmmTestAccountMap, key: string): RawDlmmTestAccountMap {
  const out: Record<string, RawDlmmTestRpcAccount | null> = { ...accounts };
  delete out[key];
  return out;
}
function dlmmRawTestPick(keys: readonly string[], source: RawDlmmTestAccountMap = dlmmRawTestFixture.accounts): RawDlmmTestAccountMap {
  const out: Record<string, RawDlmmTestRpcAccount | null> = {};
  for (const key of keys) {
    const body = source[key];
    dlmmRawTestAssert.ok(body !== undefined, `fixture lacks key ${key}`);
    out[key] = body;
  }
  return out;
}
function dlmmRawTestFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as object)) dlmmRawTestFreeze(item);
  }
  return value;
}
const dlmmRawTestSortedKeys = (keys: readonly string[]): string[] => [...new Set(keys)].sort();
const dlmmRawTestU8 = (offset: number, value: number) => (bytes: Buffer): void => { bytes.writeUInt8(value, offset); };
const dlmmRawTestU32 = (offset: number, value: number) => (bytes: Buffer): void => { bytes.writeUInt32LE(value, offset); };
const dlmmRawTestU64 = (offset: number, value: bigint) => (bytes: Buffer): void => { bytes.writeBigUInt64LE(value, offset); };

// ---- keys, PDAs and SDK decoding (independent of the adapter) ----

const dlmmRawTestKeyBytes = (address: string): Buffer => Buffer.from(new DlmmRawTestPublicKey(address).toBytes() as Uint8Array);
const dlmmRawTestAddress = (bytes: Uint8Array): string => (new DlmmRawTestPublicKey(bytes) as { toBase58(): string }).toBase58();
function dlmmRawTestPda(...seeds: Buffer[]): string {
  return (DlmmRawTestPublicKey.findProgramAddressSync(seeds, dlmmRawTestProgramKey)[0] as { toBase58(): string }).toBase58();
}
function dlmmRawTestI64(value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64LE(value);
  return bytes;
}
const dlmmRawTestArrayKey = (pool: string, index: bigint): string =>
  dlmmRawTestPda(Buffer.from('bin_array'), dlmmRawTestKeyBytes(pool), dlmmRawTestI64(index));
const dlmmRawTestExtensionKey = (pool: string): string => dlmmRawTestPda(Buffer.from('bitmap'), dlmmRawTestKeyBytes(pool));
const dlmmRawTestReserveKey = (pool: string, mint: string): string => dlmmRawTestPda(dlmmRawTestKeyBytes(pool), dlmmRawTestKeyBytes(mint));
const dlmmRawTestDecode = (name: 'lbPair' | 'binArray' | 'binArrayBitmapExtension', bytes: Buffer): any =>
  DlmmRawTestSdk.decodeAccount(dlmmRawTestProgram, name, bytes);
const dlmmRawTestQPrice = (id: bigint, binStep: bigint): bigint =>
  BigInt(DlmmRawTestSdk.getQPriceFromId(new DlmmRawTestBN(id.toString()), new DlmmRawTestBN(binStep.toString())).toString());
function dlmmRawTestFloorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
}
function dlmmRawTestDiscriminator(name: string): Buffer {
  const entry = (DlmmRawTestSdk.IDL.accounts as readonly { readonly name: string; readonly discriminator: readonly number[] }[]).find(
    (account) => account.name.replace(/_/g, '').toLowerCase() === name.toLowerCase(),
  );
  if (entry === undefined) return dlmmRawTestAssert.fail(`IDL lacks account ${name}`);
  return Buffer.from(entry.discriminator);
}

function dlmmRawTestPoolFacts(accounts: RawDlmmTestAccountMap, pool: string): RawDlmmTestPoolFacts {
  const bytes = dlmmRawTestData(dlmmRawTestAccount(accounts, pool));
  const pair = dlmmRawTestDecode('lbPair', bytes);
  const at = (offset: number): string => dlmmRawTestAddress(bytes.subarray(offset, offset + 32));
  return {
    pool,
    tokenX: at(88),
    tokenY: at(120),
    reserveX: at(152),
    reserveY: at(184),
    extension: dlmmRawTestExtensionKey(pool),
    activeId: BigInt(pair.activeId),
    binStep: BigInt(pair.binStep),
    pair,
  };
}

function dlmmRawTestBitPositions(words: readonly bigint[]): bigint[] {
  const out: bigint[] = [];
  words.forEach((word, i) => {
    for (let bit = 0n; bit < 64n; bit += 1n) if ((word >> bit) & 1n) out.push(BigInt(i) * 64n + bit);
  });
  return out;
}

// Pool bitmap bit b is array b-512; extension positive bit p is p+512, negative bit p is -p-513.
function dlmmRawTestFlaggedIndices(pair: any, extension: Buffer | null): bigint[] {
  const words = (pair.binArrayBitmap as readonly { toString(): string }[]).map((word) => BigInt(word.toString()));
  const indices = dlmmRawTestBitPositions(words).map((position) => position - 512n);
  if (extension !== null) {
    const rows = (offset: number): bigint[] => Array.from({ length: 96 }, (_, i) => extension.readBigUInt64LE(offset + i * 8));
    indices.push(...dlmmRawTestBitPositions(rows(40)).map((p) => p + 512n), ...dlmmRawTestBitPositions(rows(808)).map((p) => -p - 513n));
  }
  return indices;
}

function dlmmRawTestDirectionalIndices(facts: RawDlmmTestPoolFacts, accounts: RawDlmmTestAccountMap): bigint[] {
  const extension = accounts[facts.extension];
  const active = dlmmRawTestFloorDiv(facts.activeId, 70n);
  return [...new Set(dlmmRawTestFlaggedIndices(facts.pair, extension ? dlmmRawTestData(extension) : null))]
    .filter((index) => index <= active)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

function dlmmRawTestDirectionalOutput(accounts: RawDlmmTestAccountMap, facts: RawDlmmTestPoolFacts, indices: readonly bigint[], withOrders: boolean): bigint {
  const supportLimitOrder = withOrders && Boolean(DlmmRawTestSdk.isSupportLimitOrder(facts.pair));
  let total = 0n;
  for (const index of indices) {
    const decoded = dlmmRawTestDecode('binArray', dlmmRawTestData(dlmmRawTestAccount(accounts, dlmmRawTestArrayKey(facts.pool, index))));
    (decoded.bins as any[]).forEach((bin, offset) => {
      if (index * 70n + BigInt(offset) > facts.activeId) return;
      total += BigInt(bin.amountY.toString());
      if (supportLimitOrder && Number(bin.limitOrderAskSide) === 0) {
        total += BigInt(bin.openOrderAmount.toString()) + BigInt(bin.processedOrderRemainingAmount.toString());
      }
    });
  }
  return total;
}

let dlmmRawTestRoutesCache: readonly RawDlmmTestRoute[] | undefined;
function dlmmRawTestRoutes(): readonly RawDlmmTestRoute[] {
  dlmmRawTestRoutesCache ??= dlmmRawTestFixture.pools.map((pool) => {
    const accounts = dlmmRawTestFixture.accounts;
    const facts = dlmmRawTestPoolFacts(accounts, pool);
    const indices = dlmmRawTestDirectionalIndices(facts, accounts);
    const deepest = indices[indices.length - 1];
    return {
      facts,
      indices,
      arrays: dlmmRawTestSortedKeys(indices.map((index) => dlmmRawTestArrayKey(pool, index))),
      deepestArray: deepest === undefined ? null : dlmmRawTestArrayKey(pool, deepest),
      directionalOutput: dlmmRawTestDirectionalOutput(accounts, facts, indices, true),
      directionalPrincipal: dlmmRawTestDirectionalOutput(accounts, facts, indices, false),
    };
  });
  return dlmmRawTestRoutesCache;
}
function dlmmRawTestPositiveRoute(): RawDlmmTestRoute {
  return dlmmRawTestRoutes().find((route) => route.directionalOutput > 0n) ?? dlmmRawTestAssert.fail('fixture has no positive route');
}
function dlmmRawTestOtherPool(pool: string): string {
  return dlmmRawTestRoutes().find((route) => route.facts.pool !== pool)?.facts.pool ?? dlmmRawTestAssert.fail('fixture has one pool');
}

// ---- outcome assertions ----

function dlmmRawTestAdmits(net: bigint, input: bigint, num: bigint, den: bigint, impactBps: number): boolean {
  return net * den * 10_000n >= input * num * (10_000n - BigInt(impactBps));
}
const dlmmRawTestFeeSum = (quote: RawDlmmTestRouteQuote): bigint =>
  BigInt(quote.fees.tradingInputAtoms) + BigInt(quote.fees.tradingOutputAtoms);

function dlmmRawTestJsonOnly(value: unknown, path: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    dlmmRawTestAssert.ok(Number.isSafeInteger(value), `${path}: numbers must be safe integers; amounts belong in decimal strings`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item: unknown, i: number) => dlmmRawTestJsonOnly(item, `${path}[${i}]`));
    return;
  }
  dlmmRawTestAssert.ok(typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype, `${path}: plain JSON object`);
  for (const [key, item] of Object.entries(value as object)) dlmmRawTestJsonOnly(item, `${path}.${key}`);
}

function dlmmRawTestCheckPlan(label: string, plan: RawDlmmTestRoutePlan, facts: RawDlmmTestPoolFacts): void {
  dlmmRawTestAssert.equal(plan.venue, 'DLMM');
  dlmmRawTestAssert.equal(plan.programId, DLMM_RAW_TEST_PROGRAM_ID);
  dlmmRawTestAssert.equal(plan.pool, facts.pool);
  dlmmRawTestAssert.equal(plan.targetMint, DLMM_RAW_TEST_TARGET);
  const lists = [
    ['requiredKeys', plan.requiredKeys],
    ['additionalKeys', plan.additionalKeys],
    ['missingKeys', plan.missingKeys],
    ['nullKeys', plan.nullKeys],
    ['mutableKeys', plan.mutableKeys],
  ] as const;
  for (const [name, keys] of lists) dlmmRawTestAssert.deepEqual([...keys], dlmmRawTestSortedKeys(keys), `${label}: ${name} sorted and unique`);
  const planned = new Set([...plan.requiredKeys, ...plan.additionalKeys]);
  dlmmRawTestAssert.ok(plan.additionalKeys.every((key) => !plan.requiredKeys.includes(key)), `${label}: required/additional disjoint`);
  for (const [name, keys] of lists.slice(2)) dlmmRawTestAssert.ok(keys.every((key) => planned.has(key)), `${label}: ${name} subset of planned keys`);
  dlmmRawTestAssert.ok(plan.missingKeys.every((key) => !plan.nullKeys.includes(key)), `${label}: missing/null disjoint`);
  dlmmRawTestAssert.ok(!planned.has(DLMM_RAW_TEST_CLOCK_KEY), `${label}: Clock is excluded from the plan`);
  dlmmRawTestAssert.ok(plan.requiredKeys.includes(facts.pool) && plan.mutableKeys.includes(facts.pool), `${label}: pool planned and mutable`);
  if (plan.route === null) return;
  for (const key of [facts.tokenX, facts.tokenY, facts.reserveX, facts.reserveY, facts.extension]) {
    dlmmRawTestAssert.ok(plan.requiredKeys.includes(key), `${label}: static key ${key} required`);
  }
  for (const key of [facts.reserveX, facts.reserveY, ...plan.additionalKeys]) {
    dlmmRawTestAssert.ok(plan.mutableKeys.includes(key), `${label}: ${key} is raw-state mutable`);
  }
  dlmmRawTestAssert.ok(!plan.mutableKeys.includes(facts.tokenX) && !plan.mutableKeys.includes(facts.tokenY), `${label}: shared mints are not mutable`);
}

function dlmmRawTestRouteMeta(facts: RawDlmmTestPoolFacts, accounts: RawDlmmTestAccountMap, programsRead: boolean): unknown {
  return {
    outputMint: facts.tokenY,
    direction: 'FIRST_TO_SECOND',
    vaults: { input: facts.reserveX, output: facts.reserveY },
    tokenPrograms: programsRead
      ? { input: dlmmRawTestAccount(accounts, facts.tokenX).owner, output: dlmmRawTestAccount(accounts, facts.tokenY).owner }
      : null,
  };
}

function dlmmRawTestKnownOf(label: string, solve: RawDlmmTestRouteSolve): RawDlmmTestKnown {
  const outcome = solve.outcome;
  if (outcome.status !== 'KNOWN') return dlmmRawTestAssert.fail(`${label}: expected KNOWN, got ${outcome.status} ${outcome.reasons.join(',')}`);
  return outcome;
}

function dlmmRawTestCheckCertificate(label: string, pool: string, bank: RawDlmmTestBank, outcome: RawDlmmTestKnown, impactBps: number): void {
  const { certificate } = outcome;
  const num = BigInt(outcome.facts.p0.num);
  const den = BigInt(outcome.facts.p0.den);
  const quote = (x: string): RawDlmmTestRouteQuote => dlmmRawTestQuoteAt(pool, bank, x);
  const admits = (q: RawDlmmTestRouteQuote): boolean => q.complete && dlmmRawTestAdmits(BigInt(q.netAtoms), BigInt(q.inputAtoms), num, den, impactBps);
  dlmmRawTestAssert.match(certificate.kind, /^DLMM_[A-Z0-9_]+$/);
  dlmmRawTestAssert.equal(certificate.maximal, true, `${label}: KNOWN requires a maximal certificate`);
  dlmmRawTestJsonOnly(certificate.diagnostics, `${label}.diagnostics`);
  dlmmRawTestAssert.deepEqual(JSON.parse(JSON.stringify(certificate.diagnostics)), certificate.diagnostics, `${label}: diagnostics are JSON-only`);
  dlmmRawTestAssert.ok(
    certificate.witnesses.some((w) => w.role === 'CHOSEN' && w.inputAtoms === outcome.inputAtoms && w.netAtoms === outcome.netAtoms && w.complete && w.admissible),
    `${label}: every chosen point, including zero, carries a CHOSEN witness`,
  );
  const chosen = quote(outcome.inputAtoms);
  dlmmRawTestAssert.deepEqual(
    [chosen.inputAtoms, chosen.consumedAtoms, chosen.netAtoms, chosen.complete, admits(chosen)],
    [outcome.inputAtoms, outcome.inputAtoms, outcome.netAtoms, true, true],
    `${label}: chosen requote`,
  );
  for (const w of certificate.witnesses) {
    dlmmRawTestAssert.match(w.inputAtoms, DLMM_RAW_TEST_ATOMIC);
    dlmmRawTestAssert.match(w.netAtoms, DLMM_RAW_TEST_ATOMIC);
    const q = quote(w.inputAtoms);
    dlmmRawTestAssert.deepEqual([q.inputAtoms, q.netAtoms, q.complete, admits(q)], [w.inputAtoms, w.netAtoms, w.complete, w.admissible], `${label}: witness ${w.role}@${w.inputAtoms}`);
    dlmmRawTestAssert.ok(BigInt(q.consumedAtoms) <= BigInt(q.inputAtoms) && q.complete === (q.consumedAtoms === q.inputAtoms), `${label}: witness consumption`);
    if (w.admissible) {
      const net = BigInt(w.netAtoms);
      const best = BigInt(outcome.netAtoms);
      dlmmRawTestAssert.ok(net < best || (net === best && BigInt(w.inputAtoms) >= BigInt(outcome.inputAtoms)), `${label}: witness ${w.role} beats the chosen point`);
    }
  }
  const max = outcome.maxAdmissibleInputAtoms;
  if (max !== null) {
    dlmmRawTestAssert.ok(admits(quote(max)) && BigInt(max) >= BigInt(outcome.inputAtoms), `${label}: maxAdmissible is admissible and not below chosen`);
    for (const w of certificate.witnesses) if (w.role === 'MAX_ADMISSIBLE') dlmmRawTestAssert.equal(w.inputAtoms, max);
  }
  const end = certificate.domainEndAtoms;
  if (end !== null) {
    dlmmRawTestAssert.equal(quote(end).complete, true, `${label}: domain end is fully consumable`);
    if (BigInt(end) < DLMM_RAW_TEST_U64_MAX) dlmmRawTestAssert.equal(quote((BigInt(end) + 1n).toString()).complete, false, `${label}: domain end + 1 is partial`);
  }
  // Public zero is the canonical zero quote once the bank is admitted.
  dlmmRawTestAssert.deepEqual(quote('0'), DLMM_RAW_TEST_ZERO_QUOTE, `${label}: quote(0)`);
  if (outcome.zero !== null) dlmmRawTestAssert.deepEqual([outcome.netAtoms, outcome.inputAtoms], ['0', '0'], `${label}: zero outcome`);
  else dlmmRawTestAssert.ok(BigInt(outcome.netAtoms) > 0n, `${label}: non-zero outcome has positive net`);
}

function dlmmRawTestCheckKnown(
  label: string,
  facts: RawDlmmTestPoolFacts,
  bank: RawDlmmTestBank,
  solve: RawDlmmTestRouteSolve,
  impactBps: number = DLMM_RAW_TEST_IMPACT_BPS,
): RawDlmmTestKnown {
  dlmmRawTestAssert.equal(solve.adapterVersion, dlmmRawTestAdapterVersion);
  dlmmRawTestAssert.equal(dlmmRawTestAdapterVersion, 'execliq-dlmm-sdk-1.9.14-v1');
  dlmmRawTestAssert.deepEqual([solve.bankSlot, solve.clock, solve.impactBps], [bank.slot, bank.clock, impactBps], `${label}: solve echoes the bank`);
  dlmmRawTestAssert.deepEqual(solve.plan, dlmmRawTestPlanAt(facts.pool, bank.accounts), `${label}: plan recomputed from bank.accounts alone`);
  dlmmRawTestCheckPlan(label, solve.plan, facts);
  dlmmRawTestAssert.deepEqual([solve.plan.rejected, solve.plan.open, solve.plan.missingKeys], [null, false, []], `${label}: closed admitted plan`);
  dlmmRawTestAssert.deepEqual(solve.plan.route, dlmmRawTestRouteMeta(facts, bank.accounts, true), `${label}: route meta`);
  const outcome = dlmmRawTestKnownOf(label, solve);
  const vault = (address: string, mint: string): unknown => ({
    address,
    mint,
    tokenProgram: dlmmRawTestAccount(bank.accounts, mint).owner,
    amountAtoms: dlmmRawTestData(dlmmRawTestAccount(bank.accounts, address)).readBigUInt64LE(64).toString(),
  });
  dlmmRawTestAssert.deepEqual(outcome.facts.vaults, { input: vault(facts.reserveX, facts.tokenX), output: vault(facts.reserveY, facts.tokenY) }, `${label}: vault facts are token amounts`);
  dlmmRawTestAssert.deepEqual(
    outcome.facts.decimals,
    {
      input: dlmmRawTestData(dlmmRawTestAccount(bank.accounts, facts.tokenX)).readUInt8(44),
      output: dlmmRawTestData(dlmmRawTestAccount(bank.accounts, facts.tokenY)).readUInt8(44),
    },
    `${label}: decimals`,
  );
  const den = BigInt(outcome.facts.p0.den);
  dlmmRawTestAssert.ok(den > 0n, `${label}: p0 denominator positive`);
  dlmmRawTestAssert.equal(BigInt(outcome.facts.p0.num) * DLMM_RAW_TEST_Q64, dlmmRawTestQPrice(facts.activeId, facts.binStep) * den, `${label}: p0 is the activeId Q64.64 price`);
  for (const atoms of [outcome.netAtoms, outcome.inputAtoms]) dlmmRawTestAssert.match(atoms, DLMM_RAW_TEST_ATOMIC);
  dlmmRawTestCheckCertificate(label, facts.pool, bank, outcome, impactBps);
  return outcome;
}

function dlmmRawTestQuoteRefuses(label: string, pool: string, bank: RawDlmmTestBank, inputAtoms: string, reasons: readonly string[], target: string): void {
  let quote: RawDlmmTestRouteQuote | undefined;
  let text = '';
  try {
    quote = dlmmRawTestQuoteAt(pool, bank, inputAtoms, target);
  } catch (error) {
    const e = error as { readonly code?: unknown; readonly message?: unknown };
    text = `${String(e.code ?? '')} ${String(e.message ?? '')}`;
  }
  dlmmRawTestAssert.equal(quote, undefined, `${label}: quote(${inputAtoms}) fabricated ${JSON.stringify(quote)}`);
  dlmmRawTestAssert.ok(reasons.some((reason) => text.includes(reason)), `${label}: quote(${inputAtoms}) error '${text}' must carry a solve reason (${reasons.join(',')})`);
}

function dlmmRawTestExpectNotKnown(
  label: string,
  pool: string,
  bank: RawDlmmTestBank,
  quoteInputs: readonly string[] = ['0', DLMM_RAW_TEST_BIG_INPUT],
  target: string = DLMM_RAW_TEST_TARGET,
): readonly string[] {
  let solve: RawDlmmTestRouteSolve;
  try {
    solve = dlmmRawTestSolveAt(pool, bank, DLMM_RAW_TEST_IMPACT_BPS, target);
  } catch (error) {
    return dlmmRawTestAssert.fail(`${label}: solve threw for a valid caller: ${String(error)}`);
  }
  const outcome = solve.outcome;
  if (outcome.status === 'KNOWN') return dlmmRawTestAssert.fail(`${label}: became KNOWN net=${outcome.netAtoms} zero=${String(outcome.zero)}`);
  dlmmRawTestAssert.ok(outcome.reasons.length > 0 && outcome.reasons.every((reason) => /^[A-Z][A-Z0-9_]*$/.test(reason)), `${label}: meaningful reasons`);
  for (const input of quoteInputs) dlmmRawTestQuoteRefuses(label, pool, bank, input, outcome.reasons, target);
  return outcome.reasons;
}

function dlmmRawTestPlanNoThrow(label: string, pool: string, accounts: RawDlmmTestAccountMap): RawDlmmTestRoutePlan {
  try {
    return dlmmRawTestPlanAt(pool, accounts);
  } catch (error) {
    return dlmmRawTestAssert.fail(`${label}: plan threw for a valid caller: ${String(error)}`);
  }
}

function dlmmRawTestSdkVersion(): string {
  for (let dir = new URL('./', dlmmRawTestPathToFileURL(dlmmRawTestSdkPath)); dir.pathname !== '/'; dir = new URL('../', dir)) {
    try {
      const pkg = JSON.parse(dlmmRawTestReadFileSync(new URL('package.json', dir), 'utf8')) as { readonly name?: string; readonly version?: string };
      if (pkg.name === '@meteora-ag/dlmm') return String(pkg.version);
    } catch {
      continue;
    }
  }
  return dlmmRawTestAssert.fail('published @meteora-ag/dlmm package.json not found');
}

// ---- SDK coder edits of LbPair (904 bytes fits the coder buffer) ----

function dlmmRawTestSet(holder: any, field: string, value: bigint): void {
  dlmmRawTestAssert.ok(holder !== null && typeof holder === 'object' && field in holder, `decoded SDK account lacks ${field}`);
  holder[field] = typeof holder[field] === 'number' ? Number(value) : new DlmmRawTestBN(value.toString());
}
function dlmmRawTestHolder(pair: any, field: string): any {
  for (const candidate of [pair.parameters, pair]) if (candidate !== null && typeof candidate === 'object' && field in candidate) return candidate;
  return dlmmRawTestAssert.fail(`SDK 1.9.14 decoded LbPair exposes no ${field}`);
}
async function dlmmRawTestEncodePool(pair: any, original: Buffer): Promise<Buffer> {
  const encoded = Buffer.from((await dlmmRawTestProgram.coder.accounts.encode('lbPair', pair)) as Uint8Array);
  dlmmRawTestAssert.equal(encoded.length, original.length, 'encoded LbPair length');
  dlmmRawTestAssert.deepEqual(encoded.subarray(0, 8), original.subarray(0, 8), 'encoded LbPair discriminator');
  return encoded;
}
async function dlmmRawTestEditPool(accounts: RawDlmmTestAccountMap, pool: string, change: (pair: any) => void): Promise<RawDlmmTestAccountMap> {
  const body = dlmmRawTestAccount(accounts, pool);
  const bytes = dlmmRawTestData(body);
  const pair = dlmmRawTestDecode('lbPair', bytes);
  change(pair);
  return { ...accounts, [pool]: dlmmRawTestWithData(body, await dlmmRawTestEncodePool(pair, bytes)) };
}

// ---- Token-2022 TLV helpers ----

function dlmmRawTestTlv(type: number, value: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(type, 0);
  header.writeUInt16LE(value.length, 2);
  return Buffer.concat([header, value]);
}
function dlmmRawTestInsertTlv(bytes: Buffer, entry: Buffer): Buffer {
  dlmmRawTestAssert.ok(bytes.length >= 166 && bytes.readUInt8(165) === 1, 'Token-2022 mint with account type');
  let at = 166;
  while (at < bytes.length && bytes.subarray(at).some((byte) => byte !== 0)) at += 4 + bytes.readUInt16LE(at + 2);
  return Buffer.concat([bytes.subarray(0, at), entry, bytes.subarray(at)]);
}
function dlmmRawTestZeroTransferTax(body: RawDlmmTestRpcAccount): boolean {
  const bytes = dlmmRawTestData(body);
  if (body.owner !== DLMM_RAW_TEST_TOKEN_2022_PROGRAM || bytes.length <= 166) return true;
  for (let at = 166; at + 4 <= bytes.length && bytes.subarray(at).some((byte) => byte !== 0);) {
    const type = bytes.readUInt16LE(at);
    const length = bytes.readUInt16LE(at + 2);
    if (type === 1 && (bytes.readUInt16LE(at + 4 + 88) !== 0 || bytes.readUInt16LE(at + 4 + 106) !== 0)) return false;
    at += 4 + length;
  }
  return true;
}

// ---- isolated frozen-clock SDK child ----

const DLMM_RAW_TEST_SDK_CHILD = String.raw`
'use strict';
const { createRequire } = require('node:module');
const { readFileSync } = require('node:fs');
const input = JSON.parse(readFileSync(0, 'utf8'));
const sdkRequire = createRequire(input.sdkPath);
const SDK = sdkRequire(input.sdkPath);
const { PublicKey } = sdkRequire('@solana/web3.js');
const { unpackMint, unpackAccount } = sdkRequire('@solana/spl-token');
const BN = sdkRequire('bn.js');
let networkCalls = 0;
const connection = new Proxy({}, { get(_target, key) { if (key === 'commitment') return 'finalized'; networkCalls += 1; throw new Error('NO_NETWORK:' + String(key)); } });
const program = SDK.createProgram(connection);
const info = (key) => { const a = input.accounts[key]; return a == null ? null : { ...a, owner: new PublicKey(a.owner), data: Buffer.from(a.data[0], 'base64') }; };
const clock = SDK.ClockLayout.decode(info(input.clockKey).data);
const frozenMs = clock.unixTimestamp.toNumber() * 1000;
Date.now = () => frozenMs;
const rows = input.routes.map((route) => {
  const pubkey = new PublicKey(route.pool);
  const pair = SDK.decodeAccount(program, 'lbPair', info(route.pool).data);
  const reserve = (mintKey, reserveKey) => {
    const mintInfo = info(mintKey.toBase58());
    const reserveInfo = info(reserveKey.toBase58());
    return { publicKey: mintKey, reserve: reserveKey, mint: unpackMint(mintKey, mintInfo, mintInfo.owner), amount: unpackAccount(reserveKey, reserveInfo, reserveInfo.owner).amount, owner: mintInfo.owner, transferHookAccountMetas: [] };
  };
  const [extKey] = SDK.deriveBinArrayBitmapExtension(pubkey, program.programId);
  const extInfo = info(extKey.toBase58());
  const extension = extInfo ? { publicKey: extKey, account: SDK.decodeAccount(program, 'binArrayBitmapExtension', extInfo.data) } : null;
  const arrays = Object.keys(input.accounts)
    .filter((key) => { const a = input.accounts[key]; return a != null && a.owner === program.programId.toBase58() && Buffer.from(a.data[0], 'base64').length === 10136; })
    .map((key) => ({ publicKey: new PublicKey(key), account: SDK.decodeAccount(program, 'binArray', info(key).data) }))
    .filter((a) => a.account.lbPair.equals(pubkey));
  const dlmm = new SDK(pubkey, program, pair, extension, reserve(pair.tokenXMint, pair.reserveX), reserve(pair.tokenYMint, pair.reserveY), [], clock);
  const points = route.points.map((x) => {
    try {
      const q = dlmm.swapQuote(new BN(x), true, new BN(0), arrays, true);
      return { input: x, consumed: q.consumedInAmount.toString(), net: q.outAmount.toString(), fee: q.fee.toString(), protocol: q.protocolFee.toString() };
    } catch (error) {
      return { input: x, error: { name: String(error && error.name), code: String(error && (error.code ?? error.errorCode ?? '')), message: String(error && error.message) } };
    }
  });
  return { pool: route.pool, points };
});
process.stdout.write(JSON.stringify({ frozenMs, dateNowFrozen: Date.now() === frozenMs, networkCalls, rows }));
`;

interface RawDlmmTestSdkPoint {
  readonly input: string;
  readonly consumed?: string;
  readonly net?: string;
  readonly fee?: string;
  readonly protocol?: string;
  readonly error?: { readonly name: string; readonly code: string; readonly message: string };
}
interface RawDlmmTestSdkRun {
  readonly frozenMs: number;
  readonly dateNowFrozen: boolean;
  readonly networkCalls: number;
  readonly rows: readonly { readonly pool: string; readonly points: readonly RawDlmmTestSdkPoint[] }[];
}

function dlmmRawTestRunSdk(accounts: RawDlmmTestAccountMap, routes: readonly { readonly pool: string; readonly points: readonly string[] }[]): RawDlmmTestSdkRun {
  const child = dlmmRawTestSpawnSync(process.execPath, ['-e', DLMM_RAW_TEST_SDK_CHILD], {
    input: JSON.stringify({ sdkPath: dlmmRawTestSdkPath, clockKey: DLMM_RAW_TEST_CLOCK_KEY, accounts, routes }),
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 1 << 28,
  });
  dlmmRawTestAssert.equal(child.error, undefined, `SDK child failed to start: ${String(child.error)}`);
  dlmmRawTestAssert.equal(child.status, 0, `SDK child exited ${String(child.status)}: ${child.stderr}`);
  dlmmRawTestAssert.equal(Date.now, dlmmRawTestOriginalDateNow, 'parent Date.now is never overridden');
  const run = JSON.parse(child.stdout) as RawDlmmTestSdkRun;
  dlmmRawTestAssert.deepEqual([run.networkCalls, run.dateNowFrozen, run.frozenMs], [0, true, dlmmRawTestClock().unixTimestamp * 1000], 'offline child with Date frozen to the bank Clock');
  dlmmRawTestAssert.deepEqual(run.rows.map((row) => row.pool), routes.map((route) => route.pool));
  return run;
}

function dlmmRawTestSdkPoints(outcome: RawDlmmTestKnown, extra: readonly bigint[] = []): string[] {
  const seeds: bigint[] = [...DLMM_RAW_TEST_GRID.map((x) => BigInt(x)), ...extra];
  const certificate = outcome.certificate;
  for (const value of [outcome.inputAtoms, outcome.maxAdmissibleInputAtoms, certificate.domainEndAtoms, ...certificate.witnesses.map((w) => w.inputAtoms)]) {
    if (value !== null) seeds.push(BigInt(value), BigInt(value) + 1n);
  }
  return [...new Set(seeds.filter((x) => x > 0n && x <= DLMM_RAW_TEST_U64_MAX))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(String);
}

function dlmmRawTestCompareSdk(label: string, pool: string, bank: RawDlmmTestBank, point: RawDlmmTestSdkPoint, positive: boolean): RawDlmmTestRouteQuote {
  const quote = dlmmRawTestQuoteAt(pool, bank, point.input);
  const at = `${label}@${point.input}`;
  if (point.error !== undefined) {
    dlmmRawTestAssert.equal(positive, false, `${at}: SDK error on a positive route ${JSON.stringify(point.error)}`);
    dlmmRawTestAssert.ok(
      /INSUFFICIENT_LIQUIDITY/.test(`${point.error.name} ${point.error.code}`) || /insufficient liquidity/i.test(point.error.message),
      `${at}: empty SDK side reports insufficient liquidity, got ${JSON.stringify(point.error)}`,
    );
    dlmmRawTestAssert.deepEqual([quote.consumedAtoms, quote.netAtoms, quote.complete], ['0', '0', false], `${at}: adapter empty side is an exact partial zero`);
    return quote;
  }
  dlmmRawTestAssert.equal(positive, true, `${at}: SDK quoted an independently empty side`);
  const { consumed, net, fee, protocol } = point;
  if (consumed === undefined || net === undefined || fee === undefined || protocol === undefined) return dlmmRawTestAssert.fail(`${at}: incomplete SDK row`);
  dlmmRawTestAssert.deepEqual(
    [quote.inputAtoms, quote.consumedAtoms, quote.netAtoms, quote.complete, dlmmRawTestFeeSum(quote)],
    [point.input, consumed, net, consumed === point.input, BigInt(fee) + BigInt(protocol)],
    `${at}: adapter vs SDK consumed/net/complete/LP+protocol fee`,
  );
  return quote;
}

// ---- declared synthetic extension-crossing bank ----

const DLMM_RAW_TEST_SYNTHETIC = {
  activeId: -35840n,
  binStep: 1n,
  parameters: { baseFactor: 5000n, baseFeePowerFactor: 1n, variableFeeControl: 0n, filterPeriod: 30n, decayPeriod: 600n, reductionFactor: 5000n },
  lastUpdateLagSeconds: 10n,
  protocolFee: { amountX: 2n, amountY: 5n },
  // Active bin -35840 lives in default-bitmap array -512 (pool bit 0); the next non-empty bin -35841 lives in array -513,
  // reachable only through the extension (negative row 0 bit 0).
  arrays: [-512n, -513n],
  bins: [
    { id: -35840n, amountY: 50n, processedOrderRemainingAmount: 3n, openOrderAmount: 4n },
    { id: -35841n, amountY: 40n, processedOrderRemainingAmount: 0n, openOrderAmount: 0n },
  ],
  cap: 4096n,
} as const;

interface RawDlmmTestSynthetic {
  readonly facts: RawDlmmTestPoolFacts;
  readonly accounts: RawDlmmTestAccountMap;
  readonly arrayKeys: readonly string[];
  readonly feeOnInput: boolean;
  readonly oracle: DlmmOraclePool;
  readonly benchmark: DlmmOracleBenchmark;
}

function dlmmRawTestSetBit(bytes: Buffer, offset: number, position: bigint): void {
  const at = offset + Number(position / 64n) * 8;
  bytes.writeBigUInt64LE(bytes.readBigUInt64LE(at) | (1n << (position % 64n)), at);
}

function dlmmRawTestExtensionBody(pool: string, indices: readonly bigint[]): Buffer {
  const bytes = Buffer.alloc(1576);
  dlmmRawTestDiscriminator('BinArrayBitmapExtension').copy(bytes, 0);
  dlmmRawTestKeyBytes(pool).copy(bytes, 8);
  for (const index of indices) {
    if (index >= 512n) dlmmRawTestSetBit(bytes, 40, index - 512n);
    else if (index < -512n) dlmmRawTestSetBit(bytes, 808, -index - 513n);
    else dlmmRawTestAssert.fail(`array ${index} belongs to the pool default bitmap`);
  }
  return bytes;
}

// Cloned genuine v2 BinArray header; all 70 bins zeroed, canonical SDK prices, declared liquidity only.
function dlmmRawTestArrayBody(template: Buffer, pool: string, index: bigint): Buffer {
  const S = DLMM_RAW_TEST_SYNTHETIC;
  const bytes = Buffer.from(template);
  bytes.fill(0, 56);
  bytes.writeBigInt64LE(index, 8);
  dlmmRawTestKeyBytes(pool).copy(bytes, 24);
  for (let offset = 0; offset < 70; offset += 1) {
    const at = 56 + offset * 144;
    const price = dlmmRawTestQPrice(index * 70n + BigInt(offset), S.binStep);
    bytes.writeBigUInt64LE(price & DLMM_RAW_TEST_U64_MAX, at + 16);
    bytes.writeBigUInt64LE(price >> 64n, at + 24);
  }
  for (const bin of S.bins) {
    if (dlmmRawTestFloorDiv(bin.id, 70n) !== index) continue;
    const at = 56 + Number(bin.id - index * 70n) * 144;
    bytes.writeBigUInt64LE(bin.amountY, at + 8);
    bytes.writeBigUInt64LE(bin.openOrderAmount, at + 112);
    bytes.writeBigUInt64LE(bin.processedOrderRemainingAmount, at + 128);
    bytes.writeUInt8(0, at + 140); // bid side serves X->Y
  }
  return bytes;
}

function dlmmRawTestVaultWithAmount(accounts: RawDlmmTestAccountMap, key: string, amount: bigint): RawDlmmTestRpcAccount {
  const body = dlmmRawTestAccount(accounts, key);
  const bytes = Buffer.from(dlmmRawTestData(body));
  bytes.writeBigUInt64LE(amount, 64);
  const native = bytes.readUInt32LE(109) === 1;
  return dlmmRawTestWithData(body, bytes, native ? { lamports: Number(amount + bytes.readBigUInt64LE(113)) } : {});
}

async function dlmmRawTestSyntheticWorld(): Promise<RawDlmmTestSynthetic> {
  const S = DLMM_RAW_TEST_SYNTHETIC;
  const base = dlmmRawTestFixture.accounts;
  const template = [...dlmmRawTestRoutes()]
    .filter((route) => route.directionalOutput > 0n)
    .sort((a, b) => Number(b.facts.tokenY === DLMM_RAW_TEST_WSOL) - Number(a.facts.tokenY === DLMM_RAW_TEST_WSOL))[0];
  if (template === undefined) return dlmmRawTestAssert.fail('no positive template route');
  const t = template.facts;
  const clock = dlmmRawTestClock();
  const poolBody = dlmmRawTestAccount(base, t.pool);
  const poolBytes = dlmmRawTestData(poolBody);
  dlmmRawTestAssert.deepEqual(poolBytes.subarray(0, 8), dlmmRawTestDiscriminator('LbPair'), 'IDL LbPair discriminator matches genuine bytes');
  const pair = dlmmRawTestDecode('lbPair', poolBytes);
  dlmmRawTestSet(pair, 'activeId', S.activeId);
  dlmmRawTestSet(pair, 'binStep', S.binStep);
  pair.binStepSeed = [Number(S.binStep & 0xffn), Number(S.binStep >> 8n)];
  for (const [field, value] of Object.entries(S.parameters)) dlmmRawTestSet(pair.parameters, field, value);
  if ('minBinId' in pair.parameters) dlmmRawTestSet(pair.parameters, 'minBinId', -443636n);
  if ('maxBinId' in pair.parameters) dlmmRawTestSet(pair.parameters, 'maxBinId', 443636n);
  const lastUpdate = BigInt(clock.unixTimestamp) - S.lastUpdateLagSeconds;
  dlmmRawTestSet(pair.vParameters, 'volatilityAccumulator', 0n);
  dlmmRawTestSet(pair.vParameters, 'volatilityReference', 0n);
  dlmmRawTestSet(pair.vParameters, 'indexReference', S.activeId);
  dlmmRawTestSet(pair.vParameters, 'lastUpdateTimestamp', lastUpdate);
  dlmmRawTestSet(pair.protocolFee, 'amountX', S.protocolFee.amountX);
  dlmmRawTestSet(pair.protocolFee, 'amountY', S.protocolFee.amountY);
  const words: bigint[] = Array.from({ length: 16 }, () => 0n);
  for (const index of S.arrays) {
    if (index < -512n || index >= 512n) continue;
    const position = index + 512n;
    const word = Number(position / 64n);
    words[word] = (words[word] ?? 0n) | (1n << (position % 64n));
  }
  pair.binArrayBitmap = words.map((word) => new DlmmRawTestBN(word.toString()));
  const encodedPool = await dlmmRawTestEncodePool(pair, poolBytes);
  const synthetic = dlmmRawTestDecode('lbPair', encodedPool);
  dlmmRawTestAssert.deepEqual([Number(synthetic.activeId), Number(synthetic.binStep)], [Number(S.activeId), Number(S.binStep)]);
  const accounts: Record<string, RawDlmmTestRpcAccount | null> = {
    [t.pool]: dlmmRawTestWithData(poolBody, encodedPool),
    [t.tokenX]: dlmmRawTestAccount(base, t.tokenX),
    [t.tokenY]: dlmmRawTestAccount(base, t.tokenY),
    [DLMM_RAW_TEST_CLOCK_KEY]: dlmmRawTestAccount(base, DLMM_RAW_TEST_CLOCK_KEY),
  };
  const facts = dlmmRawTestPoolFacts(accounts, t.pool);
  const templateArrayKey = template.arrays[0] ?? dlmmRawTestAssert.fail('template has no arrays');
  const templateArray = dlmmRawTestAccount(base, templateArrayKey);
  dlmmRawTestAssert.deepEqual(dlmmRawTestData(templateArray).subarray(0, 8), dlmmRawTestDiscriminator('BinArray'), 'IDL BinArray discriminator matches genuine bytes');
  const arrayKeys: string[] = [];
  for (const index of S.arrays) {
    const key = dlmmRawTestArrayKey(t.pool, index);
    const bytes = dlmmRawTestArrayBody(dlmmRawTestData(templateArray), t.pool, index);
    const decoded = dlmmRawTestDecode('binArray', bytes);
    dlmmRawTestAssert.deepEqual([BigInt(decoded.index.toString()), decoded.lbPair.toBase58(), Number(decoded.version)], [index, t.pool, 2]);
    (decoded.bins as any[]).forEach((bin, offset) => {
      const id = index * 70n + BigInt(offset);
      const declared = S.bins.find((item) => item.id === id);
      dlmmRawTestAssert.equal(BigInt(bin.price.toString()), dlmmRawTestQPrice(id, S.binStep), `bin ${id} canonical price`);
      dlmmRawTestAssert.deepEqual(
        [bin.amountX, bin.amountY, bin.openOrderAmount, bin.processedOrderRemainingAmount].map((v: { toString(): string }) => BigInt(v.toString())),
        [0n, declared?.amountY ?? 0n, declared?.openOrderAmount ?? 0n, declared?.processedOrderRemainingAmount ?? 0n],
        `bin ${id} declared amounts (all unused bins zero)`,
      );
    });
    arrayKeys.push(key);
    accounts[key] = dlmmRawTestWithData(templateArray, bytes);
  }
  const extensionBytes = dlmmRawTestExtensionBody(t.pool, S.arrays.filter((index) => index < -512n || index >= 512n));
  const extension = dlmmRawTestDecode('binArrayBitmapExtension', extensionBytes);
  dlmmRawTestAssert.equal(extension.lbPair.toBase58(), t.pool);
  dlmmRawTestAssert.equal(BigInt(extension.negativeBinArrayBitmap[0][0].toString()), 1n, 'negative extension row 0 bit 0');
  accounts[facts.extension] = dlmmRawTestWithData(poolBody, extensionBytes, { lamports: 12_000_000 });
  const backingY = S.bins.reduce<bigint>((sum, bin) => sum + bin.amountY + bin.processedOrderRemainingAmount + bin.openOrderAmount, 0n) + S.protocolFee.amountY;
  accounts[t.reserveX] = dlmmRawTestVaultWithAmount(base, t.reserveX, S.protocolFee.amountX);
  accounts[t.reserveY] = dlmmRawTestVaultWithAmount(base, t.reserveY, backingY);
  for (const mint of [t.tokenX, t.tokenY]) dlmmRawTestAssert.ok(dlmmRawTestZeroTransferTax(dlmmRawTestAccount(base, mint)), `oracle precondition: ${mint} zero transfer tax`);
  const feeOnInput = Boolean(DlmmRawTestSdk.getFeeMode(synthetic, true).feeOnInput);
  const oracle = dlmmOracleParsePool({
    binStep: S.binStep.toString(),
    activeId: S.activeId.toString(),
    swapForY: true,
    collectFeeMode: feeOnInput ? 'InputOnly' : 'OnlyY',
    supportLimitOrder: Boolean(DlmmRawTestSdk.isSupportLimitOrder(synthetic)),
    currentTimestamp: String(clock.unixTimestamp),
    sParameters: {
      baseFactor: S.parameters.baseFactor.toString(),
      baseFeePowerFactor: S.parameters.baseFeePowerFactor.toString(),
      variableFeeControl: S.parameters.variableFeeControl.toString(),
      maxVolatilityAccumulator: String(synthetic.parameters.maxVolatilityAccumulator),
      filterPeriod: S.parameters.filterPeriod.toString(),
      decayPeriod: S.parameters.decayPeriod.toString(),
      reductionFactor: S.parameters.reductionFactor.toString(),
    },
    vParameters: { volatilityAccumulator: '0', volatilityReference: '0', indexReference: S.activeId.toString(), lastUpdateTimestamp: lastUpdate.toString() },
    bins: S.bins.map((bin) => ({
      id: bin.id.toString(),
      priceQ64: dlmmRawTestQPrice(bin.id, S.binStep).toString(),
      amountX: '0',
      amountY: bin.amountY.toString(),
      limitOrderAskSide: false,
      openOrderAmount: bin.openOrderAmount.toString(),
      processedOrderRemainingAmount: bin.processedOrderRemainingAmount.toString(),
    })),
    zeroTransferTaxAdmitted: true,
  });
  const benchmark: DlmmOracleBenchmark = { num: dlmmRawTestQPrice(S.activeId, S.binStep), den: DLMM_RAW_TEST_Q64, impactBps: BigInt(DLMM_RAW_TEST_IMPACT_BPS) };
  return { facts, accounts, arrayKeys, feeOnInput, oracle, benchmark };
}

let dlmmRawTestSyntheticCache: Promise<RawDlmmTestSynthetic> | undefined;
const dlmmRawTestSynthetic = (): Promise<RawDlmmTestSynthetic> => (dlmmRawTestSyntheticCache ??= dlmmRawTestSyntheticWorld());

// ===== tests =====

dlmmRawTestCase('dlmm raw: exact SDK root, retained fixture, PDAs and raw Clock agree independently', () => {
  dlmmRawTestAssert.equal(typeof DlmmRawTestSdk, 'function', 'CJS root is the DLMM constructor');
  dlmmRawTestAssert.equal(dlmmRawTestSdkVersion(), '1.9.14');
  dlmmRawTestAssert.equal(dlmmRawTestProgram.programId.toBase58(), DLMM_RAW_TEST_PROGRAM_ID);
  dlmmRawTestAssert.equal(dlmmRawTestFixture.pools.length, 7, 'retained fixture cardinality');
  dlmmRawTestAssert.equal(Object.keys(dlmmRawTestFixture.accounts).length, 52, 'retained fixture cardinality');
  const clock = dlmmRawTestClock();
  const raw = dlmmRawTestData(dlmmRawTestAccount(dlmmRawTestFixture.accounts, DLMM_RAW_TEST_CLOCK_KEY));
  dlmmRawTestAssert.deepEqual(
    [raw.length, raw.readBigUInt64LE(0), raw.readBigInt64LE(8), raw.readBigUInt64LE(16), raw.readBigUInt64LE(24), raw.readBigInt64LE(32)],
    [40, BigInt(clock.slot), BigInt(clock.epochStartTimestamp), BigInt(clock.epoch), BigInt(clock.leaderScheduleEpoch), BigInt(clock.unixTimestamp)],
  );
  dlmmRawTestAssert.equal(dlmmRawTestFixture.context.slot, clock.slot, 'retained context slot equals its Clock slot');
  for (const route of dlmmRawTestRoutes()) {
    const { facts } = route;
    const pool = new DlmmRawTestPublicKey(facts.pool);
    dlmmRawTestAssert.equal(facts.tokenX, DLMM_RAW_TEST_TARGET, 'target is tokenX on every retained route');
    dlmmRawTestAssert.deepEqual(
      [facts.tokenX, facts.tokenY, facts.reserveX, facts.reserveY],
      [facts.pair.tokenXMint.toBase58(), facts.pair.tokenYMint.toBase58(), facts.pair.reserveX.toBase58(), facts.pair.reserveY.toBase58()],
    );
    dlmmRawTestAssert.deepEqual([facts.reserveX, facts.reserveY], [dlmmRawTestReserveKey(facts.pool, facts.tokenX), dlmmRawTestReserveKey(facts.pool, facts.tokenY)]);
    dlmmRawTestAssert.equal(facts.extension, DlmmRawTestSdk.deriveBinArrayBitmapExtension(pool, dlmmRawTestProgramKey)[0].toBase58());
    dlmmRawTestAssert.equal(dlmmRawTestFixture.accounts[facts.extension], null, 'retained extension observed null');
    for (const index of route.indices) {
      const key = dlmmRawTestArrayKey(facts.pool, index);
      dlmmRawTestAssert.equal(key, DlmmRawTestSdk.deriveBinArray(pool, new DlmmRawTestBN(index.toString()), dlmmRawTestProgramKey)[0].toBase58());
      const decoded = dlmmRawTestDecode('binArray', dlmmRawTestData(dlmmRawTestAccount(dlmmRawTestFixture.accounts, key)));
      dlmmRawTestAssert.deepEqual([BigInt(decoded.index.toString()), decoded.lbPair.toBase58(), Number(decoded.version)], [index, facts.pool, 2]);
    }
  }
  dlmmRawTestAssert.equal(dlmmRawTestRoutes().filter((route) => route.directionalOutput > 0n).length, 3, 'retained fixture: three positive sell directions');
  dlmmRawTestAssert.equal(dlmmRawTestRoutes().reduce((n, route) => n + route.indices.length, 0), 19, 'retained fixture: 19 directional arrays');
  dlmmRawTestAssert.equal(dlmmRawTestNetworkCalls, 0);
});

dlmmRawTestCase('dlmm raw: all retained genuine routes solve KNOWN at 300 bps with exact facts and requoted witnesses', () => {
  const bank = dlmmRawTestBank();
  for (const route of dlmmRawTestRoutes()) {
    const { facts } = route;
    const outcome = dlmmRawTestCheckKnown(`genuine ${facts.pool}`, facts, bank, dlmmRawTestSolveAt(facts.pool, bank));
    const plan = dlmmRawTestPlanAt(facts.pool, bank.accounts);
    dlmmRawTestAssert.deepEqual(plan.additionalKeys, route.arrays, `${facts.pool}: exactly the flagged directional arrays`);
    if (route.directionalOutput > 0n) {
      dlmmRawTestAssert.equal(outcome.zero, null);
    } else {
      dlmmRawTestAssert.ok(outcome.zero === 'EMPTY_OUTPUT_SIDE' || outcome.zero === 'ZERO_LIQUIDITY', `${facts.pool}: empty sell side zero reason ${String(outcome.zero)}`);
    }
  }
  dlmmRawTestAssert.equal(dlmmRawTestNetworkCalls, 0);
});

dlmmRawTestCase('dlmm raw: frozen-clock child SDK swapQuote agrees on the genuine grid, witnesses and +1 points', () => {
  const bank = dlmmRawTestBank();
  const plans = dlmmRawTestRoutes().map((route) => ({
    route,
    points: dlmmRawTestSdkPoints(dlmmRawTestKnownOf(route.facts.pool, dlmmRawTestSolveAt(route.facts.pool, bank))),
  }));
  const run = dlmmRawTestRunSdk(dlmmRawTestFixture.accounts, plans.map((plan) => ({ pool: plan.route.facts.pool, points: plan.points })));
  run.rows.forEach((row, i) => {
    const plan = plans[i] ?? dlmmRawTestAssert.fail('row without plan');
    dlmmRawTestAssert.deepEqual(row.points.map((point) => point.input), plan.points);
    for (const point of row.points) dlmmRawTestCompareSdk(`sdk ${row.pool}`, row.pool, bank, point, plan.route.directionalOutput > 0n);
  });
});

dlmmRawTestCase('dlmm raw: repeated solves and quotes are deterministic and leave the raw bank unchanged', () => {
  const accounts = dlmmRawTestFreeze(structuredClone(dlmmRawTestFixture.accounts) as RawDlmmTestAccountMap);
  const snapshot = JSON.stringify(accounts);
  const bank = dlmmRawTestFreeze(dlmmRawTestBank(accounts));
  for (const { facts } of dlmmRawTestRoutes()) {
    dlmmRawTestAssert.deepEqual(dlmmRawTestSolveAt(facts.pool, bank), dlmmRawTestSolveAt(facts.pool, bank));
    dlmmRawTestAssert.deepEqual(dlmmRawTestPlanAt(facts.pool, accounts), dlmmRawTestPlanAt(facts.pool, accounts));
    dlmmRawTestAssert.deepEqual(dlmmRawTestQuoteAt(facts.pool, bank, DLMM_RAW_TEST_BIG_INPUT), dlmmRawTestQuoteAt(facts.pool, bank, DLMM_RAW_TEST_BIG_INPUT));
  }
  dlmmRawTestAssert.equal(JSON.stringify(accounts), snapshot, 'source raw bank unchanged');
});

dlmmRawTestCase('dlmm raw: key plan progresses from an empty map to a closed key set without Clock', () => {
  const route = dlmmRawTestPositiveRoute();
  const { facts } = route;
  const pool = facts.pool;
  const base = dlmmRawTestFixture.accounts;
  const statics = [facts.tokenX, facts.tokenY, facts.reserveX, facts.reserveY];
  const empty = dlmmRawTestPlanAt(pool, {});
  dlmmRawTestCheckPlan('empty map', empty, facts);
  dlmmRawTestAssert.deepEqual([empty.route, empty.open, empty.rejected], [null, true, null]);
  dlmmRawTestAssert.ok(empty.missingKeys.includes(pool), 'empty map requests the pool');
  const poolOnly = dlmmRawTestPlanAt(pool, dlmmRawTestPick([pool]));
  dlmmRawTestCheckPlan('pool only', poolOnly, facts);
  dlmmRawTestAssert.deepEqual(poolOnly.route, dlmmRawTestRouteMeta(facts, base, false));
  dlmmRawTestAssert.equal(poolOnly.open, true);
  dlmmRawTestAssert.ok([...statics, facts.extension].every((key) => poolOnly.missingKeys.includes(key)), 'pool derives static keys');
  dlmmRawTestAssert.ok(poolOnly.additionalKeys.every((key) => route.arrays.includes(key)), 'only flagged directional arrays');
  const mintsUnread = dlmmRawTestPlanAt(pool, dlmmRawTestPick([pool, facts.extension]));
  dlmmRawTestAssert.equal(mintsUnread.open, true, 'unread mints keep the key set open');
  const noExtension = dlmmRawTestPlanAt(pool, dlmmRawTestPick([pool, ...statics]));
  dlmmRawTestCheckPlan('extension unread', noExtension, facts);
  dlmmRawTestAssert.deepEqual(noExtension.route, dlmmRawTestRouteMeta(facts, base, true));
  dlmmRawTestAssert.ok(noExtension.open && noExtension.missingKeys.includes(facts.extension), 'an unread extension keeps the key set open');
  dlmmRawTestExpectNotKnown('unread extension cannot prove the empty side', pool, dlmmRawTestBank(dlmmRawTestPick([pool, ...statics, ...route.arrays, DLMM_RAW_TEST_CLOCK_KEY])), [DLMM_RAW_TEST_BIG_INPUT]);
  const closed = dlmmRawTestPlanAt(pool, dlmmRawTestPick([pool, ...statics, facts.extension]));
  dlmmRawTestCheckPlan('closed', closed, facts);
  dlmmRawTestAssert.deepEqual(
    [closed.open, closed.nullKeys, closed.additionalKeys, closed.missingKeys],
    [false, [facts.extension], route.arrays, route.arrays],
    'read mints plus observed-null extension close the key set; arrays may still be missing',
  );
  const half = route.arrays.slice(0, Math.ceil(route.arrays.length / 2));
  const partial = dlmmRawTestPlanAt(pool, dlmmRawTestPick([pool, ...statics, facts.extension, ...half]));
  dlmmRawTestAssert.deepEqual([partial.open, partial.additionalKeys, partial.missingKeys], [false, route.arrays, route.arrays.filter((key) => !half.includes(key))]);
  const complete = dlmmRawTestPlanAt(pool, base);
  dlmmRawTestCheckPlan('complete', complete, facts);
  dlmmRawTestAssert.deepEqual(
    [complete.open, complete.rejected, complete.missingKeys, complete.nullKeys, complete.additionalKeys],
    [false, null, [], [facts.extension], route.arrays],
  );
  dlmmRawTestAssert.deepEqual(dlmmRawTestPlanAt(pool, base), complete, 'plans are deterministic');
});

dlmmRawTestCase('dlmm raw: flagged array set, PDA, parent, index and version gate coverage; gaps never become KNOWN', () => {
  const route = dlmmRawTestPositiveRoute();
  const { facts } = route;
  const pool = facts.pool;
  const base = dlmmRawTestFixture.accounts;
  const deep = route.deepestArray ?? dlmmRawTestAssert.fail('positive route without arrays');
  const deepIndex = route.indices[route.indices.length - 1] ?? dlmmRawTestAssert.fail('no deepest index');
  const other = dlmmRawTestOtherPool(pool);
  const coverage = [DLMM_RAW_TEST_BIG_INPUT];
  const dropped = dlmmRawTestWithout(base, deep);
  dlmmRawTestAssert.ok(dlmmRawTestPlanAt(pool, dropped).missingKeys.includes(deep));
  dlmmRawTestExpectNotKnown('dropped flagged array', pool, dlmmRawTestBank(dropped), coverage);
  const nulled = { ...base, [deep]: null };
  dlmmRawTestAssert.ok(dlmmRawTestPlanAt(pool, nulled).nullKeys.includes(deep));
  dlmmRawTestExpectNotKnown('null flagged array', pool, dlmmRawTestBank(nulled), coverage);
  const unread = dlmmRawTestWithout(base, facts.extension);
  const unreadPlan = dlmmRawTestPlanAt(pool, unread);
  dlmmRawTestAssert.ok(unreadPlan.open && unreadPlan.missingKeys.includes(facts.extension));
  dlmmRawTestExpectNotKnown('dropped extension property', pool, dlmmRawTestBank(unread), coverage);
  const arrayCases: readonly (readonly [string, RawDlmmTestAccountMap])[] = [
    ['array owner', dlmmRawTestPatch(base, deep, { owner: DLMM_RAW_TEST_TOKEN_PROGRAM })],
    ['array discriminator', dlmmRawTestEdit(base, deep, (b) => { b.writeUInt8(b.readUInt8(0) ^ 0xff, 0); })],
    ['array size', dlmmRawTestReplace(base, deep, dlmmRawTestData(dlmmRawTestAccount(base, deep)).subarray(0, 10128))],
    ['array executable', dlmmRawTestPatch(base, deep, { executable: true })],
    ['array parent', dlmmRawTestEdit(base, deep, (b) => { dlmmRawTestKeyBytes(other).copy(b, 24); })],
    ['array index', dlmmRawTestEdit(base, deep, (b) => { b.writeBigInt64LE(deepIndex - 1n, 8); })],
    ['array version', dlmmRawTestEdit(base, deep, dlmmRawTestU8(16, 3))],
  ];
  for (const [label, accounts] of arrayCases) dlmmRawTestExpectNotKnown(label, pool, dlmmRawTestBank(accounts), coverage);
  const poolCases: readonly (readonly [string, RawDlmmTestAccountMap])[] = [
    ['pool owner', dlmmRawTestPatch(base, pool, { owner: DLMM_RAW_TEST_TOKEN_PROGRAM })],
    ['pool discriminator', dlmmRawTestEdit(base, pool, (b) => { b.writeUInt8(b.readUInt8(0) ^ 0xff, 0); })],
    ['pool size', dlmmRawTestReplace(base, pool, dlmmRawTestData(dlmmRawTestAccount(base, pool)).subarray(0, 896))],
    ['pool executable', dlmmRawTestPatch(base, pool, { executable: true })],
  ];
  for (const [label, accounts] of poolCases) {
    dlmmRawTestAssert.notEqual(dlmmRawTestPlanNoThrow(label, pool, accounts).rejected, null, `${label}: plan rejected`);
    dlmmRawTestExpectNotKnown(label, pool, dlmmRawTestBank(accounts));
  }
});

dlmmRawTestCase('dlmm raw: raw reverse orientation stays explicitly unsupported and foreign targets are not routes', () => {
  const { facts } = dlmmRawTestPositiveRoute();
  const reasons = dlmmRawTestExpectNotKnown('raw reverse direction', facts.pool, dlmmRawTestBank(), [], facts.tokenY);
  dlmmRawTestAssert.ok(reasons.includes('DLMM_REVERSE_DIRECTION_UNPROVED'), `declared reverse limit, got ${reasons.join(',')}`);
  const foreign = dlmmRawTestOtherPool(facts.pool);
  dlmmRawTestExpectNotKnown('foreign target mint', facts.pool, dlmmRawTestBank(), [], foreign);
  dlmmRawTestAssert.notEqual(dlmmRawTestPlanAt(facts.pool, dlmmRawTestFixture.accounts, foreign).rejected, null);
});

dlmmRawTestCase('dlmm raw: evidenced mint/vault option and state guards reject malformed controls with no false zero', () => {
  const { facts } = dlmmRawTestPositiveRoute();
  const pool = facts.pool;
  const base = dlmmRawTestFixture.accounts;
  dlmmRawTestCheckKnown('accepted genuine clone', facts, dlmmRawTestBank(), dlmmRawTestSolveAt(pool, dlmmRawTestBank()));
  const other = dlmmRawTestOtherPool(pool);
  const swapProgram = (owner: string): string => (owner === DLMM_RAW_TEST_TOKEN_PROGRAM ? DLMM_RAW_TEST_TOKEN_2022_PROGRAM : DLMM_RAW_TEST_TOKEN_PROGRAM);
  const cases: [string, RawDlmmTestAccountMap][] = [];
  for (const [side, mint] of [['input', facts.tokenX], ['output', facts.tokenY]] as const) {
    const mintCases = [
      ['is_initialized byte45=0', dlmmRawTestU8(45, 0)],
      ['is_initialized byte45=2', dlmmRawTestU8(45, 2)],
      ['mint authority option tag 2', dlmmRawTestU32(0, 2)],
      ['freeze authority option tag 2', dlmmRawTestU32(46, 2)],
    ] as const;
    for (const [label, change] of mintCases) cases.push([`${side} mint ${label}`, dlmmRawTestEdit(base, mint, change)]);
    cases.push([`${side} mint owner mismatch`, dlmmRawTestPatch(base, mint, { owner: swapProgram(dlmmRawTestAccount(base, mint).owner) })]);
  }
  for (const [side, vault, wrongMint] of [['input', facts.reserveX, facts.tokenY], ['output', facts.reserveY, facts.tokenX]] as const) {
    const vaultCases = [
      ['state byte108=3', dlmmRawTestU8(108, 3)],
      ['frozen state byte108=2', dlmmRawTestU8(108, 2)],
      ['delegate option tag 2', dlmmRawTestU32(72, 2)],
      ['is_native option tag 2', dlmmRawTestU32(109, 2)],
      ['close authority option tag 2', dlmmRawTestU32(129, 2)],
      ['delegate present', (b: Buffer): void => { b.writeUInt32LE(1, 72); dlmmRawTestKeyBytes(other).copy(b, 76); }],
      ['close authority present', (b: Buffer): void => { b.writeUInt32LE(1, 129); dlmmRawTestKeyBytes(other).copy(b, 133); }],
      ['delegated amount nonzero', dlmmRawTestU64(121, 1n)],
      ['wrong vault mint', (b: Buffer): void => { dlmmRawTestKeyBytes(wrongMint).copy(b, 0); }],
      ['wrong vault authority', (b: Buffer): void => { dlmmRawTestKeyBytes(other).copy(b, 32); }],
    ] as const;
    for (const [label, change] of vaultCases) cases.push([`${side} vault ${label}`, dlmmRawTestEdit(base, vault, change)]);
    cases.push([`${side} vault header program`, dlmmRawTestPatch(base, vault, { owner: swapProgram(dlmmRawTestAccount(base, vault).owner) })]);
  }
  for (const [label, accounts] of cases) dlmmRawTestExpectNotKnown(label, pool, dlmmRawTestBank(accounts));
});

dlmmRawTestCase('dlmm raw: output backing, protocol fee, clock coherence, RPC shapes and rounded rentEpoch', async () => {
  const route = dlmmRawTestPositiveRoute();
  const { facts } = route;
  const pool = facts.pool;
  const base = dlmmRawTestFixture.accounts;
  const baseline = dlmmRawTestKnownOf('baseline', dlmmRawTestSolveAt(pool, dlmmRawTestBank()));
  dlmmRawTestAssert.ok(route.directionalPrincipal > 0n);
  dlmmRawTestExpectNotKnown('output vault below gross principal', pool, dlmmRawTestBank(dlmmRawTestEdit(base, facts.reserveY, dlmmRawTestU64(64, route.directionalPrincipal - 1n))));
  const vaultAmount = dlmmRawTestData(dlmmRawTestAccount(base, facts.reserveY)).readBigUInt64LE(64);
  const fee = await dlmmRawTestEditPool(base, pool, (pair) => dlmmRawTestSet(pair.protocolFee, 'amountY', vaultAmount + 1n));
  dlmmRawTestExpectNotKnown('protocol fee above output vault balance', pool, dlmmRawTestBank(fee));
  const clock = dlmmRawTestClock();
  const clockCases: readonly (readonly [string, RawDlmmTestBank])[] = [
    ['decoded unixTimestamp differs from raw Clock', dlmmRawTestBank(base, { unixTimestamp: clock.unixTimestamp + 1 })],
    ['decoded Clock slot differs', dlmmRawTestBank(base, { slot: clock.slot + 1 })],
    ['decoded epoch differs', dlmmRawTestBank(base, { epoch: clock.epoch + 1 })],
    ['context slot differs from Clock slot', dlmmRawTestBank(base, {}, dlmmRawTestFixture.context.slot + 1)],
    ['raw Clock body differs', dlmmRawTestBank(dlmmRawTestEdit(base, DLMM_RAW_TEST_CLOCK_KEY, (b) => { b.writeBigInt64LE(b.readBigInt64LE(32) + 1n, 32); }))],
    ['unsafe decoded Clock slot with valid context slot', dlmmRawTestBank(base, { slot: 2 ** 53 })],
  ];
  for (const [label, bank] of clockCases) dlmmRawTestExpectNotKnown(label, pool, bank);
  const deep = route.deepestArray ?? dlmmRawTestAssert.fail('no arrays');
  for (const key of [pool, facts.tokenX, facts.reserveY, deep]) {
    const body = dlmmRawTestAccount(base, key);
    const shapes = [
      ['non-base64 data', { data: ['@@@@', 'base64'] }],
      ['non-base64 encoding tag', { data: [body.data[0], 'base58'] }],
      ['negative lamports', { lamports: -1 }],
      ['unsafe lamports', { lamports: 2 ** 53 }],
      ['fractional lamports', { lamports: 1.5 }],
      ['short owner', { owner: 'short' }],
      ['non-boolean executable', { executable: 'false' }],
    ] as const;
    for (const [label, patch] of shapes) {
      const accounts = dlmmRawTestPatch(base, key, patch);
      const plan = dlmmRawTestPlanNoThrow(`${label} on ${key}`, pool, accounts);
      if (key === pool) dlmmRawTestAssert.notEqual(plan.rejected, null, `${label} on pool: plan rejected`);
      dlmmRawTestExpectNotKnown(`${label} on ${key}`, pool, dlmmRawTestBank(accounts));
    }
  }
  const rounded: Record<string, RawDlmmTestRpcAccount | null> = {};
  for (const [key, body] of Object.entries(base)) rounded[key] = body === null ? null : { ...body, rentEpoch: Number(DLMM_RAW_TEST_U64_MAX) };
  const roundedBank = dlmmRawTestBank(rounded);
  const roundedOutcome = dlmmRawTestCheckKnown('rentEpoch u64 max arrives rounded', facts, roundedBank, dlmmRawTestSolveAt(pool, roundedBank));
  dlmmRawTestAssert.deepEqual(roundedOutcome, baseline, 'unused rentEpoch metadata does not change the outcome');
});

dlmmRawTestCase('dlmm raw: native WSOL vault requires lamport backing, ignores surplus; non-WSOL native flags are unsupported', () => {
  const base = dlmmRawTestFixture.accounts;
  const ordered = [...dlmmRawTestRoutes()].sort((a, b) => Number(b.directionalOutput > 0n) - Number(a.directionalOutput > 0n));
  let found: { readonly route: RawDlmmTestRoute; readonly vault: string; readonly mint: string } | undefined;
  for (const route of ordered) {
    for (const [vault, mint] of [[route.facts.reserveX, route.facts.tokenX], [route.facts.reserveY, route.facts.tokenY]] as const) {
      if (found === undefined && dlmmRawTestData(dlmmRawTestAccount(base, vault)).readUInt32LE(109) === 1) found = { route, vault, mint };
    }
  }
  if (found === undefined) return dlmmRawTestAssert.fail('retained fixture has no native vault');
  dlmmRawTestAssert.equal(found.mint, DLMM_RAW_TEST_WSOL);
  const { facts } = found.route;
  const baseline = dlmmRawTestKnownOf('native baseline', dlmmRawTestSolveAt(facts.pool, dlmmRawTestBank()));
  const bytes = dlmmRawTestData(dlmmRawTestAccount(base, found.vault));
  const backing = Number(bytes.readBigUInt64LE(64) + bytes.readBigUInt64LE(113));
  const summary = (o: RawDlmmTestKnown): unknown => [o.netAtoms, o.inputAtoms, o.maxAdmissibleInputAtoms, o.zero, o.certificate.domainEndAtoms, o.facts];
  for (const lamports of [backing, backing + 1_000_000_000]) {
    const bank = dlmmRawTestBank(dlmmRawTestPatch(base, found.vault, { lamports }));
    const outcome = dlmmRawTestCheckKnown(`native lamports ${lamports}`, facts, bank, dlmmRawTestSolveAt(facts.pool, bank));
    dlmmRawTestAssert.deepEqual(summary(outcome), summary(baseline), 'surplus lamports never add executable depth');
  }
  dlmmRawTestExpectNotKnown('native lamports below amount + rent reserve', facts.pool, dlmmRawTestBank(dlmmRawTestPatch(base, found.vault, { lamports: backing - 1 })));
  const target = dlmmRawTestPositiveRoute().facts;
  const nonWsol = dlmmRawTestEdit(base, target.reserveX, (b) => { b.writeUInt32LE(1, 109); b.writeBigUInt64LE(2_039_280n, 113); });
  dlmmRawTestExpectNotKnown('non-WSOL native flag', target.pool, dlmmRawTestBank(nonWsol));
});

dlmmRawTestCase('dlmm raw: target transfer controls require zero immutable tax and reject hooks or unknown TLVs', async () => {
  const { facts } = dlmmRawTestPositiveRoute();
  const pool = facts.pool;
  let base = dlmmRawTestFixture.accounts;
  const mintBody = dlmmRawTestAccount(base, facts.tokenX);
  if (mintBody.owner === DLMM_RAW_TEST_TOKEN_PROGRAM) {
    // Equivalent zero-extension Token-2022 target so each TLV case isolates one control.
    base = dlmmRawTestReplace(base, facts.tokenX, Buffer.concat([dlmmRawTestData(mintBody), Buffer.alloc(83), Buffer.from([1])]), { owner: DLMM_RAW_TEST_TOKEN_2022_PROGRAM });
    const vault = dlmmRawTestAccount(base, facts.reserveX);
    dlmmRawTestAssert.equal(vault.owner, DLMM_RAW_TEST_TOKEN_PROGRAM);
    base = dlmmRawTestReplace(base, facts.reserveX, Buffer.concat([dlmmRawTestData(vault), Buffer.from([2])]), { owner: DLMM_RAW_TEST_TOKEN_2022_PROGRAM });
    base = await dlmmRawTestEditPool(base, pool, (pair) => dlmmRawTestSet(pair, 'tokenMintXProgramFlag', 1n));
  } else if (dlmmRawTestData(mintBody).length === 82) {
    base = dlmmRawTestReplace(base, facts.tokenX, Buffer.concat([dlmmRawTestData(mintBody), Buffer.alloc(83), Buffer.from([1])]));
  }
  const genuine = dlmmRawTestKnownOf('genuine', dlmmRawTestSolveAt(pool, dlmmRawTestBank()));
  const convertedBank = dlmmRawTestBank(base);
  const converted = dlmmRawTestCheckKnown('zero-extension Token-2022 target', facts, convertedBank, dlmmRawTestSolveAt(pool, convertedBank));
  dlmmRawTestAssert.deepEqual([converted.netAtoms, converted.inputAtoms], [genuine.netAtoms, genuine.inputAtoms]);
  const other = dlmmRawTestOtherPool(pool);
  const feeConfig = (authority: string | null, bps: number): Buffer => {
    const value = Buffer.alloc(108);
    if (authority !== null) dlmmRawTestKeyBytes(authority).copy(value, 0);
    value.writeUInt16LE(bps, 88);
    value.writeUInt16LE(bps, 106);
    return dlmmRawTestTlv(1, value);
  };
  const hookValue = Buffer.alloc(64);
  dlmmRawTestKeyBytes(other).copy(hookValue, 32);
  const cases = [
    ['nonzero transfer fee', feeConfig(null, 100)],
    ['mutable transfer fee authority', feeConfig(other, 0)],
    ['transfer hook program', dlmmRawTestTlv(14, hookValue)],
    ['unknown TLV', dlmmRawTestTlv(999, Buffer.alloc(4))],
  ] as const;
  for (const [label, entry] of cases) {
    const accounts = dlmmRawTestReplace(base, facts.tokenX, dlmmRawTestInsertTlv(dlmmRawTestData(dlmmRawTestAccount(base, facts.tokenX)), entry));
    dlmmRawTestExpectNotKnown(label, pool, dlmmRawTestBank(accounts));
  }
});

dlmmRawTestCase('dlmm raw: pool status, source activation, timestamps and fee modes follow the source policy', async () => {
  const base = dlmmRawTestFixture.accounts;
  for (const { facts } of dlmmRawTestRoutes()) {
    const bytes = dlmmRawTestData(dlmmRawTestAccount(base, facts.pool));
    dlmmRawTestAssert.deepEqual(await dlmmRawTestEncodePool(dlmmRawTestDecode('lbPair', bytes), bytes), bytes, 'SDK coder round-trips genuine LbPair bytes');
  }
  const { facts } = dlmmRawTestPositiveRoute();
  const pool = facts.pool;
  const clock = dlmmRawTestClock();
  const baseline = dlmmRawTestKnownOf('baseline', dlmmRawTestSolveAt(pool, dlmmRawTestBank()));
  const activation = (pairType: bigint, activationType: bigint, point: bigint) => (pair: any): void => {
    dlmmRawTestSet(pair, 'pairType', pairType);
    dlmmRawTestSet(pair, 'activationType', activationType);
    dlmmRawTestSet(pair, 'activationPoint', point);
  };
  const futureTimestamp = BigInt(clock.unixTimestamp) + 3600n;
  const futureSlot = BigInt(clock.slot) + 1000n;
  const blocked: readonly (readonly [string, (pair: any) => void])[] = [
    ['disabled status', (pair) => dlmmRawTestSet(pair, 'status', 1n)],
    ['permission pair future timestamp activation', activation(1n, 1n, futureTimestamp)],
    ['permission pair future slot activation', activation(1n, 0n, futureSlot)],
    ['customizable permissionless future timestamp activation', activation(2n, 1n, futureTimestamp)],
    ['customizable permissionless future slot activation', activation(2n, 0n, futureSlot)],
    ['lastUpdateTimestamp after Clock', (pair) => dlmmRawTestSet(pair.vParameters, 'lastUpdateTimestamp', BigInt(clock.unixTimestamp) + 1n)],
    ['unknown collect fee mode', (pair) => dlmmRawTestSet(dlmmRawTestHolder(pair, 'collectFeeMode'), 'collectFeeMode', 250n)],
    ['unknown function type', (pair) => dlmmRawTestSet(dlmmRawTestHolder(pair, 'functionType'), 'functionType', 250n)],
  ];
  for (const [label, change] of blocked) dlmmRawTestExpectNotKnown(label, pool, dlmmRawTestBank(await dlmmRawTestEditPool(base, pool, change)));
  const ignored = [
    ['permissionless v2 future slot activation', activation(3n, 0n, futureSlot + 1_000_000n)],
    ['permissionless v2 future timestamp activation', activation(3n, 1n, futureTimestamp + 86_400n)],
  ] as const;
  for (const [label, change] of ignored) {
    const bank = dlmmRawTestBank(await dlmmRawTestEditPool(base, pool, change));
    const outcome = dlmmRawTestCheckKnown(label, facts, bank, dlmmRawTestSolveAt(pool, bank));
    dlmmRawTestAssert.deepEqual(
      [outcome.netAtoms, outcome.inputAtoms, outcome.maxAdmissibleInputAtoms],
      [baseline.netAtoms, baseline.inputAtoms, baseline.maxAdmissibleInputAtoms],
      `${label}: source ignores activationPoint for pairType 3`,
    );
  }
});

dlmmRawTestCase('dlmm raw: caller input errors are EXEC_LIQ_INPUT_INVALID; public zero input is the canonical zero quote', () => {
  const bank = dlmmRawTestBank();
  const positive = dlmmRawTestPositiveRoute().facts.pool;
  const empty = dlmmRawTestRoutes().find((route) => route.directionalOutput === 0n)?.facts.pool ?? dlmmRawTestAssert.fail('no empty route');
  const invalid = (label: string, call: () => unknown): void => {
    dlmmRawTestAssert.throws(call, (error: unknown) => {
      const e = error as { readonly code?: unknown; readonly message?: unknown };
      return e.code === 'EXEC_LIQ_INPUT_INVALID' || String(e.message).includes('EXEC_LIQ_INPUT_INVALID');
    }, label);
  };
  for (const pool of ['', 'not-a-pubkey!', '0OIl0OIl']) {
    invalid(`plan pool '${pool}'`, () => dlmmRawTestPlanAt(pool, dlmmRawTestFixture.accounts));
    invalid(`quote pool '${pool}'`, () => dlmmRawTestQuoteAt(pool, bank, '1'));
    invalid(`solve pool '${pool}'`, () => dlmmRawTestSolveAt(pool, bank));
  }
  for (const address of ['', 'not-a-pubkey!']) {
    invalid(`plan token '${address}'`, () => dlmmRawTestPlanAt(positive, dlmmRawTestFixture.accounts, address));
    invalid(`quote token '${address}'`, () => dlmmRawTestQuoteAt(positive, bank, '1', address));
    invalid(`solve token '${address}'`, () => dlmmRawTestSolveAt(positive, bank, DLMM_RAW_TEST_IMPACT_BPS, address));
  }
  for (const inputAtoms of ['-1', '01', '1.5', ' 1', '1e3', '', '0x10', (DLMM_RAW_TEST_U64_MAX + 1n).toString()]) {
    invalid(`inputAtoms '${inputAtoms}'`, () => dlmmRawTestQuoteAt(positive, bank, inputAtoms));
  }
  for (const impactBps of [-1, 10_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    invalid(`impactBps ${impactBps}`, () => dlmmRawTestSolveAt(positive, bank, impactBps));
  }
  const unsafeSlotBanks: readonly (readonly [string, RawDlmmTestBank])[] = [
    ['unsafe Clock and context slot', dlmmRawTestBank(dlmmRawTestFixture.accounts, { slot: 2 ** 53 }, 2 ** 53)],
    ['unsafe context slot', dlmmRawTestBank(dlmmRawTestFixture.accounts, {}, 2 ** 53)],
  ];
  for (const [label, unsafeBank] of unsafeSlotBanks) {
    invalid(`quote ${label}`, () => dlmmRawTestQuoteAt(positive, unsafeBank, '1'));
    invalid(`solve ${label}`, () => dlmmRawTestSolveAt(positive, unsafeBank));
  }
  for (const pool of [positive, empty]) dlmmRawTestAssert.deepEqual(dlmmRawTestQuoteAt(pool, bank, '0'), DLMM_RAW_TEST_ZERO_QUOTE);
  dlmmRawTestAssert.doesNotThrow(() => dlmmRawTestQuoteAt(positive, bank, DLMM_RAW_TEST_U64_MAX.toString()));
  for (const impactBps of [0, 10_000]) dlmmRawTestAssert.equal(dlmmRawTestSolveAt(positive, bank, impactBps).impactBps, impactBps);
});

dlmmRawTestCase('dlmm raw: synthetic bitmap-extension crossing matches the independent oracle and the frozen-clock SDK', async () => {
  const world = await dlmmRawTestSynthetic();
  const { facts, accounts } = world;
  const pool = facts.pool;
  const bank = dlmmRawTestBank(accounts);
  const S = DLMM_RAW_TEST_SYNTHETIC;
  const oracle = dlmmOracleSolve(world.oracle, world.benchmark, S.cap);
  dlmmRawTestAssert.equal(oracle.capFullyConsumable, false, 'physical domain ends inside the enumeration cap');
  dlmmRawTestAssert.ok(oracle.largestFullyConsumableInput < oracle.cap);
  const endQuote = oracle.table[Number(oracle.largestFullyConsumableInput)] ?? dlmmRawTestAssert.fail('oracle table');
  dlmmRawTestAssert.deepEqual(endQuote.steps.map((step) => step.binId), [-35840n, -35841n], 'the domain crosses into the extension array');
  const plan = dlmmRawTestPlanAt(pool, accounts);
  dlmmRawTestAssert.deepEqual(
    [plan.additionalKeys, plan.missingKeys, plan.nullKeys, plan.open, plan.rejected],
    [dlmmRawTestSortedKeys(world.arrayKeys), [], [], false, null],
    'coverage derives exactly from pool bitmap and extension; no default array convenience',
  );
  const outcome = dlmmRawTestCheckKnown('synthetic', facts, bank, dlmmRawTestSolveAt(pool, bank));
  dlmmRawTestAssert.deepEqual([outcome.netAtoms, outcome.inputAtoms, outcome.zero], [oracle.maxNet.toString(), oracle.smallestInputAtMaxNet.toString(), null], 'max net and smallest tie');
  if (outcome.maxAdmissibleInputAtoms !== null) dlmmRawTestAssert.equal(outcome.maxAdmissibleInputAtoms, oracle.greatestAdmissibleInput.toString());
  if (outcome.certificate.domainEndAtoms !== null) dlmmRawTestAssert.equal(outcome.certificate.domainEndAtoms, oracle.largestFullyConsumableInput.toString());
  const points = new Set<bigint>();
  for (let x = 0n; x <= 80n; x += 1n) points.add(x);
  for (let x = 0n; x <= S.cap; x += 37n) points.add(x);
  for (const anchor of [oracle.smallestInputAtMaxNet, oracle.greatestAdmissibleInput, oracle.largestFullyConsumableInput]) {
    for (const delta of [-1n, 0n, 1n]) if (anchor + delta >= 0n && anchor + delta <= S.cap) points.add(anchor + delta);
  }
  for (const w of outcome.certificate.witnesses) if (BigInt(w.inputAtoms) <= S.cap) points.add(BigInt(w.inputAtoms));
  points.add(S.cap);
  const ordered = [...points].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const x of ordered) {
    const expected = oracle.table[Number(x)] ?? dlmmRawTestAssert.fail(`oracle x=${x}`);
    const quote = dlmmRawTestQuoteAt(pool, bank, x.toString());
    const fee = expected.feePlusProtocolFee.toString();
    dlmmRawTestAssert.deepEqual(
      [quote.consumedAtoms, quote.netAtoms, quote.complete, quote.fees],
      [
        expected.consumed.toString(),
        expected.net.toString(),
        expected.complete,
        { tradingInputAtoms: world.feeOnInput ? fee : '0', tradingOutputAtoms: world.feeOnInput ? '0' : fee, transferInputAtoms: '0', transferOutputAtoms: '0' },
      ],
      `synthetic quote x=${x} vs oracle`,
    );
  }
  const dustOracle = oracle.table[1] ?? dlmmRawTestAssert.fail('oracle x=1');
  dlmmRawTestAssert.deepEqual([dustOracle.consumed, dustOracle.net, dustOracle.feePlusProtocolFee], [1n, 0n, 0n], 'declared dust point');
  const dust = dlmmRawTestQuoteAt(pool, bank, '1');
  dlmmRawTestAssert.deepEqual([dust.consumedAtoms, dust.netAtoms, dust.complete, dlmmRawTestFeeSum(dust)], ['1', '0', true, 0n], 'one atom consumed, net 0, reported fee 0');
  const run = dlmmRawTestRunSdk(accounts, [{ pool, points: ordered.filter((x) => x > 0n).map(String) }]);
  for (const point of run.rows[0]?.points ?? dlmmRawTestAssert.fail('no SDK row')) {
    dlmmRawTestCompareSdk('synthetic sdk', pool, bank, point, true);
    const expected = oracle.table[Number(point.input)] ?? dlmmRawTestAssert.fail(`oracle x=${point.input}`);
    dlmmRawTestAssert.deepEqual([point.consumed, point.net], [expected.consumed.toString(), expected.net.toString()], `SDK vs oracle x=${point.input}`);
  }
});

dlmmRawTestCase('dlmm raw: synthetic extension coverage gaps and foreign extensions never become KNOWN', async () => {
  const world = await dlmmRawTestSynthetic();
  const { facts, accounts } = world;
  const pool = facts.pool;
  const extension = facts.extension;
  const activeArray = world.arrayKeys[0] ?? dlmmRawTestAssert.fail('no active array');
  const outsideArray = world.arrayKeys[1] ?? dlmmRawTestAssert.fail('no extension-flagged array');
  const other = dlmmRawTestOtherPool(pool);
  const deeper = dlmmRawTestArrayKey(pool, -514n);
  const extensionBytes = dlmmRawTestData(dlmmRawTestAccount(accounts, extension));
  const cases: readonly (readonly [string, RawDlmmTestAccountMap, (plan: RawDlmmTestRoutePlan) => boolean])[] = [
    ['dropped extension-flagged array', dlmmRawTestWithout(accounts, outsideArray), (p) => p.missingKeys.includes(outsideArray)],
    ['null extension-flagged array', { ...accounts, [outsideArray]: null }, (p) => p.nullKeys.includes(outsideArray)],
    ['unread extension', dlmmRawTestWithout(accounts, extension), (p) => p.open && p.missingKeys.includes(extension)],
    ['extension flags an unread deeper array', dlmmRawTestReplace(accounts, extension, dlmmRawTestExtensionBody(pool, [-513n, -514n])), (p) => p.additionalKeys.includes(deeper) && p.missingKeys.includes(deeper)],
    ['extension parent', dlmmRawTestEdit(accounts, extension, (b) => { dlmmRawTestKeyBytes(other).copy(b, 8); }), () => true],
    ['extension discriminator', dlmmRawTestEdit(accounts, extension, (b) => { b.writeUInt8(b.readUInt8(0) ^ 0xff, 0); }), () => true],
    ['extension owner', dlmmRawTestPatch(accounts, extension, { owner: DLMM_RAW_TEST_TOKEN_PROGRAM }), () => true],
    ['extension size', dlmmRawTestReplace(accounts, extension, extensionBytes.subarray(0, 1568)), () => true],
  ];
  for (const [label, map, planCheck] of cases) {
    dlmmRawTestAssert.ok(planCheck(dlmmRawTestPlanNoThrow(label, pool, map)), `${label}: plan coverage`);
    dlmmRawTestExpectNotKnown(label, pool, dlmmRawTestBank(map), [DLMM_RAW_TEST_BIG_INPUT]);
  }
  // An observed-null extension proves no extension bits: only the default-bitmap array remains in coverage.
  const nullExtension = { ...dlmmRawTestWithout(accounts, outsideArray), [extension]: null };
  const nullPlan = dlmmRawTestPlanAt(pool, nullExtension);
  dlmmRawTestAssert.deepEqual([nullPlan.additionalKeys, nullPlan.missingKeys, nullPlan.open], [[activeArray], [], false]);
  const reduced = dlmmOracleSolve({ ...world.oracle, bins: world.oracle.bins.filter((bin) => bin.id >= -35840n) }, world.benchmark, DLMM_RAW_TEST_SYNTHETIC.cap);
  dlmmRawTestAssert.equal(reduced.capFullyConsumable, false);
  const nullBank = dlmmRawTestBank(nullExtension);
  const nullOutcome = dlmmRawTestCheckKnown('observed-null extension', facts, nullBank, dlmmRawTestSolveAt(pool, nullBank));
  dlmmRawTestAssert.deepEqual([nullOutcome.netAtoms, nullOutcome.inputAtoms], [reduced.maxNet.toString(), reduced.smallestInputAtMaxNet.toString()]);
});
// ===== END DLMM RAW BANK / ADMISSION / COVERAGE TESTS (PART_B) =====
