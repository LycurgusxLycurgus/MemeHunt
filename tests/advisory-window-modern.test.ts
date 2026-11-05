import test from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { OFFLINE_PUMP_AMM_PROGRAM as sdk, PUMP_AMM_PROGRAM_ID, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, userVolumeAccumulatorPda, poolPda } from '@pump-fun/pump-swap-sdk';
import { encodeSolanaAddress } from '../src/providers/solana.js';
import { decodePumpSwapWindowTransaction } from '../src/providers/advisory-trades.js';
import { decodeAdvisoryWindow, deriveO28Window, decodeWindowQuote, type AdvisoryWindowHistory } from '../src/providers/advisory-window.js';

// Shape, scope-guard and real-decode coverage for the proof35 modern additions. The four historical corpora
// (BOUNCER/USDC/TTWO-peer/native incl. multi-hop) and the fresh BOUNCER capture are exercised end to end by
// the real-network acceptance entrypoints; these tests drive the production decoders on synthetic receipts.
const WSOL = NATIVE_MINT.toBase58();
const TTWO = 'TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo';
const TOKEN_2022 = TOKEN_2022_PROGRAM_ID.toBase58();
const LEGACY_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const BOUNCER = 'Gv6jKrrjJW9NLZujVZdxj6D9xL21qcLbHso8LYFMpump';
const POOL_BASE = 'EwwakfDng22Qv5f7qCPGH1ohrQDWocb38MHRJtcWYEv2';

// --- deriveO28Window descriptor coverage -------------------------------------------------------------
const base = (over: Partial<AdvisoryWindowHistory>): AdvisoryWindowHistory => ({
  method: 'pumpswap-selected-pool-window-v4', token: { chain: 'solana', address: BOUNCER }, pool: POOL_BASE,
  window: { start: '2026-10-24T09:00:00.000Z', end: '2026-10-24T10:00:00.000Z' }, genesisVerified: true,
  anchorSlot: 1, anchorTime: '2026-10-24T10:00:30.000Z', poolVerified: true, stateSlot: 2, coverageReachedStart: true,
  indexComplete: true, complete: true, sourceUniverseComplete: false, pages: [], successfulSignatures: 1, failedReferences: 0,
  transactions: [{ signature: 's', slot: 1, at: '2026-10-24T09:30:00.000Z', status: 'OBSERVED', trades: 1 }],
  trades: [], buyQuoteAtomic: '0', sellQuoteAtomic: '0', netQuoteAtomic: '0', foreignSwapLegs: 0, nonSwapInvocations: 0,
  cpiAuthorizedAccounts: [], limitations: [], reasonCode: 'SELECTED_POOL_WINDOW_FLOW_OBSERVED', ...over });

test('O28 without a decoded quote reproduces the exact proof1-34 WSOL shape with no quoteProgram', () => {
  const data = base({ quote: undefined });
  const metric = deriveO28Window(data, ['e', 'e']);
  assert.deepEqual(metric, { id: 'O28', quality: 'KNOWN', unit: 'WSOL quote flow', data: { ...data,
    scope: 'VERIFIED_PUMPSWAP_WSOL_POOL', wholeTokenFlow: null, otherPools: 'EXCLUDED', newCapital: null,
    quoteMint: WSOL, quoteDecimals: 9, uniqueBuyerAccounts: [], uniqueSellerAccounts: [], economicBuyerCount: null, economicSellerCount: null },
    evidenceIds: ['e'], reasonCode: 'SELECTED_POOL_WINDOW_FLOW_OBSERVED' });
  assert.equal('quoteProgram' in (metric.data as Record<string, unknown>), false);
});

test('O28 custom quote exposes the verified quote mint, decimals and program', () => {
  const m = deriveO28Window(base({ method: 'pumpswap-selected-pool-window-v5', quote: { mint: TTWO, decimals: 6, program: TOKEN_2022 } }), ['e']);
  const d = m.data as any;
  assert.equal(m.quality, 'KNOWN');
  assert.equal(m.unit, 'quote-token fee-exclusive core flow');
  assert.equal(d.scope, 'VERIFIED_PUMPSWAP_DIRECT_QUOTE_POOL');
  assert.equal(d.quoteMint, TTWO);
  assert.equal(d.quoteDecimals, 6);
  assert.equal(d.quoteProgram, TOKEN_2022);
});

test('O28 modern WSOL window keeps the WSOL scope/unit but records the verified quote program', () => {
  const d = deriveO28Window(base({ quote: { mint: WSOL, decimals: 9, program: LEGACY_TOKEN } }), ['e']).data as any;
  assert.equal(d.scope, 'VERIFIED_PUMPSWAP_WSOL_POOL');
  assert.equal(d.quoteMint, WSOL);
  assert.equal(d.quoteDecimals, 9);
  assert.equal(d.quoteProgram, LEGACY_TOKEN);
});

// --- scope guards ------------------------------------------------------------------------------------
test('modern window decode requires the expanded acquisition geometry', () => {
  assert.throws(() => decodeAdvisoryWindow({ chain: 'solana', address: BOUNCER }, POOL_BASE, '2026-10-24T10:00:00.000Z', {}, {}, {}, '2026-10-24T11:00:00.000Z', true, true, true, true, false, true), /ADVISORY_WINDOW_MODERN_SCOPE/);
});

test('modern transaction decode requires the fee-exclusive scope', () => {
  assert.throws(() => decodePumpSwapWindowTransaction({}, { signature: 's', slot: 1, at: '2026-10-24T09:30:00.000Z' }, 'p', {} as any, 2, '2026-10-24T10:00:00.000Z', true, false, false, false, false, true), /ADVISORY_TRADE_MODERN_SCOPE/);
});

// --- decodeWindowQuote: the modern final quote-mint bank read via installed SPL unpackMint -------------
function mintValue(owner: string, decimals: number, opts: { len?: number; typeByte?: number; initialized?: number } = {}) {
  const b = Buffer.alloc(opts.len ?? 82); b[44] = decimals; b[45] = opts.initialized ?? 1; if ((opts.len ?? 82) > 82) b[165] = opts.typeByte ?? 1;
  return { owner, executable: false, data: [b.toString('base64'), 'base64'] };
}
test('decodeWindowQuote accepts an initialized 6-decimal Token-2022 quote mint', () => {
  assert.deepEqual(decodeWindowQuote(mintValue(TOKEN_2022, 6), TTWO), { mint: TTWO, decimals: 6, program: TOKEN_2022 });
});
test('decodeWindowQuote accepts a 9-decimal legacy WSOL mint', () => {
  assert.deepEqual(decodeWindowQuote(mintValue(LEGACY_TOKEN, 9), WSOL), { mint: WSOL, decimals: 9, program: LEGACY_TOKEN });
});
test('decodeWindowQuote rejects a non-token-program owner', () => {
  assert.throws(() => decodeWindowQuote(mintValue(BOUNCER, 6), TTWO), /ADVISORY_WINDOW_QUOTE_SHAPE/);
});
test('decodeWindowQuote rejects a Token-2022 account whose type tag is not Mint', () => {
  assert.throws(() => decodeWindowQuote(mintValue(TOKEN_2022, 6, { len: 200, typeByte: 2 }), TTWO), /ADVISORY_WINDOW_QUOTE_SHAPE/);
});
test('decodeWindowQuote rejects a truncated or uninitialized mint account', () => {
  assert.throws(() => decodeWindowQuote(mintValue(TOKEN_2022, 6, { len: 40 }), TTWO), /ADVISORY_WINDOW_QUOTE_SHAPE/);
  assert.throws(() => decodeWindowQuote(mintValue(LEGACY_TOKEN, 9, { initialized: 0 }), WSOL), /ADVISORY_WINDOW_QUOTE_SHAPE/);
});

// --- real modern decode: event clock, +32 custom quote and selected multi-hop SELL --------------------
const token = { chain: 'solana' as const, address: '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump' };
const user = new PublicKey(Buffer.alloc(32, 4)), baseVault = new PublicKey(Buffer.alloc(32, 5)), quoteVault = new PublicKey(Buffer.alloc(32, 6)), creator = new PublicKey(Buffer.alloc(32, 7));
const customMint = new PublicKey(Buffer.alloc(32, 8));
const program = PUMP_AMM_PROGRAM_ID.toBase58();
const pool = poolPda(0, creator, new PublicKey(token.address), NATIVE_MINT).toBase58();
const eventAuthority = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP_AMM_PROGRAM_ID)[0].toBase58();
const HOUR = 1760785200, blockTime = HOUR + 1800, slot = 1000;
const at = new Date(blockTime * 1000).toISOString(), retrieved = new Date((blockTime + 120) * 1000).toISOString();
function defaults(name: string): any {
  const type = sdk.idl.types!.find(t => t.name === name)!;
  const result: Record<string, unknown> = {};
  for (const f of (type.type as any).fields) result[f.name] = f.type === 'pubkey' ? user : f.type === 'bool' ? false : f.type === 'u8' || f.type === 'u16' ? 0 : new BN(0);
  return result;
}
function sellEventBytes(ts: number, quoteOut: PublicKey, baseAcc: PublicKey, appendix: number): Buffer {
  const core = 1000000n, lp = 2n, protocol = 4n, creatorFee = 2n, fees = lp + protocol + creatorFee, userQuote = core - fees;
  const event = { ...defaults('sellEvent'), timestamp: new BN(ts), pool: new PublicKey(pool), user, userBaseTokenAccount: baseAcc, userQuoteTokenAccount: quoteOut,
    poolBaseTokenReserves: new BN(100000), poolQuoteTokenReserves: new BN(1000000), baseAmountIn: new BN(500), quoteAmountOut: new BN(core.toString()),
    userQuoteAmountOut: new BN(userQuote.toString()), quoteAmountOutWithoutLpFee: new BN((core - lp).toString()), minQuoteAmountOut: new BN(0),
    lpFee: new BN(2), protocolFee: new BN(4), coinCreatorFee: new BN(2), buybackFee: new BN(2), cashback: new BN(0) };
  return Buffer.concat([Buffer.from(sdk.idl.events!.find(e => e.name === 'sellEvent')!.discriminator), sdk.coder.types.encode('sellEvent', event), Buffer.alloc(appendix)]);
}
function modernSell(ts: number, opts: { quoteMint?: PublicKey; quoteProgram?: string; appendix?: number } = {}): any {
  const quoteMint = opts.quoteMint ?? NATIVE_MINT, quoteProgram = opts.quoteProgram ?? TOKEN_PROGRAM_ID.toBase58(), appendix = opts.appendix ?? 24;
  const payload = sellEventBytes(ts, quoteVault, baseVault, appendix).toString('base64');
  const data = Buffer.alloc(24); Buffer.from([93, 246, 130, 60, 231, 233, 64, 178]).copy(data); data.writeBigUInt64LE(500n, 8); data.writeBigUInt64LE(0n, 16);
  const accounts = [pool, user.toBase58(), GLOBAL_CONFIG_PDA.toBase58(), token.address, quoteMint.toBase58(), baseVault.toBase58(), quoteVault.toBase58(), baseVault.toBase58(), quoteVault.toBase58(), TOKEN_PROGRAM_ID.toBase58(), quoteProgram, '11111111111111111111111111111111', userVolumeAccumulatorPda(user).toBase58(), PUMP_AMM_FEE_CONFIG_PDA.toBase58(), user.toBase58(), eventAuthority, program];
  return { version: 1, slot, blockTime, transaction: { signatures: ['sig1'], message: {
    accountKeys: [...new Set(accounts)].map(pubkey => ({ pubkey, signer: pubkey === user.toBase58() })), instructions: [{ programId: program, accounts, data: encodeSolanaAddress(data) }] } },
    meta: { err: null, innerInstructions: [], logMessages: [`Program ${program} invoke [1]`, `Program data: ${payload}`, `Program ${program} success`] } };
}
const decodeSell = (tx: any, modern: boolean, quoteMint: PublicKey = NATIVE_MINT, quoteProgram?: string) =>
  decodePumpSwapWindowTransaction(tx, { signature: 'sig1', slot, at }, pool, { baseMint: new PublicKey(token.address), quoteMint, poolBaseTokenAccount: baseVault, poolQuoteTokenAccount: quoteVault } as any, slot, retrieved, true, true, false, false, false, modern, quoteProgram);

test('modern event clock accepts a same-hour drift from the RPC blockTime estimate', () => {
  const proof = decodeSell(modernSell(blockTime - 1), true);
  assert.equal(proof.trades.length, 1);
  assert.equal(proof.trades[0]!.side, 'SELL');
  assert.equal(proof.trades[0]!.quoteAtomic, '1000000');
});
test('legacy (modern=false) decode still requires exact event/blockTime equality', () => {
  assert.equal(decodeSell(modernSell(blockTime), false).trades.length, 1);
  assert.throws(() => decodeSell(modernSell(blockTime - 1), false), /ADVISORY_TRADE_EVENT_BINDING/);
});
test('modern event clock rejects a timestamp outside the frozen half-open hour', () => {
  assert.throws(() => decodeSell(modernSell(HOUR - 1), true), /ADVISORY_TRADE_EVENT_BINDING/);
});
test('modern +32 TRANSFER_FEE_APPENDIX custom-quote sell reconciles with a zero quote transfer fee', () => {
  const proof = decodeSell(modernSell(blockTime, { quoteMint: customMint, quoteProgram: TOKEN_2022, appendix: 32 }), true, customMint, TOKEN_2022);
  assert.equal(proof.trades.length, 1);
  const q = proof.trades[0]!.quoteAccounting!;
  assert.equal(q.method, 'pumpswap-event-fee-exclusive-v2');
  assert.equal(q.eventLayout, 'TRANSFER_FEE_APPENDIX');
  assert.equal(q.quoteTransferFeeAtomic, '0');
});
test('a custom-quote sell whose instruction quote program does not match is rejected', () => {
  assert.throws(() => decodeSell(modernSell(blockTime, { quoteMint: customMint, quoteProgram: TOKEN_2022, appendix: 32 }), true, customMint, TOKEN_PROGRAM_ID.toBase58()), /ADVISORY_TRADE_V2_ACCOUNT_BINDING/);
});

// Two-hop sell route B -> A -> SOL: hop0 is B's bonding curve (Pump program), hop1 is the selected A/WSOL pool.
const SYSTEM = '11111111111111111111111111111111';
const PUMP_CURVE_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_CURVE_GLOBAL = '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf';
const PUMP_CURVE_FEE_CONFIG = '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt';
const PUMP_CURVE_EVENT_AUTHORITY = 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1';
const bMint = new PublicKey(Buffer.alloc(32, 9)).toBase58(), cMint = new PublicKey(Buffer.alloc(32, 19)).toBase58();
const wsolAccount = new PublicKey(Buffer.alloc(32, 10)).toBase58(), bAccount = new PublicKey(Buffer.alloc(32, 11)).toBase58();
const bCurve = new PublicKey(Buffer.alloc(32, 12)).toBase58(), bCurveBase = new PublicKey(Buffer.alloc(32, 13)).toBase58(), bCurveQuote = new PublicKey(Buffer.alloc(32, 14)).toBase58();
const buyback = new PublicKey(Buffer.alloc(32, 15)).toBase58();
function multiHopSell(opts: { badGlobal?: boolean; breakRoute?: boolean; omitCpi?: boolean } = {}): any {
  const eventBytes = sellEventBytes(blockTime, new PublicKey(wsolAccount), PublicKey.default, 24), payload = eventBytes.toString('base64');
  const mh = Buffer.alloc(24); Buffer.from([43, 100, 73, 19, 233, 246, 111, 148]).copy(mh); mh.writeBigUInt64LE(500n, 8); mh.writeBigUInt64LE(1n, 16);
  const hop0Quote = opts.breakRoute ? cMint : token.address;
  const accounts = [user.toBase58(), bAccount, wsolAccount, GLOBAL_CONFIG_PDA.toBase58(), PUMP_AMM_FEE_CONFIG_PDA.toBase58(), userVolumeAccumulatorPda(user).toBase58(), buyback, TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022, SYSTEM, eventAuthority, program, PUMP_CURVE_PROGRAM, opts.badGlobal ? buyback : PUMP_CURVE_GLOBAL, PUMP_CURVE_FEE_CONFIG, PUMP_CURVE_EVENT_AUTHORITY,
    bMint, hop0Quote, bCurve, bCurveBase, bCurveQuote,
    token.address, NATIVE_MINT.toBase58(), pool, baseVault.toBase58(), quoteVault.toBase58()];
  const curveInner = { programId: PUMP_CURVE_PROGRAM, accounts: [user.toBase58()], data: encodeSolanaAddress(Buffer.alloc(8)), stackHeight: 2 };
  const emitInner = { programId: program, accounts: [eventAuthority], data: encodeSolanaAddress(Buffer.concat([Buffer.from('e445a52e51cb9a1d', 'hex'), eventBytes])), stackHeight: 2 };
  const logMessages = [`Program ${program} invoke [1]`, `Program ${PUMP_CURVE_PROGRAM} invoke [2]`, `Program ${PUMP_CURVE_PROGRAM} success`, `Program data: ${payload}`];
  if (!opts.omitCpi) logMessages.push(`Program ${program} invoke [2]`, `Program ${program} success`);
  logMessages.push(`Program ${program} success`);
  const keys = [...new Set([...accounts, program, PUMP_CURVE_PROGRAM, eventAuthority])];
  return { version: 1, slot, blockTime, transaction: { signatures: ['sig1'], message: {
    accountKeys: keys.map(pubkey => ({ pubkey, signer: pubkey === user.toBase58() })), instructions: [{ programId: program, accounts, data: encodeSolanaAddress(mh) }] } },
    meta: { err: null, innerInstructions: [{ index: 0, instructions: opts.omitCpi ? [curveInner] : [curveInner, emitInner] }], logMessages } };
}
const decodeMh = (tx: any) => decodePumpSwapWindowTransaction(tx, { signature: 'sig1', slot, at }, pool, { baseMint: new PublicKey(token.address), quoteMint: NATIVE_MINT, poolBaseTokenAccount: baseVault, poolQuoteTokenAccount: quoteVault } as any, slot, retrieved, true, true, false, false, false, true, undefined);

test('a valid selected multi-hop SELL (B->A->SOL) is counted once as a multi_hop_swap trade', () => {
  const proof = decodeMh(multiHopSell());
  assert.equal(proof.trades.length, 1);
  assert.equal(proof.trades[0]!.side, 'SELL');
  assert.equal(proof.trades[0]!.instructionName, 'multi_hop_swap');
  assert.equal(proof.trades[0]!.quoteAtomic, '1000000');
});
test('multi-hop with a wrong Pump global PDA is rejected', () => {
  assert.throws(() => decodeMh(multiHopSell({ badGlobal: true })), /ADVISORY_TRADE_MULTIHOP_ACCOUNT_BINDING/);
});
test('multi-hop with a discontinuous (non-sell-chain) route is rejected', () => {
  assert.throws(() => decodeMh(multiHopSell({ breakRoute: true })), /ADVISORY_TRADE_MULTIHOP_ROUTE/);
});
test('multi-hop with an omitted event CPI breaks the one-to-one pairing', () => {
  assert.throws(() => decodeMh(multiHopSell({ omitCpi: true })), /ADVISORY_TRADE_EVENT_CPI_BINDING/);
});
