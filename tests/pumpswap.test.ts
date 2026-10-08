import assert from 'node:assert/strict';
import test from 'node:test';
import BN from 'bn.js';
import { Decimal } from 'decimal.js';
import { MessageV0, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, MintLayout, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  GLOBAL_CONFIG_PDA, OFFLINE_PUMP_AMM_PROGRAM, PUMP_AMM_PROGRAM_ID, PUMP_AMM_FEE_CONFIG_PDA,
  FEE_CONFIG_SIZE_PRE_STABLE, PUMP_FEE_PROGRAM_ID, buyBaseInput, buyQuoteInput, lpMintPda, poolPda,
  pumpPoolAuthorityPda, sellBaseInput,
} from '@pump-fun/pump-swap-sdk';
import { starterProfile } from '../src/app/config.js';
import type { ControlFacts, HolderFacts } from '../src/domain/baseline.js';
import type { TokenRef } from '../src/domain/contracts.js';
import { TOKEN_2022_PROGRAM, UPGRADEABLE_LOADER } from '../src/providers/solana.js';
import { inspectPumpSwap } from '../src/providers/pumpswap.js';

const MINT = '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump';
const TOKEN: TokenRef = { chain: 'solana', address: MINT };
const AT = '2026-09-30T16:00:00.000Z';
const SLOT = 500;
const TINYFISH_KEY = 'pump-tinyfish-test-secret';
const PROGRAM_DATA = new PublicKey(Buffer.alloc(32, 8));
const PAYER = new PublicKey(Buffer.alloc(32, 23));
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PAYLOAD_MINT_SUPPLY = 1_000_000_000_000n;

type Scenario = {
  wrongPoolOwner?: boolean;
  wrongPoolMint?: boolean;
  wrongQuoteMint?: boolean;
  wrongBaseVaultMint?: boolean;
  wrongBaseVaultAuthority?: boolean;
  wrongLpAuthority?: boolean;
  lpSupply?: bigint;
  poolLpSupply?: bigint;
  discoveryPoolLpSupply?: bigint;
  discoveryDisableFlags?: number;
  captureDisableFlags?: number;
  feeTierBps?: { lp: number; protocol: number; creator: number };
  discoveryFeeTierBps?: { lp: number; protocol: number; creator: number };
  discoverySlot?: number;
  captureSlot?: number;
  missingCaptureAccount?: 'pool' | 'baseMint' | 'quoteMint' | 'baseVault' | 'quoteVault' | 'lpMint';
  malformedCaptureSlot?: boolean;
  reboundCapturePointer?: 'baseVault' | 'quoteVault' | 'lpMint' | 'baseMint';
  wrongCapturePoolOwner?: boolean;
  wrongCaptureAccountOwner?: 'baseMint' | 'baseVault' | 'quoteVault' | 'lpMint';
  mayhem?: boolean;
  virtualQuoteReserves?: bigint;
  quoteVaultAtomic?: bigint;
  disableFlags?: number;
  failDex?: boolean;
  mintAuthority?: boolean;
  freezeAuthority?: boolean;
  simulate?: boolean;
  protocolFeeRecipients?: PublicKey[];
  globalAdmin?: PublicKey;
  discoveryProtocolFeeRecipients?: PublicKey[];
  discoveryGlobalAdmin?: PublicKey;
  payerLamports?: number;
  payerSystem?: boolean;
  additionalFundedPayers?: PublicKey[];
  existingWsolOwners?: PublicKey[];
  existingBaseOwners?: PublicKey[];
  simulationPayer?: PublicKey;
  preSimulationPayerLamports?: number;
  simulationFeeLamports?: number;
  simulationSetupLamports?: number;
  simulationQuoteAccount?: 'null' | 'closed-tombstone';
  feeResponses?: unknown[];
  feeErrors?: Array<{ code: number; message: string } | undefined>;
  blockhashes?: string[];
  simulationFailure?:
    | 'payer-delta' | 'base-delta' | 'existing-base-changed' | 'wrong-slot' | 'event-spend'
    | 'missing-vectors' | 'null-vectors' | 'missing-fee' | 'null-fee' | 'missing-token-vectors' | 'null-token-vectors'
    | 'missing-loaded-addresses' | 'null-loaded-addresses'
    | 'native-vector-length' | 'native-negative' | 'native-fractional' | 'native-unsafe'
    | 'fee-negative' | 'fee-fractional' | 'fee-unsafe' | 'loaded-addresses-nonempty'
    | 'duplicate-token' | 'token-out-of-range' | 'token-wrong-mint' | 'token-wrong-owner'
    | 'token-wrong-program' | 'token-wrong-decimals' | 'token-wrong-amount'
    | 'missing-existing-base-pre' | 'improper-new-base-pre' | 'returned-lamport-mismatch' | 'base-lamport-mismatch'
    | 'pre-wsol' | 'post-wsol' | 'simulation-error' | 'negative-setup' | 'underfunded-setup'
    | 'wrong-event' | 'duplicate-event' | 'wrong-log-scope' | 'payer-wrong-owner' | 'payer-executable'
    | 'base-wrong-owner' | 'base-wrong-mint' | 'base-wrong-state' | 'base-executable' | 'quote-returned'
    | 'quote-tombstone-funded' | 'quote-tombstone-nonsystem' | 'quote-tombstone-data' | 'quote-tombstone-executable';
};

const fees = (lpFeeBps: number, protocolFeeBps: number, creatorFeeBps: number) => ({
  lpFeeBps: new BN(lpFeeBps), protocolFeeBps: new BN(protocolFeeBps), creatorFeeBps: new BN(creatorFeeBps),
});
function mintBytes(options: { supply: bigint; decimals: number; authority?: PublicKey; freezeAuthority?: PublicKey } ): Buffer {
  const data = Buffer.alloc(MintLayout.span);
  data.writeUInt32LE(options.authority ? 1 : 0, 0);
  options.authority?.toBuffer().copy(data, 4);
  data.writeBigUInt64LE(options.supply, 36);
  data[44] = options.decimals;
  data[45] = 1;
  if (options.freezeAuthority) { data.writeUInt32LE(1, 46); options.freezeAuthority.toBuffer().copy(data, 50); }
  return data;
}
function tokenAccountBytes(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return data;
}
function rpcAccount(owner: PublicKey | string, bytes: Buffer, options: { executable?: boolean; lamports?: number } = {}) {
  return {
    owner: typeof owner === 'string' ? owner : owner.toBase58(),
    executable: options.executable ?? false,
    lamports: options.lamports ?? 1_000_000_000,
    data: [bytes.toString('base64'), 'base64'],
  };
}
async function sdkAccount(name: 'pool' | 'globalConfig' | 'feeConfig', value: Record<string, unknown>): Promise<Buffer> {
  const encoded = Buffer.from(await OFFLINE_PUMP_AMM_PROGRAM.coder.accounts.encode(name, value as never));
  if (name !== 'feeConfig') return encoded;
  return Buffer.concat([encoded, Buffer.alloc(Math.max(0, FEE_CONFIG_SIZE_PRE_STABLE - encoded.length))]);
}

function pumpEvent(name: 'buyEvent' | 'sellEvent', values: Record<string, unknown>): string {
  const idl = OFFLINE_PUMP_AMM_PROGRAM.idl as unknown as {
    events: Array<{ name: string; discriminator: number[] }>;
    types: Array<{ name: string; type: { fields: Array<{ name: string; type: unknown }> } }>;
  };
  const event = idl.events.find(item => item.name === name);
  const eventType = idl.types.find(item => item.name === name);
  assert.ok(event && eventType, `pinned PumpSwap SDK IDL includes ${name}`);
  const data: Record<string, unknown> = {};
  for (const field of eventType.type.fields) {
    data[field.name] = field.type === 'pubkey'
      ? PublicKey.default
      : field.type === 'bool'
        ? false
        : field.type === 'string'
          ? name === 'buyEvent' ? 'buy' : 'sell'
          : new BN(0);
  }
  Object.assign(data, values);
  const encoded = OFFLINE_PUMP_AMM_PROGRAM.coder.types.encode(name, data as never);
  return Buffer.concat([Buffer.from(event.discriminator), Buffer.from(encoded)]).toString('base64');
}

async function fixture(scenario: Scenario = {}) {
  const mint = new PublicKey(MINT);
  const creator = pumpPoolAuthorityPda(mint);
  const poolKey = poolPda(0, creator, mint, NATIVE_MINT);
  const lpMint = lpMintPda(poolKey);
  const wrongMint = new PublicKey(Buffer.alloc(32, 12));
  const baseVault = getAssociatedTokenAddressSync(mint, poolKey, true, TOKEN_PROGRAM_ID);
  const quoteVault = getAssociatedTokenAddressSync(NATIVE_MINT, poolKey, true, TOKEN_PROGRAM_ID);
  const captureBaseVault = scenario.reboundCapturePointer === 'baseVault' ? new PublicKey(Buffer.alloc(32, 13)) : baseVault;
  const captureQuoteVault = scenario.reboundCapturePointer === 'quoteVault' ? new PublicKey(Buffer.alloc(32, 14)) : quoteVault;
  const captureLpMint = scenario.reboundCapturePointer === 'lpMint' ? new PublicKey(Buffer.alloc(32, 15)) : lpMint;
  const captureBaseMint = scenario.reboundCapturePointer === 'baseMint' ? wrongMint : mint;
  const pool = await sdkAccount('pool', {
    poolBump: 1, index: 0, creator, baseMint: scenario.wrongPoolMint ? wrongMint : captureBaseMint,
    quoteMint: scenario.wrongQuoteMint ? wrongMint : NATIVE_MINT, lpMint: captureLpMint,
    poolBaseTokenAccount: captureBaseVault, poolQuoteTokenAccount: captureQuoteVault,
    lpSupply: new BN((scenario.poolLpSupply ?? 1000n).toString()), coinCreator: new PublicKey(Buffer.alloc(32, 7)),
    isMayhemMode: scenario.mayhem ?? false, isCashbackCoin: false,
    virtualQuoteReserves: new BN((scenario.virtualQuoteReserves ?? 0n).toString()), creatorFeeBps: new BN(0), canEditCreatorFee: false,
  });
  const discoveredPool = await sdkAccount('pool', {
    poolBump: 1, index: 0, creator, baseMint: scenario.wrongPoolMint ? wrongMint : mint,
    quoteMint: scenario.wrongQuoteMint ? wrongMint : NATIVE_MINT, lpMint,
    poolBaseTokenAccount: baseVault, poolQuoteTokenAccount: quoteVault,
    lpSupply: new BN((scenario.discoveryPoolLpSupply ?? scenario.poolLpSupply ?? 1000n).toString()), coinCreator: new PublicKey(Buffer.alloc(32, 7)),
    isMayhemMode: scenario.mayhem ?? false, isCashbackCoin: false,
    virtualQuoteReserves: new BN((scenario.virtualQuoteReserves ?? 0n).toString()), creatorFeeBps: new BN(0), canEditCreatorFee: false,
  });
  const feeTier = { marketCapLamportsThreshold: new BN(0), fees: fees(20, 15, 10) };
  const globalAdmin = scenario.globalAdmin ?? new PublicKey(Buffer.alloc(32, 9));
  const protocolFeeRecipients = scenario.protocolFeeRecipients ?? Array(8).fill(PublicKey.default);
  const discoveryGlobalAdmin = scenario.discoveryGlobalAdmin ?? globalAdmin;
  const discoveryProtocolFeeRecipients = scenario.discoveryProtocolFeeRecipients ?? protocolFeeRecipients;
  const globalConfig = await sdkAccount('globalConfig', {
    admin: globalAdmin, lpFeeBasisPoints: new BN(100), protocolFeeBasisPoints: new BN(50),
    disableFlags: scenario.captureDisableFlags ?? scenario.disableFlags ?? 0, protocolFeeRecipients,
    coinCreatorFeeBasisPoints: new BN(25), adminSetCoinCreatorAuthority: PublicKey.default,
    whitelistPda: PublicKey.default, reservedFeeRecipient: PublicKey.default, mayhemModeEnabled: false,
    reservedFeeRecipients: Array(7).fill(PublicKey.default), isCashbackEnabled: false,
    buybackFeeRecipients: Array(8).fill(PublicKey.default), buybackBasisPoints: new BN(0),
    boostAuthority: PublicKey.default, boostEnabled: false, creatorFeeConfigurable: true, maxConfigurableCreatorFeeBps: new BN(100),
  });
  const feeConfig = await sdkAccount('feeConfig', {
    bump: 1, admin: PublicKey.default, flatFees: fees(100, 50, 25),
    feeTiers: [{ marketCapLamportsThreshold: new BN(0), fees: fees(scenario.feeTierBps?.lp ?? 20, scenario.feeTierBps?.protocol ?? 15, scenario.feeTierBps?.creator ?? 10) }],
    stableFeeTiers: [feeTier], exoticFlatFees: fees(0, 0, 0),
  });
  const discoveryFeeTier = scenario.discoveryFeeTierBps ?? scenario.feeTierBps ?? { lp: 20, protocol: 15, creator: 10 };
  const discoveryFeeConfig = await sdkAccount('feeConfig', {
    bump: 1, admin: PublicKey.default, flatFees: fees(100, 50, 25),
    feeTiers: [{ marketCapLamportsThreshold: new BN(0), fees: fees(discoveryFeeTier.lp, discoveryFeeTier.protocol, discoveryFeeTier.creator) }],
    stableFeeTiers: [feeTier], exoticFlatFees: fees(0, 0, 0),
  });
  const discoveryGlobalConfig = await sdkAccount('globalConfig', {
    admin: discoveryGlobalAdmin, lpFeeBasisPoints: new BN(100), protocolFeeBasisPoints: new BN(50),
    disableFlags: scenario.discoveryDisableFlags ?? scenario.captureDisableFlags ?? scenario.disableFlags ?? 0,
    protocolFeeRecipients: discoveryProtocolFeeRecipients, coinCreatorFeeBasisPoints: new BN(25),
    adminSetCoinCreatorAuthority: PublicKey.default, whitelistPda: PublicKey.default,
    reservedFeeRecipient: PublicKey.default, mayhemModeEnabled: false,
    reservedFeeRecipients: Array(7).fill(PublicKey.default), isCashbackEnabled: false,
    buybackFeeRecipients: Array(8).fill(PublicKey.default), buybackBasisPoints: new BN(0),
    boostAuthority: PublicKey.default, boostEnabled: false, creatorFeeConfigurable: true,
    maxConfigurableCreatorFeeBps: new BN(100),
  });
  const lpMintData = mintBytes({ supply: scenario.lpSupply ?? 250n, decimals: 0, authority: scenario.wrongLpAuthority ? wrongMint : poolKey });
  const baseTokenData = mintBytes({
    supply: PAYLOAD_MINT_SUPPLY, decimals: 6,
    authority: scenario.mintAuthority ? PublicKey.default : undefined,
    freezeAuthority: scenario.freezeAuthority ? PublicKey.default : undefined,
  });
  const quoteTokenData = mintBytes({ supply: 1_000_000_000_000n, decimals: 9 });
  const baseVaultData = tokenAccountBytes(scenario.wrongBaseVaultMint ? wrongMint : mint, scenario.wrongBaseVaultAuthority ? wrongMint : poolKey, 1_000_000_000_000n);
  const quoteVaultAmount = scenario.quoteVaultAtomic ?? 1_000_000_000_000n;
  const quoteVaultData = tokenAccountBytes(NATIVE_MINT, poolKey, quoteVaultAmount);
  const header = Buffer.alloc(36);
  header.writeUInt32LE(2, 0);
  PROGRAM_DATA.toBuffer().copy(header, 4);
  const programData = Buffer.alloc(45);
  programData.writeUInt32LE(3, 0);
  programData.writeBigUInt64LE(400n, 4);
  programData[12] = 1;
  new PublicKey(Buffer.alloc(32, 11)).toBuffer().copy(programData, 13);

  const methods: Array<{ method: string; params: unknown[] }> = [];
  let feeResponseIndex = 0;
  let blockhashIndex = 0;
  const poolAccounts = new Map<string, ReturnType<typeof rpcAccount>>([
    [poolKey.toBase58(), rpcAccount(PUMP_AMM_PROGRAM_ID, discoveredPool)],
    [GLOBAL_CONFIG_PDA.toBase58(), rpcAccount(PUMP_AMM_PROGRAM_ID, discoveryGlobalConfig)],
    [PUMP_AMM_FEE_CONFIG_PDA.toBase58(), rpcAccount(PUMP_FEE_PROGRAM_ID, discoveryFeeConfig)],
  ]);
  const capturedAccounts = new Map<string, ReturnType<typeof rpcAccount>>([
    [poolKey.toBase58(), rpcAccount(PUMP_AMM_PROGRAM_ID, pool)],
    [GLOBAL_CONFIG_PDA.toBase58(), rpcAccount(PUMP_AMM_PROGRAM_ID, globalConfig)],
    [PUMP_AMM_FEE_CONFIG_PDA.toBase58(), rpcAccount(PUMP_FEE_PROGRAM_ID, feeConfig)],
    [mint.toBase58(), rpcAccount(TOKEN_PROGRAM_ID, baseTokenData)],
    [NATIVE_MINT.toBase58(), rpcAccount(TOKEN_PROGRAM_ID, quoteTokenData)],
    [baseVault.toBase58(), rpcAccount(TOKEN_PROGRAM_ID, baseVaultData)],
    [quoteVault.toBase58(), rpcAccount(TOKEN_PROGRAM_ID, quoteVaultData)],
    [lpMint.toBase58(), rpcAccount(TOKEN_PROGRAM_ID, lpMintData)],
  ]);
  if (scenario.reboundCapturePointer === 'baseVault') capturedAccounts.set(captureBaseVault.toBase58(), rpcAccount(TOKEN_PROGRAM_ID, baseVaultData));
  if (scenario.reboundCapturePointer === 'quoteVault') capturedAccounts.set(captureQuoteVault.toBase58(), rpcAccount(TOKEN_PROGRAM_ID, quoteVaultData));
  if (scenario.reboundCapturePointer === 'lpMint') capturedAccounts.set(captureLpMint.toBase58(), rpcAccount(TOKEN_PROGRAM_ID, lpMintData));
  if (scenario.wrongCapturePoolOwner) capturedAccounts.set(poolKey.toBase58(), rpcAccount(PublicKey.default, pool));
  const quoteAtomic = new BN(new Decimal(starterProfile().sizeUsd ?? '25').div(160).mul(1e9).floor().toFixed(0));
  const quoteState = {
    baseReserve: new BN('1000000000000'), quoteReserve: new BN(quoteVaultAmount.toString()), virtualQuoteReserves: new BN((scenario.virtualQuoteReserves ?? 0n).toString()),
    globalConfig: OFFLINE_PUMP_AMM_PROGRAM.coder.accounts.decode('globalConfig', globalConfig),
    baseMintAccount: MintLayout.decode(baseTokenData), baseMint: mint, coinCreator: new PublicKey(Buffer.alloc(32, 7)),
    creator, feeConfig: OFFLINE_PUMP_AMM_PROGRAM.coder.accounts.decode('feeConfig', feeConfig), quoteMint: NATIVE_MINT,
    isMayhemMode: scenario.mayhem ?? false, creatorFeeBps: new BN(0), slippage: 0,
  };
  const expectedBuy = buyQuoteInput({ ...quoteState, quote: quoteAtomic });
  const expectedActualBuy = buyBaseInput({ ...quoteState, base: expectedBuy.base });
  let expectedSell: ReturnType<typeof sellBaseInput> | undefined;
  try { expectedSell = sellBaseInput({ ...quoteState, base: expectedBuy.base }); }
  catch { /* The production adapter must name a reserve-shortfall from this SDK guard. */ }
  const rentLamports = 2_039_280;
  const networkFeeLamports = 5_000;
  const payerLamports = scenario.payerLamports ?? 1_000_000_000;
  const simulationPayer = scenario.simulationPayer ?? PAYER;
  const actualSpend = BigInt(expectedActualBuy.uiQuote.toString());
  const actualReceive = BigInt(expectedSell?.uiQuote.toString() ?? '0');
  const preSimulationPayerLamports = scenario.preSimulationPayerLamports ?? payerLamports;
  const simulationFeeLamports = scenario.simulationFeeLamports ?? networkFeeLamports;
  const hasExistingBase = new Set((scenario.existingBaseOwners ?? []).map(key => key.toBase58())).has(simulationPayer.toBase58());
  let simulationSetupLamports = scenario.simulationSetupLamports ?? (hasExistingBase ? 0 : rentLamports);
  if (scenario.simulationFailure === 'negative-setup') simulationSetupLamports = -1;
  if (scenario.simulationFailure === 'underfunded-setup') simulationSetupLamports = rentLamports - 1;
  let afterPayerLamports = preSimulationPayerLamports - Number(actualSpend) + Number(actualReceive) - simulationFeeLamports - simulationSetupLamports;
  if (scenario.simulationFailure === 'payer-delta') afterPayerLamports += 1;
  const baseAmountBefore = hasExistingBase ? 1n : 0n;
  const baseAmountAfter = baseAmountBefore + (scenario.simulationFailure === 'base-delta' || scenario.simulationFailure === 'existing-base-changed' ? 1n : 0n);
  const baseAta = getAssociatedTokenAddressSync(mint, simulationPayer, true, TOKEN_PROGRAM_ID);
  const quoteAta = getAssociatedTokenAddressSync(NATIVE_MINT, simulationPayer, true, TOKEN_PROGRAM_ID);
  const fundedPayerAddresses = new Set([PAYER, ...(scenario.additionalFundedPayers ?? [])].map(key => key.toBase58()));
  const existingWsolOwners = new Set((scenario.existingWsolOwners ?? []).map(key => key.toBase58()));
  const existingBaseOwners = new Set((scenario.existingBaseOwners ?? []).map(key => key.toBase58()));
  const candidateOwners = [
    PAYER, ...(scenario.additionalFundedPayers ?? []), ...(scenario.protocolFeeRecipients ?? []),
    scenario.globalAdmin ?? new PublicKey(Buffer.alloc(32, 9)),
  ];
  const associated = new Map<string, { owner: PublicKey; mint: PublicKey; kind: 'base' | 'quote' }>();
  for (const owner of candidateOwners) {
    if (owner.equals(PublicKey.default)) continue;
    associated.set(getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID).toBase58(), { owner, mint, kind: 'base' });
    associated.set(getAssociatedTokenAddressSync(NATIVE_MINT, owner, true, TOKEN_PROGRAM_ID).toBase58(), { owner, mint: NATIVE_MINT, kind: 'quote' });
  }
  const simLogs = (spent = actualSpend) => {
    const program = scenario.simulationFailure === 'wrong-log-scope' ? PUMP_AMM_FEE_CONFIG_PDA : PUMP_AMM_PROGRAM_ID;
    const buyPool = scenario.simulationFailure === 'wrong-event' ? new PublicKey(Buffer.alloc(32, 55)) : poolKey;
    const buy = `Program data: ${pumpEvent('buyEvent', {
      baseAmountOut: expectedBuy.base, userQuoteAmountIn: new BN(spent.toString()), pool: buyPool, user: simulationPayer,
    })}`;
    const sell = `Program data: ${pumpEvent('sellEvent', {
      baseAmountIn: expectedBuy.base, userQuoteAmountOut: new BN(actualReceive.toString()), pool: poolKey, user: simulationPayer,
    })}`;
    return [
      `Program ${program.toBase58()} invoke [1]`, buy,
      ...(scenario.simulationFailure === 'duplicate-event' ? [buy] : []),
      `Program ${program.toBase58()} success`,
      `Program ${program.toBase58()} invoke [1]`, sell,
      `Program ${program.toBase58()} success`,
    ];
  };
  const rpcResult = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { headers: { 'content-type': 'application/json' } });
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://api.dexscreener.com/')) {
      if (scenario.failDex) return new Response('unavailable', { status: 503, headers: { 'retry-after': '11' } });
      return new Response(JSON.stringify([{
        chainId: 'solana', pairAddress: 'FixtureSolUsdc', dexId: 'raydium', url: 'https://dexscreener.com/solana/FixtureSolUsdc',
        baseToken: { address: NATIVE_MINT.toBase58(), name: 'Wrapped SOL', symbol: 'SOL' },
        quoteToken: { address: USDC, name: 'USD Coin', symbol: 'USDC' }, priceUsd: '160',
        liquidity: { usd: '10000000' }, volume: { h24: '1000000' }, txns: { h24: { buys: 1, sells: 1 } },
      }]), { headers: { 'content-type': 'application/json' } });
    }
    const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    methods.push(request);
    if (request.method === 'getMultipleAccounts') {
      const keys = request.params[0] as string[];
      const discovery = keys.length === 3 && keys[0] === poolKey.toBase58();
      const capture = keys.length === 8 && keys[0] === poolKey.toBase58();
      const map = discovery ? poolAccounts : capture ? capturedAccounts : undefined;
      let contextSlot = discovery ? scenario.discoverySlot ?? SLOT + 1 : capture ? scenario.captureSlot ?? SLOT + 2 : Math.max(SLOT + 1, scenario.captureSlot ?? SLOT + 2);
      if (capture && scenario.malformedCaptureSlot) contextSlot = (scenario.discoverySlot ?? SLOT + 1) - 1;
      return rpcResult({ context: { slot: contextSlot }, value: keys.map(key => {
        if (scenario.simulate && fundedPayerAddresses.has(key)) {
          return rpcAccount(key === PAYER.toBase58() && scenario.payerSystem === false ? TOKEN_PROGRAM_ID : PublicKey.default,
            Buffer.alloc(0), { lamports: payerLamports });
        }
        const associatedAccount = scenario.simulate ? associated.get(key) : undefined;
        if (associatedAccount) {
          const existing = associatedAccount.kind === 'quote'
            ? existingWsolOwners.has(associatedAccount.owner.toBase58())
            : existingBaseOwners.has(associatedAccount.owner.toBase58());
          return existing
            ? rpcAccount(TOKEN_PROGRAM_ID, tokenAccountBytes(associatedAccount.mint, associatedAccount.owner, 1n))
            : null;
        }
        const missingKey = scenario.missingCaptureAccount === 'pool' ? poolKey.toBase58()
          : scenario.missingCaptureAccount === 'baseMint' ? mint.toBase58()
            : scenario.missingCaptureAccount === 'quoteMint' ? NATIVE_MINT.toBase58()
              : scenario.missingCaptureAccount === 'baseVault' ? baseVault.toBase58()
                : scenario.missingCaptureAccount === 'quoteVault' ? quoteVault.toBase58()
                  : scenario.missingCaptureAccount === 'lpMint' ? lpMint.toBase58() : undefined;
        if (capture && missingKey === key) return null;
        const found = map?.get(key);
        if (found && discovery && scenario.wrongPoolOwner && key === poolKey.toBase58()) return rpcAccount(PublicKey.default, discoveredPool);
        if (found && capture && scenario.wrongCapturePoolOwner && key === poolKey.toBase58()) return rpcAccount(PublicKey.default, pool);
        const wrongOwnerKey = scenario.wrongCaptureAccountOwner === 'baseMint' ? mint.toBase58()
          : scenario.wrongCaptureAccountOwner === 'baseVault' ? baseVault.toBase58()
            : scenario.wrongCaptureAccountOwner === 'quoteVault' ? quoteVault.toBase58()
              : scenario.wrongCaptureAccountOwner === 'lpMint' ? lpMint.toBase58() : undefined;
        if (found && capture && wrongOwnerKey === key) return rpcAccount(PublicKey.default, Buffer.from(found.data[0], 'base64'));
        return found ?? null;
      }) });
    }
    if (request.method === 'getAccountInfo' && request.params[0] === PUMP_AMM_PROGRAM_ID.toBase58()) return rpcResult({
      context: { slot: SLOT + methods.length }, value: rpcAccount(UPGRADEABLE_LOADER, header, { executable: true }),
    });
    if (request.method === 'getAccountInfo' && request.params[0] === PROGRAM_DATA.toBase58()) return rpcResult({
      context: { slot: SLOT + methods.length }, value: rpcAccount(UPGRADEABLE_LOADER, programData),
    });
    if (request.method === 'getLatestBlockhash') {
      const index = blockhashIndex++;
      const blockhash = scenario.blockhashes?.[index] ?? new PublicKey(Buffer.alloc(32, 44 + index)).toBase58();
      return rpcResult({ context: { slot: SLOT + 3 + index }, value: { blockhash, lastValidBlockHeight: 10_000 + index } });
    }
    if (request.method === 'getFeeForMessage') {
      const index = feeResponseIndex++;
      const error = scenario.feeErrors?.[index];
      if (error) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error }), { headers: { 'content-type': 'application/json' } });
      const value = scenario.feeResponses ? scenario.feeResponses[index] : networkFeeLamports;
      return rpcResult({ context: { slot: SLOT + 1 }, value });
    }
    if (request.method === 'getMinimumBalanceForRentExemption') return rpcResult(rentLamports);
    if (request.method === 'simulateTransaction' && scenario.simulate) {
      const failure = scenario.simulationFailure;
      const params = request.params as [string, { accounts?: { addresses?: unknown[] } }];
      const transaction = VersionedTransaction.deserialize(Buffer.from(params[0]!, 'base64'));
      const staticKeys = transaction.message.staticAccountKeys.map(key => key.toBase58());
      const [payerOutput, baseOutput, quoteOutput] = params[1]?.accounts?.addresses ?? [];
      const payerIndex = staticKeys.indexOf(simulationPayer.toBase58());
      const baseIndex = staticKeys.indexOf(baseAta.toBase58());
      const quoteIndex = staticKeys.indexOf(quoteAta.toBase58());
      if (payerIndex !== 0 || baseIndex < 0 || quoteIndex < 0 || payerOutput !== simulationPayer.toBase58() || baseOutput !== baseAta.toBase58() || quoteOutput !== quoteAta.toBase58()) {
        throw new Error('FIXTURE_SIMULATION_REQUEST_DOES_NOT_MATCH_COMPILED_MESSAGE');
      }

      const preBalances = Array<number>(staticKeys.length).fill(0);
      const postBalances = [...preBalances];
      const baseBeforeLamports = hasExistingBase ? rentLamports : 0;
      const baseAfterLamports = rentLamports;
      preBalances[payerIndex] = preSimulationPayerLamports;
      postBalances[payerIndex] = afterPayerLamports;
      preBalances[baseIndex] = baseBeforeLamports;
      postBalances[baseIndex] = baseAfterLamports;
      if (failure === 'pre-wsol') preBalances[quoteIndex] = 1;
      if (failure === 'post-wsol') postBalances[quoteIndex] = 1;

      const tokenRecord = (accountIndex: number, amount: bigint, overrides: { mint?: string; owner?: string; programId?: string; decimals?: number } = {}) => ({
        accountIndex, mint: overrides.mint ?? MINT, owner: overrides.owner ?? simulationPayer.toBase58(),
        programId: overrides.programId ?? TOKEN_PROGRAM_ID.toBase58(),
        uiTokenAmount: { amount: amount.toString(), decimals: overrides.decimals ?? 6, uiAmount: null, uiAmountString: '0' },
      });
      let preTokenBalances: unknown[] = hasExistingBase ? [tokenRecord(baseIndex, baseAmountBefore)] : [];
      let postTokenBalances: unknown[] = [tokenRecord(baseIndex, baseAmountAfter)];
      if (failure === 'missing-existing-base-pre') preTokenBalances = [];
      if (failure === 'improper-new-base-pre') preTokenBalances = [tokenRecord(baseIndex, 1n)];
      if (failure === 'pre-wsol') preTokenBalances.push(tokenRecord(quoteIndex, 1n, { mint: NATIVE_MINT.toBase58(), decimals: 9 }));
      if (failure === 'post-wsol') postTokenBalances.push(tokenRecord(quoteIndex, 1n, { mint: NATIVE_MINT.toBase58(), decimals: 9 }));
      if (failure === 'duplicate-token') {
        preTokenBalances = [...preTokenBalances, ...preTokenBalances];
        postTokenBalances = [...postTokenBalances, ...postTokenBalances];
      }
      if (failure === 'token-out-of-range') postTokenBalances.push(tokenRecord(staticKeys.length + 1, baseAmountAfter));
      if (failure === 'token-wrong-mint') postTokenBalances[0] = tokenRecord(baseIndex, baseAmountAfter, { mint: USDC });
      if (failure === 'token-wrong-owner') postTokenBalances[0] = tokenRecord(baseIndex, baseAmountAfter, { owner: PAYER.toBase58() === simulationPayer.toBase58() ? USDC : PAYER.toBase58() });
      if (failure === 'token-wrong-program') postTokenBalances[0] = tokenRecord(baseIndex, baseAmountAfter, { programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' });
      if (failure === 'token-wrong-decimals') postTokenBalances[0] = tokenRecord(baseIndex, baseAmountAfter, { decimals: 9 });
      if (failure === 'token-wrong-amount') postTokenBalances[0] = tokenRecord(baseIndex, baseAmountAfter + 1n);

      const returnedPayerLamports = postBalances[payerIndex]! + (failure === 'returned-lamport-mismatch' ? 1 : 0);
      const returnedBaseLamports = postBalances[baseIndex]! + (failure === 'base-lamport-mismatch' ? 1 : 0);
      const baseBytes = tokenAccountBytes(failure === 'base-wrong-mint' ? wrongMint : mint, simulationPayer, baseAmountAfter);
      if (failure === 'base-wrong-state') baseBytes[108] = 0;
      const returnedBaseOwner = failure === 'base-wrong-owner' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM_ID;
      const returnedPayerOwner = failure === 'payer-wrong-owner' ? TOKEN_PROGRAM_ID : PublicKey.default;
      const returnedQuote = failure === 'quote-returned' ? rpcAccount(TOKEN_PROGRAM_ID, tokenAccountBytes(NATIVE_MINT, simulationPayer, 1n))
        : failure === 'quote-tombstone-funded' ? rpcAccount(PublicKey.default, Buffer.alloc(0), { lamports: 1 })
          : failure === 'quote-tombstone-nonsystem' ? rpcAccount(TOKEN_PROGRAM_ID, Buffer.alloc(0), { lamports: 0 })
            : failure === 'quote-tombstone-data' ? rpcAccount(PublicKey.default, Buffer.from([0]), { lamports: 0 })
              : failure === 'quote-tombstone-executable' ? rpcAccount(PublicKey.default, Buffer.alloc(0), { lamports: 0, executable: true })
                : scenario.simulationQuoteAccount === 'closed-tombstone' ? rpcAccount(PublicKey.default, Buffer.alloc(0), { lamports: 0 }) : null;
      const simValue: Record<string, unknown> = {
        err: failure === 'simulation-error' ? { InstructionError: [0, 'Custom'] } : null,
        accounts: [
          rpcAccount(returnedPayerOwner, Buffer.alloc(0), { lamports: returnedPayerLamports, executable: failure === 'payer-executable' }),
          rpcAccount(returnedBaseOwner, baseBytes, { lamports: returnedBaseLamports, executable: failure === 'base-executable' }),
          returnedQuote,
        ],
        logs: simLogs(failure === 'event-spend' ? actualSpend + 1n : actualSpend),
        fee: failure === 'fee-negative' ? -1
          : failure === 'fee-fractional' ? 1.5
            : failure === 'fee-unsafe' ? Number.MAX_SAFE_INTEGER + 1 : simulationFeeLamports,
        preBalances,
        postBalances,
        preTokenBalances,
        postTokenBalances,
        loadedAddresses: failure === 'loaded-addresses-nonempty'
          ? { writable: [PAYER.toBase58()], readonly: [] }
          : { writable: [], readonly: [] },
      };
      if (failure === 'missing-vectors') { delete simValue.preBalances; delete simValue.postBalances; }
      if (failure === 'null-vectors') { simValue.preBalances = null; simValue.postBalances = null; }
      if (failure === 'missing-fee') delete simValue.fee;
      if (failure === 'null-fee') simValue.fee = null;
      if (failure === 'missing-token-vectors') { delete simValue.preTokenBalances; delete simValue.postTokenBalances; }
      if (failure === 'null-token-vectors') { simValue.preTokenBalances = null; simValue.postTokenBalances = null; }
      if (failure === 'missing-loaded-addresses') delete simValue.loadedAddresses;
      if (failure === 'null-loaded-addresses') simValue.loadedAddresses = null;
      if (failure === 'native-vector-length') simValue.preBalances = preBalances.slice(0, -1);
      if (failure === 'native-negative') preBalances[payerIndex] = -1;
      if (failure === 'native-fractional') preBalances[payerIndex] = 1.5;
      if (failure === 'native-unsafe') preBalances[payerIndex] = Number.MAX_SAFE_INTEGER + 1;
      if (failure === 'post-wsol') postBalances[quoteIndex] = 1;
      if (failure === 'pre-wsol') preBalances[quoteIndex] = 1;
      const captureSlot = scenario.captureSlot ?? SLOT + 2;
      const contextSlot = failure === 'wrong-slot' ? Math.max(0, captureSlot - 1) : captureSlot;
      return rpcResult({ context: { slot: contextSlot }, value: simValue });
    }
    throw new Error(`UNEXPECTED_MOCK_RPC_${request.method}`);
  };
  return { fetcher, methods, poolKey, baseVault, quoteVault, lpMint, payer: PAYER, expectedBaseAtomic: expectedBuy.base.toString(), baseAta, quoteAta };
}

const controls: ControlFacts = {
  complete: true, supplyAllowed: true, transferAllowed: true, surfaceSupported: true,
  currentFeeBps: '0', feeImmutable: true, controls: [], unsupported: [], evidenceIds: ['rpc-mint-raw'],
};

function pumpUsdRecoveryFetcher(baseFetch: typeof fetch, events: string[], status = 200) {
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const pairText = JSON.stringify([{
    chainId: 'solana', pairAddress: 'FixtureSolUsdcFallback', dexId: 'raydium', url: 'https://dexscreener.com/solana/FixtureSolUsdcFallback',
    baseToken: { address: NATIVE_MINT.toBase58(), name: 'Wrapped SOL', symbol: 'SOL' },
    quoteToken: { address: USDC, name: 'USD Coin', symbol: 'USDC' }, priceUsd: '160',
    liquidity: { usd: '10000000' }, volume: { h24: '1000000' }, txns: { h24: { buys: 1, sells: 1 } },
  }]);
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://api.fetch.tinyfish.ai/') {
      events.push('tinyfish-fetch');
      fetchCalls.push({ url, init });
      const request = JSON.parse(String(init?.body)) as { urls: string[]; format: string };
      const body = JSON.stringify({
        results: request.urls.map(requestedUrl => ({ url: requestedUrl, final_url: requestedUrl, format: 'html', text: pairText })),
        errors: [],
      });
      return new Response(body, { status, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('https://api.dexscreener.com/')) {
      events.push('dexscreener');
      return baseFetch(input, init);
    }
    if (url.startsWith('https://rpc.example')) {
      const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      if (request.method === 'getMultipleAccounts') {
        const count = (request.params[0] as string[]).length;
        if (count === 3) events.push('pool-discovery');
        if (count === 8) events.push('state-capture');
      }
      return baseFetch(input, init);
    }
    throw new Error(`UNEXPECTED_MOCK_REQUEST_${url}`);
  };
  return { fetcher, fetchCalls, pairText };
}

test('canonical PumpSwap binding and SDK quotes use the requested USD size and acquired-quantity exit', async () => {
  const f = await fixture();
  const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, undefined, SLOT, 'https://rpc.example', f.fetcher, () => AT);
  assert.equal(read.inspection.bindingVerified, true);
  assert.equal(read.inspection.poolAddress, f.poolKey.toBase58());
  assert.equal(read.inspection.certificateId, `pumpswap-canonical-wsol:${f.poolKey.toBase58()}`);
  assert.equal(read.inspection.removableLiquidityFraction, '0.25', 'outstanding LP amount uses the pool LP denominator, not a gross token reserve or whole-token estimate');
  assert.equal(read.inspection.errors.execution, 'PUMP_TRANSACTION_COSTS_UNAVAILABLE');
  assert.equal(read.inspection.errors.simulation, 'PUMP_SIMULATION_PAYER_UNAVAILABLE');
  assert.equal(read.venue?.method, 'INDEPENDENT_QUOTES');
  assert.equal(read.venue?.entryQuoteUsd, '25');
  assert.equal(read.venue?.exitQuantityAtomic, read.venue?.acquiredAtomic, 'exit quote must sell the same acquired base quantity');
  assert.equal(read.venue?.costsReconciled, false, 'missing funded simulation context cannot claim network cost is zero');
  assert.equal(read.venue?.simulation, undefined);
  assert.equal(read.venue?.availableAt, AT, 'the state capture time bounds the quote age');
  const quote = JSON.parse(read.rawArtifacts['pump-quote-calculation']!) as {
    requestedUsd: string; quoteAtomic: string; actualEntryAtomic: string; acquiredAtomic: string; exitAtomic: string; method: string;
  };
  assert.equal(quote.requestedUsd, '25');
  assert.equal(quote.quoteAtomic, '156250000');
  assert.equal(quote.acquiredAtomic, read.venue?.acquiredAtomic);
  assert.equal(quote.method, 'INDEPENDENT_QUOTES');
  assert.ok(BigInt(quote.actualEntryAtomic) > 0n);
  assert.ok(BigInt(quote.exitAtomic) > 0n);
  assert.deepEqual(read.inspection.evidenceIds, [
    'rpc-genesis', 'pump-pool-config', 'pump-mints-vaults', 'pump-program', 'pump-program-data', 'pump-sol-usd', 'pump-simulation-fallback-payers', 'pump-quote-calculation',
  ]);
  assert.deepEqual(Object.keys(read.retrievedAt).sort(), Object.keys(read.rawArtifacts).sort());
  assert.ok(Object.values(read.retrievedAt).every(at => at === AT));
  assert.equal(f.methods.some(call => call.method.toLowerCase().includes('sendtransaction')), false);
  assert.equal(f.methods.some(call => call.method === 'simulateTransaction'), false, 'unsigned simulation was correctly withheld when no public payer was available');
});

test('a null blockhash-specific fee rebuilds both unsigned messages once and preserves every attempt', async () => {
  const f = await fixture({ simulate: true, feeResponses: [null, 5_100, 6_100, 7_100] });
  const holders: HolderFacts = {
    supplyAtomic: PAYLOAD_MINT_SUPPLY.toString(), slot: SLOT, complete: false, evidenceIds: ['holders'],
    accounts: [{ address: 'candidate-token-account', owner: f.payer.toBase58(), amount: '1' }],
  };
  const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, holders, SLOT, 'https://rpc.example', f.fetcher, () => AT);
  const fees = f.methods.filter(call => call.method === 'getFeeForMessage');
  const blockhashes = f.methods.filter(call => call.method === 'getLatestBlockhash');
  assert.equal(fees.length, 4, 'both original quotes and both refreshed quotes are retained');
  assert.equal(blockhashes.length, 2, 'one finalized blockhash refresh is used for the retry');
  assert.equal(f.methods.filter(call => call.method === 'simulateTransaction').length, 1);
  assert.equal(read.inspection.errors.simulation, undefined);
  assert.equal(read.venue?.costsReconciled, true);
  for (const id of [
    'pump-blockhash', 'pump-blockhash-retry', 'pump-entry-network-fee', 'pump-exit-network-fee',
    'pump-entry-network-fee-retry', 'pump-exit-network-fee-retry',
  ]) assert.ok(read.rawArtifacts[id], `${id} keeps its own provider response evidence`);

  const recentBlockhash = (call: typeof fees[number]) => MessageV0.deserialize(Buffer.from(String(call.params[0]), 'base64')).recentBlockhash;
  const originalHash = recentBlockhash(fees[0]!);
  const refreshedHash = recentBlockhash(fees[2]!);
  assert.equal(recentBlockhash(fees[1]!), originalHash, 'the initial entry and exit messages share the first blockhash');
  assert.notEqual(refreshedHash, originalHash, 'the retry messages use the refreshed finalized blockhash');
  assert.equal(recentBlockhash(fees[3]!), refreshedHash, 'both retry messages are rebuilt against the same refreshed blockhash');
  assert.deepEqual(fees.map(call => (call.params[1] as { minContextSlot: number }).minContextSlot), [SLOT + 3, SLOT + 3, SLOT + 4, SLOT + 4]);
  assert.deepEqual(blockhashes.map(call => call.params[0]), [
    { commitment: 'finalized', minContextSlot: SLOT + 2 },
    { commitment: 'finalized', minContextSlot: SLOT + 2 },
  ]);
});

test('exhausted or malformed message fees stay unknown without retrying malformed RPC values', async t => {
  await t.test('null remains unavailable after the single complete retry pair', async () => {
    const f = await fixture({ simulate: true, feeResponses: [null, 5_000, null, null] });
    const holders: HolderFacts = {
      supplyAtomic: PAYLOAD_MINT_SUPPLY.toString(), slot: SLOT, complete: false, evidenceIds: ['holders'],
      accounts: [{ address: 'candidate-token-account', owner: f.payer.toBase58(), amount: '1' }],
    };
    const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, holders, SLOT, 'https://rpc.example', f.fetcher, () => AT);
    assert.equal(read.inspection.errors.simulation, 'PUMP_FEE_MESSAGE_UNAVAILABLE');
    assert.equal(read.venue?.costsReconciled, false);
    assert.equal(f.methods.filter(call => call.method === 'getFeeForMessage').length, 4);
    assert.equal(f.methods.filter(call => call.method === 'getLatestBlockhash').length, 2);
    assert.equal(f.methods.some(call => call.method === 'simulateTransaction'), false);
    for (const id of ['pump-entry-network-fee', 'pump-exit-network-fee', 'pump-entry-network-fee-retry', 'pump-exit-network-fee-retry']) {
      assert.ok(read.rawArtifacts[id], `${id} remains inspectable when the fee lookup is unavailable`);
    }
  });

  for (const [label, malformed] of [
    ['negative', -1], ['fractional', 1.5], ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ] as const) {
    await t.test(`${label} non-null fee is an RPC shape error without retry`, async () => {
      const f = await fixture({ simulate: true, feeResponses: [malformed, 5_000] });
      const holders: HolderFacts = {
        supplyAtomic: PAYLOAD_MINT_SUPPLY.toString(), slot: SLOT, complete: false, evidenceIds: ['holders'],
        accounts: [{ address: 'candidate-token-account', owner: f.payer.toBase58(), amount: '1' }],
      };
      const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, holders, SLOT, 'https://rpc.example', f.fetcher, () => AT);
      assert.equal(read.inspection.errors.simulation, 'RPC_SHAPE');
      assert.equal(read.venue?.costsReconciled, false);
      assert.equal(f.methods.filter(call => call.method === 'getFeeForMessage').length, 1);
      assert.equal(f.methods.filter(call => call.method === 'getLatestBlockhash').length, 1);
      assert.equal(f.methods.some(call => call.method === 'simulateTransaction'), false);
      assert.ok(read.rawArtifacts['pump-entry-network-fee']);
      assert.equal(read.rawArtifacts['pump-entry-network-fee-retry'], undefined);
    });
  }
});

test('fresh Shared retries only an identical min-context fee read and keeps failures unknown', async t => {
  const slotFloorError = { code: -32016, message: 'Minimum context slot has not been reached' };

  await t.test('one -32016 retry succeeds with the same finalized message and slot floor', async () => {
    const f = await fixture({ simulate: true, feeResponses: [null, 5_000, 6_000], feeErrors: [slotFloorError] });
    const holders: HolderFacts = {
      supplyAtomic: PAYLOAD_MINT_SUPPLY.toString(), slot: SLOT, complete: false, evidenceIds: ['holders'],
      accounts: [{ address: 'candidate-token-account', owner: f.payer.toBase58(), amount: '1' }],
    };
    const waits: number[] = [];
    const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, holders, SLOT, 'https://rpc.example', f.fetcher,
      () => AT, undefined, { tinyfishKey: TINYFISH_KEY }, async (milliseconds) => { waits.push(milliseconds); });
    const fees = f.methods.filter(call => call.method === 'getFeeForMessage');
    assert.equal(fees.length, 3, JSON.stringify({ inspection: read.inspection, venue: read.venue, ids: Object.keys(read.rawArtifacts), methods: f.methods }));
    assert.deepEqual(waits, [1000]);
    assert.deepEqual(fees[0]!.params, fees[1]!.params, 'retry preserves the exact base64 message, commitment, and minContextSlot');
    assert.equal((fees[0]!.params[1] as { commitment: string; minContextSlot: number }).commitment, 'finalized');
    assert.equal((fees[0]!.params[1] as { minContextSlot: number }).minContextSlot, SLOT + 3);
    assert.equal(f.methods.filter(call => call.method === 'getLatestBlockhash').length, 1, 'min-context recovery does not lower or refresh the blockhash floor');
    assert.equal(f.methods.filter(call => call.method === 'simulateTransaction').length, 1);
    assert.equal(read.venue?.costsReconciled, true);
    assert.equal(read.inspection.errors.simulation, undefined);

    const first = JSON.parse(read.rawArtifacts['pump-entry-network-fee-min-context-attempt-1']!) as { error: { code: number; message: string } };
    const second = JSON.parse(read.rawArtifacts['pump-entry-network-fee-min-context-attempt-2']!) as { result: { value: number } };
    const receipt = JSON.parse(read.rawArtifacts['pump-entry-network-fee-min-context-recovery']!) as {
      method: string; operation: string; params: unknown[]; code: string; delayMs: number; firstResponseId: string; secondResponseId: string;
    };
    assert.deepEqual(first.error, slotFloorError);
    assert.equal(second.result.value, 5_000);
    assert.deepEqual(receipt, {
      method: 'fee-min-context-retry-v1', operation: 'getFeeForMessage', params: fees[0]!.params,
      code: 'RPC_REMOTE_-32016', delayMs: 1000,
      firstResponseId: 'pump-entry-network-fee-min-context-attempt-1',
      secondResponseId: 'pump-entry-network-fee-min-context-attempt-2',
    });
    assert.equal(read.rawArtifacts['pump-entry-network-fee'], read.rawArtifacts['pump-entry-network-fee-min-context-attempt-2']);
  });

  await t.test('a different RPC code does not receive the extra retry', async () => {
    const f = await fixture({ simulate: true, feeResponses: [null], feeErrors: [{ code: -32005, message: 'Node is behind' }] });
    const holders: HolderFacts = {
      supplyAtomic: PAYLOAD_MINT_SUPPLY.toString(), slot: SLOT, complete: false, evidenceIds: ['holders'],
      accounts: [{ address: 'candidate-token-account', owner: f.payer.toBase58(), amount: '1' }],
    };
    const waits: number[] = [];
    const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, holders, SLOT, 'https://rpc.example', f.fetcher,
      () => AT, undefined, { tinyfishKey: TINYFISH_KEY }, async milliseconds => { waits.push(milliseconds); });
    assert.equal(f.methods.filter(call => call.method === 'getFeeForMessage').length, 1);
    assert.deepEqual(waits, []);
    assert.equal(read.rawArtifacts['pump-entry-network-fee-min-context-attempt-1'] !== undefined, true);
    assert.equal(read.rawArtifacts['pump-entry-network-fee-min-context-recovery'], undefined);
    assert.equal(read.venue?.costsReconciled, false);
    assert.equal(read.inspection.errors.simulation, 'RPC_REMOTE_-32005');
  });

  await t.test('a second -32016 and cancellation during the delay never produce a fee', async () => {
    const repeated = await fixture({ simulate: true, feeResponses: [null, null], feeErrors: [slotFloorError, slotFloorError] });
    const repeatedHolders: HolderFacts = {
      supplyAtomic: PAYLOAD_MINT_SUPPLY.toString(), slot: SLOT, complete: false, evidenceIds: ['holders'],
      accounts: [{ address: 'candidate-token-account', owner: repeated.payer.toBase58(), amount: '1' }],
    };
    const repeatedWaits: number[] = [];
    const repeatedRead = await inspectPumpSwap(TOKEN, starterProfile(), controls, repeatedHolders, SLOT, 'https://rpc.example', repeated.fetcher,
      () => AT, undefined, { tinyfishKey: TINYFISH_KEY }, async milliseconds => { repeatedWaits.push(milliseconds); });
    assert.equal(repeated.methods.filter(call => call.method === 'getFeeForMessage').length, 2, 'the logical read gets one retry only');
    assert.deepEqual(repeatedWaits, [1000]);
    assert.ok(repeatedRead.rawArtifacts['pump-entry-network-fee-min-context-attempt-2']);
    assert.equal(repeatedRead.rawArtifacts['pump-entry-network-fee'], undefined, 'a failed retry never fabricates a normal fee receipt');
    assert.equal(repeatedRead.venue?.costsReconciled, false);
    assert.equal(repeatedRead.inspection.errors.simulation, 'RPC_REMOTE_-32016');

    const controller = new AbortController();
    const cancelled = await fixture({ simulate: true, feeResponses: [null], feeErrors: [slotFloorError] });
    const cancelledHolders: HolderFacts = {
      supplyAtomic: PAYLOAD_MINT_SUPPLY.toString(), slot: SLOT, complete: false, evidenceIds: ['holders'],
      accounts: [{ address: 'candidate-token-account', owner: cancelled.payer.toBase58(), amount: '1' }],
    };
    const cancelledRead = await inspectPumpSwap(TOKEN, starterProfile(), controls, cancelledHolders, SLOT, 'https://rpc.example', cancelled.fetcher,
      () => AT, controller.signal, { tinyfishKey: TINYFISH_KEY }, async (_milliseconds, signal) => { controller.abort(); signal?.throwIfAborted(); });
    assert.equal(cancelled.methods.filter(call => call.method === 'getFeeForMessage').length, 1, 'cancellation during the wait prevents the retry request');
    assert.equal(cancelledRead.rawArtifacts['pump-entry-network-fee-min-context-attempt-2'], undefined);
    assert.equal(cancelledRead.venue?.costsReconciled, false);
  });
});

test('authoritative same-bank state supplies the LP denominator, quote slot, timestamp, and evidence', async () => {
  const f = await fixture({ discoveryPoolLpSupply: 1000n, poolLpSupply: 800n, lpSupply: 50n, discoverySlot: SLOT + 1, captureSlot: SLOT + 2 });
  let tick = 0;
  const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, undefined, SLOT, 'https://rpc.example', f.fetcher,
    () => new Date(Date.parse(AT) + tick++ * 1000).toISOString());

  assert.equal(read.inspection.removableLiquidityFraction, '0.0625', '50 outstanding LP supply is divided by the captured pool denominator 800');
  assert.notEqual(read.inspection.removableLiquidityFraction, '0.05', 'the bootstrap denominator 1000 cannot be combined with current LP supply');
  const discovery = JSON.parse(read.rawArtifacts['pump-pool-config']!) as { result: { context: { slot: number } } };
  const capture = JSON.parse(read.rawArtifacts['pump-mints-vaults']!) as { result: { context: { slot: number } } };
  const captureCall = f.methods.find(call => call.method === 'getMultipleAccounts' && (call.params[0] as string[]).length === 8);
  const quote = JSON.parse(read.rawArtifacts['pump-quote-calculation']!) as { slot: number };
  assert.ok(captureCall, 'all coupled current values arrive in one eight-account response');
  assert.equal((captureCall!.params[1] as { minContextSlot: number }).minContextSlot, SLOT + 1);
  assert.equal(discovery.result.context.slot, SLOT + 1);
  assert.equal(capture.result.context.slot, SLOT + 2);
  assert.equal(quote.slot, capture.result.context.slot, 'derived quote state records the authoritative capture bank');
  assert.ok(read.retrievedAt['pump-mints-vaults']! > read.retrievedAt['pump-pool-config']!);
  assert.equal(read.venue?.availableAt, read.retrievedAt['pump-mints-vaults'], 'quote freshness starts at authoritative capture retrieval');
  assert.equal(read.venue?.expiresAt, new Date(Date.parse(read.retrievedAt['pump-mints-vaults']!) + 30_000).toISOString());
  assert.ok(read.inspection.evidenceIds.includes('pump-pool-config'), 'pool discovery remains inspectable provenance');
  assert.ok(read.inspection.evidenceIds.includes('pump-mints-vaults'));
  assert.ok(read.venue?.evidenceIds.includes('pump-mints-vaults'));
  assert.equal(read.venue?.evidenceIds.includes('pump-pool-config'), false, 'discovery is excluded from quote-state evidence');
});

test('captured fees and disable flags supersede favorable discovery configuration', async () => {
  const currentFees = { lp: 400, protocol: 250, creator: 150 };
  const changedFees = await fixture({ discoveryFeeTierBps: { lp: 20, protocol: 15, creator: 10 }, feeTierBps: currentFees });
  const currentFromBothReads = await fixture({ discoveryFeeTierBps: currentFees, feeTierBps: currentFees });
  const defaultFees = await fixture();
  const stale = await inspectPumpSwap(TOKEN, starterProfile(), controls, undefined, SLOT, 'https://rpc.example', changedFees.fetcher, () => AT);
  const current = await inspectPumpSwap(TOKEN, starterProfile(), controls, undefined, SLOT, 'https://rpc.example', currentFromBothReads.fetcher, () => AT);
  const defaultRead = await inspectPumpSwap(TOKEN, starterProfile(), controls, undefined, SLOT, 'https://rpc.example', defaultFees.fetcher, () => AT);
  const changedQuote = JSON.parse(stale.rawArtifacts['pump-quote-calculation']!) as { actualEntryAtomic: string; acquiredAtomic: string };
  const currentQuote = JSON.parse(current.rawArtifacts['pump-quote-calculation']!) as { actualEntryAtomic: string; acquiredAtomic: string };
  const defaultQuote = JSON.parse(defaultRead.rawArtifacts['pump-quote-calculation']!) as { actualEntryAtomic: string; acquiredAtomic: string };
  assert.equal(changedQuote.actualEntryAtomic, currentQuote.actualEntryAtomic, 'the capture fee schedule controls the quote even when discovery had lower fees');
  assert.equal(changedQuote.acquiredAtomic, currentQuote.acquiredAtomic);
  assert.notEqual(changedQuote.acquiredAtomic, defaultQuote.acquiredAtomic, 'captured fee changes affect the acquired base quantity');

  const disabled = await fixture({ discoveryDisableFlags: 0, captureDisableFlags: 8 });
  const noExecution = await inspectPumpSwap(TOKEN, starterProfile(), controls, undefined, SLOT, 'https://rpc.example', disabled.fetcher, () => AT);
  assert.equal(noExecution.inspection.bindingVerified, true, 'canonical pool identity remains independently usable');
  assert.equal(noExecution.inspection.executionDisabled, true, 'the captured disabled state is authoritative');
  assert.equal(noExecution.inspection.errors.execution, 'PUMP_EXECUTION_MODE_UNSUPPORTED');
  assert.equal(noExecution.venue, undefined);
  assert.equal(noExecution.rawArtifacts['pump-quote-calculation'], undefined);
});

test('authoritative capture rejects rebound pool pointers and owners before promoting liquidity or quotes', async t => {
  for (const [name, scenario] of [
    ['base vault pointer changed after discovery', { reboundCapturePointer: 'baseVault' }],
    ['quote vault pointer changed after discovery', { reboundCapturePointer: 'quoteVault' }],
    ['LP mint pointer changed after discovery', { reboundCapturePointer: 'lpMint' }],
    ['pool mint changed after discovery', { reboundCapturePointer: 'baseMint' }],
    ['captured pool owner changed', { wrongCapturePoolOwner: true }],
    ['captured base mint owner changed', { wrongCaptureAccountOwner: 'baseMint' }],
    ['captured vault owner changed', { wrongCaptureAccountOwner: 'baseVault' }],
  ] as const) {
    await t.test(name, async () => {
      const f = await fixture(scenario);
      const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, undefined, SLOT, 'https://rpc.example', f.fetcher, () => AT);
      assert.equal(read.inspection.bindingVerified, false);
      assert.equal(read.inspection.errors.binding, 'PUMP_ACCOUNT_BINDING');
      assert.equal(read.inspection.removableLiquidityFraction, undefined);
      assert.equal(read.venue, undefined);
      assert.equal(read.rawArtifacts['pump-quote-calculation'], undefined);
    });
  }
});

test('captured LP account owner failure withholds liquidity and quotes while preserving pool identity', async () => {
  const f = await fixture({ wrongCaptureAccountOwner: 'lpMint' });
  const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, undefined, SLOT, 'https://rpc.example', f.fetcher, () => AT);
  assert.equal(read.inspection.bindingVerified, true);
  assert.equal(read.inspection.errors.liquidity, 'PUMP_LP_UNSUPPORTED');
  assert.equal(read.inspection.removableLiquidityFraction, undefined);
  assert.equal(read.venue, undefined);
  assert.equal(read.rawArtifacts['pump-quote-calculation'], undefined);
});

test('missing or malformed authoritative capture cannot promote discovery values', async t => {
  const cases: Array<[string, Scenario, string]> = [
    ['missing captured LP mint', { missingCaptureAccount: 'lpMint' }, 'PUMP_STATE_MISSING'],
    ['capture context regresses below discovery', { malformedCaptureSlot: true }, 'RPC_SHAPE'],
  ];
  for (const [name, scenario, code] of cases) {
    await t.test(name, async () => {
      const f = await fixture(scenario);
      const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, undefined, SLOT, 'https://rpc.example', f.fetcher, () => AT);
      assert.equal(read.inspection.bindingVerified, false);
      assert.equal(read.inspection.errors.binding, code);
      assert.equal(read.inspection.removableLiquidityFraction, undefined);
      assert.equal(read.venue, undefined);
      assert.ok(read.rawArtifacts['pump-mints-vaults'], 'the failed capture is retained as raw evidence');
      assert.equal(read.rawArtifacts['pump-quote-calculation'], undefined);
    });
  }
});

test('counterfeit pool owner, mint orientation, and vault mint or authority cannot receive a binding certificate', async t => {
  for (const [name, scenario] of [
    ['wrong account owner', { wrongPoolOwner: true }],
    ['wrong base mint', { wrongPoolMint: true }],
    ['wrong quote mint', { wrongQuoteMint: true }],
    ['vault holding another mint', { wrongBaseVaultMint: true }],
    ['vault controlled by another authority', { wrongBaseVaultAuthority: true }],
  ] as const) {
    await t.test(name, async () => {
      const f = await fixture(scenario);
      const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, undefined, SLOT, 'https://rpc.example', f.fetcher, () => AT);
      assert.equal(read.inspection.bindingVerified, false);
      assert.equal(read.venue, undefined);
      assert.equal(read.inspection.errors.binding, 'PUMP_ACCOUNT_BINDING');
      assert.equal(read.rawArtifacts['pump-quote-calculation'], undefined);
    });
  }
});

test('LP mint authority and outstanding supply bound removable fraction; unsupported pool execution modes stay explicit', async t => {
  const fraction = await fixture({ lpSupply: 250n, poolLpSupply: 1000n });
  const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, undefined, SLOT, 'https://rpc.example', fraction.fetcher, () => AT);
  assert.equal(read.inspection.removableLiquidityFraction, '0.25');

  const wrongAuthority = await fixture({ wrongLpAuthority: true });
  const unsupportedLp = await inspectPumpSwap(TOKEN, starterProfile(), controls, undefined, SLOT, 'https://rpc.example', wrongAuthority.fetcher, () => AT);
  assert.equal(unsupportedLp.inspection.bindingVerified, true, 'independent pool identity remains known when LP control evidence fails');
  assert.equal(unsupportedLp.inspection.removableLiquidityFraction, undefined);
  assert.equal(unsupportedLp.inspection.errors.liquidity, 'PUMP_LP_UNSUPPORTED');
  assert.equal(unsupportedLp.venue, undefined);

  for (const scenario of [{ mayhem: true }, { virtualQuoteReserves: -1n }, { disableFlags: 8 }]) {
    const unsupported = await fixture(scenario);
    const mode = await inspectPumpSwap(TOKEN, starterProfile(), controls, undefined, SLOT, 'https://rpc.example', unsupported.fetcher, () => AT);
    assert.equal(mode.inspection.bindingVerified, true);
    assert.equal(mode.inspection.errors.execution, 'PUMP_EXECUTION_MODE_UNSUPPORTED');
    assert.equal(mode.venue, undefined);
  }
});

test('positive virtual quote reserves are included in the SDK price while executable exit stays inside real WSOL reserves', async () => {
  const virtual = await fixture({ virtualQuoteReserves: 17_584_505_630n });
  const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, undefined, SLOT, 'https://rpc.example', virtual.fetcher, () => AT);
  assert.equal(read.inspection.bindingVerified, true);
  assert.equal(read.venue?.method, 'INDEPENDENT_QUOTES');
  assert.equal(read.venue?.exitQuantityAtomic, read.venue?.acquiredAtomic);
  const calculation = JSON.parse(read.rawArtifacts['pump-quote-calculation']!) as {
    virtualQuoteReserves: string; actualQuoteReserve: string; exitAtomic: string;
  };
  assert.equal(calculation.virtualQuoteReserves, '17584505630');
  assert.equal(calculation.actualQuoteReserve, '1000000000000');
  assert.ok(BigInt(calculation.exitAtomic) < BigInt(calculation.actualQuoteReserve));

  const insufficient = await fixture({ quoteVaultAtomic: 100_000_000n, virtualQuoteReserves: 1_000_000_000n });
  const capped = await inspectPumpSwap(TOKEN, starterProfile(), controls, undefined, SLOT, 'https://rpc.example', insufficient.fetcher, () => AT);
  assert.equal(capped.inspection.bindingVerified, true, 'direct pool identity remains usable when the requested sale cannot fit real vault reserves');
  assert.equal(capped.inspection.errors.execution, 'PUMP_EXIT_RESERVE_INSUFFICIENT');
  assert.equal(capped.venue, undefined);
});

test('fresh raw mint controls override supplied stale favorable controls before PumpSwap execution', async () => {
  const f = await fixture({ freezeAuthority: true });
  const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, undefined, SLOT, 'https://rpc.example', f.fetcher, () => AT);
  assert.equal(read.inspection.bindingVerified, true);
  assert.equal(read.controls?.transferAllowed, false);
  assert.deepEqual(read.controls?.controls, ['FREEZE_AUTHORITY']);
  assert.equal(read.controls?.evidenceIds.includes('pump-mints-vaults'), true);
  assert.equal(read.inspection.errors.execution, 'PUMP_EXECUTION_MODE_UNSUPPORTED');
  assert.equal(read.venue, undefined);
});

test('funded deterministic candidate account permits unsigned round-trip reconciliation with real SDK event bytes', async () => {
  const configuredOnly = new PublicKey(Buffer.alloc(32, 77));
  const configuredAdmin = new PublicKey(Buffer.alloc(32, 78));
  const f = await fixture({
    simulate: true, protocolFeeRecipients: [configuredOnly, ...Array(7).fill(PublicKey.default)], globalAdmin: configuredAdmin,
    payerLamports: 1_000_000_000, preSimulationPayerLamports: 1_200_000_000,
    simulationSetupLamports: 2_064_280, simulationFeeLamports: 7_500, simulationQuoteAccount: 'closed-tombstone',
  });
  const holders: HolderFacts = {
    supplyAtomic: PAYLOAD_MINT_SUPPLY.toString(), slot: SLOT, complete: false, evidenceIds: ['holders'],
    // A generated public key with a mocked system account; no wallet or signing key is used.
    accounts: [{ address: 'candidate-token-account', owner: f.payer.toBase58(), amount: '1' }],
  };
  const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, holders, SLOT, 'https://rpc.example', f.fetcher, () => AT);
  assert.equal(read.inspection.bindingVerified, true);
  assert.equal(read.inspection.errors.simulation, undefined);
  assert.equal(read.inspection.errors.execution, undefined);
  assert.equal(read.venue?.method, 'INDEPENDENT_QUOTES');
  assert.equal(read.venue?.costsReconciled, true);
  assert.deepEqual(read.venue?.simulation, { setupVerified: true, buySucceeded: true, sellSucceeded: true });
  assert.equal(read.venue?.entryExternalCostUsd, '0.3310848', 'entry counts the separate message fee and exact rent plus other setup from simulation vectors');
  assert.equal(read.venue?.exitExternalCostUsd, '0.0008', 'exit retains its independent message fee');
  assert.equal(f.methods.filter(call => call.method === 'getFeeForMessage').length, 2, 'only entry and exit message fees are quoted');
  assert.equal(f.methods.filter(call => call.method === 'getMinimumBalanceForRentExemption').length, 0, 'setup is measured from execution balances without a rent quote');
  const sim = f.methods.find(call => call.method === 'simulateTransaction');
  assert.ok(sim);
  assert.equal(f.methods.filter(call => call.method === 'simulateTransaction').length, 1, 'one response supplies the complete execution proof');
  const config = sim.params[1] as {
    encoding: string; sigVerify: boolean; replaceRecentBlockhash: boolean; commitment: string; minContextSlot: number;
    accounts: { encoding: string; addresses: string[] };
  };
  assert.deepEqual(config, {
    encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'finalized', minContextSlot: SLOT + 2,
    accounts: { encoding: 'base64', addresses: [f.payer.toBase58(), f.baseAta.toBase58(), f.quoteAta.toBase58()] },
  });
  assert.deepEqual(Object.keys(config).sort(), ['accounts', 'commitment', 'encoding', 'minContextSlot', 'replaceRecentBlockhash', 'sigVerify']);
  const wire = VersionedTransaction.deserialize(Buffer.from(String(sim.params[0]), 'base64'));
  const staticKeys = wire.message.staticAccountKeys.map(key => key.toBase58());
  assert.equal(wire.message.addressTableLookups.length, 0, 'balance indices bind to static keys without a lookup table');
  assert.equal(new Set(staticKeys).size, staticKeys.length, 'the exact submitted message has unique static account keys');
  assert.equal(staticKeys[0], f.payer.toBase58(), 'the selected simulation subject is the message fee payer');
  assert.ok(wire.signatures.every(signature => signature.every(byte => byte === 0)), 'the submitted transaction remains unsigned');
  const rawSimulation = JSON.parse(read.rawArtifacts['pump-roundtrip-simulation']!) as {
    result: { context: { slot: number }; value: { fee: number; preBalances: number[]; postBalances: number[]; accounts: Array<{ owner: string; executable: boolean; lamports: number; data: [string, string] } | null>; loadedAddresses: { writable: string[]; readonly: string[] } } };
  };
  assert.equal(rawSimulation.result.context.slot, SLOT + 2);
  assert.equal(rawSimulation.result.value.fee, 7_500);
  assert.equal(rawSimulation.result.value.preBalances[0], 1_200_000_000, 'reconciliation begins at the simulation bank, not the earlier funded-account probe');
  assert.deepEqual(rawSimulation.result.value.loadedAddresses, { writable: [], readonly: [] });
  assert.deepEqual(rawSimulation.result.value.accounts[2], { owner: '11111111111111111111111111111111', executable: false, lamports: 0, data: ['', 'base64'] }, 'the exact closed WSOL tombstone is retained from the RPC response');
  assert.equal(f.methods.some(call => call.method === 'getMultipleAccounts'
    && (call.params[0] as string[]).length === 3
    && (call.params[0] as string[]).includes(f.payer.toBase58())
    && (call.params[0] as string[]).includes(f.baseAta.toBase58())
    && (call.params[0] as string[]).includes(f.quoteAta.toBase58())), false, 'payer balances come only from simulateTransaction, with no bank pre-read');
  const calculation = JSON.parse(read.rawArtifacts['pump-quote-calculation']!) as {
    simulationProof: {
      method: string; wireBase64: string; staticAccountKeys: string[]; payerIndex: number; baseIndex: number;
      quoteIndex: number; slot: number; evidenceId: string; feeLamports: string; setupLamports: string;
    };
  };
  const proof = calculation.simulationProof;
  assert.equal(proof.method, 'SIMULATION_PRE_POST_BALANCES');
  assert.equal(proof.wireBase64, sim.params[0], 'the derived artifact retains the exact transaction sent to simulation');
  assert.deepEqual(proof.staticAccountKeys, staticKeys);
  assert.equal(proof.payerIndex, 0);
  assert.equal(proof.baseIndex, staticKeys.indexOf(f.baseAta.toBase58()));
  assert.equal(proof.quoteIndex, staticKeys.indexOf(f.quoteAta.toBase58()));
  assert.equal(proof.slot, SLOT + 2);
  assert.equal(proof.evidenceId, 'pump-roundtrip-simulation');
  assert.equal(proof.feeLamports, '7500');
  assert.equal(proof.setupLamports, '2064280');
  const holderPayerProbe = f.methods.find(call => call.method === 'getMultipleAccounts'
    && (call.params[0] as string[]).length === 1 && (call.params[0] as string[])[0] === f.payer.toBase58());
  assert.ok(holderPayerProbe, 'the observed holder owner is checked before configured fallback accounts');
  assert.equal(read.rawArtifacts['pump-simulation-fallback-payers'], undefined, 'a funded observed holder prevents fallback probing');
  assert.equal(f.methods.some(call => /sendtransaction/i.test(call.method)), false, 'execution remains unsigned and is never broadcast');
});

test('existing base ATA requires unchanged pre/post token balances and records zero setup while both fees remain counted', async () => {
  const f = await fixture({
    simulate: true, existingBaseOwners: [PAYER], payerLamports: 850_000_000,
    preSimulationPayerLamports: 1_250_000_000, simulationFeeLamports: 8_000,
  });
  const holders: HolderFacts = {
    supplyAtomic: PAYLOAD_MINT_SUPPLY.toString(), slot: SLOT, complete: false, evidenceIds: ['holders'],
    accounts: [{ address: 'existing-base-token-account', owner: PAYER.toBase58(), amount: '1' }],
  };
  const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, holders, SLOT, 'https://rpc.example', f.fetcher, () => AT);

  assert.equal(read.inspection.errors.simulation, undefined);
  assert.equal(read.venue?.costsReconciled, true);
  assert.equal(read.venue?.entryExternalCostUsd, '0.0008', 'a verified existing ATA adds no setup rent');
  assert.equal(read.venue?.exitExternalCostUsd, '0.0008');
  const raw = JSON.parse(read.rawArtifacts['pump-roundtrip-simulation']!) as {
    result: { value: { preBalances: number[]; postBalances: number[]; preTokenBalances: Array<{ accountIndex: number; uiTokenAmount: { amount: string } }>; postTokenBalances: Array<{ accountIndex: number; uiTokenAmount: { amount: string } }> } };
  };
  const tx = VersionedTransaction.deserialize(Buffer.from(String(f.methods.find(call => call.method === 'simulateTransaction')?.params[0]), 'base64'));
  const baseIndex = tx.message.staticAccountKeys.findIndex(key => key.equals(f.baseAta));
  assert.ok(raw.result.value.preTokenBalances.some(row => row.accountIndex === baseIndex && row.uiTokenAmount.amount === '1'));
  assert.ok(raw.result.value.postTokenBalances.some(row => row.accountIndex === baseIndex && row.uiTokenAmount.amount === '1'));
  assert.equal(read.venue?.simulation?.setupVerified, true);
});

test('unsigned simulation preserves the 1232-byte wire cap before making an RPC call', async () => {
  const f = await fixture({ simulate: true });
  const holders: HolderFacts = {
    supplyAtomic: PAYLOAD_MINT_SUPPLY.toString(), slot: SLOT, complete: false, evidenceIds: ['holders'],
    accounts: [{ address: 'candidate-token-account', owner: f.payer.toBase58(), amount: '1' }],
  };
  const prototype = VersionedTransaction.prototype;
  const originalSerialize = prototype.serialize;
  Object.defineProperty(prototype, 'serialize', { configurable: true, writable: true, value: () => Buffer.alloc(1233) });
  try {
    const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, holders, SLOT, 'https://rpc.example', f.fetcher, () => AT);
    assert.equal(read.inspection.errors.simulation, 'PUMP_SIMULATION_TRANSACTION_TOO_LARGE');
    assert.equal(read.venue?.costsReconciled, false);
    assert.equal(f.methods.some(call => call.method === 'simulateTransaction'), false, 'oversized unsigned wire is withheld from RPC');
    assert.equal(f.methods.filter(call => call.method === 'getFeeForMessage').length, 2);
  } finally {
    Object.defineProperty(prototype, 'serialize', { configurable: true, writable: true, value: originalSerialize });
  }
});

test('decoded GlobalConfig fee recipients and admin enable a bounded unsigned simulation when no holders are available', async () => {
  const configured = [
    PAYER,
    ...Array.from({ length: 6 }, (_, index) => new PublicKey(Buffer.alloc(32, index + 24))),
    PublicKey.default,
  ];
  const admin = new PublicKey(Buffer.alloc(32, 30));
  const f = await fixture({
    simulate: true,
    protocolFeeRecipients: configured,
    globalAdmin: admin,
    discoveryProtocolFeeRecipients: [new PublicKey(Buffer.alloc(32, 31)), ...Array(7).fill(PublicKey.default)],
    discoveryGlobalAdmin: new PublicKey(Buffer.alloc(32, 32)),
  });
  const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, undefined, SLOT, 'https://rpc.example', f.fetcher, () => AT);

  assert.equal(read.inspection.bindingVerified, true);
  assert.equal(read.inspection.errors.simulation, undefined);
  assert.equal(read.inspection.errors.execution, undefined);
  assert.equal(read.venue?.costsReconciled, true);
  assert.deepEqual(read.venue?.simulation, { setupVerified: true, buySucceeded: true, sellSucceeded: true });
  const fallbackProbe = f.methods.find(call => call.method === 'getMultipleAccounts'
    && (call.params[0] as string[])[0] === PAYER.toBase58());
  assert.ok(fallbackProbe);
  assert.deepEqual(fallbackProbe.params[0], [...configured.filter(key => !key.equals(PublicKey.default)).map(key => key.toBase58()), admin.toBase58()]);
  assert.equal((fallbackProbe.params[0] as string[]).length, 8, 'recipients and admin are de-duplicated and capped together at eight');
  assert.equal(read.retrievedAt['pump-simulation-fallback-payers'], AT);
  const fallbackEvidence = JSON.parse(read.rawArtifacts['pump-simulation-fallback-payers']!) as {
    result: { context: { slot: number }; value: Array<unknown> };
  };
  assert.equal(fallbackEvidence.result.value.length, 8, 'the retained artifact records every checked account in the bounded batch');
  const sim = f.methods.find(call => call.method === 'simulateTransaction');
  assert.ok(sim);
  assert.equal((sim.params[1] as { sigVerify: boolean }).sigVerify, false);
  assert.equal(f.methods.some(call => /sendtransaction/i.test(call.method)), false);
});

test('holder payer selection checks each funded candidate with both ATAs and chooses the first without WSOL', async () => {
  const second = new PublicKey(Buffer.alloc(32, 70));
  const configuredOnly = new PublicKey(Buffer.alloc(32, 71));
  const holders: HolderFacts = {
    supplyAtomic: PAYLOAD_MINT_SUPPLY.toString(), slot: SLOT, complete: false, evidenceIds: ['holders'],
    accounts: [
      { address: 'first-holder-token-account', owner: PAYER.toBase58(), amount: '1' },
      { address: 'second-holder-token-account', owner: second.toBase58(), amount: '1' },
    ],
  };
  const f = await fixture({
    simulate: true, additionalFundedPayers: [second], existingWsolOwners: [PAYER], simulationPayer: second,
    protocolFeeRecipients: [configuredOnly, ...Array(7).fill(PublicKey.default)],
  });
  const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, holders, SLOT, 'https://rpc.example', f.fetcher, () => AT);

  assert.equal(read.venue?.costsReconciled, true);
  assert.deepEqual(read.venue?.simulation, { setupVerified: true, buySucceeded: true, sellSucceeded: true });
  const ataProbe = f.methods.find(call => call.method === 'getMultipleAccounts'
    && (call.params[0] as string[]).length === 4
    && (call.params[0] as string[])[0] === getAssociatedTokenAddressSync(new PublicKey(MINT), PAYER, true, TOKEN_PROGRAM_ID).toBase58());
  assert.ok(ataProbe, 'both ATAs for each funded holder candidate are checked in one batch');
  assert.deepEqual(ataProbe.params[0], [
    getAssociatedTokenAddressSync(new PublicKey(MINT), PAYER, true, TOKEN_PROGRAM_ID).toBase58(),
    getAssociatedTokenAddressSync(NATIVE_MINT, PAYER, true, TOKEN_PROGRAM_ID).toBase58(),
    getAssociatedTokenAddressSync(new PublicKey(MINT), second, true, TOKEN_PROGRAM_ID).toBase58(),
    getAssociatedTokenAddressSync(NATIVE_MINT, second, true, TOKEN_PROGRAM_ID).toBase58(),
  ]);
  assert.equal(read.rawArtifacts['pump-simulation-fallback-payers'], undefined, 'the second usable holder candidate avoids protocol fallback');
  assert.equal(read.rawArtifacts['pump-simulation-fallback-user-accounts'], undefined);
  assert.equal(f.methods.some(call => call.method === 'simulateTransaction'), true);
});

test('a holder with existing WSOL is skipped before trying the GlobalConfig fallback group', async () => {
  const fallbackPayer = new PublicKey(Buffer.alloc(32, 72));
  const holders: HolderFacts = {
    supplyAtomic: PAYLOAD_MINT_SUPPLY.toString(), slot: SLOT, complete: false, evidenceIds: ['holders'],
    accounts: [{ address: 'holder-with-wsol', owner: PAYER.toBase58(), amount: '1' }],
  };
  const f = await fixture({
    simulate: true,
    protocolFeeRecipients: [fallbackPayer, ...Array(7).fill(PublicKey.default)],
    additionalFundedPayers: [fallbackPayer], existingWsolOwners: [PAYER], simulationPayer: fallbackPayer,
  });
  const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, holders, SLOT, 'https://rpc.example', f.fetcher, () => AT);

  assert.equal(read.venue?.costsReconciled, true);
  assert.deepEqual(read.venue?.simulation, { setupVerified: true, buySucceeded: true, sellSucceeded: true });
  assert.ok(read.rawArtifacts['pump-simulation-payers'], 'the original holder candidate check is retained');
  assert.ok(read.rawArtifacts['pump-simulation-user-accounts'], 'the original holder ATAs show why it was skipped');
  assert.ok(read.rawArtifacts['pump-simulation-fallback-payers'], 'the decoded GlobalConfig candidate check is retained');
  assert.ok(read.rawArtifacts['pump-simulation-fallback-user-accounts'], 'the fallback candidate ATAs support payer selection');
  const fallbackRequest = f.methods.find(call => call.method === 'getMultipleAccounts'
    && (call.params[0] as string[]).includes(fallbackPayer.toBase58()));
  assert.ok(fallbackRequest);
  assert.equal(f.methods.some(call => /sendtransaction/i.test(call.method)), false);
});

test('unfunded or non-system GlobalConfig candidates remain unknown and retain safe fallback evidence', async t => {
  for (const scenario of [
    { label: 'insufficient lamports', payerLamports: 1 },
    { label: 'non-system account', payerSystem: false },
  ] as const) {
    await t.test(scenario.label, async () => {
      const readFixture = await fixture({
        simulate: true,
        protocolFeeRecipients: [PAYER, ...Array(7).fill(PublicKey.default)],
        globalAdmin: PublicKey.default,
        ...scenario,
      });
      const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, undefined, SLOT, 'https://rpc.example', readFixture.fetcher, () => AT);

      assert.equal(read.inspection.bindingVerified, true);
      assert.equal(read.inspection.errors.simulation, 'PUMP_SIMULATION_PAYER_UNAVAILABLE');
      assert.equal(read.venue?.costsReconciled, false);
      assert.equal(read.venue?.simulation, undefined);
      assert.equal(read.retrievedAt['pump-simulation-fallback-payers'], AT);
      const fallbackEvidence = JSON.parse(read.rawArtifacts['pump-simulation-fallback-payers']!) as {
        result: { value: Array<unknown> };
      };
      assert.equal(fallbackEvidence.result.value.length, 1);
      assert.equal(readFixture.methods.some(call => call.method === 'simulateTransaction'), false);
      assert.equal(readFixture.methods.some(call => /sendtransaction/i.test(call.method)), false);
    });
  }
});

test('incomplete, malformed or inconsistent single-response simulation proof remains unknown', async t => {
  const cases: Array<{ failure: NonNullable<Scenario['simulationFailure']>; expected: string; existingBase?: boolean }> = [
    ...(['missing-vectors', 'null-vectors', 'missing-fee', 'null-fee', 'missing-token-vectors', 'null-token-vectors', 'missing-loaded-addresses', 'null-loaded-addresses'] as const)
      .map(failure => ({ failure, expected: 'PUMP_SIMULATION_BALANCES_UNAVAILABLE' })),
    ...(['native-vector-length', 'native-negative', 'native-fractional', 'native-unsafe', 'fee-negative', 'fee-fractional', 'fee-unsafe', 'loaded-addresses-nonempty'] as const)
      .map(failure => ({ failure, expected: 'PUMP_SIMULATION_DELTA_MISMATCH' })),
    ...(['duplicate-token', 'token-out-of-range', 'token-wrong-mint', 'token-wrong-owner', 'token-wrong-program', 'token-wrong-decimals', 'token-wrong-amount', 'improper-new-base-pre', 'returned-lamport-mismatch', 'base-lamport-mismatch', 'pre-wsol', 'post-wsol', 'quote-returned', 'quote-tombstone-funded', 'quote-tombstone-nonsystem', 'quote-tombstone-data', 'quote-tombstone-executable', 'payer-wrong-owner', 'payer-executable', 'base-wrong-owner', 'base-wrong-mint', 'base-wrong-state', 'base-executable', 'payer-delta', 'base-delta', 'event-spend', 'negative-setup', 'underfunded-setup', 'wrong-event', 'duplicate-event', 'wrong-log-scope'] as const)
      .map(failure => ({ failure, expected: 'PUMP_SIMULATION_DELTA_MISMATCH' })),
    { failure: 'missing-existing-base-pre', expected: 'PUMP_SIMULATION_DELTA_MISMATCH', existingBase: true },
    { failure: 'existing-base-changed', expected: 'PUMP_SIMULATION_DELTA_MISMATCH', existingBase: true },
    { failure: 'wrong-slot', expected: 'PUMP_SIMULATION_STATE_CHANGED' },
    { failure: 'simulation-error', expected: 'PUMP_SIMULATION_REJECTED' },
  ];
  for (const { failure, expected, existingBase } of cases) {
    await t.test(failure, async () => {
      const f = await fixture({ simulate: true, simulationFailure: failure, ...(existingBase ? { existingBaseOwners: [PAYER] } : {}) });
      const holders: HolderFacts = {
        supplyAtomic: PAYLOAD_MINT_SUPPLY.toString(), slot: SLOT, complete: false, evidenceIds: ['holders'],
        accounts: [{ address: 'candidate-token-account', owner: f.payer.toBase58(), amount: '1' }],
      };
      const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, holders, SLOT, 'https://rpc.example', f.fetcher, () => AT);
      assert.equal(read.inspection.bindingVerified, true);
      assert.equal(read.inspection.errors.simulation, expected);
      assert.equal(read.inspection.errors.execution, 'PUMP_TRANSACTION_COSTS_UNAVAILABLE');
      assert.equal(read.venue?.costsReconciled, false);
      assert.equal(read.venue?.simulation, undefined);
      assert.ok(read.rawArtifacts['pump-roundtrip-simulation'], 'the complete provider response remains available when semantic proof fails');
      assert.equal(f.methods.filter(call => call.method === 'simulateTransaction').length, 1, 'semantic mismatches are not retried');
      assert.equal(f.methods.filter(call => call.method === 'getFeeForMessage').length, 2, 'only independent entry and exit fees are requested');
      assert.ok(read.venue, 'direct binding and quote facts survive rejected simulation');
    });
  }
});

test('USD conversion failure preserves direct venue and liquidity observations without manufacturing quotes', async () => {
  const f = await fixture({ failDex: true });
  const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, undefined, SLOT, 'https://rpc.example', f.fetcher, () => AT);
  assert.equal(read.inspection.bindingVerified, true);
  assert.equal(read.inspection.removableLiquidityFraction, '0.25');
  assert.equal(read.inspection.errors.execution, 'PUMP_USD_PRICE_UNAVAILABLE');
  assert.equal(read.venue, undefined);
  assert.equal(read.rawArtifacts['pump-quote-calculation'], undefined);
});

test('PumpSwap recovers native USD before coherent capture and binds quote math to the selected receipt', async () => {
  const f = await fixture({ failDex: true });
  const events: string[] = [];
  const recovery = pumpUsdRecoveryFetcher(f.fetcher, events);
  let clockCalls = 0;
  const now = () => new Date(Date.parse(AT) + clockCalls++ * 1000).toISOString();
  const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, undefined, SLOT, 'https://rpc.example', recovery.fetcher, now, undefined, { tinyfishKey: TINYFISH_KEY });
  const requestedUrl = `https://api.dexscreener.com/token-pairs/v1/solana/${NATIVE_MINT.toBase58()}`;

  assert.deepEqual(events.slice(0, 4), ['pool-discovery', 'dexscreener', 'tinyfish-fetch', 'state-capture'],
    'the slower USD fallback completes after canonical pool discovery and before the coherent eight-account capture');
  assert.equal(recovery.fetchCalls.length, 1);
  const fetchCall = recovery.fetchCalls[0]!;
  assert.equal((fetchCall.init?.headers as Record<string, string>)['X-API-Key'], TINYFISH_KEY);
  assert.deepEqual(JSON.parse(String(fetchCall.init?.body)), {
    urls: [requestedUrl], format: 'html', ttl: 0, per_url_timeout_ms: 8000, include_etag_and_last_modified: true,
  });
  const evidence = read.marketEvidence;
  assert.ok(evidence);
  assert.equal(evidence['pump-sol-usd']?.sourceId, 'tinyfish-fetch');
  assert.equal(evidence['pump-sol-usd']?.sourceType, 'MARKET_API_WITH_FETCH');
  assert.equal(evidence['pump-sol-usd']?.accessMode, 'FREE_ACCOUNT');
  assert.equal(evidence['pump-sol-usd']?.scope.method, 'tinyfish-live-dex-json-v1');
  assert.equal(evidence['pump-sol-usd-fetch-request']?.sourceId, 'shared-collector');
  assert.equal(evidence['pump-sol-usd-fetch-response']?.sourceId, 'tinyfish-fetch');
  assert.equal(evidence['pump-sol-usd-fetch-response']?.raw, JSON.stringify({
    results: [{ url: requestedUrl, final_url: requestedUrl, format: 'html', text: recovery.pairText }], errors: [],
  }));
  const selection = JSON.parse(evidence['pump-sol-usd-fetch-selection']!.raw) as { selected: boolean; primaryCode: string; parents: string[] };
  assert.equal(selection.selected, true);
  assert.equal(selection.primaryCode, 'DEX_HTTP_503');
  assert.deepEqual(selection.parents, ['pump-sol-usd-fetch-request', 'pump-sol-usd-fetch-response']);
  assert.equal(read.rawArtifacts['pump-sol-usd'], recovery.pairText);
  assert.ok(Date.parse(read.retrievedAt['pump-sol-usd']!) < Date.parse(read.retrievedAt['pump-mints-vaults']!));

  const quote = JSON.parse(read.rawArtifacts['pump-quote-calculation']!) as {
    nativeUsd: string; nativePriceEvidenceId: string; requestedUsd: string; quoteAtomic: string;
    actualEntryAtomic: string; acquiredAtomic: string; exitAtomic: string; method: string; slot: number;
  };
  assert.equal(quote.nativeUsd, '160');
  assert.equal(quote.nativePriceEvidenceId, 'pump-sol-usd');
  assert.equal(quote.requestedUsd, '25');
  assert.equal(quote.quoteAtomic, '156250000');
  assert.equal(quote.method, 'INDEPENDENT_QUOTES');
  assert.equal(quote.slot, SLOT + 2);
  assert.ok(BigInt(quote.actualEntryAtomic) > 0n);
  assert.ok(BigInt(quote.acquiredAtomic) > 0n);
  assert.ok(BigInt(quote.exitAtomic) > 0n);
  assert.ok(read.venue, 'the selected fresh price supports an independent quote even when public simulation payer context is unavailable');
  assert.equal(read.venue.availableAt, read.retrievedAt['pump-mints-vaults']);
  assert.equal(read.venue.evidenceIds.includes('pump-sol-usd'), true);
  assert.equal(read.venue.expiresAt, new Date(Date.parse(read.retrievedAt['pump-sol-usd']!) + 30_000).toISOString());
  assert.equal(JSON.stringify(read).includes(TINYFISH_KEY), false);
});

test('PumpSwap USD freshness uses an inclusive 30-second age and rejects a later capture', async () => {
  for (const ageMs of [30_000, 30_001]) {
    const f = await fixture({ failDex: true });
    const events: string[] = [];
    const recovery = pumpUsdRecoveryFetcher(f.fetcher, events);
    let clockCalls = 0;
    const now = () => {
      const index = clockCalls++;
      return new Date(Date.parse(AT) + (index < 4 ? 0 : ageMs)).toISOString();
    };
    const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, undefined, SLOT, 'https://rpc.example', recovery.fetcher, now, undefined, { tinyfishKey: TINYFISH_KEY });
    assert.equal(read.retrievedAt['pump-sol-usd'], AT, `USD read time at age ${ageMs}`);
    assert.equal(read.retrievedAt['pump-mints-vaults'], new Date(Date.parse(AT) + ageMs).toISOString(), `capture time at age ${ageMs}`);
    assert.equal(read.inspection.bindingVerified, true, `canonical binding remains available at age ${ageMs}`);
    assert.equal(read.inspection.removableLiquidityFraction, '0.25', `LP facts remain available at age ${ageMs}`);
    if (ageMs === 30_000) {
      assert.ok(read.venue, 'the exact freshness boundary remains usable');
      assert.equal(read.venue.expiresAt, new Date(Date.parse(AT) + 30_000).toISOString());
    } else {
      assert.equal(read.inspection.errors.execution, 'PUMP_USD_PRICE_STALE');
      assert.equal(read.venue, undefined, 'a stale price cannot create an executable quote');
      assert.equal(read.rawArtifacts['pump-quote-calculation'], undefined);
    }
  }
});

test('failed PumpSwap USD recovery retains request failure and LP facts without fabricating a selected price', async () => {
  const f = await fixture({ failDex: true });
  const events: string[] = [];
  const recovery = pumpUsdRecoveryFetcher(f.fetcher, events, 503);
  const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, undefined, SLOT, 'https://rpc.example', recovery.fetcher, () => AT, undefined, { tinyfishKey: TINYFISH_KEY });

  assert.equal(read.inspection.bindingVerified, true);
  assert.equal(read.inspection.removableLiquidityFraction, '0.25');
  assert.equal(read.inspection.errors.execution, 'PUMP_USD_PRICE_UNAVAILABLE');
  assert.equal(read.venue, undefined);
  assert.equal(read.rawArtifacts['pump-quote-calculation'], undefined);
  assert.ok(read.marketEvidence?.['pump-sol-usd-fetch-request']);
  assert.ok(read.marketEvidence?.['pump-sol-usd-fetch-selection']);
  assert.equal(read.marketEvidence?.['pump-sol-usd-fetch-response'], undefined, 'an HTTP failure has no successful response body artifact');
  assert.equal(read.marketEvidence?.['pump-sol-usd'], undefined, 'a failed fallback never creates a selected market artifact');
  assert.equal(read.rawArtifacts['pump-sol-usd'], undefined);
  const selection = JSON.parse(read.marketEvidence!['pump-sol-usd-fetch-selection']!.raw) as { selected: boolean; code: string };
  assert.equal(selection.selected, false);
  assert.equal(selection.code, 'DEX_FETCH_HTTP_503');
});

test('holder-supplied payer candidates are bounded to observed owners and never imply user identity', async () => {
  const holders: HolderFacts = {
    supplyAtomic: PAYLOAD_MINT_SUPPLY.toString(), slot: SLOT, complete: false, evidenceIds: ['holders'],
    accounts: Array.from({ length: 6 }, (_, index) => ({ address: `token-account-${index}`, owner: new PublicKey(Buffer.alloc(32, index + 1)).toBase58(), amount: '1' })),
  };
  const f = await fixture();
  const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, holders, SLOT, 'https://rpc.example', f.fetcher, () => AT);
  assert.equal(read.inspection.bindingVerified, true);
  const payerQuery = f.methods.find(call => call.method === 'getMultipleAccounts' && (call.params[0] as string[]).length === 5);
  assert.ok(payerQuery, 'at most five candidate system-owner accounts are checked');
  assert.equal(read.inspection.errors.simulation, 'PUMP_SIMULATION_PAYER_UNAVAILABLE');
  assert.equal(read.venue?.simulation, undefined);
  assert.equal(read.venue?.costsReconciled, false);
});
