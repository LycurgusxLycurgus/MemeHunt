import test from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { Decimal } from 'decimal.js';
import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { OFFLINE_PUMP_AMM_PROGRAM as sdk, PUMP_AMM_PROGRAM_ID, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, userVolumeAccumulatorPda, poolPda } from '@pump-fun/pump-swap-sdk';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { collectAdvisoryDemandWindows, decodeAdvisoryDemandWindows, deriveA30DemandWindows, projectCompiledTransaction, archiveDemandReceipt, unpackDemandReceipt, demandArchiveSourceLimit, DEMAND_TRANSACTION_CAP, type DemandHistory, type DemandTrade } from '../src/providers/advisory-demand-windows.js';
import type { AdvisoryWindowHistory } from '../src/providers/advisory-window.js';
import { encodeSolanaAddress } from '../src/providers/solana.js';

const token = { chain: 'solana' as const, address: '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump' };
const user = new PublicKey(Buffer.alloc(32, 4)), baseVault = new PublicKey(Buffer.alloc(32, 5)), quoteVault = new PublicKey(Buffer.alloc(32, 6)), creator = new PublicKey(Buffer.alloc(32, 7));
const program = PUMP_AMM_PROGRAM_ID.toBase58(), system = '11111111111111111111111111111111';
const pool = poolPda(0, creator, new PublicKey(token.address), NATIVE_MINT).toBase58();
const addr = (n: number) => encodeSolanaAddress(Buffer.alloc(32, n)), payer = addr(11), blockhash = addr(12);
const end = '2026-10-11T23:00:00.000Z', E = Date.parse(end) / 1000, START = E - 12 * 3600, anchorSlot = 500_000;
const anchorAt = '2026-10-11T23:00:40.000Z', clock = '2026-10-11T23:05:00.000Z', cutoff = '2026-10-11T23:10:00.000Z';
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const at = (hour: number, second = 60) => START + hour * 3600 + second;
const sig = (id: number) => { const bytes = Buffer.alloc(64, 9); bytes.writeUInt32LE(id); return encodeSolanaAddress(bytes); };
type Row = { signature: string; slot: number; blockTime: number | null; err: unknown; confirmationStatus: string; transactionIndex: number };
type RpcRequest = { method: string; params: any[] };
let serial = 0;
/** Newest-first finalized references with strictly decreasing slots, as the pool index returns them. */
const tape = (entries: Array<{ blockTime: number | null; err?: unknown }>): Row[] => entries.map((e, i) => ({ signature: sig(++serial), slot: anchorSlot - 1 - i, blockTime: e.blockTime, err: e.err ?? null, confirmationStatus: 'finalized', transactionIndex: i % 5 }));

function defaults(name: string): any {
  const type = sdk.idl.types!.find(t => t.name === name)!;
  const result: Record<string, unknown> = {};
  for (const f of (type.type as any).fields) result[f.name] = f.type === 'pubkey' ? user : f.type === 'bool' ? false : f.type === 'string' ? 'buy' : f.type === 'u8' || f.type === 'u16' ? 0 : new BN(0);
  return result;
}
/** Official compiled json form: static keys, header and numeric account indices. */
function compile(reference: Row, instructions: Array<{ programId: string; accounts: string[]; data: string }>, logs: string[], signer = payer): any {
  const keys = [signer, ...new Set(instructions.flatMap(ix => [...ix.accounts, ix.programId]).filter(k => k !== signer))];
  return { slot: reference.slot, blockTime: reference.blockTime, version: 'legacy', transaction: { signatures: [reference.signature], message: {
    header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 }, accountKeys: keys, recentBlockhash: blockhash,
    instructions: instructions.map(ix => ({ programIdIndex: keys.indexOf(ix.programId), accounts: ix.accounts.map(k => keys.indexOf(k)), data: ix.data, stackHeight: null })) } },
    meta: { err: null, fee: 5000, preBalances: [], postBalances: [], preTokenBalances: [], postTokenBalances: [], innerInstructions: [], logMessages: logs, loadedAddresses: { writable: [], readonly: [] } } };
}
const zero = (reference: Row) => compile(reference, [{ programId: system, accounts: [payer, pool], data: '' }], [`Program ${system} invoke [1]`, `Program ${system} success`]);
const v1Config = { computeUnitLimit: 276751, heapSize: null, loadedAccountsDataSizeLimit: 35000000, priorityFee: 552 };
/** Observed RPC version-1 json layout: static keys only, a transactionConfig object, no lookup field and empty loaded addresses. */
const v1 = (tx: any) => ({ ...tx, version: 1, transaction: { ...tx.transaction, message: { ...tx.transaction.message, transactionConfig: { ...v1Config } } }, meta: { ...tx.meta, loadedAddresses: { readonly: [], writable: [] } } });
const eventAuthority = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP_AMM_PROGRAM_ID)[0].toBase58();
const discriminators = { buy_v2: [184, 23, 238, 97, 103, 197, 211, 61], sell_v2: [93, 246, 130, 60, 231, 233, 64, 178] };
/** Current fee-exclusive v2 swap with the same accounting identities as the window decoder tests. */
function swapTx(reference: Row, method: 'buy_v2' | 'sell_v2', core: bigint): any {
  const sell = method === 'sell_v2', lp = 2n, protocolFee = 3n, creatorFee = 2n, fees = lp + protocolFee + creatorFee, gross = sell ? core : core + fees, userQuote = sell ? core - fees : gross;
  const name = sell ? 'sellEvent' : 'buyEvent', big = (v: bigint | number) => new BN(v.toString());
  const event = { ...defaults(name), timestamp: big(reference.blockTime!), pool: new PublicKey(pool), user, userBaseTokenAccount: baseVault, userQuoteTokenAccount: quoteVault, poolBaseTokenReserves: big(100000), poolQuoteTokenReserves: big(1000000), baseAmountOut: big(500), baseAmountIn: big(500),
    ixName: method, lpFee: big(lp), protocolFee: big(protocolFee), coinCreatorFee: big(creatorFee), buybackFee: big(protocolFee / 2n), cashback: big(0),
    quoteAmountIn: big(core), userQuoteAmountIn: big(userQuote), quoteAmountInWithLpFee: big(core + lp), quoteAmountOut: big(core), userQuoteAmountOut: big(userQuote), quoteAmountOutWithoutLpFee: big(core - lp),
    maxQuoteAmountIn: big(gross), minBaseAmountOut: big(500), minQuoteAmountOut: big(userQuote) };
  const payload = Buffer.concat([Buffer.from(sdk.idl.events!.find(e => e.name === name)!.discriminator), sdk.coder.types.encode(name, event), Buffer.alloc(24)]).toString('base64');
  const data = Buffer.alloc(24); Buffer.from(discriminators[method]).copy(data); data.writeBigUInt64LE(500n, 8); data.writeBigUInt64LE(sell ? userQuote : gross, 16);
  const accounts = [pool, user.toBase58(), GLOBAL_CONFIG_PDA.toBase58(), token.address, NATIVE_MINT.toBase58(), baseVault.toBase58(), quoteVault.toBase58(), baseVault.toBase58(), quoteVault.toBase58(), TOKEN_PROGRAM_ID.toBase58(), TOKEN_PROGRAM_ID.toBase58(), system, userVolumeAccumulatorPda(user).toBase58(), PUMP_AMM_FEE_CONFIG_PDA.toBase58(), user.toBase58(), eventAuthority, program];
  return compile(reference, [{ programId: program, accounts, data: encodeSolanaAddress(data) }], [`Program ${program} invoke [1]`, `Program data: ${payload}`, `Program ${program} success`], user.toBase58());
}
const poolState = (baseMint: PublicKey) => sdk.coder.accounts.encode('pool', { ...defaults('pool'), creator, baseMint, quoteMint: NATIVE_MINT, poolBaseTokenAccount: baseVault, poolQuoteTokenAccount: quoteVault });
const poolData = (await poolState(new PublicKey(token.address))).toString('base64'), foreignPoolData = (await poolState(quoteVault)).toString('base64');

function windowFixture(reused = new Map<string, unknown>(), over: Partial<AdvisoryWindowHistory> = {}) {
  const data = { method: 'pumpswap-selected-pool-window-v3', token, pool, window: { start: iso(E - 3600), end }, genesisVerified: true, anchorSlot, anchorTime: iso(E + 30), poolVerified: true, stateSlot: anchorSlot,
    coverageReachedStart: true, indexComplete: true, complete: true, sourceUniverseComplete: false, pages: [], successfulSignatures: 0, failedReferences: 0, transactions: [], trades: [],
    buyQuoteAtomic: '0', sellQuoteAtomic: '0', netQuoteAtomic: '0', foreignSwapLegs: 0, nonSwapInvocations: 0, cpiAuthorizedAccounts: [], limitations: [], reasonCode: 'SELECTED_POOL_WINDOW_FLOW_OBSERVED', ...over } as unknown as AdvisoryWindowHistory;
  const rawArtifacts: Record<string, string> = { 'window-anchor-time': JSON.stringify({ jsonrpc: '2.0', id: 1, result: E + 30 }) }, retrievedAt: Record<string, string> = { 'window-anchor-time': anchorAt };
  const requests: Record<string, { method: string; params: unknown[] }> = { 'window-anchor-time': { method: 'getBlockTime', params: [anchorSlot] } };
  [...reused].forEach(([signature, value], i) => { const id = `window-transaction-${i}`; requests[id] = { method: 'getTransaction', params: [signature, { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }] }; rawArtifacts[id] = JSON.stringify({ jsonrpc: '2.0', id: 1, result: value }); retrievedAt[id] = '2026-10-11T23:01:00.000Z'; });
  return { data, rawArtifacts, retrievedAt, requests };
}
async function run(pages: Row[][], transactions = new Map<string, unknown>(), options: { reused?: Map<string, unknown>; over?: Partial<AdvisoryWindowHistory>; mutate?: (request: RpcRequest, body: any) => any } = {}) {
  const calls: RpcRequest[] = [], bodies = new Map<string, string>();
  const fetcher: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as RpcRequest; calls.push(request);
    let result: unknown;
    if (request.method === 'getSignaturesForAddress') { const before = request.params[1].before; const page = before ? pages.findIndex(p => p.at(-1)?.signature === before) + 1 : 0; result = structuredClone(pages[page] ?? []); }
    else if (request.method === 'getTransaction') { const reference = pages.flat().find(r => r.signature === request.params[0])!; result = transactions.has(reference.signature) ? structuredClone(transactions.get(reference.signature)) : zero(reference); }
    else if (request.method === 'getAccountInfo') result = { context: { slot: anchorSlot + 5 }, value: { owner: program, executable: false, lamports: 1, data: [poolData, 'base64'] } };
    else throw new Error(`Unexpected request ${request.method}`);
    const body = { jsonrpc: '2.0', id: 1, result };
    const text = JSON.stringify(options.mutate ? options.mutate(request, body) : body);
    bodies.set(JSON.stringify({ method: request.method, params: request.params }), text);
    return new Response(text);
  };
  const window = windowFixture(options.reused, options.over);
  const collected = await collectAdvisoryDemandWindows(token, window, 'https://rpc.example', fetcher, () => clock);
  const decode = () => decodeAdvisoryDemandWindows(token, window.data, window, collected.rawArtifacts, collected.retrievedAt, collected.requests, cutoff);
  return { calls, bodies, window, collected, decode };
}
function assertUnresolved(history: DemandHistory, code: RegExp) {
  const metric = deriveA30DemandWindows(history, [])!, data = metric.data as any;
  assert.equal(history.complete, false); assert.equal(metric.quality, 'MISSING'); assert.match(metric.reasonCode, code);
  assert.equal(data.satisfiedWindows, null); assert.equal(data.share, null); assert.equal(data.windows.length, 6);
  assert.ok(data.windows.every((w: any) => w.condition === null && w.newMeaningfulBuyers === null));
}

test('complete 12h compiled-json tape with exact O28 jsonParsed reuse certifies baseline-excluded first-observed buyers', async () => {
  // The only baseline activity is a sell, so the hour-8 meaningful buy is first observed there.
  const rows = tape([{ blockTime: at(11, 100) }, { blockTime: at(8, 200) }, { blockTime: at(8, 100), err: { InstructionError: [0, { Custom: 1 }] } }, { blockTime: at(2, 50) }, { blockTime: at(0, 10) }, { blockTime: START - 10 }]);
  const x = await run([rows], new Map([[rows[1]!.signature, v1(swapTx(rows[1]!, 'buy_v2', 30_000_000n))], [rows[3]!.signature, swapTx(rows[3]!, 'sell_v2', 5_000_000n)]]), { reused: new Map([[rows[0]!.signature, projectCompiledTransaction(zero(rows[0]!))]]) });
  const history = x.decode(), metric = deriveA30DemandWindows(history, ['receipt'])!, data = metric.data as any;
  assert.equal(history.complete, true); assert.equal(metric.quality, 'KNOWN'); assert.equal(metric.reasonCode, 'COMPLETE_POOL_BASELINE_DEMAND_OBSERVED');
  assert.deepEqual(x.calls.filter(c => c.method === 'getTransaction').map(c => c.params[1].encoding), ['json', 'json', 'json']);
  assert.deepEqual([data.reusedTransactions, data.freshTransactions, data.failedReferences], [1, 3, 1]);
  assert.ok(history.transactions.every(t => t.status === 'OBSERVED' && t.logRecovery?.truncated === false));
  assert.deepEqual([data.logRecovery.truncatedTransactions, data.logRecovery.unresolvedNonFlowInvocations], [0, 0]);
  // Stored receipts are archives whose unpacked bytes equal the exact RPC bodies; the reused O28 receipt stays plain.
  for (const [key, stored] of Object.entries(x.collected.rawArtifacts)) { assert.equal(JSON.parse(stored).method, 'advisory-demand-rpc-archive-v1'); assert.equal(unpackDemandReceipt(stored, demandArchiveSourceLimit(key)), x.bodies.get(JSON.stringify(x.collected.requests[key]))); }
  assert.equal(JSON.parse(x.window.rawArtifacts['window-transaction-0']!).jsonrpc, '2.0');
  assert.deepEqual([data.storage.receipts, data.storage.adapterVersion, data.storage.storedAggregateCapBytes], [5, 'demand-archive-v1', 24_000_000]);
  assert.deepEqual(data.windows.map((w: any) => w.condition), [false, false, true, false, false, false]);
  const buyer = data.windows[2].newMeaningfulBuyers[0];
  assert.deepEqual([buyer.user, buyer.coreQuoteAtomic, buyer.baselineSell, buyer.baselineSubThresholdBuy], [user.toBase58(), '30000000', true, false]);
  assert.equal(data.baseline.hours[2].sellQuoteAtomic, '5000000'); assert.equal(data.baseline.meaningfulBuyers, 0);
  assert.deepEqual([data.satisfiedWindows, data.share, data.sourceUniverseComplete, data.newCapital], [1, new Decimal(1).div(6).toFixed(), false, null]);
  // A meaningful baseline buy excludes the same account from every current window.
  const repeat = tape([{ blockTime: at(10, 10) }, { blockTime: at(1, 10) }, { blockTime: START - 1 }]);
  const y = await run([repeat], new Map([[repeat[0]!.signature, swapTx(repeat[0]!, 'buy_v2', 30_000_000n)], [repeat[1]!.signature, swapTx(repeat[1]!, 'buy_v2', 20_000_000n)]]));
  const excluded = deriveA30DemandWindows(y.decode(), [])!.data as any;
  assert.deepEqual(excluded.windows.map((w: any) => w.condition), Array(6).fill(false));
  assert.deepEqual([excluded.satisfiedWindows, excluded.share, excluded.baseline.meaningfulBuyers], [0, '0', 1]);
});

function synthetic(rows: Array<[number, string, 'BUY' | 'SELL', string]>, programs: string[], complete: boolean): DemandHistory {
  const trades: DemandTrade[] = rows.map(([hour, owner, side, quote], i) => ({ signature: sig(50_000 + i), slot: 1_000 + i, at: iso(at(hour, i + 1)), user: owner, side, baseAtomic: '1', quoteAtomic: quote, poolBaseReservesAtomic: '1', poolQuoteReservesAtomic: '1', instructionIndex: 0, transactionIndex: 0 }));
  return { method: 'complete-pool-baseline-demand-windows-v1', eligible: true, token, pool, range: { start: iso(START), baselineEnd: iso(START + 6 * 3600), end }, anchorSlot, poolVerified: true, stateSlot: anchorSlot, pages: [], indexReached: true, indexComplete: true,
    successfulReferences: trades.length, failedReferences: 0, freshTransactions: trades.length, reusedTransactions: 0, transactionCap: DEMAND_TRANSACTION_CAP, capExceeded: false, transactions: [],
    hours: Array.from({ length: 12 }, (_, h) => ({ start: iso(START + h * 3600), end: iso(START + (h + 1) * 3600), successfulReferences: 0, failedReferences: 0, complete: complete || h !== 4 })),
    trades, programAccounts: programs, storage: { archiveMethod: 'advisory-demand-rpc-archive-v1', adapterVersion: 'demand-archive-v1', receipts: 0, storedBytes: 0, sourceBytes: 0 }, complete, reasonCode: complete ? 'COMPLETE_POOL_BASELINE_DEMAND_OBSERVED' : 'ADVISORY_DEMAND_TRANSACTION_MISSING' };
}

test('first-observed meaningful buyers count once, exclude program users and dust, and require nonnegative flow', () => {
  const [U, V, P, W, X] = [41, 42, 43, 44, 45].map(addr) as [string, string, string, string, string];
  const rows: Array<[number, string, 'BUY' | 'SELL', string]> = [[3, V, 'BUY', '1000000'], [6, P, 'BUY', '50000000'], [7, U, 'BUY', '20000000'], [9, U, 'BUY', '20000000'], [10, V, 'BUY', '20000000'], [11, W, 'BUY', '20000000'], [11, X, 'SELL', '30000000']];
  const metric = deriveA30DemandWindows(synthetic(rows, [P], true), ['receipt'])!, data = metric.data as any;
  assert.equal(metric.quality, 'KNOWN'); assert.deepEqual(metric.evidenceIds, ['receipt']);
  assert.deepEqual(data.windows.map((w: any) => w.condition), [false, true, false, false, true, false]);
  assert.deepEqual(data.windows.map((w: any) => w.newMeaningfulBuyers.map((b: any) => b.user)), [[], [U], [], [], [V], [W]]);
  assert.deepEqual([data.windows[0].programAccountTrades, data.windows[0].programAccountQuoteAtomic, data.windows[0].netQuoteAtomic], [1, '50000000', '50000000']);
  assert.deepEqual([data.windows[2].decodedTrades, data.windows[2].netQuoteAtomic], [0, '0']);
  assert.equal(data.windows[4].newMeaningfulBuyers[0].baselineSubThresholdBuy, true); assert.equal(data.windows[5].netQuoteAtomic, '-10000000');
  assert.deepEqual([data.denominator, data.satisfiedWindows, data.share, data.baseline.meaningfulBuyers], [6, 2, new Decimal(2).div(6).toFixed(), 0]);
  const recovered = synthetic(rows, [P], true);
  recovered.transactions = [{ signature: sig(60_000), slot: 1, at: iso(at(7)), receipt: 'DEMAND', status: 'OBSERVED', trades: 0, logRecovery: { truncated: true, unresolvedInvocations: 2, emptyForeignSweeps: 1 } },
    { signature: sig(60_001), slot: 2, at: iso(at(8)), receipt: 'WINDOW', status: 'OBSERVED', trades: 1, logRecovery: { truncated: false, unresolvedInvocations: 0, emptyForeignSweeps: 0 } }];
  const disclosed = (deriveA30DemandWindows(recovered, [])!.data as any).logRecovery;
  assert.deepEqual([disclosed.truncatedTransactions, disclosed.unresolvedNonFlowInvocations, disclosed.emptyForeignSweeps], [1, 2, 1]);
  const partial = deriveA30DemandWindows(synthetic(rows, [P], false), [])!, missing = partial.data as any;
  assert.equal(partial.quality, 'MISSING'); assert.deepEqual([missing.satisfiedWindows, missing.share, missing.baseline.meaningfulBuyers], [null, null, null]);
  assert.equal(missing.windows.length, 6); assert.ok(missing.windows.every((w: any) => w.condition === null && w.newMeaningfulBuyerCount === null));
  assert.equal(missing.windows[0].buyQuoteAtomic, '50000000'); assert.equal(missing.baseline.hours[4].coverage, 'INCOMPLETE');
});

test('index, clock, cap, transaction and unsupported-proof gaps leave every A30 condition null', async () => {
  const older = { blockTime: START - 5 };
  const flood = tape(Array.from({ length: 2000 }, (_, i) => ({ blockTime: E - 1 - i })));
  const capped = tape([...Array.from({ length: DEMAND_TRANSACTION_CAP + 1 }, (_, i) => ({ blockTime: E - 1 - i })), older]);
  const gap = tape([{ blockTime: at(11) }, { blockTime: null }, older]), dup = tape([{ blockTime: at(11) }, older]);
  const plain = () => tape([{ blockTime: at(9) }, older]);
  const rpc = plain(), version = plain(), absent = plain(), unsupported = plain(), foreign = plain();
  const unsupportedTx = swapTx(unsupported[0]!, 'buy_v2', 20_000_000n); unsupportedTx.transaction.message.instructions[0].data = encodeSolanaAddress(Buffer.alloc(24, 1));
  const cases: Array<[string, Row[][], Map<string, unknown>, ((r: RpcRequest, b: any) => any) | undefined, RegExp, boolean]> = [
    ['page cap', [flood.slice(0, 1000), flood.slice(1000)], new Map(), undefined, /ADVISORY_DEMAND_PAGE_CAP/, false],
    ['null clock', [gap], new Map(), undefined, /ADVISORY_DEMAND_NULL_CLOCK/, false],
    ['duplicate cursor row', [[dup[0]!, dup[0]!, dup[1]!]], new Map(), undefined, /ADVISORY_DEMAND_PAGE_ORDER/, false],
    ['transaction cap', [capped], new Map(), undefined, /ADVISORY_DEMAND_TRANSACTION_CAP/, false],
    ['transaction rpc failure', [rpc], new Map(), (r, b) => r.method === 'getTransaction' ? { jsonrpc: '2.0', id: 1, error: { code: -32009, message: 'unavailable' } } : b, /RPC_REMOTE_-32009/, true],
    ['future version 2', [version], new Map([[version[0]!.signature, { ...zero(version[0]!), version: 2 }]]), undefined, /ADVISORY_DEMAND_JSON_VERSION/, true],
    ['missing transaction', [absent], new Map([[absent[0]!.signature, null]]), undefined, /ADVISORY_DEMAND_TRANSACTION_MISSING/, true],
    ['unsupported pool instruction', [unsupported], new Map([[unsupported[0]!.signature, unsupportedTx]]), undefined, /ADVISORY_TRADE_UNSUPPORTED_INSTRUCTION/, true],
    ['foreign pool state', [foreign], new Map(), (r, b) => r.method === 'getAccountInfo' ? { ...b, result: { ...b.result, value: { ...b.result.value, data: [foreignPoolData, 'base64'] } } } : b, /ADVISORY_DEMAND_POOL_BINDING/, true],
  ];
  for (const [name, pages, transactions, mutate, code, fetched] of cases) {
    const x = await run(pages, transactions, { mutate });
    assertUnresolved(x.decode(), code);
    assert.equal(x.calls.some(c => c.method === 'getTransaction'), fetched, name);
  }
});

test('compiled json projection validates header, signers, lookups, indices and versions before the pinned decoder', () => {
  const [programKey, table, a, b, c] = [22, 23, 24, 25, 26].map(addr) as [string, string, string, string, string];
  const base = (): any => ({ slot: 1, blockTime: 2, version: 0, transaction: { signatures: [sig(900_000)], message: { header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 }, accountKeys: [payer, programKey], recentBlockhash: blockhash,
    instructions: [{ programIdIndex: 1, accounts: [0, 2, 3, 4], data: '3Bxs', stackHeight: null }], addressTableLookups: [{ accountKey: table, writableIndexes: [3], readonlyIndexes: [4, 5] }] } },
    meta: { err: null, innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 3, accounts: [2], data: '', stackHeight: 2 }] }], logMessages: [], loadedAddresses: { writable: [a], readonly: [b, c] } } });
  const projected = projectCompiledTransaction(base());
  assert.deepEqual(projected.transaction.message.accountKeys, [
    { pubkey: payer, signer: true, writable: true, source: 'transaction' }, { pubkey: programKey, signer: false, writable: false, source: 'transaction' },
    { pubkey: a, signer: false, writable: true, source: 'lookupTable' }, { pubkey: b, signer: false, writable: false, source: 'lookupTable' }, { pubkey: c, signer: false, writable: false, source: 'lookupTable' }]);
  assert.deepEqual(projected.transaction.message.instructions[0], { programId: programKey, accounts: [payer, a, b, c], data: '3Bxs', stackHeight: null });
  assert.deepEqual(projected.meta.innerInstructions[0].instructions[0], { programId: b, accounts: [a], data: '', stackHeight: 2 });
  const legacy = base(); legacy.version = 'legacy'; delete legacy.transaction.message.addressTableLookups; legacy.meta.loadedAddresses = { writable: [], readonly: [] }; legacy.transaction.message.instructions[0].accounts = [0]; legacy.meta.innerInstructions = [];
  assert.equal(projectCompiledTransaction(legacy).transaction.message.accountKeys.length, 2);
  // Representative of the retained RPC version-1 json receipt: static keys, top-level stackHeight 1, config object, no lookup field.
  const v1Base = (): any => { const value = base(); value.version = 1; delete value.transaction.message.addressTableLookups; value.transaction.message.transactionConfig = { ...v1Config }; value.meta.loadedAddresses = { readonly: [], writable: [] }; value.transaction.message.instructions[0] = { accounts: [0], data: '3Bxs', programIdIndex: 1, stackHeight: 1 }; value.meta.innerInstructions = []; return value; };
  assert.deepEqual(projectCompiledTransaction(v1Base()).transaction.message, { accountKeys: [{ pubkey: payer, signer: true, writable: true, source: 'transaction' }, { pubkey: programKey, signer: false, writable: false, source: 'transaction' }],
    instructions: [{ programId: programKey, accounts: [payer], data: '3Bxs', stackHeight: 1 }], recentBlockhash: blockhash });
  const nullLoaded = v1Base(); nullLoaded.meta.loadedAddresses = null; assert.equal(projectCompiledTransaction(nullLoaded).version, 1);
  const v1Rejects: Array<[string, (v: any) => void, string]> = [
    ['v1 lookup field', v => { v.transaction.message.addressTableLookups = []; }, 'ADVISORY_DEMAND_JSON_V1_LAYOUT'],
    ['v1 loaded addresses', v => { v.meta.loadedAddresses.writable = [a]; }, 'ADVISORY_DEMAND_JSON_V1_LAYOUT'],
    ['v1 missing config', v => { delete v.transaction.message.transactionConfig; }, 'ADVISORY_DEMAND_JSON_V1_LAYOUT'],
    ['v1 config field', v => { v.transaction.message.transactionConfig.extra = 1; }, 'ADVISORY_DEMAND_JSON_V1_LAYOUT'],
    ['v1 config value', v => { v.transaction.message.transactionConfig.priorityFee = -1; }, 'ADVISORY_DEMAND_JSON_V1_LAYOUT'],
    ['v1 unknown message field', v => { v.transaction.message.extra = 1; }, 'ADVISORY_DEMAND_JSON_SHAPE'],
    ['v1 account index bound', v => { v.transaction.message.instructions[0].accounts = [2]; }, 'ADVISORY_DEMAND_JSON_INSTRUCTION'],
    ['v1 key limit', v => { v.transaction.message.accountKeys = Array.from({ length: 257 }, (_, i) => { const bytes = Buffer.alloc(32, 1); bytes.writeUInt16LE(i + 1, 30); return encodeSolanaAddress(bytes); }); }, 'ADVISORY_DEMAND_JSON_ADDRESS'],
  ];
  for (const [name, mutate, code] of v1Rejects) { const value = v1Base(); mutate(value); assert.throws(() => projectCompiledTransaction(value), new RegExp(code), name); }
  const rejects: Array<[string, (v: any) => void, string]> = [
    ['account index bound', v => { v.transaction.message.instructions[0].accounts = [0, 9]; }, 'ADVISORY_DEMAND_JSON_INSTRUCTION'],
    ['top-level program from lookup', v => { v.transaction.message.instructions[0].programIdIndex = 2; }, 'ADVISORY_DEMAND_JSON_INSTRUCTION'],
    ['readonly-signed header', v => { v.transaction.message.header.numReadonlySignedAccounts = 1; }, 'ADVISORY_DEMAND_JSON_HEADER'],
    ['signature count', v => { v.transaction.signatures.push(sig(900_001)); }, 'ADVISORY_DEMAND_JSON_HEADER'],
    ['loaded count', v => { v.meta.loadedAddresses.readonly = [b]; }, 'ADVISORY_DEMAND_JSON_LOOKUP'],
    ['lookup index range', v => { v.transaction.message.addressTableLookups[0].writableIndexes = [256]; }, 'ADVISORY_DEMAND_JSON_LOOKUP'],
    ['legacy lookup', v => { v.version = 'legacy'; }, 'ADVISORY_DEMAND_JSON_LOOKUP'],
    ['noncanonical address', v => { v.transaction.message.accountKeys[0] = `1${payer}`; }, 'ADVISORY_DEMAND_JSON_ADDRESS'],
    ['duplicate loaded key', v => { v.meta.loadedAddresses.writable = [payer]; }, 'ADVISORY_DEMAND_JSON_ADDRESS'],
    ['inner depth', v => { v.meta.innerInstructions[0].instructions[0].stackHeight = 1; }, 'ADVISORY_DEMAND_JSON_INSTRUCTION'],
    ['unknown message field', v => { v.transaction.message.extra = 1; }, 'ADVISORY_DEMAND_JSON_SHAPE'],
    ['instruction data alphabet', v => { v.transaction.message.instructions[0].data = '0OIl'; }, 'ADVISORY_DEMAND_JSON_INSTRUCTION'],
    ['future version 2', v => { v.version = 2; }, 'ADVISORY_DEMAND_JSON_VERSION'],
    ['v0 relabelled as v1 with lookups', v => { v.version = 1; v.transaction.message.transactionConfig = { ...v1Config }; }, 'ADVISORY_DEMAND_JSON_V1_LAYOUT'],
  ];
  for (const [name, mutate, code] of rejects) { const value = base(); mutate(value); assert.throws(() => projectCompiledTransaction(value), new RegExp(code), name); }
  assert.throws(() => projectCompiledTransaction(null), /ADVISORY_DEMAND_TRANSACTION_MISSING/);
});

test('demand archives recover exact source bytes and reject malformed, tampered or oversized containers', () => {
  const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
  const raw = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { memo: 'Ω ✓ 🚀 \u2028', log: 'line1\nline2' } }) + '\n\t ';
  const archive = archiveDemandReceipt(raw), container = JSON.parse(archive);
  assert.equal(archiveDemandReceipt(raw), archive); assert.equal(sha(archiveDemandReceipt(raw)), sha(archive));
  assert.deepEqual(Object.keys(container), ['method', 'encoding', 'sourceBytes', 'sourceHash', 'data']);
  assert.deepEqual([container.method, container.encoding, container.sourceBytes, container.sourceHash], ['advisory-demand-rpc-archive-v1', 'DEFLATE_RAW_BASE64', Buffer.byteLength(raw), sha(raw)]);
  assert.equal(unpackDemandReceipt(archive, 500_000), raw);
  // Unpacking is single-level: an archived archive yields the inner container text, which the RPC reader then rejects.
  assert.equal(unpackDemandReceipt(archiveDemandReceipt(archive), 500_000), archive);
  assert.deepEqual(['demand-page-1', 'demand-transaction-479', 'demand-pool'].map(demandArchiveSourceLimit), [6_000_000, 1_500_000, 1_500_000]);
  assert.throws(() => demandArchiveSourceLimit('demand-page-2'), /ADVISORY_DEMAND_RECEIPT_MEMBERSHIP/);
  const pack = (bytes: Buffer) => JSON.stringify({ method: 'advisory-demand-rpc-archive-v1', encoding: 'DEFLATE_RAW_BASE64', sourceBytes: bytes.length, sourceHash: sha(bytes), data: deflateRawSync(bytes).toString('base64') });
  const small = JSON.parse(pack(Buffer.from('{}'))), bomb = deflateRawSync(Buffer.alloc(8_000_000, 32)).toString('base64');
  const rejects: Array<[string, string, number]> = [
    ['plain rpc body', raw, 500_000],
    ['extra key', JSON.stringify({ ...container, extra: 1 }), 500_000],
    ['missing key', JSON.stringify({ ...container, sourceHash: undefined }), 500_000],
    ['method', JSON.stringify({ ...container, method: 'advisory-demand-rpc-archive-v2' }), 500_000],
    ['encoding', JSON.stringify({ ...container, encoding: 'GZIP_BASE64' }), 500_000],
    ['whitespace json', JSON.stringify(container, null, 1), 500_000],
    ['key order', JSON.stringify({ data: container.data, ...container }), 500_000],
    ['noncanonical base64', JSON.stringify({ ...container, data: `${container.data}\n` }), 500_000],
    ['source hash', JSON.stringify({ ...container, sourceHash: sha('other') }), 500_000],
    ['short claimed size', JSON.stringify({ ...container, sourceBytes: container.sourceBytes - 1 }), 500_000],
    ['long claimed size', JSON.stringify({ ...container, sourceBytes: container.sourceBytes + 1 }), 500_000],
    ['string claimed size', JSON.stringify({ ...container, sourceBytes: String(container.sourceBytes) }), 500_000],
    ['trailing compressed bytes', JSON.stringify({ ...container, data: Buffer.concat([Buffer.from(container.data, 'base64'), Buffer.from([1, 2, 3])]).toString('base64') }), 500_000],
    ['invalid utf8', pack(Buffer.from([0x7b, 0xff, 0x7d])), 500_000],
    ['claimed size beyond ceiling before inflate', pack(Buffer.alloc(500_001, 32)), 500_000],
    ['bomb beyond page ceiling', pack(Buffer.alloc(8_000_000, 32)), demandArchiveSourceLimit('demand-page-0')],
    ['bomb under a small claim', JSON.stringify({ ...small, sourceBytes: 1000, data: bomb }), 500_000],
    ['empty data', JSON.stringify({ ...container, data: '' }), 500_000],
  ];
  for (const [name, value, limit] of rejects) assert.throws(() => unpackDemandReceipt(value, limit), /ADVISORY_DEMAND_ARCHIVE_INVALID/, name);
});

test('demand receipts bind exact membership, request, clock, eligibility and O28 reuse', async () => {
  const rows = tape([{ blockTime: at(11, 10) }, { blockTime: at(5, 10) }, { blockTime: START - 3 }]);
  const x = await run([rows], new Map(), { reused: new Map([[rows[0]!.signature, projectCompiledTransaction(zero(rows[0]!))]]) }), c = x.collected;
  assert.equal(x.decode().complete, true); assert.deepEqual(Object.keys(c.requests).sort(), ['demand-page-0', 'demand-pool', 'demand-transaction-0']);
  const decode = (raw = c.rawArtifacts, times = c.retrievedAt, requests = c.requests, window = x.window) => decodeAdvisoryDemandWindows(token, window.data, window, raw, times, requests, cutoff);
  assert.throws(() => decode({ ...c.rawArtifacts, 'demand-extra': '{}' }, { ...c.retrievedAt, 'demand-extra': clock }, { ...c.requests, 'demand-extra': { method: 'getSlot', params: [] } }), /ADVISORY_DEMAND_RECEIPT_MEMBERSHIP/);
  const { 'demand-pool': _pool, ...withoutPoolTime } = c.retrievedAt;
  assert.throws(() => decode(c.rawArtifacts, withoutPoolTime), /ADVISORY_DEMAND_RECEIPT_MEMBERSHIP/);
  // A future index clock invalidates the tape, so retained transaction receipts no longer belong to any plan.
  assert.throws(() => decode(c.rawArtifacts, { ...c.retrievedAt, 'demand-page-0': '2026-10-11T23:11:00.000Z' }), /ADVISORY_DEMAND_RECEIPT_MEMBERSHIP/);
  const parsed = structuredClone(c.requests); (parsed['demand-transaction-0']!.params[1] as { encoding: string }).encoding = 'jsonParsed';
  assertUnresolved(decode(c.rawArtifacts, c.retrievedAt, parsed), /ADVISORY_DEMAND_REQUEST/);
  assertUnresolved(decode(c.rawArtifacts, { ...c.retrievedAt, 'demand-transaction-0': '2026-10-11T22:59:30.000Z' }), /ADVISORY_DEMAND_TRANSACTION_BINDING/);
  const altered = structuredClone(x.window); (altered.requests['window-transaction-0']!.params[1] as { maxSupportedTransactionVersion: number }).maxSupportedTransactionVersion = 0;
  assertUnresolved(decode(c.rawArtifacts, c.retrievedAt, c.requests, altered), /ADVISORY_DEMAND_REQUEST/);
  const ineligible = { ...x.window, data: { ...x.window.data, complete: false } };
  assert.throws(() => decode(c.rawArtifacts, c.retrievedAt, c.requests, ineligible), /ADVISORY_DEMAND_RECEIPT_MEMBERSHIP/);
  assert.equal(deriveA30DemandWindows(decode({}, {}, {}, ineligible), []), null);
  assert.equal((await run([rows], new Map(), { over: { complete: false } })).calls.length, 0);
  assert.throws(() => decodeAdvisoryDemandWindows({ chain: 'solana', address: pool }, x.window.data, x.window, c.rawArtifacts, c.retrievedAt, c.requests, cutoff), /ADVISORY_DEMAND_SCOPE/);
});
