import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { OFFLINE_PUMP_AMM_PROGRAM as sdk, PUMP_AMM_PROGRAM_ID, poolPda } from '@pump-fun/pump-swap-sdk';
import { archiveDemandReceipt } from '../src/providers/advisory-demand-windows.js';
import { archiveAdvisoryWindowReceipts, collectAdvisoryWindow, decodeAdvisoryWindow, deriveO28Window, unpackAdvisoryWindowReceipts, WINDOW_ARCHIVE_ADAPTER,
  WINDOW_DENSE_MAX_PAGES, WINDOW_DENSE_PAGE_LIMIT, WINDOW_DENSE_REQUEST_CAP, WINDOW_DENSE_STORED_BYTES, WINDOW_DENSE_TRANSACTION_CAP, WINDOW_RESPONSE_BYTES } from '../src/providers/advisory-window.js';
import { encodeSolanaAddress, SOLANA_MAINNET_GENESIS } from '../src/providers/solana.js';

type Row = { signature: string; slot: number; blockTime: number | null; err: unknown; confirmationStatus: string };
type RpcRequest = { method: string; params: any[] };
type Clock = { end: string; cutoff: string; anchorSlot: number; anchorTime: number };
const token = { chain: 'solana' as const, address: '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump' };
const user = new PublicKey(Buffer.alloc(32, 4)), baseVault = new PublicKey(Buffer.alloc(32, 5)), quoteVault = new PublicKey(Buffer.alloc(32, 6));
const creator = new PublicKey(Buffer.alloc(32, 7)), program = PUMP_AMM_PROGRAM_ID.toBase58();
const pool = poolPda(0, creator, new PublicKey(token.address), NATIVE_MINT).toBase58();
const SYNTHETIC: Clock = { end: '2026-10-11T12:00:00.000Z', cutoff: '2026-10-11T12:01:00.000Z', anchorSlot: 1_000_001, anchorTime: Date.parse('2026-10-11T12:00:30.000Z') / 1000 };
const endS = Date.parse(SYNTHETIC.end) / 1000, startS = endS - 3600, FAILED = { InstructionError: [0, 'Custom'] };
// Genuine finalized public getSignaturesForAddress limit:256 envelope captured separately from the old snapshot (root: 61,048 bytes, 2.82 s).
// Its original request/pool are not stored with the fixture; the mock serves these exact bytes for the dense first-page request of the
// synthetic bound pool below. Transaction bodies served for its signatures are CONSTRUCTED test bodies, never token evidence.
const REAL_INDEX = readFileSync('tests/fixtures/o28-dense-index-256.json', 'utf8').replace(/\n$/, '');
const REAL_ROWS = (JSON.parse(REAL_INDEX) as { result: Row[] }).result;
const REAL: Clock = { end: '2026-10-12T11:00:00.000Z', cutoff: '2026-10-12T13:05:00.000Z', anchorSlot: 456_056_300, anchorTime: Date.parse('2026-10-12T13:03:20.000Z') / 1000 };

const sig = (id: number) => { const bytes = Buffer.alloc(64, 8); bytes.writeUInt32LE(id); return encodeSolanaAddress(bytes); };
const row = (id: number, blockTime: number | null, err: unknown = null): Row => ({ signature: sig(id), slot: 1_000_000 - id, blockTime, err, confirmationStatus: 'finalized' });
const noise = (seed: number, bytes: number) => { const parts: Buffer[] = []; let h = createHash('sha256').update(String(seed)).digest(); for (let n = 0; n < bytes; n += 32) { parts.push(h); h = createHash('sha256').update(h).digest(); } return Buffer.concat(parts).subarray(0, bytes).toString('base64'); };
function defaults(name: string): any {
  const type = sdk.idl.types!.find(t => t.name === name)!;
  const result: Record<string, unknown> = {};
  for (const f of (type.type as any).fields) result[f.name] = f.type === 'pubkey' ? user : f.type === 'bool' ? false : f.type === 'string' ? 'buy' : f.type === 'u8' || f.type === 'u16' ? 0 : new BN(0);
  return result;
}
/** CONSTRUCTED zero-fee BUY bound to a reference's signature/slot/clock; exercises binding and decoding mechanics only. */
function swap(reference: Row, quote = '1000'): any {
  const event = { ...defaults('buyEvent'), timestamp: new BN(reference.blockTime!), pool: new PublicKey(pool), user,
    userBaseTokenAccount: baseVault, userQuoteTokenAccount: quoteVault, poolBaseTokenReserves: new BN(100000), poolQuoteTokenReserves: new BN(1000000),
    baseAmountOut: new BN(500), quoteAmountIn: new BN(quote), quoteAmountInWithLpFee: new BN(quote), userQuoteAmountIn: new BN(quote) };
  const payload = Buffer.concat([Buffer.from(sdk.idl.events!.find(x => x.name === 'buyEvent')!.discriminator), sdk.coder.types.encode('buyEvent', event)]).toString('base64');
  const data = sdk.coder.instruction.encode('buy', { baseAmountOut: new BN(500), maxQuoteAmountIn: new BN(quote), trackVolume: { 0: true } });
  const accounts = [pool, user.toBase58(), user.toBase58(), token.address, NATIVE_MINT.toBase58(), baseVault.toBase58(), quoteVault.toBase58(), baseVault.toBase58(), quoteVault.toBase58(), user.toBase58(), user.toBase58(), user.toBase58(), user.toBase58(), user.toBase58(), user.toBase58(), user.toBase58(), program];
  return { version: 1, slot: reference.slot, blockTime: reference.blockTime, transaction: { signatures: [reference.signature], message: {
    accountKeys: [...new Set(accounts)].map(pubkey => ({ pubkey, signer: pubkey === user.toBase58() })), instructions: [{ programId: program, accounts, data: encodeSolanaAddress(data) }] } },
    meta: { err: null, preTokenBalances: [], postTokenBalances: [], innerInstructions: [], logMessages: [`Program ${program} invoke [1]`, `Program data: ${payload}`, `Program ${program} success`] } };
}
type Options = { clock?: Clock; raw?: (request: RpcRequest, page: number) => string | undefined; bodies?: Map<string, any>; delay?: number; dense?: boolean };
async function harness(pages: Row[][], options: Options = {}) {
  const clock = options.clock ?? SYNTHETIC, dense = options.dense ?? true, calls: RpcRequest[] = [], flight = { now: 0, max: 0 };
  const poolData = await sdk.coder.accounts.encode('pool', { ...defaults('pool'), creator, baseMint: new PublicKey(token.address), quoteMint: NATIVE_MINT, poolBaseTokenAccount: baseVault, poolQuoteTokenAccount: quoteVault });
  const fetcher: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as RpcRequest; calls.push(request);
    flight.now++; flight.max = Math.max(flight.max, flight.now);
    try {
      if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
      let result: any;
      if (request.method === 'getGenesisHash') result = SOLANA_MAINNET_GENESIS;
      else if (request.method === 'getSlot') result = clock.anchorSlot;
      else if (request.method === 'getBlockTime') result = clock.anchorTime;
      else if (request.method === 'getSignaturesForAddress') {
        const before = request.params[1].before as string | undefined, index = before ? pages.findIndex(p => p.at(-1)?.signature === before) + 1 : 0;
        const raw = options.raw?.(request, index); if (raw !== undefined) return new Response(raw);
        result = structuredClone(pages[index] ?? []);
      } else if (request.method === 'getTransaction') {
        const reference = pages.flat().find(r => r.signature === request.params[0])!;
        result = options.bodies?.has(reference.signature) ? structuredClone(options.bodies.get(reference.signature)) : swap(reference);
      } else if (request.method === 'getAccountInfo') result = { context: { slot: clock.anchorSlot }, value: { owner: program, executable: false, data: [poolData.toString('base64'), 'base64'] } };
      else throw new Error(`Unexpected request ${request.method}`);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    } finally { flight.now--; }
  };
  const collected = await collectAdvisoryWindow(token, pool, 'https://rpc.example', fetcher, () => clock.cutoff, clock.end, undefined, undefined, true, true, dense);
  const decode = (asDense = dense) => decodeAdvisoryWindow(token, pool, clock.end, collected.rawArtifacts, collected.retrievedAt, collected.requests, clock.cutoff, true, true, asDense);
  const count = (method: string) => calls.filter(r => r.method === method).length;
  return { collected, decode, calls, count, flight, fetcher };
}
function assertNotKnown(decode: () => ReturnType<typeof decodeAdvisoryWindow>) {
  let history: ReturnType<typeof decodeAdvisoryWindow>;
  try { history = decode(); } catch (error) { assert.match(String(error), /ADVISORY_WINDOW_/); return; }
  assert.equal(history.complete, false); assert.notEqual(deriveO28Window(history, []).quality, 'KNOWN');
}
function assertStoppedBeforeReads(x: Awaited<ReturnType<typeof harness>>, code: string) {
  const history = x.decode();
  assert.equal(x.count('getTransaction'), 0); assert.equal(x.count('getAccountInfo'), 0);
  assert.equal(history.reasonCode, code); assert.equal(history.acquisition!.stopCode, code);
  assert.equal(history.complete, false); assert.equal(deriveO28Window(history, []).quality, 'MISSING');
  return history;
}

test('dense bounds are the corrected 256x4 / 64 / 72 / 500 KB / 1.25 MB contract', () => {
  assert.deepEqual([WINDOW_DENSE_PAGE_LIMIT, WINDOW_DENSE_MAX_PAGES, WINDOW_DENSE_TRANSACTION_CAP, WINDOW_DENSE_REQUEST_CAP, WINDOW_RESPONSE_BYTES, WINDOW_DENSE_STORED_BYTES, WINDOW_ARCHIVE_ADAPTER],
    [256, 4, 64, 72, 500_000, 1_250_000, 'window-archive-v1']);
});

test('genuine finalized 256-row index: 120/48/72 census, row-205 witness, one page plans exactly 48 reads', async () => {
  assert.equal(Buffer.byteLength(REAL_INDEX), 61_047); assert.equal(REAL_ROWS.length, 256);
  const end = Date.parse(REAL.end) / 1000, start = end - 3600, inHour = REAL_ROWS.filter(r => r.blockTime! >= start && r.blockTime! < end);
  const successful = inHour.filter(r => r.err === null), witness = REAL_ROWS.findIndex(r => r.blockTime! < start);
  assert.ok(REAL_ROWS.every(r => r.blockTime !== null && r.confirmationStatus === 'finalized'));
  assert.equal(inHour.length, 120); assert.equal(successful.length, 48); assert.equal(inHour.length - successful.length, 72);
  assert.equal(REAL_ROWS.filter(r => r.blockTime! >= end).length, 84); assert.equal(witness + 1, 205);
  // Both v3 blockers on these real rows: 4x32 rows end before the witness and 48 successes exceed its 40-read cap.
  assert.ok(witness >= 4 * 32); assert.ok(successful.length > 40);
  const x = await harness([REAL_ROWS], { clock: REAL, raw: (request, page) => {
    assert.equal(page, 0); assert.deepEqual(request.params, [pool, { commitment: 'finalized', limit: 256, minContextSlot: REAL.anchorSlot }]); return REAL_INDEX; } });
  assert.equal(x.collected.rawArtifacts['window-page-0'], REAL_INDEX);
  assert.equal(x.count('getSignaturesForAddress'), 1); assert.equal(x.count('getTransaction'), 48); assert.equal(x.count('getAccountInfo'), 1);
  assert.equal(x.calls.length, 3 + 1 + 48 + 1); assert.equal(x.calls.at(-1)!.method, 'getAccountInfo');
  successful.forEach((r, i) => assert.deepEqual(x.collected.requests[`window-transaction-${i}`]!.params, [r.signature, { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }]));
  const history = x.decode();
  assert.equal(history.method, 'pumpswap-selected-pool-window-v3'); assert.equal(history.coverageReachedStart, true); assert.equal(history.indexComplete, true);
  assert.equal(history.successfulSignatures, 48); assert.equal(history.failedReferences, 72); assert.equal(history.transactions.length, 48);
  assert.deepEqual(history.pages.map(p => [p.returned, p.exhausted, p.status]), [[256, false, 'OBSERVED']]);
  assert.deepEqual(history.acquisition, { version: 'window-dense-v1', pageLimit: 256, maxPages: 4, transactionCap: 64, requestCap: 72, responseBytes: 500_000, storedBytesCap: 1_250_000,
    indexedReferences: 256, newerReferences: 84, witnessRow: 205, stopCode: null });
  // Archive keeps the genuine bytes reversible; constructed transaction bodies are not claimed as token evidence.
  const archived = archiveAdvisoryWindowReceipts(x.collected), container = JSON.parse(archived.rawArtifacts['window-page-0']!);
  assert.equal(container.sourceBytes, Buffer.byteLength(REAL_INDEX)); assert.equal(container.sourceHash, createHash('sha256').update(REAL_INDEX).digest('hex'));
  assert.equal(unpackAdvisoryWindowReceipts(archived).rawArtifacts['window-page-0'], REAL_INDEX); assert.ok(archived.storage.storedBytes <= WINDOW_DENSE_STORED_BYTES);
});

test('worst admitted hour uses exactly the 72-request allowance with at most two transactions in flight', async () => {
  const refs = Array.from({ length: 3 * 256 + 64 }, (_, i) => row(i + 1, endS - 1 - Math.floor(i / 4), i < 768 ? FAILED : null));
  const pages = [refs.slice(0, 256), refs.slice(256, 512), refs.slice(512, 768), [...refs.slice(768), row(5000, startS - 1)]];
  const x = await harness(pages, { delay: 2 });
  assert.equal(x.calls.length, WINDOW_DENSE_REQUEST_CAP); assert.equal(x.count('getSignaturesForAddress'), 4); assert.equal(x.count('getTransaction'), 64);
  assert.equal(x.flight.max, 2); assert.equal(Object.keys(x.collected.rawArtifacts).length, 72);
  const pageCalls = x.calls.filter(r => r.method === 'getSignaturesForAddress');
  for (let i = 1; i < 4; i++) assert.deepEqual(pageCalls[i]!.params, [pool, { commitment: 'finalized', limit: 256, minContextSlot: SYNTHETIC.anchorSlot, before: pages[i - 1]!.at(-1)!.signature }]);
  const history = x.decode(); // synthetic index and constructed bodies: mechanism check only
  assert.equal(history.complete, true); assert.equal(history.acquisition!.witnessRow, 833); assert.equal(history.successfulSignatures, 64);
});

test('65 successful references stop before any transaction or pool read while 64 proceed', async () => {
  for (const n of [64, 65]) {
    const x = await harness([[...Array.from({ length: n }, (_, i) => row(i + 1, endS - 1 - i)), row(999, startS - 1)]]);
    if (n === 64) { assert.equal(x.count('getTransaction'), 64); assert.equal(x.decode().complete, true); continue; }
    const history = assertStoppedBeforeReads(x, 'ADVISORY_WINDOW_TRANSACTION_CAP');
    assert.equal(history.successfulSignatures, 65); assert.ok(history.limitations.some(l => l.includes('cap of 64 exceeded')));
    // Replay admits no transaction or pool receipt after a dense early stop.
    const forged = structuredClone(x.collected); forged.rawArtifacts['window-pool'] = '{}'; forged.requests['window-pool'] = { method: 'getAccountInfo', params: [] }; forged.retrievedAt['window-pool'] = SYNTHETIC.cutoff;
    assert.throws(() => decodeAdvisoryWindow(token, pool, SYNTHETIC.end, forged.rawArtifacts, forged.retrievedAt, forged.requests, SYNTHETIC.cutoff, true, true, true), /ADVISORY_WINDOW_RECEIPT_MEMBERSHIP/);
  }
});

test('1,024 references without an older witness stop at the page cap', async () => {
  const refs = Array.from({ length: 1024 }, (_, i) => row(i + 1, endS - 1 - Math.floor(i / 2), FAILED));
  const x = await harness([0, 1, 2, 3].map(p => refs.slice(p * 256, p * 256 + 256)));
  assert.equal(x.count('getSignaturesForAddress'), 4);
  const history = assertStoppedBeforeReads(x, 'ADVISORY_WINDOW_PAGE_CAP');
  assert.equal(history.coverageReachedStart, false); assert.equal(history.acquisition!.indexedReferences, 1024); assert.equal(history.acquisition!.witnessRow, null);
});

test('null clocks, malformed rows and remote page errors stop before transactions', async () => {
  const nullClock = await harness([[row(1, endS - 1), row(2, null), row(3, startS - 1)]]);
  assert.equal(assertStoppedBeforeReads(nullClock, 'ADVISORY_WINDOW_NULL_CLOCK').pages[0]!.status, 'TRUNCATED');
  const remote = await harness([[row(1, endS - 1)]], { raw: () => JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'busy' } }) });
  assert.equal(assertStoppedBeforeReads(remote, 'RPC_REMOTE_-32005').pages[0]!.status, 'UNAVAILABLE');
  await assertStoppedBeforeReads(await harness([Array.from({ length: 257 }, (_, i) => row(i + 1, endS - 1, FAILED))]), 'ADVISORY_WINDOW_PAGE_SHAPE');
  await assertStoppedBeforeReads(await harness([[{ ...row(1, endS - 1), signature: `1${sig(1)}` }, row(2, startS - 1)]]), 'ADVISORY_WINDOW_PAGE_SHAPE');
});

test('every dense response stays under the unchanged 500,000-byte per-call limit', async () => {
  const page = (memo: number) => Array.from({ length: 256 }, (_, i) => ({ ...row(i + 1, endS - 1 - Math.floor(i / 4), FAILED), memo: 'x'.repeat(memo) }));
  const body = (rows: Row[]) => JSON.stringify({ jsonrpc: '2.0', id: 1, result: rows });
  const small = page(1700), large = page(2000);
  assert.ok(Buffer.byteLength(body(small)) < WINDOW_RESPONSE_BYTES); assert.ok(Buffer.byteLength(body(large)) > WINDOW_RESPONSE_BYTES);
  const within = await harness([small], { raw: (_r, i) => i === 0 ? body(small) : undefined });
  assert.deepEqual([within.decode().pages[0]!.status, within.decode().pages[0]!.returned], ['OBSERVED', 256]);
  const over = await harness([large], { raw: (_r, i) => i === 0 ? body(large) : undefined });
  assertStoppedBeforeReads(over, 'RPC_RESPONSE_LIMIT'); assert.ok(!over.collected.rawArtifacts['window-page-0']!.includes('xxxx'));
});

test('storage ceiling mid-collection replaces the overflowing receipts and stops further reads', async () => {
  const refs = Array.from({ length: 6 }, (_, i) => row(i + 1, endS - 1 - i));
  const bodies = new Map(refs.map((r, i) => [r.signature, { ...swap(r), padding: noise(i, 360_000) }]));
  assert.ok(JSON.stringify({ jsonrpc: '2.0', id: 1, result: bodies.get(refs[0]!.signature) }).length < WINDOW_RESPONSE_BYTES);
  const x = await harness([[...refs, row(99, startS - 1)]], { bodies });
  assert.equal(x.count('getTransaction'), 4); assert.equal(x.count('getAccountInfo'), 0);
  for (const i of [0, 1]) assert.ok(!x.collected.rawArtifacts[`window-transaction-${i}`]!.includes('ADVISORY_WINDOW_STORAGE_CAP'));
  for (const i of [2, 3]) assert.ok(x.collected.rawArtifacts[`window-transaction-${i}`]!.includes('ADVISORY_WINDOW_STORAGE_CAP'));
  const history = x.decode();
  assert.equal(history.reasonCode, 'ADVISORY_WINDOW_STORAGE_CAP'); assert.equal(history.acquisition!.stopCode, 'ADVISORY_WINDOW_STORAGE_CAP'); assertNotKnown(x.decode);
  const archived = archiveAdvisoryWindowReceipts(x.collected); assert.ok(archived.storage.storedBytes <= WINDOW_DENSE_STORED_BYTES);
  assert.deepEqual(unpackAdvisoryWindowReceipts(archived).rawArtifacts, x.collected.rawArtifacts);
});

test('archive round trip is byte exact for decoding and every forged or oversized archive fails closed', async () => {
  const x = await harness([[row(1, endS - 10), row(2, endS - 20), row(3, startS - 1)]]), archived = archiveAdvisoryWindowReceipts(x.collected);
  assert.equal(archived.storage.adapterVersion, WINDOW_ARCHIVE_ADAPTER); assert.equal(archived.storage.receipts, Object.keys(x.collected.rawArtifacts).length);
  assert.ok(Object.keys(archived.rawArtifacts).every(k => archived.rawArtifacts[k] !== x.collected.rawArtifacts[k]));
  assert.deepEqual(archived.requests, x.collected.requests); assert.deepEqual(archived.retrievedAt, x.collected.retrievedAt);
  const plain = unpackAdvisoryWindowReceipts(archived);
  assert.deepEqual(plain.rawArtifacts, x.collected.rawArtifacts); assert.deepEqual(plain.storage, archived.storage);
  assert.deepEqual(decodeAdvisoryWindow(token, pool, SYNTHETIC.end, plain.rawArtifacts, plain.retrievedAt, plain.requests, SYNTHETIC.cutoff, true, true, true), x.decode());
  const forge = (key: string, change: (c: any) => void) => { const copy = structuredClone(archived), c = JSON.parse(copy.rawArtifacts[key]!); change(c);
    copy.rawArtifacts[key] = JSON.stringify({ method: c.method, encoding: c.encoding, sourceBytes: c.sourceBytes, sourceHash: c.sourceHash, data: c.data }); return copy; };
  for (const bad of [forge('window-pool', c => { c.sourceHash = '0'.repeat(64); }), forge('window-page-0', c => { c.sourceBytes += 1; }), forge('window-genesis', c => { c.method = 'other'; })])
    assert.throws(() => unpackAdvisoryWindowReceipts(bad), /ADVISORY_WINDOW_ARCHIVE_INVALID/);
  assert.throws(() => unpackAdvisoryWindowReceipts(x.collected), /ADVISORY_WINDOW_ARCHIVE_INVALID/); // plain bodies under the archive adapter
  for (const mutate of [(s: any) => { s.rawArtifacts['window-extra'] = s.rawArtifacts['window-pool']; s.requests['window-extra'] = s.requests['window-pool']; s.retrievedAt['window-extra'] = s.retrievedAt['window-pool']; },
    (s: any) => { delete s.retrievedAt['window-pool']; },
    (s: any) => { s.rawArtifacts['window-transaction-64'] = s.rawArtifacts['window-pool']; s.requests['window-transaction-64'] = s.requests['window-pool']; s.retrievedAt['window-transaction-64'] = s.retrievedAt['window-pool']; }]) {
    const copy = structuredClone(archived); mutate(copy); assert.throws(() => unpackAdvisoryWindowReceipts(copy), /ADVISORY_WINDOW_ARCHIVE_MEMBERSHIP/);
  }
  const heavy = { rawArtifacts: {} as Record<string, string>, retrievedAt: {} as Record<string, string>, requests: {} as Record<string, { method: string; params: unknown[] }> };
  for (let i = 0; i < 3; i++) { const k = `window-transaction-${i}`; heavy.rawArtifacts[k] = JSON.stringify({ jsonrpc: '2.0', id: 1, result: noise(100 + i, 360_000) }); heavy.retrievedAt[k] = SYNTHETIC.cutoff; heavy.requests[k] = { method: 'getTransaction', params: [] }; }
  assert.throws(() => archiveAdvisoryWindowReceipts(heavy), /ADVISORY_WINDOW_STORAGE_CAP/);
  const stored = { ...heavy, rawArtifacts: Object.fromEntries(Object.entries(heavy.rawArtifacts).map(([k, v]) => [k, archiveDemandReceipt(v)])) };
  assert.throws(() => unpackAdvisoryWindowReceipts(stored), /ADVISORY_WINDOW_STORAGE_CAP/);
});

test('legacy v3 path is unchanged by default and isolated from dense receipts', async () => {
  const pages = [[row(1, endS - 10), row(2, startS - 1)]], legacy = await harness(pages, { dense: false }), history = legacy.decode();
  assert.equal(history.complete, true); assert.equal(history.method, 'pumpswap-selected-pool-window-v3'); assert.equal(Object.hasOwn(history, 'acquisition'), false);
  assert.ok(!history.limitations.some(l => l.startsWith('Dense acquisition')));
  assert.deepEqual(legacy.calls.find(r => r.method === 'getSignaturesForAddress')!.params, [pool, { commitment: 'finalized', limit: 32, minContextSlot: SYNTHETIC.anchorSlot }]);
  const implicit = await collectAdvisoryWindow(token, pool, 'https://rpc.example', legacy.fetcher, () => SYNTHETIC.cutoff, SYNTHETIC.end);
  assert.deepEqual(implicit, legacy.collected);
  const dense = await harness(pages);
  assertNotKnown(() => dense.decode(false)); assertNotKnown(() => legacy.decode(true));
  assert.throws(() => decodeAdvisoryWindow(token, pool, SYNTHETIC.end, dense.collected.rawArtifacts, dense.collected.retrievedAt, dense.collected.requests, SYNTHETIC.cutoff, true, false, true), /ADVISORY_WINDOW_DENSE_SCOPE/);
  await assert.rejects(() => collectAdvisoryWindow(token, pool, 'https://rpc.example', dense.fetcher, () => SYNTHETIC.cutoff, SYNTHETIC.end, undefined, undefined, true, false, true), /ADVISORY_WINDOW_DENSE_SCOPE/);
});

test('first live dense-hour snapshot replays its original incomplete v3 evidence', () => {
  const fixture = JSON.parse(readFileSync('tests/fixtures/o28-first-run-window-receipts.json', 'utf8')) as {
    token: typeof token; pool: string; windowEnd: string; cutoff: string;
    items: { id: string; request: RpcRequest; retrievedAt: string; contentHash: string; deflateBase64: string; sourceBytes: number }[];
  };
  const raw: Record<string,string> = {}, times: Record<string,string> = {}, requests: Record<string,RpcRequest> = {};
  for (const item of fixture.items) {
    const key = item.id.slice('advisory-window-'.length);
    assert.ok(item.id.startsWith('advisory-window-'));
    const bytes = inflateSync(Buffer.from(item.deflateBase64, 'base64'));
    assert.equal(bytes.length, item.sourceBytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.contentHash);
    raw[key] = bytes.toString('utf8'); times[key] = item.retrievedAt; requests[key] = item.request;
  }
  assert.equal(fixture.items.length, 38);
  const history = decodeAdvisoryWindow(fixture.token, fixture.pool, fixture.windowEnd, raw, times, requests, fixture.cutoff, true, true);
  const metric = deriveO28Window(history, []);
  assert.equal(history.method, 'pumpswap-selected-pool-window-v3');
  assert.equal(metric.quality, 'TRUNCATED');
  assert.equal(history.coverageReachedStart, false);
  assert.equal(history.indexComplete, false);
  assert.equal(history.successfulSignatures, 30);
  assert.equal(history.failedReferences, 61);
  assert.equal(history.pages.length, 4);
  assert.equal(history.transactions.length, 30);
  assert.equal(Object.hasOwn(history, 'acquisition'), false);
});
