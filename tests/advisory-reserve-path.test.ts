import test from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { Decimal } from 'decimal.js';
import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { OFFLINE_PUMP_AMM_PROGRAM as sdk, PUMP_AMM_PROGRAM_ID, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, userVolumeAccumulatorPda, poolPda, buyBaseInput, buyQuoteInput, sellBaseInput } from '@pump-fun/pump-swap-sdk';
import { collectAdvisoryDemandWindows, decodeAdvisoryDemandWindows, deriveA30DemandWindows, DEMAND_ARCHIVE_ADAPTER, DEMAND_ARCHIVE_METHOD, DEMAND_METHOD, type DemandHistory, type DemandTrade } from '../src/providers/advisory-demand-windows.js';
import { decodePumpSwapWindowTransaction } from '../src/providers/advisory-trades.js';
import { reconcileWindowQuote } from '../src/providers/pumpswap-window-abi.js';
import type { AdvisoryWindowHistory } from '../src/providers/advisory-window.js';
import { encodeSolanaAddress } from '../src/providers/solana.js';
import { deriveO29ReservePath, RESERVE_PATH_METHOD } from '../src/providers/advisory-reserve-path.js';

const token = { chain: 'solana' as const, address: '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump' };
const creator = new PublicKey(Buffer.alloc(32, 7)), coinCreator = new PublicKey(Buffer.alloc(32, 8)), baseMint = new PublicKey(token.address);
const baseVault = new PublicKey(Buffer.alloc(32, 5)), quoteVault = new PublicKey(Buffer.alloc(32, 6));
const pool = poolPda(0, creator, baseMint, NATIVE_MINT).toBase58(), program = PUMP_AMM_PROGRAM_ID.toBase58(), system = '11111111111111111111111111111111';
const HOUR = 3_600_000, end = '2026-10-11T23:00:00.000Z', START = Date.parse(end) - 12 * HOUR, E = Date.parse(end) / 1000, anchorSlot = 500_000;
const anchorAt = '2026-10-11T23:00:40.000Z', clock = '2026-10-11T23:05:00.000Z', cutoff = '2026-10-11T23:10:00.000Z', iso = (ms: number) => new Date(ms).toISOString();
const I128 = 2n ** 127n;
// Synthetic real reserves; V0 and the four offsets are actual event values of consecutive old-corpus trades whose physical quote offset moved V by the exact opposite amount.
const B0 = 200_000_000_000_000n, Q0 = 80_000_000_000n, V0 = 17_584_505_629n;
const OFFSETS = [2_005_054n, -1_218_758n, 24_767_339n, -25_553_635n];
// With feeConfig null the SDK charges these globalConfig rates: LP 20, protocol 5 and creator 30 basis points of the curve quote, rounded up.
const globalConfig = { lpFeeBasisPoints: new BN(20), protocolFeeBasisPoints: new BN(5), coinCreatorFeeBasisPoints: new BN(30) }, baseMintAccount = { supply: 1_000_000_000_000_000n };
const fee = (c: bigint, bps: bigint) => (c * bps + 9_999n) / 10_000n;

type Name = 'buy' | 'buy_v2' | 'buy_exact_quote_in_v2' | 'sell' | 'sell_v2';
type Spec = { name: Name; amount: bigint; hour: number; slot: number; txIndex: number | null; signature?: string; leg?: number; offset?: bigint };
type Priced = { name: Name; base: bigint; core: bigint; lp: bigint; protocol: bigint; creator: bigint; B: bigint; Q: bigint; V: bigint };
type Gap = { before: number; atomic: bigint };
type Options = { nudge?: number; baseGap?: Gap; quoteGap?: Gap; virtualGap?: Gap; start?: { B: bigint; Q: bigint; V: bigint } };
/** Prices each trade with the pinned SDK quote functions at the running real reserves and its own V. offset moves real Q up and V down by the same amount; gaps move one quantity only; nudge moves one checked amount by one atomic unit. */
function price(specs: Spec[], options: Options = {}): Priced[] {
  let { B, Q, V } = options.start ?? { B: B0, Q: Q0, V: V0 };
  return specs.map((s, i) => {
    if (s.offset) { Q += s.offset; V -= s.offset; }
    if (options.baseGap?.before === i) B += options.baseGap.atomic;
    if (options.quoteGap?.before === i) Q += options.quoteGap.atomic;
    if (options.virtualGap?.before === i) V += options.virtualGap.atomic;
    const args = { slippage: 0, baseReserve: new BN(B.toString()), quoteReserve: new BN(Q.toString()), virtualQuoteReserves: new BN(V.toString()), globalConfig, baseMintAccount, baseMint, coinCreator, creator, feeConfig: null } as any;
    const sell = s.name.startsWith('sell'), exact = s.name.startsWith('buy_exact'), nudge = options.nudge === i ? 1n : 0n, amount = new BN(s.amount.toString());
    let base = s.amount, core: bigint;
    if (exact) { const r = buyQuoteInput({ ...args, quote: amount }); core = BigInt(r.internalQuoteWithoutFees.toString()); base = BigInt(r.base.toString()) + nudge; }
    else if (sell) core = BigInt(sellBaseInput({ ...args, base: amount }).internalQuoteAmountOut.toString()) + nudge;
    else core = BigInt(buyBaseInput({ ...args, base: amount }).internalQuoteAmount.toString()) + nudge;
    const p: Priced = { name: s.name, base, core, lp: fee(core, 20n), protocol: fee(core, 5n), creator: fee(core, 30n), B, Q, V };
    if (sell) { B += base; Q -= core - p.lp; } else { B -= base; Q += core + p.lp; }
    return p;
  });
}
const modelled = (x: Priced) => x.name.startsWith('sell') ? { B: x.B + x.base, Q: x.Q - (x.core - x.lp) } : { B: x.B - x.base, Q: x.Q + x.core + x.lp };
function accounting(p: Priced) {
  const sell = p.name.startsWith('sell'), exact = p.name.startsWith('buy_exact'), fees = p.lp + p.protocol + p.creator;
  return reconcileWindowQuote(p.name, { eventLayout: p.name.endsWith('_v2') ? 'CURRENT_APPENDIX' : 'SDK_PREFIX', ixName: p.name, lpFee: p.lp, protocolFee: p.protocol, coinCreatorFee: p.creator, buybackFee: 0n, cashback: 0n, cashbackFeeBasisPoints: 0n, holderRewardsBps: 0n, holderRewards: 0n, creatorFeeUnclaimed: 0n,
    ...(sell ? { quoteAmountOut: p.core, userQuoteAmountOut: p.core - fees, quoteAmountOutWithoutLpFee: p.core - p.lp } : exact ? { quoteAmountIn: p.core + fees, userQuoteAmountIn: p.core, quoteAmountInWithLpFee: p.core + p.lp } : { quoteAmountIn: p.core, userQuoteAmountIn: p.core + fees, quoteAmountInWithLpFee: p.core + p.lp }) });
}
/** Decoded-trade shape; retain=false is the default decode without V. */
function trades(specs: Spec[], priced = price(specs), retain = true): DemandTrade[] {
  return priced.map((p, i): DemandTrade => {
    const s = specs[i]!, quoteAccounting = accounting(p);
    return { signature: s.signature ?? `S${i}`, slot: s.slot, at: iso(START + s.hour * HOUR + 60_000 + i * 1000), user: `U${i}`, side: p.name.startsWith('sell') ? 'SELL' : 'BUY', baseAtomic: String(p.base), quoteAtomic: quoteAccounting.coreQuoteAtomic,
      poolBaseReservesAtomic: String(p.B), poolQuoteReservesAtomic: String(p.Q), instructionIndex: s.leg ?? 0, instructionName: p.name, quoteAccounting, ...(retain ? { virtualQuoteReservesAtomic: String(p.V) } : {}), transactionIndex: s.txIndex };
  });
}
function history(list: DemandTrade[], over: Partial<DemandHistory> = {}): DemandHistory {
  const signatures = [...new Set(list.map(t => t.signature))];
  const transactions = signatures.map(signature => { const own = list.filter(t => t.signature === signature); return { signature, slot: own[0]!.slot, at: own[0]!.at, receipt: 'DEMAND' as const, status: 'OBSERVED' as const, trades: own.length }; });
  return { method: DEMAND_METHOD, eligible: true, token, pool, range: { start: iso(START), baselineEnd: iso(START + 6 * HOUR), end }, anchorSlot, poolVerified: true, stateSlot: anchorSlot + 5, pages: [], indexReached: true, indexComplete: true,
    successfulReferences: signatures.length, failedReferences: 0, freshTransactions: signatures.length, reusedTransactions: 0, transactionCap: 480, capExceeded: false, transactions,
    hours: Array.from({ length: 12 }, (_, h) => ({ start: iso(START + h * HOUR), end: iso(START + (h + 1) * HOUR), successfulReferences: transactions.filter(x => Math.floor((Date.parse(x.at) - START) / HOUR) === h).length, failedReferences: 0, complete: true })),
    trades: list, programAccounts: [], storage: { archiveMethod: DEMAND_ARCHIVE_METHOD, adapterVersion: DEMAND_ARCHIVE_ADAPTER, receipts: 0, storedBytes: 0, sourceBytes: 0 }, complete: true, reasonCode: 'COMPLETE_POOL_BASELINE_DEMAND_OBSERVED', ...over };
}
/** Hours 0, 2, 7 and 11 trade; hour 2 holds two indexed transactions in one slot; four actual V moves offset physical quote. */
const specs: Spec[] = [
  { name: 'buy_v2', amount: 1_000_000_000_000n, hour: 0, slot: 400_000, txIndex: 3 },
  { name: 'sell_v2', amount: 400_000_000_000n, hour: 0, slot: 400_010, txIndex: 0, offset: OFFSETS[0] },
  { name: 'buy_exact_quote_in_v2', amount: 2_000_000_000n, hour: 2, slot: 401_000, txIndex: 1, offset: OFFSETS[1] },
  { name: 'sell', amount: 3_000_000_000_000n, hour: 2, slot: 401_000, txIndex: 4 },
  { name: 'buy', amount: 50_000_000_000n, hour: 7, slot: 402_000, txIndex: null, offset: OFFSETS[2] },
  { name: 'sell_v2', amount: 900_000_000_000n, hour: 11, slot: 403_000, txIndex: null, offset: OFFSETS[3] },
];
function assertNull(metric: any, code: string) {
  assert.equal(metric.quality, 'MISSING'); assert.equal(metric.reasonCode, code);
  assert.deepEqual([metric.data.offsets, metric.data.whole, metric.data.hours, metric.data.anomaly, metric.data.depthAtDefinedImpact, metric.data.cohortBaseline], [null, null, null, null, null, null]);
}

test('per-event V: an SDK-exact effective path yields the A30-aligned vector with observed pre endpoints, a modelled last endpoint and unattributed offsets', () => {
  const p = price(specs), list = trades(specs, p), h = history(list), metric = deriveO29ReservePath(h, ['a', 'b', 'a'])!, data = metric.data as any;
  assert.deepEqual([metric.id, metric.quality, metric.reasonCode, metric.unit, metric.evidenceIds], ['O29', 'KNOWN', 'EFFECTIVE_RESERVE_PATH_OBSERVED', 'reserve-path-vector', ['a', 'b']]);
  assert.equal(data.method, RESERVE_PATH_METHOD);
  assert.deepEqual([data.anomaly, data.cohortBaseline, data.thinLiquidity, data.depthAtDefinedImpact, data.offsetCause, data.anomalyStatus, data.depthStatus], [null, null, null, null, null, 'ANOMALY_REQUIRES_COHORT_BASELINE', 'FIXED_SIZE_NOT_DECLARED']);
  assert.deepEqual(p.map(x => String(x.V)), ['17584505629', '17582500575', '17583719333', '17583719333', '17558951994', '17584505629']);
  const g = data.gates;
  assert.deepEqual([g.checkedTrades, g.transactionTrades, g.curveMatches, g.curveMismatches, g.continuityPairs, g.effectiveDiscontinuities, g.sameSlotPairs, g.unorderedSameSlotPairs, g.firstFailure], [6, 6, 6, 0, 5, 0, 1, 0, null]);
  assert.deepEqual(g.byInstruction, { buy_v2: { trades: 1, curveMatches: 1 }, sell_v2: { trades: 2, curveMatches: 2 }, buy_exact_quote_in_v2: { trades: 1, curveMatches: 1 }, sell: { trades: 1, curveMatches: 1 }, buy: { trades: 1, curveMatches: 1 } });
  const o = data.offsets;
  assert.deepEqual([o.pairs, o.unchangedPairs, o.offsetPairs, o.physicalQuoteOffsetSumAtomic, o.virtualQuoteChangePairs, o.distinctVirtualQuoteValues, o.cause], [5, 1, 4, '0', 4, 4, null]);
  assert.deepEqual(o.sample.map((x: any) => [x.physicalQuoteOffsetAtomic, x.virtualQuoteChangeAtomic]), OFFSETS.map(x => [String(x), String(-x)]));
  // Same hour bounds, trade counts and fee-exclusive flow as A30 over the same history.
  const a30 = deriveA30DemandWindows(h, [])!.data as any, a30Hours = [...a30.baseline.hours, ...a30.windows];
  assert.deepEqual(data.hours.map((x: any) => [x.start, x.end, x.trades, x.buyCoreQuoteAtomic, x.sellCoreQuoteAtomic, x.netCoreQuoteAtomic]), a30Hours.map((x: any) => [x.start, x.end, x.decodedTrades, x.buyQuoteAtomic, x.sellQuoteAtomic, x.netQuoteAtomic]));
  const h0 = data.hours[0];
  assert.deepEqual([h0.firstEventPre.basis, h0.firstEventPre.baseReserveAtomic, h0.firstEventPre.quoteReserveAtomic, h0.firstEventPre.virtualQuoteReserveAtomic, h0.lastEventPre.signature, h0.modelledPost.basis, h0.modelledPost.afterSignature, h0.modelledPost.at], ['EVENT_REPORTED', String(B0), String(Q0), String(V0), 'S1', 'MODELLED_CURVE_ENDPOINT', 'S1', list[1]!.at]);
  assert.deepEqual([h0.virtualQuoteReserveChangeAtomic, h0.internalPairs, h0.offsetPairs, h0.physicalQuoteOffsetSumAtomic], ['-2005054', 1, 1, '2005054']);
  for (const x of [h0, data.hours[2], data.whole]) {
    assert.equal(x.effectiveQuoteReserveChangeAtomic, String(BigInt(x.netCoreQuoteAtomic) + BigInt(x.lpFeeAtomic)));
    assert.equal(x.physicalQuoteReserveChangeAtomic, String(BigInt(x.effectiveQuoteReserveChangeAtomic) - BigInt(x.virtualQuoteReserveChangeAtomic)));
    assert.equal(x.baseReserveChangeAtomic, String(BigInt(x.baseSoldAtomic) - BigInt(x.baseBoughtAtomic)));
  }
  const empty = data.hours[1];
  assert.deepEqual([empty.trades, empty.netCoreQuoteAtomic, empty.lpFeeAtomic, empty.physicalQuoteOffsetSumAtomic, empty.firstEventPre, empty.modelledPost, empty.physicalQuoteReserveChangeAtomic, empty.observedPriceChange, empty.modelledPriceChange, empty.curveImpact], [0, '0', '0', '0', null, null, null, null, null, null]);
  // A single-trade hour has no observed interval; its modelled change is that trade curve impact.
  for (const i of [7, 11]) { const x = data.hours[i]; assert.equal(x.observedPriceChange, null); assert.deepEqual([x.curveImpact.min, x.curveImpact.max], [x.modelledPriceChange, x.modelledPriceChange]); }
  const w = data.whole, z = p.at(-1)!, after = modelled(z);
  assert.equal(w.modelledPost.at, list.at(-1)!.at); assert.notEqual(w.modelledPost.at, w.end);
  assert.equal(w.modelledPriceChange, new Decimal(String((after.Q + z.V) * B0 - (Q0 + V0) * after.B)).div(String((Q0 + V0) * after.B)).toFixed());
  assert.equal(w.observedPriceChange, new Decimal(String((z.Q + z.V) * B0 - (Q0 + V0) * z.B)).div(String((Q0 + V0) * z.B)).toFixed());
  assert.deepEqual([w.virtualQuoteReserveChangeAtomic, w.protocolFeeAtomic, w.creatorFeeAtomic], ['0', String(p.reduce((n, x) => n + x.protocol, 0n)), String(p.reduce((n, x) => n + x.creator, 0n))]);
  assert.equal(JSON.stringify(deriveO29ReservePath(h, ['a', 'b', 'a'])), JSON.stringify(metric));
});

test('a one-atomic curve gap or a base, physical-quote or virtual-only path gap leaves every value null with the first failure', () => {
  for (const [index, field] of [[0, 'coreQuoteAtomic'], [1, 'coreQuoteAtomic'], [2, 'baseAtomic']] as Array<[number, string]>) {
    const metric = deriveO29ReservePath(history(trades(specs, price(specs, { nudge: index }))), [])!, g = (metric.data as any).gates;
    assertNull(metric, 'RESERVE_CURVE_MISMATCH');
    assert.deepEqual([g.curveMismatches, g.effectiveDiscontinuities, g.firstFailure.signature, g.mismatchSample[0].checkedField], [1, 0, `S${index}`, field]);
    assert.equal(BigInt(g.mismatchSample[0].observedAtomic) - BigInt(g.mismatchSample[0].expectedAtomic), 1n);
  }
  const gaps: Array<[Options, string[]]> = [
    [{ baseGap: { before: 3, atomic: 1n } }, ['1', '0', '0', '0']],
    [{ quoteGap: { before: 3, atomic: 1n } }, ['0', '1', '0', '1']],
    [{ virtualGap: { before: 3, atomic: -1n } }, ['0', '0', '-1', '-1']],
  ];
  for (const [option, residuals] of gaps) {
    const metric = deriveO29ReservePath(history(trades(specs, price(specs, option))), [])!, g = (metric.data as any).gates, s = g.discontinuitySample[0];
    assertNull(metric, 'RESERVE_PATH_EFFECTIVE_DISCONTINUOUS');
    assert.deepEqual([g.curveMismatches, g.effectiveDiscontinuities, s.previousSignature, s.signature], [0, 1, 'S2', 'S3']);
    assert.deepEqual([s.baseResidualAtomic, s.physicalQuoteResidualAtomic, s.virtualQuoteChangeAtomic, s.effectiveQuoteResidualAtomic], residuals);
  }
});

test('V must be the retained signed event value: missing, malformed or out-of-range strings and nonpositive effective reserves never produce values', () => {
  const p = price(specs), absent = deriveO29ReservePath(history(trades(specs, p, false)), [])!;
  assertNull(absent, 'RESERVE_PATH_VIRTUAL_QUOTE_MISSING');
  assert.deepEqual([(absent.data as any).gates.firstFailure.signature, (absent.data as any).gates.curveMatches], ['S0', 0]);
  for (const bad of ['', '-0', '01', '+1', '1.5', '1e3', ' 1', String(I128), String(-I128 - 1n), 5 as unknown as string]) {
    const list = trades(specs, p); list[2]!.virtualQuoteReservesAtomic = bad;
    const metric = deriveO29ReservePath(history(list), [])!;
    assertNull(metric, 'RESERVE_PATH_VIRTUAL_QUOTE_INVALID'); assert.equal((metric.data as any).gates.firstFailure.signature, 'S2');
  }
  const list = trades(specs, p); list[0]!.virtualQuoteReservesAtomic = String(-Q0);
  assertNull(deriveO29ReservePath(history(list), [])!, 'RESERVE_PATH_NONPOSITIVE_RESERVE');
});

test('same-slot trades of different transactions need both indexes; legs of one transaction keep log order', () => {
  const run = (list: Spec[]) => deriveO29ReservePath(history(trades(list)), [])!;
  const unindexed = run(specs.map((s, i) => i === 3 ? { ...s, txIndex: null } : s));
  assertNull(unindexed, 'INTRA_SLOT_ORDER_UNKNOWN');
  assert.deepEqual((unindexed.data as any).gates.unorderedSample, [{ slot: 401_000, previousSignature: 'S2', signature: 'S3' }]);
  assertNull(run(specs.map((s, i) => i === 3 ? { ...s, txIndex: 1 } : s)), 'INTRA_SLOT_ORDER_UNKNOWN');
  const legs = specs.map((s, i) => i === 2 ? { ...s, txIndex: null } : i === 3 ? { ...s, txIndex: null, signature: 'S2', leg: 1 } : s);
  const known = run(legs), g = (known.data as any).gates;
  assert.deepEqual([known.quality, g.sameSlotPairs, g.continuityPairs, g.transactionTrades], ['KNOWN', 0, 5, 6]);
  assertNull(run(legs.map((s, i) => i === 3 ? { ...s, leg: -1 } : s)), 'RESERVE_PATH_ORDER_INVALID');
});

test('ineligible, incomplete, misaligned, shrunk or tradeless tapes and missing accounting never produce values', () => {
  const list = trades(specs);
  assert.equal(deriveO29ReservePath(history(list, { eligible: false }), []), null);
  const incomplete = deriveO29ReservePath(history(list, { complete: false, reasonCode: 'ADVISORY_DEMAND_PAGE_CAP' }), [])!;
  assertNull(incomplete, 'ADVISORY_DEMAND_PAGE_CAP'); assert.equal((incomplete.data as any).gates, null);
  assertNull(deriveO29ReservePath(history(list, { hours: history(list).hours.slice(1) }), [])!, 'RESERVE_PATH_HOURS_UNALIGNED');
  assertNull(deriveO29ReservePath(history(list.slice(1), { transactions: history(list).transactions }), [])!, 'RESERVE_PATH_TAPE_SHRUNK');
  assertNull(deriveO29ReservePath(history([]), [])!, 'RESERVE_PATH_NO_TRADES');
  const unaccounted = deriveO29ReservePath(history(list.map((t, i) => i === 4 ? { ...t, quoteAccounting: undefined } : t)), [])!;
  assertNull(unaccounted, 'RESERVE_PATH_QUOTE_ACCOUNTING_MISSING'); assert.equal((unaccounted.data as any).gates.firstFailure.signature, 'S4');
});

// Production boundary: official json receipts collected and decoded by the unchanged A30 path.
type Row = { signature: string; slot: number; blockTime: number; err: null; confirmationStatus: 'finalized'; transactionIndex: number };
type Ix = { programId: string; accounts: string[]; data: string };
const TAGS: Record<string, number[]> = { buy_v2: [184, 23, 238, 97, 103, 197, 211, 61], sell_v2: [93, 246, 130, 60, 231, 233, 64, 178], buy_exact_quote_in_v2: [194, 171, 28, 70, 104, 77, 91, 47] };
const eventAuthority = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP_AMM_PROGRAM_ID)[0].toBase58();
const sig = (id: number) => { const bytes = Buffer.alloc(64, 9); bytes.writeUInt32LE(id); return encodeSolanaAddress(bytes); };
function defaults(name: string, key: PublicKey): any {
  const type = sdk.idl.types!.find(t => t.name === name)!, result: Record<string, unknown> = {};
  for (const f of (type.type as any).fields) result[f.name] = f.type === 'pubkey' ? key : f.type === 'bool' ? false : f.type === 'string' ? '' : f.type === 'u8' || f.type === 'u16' ? 0 : new BN(0);
  return result;
}
function compile(r: Row, signer: string, ix: Ix, logs: string[]): any {
  const keys = [signer, ...new Set([...ix.accounts, ix.programId].filter(k => k !== signer))];
  const message = { header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 }, accountKeys: keys, recentBlockhash: encodeSolanaAddress(Buffer.alloc(32, 12)), instructions: [{ programIdIndex: keys.indexOf(ix.programId), accounts: ix.accounts.map(k => keys.indexOf(k)), data: ix.data, stackHeight: null }] };
  return { slot: r.slot, blockTime: r.blockTime, version: 'legacy', transaction: { signatures: [r.signature], message }, meta: { err: null, fee: 5000, preBalances: [], postBalances: [], preTokenBalances: [], postTokenBalances: [], innerInstructions: [], logMessages: logs, loadedAddresses: { writable: [], readonly: [] } } };
}
/** One current fee-exclusive v2 swap with exact event accounting and its own V; truncate drops virtual_quote_reserves, can_boost and base_supply (the last 25 typed bytes). */
function swap(r: Row, user: PublicKey, p: Priced, truncate: boolean): any {
  const sell = p.name.startsWith('sell'), exact = p.name.startsWith('buy_exact'), fees = p.lp + p.protocol + p.creator, big = (v: bigint | number) => new BN(v.toString());
  const userQuote = sell ? p.core - fees : exact ? p.core : p.core + fees, gross = sell ? p.core : p.core + fees, name = sell ? 'sellEvent' : 'buyEvent', u = user.toBase58();
  const event = { ...defaults(name, user), timestamp: big(r.blockTime), pool: new PublicKey(pool), user, userBaseTokenAccount: baseVault, userQuoteTokenAccount: quoteVault, poolBaseTokenReserves: big(p.B), poolQuoteTokenReserves: big(p.Q), virtualQuoteReserves: big(p.V),
    baseAmountOut: big(p.base), baseAmountIn: big(p.base), ixName: p.name, lpFee: big(p.lp), protocolFee: big(p.protocol), coinCreatorFee: big(p.creator), buybackFee: big(0), cashback: big(0),
    quoteAmountIn: big(exact ? gross : p.core), userQuoteAmountIn: big(userQuote), quoteAmountInWithLpFee: big(p.core + p.lp), quoteAmountOut: big(p.core), userQuoteAmountOut: big(userQuote), quoteAmountOutWithoutLpFee: big(p.core - p.lp),
    maxQuoteAmountIn: big(gross), minBaseAmountOut: big(p.base), minQuoteAmountOut: big(userQuote) };
  const typed = sdk.coder.types.encode(name, event);
  const payload = Buffer.concat([Buffer.from(sdk.idl.events!.find(e => e.name === name)!.discriminator), truncate ? typed.subarray(0, typed.length - 25) : typed, Buffer.alloc(24)]).toString('base64');
  const data = Buffer.alloc(24); Buffer.from(TAGS[p.name]!).copy(data);
  data.writeBigUInt64LE(exact ? gross : p.base, 8); data.writeBigUInt64LE(sell ? userQuote : exact ? p.base : gross, 16);
  const accounts = [pool, u, GLOBAL_CONFIG_PDA.toBase58(), token.address, NATIVE_MINT.toBase58(), baseVault.toBase58(), quoteVault.toBase58(), baseVault.toBase58(), quoteVault.toBase58(), TOKEN_PROGRAM_ID.toBase58(), TOKEN_PROGRAM_ID.toBase58(), system, userVolumeAccumulatorPda(user).toBase58(), PUMP_AMM_FEE_CONFIG_PDA.toBase58(), u, eventAuthority, program];
  return compile(r, u, { programId: program, accounts, data: encodeSolanaAddress(data) }, [`Program ${program} invoke [1]`, `Program data: ${payload}`, `Program ${program} success`]);
}
function windowFixture() {
  const data = { method: 'pumpswap-selected-pool-window-v3', token, pool, window: { start: iso(Date.parse(end) - HOUR), end }, genesisVerified: true, anchorSlot, anchorTime: iso((E + 30) * 1000), poolVerified: true, stateSlot: anchorSlot,
    coverageReachedStart: true, indexComplete: true, complete: true, sourceUniverseComplete: false, pages: [], successfulSignatures: 0, failedReferences: 0, transactions: [], trades: [],
    buyQuoteAtomic: '0', sellQuoteAtomic: '0', netQuoteAtomic: '0', foreignSwapLegs: 0, nonSwapInvocations: 0, cpiAuthorizedAccounts: [], limitations: [], reasonCode: 'SELECTED_POOL_WINDOW_FLOW_OBSERVED' } as unknown as AdvisoryWindowHistory;
  const requests: Record<string, { method: string; params: unknown[] }> = { 'window-anchor-time': { method: 'getBlockTime', params: [anchorSlot] } };
  return { data, rawArtifacts: { 'window-anchor-time': JSON.stringify({ jsonrpc: '2.0', id: 1, result: E + 30 }) } as Record<string, string>, retrievedAt: { 'window-anchor-time': anchorAt } as Record<string, string>, requests };
}
async function receipts(priced: Priced[], list: Spec[], truncate = -1) {
  const poolData = (await sdk.coder.accounts.encode('pool', { ...defaults('pool', creator), creator, baseMint, quoteMint: NATIVE_MINT, poolBaseTokenAccount: baseVault, poolQuoteTokenAccount: quoteVault })).toString('base64');
  const rows = list.map((s, i): Row => ({ signature: sig(i + 1), slot: s.slot, blockTime: START / 1000 + s.hour * 3600 + 60 + i, err: null, confirmationStatus: 'finalized', transactionIndex: s.txIndex ?? 0 }));
  const bodies = new Map(rows.map((r, i) => [r.signature, swap(r, new PublicKey(Buffer.alloc(32, 61 + i)), priced[i]!, i === truncate)]));
  const fetcher: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string; params: any[] };
    const result = request.method === 'getSignaturesForAddress' ? [...rows].sort((a, b) => b.slot - a.slot || b.blockTime - a.blockTime)
      : request.method === 'getTransaction' ? structuredClone(bodies.get(request.params[0]))
      : { context: { slot: anchorSlot + 5 }, value: { owner: program, executable: false, lamports: 1, data: [poolData, 'base64'] } };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  };
  const window = windowFixture(), c = await collectAdvisoryDemandWindows(token, window, 'https://rpc.example', fetcher, () => clock);
  return { rows, decode: (retain?: boolean) => retain === undefined ? decodeAdvisoryDemandWindows(token, window.data, window, c.rawArtifacts, c.retrievedAt, c.requests, cutoff) : decodeAdvisoryDemandWindows(token, window.data, window, c.rawArtifacts, c.retrievedAt, c.requests, cutoff, retain) };
}
const decoderSpecs: Spec[] = [
  { name: 'buy_v2', amount: 1_000_000_000_000n, hour: 0, slot: 400_000, txIndex: 3 },
  { name: 'sell_v2', amount: 400_000_000_000n, hour: 0, slot: 400_010, txIndex: 0, offset: OFFSETS[0] },
  { name: 'buy_exact_quote_in_v2', amount: 2_000_000_000n, hour: 2, slot: 401_000, txIndex: 1, offset: OFFSETS[1] },
  { name: 'sell_v2', amount: 3_000_000_000_000n, hour: 2, slot: 401_000, txIndex: 4 },
  { name: 'buy_v2', amount: 50_000_000_000n, hour: 7, slot: 402_000, txIndex: 2, offset: OFFSETS[2] },
  { name: 'sell_v2', amount: 900_000_000_000n, hour: 11, slot: 403_000, txIndex: 1, offset: OFFSETS[3] },
];

test('the production decode retains each verified signed event V only on opt-in; the default history and A30 stay byte-identical and O29 measures only retained V', async () => {
  const p = price(decoderSpecs), r = await receipts(p, decoderSpecs), plain = r.decode(), retained = r.decode(true);
  assert.deepEqual([plain.complete, plain.trades.length, retained.complete], [true, 6, true]);
  assert.ok(plain.trades.every(t => !('virtualQuoteReservesAtomic' in t)));
  assert.deepEqual(retained.trades.map(t => t.virtualQuoteReservesAtomic), p.map(x => String(x.V)));
  const stripped = structuredClone(retained); for (const t of stripped.trades) delete t.virtualQuoteReservesAtomic;
  assert.equal(JSON.stringify(stripped), JSON.stringify(plain));
  assert.equal(JSON.stringify(r.decode(false)), JSON.stringify(plain));
  assert.equal(JSON.stringify(deriveA30DemandWindows(retained, ['r'])), JSON.stringify(deriveA30DemandWindows(plain, ['r'])));
  const known = deriveO29ReservePath(retained, ['r'])!, g = (known.data as any).gates;
  assert.deepEqual([known.quality, g.curveMatches, g.effectiveDiscontinuities, g.sameSlotPairs, g.unorderedSameSlotPairs, (known.data as any).offsets.offsetPairs], ['KNOWN', 6, 0, 1, 0, 4]);
  const absent = deriveO29ReservePath(plain, ['r'])!;
  assertNull(absent, 'RESERVE_PATH_VIRTUAL_QUOTE_MISSING'); assert.equal((absent.data as any).gates.firstFailure.signature, plain.trades[0]!.signature);
  const negative = price(decoderSpecs, { start: { B: B0, Q: Q0, V: -10_000_000_000n } }), n = (await receipts(negative, decoderSpecs)).decode(true);
  assert.ok(n.trades.every(t => t.virtualQuoteReservesAtomic!.startsWith('-')));
  assert.equal(deriveO29ReservePath(n, [])!.quality, 'KNOWN');
});

test('signed i128 extremes are retained exactly, an event without V never yields a trade, and the flag needs fee-exclusive current-ABI decoding', async () => {
  const p = price(decoderSpecs), extreme = p.map((x, i) => i === 0 ? { ...x, V: -I128 } : i === 1 ? { ...x, V: I128 - 1n } : x);
  const e = (await receipts(extreme, decoderSpecs)).decode(true);
  assert.deepEqual(e.trades.slice(0, 2).map(t => t.virtualQuoteReservesAtomic), ['-170141183460469231731687303715884105728', '170141183460469231731687303715884105727']);
  assertNull(deriveO29ReservePath(e, [])!, 'RESERVE_PATH_NONPOSITIVE_RESERVE');
  const r = await receipts(p, decoderSpecs, 4), cut = r.decode(true);
  assert.equal(cut.complete, false);
  assert.deepEqual(cut.transactions.filter(t => t.status !== 'OBSERVED').map(t => t.signature), [r.rows[4]!.signature]);
  assert.match(cut.reasonCode, /^ADVISORY_(TRADE|DEMAND)_[A-Z_]+$/);
  assertNull(deriveO29ReservePath(cut, [])!, cut.reasonCode);
  for (const [abi, exclusive] of [[false, false], [true, false]] as Array<[boolean, boolean]>) assert.throws(() => decodePumpSwapWindowTransaction(null, { signature: sig(1), slot: 1, at: clock }, pool, {} as any, 1, clock, abi, exclusive, false, true), /ADVISORY_TRADE_VIRTUAL_SCOPE/);
});
