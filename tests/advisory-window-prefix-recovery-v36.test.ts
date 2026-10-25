import test from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { OFFLINE_PUMP_AMM_PROGRAM as sdk, PUMP_AMM_PROGRAM_ID, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, userVolumeAccumulatorPda, poolPda } from '@pump-fun/pump-swap-sdk';
import { encodeSolanaAddress } from '../src/providers/solana.js';
import { decodePumpSwapWindowTransaction } from '../src/providers/advisory-trades.js';

// CONSTRUCTED_REGRESSION for the two proof36 truncated-receipt root causes found in the eight-window acceptance run.
// (1) 13 actual receipts (route-pumpquote window-transaction-34 and siblings, tax-gtz window-transaction-118 and siblings): a selected
//     direct swap logged its event and its own emit_cpi child, which closed, before 'Log truncated'; only the swap's own success line is absent.
// (2) 1 actual receipt (tax-gtz window-transaction-162): the selected SELL closed, then an unrelated foreign BuyExactQuoteIn was cut open
//     with its own event child unlogged. These receipts are built with the installed SDK coder and never relabel a mainnet receipt.
const key = (n: number) => new PublicKey(Buffer.alloc(32, n)).toBase58();
const token = { chain: 'solana' as const, address: '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump' };
const user = new PublicKey(Buffer.alloc(32, 4)), U = user.toBase58(), creator = new PublicKey(Buffer.alloc(32, 7));
const baseVault = key(5), quoteVault = key(6), USER_BASE = key(30), USER_QUOTE = key(31), USER_IN = key(32), USER_OUT = key(33);
const program = PUMP_AMM_PROGRAM_ID.toBase58(), WSOL = NATIVE_MINT.toBase58(), TOKEN = TOKEN_PROGRAM_ID.toBase58(), TOKEN22 = TOKEN_2022_PROGRAM_ID.toBase58();
const SYSTEM = '11111111111111111111111111111111', ROUTER = key(20), FEE_PROGRAM = key(22);
const CURVE = ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf', '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt', 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1'];
const pool = poolPda(0, creator, new PublicKey(token.address), NATIVE_MINT).toBase58();
const eventAuthority = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP_AMM_PROGRAM_ID)[0].toBase58();
const HOUR = 1760785200, blockTime = HOUR + 1800, slot = 1000;
const at = new Date(blockTime * 1000).toISOString(), retrieved = new Date((blockTime + 120) * 1000).toISOString();
const poolFixture = { baseMint: new PublicKey(token.address), quoteMint: NATIVE_MINT, poolBaseTokenAccount: new PublicKey(baseVault), poolQuoteTokenAccount: new PublicKey(quoteVault) } as any;
const n = (v: bigint | number) => new BN(v.toString()), pk = (s: string) => new PublicKey(s);
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };

function defaults(name: string): Record<string, unknown> {
  const type = sdk.idl.types!.find(t => t.name === name)!;
  const out: Record<string, unknown> = {};
  for (const f of (type.type as any).fields) out[f.name] = f.type === 'pubkey' ? user : f.type === 'bool' ? false : f.type === 'string' ? '' : f.type === 'u8' || f.type === 'u16' ? 0 : new BN(0);
  return out;
}
/** SDK-coded event prefix plus the current 24-byte zero appendix (holder bps, holder rewards, unclaimed creator fee). */
function eventBytes(name: 'buyEvent' | 'sellEvent', fields: Record<string, unknown>): Buffer {
  const data = { ...defaults(name), timestamp: n(blockTime), user, poolBaseTokenReserves: n(100000), poolQuoteTokenReserves: n(1000000), ...fields };
  return Buffer.concat([Buffer.from(sdk.idl.events!.find(e => e.name === name)!.discriminator), sdk.coder.types.encode(name, data as any), Buffer.alloc(24)]);
}
const v2Accounts = (poolKey: string, baseMint: string, quoteMint: string, userBase: string, userQuote: string, bVault: string, qVault: string) =>
  [poolKey, U, GLOBAL_CONFIG_PDA.toBase58(), baseMint, quoteMint, userBase, userQuote, bVault, qVault, TOKEN, TOKEN, SYSTEM, userVolumeAccumulatorPda(user).toBase58(), PUMP_AMM_FEE_CONFIG_PDA.toBase58(), U, eventAuthority, program];
const SELECTED = v2Accounts(pool, token.address, WSOL, USER_BASE, USER_QUOTE, baseVault, quoteVault);
const FPOOL = key(50), FUB = key(53), FUQ = key(54);
const FOREIGN = v2Accounts(FPOOL, key(51), key(52), FUB, FUQ, key(55), key(56));
const sellData = Buffer.concat([Buffer.from([93, 246, 130, 60, 231, 233, 64, 178]), u64(500n), u64(0n)]);
const exactInData = Buffer.concat([Buffer.from([194, 171, 28, 70, 104, 77, 91, 47]), u64(2_000_000n), u64(1n)]);
/** Selected sell_v2: core Q=1,000,000, fees LP 2 + protocol 4 + creator 2 (buyback 2 inside protocol), so it keeps frozen v2 accounting. */
const selectedSell = (ts = blockTime, core = 1_000_000n) => eventBytes('sellEvent', { timestamp: n(ts), pool: pk(pool), userBaseTokenAccount: pk(USER_BASE), userQuoteTokenAccount: pk(USER_QUOTE),
  baseAmountIn: n(500), quoteAmountOut: n(core), userQuoteAmountOut: n(core - 8n), quoteAmountOutWithoutLpFee: n(core - 2n), lpFee: n(2), protocolFee: n(4), coinCreatorFee: n(2), buybackFee: n(2) });
type Foreign = { name?: 'buyEvent' | 'sellEvent'; pool?: string; user?: string; userBase?: string; ts?: number; quote?: bigint };
const foreignEvent = (o: Foreign = {}) => {
  const common = { timestamp: n(o.ts ?? blockTime), pool: pk(o.pool ?? FPOOL), user: pk(o.user ?? U), userBaseTokenAccount: pk(o.userBase ?? FUB), userQuoteTokenAccount: pk(FUQ) };
  const q = o.quote ?? 1_000_000n;
  return (o.name ?? 'buyEvent') === 'buyEvent'
    ? eventBytes('buyEvent', { ...common, ixName: 'buy_exact_quote_in_v2', quoteAmountIn: n(q), userQuoteAmountIn: n(q), quoteAmountInWithLpFee: n(q), baseAmountOut: n(3_000_000) })
    : eventBytes('sellEvent', { ...common, quoteAmountOut: n(q), userQuoteAmountOut: n(q), quoteAmountOutWithoutLpFee: n(q), baseAmountIn: n(3_000_000) });
};
const ix = (programId: string, accounts: string[], data: Buffer, stackHeight: number) => ({ programId, accounts, data: encodeSolanaAddress(data), stackHeight });
const emit = (bytes: Buffer, stackHeight = 3) => ix(program, [eventAuthority], Buffer.concat([Buffer.from('e445a52e51cb9a1d', 'hex'), bytes]), stackHeight);
const feeChild = () => ix(FEE_PROGRAM, [U], Buffer.from([1]), 3);
const tokenChild = () => ({ program: 'spl-token', programId: TOKEN, parsed: { type: 'transfer' }, stackHeight: 3 });
function receipt(inner: any[], logMessages: string[], opts: { top?: string; err?: unknown } = {}): any {
  const top = opts.top ?? ROUTER;
  const keys = [...new Set<string>([top, U, ...inner.flatMap((i: any) => [i.programId, ...(i.accounts ?? [])])])];
  return { version: 0, slot, blockTime, transaction: { signatures: ['sig1'], message: {
    accountKeys: keys.map(pubkey => ({ pubkey, signer: pubkey === U })), instructions: [{ programId: top, accounts: [U], data: encodeSolanaAddress(Buffer.from([1])) }] } },
    meta: { err: opts.err ?? null, innerInstructions: inner.length ? [{ index: 0, instructions: inner }] : [], logMessages } };
}
const inv = (p: string, d: number) => `Program ${p} invoke [${d}]`, ok = (p: string) => `Program ${p} success`, logged = (b: Buffer) => `Program data: ${b.toString('base64')}`;
/** Proof35 modern truncated-recovery scope; `extended` toggles proof36. */
const decode = (tx: any, extended = true) => decodePumpSwapWindowTransaction(tx, { signature: 'sig1', slot, at }, pool, poolFixture, slot, retrieved, true, true, true, false, false, true, undefined, extended, 9);
const TRUNCATED = /ADVISORY_TRADE_LOG_TRUNCATED/;

// ---- (1) selected swap: event and own emit_cpi child logged and closed before the marker; only the swap's own close is lost ----
const closedChildLogs = (sell: Buffer, top = ROUTER) => [inv(top, 1), inv(program, 2), logged(sell), inv(program, 3), ok(program), 'Log truncated', 'Program log: Instruction: Swap2'];

test('proof36 proves an open selected swap once from its logged, closed and payload-bound event child; frozen proof35 still rejects it', () => {
  const sell = selectedSell(), tx = receipt([ix(program, SELECTED, sellData, 2), emit(sell)], closedChildLogs(sell));
  const proof = decode(tx);
  assert.equal(proof.trades.length, 1);
  const t = proof.trades[0]!;
  assert.deepEqual([t.side, t.user, t.baseAtomic, t.quoteAtomic, t.quoteAccounting!.method], ['SELL', U, '500', '1000000', 'pumpswap-event-fee-exclusive-v2']);
  assert.deepEqual([proof.logRecovery!.truncated, proof.logRecovery!.unresolvedInvocations, proof.logRecovery!.executionProvenInvocations], [true, 1, 1]);
  assert.deepEqual([proof.foreignSwapLegs, proof.extendedLegs], [0, 1]);
  assert.throws(() => decode(tx, false), TRUNCATED);
});

test('a logged emit_cpi child whose payload differs from the logged event is rejected in both modes', () => {
  const sell = selectedSell(), tx = receipt([ix(program, SELECTED, sellData, 2), emit(selectedSell(blockTime + 1))], closedChildLogs(sell));
  assert.throws(() => decode(tx), /ADVISORY_TRADE_EVENT_CPI_BINDING/);
  assert.throws(() => decode(tx, false), /ADVISORY_TRADE_EVENT_CPI_BINDING/);
});

test('an extra event child in the open swap subtree leaves the swap unproven', () => {
  const sell = selectedSell();
  assert.throws(() => decode(receipt([ix(program, SELECTED, sellData, 2), emit(sell), tokenChild(), emit(sell, 4)], closedChildLogs(sell))), TRUNCATED);
});

test('a native-builtin ancestor or a failed transaction never proves the open swap', () => {
  const sell = selectedSell(), inner = () => [ix(program, SELECTED, sellData, 2), emit(sell)];
  assert.throws(() => decode(receipt(inner(), closedChildLogs(sell, SYSTEM), { top: SYSTEM })), TRUNCATED);
  assert.throws(() => decode(receipt(inner(), closedChildLogs(sell), { err: { InstructionError: [0, 'Custom'] } })), /ADVISORY_TRADE_TRANSACTION_BINDING/);
});

test('route-pumpquote combination: a closed BUY route with its selected last hop plus the open selected SELL decode once each', () => {
  const IN_HOP = [WSOL, key(60), key(61), key(62), key(63)], SELECTED_HOP = [token.address, WSOL, pool, baseVault, quoteVault];
  const route = [U, USER_IN, USER_OUT, GLOBAL_CONFIG_PDA.toBase58(), PUMP_AMM_FEE_CONFIG_PDA.toBase58(), userVolumeAccumulatorPda(user).toBase58(), key(15), TOKEN, TOKEN22, SYSTEM, eventAuthority, program, ...CURVE, ...IN_HOP, ...SELECTED_HOP];
  const routeData = Buffer.concat([Buffer.from([43, 100, 73, 19, 233, 246, 111, 148]), u64(1_001_000n), u64(700n)]);
  // Hop 0 (foreign) carries only protocol; hop 1 (selected target) carries LP and creator: Q=U+F, W=U+LP, and hop 1 input equals hop 0 output.
  const e0 = eventBytes('buyEvent', { pool: pk(key(61)), userBaseTokenAccount: pk(SYSTEM), userQuoteTokenAccount: pk(USER_IN), ixName: 'multi_hop_swap',
    quoteAmountIn: n(1_001_000), userQuoteAmountIn: n(1_000_000), quoteAmountInWithLpFee: n(1_000_000), protocolFee: n(1000), baseAmountOut: n(5_000_000) });
  const e1 = eventBytes('buyEvent', { pool: pk(pool), userBaseTokenAccount: pk(USER_OUT), userQuoteTokenAccount: pk(SYSTEM), ixName: 'multi_hop_swap',
    quoteAmountIn: n(5_000_000), userQuoteAmountIn: n(4_987_500), quoteAmountInWithLpFee: n(4_997_500), lpFee: n(10_000), coinCreatorFee: n(2_500), baseAmountOut: n(777) });
  const sell = selectedSell();
  const tx = receipt([ix(program, route, routeData, 2), emit(e0), emit(e1), ix(program, SELECTED, sellData, 2), emit(sell)], [
    inv(ROUTER, 1), inv(program, 2), logged(e0), inv(program, 3), ok(program), logged(e1), inv(program, 3), ok(program), ok(program),
    inv(program, 2), logged(sell), inv(program, 3), ok(program), 'Log truncated', 'Program log: Instruction: Swap2']);
  const proof = decode(tx);
  assert.deepEqual(proof.trades.map(t => [t.side, t.baseAtomic, t.quoteAtomic, t.instructionName, t.quoteAccounting!.method]), [
    ['BUY', '777', '4987500', 'multi_hop_swap', 'pumpswap-event-fee-exclusive-v3'], ['SELL', '500', '1000000', 'sell_v2', 'pumpswap-event-fee-exclusive-v2']]);
  assert.deepEqual([proof.foreignSwapLegs, proof.logRecovery!.unresolvedInvocations, proof.logRecovery!.executionProvenInvocations, proof.extendedLegs], [1, 1, 1, 2]);
  assert.throws(() => decode(tx, false), /ADVISORY_TRADE_MULTIHOP_BUY_UNSUPPORTED/);
});

// ---- (2) selected SELL closed, then an unrelated foreign BuyExactQuoteIn cut open by the marker ----
const sellThenForeign = (fb: Buffer | null, o: { accounts?: string[]; extraChild?: boolean; top?: string; loggedEvent?: Buffer } = {}) => {
  const sell = selectedSell(), top = o.top ?? ROUTER;
  const inner = [ix(program, SELECTED, sellData, 2), emit(sell), ix(program, o.accounts ?? FOREIGN, exactInData, 2), feeChild(), ...(fb ? [emit(fb)] : []), ...(o.extraChild && fb ? [emit(fb)] : [])];
  const tail = o.loggedEvent ? [inv(FEE_PROGRAM, 3), ok(FEE_PROGRAM), logged(o.loggedEvent), 'Log truncated'] : [inv(FEE_PROGRAM, 3), 'Program log: Instruction: GetFeesWithQuoteMint', 'Log truncated'];
  return receipt(inner, [inv(top, 1), inv(program, 2), logged(sell), inv(program, 3), ok(program), ok(program), inv(program, 2), ...tail], { top });
};

test('proof36 proves an unlogged foreign direct swap from its sole bound event child, adding no selected flow; frozen proof35 rejects', () => {
  const tx = sellThenForeign(foreignEvent());
  const proof = decode(tx);
  assert.deepEqual(proof.trades.map(t => [t.side, t.quoteAtomic]), [['SELL', '1000000']]);
  assert.deepEqual([proof.foreignSwapLegs, proof.logRecovery!.unresolvedInvocations, proof.logRecovery!.executionProvenInvocations, proof.extendedLegs], [1, 2, 2, 1]);
  assert.throws(() => decode(tx, false), TRUNCATED);
});

test('a foreign event logged before the marker is counted once and its unlogged child must be byte-identical', () => {
  const fb = foreignEvent();
  const proof = decode(sellThenForeign(fb, { loggedEvent: fb }));
  assert.deepEqual([proof.trades.length, proof.foreignSwapLegs, proof.logRecovery!.unresolvedInvocations, proof.logRecovery!.executionProvenInvocations], [1, 1, 2, 2]);
  assert.throws(() => decode(sellThenForeign(foreignEvent({ quote: 1_000_001n }), { loggedEvent: fb })), TRUNCATED);
});

test('a foreign event child bound to the wrong pool, user, user account, clock or side leaves the receipt unproven', () => {
  for (const bad of [{ pool: key(57) }, { user: key(58) }, { userBase: key(59) }, { ts: HOUR - 1 }, { name: 'sellEvent' as const }])
    assert.throws(() => decode(sellThenForeign(foreignEvent(bad))), TRUNCATED, JSON.stringify(bad));
});

test('a foreign swap touching a selected vault, missing or duplicating its event child, or under a native ancestor stays unproven', () => {
  const touching = [...FOREIGN]; touching[8] = quoteVault;
  assert.throws(() => decode(sellThenForeign(foreignEvent(), { accounts: touching })), TRUNCATED);
  assert.throws(() => decode(sellThenForeign(null)), TRUNCATED);
  assert.throws(() => decode(sellThenForeign(foreignEvent(), { extraChild: true })), TRUNCATED);
  assert.throws(() => decode(sellThenForeign(foreignEvent(), { top: SYSTEM })), TRUNCATED);
});
