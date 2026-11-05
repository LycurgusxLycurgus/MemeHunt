import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { PUMP_AMM_PROGRAM_ID, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, PUMP_AMM_EVENT_AUTHORITY_PDA, userVolumeAccumulatorPda } from '@pump-fun/pump-swap-sdk';
import { encodeSolanaAddress } from '../src/providers/solana.js';
import { decodePumpSwapWindowTransaction } from '../src/providers/advisory-trades.js';
import { eventPrefix, u64le, emitData } from './window-v36-fixtures.js';

// CONSTRUCTED_SOURCE_CONFORMANCE for the proof36 multi_hop_swap route decoder (extended flag, arg 14).
// Every receipt is authored here with the installed SDK coder exactly as pumpswap-window-abi re-encodes
// event prefixes; no .data corpus, mainnet capture or private fixture is read. The ordered route binder in
// advisory-trades (bindRouteEvent) is exercised for legal routes that the eight-window acceptance run never
// observed: selected hop at the first / intermediate / last position across 1/2/3 and a coherent 7 hops,
// the first-BUY / last-SELL quote-transfer tax with its checked-transfer witness, a repeated selected venue
// in one route, own-CPI authorization and truncated-prefix recovery, plus the fee-mask, chain, endpoint,
// cap, witness and event-multiplicity negatives. Positives first, then negatives.

const enc = encodeSolanaAddress;
const pk = (s: string) => new PublicKey(s);
const key = (n: number) => new PublicKey(Buffer.alloc(32, n)).toBase58();
const program = PUMP_AMM_PROGRAM_ID.toBase58();
const TOKEN = TOKEN_PROGRAM_ID.toBase58(), TOKEN22 = TOKEN_2022_PROGRAM_ID.toBase58();
const SYSTEM = '11111111111111111111111111111111';
const eventAuthority = PUMP_AMM_EVENT_AUTHORITY_PDA.toBase58();
const GLOBAL = GLOBAL_CONFIG_PDA.toBase58(), FEE = PUMP_AMM_FEE_CONFIG_PDA.toBase58();
const PUMP_CURVE_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_CURVE_GLOBAL = '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf';
const PUMP_CURVE_FEE_CONFIG = '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt';
const PUMP_CURVE_EVENT_AUTHORITY = 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1';
const MH_TAG = Buffer.from([43, 100, 73, 19, 233, 246, 111, 148]);

const user = new PublicKey(Buffer.alloc(32, 4)), U = user.toBase58();
const uva = userVolumeAccumulatorPda(user).toBase58();
const USER_IN = key(30), USER_OUT = key(31), EXTRA = key(15), ROUTER = key(20);
const SEL_VENUE = key(40), SEL_BASE_VAULT = key(60), SEL_QUOTE_VAULT = key(61);

// Canonical 16 fixed route accounts (user, user in/out, global/fee config, user-volume PDA, token/system
// programs, event authority, swap program, and the four Pump bonding-curve PDAs required at 12-15).
const FIXED = [U, USER_IN, USER_OUT, GLOBAL, FEE, uva, EXTRA, TOKEN, TOKEN22, SYSTEM, eventAuthority, program, PUMP_CURVE_PROGRAM, PUMP_CURVE_GLOBAL, PUMP_CURVE_FEE_CONFIG, PUMP_CURVE_EVENT_AUTHORITY];

const HOUR = 1760785200, blockTime = HOUR + 1800, slot = 1000;
const at = new Date(blockTime * 1000).toISOString(), retrieved = new Date((blockTime + 120) * 1000).toISOString();
const expe = { signature: 'sig1', slot, at };
const T = (k: number) => key(100 + k);

type BuyHop = { ts?: number; pool: string; userBase: string; userQuote: string; quoteIn: bigint; userIn: bigint; baseOut: bigint; lp: bigint; protocol: bigint; creator: bigint; tax?: bigint; cashback?: bigint; cashbackBps?: bigint };
function evtBuy(o: BuyHop): Buffer {
  const prefix = eventPrefix('buyEvent', {
    timestamp: BigInt(o.ts ?? blockTime), pool: pk(o.pool), user,
    user_base_token_account: pk(o.userBase), user_quote_token_account: pk(o.userQuote),
    pool_base_token_reserves: 100000n, pool_quote_token_reserves: 1000000n, ix_name: 'multi_hop_swap',
    quote_amount_in: o.quoteIn, user_quote_amount_in: o.userIn, quote_amount_in_with_lp_fee: o.userIn + o.lp,
    base_amount_out: o.baseOut, lp_fee: o.lp, protocol_fee: o.protocol, coin_creator_fee: o.creator,
    buyback_fee: 0n, cashback: o.cashback ?? 0n, cashback_fee_basis_points: o.cashbackBps ?? 0n,
  });
  const tail = o.tax == null ? [0n, 0n, 0n] : [0n, 0n, 0n, o.tax];
  return Buffer.concat([prefix, ...tail.map(u64le)]);
}
type SellHop = { ts?: number; pool: string; userBase: string; userQuote: string; baseIn: bigint; quoteOut: bigint; userOut: bigint; lp: bigint; protocol: bigint; creator: bigint; tax?: bigint; cashback?: bigint; cashbackBps?: bigint };
function evtSell(o: SellHop): Buffer {
  const prefix = eventPrefix('sellEvent', {
    timestamp: BigInt(o.ts ?? blockTime), pool: pk(o.pool), user,
    user_base_token_account: pk(o.userBase), user_quote_token_account: pk(o.userQuote),
    pool_base_token_reserves: 100000n, pool_quote_token_reserves: 1000000n,
    base_amount_in: o.baseIn, quote_amount_out: o.quoteOut, user_quote_amount_out: o.userOut,
    quote_amount_out_without_lp_fee: o.quoteOut - o.lp, lp_fee: o.lp, protocol_fee: o.protocol,
    coin_creator_fee: o.creator, buyback_fee: 0n, cashback: o.cashback ?? 0n, cashback_fee_basis_points: o.cashbackBps ?? 0n,
  });
  const tail = o.tax == null ? [0n, 0n, 0n] : [0n, 0n, 0n, o.tax];
  return Buffer.concat([prefix, ...tail.map(u64le)]);
}
function tokenLeg(o: { mint: string; authority: string; source: string; destination: string; amount: bigint; fee: bigint | null; decimals: number }): any {
  const info: any = { mint: o.mint, authority: o.authority, source: o.source, destination: o.destination, tokenAmount: { amount: String(o.amount), decimals: o.decimals } };
  if (o.fee != null) info.feeAmount = { amount: String(o.fee), decimals: o.decimals };
  return { programId: TOKEN22, parsed: { type: o.fee == null ? 'transferChecked' : 'transferCheckedWithFee', info }, stackHeight: 3 };
}
type Hop = { base: string; quote: string; venue: string; baseVault: string; quoteVault: string; event: Buffer };
type Route = { hops: Hop[]; amountIn: bigint; minOut: bigint; poolKey: string; poolFixture: any; sel: number; witnessLegs: any[]; baseOut?: bigint[]; userIn?: bigint[]; quoteIn?: bigint[]; baseIn?: bigint[]; quoteOut?: bigint[]; userOut?: bigint[] };

const fixtureFor = (h: Hop): any => ({ baseMint: pk(h.base), quoteMint: pk(h.quote), poolBaseTokenAccount: pk(h.baseVault), poolQuoteTokenAccount: pk(h.quoteVault) });

// BUY route: user spends amountIn of hop0's quote and the base of hop x funds the quote of hop x+1; the
// protocol fee sits on the first hop and LP+creator on the last, with an optional first-hop quote tax.
function buyRoute(opts: { n: number; sel: number; tax0?: bigint; protocolOn?: number; lpCreatorOn?: number; taxOn?: number; cashbackHop?: number }): Route {
  const { n, sel } = opts, tax0 = opts.tax0 ?? 0n, protocolOn = opts.protocolOn ?? 0, lpCreatorOn = opts.lpCreatorOn ?? n - 1, taxOn = opts.taxOn ?? 0, cashbackHop = opts.cashbackHop ?? -1;
  const baseOut: bigint[] = [], quoteIn: bigint[] = [], userIn: bigint[] = [];
  for (let i = 0; i < n; i++) baseOut[i] = 900000n - BigInt(i) * 100000n;
  for (let i = 0; i < n; i++) quoteIn[i] = i === 0 ? 1000000n : baseOut[i - 1]!;
  const lpAt = (i: number) => (i === lpCreatorOn ? 200n : 0n), crAt = (i: number) => (i === lpCreatorOn ? 100n : 0n), pAt = (i: number) => (i === protocolOn ? 300n : 0n);
  for (let i = 0; i < n; i++) userIn[i] = quoteIn[i]! - (lpAt(i) + crAt(i) + pAt(i));
  const hops: Hop[] = [];
  for (let i = 0; i < n; i++) {
    const first = i === 0, last = i === n - 1, isSel = i === sel;
    const base = T(i + 1), quote = T(i), venue = isSel ? SEL_VENUE : key(50 + i);
    const baseVault = isSel ? SEL_BASE_VAULT : key(70 + i * 2), quoteVault = isSel ? SEL_QUOTE_VAULT : key(71 + i * 2);
    const cb = i === cashbackHop ? 500n : 0n;
    const event = evtBuy({ pool: venue, userBase: last ? USER_OUT : SYSTEM, userQuote: first ? USER_IN : SYSTEM, quoteIn: quoteIn[i]!, userIn: userIn[i]!, baseOut: baseOut[i]!, lp: lpAt(i), protocol: pAt(i), creator: crAt(i), tax: i === taxOn && tax0 > 0n ? tax0 : undefined, cashback: cb, cashbackBps: cb > 0n ? 50n : 0n });
    hops.push({ base, quote, venue, baseVault, quoteVault, event });
  }
  const amountIn = quoteIn[0]! + (taxOn === 0 ? tax0 : 0n), minOut = baseOut[n - 1]!;
  const witnessLegs = tax0 > 0n ? [tokenLeg({ mint: hops[taxOn]!.quote, authority: U, source: USER_IN, destination: hops[taxOn]!.quoteVault, amount: quoteIn[taxOn]! + tax0, fee: tax0, decimals: taxOn === sel ? 9 : 6 })] : [];
  return { hops, amountIn, minOut, poolKey: SEL_VENUE, poolFixture: fixtureFor(hops[sel]!), sel, witnessLegs, baseOut, userIn, quoteIn };
}

// SELL route: user sells amountIn of hop0's base and the quote of hop x funds the base of hop x+1; LP+creator
// sit on the first hop and protocol on the last, with an optional last-hop quote tax on the landed payout.
function sellRoute(opts: { n: number; sel: number; taxLast?: bigint }): Route {
  const { n, sel } = opts, taxLast = opts.taxLast ?? 0n;
  const baseIn: bigint[] = [], quoteOut: bigint[] = [], userOut: bigint[] = [];
  let bi = 500000n;
  for (let i = 0; i < n; i++) {
    const first = i === 0, last = i === n - 1;
    const L = first ? 200n : 0n, CR = first ? 100n : 0n, P = last ? 300n : 0n, tax = last ? taxLast : 0n;
    const qo = bi + 50000n, uo = qo - (L + CR + P);
    baseIn[i] = bi; quoteOut[i] = qo; userOut[i] = uo; bi = uo - tax;
  }
  const hops: Hop[] = [];
  for (let i = 0; i < n; i++) {
    const first = i === 0, last = i === n - 1, isSel = i === sel;
    const base = T(i), quote = T(i + 1), venue = isSel ? SEL_VENUE : key(50 + i);
    const baseVault = isSel ? SEL_BASE_VAULT : key(70 + i * 2), quoteVault = isSel ? SEL_QUOTE_VAULT : key(71 + i * 2);
    const event = evtSell({ pool: venue, userBase: first ? USER_IN : SYSTEM, userQuote: last ? USER_OUT : SYSTEM, baseIn: baseIn[i]!, quoteOut: quoteOut[i]!, userOut: userOut[i]!, lp: first ? 200n : 0n, creator: first ? 100n : 0n, protocol: last ? 300n : 0n, tax: last && taxLast > 0n ? taxLast : undefined });
    hops.push({ base, quote, venue, baseVault, quoteVault, event });
  }
  const amountIn = baseIn[0]!, minOut = userOut[n - 1]! - taxLast;
  const witnessLegs = taxLast > 0n ? [tokenLeg({ mint: hops[n - 1]!.quote, authority: hops[n - 1]!.venue, source: hops[n - 1]!.quoteVault, destination: USER_OUT, amount: userOut[n - 1]!, fee: taxLast, decimals: 9 })] : [];
  return { hops, amountIn, minOut, poolKey: SEL_VENUE, poolFixture: fixtureFor(hops[sel]!), sel, witnessLegs, baseIn, quoteOut, userOut };
}

const inv = (p: string, d: number) => `Program ${p} invoke [${d}]`, ok = (p: string) => `Program ${p} success`, logged = (b: Buffer) => `Program data: ${b.toString('base64')}`;
type BuildOpts = { signer?: boolean; truncate?: boolean; top?: string; dropEmit?: number; dropData?: number; extraEmitAt?: number; tamperEmit?: { i: number; event: Buffer }; witnessLegs?: any[] };
function build(g: Route, o: BuildOpts = {}): any {
  const signer = o.signer ?? true, top = o.top ?? ROUTER, dropEmit = o.dropEmit ?? -1, dropData = o.dropData ?? -1, extraEmitAt = o.extraEmitAt ?? -1;
  const legs = o.witnessLegs ?? g.witnessLegs;
  const accounts = [...FIXED, ...g.hops.flatMap(h => [h.base, h.quote, h.venue, h.baseVault, h.quoteVault])];
  const multiHop = { programId: program, accounts, data: enc(Buffer.concat([MH_TAG, u64le(g.amountIn), u64le(g.minOut)])), stackHeight: 2 };
  const emitFor = (e: Buffer) => ({ programId: program, accounts: [eventAuthority], data: enc(emitData(e)), stackHeight: 3 });
  const emitList = g.hops.map((h, i) => emitFor(o.tamperEmit && o.tamperEmit.i === i ? o.tamperEmit.event : h.event)).filter((_, i) => i !== dropEmit);
  if (extraEmitAt >= 0) emitList.push(emitFor(g.hops[extraEmitAt]!.event));
  const inner = [multiHop, ...emitList, ...legs];
  const logs = [inv(top, 1), inv(program, 2)];
  g.hops.forEach((h, i) => { if (i === dropData) return; logs.push(logged(h.event)); if (i !== dropEmit) logs.push(inv(program, 3), ok(program)); });
  if (extraEmitAt >= 0) logs.push(logged(g.hops[extraEmitAt]!.event), inv(program, 3), ok(program));
  if (o.truncate) logs.push('Log truncated'); else logs.push(ok(program), ok(top));
  const topSigner = signer ? U : top;
  const keys = [...new Set([top, U, ...inner.flatMap((i: any) => [i.programId, ...(i.accounts ?? [])])])];
  return { version: 0, slot, blockTime, transaction: { signatures: ['sig1'], message: { accountKeys: keys.map(pubkey => ({ pubkey, signer: pubkey === topSigner })), instructions: [{ programId: top, accounts: [U], data: enc(Buffer.from([1])) }] } }, meta: { err: null, innerInstructions: inner.length ? [{ index: 0, instructions: inner }] : [], logMessages: logs } };
}
const V3 = 'pumpswap-event-fee-exclusive-v3', V2 = 'pumpswap-event-fee-exclusive-v2';
function decode(g: Route, tx: any, rec = false) {
  return decodePumpSwapWindowTransaction(tx, expe, g.poolKey, g.poolFixture, slot, retrieved, true, true, rec, false, false, true, undefined, true, 9);
}

// ---- positives: selected hop at every position across 1/2/3 hops, both directions ----
for (const c of [{ n: 1, sel: 0 }, { n: 2, sel: 0 }, { n: 2, sel: 1 }, { n: 3, sel: 0 }, { n: 3, sel: 1 }, { n: 3, sel: 2 }]) {
  test(`BUY route n=${c.n} selected hop ${c.sel} decodes exactly one selected trade, foreign legs counted`, () => {
    const g = buyRoute(c), proof = decode(g, build(g));
    assert.equal(proof.trades.length, 1);
    const t = proof.trades[0]!;
    assert.deepEqual([t.side, t.instructionName, t.baseAtomic, t.quoteAtomic, t.quoteAccounting!.method], ['BUY', 'multi_hop_swap', String(g.baseOut![c.sel]), String(g.userIn![c.sel]), V3]);
    assert.equal(proof.foreignSwapLegs, c.n - 1);
  });
  test(`SELL route n=${c.n} selected hop ${c.sel} decodes exactly one selected trade with position-correct accounting`, () => {
    const g = sellRoute(c), proof = decode(g, build(g));
    assert.equal(proof.trades.length, 1);
    const t = proof.trades[0]!;
    // Target (first) SELL hop re-grades to v3; a non-target intermediate/last untaxed hop keeps the frozen v2 object.
    assert.deepEqual([t.side, t.instructionName, t.baseAtomic, t.quoteAtomic, t.quoteAccounting!.method], ['SELL', 'multi_hop_swap', String(g.baseIn![c.sel]), String(g.quoteOut![c.sel]), c.sel === 0 ? V3 : V2]);
    assert.equal(proof.foreignSwapLegs, c.n - 1);
  });
}

test('a coherent 7-hop BUY route has no arbitrary hop cap and prices only its selected hop', () => {
  const g = buyRoute({ n: 7, sel: 3 }), proof = decode(g, build(g));
  assert.equal(proof.trades.length, 1);
  assert.deepEqual([proof.trades[0]!.baseAtomic, proof.trades[0]!.quoteAtomic, proof.foreignSwapLegs], [String(g.baseOut![3]), String(g.userIn![3]), 6]);
});

test('a selected intermediate hop with zero creator/cashback charges is a legal non-creator route leg', () => {
  const g = buyRoute({ n: 3, sel: 1 }), proof = decode(g, build(g));
  assert.equal(proof.trades[0]!.quoteAccounting!.creatorFeeAtomic, '0');
  assert.equal(proof.trades[0]!.quoteAccounting!.cashbackAtomic, '0');
});

test('the protocol-first/LP+creator-last BUY mask is bound: both masked hops reconcile against their event', () => {
  const g = buyRoute({ n: 2, sel: 1 }), proof = decode(g, build(g)), q = proof.trades[0]!.quoteAccounting!;
  assert.deepEqual([q.lpFeeAtomic, q.creatorFeeAtomic, q.protocolFeeAtomic], ['200', '100', '0']);
});

test('the LP+creator-first/protocol-last SELL mask is bound on the first (target) selected hop', () => {
  const g = sellRoute({ n: 2, sel: 0 }), proof = decode(g, build(g)), q = proof.trades[0]!.quoteAccounting!;
  assert.deepEqual([q.lpFeeAtomic, q.creatorFeeAtomic, q.protocolFeeAtomic], ['200', '100', '0']);
});

// ---- taxed endpoints: first-BUY and last-SELL quote Token-2022 transfer fee with its checked witness ----
test('a first-hop taxed BUY binds a TransferCheckedWithFee witness of the gross input and the booked wallet debit', () => {
  const g = buyRoute({ n: 2, sel: 0, tax0: 500n }), proof = decode(g, build(g)), t = proof.trades[0]!, q = t.quoteAccounting!;
  assert.equal(q.method, V3);
  assert.equal(q.quoteTransferFeeAtomic, '500');
  assert.equal(q.transferWitness, 'TRANSFER_CHECKED_WITH_FEE');
  assert.equal(t.quoteAtomic, String(g.userIn![0]));
  // The route amount_in equals the gross input the checked leg moves (event quote + tax).
  assert.equal(g.amountIn, g.quoteIn![0]! + 500n);
});

test('a last-hop taxed SELL binds a TransferCheckedWithFee witness at the verified selected-quote decimals', () => {
  const g = sellRoute({ n: 2, sel: 1, taxLast: 500n }), proof = decode(g, build(g)), q = proof.trades[0]!.quoteAccounting!;
  assert.equal(q.method, V3);
  assert.deepEqual([q.quoteTransferFeeAtomic, q.transferWitness, q.walletQuoteAtomic], ['500', 'TRANSFER_CHECKED_WITH_FEE', String(g.userOut![1]! - 500n)]);
  // The route min_amount_out is the landed payout (user out minus tax); nothing larger is admitted.
  assert.equal(g.minOut, g.userOut![1]! - 500n);
});

test('a taxed BUY whose witness is a plain TransferChecked (no serialized fee) of the gross input is admitted', () => {
  const g = buyRoute({ n: 2, sel: 0, tax0: 500n });
  const leg = tokenLeg({ mint: g.hops[0]!.quote, authority: U, source: USER_IN, destination: g.hops[0]!.quoteVault, amount: g.quoteIn![0]! + 500n, fee: null, decimals: 9 });
  const proof = decode(g, build(g, { witnessLegs: [leg] }));
  assert.equal(proof.trades[0]!.quoteAccounting!.transferWitness, 'TRANSFER_CHECKED');
});

// ---- repeated selected venue, CPI authorization, truncated-prefix recovery ----
test('a route may revisit the selected pool without dedup: each cycle hop binds its own ordered event', () => {
  const S = T(0), A = T(1), FV = key(51);
  const h0 = { base: A, quote: S, venue: SEL_VENUE, baseVault: SEL_BASE_VAULT, quoteVault: SEL_QUOTE_VAULT, event: evtBuy({ pool: SEL_VENUE, userBase: SYSTEM, userQuote: USER_IN, quoteIn: 100300n, userIn: 100000n, baseOut: 90000n, lp: 0n, protocol: 300n, creator: 0n }) };
  const h1 = { base: S, quote: A, venue: FV, baseVault: key(72), quoteVault: key(73), event: evtBuy({ pool: FV, userBase: SYSTEM, userQuote: SYSTEM, quoteIn: 90000n, userIn: 90000n, baseOut: 80000n, lp: 0n, protocol: 0n, creator: 0n }) };
  const h2 = { base: A, quote: S, venue: SEL_VENUE, baseVault: SEL_BASE_VAULT, quoteVault: SEL_QUOTE_VAULT, event: evtBuy({ pool: SEL_VENUE, userBase: USER_OUT, userQuote: SYSTEM, quoteIn: 80000n, userIn: 79700n, baseOut: 70000n, lp: 200n, protocol: 0n, creator: 100n }) };
  const g: Route = { hops: [h0, h1, h2], amountIn: 100300n, minOut: 70000n, poolKey: SEL_VENUE, poolFixture: fixtureFor(h0), sel: 0, witnessLegs: [] };
  const proof = decode(g, build(g));
  assert.deepEqual(proof.trades.map(t => [t.side, t.baseAtomic, t.quoteAtomic]), [['BUY', '90000', '100000'], ['BUY', '70000', '79700']]);
  assert.deepEqual([proof.foreignSwapLegs, proof.extendedLegs], [1, 2]);
});

test('a route driven under CPI (user not signer, depth>1) is admitted and records the CPI-authorized user', () => {
  const g = buyRoute({ n: 2, sel: 1 }), proof = decode(g, build(g, { signer: false }));
  assert.equal(proof.trades.length, 1);
  assert.deepEqual(proof.cpiAuthorizedAccounts, [U]);
});

test('a route cut by Log truncated after its logged, closed event children is proven once by recovery', () => {
  const g = buyRoute({ n: 2, sel: 1 }), proof = decode(g, build(g, { truncate: true }), true);
  assert.equal(proof.trades.length, 1);
  assert.equal(proof.trades[0]!.baseAtomic, String(g.baseOut![1]));
  assert.deepEqual([proof.logRecovery!.truncated, proof.logRecovery!.executionProvenInvocations], [true, 1]);
});

// ---- negatives ----
const MASK = /ADVISORY_TRADE_FEE_BINDING/, ROUTE = /ADVISORY_TRADE_MULTIHOP_ROUTE/, EVB = /ADVISORY_TRADE_MULTIHOP_EVENT_BINDING/;
const ACCT = /ADVISORY_TRADE_MULTIHOP_ACCOUNT_BINDING/, MISS = /ADVISORY_TRADE_EVENT_MISSING/, DUP = /ADVISORY_TRADE_EVENT_DUPLICATE/;
const CPI = /ADVISORY_TRADE_EVENT_CPI_BINDING/, WIT = /ADVISORY_TRADE_QUOTE_TRANSFER_WITNESS/;

test('a protocol fee on a non-first BUY hop breaks the mask', () => {
  const g = buyRoute({ n: 2, sel: 1, protocolOn: 1 });
  assert.throws(() => decode(g, build(g)), MASK);
});
test('an LP/creator fee on a non-target BUY hop breaks the mask', () => {
  const g = buyRoute({ n: 2, sel: 0, lpCreatorOn: 0 });
  assert.throws(() => decode(g, build(g)), MASK);
});
test('a quote tax on the wrong (non-endpoint) hop is rejected rather than priced', () => {
  const g = buyRoute({ n: 2, sel: 1, tax0: 500n, taxOn: 1 });
  assert.throws(() => decode(g, build(g)), EVB);
});
test('a cashback charge on any route hop is protocol-invalid', () => {
  const g = buyRoute({ n: 2, sel: 1, cashbackHop: 1 });
  assert.throws(() => decode(g, build(g)), MASK);
});
test('mixing a sell event into a buy route (mixed sides) is rejected', () => {
  const g = buyRoute({ n: 2, sel: 1 });
  g.hops[1]!.event = evtSell({ pool: g.hops[1]!.venue, userBase: SYSTEM, userQuote: USER_OUT, baseIn: 1n, quoteOut: 100n, userOut: 100n, lp: 0n, protocol: 0n, creator: 0n });
  assert.throws(() => decode(g, build(g)), ROUTE);
});
test('a broken mint chain (base_x != quote_(x+1)) is rejected', () => {
  const g = buyRoute({ n: 2, sel: 0 });
  g.hops[1]!.quote = key(199); // foreign last hop quote no longer matches the first hop base
  assert.throws(() => decode(g, build(g)), ROUTE);
});
test('a broken amount chain (hop quote_in != previous base_out) is rejected', () => {
  const g = buyRoute({ n: 2, sel: 1 }), qi = g.quoteIn![1]! + 1000n;
  g.hops[1]!.event = evtBuy({ pool: g.hops[1]!.venue, userBase: USER_OUT, userQuote: SYSTEM, quoteIn: qi, userIn: qi - 300n, baseOut: g.baseOut![1]!, lp: 200n, protocol: 0n, creator: 100n });
  assert.throws(() => decode(g, build(g)), EVB);
});
test('a route whose amount_in does not equal the first hop gross input is rejected at the endpoint', () => {
  const g = buyRoute({ n: 2, sel: 1 });
  g.amountIn = g.amountIn + 1n;
  assert.throws(() => decode(g, build(g)), EVB);
});
test('a route whose min_amount_out exceeds the last hop delivered output is rejected at the endpoint', () => {
  const g = buyRoute({ n: 2, sel: 1 });
  g.minOut = g.baseOut![1]! + 1n;
  assert.throws(() => decode(g, build(g)), EVB);
});
test('a non-positive route amount_in fails the fixed-account/cap binding', () => {
  const g = buyRoute({ n: 1, sel: 0 });
  g.amountIn = 0n;
  assert.throws(() => decode(g, build(g)), ACCT);
});
test('a selected hop bound to the wrong pool quote vault fails the account binding', () => {
  const g = buyRoute({ n: 2, sel: 1 });
  g.hops[1]!.quoteVault = key(198);
  assert.throws(() => decode(g, build(g)), ACCT);
});
test('a selected hop bound to the wrong pool base mint fails the account binding', () => {
  const g = buyRoute({ n: 2, sel: 1 });
  g.hops[1]!.base = key(197);
  assert.throws(() => decode(g, build(g)), ACCT);
});
test('a pool hop that closes without its event is not faked as success', () => {
  const g = buyRoute({ n: 2, sel: 0 });
  assert.throws(() => decode(g, build(g, { dropData: 1, dropEmit: 1 })), MISS);
});
test('an extra event beyond the route hop count is a duplicate', () => {
  const g = buyRoute({ n: 2, sel: 1 });
  assert.throws(() => decode(g, build(g, { extraEmitAt: 1 })), DUP);
});
test('an event-CPI child whose payload differs from the logged event breaks the one-to-one binding', () => {
  const g = buyRoute({ n: 2, sel: 1 });
  assert.throws(() => decode(g, build(g, { tamperEmit: { i: 1, event: g.hops[0]!.event } })), CPI);
});
test('a logged route event with no matching emit_cpi child breaks the event multiplicity', () => {
  const g = buyRoute({ n: 2, sel: 1 });
  assert.throws(() => decode(g, build(g, { dropEmit: 1 })), CPI);
});
test('a taxed route whose checked witness fee does not equal the event tax is rejected', () => {
  const g = buyRoute({ n: 2, sel: 0, tax0: 500n });
  const leg = tokenLeg({ mint: g.hops[0]!.quote, authority: U, source: USER_IN, destination: g.hops[0]!.quoteVault, amount: g.quoteIn![0]! + 500n, fee: 501n, decimals: 9 });
  assert.throws(() => decode(g, build(g, { witnessLegs: [leg] })), WIT);
});
test('a taxed route with no checked transfer witness at all is rejected', () => {
  const g = buyRoute({ n: 2, sel: 0, tax0: 500n });
  assert.throws(() => decode(g, build(g, { witnessLegs: [] })), WIT);
});
