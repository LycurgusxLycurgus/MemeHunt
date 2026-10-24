import test from 'node:test';
import assert from 'node:assert/strict';
import type { AdvisoryWindowHistory } from '../src/providers/advisory-window.js';
import type { DecodedTrade } from '../src/providers/advisory-trades.js';
import { collectAdvisoryWindowAccounts, decodeAdvisoryWindowAccounts, deriveO26Window, ACCOUNT_RECEIPT_CAP, type WindowAccountHistory } from '../src/providers/advisory-window-accounts.js';
import { encodeSolanaAddress } from '../src/providers/solana.js';

const token = { chain: 'solana' as const, address: '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump' };
const pool = '4zLRGHwKdXyaTovP8UkV66CskWgo9E7kAaGYcw1vFh7E', program = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', wsol = 'So11111111111111111111111111111111111111112';
const key = (n: number) => encodeSolanaAddress(Buffer.alloc(32, n));
const sig = (n: number) => { const b = Buffer.alloc(64, 9); b.writeUInt32LE(n); return encodeSolanaAddress(b); };
const vault = key(5), quoteVault = key(6), other = key(40), A = key(11), B = key(12), C = key(13);
const userOf = (account: string) => key(100 + (Buffer.from(account).readUInt8(0) % 50));
const end = '2026-10-11T16:00:00.000Z', start = '2026-10-11T15:00:00.000Z', cutoff = '2026-10-11T16:30:00.000Z';
const endS = Date.parse(end) / 1000, startS = endS - 3600, anchorSlot = 10_001;
type RpcRequest = { method: string; params: any[] };
type Step = { pump: { side: 'BUY' | 'SELL'; account: string; amount: string } } | { transfer: { source: string; destination: string; amount: string; type?: string } } | { init: string } | { close: string } | { parsed: { type: string; info: Record<string, unknown> } };
type Tx = { n: number; at: number; steps: Step[]; balances: Record<string, [string | null, string | null]>; quote?: string; err?: unknown; index?: number | null; slot?: number; mutateReceipt?: (value: any) => void };
const slotOf = (t: { n: number; slot?: number }) => t.slot ?? 1000 + t.n * 10;

const balance = (keys: string[], account: string, amount: string | null) => amount === null ? [] : [{ accountIndex: keys.indexOf(account), mint: token.address, owner: userOf(account), programId: T22, uiTokenAmount: { amount, decimals: 6, uiAmount: null, uiAmountString: amount } }];
const leg = (source: string, destination: string, amount: string, stackHeight: number | null, type = 'transferChecked') => ({ program: 'spl-token', programId: T22, stackHeight, parsed: { type, info: { source, destination, mint: token.address, authority: source === vault ? pool : userOf(source), tokenAmount: { amount, decimals: 6, uiAmount: null, uiAmountString: amount } } } });
function runtimeLogs(instructions: any[], inner: any[]): string[] {
  const logs: string[] = [];
  for (const [index, ix] of instructions.entries()) {
    const stack = [ix.programId]; logs.push(`Program ${ix.programId} invoke [1]`);
    for (const child of inner.find(g => g.index === index)?.instructions ?? []) {
      while (stack.length >= child.stackHeight) logs.push(`Program ${stack.pop()} success`);
      assert.equal(child.stackHeight, stack.length + 1);
      stack.push(child.programId); logs.push(`Program ${child.programId} invoke [${child.stackHeight}]`);
    }
    while (stack.length) logs.push(`Program ${stack.pop()} success`);
  }
  return logs;
}
function receipt(t: Tx): any {
  const instructions: any[] = [], inner: any[] = [];
  for (const step of t.steps) {
    if ('pump' in step) {
      const { side, account, amount } = step.pump, user = userOf(account);
      const accounts = [pool, user, key(60), token.address, wsol, account, key(61), vault, quoteVault, T22, T22, '11111111111111111111111111111111', key(62), key(63), key(64), key(65), program];
      inner.push({ index: instructions.length, instructions: [side === 'BUY' ? leg(vault, account, amount, 2) : leg(account, vault, amount, 2), { program: 'spl-token', programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', stackHeight: 2, parsed: { type: 'transferChecked', info: { source: key(61), destination: quoteVault, mint: wsol, authority: user, tokenAmount: { amount: t.quote ?? '1', decimals: 9 } } } }] });
      instructions.push({ programId: program, accounts, data: '3Bxs4Bc3VYuGVB19', stackHeight: 1 });
    } else if ('transfer' in step) instructions.push(leg(step.transfer.source, step.transfer.destination, step.transfer.amount, 1, step.transfer.type));
    else if ('init' in step) instructions.push({ program: 'spl-token', programId: T22, stackHeight: 1, parsed: { type: 'initializeAccount3', info: { account: step.init, mint: token.address, owner: userOf(step.init) } } });
    else if ('close' in step) instructions.push({ program: 'spl-token', programId: T22, stackHeight: 1, parsed: { type: 'closeAccount', info: { account: step.close, destination: userOf(step.close), owner: userOf(step.close) } } });
    else instructions.push({ program: 'spl-token', programId: T22, stackHeight: 1, parsed: step.parsed });
  }
  const keys = [...new Set([...t.steps.flatMap(s => 'pump' in s ? [userOf(s.pump.account), s.pump.account, vault, pool] : 'transfer' in s ? [s.transfer.source, s.transfer.destination] : []), ...Object.keys(t.balances), program, T22])];
  const result = { slot: slotOf(t), blockTime: t.at, version: 0, transactionIndex: t.index === undefined ? t.n : t.index, transaction: { signatures: [sig(t.n)], message: { accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0, source: 'transaction', writable: true })), instructions } },
    meta: { err: t.err ?? null, innerInstructions: inner, logMessages: runtimeLogs(instructions, inner), preTokenBalances: Object.entries(t.balances).flatMap(([a, [pre]]) => balance(keys, a, pre)), postTokenBalances: Object.entries(t.balances).flatMap(([a, [, post]]) => balance(keys, a, post)) } };
  t.mutateReceipt?.(result); return result;
}
const row = (t: { n: number; at: number | null; err?: unknown; index?: number | null; slot?: number }) => ({ signature: sig(t.n), slot: slotOf(t), blockTime: t.at, err: t.err ?? null, memo: null, confirmationStatus: 'finalized', ...(t.index === null ? {} : { transactionIndex: t.index ?? t.n }) });
const getTransaction = (signature: string) => ({ method: 'getTransaction', params: [signature, { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }] });

/** A complete selected-pool window whose receipts are shaped like finalized jsonParsed RPC responses. */
function scenario(pool_txs: Tx[], extras: Tx[] = [], indexRows: (account: string) => any[][] = () => [], options: { complete?: boolean; method?: AdvisoryWindowHistory['method'] } = {}) {
  const trades: DecodedTrade[] = [], windowRaw: Record<string, string> = {}, windowTimes: Record<string, string> = {}, windowRequests: Record<string, RpcRequest> = {};
  windowRequests['window-anchor-time'] = { method: 'getBlockTime', params: [anchorSlot] }; windowRaw['window-anchor-time'] = JSON.stringify({ jsonrpc: '2.0', id: 1, result: endS + 30 }); windowTimes['window-anchor-time'] = '2026-10-11T16:00:31.000Z';
  pool_txs.forEach((t, i) => {
    const r = receipt(t), pump = t.steps.find(s => 'pump' in s) as { pump: { side: 'BUY' | 'SELL'; account: string; amount: string } };
    trades.push({ signature: sig(t.n), slot: r.slot, at: new Date(t.at * 1000).toISOString(), user: userOf(pump.pump.account), side: pump.pump.side, baseAtomic: pump.pump.amount, quoteAtomic: t.quote ?? '1', poolBaseReservesAtomic: '1000000', poolQuoteReservesAtomic: '1000000', instructionIndex: 0, instructionName: pump.pump.side === 'BUY' ? 'buy_v2' : 'sell_v2' });
    windowRequests[`window-transaction-${i}`] = getTransaction(sig(t.n)); windowRaw[`window-transaction-${i}`] = JSON.stringify({ jsonrpc: '2.0', id: 1, result: r }); windowTimes[`window-transaction-${i}`] = '2026-10-11T16:00:40.000Z';
  });
  const window: AdvisoryWindowHistory = { method: options.method ?? 'pumpswap-selected-pool-window-v3', abi: { source: 'fixture', sha256: '0'.repeat(64) }, token, pool, window: { start, end }, genesisVerified: true, anchorSlot, anchorTime: '2026-10-11T16:00:30.000Z', poolVerified: true, stateSlot: anchorSlot, coverageReachedStart: true, indexComplete: true, complete: options.complete ?? true, sourceUniverseComplete: false, pages: [], successfulSignatures: pool_txs.length, failedReferences: 0,
    transactions: pool_txs.map(t => ({ signature: sig(t.n), slot: slotOf(t), at: new Date(t.at * 1000).toISOString(), status: 'OBSERVED' as const, trades: 1 })), trades: trades.sort((a, b) => a.slot - b.slot), buyQuoteAtomic: '0', sellQuoteAtomic: '0', netQuoteAtomic: '0', foreignSwapLegs: 0, nonSwapInvocations: 0, cpiAuthorizedAccounts: [], limitations: [], reasonCode: 'SELECTED_POOL_WINDOW_FLOW_OBSERVED' };
  const all = [...pool_txs, ...extras], calls: RpcRequest[] = [];
  const defaultRows = (account: string) => [[...all.filter(t => receipt(t).transaction.message.accountKeys.some((k: any) => k.pubkey === account)).sort((a, b) => slotOf(b) - slotOf(a)).map(t => row({ n: t.n, at: t.at, err: t.err, index: t.index, slot: t.slot })), row({ n: 9000 + Buffer.from(account).readUInt8(1), at: startS - 100, slot: 500 })]];
  let clock = Date.parse('2026-10-11T16:10:00.000Z');
  const fetcher: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as RpcRequest; calls.push(request); let result: unknown;
    if (request.method === 'getSignaturesForAddress') {
      const pages = indexRows(request.params[0]).length ? indexRows(request.params[0]) : defaultRows(request.params[0]), before = request.params[1].before;
      result = before ? pages[pages.findIndex(p => p.at(-1)?.signature === before) + 1] ?? [] : pages[0] ?? [];
    } else if (request.method === 'getTransaction') { const t = all.find(t => sig(t.n) === request.params[0]); result = t ? receipt(t) : null; }
    else throw new Error(`Unexpected request ${request.method}`);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  };
  const windowReceipts = { rawArtifacts: windowRaw, retrievedAt: windowTimes, requests: windowRequests };
  const collect = () => collectAdvisoryWindowAccounts(token, { ...windowReceipts, data: window }, 'https://rpc.example', fetcher, () => new Date(clock += 1000).toISOString());
  const decode = (c: Awaited<ReturnType<typeof collect>>, at = cutoff) => decodeAdvisoryWindowAccounts(token, window, windowReceipts, c.rawArtifacts, c.retrievedAt, c.requests, at);
  return { window, windowReceipts, calls, collect, decode };
}
const pump = (side: 'BUY' | 'SELL', account: string, amount: string): Step => ({ pump: { side, account, amount } });
const out = (source: string, destination: string, amount: string): Step => ({ transfer: { source, destination, amount } });
/** A round-trips twice, B passes a buy straight through, C round-trips with intervening transfers and a create/close lifecycle. */
const rich = (mutate: (extras: Tx[], pools: Tx[]) => void = () => {}) => {
  const pools: Tx[] = [
    { n: 1, at: startS + 60, steps: [pump('BUY', A, '100')], balances: { [A]: ['0', '100'] }, quote: '1000' },
    { n: 2, at: startS + 120, steps: [pump('SELL', A, '100')], balances: { [A]: ['100', '0'] }, quote: '900' },
    { n: 3, at: startS + 180, steps: [pump('BUY', A, '40')], balances: { [A]: ['0', '40'] }, quote: '400' },
    { n: 4, at: startS + 240, steps: [pump('SELL', A, '40')], balances: { [A]: ['40', '0'] }, quote: '380' },
    { n: 5, at: startS + 300, steps: [pump('BUY', B, '50'), out(B, other, '50')], balances: { [B]: ['0', '0'], [other]: ['5', '55'] }, quote: '500' },
    { n: 6, at: startS + 360, steps: [{ init: C }, pump('BUY', C, '70')], balances: { [C]: [null, '70'] }, quote: '700' },
    { n: 9, at: startS + 540, steps: [pump('SELL', C, '70'), { close: C }], balances: { [C]: ['70', null] }, quote: '650' },
  ];
  const extras: Tx[] = [
    { n: 7, at: startS + 420, steps: [out(C, other, '30')], balances: { [C]: ['70', '40'], [other]: ['55', '85'] } },
    { n: 8, at: startS + 480, steps: [out(other, C, '30')], balances: { [C]: ['40', '70'], [other]: ['85', '55'] } },
  ];
  mutate(extras, pools); return scenario(pools, extras);
};
const status = (h: WindowAccountHistory, account: string) => h.accounts.find(a => a.account === account)!;

test('complete trader-account legs certify repeated round trips, pass-throughs and trade/transfer motifs', async () => {
  const x = rich(), collected = await x.collect(), history = collected.data;
  assert.equal(history.complete, true); assert.equal(history.population, 3); assert.equal(history.reasonCode, 'TRADER_ACCOUNT_LEGS_OBSERVED');
  // Three index pages plus only the two receipts the window did not already retain.
  assert.deepEqual(x.calls.map(c => c.method), ['getSignaturesForAddress', 'getSignaturesForAddress', 'getSignaturesForAddress', 'getTransaction', 'getTransaction']);
  assert.deepEqual(x.calls.filter(c => c.method === 'getTransaction').map(c => c.params[0]), [sig(8), sig(7)]);
  assert.deepEqual(x.calls[0]!.params, [[A, B, C].sort()[0], { commitment: 'finalized', limit: 32, minContextSlot: anchorSlot }]);
  assert.deepEqual(decodeAdvisoryWindowAccounts(token, x.window, x.windowReceipts, collected.rawArtifacts, collected.retrievedAt, collected.requests, cutoff), history);
  assert.deepEqual(status(history, B).legs.map(l => [l.kind, l.amountAtomic]), [['POOL_BUY', '50'], ['TRANSFER_OUT', '50']]);
  assert.deepEqual(status(history, C).transactions.map(t => [t.preAtomic, t.postAtomic, t.lifecycle, t.receipt]), [['0', '70', ['INITIALIZED'], 'WINDOW'], ['70', '40', [], 'ACCOUNTS'], ['40', '70', [], 'ACCOUNTS'], ['70', '0', ['CLOSED'], 'WINDOW']]);
  const metric = deriveO26Window(history, x.window, ['w', 'a'])!, data = metric.data as any;
  assert.equal(metric.quality, 'KNOWN'); assert.equal(metric.reasonCode, 'SELECTED_WINDOW_INVENTORY_RETURNS_OBSERVED'); assert.deepEqual(metric.evidenceIds, ['w', 'a']);
  assert.equal(data.motifCount, 3); assert.deepEqual(data.repeatedAccounts, [A]); assert.equal(data.repeatedMotifCount, 2);
  assert.equal(data.passThroughReturns, 1); assert.equal(data.singleSidePoolReturns, 1); assert.equal(data.transferOnlyReturns, 0); assert.equal(data.openAccounts, 0);
  const c = data.motifs.find((m: any) => m.account === C);
  assert.equal(c.legs, 4); assert.equal(c.transferLegs, 2); assert.equal(c.transferOutBaseAtomic, '30'); assert.equal(c.grossQuoteAtomic, '1350'); assert.equal(c.netQuoteAtomic, '-50');
  assert.deepEqual(c.signatures, [sig(6), sig(7), sig(8), sig(9)]);
  assert.equal(data.motifGrossQuoteAtomic, '4030'); assert.equal(data.repeatedMotifGrossQuoteAtomic, '2680'); assert.equal(data.coveredTradeGrossQuoteAtomic, '4530');
  assert.equal(data.motifQuoteShare, '0.88962472406181015453');
});

test('an incomplete or older-basis window issues no account reads and leaves the bounded O26 in place', async () => {
  for (const options of [{ complete: false }, { method: 'pumpswap-selected-pool-window-v2' as const }]) {
    const x = scenario([{ n: 1, at: startS + 60, steps: [pump('BUY', A, '100')], balances: { [A]: ['0', '100'] } }], [], () => [], options), collected = await x.collect();
    assert.equal(x.calls.length, 0); assert.equal(collected.data.complete, false); assert.equal(collected.data.population, 0);
    if (options.complete === false) assert.equal(deriveO26Window(collected.data, x.window, []), null);
    else assert.equal(deriveO26Window(collected.data, x.window, [])?.quality, 'MISSING');
  }
});

test('a complete empty window is a known zero-motif population', async () => {
  const x = scenario([]), collected = await x.collect(), metric = deriveO26Window(collected.data, x.window, [])!;
  assert.equal(x.calls.length, 0); assert.equal(metric.quality, 'KNOWN'); assert.equal((metric.data as any).motifCount, 0); assert.equal((metric.data as any).motifQuoteShare, null);
});

test('unreconciled, discontinuous, unbound and unsupported legs leave only that account incomplete', async () => {
  const unparsed = (c: Awaited<ReturnType<ReturnType<typeof rich>['collect']>>) => {
    const id = Object.entries(c.requests).find(([, r]) => r.method === 'getTransaction' && r.params[0] === sig(7))![0], raw = JSON.parse(c.rawArtifacts[id]!);
    raw.result.transaction.message.instructions = [{ programId: T22, accounts: [C, other], data: '3Bxs', stackHeight: 1 }]; c.rawArtifacts[id] = JSON.stringify(raw);
  };
  const cases: Array<[string, (extras: Tx[], pools: Tx[]) => void, typeof unparsed?]> = [
    ['ADVISORY_ACCOUNTS_BALANCE_UNRECONCILED', e => { e[0]!.balances[C] = [null, '40']; }],
    ['ADVISORY_ACCOUNTS_BALANCE_UNRECONCILED', e => { e[0]!.balances[C] = ['70', '41']; }],
    ['ADVISORY_ACCOUNTS_CONTINUITY', e => { e[1]!.balances[C] = ['41', '71']; }],
    ['ADVISORY_ACCOUNTS_UNBOUND_POOL_LEG', e => { e[1]!.steps = [out(vault, C, '30')]; }],
    ['ADVISORY_ACCOUNTS_UNSUPPORTED_INSTRUCTION', e => { e[0]!.steps.push({ parsed: { type: 'transferCheckedWithFee', info: { source: C, destination: other, mint: token.address, tokenAmount: { amount: '0' } } } }); }],
    ['ADVISORY_ACCOUNTS_UNPARSED_TOKEN_INSTRUCTION', () => {}, unparsed],
    ['ADVISORY_ACCOUNTS_LIFECYCLE', (_e, p) => { p[5]!.steps.push({ init: C }); }],
  ];
  for (const [code, mutate, raw] of cases) {
    const x = rich(mutate), collected = await x.collect();
    raw?.(collected);
    const history = raw ? x.decode(collected) : collected.data;
    assert.equal(history.complete, false, code); assert.equal(status(history, C).status, 'INVALID', code); assert.equal(status(history, C).code, code);
    assert.equal(status(history, A).status, 'OBSERVED'); assert.equal(status(history, C).legs.length, 0);
    const metric = deriveO26Window(history, x.window, [])!;
    assert.equal(metric.quality, 'TRUNCATED', code); assert.equal((metric.data as any).coveredAccounts, 2); assert.equal((metric.data as any).motifCount, 2); assert.equal((metric.data as any).motifQuoteShare, null);
  }
  // A first transaction whose legs would reconcile from zero still needs an explicit creation proof.
  const unproven = (await scenario([{ n: 1, at: startS + 60, steps: [pump('BUY', A, '100')], balances: { [A]: [null, '100'] } }, { n: 2, at: startS + 120, steps: [pump('SELL', A, '100')], balances: { [A]: ['100', '0'] } }]).collect()).data;
  assert.equal(status(unproven, A).code, 'ADVISORY_ACCOUNTS_BALANCE_UNRECONCILED'); assert.equal(unproven.complete, false);
});

test('failed indexed transactions are excluded and need no receipt; ambiguous same-slot order fails closed', async () => {
  const failed = rich(e => { e.push({ n: 10, slot: 1085, at: startS + 500, steps: [out(C, other, '999')], balances: { [C]: ['40', '0'] }, err: { InstructionError: [0, 'Custom'] } }); });
  const collected = await failed.collect();
  assert.equal(collected.data.complete, true); assert.ok(!failed.calls.some(c => c.method === 'getTransaction' && c.params[0] === sig(10)));
  const sameSlot = (index: [number | null, number | null]) => scenario([{ n: 1, slot: 2000, at: startS + 60, steps: [pump('BUY', A, '100')], balances: { [A]: ['0', '100'] }, index: index[0] }], [{ n: 2, slot: 2000, at: startS + 60, steps: [out(A, other, '100')], balances: { [A]: ['100', '0'] }, index: index[1] }]);
  const ordered = await sameSlot([4, 7]).collect(); assert.equal(ordered.data.complete, true);
  assert.deepEqual(status(ordered.data, A).legs.map(l => l.kind), ['POOL_BUY', 'TRANSFER_OUT']);
  const ambiguous = await sameSlot([null, null]).collect(); assert.equal(status(ambiguous.data, A).code, 'ADVISORY_ACCOUNTS_ORDER_AMBIGUOUS');
});

test('null clocks, page caps and receipt caps remain truncated without exceeding 64 receipts', async () => {
  const withNull = scenario([{ n: 1, at: startS + 60, steps: [pump('BUY', A, '100')], balances: { [A]: ['0', '100'] } }], [], () => [[row({ n: 50, at: null, slot: 5000 }), row({ n: 1, at: startS + 60 }), row({ n: 51, at: startS - 1, slot: 500 })]]);
  const nulled = (await withNull.collect()).data; assert.equal(status(nulled, A).status, 'TRUNCATED'); assert.equal(status(nulled, A).code, 'ADVISORY_ACCOUNTS_NULL_CLOCK');
  assert.equal(deriveO26Window(nulled, withNull.window, [])!.quality, 'MISSING');
  const later = Array.from({ length: 4 }, (_, p) => Array.from({ length: 32 }, (_, i) => row({ n: 200 + p * 32 + i, at: endS + 300 - p * 32 - i, slot: 100_000 - p * 32 - i })));
  const capped = scenario([{ n: 1, at: startS + 60, steps: [pump('BUY', A, '100')], balances: { [A]: ['0', '100'] } }], [], () => later), cappedHistory = (await capped.collect()).data;
  assert.equal(capped.calls.length, 4); assert.equal(status(cappedHistory, A).code, 'ADVISORY_ACCOUNTS_PAGE_CAP'); assert.equal(cappedHistory.complete, false);
  const account = (i: number) => { const b = Buffer.alloc(32, 77); b.writeUInt16LE(i + 1); return encodeSolanaAddress(b); };
  const many: Tx[] = Array.from({ length: ACCOUNT_RECEIPT_CAP + 1 }, (_, i) => ({ n: i + 1, at: startS + 10 + i, steps: [pump('BUY', account(i), '10')], balances: { [account(i)]: ['0', '10'] } }));
  const big = scenario(many), bigHistory = (await big.collect()).data;
  assert.equal(big.calls.length, ACCOUNT_RECEIPT_CAP); assert.equal(bigHistory.population, ACCOUNT_RECEIPT_CAP + 1); assert.equal(bigHistory.complete, false);
  assert.equal(bigHistory.accounts.filter(a => a.status === 'TRUNCATED' && a.code === 'ADVISORY_ACCOUNTS_PAGE_MISSING').length, 1);
  assert.equal(deriveO26Window(bigHistory, big.window, [])!.quality, 'TRUNCATED');
});

test('forged requests, late or early clocks and unused receipts cannot certify coverage', async () => {
  const x = rich(), collected = await x.collect();
  const pageId = `account-${[A, B, C].sort().indexOf(A)}-page-0`, txId = 'account-transaction-0';
  const variant = (change: (c: typeof collected) => void) => { const c = structuredClone(collected); change(c); return c; };
  assert.equal(status(x.decode(variant(c => { (c.requests[pageId]!.params[1] as any).minContextSlot = anchorSlot - 1; })), A).code, 'ADVISORY_ACCOUNTS_REQUEST');
  assert.equal(status(x.decode(variant(c => { c.requests[pageId]!.params[0] = other; })), A).code, 'ADVISORY_ACCOUNTS_REQUEST');
  assert.equal(status(x.decode(variant(c => { c.retrievedAt[pageId] = '2026-10-11T17:00:00.000Z'; })), A).code, 'ADVISORY_ACCOUNTS_RECEIPT_TIME');
  assert.equal(status(x.decode(variant(c => { c.retrievedAt[pageId] = '2026-10-11T15:59:00.000Z'; })), A).code, 'ADVISORY_ACCOUNTS_PAGE_TIME');
  assert.equal(status(x.decode(variant(c => { const raw = JSON.parse(c.rawArtifacts[txId]!); raw.result.slot += 1; c.rawArtifacts[txId] = JSON.stringify(raw); })), C).code, 'ADVISORY_ACCOUNTS_TRANSACTION_BINDING');
  const unavailable = status(x.decode(variant(c => { c.rawArtifacts[txId] = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 'RPC_TIMEOUT' } }); })), C);
  assert.equal(unavailable.status, 'UNAVAILABLE'); assert.equal(unavailable.code, 'RPC_TIMEOUT');
  assert.throws(() => x.decode(variant(c => { c.requests['account-transaction-9'] = getTransaction(sig(99)); c.rawArtifacts['account-transaction-9'] = '{}'; c.retrievedAt['account-transaction-9'] = cutoff; })), /ADVISORY_ACCOUNTS_RECEIPT_MEMBERSHIP/);
  assert.throws(() => x.decode(variant(c => { delete c.retrievedAt[pageId]; })), /ADVISORY_ACCOUNTS_RECEIPT_MEMBERSHIP/);
  assert.throws(() => x.decode(collected, '2026-10-11T15:30:00.000Z'), /ADVISORY_ACCOUNTS_SCOPE/);
  const removed = x.decode(variant(c => { delete c.requests[pageId]; delete c.rawArtifacts[pageId]; delete c.retrievedAt[pageId]; }));
  assert.equal(status(removed, A).status, 'TRUNCATED'); assert.equal(status(removed, A).code, 'ADVISORY_ACCOUNTS_PAGE_MISSING');
  assert.notEqual(deriveO26Window(removed, x.window, [])!.quality, 'KNOWN');
});

test('trade legs must bind exactly once and every bound trade must appear in its account index', async () => {
  const x = scenario([{ n: 1, at: startS + 60, steps: [pump('BUY', A, '100')], balances: { [A]: ['0', '100'] } }]);
  x.window.trades[0]!.baseAtomic = '99';
  const unbound = await x.collect(); assert.equal(x.calls.length, 0); assert.equal(unbound.data.reasonCode, 'ADVISORY_ACCOUNTS_TRADE_BINDING');
  assert.equal(deriveO26Window(unbound.data, x.window, [])!.quality, 'MISSING');
  const missingRow = scenario([{ n: 1, at: startS + 60, steps: [pump('BUY', A, '100')], balances: { [A]: ['0', '100'] } }], [], () => [[row({ n: 77, at: startS - 1 })]]);
  const history = (await missingRow.collect()).data; assert.equal(status(history, A).code, 'ADVISORY_ACCOUNTS_INDEX_INCONSISTENT');
});


function caughtBranch(value: any, failedAncestor: boolean) {
  const parent = key(70), child = key(71), index = value.transaction.message.instructions.length;
  value.transaction.message.instructions.push({ programId: parent, accounts: [C, other], data: '3Bxs', stackHeight: 1 });
  const outbound = leg(C, other, '30', failedAncestor ? 3 : 2), inbound = leg(other, C, '30', failedAncestor ? 3 : 2);
  value.meta.innerInstructions.push({ index, instructions: failedAncestor
    ? [{ programId: child, accounts: [C, other], data: '3Bxs', stackHeight: 2 }, outbound, inbound]
    : [outbound, inbound] });
  value.meta.logMessages.push(`Program ${parent} invoke [1]`, ...(failedAncestor ? [
    `Program ${child} invoke [2]`, `Program ${T22} invoke [3]`, `Program ${T22} success`,
    `Program ${T22} invoke [3]`, `Program ${T22} success`, `Program ${child} failed: custom program error: 0x1`,
  ] : [
    `Program ${T22} invoke [2]`, `Program ${T22} failed: custom program error: 0x1`,
    `Program ${T22} invoke [2]`, `Program ${T22} failed: custom program error: 0x1`,
  ]), `Program ${parent} success`);
}

test('caught failed token CPIs and successful descendants of a failed ancestor supply no inventory legs', async () => {
  for (const failedAncestor of [false, true]) {
    const x = rich(extras => { extras[0]!.mutateReceipt = value => caughtBranch(value, failedAncestor); });
    const collected = await x.collect(), metric = deriveO26Window(collected.data, x.window, [])!;
    assert.equal(collected.data.complete, true); assert.equal(metric.quality, 'KNOWN');
    const history = status(collected.data, C);
    assert.deepEqual(history.legs.map(l => [l.kind, l.amountAtomic]), [['POOL_BUY', '70'], ['TRANSFER_OUT', '30'], ['TRANSFER_IN', '30'], ['POOL_SELL', '70']]);
    const motif = (metric.data as any).motifs.find((m: any) => m.account === C);
    assert.equal(motif.transferOutBaseAtomic, '30'); assert.equal(motif.transferInBaseAtomic, '30');
    assert.equal(motif.legs, 4); assert.equal(motif.transferLegs, 2);
  }
});

test('missing, truncated or inconsistent invocation logs cannot certify account coverage', async () => {
  const variants: Array<[string, (value: any) => void]> = [
    ['missing', value => { value.meta.logMessages = null; }],
    ['empty', value => { value.meta.logMessages = []; }],
    ['truncated', value => { value.meta.logMessages.pop(); }],
    ['truncation marker', value => { value.meta.logMessages.push('Log truncated'); }],
    ['wrong program', value => { value.meta.logMessages[0] = `Program ${other} invoke [1]`; }],
    ['wrong depth', value => { value.meta.logMessages[0] = `Program ${T22} invoke [2]`; }],
    ['wrong outcome program', value => { value.meta.logMessages[1] = `Program ${other} success`; }],
    ['missing inner invocation', value => { caughtBranch(value, true); value.meta.logMessages.splice(3, 2); }],
    ['extra invocation', value => { value.meta.logMessages.push(`Program ${other} invoke [1]`, `Program ${other} success`); }],
  ];
  for (const [name, mutate] of variants) {
    const x = rich(extras => { extras[0]!.mutateReceipt = mutate; }), collected = await x.collect();
    assert.equal(collected.data.complete, false, name); assert.equal(status(collected.data, C).status, 'INVALID', name);
    assert.match(status(collected.data, C).code!, /^ADVISORY_ACCOUNTS_LOG_/, name);
    assert.equal(status(collected.data, C).legs.length, 0, name);
    assert.equal(status(collected.data, A).status, 'OBSERVED', name);
    assert.equal(deriveO26Window(collected.data, x.window, [])!.quality, 'TRUNCATED', name);
  }
});

test('failed pool-token branches keep original instruction positions for the subsequent successful base leg', async () => {
  const x = rich((_extras, pools) => {
    pools[0]!.mutateReceipt = value => {
      const group = value.meta.innerInstructions[0];
      group.instructions.unshift(leg(vault, A, '100', 2));
      value.meta.logMessages.splice(1, 0, `Program ${T22} invoke [2]`, `Program ${T22} failed: custom program error: 0x1`);
    };
  });
  const collected = await x.collect(); assert.equal(collected.data.complete, true);
  const history = status(collected.data, A); assert.equal(history.legs[0]!.order, 2); assert.equal(history.legs[0]!.trade, 0);
  assert.equal(deriveO26Window(collected.data, x.window, [])!.quality, 'KNOWN');
});
