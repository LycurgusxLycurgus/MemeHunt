import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Connection, PublicKey } from '@solana/web3.js';
import * as cpAmmSdk from '@meteora-ag/cp-amm-sdk';
import type { TokenRef } from '../src/domain/contracts.js';
import type {
  CapacityWitness, CoherentBank, Rational, RouteOutcome, RoutePlan, RouteQuote, RouteSolve, RpcAccount, SolanaClock,
} from '../src/domain/executable-liquidity.js';
import { EXEC_LIQ_DAMM_VERSION, planDammRoute, quoteDammRoute, solveDammRoute } from '../src/providers/executable-liquidity-damm.js';

// GENUINE: byte-identical offline projection of one joint bank at slot 461618922 (public raw account bytes only).
// CONSTRUCTED: labelled mutations of the genuine Ca bytes used by the oracle families; never reported as genuine facts.
type FixtureAccount = { lamports: number; data: [string, 'base64']; owner: string; executable: boolean; rentEpoch?: number; space?: number };
type Fixture = { token: string; slot: number; cashPoolAddresses: string[]; accounts: Record<string, FixtureAccount> };
type MutAccounts = Record<string, FixtureAccount | null>;
const fixture = JSON.parse(readFileSync('tests/fixtures/executable-liquidity-damm.json', 'utf8')) as Fixture;

const DAMM_PROGRAM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
const CLOCK_KEY = 'SysvarC1ock11111111111111111111111111111111';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_LEGACY = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CA = 'CaUgbB98qBZgQBbQPcLqFMszjdHddpqdA22wJqyLpi6o';
const CX = 'CXbfPNXWzLYybcKH7NpzpxQcf9dBrX5ep3Di2cav2Qfv';
const L0_POOLS = [
  '5Wu8bDBKaJxc8RacVk9hi54PXt6JsDSyH9tZKk4972a9', '8mtnbphJdGvg7frACqAAHNRN7PbCCX3pyDt7WGDetmZZ', 'EfCJyjXy6pYcXGn4xRJGpCPHNgxoNV6C8NaD3wwNnJ6j',
  'FiBr3heyH5bYWarJ4qXRRRYFc9yX1zU1x484Qv8FxnZd', 'HS23icXsGGVHxAXZia6VNJbTq9JMqD4Pumd1YbMsrA32',
];
const FEE_FLOOR_POOLS = [CX, 'ETtnpR8ete58b9rnd6EiNHdN2rRAuVKVqKW5DwpqjWfw', 'EeaLETKomynSs5kP3SbUaWxN5n4LX5C9MjHNTPYUsh1h'];
const LIMIT_BPS = 300;
const GRID = [1n, 1000n, 13622n, 13623n, 13624n, 13625n, 13626n, 13774n];
const Q64 = 1n << 64n;
const Q128 = 1n << 128n;
const U64_MAX = Q64 - 1n;
const U128_MAX = Q128 - 1n;
const FEE_DEN = 1_000_000_000n;
// SPL mint / token-account byte offsets (Token-2022 base layout is identical; mint TLV starts after the account-type byte).
const MINT_SUPPLY = 36;
const MINT_DECIMALS = 44;
const MINT_INITIALIZED = 45;
const MINT_TLV = 166;
const ACC_MINT = 0;
const ACC_AUTHORITY = 32;
const ACC_AMOUNT = 64;
const ACC_DELEGATE = 72;
const ACC_STATE = 108;
const ACC_NATIVE = 109;
const ACC_DELEGATED = 121;
const ACC_CLOSE = 129;
const FOREIGN = Buffer.alloc(32, 7);
const FOREIGN_KEY = new PublicKey(FOREIGN).toBase58();
const EXTRA_KEY = new PublicKey(Buffer.alloc(32, 9)).toBase58();
const token = { chain: 'solana', address: fixture.token } as TokenRef;
const ZERO_QUOTE = {
  inputAtoms: '0', consumedAtoms: '0', netAtoms: '0', complete: true,
  fees: { tradingInputAtoms: '0', tradingOutputAtoms: '0', transferInputAtoms: '0', transferOutputAtoms: '0' },
};

// ---------- raw account helpers ----------
const raw = (account: RpcAccount): Buffer => Buffer.from(account.data[0], 'base64');
const u64 = (bytes: Buffer, offset: number): bigint => bytes.readBigUInt64LE(offset);
const nativeReserve = (bytes: Buffer): bigint | null => (bytes.readUInt32LE(ACC_NATIVE) === 1 ? u64(bytes, ACC_NATIVE + 4) : null);
const sorted = (keys: readonly string[]): string[] => [...new Set(keys)].sort();

function copyAccounts(source: Readonly<Record<string, FixtureAccount | null>>): MutAccounts {
  const out: MutAccounts = {};
  for (const [key, account] of Object.entries(source)) out[key] = account === null ? null : { ...account, data: [account.data[0], 'base64'] };
  return out;
}
const genuineAccounts = (): MutAccounts => copyAccounts(fixture.accounts);
function bodyOf(accounts: MutAccounts, key: string): FixtureAccount {
  const account = accounts[key];
  assert.ok(account, `account body ${key} present`);
  return account;
}
function writeData(account: FixtureAccount, bytes: Buffer): void {
  const before = raw(account).length;
  account.data = [bytes.toString('base64'), 'base64'];
  if (bytes.length !== before) account.space = bytes.length;
}
function patch(accounts: MutAccounts, key: string, edit: (bytes: Buffer, account: FixtureAccount) => void): void {
  const account = bodyOf(accounts, key);
  const bytes = raw(account);
  edit(bytes, account);
  writeData(account, bytes);
}
/** Token amount at offset 64; a native WSOL body keeps lamports = amount + rent-exempt reserve. */
function setTokenAmount(accounts: MutAccounts, key: string, amount: bigint): void {
  patch(accounts, key, (bytes, account) => {
    bytes.writeBigUInt64LE(amount, ACC_AMOUNT);
    const reserve = nativeReserve(bytes);
    if (reserve !== null) account.lamports = Number(amount + reserve);
  });
}
function setNativeLamports(accounts: MutAccounts, key: string, delta: bigint): void {
  patch(accounts, key, (bytes, account) => {
    const reserve = nativeReserve(bytes);
    assert.notEqual(reserve, null, `${key} is native WSOL`);
    account.lamports = Number(u64(bytes, ACC_AMOUNT) + (reserve ?? 0n) + delta);
  });
}
function retypeFirstMintExtension(bytes: Buffer, extensionType: number): void {
  assert.equal(bytes[MINT_TLV - 1], 1, 'Token-2022 account type Mint');
  assert.equal(bytes.readUInt16LE(MINT_TLV), 18, 'first genuine extension is MetadataPointer');
  bytes.writeUInt16LE(extensionType, MINT_TLV);
}

// ---------- Clock (40-byte sysvar of the same bank) ----------
function decodeClock(account: RpcAccount): SolanaClock {
  const bytes = raw(account);
  assert.equal(bytes.length, 40);
  const safe = (value: bigint): number => {
    assert.ok(value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER));
    return Number(value);
  };
  return {
    slot: safe(bytes.readBigUInt64LE(0)), epochStartTimestamp: safe(bytes.readBigInt64LE(8)), epoch: safe(bytes.readBigUInt64LE(16)),
    leaderScheduleEpoch: safe(bytes.readBigUInt64LE(24)), unixTimestamp: safe(bytes.readBigInt64LE(32)),
  };
}
function shiftClockSeconds(accounts: MutAccounts, seconds: number): void {
  patch(accounts, CLOCK_KEY, (bytes) => bytes.writeBigInt64LE(bytes.readBigInt64LE(32) + BigInt(seconds), 32));
}
function bankOf(accounts: MutAccounts): CoherentBank {
  const clock = decodeClock(bodyOf(accounts, CLOCK_KEY));
  return { slot: clock.slot, clock, accounts };
}

// ---------- SDK 1.5.1: offline coder and pure functions only ----------
type Bn = { toString(base?: number): string };
type PoolView = {
  poolFees: {
    baseFee: { baseFeeInfo: { data: number[] } };
    protocolFeePercent: number; compoundingFeeBps: number; initSqrtPrice: Bn;
    dynamicFee: { initialized: number; volatilityAccumulator: Bn };
  };
  tokenAMint: PublicKey; tokenBMint: PublicKey; tokenAVault: PublicKey; tokenBVault: PublicKey;
  liquidity: Bn; sqrtPrice: Bn; sqrtMinPrice: Bn; sqrtMaxPrice: Bn; tokenAAmount: Bn; tokenBAmount: Bn;
  protocolAFee: Bn; protocolBFee: Bn; deadLiquidityFeeCheckpoint: Bn; permanentLockLiquidity: Bn;
  feeAPerLiquidity: number[]; feeBPerLiquidity: number[];
  activationPoint: Bn; activationType: number; collectFeeMode: number; feeVersion: number; tokenAFlag: number;
};
type AccountsCoder = { decode(name: string, data: Buffer): unknown; encode(name: string, value: unknown): Promise<Buffer> | Buffer };
type SdkQuote = { swapOutAmount: Bn; totalFee: Bn };
type CpAmmView = { _program: { coder: { accounts: AccountsCoder } }; getQuote(params: Record<string, unknown>): SdkQuote | Promise<SdkQuote> };
type SdkView = {
  CpAmm: new (connection: Connection) => unknown;
  getTotalTradingFeeFromIncludedFeeAmount: (...args: unknown[]) => Bn;
  getMaxFeeNumerator: (feeVersion: number) => Bn;
  splitFees: (poolFees: unknown, feeAmount: Bn, hasReferral: boolean) => { claimingFee: Bn; compoundingFee: Bn; protocolFee: Bn; referralFee: Bn };
  TradeDirection: { AtoB: number; BtoA: number };
};
function loadSdk(): SdkView {
  const ns = cpAmmSdk as unknown as { readonly [name: string]: unknown; readonly default?: { readonly [name: string]: unknown } };
  const pick = (name: string): unknown => ns[name] ?? ns.default?.[name];
  const view = {
    CpAmm: pick('CpAmm'), getTotalTradingFeeFromIncludedFeeAmount: pick('getTotalTradingFeeFromIncludedFeeAmount'),
    getMaxFeeNumerator: pick('getMaxFeeNumerator'), splitFees: pick('splitFees'), TradeDirection: pick('TradeDirection'),
  };
  for (const [name, value] of Object.entries(view)) assert.ok(value !== undefined && value !== null, `cp-amm-sdk export ${name}`);
  return view as unknown as SdkView;
}
const sdk = loadSdk();
const refuseNetwork = (): never => { throw new Error('NETWORK_FORBIDDEN_IN_TEST'); };
const cpAmm = new sdk.CpAmm(new Connection('http://127.0.0.1:9', { commitment: 'confirmed', fetch: refuseNetwork as never })) as CpAmmView;
const coder = cpAmm._program.coder.accounts;
const decodePool = (accounts: MutAccounts, key: string): PoolView => coder.decode('pool', raw(bodyOf(accounts, key))) as PoolView;
const genuineCa = decodePool(genuineAccounts(), CA);
const BnCtor = (genuineCa.liquidity as unknown as { constructor: new (value: string, base: number) => Bn }).constructor;
const bn = (value: bigint): Bn => new BnCtor(value.toString(), 10);
const big = (value: Bn): bigint => BigInt(value.toString(10));

type PinnedAccountLayout = { discriminator: number[]; layout: { encode(account: unknown, buffer: Buffer): number } };
/** Installed BorshAccountsCoder.encode allocates 1000 bytes; drive its own pinned pool layout into an exact 1112-byte body. */
async function encodePool(accounts: MutAccounts, key: string, pool: PoolView): Promise<void> {
  const poolSpace = 1112;
  const pinned = (coder as unknown as { accountLayouts: Map<string, PinnedAccountLayout> }).accountLayouts.get('pool');
  assert.ok(pinned, 'installed coder has the pool layout');
  const discriminator = Buffer.from(pinned.discriminator);
  assert.equal(discriminator.length, 8, 'Anchor discriminator');
  const body = Buffer.alloc(poolSpace - discriminator.length);
  const len = pinned.layout.encode(pool, body);
  assert.equal(len, body.length, 'pool layout fills the 1112-byte account');
  const encoded = Buffer.concat([discriminator, body]);
  assert.equal(encoded.length, poolSpace);
  writeData(bodyOf(accounts, key), encoded);
  const back = coder.decode('pool', encoded) as PoolView;
  assert.equal(big(back.sqrtPrice), big(pool.sqrtPrice));
  assert.equal(big(back.liquidity), big(pool.liquidity));
}
async function mutatePool(accounts: MutAccounts, key: string, edit: (pool: PoolView) => void): Promise<PoolView> {
  const pool = decodePool(accounts, key);
  edit(pool);
  await encodePool(accounts, key, pool);
  return pool;
}
function sdkFeeNumerator(pool: PoolView, forward: boolean, clock: SolanaClock): bigint {
  const point = pool.activationType === 0 ? clock.slot : clock.unixTimestamp;
  return big(sdk.getTotalTradingFeeFromIncludedFeeAmount(
    pool.poolFees, bn(BigInt(point)), pool.activationPoint, bn(1n), forward ? sdk.TradeDirection.AtoB : sdk.TradeDirection.BtoA,
    sdk.getMaxFeeNumerator(pool.feeVersion), pool.poolFees.initSqrtPrice, pool.sqrtPrice,
  ));
}
async function sdkQuote(pool: PoolView, accounts: MutAccounts, clock: SolanaClock, x: bigint): Promise<{ out: bigint; fee: bigint } | { error: string }> {
  const decimals = (mint: PublicKey): number => raw(bodyOf(accounts, mint.toBase58()))[MINT_DECIMALS];
  try {
    const q = await cpAmm.getQuote({
      inAmount: bn(x), inputTokenMint: new PublicKey(fixture.token), slippage: 0, poolState: pool,
      currentTime: clock.unixTimestamp, currentSlot: clock.slot, tokenADecimal: decimals(pool.tokenAMint), tokenBDecimal: decimals(pool.tokenBMint),
    });
    return { out: big(q.swapOutAmount), fee: big(q.totalFee) };
  } catch (error) {
    // Returned, not swallowed: every caller asserts the exact legitimate SDK message.
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

type Side = { forward: boolean; inputMint: string; outputMint: string; inputVault: string; outputVault: string };
function sideOf(pool: PoolView): Side {
  const a = pool.tokenAMint.toBase58();
  const b = pool.tokenBMint.toBase58();
  assert.ok(a === fixture.token || b === fixture.token, 'pool trades the target mint');
  const forward = a === fixture.token;
  return {
    forward, inputMint: forward ? a : b, outputMint: forward ? b : a,
    inputVault: (forward ? pool.tokenAVault : pool.tokenBVault).toBase58(), outputVault: (forward ? pool.tokenBVault : pool.tokenAVault).toBase58(),
  };
}
const CA_SIDE = sideOf(genuineCa);
const L0_SIDE = sideOf(decodePool(genuineAccounts(), L0_POOLS[0]));

// ---------- independent BigInt oracle: own closed forms, no production quote/helper/solver/segments ----------
type Fraction = { num: bigint; den: bigint };
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const netAfterFee = (gross: bigint, feeNumerator: bigint): bigint => gross - ceilDiv(gross * feeNumerator, FEE_DEN);
const meetsLimit = (x: bigint, net: bigint, p0: Fraction, bps: bigint): boolean => net > 0n && net * p0.den * 10000n >= x * p0.num * (10000n - bps);
const cpGross = (reserveIn: bigint, reserveOut: bigint) => (x: bigint): bigint => (reserveOut * x) / (reserveIn + x);
const clNextSqrt = (liquidity: bigint, sqrt: bigint, x: bigint): bigint => ceilDiv(liquidity * sqrt, liquidity + x * sqrt);
const clGross = (liquidity: bigint, sqrt: bigint) => (x: bigint): bigint => (liquidity * (sqrt - clNextSqrt(liquidity, sqrt, x))) >> 128n;
function clRangeCap(liquidity: bigint, sqrt: bigint, sqrtMin: bigint, limit: bigint): bigint {
  let x = 0n;
  while (x < limit && clNextSqrt(liquidity, sqrt, x + 1n) >= sqrtMin) x += 1n;
  return x;
}
type Oracle = { net: bigint; input: bigint; maxAdmissible: bigint | null; nonmonotone: boolean };
/** Exhaustive scan of every x in [1, cap]; admissibility is not monotone, so nothing is bisected. */
function bruteForce(gross: (x: bigint) => bigint, feeNumerator: bigint, p0: Fraction, bps: bigint, cap: bigint): Oracle {
  const result: Oracle = { net: 0n, input: 0n, maxAdmissible: null, nonmonotone: false };
  let gap = false;
  for (let x = 1n; x <= cap; x += 1n) {
    const net = netAfterFee(gross(x), feeNumerator);
    if (!meetsLimit(x, net, p0, bps)) {
      gap = gap || result.maxAdmissible !== null;
      continue;
    }
    if (gap) result.nonmonotone = true;
    result.maxAdmissible = x;
    if (net > result.net) {
      result.net = net;
      result.input = x;
    }
  }
  return result;
}
const p0Of = (pool: PoolView, forward: boolean): Fraction => {
  const s = big(pool.sqrtPrice);
  return forward ? { num: s * s, den: Q128 } : { num: Q128, den: s * s };
};

// ---------- canonical contract checks ----------
const BASE_REASONS = new Set([
  'ACCOUNT_NOT_READ', 'ACCOUNT_NULL', 'ACCOUNT_SHAPE', 'ACCOUNT_BINDING', 'LAYOUT_UNSUPPORTED', 'MODE_UNSUPPORTED', 'TOKEN_MODE_UNSUPPORTED',
  'NOT_TARGET_ROUTE', 'ROUTE_DISABLED', 'KEY_SET_OPEN', 'CLOCK_MISMATCH', 'BIN_COVERAGE_INCOMPLETE', 'MAX_UNPROVED', 'OUTPUT_BACKING_INSUFFICIENT', 'ARITHMETIC_RANGE',
]);
const isReason = (reason: string): boolean => BASE_REASONS.has(reason) || /^DAMM_[A-Z0-9_]+$/.test(reason);
const is = (expected: string) => (reason: string): boolean => reason === expected;
const anyOf = (...expected: string[]) => (reason: string): boolean => expected.includes(reason);
const backing = (reason: string): boolean => reason === 'OUTPUT_BACKING_INSUFFICIENT' || reason.startsWith('DAMM_');
const quote = (pool: string, bank: CoherentBank, x: bigint): RouteQuote => quoteDammRoute({ token, pool, bank, inputAtoms: x.toString() });
const solve = (pool: string, bank: CoherentBank, impactBps = LIMIT_BPS): RouteSolve => solveDammRoute({ token, pool, bank, impactBps });
type KnownOutcome = Extract<RouteOutcome, { status: 'KNOWN' }>;

function checkPlanShape(plan: RoutePlan): void {
  for (const keys of [plan.requiredKeys, plan.additionalKeys, plan.missingKeys, plan.nullKeys, plan.mutableKeys]) assert.deepEqual([...keys], sorted(keys));
  const planned = new Set([...plan.requiredKeys, ...plan.additionalKeys]);
  for (const key of plan.additionalKeys) assert.ok(!plan.requiredKeys.includes(key));
  for (const key of [...plan.missingKeys, ...plan.nullKeys, ...plan.mutableKeys]) assert.ok(planned.has(key), `${key} is planned`);
  assert.ok(!planned.has(CLOCK_KEY), 'Clock is added by core, not planned');
}
function quoteAdmissible(q: RouteQuote, p0: Rational, bps: number): boolean {
  const x = BigInt(q.inputAtoms);
  return x === 0n || (q.complete && meetsLimit(x, BigInt(q.netAtoms), { num: BigInt(p0.num), den: BigInt(p0.den) }, BigInt(bps)));
}
/** Root frozen-certificate acceptance: maximal, CHOSEN, BELOW_CHOSEN when positive, MAX_ADMISSIBLE when reported; every witness re-quotes exactly. */
function checkKnown(s: RouteSolve, pool: string, bank: CoherentBank): KnownOutcome {
  const o = s.outcome;
  if (o.status !== 'KNOWN') assert.fail(`${pool}: expected KNOWN, got ${JSON.stringify(o)}`);
  const cert = o.certificate;
  assert.equal(cert.maximal, true, pool);
  assert.match(cert.kind, /^DAMM_[A-Z0-9_]+$/);
  const role = (r: CapacityWitness['role']): CapacityWitness | undefined => cert.witnesses.find((w) => w.role === r);
  const chosen = role('CHOSEN');
  assert.ok(chosen, `${pool}: CHOSEN witness`);
  assert.deepEqual([chosen.inputAtoms, chosen.netAtoms, chosen.complete, chosen.admissible], [o.inputAtoms, o.netAtoms, true, true], pool);
  const x = BigInt(o.inputAtoms);
  const net = BigInt(o.netAtoms);
  if (x > 0n) {
    const below = role('BELOW_CHOSEN');
    assert.ok(below, `${pool}: BELOW_CHOSEN witness`);
    assert.ok(BigInt(below.inputAtoms) < x);
    assert.ok(!(below.admissible && BigInt(below.netAtoms) >= net), `${pool}: chosen input is the minimum tie`);
  } else {
    assert.equal(net, 0n);
    assert.notEqual(o.zero, null, `${pool}: known zero carries a ZeroReason`);
  }
  if (o.maxAdmissibleInputAtoms !== null) {
    const max = role('MAX_ADMISSIBLE');
    assert.ok(max, `${pool}: MAX_ADMISSIBLE witness`);
    assert.equal(max.inputAtoms, o.maxAdmissibleInputAtoms);
    assert.equal(max.admissible, true);
    assert.ok(BigInt(max.inputAtoms) >= x);
  }
  if (cert.domainEndAtoms !== null) assert.ok(BigInt(cert.domainEndAtoms) >= x);
  assert.ok(net <= BigInt(o.facts.vaults.output.amountAtoms), `${pool}: net backed by the output vault`);
  for (const w of cert.witnesses) {
    const q = quoteDammRoute({ token, pool, bank, inputAtoms: w.inputAtoms });
    const where = `${pool} witness ${w.role}@${w.inputAtoms}`;
    assert.equal(q.netAtoms, w.netAtoms, where);
    assert.equal(q.complete, w.complete, where);
    assert.equal(quoteAdmissible(q, o.facts.p0, s.impactBps), w.admissible, where);
    if (w.complete) assert.equal(q.consumedAtoms, q.inputAtoms, where);
    if (w.role === 'ABOVE_MAX_ADMISSIBLE') assert.equal(w.admissible, false, where);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s, `${pool}: solve is plain JSON`);
  return o;
}
function compareOracle(o: KnownOutcome, oracle: Oracle, label: string): void {
  assert.equal(o.netAtoms, oracle.net.toString(), `${label}: max net`);
  assert.equal(o.inputAtoms, oracle.input.toString(), `${label}: minimum input attaining it`);
  assert.equal(o.zero, oracle.net === 0n ? 'NO_ADMISSIBLE_INPUT' : null, label);
  if (o.maxAdmissibleInputAtoms !== null) {
    assert.equal(o.maxAdmissibleInputAtoms, (oracle.maxAdmissible ?? 0n).toString(), `${label}: max admissible input`);
  }
}
function assertNotKnown(s: RouteSolve, statuses: readonly string[], label: string, reason?: (r: string) => boolean): void {
  const o = s.outcome;
  if (o.status === 'KNOWN') assert.fail(`${label}: unresolved state reported KNOWN net ${o.netAtoms}`);
  assert.ok(statuses.includes(o.status), `${label}: status ${o.status} not in ${statuses.join('/')}`);
  assert.ok(o.reasons.length > 0 && o.reasons.every(isReason), `${label}: reasons ${o.reasons.join(',')}`);
  if (reason) assert.ok(o.reasons.some(reason), `${label}: reasons ${o.reasons.join(',')}`);
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as object)) deepFreeze(child);
  }
  return value;
}

// ---------- 1. genuine plans, solves and SDK parity ----------
type GenuineExpectation = { net: string; input: string; zero: 'ZERO_LIQUIDITY' | 'NO_ADMISSIBLE_INPUT' | null; maxAdmissible?: string };
const GENUINE_EXPECTED = new Map<string, GenuineExpectation>([
  ...L0_POOLS.map((pool): [string, GenuineExpectation] => [pool, { net: '0', input: '0', zero: 'ZERO_LIQUIDITY' }]),
  ...FEE_FLOOR_POOLS.map((pool): [string, GenuineExpectation] => [pool, { net: '0', input: '0', zero: 'NO_ADMISSIBLE_INPUT' }]),
  [CA, { net: '1021', input: '13623', zero: null, maxAdmissible: '13625' }],
]);

test('GENUINE plan: all 9 cash pools close from the complete bank with exact sorted required/mutable keys', () => {
  assert.equal(fixture.cashPoolAddresses.length, 9);
  assert.equal(GENUINE_EXPECTED.size, 9);
  const accounts = genuineAccounts();
  assert.equal(decodeClock(bodyOf(accounts, CLOCK_KEY)).slot, fixture.slot);
  for (const pool of fixture.cashPoolAddresses) {
    assert.equal(bodyOf(accounts, pool).owner, DAMM_PROGRAM);
    const side = sideOf(decodePool(accounts, pool));
    const plan = planDammRoute({ token, pool, accounts });
    checkPlanShape(plan);
    assert.deepEqual([plan.venue, plan.programId, plan.pool, plan.targetMint], ['DAMM_V2', DAMM_PROGRAM, pool, fixture.token]);
    assert.deepEqual(plan.route, {
      outputMint: side.outputMint,
      direction: side.forward ? 'FIRST_TO_SECOND' : 'SECOND_TO_FIRST',
      vaults: { input: side.inputVault, output: side.outputVault },
      tokenPrograms: { input: bodyOf(accounts, side.inputMint).owner, output: bodyOf(accounts, side.outputMint).owner },
    }, pool);
    assert.deepEqual(plan.requiredKeys, sorted([pool, side.inputMint, side.outputMint, side.inputVault, side.outputVault]), pool);
    assert.deepEqual(plan.mutableKeys, sorted([pool, side.inputVault, side.outputVault]), pool);
    assert.deepEqual([plan.additionalKeys, plan.missingKeys, plan.nullKeys, plan.open, plan.rejected], [[], [], [], false, null], pool);
  }
});

test('plan: empty and pool-only maps stay open without inventing programs; a null pool is MISSING ACCOUNT_NULL', () => {
  const accounts = genuineAccounts();
  const empty = planDammRoute({ token, pool: CA, accounts: {} });
  checkPlanShape(empty);
  assert.deepEqual([empty.route, empty.missingKeys, empty.open, empty.rejected], [null, [CA], true, null]);

  const poolOnly = planDammRoute({ token, pool: CA, accounts: { [CA]: bodyOf(accounts, CA) } });
  checkPlanShape(poolOnly);
  assert.ok(poolOnly.route);
  assert.equal(poolOnly.route.tokenPrograms, null, 'mint programs stay null until both mints are read');
  assert.deepEqual(poolOnly.route.vaults, { input: CA_SIDE.inputVault, output: CA_SIDE.outputVault });
  assert.deepEqual(poolOnly.missingKeys, sorted([CA_SIDE.inputMint, CA_SIDE.outputMint, CA_SIDE.inputVault, CA_SIDE.outputVault]));
  assert.deepEqual([poolOnly.open, poolOnly.rejected], [true, null]);

  const nulled = planDammRoute({ token, pool: CA, accounts: { [CA]: null } });
  checkPlanShape(nulled);
  assert.deepEqual([nulled.route, nulled.nullKeys, nulled.missingKeys, nulled.open, nulled.rejected], [null, [CA], [], false, null]);
  const bank = bankOf(accounts);
  assertNotKnown(solve(CA, { ...bank, accounts: { [CA]: null } }), ['MISSING'], 'null pool', is('ACCOUNT_NULL'));
});

test('GENUINE solve: all 9 match the known source outcomes with exact facts and a re-quotable maximal certificate', () => {
  const accounts = genuineAccounts();
  const bank = bankOf(accounts);
  assert.equal(bank.slot, fixture.slot);
  for (const pool of fixture.cashPoolAddresses) {
    const expected = GENUINE_EXPECTED.get(pool);
    assert.ok(expected, pool);
    const s = solve(pool, bank);
    assert.deepEqual([s.adapterVersion, s.bankSlot, s.impactBps], [EXEC_LIQ_DAMM_VERSION, fixture.slot, LIMIT_BPS]);
    assert.deepEqual(s.clock, bank.clock);
    assert.deepEqual(s.plan, planDammRoute({ token, pool, accounts }));
    const o = checkKnown(s, pool, bank);
    assert.deepEqual([o.netAtoms, o.inputAtoms, o.zero], [expected.net, expected.input, expected.zero], pool);
    if (expected.maxAdmissible !== undefined) assert.equal(o.maxAdmissibleInputAtoms, expected.maxAdmissible, pool);

    const view = decodePool(accounts, pool);
    const side = sideOf(view);
    const p0 = p0Of(view, side.forward);
    assert.ok(BigInt(o.facts.p0.den) > 0n);
    assert.equal(BigInt(o.facts.p0.num) * p0.den, BigInt(o.facts.p0.den) * p0.num, `${pool}: p0 is the raw stored-sqrt rate`);
    for (const [role, mint, vault] of [['input', side.inputMint, side.inputVault], ['output', side.outputMint, side.outputVault]] as const) {
      assert.deepEqual(o.facts.vaults[role], {
        address: vault, mint, tokenProgram: bodyOf(accounts, mint).owner, amountAtoms: u64(raw(bodyOf(accounts, vault)), ACC_AMOUNT).toString(),
      }, `${pool} ${role} vault token amount, never lamports`);
      assert.equal(o.facts.decimals[role], raw(bodyOf(accounts, mint))[MINT_DECIMALS]);
    }
  }
});

test('GENUINE SDK 1.5.1 public getQuote parity on the 72-point grid at the bank Clock', async () => {
  const accounts = genuineAccounts();
  const bank = bankOf(accounts);
  let compared = 0;
  for (const pool of fixture.cashPoolAddresses) {
    const view = decodePool(accounts, pool);
    const side = sideOf(view);
    const l0 = L0_POOLS.includes(pool);
    assert.equal(big(view.liquidity) === 0n, l0, `${pool}: L0 classification is read from the pool bytes`);
    assert.equal(bodyOf(accounts, side.outputMint).owner, TOKEN_LEGACY, 'legacy output: SDK swapOut is the wallet net');
    assert.deepEqual(quote(pool, bank, 0n), ZERO_QUOTE, `${pool}: zero quote is the all-zero complete convention`);
    for (const x of GRID) {
      const ref = await sdkQuote(view, accounts, bank.clock, x);
      const where = `${pool}@${x}`;
      if (l0) {
        assert.ok('error' in ref && /liquidity must be greater than 0/i.test(ref.error), `${where}: SDK ${JSON.stringify(ref)}`);
        assert.throws(() => quote(pool, bank, x), (e: unknown) => e instanceof Error && e.message !== 'EXEC_LIQ_INPUT_INVALID', where);
      } else {
        const q = quote(pool, bank, x);
        assert.deepEqual([q.inputAtoms, q.consumedAtoms, q.complete], [x.toString(), x.toString(), true], where);
        assert.deepEqual([q.fees.transferInputAtoms, q.fees.transferOutputAtoms], ['0', '0'], where);
        if ('error' in ref) {
          assert.match(ref.error, /Amount out must be greater than 0/, where);
          assert.equal(q.netAtoms, '0', `${where}: production returns the raw net 0 complete`);
        } else {
          assert.equal(q.netAtoms, ref.out.toString(), where);
        }
      }
      compared += 1;
    }
  }
  assert.equal(compared, 72);
});

test('GENUINE Ca: full consumption, fee charged once, no impact clamp, SDK fee partition 2/9/0', async () => {
  const accounts = genuineAccounts();
  const bank = bankOf(accounts);
  assert.equal(CA_SIDE.forward, true);
  assert.equal(genuineCa.collectFeeMode, 2);
  const gross = cpGross(big(genuineCa.tokenAAmount), big(genuineCa.tokenBAmount));
  // 13626 exceeds the 300 bps limit (SDK impact 3.0037%), yet the quote has no impact parameter and is not clamped.
  for (const x of [13623n, 13625n, 13626n]) {
    const q = quote(CA, bank, x);
    assert.deepEqual([q.consumedAtoms, q.complete, q.netAtoms], [x.toString(), true, '1021']);
    assert.deepEqual(q.fees, { tradingInputAtoms: '0', tradingOutputAtoms: '11', transferInputAtoms: '0', transferOutputAtoms: '0' });
    assert.equal(BigInt(q.netAtoms) + BigInt(q.fees.tradingOutputAtoms), gross(x), 'one trading fee on the included-fee output');
  }
  const ref = await sdkQuote(genuineCa, accounts, bank.clock, 13623n);
  assert.deepEqual(ref, { out: 1021n, fee: 11n });
  const split = sdk.splitFees(genuineCa.poolFees, bn(11n), false);
  assert.deepEqual(
    [big(split.protocolFee), big(split.claimingFee), big(split.compoundingFee), big(split.referralFee)],
    [2n, 9n, 0n, 0n],
  );
  const protocol = (11n * BigInt(genuineCa.poolFees.protocolFeePercent)) / 100n;
  assert.deepEqual([protocol, ((11n - protocol) * BigInt(genuineCa.poolFees.compoundingFeeBps)) / 10000n], [2n, 0n]);
});

// ---------- 2. constructed CP / CL families vs the brute-force oracle ----------
type Construct = {
  label: string; family: 'CP' | 'CL'; feeBps: bigint; liquidity: bigint; sqrtPrice: bigint; sqrtMin: bigint; sqrtMax: bigint;
  trackedA: bigint; trackedB: bigint; physA: bigint; physB: bigint; outstanding: bigint;
};
type Expectation = { bps: number; net: bigint; input: bigint; maxAdmissible: bigint | null; nonmonotone?: boolean };
const CP_SAMPLE: Omit<Construct, 'label' | 'feeBps'> = {
  family: 'CP', liquidity: 100n << 64n, sqrtPrice: 10n * Q64, sqrtMin: 0n, sqrtMax: U128_MAX,
  trackedA: 100n, trackedB: 10_000n, physA: 100n, physB: 10_000n, outstanding: 40n,
};
const CL_SAMPLE: Omit<Construct, 'label' | 'feeBps'> = {
  family: 'CL', liquidity: 64n << 64n, sqrtPrice: Q64, sqrtMin: 1n << 63n, sqrtMax: 2n << 64n,
  trackedA: 32n, trackedB: 32n, physA: 32n, physB: 32n, outstanding: 40n,
};
const zeroAt = (bps: number): Expectation => ({ bps, net: 0n, input: 0n, maxAdmissible: null });
const CONSTRUCTED: Array<Construct & { expects: Expectation[] }> = [
  {
    ...CP_SAMPLE, label: 'CONSTRUCTED CP compounding A=100 B=10000 p0=100, static fee 100 bps', feeBps: 100n,
    expects: [zeroAt(0), { bps: 300, net: 194n, input: 2n, maxAdmissible: 2n }, { bps: 450, net: 288n, input: 3n, maxAdmissible: 3n },
      { bps: 10_000, net: 2828n, input: 40n, maxAdmissible: 40n }],
  },
  { ...CP_SAMPLE, label: 'CONSTRUCTED CP fee equal to the 300 bps limit (floor)', feeBps: 300n, expects: [zeroAt(300)] },
  {
    ...CP_SAMPLE, label: 'CONSTRUCTED CP stored sqrt 5*2^64 (p0=25) diverging from reserves 100/10000', sqrtPrice: 5n * Q64, feeBps: 300n,
    expects: [{ bps: 300, net: 2771n, input: 40n, maxAdmissible: 40n }],
  },
  {
    ...CL_SAMPLE, label: 'CONSTRUCTED CL concentrated L=64<<64 S=2^64 range [2^63, 2^65]', feeBps: 50n,
    expects: [zeroAt(0), zeroAt(300), { bps: 4150, net: 23n, input: 39n, maxAdmissible: 39n, nonmonotone: true },
      { bps: 10_000, net: 23n, input: 39n, maxAdmissible: 40n }],
  },
  {
    ...CL_SAMPLE, label: 'CONSTRUCTED CL supply allows 100 but the price range ends at 64', outstanding: 100n, feeBps: 50n,
    expects: [{ bps: 10_000, net: 31n, input: 64n, maxAdmissible: 64n }],
  },
];
function staticBaseFee(feeBps: bigint): number[] {
  const data = Buffer.alloc(32);
  data.writeBigUInt64LE(feeBps * 100_000n, 0); // cliff numerator; mode 0 @8, periods 0 @14, frequency 0 @16, reduction 0 @24
  return [...data];
}
async function constructBank(c: Construct): Promise<CoherentBank> {
  const accounts = genuineAccounts();
  const pool = await mutatePool(accounts, CA, (p) => {
    p.liquidity = bn(c.liquidity);
    p.sqrtPrice = bn(c.sqrtPrice);
    p.sqrtMinPrice = bn(c.sqrtMin);
    p.sqrtMaxPrice = bn(c.sqrtMax);
    p.tokenAAmount = bn(c.trackedA);
    p.tokenBAmount = bn(c.trackedB);
    p.protocolAFee = bn(0n);
    p.protocolBFee = bn(0n);
    p.deadLiquidityFeeCheckpoint = bn(0n);
    p.permanentLockLiquidity = bn(0n);
    p.feeAPerLiquidity = new Array<number>(32).fill(0);
    p.feeBPerLiquidity = new Array<number>(32).fill(0);
    p.collectFeeMode = c.family === 'CP' ? 2 : 1;
    p.poolFees.compoundingFeeBps = c.family === 'CP' ? 1000 : 0;
    p.poolFees.dynamicFee.initialized = 0;
    p.poolFees.baseFee.baseFeeInfo.data = staticBaseFee(c.feeBps);
  });
  patch(accounts, pool.tokenAMint.toBase58(), (bytes) => bytes.writeBigUInt64LE(c.physA + c.outstanding, MINT_SUPPLY));
  setTokenAmount(accounts, pool.tokenAVault.toBase58(), c.physA);
  setTokenAmount(accounts, pool.tokenBVault.toBase58(), c.physB);
  return bankOf(accounts);
}

test('CONSTRUCTED CP/CL families: production solve and every in-domain quote equal an independent brute-force oracle', async () => {
  const roundTrip = genuineAccounts();
  const before = Buffer.from(raw(bodyOf(roundTrip, CA)));
  const decoded = decodePool(roundTrip, CA);
  await encodePool(roundTrip, CA, decoded);
  const encoded = Buffer.from(raw(bodyOf(roundTrip, CA)));
  assert.deepEqual(encoded, before, 'SDK coder round-trips the genuine Ca pool byte-exactly');
  for (const c of CONSTRUCTED) {
    const bank = await constructBank(c);
    const plan = planDammRoute({ token, pool: CA, accounts: bank.accounts });
    assert.deepEqual([plan.open, plan.rejected, plan.missingKeys], [false, null, []], c.label);
    const gross = c.family === 'CP' ? cpGross(c.trackedA, c.trackedB) : clGross(c.liquidity, c.sqrtPrice);
    const domain = c.family === 'CP' ? c.outstanding : clRangeCap(c.liquidity, c.sqrtPrice, c.sqrtMin, c.outstanding);
    const feeNumerator = c.feeBps * 100_000n;
    const p0 = { num: c.sqrtPrice * c.sqrtPrice, den: Q128 };
    for (const e of c.expects) {
      const label = `${c.label} @${e.bps}bps`;
      const oracle = bruteForce(gross, feeNumerator, p0, BigInt(e.bps), domain);
      assert.deepEqual([oracle.net, oracle.input, oracle.maxAdmissible], [e.net, e.input, e.maxAdmissible], `${label}: oracle fixture sanity`);
      if (e.nonmonotone !== undefined) assert.equal(oracle.nonmonotone, e.nonmonotone, `${label}: rounding holes`);
      const s = solve(CA, bank, e.bps);
      const o = checkKnown(s, CA, bank);
      compareOracle(o, oracle, label);
      assert.equal(BigInt(o.facts.p0.num) * p0.den, BigInt(o.facts.p0.den) * p0.num, `${label}: p0 from stored sqrt`);
    }
    for (let x = 1n; x <= domain; x += 1n) {
      const q = quote(CA, bank, x);
      const g = gross(x);
      const net = netAfterFee(g, feeNumerator);
      assert.deepEqual([q.netAtoms, q.consumedAtoms, q.complete], [net.toString(), x.toString(), true], `${c.label} quote@${x}`);
      assert.deepEqual([q.fees.tradingInputAtoms, q.fees.tradingOutputAtoms], ['0', (g - net).toString()], `${c.label} fee@${x}`);
    }
  }
});

// ---------- 3. EXHAUSTIVE_PHYS and the complete genuine Ca oracle ----------
test('CONSTRUCTED EXHAUSTIVE_PHYS dust: physical output bounds the domain and the exhaustive oracle agrees', async () => {
  const c: Construct = {
    label: 'CONSTRUCTED CP dust B=5 A=10, p0=1/256, supply domain 1e6', family: 'CP', feeBps: 25n, liquidity: 100n << 64n,
    sqrtPrice: Q64 >> 4n, sqrtMin: 0n, sqrtMax: U128_MAX, trackedA: 10n, trackedB: 5n, physA: 10n, physB: 5n, outstanding: 1_000_000n,
  };
  const bps = BigInt(LIMIT_BPS);
  const s2 = c.sqrtPrice * c.sqrtPrice;
  const xPhys = (c.physB * Q128 * 10000n) / ((10000n - bps) * s2);
  assert.equal(xPhys, 1319n);
  // Any x > Xphys would need net > physical output vault: impossible for a complete swap.
  assert.ok(c.physB * Q128 * 10000n < (xPhys + 1n) * s2 * (10000n - bps));
  const domain = xPhys < c.outstanding ? xPhys : c.outstanding;
  const bank = await constructBank(c);
  const oracle = bruteForce(cpGross(c.trackedA, c.trackedB), c.feeBps * 100_000n, { num: s2, den: Q128 }, bps, domain);
  assert.deepEqual([oracle.net, oracle.input, oracle.maxAdmissible], [3n, 40n, 791n]);
  compareOracle(checkKnown(solve(CA, bank), CA, bank), oracle, c.label);
  for (let x = 1n; x <= domain; x += 1n) {
    assert.equal(quote(CA, bank, x).netAtoms, netAfterFee(cpGross(c.trackedA, c.trackedB)(x), c.feeBps * 100_000n).toString(), `dust quote@${x}`);
  }
  for (const x of [xPhys + 1n, c.outstanding]) assert.ok(BigInt(quote(CA, bank, x).netAtoms) <= c.physB);
});

test('GENUINE Ca: independent complete oracle over [1, U] proves net 1021, minimum input 13623, max admissible 13625', () => {
  const accounts = genuineAccounts();
  const bank = bankOf(accounts);
  const a = big(genuineCa.tokenAAmount);
  const b = big(genuineCa.tokenBAmount);
  const s = big(genuineCa.sqrtPrice);
  assert.deepEqual([a, b, s], [690505n, 53342n, 5127090178815493267n]);
  const n = sdkFeeNumerator(genuineCa, true, bank.clock);
  assert.equal(ceilDiv(1032n * n, FEE_DEN), 11n);
  const bps = BigInt(LIMIT_BPS);
  const s2 = s * s;
  // net <= G*(1e9-n)/1e9 <= B*x*(1e9-n)/((A+x)*1e9), so the limit fails for every x beyond this bound.
  const bound = (b * (FEE_DEN - n) * Q128 * 10000n) / (FEE_DEN * s2 * (10000n - bps)) - a;
  assert.ok(bound >= 13625n && bound < 20000n, `bound ${bound}`);
  assert.ok(b * (FEE_DEN - n) * Q128 * 10000n < (a + bound + 1n) * FEE_DEN * s2 * (10000n - bps));
  const oracle = bruteForce(cpGross(a, b), n, { num: s2, den: Q128 }, bps, bound > 13774n ? bound : 13774n);
  assert.deepEqual([oracle.net, oracle.input, oracle.maxAdmissible], [1021n, 13623n, 13625n]);
  assert.equal(1021n * Q128 * 10000n, 3474282966262781711961054741878353438965760000n);
  assert.equal(13625n * s2 * (10000n - bps), 3474162734851757119106026223811032873307462500n);
  compareOracle(checkKnown(solve(CA, bank), CA, bank), oracle, 'genuine Ca');
});

test('GENUINE CX/ET/Ee: zero is proved by an independent fee-floor upper bound', () => {
  const accounts = genuineAccounts();
  const bank = bankOf(accounts);
  for (const pool of FEE_FLOOR_POOLS) {
    const view = decodePool(accounts, pool);
    const side = sideOf(view);
    const n = sdkFeeNumerator(view, side.forward, bank.clock);
    const p0 = p0Of(view, side.forward);
    const a = big(view.tokenAAmount);
    const b = big(view.tokenBAmount);
    const rate = view.collectFeeMode === 2 ? (side.forward ? { num: b, den: a } : { num: a, den: b }) : p0;
    // For every x: net <= x * rate * (1e9 - n) / 1e9, so this strict inequality excludes every positive input.
    assert.ok(rate.num * (FEE_DEN - n) * 10000n * p0.den < rate.den * FEE_DEN * p0.num * (10000n - BigInt(LIMIT_BPS)), pool);
    const o = checkKnown(solve(pool, bank), pool, bank);
    assert.deepEqual([o.netAtoms, o.inputAtoms, o.zero], ['0', '0', 'NO_ADMISSIBLE_INPUT'], pool);
  }
});

// ---------- 4. state failures are never KNOWN zero ----------
type Failure = {
  label: string; pool: string; statuses: readonly string[]; reason?: (r: string) => boolean; quoteZeroThrows?: boolean;
  edit: (accounts: MutAccounts) => void | Promise<void>;
};
const BAD = ['INVALID', 'UNSUPPORTED'] as const;
const FAILURES: Failure[] = [
  { label: 'Ca output vault not read', pool: CA, statuses: ['MISSING'], reason: is('ACCOUNT_NOT_READ'), quoteZeroThrows: true, edit: (a) => { delete a[CA_SIDE.outputVault]; } },
  { label: 'Ca output vault observed null', pool: CA, statuses: ['MISSING'], reason: is('ACCOUNT_NULL'), quoteZeroThrows: true, edit: (a) => { a[CA_SIDE.outputVault] = null; } },
  { label: 'Ca input mint not read', pool: CA, statuses: ['MISSING'], reason: anyOf('ACCOUNT_NOT_READ', 'KEY_SET_OPEN'), quoteZeroThrows: true, edit: (a) => { delete a[CA_SIDE.inputMint]; } },
  { label: 'Ca pool not read', pool: CA, statuses: ['MISSING'], reason: anyOf('ACCOUNT_NOT_READ', 'KEY_SET_OPEN'), quoteZeroThrows: true, edit: (a) => { delete a[CA]; } },
  { label: 'pool owner is not the DAMM v2 program', pool: CA, statuses: BAD, quoteZeroThrows: true, edit: (a) => { bodyOf(a, CA).owner = SYSTEM_PROGRAM; } },
  { label: 'pool discriminator', pool: CA, statuses: BAD, quoteZeroThrows: true, edit: (a) => patch(a, CA, (bytes) => { bytes[0] ^= 0xff; }) },
  { label: 'pool layout length', pool: CA, statuses: BAD, quoteZeroThrows: true, edit: (a) => writeData(bodyOf(a, CA), raw(bodyOf(a, CA)).subarray(0, 1000)) },
  { label: 'pool collect fee mode 7', pool: CA, statuses: BAD, edit: async (a) => { await mutatePool(a, CA, (p) => { p.collectFeeMode = 7; }); } },
  {
    label: 'pool base fee mode 9', pool: CA, statuses: BAD,
    edit: async (a) => {
      await mutatePool(a, CA, (p) => {
        const data = [...p.poolFees.baseFee.baseFeeInfo.data];
        data[8] = 9;
        p.poolFees.baseFee.baseFeeInfo.data = data;
      });
    },
  },
  { label: 'pool tokenAFlag disagrees with the Token-2022 mint', pool: CA, statuses: BAD, edit: async (a) => { await mutatePool(a, CA, (p) => { p.tokenAFlag = 0; }); } },
  {
    label: 'pool input vault is not the canonical vault PDA', pool: CA, statuses: BAD,
    edit: async (a) => {
      a[FOREIGN_KEY] = { ...bodyOf(a, CA_SIDE.inputVault) };
      await mutatePool(a, CA, (p) => { p.tokenAVault = new PublicKey(FOREIGN_KEY); });
    },
  },
  { label: 'input vault owned by the wrong token program', pool: CA, statuses: BAD, edit: (a) => { bodyOf(a, CA_SIDE.inputVault).owner = TOKEN_LEGACY; } },
  { label: 'output vault holds the wrong mint', pool: CA, statuses: BAD, edit: (a) => patch(a, CA_SIDE.outputVault, (bytes) => { new PublicKey(USDC).toBuffer().copy(bytes, ACC_MINT); }) },
  { label: 'output vault authority is not the pool authority', pool: CA, statuses: BAD, edit: (a) => patch(a, CA_SIDE.outputVault, (bytes) => { FOREIGN.copy(bytes, ACC_AUTHORITY); }) },
  { label: 'output vault frozen', pool: CA, statuses: BAD, edit: (a) => patch(a, CA_SIDE.outputVault, (bytes) => { bytes[ACC_STATE] = 2; }) },
  {
    label: 'input vault has a delegate', pool: CA, statuses: BAD,
    edit: (a) => patch(a, CA_SIDE.inputVault, (bytes) => {
      bytes.writeUInt32LE(1, ACC_DELEGATE);
      FOREIGN.copy(bytes, ACC_DELEGATE + 4);
      bytes.writeBigUInt64LE(1n, ACC_DELEGATED);
    }),
  },
  {
    label: 'output vault has a close authority', pool: CA, statuses: BAD,
    edit: (a) => patch(a, CA_SIDE.outputVault, (bytes) => {
      bytes.writeUInt32LE(1, ACC_CLOSE);
      FOREIGN.copy(bytes, ACC_CLOSE + 4);
    }),
  },
  { label: 'input mint uninitialized', pool: CA, statuses: BAD, edit: (a) => patch(a, CA_SIDE.inputMint, (bytes) => { bytes[MINT_INITIALIZED] = 0; }) },
  { label: 'input mint carries an unknown Token-2022 extension', pool: CA, statuses: BAD, edit: (a) => patch(a, CA_SIDE.inputMint, (bytes) => retypeFirstMintExtension(bytes, 0xfff0)) },
  { label: 'protocol B claim at u64 max overflows backing', pool: CA, statuses: ['CONFLICT', 'UNSUPPORTED', 'INVALID'], edit: async (a) => { await mutatePool(a, CA, (p) => { p.protocolBFee = bn(U64_MAX); }); } },
  { label: 'output vault below the quoted payout', pool: CA, statuses: ['CONFLICT'], reason: backing, edit: (a) => setTokenAmount(a, CA_SIDE.outputVault, 1000n) },
  {
    label: 'output vault below tracked reserve plus protocol claim', pool: CA, statuses: ['CONFLICT'], reason: backing,
    edit: (a) => setTokenAmount(a, CA_SIDE.outputVault, big(genuineCa.tokenBAmount) + big(genuineCa.protocolBFee) - 1n),
  },
  { label: 'L0 output vault not read', pool: L0_POOLS[0], statuses: ['MISSING'], reason: is('ACCOUNT_NOT_READ'), quoteZeroThrows: true, edit: (a) => { delete a[L0_SIDE.outputVault]; } },
  { label: 'L0 input vault observed null', pool: L0_POOLS[0], statuses: ['MISSING'], reason: is('ACCOUNT_NULL'), quoteZeroThrows: true, edit: (a) => { a[L0_SIDE.inputVault] = null; } },
  { label: 'L0 output vault authority wrong', pool: L0_POOLS[0], statuses: BAD, edit: (a) => patch(a, L0_SIDE.outputVault, (bytes) => { FOREIGN.copy(bytes, ACC_AUTHORITY); }) },
  {
    label: 'CX native output vault lamports below token amount plus rent reserve', pool: CX, statuses: ['CONFLICT', 'INVALID'],
    edit: (a) => setNativeLamports(a, sideOf(decodePool(a, CX)).outputVault, -1n),
  },
];

test('state failures are never KNOWN zero and quote 0 does not bypass admission', async () => {
  for (const f of FAILURES) {
    const accounts = genuineAccounts();
    await f.edit(accounts);
    const bank = bankOf(accounts);
    const s = solve(f.pool, bank);
    assert.equal(s.plan.pool, f.pool, `${f.label}: route stays visible`);
    assertNotKnown(s, f.statuses, f.label, f.reason);
    if (f.quoteZeroThrows) {
      assert.throws(() => quote(f.pool, bank, 0n), (e: unknown) => e instanceof Error && isReason(e.message), f.label);
    }
  }
});

test('native WSOL: +2 surplus lamports change nothing; token amount, not lamports, is reported', () => {
  const base = genuineAccounts();
  const nativeKey = sideOf(decodePool(base, CX)).outputVault;
  const bytes = raw(bodyOf(base, nativeKey));
  assert.notEqual(nativeReserve(bytes), null, 'CX output vault is native WSOL');
  const amount = u64(bytes, ACC_AMOUNT);
  const baseBank = bankOf(base);
  const before = solve(CX, baseBank);
  const surplus = copyAccounts(base);
  bodyOf(surplus, nativeKey).lamports += 2;
  const surplusBank = bankOf(surplus);
  const after = solve(CX, surplusBank);
  assert.equal(bodyOf(surplus, nativeKey).lamports, bodyOf(base, nativeKey).lamports + 2);
  const b = checkKnown(before, CX, baseBank);
  const o = checkKnown(after, CX, surplusBank);
  // Certificate diagnostics may truthfully record the native surplus; economics, facts and witnesses may not move.
  assert.deepEqual([o.netAtoms, o.inputAtoms, o.maxAdmissibleInputAtoms, o.zero], [b.netAtoms, b.inputAtoms, b.maxAdmissibleInputAtoms, b.zero], 'capacity and minimum input');
  assert.deepEqual(o.facts, b.facts, 'raw facts');
  assert.deepEqual([o.certificate.kind, o.certificate.maximal, o.certificate.domainEndAtoms], [b.certificate.kind, b.certificate.maximal, b.certificate.domainEndAtoms]);
  assert.deepEqual(o.certificate.witnesses, b.certificate.witnesses, 'witnesses');
  for (const x of GRID) assert.deepEqual(quote(CX, surplusBank, x), quote(CX, baseBank, x), `surplus quote @${x}`);
  assert.equal(o.facts.vaults.output.amountAtoms, amount.toString());
  assert.equal(u64(raw(bodyOf(surplus, nativeKey)), ACC_AMOUNT), amount);
});

test('strict raw headers: bad mint/vault COption tags, initialized byte and account state are INVALID ACCOUNT_SHAPE and quote(0) throws', () => {
  type HeaderEdit = { label: string; key: string; offset: number; width: 1 | 4; value: number };
  const headerEdits = (pool: string): HeaderEdit[] => {
    const side = sideOf(decodePool(genuineAccounts(), pool));
    const out: HeaderEdit[] = [];
    for (const [label, key] of [['INPUT_MINT', side.inputMint], ['OUTPUT_MINT', side.outputMint]] as const) {
      out.push({ label: `${label}_INITIALIZED`, key, offset: 45, width: 1, value: 2 });
      out.push({ label: `${label}_MINT_AUTHORITY_OPTION`, key, offset: 0, width: 4, value: 2 });
      out.push({ label: `${label}_FREEZE_AUTHORITY_OPTION`, key, offset: 46, width: 4, value: 2 });
    }
    for (const [label, key] of [['INPUT_VAULT', side.inputVault], ['OUTPUT_VAULT', side.outputVault]] as const) {
      out.push({ label: `${label}_DELEGATE_OPTION`, key, offset: 72, width: 4, value: 2 });
      out.push({ label: `${label}_NATIVE_OPTION`, key, offset: 109, width: 4, value: 2 });
      out.push({ label: `${label}_CLOSE_OPTION`, key, offset: 129, width: 4, value: 2 });
      out.push({ label: `${label}_STATE`, key, offset: 108, width: 1, value: 3 });
    }
    return out;
  };
  const l0 = L0_POOLS[0];
  assert.ok(l0, 'an L0 pool exists');
  const baseBank = bankOf(genuineAccounts());
  assert.ok(BigInt(checkKnown(solve(CA, baseBank), CA, baseBank).netAtoms) > 0n, 'Ca is currently positive');
  assert.equal(checkKnown(solve(l0, baseBank), l0, baseBank).netAtoms, '0', 'L0 is currently a known zero');
  for (const pool of [CA, l0]) {
    for (const e of headerEdits(pool)) {
      const accounts = genuineAccounts();
      patch(accounts, e.key, (bytes) => {
        if (e.width === 1) bytes.writeUInt8(e.value, e.offset);
        else bytes.writeUInt32LE(e.value, e.offset);
      });
      const bank = bankOf(accounts);
      const label = `${pool} ${e.label}`;
      const s = solve(pool, bank);
      assertNotKnown(s, ['INVALID'], label, (r) => r === 'ACCOUNT_SHAPE');
      assert.throws(() => quote(pool, bank, 0n), /ACCOUNT_SHAPE/, label);
    }
  }
});

test('Clock: bank slot vs Clock slot mismatch is CONFLICT CLOCK_MISMATCH and quotes refuse it', () => {
  const bank = bankOf(genuineAccounts());
  const skewed: CoherentBank = { ...bank, slot: bank.slot + 1 };
  for (const pool of [CA, L0_POOLS[0]]) {
    assertNotKnown(solve(pool, skewed), ['CONFLICT'], `${pool} clock`, is('CLOCK_MISMATCH'));
  }
  for (const x of [0n, 13623n]) assert.throws(() => quote(CA, skewed, x), { message: 'CLOCK_MISMATCH' });
});

test('invalid inputs throw EXEC_LIQ_INPUT_INVALID', () => {
  const accounts = genuineAccounts();
  const bank = bankOf(accounts);
  const invalid = { message: 'EXEC_LIQ_INPUT_INVALID' };
  const badTokens = [
    { chain: 'ethereum', address: fixture.token } as unknown as TokenRef,
    { chain: 'solana', address: '0OIl' } as unknown as TokenRef,
  ];
  for (const bad of badTokens) {
    assert.throws(() => planDammRoute({ token: bad, pool: CA, accounts }), invalid);
    assert.throws(() => quoteDammRoute({ token: bad, pool: CA, bank, inputAtoms: '1' }), invalid);
    assert.throws(() => solveDammRoute({ token: bad, pool: CA, bank, impactBps: LIMIT_BPS }), invalid);
  }
  for (const pool of ['', '0OIl']) {
    assert.throws(() => planDammRoute({ token, pool, accounts }), invalid);
    assert.throws(() => solveDammRoute({ token, pool, bank, impactBps: LIMIT_BPS }), invalid);
  }
  for (const impactBps of [-1, 10001, 1.5, Number.NaN]) assert.throws(() => solveDammRoute({ token, pool: CA, bank, impactBps }), invalid);
  for (const inputAtoms of ['', '01', '-1', '1.0', '1e3', ' 1']) assert.throws(() => quoteDammRoute({ token, pool: CA, bank, inputAtoms }), invalid);
  assert.throws(() => quoteDammRoute({ token, pool: CA, bank, inputAtoms: 13623 as unknown as string }), invalid);
});

// ---------- 5. Clock / dynamic fee controls and purity ----------
test('GENUINE Ca dynamic fee: stored volatility accumulator is sticky when only unix time advances (typed and raw Clock)', async () => {
  const base = genuineAccounts();
  const later = copyAccounts(base);
  shiftClockSeconds(later, 3600);
  const bank0 = bankOf(base);
  const bank1 = bankOf(later);
  assert.equal(bank1.clock.unixTimestamp, bank0.clock.unixTimestamp + 3600);
  assert.equal(bank1.slot, bank0.slot);
  assert.notEqual(big(genuineCa.poolFees.dynamicFee.volatilityAccumulator), 0n);
  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  for (const x of GRID) {
    const q = quote(CA, bank1, x);
    assert.deepEqual(q, quote(CA, bank0, x), `sticky @${x}`);
    const ref = await sdkQuote(genuineCa, later, bank1.clock, x);
    if ('error' in ref) {
      // Legitimate UI refusal only: production is complete with net 0 and the SDK refuses identically at the original Clock.
      assert.equal(message(ref.error), 'Amount out must be greater than 0', `SDK @${x}`);
      assert.equal(q.complete, true, `complete zero @${x}`);
      assert.equal(q.netAtoms, '0', `net 0 @${x}`);
      const ref0 = await sdkQuote(genuineCa, base, bank0.clock, x);
      assert.ok('error' in ref0, `SDK refuses at the original Clock @${x}`);
      assert.equal(message(ref0.error), message(ref.error), `same SDK error @${x}`);
    } else {
      assert.equal(q.netAtoms, ref.out.toString(), `SDK parity at the later Clock @${x}`);
    }
  }
  const o0 = checkKnown(solve(CA, bank0), CA, bank0);
  const o1 = checkKnown(solve(CA, bank1), CA, bank1);
  assert.deepEqual([o1.netAtoms, o1.inputAtoms, o1.maxAdmissibleInputAtoms], [o0.netAtoms, o0.inputAtoms, o0.maxAdmissibleInputAtoms]);
});

test('CONSTRUCTED fee schedule: an exponential scheduler still decaying at the Clock is read from that Clock', async () => {
  const accounts = genuineAccounts();
  const clock0 = bankOf(accounts).clock;
  const view = await mutatePool(accounts, CA, (p) => { p.activationPoint = bn(BigInt(clock0.unixTimestamp - 10)); });
  assert.equal(view.activationType, 1);
  const later = copyAccounts(accounts);
  shiftClockSeconds(later, 40);
  const nets: bigint[] = [];
  for (const acc of [accounts, later]) {
    const bank = bankOf(acc);
    const q = quote(CA, bank, 13623n);
    const ref = await sdkQuote(view, acc, bank.clock, 13623n);
    assert.ok(!('error' in ref), 'error' in ref ? String(ref.error) : 'sdkQuote ok');
    assert.deepEqual([q.netAtoms, q.fees.tradingOutputAtoms], [ref.out.toString(), ref.fee.toString()]);
    checkKnown(solve(CA, bank), CA, bank);
    nets.push(BigInt(q.netAtoms));
  }
  assert.ok(nets[1] > nets[0], `fee decays between Clock points: ${nets.join(' -> ')}`);
});

test('purity: frozen bank is not mutated, repeated output is stable, extra unplanned keys are ignored', () => {
  const accounts = genuineAccounts();
  const bank = bankOf(accounts);
  const snapshot = JSON.stringify(bank);
  deepFreeze(bank);
  const first = solve(CA, bank);
  assert.deepEqual(solve(CA, bank), first);
  assert.deepEqual(quote(CA, bank, 13623n), quote(CA, bank, 13623n));
  assert.equal(JSON.stringify(bank), snapshot);
  const extra = copyAccounts(accounts);
  extra[EXTRA_KEY] = { ...bodyOf(accounts, CA_SIDE.outputVault) };
  const extraBank = bankOf(extra);
  assert.deepEqual(solve(CA, extraBank), first);
  assert.deepEqual(planDammRoute({ token, pool: CA, accounts: extra }), planDammRoute({ token, pool: CA, accounts }));
});
