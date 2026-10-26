// Offline executable-sell-capacity-v1 core tests: collector, reconstruction, PumpSwap kernel and owned-receipt validator.
// Account bodies and the six getProgramAccounts result bodies are unchanged retained public C5 bytes from
// tests/fixtures/executable-liquidity-c5.json. JSON-RPC envelopes, response context slots, wall clocks, the HTTP 200
// -32600 retry, USD rows, narrowed scopes, raw-byte edits and split bank receipts are CONSTRUCTED conformance inputs.
// Nothing here is, or claims to be, a fresh live collection, a simulation or a send. No network, env, Service or CLI.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import {
  EXEC_LIQ_PUMP_VERSION, EXEC_LIQ_REFERENCE_CASH_POOLS, collectExecutableLiquidity, execLiqAccountsRequest, execLiqDerivationRecord, execLiqInventoryRequest,
  planPumpRoute, quotePumpRoute, reconstructExecutableLiquidity, solvePumpRoute, validateExecutableLiquidity,
} from '../src/providers/executable-liquidity.js';
import type { ExecLiqBundleView, ExecLiqValidation } from '../src/providers/executable-liquidity.js';
import {
  EXEC_LIQ_CASH_OUTPUTS, EXEC_LIQ_CLOCK_SYSVAR, EXEC_LIQ_DERIVATION_ID, EXEC_LIQ_IMPACT_BPS, EXEC_LIQ_INVENTORY_FRAMES, EXEC_LIQ_MAINNET_GENESIS, EXEC_LIQ_USD_URL,
  execLiqRequestArtifactSchema,
} from '../src/domain/executable-liquidity.js';
import type { CoherentBank, ExecutableLiquidityFacts, RpcAccount, SolanaClock } from '../src/domain/executable-liquidity.js';
import type { TokenRef } from '../src/domain/contracts.js';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Capture = { records: Json[]; rawArtifacts: Record<string, string> };
type Q = { n: bigint; d: bigint };

const fixture: Json = JSON.parse(readFileSync(new URL('../../tests/fixtures/executable-liquidity-c5.json', import.meta.url), 'utf8'));
const TOKEN = fixture.token as TokenRef;
const SLOT: number = fixture.sourceContextSlot;
const CLOCK_KEY = EXEC_LIQ_CLOCK_SYSVAR;
const FRAME_IDS: string[] = EXEC_LIQ_INVENTORY_FRAMES.map(f => f.frameId);
const CASH_MINTS: string[] = EXEC_LIQ_CASH_OUTPUTS.map(o => o.mint);
const MINT: Record<string, string> = Object.fromEntries(EXEC_LIQ_CASH_OUTPUTS.map((o): [string, string] => [o.asset, o.mint]));
const WSOL = MINT['WSOL']!;
/** Genuine quote mint of the 3M9s PumpSwap Pool (raw Pool bytes 75..107): WBTC, decimals 8. */
const PUMP_QUOTE = MINT['WBTC']!;
/** Genuine PumpSwap Pool of the frozen token: fee override 300 at byte 261, holderReward byte 270. */
const POOL = '3M9sVgL4u6ATKaiExf3XhQqNfMB6ijvzk3meMcQaen1w';
const RPC_SECRET = 'constructed-test-secret-0001';
const RPC_URL = `https://rpc.constructed.invalid/conformance?api-key=${RPC_SECRET}`;
const KNOWN_MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
/* Constructed wall clocks around the genuine bank Clock unix 1793008129 = 2026-10-26T09:48:49.000Z. */
const BANK_CLOCK_AT = '2026-10-26T09:48:49.000Z', BANK_EXPIRES_AT = '2026-10-26T09:49:19.000Z';
const NOW_MAIN = '2026-10-26T09:48:50.000Z', CUTOFF_MAIN = '2026-10-26T09:49:00.000Z', NOW_EARLY = '2026-10-26T09:48:40.000Z';
const ZERO = { num: '0', den: '1' };
const HEAVY = { timeout: 600_000 };

const has = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const q = (r: Json): Q => ({ n: BigInt(r.num), d: BigInt(r.den) });
const qEq = (a: Q, b: Q): boolean => a.n * b.d === b.n * a.d;
const qAdd = (a: Q, b: Q): Q => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
function decimalQ(text: string): Q { const [whole = '0', fraction = ''] = text.split('.'); return { n: BigInt(`${whole}${fraction}`), d: 10n ** BigInt(fraction.length) }; }
const addressAt = (d: Buffer, offset: number): string => new PublicKey(d.subarray(offset, offset + 32)).toBase58();
const codes = (facts: Json): string[] => (facts.aggregate.blockers ?? []).map((b: Json) => b.code);
const blocker = (facts: Json, code: string): Json => (facts.aggregate.blockers ?? []).find((b: Json) => b.code === code);

function clockOf(account: Json): SolanaClock {
  const d = Buffer.from(account.data[0], 'base64');
  return { slot: Number(d.readBigUInt64LE(0)), epochStartTimestamp: Number(d.readBigInt64LE(8)), epoch: Number(d.readBigUInt64LE(16)), leaderScheduleEpoch: Number(d.readBigUInt64LE(24)), unixTimestamp: Number(d.readBigInt64LE(32)) };
}
const CLOCK = clockOf(fixture.accounts[CLOCK_KEY]);
const POOL_DATA = Buffer.from(fixture.accounts[POOL].data[0], 'base64');
const BASE_VAULT = addressAt(POOL_DATA, 139);

/** A CONSTRUCTED edit of one retained account body; metadata other than data (and space, if present) is unchanged. */
function edited(address: string, mutate: (d: Buffer) => Buffer | void): RpcAccount {
  assert.ok(has(fixture.accounts, address) && fixture.accounts[address] !== null, `${address} is a retained body`);
  const a = fixture.accounts[address], d = Buffer.from(a.data[0], 'base64'), r = mutate(d), out = r instanceof Buffer ? r : d;
  return { ...a, data: [out.toString('base64'), 'base64'] as const, ...(a.space === undefined ? {} : { space: out.length }) };
}
function bankOf(edits: Record<string, RpcAccount | null | 'ABSENT'> = {}): CoherentBank {
  const accounts: Record<string, RpcAccount | null> = { ...fixture.accounts };
  for (const [k, v] of Object.entries(edits)) { if (v === 'ABSENT') delete accounts[k]; else accounts[k] = v; }
  return { slot: SLOT, clock: CLOCK, accounts };
}
const solve = (edits: Record<string, RpcAccount | null | 'ABSENT'> = {}) => solvePumpRoute({ token: TOKEN, pool: POOL, bank: bankOf(edits), impactBps: EXEC_LIQ_IMPACT_BPS });
const feeOverride = (bps: number): RpcAccount => edited(POOL, d => { d.writeBigUInt64LE(BigInt(bps), 261); });

const USD_PRICES: Record<string, string> = { WBTC: '80300.26', USDC: '0.9994', USDT: '0.9983', WSOL: '101.37' };
const usdRow = (base: string, pairAddress: string, priceUsd: string, liquidityUsd?: number, extra: Json = {}): Json => ({
  chainId: 'solana', dexId: 'constructed', pairAddress, baseToken: { address: base }, priceUsd, ...(liquidityUsd === undefined ? {} : { liquidity: { usd: liquidityUsd } }), ...extra,
});
/** Four constructed rows, each with its own cash mint as base; never a peg or the target priceNative. */
const USD_ROWS: Json[] = EXEC_LIQ_CASH_OUTPUTS.map(o => usdRow(o.mint, `constructed-${o.asset.toLowerCase()}-pair`, USD_PRICES[o.asset]!, 1_000_000));
const PRICE = new Map<string, Q>(EXEC_LIQ_CASH_OUTPUTS.map((o): [string, Q] => [o.mint, decimalQ(USD_PRICES[o.asset]!)]));
const SELECTION_ROWS: Json[] = [
  usdRow(TOKEN.address, 'constructed-c5-wsol', '0.00001', 9e12, { quoteToken: { address: WSOL }, priceNative: '0.0000000987' }),
  usdRow(TOKEN.address, 'constructed-c5-usdt', '0.00002', 9e12, { quoteToken: { address: MINT['USDT'] }, priceNative: '0.00002' }),
  { ...usdRow(WSOL, 'constructed-wsol-evm', '500', 9e12), chainId: 'ethereum' },
  usdRow(WSOL, 'constructed-wsol-zero', '0', 8e12),
  usdRow(WSOL, 'constructed-wsol-noliq', '250'),
  usdRow(WSOL, 'constructed-wsol-small', '99.10', 10),
  usdRow(WSOL, 'constructed-wsol-tie-b', '102.00', 5000),
  usdRow(WSOL, 'constructed-wsol-tie-a', '101.37', 5000),
  usdRow(MINT['USDC']!, 'constructed-usdc-zero', '0.0000', 1_000_000),
  usdRow(MINT['WBTC']!, 'constructed-wbtc-only', '80300.26', 2_000_000),
];
const rpcResult = (result: unknown): string => JSON.stringify({ jsonrpc: '2.0', id: 1, result });
const rpcError = (code: number, message: string): string => JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message } });

type Variant = {
  readonly frame?: (frameId: string, body: Json) => Json;
  readonly accounts?: Readonly<Record<string, RpcAccount | null>>;
  readonly withhold?: readonly string[];
  readonly genesis?: { readonly status: number; readonly text: string };
  readonly usd?: { readonly status: number; readonly text: string };
  readonly failOnce?: { readonly frameId: string; readonly text: string };
  readonly abortAtAccounts?: boolean;
};
type Sent = { readonly kind: string; readonly body: string };

/** CONSTRUCTED scope: only the genuine 3M9s row in pumpswap-first, every other frame an explicitly empty value array. */
const onlyPool = (account?: RpcAccount) => (frameId: string, body: Json): Json => {
  body.result.value = frameId === 'pumpswap-first' ? body.result.value.filter((r: Json) => r.pubkey === POOL).map((r: Json) => account ? { ...r, account } : r) : [];
  return body;
};
const PUMP_ONLY: Variant = { frame: onlyPool(), usd: { status: 404, text: JSON.stringify({ error: 'constructed: no FX source in this scope' }) } };

function frameOfRequest(request: Json): string | undefined {
  const [program, config] = Array.isArray(request.params) ? request.params : [];
  if (request.params?.length !== 2 || !config || Object.keys(config).sort().join() !== 'commitment,encoding,filters,withContext') return undefined;
  if (config.encoding !== 'base64' || config.commitment !== 'finalized' || config.withContext !== true || !Array.isArray(config.filters) || config.filters.length !== 2) return undefined;
  const [kind, target] = config.filters;
  if (Object.keys(kind).join() !== 'memcmp' || Object.keys(target).join() !== 'memcmp') return undefined;
  return EXEC_LIQ_INVENTORY_FRAMES.find(f => f.programId === program && kind.memcmp.offset === 0 && kind.memcmp.bytes === f.discriminator
    && target.memcmp.offset === f.targetOffset && target.memcmp.bytes === TOKEN.address)?.frameId;
}

/** Fixture transport: any request outside the planned set records a problem and aborts the controller, so the collector halts instead of retrying. */
function transport(v: Variant = {}) {
  const controller = new AbortController(), sent: Sent[] = [], problems: string[] = [], seen = new Map<string, number>();
  let failedOnce = false;
  const reply = (status: number, text: string): Response => new Response(text, { status, headers: { 'content-type': 'application/json' } });
  const unexpected = (why: string): never => { problems.push(why); controller.abort(); throw new Error(`UNEXPECTED_REQUEST ${why}`); };
  const fetcher = async (url: unknown, init?: Json): Promise<Response> => {
    if (controller.signal.aborted) throw new Error('ABORTED');
    const target = String(url), body = typeof init?.body === 'string' ? init.body : '', identity = `${target} ${body}`, count = (seen.get(identity) ?? 0) + 1;
    seen.set(identity, count);
    if (sent.length >= 64) unexpected('more than 64 requests');
    if (target === EXEC_LIQ_USD_URL) {
      sent.push({ kind: 'USD', body });
      if (init?.method !== 'GET' || body !== '' || count > 1) unexpected('USD request is not one bodiless GET');
      const usd = v.usd ?? { status: 200, text: JSON.stringify(USD_ROWS) };
      return reply(usd.status, usd.text);
    }
    if (target !== RPC_URL || init?.method !== 'POST') return unexpected(`unknown endpoint or verb ${String(init?.method)}`);
    const request = JSON.parse(body);
    sent.push({ kind: String(request.method), body });
    if (request.jsonrpc !== '2.0' || request.id !== 1) unexpected('non-canonical JSON-RPC envelope');
    if (request.method === 'getGenesisHash') {
      if (count > 1 || JSON.stringify(request.params) !== '[]') unexpected('genesis repeated or with params');
      const g = v.genesis ?? { status: 200, text: rpcResult(KNOWN_MAINNET_GENESIS) };
      return reply(g.status, g.text);
    }
    if (request.method === 'getProgramAccounts') {
      const frameId = frameOfRequest(request) ?? unexpected(`not one of the six pinned frames: ${body.slice(0, 200)}`);
      const retry = v.failOnce?.frameId === frameId;
      if (count > (retry ? 2 : 1)) unexpected(`frame ${frameId} re-sent beyond the planned attempts`);
      if (retry && !failedOnce) { failedOnce = true; return reply(200, v.failOnce!.text); }
      const clone = structuredClone(fixture.gpa[frameId].body);
      clone.id = request.id;
      return reply(200, JSON.stringify(v.frame ? v.frame(frameId, clone) : clone));
    }
    if (request.method === 'getMultipleAccounts') {
      if (count > 1) unexpected('identical accounts body re-sent');
      if (v.abortAtAccounts) { controller.abort(); throw new Error('CONSTRUCTED_DEADLINE'); }
      const [keys, config] = request.params;
      if (config.minContextSlot !== undefined && config.minContextSlot > SLOT) unexpected('minContextSlot beyond the retained bank slot');
      const value = keys.map((k: string) => v.accounts && has(v.accounts, k) ? v.accounts[k]
        : has(fixture.accounts, k) && !(v.withhold ?? []).includes(k) ? fixture.accounts[k] : unexpected(`key ${k} is not retained in the fixture`));
      return reply(200, JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { context: { slot: SLOT }, value } }));
    }
    return unexpected(`method ${String(request.method)}`);
  };
  return { controller, sent, problems, fetcher: fetcher as unknown as typeof fetch };
}
type Transport = ReturnType<typeof transport>;

async function capture(v: Variant = {}, now = NOW_MAIN, onWait?: (t: Transport) => void) {
  const t = transport(v), waits: number[] = [];
  const cap = await collectExecutableLiquidity({
    token: TOKEN, fetcher: t.fetcher, rpcUrl: RPC_URL, signal: t.controller.signal, now: () => now,
    wait: async (ms: number) => { waits.push(ms); onWait?.(t); },
  });
  return { t, waits, cap: { records: [...cap.records], rawArtifacts: { ...cap.rawArtifacts } } as Capture };
}
type Run = Awaited<ReturnType<typeof capture>>;
function memo<T>(make: () => Promise<T>): () => Promise<T> { let p: Promise<T> | undefined; return () => (p ??= make()); }
const pumpRun = memo((): Promise<Run> => capture(PUMP_ONLY, NOW_EARLY));
const deadlineRun = memo((): Promise<Run> => capture({ abortAtAccounts: true }));

const reconstruct = (c: Capture, cutoff: string) => reconstructExecutableLiquidity({ token: TOKEN, cutoff, evidence: c.records, rawArtifacts: c.rawArtifacts });
function rebuild(c: Capture, cutoff: string): Json {
  const r = reconstruct(c, cutoff);
  return r.ok ? r.facts : assert.fail(`reconstruction rejected ${r.code}: ${r.detail}`);
}
const artifactOf = (c: Capture, id: string): Json => JSON.parse(c.rawArtifacts[id]!);
const lastId = (c: Capture): string => c.records[c.records.length - 1].id;
/** Re-serialises one retained artifact after a CONSTRUCTED edit and rebinds its record hash; strict keeps the schema byte order. */
function rewrite(c: Capture, id: string, mutate: (artifact: Json) => void, strict = true): Capture {
  const artifact = artifactOf(c, id);
  mutate(artifact);
  const raw = strict ? JSON.stringify(execLiqRequestArtifactSchema.parse(artifact)) : JSON.stringify(artifact);
  return { records: c.records.map(r => r.id === id ? { ...r, contentHash: sha256(raw) } : r), rawArtifacts: { ...c.rawArtifacts, [id]: raw } };
}
const shiftedClock = (seconds: number): RpcAccount => edited(CLOCK_KEY, d => { d.writeBigInt64LE(d.readBigInt64LE(32) + BigInt(seconds), 32); });
/** Appends one CONSTRUCTED two-part bank round of retained bodies; part 2 may carry another slot or a shifted Clock. */
function appendSplitBank(c: Capture, part2: { readonly slot?: number; readonly clockShiftSeconds?: number }): Capture {
  const bankIds = c.records.filter(r => r.scope.role === 'BANK').map(r => r.id as string), lastBank = bankIds[bankIds.length - 1]!;
  const last = artifactOf(c, lastBank), template = c.records.find(r => r.id === lastBank);
  const keys: string[] = last.request.params[0].filter((k: string) => k !== CLOCK_KEY), minSlot: number = last.request.params[1].minContextSlot;
  const round = Math.max(...bankIds.map(id => artifactOf(c, id).round)) + 1, half = Math.ceil(keys.length / 2);
  const halves = [keys.slice(0, half), keys.slice(half)];
  assert.ok(halves.every(h => h.length > 0), 'the retained bank splits into two non-empty parts');
  const records = [...c.records], rawArtifacts = { ...c.rawArtifacts };
  halves.forEach((group, i) => {
    const partKeys = [...group, CLOCK_KEY].sort(), second = i === 1;
    const value = partKeys.map(k => {
      assert.ok(has(fixture.accounts, k), `${k} retained`);
      return k === CLOCK_KEY && second && part2.clockShiftSeconds ? shiftedClock(part2.clockShiftSeconds) : fixture.accounts[k];
    });
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: second && part2.slot !== undefined ? part2.slot : SLOT }, value } });
    const sequence = records.length + 1, requestId = `bank-${round}-${i + 1}`, id = `execliq-req-${sequence}`;
    const raw = JSON.stringify(execLiqRequestArtifactSchema.parse({
      artifactVersion: last.artifactVersion, method: last.method, token: last.token, sequence, requestId, startedAt: last.completedAt, completedAt: last.completedAt,
      response: { status: 'OK', httpStatus: 200, body }, role: 'BANK', round, part: i + 1, partCount: 2, request: execLiqAccountsRequest(partKeys, minSlot),
    }));
    records.push({ ...template, id, contentHash: sha256(raw), scope: { ...template.scope, requestId, sequence } });
    rawArtifacts[id] = raw;
  });
  return { records, rawArtifacts };
}

/** Pure validator unit view: ordinary empty components, NOT_REQUESTED semantic; not a Service snapshot. */
function bundle(c: Capture, cutoff: string, facts?: Json): Json {
  const evidence: Json[] = [...c.records], rawArtifacts: Record<string, string> = { ...c.rawArtifacts };
  if (facts !== undefined) { const d = execLiqDerivationRecord(facts as ExecutableLiquidityFacts); evidence.push(d.record); rawArtifacts[EXEC_LIQ_DERIVATION_ID] = d.raw; }
  return {
    token: TOKEN, cutoff, evidence, rawArtifacts, features: [], observations: [], semantic: { status: 'NOT_REQUESTED', claims: [] }, exitProofs: [],
    details: { baseline: [], origins: {}, stageInputs: null, ...(facts === undefined ? {} : { executableLiquidity: facts }) },
  };
}
const validate = (b: Json): ExecLiqValidation => validateExecutableLiquidity(b as ExecLiqBundleView);
function assertReject(v: ExecLiqValidation, expected: readonly string[], label: string): void {
  assert.equal(v.ok, false, `${label}: must reject`);
  if (!v.ok) assert.ok(expected.includes(v.code), `${label}: got ${v.code} (${v.detail})`);
}

let main!: { cap: Capture; facts: Json; sent: Sent[] };
before(async () => {
  const run = await capture();
  assert.deepEqual(run.t.problems, [], 'the constructed transport saw only planned requests');
  assert.equal(run.t.controller.signal.aborted, false);
  main = { cap: run.cap, facts: rebuild(run.cap, CUTOFF_MAIN), sent: run.t.sent };
}, HEAVY);

test('retained fixture: 91 keys, genuine Clock, frames 2/27/7/0/9/11 at or below the bank slot, genuine 3M9s Pool bytes', () => {
  assert.equal(TOKEN.address, 'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump');
  assert.equal(Object.keys(fixture.accounts).length, 91);
  assert.equal(fixture.accounts[CLOCK_KEY].owner, 'Sysvar1111111111111111111111111111111111111');
  assert.deepEqual([CLOCK.slot, CLOCK.epoch, CLOCK.unixTimestamp], [SLOT, 1068, 1793008129]);
  assert.equal(new Date(CLOCK.unixTimestamp * 1000).toISOString(), BANK_CLOCK_AT);
  assert.deepEqual(FRAME_IDS.map(id => fixture.gpa[id].body.result.value.length), [2, 27, 7, 0, 9, 11]);
  for (const id of FRAME_IDS) assert.ok(fixture.gpa[id].body.result.context.slot <= SLOT, `${id} context slot is not after the bank`);
  assert.equal(EXEC_LIQ_MAINNET_GENESIS, KNOWN_MAINNET_GENESIS);
  assert.equal(POOL_DATA.length, 301);
  assert.equal(POOL_DATA.readBigUInt64LE(261), 300n);
  assert.equal(POOL_DATA[270], 1);
  assert.equal(PUMP_QUOTE, '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh');
  assert.deepEqual([addressAt(POOL_DATA, 43), addressAt(POOL_DATA, 75)], [TOKEN.address, PUMP_QUOTE]);
  assert.ok(fixture.gpa['pumpswap-first'].body.result.value.some((r: Json) => r.pubkey === POOL));
});

test('collector: contiguous receipts, genesis first, six pinned frame bodies without dataSize or cap, Clock in every bank part, USD last', () => {
  const { cap, sent } = main;
  const ids: string[] = cap.records.map(r => r.id);
  assert.deepEqual(ids, ids.map((_, i) => `execliq-req-${i + 1}`));
  assert.deepEqual(Object.keys(cap.rawArtifacts).sort(), [...ids].sort());
  assert.equal(sent.length, ids.length, 'exactly one transport call per retained attempt');
  const artifacts = ids.map(id => artifactOf(cap, id));
  assert.ok(artifacts.every(a => a.response.status === 'OK'));
  const rank: Record<string, number> = { GENESIS: 0, INVENTORY: 1, DISCOVERY: 2, BANK: 3, USD: 4 };
  assert.ok(artifacts.every((a, i) => i === 0 || rank[a.role]! >= rank[artifacts[i - 1].role]!), 'send order genesis, inventory, discovery, bank, USD');
  assert.equal(artifacts[0].role, 'GENESIS');
  assert.equal(JSON.parse(artifacts[0].response.body).result, KNOWN_MAINNET_GENESIS);
  assert.deepEqual(artifacts.slice(1, 7).map(a => a.frameId), FRAME_IDS);
  EXEC_LIQ_INVENTORY_FRAMES.forEach((frame, i) => {
    const body = sent[i + 1]!.body;
    assert.deepEqual(JSON.parse(body), execLiqInventoryRequest(TOKEN, frame.frameId));
    assert.equal(/dataSize|dataSlice|minContextSlot/.test(body), false, `${frame.frameId} carries no size filter, slice or slot`);
    assert.equal(JSON.parse(artifacts[i + 1].response.body).result.value.length, fixture.gpa[frame.frameId].body.result.value.length);
  });
  const maxSlot = Math.max(...FRAME_IDS.map(id => fixture.gpa[id].body.result.context.slot));
  const reads = artifacts.filter(a => a.role === 'DISCOVERY' || a.role === 'BANK');
  assert.ok(reads.some(a => a.role === 'DISCOVERY') && reads.some(a => a.role === 'BANK'));
  for (const a of reads) assert.equal(a.request.params[1].minContextSlot, maxSlot);
  for (const a of artifacts.filter(x => x.role === 'BANK')) assert.ok(a.request.params[0].includes(CLOCK_KEY));
  assert.deepEqual(artifacts[artifacts.length - 1].request, { method: 'GET', url: EXEC_LIQ_USD_URL });
  for (const text of [...Object.values(cap.rawArtifacts), JSON.stringify(cap.records), JSON.stringify(main.facts)]) {
    assert.equal(text.includes(RPC_SECRET) || text.includes(RPC_URL), false, 'the RPC URL is never retained');
  }
});

test('reconstruction scope: 56 unique pools, 17 cash routes, 39 explicit non-cash rows, nothing unclassified', () => {
  const inv = main.facts.inventory;
  assert.ok(inv.frames.every((f: Json) => f.status === 'OBSERVED'));
  assert.deepEqual(inv.frames.map((f: Json) => f.frameId), FRAME_IDS);
  assert.deepEqual(inv.frames.map((f: Json) => f.pools.length), [2, 27, 7, 0, 9, 11]);
  assert.deepEqual(inv.frames.map((f: Json) => f.contextSlot), FRAME_IDS.map(id => fixture.gpa[id].body.result.context.slot));
  const all = new Set<string>(inv.frames.flatMap((f: Json) => f.pools));
  assert.equal(all.size, 56);
  assert.equal(inv.cashPools.length, 17);
  assert.equal(inv.excluded.length, 39);
  assert.deepEqual(inv.unclassified, []);
  const excluded: string[] = inv.excluded.map((e: Json) => e.pool);
  assert.deepEqual([...inv.cashPools, ...excluded].sort(), [...all].sort());
  for (const e of inv.excluded) {
    assert.equal(e.reason, 'OTHER_ASSET_CONVERSION');
    assert.equal(CASH_MINTS.includes(e.counterMint), false, `${e.pool} counter ${e.counterMint} is not cash`);
  }
  assert.deepEqual(main.facts.routes.map((r: Json) => r.pool), inv.cashPools);
  for (const r of main.facts.routes) assert.equal(MINT[r.cashAsset], r.outputMint);
  assert.deepEqual([inv.comparison.added, inv.comparison.vanished], [[], []]);
  assert.deepEqual([...inv.cashPools].sort(), [...EXEC_LIQ_REFERENCE_CASH_POOLS].sort());
});

test('all 17 routes KNOWN within own-p0 300 bps; per-asset, netUSD, reference notional, impact and domain re-derived independently', () => {
  const f = main.facts;
  assert.equal(f.aggregate.status, 'PRIMARY_KNOWN', JSON.stringify(f.aggregate.blockers ?? []));
  let net: Q = { n: 0n, d: 1n }, ref: Q = { n: 0n, d: 1n }, chosen = 0n;
  const perAsset = new Map<string, { net: bigint; pools: string[]; decimals: number }>();
  const inputVaults = new Map<string, bigint>();
  for (const r of f.routes) {
    const o = r.outcome;
    assert.equal(o.status, 'KNOWN', `${r.pool} ${JSON.stringify(o.reasons)}`);
    const x = BigInt(o.inputAtoms), n = BigInt(o.netAtoms), num = BigInt(o.facts.p0.num), den = BigInt(o.facts.p0.den);
    assert.ok(den > 0n);
    assert.ok(n * den * 10_000n >= x * num * BigInt(10_000 - EXEC_LIQ_IMPACT_BPS), `${r.pool} satisfies its own-p0 300 bps inequality`);
    if (n === 0n) assert.equal(o.inputAtoms, '0', `${r.pool}: the smallest input attaining a zero maximum is zero`);
    if (o.maxAdmissibleInputAtoms !== null) assert.ok(BigInt(o.maxAdmissibleInputAtoms) >= x);
    const w = o.certificate.witnesses.find((c: Json) => c.role === 'CHOSEN');
    assert.deepEqual([w.inputAtoms, w.netAtoms, w.complete, w.admissible], [o.inputAtoms, o.netAtoms, true, true]);
    assert.equal(o.facts.vaults.input.mint, TOKEN.address);
    assert.equal(o.facts.vaults.output.mint, r.outputMint);
    const p = PRICE.get(r.outputMint)!, scale = 10n ** BigInt(o.facts.decimals.output);
    const routeNet: Q = { n: n * p.n, d: p.d * scale }, routeRef: Q = { n: x * num * p.n, d: den * p.d * scale };
    assert.ok(qEq(q(r.usd.netUsd), routeNet), `${r.pool} netUsd`);
    assert.ok(qEq(q(r.usd.referenceNotionalUsd), routeRef), `${r.pool} reference notional`);
    net = qAdd(net, routeNet); ref = qAdd(ref, routeRef); chosen += x;
    const a: { net: bigint; pools: string[]; decimals: number } = perAsset.get(r.outputMint) ?? { net: 0n, pools: [], decimals: o.facts.decimals.output };
    a.net += n; a.pools.push(r.pool); perAsset.set(r.outputMint, a);
    const prior = inputVaults.get(o.facts.vaults.input.address);
    if (prior !== undefined) assert.equal(prior, BigInt(o.facts.vaults.input.amountAtoms));
    inputVaults.set(o.facts.vaults.input.address, BigInt(o.facts.vaults.input.amountAtoms));
  }
  assert.deepEqual(f.aggregate.assets.map((a: Json) => a.outputMint), [...perAsset.keys()].sort());
  for (const a of f.aggregate.assets) {
    const mine = perAsset.get(a.outputMint)!, p = PRICE.get(a.outputMint)!;
    assert.deepEqual([a.netAtoms, a.routePools, a.decimals], [mine.net.toString(), mine.pools, mine.decimals]);
    assert.ok(qEq(q(a.usdPerUnit), p));
    assert.ok(qEq(q(a.netUsd), { n: mine.net * p.n, d: p.d * 10n ** BigInt(mine.decimals) }), `${a.cashAsset} netUsd`);
  }
  assert.ok(qEq(q(f.aggregate.netUsd), net));
  assert.ok(qEq(q(f.aggregate.referenceNotionalUsd), ref));
  assert.ok(net.n > 0n && ref.n > 0n && chosen > 0n);
  assert.equal(f.aggregate.chosenInputSumAtoms, chosen.toString());
  const impact: Q = { n: 10_000n * (ref.n * net.d - net.n * ref.d), d: ref.n * net.d };
  assert.ok(qEq(q(f.aggregate.weightedImpactBps), impact));
  assert.ok(impact.n <= BigInt(EXEC_LIQ_IMPACT_BPS) * impact.d, 'weighted impact never exceeds 300 bps');
  const supply = Buffer.from(fixture.accounts[TOKEN.address].data[0], 'base64').readBigUInt64LE(36);
  const excludedSum = [...inputVaults.values()].reduce((s, v) => s + v, 0n);
  assert.equal(f.inputDomain.status, 'KNOWN');
  assert.equal(f.inputDomain.supplyAtoms, supply.toString());
  assert.deepEqual(f.inputDomain.excludedInputVaults.map((v: Json) => v.address), [...inputVaults.keys()].sort());
  assert.equal(f.inputDomain.domainAtoms, (supply - excludedSum).toString());
  assert.equal(f.inputDomain.chosenInputSumAtoms, chosen.toString());
  assert.equal(f.inputDomain.withinDomain, true);
});

test('route specifics: DAMM 13623 -> 1021 with max admissible 13625 and eight known zeros; PumpSwap fee-floor zeros with current holderReward', () => {
  const routes: Json[] = main.facts.routes, damm = routes.filter(r => r.venue === 'DAMM_V2');
  assert.equal(damm.length, 9);
  const positive = damm.filter(r => r.outcome.netAtoms !== '0');
  assert.equal(positive.length, 1);
  const o = positive[0].outcome;
  assert.deepEqual({ input: o.inputAtoms, max: o.maxAdmissibleInputAtoms, net: o.netAtoms, output: positive[0].outputMint, zero: o.zero },
    { input: '13623', max: '13625', net: '1021', output: WSOL, zero: null });
  for (const r of damm.filter(x => x.outcome.netAtoms === '0')) {
    assert.deepEqual([r.outcome.status, r.outcome.inputAtoms], ['KNOWN', '0']);
    assert.ok(['ZERO_LIQUIDITY', 'EMPTY_OUTPUT_SIDE', 'NO_ADMISSIBLE_INPUT'].includes(r.outcome.zero));
  }
  const pump = routes.filter(r => r.venue === 'PUMPSWAP');
  assert.ok(pump.some(r => r.pool === POOL));
  for (const r of pump) {
    assert.deepEqual([r.outcome.status, r.outcome.netAtoms, r.outcome.certificate.kind, r.adapterVersion, r.direction], ['KNOWN', '0', 'PUMP_FEE_FLOOR', EXEC_LIQ_PUMP_VERSION, 'FIRST_TO_SECOND']);
  }
  const d = pump.find(r => r.pool === POOL).outcome.certificate.diagnostics;
  assert.deepEqual([d.holderReward, d.totalFeeBps, d.feesBps], [true, '325', ['20', '5', '300']]);
});

test('bank, USD references and freshness of the main capture are bound to the retained Clock and constructed rows', () => {
  const f = main.facts;
  assert.deepEqual(f.freshness, { bankClockAt: BANK_CLOCK_AT, usdObservedAt: NOW_MAIN, expiresAt: BANK_EXPIRES_AT, freshAtCutoff: true });
  assert.deepEqual([f.bank.status, f.bank.slot, f.bank.closed], ['OBSERVED', SLOT, true]);
  assert.deepEqual(f.bank.clock, CLOCK);
  assert.ok(f.bank.keys.includes(CLOCK_KEY) && f.bank.keys.includes(TOKEN.address));
  assert.ok(f.bank.keys.every((k: string) => has(fixture.accounts, k)));
  assert.deepEqual(f.usd.refs.map((r: Json) => [r.mint, r.status, r.priceUsdText]), EXEC_LIQ_CASH_OUTPUTS.map(o => [o.mint, 'KNOWN', USD_PRICES[o.asset]]));
  assert.deepEqual([f.cutoff, f.impactBps, f.proofLevel, f.expirySeconds], [CUTOFF_MAIN, 300, 'QUOTED', 30]);
  assert.ok(f.limitations.includes('NOT_WALLET_AVAILABILITY') && f.limitations.includes('NO_SIGNING_SEND_OR_SIMULATION'));
  assert.deepEqual(f.requests.map((e: Json) => e.transport), f.requests.map((e: Json) => e.role === 'USD' ? 'DEXSCREENER' : 'SOLANA_RPC'));
});

test('a wrong-network genesis body under otherwise complete receipts is never primary', HEAVY, () => {
  const cap = rewrite(main.cap, 'execliq-req-1', a => { a.response.body = rpcResult(DEVNET_GENESIS); });
  const f = rebuild(cap, CUTOFF_MAIN);
  assert.equal(f.aggregate.status, 'NOT_PRIMARY');
  assert.deepEqual(f.aggregate.blockers, [{ code: 'NETWORK_NOT_VERIFIED', subjects: [] }]);
  assert.deepEqual(f.routes, main.facts.routes);
  assert.deepEqual(f.aggregate.knownSubtotals.map((s: Json) => [s.outputMint, s.knownSubtotalAtoms]), main.facts.aggregate.assets.map((a: Json) => [a.outputMint, a.netAtoms]));
});

test('a positive cash asset without its own mint-as-base USD row blocks primary with USD_MISSING; atoms stay context only', HEAVY, () => {
  const positive = main.facts.aggregate.assets.find((a: Json) => a.netAtoms !== '0');
  assert.ok(positive, 'the main scope has a positive cash asset');
  const cap = rewrite(main.cap, lastId(main.cap), a => { a.response.body = JSON.stringify(USD_ROWS.filter(r => r.baseToken.address !== positive.outputMint)); });
  const f = rebuild(cap, CUTOFF_MAIN);
  assert.deepEqual(f.aggregate.blockers, [{ code: 'USD_MISSING', subjects: [positive.outputMint] }]);
  const ref = f.usd.refs.find((r: Json) => r.mint === positive.outputMint);
  assert.deepEqual([ref.status, ref.code], ['MISSING', 'NO_BASE_ROW']);
  assert.ok(f.routes.every((r: Json) => r.outcome.status === 'KNOWN'));
  for (const r of f.routes.filter((x: Json) => x.outputMint === positive.outputMint && x.outcome.netAtoms !== '0')) assert.equal(r.usd, null);
  assert.equal(f.aggregate.knownSubtotals.find((s: Json) => s.outputMint === positive.outputMint).knownSubtotalAtoms, positive.netAtoms);
  assert.equal(f.freshness.usdObservedAt, NOW_MAIN);
});

test('root Helius failure shape: HTTP 200 RPC error -32600 on pumpswap-second is retained, the unchanged request is retried and returns 27 rows', HEAVY, async () => {
  const errorText = rpcError(-32600, 'constructed conformance envelope: too many accounts requested');
  const run = await capture({ failOnce: { frameId: 'pumpswap-second', text: errorText } }, NOW_EARLY);
  assert.deepEqual(run.t.problems, []);
  assert.equal(run.waits.length, 1);
  assert.ok(run.waits[0]! > 0);
  const attempts = run.cap.records.map(r => artifactOf(run.cap, r.id)).filter(a => a.requestId === 'inventory-pumpswap-second');
  assert.equal(attempts.length, 2);
  const [failed, ok] = attempts;
  assert.equal(ok.sequence, failed.sequence + 1);
  assert.deepEqual(failed.response, { status: 'FAILED', code: 'RPC_ERROR', httpStatus: 200, body: errorText });
  assert.equal(ok.response.status, 'OK');
  assert.deepEqual(failed.request, ok.request);
  assert.deepEqual(ok.request, execLiqInventoryRequest(TOKEN, 'pumpswap-second'));
  const bodies = run.t.sent.filter(s => s.kind === 'getProgramAccounts' && JSON.parse(s.body).params[1].filters[1].memcmp.offset === 75).map(s => s.body);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1], 'the retry is the byte-identical request: no dataSize, cap or fallback');
  assert.equal(JSON.parse(ok.response.body).result.value.length, 27);
  const fresh = rebuild(run.cap, '2026-10-26T09:49:10.000Z');
  const entry = fresh.requests.find((e: Json) => e.requestId === 'inventory-pumpswap-second');
  assert.deepEqual(entry.attempts.map((a: Json) => [a.status, a.code, a.httpStatus, a.sequence]), [['FAILED', 'RPC_ERROR', 200, failed.sequence], ['OK', null, 200, ok.sequence]]);
  const all = fresh.requests.flatMap((e: Json) => e.attempts).sort((a: Json, b: Json) => a.sequence - b.sequence);
  assert.deepEqual(all.map((a: Json) => a.sequence), run.cap.records.map((_, i) => i + 1));
  assert.ok(all.every((a: Json) => a.artifactId === `execliq-req-${a.sequence}`));
  const frame = fresh.inventory.frames.find((x: Json) => x.frameId === 'pumpswap-second');
  assert.deepEqual([frame.status, frame.artifactId, frame.pools.length], ['OBSERVED', `execliq-req-${ok.sequence}`, 27]);
  assert.deepEqual(fresh.inventory.cashPools, main.facts.inventory.cashPools);
  assert.deepEqual(fresh.inventory.excluded, main.facts.inventory.excluded);
  assert.deepEqual(fresh.routes, main.facts.routes);
  assert.deepEqual(fresh.aggregate, main.facts.aggregate);
  assert.deepEqual(fresh.freshness, { bankClockAt: BANK_CLOCK_AT, usdObservedAt: NOW_EARLY, expiresAt: '2026-10-26T09:49:10.000Z', freshAtCutoff: true });
  const stale = rebuild(run.cap, '2026-10-26T09:49:10.001Z');
  assert.equal(stale.freshness.freshAtCutoff, false);
  assert.deepEqual(stale.aggregate.blockers, [{ code: 'STALE_AT_CUTOFF', subjects: [] }]);
});

test('terminal deadline: a programmatic abort retains the in-flight DISCOVERY attempt as DEADLINE and stops; routes stay MISSING, never zero', async () => {
  const { t, cap, waits } = await deadlineRun();
  assert.deepEqual(t.problems, []);
  assert.equal(t.controller.signal.aborted, true);
  assert.deepEqual([cap.records.length, t.sent.length, waits.length], [8, 8, 0]);
  const last = artifactOf(cap, 'execliq-req-8');
  assert.deepEqual([last.role, last.requestId], ['DISCOVERY', 'discovery-1']);
  assert.deepEqual(last.response, { status: 'FAILED', code: 'DEADLINE', httpStatus: null, body: null });
  const f = rebuild(cap, CUTOFF_MAIN);
  assert.deepEqual(f.bank, { status: 'MISSING', code: 'NOT_ATTEMPTED', artifactIds: [] });
  assert.equal(f.routes.length, 17);
  for (const r of f.routes) {
    assert.deepEqual([r.outcome.status, r.outcome.reasons, r.usd], ['MISSING', ['ACCOUNT_NOT_READ'], null]);
    assert.equal(has(r.outcome, 'netAtoms'), false);
  }
  assert.equal(f.aggregate.status, 'NOT_PRIMARY');
  assert.deepEqual(f.aggregate.knownSubtotals, []);
  assert.deepEqual(blocker(f, 'BANK_NOT_OBSERVED').subjects, ['NOT_ATTEMPTED']);
  assert.deepEqual(blocker(f, 'ROUTE_NOT_KNOWN').subjects, f.inventory.cashPools);
  assert.equal(codes(f).includes('STALE_AT_CUTOFF'), false);
  assert.deepEqual([f.usd.status, f.usd.code, f.freshness.bankClockAt, f.freshness.freshAtCutoff], ['MISSING', 'NOT_ATTEMPTED', null, false]);
});

test('network proof: wrong-hash, HTTP-failed and RPC-error genesis stop the collector before inventory; absent genesis is never primary', async () => {
  const wrong = await capture({ genesis: { status: 200, text: rpcResult(DEVNET_GENESIS) } });
  const failed = await capture({ genesis: { status: 403, text: rpcError(-32403, 'constructed forbidden') } });
  const erroring = await capture({ genesis: { status: 200, text: rpcError(-32600, 'constructed error envelope') } }, NOW_MAIN, t => t.controller.abort());
  const expected: [string, Run, Json][] = [
    ['wrong network', wrong, { status: 'OK', code: undefined, httpStatus: 200 }],
    ['HTTP 403', failed, { status: 'FAILED', code: 'HTTP_STATUS', httpStatus: 403 }],
    ['RPC error ended by deadline', erroring, { status: 'FAILED', code: 'RPC_ERROR', httpStatus: 200 }],
  ];
  for (const [label, run, response] of expected) {
    assert.deepEqual(run.t.problems, [], label);
    assert.deepEqual(run.t.sent.map(s => s.kind), ['getGenesisHash'], `${label}: no inventory request follows`);
    assert.equal(run.cap.records.length, 1, label);
    const a = artifactOf(run.cap, 'execliq-req-1');
    assert.deepEqual([a.role, a.requestId, a.response.status, a.response.code, a.response.httpStatus], ['GENESIS', 'genesis', response.status, response.code, response.httpStatus], label);
    const f = rebuild(run.cap, CUTOFF_MAIN);
    assert.equal(f.aggregate.status, 'NOT_PRIMARY', label);
    assert.ok(codes(f).includes('NETWORK_NOT_VERIFIED'), label);
    assert.deepEqual(blocker(f, 'INVENTORY_FRAME_NOT_OBSERVED').subjects, [...FRAME_IDS].sort(), label);
    assert.ok(f.inventory.frames.every((x: Json) => x.status === 'MISSING' && x.code === 'NOT_ATTEMPTED'), label);
    assert.deepEqual(f.requests.map((e: Json) => e.requestId), ['genesis'], label);
  }
  assert.equal(erroring.waits.length, 1);
  const none = rebuild({ records: [], rawArtifacts: {} }, CUTOFF_MAIN);
  assert.equal(none.aggregate.status, 'NOT_PRIMARY');
  assert.ok(codes(none).includes('NETWORK_NOT_VERIFIED'));
  assert.deepEqual(none.requests, []);
});

test('collector rejects a non-Solana token before any request', async () => {
  const t = transport();
  await assert.rejects(collectExecutableLiquidity({
    token: { chain: 'base', address: '0x0000000000000000000000000000000000000001' } as unknown as TokenRef, fetcher: t.fetcher, rpcUrl: RPC_URL,
    signal: t.controller.signal, now: () => NOW_MAIN, wait: async () => {},
  }), /EXEC_LIQ_SOLANA_REQUIRED/);
  assert.equal(t.sent.length, 0);
});

test('an absent fixture key is never served as null: the transport aborts and the collector halts with a retained DEADLINE', async () => {
  const run = await capture({ ...PUMP_ONLY, withhold: [BASE_VAULT] }, NOW_EARLY);
  assert.equal(run.t.problems.length, 1);
  assert.match(run.t.problems[0]!, /not retained/);
  const last = artifactOf(run.cap, lastId(run.cap));
  assert.deepEqual([last.role, last.response.status, last.response.code], ['DISCOVERY', 'FAILED', 'DEADLINE']);
  const f = rebuild(run.cap, CUTOFF_MAIN);
  assert.deepEqual([f.bank.status, f.routes[0].outcome.status, f.routes[0].outcome.reasons, f.aggregate.status], ['MISSING', 'MISSING', ['ACCOUNT_NOT_READ'], 'NOT_PRIMARY']);
});

test('constructed zero-only Pump scope: genuine route KNOWN zero, primary without any FX, usdObservedAt null', async () => {
  const { t, cap } = await pumpRun();
  assert.deepEqual(t.problems, []);
  const f = rebuild(cap, CUTOFF_MAIN);
  assert.deepEqual(f.inventory.cashPools, [POOL]);
  assert.deepEqual(f.inventory.frames.map((x: Json) => [x.status, x.pools]), FRAME_IDS.map(id => ['OBSERVED', id === 'pumpswap-first' ? [POOL] : []]));
  assert.deepEqual(f.inventory.comparison.added, []);
  assert.deepEqual(f.inventory.comparison.vanished, EXEC_LIQ_REFERENCE_CASH_POOLS.filter(p => p !== POOL));
  assert.deepEqual([f.usd.status, f.usd.code], ['MISSING', 'HTTP_STATUS']);
  const r = f.routes[0];
  assert.deepEqual([r.venue, r.direction, r.outputMint, r.cashAsset, r.adapterVersion], ['PUMPSWAP', 'FIRST_TO_SECOND', PUMP_QUOTE, 'WBTC', EXEC_LIQ_PUMP_VERSION]);
  assert.ok(r.plan.mutableKeys.includes(POOL) && r.plan.mutableKeys.includes(BASE_VAULT));
  assert.deepEqual([r.outcome.status, r.outcome.netAtoms, r.outcome.zero, r.outcome.certificate.kind], ['KNOWN', '0', 'NO_ADMISSIBLE_INPUT', 'PUMP_FEE_FLOOR']);
  assert.equal(r.outcome.certificate.diagnostics.holderReward, true);
  assert.deepEqual(r.usd, { netUsd: ZERO, referenceNotionalUsd: ZERO });
  const a = f.aggregate;
  assert.deepEqual([a.status, a.netUsd, a.referenceNotionalUsd, a.weightedImpactBps, a.chosenInputSumAtoms], ['PRIMARY_KNOWN', ZERO, ZERO, null, '0']);
  assert.equal(a.assets.length, 1);
  assert.deepEqual([a.assets[0].outputMint, a.assets[0].netAtoms, a.assets[0].usdPerUnit, a.assets[0].netUsd, a.assets[0].routePools], [PUMP_QUOTE, '0', null, ZERO, [POOL]]);
  assert.deepEqual(f.freshness, { bankClockAt: BANK_CLOCK_AT, usdObservedAt: null, expiresAt: BANK_EXPIRES_AT, freshAtCutoff: true });
});

test('expiry: original cutoff inclusive at bank Clock + 30 s, stale at + 30 001 ms, a future bank Clock is never fresh, replay invariant', async () => {
  const { cap } = await pumpRun();
  const inclusive = rebuild(cap, BANK_EXPIRES_AT), late = rebuild(cap, '2026-10-26T09:49:19.001Z'), early = rebuild(cap, '2026-10-26T09:48:45.000Z');
  assert.deepEqual([inclusive.freshness.freshAtCutoff, inclusive.aggregate.status], [true, 'PRIMARY_KNOWN']);
  assert.deepEqual(early.freshness, { bankClockAt: BANK_CLOCK_AT, usdObservedAt: null, expiresAt: BANK_EXPIRES_AT, freshAtCutoff: false });
  for (const f of [late, early]) {
    assert.equal(f.freshness.freshAtCutoff, false);
    assert.deepEqual(f.aggregate.blockers, [{ code: 'STALE_AT_CUTOFF', subjects: [] }]);
    assert.deepEqual(f.aggregate.knownSubtotals.map((s: Json) => [s.outputMint, s.knownSubtotalAtoms]), [[PUMP_QUOTE, '0']]);
  }
  assert.deepEqual([inclusive.cutoff, late.cutoff, late.freshness.expiresAt], [BANK_EXPIRES_AT, '2026-10-26T09:49:19.001Z', BANK_EXPIRES_AT]);
  assert.deepEqual(rebuild(cap, BANK_EXPIRES_AT), inclusive, 'replay at the original cutoff is deterministic');
  const before = reconstruct(cap, '2026-10-26T09:48:39.999Z');
  assert.deepEqual(before.ok ? null : before.code, 'EXEC_LIQ_TOKEN_OR_CUTOFF_MISMATCH');
});

test('USD reference: Solana rows with the cash mint as base and positive decimal priceUsd; highest liquidity then pair address; quote-side and target rows ignored', async () => {
  const run = await capture({ ...PUMP_ONLY, usd: { status: 200, text: JSON.stringify(SELECTION_ROWS) } }, NOW_EARLY);
  assert.deepEqual(run.t.problems, []);
  const f = rebuild(run.cap, CUTOFF_MAIN);
  assert.deepEqual([f.usd.status, f.usd.observedAt], ['OBSERVED', NOW_EARLY]);
  assert.deepEqual(f.usd.refs.map((r: Json) => r.mint), CASH_MINTS);
  const ref = (asset: string): Json => f.usd.refs.find((r: Json) => r.mint === MINT[asset]);
  const known = (r: Json) => [r.status, r.pairAddress, r.dexId, r.priceUsdText, r.priceUsd, r.liquidityUsd];
  assert.deepEqual(known(ref('WBTC')), ['KNOWN', 'constructed-wbtc-only', 'constructed', '80300.26', { num: '8030026', den: '100' }, 2_000_000]);
  assert.deepEqual(known(ref('WSOL')), ['KNOWN', 'constructed-wsol-tie-a', 'constructed', '101.37', { num: '10137', den: '100' }, 5000]);
  assert.deepEqual([ref('USDC').status, ref('USDC').code], ['MISSING', 'NO_POSITIVE_PRICE']);
  assert.deepEqual([ref('USDT').status, ref('USDT').code], ['MISSING', 'NO_BASE_ROW']);
  assert.equal(f.aggregate.status, 'PRIMARY_KNOWN');
  assert.deepEqual([f.aggregate.assets[0].outputMint, f.aggregate.assets[0].usdPerUnit, f.aggregate.assets[0].netUsd], [PUMP_QUOTE, { num: '8030026', den: '100' }, ZERO]);
  assert.equal(f.freshness.usdObservedAt, null, 'an observed but unneeded USD clock never shortens expiry');
});

test('a cash pool with an unsupported data length stays visible and blocks primary instead of being censored or zeroed', async () => {
  const long = edited(POOL, d => Buffer.concat([d, Buffer.alloc(8)]));
  const run = await capture({ frame: onlyPool(long), accounts: { [POOL]: long } }, NOW_EARLY);
  assert.deepEqual(run.t.problems, []);
  const f = rebuild(run.cap, CUTOFF_MAIN);
  assert.deepEqual([f.inventory.cashPools, f.inventory.frames[0].pools], [[POOL], [POOL]]);
  const r = f.routes[0];
  assert.deepEqual([r.dataLength, r.plan.rejected, r.outcome.status, r.outcome.reasons, r.usd], [309, 'LAYOUT_UNSUPPORTED', 'UNSUPPORTED', ['LAYOUT_UNSUPPORTED'], null]);
  assert.equal(f.aggregate.status, 'NOT_PRIMARY');
  assert.deepEqual(blocker(f, 'ROUTE_NOT_KNOWN').subjects, [POOL]);
  assert.deepEqual(f.aggregate.knownSubtotals, []);
});

test('split bank parts at different slots or with different Clocks are an honest CONFLICT; an equal split merges', async () => {
  const { cap } = await pumpRun();
  const base = rebuild(cap, CUTOFF_MAIN);
  for (const [label, part2, code] of [['slot', { slot: SLOT + 1 }, 'SLOT_MISMATCH'], ['clock', { clockShiftSeconds: 1 }, 'CLOCK_MISMATCH']] as const) {
    const split = appendSplitBank(cap, part2), f = rebuild(split, CUTOFF_MAIN);
    assert.deepEqual([f.bank.status, f.bank.code], ['CONFLICT', code], label);
    assert.deepEqual(f.bank.artifactIds, split.records.slice(-2).map(r => r.id), label);
    assert.deepEqual([f.routes[0].outcome.status, f.routes[0].outcome.reasons], ['CONFLICT', ['CLOCK_MISMATCH']], label);
    assert.equal(f.aggregate.status, 'NOT_PRIMARY', label);
    assert.deepEqual(blocker(f, 'BANK_NOT_OBSERVED').subjects, [code], label);
    assert.deepEqual([f.freshness.bankClockAt, f.freshness.freshAtCutoff], [null, false], label);
  }
  const equal = appendSplitBank(cap, {}), merged = rebuild(equal, CUTOFF_MAIN);
  assert.deepEqual([merged.bank.status, merged.bank.artifactIds, merged.aggregate.status], ['OBSERVED', equal.records.slice(-2).map(r => r.id), 'PRIMARY_KNOWN']);
  assert.deepEqual(merged.routes, base.routes);
});

test('PumpSwap fee floor: genuine 325 bps KNOWN zero, F = L and F = L + 1 KNOWN zero, F < L stays UNSUPPORTED', () => {
  const genuine = solve();
  assert.equal(genuine.adapterVersion, 'execliq-pumpswap-core-v1');
  assert.equal(EXEC_LIQ_PUMP_VERSION, 'execliq-pumpswap-core-v1');
  assert.equal(genuine.plan.route?.direction, 'FIRST_TO_SECOND');
  const o: Json = genuine.outcome;
  assert.deepEqual([o.status, o.netAtoms, o.inputAtoms, o.maxAdmissibleInputAtoms, o.zero], ['KNOWN', '0', '0', '0', 'NO_ADMISSIBLE_INPUT']);
  assert.deepEqual([o.certificate.kind, o.certificate.maximal], ['PUMP_FEE_FLOOR', true]);
  assert.deepEqual([o.certificate.diagnostics.feesBps, o.certificate.diagnostics.totalFeeBps, o.certificate.diagnostics.holderReward], [['20', '5', '300'], '325', true]);
  for (const [bps, total] of [[275, '300'], [276, '301']] as const) {
    const s: Json = solve({ [POOL]: feeOverride(bps) }).outcome;
    assert.deepEqual([s.status, s.netAtoms, s.zero, s.certificate.diagnostics.totalFeeBps], ['KNOWN', '0', 'NO_ADMISSIBLE_INPUT', total], `override ${bps}`);
  }
  const below: Json = solve({ [POOL]: feeOverride(274) }).outcome;
  assert.deepEqual([below.status, below.reasons], ['UNSUPPORTED', ['PUMP_POSITIVE_UNPROVED']]);
  assert.notEqual(below.facts, null);
});

/** Rewrites the response context slot of retained bank receipts (CONSTRUCTED); account bodies and their genuine Clock bytes are unchanged. */
function atContextSlot(c: Capture, ids: readonly string[], slot: number): Capture {
  return ids.reduce((acc, id) => rewrite(acc, id, a => { const body = JSON.parse(a.response.body); body.result.context.slot = slot; a.response.body = JSON.stringify(body); }), c);
}

test('a bank whose context slot is not its Clock slot is an honest CONFLICT for one part or equally mismatched parts; never zero or PRIMARY_KNOWN', async () => {
  const { cap } = await pumpRun();
  const base = rebuild(cap, CUTOFF_MAIN);
  assert.deepEqual([base.bank.status, base.bank.slot, base.bank.clock.slot, base.aggregate.status], ['OBSERVED', SLOT, SLOT, 'PRIMARY_KNOWN']);
  const bankIds = cap.records.filter(r => r.scope.role === 'BANK').map(r => r.id as string), lastBank = bankIds[bankIds.length - 1]!;
  assert.equal(artifactOf(cap, lastBank).partCount, 1, 'the Pump-only bank round is one part');
  for (const id of bankIds) {
    const keys: string[] = artifactOf(cap, id).request.params[0];
    assert.equal(keys.filter(k => k === CLOCK_KEY).length, 1, `${id}: core injects exactly one global Clock into every bank request`);
  }
  const finalKeys: string[] = artifactOf(cap, lastBank).request.params[0], pumpPlan = planPumpRoute({ token: TOKEN, pool: POOL, accounts: bankOf().accounts });
  assert.ok(!pumpPlan.requiredKeys.includes(CLOCK_KEY) && !pumpPlan.additionalKeys.includes(CLOCK_KEY), 'the Pump route plan excludes the global Clock');
  assert.ok(pumpPlan.requiredKeys.every(k => finalKeys.includes(k)), 'the final bank covers every planned Pump key');
  assert.deepEqual(finalKeys.filter(k => k !== CLOCK_KEY), [...pumpPlan.requiredKeys].sort(), 'the final bank is the Pump plan plus exactly one core-added Clock');
  const split = appendSplitBank(cap, {}), splitIds = split.records.slice(-2).map(r => r.id as string);
  const cases: [string, Capture, string[]][] = [
    ['single part', atContextSlot(cap, [lastBank], SLOT + 1), [lastBank]],
    ['equally mismatched two parts', atContextSlot(split, splitIds, SLOT + 1), splitIds],
  ];
  for (const [label, mismatched, ids] of cases) {
    const f = rebuild(mismatched, CUTOFF_MAIN);
    assert.deepEqual([f.bank.status, f.bank.code, f.bank.artifactIds], ['CONFLICT', 'CLOCK_MISMATCH', ids], label);
    assert.deepEqual([f.routes[0].outcome.status, f.routes[0].outcome.reasons], ['CONFLICT', ['CLOCK_MISMATCH']], label);
    assert.ok(f.routes.every((r: Json) => r.outcome.status !== 'KNOWN' && !has(r.outcome, 'netAtoms')), `${label}: no route zero`);
    assert.equal(f.aggregate.status, 'NOT_PRIMARY', label);
    assert.deepEqual(blocker(f, 'BANK_NOT_OBSERVED').subjects, ['CLOCK_MISMATCH'], label);
    assert.deepEqual([f.freshness.bankClockAt, f.freshness.freshAtCutoff], [null, false], label);
    assert.equal(validate(bundle(mismatched, CUTOFF_MAIN, f)).ok, true, `${label}: honest non-primary facts validate`);
    assert.equal(validate(bundle(mismatched, CUTOFF_MAIN, base)).ok, false, `${label}: cached PRIMARY_KNOWN facts contradict the receipts`);
  }
});

test('direct PumpSwap quote/solve require the global raw Clock of the common bank (never a route plan key) equal to the typed Clock of the bank slot; only a matching bank stays KNOWN zero', () => {
  const input = { token: TOKEN, pool: POOL }, impactBps = EXEC_LIQ_IMPACT_BPS;
  const zeroFees = { tradingInputAtoms: '0', tradingOutputAtoms: '0', transferInputAtoms: '0', transferOutputAtoms: '0' };
  const matching = bankOf(), noRaw = bankOf({ [CLOCK_KEY]: 'ABSENT' }), nullRaw = bankOf({ [CLOCK_KEY]: null });
  assert.deepEqual(quotePumpRoute({ ...input, bank: matching, inputAtoms: '0' }), { inputAtoms: '0', consumedAtoms: '0', netAtoms: '0', complete: true, fees: zeroFees }, 'raw Clock present');
  const known: Json = solvePumpRoute({ ...input, bank: matching, impactBps }).outcome;
  assert.deepEqual([known.status, known.netAtoms, known.zero], ['KNOWN', '0', 'NO_ADMISSIBLE_INPUT'], 'raw Clock present');
  /* The raw Clock is global: core adds it to every common math bank and no route plan lists it. An absent or null bank Clock leaves the Pump plan unchanged, while quote/solve below still stop MISSING on it. */
  const plan = planPumpRoute({ ...input, accounts: matching.accounts });
  assert.deepEqual([plan.requiredKeys.includes(CLOCK_KEY), plan.mutableKeys.includes(CLOCK_KEY), plan.missingKeys, plan.nullKeys, plan.rejected], [false, false, [], [], null]);
  for (const [label, bank] of [['raw Clock absent', noRaw], ['raw Clock observed null', nullRaw]] as const) {
    assert.deepEqual(planPumpRoute({ ...input, accounts: bank.accounts }), plan, `${label}: the route plan never sees the global Clock`);
  }
  const rejected: [string, CoherentBank, string, string][] = [
    ['context slot one past the Clock slot', { ...matching, slot: SLOT + 1 }, 'CONFLICT', 'CLOCK_MISMATCH'],
    ['context slot one past the Clock slot, raw Clock absent', { ...noRaw, slot: SLOT + 1 }, 'CONFLICT', 'CLOCK_MISMATCH'],
    ['typed Clock moved with the slot, raw Clock not', { ...matching, slot: SLOT + 1, clock: { ...CLOCK, slot: SLOT + 1 } }, 'CONFLICT', 'CLOCK_MISMATCH'],
    ['raw Clock unix shifted 1 s', bankOf({ [CLOCK_KEY]: shiftedClock(1) }), 'CONFLICT', 'CLOCK_MISMATCH'],
    ['raw Clock absent', noRaw, 'MISSING', 'ACCOUNT_NOT_READ'],
    ['raw Clock observed null', nullRaw, 'MISSING', 'ACCOUNT_NULL'],
    ['raw Clock body cut to 39 bytes (CONSTRUCTED)', bankOf({ [CLOCK_KEY]: edited(CLOCK_KEY, d => d.subarray(0, 39)) }), 'INVALID', 'ACCOUNT_SHAPE'],
    ['raw Clock body owned by the pool program (CONSTRUCTED)', bankOf({ [CLOCK_KEY]: { ...fixture.accounts[CLOCK_KEY], owner: fixture.accounts[POOL].owner } }), 'INVALID', 'ACCOUNT_BINDING'],
  ];
  for (const [label, bank, status, reason] of rejected) {
    for (const inputAtoms of ['0', '1000000']) assert.throws(() => quotePumpRoute({ ...input, bank, inputAtoms }), { message: reason }, `${label}: quote ${inputAtoms}`);
    const s = solvePumpRoute({ ...input, bank, impactBps }), o: Json = s.outcome;
    assert.deepEqual([o.status, o.reasons, o.facts, o.certificate, has(o, 'netAtoms')], [status, [reason], null, null, false], label);
    assert.throws(() => quotePumpRoute({ ...input, bank, inputAtoms: '-1' }), { message: 'ARITHMETIC_RANGE' }, `${label}: malformed atomic first`);
    const bad: Json = solvePumpRoute({ ...input, bank, impactBps: -1 }).outcome;
    assert.deepEqual([bad.status, bad.reasons], ['INVALID', ['ARITHMETIC_RANGE']], `${label}: invalid impact first`);
  }
});

test('PumpSwap direction gate: a constructed quote-side (SECOND) Pool never applies the base-input zero theorem', () => {
  const swapped = edited(POOL, d => { const base = Buffer.from(d.subarray(43, 75)); d.subarray(75, 107).copy(d, 43); base.copy(d, 75); });
  const plan = planPumpRoute({ token: TOKEN, pool: POOL, accounts: bankOf({ [POOL]: swapped }).accounts });
  assert.deepEqual([plan.rejected, plan.route?.direction, plan.route?.outputMint], [null, 'SECOND_TO_FIRST', PUMP_QUOTE]);
  const o: Json = solve({ [POOL]: swapped }).outcome;
  assert.deepEqual([o.status, o.reasons], ['UNSUPPORTED', ['PUMP_QUOTE_INPUT_BUY_UNPROVED']]);
});

test('PumpSwap raw admission: coercible vault/mint bytes are INVALID; absent and observed-null stay distinct MISSING; rounded u64 rentEpoch accepted', () => {
  const shape: [string, string, RpcAccount][] = [
    ['base vault state byte 108 = 3', BASE_VAULT, edited(BASE_VAULT, d => { d[108] = 3; })],
    ['base vault isNative COption = 2', BASE_VAULT, edited(BASE_VAULT, d => { d.writeUInt32LE(2, 109); })],
    ['base vault delegate COption = 2', BASE_VAULT, edited(BASE_VAULT, d => { d.writeUInt32LE(2, 72); })],
    ['base vault closeAuthority COption = 2', BASE_VAULT, edited(BASE_VAULT, d => { d.writeUInt32LE(2, 129); })],
    ['quote mint isInitialized byte 45 = 2', PUMP_QUOTE, edited(PUMP_QUOTE, d => { d[45] = 2; })],
  ];
  for (const [label, key, account] of shape) {
    const o: Json = solve({ [key]: account }).outcome;
    assert.deepEqual([o.status, o.reasons], ['INVALID', ['ACCOUNT_SHAPE']], label);
  }
  const absentPlan = planPumpRoute({ token: TOKEN, pool: POOL, accounts: bankOf({ [BASE_VAULT]: 'ABSENT' }).accounts });
  assert.deepEqual([absentPlan.missingKeys.includes(BASE_VAULT), absentPlan.nullKeys.includes(BASE_VAULT)], [true, false]);
  const absent: Json = solve({ [BASE_VAULT]: 'ABSENT' }).outcome;
  assert.deepEqual([absent.status, absent.reasons, has(absent, 'netAtoms')], ['MISSING', ['ACCOUNT_NOT_READ'], false]);
  const nullPlan = planPumpRoute({ token: TOKEN, pool: POOL, accounts: bankOf({ [BASE_VAULT]: null }).accounts });
  assert.deepEqual([nullPlan.missingKeys.includes(BASE_VAULT), nullPlan.nullKeys.includes(BASE_VAULT)], [false, true]);
  const observedNull: Json = solve({ [BASE_VAULT]: null }).outcome;
  assert.deepEqual([observedNull.status, observedNull.reasons, has(observedNull, 'netAtoms')], ['MISSING', ['ACCOUNT_NULL'], false]);
  const rounded = Number(2n ** 64n - 1n);
  assert.equal(rounded, 2 ** 64);
  const meta: Json = solve({ [BASE_VAULT]: { ...fixture.accounts[BASE_VAULT], rentEpoch: rounded } }).outcome;
  assert.deepEqual([meta.status, meta.netAtoms], ['KNOWN', '0']);
});

test('validator admits exact PRESENT bundles and rejects receipt tampering with specific EXEC_LIQ codes', HEAVY, async () => {
  const full = validate(bundle(main.cap, CUTOFF_MAIN, main.facts));
  assert.equal(full.ok && full.claim === 'PRESENT' ? full.facts.aggregate.status : null, 'PRIMARY_KNOWN');
  const { cap } = await pumpRun(), facts = rebuild(cap, CUTOFF_MAIN);
  const ok = validate(bundle(cap, CUTOFF_MAIN, facts));
  assert.equal(ok.ok && ok.claim, 'PRESENT');
  const changed = (mutate: (b: Json) => void): ExecLiqValidation => { const b = bundle(cap, CUTOFF_MAIN, facts); mutate(b); return validate(b); };
  const patch = (id: string, p: Json) => (b: Json): void => { b.evidence = b.evidence.map((e: Json) => e.id === id ? { ...e, ...p } : e); };
  assertReject(changed(b => { b.rawArtifacts['execliq-req-2'] += ' '; }), ['EXEC_LIQ_RECORD_INVALID'], 'raw bytes under an unchanged hash');
  assertReject(changed(patch('execliq-req-2', { contentHash: '0'.repeat(64) })), ['EXEC_LIQ_RECORD_INVALID'], 'hash');
  assertReject(changed(patch('execliq-req-2', { sourceId: 'execliq-dexscreener' })), ['EXEC_LIQ_RECORD_INVALID'], 'source');
  assertReject(changed(patch('execliq-req-2', { accessMode: 'LOCAL_DERIVED' })), ['EXEC_LIQ_RECORD_INVALID'], 'access mode');
  assertReject(changed(patch('execliq-req-2', { adapterVersion: 'execliq-capture-v0' })), ['EXEC_LIQ_RECORD_INVALID'], 'adapter');
  assertReject(changed(patch('execliq-req-2', { retrievedAt: '2026-10-26T09:48:41.000Z' })), ['EXEC_LIQ_RECORD_INVALID'], 'record clock');
  assertReject(changed(b => { b.evidence = [...b.evidence, b.evidence[1]]; }), ['EXEC_LIQ_RECORD_INVALID'], 'duplicate receipt');
  const request = rewrite(cap, 'execliq-req-2', a => { a.request.params[1].filters[1].memcmp.offset = 44; }, false);
  assertReject(validate(bundle(request, CUTOFF_MAIN, facts)), ['EXEC_LIQ_ARTIFACT_INVALID'], 'request body');
  const notJson: Capture = { records: cap.records.map(r => r.id === 'execliq-req-2' ? { ...r, contentHash: sha256('not json') } : r), rawArtifacts: { ...cap.rawArtifacts, 'execliq-req-2': 'not json' } };
  assertReject(validate(bundle(notJson, CUTOFF_MAIN, facts)), ['EXEC_LIQ_ARTIFACT_INVALID'], 'non-JSON raw with rebound hash');
  assertReject(changed(b => { b.token = { chain: 'solana', address: MINT['USDC'] }; }), ['EXEC_LIQ_ARTIFACT_INVALID'], 'token');
  assertReject(changed(b => { b.token = { chain: 'base', address: '0x0000000000000000000000000000000000000001' }; }), ['EXEC_LIQ_CHAIN_UNSUPPORTED'], 'chain');
  assertReject(changed(b => { b.cutoff = '2026-10-26T09:49:01.000Z'; }), ['EXEC_LIQ_TOKEN_OR_CUTOFF_MISMATCH'], 'cutoff');
  assertReject(changed(b => {
    const raw = JSON.stringify({ ...facts, impactBps: 299 });
    b.rawArtifacts[EXEC_LIQ_DERIVATION_ID] = raw;
    patch(EXEC_LIQ_DERIVATION_ID, { contentHash: sha256(raw) })(b);
  }), ['EXEC_LIQ_DERIVATION_MISMATCH'], 'derivation raw differs from details');
});

test('validator: cached details differing from the reconstruction of unchanged receipts reject; honest NOT_PRIMARY details are admitted', async () => {
  const pump = (await pumpRun()).cap, pumpFacts = rebuild(pump, CUTOFF_MAIN);
  const deadline = (await deadlineRun()).cap, deadlineFacts = rebuild(deadline, CUTOFF_MAIN);
  const honest = validate(bundle(deadline, CUTOFF_MAIN, deadlineFacts));
  assert.equal(honest.ok && honest.claim === 'PRESENT' ? honest.facts.aggregate.status : null, 'NOT_PRIMARY');
  const tampered = (c: Capture, f: Json, mutate: (copy: Json) => void): ExecLiqValidation => { const copy = structuredClone(f); mutate(copy); return validate(bundle(c, CUTOFF_MAIN, copy)); };
  const cached = ['EXEC_LIQ_DETAILS_INVALID', 'EXEC_LIQ_RECONSTRUCTION_MISMATCH'];
  assertReject(tampered(pump, pumpFacts, f => { f.routes[0].outcome.certificate.diagnostics.holderReward = false; }), ['EXEC_LIQ_RECONSTRUCTION_MISMATCH'], 'stale holderReward false');
  assertReject(tampered(pump, pumpFacts, f => { f.bank.clock.unixTimestamp += 1; }), cached, 'bank Clock');
  assertReject(tampered(pump, pumpFacts, f => { f.aggregate.netUsd = { num: '1', den: '1' }; }), cached, 'cached netUsd');
  assertReject(tampered(pump, pumpFacts, f => { f.freshness.freshAtCutoff = false; }), cached, 'cached freshness');
  assertReject(tampered(deadline, deadlineFacts, f => { f.routes[0].outcome.reasons = ['ACCOUNT_NULL']; }), cached, 'route reason');
  assertReject(tampered(deadline, deadlineFacts, f => { f.routes[0].outcome.status = 'UNSUPPORTED'; }), cached, 'route quality');
});

test('namespace: orphan receipts, detail-only claims, partial strips and foreign citations reject; a fully stripped bundle is ABSENT', async () => {
  const { cap } = await pumpRun(), facts = rebuild(cap, CUTOFF_MAIN);
  const changed = (mutate: (b: Json) => void, withFacts = true): ExecLiqValidation => { const b = bundle(cap, CUTOFF_MAIN, withFacts ? facts : undefined); mutate(b); return validate(b); };
  assertReject(changed(() => undefined, false), ['EXEC_LIQ_ORPHAN_PROOF'], 'receipts without details');
  assertReject(changed(b => { b.evidence = []; }, false), ['EXEC_LIQ_ORPHAN_PROOF'], 'owned raw artifacts without records or details');
  assertReject(changed(b => { b.evidence = []; b.rawArtifacts = {}; }), ['EXEC_LIQ_DETAIL_WITHOUT_PROOF'], 'detail only');
  assertReject(changed(b => { b.evidence = b.evidence.filter((e: Json) => e.id !== 'execliq-req-3'); }), ['EXEC_LIQ_RECORD_INVALID'], 'middle record stripped, raw retained');
  assertReject(changed(b => { b.evidence = b.evidence.filter((e: Json) => e.id !== 'execliq-req-3'); delete b.rawArtifacts['execliq-req-3']; }), ['EXEC_LIQ_SEQUENCE_GAP'], 'middle request stripped');
  assertReject(changed(b => {
    b.evidence = b.evidence.filter((e: Json) => e.id === EXEC_LIQ_DERIVATION_ID);
    b.rawArtifacts = { [EXEC_LIQ_DERIVATION_ID]: b.rawArtifacts[EXEC_LIQ_DERIVATION_ID] };
  }), ['EXEC_LIQ_RECONSTRUCTION_MISMATCH'], 'every request stripped, derivation kept');
  assertReject(changed(b => { b.features = [{ id: 'feature-x', evidenceIds: ['execliq-req-2'] }]; }), ['EXEC_LIQ_FOREIGN_CITATION'], 'feature cites a receipt');
  assertReject(changed(b => { b.semantic = { status: 'NOT_REQUESTED', claims: [{ evidenceIds: ['execliq-req-9'] }] }; }), ['EXEC_LIQ_FOREIGN_CITATION'], 'semantic claim');
  assertReject(changed(b => { b.details.advisory = { evidence: [EXEC_LIQ_DERIVATION_ID] }; }), ['EXEC_LIQ_FOREIGN_CITATION'], 'advisory detail');
  const unrelated = { id: 'dex-pairs-1', sourceId: 'dexscreener', sourceType: 'HTTP_JSON', retrievedAt: NOW_MAIN, availableAt: NOW_MAIN, contentHash: sha256('[]'), adapterVersion: 'dexscreener-v1', accessMode: 'PUBLIC_API', scope: {} };
  const absent = changed(b => { b.evidence = [unrelated]; b.rawArtifacts = { 'dex-pairs-1': '[]' }; delete b.details.executableLiquidity; });
  assert.deepEqual(absent, { ok: true, claim: 'ABSENT' });
});
