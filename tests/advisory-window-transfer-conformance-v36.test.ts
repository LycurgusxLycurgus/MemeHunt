import test from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { OFFLINE_PUMP_AMM_PROGRAM as sdk, PUMP_AMM_PROGRAM_ID, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, userVolumeAccumulatorPda, poolPda, pumpAmmJson } from '@pump-fun/pump-swap-sdk';
import { encodeSolanaAddress } from '../src/providers/solana.js';
import { decodePumpSwapWindowTransaction } from '../src/providers/advisory-trades.js';

// CONSTRUCTED_SOURCE_CONFORMANCE for proof36 direct-swap quote-transfer witnesses; no mainnet receipt is claimed. Event bytes are the
// installed SDK coder prefix plus the official TRANSFER_FEE_APPENDIX / HOLDER_APPENDIX u64s; instruction tags and account positions follow
// the canonical pump_amm IDL (P/canonical-sources, read-only provenance, never a runtime input); token legs use the RPC jsonParsed
// Token-2022 shape. Amounts follow the frozen fee identities. Observed forms are covered by the eight genuine-window acceptance run.
const key = (n: number) => new PublicKey(Buffer.alloc(32, n)).toBase58();
const token = '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump';
const user = new PublicKey(Buffer.alloc(32, 4)), U = user.toBase58(), creator = new PublicKey(Buffer.alloc(32, 7));
const QM = key(8), baseVault = key(5), quoteVault = key(6), UB = key(30), UQ = key(31), ROUTER = key(20);
const PROTOCOL_ATA = key(41), CREATOR_ATA = key(42), CASHBACK_ATA = key(44), BUYBACK_ATA = key(45);
const program = PUMP_AMM_PROGRAM_ID.toBase58(), TOKEN = TOKEN_PROGRAM_ID.toBase58(), TOKEN22 = TOKEN_2022_PROGRAM_ID.toBase58(), WSOL = NATIVE_MINT.toBase58();
const SYSTEM = '11111111111111111111111111111111';
const pool = poolPda(0, creator, new PublicKey(token), new PublicKey(QM)).toBase58();
const eventAuthority = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP_AMM_PROGRAM_ID)[0].toBase58();
const HOUR = 1760785200, blockTime = HOUR + 1800, slot = 1000, SIG = 'sig1';
const at = new Date(blockTime * 1000).toISOString(), retrieved = new Date((blockTime + 120) * 1000).toISOString();
const poolFixture = { baseMint: new PublicKey(token), quoteMint: new PublicKey(QM), poolBaseTokenAccount: new PublicKey(baseVault), poolQuoteTokenAccount: new PublicKey(quoteVault) } as any;
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };

// ---- events ----
type Fees = { lp?: bigint; protocol?: bigint; creator?: bigint; cashback?: bigint; buyback?: bigint; buybackBps?: bigint };
const charged = (f: Fees) => (f.lp ?? 0n) + (f.protocol ?? 0n) + (f.creator ?? 0n) + (f.cashback ?? 0n);
const feeFields = (f: Fees) => ({ lpFee: f.lp ?? 0n, lpFeeBasisPoints: f.lp ? 20n : 0n, protocolFee: f.protocol ?? 0n, protocolFeeBasisPoints: f.protocol ? 5n : 0n,
  coinCreatorFee: f.creator ?? 0n, coinCreatorFeeBasisPoints: f.creator ? 5n : 0n, cashback: f.cashback ?? 0n, cashbackFeeBasisPoints: f.cashback ? 30n : 0n,
  buybackFee: f.buyback ?? 0n, buybackFeeBasisPoints: f.buybackBps ?? 0n });
/** Direct buy: Q is the core, U = Q + F, W = Q + LP. */
const buyAmounts = (q: bigint, f: Fees, out: bigint) => ({ quoteAmountIn: q, userQuoteAmountIn: q + charged(f), quoteAmountInWithLpFee: q + (f.lp ?? 0n), baseAmountOut: out, ...feeFields(f) });
/** Exact-quote-in: U is the core, booked = U + F, W = U + LP, and Q echoes the declared spendable budget. */
const exactAmounts = (u: bigint, f: Fees, budget: bigint, out: bigint) => ({ quoteAmountIn: budget, userQuoteAmountIn: u, quoteAmountInWithLpFee: u + (f.lp ?? 0n), baseAmountOut: out, ...feeFields(f) });
/** Sell: Q is the core, U = Q - F, W = Q - LP. */
const sellAmounts = (q: bigint, f: Fees, baseIn: bigint) => ({ quoteAmountOut: q, userQuoteAmountOut: q - charged(f), quoteAmountOutWithoutLpFee: q - (f.lp ?? 0n), baseAmountIn: baseIn, ...feeFields(f) });
/** TRANSFER_FEE_APPENDIX: holder bps, holder rewards, unclaimed creator fee, quote transfer fee. */
const TAX = (t: bigint) => [0n, 0n, 0n, t];
function defaults(name: string): Record<string, unknown> {
  const type = sdk.idl.types!.find(t => t.name === name)!;
  const out: Record<string, unknown> = {};
  for (const f of (type.type as any).fields) out[f.name] = f.type === 'pubkey' ? user : f.type === 'bool' ? false : f.type === 'string' ? '' : f.type === 'u8' || f.type === 'u16' ? 0 : new BN(0);
  return out;
}
function eventBytes(name: 'buyEvent' | 'sellEvent', amounts: Record<string, bigint>, o: { ixName?: string; tail: bigint[] }): Buffer {
  const data: Record<string, unknown> = { ...defaults(name), timestamp: new BN(blockTime), pool: new PublicKey(pool), user, userBaseTokenAccount: new PublicKey(UB), userQuoteTokenAccount: new PublicKey(UQ),
    poolBaseTokenReserves: new BN('1000000000000'), poolQuoteTokenReserves: new BN('1000000000000') };
  if (name === 'buyEvent') data.ixName = o.ixName;
  for (const [k, v] of Object.entries(amounts)) data[k] = new BN(v.toString());
  return Buffer.concat([Buffer.from(sdk.idl.events!.find(e => e.name === name)!.discriminator), sdk.coder.types.encode(name, data as any), ...o.tail.map(u64)]);
}

// ---- jsonParsed token legs ----
type Leg = { source: string; destination: string; amount: bigint; authority?: string; mint?: string; decimals?: number; fee?: bigint; feeDecimals?: number; type?: string; programId?: string; multisig?: boolean; stackHeight?: number };
const ui = (amount: bigint, decimals: number) => ({ amount: amount.toString(), decimals, uiAmount: Number(amount) / 10 ** decimals, uiAmountString: String(Number(amount) / 10 ** decimals) });
function leg(o: Leg): any {
  const decimals = o.decimals ?? 6, programId = o.programId ?? TOKEN22, authority = o.authority ?? U;
  const info = { source: o.source, mint: o.mint ?? QM, destination: o.destination, tokenAmount: ui(o.amount, decimals),
    ...(o.multisig ? { multisigAuthority: authority, signers: [authority] } : { authority }),
    ...(o.fee === undefined ? {} : { feeAmount: ui(o.fee, o.feeDecimals ?? decimals) }) };
  return { program: programId === TOKEN ? 'spl-token' : 'spl-token-2022', programId, parsed: { type: o.type ?? (o.fee === undefined ? 'transferChecked' : 'transferCheckedWithFee'), info }, stackHeight: o.stackHeight ?? 2 };
}
const vaultLeg = (amount: bigint, o: Partial<Leg> = {}) => leg({ source: UQ, destination: quoteVault, amount, ...o });
const userLeg = (destination: string, amount: bigint, o: Partial<Leg> = {}) => leg({ source: UQ, destination, amount, ...o });
const payoutLeg = (amount: bigint, o: Partial<Leg> = {}) => leg({ source: quoteVault, destination: UQ, amount, authority: pool, ...o });
const baseOutLeg = (amount: bigint) => leg({ source: baseVault, destination: UB, mint: token, amount, authority: pool, programId: TOKEN });
const baseInLeg = (amount: bigint) => leg({ source: UB, destination: baseVault, mint: token, amount, programId: TOKEN });

// ---- direct swap receipts: top-level swap, its own token legs, then its logged event and own emit_cpi child ----
type Name = 'buy' | 'buy_exact_quote_in' | 'sell' | 'buy_v2' | 'buy_exact_quote_in_v2' | 'sell_v2';
const V2_TAGS: Record<string, number[]> = { buy_v2: [184, 23, 238, 97, 103, 197, 211, 61], buy_exact_quote_in_v2: [194, 171, 28, 70, 104, 77, 91, 47], sell_v2: [93, 246, 130, 60, 231, 233, 64, 178] };
const tag = (name: Name) => Buffer.from(V2_TAGS[name] ?? pumpAmmJson.instructions.find(x => x.name === name)!.discriminator);
const accountsFor = (name: Name, quoteProgram: string) => name.endsWith('_v2')
  ? [pool, U, GLOBAL_CONFIG_PDA.toBase58(), token, QM, UB, UQ, baseVault, quoteVault, TOKEN, quoteProgram, SYSTEM, userVolumeAccumulatorPda(user).toBase58(), PUMP_AMM_FEE_CONFIG_PDA.toBase58(), U, eventAuthority, program]
  : [pool, U, GLOBAL_CONFIG_PDA.toBase58(), token, QM, UB, UQ, baseVault, quoteVault, key(40), PROTOCOL_ATA, TOKEN, quoteProgram, SYSTEM, ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), eventAuthority, program, CREATOR_ATA, key(43)];
const emit = (event: Buffer) => ({ programId: program, accounts: [eventAuthority], data: encodeSolanaAddress(Buffer.concat([Buffer.from('e445a52e51cb9a1d', 'hex'), event])), stackHeight: 2 });
/** Exact own-trace logs in preorder: every node opens at its stackHeight and closes before its next sibling; the event is logged in the swap frame just before its emit_cpi. */
function logsFor(nodes: any[], event: Buffer): string[] {
  const out = [`Program ${program} invoke [1]`], open = [program];
  for (const node of nodes) {
    while (open.length >= node.stackHeight) out.push(`Program ${open.pop()} success`);
    if (node.programId === program) out.push(`Program data: ${event.toString('base64')}`);
    out.push(`Program ${node.programId} invoke [${node.stackHeight}]`); open.push(node.programId);
  }
  while (open.length) out.push(`Program ${open.pop()} success`);
  return out;
}
function swapTx(name: Name, args: [bigint, bigint], event: Buffer, legs: any[], quoteProgram = TOKEN22): any {
  const top = { programId: program, accounts: accountsFor(name, quoteProgram), data: encodeSolanaAddress(Buffer.concat([tag(name), u64(args[0]), u64(args[1])])) };
  const nodes = [...legs, emit(event)];
  const keys = [...new Set<string>([program, ...top.accounts, ...nodes.flatMap((n: any) => [n.programId, ...(n.accounts ?? [])])])];
  return { version: 0, slot, blockTime, transaction: { signatures: [SIG], message: { accountKeys: keys.map(pubkey => ({ pubkey, signer: pubkey === U })), instructions: [top] } },
    meta: { err: null, innerInstructions: [{ index: 0, instructions: nodes }], logMessages: logsFor(nodes, event) } };
}
type Mode = { extended?: boolean; quoteProgram?: string };
/** Production decoder under the proof35 modern scope with the custom 6-decimal Token-2022 quote; proof36 extended unless disabled. */
const decode = (tx: any, m: Mode = {}) => decodePumpSwapWindowTransaction(tx, { signature: SIG, slot, at }, pool, poolFixture, slot, retrieved,
  true, true, false, false, false, true, m.quoteProgram ?? TOKEN22, m.extended ?? true, 6);

// ---- scenarios ----
type Opt = { vault?: Partial<Leg>; payout?: Partial<Leg>; legs?: any[]; extra?: any[]; cap?: bigint; tax?: bigint; quoteProgram?: string; cashback?: bigint };
const BUY_F: Fees = { lp: 2000n, protocol: 500n, creator: 500n, buyback: 250n, buybackBps: 5000n };
// v2 ordinary BUY (unobserved, source-legal): core 1,000,000; booked U 1,003,000; tax 10,030; wallet 1,013,030; canonical buyback slice floor(500*5000/1e4)=250; vault = booked-250+tax.
const v2Buy = (o: Opt = {}) => swapTx('buy_v2', [7_000_000n, o.cap ?? 1_013_030n],
  eventBytes('buyEvent', buyAmounts(1_000_000n, { ...BUY_F, cashback: o.cashback }, 7_000_000n), { ixName: 'buy_v2', tail: TAX(o.tax ?? 10_030n) }),
  o.legs ?? [vaultLeg(1_012_780n, o.vault), userLeg(BUYBACK_ATA, 250n), baseOutLeg(7_000_000n), ...(o.extra ?? [])], o.quoteProgram);
// v2 exact-in with the frozen 249K aggregates (constructed LP/protocol/creator split summing to 100,504): budget 33,940,602, core 33,500,691, booked 33,601,195, tax 339,322, wallet 33,940,517, dust 85.
const K249: Fees = { lp: 67_001n, protocol: 16_750n, creator: 16_753n };
const v2Exact = (o: Opt = {}) => swapTx('buy_exact_quote_in_v2', [o.cap ?? 33_940_602n, 1n],
  eventBytes('buyEvent', exactAmounts(33_500_691n, K249, 33_940_602n, 1_000_000_000n), { ixName: 'buy_exact_quote_in_v2', tail: TAX(o.tax ?? 339_322n) }),
  o.legs ?? [vaultLeg(33_940_517n, o.vault), baseOutLeg(1_000_000_000n), ...(o.extra ?? [])]);
const SELL_F: Fees = { lp: 2000n, protocol: 500n, creator: 500n };
// v2 SELL: core 1,000,000; U 997,000 paid from the vault; tax 9,970; landed wallet 987,030.
const v2Sell = (o: Opt = {}) => swapTx('sell_v2', [4_000_000n, o.cap ?? 987_030n],
  eventBytes('sellEvent', sellAmounts(1_000_000n, SELL_F, 4_000_000n), { tail: TAX(9_970n) }),
  o.legs ?? [baseInLeg(4_000_000n), payoutLeg(997_000n, o.payout), ...(o.extra ?? [])]);
// v1 cashback + tax: F = LP 2,000 + protocol 500 + creator 500 + cashback 3,000 = 6,000 charged once; buyback 250 sits inside protocol.
const CB_F: Fees = { ...BUY_F, cashback: 3000n };
// v1 vault = core + LP + tax = 1,012,060; non-vault legs carry nominal P+C+K = 4,000 with protocol actually split protocol 250 + buyback 250.
const v1Legs = (vault: bigint, o: Partial<Leg> = {}, rest = [userLeg(PROTOCOL_ATA, 250n), userLeg(BUYBACK_ATA, 250n), userLeg(CREATOR_ATA, 500n), userLeg(CASHBACK_ATA, 3000n)]) =>
  [vaultLeg(vault, o), ...rest, baseOutLeg(7_000_000n)];
const v1Buy = (o: Opt = {}) => swapTx('buy', [7_000_000n, o.cap ?? 1_016_060n],
  eventBytes('buyEvent', buyAmounts(1_000_000n, CB_F, 7_000_000n), { ixName: 'buy', tail: TAX(10_060n) }), o.legs ?? v1Legs(1_012_060n, o.vault));
const v1Exact = (o: Opt = {}) => swapTx('buy_exact_quote_in', [o.cap ?? 1_016_100n, 1n],
  eventBytes('buyEvent', exactAmounts(1_000_000n, CB_F, 1_016_100n, 7_000_000n), { ixName: 'buy_exact_quote_in', tail: TAX(10_060n) }), o.legs ?? v1Legs(1_012_060n, o.vault));
// v1 SELL with cashback: U = 994,000 paid from the vault; tax 9,940; landed 984,060.
const v1Sell = (o: Opt = {}) => swapTx('sell', [4_000_000n, o.cap ?? 984_060n],
  eventBytes('sellEvent', sellAmounts(1_000_000n, { ...SELL_F, cashback: 3000n }, 4_000_000n), { tail: TAX(9_940n) }),
  o.legs ?? [baseInLeg(4_000_000n), payoutLeg(994_000n, o.payout)], o.quoteProgram);

const V3 = 'pumpswap-event-fee-exclusive-v3', CHECKED = 'TRANSFER_CHECKED', WITH_FEE = 'TRANSFER_CHECKED_WITH_FEE', EXACT = 'EXACT_QUOTE_BUY_GROSS';
const WITNESS = /ADVISORY_TRADE_QUOTE_TRANSFER_WITNESS/, ARG = /ADVISORY_TRADE_ARGUMENT_BINDING/, FEE = /ADVISORY_TRADE_FEE_BINDING/;
const pick = (q: any, expected: Record<string, unknown>) => Object.fromEntries(Object.keys(expected).map(k => [k, q[k]]));

test('legal taxed direct swaps decode once with exact core, booked, wallet and tax bound to their own checked transfer witness', () => {
  const cases: Array<[string, any, Record<string, unknown>]> = [
    ['v2 buy TransferChecked', v2Buy(), { method: V3, basis: 'BUY_CORE', eventLayout: 'TRANSFER_FEE_APPENDIX', coreQuoteAtomic: '1000000', bookedQuoteAtomic: '1003000', grossQuoteAtomic: '1003000',
      walletQuoteAtomic: '1013030', quoteTransferFeeAtomic: '10030', totalFeeAtomic: '3000', buybackFeeAtomic: '250', cashbackAtomic: '0', budgetRemainderAtomic: null, transferWitness: CHECKED }],
    ['v2 buy TransferCheckedWithFee', v2Buy({ vault: { fee: 10_030n } }), { walletQuoteAtomic: '1013030', quoteTransferFeeAtomic: '10030', transferWitness: WITH_FEE }],
    ['v2 exact-in 249K budget dust', v2Exact(), { method: V3, basis: EXACT, eventQuoteAtomic: '33940602', coreQuoteAtomic: '33500691', bookedQuoteAtomic: '33601195',
      walletQuoteAtomic: '33940517', quoteTransferFeeAtomic: '339322', budgetRemainderAtomic: '85', totalFeeAtomic: '100504', transferWitness: CHECKED }],
    ['v2 exact-in TransferCheckedWithFee', v2Exact({ vault: { fee: 339_322n } }), { walletQuoteAtomic: '33940517', budgetRemainderAtomic: '85', transferWitness: WITH_FEE }],
    ['v2 sell TransferChecked', v2Sell(), { method: V3, basis: 'SELL_CORE', coreQuoteAtomic: '1000000', bookedQuoteAtomic: '1000000', userQuoteAtomic: '997000',
      walletQuoteAtomic: '987030', quoteTransferFeeAtomic: '9970', totalFeeAtomic: '3000', transferWitness: CHECKED }],
    ['v2 sell TransferCheckedWithFee', v2Sell({ payout: { fee: 9_970n } }), { walletQuoteAtomic: '987030', transferWitness: WITH_FEE }],
    ['v1 cashback+tax buy', v1Buy(), { method: V3, basis: 'BUY_CORE', coreQuoteAtomic: '1000000', bookedQuoteAtomic: '1006000', walletQuoteAtomic: '1016060',
      quoteTransferFeeAtomic: '10060', cashbackAtomic: '3000', totalFeeAtomic: '6000', buybackFeeAtomic: '250', transferWitness: CHECKED }],
    ['v1 cashback+tax exact-in', v1Exact(), { method: V3, basis: EXACT, eventQuoteAtomic: '1016100', coreQuoteAtomic: '1000000', bookedQuoteAtomic: '1006000',
      walletQuoteAtomic: '1016060', budgetRemainderAtomic: '40', cashbackAtomic: '3000', totalFeeAtomic: '6000', transferWitness: CHECKED }],
    ['v1 cashback+tax sell', v1Sell(), { method: V3, basis: 'SELL_CORE', coreQuoteAtomic: '1000000', userQuoteAtomic: '994000', walletQuoteAtomic: '984060',
      quoteTransferFeeAtomic: '9940', cashbackAtomic: '3000', totalFeeAtomic: '6000', transferWitness: CHECKED }],
    ['v1 cashback+tax sell TransferCheckedWithFee', v1Sell({ payout: { fee: 9_940n } }), { walletQuoteAtomic: '984060', transferWitness: WITH_FEE }]];
  for (const [label, tx, expected] of cases) {
    const proof = decode(tx);
    assert.equal(proof.trades.length, 1, label);
    const q = proof.trades[0]!.quoteAccounting!;
    assert.equal(proof.trades[0]!.quoteAtomic, q.coreQuoteAtomic, label);
    assert.deepEqual(pick(q, expected), expected, label);
    assert.equal(proof.extendedLegs, 1, label);
  }
});

test('the historical HOLDER_APPENDIX duplicates the creator charge, adds no fee and needs no transfer witness', () => {
  const holderSell = (rewards: bigint) => swapTx('sell_v2', [4_000_000n, 997_000n], eventBytes('sellEvent', sellAmounts(1_000_000n, SELL_F, 4_000_000n), { tail: [5n, rewards] }), [baseInLeg(4_000_000n), payoutLeg(997_000n)]);
  const expected = { method: V3, eventLayout: 'HOLDER_APPENDIX', holderRewardsBps: '5', holderRewardsAtomic: '500', creatorFeeUnclaimedAtomic: null, quoteTransferFeeAtomic: null,
    totalFeeAtomic: '3000', walletQuoteAtomic: '997000', transferWitness: 'NONE' };
  assert.deepEqual(pick(decode(holderSell(500n)).trades[0]!.quoteAccounting!, expected), expected);
  assert.throws(() => decode(holderSell(501n)), FEE);
  assert.throws(() => decode(holderSell(500n), { extended: false }), /ADVISORY_TRADE_EVENT_ENCODING/);
});

test('frozen proof35 decoding still refuses taxed and cashback events', () => {
  assert.throws(() => decode(v2Buy(), { extended: false }), /ADVISORY_TRADE_QUOTE_TRANSFER_FEE_UNSUPPORTED/);
  assert.throws(() => decode(v1Buy(), { extended: false }), FEE);
});

test('caps, tampered or ambiguous witnesses, invalid cashback and native Tokenkeg quotes fail closed', () => {
  const grandchild = [{ programId: ROUTER, accounts: [U], data: encodeSolanaAddress(Buffer.from([1])), stackHeight: 2 }, vaultLeg(1_012_780n, { stackHeight: 3 }), userLeg(BUYBACK_ATA, 250n, { stackHeight: 3 })];
  const cases: Array<[string, any, RegExp, Mode?]> = [
    ['buy maximum below wallet debit', v2Buy({ cap: 1_013_029n }), ARG],
    ['explicit fee differs from event tax', v2Buy({ vault: { fee: 10_029n } }), WITNESS],
    ['fee decimals differ from leg decimals', v2Buy({ vault: { fee: 10_030n, feeDecimals: 9 } }), WITNESS],
    ['fee field on an ordinary TransferChecked', v2Buy({ vault: { fee: 10_030n, type: 'transferChecked' } }), WITNESS],
    ['wrong mint', v2Buy({ vault: { mint: WSOL } }), WITNESS],
    ['legacy Token program leg', v2Buy({ vault: { programId: TOKEN } }), WITNESS],
    ['unchecked transfer type', v2Buy({ vault: { type: 'transfer' } }), WITNESS],
    ['wrong decimals', v2Buy({ vault: { decimals: 9 } }), WITNESS],
    ['wrong source', v2Buy({ vault: { source: UB } }), WITNESS],
    ['wrong destination', v2Buy({ vault: { destination: baseVault } }), WITNESS],
    ['wrong authority', v2Buy({ vault: { authority: UB } }), WITNESS],
    ['multisig authority', v2Buy({ vault: { multisig: true } }), WITNESS],
    ['vault amount off by one', v2Buy({ vault: { amount: 1_012_781n } }), WITNESS],
    ['missing own vault leg', v2Buy({ legs: [userLeg(BUYBACK_ATA, 250n)] }), WITNESS],
    ['duplicate own vault leg', v2Buy({ extra: [vaultLeg(1_012_780n)] }), WITNESS],
    ['non-canonical buyback slice', v2Buy({ legs: [vaultLeg(1_012_779n), userLeg(BUYBACK_ATA, 251n)] }), WITNESS],
    ['vault leg not the swap own child', v2Buy({ legs: grandchild }), WITNESS],
    ['native Tokenkeg quote cannot attest a nonzero tax', v2Buy({ quoteProgram: TOKEN, legs: [vaultLeg(1_012_780n, { programId: TOKEN }), userLeg(BUYBACK_ATA, 250n, { programId: TOKEN })] }), WITNESS, { quoteProgram: TOKEN }],
    ['v2 cashback is protocol-invalid', v2Buy({ cashback: 3000n }), FEE],
    ['exact-in spendable below wallet debit', v2Exact({ cap: 33_940_516n }), ARG],
    ['exact-in vault debits the whole budget', v2Exact({ vault: { amount: 33_940_602n } }), WITNESS],
    ['exact-in tax beyond the declared budget', v2Exact({ tax: 339_408n }), FEE],
    ['sell minimum above landed quote', v2Sell({ cap: 987_031n }), ARG],
    ['sell payout under the user authority', v2Sell({ payout: { authority: U } }), WITNESS],
    ['sell payout of the landed amount', v2Sell({ payout: { amount: 987_030n } }), WITNESS],
    ['sell explicit fee differs', v2Sell({ payout: { fee: 9_971n } }), WITNESS],
    ['sell missing payout', v2Sell({ legs: [baseInLeg(4_000_000n)] }), WITNESS],
    ['sell duplicate payout', v2Sell({ extra: [payoutLeg(997_000n)] }), WITNESS],
    ['v1 buy maximum below wallet debit', v1Buy({ cap: 1_016_059n }), ARG],
    ['v1 vault share moved to a non-vault leg', v1Buy({ legs: v1Legs(1_012_059n, {}, [userLeg(PROTOCOL_ATA, 251n), userLeg(BUYBACK_ATA, 250n), userLeg(CREATOR_ATA, 500n), userLeg(CASHBACK_ATA, 3000n)]) }), WITNESS],
    ['v1 cashback leg missing', v1Buy({ legs: v1Legs(1_012_060n, {}, [userLeg(PROTOCOL_ATA, 250n), userLeg(BUYBACK_ATA, 250n), userLeg(CREATOR_ATA, 500n)]) }), WITNESS],
    ['v1 exact-in spendable below wallet debit', v1Exact({ cap: 1_016_059n }), ARG],
    ['v1 sell minimum above landed quote', v1Sell({ cap: 984_061n }), ARG],
    ['v1 native Tokenkeg quote sell', v1Sell({ quoteProgram: TOKEN, legs: [baseInLeg(4_000_000n), payoutLeg(994_000n, { programId: TOKEN })] }), WITNESS, { quoteProgram: TOKEN }]];
  for (const [label, tx, error, mode] of cases) assert.throws(() => decode(tx, mode), error, label);
});
