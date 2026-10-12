import test from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { OFFLINE_PUMP_AMM_PROGRAM as sdk, PUMP_AMM_PROGRAM_ID, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, userVolumeAccumulatorPda, coinCreatorVaultAuthorityPda, poolPda } from '@pump-fun/pump-swap-sdk';
import { decodePumpSwapWindowTransaction } from '../src/providers/advisory-trades.js';
import { encodeSolanaAddress } from '../src/providers/solana.js';

// Builders mirror tests/advisory-window.test.ts; recovery is exercised on the transaction decoder directly.
const token = { chain: 'solana' as const, address: '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump' };
const user = new PublicKey(Buffer.alloc(32, 4)), baseVault = new PublicKey(Buffer.alloc(32, 5)), quoteVault = new PublicKey(Buffer.alloc(32, 6));
const creator = new PublicKey(Buffer.alloc(32, 7)), program = PUMP_AMM_PROGRAM_ID.toBase58();
const pool = poolPda(0, creator, new PublicKey(token.address), NATIVE_MINT).toBase58();
const otherPool = new PublicKey(Buffer.alloc(32, 9)).toBase58(), otherVault = new PublicKey(Buffer.alloc(32, 10)).toBase58();
const memo = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', router = 'ComputeBudget111111111111111111111111111111';
const cutoff = '2026-10-11T12:01:00.000Z', blockTime = Date.parse('2026-10-11T12:00:00.000Z') / 1000 - 10;
type Row = { signature: string; slot: number; blockTime: number | null };
const signature = (() => { const bytes = Buffer.alloc(64, 8); bytes.writeUInt32LE(1); return encodeSolanaAddress(bytes); })();
const reference: Row = { signature, slot: 9_999, blockTime };
const expected = { signature, slot: reference.slot, at: new Date(blockTime * 1000).toISOString() };
const state = { baseMint: new PublicKey(token.address), quoteMint: NATIVE_MINT, poolBaseTokenAccount: baseVault, poolQuoteTokenAccount: quoteVault } as any;
const decode = (tx: any, recovery = true) => decodePumpSwapWindowTransaction(tx, expected, pool, state, 10_001, cutoff, true, true, recovery);

function defaults(name: string): any {
  const type = sdk.idl.types!.find(t => t.name === name)!;
  const result: Record<string, unknown> = {};
  for (const f of (type.type as any).fields) result[f.name] = f.type === 'pubkey' ? user : f.type === 'bool' ? false : f.type === 'string' ? 'buy' : f.type === 'u8' || f.type === 'u16' ? 0 : new BN(0);
  return result;
}
function swap(reference: Row, side: 'BUY' | 'SELL' = 'BUY', quote = '9007199254740993'): any {
  const eventName = side === 'BUY' ? 'buyEvent' : 'sellEvent';
  const event = { ...defaults(eventName), timestamp: new BN(reference.blockTime!), pool: new PublicKey(pool), user,
    userBaseTokenAccount: baseVault, userQuoteTokenAccount: quoteVault, poolBaseTokenReserves: new BN(100000), poolQuoteTokenReserves: new BN(1000000),
    baseAmountOut: new BN(500), baseAmountIn: new BN(500), quoteAmountIn: new BN(quote), quoteAmountOut: new BN(quote), quoteAmountInWithLpFee: new BN(quote), quoteAmountOutWithoutLpFee: new BN(quote), userQuoteAmountIn: new BN(quote), userQuoteAmountOut: new BN(quote) };
  const payload = Buffer.concat([Buffer.from(sdk.idl.events!.find(x => x.name === eventName)!.discriminator), sdk.coder.types.encode(eventName, event)]).toString('base64');
  const data = sdk.coder.instruction.encode(side === 'BUY' ? 'buy' : 'sell', side === 'BUY' ? { baseAmountOut: new BN(500), maxQuoteAmountIn: new BN(quote), trackVolume: { 0: true } } : { baseAmountIn: new BN(500), minQuoteAmountOut: new BN(0) });
  const accounts = [pool, user.toBase58(), user.toBase58(), token.address, NATIVE_MINT.toBase58(), baseVault.toBase58(), quoteVault.toBase58(), baseVault.toBase58(), quoteVault.toBase58(), user.toBase58(), user.toBase58(), user.toBase58(), user.toBase58(), user.toBase58(), user.toBase58(), user.toBase58(), program];
  return { version: 1, slot: reference.slot, blockTime: reference.blockTime, transaction: { signatures: [reference.signature], message: {
    accountKeys: [...new Set(accounts)].map(pubkey => ({ pubkey, signer: pubkey === user.toBase58() })), instructions: [{ programId: program, accounts, data: encodeSolanaAddress(data) }] } },
    meta: { err: null, preTokenBalances: [], postTokenBalances: [], innerInstructions: [], logMessages: [`Program ${program} invoke [1]`, `Program data: ${payload}`, `Program ${program} success`] } };
}
type V2Method = 'buy_v2' | 'buy_exact_quote_in_v2' | 'sell_v2';
const currentDiscriminators = {
  buy_v2: [184, 23, 238, 97, 103, 197, 211, 61],
  buy_exact_quote_in_v2: [194, 171, 28, 70, 104, 77, 91, 47],
  sell_v2: [93, 246, 130, 60, 231, 233, 64, 178],
  sweep_creator_fee: [32, 246, 191, 52, 8, 201, 73, 186],
  sweep_protocol_fee: [8, 48, 190, 7, 182, 68, 183, 229],
};
const eventAuthority = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP_AMM_PROGRAM_ID)[0].toBase58();
function currentArguments(method: V2Method, first: bigint, second: bigint) {
  const result = Buffer.alloc(24); Buffer.from(currentDiscriminators[method]).copy(result);
  result.writeBigUInt64LE(first, 8); result.writeBigUInt64LE(second, 16); return encodeSolanaAddress(result);
}
function bindKeys(tx: any) {
  const previous = new Map(tx.transaction.message.accountKeys.map((k: any) => [k.pubkey, k.signer]));
  tx.transaction.message.accountKeys = [...new Set(tx.transaction.message.instructions.flatMap((i: any) => [...i.accounts, i.programId]))].map(pubkey => ({ pubkey, signer: previous.get(pubkey) === true }));
}
function swapV2(reference: Row, method: V2Method): any {
  const tx = swap(reference, method === 'sell_v2' ? 'SELL' : 'BUY'), ix = tx.transaction.message.instructions[0];
  ix.data = currentArguments(method, method === 'buy_exact_quote_in_v2' ? 9007199254741000n : 500n, method === 'buy_v2' ? 9007199254741000n : method === 'sell_v2' ? 1n : 500n);
  ix.accounts[2] = GLOBAL_CONFIG_PDA.toBase58(); ix.accounts[9] = TOKEN_PROGRAM_ID.toBase58(); ix.accounts[10] = TOKEN_PROGRAM_ID.toBase58();
  ix.accounts[11] = '11111111111111111111111111111111'; ix.accounts[15] = eventAuthority;
  ix.accounts[12] = userVolumeAccumulatorPda(user).toBase58(); ix.accounts[13] = PUMP_AMM_FEE_CONFIG_PDA.toBase58();
  const decoded = sdk.coder.events.decode(tx.meta.logMessages[1].slice(14))!, event = decoded.data as any;
  event.ixName = method; event.maxQuoteAmountIn = new BN('9007199254741000'); event.minBaseAmountOut = new BN(500); event.minQuoteAmountOut = new BN(1);
  event.lpFee = new BN(2); event.protocolFee = new BN(3); event.coinCreatorFee = new BN(2);
  event.quoteAmountIn = new BN(method === 'buy_exact_quote_in_v2' ? '9007199254741000' : '9007199254740993');
  event.userQuoteAmountIn = new BN(method === 'buy_exact_quote_in_v2' ? '9007199254740993' : '9007199254741000');
  event.quoteAmountInWithLpFee = new BN('9007199254740995');
  event.userQuoteAmountOut = new BN('9007199254740986'); event.quoteAmountOutWithoutLpFee = new BN('9007199254740991');
  event.buybackFee = new BN(1);
  const suffix = Buffer.alloc(24);
  const payload = Buffer.concat([Buffer.from(sdk.idl.events!.find(e => e.name === decoded.name)!.discriminator), sdk.coder.types.encode(decoded.name, event), suffix]);
  tx.meta.logMessages[1] = `Program data: ${payload.toString('base64')}`; bindKeys(tx); return tx;
}
function mutateSwapEvent(tx: any, change: (event: any) => void) {
  const payload = Buffer.from(tx.meta.logMessages[1].slice(14), 'base64'), decoded = sdk.coder.events.decode(payload.toString('base64'))!;
  const suffix = payload.subarray(8 + sdk.coder.types.encode(decoded.name, decoded.data).length);
  change(decoded.data);
  tx.meta.logMessages[1] = `Program data: ${Buffer.concat([Buffer.from(sdk.idl.events!.find(e => e.name === decoded.name)!.discriminator), sdk.coder.types.encode(decoded.name, decoded.data), suffix]).toString('base64')}`;
}
// Same accounting as accountingSwap(reference, 'sell_v2') in the window tests.
function sellV2(reference: Row): any {
  const core = 9007199254740993n, userQuote = core - 7n, tx = swapV2(reference, 'sell_v2');
  tx.transaction.message.instructions[0].data = currentArguments('sell_v2', 500n, userQuote);
  mutateSwapEvent(tx, event => {
    event.ixName = 'sell_v2'; event.lpFee = new BN(2); event.protocolFee = new BN(3); event.coinCreatorFee = new BN(2); event.buybackFee = new BN(1); event.cashback = new BN(0);
    event.quoteAmountIn = new BN(core.toString()); event.userQuoteAmountIn = new BN(userQuote.toString()); event.quoteAmountInWithLpFee = new BN((core + 2n).toString());
    event.quoteAmountOut = new BN(core.toString()); event.userQuoteAmountOut = new BN(userQuote.toString()); event.quoteAmountOutWithoutLpFee = new BN((core - 2n).toString());
    event.maxQuoteAmountIn = new BN(core.toString()); event.minBaseAmountOut = new BN(500); event.minQuoteAmountOut = new BN(userQuote.toString());
  });
  return tx;
}
function feeSweep(reference: Row, method: 'sweep_creator_fee' | 'sweep_protocol_fee'): any {
  const tx = swap(reference), recipient = coinCreatorVaultAuthorityPda(user);
  const accounts = [user.toBase58(), GLOBAL_CONFIG_PDA.toBase58(), pool, NATIVE_MINT.toBase58(), TOKEN_PROGRAM_ID.toBase58(), quoteVault.toBase58(), recipient.toBase58(), getAssociatedTokenAddressSync(NATIVE_MINT, recipient, true).toBase58(), '11111111111111111111111111111111', ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), eventAuthority, program];
  tx.transaction.message.instructions = [{ programId: program, accounts, data: encodeSolanaAddress(Buffer.from(currentDiscriminators[method])) }];
  const prefix = Buffer.alloc(16); Buffer.from([130, 164, 36, 97, 228, 130, 135, 165]).copy(prefix); prefix.writeBigInt64LE(BigInt(reference.blockTime!), 8);
  const amount = Buffer.alloc(9); amount.writeBigUInt64LE(9007199254740993n); amount[8] = method === 'sweep_creator_fee' ? 1 : 0;
  const payload = Buffer.concat([prefix, new PublicKey(pool).toBuffer(), new PublicKey(token.address).toBuffer(), NATIVE_MINT.toBuffer(), recipient.toBuffer(), user.toBuffer(), amount]);
  tx.meta.logMessages = [`Program ${program} invoke [1]`, `Program data: ${payload.toString('base64')}`, `Program ${program} success`];
  bindKeys(tx); return tx;
}
// A later top-level instruction whose frame the runtime truncated; retained short lines follow the marker.
function truncateAfter(tx: any, tail: string[] = []) {
  tx.transaction.message.instructions.push({ programId: memo, accounts: [], data: '' });
  tx.transaction.message.accountKeys.push({ pubkey: memo, signer: false });
  tx.meta.logMessages.push(`Program ${memo} invoke [1]`, 'Log truncated', ...tail);
  return tx;
}
// The swap runs at depth 3 under a depth-2 router; only meta.err proves the depth-1 frame.
function nested(closeRouter: boolean) {
  const tx = sellV2(reference), [swapIx] = tx.transaction.message.instructions, data = tx.meta.logMessages[1];
  tx.transaction.message.instructions = [{ programId: memo, accounts: [], data: '' }];
  tx.transaction.message.accountKeys.push({ pubkey: memo, signer: false }, { pubkey: router, signer: false });
  tx.meta.innerInstructions = [{ index: 0, instructions: [{ programId: router, accounts: [], data: '', stackHeight: 2 }, { ...swapIx, stackHeight: 3 }] }];
  tx.meta.logMessages = [`Program ${memo} invoke [1]`, `Program ${router} invoke [2]`, `Program ${program} invoke [3]`, data, `Program ${program} success`, ...(closeRouter ? [`Program ${router} success`] : []), 'Log truncated'];
  return tx;
}
function emptySweep(foreign = true, line = 'Program log: Nothing to sweep for fee bucket 1', cpi = false) {
  const tx = feeSweep(reference, 'sweep_creator_fee'), ix = tx.transaction.message.instructions[0], token2 = TOKEN_PROGRAM_ID.toBase58();
  if (foreign) { ix.accounts[2] = otherPool; ix.accounts[5] = otherVault; }
  tx.meta.logMessages = [`Program ${program} invoke [1]`, 'Program log: Instruction: SweepCreatorFee', ...(line ? [line] : []), ...(cpi ? [`Program ${token2} invoke [2]`, `Program ${token2} success`] : []), `Program ${program} success`];
  bindKeys(tx); return tx;
}

test('runtime log truncation after every closed flow frame is recovered only under the opt-in decoder', () => {
  const complete = decode(sellV2(reference), false), tx = truncateAfter(sellV2(reference), [`Program ${program} invoke [1]`]);
  assert.equal('logRecovery' in complete, false);
  assert.throws(() => decode(tx, false), /ADVISORY_TRADE_LOG_DEPTH/);
  assert.throws(() => decode(truncateAfter(sellV2(reference)), false), /ADVISORY_TRADE_LOG_INCOMPLETE/);
  const proof = decode(tx);
  assert.deepEqual(proof.trades, complete.trades);
  assert.deepEqual(proof.logRecovery, { truncated: true, unresolvedInvocations: 0, emptyForeignSweeps: 0 });
  assert.deepEqual(decode(sellV2(reference)).logRecovery, { truncated: false, unresolvedInvocations: 0, emptyForeignSweeps: 0 });
  assert.throws(() => decodePumpSwapWindowTransaction(tx, expected, pool, state, 10_001, cutoff, true, false, true), /ADVISORY_TRADE_RECOVERY_SCOPE/);
});

test('flow frames, open nested ancestors, repeated markers and selected-pool invocations after truncation stay unsupported', () => {
  const open = sellV2(reference); open.meta.logMessages = [open.meta.logMessages[0], open.meta.logMessages[1], 'Log truncated', `Program ${program} success`];
  assert.throws(() => decode(open), /ADVISORY_TRADE_LOG_TRUNCATED/);
  assert.throws(() => decode(nested(false)), /ADVISORY_TRADE_LOG_TRUNCATED/);
  assert.equal(decode(nested(true)).trades.length, 1);
  const sweep = sellV2(reference); sweep.transaction.message.instructions.push(feeSweep(reference, 'sweep_protocol_fee').transaction.message.instructions[0]); bindKeys(sweep); sweep.meta.logMessages.push('Log truncated');
  assert.throws(() => decode(sweep), /ADVISORY_TRADE_LOG_TRUNCATED/);
  const repeated = sellV2(reference); repeated.meta.logMessages.push('Log truncated', 'Log truncated');
  assert.throws(() => decode(repeated), /ADVISORY_TRADE_LOG_SHAPE/);
});

test('a foreign fee sweep with no CPI and no event is a bounded non-flow invocation only under the opt-in decoder', () => {
  assert.throws(() => decode(emptySweep(), false), /ADVISORY_TRADE_EVENT_MISSING/);
  const proof = decode(emptySweep());
  assert.deepEqual(proof.trades, []); assert.equal(proof.nonSwapInvocations, 1);
  assert.deepEqual(proof.logRecovery, { truncated: false, unresolvedInvocations: 0, emptyForeignSweeps: 1 });
  assert.throws(() => decode(emptySweep(false)), /ADVISORY_TRADE_EVENT_MISSING/);
  assert.throws(() => decode(emptySweep(true, '')), /ADVISORY_TRADE_EVENT_MISSING/);
  assert.throws(() => decode(emptySweep(true, undefined, true)), /ADVISORY_TRADE_EVENT_MISSING/);
  assert.throws(() => decode(emptySweep(true, 'Program log: Nothing to sweep for fee bucket 0')), /ADVISORY_TRADE_SWEEP_EVENT_BINDING/);
});
