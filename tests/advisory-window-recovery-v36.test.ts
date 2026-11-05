import test from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { PUMP_AMM_PROGRAM_ID, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, userVolumeAccumulatorPda, poolPda } from '@pump-fun/pump-swap-sdk';
import { encodeSolanaAddress } from '../src/providers/solana.js';
import { decodePumpSwapWindowTransaction } from '../src/providers/advisory-trades.js';
import { sdk, emitData } from './window-v36-fixtures.js';

// Proof36 route/recovery binding under the extended flag (arg 14) and the verified selected-pool quote
// decimals (arg 15). CONSTRUCTED_SOURCE_CONFORMANCE: synthetic receipts built with the installed SDK coder,
// adapted from the proof35 truncation (#62) and multi-hop SELL repro shapes. The extended flag is a clean
// superset for untaxed routes, so existing recovery and route-binding behaviour must be preserved exactly.
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
function defaults(name: string): any { const type = sdk.idl.types!.find(t => t.name === name)!; const result: Record<string, unknown> = {}; for (const f of (type.type as any).fields) result[f.name] = f.type === 'pubkey' ? user : f.type === 'bool' ? false : f.type === 'u8' || f.type === 'u16' ? 0 : new BN(0); return result; }
const swapAccounts = [pool, user.toBase58(), GLOBAL_CONFIG_PDA.toBase58(), token.address, NATIVE_MINT.toBase58(), baseVault.toBase58(), quoteVault.toBase58(), baseVault.toBase58(), quoteVault.toBase58(), TOKEN_PROGRAM_ID.toBase58(), TOKEN_PROGRAM_ID.toBase58(), SYSTEM, userVolumeAccumulatorPda(user).toBase58(), PUMP_AMM_FEE_CONFIG_PDA.toBase58(), user.toBase58(), eventAuthority, program];
const closeAccounts = [user.toBase58(), userVolumeAccumulatorPda(user).toBase58(), eventAuthority, program];
const sellData = Buffer.alloc(24); Buffer.from([93, 246, 130, 60, 231, 233, 64, 178]).copy(sellData); sellData.writeBigUInt64LE(500n, 8); sellData.writeBigUInt64LE(0n, 16);
function sellEventBytes(ts: number, poolKey: string = pool, appendix = 24, core = 1000000n): Buffer {
  const lp = 2n, protocol = 4n, creatorFee = 2n, fees = lp + protocol + creatorFee, userQuote = core - fees;
  const event = { ...defaults('sellEvent'), timestamp: new BN(ts), pool: new PublicKey(poolKey), user, userBaseTokenAccount: baseVault, userQuoteTokenAccount: quoteVault, poolBaseTokenReserves: new BN(100000), poolQuoteTokenReserves: new BN(1000000), baseAmountIn: new BN(500), quoteAmountOut: new BN(core.toString()), userQuoteAmountOut: new BN(userQuote.toString()), quoteAmountOutWithoutLpFee: new BN((core - lp).toString()), minQuoteAmountOut: new BN(0), lpFee: new BN(2), protocolFee: new BN(4), coinCreatorFee: new BN(2), buybackFee: new BN(2), cashback: new BN(0) };
  return Buffer.concat([Buffer.from(sdk.idl.events!.find(e => e.name === 'sellEvent')!.discriminator), sdk.coder.types.encode('sellEvent', event), Buffer.alloc(appendix)]);
}
const swapInner = (sh = 2) => ({ programId: program, accounts: swapAccounts, data: encodeSolanaAddress(sellData), stackHeight: sh });
const emitInner = (bytes: Buffer) => ({ programId: program, accounts: [eventAuthority], data: encodeSolanaAddress(emitData(bytes)), stackHeight: 3 });
function receipt(inner: any[], logMessages: string[], opts: { err?: unknown; top?: string } = {}): any {
  const top = opts.top ?? ROUTER;
  const keys = [...new Set([...swapAccounts, ...closeAccounts, program, eventAuthority, top])];
  return { version: 1, slot, blockTime, transaction: { signatures: ['sig1'], message: { accountKeys: keys.map(pubkey => ({ pubkey, signer: pubkey === user.toBase58() })), instructions: [{ programId: top, accounts: swapAccounts, data: encodeSolanaAddress(Buffer.from([1])) }] } }, meta: { err: opts.err ?? null, innerInstructions: inner.length ? [{ index: 0, instructions: inner }] : [], logMessages } };
}
// extended (arg 14) + selected-pool quote decimals (arg 15) recovery decode.
const decodeRecExt = (tx: any, quoteDecimals = 9) => decodePumpSwapWindowTransaction(tx, { signature: 'sig1', slot, at }, pool, poolFixture, slot, retrieved, true, true, true, false, false, true, undefined, true, quoteDecimals);

test('extended recovery still proves a selected swap whose frame and emit_cpi are cut by truncation (#62 shape)', () => {
  const bytes = sellEventBytes(blockTime), p = bytes.toString('base64');
  const proof = decodeRecExt(receipt([swapInner(), emitInner(bytes)], [`Program ${ROUTER} invoke [1]`, `Program ${program} invoke [2]`, `Program data: ${p}`, `Program ${program} invoke [3]`, 'Log truncated']));
  assert.equal(proof.trades.length, 1);
  assert.equal(proof.trades[0]!.side, 'SELL');
  assert.equal(proof.trades[0]!.quoteAtomic, '1000000');
  assert.equal(proof.logRecovery!.truncated, true);
});

test('extended recovery still refuses to reuse a logged trade when the unlogged emit_cpi child binds a different pool', () => {
  const p = sellEventBytes(blockTime).toString('base64');
  const forged = sellEventBytes(blockTime, quoteVault.toBase58());
  assert.throws(() => decodeRecExt(receipt([swapInner(), emitInner(forged)], [`Program ${ROUTER} invoke [1]`, `Program ${program} invoke [2]`, `Program data: ${p}`, 'Log truncated'])), /ADVISORY_TRADE_LOG_TRUNCATED/);
});

// --- selected multi-hop SELL route (B -> A -> SOL): hop0 is B's foreign bonding curve, hop1 the selected A/WSOL pool ---
const TOKEN_2022 = TOKEN_2022_PROGRAM_ID.toBase58();
const PUMP_CURVE_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_CURVE_GLOBAL = '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf';
const PUMP_CURVE_FEE_CONFIG = '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt';
const PUMP_CURVE_EVENT_AUTHORITY = 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1';
const cMint = new PublicKey(Buffer.alloc(32, 19)).toBase58();
const bMint = new PublicKey(Buffer.alloc(32, 9)).toBase58();
const wsolAccount = new PublicKey(Buffer.alloc(32, 10)).toBase58(), bAccount = new PublicKey(Buffer.alloc(32, 11)).toBase58();
const bCurve = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(bMint).toBuffer()], new PublicKey(PUMP_CURVE_PROGRAM))[0].toBase58(), bCurveBase = new PublicKey(Buffer.alloc(32, 13)).toBase58(), bCurveQuote = new PublicKey(Buffer.alloc(32, 14)).toBase58();
const buyback = new PublicKey(Buffer.alloc(32, 15)).toBase58();
function mhEvent(): Buffer {
  // Selected A/WSOL pool is the last (protocol) SELL hop, not the target hop, so under the proof36 route
  // masks it carries protocol fee only: lp, creator and holder must be 0 on this hop.
  const core = 1000000n, lp = 0n, protocol = 4n, creatorFee = 0n, fees = lp + protocol + creatorFee, userQuote = core - fees;
  const event = { ...defaults('sellEvent'), timestamp: new BN(blockTime), pool: new PublicKey(pool), user, userBaseTokenAccount: PublicKey.default, userQuoteTokenAccount: new PublicKey(wsolAccount), poolBaseTokenReserves: new BN(100000), poolQuoteTokenReserves: new BN(1000000), baseAmountIn: new BN(500), quoteAmountOut: new BN(core.toString()), userQuoteAmountOut: new BN(userQuote.toString()), quoteAmountOutWithoutLpFee: new BN((core - lp).toString()), minQuoteAmountOut: new BN(0), lpFee: new BN(0), protocolFee: new BN(4), coinCreatorFee: new BN(0), buybackFee: new BN(0), cashback: new BN(0) };
  return Buffer.concat([Buffer.from(sdk.idl.events!.find(e => e.name === 'sellEvent')!.discriminator), sdk.coder.types.encode('sellEvent', event), Buffer.alloc(24)]);
}
function multiHopSell(opts: { badGlobal?: boolean; breakRoute?: boolean; omitCpi?: boolean } = {}): any {
  const eventBytes = mhEvent(), payload = eventBytes.toString('base64');
  const mh = Buffer.alloc(24); Buffer.from([43, 100, 73, 19, 233, 246, 111, 148]).copy(mh); mh.writeBigUInt64LE(500n, 8); mh.writeBigUInt64LE(1n, 16);
  const hop0Quote = opts.breakRoute ? cMint : token.address;
  const accounts = [user.toBase58(), bAccount, wsolAccount, GLOBAL_CONFIG_PDA.toBase58(), PUMP_AMM_FEE_CONFIG_PDA.toBase58(), userVolumeAccumulatorPda(user).toBase58(), buyback, TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022, SYSTEM, eventAuthority, program, PUMP_CURVE_PROGRAM, opts.badGlobal ? buyback : PUMP_CURVE_GLOBAL, PUMP_CURVE_FEE_CONFIG, PUMP_CURVE_EVENT_AUTHORITY, bMint, hop0Quote, bCurve, bCurveBase, bCurveQuote, token.address, NATIVE_MINT.toBase58(), pool, baseVault.toBase58(), quoteVault.toBase58()];
  const curveInner = { programId: PUMP_CURVE_PROGRAM, accounts: [user.toBase58()], data: encodeSolanaAddress(Buffer.alloc(8)), stackHeight: 2 };
  const emitI = { programId: program, accounts: [eventAuthority], data: encodeSolanaAddress(emitData(eventBytes)), stackHeight: 2 };
  const logMessages = [`Program ${program} invoke [1]`, `Program ${PUMP_CURVE_PROGRAM} invoke [2]`, `Program ${PUMP_CURVE_PROGRAM} success`, `Program data: ${payload}`];
  if (!opts.omitCpi) logMessages.push(`Program ${program} invoke [2]`, `Program ${program} success`);
  logMessages.push(`Program ${program} success`);
  const keys = [...new Set([...accounts, program, PUMP_CURVE_PROGRAM, eventAuthority])];
  return { version: 1, slot, blockTime, transaction: { signatures: ['sig1'], message: { accountKeys: keys.map(pubkey => ({ pubkey, signer: pubkey === user.toBase58() })), instructions: [{ programId: program, accounts, data: encodeSolanaAddress(mh) }] } }, meta: { err: null, innerInstructions: [{ index: 0, instructions: opts.omitCpi ? [curveInner] : [curveInner, emitI] }], logMessages } };
}
const decodeMhExt = (tx: any, quoteDecimals = 9) => decodePumpSwapWindowTransaction(tx, { signature: 'sig1', slot, at }, pool, poolFixture, slot, retrieved, true, true, false, false, false, true, undefined, true, quoteDecimals);

test('extended counts a valid selected multi-hop SELL (B->A->SOL) exactly once against the verified quote decimals', () => {
  const proof = decodeMhExt(multiHopSell());
  assert.equal(proof.trades.length, 1);
  assert.equal(proof.trades[0]!.side, 'SELL');
  assert.equal(proof.trades[0]!.instructionName, 'multi_hop_swap');
  assert.equal(proof.trades[0]!.quoteAtomic, '1000000');
});

test('extended preserves the multi-hop global-PDA, route-continuity and one-to-one event-CPI bindings', () => {
  assert.throws(() => decodeMhExt(multiHopSell({ badGlobal: true })), /ADVISORY_TRADE_MULTIHOP_ACCOUNT_BINDING/);
  assert.throws(() => decodeMhExt(multiHopSell({ breakRoute: true })), /ADVISORY_TRADE_MULTIHOP_ROUTE/);
  assert.throws(() => decodeMhExt(multiHopSell({ omitCpi: true })), /ADVISORY_TRADE_EVENT_CPI_BINDING/);
});
