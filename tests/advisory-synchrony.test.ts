import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { OFFLINE_PUMP_AMM_PROGRAM as sdk, PUMP_AMM_PROGRAM_ID, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, userVolumeAccumulatorPda, poolPda } from '@pump-fun/pump-swap-sdk';
import { archiveDemandReceipt, collectAdvisoryDemandWindows, decodeAdvisoryDemandWindows, demandArchiveSourceLimit, deriveA30DemandWindows, projectCompiledTransaction, unpackDemandReceipt } from '../src/providers/advisory-demand-windows.js';
import { deriveO23Synchrony, SYNCHRONY_BINS, SYNCHRONY_PERMUTATIONS } from '../src/providers/advisory-synchrony.js';
import { decodeAdvisoryWindow, unpackAdvisoryWindowReceipts, type AdvisoryWindowHistory } from '../src/providers/advisory-window.js';
import { decodeAdvisoryShortDemand } from '../src/providers/advisory-short-demand.js';
import { renderSnapshot } from '../src/app/report.js';
import { advisoryFactsSchema } from '../src/domain/advisory-contracts.js';
import { encodeSolanaAddress, SOLANA_MAINNET_GENESIS } from '../src/providers/solana.js';
import { collectLiveToken } from '../src/app/live.js';
import { reconstructAdvisory } from '../src/app/advisory.js';
import { Service } from '../src/app/service.js';
import { starterProfile } from '../src/app/config.js';
import { legacyWindowBundle } from './window-legacy-fixtures.js';

const token = { chain: 'solana' as const, address: '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump' };
const baseVault = new PublicKey(Buffer.alloc(32, 5)), quoteVault = new PublicKey(Buffer.alloc(32, 6)), creator = new PublicKey(Buffer.alloc(32, 7));
const program = PUMP_AMM_PROGRAM_ID.toBase58(), system = '11111111111111111111111111111111';
const pool = poolPda(0, creator, new PublicKey(token.address), NATIVE_MINT).toBase58();
const addr = (n: number) => encodeSolanaAddress(Buffer.alloc(32, n)), account = (n: number) => new PublicKey(Buffer.alloc(32, n)), blockhash = addr(12);
const end = '2026-10-11T23:00:00.000Z', E = Date.parse(end) / 1000, START = E - 12 * 3600, anchorSlot = 500_000;
const anchorAt = '2026-10-11T23:00:40.000Z', clock = '2026-10-11T23:05:00.000Z', cutoff = '2026-10-11T23:10:00.000Z';
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const at = (hour: number, second = 60) => START + hour * 3600 + second;
const sig = (id: number) => { const bytes = Buffer.alloc(64, 9); bytes.writeUInt32LE(id); return encodeSolanaAddress(bytes); };
type Row = { signature: string; slot: number; blockTime: number; err: unknown; confirmationStatus: string; transactionIndex: number };
type Ix = { programId: string; accounts: string[]; data: string };
type RpcRequest = { method: string; params: any[] };
const row = (id: number, slot: number, blockTime: number): Row => ({ signature: sig(id), slot, blockTime, err: null, confirmationStatus: 'finalized', transactionIndex: id % 5 });
const [U1, U2, U3, U4, U5, U6, P] = [61, 62, 63, 64, 65, 66, 72].map(account) as [PublicKey, PublicKey, PublicKey, PublicKey, PublicKey, PublicKey, PublicKey];
const K = addr(70), ROUTER = addr(71), OTHER = addr(73), b58 = (u: PublicKey) => u.toBase58();

function defaults(name: string, user: PublicKey): any {
  const type = sdk.idl.types!.find(t => t.name === name)!;
  const result: Record<string, unknown> = {};
  for (const f of (type.type as any).fields) result[f.name] = f.type === 'pubkey' ? user : f.type === 'bool' ? false : f.type === 'string' ? 'buy' : f.type === 'u8' || f.type === 'u16' ? 0 : new BN(0);
  return result;
}
const eventAuthority = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP_AMM_PROGRAM_ID)[0].toBase58();
const discriminators = { buy_v2: [184, 23, 238, 97, 103, 197, 211, 61], sell_v2: [93, 246, 130, 60, 231, 233, 64, 178] };
/** One current fee-exclusive v2 leg for user, with the accounting identities of the A30 decoder tests. */
function leg(user: PublicKey, blockTime: number, method: 'buy_v2' | 'sell_v2'): { ix: Ix; payload: string } {
  const sell = method === 'sell_v2', core = 20_000_000n, lp = 2n, protocolFee = 3n, creatorFee = 2n, fees = lp + protocolFee + creatorFee, gross = sell ? core : core + fees, userQuote = sell ? core - fees : gross;
  const name = sell ? 'sellEvent' : 'buyEvent', big = (v: bigint | number) => new BN(v.toString());
  const event = { ...defaults(name, user), timestamp: big(blockTime), pool: new PublicKey(pool), user, userBaseTokenAccount: baseVault, userQuoteTokenAccount: quoteVault, poolBaseTokenReserves: big(100000), poolQuoteTokenReserves: big(1000000), baseAmountOut: big(500), baseAmountIn: big(500),
    ixName: method, lpFee: big(lp), protocolFee: big(protocolFee), coinCreatorFee: big(creatorFee), buybackFee: big(protocolFee / 2n), cashback: big(0),
    quoteAmountIn: big(core), userQuoteAmountIn: big(userQuote), quoteAmountInWithLpFee: big(core + lp), quoteAmountOut: big(core), userQuoteAmountOut: big(userQuote), quoteAmountOutWithoutLpFee: big(core - lp),
    maxQuoteAmountIn: big(gross), minBaseAmountOut: big(500), minQuoteAmountOut: big(userQuote) };
  const payload = Buffer.concat([Buffer.from(sdk.idl.events!.find(e => e.name === name)!.discriminator), sdk.coder.types.encode(name, event), Buffer.alloc(24)]).toString('base64');
  const data = Buffer.alloc(24); Buffer.from(discriminators[method]).copy(data); data.writeBigUInt64LE(500n, 8); data.writeBigUInt64LE(sell ? userQuote : gross, 16);
  const u = user.toBase58();
  return { payload, ix: { programId: program, data: encodeSolanaAddress(data), accounts: [pool, u, GLOBAL_CONFIG_PDA.toBase58(), token.address, NATIVE_MINT.toBase58(), baseVault.toBase58(), quoteVault.toBase58(), baseVault.toBase58(), quoteVault.toBase58(),
    TOKEN_PROGRAM_ID.toBase58(), TOKEN_PROGRAM_ID.toBase58(), system, userVolumeAccumulatorPda(user).toBase58(), PUMP_AMM_FEE_CONFIG_PDA.toBase58(), u, eventAuthority, program] } };
}
/** Official compiled json: signers lead the static keys and account 0 pays the fee. */
function compile(r: Row, signers: string[], top: Ix[], inner: Ix[], logs: string[], version: 'legacy' | 0 | 1 = 'legacy'): any {
  const keys = [...signers, ...new Set([...top, ...inner].flatMap(ix => [...ix.accounts, ix.programId]).filter(k => !signers.includes(k)))];
  const compiled = (ix: Ix, stackHeight: number | null) => ({ programIdIndex: keys.indexOf(ix.programId), accounts: ix.accounts.map(k => keys.indexOf(k)), data: ix.data, stackHeight });
  const message: any = { header: { numRequiredSignatures: signers.length, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 }, accountKeys: keys, recentBlockhash: blockhash, instructions: top.map(ix => compiled(ix, null)) };
  if (version === 0) message.addressTableLookups = [];
  if (version === 1) message.transactionConfig = { computeUnitLimit: 276751, heapSize: null, loadedAccountsDataSizeLimit: 35000000, priorityFee: 552 };
  return { slot: r.slot, blockTime: r.blockTime, version, transaction: { signatures: [r.signature, ...signers.slice(1).map((_, i) => sig(900_000 + i))], message },
    meta: { err: null, fee: 5000 * signers.length, preBalances: [], postBalances: [], preTokenBalances: [], postTokenBalances: [], innerInstructions: inner.length ? [{ index: 0, instructions: inner.map(ix => compiled(ix, 2)) }] : [], logMessages: logs, loadedAddresses: { writable: [], readonly: [] } } };
}
const frame = (payload: string, depth: number) => [`Program ${program} invoke [${depth}]`, `Program data: ${payload}`, `Program ${program} success`];
/** Top-level legs for users in one transaction; signers[0] pays the fee. */
const swaps = (r: Row, signers: string[], users: PublicKey[], method: 'buy_v2' | 'sell_v2' = 'buy_v2', version: 'legacy' | 0 | 1 = 'legacy') => {
  const legs = users.map(u => leg(u, r.blockTime, method));
  return compile(r, signers, legs.map(l => l.ix), [], legs.flatMap(l => frame(l.payload, 1)), version);
};
/** A router CPI leg: the decoded user is program-authorized and signs nothing. */
const routed = (r: Row, payer: string, user: PublicKey) => { const l = leg(user, r.blockTime, 'buy_v2'); return compile(r, [payer], [{ programId: ROUTER, accounts: [payer], data: '' }], [l.ix], [`Program ${ROUTER} invoke [1]`, ...frame(l.payload, 2), `Program ${ROUTER} success`]); };
const idle = (r: Row) => compile(r, [OTHER], [{ programId: system, accounts: [OTHER, pool], data: '' }], [], [`Program ${system} invoke [1]`, `Program ${system} success`]);
const poolState = (baseMint: PublicKey) => sdk.coder.accounts.encode('pool', { ...defaults('pool', creator), creator, baseMint, quoteMint: NATIVE_MINT, poolBaseTokenAccount: baseVault, poolQuoteTokenAccount: quoteVault });
const poolData = (await poolState(new PublicKey(token.address))).toString('base64');
const wsolMintData = (() => { const b = Buffer.alloc(82); b[44] = 9; b[45] = 1; return b.toString('base64'); })();

function windowFixture(reused = new Map<string, unknown>(), over: Partial<AdvisoryWindowHistory> = {}) {
  const data = { method: 'pumpswap-selected-pool-window-v3', token, pool, window: { start: iso(E - 3600), end }, genesisVerified: true, anchorSlot, anchorTime: iso(E + 30), poolVerified: true, stateSlot: anchorSlot,
    coverageReachedStart: true, indexComplete: true, complete: true, sourceUniverseComplete: false, pages: [], successfulSignatures: 0, failedReferences: 0, transactions: [], trades: [],
    buyQuoteAtomic: '0', sellQuoteAtomic: '0', netQuoteAtomic: '0', foreignSwapLegs: 0, nonSwapInvocations: 0, cpiAuthorizedAccounts: [], limitations: [], reasonCode: 'SELECTED_POOL_WINDOW_FLOW_OBSERVED', ...over } as unknown as AdvisoryWindowHistory;
  const rawArtifacts: Record<string, string> = { 'window-anchor-time': JSON.stringify({ jsonrpc: '2.0', id: 1, result: E + 30 }) }, retrievedAt: Record<string, string> = { 'window-anchor-time': anchorAt };
  const requests: Record<string, { method: string; params: unknown[] }> = { 'window-anchor-time': { method: 'getBlockTime', params: [anchorSlot] } };
  [...reused].forEach(([signature, value], i) => { const id = `window-transaction-${i}`; requests[id] = { method: 'getTransaction', params: [signature, { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }] }; rawArtifacts[id] = JSON.stringify({ jsonrpc: '2.0', id: 1, result: value }); retrievedAt[id] = '2026-10-11T23:01:00.000Z'; });
  return { data, rawArtifacts, retrievedAt, requests };
}
/** Production collection through a scripted RPC, then production A30 and O23 decoding over the retained receipts. */
async function run(pages: Row[][], transactions = new Map<string, unknown>(), options: { reused?: Map<string, unknown>; over?: Partial<AdvisoryWindowHistory>; mutate?: (request: RpcRequest, body: any) => any } = {}) {
  const fetcher: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as RpcRequest;
    let result: unknown;
    if (request.method === 'getSignaturesForAddress') { const before = request.params[1].before; const page = before ? pages.findIndex(p => p.at(-1)?.signature === before) + 1 : 0; result = structuredClone(pages[page] ?? []); }
    else if (request.method === 'getTransaction') { const reference = pages.flat().find(r => r.signature === request.params[0])!; result = transactions.has(reference.signature) ? structuredClone(transactions.get(reference.signature)) : idle(reference); }
    else if (request.method === 'getAccountInfo') result = { context: { slot: anchorSlot + 5 }, value: { owner: program, executable: false, lamports: 1, data: [poolData, 'base64'] } };
    else throw new Error(`Unexpected request ${request.method}`);
    const body = { jsonrpc: '2.0', id: 1, result };
    return new Response(JSON.stringify(options.mutate ? options.mutate(request, body) : body));
  };
  const window = windowFixture(options.reused, options.over), c = await collectAdvisoryDemandWindows(token, window, 'https://rpc.example', fetcher, () => clock);
  return { window, collected: c,
    history: (raw = c.rawArtifacts, times = c.retrievedAt, requests = c.requests) => decodeAdvisoryDemandWindows(token, window.data, window, raw, times, requests, cutoff),
    o23: (raw = c.rawArtifacts, times = c.retrievedAt, requests = c.requests) => deriveO23Synchrony(token, window.data, window, raw, times, requests, cutoff, ['receipt', 'receipt']) };
}
/** Hour 3 holds six transactions in slots 400000-400001; hour 5 holds one multi-leg transaction. */
function scenario() {
  const r3 = row(1, 420_000, at(5, 10)), r7 = row(2, 400_001, at(3, 10)), r1 = row(3, 400_000, at(3, 10)), r2 = row(4, 400_000, at(3, 10)), r4 = row(5, 400_000, at(3, 10)), r5 = row(6, 400_000, at(3, 10)), r6 = row(7, 400_000, at(3, 10));
  const transactions = new Map<string, unknown>([
    [r3.signature, swaps(r3, [K, b58(U3), b58(U4)], [U3, U4])],
    [r7.signature, swaps(r7, [K, b58(U1)], [U1])],
    [r1.signature, swaps(r1, [K, b58(U1)], [U1], 'buy_v2', 1)],
    [r4.signature, swaps(r4, [b58(U5)], [U5], 'buy_v2', 0)],
    [r5.signature, swaps(r5, [K, b58(U6)], [U6], 'sell_v2')],
    [r6.signature, routed(r6, K, P)]]);
  const reused = new Map<string, unknown>([[r2.signature, projectCompiledTransaction(swaps(r2, [K, b58(U2)], [U2]))]]);
  return { rows: [r3, r7, r1, r2, r4, r5, r6], transactions, reused, r1, r2 };
}
function assertNull(metric: any, code: RegExp) {
  assert.equal(metric.quality, 'MISSING'); assert.match(metric.reasonCode, code);
  assert.equal(metric.data.fundingClasses, null); assert.equal(metric.data.bins.length, SYNCHRONY_BINS.length);
  assert.ok(metric.data.bins.every((b: any) => b.synchronizedTrades === null && b.fraction === null && b.null === null));
}

test('sponsored same-side trades synchronize across transactions and users in declared bins, never within one transaction, for one user, self-paid or program users', async () => {
  const s = scenario(), x = await run([s.rows], s.transactions, { reused: s.reused });
  const history = x.history(), metric = x.o23()!, data = metric.data as any;
  assert.equal(deriveA30DemandWindows(history, [])!.quality, 'KNOWN');
  assert.equal(history.trades.length, 8); assert.deepEqual(history.programAccounts, [b58(P)]);
  assert.deepEqual([metric.id, metric.quality, metric.reasonCode, metric.unit, metric.evidenceIds], ['O23', 'KNOWN', 'SPONSORED_SYNCHRONY_OBSERVED', 'fraction-vector', ['receipt']]);
  assert.equal(data.denominator, 8); assert.deepEqual(data.fundingClasses, { SELF: 1, SPONSORED: 6, PROGRAM: 1 });
  assert.deepEqual(data.transactions, { withTrades: 7, sponsored: 5, multiLeg: 1 });
  assert.deepEqual(data.sponsors, { accounts: 1, top: [{ feePayer: K, sponsoredTrades: 6, transactions: 5, distinctUsers: 5 }] });
  // One slot: U1 and U2 only; ten and 150 slots also admit the later U1 trade against U2, never against U1 itself.
  assert.deepEqual(data.bins.map((b: any) => [b.widthSlots, b.offsetSlots, b.synchronizedTrades, b.fraction]), [[1, 0, 2, '0.25'], [10, 0, 3, '0.375'], [10, 5, 3, '0.375'], [150, 0, 3, '0.375'], [150, 75, 3, '0.375']]);
  assert.deepEqual([data.commonControl, data.coordination, data.seed.length], [null, null, 64]);
  const [slot, ...wider] = data.bins;
  // Hour-3 slots always share every wider bin, so their null is degenerate at the observed value.
  for (const b of wider) assert.deepEqual([b.null.permutations, b.null.minFraction, b.null.maxFraction, b.null.meanFraction, b.null.atLeastObserved], [SYNCHRONY_PERMUTATIONS, '0.375', '0.375', '0.375', SYNCHRONY_PERMUTATIONS]);
  // Single-slot null: the isolated slot falls on U2 (0), U1 or the later U1 trade (2/8) or a non-sponsored transaction (3/8).
  assert.deepEqual([slot.null.minFraction, slot.null.maxFraction], ['0', '0.375']);
  for (const q of [slot.null.q05Fraction, slot.null.medianFraction, slot.null.q95Fraction]) assert.ok(['0', '0.25', '0.375'].includes(q));
  assert.ok(Number(slot.null.q05Fraction) <= Number(slot.null.medianFraction) && Number(slot.null.medianFraction) <= Number(slot.null.q95Fraction));
  assert.ok(slot.null.atLeastObserved > 0 && slot.null.atLeastObserved < SYNCHRONY_PERMUTATIONS);
  assert.ok(Number(slot.null.meanFraction) > 0 && Number(slot.null.meanFraction) < 0.375);
  // Seeded permutations replay byte for byte.
  assert.equal(JSON.stringify(x.o23()), JSON.stringify(metric));
});

test('a complete tape without a shared sponsor is a known zero against a valid null; a tradeless tape has no denominator', async () => {
  const a = row(1, 400_000, at(3, 10)), b = row(2, 400_000, at(3, 10)), c = row(3, 400_000, at(3, 10));
  const x = await run([[a, b, c]], new Map([[a.signature, swaps(a, [b58(U1)], [U1])], [b.signature, swaps(b, [b58(U2)], [U2])], [c.signature, swaps(c, [K, b58(U3)], [U3], 'sell_v2')]]));
  const metric = x.o23()!, data = metric.data as any;
  assert.equal(metric.quality, 'KNOWN'); assert.equal(data.denominator, 3); assert.deepEqual(data.fundingClasses, { SELF: 2, SPONSORED: 1, PROGRAM: 0 });
  assert.ok(data.bins.every((bin: any) => bin.fraction === '0' && bin.null.maxFraction === '0' && bin.null.atLeastObserved === SYNCHRONY_PERMUTATIONS));
  const none = await run([[row(4, 400_000, at(3, 10))]]), empty = none.o23()!;
  assert.equal(deriveA30DemandWindows(none.history(), [])!.quality, 'KNOWN');
  assert.deepEqual([empty.quality, empty.reasonCode, (empty.data as any).denominator], ['MISSING', 'SYNCHRONY_DENOMINATOR_ZERO', 0]);
  assert.ok((empty.data as any).bins.every((bin: any) => bin.fraction === null && bin.null === null));
});

test('unverifiable fee roles, request or clock gaps and failed receipts leave every fraction null without shrinking the corpus', async () => {
  const s = scenario();
  const feeless = await run([s.rows], s.transactions, { reused: s.reused, mutate: (r, b) => r.method === 'getTransaction' && r.params[0] === s.r1.signature ? { ...b, result: { ...b.result, meta: { ...b.result.meta, fee: 0 } } } : b });
  assert.equal(deriveA30DemandWindows(feeless.history(), [])!.quality, 'KNOWN');
  assertNull(feeless.o23(), /ADVISORY_SYNCHRONY_FEE_ROLE/);
  const readonlyPayer = structuredClone(s.reused.get(s.r2.signature)) as any; readonlyPayer.transaction.message.accountKeys[0].writable = false;
  const readonlyRun = await run([s.rows], s.transactions, { reused: new Map([[s.r2.signature, readonlyPayer]]) });
  assert.equal(readonlyRun.history().complete, true); assertNull(readonlyRun.o23(), /ADVISORY_SYNCHRONY_FEE_ROLE/);
  const failed = await run([s.rows], s.transactions, { reused: s.reused, mutate: (r, b) => r.method === 'getTransaction' && r.params[0] === s.r1.signature ? { jsonrpc: '2.0', id: 1, error: { code: -32009, message: 'unavailable' } } : b });
  assertNull(failed.o23(), /RPC_REMOTE_-32009/);
  const x = await run([s.rows], s.transactions, { reused: s.reused }), c = x.collected;
  const parsed = structuredClone(c.requests); (parsed['demand-transaction-0']!.params[1] as { encoding: string }).encoding = 'jsonParsed';
  assertNull(x.o23(c.rawArtifacts, c.retrievedAt, parsed), /ADVISORY_DEMAND_REQUEST/);
  assertNull(x.o23(c.rawArtifacts, { ...c.retrievedAt, 'demand-transaction-0': '2026-10-11T22:59:30.000Z' }), /ADVISORY_DEMAND_TRANSACTION_BINDING/);
  assert.equal((await run([s.rows], s.transactions, { over: { complete: false } })).o23(), null);
});

const liveAt = '2026-10-10T12:30:00.000Z', liveEnd = Date.parse('2026-10-10T12:00:00.000Z') / 1000, liveStart = liveEnd - 12 * 3600, liveAnchor = 10_001;
/** Public fixtures for one opt-in advisory live run over the same pool; only the 1000-row demand index returns rows, so the selected hour is complete and tradeless. */
function liveFetcher(rows: Row[], transactions: Map<string, unknown>, mutate: (request: RpcRequest, body: any) => any = (_request, body) => body): typeof fetch {
  const quote = NATIVE_MINT.toBase58();
  return async (input, init) => {
    const url = String(input);
    if (init?.method === 'POST') {
      const request = JSON.parse(String(init.body)) as RpcRequest, method = request.method, options = request.params?.[1] ?? {};
      const result = method === 'getGenesisHash' ? SOLANA_MAINNET_GENESIS : method === 'getSlot' ? liveAnchor : method === 'getBlockTime' ? liveEnd + 60
        : method === 'getSignaturesForAddress' ? (request.params[0] === pool && options.limit === 1000 ? structuredClone(rows) : [])
        : method === 'getAccountInfo' && request.params[0] === pool ? { context: { slot: liveAnchor + 1 }, value: { owner: program, executable: false, lamports: 1, data: [poolData, 'base64'] } }
        : method === 'getMultipleAccounts' && Array.isArray(request.params[0]) && request.params[0][0] === pool ? { context: { slot: liveAnchor + 1 }, value: [{ owner: program, executable: false, lamports: 1, data: [poolData, 'base64'] }, { owner: TOKEN_PROGRAM_ID.toBase58(), executable: false, lamports: 1, data: [wsolMintData, 'base64'] }] }
        : method === 'getTransaction' && transactions.has(request.params[0]) ? (options.encoding==='jsonParsed'?projectCompiledTransaction(structuredClone(transactions.get(request.params[0]))):structuredClone(transactions.get(request.params[0])))
        : { context: { slot: 1 }, value: null };
      return new Response(JSON.stringify(mutate(request, { jsonrpc: '2.0', id: 1, result })));
    }
    let value: unknown;
    if (url.includes('/token-pairs/')) value = [{ chainId: 'solana', dexId: 'pumpswap', pairAddress: pool, baseToken: { address: token.address }, quoteToken: { address: quote }, priceUsd: '1', liquidity: { usd: 10000 }, volume: { h24: 100 }, txns: { h24: { buys: 4, sells: 3 } } }];
    else if (url.includes('include=base_token')) value = { data: { id: `solana_${pool}`, type: 'pool', attributes: { address: pool }, relationships: { base_token: { data: { id: `solana_${token.address}`, type: 'token' } }, quote_token: { data: { id: `solana_${quote}`, type: 'token' } } } }, included: [token.address, quote].map(address => ({ id: `solana_${address}`, type: 'token', attributes: { address } })) };
    else if (url.includes('ohlcv')) value = { data: { attributes: { ohlcv_list: Array.from({ length: 75 }, (_, i) => [liveEnd - i * 3600, 10 + i % 6, 11 + i % 6, 9 + i % 6, 10 + i % 6, 20]) } } };
    else if (url.includes('coinbase')) value = Array.from({ length: 75 }, (_, i) => [liveEnd - i * 3600, 9 + i % 6, 11 + i % 6, 10 + i % 6, 10 + i % 6, 2]);
    else if (url.includes('llama')) value = { chain: new URL(url).pathname.split('/').at(-1), totalDataChart: [[liveStart - 172800, 10], [liveStart - 86400, 20], [liveStart, 999]] };
    else if (url.includes('/orders/')) value = { orders: [{ chainId: 'solana', tokenAddress: token.address, type: 'tokenProfile', status: 'approved', paymentTimestamp: Date.parse(liveAt) - 1000 }], boosts: [] };
    else throw new Error('Unexpected fixture request');
    return new Response(JSON.stringify(value));
  };
}
const liveRows = () => [row(1, 9_000, liveStart + 3 * 3600 + 10), row(2, 9_000, liveStart + 3 * 3600 + 10), row(3, 9_000, liveStart + 3 * 3600 + 10)];
/** Two self-paid buys and one sponsored sell: no shared sponsor, so every declared bin is a known zero. */
const liveTransactions = (rows: Row[]) => new Map<string, unknown>([[rows[0]!.signature, swaps(rows[0]!, [b58(U1)], [U1])], [rows[1]!.signature, swaps(rows[1]!, [b58(U2)], [U2])], [rows[2]!.signature, swaps(rows[2]!, [K, b58(U3)], [U3], 'sell_v2')]]);
const collectLive = (rows: Row[], mutate?: (request: RpcRequest, body: any) => any) => collectLiveToken(token, { profile: starterProfile(), semanticEnabled: false, advisoryEnabled: true, fetcher: liveFetcher(rows, liveTransactions(rows), mutate), now: () => liveAt });
const rehash = (bundle: Awaited<ReturnType<typeof collectLive>>, id: string) => { bundle.evidence.find(e => e.id === id)!.contentHash = createHash('sha256').update(bundle.rawArtifacts[id]!).digest('hex'); };

test('live collection persists and replays a known-zero O23 from proof v13 onward, while proof v12 reconstruction leaves it unmeasured', async () => {
  const bundle = await collectLive(liveRows()), proof = JSON.parse(bundle.rawArtifacts['advisory-derivation']!), facts = bundle.details!.advisory!;
  assert.deepEqual([proof.method, facts.method, facts.metrics.find(m => m.id === 'A30')!.quality], ['advisory-provenance-v36', 'advisory-measurements-v35', 'KNOWN']);
  const o23 = facts.metrics.find(m => m.id === 'O23')!, data = o23.data as any;
  assert.deepEqual([o23.quality, o23.reasonCode, data.denominator, data.fundingClasses, data.sponsors.accounts], ['KNOWN', 'SPONSORED_SYNCHRONY_OBSERVED', 3, { SELF: 2, SPONSORED: 1, PROGRAM: 0 }, 1]);
  assert.ok(data.bins.every((bin: any) => bin.synchronizedTrades === 0 && bin.fraction === '0' && bin.null.permutations === SYNCHRONY_PERMUTATIONS && bin.null.maxFraction === '0' && bin.null.atLeastObserved === SYNCHRONY_PERMUTATIONS));
  assert.ok(o23.evidenceIds.includes('advisory-demand-demand-transaction-2') && o23.evidenceIds.every(id => bundle.evidence.some(e => e.id === id)));
  // Proof v12 keeps its own facts version and never derives O23 from the same receipts, rebuilt from the exact plain proof-v20 window form of this fixture.
  const { bundle: v20Bundle, proof: v20 } = legacyWindowBundle(bundle), rebuild = (p: unknown) => reconstructAdvisory(token, liveAt, v20Bundle.details!.baseline, v20Bundle.evidence, v20Bundle.rawArtifacts, p, v20Bundle.thesis ?? null, v20Bundle.features), facts20 = rebuild(v20);
  const legacy = { ...v20, method: 'advisory-provenance-v12' }, replayed = rebuild(legacy);
  assert.equal(replayed.method, 'advisory-measurements-v13');
  assert.deepEqual(replayed.metrics.find(m => m.id === 'O23'), { id: 'O23', quality: 'MISSING', unit: 'scoped-record', data: null, evidenceIds: [], reasonCode: 'INDEPENDENT_INDICATORS_AND_NULL_BASELINE_REQUIRED' });
  assert.deepEqual(replayed.metrics.filter(m => m.id !== 'O23' && m.id !== 'O29' && m.id !== 'C16'), facts20.metrics.filter(m => m.id !== 'O23' && m.id !== 'O29' && m.id !== 'C16'));
  // O29 dispatches only from proof v14 over the same single retained-V demand decode; every v13 metric is unchanged by that decode.
  const o29 = facts.metrics.find(m => m.id === 'O29')!, v13 = rebuild({ ...v20, method: 'advisory-provenance-v13' });
  assert.deepEqual([o29.quality, o29.reasonCode, (o29.data as any).method], ['MISSING', 'RESERVE_CURVE_MISMATCH', 'complete-pool-effective-reserve-path-v1']);
  assert.equal(v13.method, 'advisory-measurements-v14');
  assert.notEqual((v13.metrics.find(m => m.id === 'O29')!.data as any)?.method, 'complete-pool-effective-reserve-path-v1');
  assert.deepEqual(v13.metrics.filter(m => m.id !== 'O29' && m.id !== 'C16'), facts20.metrics.filter(m => m.id !== 'O29' && m.id !== 'C16'));
  const directory = mkdtempSync(join(tmpdir(), 'advisory-synchrony-')), file = join(directory, 'live.sqlite');
  try {
    const writer = new Service(file); let id = '';
    try {
      id = writer.analyzeLive(bundle).id;
      // A self-consistent proof v12 downgrade, a claimed bin fraction and a rehashed fee-role receipt cannot be persisted as current.
      const downgraded = structuredClone(bundle); downgraded.rawArtifacts['advisory-derivation'] = JSON.stringify(legacy); rehash(downgraded, 'advisory-derivation'); downgraded.details!.advisory = replayed;
      const claimed = structuredClone(bundle); (claimed.details!.advisory!.metrics.find(m => m.id === 'O23')!.data as any).bins[0].fraction = '0.5';
      const forged = structuredClone(bundle), key = 'demand-transaction-2', receipt = `advisory-demand-${key}`, body = JSON.parse(unpackDemandReceipt(forged.rawArtifacts[receipt]!, demandArchiveSourceLimit(key)));
      body.result.meta.fee = 0; forged.rawArtifacts[receipt] = archiveDemandReceipt(JSON.stringify(body)); rehash(forged, receipt);
      for (const [name, candidate] of [['downgraded', downgraded], ['claimed', claimed], ['forged', forged]] as const) assert.throws(() => writer.analyzeLive(candidate), /ADVISORY_PROOF_INVALID/, name);
    } finally { writer.close(); }
    const reader = new Service(file);
    try { assert.deepEqual(reader.replay(id), reader.show(id)); assert.equal(reader.analyzeLive(bundle).id, id); } finally { reader.close(); }
    const db = new DatabaseSync(file);
    try { assert.equal(JSON.parse((db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(id) as { semantic: string }).semantic).policyVersion, 'research-screen-advisory-v33'); } finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a live tape with one unverifiable fee role persists O23 as missing with every fraction null while A30 stays known', async () => {
  const rows = liveRows(), feeless = rows[2]!.signature;
  const bundle = await collectLive(rows, (request, body) => request.method === 'getTransaction' && request.params[0] === feeless ? { ...body, result: { ...body.result, meta: { ...body.result.meta, fee: 0 } } } : body);
  const facts = bundle.details!.advisory!, o23 = facts.metrics.find(m => m.id === 'O23')!;
  assert.equal(facts.metrics.find(m => m.id === 'A30')!.quality, 'KNOWN');
  assertNull(o23, /ADVISORY_SYNCHRONY_FEE_ROLE/); assert.equal((o23.data as any).denominator, null);
  const directory = mkdtempSync(join(tmpdir(), 'advisory-synchrony-missing-')), service = new Service(join(directory, 'live.sqlite'));
  try { const saved = service.analyzeLive(bundle); assert.deepEqual(service.replay(saved.id), saved); } finally { service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('proof v16 persists the supplementary one-hour report recomputed from the same raw receipts while A30 and coverage counts stay identical', async () => {
  const old = liveRows(), inScope = [row(14, 9_600, liveEnd - 300), row(13, 9_500, liveEnd - 3000), row(12, 9_400, liveEnd - 3570), row(11, 9_300, liveEnd - 5400)], rows = [...inScope, ...old];
  // U4 buys in window 5, router-authorized P in window 1, and U1 in window 0 after a baseline buy, so only window 5 qualifies.
  const transactions = new Map<string, unknown>([...liveTransactions(old), [inScope[0]!.signature, swaps(inScope[0]!, [b58(U4)], [U4])], [inScope[1]!.signature, routed(inScope[1]!, K, P)], [inScope[2]!.signature, swaps(inScope[2]!, [b58(U1)], [U1])], [inScope[3]!.signature, swaps(inScope[3]!, [b58(U1)], [U1])]]);
  const live = (mutate?: (request: RpcRequest, body: any) => any) => collectLiveToken(token, { profile: starterProfile(), semanticEnabled: false, advisoryEnabled: true, fetcher: liveFetcher(rows, transactions, mutate), now: () => liveAt });
  const bundle = await live(), proof = JSON.parse(bundle.rawArtifacts['advisory-derivation']!), facts = bundle.details!.advisory!, s = facts.supplements!.shortDemand;
  assert.deepEqual([proof.method, facts.method, facts.metrics.length, facts.metrics.find(m => m.id === 'A30')!.quality], ['advisory-provenance-v36', 'advisory-measurements-v35', 50, 'KNOWN']);
  assert.deepEqual([s.status, s.reportEnd, s.baseline.start, s.baseline.end, s.measured.start], ['COMPLETE', '2026-10-10T12:00:00.000Z', '2026-10-10T10:00:00.000Z', '2026-10-10T11:00:00.000Z', '2026-10-10T11:00:00.000Z']);
  assert.deepEqual(s.windows.map(w => w.condition), [false, false, false, false, false, true]);
  assert.deepEqual(s.windows.map(w => w.firstObservedBuyerCount), [0, 0, 0, 0, 0, 1]);
  assert.deepEqual([s.windows[1]!.flow!.programAccountTrades, s.windows[1]!.flow!.buyQuoteAtomic, s.windows[0]!.flow!.decodedTrades], [1, '20000000', 1]);
  assert.deepEqual([s.satisfiedWindows, s.share, s.baseline.meaningfulBuyers, s.measured.flow!.buyQuoteAtomic, s.coverage.scopeSuccessfulReferences, s.coverage.outsideScopeUnresolvedTransactions], [1, '0.16666666666666666667', 1, '60000000', 4, 0]);
  assert.ok(s.programAccounts.accounts.includes(b58(P)));
  // The persisted report equals the production provider over the same retained window and demand receipts.
  const receipts = (namespace: 'window' | 'demand') => { const d = proof[namespace] as { requests: Record<string, { method: string; params: unknown[] }>; artifactIds: Record<string, string> }, keys = Object.entries(d.artifactIds);
    return { rawArtifacts: Object.fromEntries(keys.map(([k, id]) => [k, bundle.rawArtifacts[id]!])), retrievedAt: Object.fromEntries(keys.map(([k, id]) => [k, bundle.evidence.find(e => e.id === id)!.retrievedAt])), requests: d.requests, ids: keys.map(([, id]) => id) }; };
  const archived = receipts('window'), w = { ...archived, rawArtifacts: unpackAdvisoryWindowReceipts(archived,true).rawArtifacts }, d = receipts('demand'), windowData = decodeAdvisoryWindow(token, proof.pool, proof.window.end, w.rawArtifacts, w.retrievedAt, w.requests, liveAt, true, true, true, true, true, true);
  assert.equal(s.coverage.logRecovery!.unresolvedForeignSwaps,0);
  assert.equal(decodeAdvisoryShortDemand(token,windowData,w,d.rawArtifacts,d.retrievedAt,d.requests,liveAt,[...w.ids,...d.ids]).coverage.logRecovery!.unresolvedForeignSwaps,undefined);
  assert.deepEqual(s, decodeAdvisoryShortDemand(token, windowData, w, d.rawArtifacts, d.retrievedAt, d.requests, liveAt, [...w.ids, ...d.ids],true));
  // Canonical A30, all 50 metrics and the group counts are identical to the proof v15 reconstruction without the report, both over the exact plain proof-v20 window form.
  const { bundle: v20Bundle, proof: v20 } = legacyWindowBundle(bundle), rebuild = (p: unknown) => reconstructAdvisory(token, liveAt, v20Bundle.details!.baseline, v20Bundle.evidence, v20Bundle.rawArtifacts, p, v20Bundle.thesis ?? null, v20Bundle.features), facts20 = rebuild(v20);
  assert.equal(facts20.method, 'advisory-measurements-v21');
  const prior = rebuild({ ...v20, method: 'advisory-provenance-v15' });
  const withoutC16 = (metrics: typeof facts.metrics) => metrics.filter(m => m.id !== 'C16');
  assert.deepEqual([prior.method, prior.supplements, withoutC16(prior.metrics), prior.groups], ['advisory-measurements-v16', undefined, withoutC16(facts20.metrics), facts20.groups]);
  // The short-only proof v16 rebuilds the same supplement and facts v17 with the registry C16 default.
  const shortOnly = rebuild({ ...v20, method: 'advisory-provenance-v16', launchpad: undefined });
  assert.deepEqual([shortOnly.method, shortOnly.supplements, withoutC16(shortOnly.metrics), shortOnly.groups], ['advisory-measurements-v17', facts20.supplements, withoutC16(facts20.metrics), facts20.groups]);
  const valid = (change: (r: any) => void) => { const f = structuredClone(facts) as any; change(f.supplements.shortDemand); return advisoryFactsSchema.safeParse(f).success; };
  assert.equal(valid(() => {}), true);
  const cases: Array<[string, (r: any) => void]> = [
    ['denominator', r => { r.denominator = 5; }], ['satisfied count', r => { r.satisfiedWindows = 2; }], ['share', r => { r.share = '0.5'; }], ['condition without buyer', r => { r.windows[0].condition = true; }],
    ['flow arithmetic', r => { r.windows[5].flow.netQuoteAtomic = '1'; }], ['buyer outside window', r => { r.windows[5].firstObservedBuyers[0].at = r.windows[0].start; }], ['dust buyer', r => { r.windows[5].firstObservedBuyers[0].coreQuoteAtomic = '9999999'; }],
    ['null condition on complete', r => { r.windows[2].condition = null; }], ['measured sum', r => { r.measured.flow.buyQuoteAtomic = '1'; }], ['comparison', r => { r.comparison.buyerRatio = '2'; }], ['shifted window', r => { r.windows[3].start = r.windows[2].start; }],
  ];
  for (const [name, change] of cases) assert.equal(valid(change), false, name);
  const directory = mkdtempSync(join(tmpdir(), 'advisory-short-demand-')), file = join(directory, 'live.sqlite');
  try {
    const writer = new Service(file); let id = '';
    try {
      const saved = writer.analyzeLive(bundle); id = saved.id;
      const text = renderSnapshot(saved);
      const derivationHash = saved.evidence.find(e => e.id === 'advisory-derivation')!.contentHash;
      assert.notEqual(derivationHash, saved.hash);
      for (const expected of ['Supplementary one-hour demand (not A30; not counted): COMPLETE / COMPLETE_SHORT_DEMAND_SCOPE_OBSERVED.', 'baseline 2026-10-10T10:00:00.000Z to 2026-10-10T11:00:00.000Z; measured 2026-10-10T11:00:00.000Z to 2026-10-10T12:00:00.000Z in six 10-minute windows', ': 1/6 (share 0.16666666666666666667); conditions false, false, false, false, false, true.', 'Advisory measurements: ',
        'Hour basis: latest completed UTC hour at collection freeze (frozen canonical end 2026-10-10T12:00:00.000Z; report end 2026-10-10T12:00:00.000Z). Snapshot cutoff 2026-10-10T12:30:00.000Z is the later capture cutoff and does not move this hour.',
        `Source derivation proof SHA256: ${derivationHash}.`]) assert.ok(text.includes(expected), expected);
      // The measured hour ends at the frozen canonical end, not at the later cutoff hour.
      assert.ok(!text.includes('measured 2026-10-10T11:00:00.000Z to 2026-10-10T13:00:00.000Z') && !text.includes('measured 2026-10-10T12:00:00.000Z to'));
      // A missing derivation record is shown as unavailable rather than substituting any other hash.
      const unhashed = renderSnapshot({ ...saved, evidence: saved.evidence.filter(e => e.id !== 'advisory-derivation') });
      assert.ok(unhashed.includes('Source derivation proof SHA256: unavailable.') && !unhashed.includes(saved.hash));
      const claimed = structuredClone(bundle); claimed.details!.advisory!.supplements!.shortDemand.windows[5]!.firstObservedBuyers![0]!.user = b58(U2);
      const dropped = structuredClone(bundle); delete dropped.details!.advisory!.supplements;
      const downgraded = structuredClone(bundle); downgraded.rawArtifacts['advisory-derivation'] = JSON.stringify({ ...proof, method: 'advisory-provenance-v15' }); rehash(downgraded, 'advisory-derivation'); downgraded.details!.advisory = prior;
      assert.throws(() => writer.analyzeLive(claimed), /ADVISORY_PROOF_INVALID/);
      assert.throws(() => writer.analyzeLive(dropped), /ADVISORY_SUPPLEMENT_VERSION/);
      assert.throws(() => writer.analyzeLive(downgraded), /ADVISORY_PROOF_INVALID/);
    } finally { writer.close(); }
    const reader = new Service(file);
    try { assert.deepEqual(reader.replay(id), reader.show(id)); assert.equal(reader.analyzeLive(bundle).id, id); } finally { reader.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
  // An in-scope receipt gap nulls every value; a gap before the two-hour start is excluded and disclosed while canonical A30 stays missing.
  const failing = (signature: string) => (request: RpcRequest, body: any) => request.method === 'getTransaction' && request.params[1]?.encoding==='json' && request.params[0] === signature ? { jsonrpc: '2.0', id: 1, error: { code: -32009, message: 'unavailable' } } : body;
  const gap = (await live(failing(inScope[3]!.signature))).details!.advisory!, earlier = (await live(failing(old[0]!.signature))).details!.advisory!;
  const g = gap.supplements!.shortDemand, e = earlier.supplements!.shortDemand;
  assert.deepEqual([gap.metrics.find(m => m.id === 'A30')!.quality, earlier.metrics.find(m => m.id === 'A30')!.quality], ['MISSING', 'MISSING']);
  assert.deepEqual([g.status, g.reasonCode, g.satisfiedWindows, g.share, g.baseline.meaningfulBuyers, g.coverage.scopeUnresolvedTransactions.map(t => t.code)], ['INCOMPLETE', 'ADVISORY_SHORT_DEMAND_SCOPE_TRANSACTION_UNRESOLVED', null, null, null, ['RPC_REMOTE_-32009']]);
  assert.ok(g.windows.every(w => w.condition === null && w.flow === null));
  assert.deepEqual([e.status, e.coverage.outsideScopeUnresolvedTransactions, e.satisfiedWindows, e.windows.map(w => w.condition)], ['COMPLETE', 1, 1, [false, false, false, false, false, true]]);
});
