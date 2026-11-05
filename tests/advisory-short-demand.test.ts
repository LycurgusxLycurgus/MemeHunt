import test from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { Decimal } from 'decimal.js';
import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { OFFLINE_PUMP_AMM_PROGRAM as sdk, PUMP_AMM_PROGRAM_ID, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, userVolumeAccumulatorPda, poolPda } from '@pump-fun/pump-swap-sdk';
import { collectAdvisoryDemandWindows, decodeAdvisoryDemandWindows, deriveA30DemandWindows, DEMAND_METHOD, DEMAND_TRANSACTION_CAP, type DemandHistory, type DemandTrade } from '../src/providers/advisory-demand-windows.js';
import { decodeAdvisoryShortDemand, deriveShortDemandReport, SHORT_DEMAND_METHOD, type ShortDemandReport } from '../src/providers/advisory-short-demand.js';
import type { AdvisoryWindowHistory } from '../src/providers/advisory-window.js';
import { shortDemandReportSchema } from '../src/domain/advisory-contracts.js';
import { encodeSolanaAddress } from '../src/providers/solana.js';

// Fixtures mirror tests/advisory-demand-windows.test.ts (test files are not shared modules); swaps take an explicit user so first-observed buyers can differ.
const token = { chain: 'solana' as const, address: '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump' };
const user = new PublicKey(Buffer.alloc(32, 4)), baseVault = new PublicKey(Buffer.alloc(32, 5)), quoteVault = new PublicKey(Buffer.alloc(32, 6)), creator = new PublicKey(Buffer.alloc(32, 7));
const program = PUMP_AMM_PROGRAM_ID.toBase58(), system = '11111111111111111111111111111111';
const pool = poolPda(0, creator, new PublicKey(token.address), NATIVE_MINT).toBase58();
const addr = (n: number) => encodeSolanaAddress(Buffer.alloc(32, n)), payer = addr(11), blockhash = addr(12), owner = (n: number) => new PublicKey(Buffer.alloc(32, n));
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
function compile(reference: Row, instructions: Array<{ programId: string; accounts: string[]; data: string }>, logs: string[], signer = payer): any {
  const keys = [signer, ...new Set(instructions.flatMap(ix => [...ix.accounts, ix.programId]).filter(k => k !== signer))];
  return { slot: reference.slot, blockTime: reference.blockTime, version: 'legacy', transaction: { signatures: [reference.signature], message: {
    header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 }, accountKeys: keys, recentBlockhash: blockhash,
    instructions: instructions.map(ix => ({ programIdIndex: keys.indexOf(ix.programId), accounts: ix.accounts.map(k => keys.indexOf(k)), data: ix.data, stackHeight: null })) } },
    meta: { err: null, fee: 5000, preBalances: [], postBalances: [], preTokenBalances: [], postTokenBalances: [], innerInstructions: [], logMessages: logs, loadedAddresses: { writable: [], readonly: [] } } };
}
const zero = (reference: Row) => compile(reference, [{ programId: system, accounts: [payer, pool], data: '' }], [`Program ${system} invoke [1]`, `Program ${system} success`]);
const eventAuthority = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP_AMM_PROGRAM_ID)[0].toBase58();
const discriminators = { buy_v2: [184, 23, 238, 97, 103, 197, 211, 61], sell_v2: [93, 246, 130, 60, 231, 233, 64, 178] };
/** Current fee-exclusive v2 swap signed by who; the event user, account 1 and its volume accumulator bind to who. */
function swapTx(reference: Row, method: 'buy_v2' | 'sell_v2', core: bigint, who = user): any {
  const sell = method === 'sell_v2', lp = 2n, protocolFee = 3n, creatorFee = 2n, fees = lp + protocolFee + creatorFee, gross = sell ? core : core + fees, userQuote = sell ? core - fees : gross;
  const name = sell ? 'sellEvent' : 'buyEvent', big = (v: bigint | number) => new BN(v.toString());
  const event = { ...defaults(name), timestamp: big(reference.blockTime!), pool: new PublicKey(pool), user: who, userBaseTokenAccount: baseVault, userQuoteTokenAccount: quoteVault, poolBaseTokenReserves: big(100000), poolQuoteTokenReserves: big(1000000), baseAmountOut: big(500), baseAmountIn: big(500),
    ixName: method, lpFee: big(lp), protocolFee: big(protocolFee), coinCreatorFee: big(creatorFee), buybackFee: big(protocolFee / 2n), cashback: big(0),
    quoteAmountIn: big(core), userQuoteAmountIn: big(userQuote), quoteAmountInWithLpFee: big(core + lp), quoteAmountOut: big(core), userQuoteAmountOut: big(userQuote), quoteAmountOutWithoutLpFee: big(core - lp),
    maxQuoteAmountIn: big(gross), minBaseAmountOut: big(500), minQuoteAmountOut: big(userQuote) };
  const payload = Buffer.concat([Buffer.from(sdk.idl.events!.find(e => e.name === name)!.discriminator), sdk.coder.types.encode(name, event), Buffer.alloc(24)]).toString('base64');
  const data = Buffer.alloc(24); Buffer.from(discriminators[method]).copy(data); data.writeBigUInt64LE(500n, 8); data.writeBigUInt64LE(sell ? userQuote : gross, 16);
  const accounts = [pool, who.toBase58(), GLOBAL_CONFIG_PDA.toBase58(), token.address, NATIVE_MINT.toBase58(), baseVault.toBase58(), quoteVault.toBase58(), baseVault.toBase58(), quoteVault.toBase58(), TOKEN_PROGRAM_ID.toBase58(), TOKEN_PROGRAM_ID.toBase58(), system, userVolumeAccumulatorPda(who).toBase58(), PUMP_AMM_FEE_CONFIG_PDA.toBase58(), user.toBase58(), eventAuthority, program];
  return compile(reference, [{ programId: program, accounts, data: encodeSolanaAddress(data) }], [`Program ${program} invoke [1]`, `Program data: ${payload}`, `Program ${program} success`], who.toBase58());
}
const poolData = (await sdk.coder.accounts.encode('pool', { ...defaults('pool'), creator, baseMint: new PublicKey(token.address), quoteMint: NATIVE_MINT, poolBaseTokenAccount: baseVault, poolQuoteTokenAccount: quoteVault })).toString('base64');

function windowFixture(over: Partial<AdvisoryWindowHistory> = {}) {
  const data = { method: 'pumpswap-selected-pool-window-v3', token, pool, window: { start: iso(E - 3600), end }, genesisVerified: true, anchorSlot, anchorTime: iso(E + 30), poolVerified: true, stateSlot: anchorSlot,
    coverageReachedStart: true, indexComplete: true, complete: true, sourceUniverseComplete: false, pages: [], successfulSignatures: 0, failedReferences: 0, transactions: [], trades: [],
    buyQuoteAtomic: '0', sellQuoteAtomic: '0', netQuoteAtomic: '0', foreignSwapLegs: 0, nonSwapInvocations: 0, cpiAuthorizedAccounts: [], limitations: [], reasonCode: 'SELECTED_POOL_WINDOW_FLOW_OBSERVED', ...over } as unknown as AdvisoryWindowHistory;
  const rawArtifacts: Record<string, string> = { 'window-anchor-time': JSON.stringify({ jsonrpc: '2.0', id: 1, result: E + 30 }) }, retrievedAt: Record<string, string> = { 'window-anchor-time': anchorAt };
  const requests: Record<string, { method: string; params: unknown[] }> = { 'window-anchor-time': { method: 'getBlockTime', params: [anchorSlot] } };
  return { data, rawArtifacts, retrievedAt, requests };
}
/** Real bounded collection through a fake RPC, then the production canonical decoder and supplementary report over the retained receipts. */
async function run(pages: Row[][], transactions = new Map<string, unknown>(), over: Partial<AdvisoryWindowHistory> = {}) {
  const calls: RpcRequest[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as RpcRequest; calls.push(request);
    let result: unknown;
    if (request.method === 'getSignaturesForAddress') { const before = request.params[1].before; const page = before ? pages.findIndex(p => p.at(-1)?.signature === before) + 1 : 0; result = structuredClone(pages[page] ?? []); }
    else if (request.method === 'getTransaction') { const reference = pages.flat().find(r => r.signature === request.params[0])!; result = transactions.has(reference.signature) ? structuredClone(transactions.get(reference.signature)) : zero(reference); }
    else if (request.method === 'getAccountInfo') result = { context: { slot: anchorSlot + 5 }, value: { owner: program, executable: false, lamports: 1, data: [poolData, 'base64'] } };
    else throw new Error(`Unexpected request ${request.method}`);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  };
  const window = windowFixture(over);
  const collected = await collectAdvisoryDemandWindows(token, window, 'https://rpc.example', fetcher, () => clock);
  const history = () => decodeAdvisoryDemandWindows(token, window.data, window, collected.rawArtifacts, collected.retrievedAt, collected.requests, cutoff);
  const short = (requests = collected.requests) => decodeAdvisoryShortDemand(token, window.data, window, collected.rawArtifacts, collected.retrievedAt, requests, cutoff, ['receipt']);
  return { calls, window, collected, history, short };
}
/** Internally consistent decoded-history shape for rules that need program accounts or a non-hour canonical end. */
function synthetic(rows: Array<[number, string, 'BUY' | 'SELL', string]>, programs: string[], rangeEnd = end): DemandHistory {
  const endS = Date.parse(rangeEnd) / 1000, startS = endS - 12 * 3600;
  const trades: DemandTrade[] = rows.map(([seconds, account, side, quote], i) => ({ signature: sig(70_000 + i), slot: 1_000 + i, at: iso(seconds), user: account, side, baseAtomic: '1', quoteAtomic: quote, poolBaseReservesAtomic: '1', poolQuoteReservesAtomic: '1', instructionIndex: 0, transactionIndex: 0 }));
  return { method: DEMAND_METHOD, eligible: true, token, pool, range: { start: iso(startS), baselineEnd: iso(startS + 6 * 3600), end: rangeEnd }, anchorSlot, poolVerified: true, stateSlot: anchorSlot,
    pages: [{ id: 'demand-page-0', returned: trades.length + 1, oldestAt: iso(startS - 10), newestAt: trades.at(-1)?.at ?? null, exhausted: true, status: 'OBSERVED' as const }], indexReached: true, indexComplete: true,
    successfulReferences: trades.length, failedReferences: 0, freshTransactions: trades.length, reusedTransactions: 0, transactionCap: DEMAND_TRANSACTION_CAP, capExceeded: false,
    transactions: trades.map(t => ({ signature: t.signature, slot: t.slot, at: t.at, receipt: 'DEMAND' as const, status: 'OBSERVED' as const, trades: 1 })),
    hours: Array.from({ length: 12 }, (_, h) => ({ start: iso(startS + h * 3600), end: iso(startS + (h + 1) * 3600), successfulReferences: 0, failedReferences: 0, complete: true })),
    trades, programAccounts: programs, storage: { archiveMethod: 'advisory-demand-rpc-archive-v1', adapterVersion: 'demand-archive-v1', receipts: 0, storedBytes: 0, sourceBytes: 0 }, complete: true, reasonCode: 'COMPLETE_POOL_BASELINE_DEMAND_OBSERVED' };
}
function assertBlocked(report: ShortDemandReport, reason: string, source?: RegExp) {
  shortDemandReportSchema.parse(report);
  assert.equal(report.status, 'INCOMPLETE'); assert.equal(report.complete, false); assert.equal(report.reasonCode, reason);
  if (source) assert.match(report.sourceReasonCode, source);
  assert.deepEqual([report.satisfiedWindows, report.share, report.denominator, report.windows.length], [null, null, 6, 6]);
  assert.ok(report.windows.every(w => w.condition === null && w.firstObservedBuyers === null && w.firstObservedBuyerCount === null && w.flow === null));
  assert.deepEqual([report.baseline.flow, report.baseline.meaningfulBuyers, report.measured.flow, report.comparison.netQuoteDeltaAtomic, report.comparison.buyerRatio], [null, null, null, null, null]);
}

test('an unresolved transaction before the two-hour start is excluded with disclosure while one at the start blocks the report', async () => {
  const [A, B] = [41, 42].map(owner) as [PublicKey, PublicKey];
  const build = (gapAt: number) => { const rows = tape([{ blockTime: at(11, 30) }, { blockTime: at(10, 100) }, { blockTime: gapAt }, { blockTime: START - 10 }]);
    return { rows, txs: new Map<string, unknown>([[rows[0]!.signature, swapTx(rows[0]!, 'buy_v2', 20_000_000n, A)], [rows[1]!.signature, swapTx(rows[1]!, 'buy_v2', 30_000_000n, B)], [rows[2]!.signature, null]]) }; };
  const outside = build(at(9, 3599)), x = await run([outside.rows], outside.txs), canonical = x.history();
  assert.equal(canonical.complete, false); assert.equal(deriveA30DemandWindows(canonical, [])!.quality, 'MISSING');
  const report = x.short();
  assert.deepEqual([report.method, report.status, report.complete, report.reasonCode, report.sourceReasonCode], [SHORT_DEMAND_METHOD, 'COMPLETE', true, 'COMPLETE_SHORT_DEMAND_SCOPE_OBSERVED', 'ADVISORY_DEMAND_TRANSACTION_MISSING']);
  assert.deepEqual([report.role, report.substitutesCanonical, report.countsTowardKnownMetrics, report.canonicalMetricId, report.canonical.complete], ['SUPPLEMENTARY', false, false, 'A30', false]);
  assert.deepEqual([report.reportEnd, report.interval.start, report.baseline.end, report.measured.start], [end, iso(E - 7200), iso(E - 3600), iso(E - 3600)]);
  assert.deepEqual(report.windows.map(w => [w.start, w.end]), Array.from({ length: 6 }, (_, k) => [iso(E - 3600 + k * 600), iso(E - 3600 + (k + 1) * 600)]));
  assert.deepEqual([report.coverage.scopeSuccessfulReferences, report.coverage.scopeObservedTransactions, report.coverage.outsideScopeUnresolvedTransactions, report.coverage.scopeReceipts], [2, 2, 1, { window: 0, demand: 2 }]);
  assert.deepEqual(report.windows.map(w => w.condition), [true, false, false, false, false, false]);
  assert.deepEqual(report.windows[0]!.firstObservedBuyers!.map(b => [b.user, b.coreQuoteAtomic]), [[A.toBase58(), '20000000']]);
  assert.deepEqual([report.satisfiedWindows, report.share, report.baseline.meaningfulBuyers], [1, new Decimal(1).div(6).toFixed(), 1]);
  assert.deepEqual(report.evidenceIds, ['receipt']); assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  const inside = build(at(10, 0)), blocked = (await run([inside.rows], inside.txs)).short();
  assertBlocked(blocked, 'ADVISORY_SHORT_DEMAND_SCOPE_TRANSACTION_UNRESOLVED', /ADVISORY_DEMAND_TRANSACTION_MISSING/);
  assert.deepEqual(blocked.coverage.scopeUnresolvedTransactions.map(t => [t.signature, t.status, t.code]), [[inside.rows[2]!.signature, 'INVALID', 'ADVISORY_DEMAND_TRANSACTION_MISSING']]);
});

test('index reach, clock, duplicate, order and cap gates block the report before any transaction read', async () => {
  const older = { blockTime: START - 5 };
  const reaches = tape(Array.from({ length: 2000 }, (_, i) => ({ blockTime: E - 1 - 5 * i }))), short = tape(Array.from({ length: 2000 }, (_, i) => ({ blockTime: E - 1 - i })));
  const capped = tape([...Array.from({ length: DEMAND_TRANSACTION_CAP + 1 }, (_, i) => ({ blockTime: E - 1 - i })), older]);
  const gap = tape([{ blockTime: at(11) }, { blockTime: null }, older]), dup = tape([{ blockTime: at(11) }, older]), swapped = tape([{ blockTime: at(11, 20) }, { blockTime: at(11, 10) }, older]);
  const cases: Array<[string, Row[][], string, RegExp, boolean]> = [
    ['index reaches the two-hour start but not the canonical start', [reaches.slice(0, 1000), reaches.slice(1000)], 'ADVISORY_SHORT_DEMAND_SCOPE_NOT_COLLECTED', /ADVISORY_DEMAND_PAGE_CAP/, true],
    ['index short of the two-hour start', [short.slice(0, 1000), short.slice(1000)], 'ADVISORY_SHORT_DEMAND_INDEX_INCOMPLETE', /ADVISORY_DEMAND_PAGE_CAP/, false],
    ['canonical transaction cap', [capped], 'ADVISORY_SHORT_DEMAND_SCOPE_NOT_COLLECTED', /ADVISORY_DEMAND_TRANSACTION_CAP/, true],
    ['missing clock', [gap], 'ADVISORY_SHORT_DEMAND_INDEX_INCOMPLETE', /ADVISORY_DEMAND_NULL_CLOCK/, false],
    ['duplicate reference', [[dup[0]!, dup[0]!, dup[1]!]], 'ADVISORY_SHORT_DEMAND_INDEX_INCOMPLETE', /ADVISORY_DEMAND_PAGE_ORDER/, false],
    ['slot order break', [[swapped[1]!, swapped[0]!, swapped[2]!]], 'ADVISORY_SHORT_DEMAND_INDEX_INCOMPLETE', /ADVISORY_DEMAND_PAGE_ORDER/, false],
  ];
  for (const [name, pages, reason, source, reached] of cases) {
    const x = await run(pages), report = x.short();
    assertBlocked(report, reason, source);
    assert.equal(report.coverage.indexReachesScopeStart, reached, name);
    assert.deepEqual([report.coverage.transactionsCollected, report.coverage.scopeSuccessfulReferences, report.coverage.outsideScopeUnresolvedTransactions], [false, null, null], name);
    assert.equal(x.calls.some(c => c.method === 'getTransaction'), false, name);
  }
});

test('fixed UTC boundaries, baseline exclusion, single counting, threshold, dust, sells and negative flow use the declared two-hour tape', async () => {
  const [A, B, C, D, F, G] = [41, 42, 43, 44, 45, 46].map(owner) as [PublicKey, PublicKey, PublicKey, PublicKey, PublicKey, PublicKey];
  const plan: Array<[number, 'buy_v2' | 'sell_v2', bigint, PublicKey]> = [
    [at(11, 3599), 'buy_v2', 10_000_000n, G], [at(11, 3000), 'sell_v2', 40_000_000n, C], [at(11, 2400), 'buy_v2', 20_000_000n, F], [at(11, 1800), 'buy_v2', 20_000_000n, A],
    [at(11, 600), 'buy_v2', 20_000_000n, A], [at(11, 599), 'buy_v2', 9_999_999n, D], [at(11, 0), 'buy_v2', 30_000_000n, B], [at(10, 3599), 'buy_v2', 15_000_000n, B],
    [at(10, 0), 'sell_v2', 5_000_000n, C], [at(9, 3599), 'buy_v2', 50_000_000n, F]];
  const rows = tape([...plan.map(([blockTime]) => ({ blockTime })), { blockTime: START - 10 }]);
  const x = await run([rows], new Map<string, unknown>(plan.map(([, method, core, who], i): [string, unknown] => [rows[i]!.signature, swapTx(rows[i]!, method, core, who)])));
  const history = x.history(), report = x.short();
  assert.equal(history.complete, true); assert.equal(report.status, 'COMPLETE'); shortDemandReportSchema.parse(report);
  assert.deepEqual(report.windows.map(w => w.condition), [false, true, false, false, true, false]);
  assert.deepEqual(report.windows.map(w => w.firstObservedBuyers!.map(b => b.user)), [[], [A.toBase58()], [], [], [F.toBase58()], [G.toBase58()]]);
  // Window 0 holds the excluded baseline repeat and the dust buy; both stay in flow.
  assert.deepEqual([report.windows[0]!.flow!.buyQuoteAtomic, report.windows[0]!.flow!.decodedTrades, report.windows[0]!.firstObservedBuyerCount], ['39999999', 2, 0]);
  assert.deepEqual([report.windows[2]!.flow!.decodedTrades, report.windows[2]!.flow!.netQuoteAtomic], [0, '0']);
  assert.deepEqual([report.windows[3]!.flow!.buyQuoteAtomic, report.windows[3]!.firstObservedBuyerCount], ['20000000', 0]);
  assert.deepEqual([report.windows[5]!.firstObservedBuyers![0]!.coreQuoteAtomic, report.windows[5]!.flow!.netQuoteAtomic], ['10000000', '-30000000']);
  assert.deepEqual([report.baseline.flow!.buyQuoteAtomic, report.baseline.flow!.sellQuoteAtomic, report.baseline.flow!.netQuoteAtomic, report.baseline.meaningfulBuyers], ['15000000', '5000000', '10000000', 1]);
  assert.deepEqual([report.satisfiedWindows, report.share], [2, new Decimal(2).div(6).toFixed()]);
  assert.deepEqual([report.comparison.buyQuoteDeltaAtomic, report.comparison.netQuoteDeltaAtomic, report.comparison.firstObservedBuyers, report.comparison.baselineMeaningfulBuyers, report.comparison.buyerRatio], ['94999999', '59999999', 3, 1, '3']);
  // Declared scope: F is first observed at hour 9 in the canonical tape but first observed in this two-hour tape at window 4.
  const a30 = deriveA30DemandWindows(history, [])!.data as any;
  assert.ok(a30.windows[3].newMeaningfulBuyers.some((b: any) => b.user === F.toBase58()));
  assert.ok(!a30.windows[5].newMeaningfulBuyers.some((b: any) => b.user === F.toBase58()));
});

test('a complete measured hour without trades is a known zero over the fixed six windows', async () => {
  const rows = tape([{ blockTime: at(11, 100) }, { blockTime: at(10, 50) }, { blockTime: START - 10 }]);
  const report = (await run([rows])).short();
  assert.deepEqual([report.status, report.complete], ['COMPLETE', true]);
  assert.deepEqual(report.windows.map(w => [w.condition, w.firstObservedBuyerCount, w.flow!.decodedTrades]), Array.from({ length: 6 }, () => [false, 0, 0]));
  assert.deepEqual([report.denominator, report.satisfiedWindows, report.share], [6, 0, '0']);
  assert.deepEqual([report.coverage.scopeSuccessfulReferences, report.coverage.scopeObservedTransactions, report.baseline.meaningfulBuyers, report.comparison.buyerRatio, report.comparison.netQuoteDeltaAtomic], [2, 2, 0, null, '0']);
});

test('program users stay out of buyer sets but in flow, and E floors a later canonical end to its completed UTC hour', () => {
  const [U, P] = [51, 52].map(addr) as [string, string];
  const rows: Array<[number, string, 'BUY' | 'SELL', string]> = [[at(10, 100), P, 'BUY', '50000000'], [at(11, 1300), P, 'BUY', '50000000'], [at(11, 1400), U, 'BUY', '20000000'], [at(11, 2000), P, 'BUY', '50000000']];
  const report = deriveShortDemandReport(synthetic(rows, [P]), ['receipt']);
  assert.deepEqual(report.windows.map(w => w.condition), [false, false, true, false, false, false]);
  assert.deepEqual(report.windows[2]!.firstObservedBuyers!.map(b => b.user), [U]);
  assert.deepEqual([report.windows[2]!.flow!.buyQuoteAtomic, report.windows[2]!.flow!.programAccountTrades, report.windows[2]!.flow!.programAccountQuoteAtomic], ['70000000', 1, '50000000']);
  assert.deepEqual([report.windows[3]!.flow!.netQuoteAtomic, report.windows[3]!.firstObservedBuyerCount], ['50000000', 0]);
  assert.deepEqual([report.baseline.meaningfulBuyers, report.baseline.flow!.programAccountTrades, report.programAccounts.accounts], [0, 1, [P]]);
  const shifted = deriveShortDemandReport(synthetic([[at(11, 1400), U, 'BUY', '20000000'], [E + 600, U, 'BUY', '20000000']], [], '2026-10-11T23:30:00.000Z'), []);
  assert.deepEqual([shifted.status, shifted.reportEnd, shifted.interval.start, shifted.windows[5]!.end], ['COMPLETE', end, iso(E - 7200), end]);
  assert.deepEqual([shifted.windows[2]!.firstObservedBuyerCount, shifted.measured.flow!.decodedTrades], [1, 1]);
});

test('scoped log recovery keeps its default shape and discloses witnessed foreign swaps only under foreign-flow recovery', () => {
  const [U, P] = [51, 52].map(addr) as [string, string];
  const rows: Array<[number, string, 'BUY' | 'SELL', string]> = [[at(10, 100), P, 'BUY', '50000000'], [at(11, 1400), U, 'BUY', '20000000']];
  const legacy = synthetic(rows, [P]);
  legacy.transactions[1]!.logRecovery = { truncated: true, unresolvedInvocations: 2, emptyForeignSweeps: 1 };
  const plain = deriveShortDemandReport(legacy, []);
  shortDemandReportSchema.parse(plain);
  assert.deepEqual(plain.coverage.logRecovery, { truncatedTransactions: 1, unresolvedNonFlowInvocations: 2, emptyForeignSweeps: 1 });
  const opted = synthetic(rows, [P]);
  opted.foreignFlowRecovery = true;
  opted.transactions[0]!.logRecovery = { truncated: false, unresolvedInvocations: 0, emptyForeignSweeps: 0, unresolvedForeignSwaps: 0 };
  opted.transactions[1]!.logRecovery = { truncated: true, unresolvedInvocations: 2, emptyForeignSweeps: 0, unresolvedForeignSwaps: 1 };
  const disclosed = deriveShortDemandReport(opted, []);
  shortDemandReportSchema.parse(disclosed);
  assert.deepEqual([disclosed.status, disclosed.coverage.logRecovery], ['COMPLETE', { truncatedTransactions: 1, unresolvedNonFlowInvocations: 1, emptyForeignSweeps: 0, unresolvedForeignSwaps: 1 }]);
  const original = 'Truncated logs pass only through the pinned decoder opt-in recovery; unresolved later invocations are disclosed as non-flow and not proven executed.';
  assert.ok(plain.limitations.includes(original)); assert.equal(disclosed.limitations.includes(original), false);
  assert.equal(disclosed.limitations.length, plain.limitations.length);
  const foreign = disclosed.limitations.find(l => /foreign-pool swaps/.test(l))!;
  assert.match(foreign, /not proven executed/); assert.match(foreign, /never counted in selected-pool flow/); assert.match(foreign, /event witness/);
});

test('reports come from genuine receipt decoding; forged flags, inconsistent trades and tampered receipts never certify the scope', async () => {
  const A = owner(41);
  const rows = tape([{ blockTime: at(11, 30) }, { blockTime: at(10, 0) }, { blockTime: START - 10 }]);
  const genuine = (await run([rows], new Map<string, unknown>([[rows[0]!.signature, swapTx(rows[0]!, 'buy_v2', 20_000_000n, A)], [rows[1]!.signature, null]]))).history();
  const forged: DemandHistory = { ...genuine, complete: true, reasonCode: 'COMPLETE_POOL_BASELINE_DEMAND_OBSERVED', hours: genuine.hours.map(h => ({ ...h, complete: true })) };
  assertBlocked(deriveShortDemandReport(forged, []), 'ADVISORY_SHORT_DEMAND_SCOPE_TRANSACTION_UNRESOLVED');
  const clean = synthetic([[at(11, 100), addr(53), 'BUY', '20000000']], []);
  assert.equal(deriveShortDemandReport(clean, []).status, 'COMPLETE');
  const inconsistent: DemandHistory[] = [
    { ...clean, trades: [...clean.trades, { ...clean.trades[0]!, signature: sig(99_999), instructionIndex: 1 }] },
    { ...clean, transactions: clean.transactions.map(t => ({ ...t, trades: 2 })) },
    { ...clean, transactions: [] },
    { ...clean, trades: clean.trades.map(t => ({ ...t, at: iso(at(11, 200)) })) },
  ];
  for (const history of inconsistent) assertBlocked(deriveShortDemandReport(history, []), 'ADVISORY_SHORT_DEMAND_HISTORY_INCONSISTENT');
  assertBlocked(deriveShortDemandReport({ ...clean, method: 'other' } as unknown as DemandHistory, []), 'ADVISORY_SHORT_DEMAND_SOURCE_METHOD');
  const fresh = tape([{ blockTime: at(11, 30) }, { blockTime: START - 10 }]), y = await run([fresh], new Map<string, unknown>([[fresh[0]!.signature, swapTx(fresh[0]!, 'buy_v2', 20_000_000n, A)]]));
  assert.equal(y.short().status, 'COMPLETE');
  const parsed = structuredClone(y.collected.requests); (parsed['demand-transaction-0']!.params[1] as { encoding: string }).encoding = 'jsonParsed';
  assertBlocked(y.short(parsed), 'ADVISORY_SHORT_DEMAND_SCOPE_TRANSACTION_UNRESOLVED', /ADVISORY_DEMAND_REQUEST/);
  assert.throws(() => decodeAdvisoryShortDemand(token, y.window.data, y.window, { ...y.collected.rawArtifacts, 'demand-extra': '{}' }, { ...y.collected.retrievedAt, 'demand-extra': clock }, { ...y.collected.requests, 'demand-extra': { method: 'getSlot', params: [] } }, cutoff), /ADVISORY_DEMAND_RECEIPT_MEMBERSHIP/);
  const z = await run([fresh], new Map(), { complete: false }), ineligible = z.short();
  assert.equal(z.calls.length, 0);
  assert.deepEqual([ineligible.status, ineligible.reasonCode, ineligible.satisfiedWindows, ineligible.share], ['NOT_ELIGIBLE', 'SELECTED_POOL_WINDOW_INCOMPLETE', null, null]);
  assert.ok(ineligible.windows.every(w => w.condition === null));
});
