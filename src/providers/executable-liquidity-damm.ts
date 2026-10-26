import BN from 'bn.js';
import { Connection, PublicKey, type AccountInfo } from '@solana/web3.js';
import { NATIVE_MINT, NATIVE_MINT_2022, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount, type Account } from '@solana/spl-token';
import * as Damm from '@meteora-ag/cp-amm-sdk';
import type {
  CapacityWitness, CoherentBank, ExecLiqPlanInput, ExecLiqQuoteInput, ExecLiqReason, ExecLiqSolveInput, JsonValue, RawAccountMap,
  RouteFacts, RouteOutcome, RoutePlan, RouteQuote, RouteSolve, RpcAccount, SolanaClock, VaultBalance, ZeroReason,
} from '../domain/executable-liquidity.js';
import { quoteAdmission, validateVaultData } from './advisory-exit-capacity-custom.js';

/**
 * Meteora DAMM v2 (cp-amm SDK 1.5.1) executable sell capacity: one exact-in sell of the target tokenA into tokenB.
 * QUOTED net of trading fees only; no wallet availability, simulation, rent, priority fee or unwrap cost.
 * Pure and deterministic: reads only planned keys, takes time only from the explicit bank Clock, never the network.
 */
export const EXEC_LIQ_DAMM_VERSION = 'execliq-damm-v2-sdk-1.5.1-v1' as const;

type BadStatus = Exclude<RouteOutcome['status'], 'KNOWN'>;
type DammKind = `DAMM_${Uppercase<string>}`;
type Diag = { [key: string]: JsonValue };
type Rec = { readonly [key: string]: unknown };
type MintAdmission = ReturnType<typeof quoteAdmission>;
type FeeMode = ReturnType<typeof Damm.getFeeMode>;
type SwapResult = ReturnType<typeof Damm.getSwapResultFromExactInput>;
type SdkBN = Parameters<typeof Damm.getSwapResultFromExactInput>[1];
type Body = { readonly key: string; readonly owner: string; readonly data: Buffer; readonly lamports: number; readonly executable: boolean };
type Pool = {
  readonly key: string; readonly state: Damm.PoolState;
  readonly mintA: string; readonly mintB: string; readonly vaultA: string; readonly vaultB: string;
  readonly flagA: number; readonly flagB: number; readonly cfm: number; readonly feeVersion: number; readonly baseFeeMode: number;
  readonly activationType: number; readonly activationPoint: bigint; readonly status: number;
  readonly liq: bigint; readonly S: bigint; readonly smin: bigint; readonly smax: bigint;
  readonly A: bigint; readonly B: bigint; readonly pA: bigint; readonly pB: bigint;
  readonly permLock: bigint; readonly feeBPerLiq: bigint; readonly deadCheckpoint: bigint; readonly totalPosition: bigint;
};
type Mint = { readonly adm: MintAdmission; readonly decimals: number; readonly supply: bigint };
type Vault = { readonly amount: bigint; readonly program: string; readonly nativeSurplus: bigint | null };
type Ctx = {
  readonly pool: Pool; readonly comp: boolean; readonly facts: RouteFacts; readonly zero: 'DISABLED' | 'L0' | null;
  readonly cp: bigint; readonly n: bigint; readonly feeMode: FeeMode | null; readonly inputCap: bigint; readonly diag: Diag;
};
type Quoted = { readonly complete: boolean; readonly net: bigint; readonly fee: bigint };
type Planned = { readonly plan: RoutePlan; readonly pool: Pool | null };

class DammFail extends Error {
  constructor(readonly reason: ExecLiqReason) { super(reason); }
}
function fail(reason: ExecLiqReason): never { throw new DammFail(reason); }
function inputInvalid(): never { throw new Error('EXEC_LIQ_INPUT_INVALID'); }

const D = 1_000_000_000n, Q128 = 1n << 128n, TENK = 10_000n, K = Q128 * TENK, M64 = 1n << 64n, U64 = M64 - 1n, U128 = Q128 - 1n;
/** Compounding dead liquidity (100 << 64) and the installed SDK sqrt-price bounds. */
const DEAD = 100n << 64n, MIN_SQRT = 4295048016n, MAX_SQRT = 79226673521066979257578248091n, BIN_STEP_U128 = 1844674407370955n;
const STEP_CAP = 1 << 17, EVAL_CAP = 1 << 21, POOL_SIZE = 1112;
const POOL_DISC = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, ATOMIC = /^(0|[1-9][0-9]*)$/;
const CLOCK_FIELDS = ['slot', 'epochStartTimestamp', 'epoch', 'leaderScheduleEpoch', 'unixTimestamp'] as const;
const PROGRAM_ID = Damm.CP_AMM_PROGRAM_ID.toBase58();
const AUTHORITY = Damm.derivePoolAuthority().toBase58();
const NATIVE = NATIVE_MINT.toBase58(), NATIVE_2022 = NATIVE_MINT_2022.toBase58();
const AtoB = Damm.TradeDirection.AtoB;
/** Anchor account coder only; the dummy connection is never used and any fetch throws. */
const CODER = (new Damm.CpAmm(new Connection('http://127.0.0.1:9', { fetch: (async () => { throw new Error('NETWORK_FORBIDDEN'); }) as never }) as never) as unknown as {
  readonly _program: { readonly coder: { readonly accounts: { decode(name: string, data: Buffer): unknown } } };
})._program.coder.accounts;

const s = (v: bigint): string => v.toString();
const minOf = (...v: bigint[]): bigint => v.reduce((a, b) => (b < a ? b : a));
const has = (m: RawAccountMap, k: string): boolean => Object.prototype.hasOwnProperty.call(m, k);
const sorted = (keys: Iterable<string>): string[] => [...new Set(keys)].sort();
const sdkBN = (v: bigint): SdkBN => new BN(v.toString()) as unknown as SdkBN;
const le = (a: Uint8Array): bigint => a.reduceRight((acc, x) => (acc << 8n) | BigInt(x), 0n);
const programOf = (flag: number): PublicKey => (flag === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID);
const info = (b: Body): AccountInfo<Buffer> => ({ data: b.data, owner: new PublicKey(b.owner), lamports: b.lamports, executable: b.executable });
const vaultPda = (mint: string, pool: string): string => Damm.deriveTokenVaultAddress(new PublicKey(mint) as never, new PublicKey(pool) as never).toBase58();

function canonical(v: unknown): v is string {
  if (typeof v !== 'string' || !BASE58.test(v)) return false;
  try { return new PublicKey(v).toBase58() === v; } catch { return false; }
}

function statusOf(r: ExecLiqReason): BadStatus {
  switch (r) {
    case 'ACCOUNT_NOT_READ': case 'ACCOUNT_NULL': case 'KEY_SET_OPEN': case 'BIN_COVERAGE_INCOMPLETE': return 'MISSING';
    case 'ACCOUNT_SHAPE': case 'ACCOUNT_BINDING': return 'INVALID';
    case 'CLOCK_MISMATCH': case 'OUTPUT_BACKING_INSUFFICIENT': case 'DAMM_STATE_INCONSISTENT': case 'DAMM_ACCOUNTING_INCOHERENT': return 'CONFLICT';
    default: return 'UNSUPPORTED';
  }
}

/** Existing exit-capacity guards throw strings; extension/control refusals are token-mode limits, everything else is shape. */
function splReason(e: unknown): ExecLiqReason {
  const m = e instanceof Error ? e.message : '';
  return /UNSUPPORTED|FROZEN|PAUSED|HOOK|MISSING/.test(m) ? 'TOKEN_MODE_UNSUPPORTED' : 'ACCOUNT_SHAPE';
}

function routeInput(input: unknown): { readonly target: string; readonly pool: string } {
  const i = input as { token?: { chain?: unknown; address?: unknown } | null; pool?: unknown } | null;
  if (typeof i !== 'object' || i === null || typeof i.token !== 'object' || i.token === null) return inputInvalid();
  if (i.token.chain !== 'solana' || !canonical(i.token.address) || !canonical(i.pool)) return inputInvalid();
  return { target: i.token.address as string, pool: i.pool as string };
}

function bankInput(v: unknown): CoherentBank {
  const b = v as { slot?: unknown; clock?: unknown; accounts?: unknown } | null;
  if (typeof b !== 'object' || b === null || typeof b.slot !== 'number' || typeof b.clock !== 'object' || b.clock === null
    || typeof b.accounts !== 'object' || b.accounts === null || Array.isArray(b.accounts)) return inputInvalid();
  return v as CoherentBank;
}

function clockOk(bank: CoherentBank): boolean {
  const c = bank.clock as unknown as Rec;
  if (!Number.isSafeInteger(bank.slot) || bank.slot < 0 || CLOCK_FIELDS.some((k) => !Number.isSafeInteger(c[k]))) return false;
  return c.slot === bank.slot && (c.epoch as number) >= 0 && (c.leaderScheduleEpoch as number) >= 0 && (c.unixTimestamp as number) >= 0;
}

/** Strict base64 body; rentEpoch is unsafe u64 metadata and is never read. */
function body(key: string, a: unknown): Body {
  const r = a as RpcAccount | null;
  if (typeof r !== 'object' || r === null) return fail('ACCOUNT_SHAPE');
  const d: unknown = r.data;
  if (!Array.isArray(d) || d.length !== 2 || d[1] !== 'base64' || typeof d[0] !== 'string') return fail('ACCOUNT_SHAPE');
  const text: string = d[0], data = Buffer.from(text, 'base64');
  if (data.toString('base64') !== text || typeof r.executable !== 'boolean' || !Number.isSafeInteger(r.lamports) || r.lamports < 0
    || !canonical(r.owner) || (r.space !== undefined && r.space !== data.length)) return fail('ACCOUNT_SHAPE');
  return { key, owner: r.owner, data, lamports: r.lamports, executable: r.executable };
}

function rec(v: unknown): Rec {
  return typeof v === 'object' && v !== null ? (v as Rec) : fail('LAYOUT_UNSUPPORTED');
}
function small(v: unknown): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : fail('LAYOUT_UNSUPPORTED');
}
function bi(v: unknown): bigint {
  if (BN.isBN(v) && !v.isNeg()) return BigInt(v.toString());
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return fail('LAYOUT_UNSUPPORTED');
}
function bytes(v: unknown, len: number): Uint8Array {
  const a = v instanceof Uint8Array ? v
    : Array.isArray(v) && v.every((x) => Number.isInteger(x) && x >= 0 && x <= 255) ? Uint8Array.from(v as number[]) : null;
  return a !== null && a.length === len ? a : fail('LAYOUT_UNSUPPORTED');
}
function keyOf(v: unknown): string {
  const k = typeof v === 'object' && v !== null && typeof (v as { toBase58?: unknown }).toBase58 === 'function' ? (v as { toBase58(): unknown }).toBase58() : null;
  return canonical(k) ? k : fail('LAYOUT_UNSUPPORTED');
}

function decodePool(data: Buffer): Rec {
  try { return rec(CODER.decode('pool', data)); } catch { return fail('LAYOUT_UNSUPPORTED'); }
}

/** Pool-only admission: owner, layout, target orientation, supported modes and vault PDA binding. */
function admitPoolBody(b: Body, target: string): Pool {
  if (b.owner !== PROGRAM_ID) fail('ACCOUNT_BINDING');
  if (b.executable || b.data.length !== POOL_SIZE || !b.data.subarray(0, 8).equals(POOL_DISC)) fail('LAYOUT_UNSUPPORTED');
  const p = decodePool(b.data), fees = rec(p.poolFees), dyn = rec(fees.dynamicFee);
  const baseData = bytes(rec(rec(fees.baseFee).baseFeeInfo).data, 32);
  const mintA = keyOf(p.tokenAMint), mintB = keyOf(p.tokenBMint), vaultA = keyOf(p.tokenAVault), vaultB = keyOf(p.tokenBVault);
  if (mintA === mintB) fail('ACCOUNT_BINDING');
  // Selling the target as tokenB (B->A) is not implemented: explicit MODE_UNSUPPORTED, never zero.
  if (mintA !== target) fail(mintB === target ? 'MODE_UNSUPPORTED' : 'NOT_TARGET_ROUTE');
  const layout = small(p.layoutVersion), feeVersion = small(p.feeVersion), cfm = small(p.collectFeeMode);
  const flagA = small(p.tokenAFlag), flagB = small(p.tokenBFlag), activationType = small(p.activationType), status = small(p.poolStatus);
  const baseFeeMode = baseData[8], dynInit = small(dyn.initialized), compoundingBps = small(fees.compoundingFeeBps);
  if (layout !== 1) fail('LAYOUT_UNSUPPORTED');
  if (flagA > 1 || flagB > 1) fail('TOKEN_MODE_UNSUPPORTED');
  // Only time/slot fee schedulers (base fee modes 0/1) are amount independent; other modes stay unsupported.
  if (feeVersion > 1 || cfm > 2 || activationType > 1 || status > 1 || baseFeeMode > 1) fail('MODE_UNSUPPORTED');
  if (dynInit !== 0 && (dynInit !== 1 || small(dyn.binStep) !== 1 || bi(dyn.binStepU128) !== BIN_STEP_U128
    || bi(dyn.volatilityAccumulator) > bi(dyn.maxVolatilityAccumulator))) fail('MODE_UNSUPPORTED');
  if (cfm === 2 ? compoundingBps > 10000 : compoundingBps !== 0) fail('MODE_UNSUPPORTED');
  if (vaultPda(mintA, b.key) !== vaultA || vaultPda(mintB, b.key) !== vaultB) fail('ACCOUNT_BINDING');
  return {
    key: b.key, state: p as unknown as Damm.PoolState, mintA, mintB, vaultA, vaultB, flagA, flagB, cfm, feeVersion, baseFeeMode, activationType,
    activationPoint: bi(p.activationPoint), status, liq: bi(p.liquidity), S: bi(p.sqrtPrice), smin: bi(p.sqrtMinPrice), smax: bi(p.sqrtMaxPrice),
    A: bi(p.tokenAAmount), B: bi(p.tokenBAmount), pA: bi(p.protocolAFee), pB: bi(p.protocolBFee), permLock: bi(p.permanentLockLiquidity),
    feeBPerLiq: le(bytes(p.feeBPerLiquidity, 32)), deadCheckpoint: bi(p.deadLiquidityFeeCheckpoint), totalPosition: bi(rec(p.metrics).totalPosition),
  };
}

function tryPool(key: string, raw: unknown, target: string): Pool | ExecLiqReason {
  try { return admitPoolBody(body(key, raw), target); } catch (e) { return e instanceof DammFail ? e.reason : 'LAYOUT_UNSUPPORTED'; }
}

function planInternal(target: string, poolKey: string, accounts: RawAccountMap): Planned {
  const head = { venue: 'DAMM_V2' as const, programId: PROGRAM_ID, pool: poolKey, targetMint: target };
  const poolOnly = (missing: boolean, isNull: boolean, rejected: ExecLiqReason | null): Planned => ({
    plan: { ...head, route: null, requiredKeys: [poolKey], additionalKeys: [], missingKeys: missing ? [poolKey] : [], nullKeys: isNull ? [poolKey] : [], open: missing, mutableKeys: [poolKey], rejected },
    pool: null,
  });
  if (!has(accounts, poolKey)) return poolOnly(true, false, null);
  const raw = accounts[poolKey];
  if (raw === null) return poolOnly(false, true, null);
  const pool = tryPool(poolKey, raw, target);
  if (typeof pool === 'string') return poolOnly(false, false, pool);
  const requiredKeys = sorted([poolKey, pool.mintA, pool.mintB, pool.vaultA, pool.vaultB]);
  const ma = has(accounts, pool.mintA) ? accounts[pool.mintA] : undefined, mb = has(accounts, pool.mintB) ? accounts[pool.mintB] : undefined;
  return {
    plan: {
      ...head,
      route: { outputMint: pool.mintB, direction: 'FIRST_TO_SECOND', vaults: { input: pool.vaultA, output: pool.vaultB }, tokenPrograms: ma && mb ? { input: ma.owner, output: mb.owner } : null },
      requiredKeys, additionalKeys: [],
      missingKeys: requiredKeys.filter((k) => !has(accounts, k)),
      nullKeys: requiredKeys.filter((k) => has(accounts, k) && accounts[k] === null),
      open: ma === undefined || mb === undefined,
      mutableKeys: sorted([poolKey, pool.vaultA, pool.vaultB]),
      rejected: null,
    },
    pool,
  };
}

function mintAdmission(b: Body): MintAdmission {
  if (b.data.length <= 45 || b.data[45] !== 1) return fail('ACCOUNT_SHAPE');
  try { return quoteAdmission(info(b)); } catch (e) { return fail(splReason(e)); }
}
function admitMint(b: Body, flag: number): Mint {
  if (b.owner !== programOf(flag).toBase58()) fail('ACCOUNT_BINDING');
  if (b.executable) fail('ACCOUNT_SHAPE');
  if (b.key === NATIVE_2022) fail('TOKEN_MODE_UNSUPPORTED');
  const adm = mintAdmission(b);
  return { adm, decimals: adm.mint.decimals, supply: BigInt(adm.mint.supply) };
}

function vaultAccount(b: Body, program: PublicKey, mintAdm: MintAdmission): Account {
  const ai = info(b);
  try { validateVaultData(ai, mintAdm); } catch (e) { return fail(splReason(e)); }
  const d = ai.data;
  for (const off of [72, 109, 129]) {
    const opt = d.readUInt32LE(off);
    if (opt !== 0 && opt !== 1) return fail('ACCOUNT_SHAPE');
  }
  if (d[108] > 2) return fail('ACCOUNT_SHAPE');
  try { return unpackAccount(new PublicKey(b.key), ai, program); } catch { return fail('ACCOUNT_SHAPE'); }
}
/** Vault amountAtoms is the token amount; WSOL lamports above amount plus rent reserve are recorded surplus, never liquidity. */
function admitVault(b: Body, mint: string, flag: number, mintAdm: MintAdmission): Vault {
  const program = programOf(flag);
  if (b.owner !== program.toBase58()) fail('ACCOUNT_BINDING');
  if (b.executable) fail('ACCOUNT_SHAPE');
  const v = vaultAccount(b, program, mintAdm);
  if (v.mint.toBase58() !== mint || v.owner.toBase58() !== AUTHORITY) fail('ACCOUNT_BINDING');
  if (!v.isInitialized) fail('ACCOUNT_SHAPE');
  if (v.isFrozen) fail('DAMM_VAULT_FROZEN');
  if (v.delegate !== null || v.closeAuthority !== null) fail('DAMM_VAULT_CONTROL');
  if (mint !== NATIVE) {
    if (v.isNative) fail('ACCOUNT_SHAPE');
    return { amount: v.amount, program: b.owner, nativeSurplus: null };
  }
  if (!v.isNative || v.rentExemptReserve === null) return fail('ACCOUNT_SHAPE');
  const surplus = BigInt(b.lamports) - v.amount - v.rentExemptReserve;
  if (surplus < 0n) fail('OUTPUT_BACKING_INSUFFICIENT');
  return { amount: v.amount, program: b.owner, nativeSurplus: surplus };
}

/** Trading fee numerator at the explicit Clock point and stored volatility accumulator, computed once; constant in x for modes 0/1. */
function tradingFee(pool: Pool, cp: bigint): { readonly n: bigint; readonly feeMode: FeeMode } {
  try {
    const feeMode = Damm.getFeeMode(pool.cfm, AtoB, false);
    const n = bi(Damm.getTotalTradingFeeFromIncludedFeeAmount(pool.state.poolFees, sdkBN(cp), pool.state.activationPoint, sdkBN(1n), AtoB,
      Damm.getMaxFeeNumerator(pool.feeVersion), pool.state.poolFees.initSqrtPrice, pool.state.sqrtPrice));
    if (!feeMode.feesOnInput && n < D) return { n, feeMode };
  } catch { /* any SDK fee failure is reported below */ }
  return fail('DAMM_FEE_UNSUPPORTED');
}

function admitState(pool: Pool, bank: CoherentBank, sink: { facts: RouteFacts | null }): Ctx {
  const get = (k: string): Body => body(k, bank.accounts[k]);
  const mA = admitMint(get(pool.mintA), pool.flagA), mB = admitMint(get(pool.mintB), pool.flagB);
  const vA = admitVault(get(pool.vaultA), pool.mintA, pool.flagA, mA.adm), vB = admitVault(get(pool.vaultB), pool.mintB, pool.flagB, mB.adm);
  const balance = (address: string, mint: string, v: Vault): VaultBalance => ({ address, mint, tokenProgram: v.program, amountAtoms: s(v.amount) });
  const facts: RouteFacts = {
    p0: { num: s(pool.S * pool.S), den: s(Q128) },
    decimals: { input: mA.decimals, output: mB.decimals },
    vaults: { input: balance(pool.vaultA, pool.mintA, vA), output: balance(pool.vaultB, pool.mintB, vB) },
  };
  sink.facts = facts;
  const comp = pool.cfm === 2;
  if (pool.S <= 0n) fail('ARITHMETIC_RANGE');
  if (comp) {
    if (pool.smin !== 0n || pool.smax !== U128) fail('ARITHMETIC_RANGE');
    // Compounding pools keep DEAD liquidity forever; less than that, or an empty tracked reserve, is not a source-reachable state.
    if (pool.liq < DEAD || pool.A === 0n || pool.B === 0n) fail('DAMM_STATE_INCONSISTENT');
  } else {
    if (pool.smin < MIN_SQRT || pool.smax > MAX_SQRT || pool.smin >= pool.smax || pool.S < pool.smin || pool.S > pool.smax) fail('ARITHMETIC_RANGE');
    if (pool.liq > 0n && pool.B === 0n) fail('DAMM_STATE_INCONSISTENT');
  }
  if (pool.permLock > pool.liq) fail('DAMM_STATE_INCONSISTENT');
  // Dead-liquidity fees sit untracked in the B vault: low u64 of (DEAD*feeBPerLiquidity)>>128 minus the checkpoint, wrapping.
  const dead = comp ? ((((DEAD * pool.feeBPerLiq) >> 128n) % M64) - pool.deadCheckpoint + M64) % M64 : 0n;
  const residualA = vA.amount - pool.A - pool.pA, residualB = vB.amount - pool.B - pool.pB - dead;
  if (residualA < 0n || mA.supply < vA.amount) fail('DAMM_ACCOUNTING_INCOHERENT');
  if (residualB < 0n) fail('OUTPUT_BACKING_INSUFFICIENT');
  const cp = BigInt(pool.activationType === 1 ? bank.clock.unixTimestamp : bank.clock.slot);
  // Hypothetical input domain: u64 amount, physical and tracked u64 headroom, and supply outside this pool's input vault.
  const domain = { amountInU64: U64, physicalInputVaultHeadroom: U64 - vA.amount, trackedInputHeadroom: U64 - pool.A, availableOutstandingInput: mA.supply - vA.amount };
  // Disabled pools and L=0 concentrated pools (Rust asserts L>0 and divides claiming fees by L) admit no swap at all.
  const zero = pool.status !== 0 ? 'DISABLED' : !comp && pool.liq === 0n ? 'L0' : null;
  // Whitelisted vaults may swap before activation, so a not-activated pool is never claimed as public zero.
  if (zero === null && cp < pool.activationPoint) fail('DAMM_NOT_ACTIVATED');
  const fee = zero === null ? tradingFee(pool, cp) : null;
  const diag: Diag = {
    proofLevel: 'QUOTED_NET_TRADING_FEES_ONLY',
    sdk: '@meteora-ag/cp-amm-sdk@1.5.1',
    collectFeeMode: pool.cfm,
    liquidityClass: comp ? (pool.liq === DEAD ? 'COMPOUNDING_DEAD_LIQUIDITY_ONLY' : 'COMPOUNDING') : pool.liq === 0n ? 'CONCENTRATED_EMPTY_L0' : 'CONCENTRATED',
    poolStatus: pool.status, activationType: pool.activationType, activationPoint: s(pool.activationPoint), currentPoint: s(cp),
    feeVersion: pool.feeVersion, baseFeeMode: pool.baseFeeMode, tradingFeeNumerator: fee ? s(fee.n) : null, feeDenominator: s(D),
    liquidity: s(pool.liq), sqrtPrice: s(pool.S), sqrtMinPrice: s(pool.smin), sqrtMaxPrice: s(pool.smax),
    permanentLockLiquidity: s(pool.permLock), totalPosition: s(pool.totalPosition),
    accounting: {
      trackedA: s(pool.A), protocolA: s(pool.pA), physicalA: s(vA.amount), residualA: s(residualA),
      trackedB: s(pool.B), protocolB: s(pool.pB), deadPendingB: s(dead), physicalB: s(vB.amount), residualB: s(residualB),
      nativeUnsyncedLamportSurplusA: vA.nativeSurplus === null ? null : s(vA.nativeSurplus),
      nativeUnsyncedLamportSurplusB: vB.nativeSurplus === null ? null : s(vB.nativeSurplus),
    },
    inputDomain: Object.fromEntries(Object.entries(domain).map(([k, v]) => [k, s(v)])),
  };
  return { pool, comp, facts, zero, cp, n: fee ? fee.n : 0n, feeMode: fee ? fee.feeMode : null, inputCap: minOf(...Object.values(domain)), diag };
}

function admitBank(planned: Planned, bank: CoherentBank, sink: { facts: RouteFacts | null }): Ctx {
  if (!clockOk(bank)) fail('CLOCK_MISMATCH');
  const { plan, pool } = planned;
  if (plan.rejected !== null) fail(plan.rejected);
  if (plan.missingKeys.length > 0) fail('ACCOUNT_NOT_READ');
  if (plan.open) fail('KEY_SET_OPEN');
  if (plan.nullKeys.length > 0) fail('ACCOUNT_NULL');
  if (pool === null) return fail('ACCOUNT_SHAPE');
  return admitState(pool, bank, sink);
}

/** Gross included-fee output G(x) (A->B): compounding B*x/(A+x); concentrated L*(S-sp)>>128 with sp = ceil(L*S/(L+x*S)). */
function gross(ctx: Ctx, x: bigint): { readonly g: bigint; readonly sp: bigint } {
  const { pool } = ctx;
  if (ctx.comp) return { g: (pool.B * x) / (pool.A + x), sp: pool.S };
  const den = pool.liq + x * pool.S, sp = (pool.liq * pool.S + den - 1n) / den;
  return { g: (pool.liq * (pool.S - sp)) >> 128n, sp };
}
/** Full consumption: input domain, concentrated price range, and G <= tracked B before the compounding add (Rust safe_sub). Monotone in x. */
function feasible(ctx: Ctx, x: bigint): boolean {
  if (x === 0n) return true;
  if (x < 0n || x > ctx.inputCap) return false;
  const { g, sp } = gross(ctx, x);
  return (ctx.comp || sp >= ctx.pool.smin) && g <= ctx.pool.B;
}
function largestFeasible(ctx: Ctx): bigint {
  let lo = 0n, hi = ctx.inputCap;
  while (lo < hi) { const mid = (lo + hi + 1n) >> 1n; if (feasible(ctx, mid)) lo = mid; else hi = mid - 1n; }
  return lo;
}

function sdkSwap(state: Damm.PoolState, x: bigint, feeMode: FeeMode, cp: bigint): SwapResult {
  try { return Damm.getSwapResultFromExactInput(state, sdkBN(x), feeMode, AtoB, sdkBN(cp)); } catch { return fail('DAMM_SDK_FAILURE'); }
}

/** One exact-in sell through the public SDK swap result, with bigint parity: net = G - ceil(G*n/1e9), fees charged once on G. */
function quoteCore(ctx: Ctx, x: bigint): Quoted {
  if (x === 0n) return { complete: true, net: 0n, fee: 0n };
  if (ctx.zero === 'DISABLED') fail('ROUTE_DISABLED');
  const feeMode = ctx.feeMode;
  if (ctx.zero === 'L0' || feeMode === null) return fail('DAMM_ZERO_LIQUIDITY');
  if (!feasible(ctx, x)) return { complete: false, net: 0n, fee: 0n };
  const { g } = gross(ctx, x), net = g - (g * ctx.n + D - 1n) / D;
  const r = sdkSwap(ctx.pool.state, x, feeMode, ctx.cp);
  const protocol = bi(r.protocolFee), referral = bi(r.referralFee), fee = bi(r.claimingFee) + bi(r.compoundingFee) + protocol + referral;
  if (!r.amountLeft.isZero() || bi(r.includedFeeInputAmount) !== x || bi(r.excludedFeeInputAmount) !== x || bi(r.outputAmount) !== net
    || referral !== 0n || fee !== g - net) fail('DAMM_SDK_PARITY');
  if (ctx.pool.pB + protocol > U64) fail('ARITHMETIC_RANGE');
  return { complete: true, net, fee };
}

/**
 * Exact max net under N(x)*2^128*1e4 >= (1e4-L)*x*S^2. N is monotone, the average-impact predicate is not: the v2 upper bound U
 * excludes every admissible x > U, then a top-down plateau scan certifies the first plateau [m, x] whose admissible prefix is non-empty.
 */
function capacity(ctx: Ctx, bps: bigint): RouteOutcome {
  const { pool, facts } = ctx, c = (TENK - bps) * pool.S * pool.S;
  const diag: Diag = { ...ctx.diag, impactBps: s(bps), admissibility: 'y*2^128*10000 >= (10000-impactBps)*x*sqrtPrice^2 and y>0 for x>0' };
  let evals = 0, steps = 0;
  const N = (x: bigint): bigint => {
    if (++evals > EVAL_CAP) fail('MAX_UNPROVED');
    const q = quoteCore(ctx, x);
    return q.complete ? q.net : fail('DAMM_PROOF_FAILURE');
  };
  const admissible = (x: bigint, y: bigint): boolean => x === 0n || (y > 0n && y * K >= c * x);
  const witness = (role: CapacityWitness['role'], x: bigint): CapacityWitness => {
    const q = quoteCore(ctx, x);
    return { role, inputAtoms: s(x), netAtoms: s(q.net), complete: q.complete, admissible: q.complete && admissible(x, q.net) };
  };
  const zero = (kind: DammKind, reason: ZeroReason, domainEnd: bigint): RouteOutcome => ({
    status: 'KNOWN', netAtoms: '0', inputAtoms: '0', maxAdmissibleInputAtoms: '0', zero: reason, facts,
    certificate: { kind, maximal: true, domainEndAtoms: s(domainEnd), witnesses: [witness('CHOSEN', 0n), witness('MAX_ADMISSIBLE', 0n)], diagnostics: { ...diag, plateauSteps: steps, evaluations: evals } },
  });
  if (ctx.zero === 'DISABLED') return zero('DAMM_ZERO_ROUTE_DISABLED', 'NO_ADMISSIBLE_INPUT', 0n);
  if (ctx.zero === 'L0') return zero('DAMM_ZERO_EMPTY_LIQUIDITY', 'ZERO_LIQUIDITY', 0n);
  const domainEnd = largestFeasible(ctx);
  diag.domainEndAtoms = s(domainEnd);
  let upper: bigint | null = null;
  if (c > 0n) {
    // Compounding: G <= B*x/(A+x) with actual A, B and stored S (B/A may exceed p0). Concentrated: strict curve fee floor, fee==limit included.
    if (ctx.comp) { const num = (D - ctx.n) * pool.B * K - c * D * pool.A; upper = num > 0n ? num / (c * D) : 0n; }
    else { const f = (D - ctx.n) * TENK - (TENK - bps) * D; upper = f > 0n ? (pool.liq * f) / ((TENK - bps) * D * pool.S) : 0n; }
    diag.upperBoundFormula = ctx.comp ? 'COMPOUNDING_RESERVE_RATIO' : 'CONCENTRATED_FEE_FLOOR';
    diag.upperBoundAtoms = s(upper);
    if (upper < 1n) return zero('DAMM_ZERO_UPPER_BOUND', 'NO_ADMISSIBLE_INPUT', domainEnd);
  }
  if (domainEnd < 1n) return ctx.inputCap < 1n ? zero('DAMM_ZERO_INPUT_DOMAIN', 'NO_ADMISSIBLE_INPUT', 0n) : fail('DAMM_DOMAIN_EMPTY');
  const least = (y: bigint, hi: bigint): bigint => {
    let lo = 1n;
    while (lo < hi) { const mid = (lo + hi) >> 1n; if (N(mid) >= y) hi = mid; else lo = mid + 1n; }
    return lo;
  };
  let best = 0n, chosen = 0n, maxAdm = 0n;
  if (upper === null) {
    // impactBps 10000: every fully consumable x with positive net is admissible; N monotone gives the maximum at the domain end.
    best = N(domainEnd);
    if (best === 0n) return zero('DAMM_ZERO_FULL_DOMAIN', 'NO_ADMISSIBLE_INPUT', domainEnd);
    chosen = least(best, domainEnd);
    maxAdm = domainEnd;
  } else {
    let x = upper < domainEnd ? upper : domainEnd;
    for (;;) {
      if (x < 1n) return zero('DAMM_ZERO_PLATEAU_SCAN', 'NO_ADMISSIBLE_INPUT', domainEnd);
      if (++steps > STEP_CAP) fail('MAX_UNPROVED');
      const y = N(x);
      if (y === 0n) return zero('DAMM_ZERO_PLATEAU_SCAN', 'NO_ADMISSIBLE_INPUT', domainEnd);
      const m = least(y, x), lim = (y * K) / c, cand = x < lim ? x : lim;
      if (cand >= m) { best = y; chosen = m; maxAdm = cand; break; }
      x = m - 1n;
    }
  }
  if (N(chosen) !== best || !admissible(chosen, best) || N(maxAdm) !== best || !admissible(maxAdm, best) || (chosen > 1n && N(chosen - 1n) >= best)) fail('DAMM_PROOF_FAILURE');
  const witnesses: CapacityWitness[] = [witness('CHOSEN', chosen), witness('BELOW_CHOSEN', chosen - 1n), witness('MAX_ADMISSIBLE', maxAdm)];
  if (maxAdm < domainEnd) {
    const above = witness('ABOVE_MAX_ADMISSIBLE', maxAdm + 1n);
    if (!above.complete || above.admissible) fail('DAMM_PROOF_FAILURE');
    witnesses.push(above);
  }
  witnesses.push(witness('DOMAIN_END', domainEnd));
  if (best > BigInt(facts.vaults.output.amountAtoms)) fail('OUTPUT_BACKING_INSUFFICIENT');
  return {
    status: 'KNOWN', netAtoms: s(best), inputAtoms: s(chosen), maxAdmissibleInputAtoms: s(maxAdm), zero: null, facts,
    certificate: {
      kind: upper === null ? 'DAMM_FULL_DOMAIN_MONOTONE' : 'DAMM_TOP_DOWN_PLATEAU', maximal: true, domainEndAtoms: s(domainEnd), witnesses,
      diagnostics: { ...diag, plateauSteps: steps, evaluations: evals, monotoneNet: 'N(x)=G(x)-ceil(G(x)*n/1e9), G nondecreasing, n constant in x' },
    },
  };
}

export function planDammRoute(input: ExecLiqPlanInput): RoutePlan {
  const { target, pool } = routeInput(input);
  const accounts = (input as { accounts?: unknown }).accounts;
  if (typeof accounts !== 'object' || accounts === null || Array.isArray(accounts)) return inputInvalid();
  return planInternal(target, pool, accounts as RawAccountMap).plan;
}

export function quoteDammRoute(input: ExecLiqQuoteInput): RouteQuote {
  const { target, pool } = routeInput(input);
  const atoms = (input as { inputAtoms?: unknown }).inputAtoms;
  if (typeof atoms !== 'string' || !ATOMIC.test(atoms)) return inputInvalid();
  const bank = bankInput(input.bank), x = BigInt(atoms);
  try {
    const q = quoteCore(admitBank(planInternal(target, pool, bank.accounts), bank, { facts: null }), x);
    return {
      inputAtoms: atoms, consumedAtoms: q.complete ? atoms : '0', netAtoms: s(q.net), complete: q.complete,
      fees: { tradingInputAtoms: '0', tradingOutputAtoms: s(q.fee), transferInputAtoms: '0', transferOutputAtoms: '0' },
    };
  } catch (e) {
    throw new Error(e instanceof DammFail ? e.reason : 'DAMM_INTERNAL_FAILURE');
  }
}

export function solveDammRoute(input: ExecLiqSolveInput): RouteSolve {
  const { target, pool } = routeInput(input);
  const bps = (input as { impactBps?: unknown }).impactBps;
  if (typeof bps !== 'number' || !Number.isInteger(bps) || bps < 0 || bps > 10000) return inputInvalid();
  const bank = bankInput(input.bank), planned = planInternal(target, pool, bank.accounts), c = bank.clock;
  const clock: SolanaClock = { slot: c.slot, epochStartTimestamp: c.epochStartTimestamp, epoch: c.epoch, leaderScheduleEpoch: c.leaderScheduleEpoch, unixTimestamp: c.unixTimestamp };
  const sink: { facts: RouteFacts | null } = { facts: null };
  let outcome: RouteOutcome;
  try {
    outcome = capacity(admitBank(planned, bank, sink), BigInt(bps));
  } catch (e) {
    const reason: ExecLiqReason = e instanceof DammFail ? e.reason : 'DAMM_INTERNAL_FAILURE';
    outcome = { status: statusOf(reason), reasons: [reason], facts: sink.facts, certificate: null };
  }
  return { adapterVersion: EXEC_LIQ_DAMM_VERSION, plan: planned.plan, bankSlot: bank.slot, clock, impactBps: bps, outcome };
}
