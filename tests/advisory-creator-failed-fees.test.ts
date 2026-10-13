import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { DEMAND_ARCHIVE_METHOD } from '../src/providers/advisory-demand-windows.js';
import { classifyCreatorFailedFees, archiveCreatorFailedFeeReceipt, unpackCreatorFailedFeeReceipt, failedFeeRequest, failedFeeReceiptId, FAILED_FEE_ADAPTER, FAILED_FEE_SOURCE_ID, FAILED_FEE_RECEIPT_CAP, FAILED_FEE_SOURCE_LIMIT, type FailedFeeInput, type FailedFeeReceipt, type FailedIndexRow } from '../src/providers/advisory-creator-failed-fees.js';

const ACTOR = '8RXNzg9QEheV1SZyTLisckJRwziVoZFzGWA3tajj1yJg', MINT = '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump', CANONICAL = 'Km6Zx9bT9MgWTTdaRZaXQhLEnUaPaBbTpB3B6aoJE2v';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111', SYSTEM = '11111111111111111111111111111111', WSOL = 'So11111111111111111111111111111111111111112';
const CUTOFF = '2026-10-12T10:00:00.000Z', CLOCK = '2026-10-12T09:30:00.000Z', ERR = { InstructionError: [2, { Custom: 1 }] };
// Public finalized receipt from the exploratory probe, byte for byte; the fixture file adds one trailing newline.
const REAL_RAW = readFileSync('tests/fixtures/creator-failed-fees-gZrtdAeh.json', 'utf8').replace(/\n$/, '');
const REAL_ROW: FailedIndexRow = { signature: 'gZrtdAehgqYzcPDkPfrzAuLti9Eiu9koxpoU3o6wRVsU8nJh82BpV5AaADKo5MQqnecCCrqX1Dpi8WRcgAN3Noo', slot: 451544982, blockTime: 1790659045, err: ERR, transactionIndex: 484, confirmationStatus: 'finalized' };
const REAL_CLOCK = '2026-10-12T09:20:13.817230+00:00', REAL_PAYER = 'DCKEuw8Da2B4ugX9i2aiKoku1eMPMjMk99CR1tyJfddM';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function encode58(bytes: Buffer): string { let n = BigInt(`0x${bytes.toString('hex')}`), s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const b of bytes) { if (b !== 0) break; s = `1${s}`; } return s; }
const sha = (x: string | Buffer) => createHash('sha256').update(x).digest('hex');
const pk = (seed: string) => encode58(createHash('sha256').update(seed).digest());
const sig = (i: number) => encode58(createHash('sha512').update(`failed-${i}`).digest());
const srow = (i: number): FailedIndexRow => ({ signature: sig(i), slot: 451600000 + i, blockTime: 1790700000 + i, err: ERR, transactionIndex: i, confirmationStatus: 'finalized' });
const input = (rows: FailedIndexRow[], receipts: FailedFeeReceipt[], over: Partial<FailedFeeInput> = {}): FailedFeeInput => ({ actor: ACTOR, mint: MINT, targetAccounts: [CANONICAL], creationSlot: 451486744, headSlot: 455914007, cutoff: CUTOFF, rows, receipts, ...over });
const classify = (rows: FailedIndexRow[], receipts: FailedFeeReceipt[], over: Partial<FailedFeeInput> = {}) => classifyCreatorFailedFees(input(rows, receipts, over));
function receipt(row: FailedIndexRow, raw: string, over: Partial<FailedFeeReceipt> = {}): FailedFeeReceipt {
  const stored = archiveCreatorFailedFeeReceipt(raw);
  return { id: failedFeeReceiptId(row.signature), sourceId: FAILED_FEE_SOURCE_ID, adapterVersion: FAILED_FEE_ADAPTER, request: failedFeeRequest(row.signature), retrievedAt: CLOCK, contentHash: sha(stored), stored, ...over };
}
type Shape = { payer?: string; keys?: string[]; lookup?: string[]; loaded?: unknown; programs?: string[]; fee?: number; mutate?: (v: any) => void };
/** Synthetic jsonParsed failure in the observed field layout: the payer signs and pays, nothing else moves. */
function synthetic(row: FailedIndexRow, o: Shape = {}): string {
  const payer = o.payer ?? ACTOR, fee = o.fee ?? 5000, programs = o.programs ?? [COMPUTE_BUDGET];
  const statics = [payer, ...(o.keys ?? []), ...programs];
  const accountKeys = [...statics.map((pubkey, i) => ({ pubkey, signer: i === 0, source: 'transaction', writable: i === 0 })), ...(o.lookup ?? []).map(pubkey => ({ pubkey, signer: false, source: 'lookupTable', writable: false }))];
  const pre = accountKeys.map((_, i) => i === 0 ? 1_000_000 : 2_039_280), post = pre.map((x, i) => i === 0 ? x - fee : x);
  const v: any = { blockTime: row.blockTime, meta: { err: row.err, fee, innerInstructions: [], logMessages: [], postBalances: post, postTokenBalances: [], preBalances: pre, preTokenBalances: [], rewards: [], status: { Err: row.err }, ...(o.loaded === undefined ? {} : { loadedAddresses: o.loaded }) }, slot: row.slot, transaction: { message: { accountKeys, addressTableLookups: [], instructions: programs.map(programId => ({ accounts: [], data: '1', programId, stackHeight: 1 })), recentBlockhash: pk('blockhash') }, signatures: [row.signature] }, version: 0 };
  o.mutate?.(v);
  return JSON.stringify({ jsonrpc: '2.0', result: v, id: 1 });
}

test('real other-payer failure that references the target charges the creator nothing', () => {
  const out = classify([REAL_ROW], [receipt(REAL_ROW, REAL_RAW, { retrievedAt: REAL_CLOCK })]);
  assert.equal(out.status, 'COMPLETE');
  const row = out.rows[0]!;
  assert.deepEqual([row.classification, row.feePayer, row.actorSigner, row.targetReference, row.metaFeeLamports, row.actorChargedLamports, row.version, row.lookupKeys], ['NOT_ACTOR_CHARGED', REAL_PAYER, false, true, '6000', '0', 0, 0]);
  assert.deepEqual(row.foreignMintReferencesObserved, [WSOL]);
  assert.equal(out.failedTargetAssociatedChargedTransactionOverheadLamports, '0');
  assert.deepEqual([out.foreignAssetCoverage, out.overheadAllocation], ['PARTIAL_OR_NOT_EVALUATED', 'NOT_ATTEMPTED']);
  assert.equal(out.storage.sourceBytes, Buffer.byteLength(REAL_RAW));
  assert.equal(JSON.parse(receipt(REAL_ROW, REAL_RAW).stored).method, DEMAND_ARCHIVE_METHOD);
});

test('actor-paid failures with a static or lookup-table target key are charged overhead', () => {
  const [a, b, c, d] = [srow(1), srow(2), srow(3), srow(4)];
  const out = classify([a, b, c], [
    receipt(a, synthetic(a, { keys: [MINT], fee: 7000 })),
    receipt(b, synthetic(b, { lookup: [CANONICAL] })),
    receipt(c, synthetic(c, { lookup: [CANONICAL], loaded: { writable: [], readonly: [CANONICAL] }, fee: 3000 })),
  ]);
  assert.equal(out.status, 'COMPLETE');
  assert.deepEqual(out.rows.map(r => r.classification), Array(3).fill('TARGET_ASSOCIATED_CHARGED'));
  assert.equal(out.rows[1]!.lookupKeys, 1);
  assert.equal(out.failedTargetAssociatedChargedTransactionOverheadLamports, '15000');
  const mismatch = classify([d], [receipt(d, synthetic(d, { lookup: [CANONICAL], loaded: { writable: [], readonly: [pk('other')] } }))]);
  assert.deepEqual([mismatch.status, mismatch.rows[0]!.code, mismatch.failedTargetAssociatedChargedTransactionOverheadLamports], ['INCOMPLETE', 'LOADED_ADDRESSES_MISMATCH', null]);
});

test('actor-paid failures without a target key stay unresolved whatever their programs', () => {
  const [a, b] = [srow(1), srow(2)];
  const out = classify([a, b], [
    receipt(a, synthetic(a, { programs: [COMPUTE_BUDGET, pk('opaque-program')] })),
    receipt(b, synthetic(b, { keys: [pk('destination')], programs: [COMPUTE_BUDGET, SYSTEM] })),
  ]);
  assert.deepEqual(out.rows.map(r => [r.classification, r.code, r.actorChargedLamports]), Array(2).fill(['UNRESOLVED', 'ACTOR_CHARGED_TARGET_UNPROVEN', '5000']));
  assert.deepEqual([out.status, out.coverage.settled, out.failedTargetAssociatedChargedTransactionOverheadLamports, 'actorChargedUnrelatedSupportedLamports' in out], ['INCOMPLETE', 0, null, false]);
});

test('a complete mixed set sums only target-associated creator charges', () => {
  const a = srow(1);
  const out = classify([REAL_ROW, a], [receipt(REAL_ROW, REAL_RAW, { retrievedAt: REAL_CLOCK }), receipt(a, synthetic(a, { keys: [CANONICAL] }))]);
  assert.equal(out.status, 'COMPLETE');
  assert.deepEqual([out.counts.NOT_ACTOR_CHARGED, out.counts.TARGET_ASSOCIATED_CHARGED, out.coverage.indexedRows, out.coverage.settled], [1, 1, 2, 2]);
  assert.equal(out.failedTargetAssociatedChargedTransactionOverheadLamports, '5000');
});

test('missing or unavailable receipts never yield a total, not even zero', () => {
  const [a, b, c, d] = [srow(1), srow(2), srow(3), srow(4)];
  const out = classify([a, b, c, d], [
    receipt(a, synthetic(a, { payer: pk('other-payer'), keys: [MINT] })),
    receipt(b, JSON.stringify({ jsonrpc: '2.0', error: { code: -32009, message: 'not available' }, id: 1 })),
    receipt(c, JSON.stringify({ jsonrpc: '2.0', result: null, id: 1 })),
  ]);
  assert.equal(out.status, 'INCOMPLETE');
  assert.deepEqual(out.rows.map(r => [r.classification, r.code]), [['NOT_ACTOR_CHARGED', null], ['UNAVAILABLE', 'RPC_REMOTE_-32009'], ['UNAVAILABLE', 'RESULT_NULL'], ['MISSING', 'RECEIPT_MISSING']]);
  assert.equal(out.failedTargetAssociatedChargedTransactionOverheadLamports, null);
  assert.equal(out.coverage.complete, false);
});

test('membership, request, hash, clock and identity forgeries fail closed', () => {
  const [a, b] = [srow(1), srow(2)], raw = synthetic(a, { keys: [MINT] }), good = receipt(a, raw), stray = srow(99);
  const cases: Array<[string, FailedIndexRow[], FailedFeeReceipt[]]> = [
    ['S15_FAILED_RECEIPT_ORPHAN', [a], [good, receipt(stray, synthetic(stray))]],
    ['S15_FAILED_RECEIPT_ORPHAN', [a], [good, { ...good, id: 'cache-copy', adapterVersion: 'demand-archive-v1' }]],
    ['S15_FAILED_RECEIPT_ORPHAN', [a], [good, { ...good, id: 'cache-copy', sourceId: 'advisory-demand' }]],
    ['S15_FAILED_RECEIPT_SOURCE', [a], [{ ...good, sourceId: 'advisory-demand' }]],
    ['S15_FAILED_RECEIPT_DUPLICATE', [a], [good, good]],
    ['S15_FAILED_RECEIPT_ADAPTER', [a], [{ ...good, adapterVersion: 'demand-archive-v1' }]],
    ['S15_FAILED_RECEIPT_REQUEST', [a], [{ ...good, request: { method: 'getTransaction', params: [a.signature, { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 1 }] } }]],
    ['S15_FAILED_RECEIPT_HASH', [a], [{ ...good, contentHash: '0'.repeat(64) }]],
    ['S15_FAILED_RECEIPT_CLOCK', [a], [{ ...good, retrievedAt: '2026-10-12T10:00:00.000001Z' }]],
    ['S15_FAILED_RECEIPT_CLOCK', [a], [{ ...good, retrievedAt: '2026-09-29T00:00:00Z' }]],
    ['S15_FAILED_RECEIPT_CLOCK', [a], [{ ...good, retrievedAt: '2026-10-12 09:30' }]],
    ['S15_FAILED_RECEIPT_BINDING', [a, b], [receipt(b, raw)]],
    ['S15_FAILED_RECEIPT_BINDING', [a], [receipt(a, synthetic(a, { keys: [MINT], mutate: v => { v.meta.err = { InstructionError: [0, { Custom: 6000 }] }; v.meta.status = { Err: v.meta.err }; } }))]],
    ['S15_FAILED_RECEIPT_BINDING', [a], [receipt(a, synthetic(a, { keys: [MINT], mutate: v => { v.slot += 1; } }))]],
  ];
  for (const [code, rows, receipts] of cases) {
    const out = classify(rows, receipts);
    assert.deepEqual([out.status, out.reasonCode, out.failedTargetAssociatedChargedTransactionOverheadLamports, out.rows.length], ['INVALID', code, null, 0], code);
  }
  const foreignEvidence = { id: 'demand-transaction-0', sourceId: 'advisory-demand', adapterVersion: 'demand-archive-v1', request: {}, retrievedAt: 'x', contentHash: 'x', stored: 'x' };
  assert.equal(classify([a], [foreignEvidence, good]).status, 'COMPLETE');
});

test('unsupported versions, non-fee effects and malformed keys stay unresolved', () => {
  const a = srow(1);
  const cases: Array<[string, (v: any) => void]> = [
    ['VERSION_UNSUPPORTED', v => { v.version = 1; }],
    ['STATUS_MISMATCH', v => { v.meta.status = { Ok: null }; }],
    ['EFFECTS_NOT_FEE_ONLY', v => { v.meta.postBalances[1] -= 1; }],
    ['EFFECTS_NOT_FEE_ONLY', v => { v.meta.fee = 4000; }],
    ['BALANCES_INVALID', v => { v.meta.preBalances.pop(); }],
    ['TOKEN_BALANCES_CHANGED', v => { v.meta.postTokenBalances = [{ accountIndex: 1, mint: MINT, owner: ACTOR, uiTokenAmount: { amount: '1', decimals: 6 } }]; }],
    ['KEYS_INVALID', v => { v.transaction.message.accountKeys[0].signer = false; }],
    ['KEYS_INVALID', v => { const k = v.transaction.message.accountKeys; k.splice(1, 0, k.pop()); }],
    ['KEYS_INVALID', v => { v.transaction.message.accountKeys[1].pubkey = 'not-a-key'; }],
    ['FEE_PAYER_INVALID', v => { v.transaction.message.accountKeys[0].writable = false; }],
  ];
  for (const [code, mutate] of cases) {
    const out = classify([a], [receipt(a, synthetic(a, { keys: [MINT], lookup: [CANONICAL], mutate }))]);
    assert.deepEqual([out.status, out.rows[0]!.classification, out.rows[0]!.code, out.failedTargetAssociatedChargedTransactionOverheadLamports], ['INCOMPLETE', 'UNRESOLVED', code, null], code);
  }
});

test('index input is bounded and validated before any receipt is read', () => {
  const many = Array.from({ length: FAILED_FEE_RECEIPT_CAP + 1 }, (_, i) => srow(i));
  assert.equal(classify(many, []).reasonCode, 'S15_FAILED_INDEX_CAP');
  assert.equal(classify([{ ...srow(1), err: null }], []).reasonCode, 'S15_FAILED_INPUT_INVALID');
  assert.equal(classify([{ ...srow(1), slot: 451486743 }], []).reasonCode, 'S15_FAILED_INPUT_INVALID');
  assert.equal(classify([srow(1)], [], { targetAccounts: [MINT] }).reasonCode, 'S15_FAILED_INPUT_INVALID');
  assert.equal(classify([srow(1)], [], { targetAccounts: [ACTOR] }).reasonCode, 'S15_FAILED_INPUT_INVALID');
});

test('archive reuse: exact round trip; trailing input, bombs, plain bodies and oversize sources fail closed', () => {
  assert.equal(unpackCreatorFailedFeeReceipt(archiveCreatorFailedFeeReceipt(REAL_RAW)), REAL_RAW);
  const bytes = Buffer.from(REAL_RAW, 'utf8');
  const container = (data: Buffer, sourceBytes: number, sourceHash: string) => JSON.stringify({ method: DEMAND_ARCHIVE_METHOD, encoding: 'DEFLATE_RAW_BASE64', sourceBytes, sourceHash, data: data.toString('base64') });
  const trailing = container(Buffer.concat([deflateRawSync(bytes), Buffer.from([0, 0, 0])]), bytes.length, sha(bytes));
  const bomb = container(deflateRawSync(Buffer.alloc(2_000_000)), 1000, sha(Buffer.alloc(1000)));
  for (const forged of [trailing, bomb]) assert.throws(() => unpackCreatorFailedFeeReceipt(forged));
  for (const forged of [trailing, REAL_RAW]) {
    const out = classify([REAL_ROW], [{ ...receipt(REAL_ROW, REAL_RAW, { retrievedAt: REAL_CLOCK }), stored: forged, contentHash: sha(forged) }]);
    assert.deepEqual([out.status, out.reasonCode], ['INVALID', 'S15_FAILED_ARCHIVE_INVALID']);
  }
  assert.throws(() => archiveCreatorFailedFeeReceipt('x'.repeat(FAILED_FEE_SOURCE_LIMIT + 1)), /S15_FAILED_ARCHIVE_SOURCE_LIMIT/);
});
