import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import type { AdvisoryWindowHistory } from '../src/providers/advisory-window.js';
import type { DecodedTrade } from '../src/providers/advisory-trades.js';
import { DCA_PROGRAM, OFFICIAL_AUTOMATION_SOURCES, bindFlashFills, collectAdvisoryAutomation, deriveO30Window, flashFillAbi, type AutomationReceipts } from '../src/providers/advisory-automation.js';
import { encodeSolanaAddress } from '../src/providers/solana.js';

const token = { chain: 'solana' as const, address: '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump' };
const pool = '4zLRGHwKdXyaTovP8UkV66CskWgo9E7kAaGYcw1vFh7E', PUMP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', WSOL = 'So11111111111111111111111111111111111111112';
const ROUTER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SYSVAR = 'Sysvar1nstructions1111111111111111111111111', SYSTEM = '11111111111111111111111111111111', ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const EVENT = 'Cspp27eGUDMXxPEdhmEXFVRn6Lt1L7xJyALF3nmnWoBj', USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const key = (n: number) => encodeSolanaAddress(Buffer.alloc(32, n));
const sig = (n: number) => { const b = Buffer.alloc(64, 9); b.writeUInt32LE(n); return encodeSolanaAddress(b); };
const KEEPER = key(21), DCA = key(22), KEEPER_IN = key(23), IN = key(24), OUT = key(25), TRADER = key(30);
const start = '2026-10-11T15:00:00.000Z', end = '2026-10-11T16:00:00.000Z', cutoff = '2026-10-11T16:30:00.000Z', anchorSlot = 10_001, endS = Date.parse(end) / 1000;
const fixture = (name: string) => readFileSync(`tests/fixtures/${name}`, 'utf8');
const bodies: Record<string, string> = { 'dca-lib': fixture('automation-dca-address.txt'), 'dca-idl': fixture('automation-dca-idl.json'), 'dca-readme': fixture('automation-dca-readme.md'), 'recurring-doc': fixture('automation-dca-doc.md') };
const abi = flashFillAbi(bodies['dca-idl']!);
const data58 = (hex: string, ...tail: Buffer[]) => encodeSolanaAddress(Buffer.concat([Buffer.from(hex, 'hex'), ...tail]));
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const discOf = (name: string) => [...abi.known].find(([, n]) => n === name)![0];

// Runtime-shaped jsonParsed receipts: top-level instructions, CPIs by stack height, and matching invoke/success logs.
type Trade = { side: 'BUY' | 'SELL'; quote: string };
type Node = { ix: any; h: number; failed?: boolean; trade?: Trade };
type Top = { ix: any; inner?: Node[]; trade?: Trade };
type Tx = { n: number; tops: Top[]; signer?: string; logRecovery?: { truncated: boolean; unresolvedInvocations: number; emptyForeignSweeps: number }; mutate?: (value: any) => void };
const transfer = (h: number): Node => ({ h, ix: { program: 'spl-token', programId: TOKEN, parsed: { type: 'transfer', info: {} } } });
const eventCpi: Node = { h: 2, ix: { programId: DCA_PROGRAM, accounts: [EVENT], data: data58('e445a52e51cb9a1d', Buffer.alloc(16, 1)) } };
const opaque = (programId: string) => ({ programId, accounts: [], data: '1' });
const pumpIx = (user: string, base: string) => ({ programId: PUMP, accounts: [pool, user, key(60), token.address, WSOL, base, ...Array.from({ length: 10 }, (_, i) => key(61 + i)), PUMP], data: '3Bxs4Bc3VYuGVB19' });
const swap = (side: 'BUY' | 'SELL', quote = '100', user = KEEPER, base = side === 'BUY' ? OUT : KEEPER_IN): Top => ({ ix: opaque(ROUTER), inner: [{ h: 2, ix: pumpIx(user, base), trade: { side, quote } }] });
type Roles = { inputMint: string; outputMint: string; keeper?: string; inAta?: string; tokenProgram?: string };
function fill(r: Roles) {
  const x = { keeper: KEEPER, inAta: IN, tokenProgram: TOKEN, ...r };
  return {
    initiate: { ix: { programId: DCA_PROGRAM, accounts: [x.keeper, DCA, x.inputMint, KEEPER_IN, x.inAta, OUT, SYSVAR, SYSTEM, x.tokenProgram, ATA], data: 'R43oN7y5NPa' }, inner: [transfer(2)] } as Top,
    fulfill: { ix: { programId: DCA_PROGRAM, accounts: [x.keeper, DCA, x.inputMint, x.outputMint, KEEPER_IN, x.inAta, OUT, key(26), key(27), SYSVAR, SYSTEM, x.tokenProgram, ATA, EVENT, DCA_PROGRAM], data: data58(abi.fulfill.discriminator, u64(1000n)) }, inner: [transfer(2), eventCpi] } as Top,
  };
}
const buy = fill({ inputMint: WSOL, outputMint: token.address }), sell = fill({ inputMint: token.address, outputMint: WSOL });
const filled = (n: number, f: ReturnType<typeof fill>, middle: Top = swap(f === sell ? 'SELL' : 'BUY')): Tx => ({ n, tops: [f.initiate, middle, f.fulfill] });

function logs(tops: Top[]) {
  const out: string[] = [];
  for (const t of tops) {
    const stack = [{ p: t.ix.programId as string, failed: false }];
    const pop = () => { const f = stack.pop()!; out.push(f.failed ? `Program ${f.p} failed: custom program error: 0x1` : `Program ${f.p} success`); };
    out.push(`Program ${t.ix.programId} invoke [1]`);
    for (const c of t.inner ?? []) { while (stack.length >= c.h) pop(); stack.push({ p: c.ix.programId, failed: !!c.failed }); out.push(`Program ${c.ix.programId} invoke [${c.h}]`); }
    while (stack.length) pop();
  }
  return out;
}
const at = (n: number) => new Date((endS - 3000 + n) * 1000).toISOString();
function receipt(t: Tx): any {
  const instructions = t.tops.map(x => ({ ...x.ix, stackHeight: 1 }));
  const innerInstructions = t.tops.flatMap((x, index) => x.inner?.length ? [{ index, instructions: x.inner.map(c => ({ ...c.ix, stackHeight: c.h })) }] : []);
  const signer = t.signer ?? KEEPER, keys = [...new Set([signer, ...t.tops.flatMap(x => [x.ix, ...(x.inner ?? []).map(c => c.ix)]).flatMap((ix: any) => [...(ix.accounts ?? []), ix.programId])])];
  const value = { slot: 1000 + t.n, blockTime: endS - 3000 + t.n, version: 0, transaction: { signatures: [sig(t.n)], message: { accountKeys: keys.map(pubkey => ({ pubkey, signer: pubkey === signer, source: 'transaction', writable: true })), instructions } }, meta: { err: null, innerInstructions, logMessages: logs(t.tops) } };
  t.mutate?.(value); return value;
}
function trades(t: Tx): DecodedTrade[] {
  let pumpIndex = 0; const out: DecodedTrade[] = [];
  for (const x of t.tops) for (const node of [{ ...x, h: 1 } as Node, ...(x.inner ?? [])]) {
    if (node.ix.programId !== PUMP) continue; const instructionIndex = pumpIndex++;
    if (node.trade) out.push({ signature: sig(t.n), slot: 1000 + t.n, at: at(t.n), user: node.ix.accounts[1], side: node.trade.side, baseAtomic: '10', quoteAtomic: node.trade.quote, poolBaseReservesAtomic: '1000000', poolQuoteReservesAtomic: '1000000', instructionIndex, instructionName: node.trade.side === 'BUY' ? 'buy_v2' : 'sell_v2' });
  }
  return out;
}
function scenario(txs: Tx[], options: { complete?: boolean; method?: AdvisoryWindowHistory['method'] } = {}) {
  const rawArtifacts: Record<string, string> = {}, retrievedAt: Record<string, string> = {}, requests: Record<string, { method: string; params: any[] }> = {};
  txs.forEach((t, i) => { const id = `window-transaction-${i}`; requests[id] = { method: 'getTransaction', params: [sig(t.n), { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }] }; rawArtifacts[id] = JSON.stringify({ jsonrpc: '2.0', id: 1, result: receipt(t) }); retrievedAt[id] = '2026-10-11T16:00:40.000Z'; });
  const window: AdvisoryWindowHistory = { method: options.method ?? 'pumpswap-selected-pool-window-v3', abi: { source: 'fixture', sha256: '0'.repeat(64) }, token, pool, window: { start, end }, genesisVerified: true, anchorSlot, anchorTime: '2026-10-11T16:00:30.000Z', poolVerified: true, stateSlot: anchorSlot, coverageReachedStart: true, indexComplete: true, complete: options.complete ?? true, sourceUniverseComplete: false, pages: [], successfulSignatures: txs.length, failedReferences: 0,
    transactions: txs.map(t => ({ signature: sig(t.n), slot: 1000 + t.n, at: at(t.n), status: 'OBSERVED' as const, trades: trades(t).length, ...(t.logRecovery ? { logRecovery: t.logRecovery } : {}) })), trades: txs.flatMap(trades), buyQuoteAtomic: '0', sellQuoteAtomic: '0', netQuoteAtomic: '0', foreignSwapLegs: 0, nonSwapInvocations: 0, cpiAuthorizedAccounts: [], limitations: [], reasonCode: 'SELECTED_POOL_WINDOW_FLOW_OBSERVED' };
  return { window, windowReceipts: { rawArtifacts, retrievedAt, requests } };
}

// Public source GETs serve the exact pinned fixtures with an explicit response URL; the RPC POST serves finalized program state.
type Net = { source?: (id: string) => { status?: number; body?: string; url?: string; error?: Error } | undefined; program?: (result: any) => unknown };
function network(net: Net = {}) {
  const calls: Array<{ url: string; method: string; body?: any }> = []; let clock = Date.parse('2026-10-11T16:10:00.000Z');
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); calls.push({ url, method: 'POST', body });
      const result = { context: { apiVersion: '4.3.0', slot: anchorSlot + 5 }, value: { data: ['', 'base64'], executable: true, lamports: 1141440, owner: LOADER, rentEpoch: 0, space: 36 } };
      return new Response(JSON.stringify(net.program ? net.program(result) : { jsonrpc: '2.0', id: 1, result }));
    }
    calls.push({ url, method: 'GET' });
    const source = OFFICIAL_AUTOMATION_SOURCES.find(s => s.url === url)!, o = net.source?.(source.id);
    if (o?.error) throw o.error;
    const response = new Response(o?.body ?? bodies[source.id], { status: o?.status ?? 200 }); Object.defineProperty(response, 'url', { value: o?.url ?? url }); return response;
  };
  return { calls, fetcher, now: () => new Date(clock += 1000).toISOString() };
}
async function measure(txs: Tx[], net: Net = {}, options: Parameters<typeof scenario>[1] = {}) {
  const x = scenario(txs, options), n = network(net), receipts = await collectAdvisoryAutomation(token, x.window, 'https://rpc.example', n.fetcher, n.now);
  return { ...x, ...n, receipts, metric: deriveO30Window(token, x.window, x.windowReceipts, receipts, cutoff, ['w', 'a']) };
}
const clone = (r: AutomationReceipts): AutomationReceipts => JSON.parse(JSON.stringify(r));

// Sanitized portable copy of mainnet 5Ybi5y...: ATA create, initiateFlashFill, router sibling, fulfillFlashFill, keeper transfer.
const REAL = { keeper: 'JD25qVdtd65FoiXNmR89JjmoJdYk9sjYQeSTZAALFiMy', dca: '93suurAn3WiyEyrkgZiLujtaH3qiybTFBSvW35ccrQrT', outputMint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', keeperInAta: '8b5VMMHh6wNMtGH3fdCBjMgyL4viQRJvw539nYx5JWgX', inAta: 'DXDK8g1YCyoWm9m924zmrd5NnYQWFAk4HMyzMZM6YdV3', outAta: '5bMYsZN2cjkCaQ64E6K9ipcjjVNTSqcifg4eP6f9GaAi' };
const realTops: Top[] = [
  { ix: { programId: ATA, program: 'spl-associated-token-account', parsed: { type: 'createIdempotent', info: {} } } },
  { ix: { programId: DCA_PROGRAM, accounts: [REAL.keeper, REAL.dca, USDC, REAL.keeperInAta, REAL.inAta, REAL.outAta, SYSVAR, SYSTEM, TOKEN, ATA], data: 'R43oN7y5NPa' }, inner: [transfer(2)] },
  { ix: opaque(ROUTER), inner: [transfer(2), { h: 2, ix: opaque('3TK9D8aoBFYjYZtKCjciPrVrRStsnvo7KmpcJqDavpaU') }, transfer(3), transfer(3), { h: 2, ix: opaque(ROUTER) }, { h: 2, ix: opaque('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc') }, transfer(3), transfer(3), { h: 2, ix: opaque(ROUTER) }, transfer(2)] },
  { ix: { programId: DCA_PROGRAM, accounts: [REAL.keeper, REAL.dca, USDC, REAL.outputMint, REAL.keeperInAta, REAL.inAta, REAL.outAta, 'CpoD6tWAsMDeyvVG2q2rD1JbDY6d4AujnvAn2NdrhZV2', 'wnYkmUh5VudfuUvHdxsac8eJ4wLNdHnxmPfeCoPXzHz', SYSVAR, SYSTEM, TOKEN, ATA, EVENT, DCA_PROGRAM], data: 'FETQbQB1sKtmGboRVUFeLX' }, inner: [transfer(2), eventCpi, eventCpi] },
  { ix: { programId: DCA_PROGRAM, accounts: [REAL.keeper, REAL.dca, 'GAdn7TZhszf5KTfwNRx3A2nP6KCRFEWucZubgdEqbJA2', REAL.outputMint, REAL.outAta, 'BTy44YBx9AVLHbKkSVLGaCBNKUpzw78W6hKy43vpeCHp', DCA_PROGRAM, SYSTEM, TOKEN, ATA, EVENT, DCA_PROGRAM], data: 'UJJfJRLDFLd' }, inner: [transfer(2), eventCpi] },
  { ix: opaque('ComputeBudget111111111111111111111111111111') },
];
const realFill = { initiateTop: 1, fulfillTop: 3, keeper: REAL.keeper, dca: REAL.dca, inputMint: USDC, outputMint: REAL.outputMint, keeperInAta: REAL.keeperInAta, inAta: REAL.inAta, outAta: REAL.outAta, side: null };

test('pinned fixtures, official IDL roles, real discriminators and event authority agree', () => {
  for (const s of OFFICIAL_AUTOMATION_SOURCES) { assert.equal(createHash('sha256').update(bodies[s.id]!, 'utf8').digest('hex'), s.sha256, s.id); assert.equal(Buffer.byteLength(bodies[s.id]!, 'utf8'), s.bytes); assert.ok(bodies[s.id]!.includes(s.literal)); }
  assert.deepEqual(abi.initiate.accounts, ['keeper', 'dca', 'inputMint', 'keeperInAta', 'inAta', 'outAta', 'instructionsSysvar', 'systemProgram', 'tokenProgram', 'associatedTokenProgram']);
  assert.deepEqual(abi.fulfill.accounts, ['keeper', 'dca', 'inputMint', 'outputMint', 'keeperInAta', 'inAta', 'outAta', 'feeAuthority', 'feeAta', 'instructionsSysvar', 'systemProgram', 'tokenProgram', 'associatedTokenProgram', 'eventAuthority', 'program']);
  assert.deepEqual([abi.initiate.dataLength, abi.fulfill.dataLength], [8, 16]);
  assert.equal(encodeSolanaAddress(Buffer.from(abi.initiate.discriminator, 'hex')), 'R43oN7y5NPa');
  assert.equal(encodeSolanaAddress(Buffer.from(discOf('transfer'), 'hex')), 'UJJfJRLDFLd');
  assert.equal(PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], new PublicKey(DCA_PROGRAM))[0].toBase58(), EVENT);
  assert.throws(() => flashFillAbi('{}'), /ADVISORY_AUTOMATION_IDL/);
  assert.throws(() => flashFillAbi(bodies['dca-idl']!.replace('"name": "keeper",\n          "isMut": true,\n          "isSigner": true', '"name": "keeper",\n          "isMut": true,\n          "isSigner": false')), /ADVISORY_AUTOMATION_IDL/);
  // The portable real shape binds one pair whose USDC input is not this pool's pair.
  assert.deepEqual(bindFlashFills(receipt({ n: 1, tops: realTops, signer: REAL.keeper }), token.address, pool, [], abi), { fills: [realFill], attributions: [] });
});

test('collector retains exactly five reads; certified BUY and SELL fills are counted once beside ordinary router flow', async () => {
  const m = await measure([filled(1, buy, swap('BUY', '100')), { n: 2, tops: [buy.initiate, swap('BUY', '200'), buy.fulfill, sell.initiate, swap('SELL', '300'), sell.fulfill] }, { n: 3, signer: TRADER, tops: [swap('BUY', '400', TRADER, key(31))] }]);
  assert.deepEqual(m.calls.filter(c => c.method === 'GET').map(c => c.url).sort(), OFFICIAL_AUTOMATION_SOURCES.map(s => s.url).sort());
  assert.deepEqual(m.calls.filter(c => c.method === 'POST').map(c => [c.url, c.body.method, c.body.params]), [['https://rpc.example', 'getAccountInfo', [DCA_PROGRAM, { encoding: 'base64', commitment: 'finalized', minContextSlot: anchorSlot, dataSlice: { offset: 0, length: 0 } }]]]);
  const keys = ['program-account', 'source-dca-idl', 'source-dca-lib', 'source-dca-readme', 'source-recurring-doc'];
  for (const map of [m.receipts.rawArtifacts, m.receipts.retrievedAt, m.receipts.requests]) assert.deepEqual(Object.keys(map).sort(), keys);
  assert.deepEqual(JSON.parse(m.receipts.rawArtifacts['source-dca-lib']!), { httpStatus: 200, url: OFFICIAL_AUTOMATION_SOURCES[0].url, body: bodies['dca-lib'] });
  assert.equal(new Set(Object.values(m.receipts.retrievedAt)).size, 5);
  const metric = m.metric, data = metric.data as any;
  assert.equal(metric.quality, 'KNOWN'); assert.equal(metric.reasonCode, 'OFFICIAL_AUTOMATION_FLOW_OBSERVED'); assert.deepEqual(metric.evidenceIds, ['w', 'a']);
  assert.deepEqual([data.coveredQuoteAtomic, data.knownAutomatedQuoteAtomic, data.unattributedQuoteAtomic, data.knownAutomatedFraction], ['1000', '600', '400', '0.6']);
  assert.deepEqual([data.coveredTrades, data.knownAutomatedTrades, data.knownAutomatedTransactions, data.fillsObserved, data.poolOrientedFills], [4, 3, 2, 3, 3]);
  assert.deepEqual(data.trades.map((t: any) => [t.side, t.quoteAtomic, t.attribution, t.fill?.side ?? null]), [['BUY', '100', 'JUPITER_LEGACY_DCA_FLASH_FILL', 'BUY'], ['BUY', '200', 'JUPITER_LEGACY_DCA_FLASH_FILL', 'BUY'], ['SELL', '300', 'JUPITER_LEGACY_DCA_FLASH_FILL', 'SELL'], ['BUY', '400', 'UNATTRIBUTED', null]]);
  assert.deepEqual(data.trades.slice(1, 3).map((t: any) => [t.fill.initiateTop, t.fill.fulfillTop]), [[0, 2], [3, 5]]);
  assert.equal(data.unknownAutomation, 'NOT_MEASURED');
  assert.ok(data.registry.programs[0].sources.every((s: any) => s.status === 'VERIFIED'));
  assert.deepEqual([data.registry.programs[0].account.status, data.registry.programs[0].account.contextSlot], ['VERIFIED', anchorSlot + 5]);
  assert.deepEqual(deriveO30Window(token, m.window, m.windowReceipts, clone(m.receipts), cutoff, ['w', 'a']), metric);
});

test('ordinary router flow and failed DCA branches are an honest registry-only zero', async () => {
  const router = await measure([{ n: 1, signer: TRADER, tops: [swap('BUY', '250', TRADER, key(31))] }]);
  const failed = await measure([{ n: 1, tops: [{ ix: opaque(ROUTER), inner: [{ h: 2, ix: buy.initiate.ix, failed: true }, { h: 2, ix: pumpIx(KEEPER, OUT), trade: { side: 'BUY', quote: '250' } }] }] }]);
  for (const m of [router, failed]) {
    const data = m.metric.data as any;
    assert.equal(m.metric.quality, 'KNOWN');
    assert.deepEqual([data.knownAutomatedQuoteAtomic, data.knownAutomatedFraction, data.unattributedQuoteAtomic, data.fillsObserved, data.unknownAutomation], ['0', '0', '250', 0, 'NOT_MEASURED']);
    assert.match(data.meaning, /never total automation, bot-free, organic or manual/);
  }
});

test('O28-safe v4 truncation uses complete parsed instruction lists only to establish bounded DCA registry absence', async () => {
  const recovered = (n: number, mutate?: (value: any) => void): Tx => ({ n, tops: [swap('BUY', '250', TRADER, key(31))], logRecovery: { truncated: true, unresolvedInvocations: 0, emptyForeignSweeps: 0 }, mutate: value => { value.meta.logMessages.push('Log truncated'); mutate?.(value); } });
  const accepted = await measure([recovered(81)], {}, { method: 'pumpswap-selected-pool-window-v4' });
  const acceptedData = accepted.metric.data as any;
  assert.equal(accepted.metric.quality, 'KNOWN');
  assert.deepEqual([acceptedData.knownAutomatedQuoteAtomic, acceptedData.unattributedQuoteAtomic, acceptedData.trades[0].attributionBasis, acceptedData.unknownAutomation], ['0', '250', 'COMPLETE_PARSED_INSTRUCTIONS_NO_REGISTERED_DCA', 'NOT_MEASURED']);
  assert.match(acceptedData.limitations.join(' '), /does not recover execution order or prove that unregistered automation is absent/);

  const dcaPresent = await measure([{ ...recovered(82), tops: [filled(82, buy).tops[0]!, ...filled(82, buy).tops.slice(1)] }], {}, { method: 'pumpswap-selected-pool-window-v4' });
  assert.equal(dcaPresent.metric.quality, 'MISSING'); assert.equal(dcaPresent.metric.reasonCode, 'ADVISORY_ACCOUNTS_LOG_INCOMPLETE');
  const missingInner = await measure([recovered(83, value => { value.meta.innerInstructions = null; })], {}, { method: 'pumpswap-selected-pool-window-v4' });
  assert.equal(missingInner.metric.quality, 'MISSING'); assert.equal(missingInner.metric.reasonCode, 'ADVISORY_ACCOUNTS_TRANSACTION_SHAPE');
  const invalidTopProgram = await measure([recovered(86, value => { value.transaction.message.instructions[0].programId = 'not-a-solana-address'; })], {}, { method: 'pumpswap-selected-pool-window-v4' });
  assert.equal(invalidTopProgram.metric.quality, 'MISSING'); assert.equal(invalidTopProgram.metric.reasonCode, 'ADVISORY_ACCOUNTS_TRANSACTION_SHAPE');
  const invalidInnerProgram = await measure([recovered(87, value => { value.meta.innerInstructions[0].instructions[0].programId = 'not-a-solana-address'; })], {}, { method: 'pumpswap-selected-pool-window-v4' });
  assert.equal(invalidInnerProgram.metric.quality, 'MISSING'); assert.equal(invalidInnerProgram.metric.reasonCode, 'ADVISORY_ACCOUNTS_INNER_SHAPE');
  const legacy = await measure([recovered(84)], {}, { method: 'pumpswap-selected-pool-window-v3' });
  assert.equal(legacy.metric.quality, 'MISSING'); assert.match(legacy.metric.reasonCode, /^ADVISORY_ACCOUNTS_LOG_/);
  const unresolved = await measure([{ ...recovered(85), logRecovery: { truncated: true, unresolvedInvocations: 1, emptyForeignSweeps: 0 } }], {}, { method: 'pumpswap-selected-pool-window-v4' });
  assert.equal(unresolved.metric.quality, 'MISSING'); assert.match(unresolved.metric.reasonCode, /^ADVISORY_ACCOUNTS_LOG_/);
});

test('role, orientation, mint and interval mismatches stay unattributed rather than certified', async () => {
  const foreign = fill({ inputMint: USDC, outputMint: token.address });
  const cases: Array<[string, Tx]> = [
    ['outside interval', { n: 1, tops: [swap('BUY'), buy.initiate, buy.fulfill] }],
    ['foreign input mint', filled(1, foreign, swap('BUY'))],
    ['keeper is not Pump user', filled(1, buy, swap('BUY', '100', TRADER, OUT))],
    ['wrong base account', filled(1, buy, swap('BUY', '100', KEEPER, KEEPER_IN))],
    ['wrong orientation', filled(1, buy, swap('SELL', '100', KEEPER, KEEPER_IN))],
  ];
  for (const [name, tx] of cases) {
    const m = await measure([tx]), data = m.metric.data as any;
    assert.equal(m.metric.quality, 'KNOWN', name);
    assert.deepEqual([data.knownAutomatedQuoteAtomic, data.trades[0].attribution, data.fillsObserved], ['0', 'UNATTRIBUTED', 1], name);
  }
});

test('unsupported, unpaired, nested, interrupted, mismatched or log-inconsistent execution leaves O30 unresolved', async () => {
  const other = fill({ inputMint: WSOL, outputMint: token.address, inAta: key(29) }), t22 = fill({ inputMint: WSOL, outputMint: token.address, tokenProgram: T22 });
  const deposit: Top = { ix: { programId: DCA_PROGRAM, accounts: [KEEPER, DCA, IN, key(28), TOKEN, EVENT, DCA_PROGRAM], data: data58(discOf('deposit'), u64(5n)) } };
  const pumpInsideDca: Top = { ...buy.fulfill, inner: [{ h: 2, ix: pumpIx(KEEPER, OUT), trade: { side: 'BUY', quote: '100' } }] };
  const cases: Array<[string, Tx, RegExp]> = [
    ['unpaired initiate', { n: 1, tops: [buy.initiate, swap('BUY')] }, /^ADVISORY_AUTOMATION_FILL_SEQUENCE$/],
    ['unpaired fulfill', { n: 1, tops: [swap('BUY'), buy.fulfill] }, /^ADVISORY_AUTOMATION_FILL_SEQUENCE$/],
    ['nested pair', { n: 1, tops: [buy.initiate, buy.initiate, swap('BUY'), buy.fulfill, buy.fulfill] }, /^ADVISORY_AUTOMATION_FILL_SEQUENCE$/],
    ['manual call interrupts', { n: 1, tops: [buy.initiate, deposit, swap('BUY'), buy.fulfill] }, /^ADVISORY_AUTOMATION_FILL_SEQUENCE$/],
    ['unknown registered call', { n: 1, tops: [{ ix: { programId: DCA_PROGRAM, accounts: [], data: data58('0102030405060708') } }, swap('BUY')] }, /^ADVISORY_AUTOMATION_UNSUPPORTED_CALL$/],
    ['executed CPI initiate', { n: 1, tops: [{ ix: opaque(ROUTER), inner: [{ h: 2, ix: buy.initiate.ix }] }, swap('BUY')] }, /^ADVISORY_AUTOMATION_UNSUPPORTED_CALL$/],
    ['pool leg inside DCA call', { n: 1, tops: [buy.initiate, pumpInsideDca] }, /^ADVISORY_AUTOMATION_UNSUPPORTED_CALL$/],
    ['pair role mismatch', { n: 1, tops: [buy.initiate, swap('BUY'), other.fulfill] }, /^ADVISORY_AUTOMATION_FILL_ROLES$/],
    ['extra initiate account', { n: 1, tops: [{ ...buy.initiate, ix: { ...buy.initiate.ix, accounts: [...buy.initiate.ix.accounts, key(40)] } }, swap('BUY'), buy.fulfill] }, /^ADVISORY_AUTOMATION_FILL_ROLES$/],
    ['unsupported token program', filled(1, t22, swap('BUY')), /^ADVISORY_AUTOMATION_FILL_ROLES$/],
    ['keeper did not sign', { ...filled(1, buy, swap('BUY')), signer: TRADER }, /^ADVISORY_AUTOMATION_FILL_SIGNER$/],
    ['pool leg under failed ancestor', { n: 1, tops: [{ ix: opaque(ROUTER), inner: [{ h: 2, ix: opaque(key(41)), failed: true }, { h: 3, ix: pumpIx(KEEPER, OUT), trade: { side: 'BUY', quote: '100' } }] }] }, /^ADVISORY_AUTOMATION_TRADE_BINDING$/],
    ['missing success log', { ...filled(1, buy, swap('BUY')), mutate: v => v.meta.logMessages.pop() }, /^ADVISORY_ACCOUNTS_LOG_/],
    ['truncated logs', { ...filled(1, buy, swap('BUY')), mutate: v => v.meta.logMessages.push('Log truncated') }, /^ADVISORY_ACCOUNTS_LOG_/],
  ];
  for (const [name, tx, code] of cases) {
    const m = await measure([tx]), data = m.metric.data as any;
    assert.equal(m.metric.quality, 'MISSING', name); assert.match(m.metric.reasonCode, code, name);
    assert.deepEqual([data.coveredQuoteAtomic, data.knownAutomatedQuoteAtomic, data.knownAutomatedFraction, data.unknownAutomation], ['100', null, null, 'NOT_MEASURED'], name);
  }
  const x = await measure([filled(1, buy)]), windowReceipts = { ...x.windowReceipts, requests: {} };
  assert.equal(deriveO30Window(token, x.window, windowReceipts, x.receipts, cutoff, []).reasonCode, 'ADVISORY_AUTOMATION_WINDOW_RECEIPT');
});

test('incomplete, non-current or tradeless windows issue no reads and stay unresolved', async () => {
  const cases: Array<[Tx[], Parameters<typeof scenario>[1], string]> = [
    [[filled(1, buy)], { complete: false }, 'AUTOMATION_WINDOW_INCOMPLETE'],
    [[filled(1, buy)], { method: 'pumpswap-selected-pool-window-v2' }, 'AUTOMATION_WINDOW_INCOMPLETE'],
    [[], {}, 'AUTOMATION_WINDOW_WITHOUT_TRADES'],
  ];
  for (const [txs, options, reason] of cases) {
    const m = await measure(txs, {}, options);
    assert.equal(m.calls.length, 0); assert.deepEqual(m.receipts, { rawArtifacts: {}, retrievedAt: {}, requests: {} });
    assert.deepEqual([m.metric.quality, m.metric.reasonCode], ['MISSING', reason]);
  }
  const good = await measure([filled(1, buy)]), incomplete = scenario([filled(1, buy)], { complete: false });
  assert.throws(() => deriveO30Window(token, incomplete.window, incomplete.windowReceipts, good.receipts, cutoff, []), /ADVISORY_AUTOMATION_RECEIPT_MEMBERSHIP/);
});

test('source and program failures are retained as explicit unresolved registry evidence', async () => {
  const masterUrl = 'https://raw.githubusercontent.com/jup-ag/dca-cpi/master/src/lib.rs';
  const cases: Array<[string, Net, string]> = [
    ['changed body', { source: id => id === 'recurring-doc' ? { body: `${bodies['recurring-doc']} ` } : undefined }, 'AUTOMATION_SOURCE_CHANGED'],
    ['redirected URL', { source: id => id === 'dca-lib' ? { url: masterUrl } : undefined }, 'AUTOMATION_SOURCE_URL'],
    ['HTTP status', { source: id => id === 'dca-readme' ? { status: 404 } : undefined }, 'AUTOMATION_SOURCE_HTTP'],
    ['transport', { source: id => id === 'dca-idl' ? { error: new Error('socket closed') } : undefined }, 'AUTOMATION_SOURCE_TRANSPORT'],
    ['not executable', { program: r => ({ jsonrpc: '2.0', id: 1, result: { ...r, value: { ...r.value, executable: false } } }) }, 'AUTOMATION_PROGRAM_NOT_EXECUTABLE'],
    ['wrong owner', { program: r => ({ jsonrpc: '2.0', id: 1, result: { ...r, value: { ...r.value, owner: 'BPFLoader2111111111111111111111111111111111' } } }) }, 'AUTOMATION_PROGRAM_NOT_EXECUTABLE'],
    ['stale context slot', { program: r => ({ jsonrpc: '2.0', id: 1, result: { ...r, context: { slot: anchorSlot - 1 } } }) }, 'AUTOMATION_PROGRAM_SLOT'],
    ['RPC error', { program: () => ({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'invalid' } }) }, 'RPC_REMOTE_-32602'],
  ];
  for (const [name, net, reason] of cases) {
    const m = await measure([filled(1, buy)], net);
    assert.equal(Object.keys(m.receipts.rawArtifacts).length, 5, name);
    assert.deepEqual([m.metric.quality, m.metric.reasonCode], ['MISSING', reason], name);
    assert.ok((m.metric.data as any).registry, name);
  }
  const m = await measure([filled(1, buy)]), early = clone(m.receipts); early.retrievedAt['program-account'] = '2026-10-11T15:59:00.000Z';
  assert.equal(deriveO30Window(token, m.window, m.windowReceipts, early, cutoff, []).reasonCode, 'AUTOMATION_PROGRAM_TIME');
  // A spent deadline makes no network calls, retains every failure and never aborts the collection.
  const x = scenario([filled(1, buy)]), n = network(), controller = new AbortController(); controller.abort();
  const aborted = await collectAdvisoryAutomation(token, x.window, 'https://rpc.example', n.fetcher, n.now, controller.signal);
  assert.equal(n.calls.length, 0); assert.equal(Object.keys(aborted.rawArtifacts).length, 5);
  assert.deepEqual(JSON.parse(aborted.rawArtifacts['source-dca-lib']!), { code: 'AUTOMATION_SOURCE_TIMEOUT' });
  assert.match(JSON.parse(aborted.rawArtifacts['program-account']!).error.code, /^RPC_/);
  assert.equal(deriveO30Window(token, x.window, x.windowReceipts, aborted, cutoff, []).reasonCode, 'AUTOMATION_SOURCE_TIMEOUT');
});

test('forged scope, cutoff, request or membership throws; zero denominator is undefined', async () => {
  const m = await measure([filled(1, buy)]), derive = (receipts: AutomationReceipts, at = cutoff, t = token) => deriveO30Window(t, m.window, m.windowReceipts, receipts, at, []);
  const changed = clone(m.receipts); (changed.requests['program-account'] as any).params[1].minContextSlot = anchorSlot - 1;
  const extra = clone(m.receipts); extra.rawArtifacts.extra = '{}'; extra.retrievedAt.extra = '2026-10-11T16:20:00.000Z'; extra.requests.extra = { method: 'GET', url: 'https://example.com' };
  const missing = clone(m.receipts); for (const map of [missing.rawArtifacts, missing.retrievedAt, missing.requests]) delete map['source-dca-readme'];
  const cases: Array<[() => unknown, RegExp]> = [
    [() => derive(m.receipts, '2026-10-11T16:10:02.000Z'), /ADVISORY_AUTOMATION_RECEIPT_TIME/],
    [() => derive(m.receipts, 'not-a-date'), /ADVISORY_AUTOMATION_TIME/],
    [() => derive(m.receipts, '2026-10-11T15:59:00.000Z'), /ADVISORY_AUTOMATION_TIME/],
    [() => derive(changed), /ADVISORY_AUTOMATION_REQUEST/],
    [() => derive(extra), /ADVISORY_AUTOMATION_RECEIPT_MEMBERSHIP/],
    [() => derive(missing), /ADVISORY_AUTOMATION_RECEIPT_MEMBERSHIP/],
    [() => derive(m.receipts, cutoff, { chain: 'solana', address: pool }), /ADVISORY_AUTOMATION_SCOPE/],
  ];
  for (const [run, error] of cases) assert.throws(run, error);
  await assert.rejects(collectAdvisoryAutomation({ chain: 'solana', address: pool }, m.window, 'https://rpc.example', network().fetcher, network().now), /ADVISORY_AUTOMATION_SCOPE/);
  const zero = await measure([filled(1, buy, swap('BUY', '0'))]);
  assert.deepEqual([zero.metric.quality, zero.metric.reasonCode, (zero.metric.data as any).knownAutomatedFraction], ['MISSING', 'AUTOMATION_DENOMINATOR_ZERO', null]);
});
