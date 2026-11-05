/* executable-sell-capacity-v1 core: exact request bodies, the retained capture, pure reconstruction, the PumpSwap fee-floor kernel and the owned-receipt validator. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import BN from 'bn.js';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import { AccountLayout, MintLayout, NATIVE_MINT, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PUMP_AMM_SDK, PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, computeFeesBps, sellBaseInput } from '@pump-fun/pump-swap-sdk';
import type { EvidenceRecord, LiveBundle, QualityState, TokenRef } from '../domain/contracts.js';
import {
  EXEC_LIQ_CAPTURE_ADAPTER, EXEC_LIQ_CASH_OUTPUTS, EXEC_LIQ_CASH_SET, EXEC_LIQ_CLOCK_SYSVAR, EXEC_LIQ_DEFINITIONS_VERSION, EXEC_LIQ_DERIVATION_ID,
  EXEC_LIQ_EXPIRY_SECONDS, EXEC_LIQ_GENESIS_REQUEST_ID, EXEC_LIQ_IMPACT_BPS, EXEC_LIQ_INVENTORY_FRAMES, EXEC_LIQ_MAX_BANK_KEYS, EXEC_LIQ_METHOD, EXEC_LIQ_PROGRAMS,
  EXEC_LIQ_RECORD_PREFIX, EXEC_LIQ_REQUEST_ARTIFACT_VERSION, EXEC_LIQ_REQUEST_RECORD_PATTERN, EXEC_LIQ_ROUTE_ADAPTERS, EXEC_LIQ_RPC_MAX_BYTES, EXEC_LIQ_SOURCE_IDS,
  EXEC_LIQ_USD_MAX_BYTES, EXEC_LIQ_USD_URL, execLiqAccountsRequestSchema, execLiqInventoryRequestSchema, execLiqRequestArtifactSchema, executableLiquidityFactsSchema,
  isExecLiqOwnedRecord, routeOutcomeSchema, routePlanSchema, rpcAccountSchema, verifyExecLiqGenesisArtifact,
} from '../domain/executable-liquidity.js';
import type {
  CapacityCertificate, CapacityWitness, CoherentBank, ExecLiqAccountsRequest, ExecLiqAggregate, ExecLiqBank, ExecLiqCashAsset, ExecLiqFailureCode, ExecLiqFrameId,
  ExecLiqFreshness, ExecLiqInputDomain, ExecLiqInventory, ExecLiqInventoryRequest, ExecLiqPlanInput, ExecLiqQuoteInput, ExecLiqReason, ExecLiqRejectCode, ExecLiqRequest,
  ExecLiqRequestArtifact, ExecLiqRequestEntry, ExecLiqRoute, ExecLiqSolveInput, ExecLiqToken, ExecLiqUsd, ExecLiqVenue, ExecutableLiquidityFacts, JsonValue, Rational,
  RawAccountMap, RouteFacts, RouteMeta, RouteOutcome, RoutePlan, RouteQuote, RouteSolve, RpcAccount, SignedRational, SolanaClock,
} from '../domain/executable-liquidity.js';
import { planDlmmRoute, quoteDlmmRoute, solveDlmmRoute } from './executable-liquidity-dlmm.js';
import { planDammRoute, quoteDammRoute, solveDammRoute } from './executable-liquidity-damm.js';
import { readLimitedText } from './http.js';
import { LEGACY_TOKEN_PROGRAM, TOKEN_2022_PROGRAM, decodeRawMintControls, decodeSolanaAddress, encodeSolanaAddress } from './solana.js';
import { quoteAdmission, validateVaultData } from './advisory-exit-capacity-custom.js';

/** Equals EXEC_LIQ_ROUTE_ADAPTERS.PUMPSWAP. */
export const EXEC_LIQ_PUMP_VERSION = EXEC_LIQ_ROUTE_ADAPTERS.PUMPSWAP;
/** The 17 cash pools of the public observed diagnostic frame (program-inventory/classification.json, sha256 796a481b...), sorted. Comparison context for the frozen token only; never the scope or a required count. */
export const EXEC_LIQ_REFERENCE_CASH_POOLS: readonly string[] = Object.freeze([
  '2tFYCTqYJ2pyrb7CeA824o2Ybq3jq7agvr3Qpv2uVDmL', '3M9sVgL4u6ATKaiExf3XhQqNfMB6ijvzk3meMcQaen1w', '3eDK8FwjhhiH5PfS8ZTSMdj7gTXiY56SEL3cQJ9P5mFH',
  '4ZQPFmHZjo2yGAWa39CdGJZ97hMapXTemh8yJRUPRijz', '4sFL1zNWA41bvyTDmAYUTsw141XErJYQNg46BCNGFfdv', '5Wu8bDBKaJxc8RacVk9hi54PXt6JsDSyH9tZKk4972a9',
  '8mtnbphJdGvg7frACqAAHNRN7PbCCX3pyDt7WGDetmZZ', 'BBNe6tSmvsKSc58CEHpRnH1PnkWhekTryKascaCUtDuJ', 'CGnifLF5vYCkzQPHuxWWGUcBHjCpFXirLZTGVEzo7ysR',
  'CXbfPNXWzLYybcKH7NpzpxQcf9dBrX5ep3Di2cav2Qfv', 'CaUgbB98qBZgQBbQPcLqFMszjdHddpqdA22wJqyLpi6o', 'E6CUWZTuf75xiz9vsJxUjP9NazjvGNJYL3WWKcE2WiyW',
  'ETtnpR8ete58b9rnd6EiNHdN2rRAuVKVqKW5DwpqjWfw', 'EeaLETKomynSs5kP3SbUaWxN5n4LX5C9MjHNTPYUsh1h', 'EfCJyjXy6pYcXGn4xRJGpCPHNgxoNV6C8NaD3wwNnJ6j',
  'FiBr3heyH5bYWarJ4qXRRRYFc9yX1zU1x484Qv8FxnZd', 'HS23icXsGGVHxAXZia6VNJbTq9JMqD4Pumd1YbMsrA32',
]);
const REFERENCE_TOKEN = 'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump';
const REFERENCE_ID = 'exec-liq-C5-2026-10-26-accepted-baseline';
const SYSVAR_OWNER = 'Sysvar1111111111111111111111111111111111111';
const TOKEN_PROGRAMS: readonly string[] = [LEGACY_TOKEN_PROGRAM, TOKEN_2022_PROGRAM];
const DEFAULT_KEY = PublicKey.default.toBase58();
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ATOMIC = /^(0|[1-9][0-9]*)$/;
const DECIMAL = /^(0|[1-9][0-9]*)([.][0-9]+)?$/;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Solana JSON-RPC error: minimum context slot has not been reached. */
const SLOT_BEHIND_RPC_CODE = -32016;
const BEHIND = Symbol('CONTEXT_SLOT_BEHIND');
const ZERO: Rational = { num: '0', den: '1' };
const PUMP_POOL_BYTES = 301, PUMP_POOL_PREFIX_BYTES = 287, PUMP_SELL_DISABLED = 16;
const PUMP_POOL_DISCRIMINATOR = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);

type Frame = (typeof EXEC_LIQ_INVENTORY_FRAMES)[number];
type GpaRow = { readonly pubkey: string; readonly account: RpcAccount; readonly data: Buffer };
type GpaFrame = { readonly slot: number; readonly rows: readonly GpaRow[] };
type AccountsBody = { readonly slot: number; readonly accounts: Readonly<Record<string, RpcAccount | null>> };
type Check = { readonly ok: true; readonly parsed: unknown } | { readonly ok: false; readonly code: ExecLiqFailureCode };
type Fail = { readonly ok: false; readonly code: ExecLiqRejectCode; readonly detail: string };
type Decoded = { readonly account: RpcAccount; readonly data: Buffer };
type CashRoute = {
  readonly pool: string; readonly venue: ExecLiqVenue; readonly programId: string; readonly frameIds: readonly ExecLiqFrameId[]; readonly dataLength: number;
  readonly outputMint: string; readonly cashAsset: ExecLiqCashAsset; readonly direction: RouteMeta['direction']; readonly account: RpcAccount;
};
type KnownOutcome = Extract<RouteOutcome, { status: 'KNOWN' }>;
type Blocker = Extract<ExecLiqAggregate, { status: 'NOT_PRIMARY' }>['blockers'][number];
type UsdRef = Extract<ExecLiqUsd, { status: 'OBSERVED' }>['refs'][number];

const has = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const field = (v: unknown, key: string): unknown => isObject(v) ? v[key] : undefined;
const parseJson = (text: string): unknown => { try { return JSON.parse(text); } catch { return undefined; } };
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const sortUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort();
const chunk = <T>(values: readonly T[], size: number): T[][] => { const out: T[][] = []; for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size)); return out; };
const fail = (code: ExecLiqRejectCode, detail: string): Fail => ({ ok: false, code, detail });
const venuePrefix = (venue: ExecLiqVenue): 'PUMP' | 'DLMM' | 'DAMM' => venue === 'PUMPSWAP' ? 'PUMP' : venue === 'DLMM' ? 'DLMM' : 'DAMM';
const isoAt = (ms: number): string => new Date(ms).toISOString();
const frameOf = (frameId: ExecLiqFrameId): Frame => EXEC_LIQ_INVENTORY_FRAMES.find(f => f.frameId === frameId)!;

/** Recursively key-sorted JSON; the canonical form for derivation and reconstruction equality. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => item === undefined ? 'null' : canonical(item)).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function base58Bytes(text: string): Buffer {
  let value = 0n;
  for (const character of text) { const digit = BASE58.indexOf(character); if (digit < 0) throw new Error('BASE58'); value = value * 58n + BigInt(digit); }
  const hex = value === 0n ? '' : value.toString(16), leading = text.length - text.replace(/^1+/, '').length;
  return Buffer.concat([Buffer.alloc(leading), Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex')]);
}

/* Exact rationals over bigint; denominators stay positive. */
type Q = { readonly n: bigint; readonly d: bigint };
const gcd = (a: bigint, b: bigint): bigint => { let x = a < 0n ? -a : a, y = b < 0n ? -b : b; while (y !== 0n) [x, y] = [y, x % y]; return x; };
const ratio = (n: bigint, d: bigint): Q => { if (d === 0n) throw new Error('ARITHMETIC_RANGE'); const sign = d < 0n ? -1n : 1n, g = gcd(n, d) || 1n; return { n: sign * n / g, d: sign * d / g }; };
const qadd = (a: Q, b: Q): Q => ratio(a.n * b.d + b.n * a.d, a.d * b.d);
const toRational = (x: Q): Rational => ({ num: x.n.toString(), den: x.d.toString() });
const fromRational = (r: Rational): Q => ({ n: BigInt(r.num), d: BigInt(r.den) });

function decodeAccount(raw: unknown): Decoded | null {
  const parsed = rpcAccountSchema.safeParse(raw);
  if (!parsed.success) return null;
  const data = Buffer.from(parsed.data.data[0], 'base64');
  return data.toString('base64') === parsed.data.data[0] ? { account: parsed.data, data } : null;
}
function decodeClock(raw: RpcAccount | null | undefined): SolanaClock | null {
  const d = raw ? decodeAccount(raw) : null;
  if (!d || d.account.owner !== SYSVAR_OWNER || d.data.length !== 40) return null;
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  const values = [d.data.readBigUInt64LE(0), d.data.readBigInt64LE(8), d.data.readBigUInt64LE(16), d.data.readBigUInt64LE(24), d.data.readBigInt64LE(32)];
  if (values.some(v => v > limit || v < -limit)) return null;
  const [slot, epochStartTimestamp, epoch, leaderScheduleEpoch, unixTimestamp] = values.map(Number) as [number, number, number, number, number];
  if (!Number.isFinite(new Date(unixTimestamp * 1000 + EXEC_LIQ_EXPIRY_SECONDS * 1000).getTime())) return null;
  return { slot, epochStartTimestamp, epoch, leaderScheduleEpoch, unixTimestamp };
}

type Envelope = { readonly kind: 'result'; readonly result: unknown } | { readonly kind: 'error'; readonly code: unknown };
function envelope(text: string): Envelope | null {
  const v = parseJson(text);
  if (!isObject(v) || v['jsonrpc'] !== '2.0' || v['id'] !== 1) return null;
  if (has(v, 'error')) { const e = v['error']; return isObject(e) ? { kind: 'error', code: e['code'] } : null; }
  return has(v, 'result') ? { kind: 'result', result: v['result'] } : null;
}
function rpcCheck(text: string, parse: (result: unknown) => unknown): Check {
  const e = envelope(text);
  if (e === null) return { ok: false, code: 'BODY_INVALID' };
  if (e.kind === 'error') return { ok: false, code: e.code === SLOT_BEHIND_RPC_CODE ? 'CONTEXT_SLOT_BEHIND' : 'RPC_ERROR' };
  const parsed = parse(e.result);
  if (parsed === BEHIND) return { ok: false, code: 'CONTEXT_SLOT_BEHIND' };
  return parsed === null || parsed === undefined ? { ok: false, code: 'BODY_INVALID' } : { ok: true, parsed };
}
const genesisResult = (result: unknown): unknown => typeof result === 'string' ? result : null;
const usdCheck = (text: string): Check => Array.isArray(parseJson(text)) ? { ok: true, parsed: true } : { ok: false, code: 'BODY_INVALID' };
function parseGpa(result: unknown, frame: Frame, target: Buffer): GpaFrame | null {
  if (!isObject(result)) return null;
  const context = result['context'], value = result['value'], slot = field(context, 'slot');
  if (typeof slot !== 'number' || !Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(value)) return null;
  const discriminator = base58Bytes(frame.discriminator), rows: GpaRow[] = [], seen = new Set<string>();
  for (const item of value) {
    const pubkey = field(item, 'pubkey'), decoded = decodeAccount(field(item, 'account'));
    if (typeof pubkey !== 'string' || !ADDRESS.test(pubkey) || seen.has(pubkey) || decoded === null) return null;
    const d = decoded.data;
    if (decoded.account.owner !== frame.programId || d.length < Math.max(discriminator.length, frame.targetOffset + 32)
      || !d.subarray(0, discriminator.length).equals(discriminator) || !d.subarray(frame.targetOffset, frame.targetOffset + 32).equals(target)) return null;
    seen.add(pubkey); rows.push({ pubkey, account: decoded.account, data: d });
  }
  return { slot, rows };
}
function parseAccounts(result: unknown, keys: readonly string[], minContextSlot: number | undefined): AccountsBody | typeof BEHIND | null {
  const slot = field(field(result, 'context'), 'slot'), value = field(result, 'value');
  if (typeof slot !== 'number' || !Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(value) || value.length !== keys.length) return null;
  if (minContextSlot !== undefined && slot < minContextSlot) return BEHIND;
  const accounts: Record<string, RpcAccount | null> = {};
  for (const [i, item] of value.entries()) {
    if (item === null) { accounts[keys[i]!] = null; continue; }
    const decoded = decodeAccount(item);
    if (decoded === null) return null;
    accounts[keys[i]!] = decoded.account;
  }
  return { slot, accounts };
}
function mergeBank(parts: readonly AccountsBody[]): { readonly ok: true; readonly bank: CoherentBank } | { readonly ok: false; readonly code: 'SLOT_MISMATCH' | 'CLOCK_MISMATCH' | 'CLOCK_INVALID' } {
  const slot = parts[0]?.slot;
  if (slot === undefined || parts.some(p => p.slot !== slot)) return { ok: false, code: 'SLOT_MISMATCH' };
  const clocks = parts.map(p => decodeClock(p.accounts[EXEC_LIQ_CLOCK_SYSVAR])), clock = clocks[0];
  if (!clock || clocks.some(c => c === null)) return { ok: false, code: 'CLOCK_INVALID' };
  if (clocks.some(c => !isDeepStrictEqual(c, clock))) return { ok: false, code: 'CLOCK_MISMATCH' };
  /* The Clock must be the bank's own: a response context slot other than Clock.slot is never one coherent finalized bank, for one part or equally mismatched parts. */
  if (clock.slot !== slot) return { ok: false, code: 'CLOCK_MISMATCH' };
  const accounts: Record<string, RpcAccount | null> = {};
  for (const p of parts) Object.assign(accounts, p.accounts);
  return { ok: true, bank: { slot, clock, accounts } };
}

/** Pools deduplicated across frames and classified by the exact counter-mint address. */
function classify(frames: readonly (GpaFrame | null)[]) {
  type Candidate = { readonly pool: string; readonly venue: ExecLiqVenue; readonly programId: string; readonly frameIds: ExecLiqFrameId[]; readonly dataLength: number; readonly counter: string | null; readonly side: 'FIRST' | 'SECOND'; readonly account: RpcAccount; conflict: boolean };
  const pools = new Map<string, Candidate>();
  EXEC_LIQ_INVENTORY_FRAMES.forEach((frame, i) => {
    for (const row of frames[i]?.rows ?? []) {
      const end = frame.counterOffset + 32, counter = row.data.length >= end ? encodeSolanaAddress(row.data.subarray(frame.counterOffset, end)) : null, prior = pools.get(row.pubkey);
      if (!prior) pools.set(row.pubkey, { pool: row.pubkey, venue: frame.venue, programId: frame.programId, frameIds: [frame.frameId], dataLength: row.data.length, counter, side: frame.side, account: row.account, conflict: false });
      else { prior.frameIds.push(frame.frameId); if (prior.venue !== frame.venue || prior.dataLength !== row.data.length || prior.counter !== counter) prior.conflict = true; }
    }
  });
  const cash: CashRoute[] = [], excluded: ExecLiqInventory['excluded'][number][] = [], unclassified: ExecLiqInventory['unclassified'][number][] = [];
  for (const c of [...pools.values()].sort((a, b) => a.pool < b.pool ? -1 : a.pool > b.pool ? 1 : 0)) {
    const base = { pool: c.pool, venue: c.venue, programId: c.programId, frameIds: [...c.frameIds], dataLength: c.dataLength };
    const output = EXEC_LIQ_CASH_OUTPUTS.find(o => o.mint === c.counter);
    if (c.conflict) unclassified.push({ ...base, reason: 'FRAME_CONFLICT' });
    else if (c.counter === null) unclassified.push({ ...base, reason: 'COUNTER_MINT_UNREADABLE' });
    else if (output) cash.push({ ...base, outputMint: output.mint, cashAsset: output.asset, direction: c.side === 'FIRST' ? 'FIRST_TO_SECOND' : 'SECOND_TO_FIRST', account: c.account });
    else excluded.push({ ...base, counterMint: c.counter, reason: 'OTHER_ASSET_CONVERSION' });
  }
  return { cash, excluded, unclassified };
}
function planAll(token: TokenRef, cash: readonly CashRoute[], accounts: RawAccountMap): (RoutePlan | null)[] {
  return cash.map(c => {
    try { const parsed = routePlanSchema.safeParse(planExecLiqRoute(c.venue, { token, pool: c.pool, accounts })); return parsed.success ? parsed.data : null; } catch { return null; }
  });
}
const bankKeys = (target: string, plans: readonly (RoutePlan | null)[]): string[] =>
  sortUnique([target, ...plans.flatMap(p => p ? [...p.requiredKeys, ...p.additionalKeys] : [])]).filter(k => k !== EXEC_LIQ_CLOCK_SYSVAR);

/* PumpSwap route kernel: pinned 301-byte Pool, signed effective quote E = P + V, real accrued counters, current schedule. */
type PumpPool = {
  readonly index: number; readonly creator: string; readonly baseMint: string; readonly quoteMint: string; readonly baseVault: string; readonly quoteVault: string; readonly coinCreator: string;
  readonly mayhem: boolean; readonly cashback: boolean; readonly virtualQuote: bigint; readonly creatorFeeBps: bigint; readonly canEditCreatorFee: boolean; readonly holderReward: boolean;
  readonly protocolAccrued: bigint; readonly creatorAccrued: bigint;
};
function decodePumpPool(data: Buffer): PumpPool | null {
  if (data.length !== PUMP_POOL_BYTES || !data.subarray(0, 8).equals(PUMP_POOL_DISCRIMINATOR) || data.subarray(PUMP_POOL_PREFIX_BYTES).some(byte => byte !== 0)) return null;
  const flags = [243, 244, 269, 270].map(offset => data[offset]);
  if (flags.some(flag => flag !== 0 && flag !== 1)) return null;
  const key = (offset: number): string => encodeSolanaAddress(data.subarray(offset, offset + 32));
  return {
    index: data.readUInt16LE(9), creator: key(11), baseMint: key(43), quoteMint: key(75), baseVault: key(139), quoteVault: key(171), coinCreator: key(211),
    mayhem: flags[0] === 1, cashback: flags[1] === 1, virtualQuote: (data.readBigInt64LE(253) << 64n) + data.readBigUInt64LE(245), creatorFeeBps: data.readBigUInt64LE(261),
    canEditCreatorFee: flags[2] === 1, holderReward: flags[3] === 1, protocolAccrued: data.readBigUInt64LE(271), creatorAccrued: data.readBigUInt64LE(279),
  };
}
class PumpStop extends Error {
  readonly status: Exclude<QualityState, 'KNOWN'>;
  readonly reason: ExecLiqReason;
  constructor(status: Exclude<QualityState, 'KNOWN'>, reason: ExecLiqReason) { super(reason); this.status = status; this.reason = reason; }
}
function stop(status: Exclude<QualityState, 'KNOWN'>, reason: ExecLiqReason): never { throw new PumpStop(status, reason); }
type PumpState = {
  readonly pool: PumpPool; readonly B: bigint; readonly P: bigint; readonly E: bigint; readonly spendable: bigint; readonly supply: bigint;
  readonly rates: readonly [bigint, bigint, bigint]; readonly sellArgs: Record<string, unknown>; readonly facts: RouteFacts;
};
function pumpState(token: TokenRef, poolKey: string, accounts: RawAccountMap): PumpState {
  const read = (key: string): Decoded => {
    if (!has(accounts, key)) return stop('MISSING', 'ACCOUNT_NOT_READ');
    const raw = accounts[key];
    if (raw === null || raw === undefined) return stop('MISSING', 'ACCOUNT_NULL');
    return decodeAccount(raw) ?? stop('INVALID', 'ACCOUNT_SHAPE');
  };
  const info = (a: Decoded): AccountInfo<Buffer> => ({ data: a.data, owner: new PublicKey(a.account.owner), executable: a.account.executable, lamports: a.account.lamports, rentEpoch: 0 });
  const target = token.address, poolAccount = read(poolKey);
  if (poolAccount.account.owner !== EXEC_LIQ_PROGRAMS.PUMPSWAP) stop('INVALID', 'ACCOUNT_BINDING');
  const pool = decodePumpPool(poolAccount.data) ?? stop('UNSUPPORTED', 'LAYOUT_UNSUPPORTED');
  if (pool.baseMint === pool.quoteMint || pool.baseMint !== target && pool.quoteMint !== target) stop('UNSUPPORTED', 'NOT_TARGET_ROUTE');
  /* Quote-input BUY (SECOND_TO_FIRST) cannot use the base-input fee-floor theorem; the official SDK direction counterexample admits F = L. */
  if (pool.baseMint !== target) stop('UNSUPPORTED', 'PUMP_QUOTE_INPUT_BUY_UNPROVED');
  const globalAccount = read(GLOBAL_CONFIG_PDA.toBase58()), feeAccount = read(PUMP_AMM_FEE_CONFIG_PDA.toBase58());
  if (globalAccount.account.owner !== PUMP_AMM_PROGRAM_ID.toBase58() || feeAccount.account.owner !== PUMP_FEE_PROGRAM_ID.toBase58()) stop('INVALID', 'ACCOUNT_BINDING');
  const [globalConfig, feeConfig] = (() => {
    try { return [PUMP_AMM_SDK.decodeGlobalConfig(info(globalAccount)), PUMP_AMM_SDK.decodeFeeConfig(info(feeAccount))] as const; } catch { return stop('INVALID', 'PUMP_CONFIG_UNDECODABLE'); }
  })();
  if ((Number(globalConfig.disableFlags) & PUMP_SELL_DISABLED) !== 0) stop('UNSUPPORTED', 'ROUTE_DISABLED');
  if (pool.mayhem) stop('UNSUPPORTED', 'PUMP_MAYHEM_UNSUPPORTED');
  if (pool.cashback) stop('UNSUPPORTED', 'PUMP_CASHBACK_UNSUPPORTED');
  const baseMintAccount = read(pool.baseMint), quoteMintAccount = read(pool.quoteMint);
  if (!TOKEN_PROGRAMS.includes(baseMintAccount.account.owner) || !TOKEN_PROGRAMS.includes(quoteMintAccount.account.owner)) stop('INVALID', 'ACCOUNT_BINDING');
  /* Raw SPL mint base: isInitialized byte 45 must be exactly 1 and both COption discriminants exactly 0 or 1; decoded truthiness admits 2..255. */
  const mintRawOk = (d: Buffer): boolean => d.length >= 82 && d[45] === 1 && d.readUInt32LE(0) <= 1 && d.readUInt32LE(46) <= 1;
  if (!mintRawOk(baseMintAccount.data) || !mintRawOk(quoteMintAccount.data)) stop('INVALID', 'ACCOUNT_SHAPE');
  const controls = (() => {
    try { return decodeRawMintControls({ context: { slot: 0 }, value: { owner: baseMintAccount.account.owner, data: [...baseMintAccount.account.data] } }); } catch { return null; }
  })();
  if (!controls || !controls.complete || !controls.transferAllowed || controls.currentFeeBps !== '0' || !controls.feeImmutable) stop('UNSUPPORTED', 'TOKEN_MODE_UNSUPPORTED');
  const baseMint = (() => { try { return MintLayout.decode(baseMintAccount.data); } catch { return stop('INVALID', 'ACCOUNT_SHAPE'); } })();
  if (!baseMint.isInitialized) stop('INVALID', 'ACCOUNT_SHAPE');
  const admitted = (() => { try { return quoteAdmission(info(quoteMintAccount)); } catch { return stop('UNSUPPORTED', 'TOKEN_MODE_UNSUPPORTED'); } })();
  if (pool.quoteMint === NATIVE_MINT.toBase58() && (quoteMintAccount.account.owner !== LEGACY_TOKEN_PROGRAM || admitted.mint.decimals !== 9)) stop('INVALID', 'ACCOUNT_BINDING');
  const ata = (mint: string, program: string): string => getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(poolKey), true, new PublicKey(program)).toBase58();
  if (pool.baseVault !== ata(pool.baseMint, baseMintAccount.account.owner) || pool.quoteVault !== ata(pool.quoteMint, quoteMintAccount.account.owner)) stop('INVALID', 'ACCOUNT_BINDING');
  const vault = (key: string, mint: string, program: string, quote: ReturnType<typeof quoteAdmission> | undefined): bigint => {
    const a = read(key);
    if (a.account.owner !== program) stop('INVALID', 'ACCOUNT_BINDING');
    /* Raw SPL account base: state byte 108 in 0..2, delegate/native/closeAuthority COption discriminants exactly 0 or 1, checked before any coercing decoder. */
    const d = a.data;
    if (d.length < 165 || d[108] > 2 || d.readUInt32LE(72) > 1 || d.readUInt32LE(109) > 1 || d.readUInt32LE(129) > 1) stop('INVALID', 'ACCOUNT_SHAPE');
    if (d[108] !== 1 || d.readUInt32LE(72) !== 0 || d.readUInt32LE(129) !== 0) stop('INVALID', 'ACCOUNT_BINDING');
    const isNativeMint = mint === NATIVE_MINT.toBase58();
    if (d.readUInt32LE(109) !== (isNativeMint ? 1 : 0)) stop('INVALID', 'ACCOUNT_BINDING');
    try { validateVaultData(info(a), quote); } catch { stop('UNSUPPORTED', 'TOKEN_MODE_UNSUPPORTED'); }
    const v = (() => { try { return AccountLayout.decode(a.data); } catch { return stop('INVALID', 'ACCOUNT_SHAPE'); } })();
    if (v.mint.toBase58() !== mint || v.owner.toBase58() !== poolKey || v.state !== 1 || v.delegateOption !== 0 || v.closeAuthorityOption !== 0) stop('INVALID', 'ACCOUNT_BINDING');
    /* Wrapped SOL: amount must be backed by lamports above the recorded rent reserve; lamport surplus is never counted as liquidity. */
    if (isNativeMint && BigInt(a.account.lamports) < v.amount + d.readBigUInt64LE(113)) stop('INVALID', 'ACCOUNT_BINDING');
    return v.amount;
  };
  const B = vault(pool.baseVault, pool.baseMint, baseMintAccount.account.owner, undefined), P = vault(pool.quoteVault, pool.quoteMint, quoteMintAccount.account.owner, admitted);
  const supply = baseMint.supply;
  if (supply < B) stop('INVALID', 'ACCOUNT_BINDING');
  /* E prices the curve; only P minus the accrued protocol and creator counters is physically payable. */
  const E = P + pool.virtualQuote, spendable = P - pool.protocolAccrued - pool.creatorAccrued;
  if (spendable < 0n) stop('INVALID', 'PUMP_ACCRUED_EXCEEDS_PHYSICAL');
  if (B <= 0n || E <= 0n) stop('UNSUPPORTED', 'PUMP_RESERVES_DEGENERATE');
  const sellArgs: Record<string, unknown> = {
    baseReserve: new BN(B.toString()), quoteReserve: new BN(P.toString()), virtualQuoteReserves: new BN(pool.virtualQuote.toString()), globalConfig, baseMintAccount: baseMint,
    baseMint: new PublicKey(pool.baseMint), coinCreator: new PublicKey(pool.coinCreator), creator: new PublicKey(pool.creator), feeConfig, quoteMint: new PublicKey(pool.quoteMint),
    isMayhemMode: pool.mayhem, creatorFeeBps: new BN(pool.creatorFeeBps.toString()), slippage: 0,
  };
  const rates = (() => {
    try {
      const r = computeFeesBps({ ...sellArgs, baseMintSupply: new BN(supply.toString()), quoteReserve: new BN(E.toString()) } as unknown as Parameters<typeof computeFeesBps>[0]);
      return [BigInt(r.lpFeeBps.toString()), BigInt(r.protocolFeeBps.toString()), pool.coinCreator === DEFAULT_KEY ? 0n : BigInt(r.creatorFeeBps.toString())] as const;
    } catch { return stop('INVALID', 'PUMP_FEE_SCHEDULE_INVALID'); }
  })();
  if (rates.some(r => r < 0n)) stop('INVALID', 'PUMP_FEE_SCHEDULE_INVALID');
  const facts: RouteFacts = {
    p0: { num: E.toString(), den: B.toString() }, decimals: { input: baseMint.decimals, output: admitted.mint.decimals },
    vaults: {
      input: { address: pool.baseVault, mint: pool.baseMint, tokenProgram: baseMintAccount.account.owner, amountAtoms: B.toString() },
      output: { address: pool.quoteVault, mint: pool.quoteMint, tokenProgram: quoteMintAccount.account.owner, amountAtoms: P.toString() },
    },
  };
  return { pool, B, P, E, spendable, supply, rates, sellArgs, facts };
}
/** Exact base-input sell: gross = floor(x*E/(B+x)), three independent ceiling fees on gross, cross-checked against the official SDK sellBaseInput. */
function pumpQuote(s: PumpState, x: bigint): RouteQuote {
  const zero = { tradingInputAtoms: '0', tradingOutputAtoms: '0', transferInputAtoms: '0', transferOutputAtoms: '0' };
  if (x === 0n) return { inputAtoms: '0', consumedAtoms: '0', netAtoms: '0', complete: true, fees: zero };
  const gross = x * s.E / (s.B + x), [lp, protocol, creator] = s.rates.map(bps => (gross * bps + 9999n) / 10000n) as [bigint, bigint, bigint];
  const net = gross - lp - protocol - creator, fees = { ...zero, tradingOutputAtoms: (lp + protocol + creator).toString() };
  if (net < 0n || net + protocol + creator > s.spendable) return { inputAtoms: x.toString(), consumedAtoms: '0', netAtoms: '0', complete: false, fees };
  let sdkNet: bigint | null = null;
  try { sdkNet = BigInt(sellBaseInput({ ...s.sellArgs, base: new BN(x.toString()) } as unknown as Parameters<typeof sellBaseInput>[0]).uiQuote.toString()); } catch { sdkNet = null; }
  if (sdkNet !== net) throw new PumpStop('INVALID', 'PUMP_SDK_QUOTE_MISMATCH');
  return { inputAtoms: x.toString(), consumedAtoms: x.toString(), netAtoms: net.toString(), complete: true, fees };
}

export function planPumpRoute(input: ExecLiqPlanInput): RoutePlan {
  const { pool, accounts } = input, target = input.token.address;
  const required = new Set([pool, target, GLOBAL_CONFIG_PDA.toBase58(), PUMP_AMM_FEE_CONFIG_PDA.toBase58()]), mutable = new Set([pool]);
  let route: RouteMeta | null = null, rejected: ExecLiqReason | null = null, open = true;
  if (has(accounts, pool)) {
    open = false;
    const raw = accounts[pool], decoded = raw ? decodeAccount(raw) : null;
    const layout = decoded && decoded.account.owner === EXEC_LIQ_PROGRAMS.PUMPSWAP ? decodePumpPool(decoded.data) : null;
    if (raw === null || raw === undefined) rejected = 'ACCOUNT_NULL';
    else if (decoded === null) rejected = 'ACCOUNT_SHAPE';
    else if (decoded.account.owner !== EXEC_LIQ_PROGRAMS.PUMPSWAP) rejected = 'ACCOUNT_BINDING';
    else if (layout === null) rejected = 'LAYOUT_UNSUPPORTED';
    else if (layout.baseMint === layout.quoteMint || layout.baseMint !== target && layout.quoteMint !== target) rejected = 'NOT_TARGET_ROUTE';
    else {
      const first = layout.baseMint === target, outputMint = first ? layout.quoteMint : layout.baseMint;
      const vaults = first ? { input: layout.baseVault, output: layout.quoteVault } : { input: layout.quoteVault, output: layout.baseVault };
      for (const key of [layout.baseMint, layout.quoteMint, vaults.input, vaults.output]) required.add(key);
      mutable.add(vaults.input); mutable.add(vaults.output);
      const inputBody = accounts[target], outputBody = accounts[outputMint];
      route = { outputMint, direction: first ? 'FIRST_TO_SECOND' : 'SECOND_TO_FIRST', vaults, tokenPrograms: inputBody && outputBody ? { input: inputBody.owner, output: outputBody.owner } : null };
    }
  }
  /* Route-specific keys only: the Clock is global, added by core to every common math bank and never planned, as for every adapter. */
  required.delete(EXEC_LIQ_CLOCK_SYSVAR);
  const requiredKeys = [...required].sort();
  return {
    venue: 'PUMPSWAP', programId: EXEC_LIQ_PROGRAMS.PUMPSWAP, pool, targetMint: target, route, requiredKeys, additionalKeys: [],
    missingKeys: requiredKeys.filter(k => !has(accounts, k)), nullKeys: requiredKeys.filter(k => has(accounts, k) && accounts[k] === null),
    open, mutableKeys: [...mutable].filter(k => required.has(k)).sort(), rejected,
  };
}
/** Clock admission of the public Pump quote/solve. The typed Clock must be of the bank's own slot, and the raw Clock sysvar must be read, non-null, sysvar-owned, well-formed, and must decode to exactly that Clock. The common math bank must carry this raw Clock: core adds the global Clock to every bank part, and route plans exclude it, so it is bound here independently of the typed Clock and of any plan. Stops otherwise: absent MISSING/ACCOUNT_NOT_READ, null MISSING/ACCOUNT_NULL, foreign owner INVALID/ACCOUNT_BINDING, malformed INVALID/ACCOUNT_SHAPE, disagreement CONFLICT/CLOCK_MISMATCH. */
function pumpClock(bank: CoherentBank): void {
  const clock: unknown = bank.clock;
  if (!isObject(clock) || clock.slot !== bank.slot) stop('CONFLICT', 'CLOCK_MISMATCH');
  if (!has(bank.accounts, EXEC_LIQ_CLOCK_SYSVAR)) stop('MISSING', 'ACCOUNT_NOT_READ');
  const body = bank.accounts[EXEC_LIQ_CLOCK_SYSVAR];
  if (body === null || body === undefined) stop('MISSING', 'ACCOUNT_NULL');
  const decoded = decodeAccount(body);
  if (decoded !== null && decoded.account.owner !== SYSVAR_OWNER) stop('INVALID', 'ACCOUNT_BINDING');
  const raw = decodeClock(body);
  if (raw === null) stop('INVALID', 'ACCOUNT_SHAPE');
  if (!isDeepStrictEqual(raw, clock)) stop('CONFLICT', 'CLOCK_MISMATCH');
}
export function quotePumpRoute(input: ExecLiqQuoteInput): RouteQuote {
  if (!ATOMIC.test(input.inputAtoms)) throw new Error('ARITHMETIC_RANGE');
  pumpClock(input.bank);
  return pumpQuote(pumpState(input.token, input.pool, input.bank.accounts), BigInt(input.inputAtoms));
}
export function solvePumpRoute(input: ExecLiqSolveInput): RouteSolve {
  const { bank, impactBps } = input, plan = planPumpRoute({ token: input.token, pool: input.pool, accounts: bank.accounts });
  const result = (outcome: RouteOutcome): RouteSolve => ({ adapterVersion: EXEC_LIQ_PUMP_VERSION, plan, bankSlot: bank.slot, clock: bank.clock, impactBps, outcome });
  const not = (status: Exclude<QualityState, 'KNOWN'>, reason: ExecLiqReason, facts: RouteFacts | null = null): RouteSolve => result({ status, reasons: [reason], facts, certificate: null });
  if (!Number.isSafeInteger(impactBps) || impactBps < 0 || impactBps > 10_000) return not('INVALID', 'ARITHMETIC_RANGE');
  try { pumpClock(bank); } catch (error) { if (error instanceof PumpStop) return not(error.status, error.reason); throw error; }
  if (plan.rejected !== null) return not(plan.rejected === 'ACCOUNT_NULL' ? 'MISSING' : plan.rejected === 'ACCOUNT_SHAPE' || plan.rejected === 'ACCOUNT_BINDING' ? 'INVALID' : 'UNSUPPORTED', plan.rejected);
  if (plan.open || plan.missingKeys.length > 0) return not('MISSING', 'ACCOUNT_NOT_READ');
  if (plan.nullKeys.length > 0) return not('MISSING', 'ACCOUNT_NULL');
  let state: PumpState;
  try { state = pumpState(input.token, input.pool, bank.accounts); } catch (error) { return error instanceof PumpStop ? not(error.status, error.reason) : not('INVALID', 'PUMP_STATE_UNDECODABLE'); }
  const [lp, protocol, creator] = state.rates, total = lp + protocol + creator, limit = BigInt(impactBps);
  /* No positive monotone-N solver: a positive Pump case stays visible and non-KNOWN. */
  if (limit >= 10_000n || total < limit) return not('UNSUPPORTED', 'PUMP_POSITIVE_UNPROVED', state.facts);
  const witnesses: CapacityWitness[] = [
    { role: 'CHOSEN', inputAtoms: '0', netAtoms: '0', complete: true, admissible: true },
    { role: 'MAX_ADMISSIBLE', inputAtoms: '0', netAtoms: '0', complete: true, admissible: true },
  ];
  try {
    const q = pumpQuote(state, 1n), full = q.complete && q.consumedAtoms === q.inputAtoms;
    witnesses.push({ role: 'BOUNDARY', inputAtoms: '1', netAtoms: q.netAtoms, complete: q.complete, admissible: full && BigInt(q.netAtoms) * state.B * 10_000n >= state.E * (10_000n - limit) });
  } catch { /* the fee-floor argument needs no sample point */ }
  const diagnostics: { readonly [key: string]: JsonValue } = {
    proof: 'STRICT_CONSTANT_PRODUCT_BASE_INPUT_SELL_FEE_FLOOR',
    argument: 'net*10000 <= gross*(10000-F) <= gross*(10000-L) and gross*B < x*E for every x > 0, so with F >= L and L < 10000 no positive input is admissible',
    feesBps: [lp, protocol, creator].map(String), totalFeeBps: total.toString(), impactBps,
    baseReserveAtoms: state.B.toString(), physicalQuoteAtoms: state.P.toString(), virtualQuoteAtoms: state.pool.virtualQuote.toString(), effectiveQuoteAtoms: state.E.toString(),
    protocolAccruedAtoms: state.pool.protocolAccrued.toString(), creatorAccruedAtoms: state.pool.creatorAccrued.toString(), spendableQuoteAtoms: state.spendable.toString(),
    poolCreatorFeeBps: state.pool.creatorFeeBps.toString(), coinCreatorUnset: state.pool.coinCreator === DEFAULT_KEY, holderReward: state.pool.holderReward,
    canEditCreatorFee: state.pool.canEditCreatorFee, poolIndex: state.pool.index, supplyAtoms: state.supply.toString(),
  };
  const certificate: CapacityCertificate = { kind: 'PUMP_FEE_FLOOR', maximal: true, domainEndAtoms: null, witnesses, diagnostics };
  return result({ status: 'KNOWN', netAtoms: '0', inputAtoms: '0', maxAdmissibleInputAtoms: '0', zero: 'NO_ADMISSIBLE_INPUT', facts: state.facts, certificate });
}

export function planExecLiqRoute(venue: ExecLiqVenue, input: ExecLiqPlanInput): RoutePlan {
  if (venue === 'PUMPSWAP') return planPumpRoute(input);
  if (venue === 'DLMM') return planDlmmRoute(input);
  return planDammRoute(input);
}
export function solveExecLiqRoute(venue: ExecLiqVenue, input: ExecLiqSolveInput): RouteSolve {
  if (venue === 'PUMPSWAP') return solvePumpRoute(input);
  if (venue === 'DLMM') return solveDlmmRoute(input);
  return solveDammRoute(input);
}
function quoteExecLiqRoute(venue: ExecLiqVenue, input: ExecLiqQuoteInput): RouteQuote {
  if (venue === 'PUMPSWAP') return quotePumpRoute(input);
  if (venue === 'DLMM') return quoteDlmmRoute(input);
  return quoteDammRoute(input);
}

export function execLiqInventoryRequest(token: TokenRef, frameId: ExecLiqFrameId): ExecLiqInventoryRequest {
  const frame = EXEC_LIQ_INVENTORY_FRAMES.find(f => f.frameId === frameId);
  if (!frame || token.chain !== 'solana') throw new Error('EXEC_LIQ_SOLANA_REQUIRED');
  return execLiqInventoryRequestSchema.parse({
    jsonrpc: '2.0', id: 1, method: 'getProgramAccounts',
    params: [frame.programId, { encoding: 'base64', commitment: 'finalized', withContext: true, filters: [{ memcmp: { offset: 0, bytes: frame.discriminator } }, { memcmp: { offset: frame.targetOffset, bytes: token.address } }] }],
  });
}
export function execLiqAccountsRequest(keys: readonly string[], minContextSlot?: number): ExecLiqAccountsRequest {
  const config = minContextSlot === undefined ? { encoding: 'base64', commitment: 'finalized' } : { encoding: 'base64', commitment: 'finalized', minContextSlot };
  return execLiqAccountsRequestSchema.parse({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [[...keys], config] });
}

function requestRecord(artifact: ExecLiqRequestArtifact, raw: string): EvidenceRecord {
  const usd = artifact.role === 'USD';
  return {
    id: `execliq-req-${artifact.sequence}`, sourceId: usd ? EXEC_LIQ_SOURCE_IDS.usd : EXEC_LIQ_SOURCE_IDS.rpc, sourceType: usd ? 'HTTP_JSON' : 'JSON_RPC',
    retrievedAt: artifact.completedAt, availableAt: artifact.completedAt, contentHash: sha256(raw), adapterVersion: EXEC_LIQ_CAPTURE_ADAPTER, accessMode: 'PUBLIC_API',
    scope: { method: EXEC_LIQ_METHOD, requestId: artifact.requestId, role: artifact.role, sequence: artifact.sequence },
  };
}
export function execLiqDerivationRecord(facts: ExecutableLiquidityFacts): { readonly record: EvidenceRecord; readonly raw: string } {
  const raw = JSON.stringify(facts);
  return {
    raw,
    record: {
      id: EXEC_LIQ_DERIVATION_ID, sourceId: EXEC_LIQ_SOURCE_IDS.derivation, sourceType: 'CALCULATION', retrievedAt: facts.cutoff, availableAt: facts.cutoff,
      contentHash: sha256(raw), adapterVersion: EXEC_LIQ_METHOD, accessMode: 'LOCAL_DERIVED', scope: { method: EXEC_LIQ_METHOD, definitionsVersion: EXEC_LIQ_DEFINITIONS_VERSION },
    },
  };
}

export type ExecLiqCollectInput = {
  readonly token: TokenRef;
  /** Deadline-only wrapper of options.fetcher ?? fetch: no request-count pool, so failed attempts are retried without a fixed budget. */
  readonly fetcher: typeof fetch;
  /** Sends RPC requests only; never written to any artifact, record, catalog, error text or log. */
  readonly rpcUrl: string;
  /** The live run deadline; when it fires the current attempt is retained as DEADLINE and collection ends. */
  readonly signal: AbortSignal;
  readonly now: () => string;
  /** Pause between a retained failed attempt and its retry; injected by tests. Default capped exponential backoff. */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
};
/** Only execliq-req-<sequence> records (send order) and their raw artifacts. The caller adds them after every existing derivation. */
export type ExecLiqCapture = { readonly records: readonly EvidenceRecord[]; readonly rawArtifacts: Readonly<Record<string, string>> };

const backoffWait = (ms: number, signal: AbortSignal): Promise<void> => new Promise<void>(resolve => {
  if (signal.aborted) { resolve(); return; }
  const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal.addEventListener('abort', done, { once: true });
});
/** Text fragments of the RPC URL that must never be retained: the URL, its query values, long path segments and any password. */
function rpcSecrets(rpcUrl: string): string[] {
  const out = [rpcUrl];
  try {
    const url = new URL(rpcUrl);
    for (const value of url.searchParams.values()) if (value.length >= 8) out.push(value);
    for (const segment of url.pathname.split('/')) if (segment.length >= 16) out.push(segment);
    if (url.password) out.push(url.password);
  } catch { /* the whole URL text stays the guard */ }
  return out.filter(s => s.length > 0);
}

/**
 * Never rejects on a network or content failure: every attempt is retained as OK or FAILED in send order. Genesis first and only a verified mainnet
 * genesis artifact lets collection continue; then the six inventory frames, discovery rounds, whole-bank rounds and the USD request last.
 */
export async function collectExecutableLiquidity(input: ExecLiqCollectInput): Promise<ExecLiqCapture> {
  let target: Buffer;
  try { if (input.token.chain !== 'solana') throw new Error('chain'); target = decodeSolanaAddress(input.token.address); } catch { throw new Error('EXEC_LIQ_SOLANA_REQUIRED'); }
  const token: ExecLiqToken = { chain: 'solana', address: input.token.address };
  const records: EvidenceRecord[] = [], rawArtifacts: Record<string, string> = {}, secrets = rpcSecrets(input.rpcUrl), wait = input.wait ?? backoffWait;
  const capture = (): ExecLiqCapture => ({ records: [...records], rawArtifacts: { ...rawArtifacts } });
  let sequence = 0, halted = false;
  const pause = async (failures: number): Promise<void> => {
    await wait(Math.min(250 * 2 ** Math.min(failures, 6), 10_000), input.signal).catch(() => undefined);
    if (input.signal.aborted) halted = true;
  };
  type Sent = { readonly artifactId: string; readonly parsed: unknown };
  const send = async (role: ExecLiqRequestArtifact['role'], requestId: string, request: ExecLiqRequest, extra: Readonly<Record<string, string | number>>, check: (text: string) => Check): Promise<Sent | null> => {
    const usd = role === 'USD', url = usd ? EXEC_LIQ_USD_URL : input.rpcUrl, maxBytes = usd ? EXEC_LIQ_USD_MAX_BYTES : EXEC_LIQ_RPC_MAX_BYTES;
    for (let failures = 0; ;) {
      if (input.signal.aborted) { halted = true; return null; }
      const seq = ++sequence, startedAt = input.now();
      let httpStatus: number | null = null, body: string | null = null, code: ExecLiqFailureCode | null = null, parsed: unknown = null;
      try {
        const response = await input.fetcher(url, usd
          ? { method: 'GET', headers: { accept: 'application/json' }, signal: input.signal }
          : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: input.signal });
        const status = response.status;
        httpStatus = status;
        try { body = await readLimitedText(response, maxBytes); }
        catch (error) {
          const message = error instanceof Error ? error.message : '';
          code = input.signal.aborted ? 'DEADLINE' : message === 'PROVIDER_RESPONSE_LIMIT' ? 'BODY_TOO_LARGE' : message === 'PROVIDER_EMPTY_RESPONSE' ? 'BODY_INVALID' : 'NETWORK';
          await response.body?.cancel().catch(() => undefined);
        }
        if (code === null || code === 'BODY_INVALID') {
          if (status === 429) code = 'RATE_LIMITED';
          else if (status < 200 || status > 299) code = 'HTTP_STATUS';
          else if (code === null && body !== null) {
            const text = body;
            if (secrets.some(s => text.includes(s))) { code = 'BODY_INVALID'; body = null; }
            else { const checked = check(text); if (checked.ok) parsed = checked.parsed; else code = checked.code; }
          }
        }
      } catch { code = input.signal.aborted ? 'DEADLINE' : 'NETWORK'; }
      let completedAt = input.now();
      if (Date.parse(completedAt) < Date.parse(startedAt)) completedAt = startedAt;
      const status = httpStatus !== null && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null, text = body;
      const retainedBody = text !== null && !secrets.some(s => text.includes(s)) ? text : null;
      const response = code === null ? { status: 'OK', httpStatus: status, body: retainedBody } : { status: 'FAILED', code, httpStatus: status, body: retainedBody };
      const artifact = execLiqRequestArtifactSchema.parse({ artifactVersion: EXEC_LIQ_REQUEST_ARTIFACT_VERSION, method: EXEC_LIQ_METHOD, token, sequence: seq, requestId, startedAt, completedAt, response, role, ...extra, request });
      const raw = JSON.stringify(artifact), artifactId = `execliq-req-${seq}`;
      rawArtifacts[artifactId] = raw; records.push(requestRecord(artifact, raw));
      if (code === null) return { artifactId, parsed };
      if (code === 'DEADLINE') { halted = true; return null; }
      if (code === 'BODY_TOO_LARGE' || code === 'HTTP_STATUS' && status !== null && status < 500) return null;
      failures += 1;
      await pause(failures);
      if (halted) return null;
    }
  };

  const genesis = await send('GENESIS', EXEC_LIQ_GENESIS_REQUEST_ID, { jsonrpc: '2.0', id: 1, method: 'getGenesisHash', params: [] }, {}, text => rpcCheck(text, genesisResult));
  if (!genesis || !verifyExecLiqGenesisArtifact(rawArtifacts[genesis.artifactId], token)) return capture();

  const frames: (GpaFrame | null)[] = [];
  for (const frame of EXEC_LIQ_INVENTORY_FRAMES) {
    const sent = await send('INVENTORY', `inventory-${frame.frameId}`, execLiqInventoryRequest(token, frame.frameId), { frameId: frame.frameId }, text => rpcCheck(text, result => parseGpa(result, frame, target)));
    if (halted) return capture();
    frames.push(sent ? sent.parsed as GpaFrame : null);
  }
  const slots = frames.flatMap(f => f ? [f.slot] : []), minSlot = slots.length > 0 ? Math.max(...slots) : undefined;
  const { cash } = classify(frames);

  /* Discovery: inventory pool bodies seed key planning only; final math never reads them. */
  const known: Record<string, RpcAccount | null> = {};
  for (const route of cash) known[route.pool] = route.account;
  let discoveryRound = 0;
  discovery: for (;;) {
    const missing = sortUnique(planAll(input.token, cash, known).flatMap(p => p ? p.missingKeys : [])).filter(k => !has(known, k) && k !== EXEC_LIQ_CLOCK_SYSVAR);
    if (missing.length === 0) break;
    for (const keys of chunk(missing, EXEC_LIQ_MAX_BANK_KEYS)) {
      discoveryRound += 1;
      const sent = await send('DISCOVERY', `discovery-${discoveryRound}`, execLiqAccountsRequest(keys, minSlot), { round: discoveryRound }, text => rpcCheck(text, result => parseAccounts(result, keys, minSlot)));
      if (halted) return capture();
      if (!sent) break discovery;
      Object.assign(known, (sent.parsed as AccountsBody).accounts);
    }
  }

  /* Bank: the whole planned key set plus the Clock in every part; a changed key set is recaptured whole, never merged with older bodies. */
  let keys = bankKeys(token.address, planAll(input.token, cash, known)), conflicts = 0;
  bank: for (let round = 1; ; round++) {
    const groups = chunk(keys, EXEC_LIQ_MAX_BANK_KEYS - 1), bodies: AccountsBody[] = [];
    for (const [i, group] of groups.entries()) {
      const partKeys = sortUnique([...group, EXEC_LIQ_CLOCK_SYSVAR]);
      const sent = await send('BANK', `bank-${round}-${i + 1}`, execLiqAccountsRequest(partKeys, minSlot), { round, part: i + 1, partCount: groups.length }, text => rpcCheck(text, result => parseAccounts(result, partKeys, minSlot)));
      if (halted) return capture();
      if (!sent) break bank;
      bodies.push(sent.parsed as AccountsBody);
    }
    const merged = mergeBank(bodies);
    if (!merged.ok) { conflicts += 1; await pause(conflicts); if (halted) return capture(); continue; }
    const next = bankKeys(token.address, planAll(input.token, cash, merged.bank.accounts));
    if (next.every(k => has(merged.bank.accounts, k))) break;
    keys = next;
  }

  await send('USD', 'usd-refs', { method: 'GET', url: EXEC_LIQ_USD_URL }, {}, usdCheck);
  return capture();
}

type Receipt = { readonly id: string; readonly record: EvidenceRecord; readonly raw: string; readonly artifact: ExecLiqRequestArtifact; readonly parsed: unknown };
const requestIdentity = (a: ExecLiqRequestArtifact): unknown => ({
  role: a.role, request: a.request, frameId: a.role === 'INVENTORY' ? a.frameId : null, round: a.role === 'BANK' || a.role === 'DISCOVERY' ? a.round : null,
  part: a.role === 'BANK' ? a.part : null, partCount: a.role === 'BANK' ? a.partCount : null,
});
/** Owned request receipts: record shape, exact artifact bytes, metadata binding, 1..n sequence, request identity and OK-body validity. */
function checkReceipts(token: ExecLiqToken, target: Buffer, evidence: readonly EvidenceRecord[], rawArtifacts: Readonly<Record<string, string>>): { readonly ok: true; readonly receipts: readonly Receipt[] } | Fail {
  const owned = evidence.filter(e => isExecLiqOwnedRecord(e) && e.id !== EXEC_LIQ_DERIVATION_ID), ids = new Set<string>();
  for (const e of owned) {
    const raw = rawArtifacts[e.id];
    const source = e.sourceId === EXEC_LIQ_SOURCE_IDS.rpc && e.sourceType === 'JSON_RPC' || e.sourceId === EXEC_LIQ_SOURCE_IDS.usd && e.sourceType === 'HTTP_JSON';
    if (!EXEC_LIQ_REQUEST_RECORD_PATTERN.test(e.id) || ids.has(e.id) || typeof raw !== 'string' || e.contentHash !== sha256(raw) || e.adapterVersion !== EXEC_LIQ_CAPTURE_ADAPTER
      || e.accessMode !== 'PUBLIC_API' || e.retrievedAt !== e.availableAt || !source) return fail('EXEC_LIQ_RECORD_INVALID', `owned record ${e.id.slice(0, 64)} is not a request receipt`);
    ids.add(e.id);
  }
  if (Object.keys(rawArtifacts).some(k => k.startsWith(EXEC_LIQ_RECORD_PREFIX) && k !== EXEC_LIQ_DERIVATION_ID && !ids.has(k))) return fail('EXEC_LIQ_RECORD_INVALID', 'an owned raw artifact has no request record');
  const receipts: Receipt[] = [];
  for (const record of owned) {
    const raw = rawArtifacts[record.id] as string, parsed = execLiqRequestArtifactSchema.safeParse(parseJson(raw));
    if (!parsed.success || JSON.stringify(parsed.data) !== raw || `execliq-req-${parsed.data.sequence}` !== record.id || parsed.data.token.address !== token.address)
      return fail('EXEC_LIQ_ARTIFACT_INVALID', `${record.id} is not an exact request artifact of this token`);
    receipts.push({ id: record.id, record, raw, artifact: parsed.data, parsed: null });
  }
  for (const r of receipts) if (!isDeepStrictEqual(r.record, requestRecord(r.artifact, r.raw))) return fail('EXEC_LIQ_RECORD_INVALID', `${r.id} metadata does not match its artifact`);
  receipts.sort((a, b) => a.artifact.sequence - b.artifact.sequence);
  if (receipts.some((r, i) => r.artifact.sequence !== i + 1)) return fail('EXEC_LIQ_SEQUENCE_GAP', 'request sequences are not exactly 1..n');
  const lastGenesis = [...receipts].reverse().find(r => r.artifact.role === 'GENESIS'), firstOther = receipts.find(r => r.artifact.role !== 'GENESIS');
  if (lastGenesis && firstOther && lastGenesis.artifact.sequence > firstOther.artifact.sequence) return fail('EXEC_LIQ_ARTIFACT_INVALID', 'genesis attempts must precede every other request');
  const identities = new Map<string, string>(), partCounts = new Map<number, number>(), out: Receipt[] = [];
  for (const r of receipts) {
    const a = r.artifact, identity = canonical(requestIdentity(a)), prior = identities.get(a.requestId);
    if (prior !== undefined && prior !== identity) return fail('EXEC_LIQ_ARTIFACT_INVALID', `${a.requestId} attempts differ in their request`);
    identities.set(a.requestId, identity);
    if (a.role === 'INVENTORY' && canonical(a.request) !== canonical(execLiqInventoryRequest(token, a.frameId))) return fail('EXEC_LIQ_ARTIFACT_INVALID', 'an inventory request is not the canonical frame body');
    if (a.role === 'BANK') {
      const count = partCounts.get(a.round);
      if (count !== undefined && count !== a.partCount) return fail('EXEC_LIQ_ARTIFACT_INVALID', 'bank parts of one round disagree on partCount');
      partCounts.set(a.round, a.partCount);
    }
    let parsed: unknown = null;
    if (a.response.status === 'OK') {
      const body = a.response.body, frame = a.role === 'INVENTORY' ? frameOf(a.frameId) : null;
      const keys = a.role === 'BANK' || a.role === 'DISCOVERY' ? a.request.params[0] : [], minSlot = a.role === 'BANK' || a.role === 'DISCOVERY' ? a.request.params[1].minContextSlot : undefined;
      const checked = a.role === 'GENESIS' ? rpcCheck(body, genesisResult) : a.role === 'USD' ? usdCheck(body)
        : frame !== null ? rpcCheck(body, result => parseGpa(result, frame, target)) : rpcCheck(body, result => parseAccounts(result, keys, minSlot));
      if (!checked.ok) return fail('EXEC_LIQ_ARTIFACT_INVALID', `${r.id} is OK but its body is not a valid response`);
      parsed = checked.parsed;
    }
    out.push({ ...r, parsed });
  }
  return { ok: true, receipts: out };
}

/** One reference per cash mint: solana rows with the mint as base and a positive decimal priceUsd, by liquidity.usd descending (absent last) then pairAddress. */
function usdRefs(body: string): UsdRef[] {
  const parsed = parseJson(body), rows = Array.isArray(parsed) ? parsed.filter(isObject) : [];
  return EXEC_LIQ_CASH_OUTPUTS.map(({ asset, mint }): UsdRef => {
    const base = rows.filter(r => r['chainId'] === 'solana' && field(r['baseToken'], 'address') === mint);
    const priced = base.flatMap(r => {
      const pair = r['pairAddress'], text = r['priceUsd'], liquidity = field(r['liquidity'], 'usd'), dex = r['dexId'];
      if (typeof pair !== 'string' || pair.length < 1 || pair.length > 128 || typeof text !== 'string' || !DECIMAL.test(text)) return [];
      const [whole, fraction = ''] = text.split('.'), num = BigInt(`${whole ?? '0'}${fraction}`);
      if (num === 0n) return [];
      return [{
        pairAddress: pair, dexId: typeof dex === 'string' && dex.length >= 1 && dex.length <= 64 ? dex : null, priceUsdText: text,
        priceUsd: { num: num.toString(), den: (10n ** BigInt(fraction.length)).toString() }, liquidityUsd: typeof liquidity === 'number' && Number.isFinite(liquidity) && liquidity >= 0 ? liquidity : null,
      }];
    });
    priced.sort((a, b) => a.liquidityUsd !== b.liquidityUsd
      ? (a.liquidityUsd === null ? 1 : b.liquidityUsd === null ? -1 : b.liquidityUsd - a.liquidityUsd)
      : a.pairAddress < b.pairAddress ? -1 : a.pairAddress > b.pairAddress ? 1 : 0);
    const best = priced[0];
    if (best) return { mint, asset, status: 'KNOWN', ...best };
    return { mint, asset, status: 'MISSING', code: base.length === 0 ? 'NO_BASE_ROW' : 'NO_POSITIVE_PRICE' };
  });
}

/** Every KNOWN chosen point and witness is re-quoted by the actual adapter: exact input, net, completeness, full consumption and own-p0 admissibility. */
function requoteConsistent(venue: ExecLiqVenue, token: TokenRef, pool: string, bank: CoherentBank, o: KnownOutcome): boolean {
  try {
    const num = BigInt(o.facts.p0.num), den = BigInt(o.facts.p0.den), keep = BigInt(10_000 - EXEC_LIQ_IMPACT_BPS);
    if (den <= 0n) return false;
    const evaluate = (x: string) => {
      const q = quoteExecLiqRoute(venue, { token, pool, bank, inputAtoms: x });
      const fields: unknown[] = [q.inputAtoms, q.consumedAtoms, q.netAtoms, q.fees.tradingInputAtoms, q.fees.tradingOutputAtoms, q.fees.transferInputAtoms, q.fees.transferOutputAtoms];
      if (fields.some(f => typeof f !== 'string' || !ATOMIC.test(f)) || typeof q.complete !== 'boolean' || q.inputAtoms !== x) return null;
      const full = q.complete && q.consumedAtoms === q.inputAtoms;
      return { net: q.netAtoms, complete: q.complete, full, admissible: full && BigInt(q.netAtoms) * den * 10_000n >= BigInt(x) * num * keep };
    };
    const chosen = evaluate(o.inputAtoms);
    if (!chosen || !chosen.full || !chosen.admissible || chosen.net !== o.netAtoms) return false;
    const witnesses = o.certificate.witnesses;
    if (!witnesses.some(w => w.role === 'CHOSEN' && w.inputAtoms === o.inputAtoms && w.netAtoms === o.netAtoms)) return false;
    if (o.maxAdmissibleInputAtoms !== null && !witnesses.some(w => w.role === 'MAX_ADMISSIBLE' && w.inputAtoms === o.maxAdmissibleInputAtoms && w.admissible)) return false;
    const chosenInput = BigInt(o.inputAtoms), chosenNet = BigInt(o.netAtoms);
    for (const w of witnesses) {
      const r = evaluate(w.inputAtoms);
      if (!r || r.net !== w.netAtoms || r.complete !== w.complete || r.admissible !== w.admissible) return false;
      const x = BigInt(w.inputAtoms), net = BigInt(w.netAtoms);
      if ((w.role === 'CHOSEN' || w.role === 'MAX_ADMISSIBLE') && !w.admissible) return false;
      if (w.role === 'ABOVE_MAX_ADMISSIBLE' && w.admissible) return false;
      if (w.admissible && (net > chosenNet || net === chosenNet && x < chosenInput)) return false;
    }
    return true;
  } catch { return false; }
}
function routeUsd(o: RouteOutcome, outputMint: string, prices: ReadonlyMap<string, Rational>): ExecLiqRoute['usd'] {
  if (o.status !== 'KNOWN') return null;
  if (o.netAtoms === '0') return { netUsd: ZERO, referenceNotionalUsd: ZERO };
  const price = prices.get(outputMint);
  if (!price) return null;
  const scale = 10n ** BigInt(o.facts.decimals.output), pn = BigInt(price.num), pd = BigInt(price.den);
  return {
    netUsd: toRational(ratio(BigInt(o.netAtoms) * pn, pd * scale)),
    referenceNotionalUsd: toRational(ratio(BigInt(o.inputAtoms) * BigInt(o.facts.p0.num) * pn, BigInt(o.facts.p0.den) * pd * scale)),
  };
}
function solveCashRoute(token: TokenRef, route: CashRoute, bank: CoherentBank | null, bankFact: ExecLiqBank, prices: ReadonlyMap<string, Rational>): ExecLiqRoute {
  const base = { pool: route.pool, venue: route.venue, programId: route.programId, frameIds: [...route.frameIds], dataLength: route.dataLength, outputMint: route.outputMint, cashAsset: route.cashAsset, direction: route.direction };
  if (bank === null) {
    const outcome: RouteOutcome = bankFact.status === 'CONFLICT' ? { status: 'CONFLICT', reasons: ['CLOCK_MISMATCH'], facts: null, certificate: null }
      : bankFact.status === 'INVALID' ? { status: 'INVALID', reasons: ['CLOCK_MISMATCH'], facts: null, certificate: null } : { status: 'MISSING', reasons: ['ACCOUNT_NOT_READ'], facts: null, certificate: null };
    return { ...base, adapterVersion: null, plan: null, outcome, usd: null };
  }
  const prefix = venuePrefix(route.venue), adapterVersion = EXEC_LIQ_ROUTE_ADAPTERS[route.venue];
  const invalid = (tail: string, facts: RouteFacts | null = null, certificate: CapacityCertificate | null = null): RouteOutcome => ({ status: 'INVALID', reasons: [`${prefix}_${tail}` as ExecLiqReason], facts, certificate });
  let plan: RoutePlan;
  try {
    const parsed = routePlanSchema.safeParse(planExecLiqRoute(route.venue, { token, pool: route.pool, accounts: bank.accounts }));
    if (!parsed.success) return { ...base, adapterVersion: null, plan: null, outcome: invalid('ADAPTER_PLAN_INVALID'), usd: null };
    plan = parsed.data;
  } catch { return { ...base, adapterVersion: null, plan: null, outcome: invalid('ADAPTER_ERROR'), usd: null }; }
  let outcome: RouteOutcome;
  try {
    const solved = solveExecLiqRoute(route.venue, { token, pool: route.pool, bank, impactBps: EXEC_LIQ_IMPACT_BPS }), parsed = routeOutcomeSchema.safeParse(solved.outcome);
    outcome = !parsed.success || solved.adapterVersion !== adapterVersion || canonical(solved.plan) !== canonical(plan) || solved.bankSlot !== bank.slot
      || !isDeepStrictEqual(solved.clock, bank.clock) || solved.impactBps !== EXEC_LIQ_IMPACT_BPS ? invalid('ADAPTER_INCONSISTENT') : parsed.data;
  } catch { outcome = invalid('ADAPTER_ERROR'); }
  if (outcome.status === 'KNOWN') {
    const known = outcome, meta = plan.route;
    if (plan.rejected !== null || plan.open || plan.missingKeys.length > 0 || meta === null) outcome = { status: 'MISSING', reasons: ['KEY_SET_OPEN'], facts: known.facts, certificate: known.certificate };
    else if (meta.outputMint !== route.outputMint || meta.direction !== route.direction || known.facts.vaults.output.mint !== route.outputMint || known.facts.vaults.input.mint !== token.address)
      outcome = { status: 'INVALID', reasons: ['ACCOUNT_BINDING'], facts: known.facts, certificate: known.certificate };
    else if (!requoteConsistent(route.venue, token, route.pool, bank, known)) outcome = invalid('REQUOTE_MISMATCH', known.facts, known.certificate);
  }
  return { ...base, adapterVersion, plan, outcome, usd: routeUsd(outcome, route.outputMint, prices) };
}
const knownOf = (r: ExecLiqRoute): KnownOutcome | null => r.outcome.status === 'KNOWN' ? r.outcome : null;
function inputDomain(target: string, bank: CoherentBank | null, routes: readonly ExecLiqRoute[]): ExecLiqInputDomain {
  const label = { kind: 'MINT_SUPPLY_MINUS_SCOPE_INPUT_VAULTS', label: 'HYPOTHETICAL_NOT_WALLET_AVAILABILITY' } as const;
  if (bank === null) return { ...label, status: 'UNKNOWN', code: 'BANK_NOT_OBSERVED' };
  const raw = bank.accounts[target], mint = raw ? decodeAccount(raw) : null;
  if (!mint || !TOKEN_PROGRAMS.includes(mint.account.owner) || mint.data.length < 82 || mint.data[45] !== 1) return { ...label, status: 'UNKNOWN', code: 'TARGET_MINT_UNREADABLE' };
  const supply = mint.data.readBigUInt64LE(36), vaults = new Map<string, string>();
  for (const r of routes) {
    const facts = r.outcome.facts, prior = facts ? vaults.get(facts.vaults.input.address) : undefined;
    if (!facts || facts.vaults.input.mint !== target || prior !== undefined && prior !== facts.vaults.input.amountAtoms) return { ...label, status: 'UNKNOWN', code: 'ROUTE_FACTS_MISSING' };
    vaults.set(facts.vaults.input.address, facts.vaults.input.amountAtoms);
  }
  const excludedInputVaults = sortUnique(vaults.keys()).map(address => ({ address, amountAtoms: vaults.get(address)! }));
  const excluded = excludedInputVaults.reduce((s, v) => s + BigInt(v.amountAtoms), 0n);
  if (excluded > supply) return { ...label, status: 'UNKNOWN', code: 'VAULTS_EXCEED_SUPPLY' };
  const chosen = routes.reduce((s, r) => s + BigInt(knownOf(r)?.inputAtoms ?? '0'), 0n), domainAtoms = supply - excluded;
  return { ...label, status: 'KNOWN', supplyAtoms: supply.toString(), excludedInputVaults, domainAtoms: domainAtoms.toString(), chosenInputSumAtoms: chosen.toString(), withinDomain: chosen <= domainAtoms };
}
function aggregateRoutes(a: { readonly genesisVerified: boolean; readonly inventory: ExecLiqInventory; readonly bank: ExecLiqBank; readonly routes: readonly ExecLiqRoute[]; readonly domain: ExecLiqInputDomain; readonly freshness: ExecLiqFreshness; readonly prices: ReadonlyMap<string, Rational> }): ExecLiqAggregate {
  const blockers: Blocker[] = [];
  const block = (code: Blocker['code'], subjects: Iterable<string> = []): void => { blockers.push({ code, subjects: sortUnique(subjects) }); };
  if (!a.genesisVerified) block('NETWORK_NOT_VERIFIED');
  const unobserved = a.inventory.frames.filter(f => f.status !== 'OBSERVED').map(f => f.frameId);
  if (unobserved.length > 0) block('INVENTORY_FRAME_NOT_OBSERVED', unobserved);
  if (a.inventory.unclassified.length > 0) block('INVENTORY_UNCLASSIFIED', a.inventory.unclassified.map(u => u.pool));
  if (a.bank.status !== 'OBSERVED') block('BANK_NOT_OBSERVED', [a.bank.code]); else if (!a.bank.closed) block('BANK_NOT_OBSERVED', ['KEY_SET_OPEN']);
  const notKnown = a.routes.filter(r => knownOf(r) === null).map(r => r.pool);
  if (notKnown.length > 0) block('ROUTE_NOT_KNOWN', notKnown);
  const holders = new Map<string, Set<string>>();
  for (const r of a.routes) for (const key of r.plan?.mutableKeys ?? []) { const set = holders.get(key) ?? new Set<string>(); set.add(r.pool); holders.set(key, set); }
  const shared = [...holders].filter(([, pools]) => pools.size > 1).map(([key]) => key);
  if (shared.length > 0) block('SHARED_MUTABLE_ACCOUNT', shared);
  const unpriced = a.routes.filter(r => { const o = knownOf(r); return o !== null && o.netAtoms !== '0' && r.usd === null; }).map(r => r.outputMint);
  if (unpriced.length > 0) block('USD_MISSING', unpriced);
  if (a.domain.status !== 'KNOWN') block('DOMAIN_UNKNOWN', [a.domain.code]); else if (!a.domain.withinDomain) block('PRIMARY_DOMAIN_BINDING');
  if (a.bank.status === 'OBSERVED' && !a.freshness.freshAtCutoff) block('STALE_AT_CUTOFF');
  if (blockers.length > 0) {
    blockers.sort((x, y) => x.code < y.code ? -1 : x.code > y.code ? 1 : 0);
    const knownRoutes = a.routes.filter(r => knownOf(r) !== null);
    const knownSubtotals = sortUnique(knownRoutes.map(r => r.outputMint)).map(mint => {
      const rs = knownRoutes.filter(r => r.outputMint === mint);
      return { outputMint: mint, cashAsset: rs[0]!.cashAsset, decimals: knownOf(rs[0]!)!.facts.decimals.output, knownSubtotalAtoms: rs.reduce((s, r) => s + BigInt(knownOf(r)!.netAtoms), 0n).toString(), knownPools: rs.map(r => r.pool) };
    });
    return { status: 'NOT_PRIMARY', blockers, knownSubtotals };
  }
  const assets = sortUnique(a.routes.map(r => r.outputMint)).map(mint => {
    const rs = a.routes.filter(r => r.outputMint === mint), outcomes = rs.map(r => knownOf(r)!), net = outcomes.reduce((s, o) => s + BigInt(o.netAtoms), 0n);
    const decimals = outcomes[0]!.facts.decimals.output, price = a.prices.get(mint) ?? null;
    return {
      outputMint: mint, cashAsset: rs[0]!.cashAsset, decimals, netAtoms: net.toString(), routePools: rs.map(r => r.pool), usdPerUnit: price,
      netUsd: price === null || net === 0n ? ZERO : toRational(ratio(net * BigInt(price.num), BigInt(price.den) * 10n ** BigInt(decimals))),
    };
  });
  const chosen = a.routes.reduce((s, r) => s + BigInt(knownOf(r)!.inputAtoms), 0n);
  const netUsd = a.routes.reduce((s, r) => qadd(s, fromRational(r.usd!.netUsd)), { n: 0n, d: 1n } as Q);
  const reference = a.routes.reduce((s, r) => qadd(s, fromRational(r.usd!.referenceNotionalUsd)), { n: 0n, d: 1n } as Q);
  let weightedImpactBps: SignedRational | null = null;
  if (chosen > 0n && reference.n > 0n) {
    const impact = ratio(10_000n * (netUsd.d * reference.n - netUsd.n * reference.d), netUsd.d * reference.n);
    weightedImpactBps = { num: impact.n.toString(), den: impact.d.toString() };
  }
  return { status: 'PRIMARY_KNOWN', assets, chosenInputSumAtoms: chosen.toString(), netUsd: toRational(netUsd), referenceNotionalUsd: toRational(reference), weightedImpactBps };
}

export type ExecLiqReconstructInput = { readonly token: TokenRef; readonly cutoff: string; readonly evidence: readonly EvidenceRecord[]; readonly rawArtifacts: Readonly<Record<string, string>> };
export type ExecLiqReconstruction = { readonly ok: true; readonly facts: ExecutableLiquidityFacts } | { readonly ok: false; readonly code: ExecLiqRejectCode; readonly detail: string };
/** Pure and deterministic over the owned execliq-req-* receipts: no env, network or wall clock. Missing or failed reads are facts; malformed owned receipts are rejections. */
export function reconstructExecutableLiquidity(input: ExecLiqReconstructInput): ExecLiqReconstruction {
  try { return reconstruct(input); } catch { return fail('EXEC_LIQ_RECONSTRUCTION_MISMATCH', 'reconstruction could not complete'); }
}
function reconstruct(input: ExecLiqReconstructInput): ExecLiqReconstruction {
  const cutoffMs = Date.parse(input.cutoff);
  let target: Buffer;
  try { if (input.token.chain !== 'solana' || !Number.isFinite(cutoffMs)) throw new Error('token'); target = decodeSolanaAddress(input.token.address); }
  catch { return fail('EXEC_LIQ_TOKEN_OR_CUTOFF_MISMATCH', 'a Solana token and an ISO cutoff are required'); }
  const token: ExecLiqToken = { chain: 'solana', address: input.token.address };
  const checked = checkReceipts(token, target, input.evidence, input.rawArtifacts);
  if (!checked.ok) return checked;
  const receipts = checked.receipts;
  if (receipts.some(r => Date.parse(r.artifact.completedAt) > cutoffMs)) return fail('EXEC_LIQ_TOKEN_OR_CUTOFF_MISMATCH', 'a request completed after the cutoff');
  const latestOk = (list: readonly Receipt[]): Receipt | undefined => [...list].reverse().find(r => r.artifact.response.status === 'OK');
  const lastCode = (list: readonly Receipt[]): ExecLiqFailureCode | 'NOT_ATTEMPTED' => { const response = list[list.length - 1]?.artifact.response; return response && response.status === 'FAILED' ? response.code : 'NOT_ATTEMPTED'; };

  type Entry = Omit<ExecLiqRequestEntry, 'attempts'> & { attempts: ExecLiqRequestEntry['attempts'][number][] };
  const entries = new Map<string, Entry>();
  for (const r of receipts) {
    const a = r.artifact;
    let entry = entries.get(a.requestId);
    if (!entry) { entry = { requestId: a.requestId, role: a.role, transport: a.role === 'USD' ? 'DEXSCREENER' : 'SOLANA_RPC', request: a.request, attempts: [] }; entries.set(a.requestId, entry); }
    entry.attempts.push({ artifactId: r.id, sequence: a.sequence, status: a.response.status, code: a.response.status === 'OK' ? null : a.response.code, httpStatus: a.response.httpStatus, startedAt: a.startedAt, completedAt: a.completedAt });
  }
  const requests: ExecLiqRequestEntry[] = [...entries.values()];

  const genesisOk = latestOk(receipts.filter(r => r.artifact.role === 'GENESIS'));
  const genesisVerified = genesisOk !== undefined && verifyExecLiqGenesisArtifact(genesisOk.raw, token);

  const gpa: (GpaFrame | null)[] = [];
  const frames = EXEC_LIQ_INVENTORY_FRAMES.map((frame): ExecLiqInventory['frames'][number] => {
    const attempts = receipts.filter(r => r.artifact.role === 'INVENTORY' && r.artifact.frameId === frame.frameId), ok = latestOk(attempts), requestId = `inventory-${frame.frameId}`;
    if (ok) {
      const parsed = ok.parsed as GpaFrame;
      gpa.push(parsed);
      return { frameId: frame.frameId, status: 'OBSERVED', requestId, artifactId: ok.id, contextSlot: parsed.slot, retrievedAt: ok.artifact.completedAt, pools: sortUnique(parsed.rows.map(row => row.pubkey)) };
    }
    gpa.push(null);
    const code = lastCode(attempts);
    return { frameId: frame.frameId, status: code === 'BODY_TOO_LARGE' ? 'TRUNCATED' : 'MISSING', requestId, artifactIds: attempts.map(r => r.id), code };
  });
  const cls = classify(gpa), cashPools = cls.cash.map(c => c.pool);
  const comparison = token.address === REFERENCE_TOKEN && frames.every(f => f.status === 'OBSERVED')
    ? { referenceId: REFERENCE_ID, added: cashPools.filter(p => !EXEC_LIQ_REFERENCE_CASH_POOLS.includes(p)), vanished: EXEC_LIQ_REFERENCE_CASH_POOLS.filter(p => !cashPools.includes(p)) } as const : null;
  const inventory: ExecLiqInventory = { frames, cashPools, excluded: cls.excluded, unclassified: cls.unclassified, comparison };

  const bankReceipts = receipts.filter(r => r.artifact.role === 'BANK');
  const partOf = (r: Receipt) => r.artifact.role === 'BANK' ? r.artifact : null;
  let selected: Receipt[] | null = null, selectedRound = 0;
  for (const round of [...new Set(bankReceipts.map(r => partOf(r)!.round))].sort((x, y) => y - x)) {
    const inRound = bankReceipts.filter(r => partOf(r)!.round === round), partCount = partOf(inRound[0]!)!.partCount, parts: Receipt[] = [];
    for (let part = 1; part <= partCount; part++) { const ok = latestOk(inRound.filter(r => partOf(r)!.part === part)); if (!ok) break; parts.push(ok); }
    if (parts.length === partCount) { selected = parts; selectedRound = round; break; }
  }
  let bank: CoherentBank | null = null, bankFact: ExecLiqBank;
  if (selected === null) bankFact = { status: 'MISSING', code: bankReceipts.length > 0 ? 'NO_SUCCESSFUL_ROUND' : 'NOT_ATTEMPTED', artifactIds: bankReceipts.map(r => r.id) };
  else {
    const bodies = selected.map(r => r.parsed as AccountsBody), seen = new Set<string>();
    for (const body of bodies) for (const key of Object.keys(body.accounts)) {
      if (key === EXEC_LIQ_CLOCK_SYSVAR) continue;
      if (seen.has(key)) return fail('EXEC_LIQ_ARTIFACT_INVALID', 'bank parts of one round overlap');
      seen.add(key);
    }
    const merged = mergeBank(bodies), artifactIds = selected.map(r => r.id);
    if (merged.ok) {
      bank = merged.bank;
      const closed = planAll(input.token, cls.cash, bank.accounts).every(p => p !== null && !p.open && p.missingKeys.length === 0);
      bankFact = { status: 'OBSERVED', round: selectedRound, artifactIds, slot: bank.slot, clock: bank.clock, keys: sortUnique(Object.keys(bank.accounts)), closed };
    } else bankFact = { status: merged.code === 'CLOCK_INVALID' ? 'INVALID' : 'CONFLICT', code: merged.code, artifactIds };
  }

  const usdAttempts = receipts.filter(r => r.artifact.role === 'USD'), usdOk = latestOk(usdAttempts), usdResponse = usdOk?.artifact.response;
  const usdFact: ExecLiqUsd = usdOk && usdResponse && usdResponse.status === 'OK'
    ? { status: 'OBSERVED', requestId: 'usd-refs', artifactId: usdOk.id, observedAt: usdOk.artifact.completedAt, refs: usdRefs(usdResponse.body) }
    : { status: 'MISSING', requestId: 'usd-refs', artifactIds: usdAttempts.map(r => r.id), code: lastCode(usdAttempts) };
  const prices = new Map<string, Rational>();
  if (usdFact.status === 'OBSERVED') for (const ref of usdFact.refs) if (ref.status === 'KNOWN') prices.set(ref.mint, ref.priceUsd);

  const routes = cls.cash.map(c => solveCashRoute(input.token, c, bank, bankFact, prices));
  const domain = inputDomain(token.address, bank, routes);
  /* Expiry is min(bank Clock, needed USD observation) + 30 s, judged at the original cutoff; a future bank Clock is never fresh. */
  const needsUsd = routes.some(r => r.outcome.status === 'KNOWN' && r.outcome.netAtoms !== '0');
  const bankMs = bank ? bank.clock.unixTimestamp * 1000 : null, usdObservedAt = needsUsd && usdFact.status === 'OBSERVED' ? usdFact.observedAt : null;
  const expiresMs = bankMs === null ? null : Math.min(bankMs, usdObservedAt !== null ? Date.parse(usdObservedAt) : bankMs) + EXEC_LIQ_EXPIRY_SECONDS * 1000;
  const freshness: ExecLiqFreshness = {
    bankClockAt: bankMs === null ? null : isoAt(bankMs), usdObservedAt, expiresAt: expiresMs === null ? null : isoAt(expiresMs),
    freshAtCutoff: bankMs !== null && expiresMs !== null && bankMs <= cutoffMs && cutoffMs <= expiresMs,
  };
  const aggregate = aggregateRoutes({ genesisVerified, inventory, bank: bankFact, routes, domain, freshness, prices });
  const facts: ExecutableLiquidityFacts = {
    method: EXEC_LIQ_METHOD, definitionsVersion: EXEC_LIQ_DEFINITIONS_VERSION, cashSet: EXEC_LIQ_CASH_SET, token, cutoff: input.cutoff, impactBps: EXEC_LIQ_IMPACT_BPS,
    proofLevel: 'QUOTED', expirySeconds: EXEC_LIQ_EXPIRY_SECONDS, units: { atoms: 'OUTPUT_MINT_ATOMS', usd: 'USD_EXACT_RATIONAL', impact: 'BPS_EXACT_RATIONAL' },
    limitations: ['QUOTED_TRADING_FEES_ONLY', 'NETWORK_RENT_SETUP_PRIORITY_UNWRAP_UNMODELED', 'NO_SIGNING_SEND_OR_SIMULATION', 'NOT_WALLET_AVAILABILITY', 'VAULT_BALANCES_CONTEXT_NOT_CAPACITY', 'DIRECT_ENUMERATED_ROUTES_ONLY', 'AS_OF_CUTOFF_NOT_CURRENT_PRICE'],
    derivationId: EXEC_LIQ_DERIVATION_ID, requests, inventory, bank: bankFact, usd: usdFact, inputDomain: domain, routes, aggregate, freshness,
  };
  const parsed = executableLiquidityFactsSchema.safeParse(facts);
  if (!parsed.success) return fail('EXEC_LIQ_DETAILS_INVALID', parsed.error.issues[0]?.message ?? 'reconstructed facts fail their schema');
  return { ok: true, facts: parsed.data };
}

export type ExecLiqBundleView = Pick<LiveBundle, 'token' | 'cutoff' | 'evidence' | 'rawArtifacts' | 'features' | 'observations' | 'semantic' | 'exitProofs' | 'details'>;
export type ExecLiqValidation =
  | { readonly ok: true; readonly claim: 'ABSENT' }
  | { readonly ok: true; readonly claim: 'PRESENT'; readonly facts: ExecutableLiquidityFacts }
  | { readonly ok: false; readonly code: ExecLiqRejectCode; readonly detail: string };
/** Never throws. Trigger, check order and codes as in api.validatorSemantics. */
export function validateExecutableLiquidity(bundle: ExecLiqBundleView): ExecLiqValidation {
  try { return validateBundle(bundle); } catch { return fail('EXEC_LIQ_DETAILS_INVALID', 'the bundle could not be read'); }
}
function validateBundle(bundle: ExecLiqBundleView): ExecLiqValidation {
  const details = bundle.details as unknown as Record<string, unknown> | undefined, claim = details?.['executableLiquidity'];
  const owned = bundle.evidence.filter(e => isExecLiqOwnedRecord(e)), ownedRaw = Object.keys(bundle.rawArtifacts).filter(k => k.startsWith(EXEC_LIQ_RECORD_PREFIX));
  if (claim === undefined && owned.length === 0 && ownedRaw.length === 0) return { ok: true, claim: 'ABSENT' };
  if (bundle.token.chain !== 'solana') return fail('EXEC_LIQ_CHAIN_UNSUPPORTED', 'executable liquidity is Solana only');
  const ownedIds = new Set(owned.map(e => e.id));
  const cites = (v: unknown): boolean => typeof v === 'string' ? ownedIds.has(v) || v === EXEC_LIQ_DERIVATION_ID || EXEC_LIQ_REQUEST_RECORD_PATTERN.test(v)
    : Array.isArray(v) ? v.some(item => cites(item)) : isObject(v) ? Object.values(v).some(item => cites(item)) : false;
  const foreign: unknown[] = [bundle.features, bundle.observations, field(bundle.semantic, 'claims'), bundle.exitProofs, ...['baseline', 'groups', 'shared', 'social', 'advisory'].map(k => details?.[k])];
  if (foreign.some(v => cites(v))) return fail('EXEC_LIQ_FOREIGN_CITATION', 'an existing component cites an executable-liquidity receipt');
  if (claim === undefined) return fail('EXEC_LIQ_ORPHAN_PROOF', 'owned receipts without executable-liquidity details');
  const derivations = owned.filter(e => e.id === EXEC_LIQ_DERIVATION_ID), derivation = derivations[0], derivationRaw = bundle.rawArtifacts[EXEC_LIQ_DERIVATION_ID];
  if (!derivation || typeof derivationRaw !== 'string') return fail('EXEC_LIQ_DETAIL_WITHOUT_PROOF', 'details without the execliq-derivation record and raw');
  if (derivations.length !== 1 || derivation.sourceId !== EXEC_LIQ_SOURCE_IDS.derivation || derivation.sourceType !== 'CALCULATION' || derivation.accessMode !== 'LOCAL_DERIVED'
    || derivation.adapterVersion !== EXEC_LIQ_METHOD || derivation.retrievedAt !== derivation.availableAt || derivation.contentHash !== sha256(derivationRaw)
    || !isDeepStrictEqual(derivation.scope, { method: EXEC_LIQ_METHOD, definitionsVersion: EXEC_LIQ_DEFINITIONS_VERSION })) return fail('EXEC_LIQ_RECORD_INVALID', 'execliq-derivation metadata is not the derivation shape');
  let target: Buffer;
  try { target = decodeSolanaAddress(bundle.token.address); } catch { return fail('EXEC_LIQ_TOKEN_OR_CUTOFF_MISMATCH', 'the bundle token is not a Solana address'); }
  const token: ExecLiqToken = { chain: 'solana', address: bundle.token.address };
  const receipts = checkReceipts(token, target, owned, bundle.rawArtifacts);
  if (!receipts.ok) return receipts;
  const parsed = executableLiquidityFactsSchema.safeParse(claim);
  if (!parsed.success) return fail('EXEC_LIQ_DETAILS_INVALID', parsed.error.issues[0]?.message ?? 'details fail their schema');
  const facts = parsed.data;
  if (facts.token.address !== bundle.token.address || facts.cutoff !== bundle.cutoff) return fail('EXEC_LIQ_TOKEN_OR_CUTOFF_MISMATCH', 'details bind another token or cutoff');
  const derived = parseJson(derivationRaw);
  if (derived === undefined || canonical(derived) !== canonical(facts) || derivation.retrievedAt !== facts.cutoff) return fail('EXEC_LIQ_DERIVATION_MISMATCH', 'the derivation raw is not the details');
  const rebuilt = reconstructExecutableLiquidity({ token: bundle.token, cutoff: bundle.cutoff, evidence: owned.filter(e => e.id !== EXEC_LIQ_DERIVATION_ID), rawArtifacts: bundle.rawArtifacts });
  if (!rebuilt.ok) return rebuilt;
  if (canonical(rebuilt.facts) !== canonical(facts)) return fail('EXEC_LIQ_RECONSTRUCTION_MISMATCH', 'details differ from the reconstruction of the retained receipts');
  return { ok: true, claim: 'PRESENT', facts };
}
