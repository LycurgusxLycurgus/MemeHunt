import { PublicKey as RawbPublicKey } from '@solana/web3.js';
import type { AccountInfo as RawbAccountInfo } from '@solana/web3.js';
import type {
  CapacityCertificate as RawbCertificate,
  CapacityWitness as RawbWitness,
  CoherentBank as RawbBank,
  ExecLiqPlanInput,
  ExecLiqQuoteInput,
  ExecLiqReason as RawbReason,
  ExecLiqSolveInput,
  JsonValue as RawbJson,
  RawAccountMap as RawbAccountMap,
  RouteFacts as RawbFacts,
  RouteMeta as RawbRouteMeta,
  RouteOutcome as RawbOutcome,
  RoutePlan,
  RouteQuote,
  RouteSolve,
  SolanaClock as RawbClock,
  VaultBalance as RawbVaultBalance,
  ZeroReason as RawbZeroReason,
} from '../domain/executable-liquidity.js';
import { quoteAdmission as rawbQuoteAdmission, validateVaultData as rawbValidateVaultData } from './advisory-exit-capacity-custom.js';
import { decodeRawMintControls as rawbDecodeRawMintControls } from './solana.js';

// Exact-in sell-capacity kernel for Meteora DLMM, pinned to @meteora-ag/dlmm 1.9.14.
// Pure and deterministic: no network, no Date, no SDK swapQuote or priceImpact.
// Caller preconditions (raw admission, not checked here): all accounts and the Clock come from one bank;
// owner/discriminator/length were admitted; lbPair was decoded from pool; pool status and activation allow
// swaps at that Clock; both transfer legs are untaxed; a null bitmap extension means the extension PDA
// account does not exist in that bank.
import { createRequire } from 'node:module';
import BN from 'bn.js';
import type {
  Bin,
  BinArrayAccount,
  BinArrayBitmapExtension,
  LbPair,
  sParameters,
  vParameters,
} from '@meteora-ag/dlmm';
import type { PublicKey } from '@solana/web3.js';

export const DLMM_KERNEL_VERSION = 'dlmm-exact-in-capacity-kernel/1';
export const DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
export const DLMM_U64_MAX = (1n << 64n) - 1n;
export const DLMM_Q64 = 1n << 64n;
export const DLMM_FEE_PRECISION = 1_000_000_000n;
export const DLMM_MAX_FEE_RATE = 100_000_000n;
export const DLMM_BPS = 10_000n;
export const DLMM_DEFAULT_MAX_LEVEL_JUMPS = 1_000_000;

const U128_MAX = (1n << 128n) - 1n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const U32_MAX = 4_294_967_295;
const BIN_ARRAY_SIZE = 70n;
const MIN_BIN_ID = -443_636;
const MAX_BIN_ID = 443_636;
const MIN_BIN_ARRAY_INDEX = -6_656n;
const MAX_BIN_ARRAY_INDEX = 6_655n;
const DEFAULT_BITMAP_WORDS = 16;
const EXTENSION_ROWS = 12;
const EXTENSION_ROW_WORDS = 8;

// ---------------------------------------------------------------- errors

export type DlmmKernelErrorCode =
  | 'INVALID_ARGUMENT'
  | 'SDK_PRIMITIVE_MISSING'
  | 'TRANSFER_FEE_NOT_ADMITTED'
  | 'PROGRAM_ID_MISMATCH'
  | 'UNSUPPORTED_MODE'
  | 'ARITHMETIC_RANGE_UNSUPPORTED'
  | 'STATE_INCONSISTENT'
  | 'BITMAP_EXTENSION_INVALID'
  | 'BIN_ARRAY_INVALID'
  | 'BIN_ARRAY_COVERAGE_INCOMPLETE'
  | 'BIN_PRICE_DERIVATION_MISMATCH'
  | 'SDK_PARITY_MISMATCH'
  | 'KERNEL_INVARIANT_VIOLATION'
  | 'INPUT_OUT_OF_PREPARED_DOMAIN';

export class DlmmKernelError extends Error {
  readonly code: DlmmKernelErrorCode;
  readonly detail: Readonly<Record<string, string>>;

  constructor(code: DlmmKernelErrorCode, message: string, detail: Record<string, string> = {}) {
    super(`${code}: ${message}`);
    this.name = 'DlmmKernelError';
    this.code = code;
    this.detail = Object.freeze({ ...detail });
  }
}

function fail(code: DlmmKernelErrorCode, message: string, detail: Record<string, string> = {}): never {
  throw new DlmmKernelError(code, message, detail);
}

// ---------------------------------------------------------------- SDK boundary

export interface DlmmSdkBinQuote {
  readonly amountIn: BN;
  readonly amountOut: BN;
  readonly fee: BN;
  readonly protocolFee: BN;
}

// Pure 1.9.14 primitives used by the kernel; names match the CJS root properties.
export interface DlmmSdkPrimitives {
  swapExactInQuoteAtBin(
    bin: Bin,
    binStep: number,
    sParameter: sParameters,
    vParameter: vParameters,
    inAmount: BN,
    swapForY: boolean,
    supportLimitOrder: boolean,
    feeOnInput: boolean,
  ): DlmmSdkBinQuote;
  getTotalFee(binStep: number, sParameter: sParameters, vParameter: vParameters): BN;
  getBinMaxAmountOut(bin: Bin, swapForY: boolean, supportLimitOrder: boolean): BN;
  getQPriceFromId(binId: BN, binStep: BN): BN;
  findNextBinArrayIndexWithLiquidity(
    swapForY: boolean,
    activeId: BN,
    lbPair: LbPair,
    binArrayBitmapExtension: BinArrayBitmapExtension | null,
  ): BN | null;
  getBinFromBinArray(binId: number, binArray: BinArrayAccount['account']): Bin;
  isSupportLimitOrder(lbPair: LbPair): boolean;
  getFeeMode(lbPair: LbPair, swapForY: boolean): { feeOnInput: boolean; feeOnTokenX: boolean };
  deriveBinArray(lbPair: PublicKey, index: BN, programId: PublicKey): [PublicKey, number];
  deriveBinArrayBitmapExtension(lbPair: PublicKey, programId: PublicKey): [PublicKey, number];
  updateReference(activeId: number, vParameter: vParameters, sParameter: sParameters, currentTimestamp: number): void;
  updateVolatilityAccumulator(vParameter: vParameters, sParameter: sParameters, activeId: number): void;
}

const SDK_PRIMITIVE_NAMES: readonly (keyof DlmmSdkPrimitives)[] = [
  'swapExactInQuoteAtBin',
  'getTotalFee',
  'getBinMaxAmountOut',
  'getQPriceFromId',
  'findNextBinArrayIndexWithLiquidity',
  'getBinFromBinArray',
  'isSupportLimitOrder',
  'getFeeMode',
  'deriveBinArray',
  'deriveBinArrayBitmapExtension',
  'updateReference',
  'updateVolatilityAccumulator',
];

let pinnedSdk: DlmmSdkPrimitives | null = null;

export function bindDlmmSdkPrimitives(root: unknown): DlmmSdkPrimitives {
  if (root === null || (typeof root !== 'function' && typeof root !== 'object')) {
    fail('SDK_PRIMITIVE_MISSING', 'SDK root is neither a constructor nor an object');
  }
  const record = root as Record<string, unknown>;
  const missing = SDK_PRIMITIVE_NAMES.filter((name) => typeof record[name] !== 'function');
  if (missing.length > 0) {
    fail('SDK_PRIMITIVE_MISSING', 'SDK root lacks required pure primitives', { missing: missing.join(',') });
  }
  const bound: Record<string, unknown> = {};
  for (const name of SDK_PRIMITIVE_NAMES) {
    bound[name] = (record[name] as (...args: unknown[]) => unknown).bind(root);
  }
  return Object.freeze(bound) as unknown as DlmmSdkPrimitives;
}

export function loadPinnedDlmmSdkPrimitives(): DlmmSdkPrimitives {
  if (pinnedSdk === null) {
    // The 1.9.14 ESM entry fails on Node directory imports; the CJS root is the DLMM class carrying helpers.
    const requireCjs = createRequire(import.meta.url);
    pinnedSdk = bindDlmmSdkPrimitives(requireCjs('@meteora-ag/dlmm'));
  }
  return pinnedSdk;
}

// ---------------------------------------------------------------- public types

export type DlmmSwapDirection = 'X_TO_Y' | 'Y_TO_X';
export type DlmmFeeUnit = 'INPUT_TOKEN' | 'OUTPUT_TOKEN';
export type DlmmCoverage = 'COMPLETE' | 'DOMAIN_CAPPED';
export type DlmmExtensionState = 'PRESENT_VALIDATED' | 'ABSENT_ATTESTED';
export type DlmmLayerKind = 'MARKET_MAKER' | 'PROCESSED_LIMIT_ORDER' | 'OPEN_LIMIT_ORDER';
export type DlmmSegmentKind = 'LAYER' | 'ABSORB';
export type DlmmZeroReason =
  | 'NO_SELL_SIDE_LIQUIDITY'
  | 'ALL_POSITIVE_INPUTS_INADMISSIBLE'
  | 'ZERO_NET_AT_ALL_ADMISSIBLE_INPUTS';

export interface DlmmKernelClock {
  readonly slot: bigint;
  readonly epoch: bigint;
  readonly unixTimestamp: bigint;
}

export interface DlmmBitmapExtensionInput {
  readonly publicKey: PublicKey;
  readonly account: BinArrayBitmapExtension;
}

export interface DlmmKernelInput {
  readonly programId: PublicKey;
  readonly pool: PublicKey;
  readonly lbPair: LbPair;
  readonly binArrays: readonly BinArrayAccount[];
  // null is the caller's same-bank attestation that the bitmap-extension PDA account is absent.
  readonly bitmapExtension: DlmmBitmapExtensionInput | null;
  readonly clock: DlmmKernelClock;
  readonly direction: DlmmSwapDirection;
  // Caller admission: both legs untaxed (legacy SPL, or Token-2022 transfer fee zero at clock.epoch).
  readonly zeroTransferFeeAdmitted: true;
  // Hypothetical input domain end in input atoms, 1..u64::MAX; defaults to u64::MAX.
  readonly inputDomainEnd?: bigint;
  readonly sdk?: DlmmSdkPrimitives;
}

export interface DlmmLiquidityLayer {
  readonly kind: DlmmLayerKind;
  readonly amountOut: bigint;
  readonly inputCap: bigint;
  readonly fillInputStart: bigint;
  readonly grossOutputStart: bigint;
}

export interface DlmmPreparedBin {
  readonly ordinal: number;
  readonly binId: number;
  readonly binArrayIndex: bigint;
  readonly priceQ64: bigint;
  readonly priceNum: bigint;
  readonly priceDen: bigint;
  readonly feeNumerator: bigint;
  readonly feeComplement: bigint;
  readonly volatilityAccumulator: number;
  readonly layers: readonly DlmmLiquidityLayer[];
  readonly fillCapacity: bigint;
  readonly grossCapacity: bigint;
  readonly fullInput: bigint;
  readonly absorbEnd: bigint;
  readonly fullNet: bigint;
  readonly inputPrefix: bigint;
  readonly netPrefix: bigint;
  readonly handledAfterInput: bigint;
  readonly handledThroughInput: bigint;
  readonly firstLocalInput: bigint;
  readonly lastLocalInput: bigint;
  readonly shadowed: boolean;
  readonly sdkBin: Bin;
  readonly sdkVParameters: vParameters;
}

// U(x) = (u0 + u1*x)/ud and U(x) - betaNum/ud <= N(x) <= U(x) on the segment.
export interface DlmmSegmentEnvelope {
  readonly u0: bigint;
  readonly u1: bigint;
  readonly ud: bigint;
  readonly betaNum: bigint;
}

export interface DlmmCapacitySegment {
  readonly index: number;
  readonly binOrdinal: number;
  readonly binId: number;
  readonly kind: DlmmSegmentKind;
  readonly layerIndex: number | null;
  readonly layerKind: DlmmLayerKind | null;
  readonly xStart: bigint;
  readonly xEnd: bigint;
  readonly netAtStart: bigint;
  readonly netAtEnd: bigint;
  readonly envelope: DlmmSegmentEnvelope;
}

export interface DlmmPreparedKernel {
  readonly kernelVersion: string;
  readonly poolAddress: string;
  readonly direction: DlmmSwapDirection;
  readonly swapForY: boolean;
  readonly feeOnInput: boolean;
  readonly feeUnit: DlmmFeeUnit;
  readonly supportLimitOrder: boolean;
  readonly binStep: number;
  readonly activeId: number;
  readonly clock: DlmmKernelClock;
  readonly activePriceQ64: bigint;
  readonly benchmarkNum: bigint;
  readonly benchmarkDen: bigint;
  readonly inputDomainCap: bigint;
  readonly domainEnd: bigint;
  readonly coverage: DlmmCoverage;
  readonly extensionState: DlmmExtensionState;
  readonly sParameters: sParameters;
  readonly referenceVParameters: vParameters;
  readonly bins: readonly DlmmPreparedBin[];
  readonly segments: readonly DlmmCapacitySegment[];
  readonly parityChecks: number;
  readonly sdk: DlmmSdkPrimitives;
}

export interface DlmmExactInQuote {
  readonly input: bigint;
  readonly consumed: bigint;
  readonly remainder: bigint;
  readonly net: bigint;
  readonly lpFee: bigint;
  readonly protocolFee: bigint;
  readonly tradingFee: bigint;
  readonly feeUnit: DlmmFeeUnit;
  readonly fullyConsumed: boolean;
  readonly binsTouched: number;
  readonly lastBinId: number | null;
}

export interface DlmmLocalBinQuote {
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly tradingFee: bigint;
}

export type DlmmExclusion =
  | {
      readonly kind: 'ENVELOPE';
      readonly segmentIndex: number;
      readonly xLo: bigint;
      readonly xHi: bigint;
      readonly gamma0: bigint;
      readonly gamma1: bigint;
    }
  | { readonly kind: 'LEVEL'; readonly xLo: bigint; readonly xHi: bigint; readonly level: bigint };

export interface DlmmMinimalityWitness {
  readonly level: bigint;
  readonly input: bigint;
  readonly netBelow: bigint | null;
}

export interface DlmmMaximalityCertificate {
  readonly lossBps: number;
  readonly admissibilityK: bigint;
  readonly admissibilityJ: bigint;
  readonly benchmarkNum: bigint;
  readonly benchmarkDen: bigint;
  readonly domainEnd: bigint;
  readonly coverage: DlmmCoverage;
  readonly extensionState: DlmmExtensionState;
  readonly witnessInput: bigint;
  readonly witnessNet: bigint;
  readonly exclusions: readonly DlmmExclusion[];
  readonly levelJumps: number;
  readonly minimality: DlmmMinimalityWitness | null;
}

export interface DlmmCapacityKnown {
  readonly status: 'KNOWN';
  readonly lossBps: number;
  readonly maxNet: bigint;
  readonly smallestInputAttainingMax: bigint;
  readonly greatestAdmissibleInput: bigint;
  readonly zeroReason: DlmmZeroReason | null;
  readonly quoteAtSmallest: DlmmExactInQuote | null;
  readonly quoteAtGreatest: DlmmExactInQuote | null;
  readonly certificate: DlmmMaximalityCertificate;
}

export interface DlmmCapacityUnresolved {
  readonly status: 'UNRESOLVED';
  readonly lossBps: number;
  readonly reason: 'LEVEL_JUMP_BUDGET_EXHAUSTED' | 'SDK_PARITY_MISMATCH';
  readonly detail: string;
  readonly unresolvedInputHigh: bigint;
  readonly partialExclusions: readonly DlmmExclusion[];
  readonly levelJumps: number;
}

export type DlmmCapacityResult = DlmmCapacityKnown | DlmmCapacityUnresolved;

export interface DlmmSolveOptions {
  readonly maxLevelJumps?: number;
}

export type DlmmCertificateCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

// ---------------------------------------------------------------- numeric helpers

const toBig = (value: { toString(base?: number): string }): bigint => BigInt(value.toString(10));
const toBN = (value: bigint): BN => new BN(value.toString(10), 10);
const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);

// n >= 0, d > 0
function ceilDiv(n: bigint, d: bigint): bigint {
  return (n + d - 1n) / d;
}

function floorDiv(n: bigint, d: bigint): bigint {
  const q = n / d;
  return n % d !== 0n && n < 0n !== d < 0n ? q - 1n : q;
}

function itemAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    fail('KERNEL_INVARIANT_VIOLATION', 'index out of range', { index: String(index) });
  }
  return item;
}

function requireInteger(label: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail('ARITHMETIC_RANGE_UNSUPPORTED', `${label} outside supported integer range`, { label, value: String(value) });
  }
  return value;
}

function bnLikeToBig(label: string, value: unknown, code: DlmmKernelErrorCode): bigint {
  if (typeof value !== 'object' || value === null || typeof (value as { toString?: unknown }).toString !== 'function') {
    fail(code, `${label} is not a BN`, { label });
  }
  const text = (value as { toString(base: number): string }).toString(10);
  if (!/^-?[0-9]+$/.test(text)) {
    fail(code, `${label} is not an integer BN`, { label });
  }
  return BigInt(text);
}

function u64Field(record: Record<string, unknown>, key: string, binId: number): bigint {
  const value = bnLikeToBig(`bin.${key}`, record[key], 'ARITHMETIC_RANGE_UNSUPPORTED');
  if (value < 0n || value > DLMM_U64_MAX) {
    fail('ARITHMETIC_RANGE_UNSUPPORTED', `bin.${key} outside u64`, { binId: String(binId) });
  }
  return value;
}

function validateWords(label: string, words: unknown, length: number, code: DlmmKernelErrorCode): void {
  if (!Array.isArray(words) || words.length !== length) {
    fail(code, `${label} must hold ${length} u64 words`, { label });
  }
  for (const word of words) {
    const value = bnLikeToBig(label, word, code);
    if (value < 0n || value > DLMM_U64_MAX) fail(code, `${label} word outside u64`, { label });
  }
}

// ---------------------------------------------------------------- state validation

function validateStaticParameters(sParameter: sParameters): void {
  const record = sParameter as unknown as Record<string, unknown>;
  requireInteger('parameters.baseFactor', record['baseFactor'], 0, 65_535);
  requireInteger('parameters.filterPeriod', record['filterPeriod'], 0, 65_535);
  requireInteger('parameters.decayPeriod', record['decayPeriod'], 0, 65_535);
  requireInteger('parameters.reductionFactor', record['reductionFactor'], 0, 65_535);
  requireInteger('parameters.variableFeeControl', record['variableFeeControl'], 0, U32_MAX);
  requireInteger('parameters.maxVolatilityAccumulator', record['maxVolatilityAccumulator'], 0, U32_MAX);
  requireInteger('parameters.protocolShare', record['protocolShare'], 0, 10_000);
  requireInteger('parameters.baseFeePowerFactor', record['baseFeePowerFactor'], 0, 255);
}

function validateVariableParameters(vParameter: vParameters): bigint {
  const record = vParameter as unknown as Record<string, unknown>;
  requireInteger('vParameters.volatilityAccumulator', record['volatilityAccumulator'], 0, U32_MAX);
  requireInteger('vParameters.volatilityReference', record['volatilityReference'], 0, U32_MAX);
  requireInteger('vParameters.indexReference', record['indexReference'], -2_147_483_648, 2_147_483_647);
  const lastUpdate = bnLikeToBig('vParameters.lastUpdateTimestamp', record['lastUpdateTimestamp'], 'STATE_INCONSISTENT');
  if (lastUpdate > MAX_SAFE || lastUpdate < -MAX_SAFE) {
    fail('ARITHMETIC_RANGE_UNSUPPORTED', 'lastUpdateTimestamp outside safe integer range');
  }
  return lastUpdate;
}

function validateClock(clock: DlmmKernelClock, lastUpdate: bigint): void {
  if (typeof clock.slot !== 'bigint' || typeof clock.epoch !== 'bigint' || typeof clock.unixTimestamp !== 'bigint') {
    fail('INVALID_ARGUMENT', 'clock fields must be bigint');
  }
  if (clock.slot < 0n || clock.epoch < 0n) fail('INVALID_ARGUMENT', 'clock slot and epoch must be non-negative');
  if (clock.unixTimestamp > MAX_SAFE || clock.unixTimestamp < -MAX_SAFE) {
    fail('ARITHMETIC_RANGE_UNSUPPORTED', 'clock unixTimestamp outside safe integer range');
  }
  if (clock.unixTimestamp < lastUpdate) {
    fail('STATE_INCONSISTENT', 'clock precedes lbPair lastUpdateTimestamp', {
      clock: clock.unixTimestamp.toString(),
      lastUpdate: lastUpdate.toString(),
    });
  }
}

function validateBitmapExtension(
  sdk: DlmmSdkPrimitives,
  extension: DlmmBitmapExtensionInput | null,
  pool: PublicKey,
  programId: PublicKey,
): BinArrayBitmapExtension | null {
  if (extension === null) return null;
  const [expected] = sdk.deriveBinArrayBitmapExtension(pool, programId);
  if (!extension.publicKey.equals(expected)) {
    fail('BITMAP_EXTENSION_INVALID', 'bitmap extension key is not the pool PDA', { key: extension.publicKey.toBase58() });
  }
  const record = extension.account as unknown as Record<string, unknown>;
  const parent = record['lbPair'] as PublicKey | undefined;
  if (parent === undefined || typeof parent.equals !== 'function' || !parent.equals(pool)) {
    fail('BITMAP_EXTENSION_INVALID', 'bitmap extension parent is not the pool');
  }
  for (const side of ['positiveBinArrayBitmap', 'negativeBinArrayBitmap']) {
    const rows = record[side];
    if (!Array.isArray(rows) || rows.length !== EXTENSION_ROWS) {
      fail('BITMAP_EXTENSION_INVALID', `${side} must have ${EXTENSION_ROWS} rows`);
    }
    rows.forEach((row: unknown, rowIndex: number) =>
      validateWords(`${side}[${rowIndex}]`, row, EXTENSION_ROW_WORDS, 'BITMAP_EXTENSION_INVALID'),
    );
  }
  return extension.account;
}

function indexBinArrays(
  sdk: DlmmSdkPrimitives,
  binArrays: readonly BinArrayAccount[],
  pool: PublicKey,
  programId: PublicKey,
): Map<bigint, BinArrayAccount> {
  const byIndex = new Map<bigint, BinArrayAccount>();
  for (const entry of binArrays) {
    const index = bnLikeToBig('binArray.index', entry.account.index, 'BIN_ARRAY_INVALID');
    const detail = { binArrayIndex: index.toString() };
    if (index < MIN_BIN_ARRAY_INDEX || index > MAX_BIN_ARRAY_INDEX) fail('BIN_ARRAY_INVALID', 'index out of range', detail);
    if (byIndex.has(index)) fail('BIN_ARRAY_INVALID', 'duplicate bin array index', detail);
    if (!entry.account.lbPair.equals(pool)) fail('BIN_ARRAY_INVALID', 'bin array parent is not the pool', detail);
    const [expected] = sdk.deriveBinArray(pool, toBN(index), programId);
    if (!entry.publicKey.equals(expected)) fail('BIN_ARRAY_INVALID', 'bin array key is not the derived PDA', detail);
    if (!Array.isArray(entry.account.bins) || entry.account.bins.length !== Number(BIN_ARRAY_SIZE)) {
      fail('BIN_ARRAY_INVALID', 'bin array must hold 70 bins', detail);
    }
    byIndex.set(index, entry);
  }
  return byIndex;
}

function cloneVParameters(vParameter: vParameters): vParameters {
  const record = vParameter as unknown as Record<string, unknown>;
  const lastUpdate = bnLikeToBig('vParameters.lastUpdateTimestamp', record['lastUpdateTimestamp'], 'STATE_INCONSISTENT');
  return { ...vParameter, lastUpdateTimestamp: toBN(lastUpdate) } as unknown as vParameters;
}

// ---------------------------------------------------------------- per-bin closed forms

interface BinContext {
  readonly sdk: DlmmSdkPrimitives;
  readonly binStep: number;
  readonly sParameter: sParameters;
  readonly swapForY: boolean;
  readonly supportLimitOrder: boolean;
  readonly feeOnInput: boolean;
  readonly referenceV: vParameters;
  readonly cap: bigint;
}

interface BinCursor {
  readonly ordinal: number;
  readonly inputPrefix: bigint;
  readonly netPrefix: bigint;
  readonly reach: bigint;
}

// Smallest requested local input whose fee-excluded fill reaches `fill` (getIncludedFeeAmount).
function fillToRequestedInput(feeOnInput: boolean, fill: bigint, feeComplement: bigint): bigint {
  return feeOnInput ? ceilDiv(fill * DLMM_FEE_PRECISION, feeComplement) : fill;
}

// Layered fill MM -> processed LO -> open LO; precondition fill <= fillCapacity.
function fillGross(bin: DlmmPreparedBin, fill: bigint): bigint {
  let left = fill;
  let out = 0n;
  for (const layer of bin.layers) {
    if (left >= layer.inputCap) {
      out += layer.amountOut;
      left -= layer.inputCap;
    } else {
      out += (left * bin.priceNum) / bin.priceDen;
      left = 0n;
      break;
    }
  }
  if (left !== 0n) fail('KERNEL_INVARIANT_VIOLATION', 'fill exceeds bin capacity', { binId: String(bin.binId) });
  return out;
}

// Closed form of swapExactInQuoteAtBin for one prepared bin; tradingFee = fee + protocolFee as the SDK reports it.
export function dlmmLocalBinQuote(bin: DlmmPreparedBin, feeOnInput: boolean, localInput: bigint): DlmmLocalBinQuote {
  if (localInput < 0n) fail('INVALID_ARGUMENT', 'local input must be non-negative');
  if (localInput > bin.absorbEnd) {
    return {
      amountIn: bin.fullInput,
      amountOut: bin.fullNet,
      tradingFee: feeOnInput ? bin.fullInput - bin.fillCapacity : bin.grossCapacity - bin.fullNet,
    };
  }
  if (feeOnInput) {
    const fill = (localInput * bin.feeComplement) / DLMM_FEE_PRECISION;
    return { amountIn: localInput, amountOut: fillGross(bin, fill), tradingFee: fill === 0n ? 0n : localInput - fill };
  }
  const gross = fillGross(bin, localInput);
  const net = (gross * bin.feeComplement) / DLMM_FEE_PRECISION;
  return { amountIn: localInput, amountOut: net, tradingFee: localInput === 0n ? 0n : gross - net };
}

function prepareBin(
  ctx: BinContext,
  cursor: BinCursor,
  bin: Bin,
  binId: number,
  binArrayIndex: bigint,
  maxOut: bigint,
): DlmmPreparedBin {
  const record = bin as unknown as Record<string, unknown>;
  const priceQ64 = bnLikeToBig('bin.price', record['price'], 'BIN_PRICE_DERIVATION_MISMATCH');
  const derived = toBig(ctx.sdk.getQPriceFromId(new BN(binId), new BN(ctx.binStep)));
  if (priceQ64 !== derived || priceQ64 <= 0n || priceQ64 > U128_MAX) {
    fail('BIN_PRICE_DERIVATION_MISMATCH', 'stored bin price differs from getQPriceFromId', {
      binId: String(binId),
      stored: priceQ64.toString(),
      derived: derived.toString(),
    });
  }
  const marketMaker = u64Field(record, ctx.swapForY ? 'amountY' : 'amountX', binId);
  let processed = 0n;
  let open = 0n;
  // getLimitOrderAmountsBySwapDirection: orders count when (swapForY and bid) or (not swapForY and ask).
  if (ctx.supportLimitOrder && ctx.swapForY !== Boolean(record['limitOrderAskSide'])) {
    processed = u64Field(record, 'processedOrderRemainingAmount', binId);
    open = u64Field(record, 'openOrderAmount', binId);
  }
  const priceNum = ctx.swapForY ? priceQ64 : DLMM_Q64;
  const priceDen = ctx.swapForY ? DLMM_Q64 : priceQ64;
  const amounts: Array<[DlmmLayerKind, bigint]> = ctx.supportLimitOrder
    ? [
        ['MARKET_MAKER', marketMaker],
        ['PROCESSED_LIMIT_ORDER', processed],
        ['OPEN_LIMIT_ORDER', open],
      ]
    : [['MARKET_MAKER', marketMaker]];
  const layers: DlmmLiquidityLayer[] = [];
  let fillCursor = 0n;
  let grossCursor = 0n;
  for (const [kind, amountOut] of amounts) {
    // getAmountIn(..., Rounding.Up): ceil(M * priceDen / priceNum)
    const inputCap = ceilDiv(amountOut * priceDen, priceNum);
    layers.push(Object.freeze({ kind, amountOut, inputCap, fillInputStart: fillCursor, grossOutputStart: grossCursor }));
    fillCursor += inputCap;
    grossCursor += amountOut;
  }
  if (grossCursor !== maxOut) {
    fail('SDK_PARITY_MISMATCH', 'layer amounts differ from getBinMaxAmountOut', { binId: String(binId) });
  }
  const sdkVParameters = cloneVParameters(ctx.referenceV);
  ctx.sdk.updateVolatilityAccumulator(sdkVParameters, ctx.sParameter, binId);
  const feeNumerator = toBig(ctx.sdk.getTotalFee(ctx.binStep, ctx.sParameter, sdkVParameters));
  if (feeNumerator < 0n || feeNumerator > DLMM_MAX_FEE_RATE) {
    fail('ARITHMETIC_RANGE_UNSUPPORTED', 'fee numerator outside 0..MAX_FEE_RATE', { binId: String(binId) });
  }
  const feeComplement = DLMM_FEE_PRECISION - feeNumerator;
  const fullInput = fillToRequestedInput(ctx.feeOnInput, fillCursor, feeComplement);
  const absorbEnd = ctx.feeOnInput
    ? ceilDiv((fillCursor + 1n) * DLMM_FEE_PRECISION, feeComplement) - 1n
    : fillCursor;
  const fullNet = ctx.feeOnInput ? grossCursor : (grossCursor * feeComplement) / DLMM_FEE_PRECISION;
  const firstLocalInput = cursor.reach - cursor.inputPrefix + 1n;
  if (firstLocalInput < 1n) fail('KERNEL_INVARIANT_VIOLATION', 'reach below input prefix', { binId: String(binId) });
  const lastLocalInput = minBig(absorbEnd, ctx.cap - cursor.inputPrefix);
  const vRecord = sdkVParameters as unknown as Record<string, unknown>;
  const prepared: DlmmPreparedBin = {
    ordinal: cursor.ordinal,
    binId,
    binArrayIndex,
    priceQ64,
    priceNum,
    priceDen,
    feeNumerator,
    feeComplement,
    volatilityAccumulator: Number(vRecord['volatilityAccumulator']),
    layers: Object.freeze(layers),
    fillCapacity: fillCursor,
    grossCapacity: grossCursor,
    fullInput,
    absorbEnd,
    fullNet,
    inputPrefix: cursor.inputPrefix,
    netPrefix: cursor.netPrefix,
    handledAfterInput: cursor.reach,
    handledThroughInput: cursor.inputPrefix + absorbEnd,
    firstLocalInput,
    lastLocalInput,
    shadowed: firstLocalInput > lastLocalInput,
    sdkBin: bin,
    sdkVParameters,
  };
  return Object.freeze(prepared);
}

// Compares the closed form with swapExactInQuoteAtBin at every boundary of the bin.
function checkBinParity(ctx: BinContext, bin: DlmmPreparedBin): number {
  const points = new Set<bigint>([
    1n,
    bin.firstLocalInput - 1n,
    bin.firstLocalInput,
    bin.fullInput - 1n,
    bin.fullInput,
    bin.absorbEnd,
    bin.absorbEnd + 1n,
  ]);
  for (const layer of bin.layers) {
    const start = fillToRequestedInput(ctx.feeOnInput, layer.fillInputStart, bin.feeComplement);
    const end = fillToRequestedInput(ctx.feeOnInput, layer.fillInputStart + layer.inputCap, bin.feeComplement);
    for (const point of [start - 1n, start, end - 1n, end]) points.add(point);
  }
  let checks = 0;
  for (const localInput of points) {
    if (localInput < 1n) continue;
    const expected = dlmmLocalBinQuote(bin, ctx.feeOnInput, localInput);
    const actual = ctx.sdk.swapExactInQuoteAtBin(
      bin.sdkBin,
      ctx.binStep,
      ctx.sParameter,
      bin.sdkVParameters,
      toBN(localInput),
      ctx.swapForY,
      ctx.supportLimitOrder,
      ctx.feeOnInput,
    );
    const amountIn = toBig(actual.amountIn);
    const amountOut = toBig(actual.amountOut);
    const tradingFee = toBig(actual.fee) + toBig(actual.protocolFee);
    if (amountIn !== expected.amountIn || amountOut !== expected.amountOut || tradingFee !== expected.tradingFee) {
      fail('SDK_PARITY_MISMATCH', 'closed-form bin quote differs from swapExactInQuoteAtBin', {
        binId: String(bin.binId),
        localInput: localInput.toString(),
        sdk: `${amountIn}/${amountOut}/${tradingFee}`,
        kernel: `${expected.amountIn}/${expected.amountOut}/${expected.tradingFee}`,
      });
    }
    checks += 1;
  }
  return checks;
}

function makeSegment(
  index: number,
  bin: DlmmPreparedBin,
  feeOnInput: boolean,
  kind: DlmmSegmentKind,
  layerIndex: number | null,
  localStart: bigint,
  localEnd: bigint,
  envelope: DlmmSegmentEnvelope,
): DlmmCapacitySegment {
  const segment: DlmmCapacitySegment = {
    index,
    binOrdinal: bin.ordinal,
    binId: bin.binId,
    kind,
    layerIndex,
    layerKind: layerIndex === null ? null : itemAt(bin.layers, layerIndex).kind,
    xStart: bin.inputPrefix + localStart,
    xEnd: bin.inputPrefix + localEnd,
    netAtStart: bin.netPrefix + dlmmLocalBinQuote(bin, feeOnInput, localStart).amountOut,
    netAtEnd: bin.netPrefix + dlmmLocalBinQuote(bin, feeOnInput, localEnd).amountOut,
    envelope: Object.freeze(envelope),
  };
  return Object.freeze(segment);
}

// Canonical partition of the bin's handled inputs (R, min(T, cap)] into layer and absorption segments.
function pushBinSegments(segments: DlmmCapacitySegment[], bin: DlmmPreparedBin, feeOnInput: boolean): void {
  if (bin.shadowed) return;
  const F = DLMM_FEE_PRECISION;
  const G = bin.feeComplement;
  const a = bin.priceNum;
  const b = bin.priceDen;
  bin.layers.forEach((layer, layerIndex) => {
    if (layer.inputCap === 0n) return;
    const localStart = maxBig(fillToRequestedInput(feeOnInput, layer.fillInputStart, G), bin.firstLocalInput);
    const localEnd = minBig(
      fillToRequestedInput(feeOnInput, layer.fillInputStart + layer.inputCap, G) - 1n,
      bin.lastLocalInput,
    );
    if (localStart > localEnd) return;
    const base = bin.netPrefix;
    const envelope: DlmmSegmentEnvelope = feeOnInput
      ? {
          // N = base + O + floor((floor(r*G/F) - C) * a / b), r = x - P
          u0: (base + layer.grossOutputStart) * F * b - bin.inputPrefix * G * a - layer.fillInputStart * a * F,
          u1: G * a,
          ud: F * b,
          betaNum: (F - 1n) * a + (b - 1n) * F,
        }
      : {
          // N = base + floor((O + floor((r - C) * a / b)) * G / F), r = x - P
          u0: base * F * b + layer.grossOutputStart * b * G - (layer.fillInputStart + bin.inputPrefix) * a * G,
          u1: a * G,
          ud: F * b,
          betaNum: (b - 1n) * G + (F - 1n) * b,
        };
    segments.push(makeSegment(segments.length, bin, feeOnInput, 'LAYER', layerIndex, localStart, localEnd, envelope));
  });
  const absorbStart = maxBig(bin.fullInput, bin.firstLocalInput);
  if (absorbStart <= bin.lastLocalInput) {
    const envelope: DlmmSegmentEnvelope = { u0: bin.netPrefix + bin.fullNet, u1: 0n, ud: 1n, betaNum: 0n };
    segments.push(makeSegment(segments.length, bin, feeOnInput, 'ABSORB', null, absorbStart, bin.lastLocalInput, envelope));
  }
}

function validateSegments(segments: readonly DlmmCapacitySegment[], domainEnd: bigint): void {
  let expectedStart = 1n;
  let previousNet = 0n;
  for (const segment of segments) {
    const detail = { segment: String(segment.index) };
    if (segment.xStart !== expectedStart || segment.xEnd < segment.xStart) {
      fail('KERNEL_INVARIANT_VIOLATION', 'segments are not a contiguous partition', detail);
    }
    if (segment.netAtStart < previousNet || segment.netAtEnd < segment.netAtStart) {
      fail('KERNEL_INVARIANT_VIOLATION', 'net is not monotone across segments', detail);
    }
    const probes: Array<[bigint, bigint]> = [
      [segment.xStart, segment.netAtStart],
      [segment.xEnd, segment.netAtEnd],
    ];
    for (const [x, net] of probes) {
      const upper = segment.envelope.u0 + segment.envelope.u1 * x;
      const scaled = net * segment.envelope.ud;
      if (scaled > upper || scaled < upper - segment.envelope.betaNum) {
        fail('KERNEL_INVARIANT_VIOLATION', 'segment envelope does not bracket net', detail);
      }
    }
    previousNet = segment.netAtEnd;
    expectedStart = segment.xEnd + 1n;
  }
  if (expectedStart - 1n !== domainEnd) {
    fail('KERNEL_INVARIANT_VIOLATION', 'segments do not end at the domain end', { domainEnd: domainEnd.toString() });
  }
}

// ---------------------------------------------------------------- prepare

export function prepareDlmmKernel(input: DlmmKernelInput): DlmmPreparedKernel {
  const sdk = input.sdk ?? loadPinnedDlmmSdkPrimitives();
  if (input.zeroTransferFeeAdmitted !== true) {
    fail('TRANSFER_FEE_NOT_ADMITTED', 'zero transfer fee on both legs must be admitted by the caller');
  }
  if (input.programId.toBase58() !== DLMM_PROGRAM_ID) {
    fail('PROGRAM_ID_MISMATCH', 'unexpected DLMM program id', { programId: input.programId.toBase58() });
  }
  if (input.direction !== 'X_TO_Y' && input.direction !== 'Y_TO_X') {
    fail('INVALID_ARGUMENT', 'direction must be X_TO_Y or Y_TO_X');
  }
  const { lbPair, pool, programId, clock } = input;
  const swapForY = input.direction === 'X_TO_Y';
  const binStep = requireInteger('lbPair.binStep', lbPair.binStep, 1, 10_000);
  const activeId = requireInteger('lbPair.activeId', lbPair.activeId, MIN_BIN_ID, MAX_BIN_ID);
  const sParameter = lbPair.parameters;
  validateStaticParameters(sParameter);
  const lastUpdate = validateVariableParameters(lbPair.vParameters);
  validateWords('lbPair.binArrayBitmap', lbPair.binArrayBitmap, DEFAULT_BITMAP_WORDS, 'STATE_INCONSISTENT');
  validateClock(clock, lastUpdate);
  const cap = input.inputDomainEnd ?? DLMM_U64_MAX;
  if (typeof cap !== 'bigint' || cap < 1n || cap > DLMM_U64_MAX) {
    fail('INVALID_ARGUMENT', 'inputDomainEnd must be a bigint in 1..u64::MAX');
  }

  let feeOnInput: boolean;
  let supportLimitOrder: boolean;
  try {
    feeOnInput = sdk.getFeeMode(lbPair, swapForY).feeOnInput;
    supportLimitOrder = sdk.isSupportLimitOrder(lbPair);
  } catch (error) {
    fail('UNSUPPORTED_MODE', 'collectFeeMode or functionType is not supported by the pinned SDK', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (typeof feeOnInput !== 'boolean' || typeof supportLimitOrder !== 'boolean') {
    fail('UNSUPPORTED_MODE', 'SDK mode helpers returned non-boolean values');
  }

  const extension = validateBitmapExtension(sdk, input.bitmapExtension, pool, programId);
  const arrays = indexBinArrays(sdk, input.binArrays, pool, programId);

  // Single reference update at the frozen bank Clock, as swapQuote does before its bin loop.
  const referenceV = cloneVParameters(lbPair.vParameters);
  sdk.updateReference(activeId, referenceV, sParameter, Number(clock.unixTimestamp));

  const activePriceQ64 = toBig(sdk.getQPriceFromId(new BN(activeId), new BN(binStep)));
  if (activePriceQ64 <= 0n || activePriceQ64 > U128_MAX) {
    fail('ARITHMETIC_RANGE_UNSUPPORTED', 'active bin price outside (0, u128]');
  }

  const ctx: BinContext = { sdk, binStep, sParameter, swapForY, supportLimitOrder, feeOnInput, referenceV, cap };
  const bins: DlmmPreparedBin[] = [];
  const segments: DlmmCapacitySegment[] = [];
  let inputPrefix = 0n;
  let netPrefix = 0n;
  let reach = 0n;
  let parityChecks = 0;
  let coverage: DlmmCoverage = 'COMPLETE';
  let cursorId = activeId;

  scan: for (;;) {
    if (reach >= cap) {
      coverage = 'DOMAIN_CAPPED';
      break;
    }
    if (cursorId < MIN_BIN_ID || cursorId > MAX_BIN_ID) break;
    const indexBn = sdk.findNextBinArrayIndexWithLiquidity(swapForY, new BN(cursorId), lbPair, extension);
    if (indexBn === null) break;
    const index = toBig(indexBn);
    const account = arrays.get(index);
    if (account === undefined) {
      fail('BIN_ARRAY_COVERAGE_INCOMPLETE', 'bitmap marks a bin array that was not supplied', {
        binArrayIndex: index.toString(),
      });
    }
    const lower = Number(index * BIN_ARRAY_SIZE);
    const upper = lower + Number(BIN_ARRAY_SIZE) - 1;
    if (swapForY ? lower > cursorId : upper < cursorId) {
      fail('STATE_INCONSISTENT', 'bitmap navigation moved against the swap direction', {
        binArrayIndex: index.toString(),
      });
    }
    const step = swapForY ? -1 : 1;
    for (
      let binId = swapForY ? Math.min(cursorId, upper) : Math.max(cursorId, lower);
      swapForY ? binId >= lower : binId <= upper;
      binId += step
    ) {
      if (reach >= cap) {
        coverage = 'DOMAIN_CAPPED';
        break scan;
      }
      const bin = sdk.getBinFromBinArray(binId, account.account);
      const maxOut = toBig(sdk.getBinMaxAmountOut(bin, swapForY, supportLimitOrder));
      if (maxOut === 0n) continue;
      const preparedBin = prepareBin(ctx, { ordinal: bins.length, inputPrefix, netPrefix, reach }, bin, binId, index, maxOut);
      parityChecks += checkBinParity(ctx, preparedBin);
      pushBinSegments(segments, preparedBin, feeOnInput);
      bins.push(preparedBin);
      inputPrefix += preparedBin.fullInput;
      netPrefix += preparedBin.fullNet;
      if (netPrefix > DLMM_U64_MAX) {
        fail('ARITHMETIC_RANGE_UNSUPPORTED', 'cumulative output exceeds u64', { binId: String(binId) });
      }
      reach = maxBig(reach, preparedBin.handledThroughInput);
    }
    cursorId = swapForY ? lower - 1 : upper + 1;
  }

  const domainEnd = minBig(reach, cap);
  validateSegments(segments, domainEnd);
  const prepared: DlmmPreparedKernel = {
    kernelVersion: DLMM_KERNEL_VERSION,
    poolAddress: pool.toBase58(),
    direction: input.direction,
    swapForY,
    feeOnInput,
    feeUnit: feeOnInput ? 'INPUT_TOKEN' : 'OUTPUT_TOKEN',
    supportLimitOrder,
    binStep,
    activeId,
    clock: Object.freeze({ slot: clock.slot, epoch: clock.epoch, unixTimestamp: clock.unixTimestamp }),
    activePriceQ64,
    benchmarkNum: swapForY ? activePriceQ64 : DLMM_Q64,
    benchmarkDen: swapForY ? DLMM_Q64 : activePriceQ64,
    inputDomainCap: cap,
    domainEnd,
    coverage,
    extensionState: extension === null ? 'ABSENT_ATTESTED' : 'PRESENT_VALIDATED',
    sParameters: sParameter,
    referenceVParameters: referenceV,
    bins: Object.freeze(bins),
    segments: Object.freeze(segments),
    parityChecks,
    sdk,
  };
  return Object.freeze(prepared);
}

// ---------------------------------------------------------------- canonical quote

// Mirrors the swapQuote bin loop with the frozen per-bin vParameters; never uses swapQuote itself.
export function quoteDlmmExactIn(prepared: DlmmPreparedKernel, input: bigint): DlmmExactInQuote {
  if (typeof input !== 'bigint' || input < 0n) fail('INVALID_ARGUMENT', 'input must be a non-negative bigint');
  if (input > prepared.inputDomainCap) {
    fail('INPUT_OUT_OF_PREPARED_DOMAIN', 'input exceeds the prepared input domain', {
      input: input.toString(),
      cap: prepared.inputDomainCap.toString(),
    });
  }
  let remainder = input;
  let net = 0n;
  let lpFee = 0n;
  let protocolFee = 0n;
  let binsTouched = 0;
  let lastBinId: number | null = null;
  for (const bin of prepared.bins) {
    if (remainder === 0n) break;
    const quote = prepared.sdk.swapExactInQuoteAtBin(
      bin.sdkBin,
      prepared.binStep,
      prepared.sParameters,
      bin.sdkVParameters,
      toBN(remainder),
      prepared.swapForY,
      prepared.supportLimitOrder,
      prepared.feeOnInput,
    );
    const amountIn = toBig(quote.amountIn);
    if (amountIn < 0n || amountIn > remainder) {
      fail('SDK_PARITY_MISMATCH', 'bin quote consumed more than the remainder', { binId: String(bin.binId) });
    }
    if (amountIn === 0n) continue;
    remainder -= amountIn;
    net += toBig(quote.amountOut);
    lpFee += toBig(quote.fee);
    protocolFee += toBig(quote.protocolFee);
    binsTouched += 1;
    lastBinId = bin.binId;
  }
  if (remainder > 0n && prepared.coverage !== 'COMPLETE') {
    fail('KERNEL_INVARIANT_VIOLATION', 'capped preparation left an in-domain remainder');
  }
  const result: DlmmExactInQuote = {
    input,
    consumed: input - remainder,
    remainder,
    net,
    lpFee,
    protocolFee,
    tradingFee: lpFee + protocolFee,
    feeUnit: prepared.feeUnit,
    fullyConsumed: remainder === 0n,
    binsTouched,
    lastBinId,
  };
  return Object.freeze(result);
}

// ---------------------------------------------------------------- closed-form net and level inversion

function findSegmentIndex(segments: readonly DlmmCapacitySegment[], input: bigint): number {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (itemAt(segments, mid).xStart <= input) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function segmentNet(prepared: DlmmPreparedKernel, segment: DlmmCapacitySegment, input: bigint): bigint {
  const bin = itemAt(prepared.bins, segment.binOrdinal);
  return bin.netPrefix + dlmmLocalBinQuote(bin, prepared.feeOnInput, input - bin.inputPrefix).amountOut;
}

export function evaluateDlmmNetClosedForm(prepared: DlmmPreparedKernel, input: bigint): bigint {
  if (input < 1n || input > prepared.domainEnd) {
    fail('INPUT_OUT_OF_PREPARED_DOMAIN', 'closed form defined only on 1..domainEnd', { input: input.toString() });
  }
  return segmentNet(prepared, itemAt(prepared.segments, findSegmentIndex(prepared.segments, input)), input);
}

// Exact inversion of the segment floor formula: floor(y) >= t iff y >= t for integer t.
function invertWithinSegment(prepared: DlmmPreparedKernel, segment: DlmmCapacitySegment, level: bigint): bigint {
  if (segment.netAtStart >= level || segment.layerIndex === null) return segment.xStart;
  const bin = itemAt(prepared.bins, segment.binOrdinal);
  const layer = itemAt(bin.layers, segment.layerIndex);
  let local: bigint;
  if (prepared.feeOnInput) {
    const need = level - bin.netPrefix - layer.grossOutputStart;
    const fill = layer.fillInputStart + ceilDiv(need * bin.priceDen, bin.priceNum);
    local = ceilDiv(fill * DLMM_FEE_PRECISION, bin.feeComplement);
  } else {
    const grossNeeded = ceilDiv((level - bin.netPrefix) * DLMM_FEE_PRECISION, bin.feeComplement);
    const layerNeed = grossNeeded - layer.grossOutputStart;
    local = layerNeed <= 0n
      ? layer.fillInputStart
      : layer.fillInputStart + ceilDiv(layerNeed * bin.priceDen, bin.priceNum);
  }
  const input = maxBig(segment.xStart, bin.inputPrefix + local);
  if (input > segment.xEnd) {
    fail('KERNEL_INVARIANT_VIOLATION', 'level inversion left its segment', { segment: String(segment.index) });
  }
  return input;
}

// Smallest x in 1..domainEnd with N(x) >= level, or null when N(domainEnd) < level.
export function smallestDlmmInputForNet(prepared: DlmmPreparedKernel, level: bigint): bigint | null {
  const segments = prepared.segments;
  if (segments.length === 0) return null;
  if (level <= itemAt(segments, 0).netAtStart) return 1n;
  if (itemAt(segments, segments.length - 1).netAtEnd < level) return null;
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (itemAt(segments, mid).netAtEnd >= level) hi = mid;
    else lo = mid + 1;
  }
  const segment = itemAt(segments, lo);
  const input = invertWithinSegment(prepared, segment, level);
  if (segmentNet(prepared, segment, input) < level) {
    fail('KERNEL_INVARIANT_VIOLATION', 'level inversion undershoots');
  }
  if (input > 1n && evaluateDlmmNetClosedForm(prepared, input - 1n) >= level) {
    fail('KERNEL_INVARIANT_VIOLATION', 'level inversion is not minimal');
  }
  return input;
}

// ---------------------------------------------------------------- capacity solve

// Admissible(x) iff N(x) * K >= x * J with K = benchmarkDen * 10000, J = benchmarkNum * (10000 - L).
export function dlmmAdmissibilityCoefficients(
  prepared: DlmmPreparedKernel,
  lossBps: number,
): { readonly admissibilityK: bigint; readonly admissibilityJ: bigint } {
  if (!Number.isInteger(lossBps) || lossBps < 0 || lossBps > 10_000) {
    fail('INVALID_ARGUMENT', 'lossBps must be an integer in 0..10000', { lossBps: String(lossBps) });
  }
  return {
    admissibilityK: prepared.benchmarkDen * DLMM_BPS,
    admissibilityJ: prepared.benchmarkNum * (DLMM_BPS - BigInt(lossBps)),
  };
}

export function solveDlmmCapacity(
  prepared: DlmmPreparedKernel,
  lossBps: number,
  options: DlmmSolveOptions = {},
): DlmmCapacityResult {
  const { admissibilityK: k, admissibilityJ: j } = dlmmAdmissibilityCoefficients(prepared, lossBps);
  const budget = options.maxLevelJumps ?? DLMM_DEFAULT_MAX_LEVEL_JUMPS;
  if (!Number.isSafeInteger(budget) || budget < 0) fail('INVALID_ARGUMENT', 'maxLevelJumps must be a non-negative safe integer');
  const segments = prepared.segments;
  const exclusions: DlmmExclusion[] = [];
  let witness = 0n;
  let jumps = 0;
  if (prepared.domainEnd > 0n && j === 0n) {
    witness = prepared.domainEnd;
  } else if (prepared.domainEnd > 0n) {
    let hi = prepared.domainEnd;
    let si = segments.length - 1;
    while (hi >= 1n) {
      while (itemAt(segments, si).xStart > hi) si -= 1;
      const segment = itemAt(segments, si);
      const { u0, u1, ud, betaNum } = segment.envelope;
      // g(x) * ud = gamma0 + gamma1 * x where g = U*K - x*J is an upper bound of N*K - x*J.
      const gamma0 = u0 * k;
      const gamma1 = u1 * k - j * ud;
      const top = gamma1 >= 0n
        ? (gamma0 + gamma1 * hi >= 0n ? hi : segment.xStart - 1n)
        : minBig(hi, floorDiv(gamma0, -gamma1));
      if (top < hi) {
        const xLo = maxBig(top + 1n, segment.xStart);
        exclusions.push({ kind: 'ENVELOPE', segmentIndex: segment.index, xLo, xHi: hi, gamma0, gamma1 });
        hi = xLo - 1n;
        if (top < segment.xStart) continue;
      }
      if (gamma0 + gamma1 * hi >= betaNum * k) {
        witness = hi;
        break;
      }
      const net = segmentNet(prepared, segment, hi);
      if (net * k >= hi * j) {
        witness = hi;
        break;
      }
      if (jumps >= budget) {
        const unresolved: DlmmCapacityUnresolved = {
          status: 'UNRESOLVED',
          lossBps,
          reason: 'LEVEL_JUMP_BUDGET_EXHAUSTED',
          detail: `level-jump budget ${budget} exhausted; inputs 1..${hi} unresolved`,
          unresolvedInputHigh: hi,
          partialExclusions: Object.freeze(exclusions.slice()),
          levelJumps: jumps,
        };
        return Object.freeze(unresolved);
      }
      // Every x in (floor(net*K/J), hi] has N(x) <= net < x*J/K.
      const next = (net * k) / j;
      exclusions.push({ kind: 'LEVEL', xLo: next + 1n, xHi: hi, level: net });
      jumps += 1;
      hi = next;
    }
  }
  return finishSolve(prepared, lossBps, k, j, witness, exclusions, jumps);
}

function finishSolve(
  prepared: DlmmPreparedKernel,
  lossBps: number,
  k: bigint,
  j: bigint,
  witness: bigint,
  exclusions: readonly DlmmExclusion[],
  jumps: number,
): DlmmCapacityResult {
  const frozenExclusions = Object.freeze(exclusions.slice());
  const certificate = (witnessNet: bigint, minimality: DlmmMinimalityWitness | null): DlmmMaximalityCertificate =>
    Object.freeze({
      lossBps,
      admissibilityK: k,
      admissibilityJ: j,
      benchmarkNum: prepared.benchmarkNum,
      benchmarkDen: prepared.benchmarkDen,
      domainEnd: prepared.domainEnd,
      coverage: prepared.coverage,
      extensionState: prepared.extensionState,
      witnessInput: witness,
      witnessNet,
      exclusions: frozenExclusions,
      levelJumps: jumps,
      minimality,
    });
  const known = (
    maxNet: bigint,
    smallest: bigint,
    zeroReason: DlmmZeroReason | null,
    quoteAtSmallest: DlmmExactInQuote | null,
    quoteAtGreatest: DlmmExactInQuote | null,
    cert: DlmmMaximalityCertificate,
  ): DlmmCapacityResult => {
    const result: DlmmCapacityKnown = {
      status: 'KNOWN',
      lossBps,
      maxNet,
      smallestInputAttainingMax: smallest,
      greatestAdmissibleInput: witness,
      zeroReason,
      quoteAtSmallest,
      quoteAtGreatest,
      certificate: cert,
    };
    return Object.freeze(result);
  };
  const parityMismatch = (detail: string): DlmmCapacityResult => {
    const result: DlmmCapacityUnresolved = {
      status: 'UNRESOLVED',
      lossBps,
      reason: 'SDK_PARITY_MISMATCH',
      detail,
      unresolvedInputHigh: witness,
      partialExclusions: frozenExclusions,
      levelJumps: jumps,
    };
    return Object.freeze(result);
  };

  if (prepared.domainEnd === 0n) {
    if (prepared.coverage !== 'COMPLETE' || prepared.bins.length !== 0) {
      fail('KERNEL_INVARIANT_VIOLATION', 'empty domain without complete empty coverage');
    }
    return known(0n, 0n, 'NO_SELL_SIDE_LIQUIDITY', null, null, certificate(0n, null));
  }
  if (witness === 0n) {
    return known(0n, 0n, 'ALL_POSITIVE_INPUTS_INADMISSIBLE', null, null, certificate(0n, null));
  }
  const witnessNet = evaluateDlmmNetClosedForm(prepared, witness);
  if (witnessNet * k < witness * j) fail('KERNEL_INVARIANT_VIOLATION', 'accepted witness is not admissible');
  const atGreatest = quoteDlmmExactIn(prepared, witness);
  if (!atGreatest.fullyConsumed || atGreatest.net !== witnessNet) {
    return parityMismatch(`canonical quote at ${witness} differs from closed form`);
  }
  if (witnessNet === 0n) {
    return known(0n, 0n, 'ZERO_NET_AT_ALL_ADMISSIBLE_INPUTS', null, atGreatest, certificate(0n, null));
  }
  const smallest = smallestDlmmInputForNet(prepared, witnessNet);
  if (smallest === null || smallest > witness || witnessNet * k < smallest * j) {
    fail('KERNEL_INVARIANT_VIOLATION', 'minimal attaining input inconsistent with witness');
  }
  const atSmallest = quoteDlmmExactIn(prepared, smallest);
  const below = smallest > 1n ? quoteDlmmExactIn(prepared, smallest - 1n) : null;
  if (
    !atSmallest.fullyConsumed ||
    atSmallest.net !== witnessNet ||
    (below !== null && (!below.fullyConsumed || below.net >= witnessNet))
  ) {
    return parityMismatch(`canonical quote around ${smallest} differs from closed form`);
  }
  return known(
    witnessNet,
    smallest,
    null,
    atSmallest,
    atGreatest,
    certificate(witnessNet, { level: witnessNet, input: smallest, netBelow: below === null ? null : below.net }),
  );
}

// ---------------------------------------------------------------- certificate verification

// Re-checks a certificate against the prepared closed forms; oracle tests should additionally
// compare the closed form with brute-force quoteDlmmExactIn.
export function verifyDlmmMaximalityCertificate(
  prepared: DlmmPreparedKernel,
  certificate: DlmmMaximalityCertificate,
): DlmmCertificateCheck {
  const reject = (reason: string): DlmmCertificateCheck => ({ ok: false, reason });
  const { admissibilityK: k, admissibilityJ: j } = dlmmAdmissibilityCoefficients(prepared, certificate.lossBps);
  if (k !== certificate.admissibilityK || j !== certificate.admissibilityJ) return reject('admissibility coefficients');
  if (certificate.domainEnd !== prepared.domainEnd) return reject('domain end');
  let cursor = prepared.domainEnd;
  for (const exclusion of certificate.exclusions) {
    if (exclusion.xHi !== cursor || exclusion.xLo > exclusion.xHi || exclusion.xLo < 1n) {
      return reject('exclusions are not contiguous and descending');
    }
    if (exclusion.kind === 'ENVELOPE') {
      const segment = prepared.segments[exclusion.segmentIndex];
      if (segment === undefined || segment.xStart > exclusion.xLo || segment.xEnd < exclusion.xHi) {
        return reject('envelope exclusion outside its segment');
      }
      const gamma0 = segment.envelope.u0 * k;
      const gamma1 = segment.envelope.u1 * k - j * segment.envelope.ud;
      if (gamma0 !== exclusion.gamma0 || gamma1 !== exclusion.gamma1) return reject('envelope coefficients');
      if (gamma0 + gamma1 * exclusion.xLo >= 0n || gamma0 + gamma1 * exclusion.xHi >= 0n) {
        return reject('envelope exclusion not negative at both ends');
      }
    } else {
      if (evaluateDlmmNetClosedForm(prepared, exclusion.xHi) !== exclusion.level) return reject('level mismatch');
      if (exclusion.level * k >= exclusion.xLo * j) return reject('level exclusion admits its low end');
    }
    cursor = exclusion.xLo - 1n;
  }
  if (cursor !== certificate.witnessInput) return reject('exclusions do not end at the witness');
  if (certificate.witnessInput > 0n) {
    const net = evaluateDlmmNetClosedForm(prepared, certificate.witnessInput);
    if (net !== certificate.witnessNet || net * k < certificate.witnessInput * j) return reject('witness not admissible');
  } else if (certificate.witnessNet !== 0n) {
    return reject('zero witness with nonzero net');
  }
  if (certificate.minimality !== null) {
    const { level, input, netBelow } = certificate.minimality;
    if (level !== certificate.witnessNet || evaluateDlmmNetClosedForm(prepared, input) !== level) {
      return reject('minimality level');
    }
    if (input > 1n && (netBelow === null || evaluateDlmmNetClosedForm(prepared, input - 1n) !== netBelow || netBelow >= level)) {
      return reject('minimality predecessor');
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------- raw-state binding (common execliq API)
// Raw admission, deterministic key plan, exact quote wrapper and certificate mapping over the unchanged kernel.
// No network, wall clock or filesystem: account bodies are decoded by the pinned SDK IDL coder of a program
// built over a connection that throws on any use.

export const EXEC_LIQ_DLMM_VERSION = 'execliq-dlmm-sdk-1.9.14-v1' as const;

type RawbNonKnown = Exclude<RawbOutcome['status'], 'KNOWN'>;
type RawbMintAdmission = ReturnType<typeof rawbQuoteAdmission>;
type RawbMintControls = ReturnType<typeof rawbDecodeRawMintControls>;

const RAWB_LEGACY_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const RAWB_TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const RAWB_NATIVE_MINT = 'So11111111111111111111111111111111111111112';
const RAWB_CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111';
const RAWB_SYSVAR_OWNER = 'Sysvar1111111111111111111111111111111111111';
const RAWB_POOL_BYTES = 904;
const RAWB_ARRAY_BYTES = 10_136;
const RAWB_EXTENSION_BYTES = 1_576;
const RAWB_MINT_BYTES = 82;
const RAWB_TOKEN_ACCOUNT_BYTES = 165;
const RAWB_CLOCK_BYTES = 40;
const RAWB_POOL_DISCRIMINATOR = Buffer.from([33, 11, 49, 98, 181, 101, 177, 13]);
const RAWB_ARRAY_DISCRIMINATOR = Buffer.from([92, 142, 92, 220, 5, 148, 70, 181]);
const RAWB_EXTENSION_DISCRIMINATOR = Buffer.from([80, 111, 124, 113, 55, 237, 18, 5]);
const RAWB_TOKEN_X_OFFSET = 88;
const RAWB_TOKEN_Y_OFFSET = 120;
// BinArray v2 is the observed current layout; other versions stay non-KNOWN instead of being assumed compatible.
const RAWB_ADMITTED_ARRAY_VERSIONS: ReadonlySet<number> = new Set([2]);
const RAWB_BINS_PER_ARRAY = 70n;
const RAWB_MIN_ARRAY_INDEX = -6_656n;
const RAWB_MAX_ARRAY_INDEX = 6_655n;
const RAWB_EXTENSION_ROWS = 12;
const RAWB_EXTENSION_ROW_WORDS = 8;
// Only tokenX-input (swapForY) routes are parity-evidenced; tokenY-input stays non-KNOWN until separately proven.
const RAWB_REVERSE_DIRECTION_ENABLED: boolean = false;
const RAWB_ATOMIC = /^(0|[1-9][0-9]*)$/;
const RAWB_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const RAWB_SOURCE_PINS = {
  sdkPackage: '@meteora-ag/dlmm@1.9.14',
  sdkArtifactSha256: 'daeae44073c451398cd0264651539416b5358783f734668f9a2c830a2c1db8ca',
  idlSha256: '045c0f4af044be046b6a14b350077e4242e8ac026b64a855803dab30fcdd8b35',
  swapQuoteMethodSha256: 'b8eeb14c1e0c789dfebd4a7c14eb9b58d5835dbb2b127e8d4b96922e45319987',
  activationSourceSha256: '102087096e591c174ca0f361ed7d56e0085f3ee3f09d033817fcabba9617f40c',
  sourceContractSha256: '6e066c1efb41ba70fcad9f1b10dc4a81e75f8ef6de89a891a7ebbd657350793d',
  kernelSourceSha256: 'a6bc9cb53cb23b1437f4deb2a930fb88b7f9d8ee1ba3cf5ef3c9565074952c77',
} as const;
const RAWB_DUST_CONVENTION =
  'A positive input fully absorbed by input-fee rounding (for example 1 atom) is consumed with net 0 and SDK-reported fee and protocolFee 0 (splitFee early return). Trading fee fields report the SDK values exactly; fee conservation is not asserted.';

type RawbBody = { readonly bytes: Buffer; readonly owner: string; readonly lamports: number };
type RawbEntry =
  | { readonly kind: 'ABSENT' }
  | { readonly kind: 'NULL' }
  | { readonly kind: 'BODY'; readonly body: RawbBody; readonly rpc: unknown };
type RawbPool = {
  readonly lbPair: LbPair;
  readonly tokenX: string;
  readonly tokenY: string;
  readonly reserveX: string;
  readonly reserveY: string;
  readonly programFlagX: number;
  readonly programFlagY: number;
  readonly protocolFeeX: bigint;
  readonly protocolFeeY: bigint;
  readonly status: number;
  readonly pairType: number;
  readonly activationType: number;
  readonly activationPoint: bigint;
  readonly activeId: number;
  readonly binStep: number;
};
type RawbMint = {
  readonly address: string;
  readonly program: string;
  readonly decimals: number;
  readonly admission: RawbMintAdmission;
  readonly rpc: unknown;
};
type RawbVault = { readonly address: string; readonly mint: string; readonly program: string; readonly amount: bigint };
type RawbState = {
  readonly required: Set<string>;
  readonly additional: Set<string>;
  readonly mutable: Set<string>;
  open: boolean;
  route: RawbRouteMeta | null;
  pair: RawbPool | null;
  swapForY: boolean;
  mints: { readonly input: RawbMint; readonly output: RawbMint } | null;
  vaults: { readonly input: RawbVault; readonly output: RawbVault } | null;
  // undefined: extension PDA not read; null: read and observed absent.
  extension: DlmmBitmapExtensionInput | null | undefined;
  readonly arrays: BinArrayAccount[];
  readonly nullArrays: string[];
};
type RawbContext = {
  readonly plan: RoutePlan;
  readonly pool: string;
  readonly pair: RawbPool | null;
  readonly swapForY: boolean;
  readonly mints: { readonly input: RawbMint; readonly output: RawbMint } | null;
  readonly vaults: { readonly input: RawbVault; readonly output: RawbVault } | null;
  readonly extension: DlmmBitmapExtensionInput | null | undefined;
  readonly arrays: readonly BinArrayAccount[];
  readonly nullArrays: readonly string[];
};
type RawbBacking = {
  readonly grossOutput: bigint;
  readonly outputVaultAmount: bigint;
  readonly outputProtocolFee: bigint;
  readonly inputVaultAmount: bigint;
  readonly inputProtocolFee: bigint;
};
type RawbRun = { readonly ctx: RawbContext; readonly prepared: DlmmPreparedKernel; readonly backing: RawbBacking };
type RawbPoint = { readonly input: bigint; readonly net: bigint; readonly complete: boolean; readonly admissible: boolean };

// Internal non-admission signal; converted at every public boundary and never exported.
class RawbStop {
  readonly reason: RawbReason;

  constructor(reason: RawbReason) {
    this.reason = reason;
  }
}

function rawbStop(reason: RawbReason): never {
  throw new RawbStop(reason);
}

function rawbInputInvalid(): never {
  throw new Error('EXEC_LIQ_INPUT_INVALID');
}

function rawbReason(error: unknown): RawbReason {
  if (error instanceof RawbStop) return error.reason;
  if (error instanceof DlmmKernelError) {
    switch (error.code) {
      case 'UNSUPPORTED_MODE':
        return 'MODE_UNSUPPORTED';
      case 'TRANSFER_FEE_NOT_ADMITTED':
        return 'TOKEN_MODE_UNSUPPORTED';
      case 'ARITHMETIC_RANGE_UNSUPPORTED':
        return 'ARITHMETIC_RANGE';
      case 'BIN_ARRAY_COVERAGE_INCOMPLETE':
        return 'BIN_COVERAGE_INCOMPLETE';
      case 'PROGRAM_ID_MISMATCH':
      case 'BITMAP_EXTENSION_INVALID':
      case 'BIN_ARRAY_INVALID':
        return 'ACCOUNT_BINDING';
      case 'BIN_PRICE_DERIVATION_MISMATCH':
        return 'DLMM_BIN_PRICE_MISMATCH';
      case 'SDK_PARITY_MISMATCH':
        return 'DLMM_SDK_PARITY_MISMATCH';
      case 'STATE_INCONSISTENT':
        return 'DLMM_STATE_INCONSISTENT';
      case 'SDK_PRIMITIVE_MISSING':
        return 'DLMM_SDK_UNAVAILABLE';
      case 'INPUT_OUT_OF_PREPARED_DOMAIN':
        return 'DLMM_INPUT_OUT_OF_DOMAIN';
      case 'INVALID_ARGUMENT':
      case 'KERNEL_INVARIANT_VIOLATION':
        return 'DLMM_KERNEL_INVARIANT';
    }
  }
  return 'DLMM_INTERNAL_ERROR';
}

// Single mapping point from non-admission to the shared quality vocabulary.
function rawbNonKnownState(): RawbNonKnown {
  return 'MISSING';
}

function rawbIsRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rawbIsAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return false;
  try {
    return new RawbPublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

function rawbFloorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

function rawbKeyOf(value: unknown): string {
  if (value !== null && typeof value === 'object') {
    const toBase58 = (value as { toBase58?: unknown }).toBase58;
    if (typeof toBase58 === 'function') {
      const text: unknown = toBase58.call(value);
      if (rawbIsAddress(text)) return text;
    }
  }
  rawbStop('LAYOUT_UNSUPPORTED');
}

function rawbBigOf(value: unknown): bigint {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (BN.isBN(value)) return BigInt((value as BN).toString(10));
  rawbStop('LAYOUT_UNSUPPORTED');
}

function rawbIntOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) rawbStop('LAYOUT_UNSUPPORTED');
  return value;
}

function rawbRawKey(bytes: Buffer, offset: number): string {
  return new RawbPublicKey(bytes.subarray(offset, offset + 32)).toBase58();
}

// Canonical COption tag; the SPL layouts do not bound it.
function rawbOption(bytes: Buffer, offset: number): 0 | 1 {
  const tag = bytes.readUInt32LE(offset);
  if (tag !== 0 && tag !== 1) rawbStop('ACCOUNT_SHAPE');
  return tag === 1 ? 1 : 0;
}

function rawbBody(account: unknown): RawbBody {
  if (!rawbIsRecord(account)) rawbStop('ACCOUNT_SHAPE');
  const data = account.data;
  if (!Array.isArray(data) || data.length !== 2 || data[1] !== 'base64') rawbStop('ACCOUNT_SHAPE');
  const encoded: unknown = data[0];
  if (typeof encoded !== 'string' || !RAWB_BASE64.test(encoded)) rawbStop('ACCOUNT_SHAPE');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) rawbStop('ACCOUNT_SHAPE');
  const { executable, lamports, owner, rentEpoch, space } = account;
  if (executable !== false || typeof lamports !== 'number' || !Number.isSafeInteger(lamports) || lamports < 0) {
    rawbStop('ACCOUNT_SHAPE');
  }
  if (!rawbIsAddress(owner)) rawbStop('ACCOUNT_SHAPE');
  // rentEpoch is unused header metadata; RPC reports u64::MAX, which JSON numbers round, so only its type is checked.
  if (rentEpoch !== undefined && (typeof rentEpoch !== 'number' || !(rentEpoch >= 0))) rawbStop('ACCOUNT_SHAPE');
  if (space !== undefined && (typeof space !== 'number' || space !== bytes.length)) rawbStop('ACCOUNT_SHAPE');
  return { bytes, owner, lamports };
}

function rawbEntry(accounts: RawbAccountMap, key: string): RawbEntry {
  if (!Object.hasOwn(accounts, key)) return { kind: 'ABSENT' };
  const rpc: unknown = accounts[key];
  if (rpc === null) return { kind: 'NULL' };
  return { kind: 'BODY', body: rawbBody(rpc), rpc };
}

function rawbInfo(body: RawbBody): RawbAccountInfo<Buffer> {
  return { data: body.bytes, executable: false, lamports: body.lamports, owner: new RawbPublicKey(body.owner) };
}

type RawbAccountsCoder = { readonly decode: (name: string, data: Buffer) => unknown };
let rawbCoderCache: RawbAccountsCoder | null = null;

function rawbCoder(): RawbAccountsCoder {
  if (rawbCoderCache !== null) return rawbCoderCache;
  let accounts: unknown;
  try {
    const root = createRequire(import.meta.url)('@meteora-ag/dlmm') as Record<string, unknown>;
    const createProgram = root.createProgram;
    if (typeof createProgram !== 'function') rawbStop('DLMM_SDK_UNAVAILABLE');
    const offline = new Proxy(
      {},
      {
        get(_target, key) {
          if (typeof key === 'symbol' || key === 'then') return undefined;
          return () => {
            throw new Error('DLMM raw binding connection is offline');
          };
        },
      },
    );
    const program: unknown = (createProgram as (connection: unknown) => unknown)(offline);
    accounts = rawbIsRecord(program) && rawbIsRecord(program.coder) ? program.coder.accounts : undefined;
  } catch {
    rawbStop('DLMM_SDK_UNAVAILABLE');
  }
  if (!rawbIsRecord(accounts) || typeof accounts.decode !== 'function') rawbStop('DLMM_SDK_UNAVAILABLE');
  const decode = accounts.decode as (name: string, data: Buffer) => unknown;
  const owner = accounts;
  rawbCoderCache = Object.freeze({ decode: (name: string, data: Buffer): unknown => decode.call(owner, name, data) });
  return rawbCoderCache;
}

// The IDL coder checks the discriminator; camelCase is the Anchor 0.31 program-coder name, PascalCase the raw IDL name.
function rawbDecode(names: readonly string[], bytes: Buffer): Record<string, unknown> {
  const coder = rawbCoder();
  for (const name of names) {
    let decoded: unknown;
    try {
      decoded = coder.decode(name, bytes);
    } catch {
      continue;
    }
    if (rawbIsRecord(decoded)) return decoded;
  }
  rawbStop('LAYOUT_UNSUPPORTED');
}

function rawbAdmitPool(body: RawbBody): RawbPool {
  if (body.owner !== DLMM_PROGRAM_ID) rawbStop('ACCOUNT_BINDING');
  const bytes = body.bytes;
  if (bytes.length !== RAWB_POOL_BYTES || !bytes.subarray(0, 8).equals(RAWB_POOL_DISCRIMINATOR)) rawbStop('LAYOUT_UNSUPPORTED');
  const decoded = rawbDecode(['lbPair', 'LbPair'], bytes);
  const tokenX = rawbKeyOf(decoded.tokenXMint);
  const tokenY = rawbKeyOf(decoded.tokenYMint);
  if (tokenX !== rawbRawKey(bytes, RAWB_TOKEN_X_OFFSET) || tokenY !== rawbRawKey(bytes, RAWB_TOKEN_Y_OFFSET)) {
    rawbStop('LAYOUT_UNSUPPORTED');
  }
  const protocolFee = decoded.protocolFee;
  if (!rawbIsRecord(protocolFee)) rawbStop('LAYOUT_UNSUPPORTED');
  const status = rawbIntOf(decoded.status);
  const pairType = rawbIntOf(decoded.pairType);
  const binStep = rawbIntOf(decoded.binStep);
  const programFlagX = rawbIntOf(decoded.tokenMintXProgramFlag);
  const programFlagY = rawbIntOf(decoded.tokenMintYProgramFlag);
  if (status !== 0 && status !== 1) rawbStop('MODE_UNSUPPORTED');
  if (pairType < 0 || pairType > 3) rawbStop('MODE_UNSUPPORTED');
  if (binStep <= 0) rawbStop('LAYOUT_UNSUPPORTED');
  if ((programFlagX !== 0 && programFlagX !== 1) || (programFlagY !== 0 && programFlagY !== 1)) rawbStop('TOKEN_MODE_UNSUPPORTED');
  return {
    lbPair: decoded as unknown as LbPair,
    tokenX,
    tokenY,
    reserveX: rawbKeyOf(decoded.reserveX),
    reserveY: rawbKeyOf(decoded.reserveY),
    programFlagX,
    programFlagY,
    protocolFeeX: rawbBigOf(protocolFee.amountX),
    protocolFeeY: rawbBigOf(protocolFee.amountY),
    status,
    pairType,
    activationType: rawbIntOf(decoded.activationType),
    activationPoint: rawbBigOf(decoded.activationPoint),
    activeId: rawbIntOf(decoded.activeId),
    binStep,
  };
}

function rawbAdmitExtension(body: RawbBody, pool: string): BinArrayBitmapExtension {
  if (body.owner !== DLMM_PROGRAM_ID) rawbStop('ACCOUNT_BINDING');
  const bytes = body.bytes;
  if (bytes.length !== RAWB_EXTENSION_BYTES || !bytes.subarray(0, 8).equals(RAWB_EXTENSION_DISCRIMINATOR)) {
    rawbStop('LAYOUT_UNSUPPORTED');
  }
  if (rawbRawKey(bytes, 8) !== pool) rawbStop('ACCOUNT_BINDING');
  const decoded = rawbDecode(['binArrayBitmapExtension', 'BinArrayBitmapExtension'], bytes);
  if (rawbKeyOf(decoded.lbPair) !== pool) rawbStop('ACCOUNT_BINDING');
  const sideBytes = RAWB_EXTENSION_ROWS * RAWB_EXTENSION_ROW_WORDS * 8;
  const sides: readonly (readonly [unknown, number])[] = [
    [decoded.positiveBinArrayBitmap, 40],
    [decoded.negativeBinArrayBitmap, 40 + sideBytes],
  ];
  for (const [rows, base] of sides) {
    if (!Array.isArray(rows) || rows.length !== RAWB_EXTENSION_ROWS) rawbStop('LAYOUT_UNSUPPORTED');
    for (let row = 0; row < RAWB_EXTENSION_ROWS; row += 1) {
      const words: unknown = rows[row];
      if (!Array.isArray(words) || words.length !== RAWB_EXTENSION_ROW_WORDS) rawbStop('LAYOUT_UNSUPPORTED');
      for (let word = 0; word < RAWB_EXTENSION_ROW_WORDS; word += 1) {
        const raw = bytes.readBigUInt64LE(base + (row * RAWB_EXTENSION_ROW_WORDS + word) * 8);
        if (rawbBigOf(words[word]) !== raw) rawbStop('LAYOUT_UNSUPPORTED');
      }
    }
  }
  return decoded as unknown as BinArrayBitmapExtension;
}

function rawbAdmitArray(body: RawbBody, pool: string, index: bigint): BinArrayAccount['account'] {
  if (body.owner !== DLMM_PROGRAM_ID) rawbStop('ACCOUNT_BINDING');
  const bytes = body.bytes;
  if (bytes.length !== RAWB_ARRAY_BYTES || !bytes.subarray(0, 8).equals(RAWB_ARRAY_DISCRIMINATOR)) rawbStop('LAYOUT_UNSUPPORTED');
  const version = bytes.readUInt8(16);
  if (bytes.readBigInt64LE(8) !== index || rawbRawKey(bytes, 24) !== pool) rawbStop('ACCOUNT_BINDING');
  if (!RAWB_ADMITTED_ARRAY_VERSIONS.has(version)) rawbStop('LAYOUT_UNSUPPORTED');
  const decoded = rawbDecode(['binArray', 'BinArray'], bytes);
  if (rawbBigOf(decoded.index) !== index || rawbIntOf(decoded.version) !== version || rawbKeyOf(decoded.lbPair) !== pool) {
    rawbStop('LAYOUT_UNSUPPORTED');
  }
  if (!Array.isArray(decoded.bins) || decoded.bins.length !== Number(RAWB_BINS_PER_ARRAY)) rawbStop('LAYOUT_UNSUPPORTED');
  return decoded as unknown as BinArrayAccount['account'];
}

function rawbFlagProgram(flag: number): string {
  return flag === 0 ? RAWB_LEGACY_TOKEN : RAWB_TOKEN_2022;
}

// The frozen helper requires the JSON-RPC result envelope; its context slot is the actual bank slot.
function rawbMintControls(rpc: unknown, slot: number): RawbMintControls {
  try {
    return rawbDecodeRawMintControls({ context: { slot }, value: rpc });
  } catch {
    rawbStop('TOKEN_MODE_UNSUPPORTED');
  }
}

function rawbAdmitMint(entry: { readonly body: RawbBody; readonly rpc: unknown }, address: string, expectedProgram: string): RawbMint {
  const { body, rpc } = entry;
  if (body.owner !== RAWB_LEGACY_TOKEN && body.owner !== RAWB_TOKEN_2022) rawbStop('TOKEN_MODE_UNSUPPORTED');
  if (body.owner !== expectedProgram) rawbStop('ACCOUNT_BINDING');
  const bytes = body.bytes;
  // Raw guards first: MintLayout reads isInitialized=2 as true and does not bound the COption tags.
  if (bytes.length < RAWB_MINT_BYTES || bytes.readUInt8(45) !== 1) rawbStop('ACCOUNT_SHAPE');
  rawbOption(bytes, 0);
  rawbOption(bytes, 46);
  let admission: RawbMintAdmission;
  try {
    admission = rawbQuoteAdmission(rawbInfo(body));
  } catch {
    rawbStop('TOKEN_MODE_UNSUPPORTED');
  }
  return { address, program: body.owner, decimals: bytes.readUInt8(44), admission, rpc };
}

function rawbAdmitVault(body: RawbBody, address: string, mint: RawbMint, pool: string): RawbVault {
  if (body.owner !== mint.program) rawbStop('ACCOUNT_BINDING');
  const bytes = body.bytes;
  if (bytes.length < RAWB_TOKEN_ACCOUNT_BYTES) rawbStop('ACCOUNT_SHAPE');
  // Raw guards first: AccountLayout coerces state 3 and native option 2.
  const accountState = bytes.readUInt8(108);
  if (accountState === 2) rawbStop('TOKEN_MODE_UNSUPPORTED');
  if (accountState !== 1) rawbStop('ACCOUNT_SHAPE');
  const delegateOption = rawbOption(bytes, 72);
  const nativeOption = rawbOption(bytes, 109);
  const closeOption = rawbOption(bytes, 129);
  if (rawbRawKey(bytes, 0) !== mint.address || rawbRawKey(bytes, 32) !== pool) rawbStop('ACCOUNT_BINDING');
  if (delegateOption !== 0 || closeOption !== 0 || bytes.readBigUInt64LE(121) !== 0n) rawbStop('TOKEN_MODE_UNSUPPORTED');
  const amount = bytes.readBigUInt64LE(64);
  if (mint.address === RAWB_NATIVE_MINT && mint.program === RAWB_LEGACY_TOKEN) {
    // Wrapped SOL: lamports must back amount plus the rent reserve; surplus lamports are not token balance.
    if (nativeOption !== 1) rawbStop('TOKEN_MODE_UNSUPPORTED');
    if (BigInt(body.lamports) < amount + bytes.readBigUInt64LE(113)) rawbStop('DLMM_NATIVE_VAULT_UNDERFUNDED');
  } else if (nativeOption !== 0) {
    rawbStop('TOKEN_MODE_UNSUPPORTED');
  }
  try {
    rawbValidateVaultData(rawbInfo(body), mint.admission);
  } catch {
    rawbStop('TOKEN_MODE_UNSUPPORTED');
  }
  return { address, mint: mint.address, program: mint.program, amount };
}

function rawbReservePda(pool: RawbPublicKey, mint: string, program: RawbPublicKey): string {
  return RawbPublicKey.findProgramAddressSync([pool.toBuffer(), new RawbPublicKey(mint).toBuffer()], program)[0].toBase58();
}

// Every directional set bit, via the SDK index search; each step resumes one bin past the array just found.
function rawbWalkBitmap(
  sdk: DlmmSdkPrimitives,
  swapForY: boolean,
  pair: RawbPool,
  extension: BinArrayBitmapExtension | null,
  found: bigint[],
): void {
  let cursor = BigInt(pair.activeId);
  const limit = Number(RAWB_MAX_ARRAY_INDEX - RAWB_MIN_ARRAY_INDEX) + 2;
  for (let step = 0; step < limit; step += 1) {
    const next: unknown = sdk.findNextBinArrayIndexWithLiquidity(swapForY, new BN(cursor.toString()), pair.lbPair, extension);
    if (next === null || next === undefined) return;
    const index = rawbBigOf(next);
    const last = found.length > 0 ? found[found.length - 1] : undefined;
    const cursorIndex = rawbFloorDiv(cursor, RAWB_BINS_PER_ARRAY);
    if (
      index < RAWB_MIN_ARRAY_INDEX ||
      index > RAWB_MAX_ARRAY_INDEX ||
      (swapForY ? index > cursorIndex : index < cursorIndex) ||
      (last !== undefined && (swapForY ? index >= last : index <= last))
    ) {
      rawbStop('DLMM_BITMAP_ENUMERATION');
    }
    found.push(index);
    if (index === (swapForY ? RAWB_MIN_ARRAY_INDEX : RAWB_MAX_ARRAY_INDEX)) return;
    cursor = swapForY ? index * RAWB_BINS_PER_ARRAY - 1n : (index + 1n) * RAWB_BINS_PER_ARRAY;
  }
  rawbStop('DLMM_BITMAP_ENUMERATION');
}

function rawbEnumerate(
  sdk: DlmmSdkPrimitives,
  swapForY: boolean,
  pair: RawbPool,
  extension: DlmmBitmapExtensionInput | null | undefined,
): bigint[] {
  const found: bigint[] = [];
  try {
    rawbWalkBitmap(sdk, swapForY, pair, extension ? extension.account : null, found);
  } catch (error) {
    // An unread extension keeps the plan open; the default-bitmap prefix found so far is still planned.
    if (extension === undefined) return found;
    if (error instanceof RawbStop) throw error;
    rawbStop('DLMM_BITMAP_ENUMERATION');
  }
  return found;
}

function rawbRun(s: RawbState, pool: string, target: string, accounts: RawbAccountMap): void {
  const poolEntry = rawbEntry(accounts, pool);
  if (poolEntry.kind === 'ABSENT') {
    s.open = true;
    return;
  }
  if (poolEntry.kind === 'NULL') rawbStop('ACCOUNT_NULL');
  const pair = rawbAdmitPool(poolEntry.body);
  if (pair.tokenX === pair.tokenY) rawbStop('ACCOUNT_BINDING');
  const swapForY = pair.tokenX === target ? true : pair.tokenY === target ? false : rawbStop('NOT_TARGET_ROUTE');
  const sdk = loadPinnedDlmmSdkPrimitives();
  const programKey = new RawbPublicKey(DLMM_PROGRAM_ID);
  const poolKey = new RawbPublicKey(pool);
  if (pair.reserveX !== rawbReservePda(poolKey, pair.tokenX, programKey) || pair.reserveY !== rawbReservePda(poolKey, pair.tokenY, programKey)) {
    rawbStop('ACCOUNT_BINDING');
  }
  const extensionKey = sdk.deriveBinArrayBitmapExtension(poolKey, programKey)[0].toBase58();
  for (const key of [pair.tokenX, pair.tokenY, pair.reserveX, pair.reserveY, extensionKey]) {
    if (s.required.has(key)) rawbStop('ACCOUNT_BINDING');
    s.required.add(key);
  }
  s.mutable.add(pair.reserveX);
  s.mutable.add(pair.reserveY);
  s.mutable.add(extensionKey);
  const inputMint = swapForY ? pair.tokenX : pair.tokenY;
  const outputMint = swapForY ? pair.tokenY : pair.tokenX;
  const inputVault = swapForY ? pair.reserveX : pair.reserveY;
  const outputVault = swapForY ? pair.reserveY : pair.reserveX;
  const inputFlag = swapForY ? pair.programFlagX : pair.programFlagY;
  const outputFlag = swapForY ? pair.programFlagY : pair.programFlagX;
  const routeBase: RawbRouteMeta = {
    outputMint,
    direction: swapForY ? 'FIRST_TO_SECOND' : 'SECOND_TO_FIRST',
    vaults: { input: inputVault, output: outputVault },
    tokenPrograms: null,
  };
  s.pair = pair;
  s.swapForY = swapForY;
  s.route = routeBase;
  if (pair.status !== 0) rawbStop('ROUTE_DISABLED');
  if ((pair.pairType === 1 || pair.pairType === 2) && pair.activationType !== 0 && pair.activationType !== 1) {
    rawbStop('MODE_UNSUPPORTED');
  }
  if (!swapForY && !RAWB_REVERSE_DIRECTION_ENABLED) rawbStop('DLMM_REVERSE_DIRECTION_UNPROVED');

  const extensionEntry = rawbEntry(accounts, extensionKey);
  if (extensionEntry.kind === 'ABSENT') {
    s.open = true;
    s.extension = undefined;
  } else if (extensionEntry.kind === 'NULL') {
    s.extension = null;
  } else {
    s.extension = { publicKey: new RawbPublicKey(extensionKey), account: rawbAdmitExtension(extensionEntry.body, pool) };
  }
  const plannedArrays: (readonly [bigint, string])[] = [];
  for (const index of rawbEnumerate(sdk, swapForY, pair, s.extension)) {
    const key = sdk.deriveBinArray(poolKey, new BN(index.toString()), programKey)[0].toBase58();
    if (s.required.has(key) || s.additional.has(key)) rawbStop('ACCOUNT_BINDING');
    s.additional.add(key);
    s.mutable.add(key);
    plannedArrays.push([index, key]);
  }

  const inputMintEntry = rawbEntry(accounts, inputMint);
  const outputMintEntry = rawbEntry(accounts, outputMint);
  if (inputMintEntry.kind === 'NULL' || outputMintEntry.kind === 'NULL') rawbStop('ACCOUNT_NULL');
  const inMint = inputMintEntry.kind === 'BODY' ? rawbAdmitMint(inputMintEntry, inputMint, rawbFlagProgram(inputFlag)) : null;
  const outMint = outputMintEntry.kind === 'BODY' ? rawbAdmitMint(outputMintEntry, outputMint, rawbFlagProgram(outputFlag)) : null;
  if (inMint !== null && outMint !== null) {
    s.mints = { input: inMint, output: outMint };
    s.route = { ...routeBase, tokenPrograms: { input: inMint.program, output: outMint.program } };
  } else {
    s.open = true;
  }

  const inputVaultEntry = rawbEntry(accounts, inputVault);
  const outputVaultEntry = rawbEntry(accounts, outputVault);
  if (inputVaultEntry.kind === 'NULL' || outputVaultEntry.kind === 'NULL') rawbStop('ACCOUNT_NULL');
  const inVault = inMint !== null && inputVaultEntry.kind === 'BODY' ? rawbAdmitVault(inputVaultEntry.body, inputVault, inMint, pool) : null;
  const outVault = outMint !== null && outputVaultEntry.kind === 'BODY' ? rawbAdmitVault(outputVaultEntry.body, outputVault, outMint, pool) : null;
  if (inVault !== null && outVault !== null) s.vaults = { input: inVault, output: outVault };

  for (const [index, key] of plannedArrays) {
    const entry = rawbEntry(accounts, key);
    if (entry.kind === 'NULL') s.nullArrays.push(key);
    else if (entry.kind === 'BODY') s.arrays.push({ publicKey: new RawbPublicKey(key), account: rawbAdmitArray(entry.body, pool, index) });
  }
}

// Never throws for raw state: any non-admission becomes plan.rejected with the keys planned so far.
function rawbAnalyze(pool: string, target: string, accounts: RawbAccountMap): RawbContext {
  const s: RawbState = {
    required: new Set([pool]),
    additional: new Set(),
    mutable: new Set([pool]),
    open: false,
    route: null,
    pair: null,
    swapForY: true,
    mints: null,
    vaults: null,
    extension: undefined,
    arrays: [],
    nullArrays: [],
  };
  let rejected: RawbReason | null = null;
  try {
    rawbRun(s, pool, target, accounts);
  } catch (error) {
    rejected = rawbReason(error);
  }
  const requiredKeys = [...s.required].sort();
  const additionalKeys = [...s.additional].filter((key) => !s.required.has(key)).sort();
  const planned = new Set([...requiredKeys, ...additionalKeys]);
  const missingKeys = [...planned].filter((key) => !Object.hasOwn(accounts, key)).sort();
  const nullKeys = [...planned].filter((key) => Object.hasOwn(accounts, key) && accounts[key] === null).sort();
  const mutableKeys = [...s.mutable].filter((key) => planned.has(key)).sort();
  const plan: RoutePlan = {
    venue: 'DLMM',
    programId: DLMM_PROGRAM_ID,
    pool,
    targetMint: target,
    route: s.route,
    requiredKeys,
    additionalKeys,
    missingKeys,
    nullKeys,
    open: rejected === null && s.open,
    mutableKeys,
    rejected,
  };
  return {
    plan,
    pool,
    pair: s.pair,
    swapForY: s.swapForY,
    mints: s.mints,
    vaults: s.vaults,
    extension: s.extension,
    arrays: s.arrays,
    nullArrays: s.nullArrays,
  };
}

function rawbCheckClock(bank: RawbBank): void {
  const clock: unknown = bank.clock;
  if (!rawbIsRecord(clock)) rawbStop('CLOCK_MISMATCH');
  for (const field of ['slot', 'epochStartTimestamp', 'epoch', 'leaderScheduleEpoch', 'unixTimestamp'] as const) {
    const value = clock[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) rawbStop('CLOCK_MISMATCH');
  }
  const c = bank.clock;
  if (c.slot < 0 || c.epoch < 0 || c.leaderScheduleEpoch < 0 || c.unixTimestamp < 0 || c.slot !== bank.slot) rawbStop('CLOCK_MISMATCH');
  const entry = rawbEntry(bank.accounts, RAWB_CLOCK_SYSVAR);
  if (entry.kind === 'ABSENT') return;
  if (entry.kind === 'NULL') rawbStop('CLOCK_MISMATCH');
  const { owner, bytes } = entry.body;
  if (owner !== RAWB_SYSVAR_OWNER) rawbStop('ACCOUNT_BINDING');
  if (bytes.length !== RAWB_CLOCK_BYTES) rawbStop('ACCOUNT_SHAPE');
  if (
    bytes.readBigUInt64LE(0) !== BigInt(c.slot) ||
    bytes.readBigInt64LE(8) !== BigInt(c.epochStartTimestamp) ||
    bytes.readBigUInt64LE(16) !== BigInt(c.epoch) ||
    bytes.readBigUInt64LE(24) !== BigInt(c.leaderScheduleEpoch) ||
    bytes.readBigInt64LE(32) !== BigInt(c.unixTimestamp)
  ) {
    rawbStop('CLOCK_MISMATCH');
  }
}

// commons quote.rs validate_swap_activation: enabled status always; activation point only for pair types 1 and 2.
function rawbCheckActivation(pair: RawbPool, clock: RawbClock): void {
  if (pair.status !== 0) rawbStop('ROUTE_DISABLED');
  if (pair.pairType !== 1 && pair.pairType !== 2) return;
  const point =
    pair.activationType === 0 ? BigInt(clock.slot) : pair.activationType === 1 ? BigInt(clock.unixTimestamp) : rawbStop('MODE_UNSUPPORTED');
  if (point < pair.activationPoint) rawbStop('ROUTE_DISABLED');
}

function rawbPrepare(ctx: RawbContext, bank: RawbBank): RawbRun {
  const plan = ctx.plan;
  if (plan.rejected !== null) rawbStop(plan.rejected);
  if (plan.missingKeys.length > 0) rawbStop(plan.open ? 'KEY_SET_OPEN' : 'ACCOUNT_NOT_READ');
  if (ctx.nullArrays.length > 0) rawbStop('BIN_COVERAGE_INCOMPLETE');
  const { pair, mints, vaults, extension } = ctx;
  if (pair === null || mints === null || vaults === null || extension === undefined) rawbStop('DLMM_INTERNAL_ERROR');
  rawbCheckClock(bank);
  // Target-mint controls need the bank context slot, so they are gated here rather than in context-free planning.
  const controls = rawbMintControls(mints.input.rpc, bank.slot);
  if (!controls.complete || !controls.transferAllowed || !controls.surfaceSupported || controls.currentFeeBps !== '0' || !controls.feeImmutable) {
    rawbStop('TOKEN_MODE_UNSUPPORTED');
  }
  rawbCheckActivation(pair, bank.clock);
  const inputProtocolFee = ctx.swapForY ? pair.protocolFeeX : pair.protocolFeeY;
  const outputProtocolFee = ctx.swapForY ? pair.protocolFeeY : pair.protocolFeeX;
  if (inputProtocolFee > vaults.input.amount) rawbStop('DLMM_INPUT_VAULT_BELOW_PROTOCOL_FEE');
  if (outputProtocolFee > vaults.output.amount) rawbStop('OUTPUT_BACKING_INSUFFICIENT');
  const prepared = prepareDlmmKernel({
    programId: new RawbPublicKey(DLMM_PROGRAM_ID),
    pool: new RawbPublicKey(ctx.pool),
    lbPair: pair.lbPair,
    binArrays: ctx.arrays,
    bitmapExtension: extension,
    clock: { slot: BigInt(bank.clock.slot), epoch: BigInt(bank.clock.epoch), unixTimestamp: BigInt(bank.clock.unixTimestamp) },
    direction: ctx.swapForY ? 'X_TO_Y' : 'Y_TO_X',
    zeroTransferFeeAdmitted: true,
  });
  if (
    prepared.swapForY !== ctx.swapForY ||
    prepared.poolAddress !== ctx.pool ||
    (extension === null) !== (prepared.extensionState === 'ABSENT_ATTESTED')
  ) {
    rawbStop('DLMM_KERNEL_INVARIANT');
  }
  // Bin principal already excludes protocol fees, so all directional gross layer output must fit the output vault
  // after the standing protocol-fee liability; quoted net is never reduced by that liability a second time.
  let grossOutput = 0n;
  for (const bin of prepared.bins) for (const layer of bin.layers) grossOutput += layer.amountOut;
  if (vaults.output.amount - outputProtocolFee < grossOutput) rawbStop('OUTPUT_BACKING_INSUFFICIENT');
  return {
    ctx,
    prepared,
    backing: {
      grossOutput,
      outputVaultAmount: vaults.output.amount,
      outputProtocolFee,
      inputVaultAmount: vaults.input.amount,
      inputProtocolFee,
    },
  };
}

function rawbVaultBalance(vault: RawbVault): RawbVaultBalance {
  return { address: vault.address, mint: vault.mint, tokenProgram: vault.program, amountAtoms: vault.amount.toString(10) };
}

// p0 is the initial active-bin Q64 price only, in output atoms per input atom, unreduced.
function rawbFacts(ctx: RawbContext): RawbFacts | null {
  const { pair, mints, vaults } = ctx;
  if (pair === null || mints === null || vaults === null) return null;
  let price: bigint;
  try {
    price = rawbBigOf(loadPinnedDlmmSdkPrimitives().getQPriceFromId(new BN(pair.activeId), new BN(pair.binStep)));
  } catch {
    return null;
  }
  if (price <= 0n) return null;
  const p0 = ctx.swapForY
    ? { num: price.toString(10), den: DLMM_Q64.toString(10) }
    : { num: DLMM_Q64.toString(10), den: price.toString(10) };
  return {
    p0,
    decimals: { input: mints.input.decimals, output: mints.output.decimals },
    vaults: { input: rawbVaultBalance(vaults.input), output: rawbVaultBalance(vaults.output) },
  };
}

function rawbNotKnown(reasons: readonly [RawbReason, ...RawbReason[]], facts: RawbFacts | null): RawbOutcome {
  return { status: rawbNonKnownState(), reasons, facts, certificate: null };
}

// Exact re-quote; null only above the prepared domain end when the kernel declines the point.
function rawbPoint(prepared: DlmmPreparedKernel, input: bigint, k: bigint, j: bigint): RawbPoint | null {
  let quote: DlmmExactInQuote;
  try {
    quote = quoteDlmmExactIn(prepared, input);
  } catch (error) {
    if (input > prepared.domainEnd) return null;
    throw error;
  }
  if (quote.input !== input || quote.consumed > input) rawbStop('DLMM_KERNEL_INVARIANT');
  const complete = quote.fullyConsumed && quote.consumed === input;
  return { input, net: quote.net, complete, admissible: complete && quote.net * k >= input * j };
}

function rawbPointWithin(prepared: DlmmPreparedKernel, input: bigint, k: bigint, j: bigint): RawbPoint {
  const point = rawbPoint(prepared, input, k, j);
  if (point === null || !point.complete) rawbStop('MAX_UNPROVED');
  return point;
}

function rawbDiagnostics(run: RawbRun, result: DlmmCapacityKnown, k: bigint, j: bigint): { readonly [key: string]: RawbJson } {
  const p = run.prepared;
  const c = result.certificate;
  const text = (value: bigint): string => value.toString(10);
  return {
    method: 'DLMM_EXACT_IN_SEGMENT_ENVELOPE_LEVEL_SEARCH',
    adapterVersion: EXEC_LIQ_DLMM_VERSION,
    kernelVersion: p.kernelVersion,
    sourcePins: RAWB_SOURCE_PINS,
    pool: p.poolAddress,
    direction: p.direction,
    swapForY: p.swapForY,
    feeOnInput: p.feeOnInput,
    feeUnit: p.feeUnit,
    supportLimitOrder: p.supportLimitOrder,
    binStep: p.binStep,
    activeId: p.activeId,
    clock: { slot: text(p.clock.slot), epoch: text(p.clock.epoch), unixTimestamp: text(p.clock.unixTimestamp) },
    activePriceQ64: text(p.activePriceQ64),
    benchmark: { num: text(p.benchmarkNum), den: text(p.benchmarkDen) },
    inputDomainCap: text(p.inputDomainCap),
    domainEnd: text(p.domainEnd),
    coverage: p.coverage,
    extensionState: p.extensionState,
    extensionAddress: run.ctx.extension ? run.ctx.extension.publicKey.toBase58() : null,
    binArrays: run.ctx.arrays.map((entry) => ({ address: entry.publicKey.toBase58(), index: text(rawbBigOf(entry.account.index)) })),
    parityChecks: p.parityChecks,
    transferFees: { inputAtoms: '0', outputAtoms: '0', admission: 'ORDINARY_ZERO_TRANSFER_FEE_LEGS' },
    backing: {
      grossOutputAtoms: text(run.backing.grossOutput),
      outputVaultAtoms: text(run.backing.outputVaultAmount),
      outputProtocolFeeAtoms: text(run.backing.outputProtocolFee),
      inputVaultAtoms: text(run.backing.inputVaultAmount),
      inputProtocolFeeAtoms: text(run.backing.inputProtocolFee),
    },
    lossBps: c.lossBps,
    admissibilityK: text(k),
    admissibilityJ: text(j),
    maxNet: text(result.maxNet),
    kernelSmallestInputAttainingMax: text(result.smallestInputAttainingMax),
    greatestAdmissibleInput: text(result.greatestAdmissibleInput),
    kernelZeroReason: result.zeroReason,
    levelJumps: c.levelJumps,
    witnessInput: text(c.witnessInput),
    witnessNet: text(c.witnessNet),
    exclusions: c.exclusions.map((e): RawbJson =>
      e.kind === 'ENVELOPE'
        ? { kind: e.kind, segmentIndex: e.segmentIndex, xLo: text(e.xLo), xHi: text(e.xHi), gamma0: text(e.gamma0), gamma1: text(e.gamma1) }
        : { kind: e.kind, xLo: text(e.xLo), xHi: text(e.xHi), level: text(e.level) },
    ),
    minimality:
      c.minimality === null
        ? null
        : {
            level: text(c.minimality.level),
            input: text(c.minimality.input),
            netBelow: c.minimality.netBelow === null ? null : text(c.minimality.netBelow),
          },
    dustConvention: RAWB_DUST_CONVENTION,
    bins: p.bins.map((bin) => ({
      ordinal: bin.ordinal,
      binId: bin.binId,
      binArrayIndex: text(bin.binArrayIndex),
      priceQ64: text(bin.priceQ64),
      priceNum: text(bin.priceNum),
      priceDen: text(bin.priceDen),
      feeNumerator: text(bin.feeNumerator),
      feeComplement: text(bin.feeComplement),
      volatilityAccumulator: bin.volatilityAccumulator,
      layers: bin.layers.map((layer) => ({
        kind: layer.kind,
        amountOut: text(layer.amountOut),
        inputCap: text(layer.inputCap),
        fillInputStart: text(layer.fillInputStart),
        grossOutputStart: text(layer.grossOutputStart),
      })),
      fillCapacity: text(bin.fillCapacity),
      grossCapacity: text(bin.grossCapacity),
      fullInput: text(bin.fullInput),
      absorbEnd: text(bin.absorbEnd),
      fullNet: text(bin.fullNet),
      inputPrefix: text(bin.inputPrefix),
      netPrefix: text(bin.netPrefix),
      handledAfterInput: text(bin.handledAfterInput),
      handledThroughInput: text(bin.handledThroughInput),
      firstLocalInput: text(bin.firstLocalInput),
      lastLocalInput: text(bin.lastLocalInput),
      shadowed: bin.shadowed,
    })),
    segments: p.segments.map((segment) => ({
      index: segment.index,
      binOrdinal: segment.binOrdinal,
      binId: segment.binId,
      kind: segment.kind,
      layerIndex: segment.layerIndex,
      layerKind: segment.layerKind,
      xStart: text(segment.xStart),
      xEnd: text(segment.xEnd),
      netAtStart: text(segment.netAtStart),
      netAtEnd: text(segment.netAtEnd),
      envelope: {
        u0: text(segment.envelope.u0),
        u1: text(segment.envelope.u1),
        ud: text(segment.envelope.ud),
        betaNum: text(segment.envelope.betaNum),
      },
    })),
  };
}

function rawbKnown(run: RawbRun, result: DlmmCapacityKnown, lossBps: number, facts: RawbFacts | null): RawbOutcome {
  const prepared = run.prepared;
  const certificate = result.certificate;
  if (facts === null || result.lossBps !== lossBps || certificate.lossBps !== lossBps) rawbStop('MAX_UNPROVED');
  const q64 = DLMM_Q64.toString(10);
  const activeQ64 = prepared.activePriceQ64.toString(10);
  if (run.ctx.swapForY ? facts.p0.num !== activeQ64 || facts.p0.den !== q64 : facts.p0.num !== q64 || facts.p0.den !== activeQ64) {
    rawbStop('DLMM_KERNEL_INVARIANT');
  }
  if (certificate.coverage !== prepared.coverage || certificate.domainEnd !== prepared.domainEnd) rawbStop('MAX_UNPROVED');
  if (prepared.coverage !== 'COMPLETE' && prepared.coverage !== 'DOMAIN_CAPPED') rawbStop('MAX_UNPROVED');
  if (!verifyDlmmMaximalityCertificate(prepared, certificate).ok) rawbStop('MAX_UNPROVED');
  const { admissibilityK: k, admissibilityJ: j } = dlmmAdmissibilityCoefficients(prepared, lossBps);
  if (k !== certificate.admissibilityK || j !== certificate.admissibilityJ || k <= 0n || j < 0n) rawbStop('MAX_UNPROVED');
  const end = prepared.domainEnd;
  const maxNet = result.maxNet;
  const greatest = result.greatestAdmissibleInput;
  // A zero route sells nothing: no positive input is reported as the chosen point.
  const chosen = maxNet > 0n ? result.smallestInputAttainingMax : 0n;
  if (maxNet < 0n || end < 0n || end > DLMM_U64_MAX || greatest < 0n || greatest > end || chosen > greatest) rawbStop('MAX_UNPROVED');

  const witnesses: RawbWitness[] = [];
  const add = (role: RawbWitness['role'], point: RawbPoint): void => {
    witnesses.push({
      role,
      inputAtoms: point.input.toString(10),
      netAtoms: point.net.toString(10),
      complete: point.complete,
      admissible: point.admissible,
    });
  };
  if (maxNet > 0n) {
    if (result.zeroReason !== null || chosen < 1n) rawbStop('MAX_UNPROVED');
    const atChosen = rawbPointWithin(prepared, chosen, k, j);
    if (!atChosen.admissible || atChosen.net !== maxNet) rawbStop('MAX_UNPROVED');
    add('CHOSEN', atChosen);
    if (chosen > 1n) {
      const below = rawbPointWithin(prepared, chosen - 1n, k, j);
      if (below.net >= maxNet) rawbStop('MAX_UNPROVED');
      add('BELOW_CHOSEN', below);
    }
    const atGreatest = rawbPointWithin(prepared, greatest, k, j);
    if (!atGreatest.admissible || atGreatest.net !== maxNet) rawbStop('MAX_UNPROVED');
    add('MAX_ADMISSIBLE', atGreatest);
  } else {
    if (result.zeroReason === null || chosen !== 0n) rawbStop('MAX_UNPROVED');
    const atChosen = rawbPointWithin(prepared, 0n, k, j);
    if (!atChosen.admissible || atChosen.net !== 0n) rawbStop('MAX_UNPROVED');
    add('CHOSEN', atChosen);
    if (greatest > 0n) {
      const atGreatest = rawbPointWithin(prepared, greatest, k, j);
      if (!atGreatest.admissible || atGreatest.net !== 0n) rawbStop('MAX_UNPROVED');
      add('MAX_ADMISSIBLE', atGreatest);
    }
  }
  if (greatest < DLMM_U64_MAX) {
    const above = rawbPoint(prepared, greatest + 1n, k, j);
    if (above !== null) {
      if (above.admissible) rawbStop('MAX_UNPROVED');
      add('ABOVE_MAX_ADMISSIBLE', above);
    }
  }
  if (end >= 1n) add('DOMAIN_END', rawbPointWithin(prepared, end, k, j));
  if (prepared.coverage === 'COMPLETE' && end < DLMM_U64_MAX) {
    const beyond = rawbPoint(prepared, end + 1n, k, j);
    if (beyond !== null) {
      if (beyond.complete) rawbStop('MAX_UNPROVED');
      add('BOUNDARY', beyond);
    }
  }

  const zero: RawbZeroReason | null =
    maxNet > 0n
      ? null
      : result.zeroReason === 'NO_SELL_SIDE_LIQUIDITY'
        ? 'EMPTY_OUTPUT_SIDE'
        : result.zeroReason === 'ZERO_NET_AT_ALL_ADMISSIBLE_INPUTS'
          ? 'ZERO_LIQUIDITY'
          : 'NO_ADMISSIBLE_INPUT';
  const capacityCertificate: RawbCertificate = {
    kind: 'DLMM_EXACT_IN_LEVEL_SEARCH',
    maximal: true,
    domainEndAtoms: prepared.coverage === 'COMPLETE' ? end.toString(10) : null,
    witnesses,
    diagnostics: rawbDiagnostics(run, result, k, j),
  };
  return {
    status: 'KNOWN',
    netAtoms: maxNet.toString(10),
    inputAtoms: chosen.toString(10),
    maxAdmissibleInputAtoms: greatest > 0n ? greatest.toString(10) : null,
    zero,
    facts,
    certificate: capacityCertificate,
  };
}

function rawbSolveOutcome(ctx: RawbContext, bank: RawbBank, lossBps: number): RawbOutcome {
  const facts = rawbFacts(ctx);
  try {
    const run = rawbPrepare(ctx, bank);
    const result = solveDlmmCapacity(run.prepared, lossBps);
    if (result.status === 'UNRESOLVED') {
      const reasons: readonly [RawbReason, ...RawbReason[]] =
        result.reason === 'LEVEL_JUMP_BUDGET_EXHAUSTED' ? ['MAX_UNPROVED', 'DLMM_LEVEL_JUMP_BUDGET_EXHAUSTED'] : ['DLMM_SDK_PARITY_MISMATCH'];
      return rawbNotKnown(reasons, facts);
    }
    return rawbKnown(run, result, lossBps, facts);
  } catch (error) {
    return rawbNotKnown([rawbReason(error)], facts);
  }
}

function rawbRouteInput(input: { readonly token: ExecLiqPlanInput['token']; readonly pool: string }): { readonly pool: string; readonly target: string } {
  const value: unknown = input;
  if (!rawbIsRecord(value)) rawbInputInvalid();
  const pool = value.pool;
  const token = value.token;
  if (!rawbIsAddress(pool) || !rawbIsRecord(token)) rawbInputInvalid();
  const target = token.address;
  if (!rawbIsAddress(target) || target === pool) rawbInputInvalid();
  return { pool, target };
}

function rawbBankInput(bank: unknown): RawbBank {
  if (!rawbIsRecord(bank)) rawbInputInvalid();
  const { slot, clock, accounts } = bank;
  if (typeof slot !== 'number' || !Number.isSafeInteger(slot) || slot < 0) rawbInputInvalid();
  if (!rawbIsRecord(clock) || !rawbIsRecord(accounts)) rawbInputInvalid();
  return bank as unknown as RawbBank;
}

function rawbAtoms(value: unknown): bigint {
  if (typeof value !== 'string' || !RAWB_ATOMIC.test(value)) rawbInputInvalid();
  const atoms = BigInt(value);
  if (atoms > DLMM_U64_MAX) rawbInputInvalid();
  return atoms;
}

export function planDlmmRoute(input: ExecLiqPlanInput): RoutePlan {
  const { pool, target } = rawbRouteInput(input);
  const accounts: unknown = input.accounts;
  if (!rawbIsRecord(accounts)) rawbInputInvalid();
  return rawbAnalyze(pool, target, input.accounts).plan;
}

export function quoteDlmmRoute(input: ExecLiqQuoteInput): RouteQuote {
  const { pool, target } = rawbRouteInput(input);
  const bank = rawbBankInput(input.bank);
  const atoms = rawbAtoms(input.inputAtoms);
  let quote: DlmmExactInQuote;
  try {
    const run = rawbPrepare(rawbAnalyze(pool, target, bank.accounts), bank);
    quote = quoteDlmmExactIn(run.prepared, atoms);
    if (quote.input !== atoms || quote.consumed > atoms || quote.tradingFee !== quote.lpFee + quote.protocolFee || quote.feeUnit !== run.prepared.feeUnit) {
      rawbStop('DLMM_KERNEL_INVARIANT');
    }
  } catch (error) {
    throw new Error(rawbReason(error));
  }
  return {
    inputAtoms: atoms.toString(10),
    consumedAtoms: quote.consumed.toString(10),
    netAtoms: quote.net.toString(10),
    complete: quote.fullyConsumed && quote.consumed === atoms,
    fees: {
      tradingInputAtoms: (quote.feeUnit === 'INPUT_TOKEN' ? quote.tradingFee : 0n).toString(10),
      tradingOutputAtoms: (quote.feeUnit === 'OUTPUT_TOKEN' ? quote.tradingFee : 0n).toString(10),
      transferInputAtoms: '0',
      transferOutputAtoms: '0',
    },
  };
}

export function solveDlmmRoute(input: ExecLiqSolveInput): RouteSolve {
  const { pool, target } = rawbRouteInput(input);
  const bank = rawbBankInput(input.bank);
  const impactBps: unknown = input.impactBps;
  if (typeof impactBps !== 'number' || !Number.isSafeInteger(impactBps) || impactBps < 0 || impactBps > 10_000) rawbInputInvalid();
  const ctx = rawbAnalyze(pool, target, bank.accounts);
  return {
    adapterVersion: EXEC_LIQ_DLMM_VERSION,
    plan: ctx.plan,
    bankSlot: bank.slot,
    clock: bank.clock,
    impactBps,
    outcome: rawbSolveOutcome(ctx, bank, impactBps),
  };
}
