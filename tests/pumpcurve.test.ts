import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import BN from 'bn.js';
import { MintLayout, NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { getPumpProgram, PUMP_FEE_CONFIG_PDA, PUMP_PROGRAM_ID, PUMP_SDK, GLOBAL_PDA, bondingCurvePda, pumpIdl } from '@pump-fun/pump-sdk';
import { PUMP_FEE_PROGRAM_ID } from '@pump-fun/pump-swap-sdk';
import { Service } from '../src/app/service.js';
import { deriveBaseline, type VenueFacts, type VenueInspection } from '../src/domain/baseline.js';
import type { AssessmentDetails, LiveBundle, Profile, TokenRef } from '../src/domain/contracts.js';
import { decodeCurveState, inspectPumpCurve, quoteCurve, verifyCurveSimulation } from '../src/providers/pumpcurve.js';

const MINT = new PublicKey('3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump');
const SLOT = 500;
const SUPPLY = 1_000_000_000_000_000n;
const TOKEN_RESERVES = 793_100_000_000_000n;
const AT = '2026-10-13T12:00:00.000Z';
const ZERO = PublicKey.default;
const PAYER = new PublicKey(Buffer.alloc(32, 23));
const coder = getPumpProgram({} as never).coder;
const accountLayouts = (coder.accounts as unknown as { accountLayouts: Map<string, {
  discriminator: number[];
  layout: { encode(value: unknown, target: Buffer): number };
}> }).accountLayouts;
const bn = (value: bigint | number) => new BN(value.toString());

function fixture(options: {
  slot?: number;
  wrongCurveOwner?: boolean;
  wrongFeeOwner?: boolean;
  wrongMintOwner?: boolean;
  wrongVaultMint?: boolean;
  wrongVaultAuthority?: boolean;
  quoteMint?: PublicKey;
  depth?: number;
  complete?: boolean;
  realTokenReserves?: bigint;
  virtualTokenReserves?: bigint;
  feeRecipient?: PublicKey;
  mintSupply?: bigint;
} = {}) {
  const curveKey = bondingCurvePda(MINT);
  const global = {
    initialized: true, authority: ZERO, feeRecipient: ZERO,
    initialVirtualTokenReserves: bn(1_073_000_000_000_000n), initialVirtualSolReserves: bn(30_000_000_000n),
    initialRealTokenReserves: bn(TOKEN_RESERVES), tokenTotalSupply: bn(SUPPLY), feeBasisPoints: bn(0),
    withdrawAuthority: ZERO, enableMigrate: true, poolMigrationFee: bn(0), creatorFeeBasisPoints: bn(0),
    feeRecipients: [options.feeRecipient ?? PAYER, ...Array(6).fill(ZERO)], setCreatorAuthority: ZERO, adminSetCreatorAuthority: ZERO,
    createV2Enabled: true, whitelistPda: ZERO, reservedFeeRecipient: ZERO, mayhemModeEnabled: false,
    reservedFeeRecipients: Array(7).fill(ZERO), isCashbackEnabled: false, buybackFeeRecipients: Array(8).fill(ZERO),
    buybackBasisPoints: bn(0), initialVirtualQuoteReserves: bn(30_000_000_000n), whitelistedQuoteMints: [ZERO],
    creatorFeeConfigurable: false, maxConfigurableCreatorFeeBps: bn(0), holderRewardClaimAuthority: ZERO,
    isHolderRewardEnabled: false, maxCurveDepth: 0,
  };
  const fees = { lpFeeBps: bn(0), protocolFeeBps: bn(0), creatorFeeBps: bn(0) };
  const curve = {
    virtualTokenReserves: bn(options.virtualTokenReserves ?? 1_073_000_000_000_000n), virtualQuoteReserves: bn(30_000_000_000n),
    realTokenReserves: bn(options.realTokenReserves ?? TOKEN_RESERVES), realQuoteReserves: bn(100_000_000_000n),
    tokenTotalSupply: bn(SUPPLY), complete: options.complete ?? false, creator: ZERO, isMayhemMode: false,
    isCashbackCoin: false, quoteMint: options.quoteMint ?? ZERO, creatorFeeBps: bn(0), canEditCreatorFee: false,
    isHolderReward: false, creatorFee: bn(0), protocolFees: bn(0), depth: options.depth ?? 0,
    initialVirtualQuoteReserves: bn(0), postCompleteBaseOut: bn(0), postCompleteQuoteIn: bn(0),
  };
  const feeConfig = { bump: 1, admin: ZERO, flatFees: fees, feeTiers: [{ marketCapLamportsThreshold: bn(0), fees }], stableFeeTiers: [], exoticFlatFees: fees };
  const mintData = Buffer.alloc(MintLayout.span);
  mintData.writeBigUInt64LE(options.mintSupply ?? SUPPLY, 36);
  mintData[44] = 6;
  mintData[45] = 1;
  const vaultData = Buffer.alloc(165);
  (options.wrongVaultMint ? new PublicKey(Buffer.alloc(32, 7)) : MINT).toBuffer().copy(vaultData, 0);
  (options.wrongVaultAuthority ? new PublicKey(Buffer.alloc(32, 8)) : curveKey).toBuffer().copy(vaultData, 32);
  vaultData.writeBigUInt64LE(TOKEN_RESERVES, 64);
  vaultData[108] = 1;

  const account = (owner: PublicKey, data: Buffer) => ({ owner: owner.toBase58(), executable: false, lamports: 1_000_000, data: [data.toString('base64'), 'base64'] });
  const encode = (name: string, value: Record<string, unknown>) => {
    const account = accountLayouts.get(name);
    if (!account) throw new Error(`fixture account layout missing: ${name}`);
    const data = Buffer.alloc(1_200);
    const length = account.layout.encode(value, data);
    const encoded = Buffer.concat([Buffer.from(account.discriminator), data.subarray(0, length)]);
    // Pump's versioned fee decoder requires its initialized allocation size,
    // even when the IDL's current variable-length account fields are shorter.
    return name === 'feeConfig' && encoded.length < 2_512
      ? Buffer.concat([encoded, Buffer.alloc(2_512 - encoded.length)])
      : encoded;
  };
  const curveOwner = options.wrongCurveOwner ? PUMP_FEE_PROGRAM_ID : PUMP_PROGRAM_ID;
  const mintOwner = options.wrongMintOwner ? new PublicKey(Buffer.alloc(32, 9)) : TOKEN_PROGRAM_ID;
  const rawState = async () => JSON.stringify({ result: { context: { slot: options.slot ?? SLOT }, value: [
    account(curveOwner, encode('bondingCurve', curve)),
    account(PUMP_PROGRAM_ID, encode('global', global)),
    account(options.wrongFeeOwner ? PUMP_PROGRAM_ID : PUMP_FEE_PROGRAM_ID, encode('feeConfig', feeConfig)),
    account(mintOwner, mintData),
    account(TOKEN_PROGRAM_ID, vaultData),
  ] } });
  return { curve, global, feeConfig, curveKey, rawState };
}

function tokenAccountData(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return data;
}

function accountWire(owner: PublicKey, data: Buffer, lamports: number) {
  return { owner: owner.toBase58(), executable: false, lamports, data: [data.toString('base64'), 'base64'] };
}

function tradeEvent(mint: PublicKey, user: PublicKey, amount: BN, solAmount: BN, isBuy: boolean) {
  const zero = bn(0);
  const fields = {
    mint, solAmount, tokenAmount: amount, isBuy, user, timestamp: zero,
    virtualSolReserves: zero, virtualTokenReserves: zero, realSolReserves: zero, realTokenReserves: zero,
    feeRecipient: ZERO, feeBasisPoints: zero, fee: zero, creator: ZERO, creatorFeeBasisPoints: zero,
    creatorFee: zero, trackVolume: false, totalUnclaimedTokens: zero, totalClaimedTokens: zero,
    currentSolVolume: zero, lastUpdateTimestamp: zero, ixName: isBuy ? 'buy_v3' : 'sell_v3',
    mayhemMode: false, cashbackFeeBasisPoints: zero, cashback: zero, buybackFeeBasisPoints: zero,
    buybackFee: zero, shareholders: [], quoteMint: ZERO, quoteAmount: solAmount,
    virtualQuoteReserves: zero, realQuoteReserves: zero, holderRewardsBps: zero, holderRewards: zero,
    creatorFeeUnclaimed: zero,
  };
  const encoded = coder.types.encode('tradeEvent', fields as never);
  const discriminator = pumpIdl.events.find(event => event.name === 'TradeEvent')!.discriminator;
  return Buffer.concat([Buffer.from(discriminator), Buffer.from(encoded)]).toString('base64');
}

async function validSimulationFixture() {
  const stateFixture = fixture();
  const state = decodeCurveState(await stateFixture.rawState(), MINT, SLOT);
  const quote = quoteCurve(state, '100', '100');
  const user = PAYER;
  const base = getAssociatedTokenAddressSync(MINT, user, true, TOKEN_PROGRAM_ID);
  const buy = await PUMP_SDK.buyV3Instructions({
    bondingCurve: state.curve, associatedUserAccountInfo: null, mint: MINT, user,
    amount: quote.acquired, quoteAmount: quote.spent, slippage: 0, tokenProgram: TOKEN_PROGRAM_ID,
  });
  const sell = await PUMP_SDK.sellV3Instructions({
    bondingCurve: state.curve, mint: MINT, user, amount: quote.acquired,
    quoteAmount: quote.exit, slippage: 0, tokenProgram: TOKEN_PROGRAM_ID,
  });
  const message = new TransactionMessage({
    payerKey: user, recentBlockhash: new PublicKey(Buffer.alloc(32, 31)).toBase58(), instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...buy, ...sell],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  const keys = transaction.message.staticAccountKeys.map(key => key.toBase58());
  const baseIndex = keys.indexOf(base.toBase58());
  const preBalances = Array(keys.length).fill(0);
  const postBalances = Array(keys.length).fill(0);
  const fee = 5_000;
  const setup = 2_039_280;
  const payerBefore = 10_000_000_000;
  const payerAfter = payerBefore - Number(quote.spent.toString()) + Number(quote.exit.toString()) - fee - setup;
  preBalances[0] = payerBefore;
  postBalances[0] = payerAfter;
  postBalances[baseIndex] = setup;
  const buyEvent = tradeEvent(MINT, user, quote.acquired, quote.spent, true);
  const sellEvent = tradeEvent(MINT, user, quote.acquired, quote.exit, false);
  const result = {
    result: { context: { slot: SLOT }, value: {
      err: null, preBalances, postBalances, fee, logs: [
        `Program ${PUMP_PROGRAM_ID.toBase58()} invoke [1]`, `Program data: ${buyEvent}`, `Program data: ${sellEvent}`, `Program ${PUMP_PROGRAM_ID.toBase58()} success`,
      ],
      accounts: [
        accountWire(ZERO, Buffer.alloc(0), payerAfter),
        accountWire(TOKEN_PROGRAM_ID, tokenAccountData(MINT, user, 0n), setup),
      ],
      preTokenBalances: [], postTokenBalances: [{ accountIndex: baseIndex, mint: MINT.toBase58(), owner: user.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), uiTokenAmount: { amount: '0' } }],
      loadedAddresses: { writable: [], readonly: [] },
    } },
  };
  return { state, quote, user, base, transaction, raw: JSON.stringify(result) };
}

async function curveTransport(feeResponses: Array<'MIN_CONTEXT' | 'SUCCESS'>) {
  const stateFixture = fixture();
  const stateRaw = await stateFixture.rawState();
  const stateResult = JSON.parse(stateRaw).result as { value: unknown[] };
  const state = decodeCurveState(stateRaw, MINT, SLOT);
  const quote = quoteCurve(state, '100', '100');
  const methods: Array<{ method: string; params: unknown[] }> = [];
  const feeCalls: Array<{ method: string; params: unknown[] }> = [];
  const rpcResponse = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { headers: { 'content-type': 'application/json' } });
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://api.dexscreener.com/')) return new Response(JSON.stringify([{
      chainId: 'solana', dexId: 'fixture', pairAddress: new PublicKey(Buffer.alloc(32, 41)).toBase58(),
      baseToken: { address: NATIVE_MINT.toBase58() }, quoteToken: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }, priceUsd: '100',
    }]), { headers: { 'content-type': 'application/json' } });
    const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    methods.push(request);
    if (request.method === 'getMultipleAccounts') {
      const keys = request.params[0] as string[];
      if (keys.length === 2) return rpcResponse({ context: { slot: SLOT }, value: [stateResult.value[0], stateResult.value[3]] });
      if (keys.length === 5) return rpcResponse(stateResult);
      if (keys.length === 1) return rpcResponse({ context: { slot: SLOT }, value: [accountWire(ZERO, Buffer.alloc(0), 10_000_000_000)] });
      assert.fail(`unexpected getMultipleAccounts key count ${keys.length}`);
    }
    if (request.method === 'getAccountInfo') {
      const address = request.params[0];
      if (address === PUMP_PROGRAM_ID.toBase58()) return rpcResponse({ context: { slot: SLOT }, value: {
        owner: 'BPFLoader1111111111111111111111111111111111', executable: true, lamports: 1_000_000,
        data: [Buffer.alloc(36).toString('base64'), 'base64'],
      } });
      return rpcResponse({ context: { slot: SLOT }, value: null });
    }
    if (request.method === 'getLatestBlockhash') return rpcResponse({ context: { slot: SLOT + 1 }, value: { blockhash: new PublicKey(Buffer.alloc(32, 31)).toBase58() } });
    if (request.method === 'getFeeForMessage') {
      feeCalls.push(request);
      if (feeResponses[feeCalls.length - 1] === 'MIN_CONTEXT') return new Response(JSON.stringify({
        jsonrpc: '2.0', id: 1, error: { code: -32016, message: 'Minimum context slot has not been reached' },
      }), { headers: { 'content-type': 'application/json' } });
      return rpcResponse({ context: { slot: SLOT + 1 }, value: 5_000 });
    }
    if (request.method === 'simulateTransaction') {
      const transaction = VersionedTransaction.deserialize(Buffer.from(request.params[0] as string, 'base64'));
      const keys = transaction.message.staticAccountKeys.map(key => key.toBase58());
      const base = getAssociatedTokenAddressSync(MINT, PAYER, true, TOKEN_PROGRAM_ID);
      const baseIndex = keys.indexOf(base.toBase58());
      const preBalances = Array(keys.length).fill(0);
      const postBalances = Array(keys.length).fill(0);
      const fee = 5_000;
      const setup = 2_039_280;
      const payerBefore = 10_000_000_000;
      const payerAfter = payerBefore - Number(quote.spent.toString()) + Number(quote.exit.toString()) - fee - setup;
      preBalances[0] = payerBefore;
      postBalances[0] = payerAfter;
      postBalances[baseIndex] = setup;
      const logs = [
        `Program ${PUMP_PROGRAM_ID.toBase58()} invoke [1]`,
        `Program data: ${tradeEvent(MINT, PAYER, quote.acquired, quote.spent, true)}`,
        `Program data: ${tradeEvent(MINT, PAYER, quote.acquired, quote.exit, false)}`,
        `Program ${PUMP_PROGRAM_ID.toBase58()} success`,
      ];
      return rpcResponse({ context: { slot: SLOT }, value: {
        err: null, preBalances, postBalances, fee, logs,
        accounts: [accountWire(ZERO, Buffer.alloc(0), payerAfter), accountWire(TOKEN_PROGRAM_ID, tokenAccountData(MINT, PAYER, 0n), setup)],
        preTokenBalances: [], postTokenBalances: [{ accountIndex: baseIndex, mint: MINT.toBase58(), owner: PAYER.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), uiTokenAmount: { amount: '0' } }],
        loadedAddresses: { writable: [], readonly: [] },
      } });
    }
    assert.fail(`unexpected RPC method ${request.method}`);
  };
  return { fetcher, methods, feeCalls };
}

function curveServiceBundle(read: Awaited<ReturnType<typeof inspectPumpCurve>>): LiveBundle {
  const token: TokenRef = { chain: 'solana', address: MINT.toBase58() };
  const cutoff = AT;
  const profile: Profile = { id: 'curve-fee-service-proof', sizeUsd: '100', horizonSeconds: 3600, risk: {}, stage: { ageBands: [] } };
  const rawArtifacts = { ...read.rawArtifacts };
  const evidence: LiveBundle['evidence'] = [];
  const add = (id: string, sourceId: string, sourceType: string, accessMode: LiveBundle['evidence'][number]['accessMode'], scope: Record<string, unknown>, raw: string, retrievedAt = AT) => {
    rawArtifacts[id] = raw;
    evidence.push({ id, sourceId, sourceType, retrievedAt, availableAt: retrievedAt, contentHash: createHash('sha256').update(raw).digest('hex'), adapterVersion: 'test-v1', accessMode, scope });
  };
  const json = (value: unknown) => JSON.stringify(value);
  add('rpc-genesis', 'solana-rpc', 'JSON_RPC', 'PUBLIC_API', { method: 'getGenesisHash' }, json({ result: '5eykt4UsFv8P8NJdTREp1YvzqKqZKvdpKuc147dw2N9d' }));
  add('rpc-account', 'solana-rpc', 'JSON_RPC', 'PUBLIC_API', { method: 'getAccountInfo', mint: token.address }, json({ result: { context: { slot: SLOT }, value: null } }));
  add('pump-pool-config', 'pumpswap-direct', 'JSON_RPC', 'PUBLIC_API', { method: 'getMultipleAccounts', mint: token.address }, json({ result: { context: { slot: SLOT }, value: [null] } }));
  add('venue-route-selection', 'pump-curve-derived', 'CALCULATION', 'LOCAL_DERIVED', { mint: token.address }, json({ method: 'pump-venue-selection-v1', primaryStateId: 'pump-pool-config', selected: 'BONDING_CURVE' }));
  for (const [id, raw] of Object.entries(read.rawArtifacts)) {
    const derived = id === 'curve-quote-calculation' || id === 'curve-simulation-proof' || id === 'curve-fee-requests' || /^curve-(?:entry|exit)-fee-recovery$/.test(id);
    const market = id === 'pump-sol-usd';
    add(id, market ? 'dexscreener' : derived ? 'pump-curve-derived' : 'pump-curve-direct',
      market ? 'PUBLIC_MARKET' : derived ? 'CALCULATION' : 'JSON_RPC',
      market || !derived ? 'PUBLIC_API' : 'LOCAL_DERIVED',
      { operation: id, mint: token.address, pool: read.inspection.poolAddress }, raw, read.retrievedAt[id] ?? AT);
  }
  const collection: LiveBundle['collection'] = { rpc: { state: 'OBSERVED' }, dex: { state: 'NO_RESULTS' }, web: { state: 'NOT_REQUESTED' } };
  const semantic: LiveBundle['semantic'] = { status: 'NOT_REQUESTED', claims: [] };
  const baseline = deriveBaseline({ sharedMode: true, token, cutoff, profile, features: [], evidence, observations: [], market: null, collection, semantic, venue: read.venue, venueInspection: read.inspection });
  add('shared-derivation', 'shared-collector', 'CALCULATION', 'LOCAL_DERIVED', { method: 'shared-evidence-v1' }, json({ venueInspection: read.inspection, venue: read.venue, baseline }), cutoff);
  const details: AssessmentDetails = { version: 1, profile, thesis: null, origins: {}, stageInputs: { circulatingMarketCapUsd: null, tokenCreatedAt: null }, baseline };
  return {
    analysisKind: 'LIVE', token, cutoff, profile, evidence, rawArtifacts,
    features: baseline.flatMap(row => row.projection ? [row.projection] : []), observations: [], collection, semantic, market: null, details,
  };
}

test('curve adapter validates finalized program-owned state and derives size-matched active-curve quotes', async t => {
  const valid = fixture();
  const state = decodeCurveState(await valid.rawState(), MINT, SLOT);
  const quote = quoteCurve(state, '100', '100');
  assert.equal(state.slot, SLOT);
  assert.equal(state.key.toBase58(), valid.curveKey.toBase58());
  assert.equal(state.curve.depth, 0);
  assert.equal(quote.quote.toString(), '1000000000', 'USD size and SOL/USD price determine the rounded native quote');
  assert.ok(quote.acquired.gt(new BN(0)) && quote.acquired.lt(state.curve.realTokenReserves));
  assert.ok(quote.spent.lte(quote.quote));
  assert.ok(quote.exit.gt(new BN(0)) && quote.exit.lte(state.curve.realQuoteReserves));

  await t.test('wrong account owners and incoherent context slots are rejected', async () => {
    for (const bad of [fixture({ wrongCurveOwner: true }), fixture({ wrongFeeOwner: true }), fixture({ wrongMintOwner: true }), fixture({ slot: SLOT - 1 })]) {
      await assert.rejects(bad.rawState().then(raw => decodeCurveState(raw, MINT, SLOT)));
    }
  });

  await t.test('vault mint, authority, non-native quote, and depth must match the supported curve mode', async () => {
    for (const bad of [fixture({ wrongVaultMint: true }), fixture({ wrongVaultAuthority: true }), fixture({ quoteMint: new PublicKey(Buffer.alloc(32, 13)) }), fixture({ depth: 1 })]) {
      await assert.rejects(bad.rawState().then(raw => decodeCurveState(raw, MINT, SLOT)));
    }
  });

  await t.test('completed and migration-boundary curves cannot produce an execution quote', async () => {
    const complete = fixture({ complete: true });
    await assert.rejects(complete.rawState().then(raw => quoteCurve(decodeCurveState(raw, MINT, SLOT), '100', '100')), /CURVE_AWAITING_MIGRATION/);
    const boundary = fixture({ realTokenReserves: 1n });
    await assert.rejects(boundary.rawState().then(raw => quoteCurve(decodeCurveState(raw, MINT, SLOT), '100', '100')), /CURVE_MIGRATION_BOUNDARY/);
  });

  await t.test('burned supply remains valid while supply above the curve creation total is rejected', async () => {
    const burned = fixture({ mintSupply: SUPPLY - 10_000_000n });
    const stateAfterBurn = decodeCurveState(await burned.rawState(), MINT, SLOT);
    assert.equal(stateAfterBurn.mintAccount.supply.toString(), (SUPPLY - 10_000_000n).toString());
    assert.ok(quoteCurve(stateAfterBurn, '100', '100').acquired.gt(new BN(0)));

    const inflated = fixture({ mintSupply: SUPPLY + 1n });
    await assert.rejects(inflated.rawState().then(raw => decodeCurveState(raw, MINT, SLOT)), /CURVE_ACCOUNT_BINDING/);
  });
});

test('unsigned round-trip verification binds SDK v3 instructions, program events and payer/token deltas', async () => {
  const valid = await validSimulationFixture();
  const wire = Buffer.from(valid.transaction.serialize()).toString('base64');
  const proof = verifyCurveSimulation(valid.raw, wire, MINT, TOKEN_PROGRAM_ID, valid.user, valid.base,
    valid.quote.acquired, valid.quote.spent, SLOT);
  assert.deepEqual(proof, {
    feeLamports: '5000', setupLamports: '2039280',
    spent: valid.quote.spent.toString(), received: valid.quote.exit.toString(),
  });
  assert.ok(valid.transaction.signatures.every(signature => signature.every(byte => byte === 0)), 'verification uses the exact unsigned versioned transaction');

  const wrongSlot = JSON.parse(valid.raw) as { result: { context: { slot: number } } };
  wrongSlot.result.context.slot = SLOT - 1;
  assert.throws(() => verifyCurveSimulation(JSON.stringify(wrongSlot), wire, MINT, TOKEN_PROGRAM_ID, valid.user, valid.base,
    valid.quote.acquired, valid.quote.spent, SLOT), /CURVE_SIMULATION_REJECTED/);
  const missingSell = JSON.parse(valid.raw) as { result: { value: { logs: string[] } } };
  missingSell.result.value.logs.splice(2, 1);
  assert.throws(() => verifyCurveSimulation(JSON.stringify(missingSell), wire, MINT, TOKEN_PROGRAM_ID, valid.user, valid.base,
    valid.quote.acquired, valid.quote.spent, SLOT), /CURVE_SIMULATION_DELTA_MISMATCH/);
  assert.throws(() => verifyCurveSimulation(valid.raw, wire, MINT, TOKEN_PROGRAM_ID, valid.user, valid.base,
    valid.quote.acquired, valid.quote.spent.subn(1), SLOT), /CURVE_SIMULATION_DELTA_MISMATCH/);
  const claimedAfterBuy = JSON.parse(valid.raw) as { result: { value: { accounts: Array<{ data: [string, string] }>; postTokenBalances: Array<{ uiTokenAmount: { amount: string } }> } } };
  claimedAfterBuy.result.value.accounts[1]!.data = [tokenAccountData(MINT, valid.user, BigInt(valid.quote.acquired.toString())).toString('base64'), 'base64'];
  claimedAfterBuy.result.value.postTokenBalances[0]!.uiTokenAmount.amount = valid.quote.acquired.toString();
  assert.throws(() => verifyCurveSimulation(JSON.stringify(claimedAfterBuy), wire, MINT, TOKEN_PROGRAM_ID, valid.user, valid.base,
    valid.quote.acquired, valid.quote.spent, SLOT), /CURVE_SIMULATION_DELTA_MISMATCH/);
});

test('Service persists and replays a reconstructed curve route proof and rejects rehashed state, quote, and selection edits', async () => {
  const token: TokenRef = { chain: 'solana', address: MINT.toBase58() };
  const cutoff = '2026-10-13T12:00:00.000Z';
  const stateAt = '2026-10-13T11:59:40.000Z';
  const profile: Profile = { id: 'curve-service-proof', sizeUsd: '100', horizonSeconds: 3600, risk: {}, stage: { ageBands: [] } };
  const stateFixture = fixture();
  const state = decodeCurveState(await stateFixture.rawState(), MINT, SLOT);
  const priceRaw = JSON.stringify([{
    chainId: 'solana', dexId: 'fixture', pairAddress: new PublicKey(Buffer.alloc(32, 41)).toBase58(),
    baseToken: { address: NATIVE_MINT.toBase58() }, quoteToken: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
    priceUsd: '100',
  }]);
  const quote = quoteCurve(state, profile.sizeUsd!, '100');
  const expiresAt = new Date(Date.parse(stateAt) + 30_000).toISOString();
  const ids = ['rpc-genesis', 'rpc-account', 'pump-pool-config', 'venue-route-selection', 'curve-state', 'curve-program', 'pump-sol-usd', 'curve-quote-calculation'];
  const inspection: VenueInspection = {
    token, poolAddress: state.key.toBase58(), certificateId: `pump-curve-sol:${state.key.toBase58()}`,
    version: 'pump-curve-sdk-4.0.0-sol-v1', availableAt: stateAt, bindingVerified: true,
    evidenceIds: ids, removableLiquidityFraction: '0', errors: {},
    limitations: ['Native SOL bonding curve; no LP redemption claims.'],
  };
  const venue: VenueFacts = {
    certificateId: inspection.certificateId, bindingVerified: true, version: inspection.version, token,
    availableAt: stateAt, expiresAt, removableLiquidityFraction: '0', lockExpiresAt: null,
    entryQuoteUsd: profile.sizeUsd!, acquiredAtomic: quote.acquired.toString(), decimals: 6,
    exitQuantityAtomic: quote.acquired.toString(), exitQuoteUsd: quote.exitUsd.toFixed(),
    referencePriceUsd: quote.reference.toFixed(), entryExternalCostUsd: '0', exitExternalCostUsd: '0',
    embeddedFeesUsd: '0', costsReconciled: false, method: 'INDEPENDENT_QUOTES', evidenceIds: ids,
  };
  const rawArtifacts: Record<string, string> = {};
  const evidence: LiveBundle['evidence'] = [];
  const put = (id: string, sourceId: string, sourceType: string, accessMode: LiveBundle['evidence'][number]['accessMode'], scope: Record<string, unknown>, raw: string, retrievedAt = stateAt) => {
    rawArtifacts[id] = raw;
    evidence.push({ id, sourceId, sourceType, retrievedAt, availableAt: retrievedAt, contentHash: createHash('sha256').update(raw).digest('hex'), adapterVersion: 'test-v1', accessMode, scope });
  };
  const json = (value: unknown) => JSON.stringify(value);
  put('rpc-genesis', 'solana-rpc', 'JSON_RPC', 'PUBLIC_API', { method: 'getGenesisHash' }, json({ result: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' }));
  put('rpc-account', 'solana-rpc', 'JSON_RPC', 'PUBLIC_API', { method: 'getAccountInfo', mint: token.address }, json({ result: { context: { slot: SLOT }, value: null } }));
  put('pump-pool-config', 'pumpswap-direct', 'JSON_RPC', 'PUBLIC_API', { method: 'getMultipleAccounts', mint: token.address }, json({ result: { context: { slot: SLOT }, value: [null] } }));
  put('venue-route-selection', 'pump-curve-derived', 'CALCULATION', 'LOCAL_DERIVED', { mint: token.address }, json({ method: 'pump-venue-selection-v1', primaryStateId: 'pump-pool-config', selected: 'BONDING_CURVE' }));
  put('curve-state', 'pump-curve-direct', 'JSON_RPC', 'PUBLIC_API', { method: 'getMultipleAccounts', mint: token.address }, await stateFixture.rawState());
  put('curve-program', 'pump-curve-direct', 'JSON_RPC', 'PUBLIC_API', { method: 'getAccountInfo', mint: token.address }, json({ result: { context: { slot: SLOT }, value: { owner: 'BPFLoader1111111111111111111111111111111111', executable: true, lamports: 1_000_000, data: [Buffer.alloc(36).toString('base64'), 'base64'] } } }));
  put('pump-sol-usd', 'dexscreener', 'PUBLIC_MARKET', 'PUBLIC_API', { market: 'native-usd' }, priceRaw);
  put('curve-quote-calculation', 'pump-curve-derived', 'CALCULATION', 'LOCAL_DERIVED', { mint: token.address }, json({
    method: 'pump-curve-sol-v1', minSlot: SLOT, slot: state.slot, nativeUsd: '100', quoteAtomic: quote.quote.toString(),
    actualEntryAtomic: quote.spent.toString(), acquiredAtomic: quote.acquired.toString(), exitAtomic: quote.exit.toString(),
  }));

  const collection: LiveBundle['collection'] = {
    rpc: { state: 'OBSERVED' }, dex: { state: 'NO_RESULTS' }, web: { state: 'NOT_REQUESTED' },
  };
  const semantic: LiveBundle['semantic'] = { status: 'NOT_REQUESTED', claims: [] };
  const baseline = deriveBaseline({
    sharedMode: true, token, cutoff, profile, features: [], evidence, observations: [], market: null,
    collection, semantic, venueInspection: inspection, venue,
  });
  const packetRaw = json({ venueInspection: inspection, venue, baseline });
  put('shared-derivation', 'shared-collector', 'CALCULATION', 'LOCAL_DERIVED', { method: 'shared-evidence-v1' }, packetRaw, cutoff);
  const details: AssessmentDetails = {
    version: 1, profile, thesis: null, origins: {},
    stageInputs: { circulatingMarketCapUsd: null, tokenCreatedAt: null }, baseline,
  };
  const bundle: LiveBundle = {
    analysisKind: 'LIVE', token, cutoff, profile, features: [], observations: [], evidence, rawArtifacts,
    collection, semantic, market: null, details,
  };

  const directory = mkdtempSync(join(tmpdir(), 'pump-curve-service-proof-'));
  try {
    const database = join(directory, 'accepted.sqlite');
    const writer = new Service(database);
    let snapshotId = '';
    let snapshotHash = '';
    try {
      const saved = writer.analyzeLive(bundle);
      snapshotId = saved.id;
      snapshotHash = saved.hash;
      assert.equal(saved.details?.baseline.find(row => row.id === 'O08')?.projection?.value, true);
    } finally { writer.close(); }

    const reopened = new Service(database);
    try {
      const replay = reopened.replay(snapshotId);
      assert.equal(replay.hash, snapshotHash);
      assert.deepEqual(replay, reopened.show(snapshotId));
    } finally { reopened.close(); }

    const rewriteRaw = (candidate: LiveBundle, id: string, raw: string) => {
      candidate.rawArtifacts[id] = raw;
      candidate.evidence.find(record => record.id === id)!.contentHash = createHash('sha256').update(raw).digest('hex');
    };
    const assertRejected = async (name: string, mutate: (candidate: LiveBundle) => Promise<void> | void) => {
      const candidate = structuredClone(bundle);
      await mutate(candidate);
      const verifier = new Service(join(directory, `${name}.sqlite`));
      try { assert.throws(() => verifier.analyzeLive(candidate), /CURVE_PROOF_INVALID/, name); }
      finally { verifier.close(); }
    };
    await assertRejected('rehash-curve-state', async candidate => {
      const changedState = fixture({ virtualTokenReserves: 1_000_000_000_000_000n });
      rewriteRaw(candidate, 'curve-state', await changedState.rawState());
    });
    await assertRejected('rehash-curve-quote', candidate => {
      const changed = JSON.parse(candidate.rawArtifacts['curve-quote-calculation']!) as Record<string, unknown>;
      changed.acquiredAtomic = '1';
      rewriteRaw(candidate, 'curve-quote-calculation', json(changed));
    });
    await assertRejected('rehash-route-selection', candidate => {
      const changed = JSON.parse(candidate.rawArtifacts['venue-route-selection']!) as Record<string, unknown>;
      changed.selected = 'UNVERIFIED';
      rewriteRaw(candidate, 'venue-route-selection', json(changed));
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('curve fee min-context recovery retries the identical message once and keeps failure or cancellation unknown', async t => {
  const token: TokenRef = { chain: 'solana', address: MINT.toBase58() };
  const profile: Profile = { id: 'curve-fee-retry', sizeUsd: '100', horizonSeconds: 3600, risk: {}, stage: { ageBands: [] } };
  const recovery = { tinyfishKey: 'unused-test-key' };

  await t.test('one -32016 attempt is retained and an identical second fee read permits the unsigned simulation', async () => {
    const f = await curveTransport(['MIN_CONTEXT', 'SUCCESS', 'SUCCESS']);
    const read = await inspectPumpCurve(token, profile, undefined, SLOT, 'https://rpc.example', f.fetcher, () => AT, undefined, recovery);
    assert.equal(f.feeCalls.length, 3, JSON.stringify({ errors: read.inspection.errors, ids: Object.keys(read.rawArtifacts) }));
    assert.deepEqual(f.feeCalls[0]!.params, f.feeCalls[1]!.params, 'the retry preserves the exact serialized message and context floor');
    assert.equal((f.feeCalls[0]!.params[1] as { commitment: string; minContextSlot: number }).commitment, 'finalized');
    assert.equal((f.feeCalls[0]!.params[1] as { minContextSlot: number }).minContextSlot, SLOT + 1);
    assert.equal(f.methods.filter(call => call.method === 'getLatestBlockhash').length, 1);
    assert.equal(f.methods.filter(call => call.method === 'simulateTransaction').length, 1);
    assert.equal(read.venue?.costsReconciled, true, JSON.stringify({ errors: read.inspection.errors, methods: f.methods.map(call => call.method), ids: Object.keys(read.rawArtifacts) }));
    assert.equal(read.inspection.errors.simulation, undefined);

    const first = JSON.parse(read.rawArtifacts['curve-entry-fee-attempt-1']!) as { error: { code: number } };
    const second = JSON.parse(read.rawArtifacts['curve-entry-fee-attempt-2']!) as { result: { value: number } };
    const marker = JSON.parse(read.rawArtifacts['curve-entry-fee-recovery']!) as {
      method: string; params: unknown[]; delayMs: number; firstResponseId: string; secondResponseId: string;
    };
    const requests = JSON.parse(read.rawArtifacts['curve-fee-requests']!) as Record<string, unknown>;
    assert.equal(first.error.code, -32016);
    assert.equal(second.result.value, 5_000);
    assert.deepEqual(marker, {
      method: 'curve-fee-min-context-retry-v1', params: f.feeCalls[0]!.params, delayMs: 1000,
      firstResponseId: 'curve-entry-fee-attempt-1', secondResponseId: 'curve-entry-fee-attempt-2',
    });
    assert.equal(requests.method, 'curve-message-fees-v1');
    assert.deepEqual(requests['curve-entry-fee'], f.feeCalls[0]!.params);
    assert.ok(Array.isArray(requests['curve-exit-fee']));
    assert.equal(read.rawArtifacts['curve-entry-fee'], read.rawArtifacts['curve-entry-fee-attempt-2']);
    assert.equal(read.retrievedAt['curve-entry-fee'], read.retrievedAt['curve-entry-fee-attempt-2']);

    const directory = mkdtempSync(join(tmpdir(), 'curve-fee-service-proof-'));
    try {
      const bundle = curveServiceBundle(read);
      const writer = new Service(join(directory, 'accepted.sqlite'));
      try {
        const saved = writer.analyzeLive(bundle);
        assert.equal(saved.details?.baseline.find(row => row.id === 'O15')?.quality, 'KNOWN');
      } finally { writer.close(); }

      const rewrite = (candidate: LiveBundle, id: string, raw: string) => {
        candidate.rawArtifacts[id] = raw;
        candidate.evidence.find(record => record.id === id)!.contentHash = createHash('sha256').update(raw).digest('hex');
      };
      const assertProofRejected = (name: string, mutate: (candidate: LiveBundle) => void) => {
        const candidate = structuredClone(bundle);
        mutate(candidate);
        const verifier = new Service(join(directory, `${name}.sqlite`));
        try { assert.throws(() => verifier.analyzeLive(candidate), /CURVE_PROOF_INVALID/, name); }
        finally { verifier.close(); }
      };
      assertProofRejected('tampered-fee-retry-marker', candidate => {
        const marker = JSON.parse(candidate.rawArtifacts['curve-entry-fee-recovery']!) as Record<string, unknown>;
        marker.delayMs = 999;
        rewrite(candidate, 'curve-entry-fee-recovery', JSON.stringify(marker));
      });
      assertProofRejected('tampered-fee-request-floor', candidate => {
        const requests = JSON.parse(candidate.rawArtifacts['curve-fee-requests']!) as Record<string, unknown> & { 'curve-entry-fee': [string, { commitment: string; minContextSlot: number }] };
        requests['curve-entry-fee'][1].minContextSlot -= 1;
        rewrite(candidate, 'curve-fee-requests', JSON.stringify(requests));
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  await t.test('a second -32016 remains unavailable and does not create the normal fee alias', async () => {
    const f = await curveTransport(['MIN_CONTEXT', 'MIN_CONTEXT']);
    const read = await inspectPumpCurve(token, profile, undefined, SLOT, 'https://rpc.example', f.fetcher, () => AT, undefined, recovery);
    assert.equal(f.feeCalls.length, 2);
    assert.deepEqual(f.feeCalls[0]!.params, f.feeCalls[1]!.params);
    assert.equal(read.venue?.costsReconciled, false);
    assert.equal(read.inspection.errors.simulation, 'RPC_REMOTE_-32016');
    assert.ok(read.rawArtifacts['curve-entry-fee-attempt-1']);
    assert.ok(read.rawArtifacts['curve-entry-fee-attempt-2']);
    assert.ok(read.rawArtifacts['curve-entry-fee-recovery']);
    assert.equal(read.rawArtifacts['curve-entry-fee'], undefined);
    assert.equal(read.rawArtifacts['curve-exit-fee'], undefined);
  });

  await t.test('cancellation during the one-second wait prevents a second fee request', async () => {
    const f = await curveTransport(['MIN_CONTEXT']);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20);
    const read = await inspectPumpCurve(token, profile, undefined, SLOT, 'https://rpc.example', f.fetcher, () => AT, controller.signal, recovery);
    clearTimeout(timer);
    assert.equal(f.feeCalls.length, 1);
    assert.equal(read.venue?.costsReconciled, false);
    assert.ok(read.rawArtifacts['curve-entry-fee-attempt-1']);
    assert.ok(read.rawArtifacts['curve-entry-fee-recovery']);
    assert.equal(read.rawArtifacts['curve-entry-fee-attempt-2'], undefined);
    assert.equal(read.rawArtifacts['curve-entry-fee'], undefined);
  });
});
