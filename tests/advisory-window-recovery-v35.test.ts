import test from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { OFFLINE_PUMP_AMM_PROGRAM as sdk, PUMP_AMM_PROGRAM_ID, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, userVolumeAccumulatorPda, poolPda } from '@pump-fun/pump-swap-sdk';
import { encodeSolanaAddress } from '../src/providers/solana.js';
import { decodePumpSwapWindowTransaction } from '../src/providers/advisory-trades.js';

// Proof35 executed-CPI/event recovery for the three real truncated BOUNCER-hour shapes (window-transaction 18/62/27)
// plus negatives, driven on synthetic receipts built with the installed SDK coder. No .data fixture dependency.
const token = { chain: 'solana' as const, address: '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump' };
const user = new PublicKey(Buffer.alloc(32, 4)), baseVault = new PublicKey(Buffer.alloc(32, 5)), quoteVault = new PublicKey(Buffer.alloc(32, 6)), creator = new PublicKey(Buffer.alloc(32, 7));
const program = PUMP_AMM_PROGRAM_ID.toBase58();
const pool = poolPda(0, creator, new PublicKey(token.address), NATIVE_MINT).toBase58();
const eventAuthority = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP_AMM_PROGRAM_ID)[0].toBase58();
const ROUTER = new PublicKey(Buffer.alloc(32, 20)).toBase58();
const SYSTEM = '11111111111111111111111111111111';
const HOUR = 1760785200, blockTime = HOUR + 1800, slot = 1000;
const at = new Date(blockTime * 1000).toISOString(), retrieved = new Date((blockTime + 120) * 1000).toISOString();
const poolFixture = { baseMint: new PublicKey(token.address), quoteMint: NATIVE_MINT, poolBaseTokenAccount: baseVault, poolQuoteTokenAccount: quoteVault } as any;
const swapAccounts = [pool, user.toBase58(), GLOBAL_CONFIG_PDA.toBase58(), token.address, NATIVE_MINT.toBase58(), baseVault.toBase58(), quoteVault.toBase58(), baseVault.toBase58(), quoteVault.toBase58(), TOKEN_PROGRAM_ID.toBase58(), TOKEN_PROGRAM_ID.toBase58(), SYSTEM, userVolumeAccumulatorPda(user).toBase58(), PUMP_AMM_FEE_CONFIG_PDA.toBase58(), user.toBase58(), eventAuthority, program];
const closeAccounts = [user.toBase58(), userVolumeAccumulatorPda(user).toBase58(), eventAuthority, program];
const sellData = Buffer.alloc(24); Buffer.from([93, 246, 130, 60, 231, 233, 64, 178]).copy(sellData); sellData.writeBigUInt64LE(500n, 8); sellData.writeBigUInt64LE(0n, 16);
const closeData = Buffer.from([249, 69, 164, 218, 150, 103, 84, 138]);

function defaults(name: string): any {
  const type = sdk.idl.types!.find(t => t.name === name)!;
  const result: Record<string, unknown> = {};
  for (const f of (type.type as any).fields) result[f.name] = f.type === 'pubkey' ? user : f.type === 'bool' ? false : f.type === 'u8' || f.type === 'u16' ? 0 : new BN(0);
  return result;
}
function sellEventBytes(ts: number, poolKey: string = pool, appendix = 24, core = 1000000n): Buffer {
  const lp = 2n, protocol = 4n, creatorFee = 2n, fees = lp + protocol + creatorFee, userQuote = core - fees;
  const event = { ...defaults('sellEvent'), timestamp: new BN(ts), pool: new PublicKey(poolKey), user, userBaseTokenAccount: baseVault, userQuoteTokenAccount: quoteVault,
    poolBaseTokenReserves: new BN(100000), poolQuoteTokenReserves: new BN(1000000), baseAmountIn: new BN(500), quoteAmountOut: new BN(core.toString()),
    userQuoteAmountOut: new BN(userQuote.toString()), quoteAmountOutWithoutLpFee: new BN((core - lp).toString()), minQuoteAmountOut: new BN(0),
    lpFee: new BN(2), protocolFee: new BN(4), coinCreatorFee: new BN(2), buybackFee: new BN(2), cashback: new BN(0) };
  return Buffer.concat([Buffer.from(sdk.idl.events!.find(e => e.name === 'sellEvent')!.discriminator), sdk.coder.types.encode('sellEvent', event), Buffer.alloc(appendix)]);
}
const swapInner = (sh = 2) => ({ programId: program, accounts: swapAccounts, data: encodeSolanaAddress(sellData), stackHeight: sh });
const emitInner = (bytes: Buffer) => ({ programId: program, accounts: [eventAuthority], data: encodeSolanaAddress(Buffer.concat([Buffer.from('e445a52e51cb9a1d', 'hex'), bytes])), stackHeight: 3 });
const closeInner = (accts: string[] = closeAccounts) => ({ programId: program, accounts: accts, data: encodeSolanaAddress(closeData), stackHeight: 2 });
function receipt(inner: any[], logMessages: string[], opts: { err?: unknown; top?: string } = {}): any {
  const top = opts.top ?? ROUTER;
  const keys = [...new Set([...swapAccounts, ...closeAccounts, program, eventAuthority, top])];
  return { version: 1, slot, blockTime, transaction: { signatures: ['sig1'], message: {
    accountKeys: keys.map(pubkey => ({ pubkey, signer: pubkey === user.toBase58() })),
    instructions: [{ programId: top, accounts: swapAccounts, data: encodeSolanaAddress(Buffer.from([1])) }] } },
    meta: { err: opts.err ?? null, innerInstructions: inner.length ? [{ index: 0, instructions: inner }] : [], logMessages } };
}
const decodeRec = (tx: any) => decodePumpSwapWindowTransaction(tx, { signature: 'sig1', slot, at }, pool, poolFixture, slot, retrieved, true, true, true, false, false, true, undefined);

test('proof35 recovers a selected swap whose in-frame event is logged but whose frame and emit_cpi are cut by truncation (#62 shape)', () => {
  const bytes = sellEventBytes(blockTime), payload = bytes.toString('base64');
  const proof = decodeRec(receipt([swapInner(), emitInner(bytes)], [
    `Program ${ROUTER} invoke [1]`, `Program ${program} invoke [2]`, `Program data: ${payload}`, `Program ${program} invoke [3]`, 'Log truncated']));
  assert.equal(proof.trades.length, 1);
  assert.equal(proof.trades[0]!.side, 'SELL');
  assert.equal(proof.trades[0]!.quoteAtomic, '1000000');
  assert.equal(proof.logRecovery!.truncated, true);
  assert.equal(proof.logRecovery!.unresolvedInvocations, 2);
  assert.equal(proof.logRecovery!.executionProvenInvocations, 2);
});

// --- payload-identity when the selected event is logged before the marker but its own emit_cpi child is wholly unlogged (marker right after `Program data`, before the CPI invoke). The already-bound logged trade is reused only if the unlogged child payload is byte-identical; a same-event-name child differing in pool, clock or amounts must be rejected rather than silently reusing the logged trade. ---
test('a logged selected event is reused when its wholly-unlogged emit_cpi child payload is byte-identical (marker before the CPI invoke)', () => {
  const bytes = sellEventBytes(blockTime), payload = bytes.toString('base64');
  const proof = decodeRec(receipt([swapInner(), emitInner(bytes)], [
    `Program ${ROUTER} invoke [1]`, `Program ${program} invoke [2]`, `Program data: ${payload}`, 'Log truncated']));
  assert.equal(proof.trades.length, 1);
  assert.equal(proof.trades[0]!.quoteAtomic, '1000000');
  assert.equal(proof.logRecovery!.unresolvedInvocations, 2);
  assert.equal(proof.logRecovery!.executionProvenInvocations, 2);
});

test('a logged selected event is not reused when its unlogged emit_cpi child has the same event name but a different pool', () => {
  const payload = sellEventBytes(blockTime).toString('base64');
  const forged = sellEventBytes(blockTime, quoteVault.toBase58());
  assert.throws(() => decodeRec(receipt([swapInner(), emitInner(forged)], [
    `Program ${ROUTER} invoke [1]`, `Program ${program} invoke [2]`, `Program data: ${payload}`, 'Log truncated'])), /ADVISORY_TRADE_LOG_TRUNCATED/);
});

test('a logged selected event is not reused when its unlogged emit_cpi child has the same event name but a different timestamp', () => {
  const payload = sellEventBytes(blockTime).toString('base64');
  const forged = sellEventBytes(blockTime + 1);
  assert.throws(() => decodeRec(receipt([swapInner(), emitInner(forged)], [
    `Program ${ROUTER} invoke [1]`, `Program ${program} invoke [2]`, `Program data: ${payload}`, 'Log truncated'])), /ADVISORY_TRADE_LOG_TRUNCATED/);
});

test('a logged selected event is not reused when its unlogged emit_cpi child has the same event name but different amounts', () => {
  const payload = sellEventBytes(blockTime).toString('base64');
  const forged = sellEventBytes(blockTime, pool, 24, 2000000n);
  assert.throws(() => decodeRec(receipt([swapInner(), emitInner(forged)], [
    `Program ${ROUTER} invoke [1]`, `Program ${program} invoke [2]`, `Program data: ${payload}`, 'Log truncated'])), /ADVISORY_TRADE_LOG_TRUNCATED/);
});

test('proof35 recovers a selected swap whose event is only in the trace emit_cpi witness (#18 shape)', () => {
  const bytes = sellEventBytes(blockTime);
  const proof = decodeRec(receipt([swapInner(), emitInner(bytes)], [
    `Program ${ROUTER} invoke [1]`, `Program ${program} invoke [2]`, 'Log truncated']));
  assert.equal(proof.trades.length, 1);
  assert.equal(proof.trades[0]!.quoteAtomic, '1000000');
  assert.equal(proof.logRecovery!.unresolvedInvocations, 2);
  assert.equal(proof.logRecovery!.executionProvenInvocations, 2);
});

test('proof35 recovers a fully-closed selected swap with an open canonical close_user_volume_accumulator tail whose own CloseEvent is verified (#27 shape)', () => {
  const bytes = sellEventBytes(blockTime), payload = bytes.toString('base64');
  const closeBytes = closeEventBytes(blockTime), closePayload = closeBytes.toString('base64');
  const proof = decodeRec(receipt([swapInner(), emitInner(bytes), closeInner(), emitInner(closeBytes)], [
    `Program ${ROUTER} invoke [1]`,
    `Program ${program} invoke [2]`, `Program data: ${payload}`, `Program ${program} invoke [3]`, `Program ${program} success`, `Program ${program} success`,
    `Program ${program} invoke [2]`, `Program data: ${closePayload}`, `Program ${program} invoke [3]`, `Program ${program} success`, 'Log truncated']));
  assert.equal(proof.trades.length, 1);
  assert.equal(proof.trades[0]!.side, 'SELL');
  assert.equal(proof.logRecovery!.unresolvedInvocations, 1);
  assert.equal(proof.logRecovery!.executionProvenInvocations, 1);
});

test('a failed (meta.err) truncated transaction is never execution-recovered', () => {
  const bytes = sellEventBytes(blockTime), payload = bytes.toString('base64');
  assert.throws(() => decodeRec(receipt([swapInner(), emitInner(bytes)], [
    `Program ${ROUTER} invoke [1]`, `Program ${program} invoke [2]`, `Program data: ${payload}`, `Program ${program} invoke [3]`, 'Log truncated'],
    { err: { InstructionError: [0, 'Custom'] } })), /ADVISORY_TRADE_TRANSACTION_BINDING/);
});

test('an unclosed selected swap under a native-builtin ancestor is not execution-proven', () => {
  const bytes = sellEventBytes(blockTime), payload = bytes.toString('base64');
  assert.throws(() => decodeRec(receipt([swapInner(), emitInner(bytes)], [
    `Program ${SYSTEM} invoke [1]`, `Program ${program} invoke [2]`, `Program data: ${payload}`, `Program ${program} invoke [3]`, 'Log truncated'],
    { top: SYSTEM })), /ADVISORY_TRADE_LOG_TRUNCATED/);
});

test('a non-canonical close tail (wrong event authority role) is not execution-proven and stays unresolved for the window gate', () => {
  const bytes = sellEventBytes(blockTime), payload = bytes.toString('base64');
  const badClose = [user.toBase58(), userVolumeAccumulatorPda(user).toBase58(), ROUTER, program];
  const proof = decodeRec(receipt([swapInner(), emitInner(bytes), closeInner(badClose), emitInner(bytes)], [
    `Program ${ROUTER} invoke [1]`,
    `Program ${program} invoke [2]`, `Program data: ${payload}`, `Program ${program} invoke [3]`, `Program ${program} success`, `Program ${program} success`,
    `Program ${program} invoke [2]`, `Program data: ${payload}`, `Program ${program} invoke [3]`, `Program ${program} success`, 'Log truncated']));
  assert.equal(proof.trades.length, 1);
  assert.equal(proof.logRecovery!.unresolvedInvocations, 1);
  assert.equal(proof.logRecovery!.executionProvenInvocations, 0);
});

test('an unclosed selected swap with no emit_cpi witness in the trace is rejected', () => {
  assert.throws(() => decodeRec(receipt([swapInner()], [
    `Program ${ROUTER} invoke [1]`, `Program ${program} invoke [2]`, 'Log truncated'])), /ADVISORY_TRADE_LOG_TRUNCATED/);
});

test('an unclosed selected swap whose trace event payload does not bind to the swap is rejected', () => {
  const bytes = sellEventBytes(blockTime, quoteVault.toBase58());
  assert.throws(() => decodeRec(receipt([swapInner(), emitInner(bytes)], [
    `Program ${ROUTER} invoke [1]`, `Program ${program} invoke [2]`, 'Log truncated'])), /ADVISORY_TRADE_EVENT_BINDING/);
});

test('an inner Pump instruction missing a valid stackHeight fails the trace shape check', () => {
  const bytes = sellEventBytes(blockTime), payload = bytes.toString('base64');
  assert.throws(() => decodeRec(receipt([swapInner(1), emitInner(bytes)], [
    `Program ${ROUTER} invoke [1]`, `Program ${program} invoke [2]`, `Program data: ${payload}`, `Program ${program} invoke [3]`, 'Log truncated'])), /ADVISORY_TRADE_INNER_DEPTH/);
});

test('a duplicated in-frame event on the unclosed selected swap is rejected', () => {
  const bytes = sellEventBytes(blockTime), payload = bytes.toString('base64');
  assert.throws(() => decodeRec(receipt([swapInner(), emitInner(bytes)], [
    `Program ${ROUTER} invoke [1]`, `Program ${program} invoke [2]`, `Program data: ${payload}`, `Program data: ${payload}`, 'Log truncated'])), /ADVISORY_TRADE_EVENT_DUPLICATE/);
});

// --- all-recorded-unresolved recovery: wholly-unlogged invocations resolved from the full stackHeight trace (#58 / #76 shapes) ---
function eventBytes(name: string, overrides: Record<string, unknown> = {}): Buffer {
  const event = { ...defaults(name), ...overrides };
  return Buffer.concat([Buffer.from(sdk.idl.events!.find(e => e.name === name)!.discriminator), sdk.coder.types.encode(name, event)]);
}
function closeEventBytes(ts: number, u: PublicKey = user): Buffer {
  return eventBytes('closeUserVolumeAccumulatorEvent', { user: u, timestamp: new BN(ts) });
}
const emitD4 = (bytes: Buffer) => ({ programId: program, accounts: [eventAuthority], data: encodeSolanaAddress(Buffer.concat([Buffer.from('e445a52e51cb9a1d', 'hex'), bytes])), stackHeight: 4 });

test('proof35 recovers an open selected swap whose BuyEvent CPI and whole trailing close pair are unlogged (#58 shape)', () => {
  const proof = decodeRec(receipt([swapInner(), emitInner(sellEventBytes(blockTime)), closeInner(), emitInner(closeEventBytes(blockTime))], [
    `Program ${ROUTER} invoke [1]`, `Program ${program} invoke [2]`, 'Log truncated']));
  assert.equal(proof.trades.length, 1);
  assert.equal(proof.trades[0]!.side, 'SELL');
  assert.equal(proof.trades[0]!.quoteAtomic, '1000000');
  assert.equal(proof.logRecovery!.unresolvedInvocations, 4);
  assert.equal(proof.logRecovery!.executionProvenInvocations, 4);
});

test('proof35 recovers a selected swap recorded wholly after the marker as a sibling, with no Pump invoke logged (#76 shape)', () => {
  const proof = decodeRec(receipt([swapInner(), emitInner(sellEventBytes(blockTime))], [
    `Program ${ROUTER} invoke [1]`, 'Log truncated']));
  assert.equal(proof.trades.length, 1);
  assert.equal(proof.trades[0]!.quoteAtomic, '1000000');
  assert.equal(proof.logRecovery!.unresolvedInvocations, 2);
  assert.equal(proof.logRecovery!.executionProvenInvocations, 2);
});

test('a wholly-unlogged selected swap under a native-builtin top-level ancestor is not execution-proven', () => {
  assert.throws(() => decodeRec(receipt([swapInner(), emitInner(sellEventBytes(blockTime))], [
    `Program ${SYSTEM} invoke [1]`, 'Log truncated'], { top: SYSTEM })), /ADVISORY_TRADE_LOG_TRUNCATED/);
});

test('a recorded selected swap with incomplete (depth-3 with no depth-2 parent) trace ancestry is rejected', () => {
  assert.throws(() => decodeRec(receipt([swapInner(3), emitInner(sellEventBytes(blockTime))], [
    `Program ${ROUTER} invoke [1]`, 'Log truncated'])), /ADVISORY_TRADE_LOG_TRUNCATED/);
});

test('a wholly-unlogged selected swap with no event-CPI child in the trace is rejected', () => {
  assert.throws(() => decodeRec(receipt([swapInner()], [
    `Program ${ROUTER} invoke [1]`, 'Log truncated'])), /ADVISORY_TRADE_LOG_TRUNCATED/);
});

test('an unknown Pump opcode among the recorded invocations is rejected', () => {
  const unknown = { programId: program, accounts: swapAccounts, data: encodeSolanaAddress(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])), stackHeight: 2 };
  assert.throws(() => decodeRec(receipt([swapInner(), emitInner(sellEventBytes(blockTime)), unknown], [
    `Program ${ROUTER} invoke [1]`, `Program ${program} invoke [2]`, 'Log truncated'])), /ADVISORY_TRADE_UNSUPPORTED_INSTRUCTION/);
});

// --- recorded trace parentage: the witness is the swap's own immediate child in a fully validated stackHeight tree whose preorder the retained log prefix matches ---
const TOKEN = TOKEN_PROGRAM_ID.toBase58();
const tokenInner = (stackHeight?: unknown) => ({ program: 'spl-token', programId: TOKEN, parsed: { type: 'transfer' }, ...(stackHeight === undefined ? {} : { stackHeight }) });
const routeInner = (stackHeight = 2) => ({ programId: ROUTER, accounts: [user.toBase58()], data: encodeSolanaAddress(Buffer.from([2])), stackHeight });

test('a selected-swap event witness re-parented under a later non-Pump sibling is not claimed (actual #76 native repro shape)', () => {
  const witness = () => emitInner(sellEventBytes(blockTime));
  const logs = [`Program ${ROUTER} invoke [1]`, `Program ${ROUTER} invoke [2]`, `Program ${TOKEN} invoke [3]`, 'Log truncated'];
  // Original: the unlogged swap is a later sibling of the truncated route frame and its own event CPI follows its token children.
  const original = decodeRec(receipt([routeInner(), tokenInner(3), tokenInner(2), swapInner(), tokenInner(3), witness()], logs));
  assert.equal(original.trades.length, 1);
  assert.equal(original.logRecovery!.unresolvedInvocations, 2);
  assert.equal(original.logRecovery!.executionProvenInvocations, 2);
  // A copy of the earlier depth-2 token sibling inserted before the witness makes the depth-3 event CPI that sibling's child.
  assert.throws(() => decodeRec(receipt([routeInner(), tokenInner(3), tokenInner(2), swapInner(), tokenInner(3), tokenInner(2), witness()], logs)), /ADVISORY_TRADE_LOG_TRUNCATED/);
  // A second event CPI nested under one of the swap's own token children breaks unique subtree ownership.
  assert.throws(() => decodeRec(receipt([routeInner(), tokenInner(3), tokenInner(2), swapInner(), witness(), tokenInner(3), emitD4(sellEventBytes(blockTime))], logs)), /ADVISORY_TRADE_LOG_TRUNCATED/);
});

test('a non-Pump trace node with a missing or invalid stackHeight invalidates the recorded tree', () => {
  const decodeWith = (child: any) => decodeRec(receipt([swapInner(), child, emitInner(sellEventBytes(blockTime))], [`Program ${ROUTER} invoke [1]`, 'Log truncated']));
  assert.equal(decodeWith(tokenInner(3)).trades.length, 1);
  for (const bad of [undefined, null, 1, '3', 2.5]) assert.throws(() => decodeWith(tokenInner(bad)), /ADVISORY_TRADE_LOG_TRUNCATED/);
});

test('an impossible stackHeight jump anywhere in the recorded trace is rejected', () => {
  const logs = [`Program ${ROUTER} invoke [1]`, 'Log truncated'];
  assert.throws(() => decodeRec(receipt([swapInner(), tokenInner(4), emitInner(sellEventBytes(blockTime))], logs)), /ADVISORY_TRADE_LOG_TRUNCATED/);
  assert.throws(() => decodeRec(receipt([tokenInner(3), swapInner(), emitInner(sellEventBytes(blockTime))], logs)), /ADVISORY_TRADE_LOG_TRUNCATED/);
});

test('the retained log prefix must match the recorded trace preorder and its still-open frames', () => {
  const flat = () => [tokenInner(2), swapInner(), emitInner(sellEventBytes(blockTime))];
  assert.equal(decodeRec(receipt(flat(), [`Program ${ROUTER} invoke [1]`, `Program ${TOKEN} invoke [2]`, `Program ${TOKEN} success`, 'Log truncated'])).trades.length, 1);
  // A logged non-Pump invocation whose program differs from the recorded node at the same preorder position.
  assert.throws(() => decodeRec(receipt(flat(), [`Program ${ROUTER} invoke [1]`, `Program ${SYSTEM} invoke [2]`, `Program ${SYSTEM} success`, 'Log truncated'])), /ADVISORY_TRADE_LOG_TRUNCATED/);
  // An unlogged swap recorded under a route frame: accepted while that frame is still open, rejected once the retained log already closed it.
  const nested = () => [routeInner(), swapInner(3), emitD4(sellEventBytes(blockTime))];
  assert.equal(decodeRec(receipt(nested(), [`Program ${ROUTER} invoke [1]`, `Program ${ROUTER} invoke [2]`, 'Log truncated'])).trades.length, 1);
  assert.throws(() => decodeRec(receipt(nested(), [`Program ${ROUTER} invoke [1]`, `Program ${ROUTER} invoke [2]`, `Program ${ROUTER} success`, 'Log truncated'])), /ADVISORY_TRADE_LOG_TRUNCATED/);
});

// --- close-event identity is required: a close is execution-proven only through its own CloseUserVolumeAccumulatorEvent CPI child bound to the same user on an in-window clock, with exact 8-byte serialization. The swap recovers (2) but the bad close pair stays unproven (executionProven 2 !== unresolved 4), so the window gate rejects. ---
test('a wholly-unlogged close whose event-CPI child is a non-trade non-close event is not execution-proven', () => {
  const proof = decodeRec(receipt([swapInner(), emitInner(sellEventBytes(blockTime)), closeInner(), emitInner(eventBytes('initUserVolumeAccumulatorEvent', { timestamp: new BN(blockTime) }))], [
    `Program ${ROUTER} invoke [1]`, `Program ${program} invoke [2]`, 'Log truncated']));
  assert.equal(proof.trades.length, 1);
  assert.equal(proof.logRecovery!.unresolvedInvocations, 4);
  assert.equal(proof.logRecovery!.executionProvenInvocations, 2);
});

test('a wholly-unlogged close whose CloseEvent binds a different user is not execution-proven', () => {
  const wrongUser = closeEventBytes(blockTime, new PublicKey(Buffer.alloc(32, 9)));
  const proof = decodeRec(receipt([swapInner(), emitInner(sellEventBytes(blockTime)), closeInner(), emitInner(wrongUser)], [
    `Program ${ROUTER} invoke [1]`, `Program ${program} invoke [2]`, 'Log truncated']));
  assert.equal(proof.trades.length, 1);
  assert.equal(proof.logRecovery!.unresolvedInvocations, 4);
  assert.equal(proof.logRecovery!.executionProvenInvocations, 2);
});

test('a wholly-unlogged close carrying trailing bytes beyond its 8-byte discriminator is not execution-proven', () => {
  const closeJunk = { programId: program, accounts: closeAccounts, data: encodeSolanaAddress(Buffer.concat([closeData, Buffer.from([0])])), stackHeight: 2 };
  const proof = decodeRec(receipt([swapInner(), emitInner(sellEventBytes(blockTime)), closeJunk, emitInner(closeEventBytes(blockTime))], [
    `Program ${ROUTER} invoke [1]`, `Program ${program} invoke [2]`, 'Log truncated']));
  assert.equal(proof.trades.length, 1);
  assert.equal(proof.logRecovery!.unresolvedInvocations, 4);
  assert.equal(proof.logRecovery!.executionProvenInvocations, 2);
});
