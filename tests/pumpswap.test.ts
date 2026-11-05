import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import BN from 'bn.js';
import { Decimal } from 'decimal.js';
import { MessageV0, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, MintLayout, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  GLOBAL_CONFIG_PDA, OFFLINE_PUMP_AMM_PROGRAM, PUMP_AMM_PROGRAM_ID, PUMP_AMM_FEE_CONFIG_PDA,
  FEE_CONFIG_SIZE_PRE_STABLE, PUMP_FEE_PROGRAM_ID, buyBaseInput, buyQuoteInput, lpMintPda, poolPda,
  pumpPoolAuthorityPda, sellBaseInput,
} from '@pump-fun/pump-swap-sdk';
import { starterProfile } from '../src/app/config.js';
import { deriveBaseline, type ControlFacts, type HolderFacts } from '../src/domain/baseline.js';
import { Service } from '../src/app/service.js';
import type { AssessmentDetails, LiveBundle, TokenRef } from '../src/domain/contracts.js';
import { TOKEN_2022_PROGRAM, UPGRADEABLE_LOADER } from '../src/providers/solana.js';
import { inspectPumpSwap, validatePumpRecoveryBundle, verifyPumpSlippage } from '../src/providers/pumpswap.js';
import { entryGroupsForBundle } from '../src/providers/entry-groups.js';

const MINT = '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump';
const TOKEN: TokenRef = { chain: 'solana', address: MINT };
const AT = '2026-09-30T16:00:00.000Z';
const SLOT = 500;
const TINYFISH_KEY = 'pump-tinyfish-test-secret';
const PROGRAM_DATA = new PublicKey(Buffer.alloc(32, 8));
const PAYER = new PublicKey(Buffer.alloc(32, 23));
const FULL_PROTOCOL_FEE_RECIPIENT = new PublicKey(Buffer.alloc(32, 240));
const FULL_BUYBACK_FEE_RECIPIENT = new PublicKey(Buffer.alloc(32, 241));
const fullSimulationRecipients = {
  protocolFeeRecipients: [FULL_PROTOCOL_FEE_RECIPIENT, ...Array(7).fill(PublicKey.default)],
  buybackFeeRecipients: [FULL_BUYBACK_FEE_RECIPIENT, ...Array(7).fill(PublicKey.default)],
};
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
  buybackFeeRecipients?: PublicKey[];
  globalAdmin?: PublicKey;
  discoveryProtocolFeeRecipients?: PublicKey[];
  discoveryGlobalAdmin?: PublicKey;
  payerLamports?: number;
  payerSystem?: boolean;
  additionalFundedPayers?: PublicKey[];
  additionalPayerLamports?: number;
  existingWsolOwners?: PublicKey[];
  validNativeWsolOwners?: PublicKey[];
  nativeWsolAmount?: bigint;
  nativeWsolRentReserve?: bigint;
  nativeWsolLamports?: number;
  nativeWsolAccountFailure?: 'malformed' | 'wrong-program' | 'wrong-mint' | 'wrong-owner' | 'frozen' | 'delegated' | 'close-authority' | 'non-native';
  existingBaseOwners?: PublicKey[];
  simulationPayer?: PublicKey;
  preSimulationPayerLamports?: number;
  simulationFeeLamports?: number;
  simulationSetupLamports?: number;
  simulationQuoteAccount?: 'null' | 'closed-tombstone';
  feeResponses?: unknown[];
  feeErrors?: Array<{ code: number; message: string } | undefined>;
  blockhashes?: string[];
  slippageSlot?: number;
  retryCaptureSlot?: number;
  simulationFailure?:
    | 'payer-delta' | 'base-delta' | 'existing-base-changed' | 'wrong-slot' | 'event-spend' | 'slippage' | 'slippage-persistent' | 'slippage-wrong-program'
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
function nativeTokenAccountBytes(
  mint: PublicKey,
  owner: PublicKey,
  amount: bigint,
  rentReserve: bigint,
  failure?: NonNullable<Scenario['nativeWsolAccountFailure']>,
): Buffer {
  const actualMint = failure === 'wrong-mint' ? new PublicKey(USDC) : mint;
  const actualOwner = failure === 'wrong-owner' ? new PublicKey(Buffer.alloc(32, 25)) : owner;
  const data = tokenAccountBytes(actualMint, actualOwner, amount);
  if (failure === 'frozen') data[108] = 2;
  if (failure === 'delegated') {
    data.writeUInt32LE(1, 72);
    new PublicKey(Buffer.alloc(32, 26)).toBuffer().copy(data, 76);
    data.writeBigUInt64LE(1n, 121);
  }
  if (failure === 'close-authority') {
    data.writeUInt32LE(1, 129);
    new PublicKey(Buffer.alloc(32, 27)).toBuffer().copy(data, 133);
  }
  if (failure !== 'non-native') {
    data.writeUInt32LE(1, 109);
    data.writeBigUInt64LE(rentReserve, 113);
  }
  return failure === 'malformed' ? data.subarray(0, 164) : data;
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
  const buybackFeeRecipients = scenario.buybackFeeRecipients ?? Array(8).fill(PublicKey.default);
  const discoveryGlobalAdmin = scenario.discoveryGlobalAdmin ?? globalAdmin;
  const discoveryProtocolFeeRecipients = scenario.discoveryProtocolFeeRecipients ?? protocolFeeRecipients;
  const globalConfig = await sdkAccount('globalConfig', {
    admin: globalAdmin, lpFeeBasisPoints: new BN(100), protocolFeeBasisPoints: new BN(50),
    disableFlags: scenario.captureDisableFlags ?? scenario.disableFlags ?? 0, protocolFeeRecipients,
    coinCreatorFeeBasisPoints: new BN(25), adminSetCoinCreatorAuthority: PublicKey.default,
    whitelistPda: PublicKey.default, reservedFeeRecipient: PublicKey.default, mayhemModeEnabled: false,
    reservedFeeRecipients: Array(7).fill(PublicKey.default), isCashbackEnabled: false,
    buybackFeeRecipients, buybackBasisPoints: new BN(0),
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
  let captureCount = 0;
  let simulationCount = 0;
  let dexCalls = 0;
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
  const additionalPayerLamports = scenario.additionalPayerLamports ?? payerLamports;
  const preSimulationPayerLamports = scenario.preSimulationPayerLamports ?? (simulationPayer.equals(PAYER) ? payerLamports : additionalPayerLamports);
  const simulationFeeLamports = scenario.simulationFeeLamports ?? networkFeeLamports;
  const hasExistingBase = new Set((scenario.existingBaseOwners ?? []).map(key => key.toBase58())).has(simulationPayer.toBase58());
  let simulationSetupLamports = scenario.simulationSetupLamports ?? (hasExistingBase ? 0 : rentLamports);
  if (scenario.simulationFailure === 'negative-setup') simulationSetupLamports = -1;
  if (scenario.simulationFailure === 'underfunded-setup') simulationSetupLamports = rentLamports - 1;
  const validNativeWsolOwners = new Set((scenario.validNativeWsolOwners ?? []).map(key => key.toBase58()));
  const hasExistingNativeWsol = validNativeWsolOwners.has(simulationPayer.toBase58());
  const nativeWsolAmount = scenario.nativeWsolAmount ?? 1n;
  const nativeWsolRentReserve = scenario.nativeWsolRentReserve ?? BigInt(rentLamports);
  const nativeWsolLamports = scenario.nativeWsolLamports ?? Number(nativeWsolRentReserve + nativeWsolAmount);
  const preNativeWsolLamports = hasExistingNativeWsol ? nativeWsolLamports : 0;
  let afterPayerLamports = preSimulationPayerLamports - Number(actualSpend) + Number(actualReceive) - simulationFeeLamports - simulationSetupLamports + preNativeWsolLamports;
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
      dexCalls++;
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
      const options = request.params[1] as { minContextSlot?: number } | undefined;
      const discovery = keys.length === 3 && keys[0] === poolKey.toBase58();
      const capture = keys.length === 8 && keys[0] === poolKey.toBase58();
      const captureIndex = capture ? captureCount++ : -1;
      const map = discovery ? poolAccounts : capture ? capturedAccounts : undefined;
      let contextSlot = discovery ? scenario.discoverySlot ?? SLOT + 1 : capture ? captureIndex === 0
        ? scenario.captureSlot ?? SLOT + 2 : scenario.retryCaptureSlot ?? SLOT + 12
        : Math.max(SLOT + 1, scenario.captureSlot ?? SLOT + 2);
      contextSlot = Math.max(contextSlot, options?.minContextSlot ?? 0);
      if (capture && scenario.malformedCaptureSlot) contextSlot = (scenario.discoverySlot ?? SLOT + 1) - 1;
      return rpcResult({ context: { slot: contextSlot }, value: keys.map(key => {
        if (scenario.simulate && fundedPayerAddresses.has(key)) {
          return rpcAccount(key === PAYER.toBase58() && scenario.payerSystem === false ? TOKEN_PROGRAM_ID : PublicKey.default,
            Buffer.alloc(0), { lamports: key === PAYER.toBase58() ? payerLamports : scenario.additionalPayerLamports ?? payerLamports });
        }
        const associatedAccount = scenario.simulate ? associated.get(key) : undefined;
        if (associatedAccount) {
          const ownerAddress = associatedAccount.owner.toBase58();
          const existing = associatedAccount.kind === 'quote'
            ? existingWsolOwners.has(ownerAddress) || validNativeWsolOwners.has(ownerAddress)
            : existingBaseOwners.has(associatedAccount.owner.toBase58());
          if (!existing) return null;
          if (associatedAccount.kind === 'quote' && validNativeWsolOwners.has(ownerAddress)) {
            return rpcAccount(scenario.nativeWsolAccountFailure === 'wrong-program' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM_ID, nativeTokenAccountBytes(
              associatedAccount.mint, associatedAccount.owner, nativeWsolAmount, nativeWsolRentReserve,
              scenario.nativeWsolAccountFailure,
            ), { lamports: nativeWsolLamports });
          }
          return rpcAccount(TOKEN_PROGRAM_ID, tokenAccountBytes(associatedAccount.mint, associatedAccount.owner, 1n));
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
      context: { slot: Math.max(SLOT + methods.length, (request.params[1] as { minContextSlot?: number } | undefined)?.minContextSlot ?? 0) }, value: rpcAccount(UPGRADEABLE_LOADER, header, { executable: true }),
    });
    if (request.method === 'getAccountInfo' && request.params[0] === PROGRAM_DATA.toBase58()) return rpcResult({
      context: { slot: Math.max(SLOT + methods.length, (request.params[1] as { minContextSlot?: number } | undefined)?.minContextSlot ?? 0) }, value: rpcAccount(UPGRADEABLE_LOADER, programData),
    });
    if (request.method === 'getLatestBlockhash') {
      const index = blockhashIndex++;
      const blockhash = scenario.blockhashes?.[index] ?? new PublicKey(Buffer.alloc(32, 44 + index)).toBase58();
      const floor = (request.params[0] as { minContextSlot?: number } | undefined)?.minContextSlot ?? 0;
      return rpcResult({ context: { slot: Math.max(SLOT + 3 + index, floor) }, value: { blockhash, lastValidBlockHeight: 10_000 + index } });
    }
    if (request.method === 'getFeeForMessage') {
      const index = feeResponseIndex++;
      const error = scenario.feeErrors?.[index];
      if (error) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error }), { headers: { 'content-type': 'application/json' } });
      const value = scenario.feeResponses ? scenario.feeResponses[index] : networkFeeLamports;
      const floor = (request.params[1] as { minContextSlot?: number } | undefined)?.minContextSlot ?? 0;
      return rpcResult({ context: { slot: Math.max(SLOT + 1, floor) }, value });
    }
    if (request.method === 'getMinimumBalanceForRentExemption') return rpcResult(rentLamports);
    if (request.method === 'simulateTransaction' && scenario.simulate) {
      const simulationIndex = simulationCount++;
      const persistentSlippage = scenario.simulationFailure === 'slippage-persistent';
      const refreshFailure = scenario.simulationFailure === 'slippage' || scenario.simulationFailure === 'slippage-wrong-program' || persistentSlippage;
      const failure = refreshFailure && simulationIndex > 0 && !persistentSlippage ? undefined : scenario.simulationFailure;
      const params = request.params as [string, { accounts?: { addresses?: unknown[] }; minContextSlot?: number }];
      const transaction = VersionedTransaction.deserialize(Buffer.from(params[0]!, 'base64'));
      const staticKeys = transaction.message.staticAccountKeys.map(key => key.toBase58());
      const [payerOutput, baseOutput, quoteOutput] = params[1]?.accounts?.addresses ?? [];
      const payerIndex = staticKeys.indexOf(simulationPayer.toBase58());
      const baseIndex = staticKeys.indexOf(baseAta.toBase58());
      const quoteIndex = staticKeys.indexOf(quoteAta.toBase58());
      if (payerIndex !== 0 || baseIndex < 0 || quoteIndex < 0 || payerOutput !== simulationPayer.toBase58() || baseOutput !== baseAta.toBase58() || quoteOutput !== quoteAta.toBase58()) {
        throw new Error('FIXTURE_SIMULATION_REQUEST_DOES_NOT_MATCH_COMPILED_MESSAGE');
      }
      if (refreshFailure && (simulationIndex === 0 || persistentSlippage)) {
        const buyDiscriminator = Buffer.from(OFFLINE_PUMP_AMM_PROGRAM.idl.instructions.find(instruction => instruction.name === 'buy')!.discriminator);
        const instructionIndex = transaction.message.compiledInstructions.findIndex(instruction =>
          staticKeys[instruction.programIdIndex] === PUMP_AMM_PROGRAM_ID.toBase58()
          && Buffer.from(instruction.data).subarray(0, buyDiscriminator.length).equals(buyDiscriminator));
        assert.notEqual(instructionIndex, -1, 'slippage fixture points to the actual Pump buy instruction in the compiled transaction');
        const program = scenario.simulationFailure === 'slippage-wrong-program' ? PUMP_AMM_FEE_CONFIG_PDA : PUMP_AMM_PROGRAM_ID;
        const contextSlot = Math.max(scenario.slippageSlot ?? SLOT + 10, params[1]?.minContextSlot ?? SLOT + 2);
        return rpcResult({ context: { slot: contextSlot }, value: {
          err: { InstructionError: [instructionIndex, { Custom: 6004 }] },
          logs: [
            `Program ${program.toBase58()} invoke [1]`,
            'Program log: Error Code: ExceededSlippage. Error Number: 6004.',
            `Program ${program.toBase58()} failed: custom program error: 0x1774`,
          ],
        } });
      }

      const preBalances = Array<number>(staticKeys.length).fill(0);
      const postBalances = [...preBalances];
      const baseBeforeLamports = hasExistingBase ? rentLamports : 0;
      const baseAfterLamports = rentLamports;
      preBalances[payerIndex] = preSimulationPayerLamports;
      postBalances[payerIndex] = afterPayerLamports;
      preBalances[baseIndex] = baseBeforeLamports;
      postBalances[baseIndex] = baseAfterLamports;
      if (hasExistingNativeWsol) preBalances[quoteIndex] = preNativeWsolLamports;
      if (failure === 'pre-wsol') preBalances[quoteIndex] = 1;
      if (failure === 'post-wsol') postBalances[quoteIndex] = 1;

      const tokenRecord = (accountIndex: number, amount: bigint, overrides: { mint?: string; owner?: string; programId?: string; decimals?: number } = {}) => ({
        accountIndex, mint: overrides.mint ?? MINT, owner: overrides.owner ?? simulationPayer.toBase58(),
        programId: overrides.programId ?? TOKEN_PROGRAM_ID.toBase58(),
        uiTokenAmount: { amount: amount.toString(), decimals: overrides.decimals ?? 6, uiAmount: null, uiAmountString: '0' },
      });
      let preTokenBalances: unknown[] = hasExistingBase ? [tokenRecord(baseIndex, baseAmountBefore)] : [];
      let postTokenBalances: unknown[] = [tokenRecord(baseIndex, baseAmountAfter)];
      if (hasExistingNativeWsol) preTokenBalances.push(tokenRecord(quoteIndex, nativeWsolAmount, { mint: NATIVE_MINT.toBase58(), decimals: 9 }));
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
      const contextSlot = failure === 'wrong-slot' ? Math.max(0, captureSlot - 1) : Math.max(captureSlot, params[1]?.minContextSlot ?? captureSlot);
      return rpcResult({ context: { slot: contextSlot }, value: simValue });
    }
    throw new Error(`UNEXPECTED_MOCK_RPC_${request.method}`);
  };
  return { fetcher, methods, poolKey, baseVault, quoteVault, lpMint, payer: PAYER, expectedBaseAtomic: expectedBuy.base.toString(), baseAta, quoteAta,
    get nativeWsolLamports() { return nativeWsolLamports; }, get nativeWsolAmount() { return nativeWsolAmount; },
    get simulationSetupLamports() { return simulationSetupLamports; },
    get captureCount() { return captureCount; }, get dexCalls() { return dexCalls; } };
}

const controls: ControlFacts = {
  complete: true, supplyAllowed: true, transferAllowed: true, surfaceSupported: true,
  currentFeeBps: '0', feeImmutable: true, controls: [], unsupported: [], evidenceIds: ['rpc-mint-raw'],
};

function pumpLiveBundle(read: Awaited<ReturnType<typeof inspectPumpSwap>>, profile: ReturnType<typeof starterProfile>): LiveBundle {
  assert.ok(read.venue, 'a simulation result supplies a venue for Service admission');
  const baseline = deriveBaseline({
    token: TOKEN, cutoff: AT, profile, features: [], evidence: [], observations: [],
    venueInspection: read.inspection, venue: read.venue,
  });
  const rawArtifacts = structuredClone(read.rawArtifacts);
  const derivedIds = new Set(['pump-simulation-request', 'pump-quote-calculation']);
  const evidence: LiveBundle['evidence'] = Object.entries(rawArtifacts).map(([id, raw]) => {
    const derived = derivedIds.has(id), market = id === 'pump-sol-usd';
    const retrievedAt = read.retrievedAt[id]!;
    return {
      id, sourceId: derived ? 'pumpswap-derived' : market ? 'dexscreener' : 'pumpswap-direct',
      sourceType: derived ? 'CALCULATION' : market ? 'PUBLIC_MARKET' : 'JSON_RPC',
      retrievedAt, availableAt: retrievedAt, contentHash: createHash('sha256').update(raw).digest('hex'),
      adapterVersion: 'pumpswap-test-v1', accessMode: derived ? 'LOCAL_DERIVED' : 'PUBLIC_API',
      scope: { operation: id, mint: TOKEN.address, pool: read.inspection.poolAddress },
    };
  });
  return {
    analysisKind: 'LIVE', token: TOKEN, cutoff: AT, profile, evidence, rawArtifacts, observations: [],
    features: baseline.flatMap(row => row.projection ? [row.projection] : []),
    collection: { rpc: { state: 'OBSERVED' }, dex: { state: 'NO_RESULTS', count: 0 }, web: { state: 'NOT_REQUESTED' } },
    semantic: { status: 'NOT_REQUESTED', claims: [] }, market: null,
    details: { version: 1, profile, thesis: null, baseline, origins: {}, stageInputs: { circulatingMarketCapUsd: null, tokenCreatedAt: null } },
  };
}

function rehashPumpBundle(bundle: LiveBundle): void {
  for (const record of bundle.evidence) {
    const raw = bundle.rawArtifacts[record.id];
    if (raw !== undefined) record.contentHash = createHash('sha256').update(raw).digest('hex');
  }
}

function pumpProof(bundle: LiveBundle) {
  const calculation = JSON.parse(bundle.rawArtifacts['pump-quote-calculation']!) as {
    simulationProof: {
      wireBase64: string;
      quoteIndex: number;
      setupLamports: string;
      initialQuoteRefundLamports?: string;
      existingWsol?: { method: string; user: string; sourceId: string; sourceIndex: number };
    };
  };
  return calculation.simulationProof;
}

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
    'rpc-genesis', 'pump-pool-config', 'pump-mints-vaults', 'pump-program', 'pump-program-data', 'pump-sol-usd', 'pump-simulation-payers', 'pump-simulation-fallback-payers', 'pump-quote-calculation',
  ]);
  assert.deepEqual(Object.keys(read.retrievedAt).sort(), Object.keys(read.rawArtifacts).sort());
  assert.ok(Object.values(read.retrievedAt).every(at => at === AT));
  assert.equal(f.methods.some(call => call.method.toLowerCase().includes('sendtransaction')), false);
  assert.equal(f.methods.some(call => call.method === 'simulateTransaction'), false, 'unsigned simulation was correctly withheld when no public payer was available');
});

test('current holder groups exclude only the captured canonical PumpSwap base vault', async () => {
  const profile = starterProfile();
  const f = await fixture();
  const read = await inspectPumpSwap(TOKEN, profile, controls, undefined, SLOT, 'https://rpc.example', f.fetcher, () => AT);
  const bundle = pumpLiveBundle(read, profile);
  assert.equal(bundle.details!.baseline.find(row => row.id === 'O08')?.quality, 'KNOWN');

  const addRaw = (id: string, raw: string) => {
    bundle.rawArtifacts[id] = raw;
    bundle.evidence.push({
      id, sourceId: 'solana-rpc', sourceType: 'JSON_RPC', retrievedAt: AT, availableAt: AT,
      contentHash: createHash('sha256').update(raw).digest('hex'), adapterVersion: 'entry-groups-pump-test-v1',
      accessMode: 'PUBLIC_API', scope: { method: 'sanitized-pump-provider-fixture', mint: TOKEN.address },
    });
  };
  addRaw('rpc-genesis', JSON.stringify({ result: 'solana-mainnet-genesis-fixture' }));
  addRaw('rpc-mint-raw', JSON.stringify({ result: { context: { slot: SLOT }, value: rpcAccount(TOKEN_PROGRAM_ID, mintBytes({ supply: PAYLOAD_MINT_SUPPLY, decimals: 6 })) } }));
  const population = [
    { address: f.baseVault.toBase58(), owner: f.poolKey.toBase58(), amount: 700_000_000_000n },
    ...[0, 1, 2].map(index => ({
      address: new PublicKey(Buffer.alloc(32, 50 + index)).toBase58(),
      owner: new PublicKey(Buffer.alloc(32, 60 + index)).toBase58(), amount: 100_000_000_000n,
    })),
  ];
  addRaw('rpc-holder-population', JSON.stringify({ result: {
    context: { slot: SLOT + 2 },
    value: population.map(account => ({
      pubkey: account.address,
      account: rpcAccount(TOKEN_PROGRAM_ID, tokenAccountBytes(new PublicKey(TOKEN.address), new PublicKey(account.owner), account.amount)),
    })),
  } }));

  const providerInput = { ...bundle, details: { baseline: bundle.details!.baseline, social: bundle.details!.social } };
  const groups = entryGroupsForBundle(providerInput);
  const owners = groups.groups.find(group => group.checkId === 'ADV-01')!;
  assert.equal(owners.status, 'PASS', `the exact captured liquidity vault is not treated as a wallet owner cluster: ${JSON.stringify(owners)}`);
  assert.equal(owners.metrics.protocolVaultSupplyFraction, '0.7');
  assert.equal(owners.metrics.largestOwnerSupplyFraction, '0.1');
  assert.deepEqual(owners.metrics.excludedVaults, [f.baseVault.toBase58()]);
  assert.ok(owners.evidenceIds.includes('pump-mints-vaults'));

  const damaged = structuredClone(bundle);
  const capture = JSON.parse(damaged.rawArtifacts['pump-mints-vaults']!) as { result: { value: Array<Record<string, unknown>> } };
  const vault = capture.result.value[5] as { data: [string, string] };
  const vaultBytes = Buffer.from(vault.data[0], 'base64');
  new PublicKey(Buffer.alloc(32, 99)).toBuffer().copy(vaultBytes, 32);
  vault.data[0] = vaultBytes.toString('base64');
  damaged.rawArtifacts['pump-mints-vaults'] = JSON.stringify(capture);
  const rejected = entryGroupsForBundle({ ...damaged, details: { baseline: damaged.details!.baseline, social: damaged.details!.social } })
    .groups.find(group => group.checkId === 'ADV-01')!;
  assert.equal(rejected.status, 'UNKNOWN', 'a damaged vault owner proof cannot promote or exclude pool inventory');
  assert.equal(rejected.code, 'GROUP_VAULT_PROOF_INVALID');
  assert.equal(Object.hasOwn(rejected.metrics, 'largestOwnerSupplyFraction'), false);

  const substituted = structuredClone(bundle);
  substituted.evidence.find(record => record.id === 'pump-mints-vaults')!.sourceId = 'solana-rpc';
  const sourceRejected = entryGroupsForBundle({ ...substituted, details: { baseline: substituted.details!.baseline, social: substituted.details!.social } })
    .groups.find(group => group.checkId === 'ADV-01')!;
  assert.equal(sourceRejected.status, 'UNKNOWN', 'changing the acquired vault artifact provenance cannot preserve the wallet-cluster exclusion');
  assert.equal(sourceRejected.code, 'GROUP_VAULT_PROOF_INVALID');
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
    && (call.params[0] as string[]).length === 2 && (call.params[0] as string[])[0] === f.payer.toBase58());
  assert.ok(holderPayerProbe, 'the observed holder and verified pool coin creator are checked before configured fallback accounts');
  assert.deepEqual(holderPayerProbe.params[0], [f.payer.toBase58(), new PublicKey(Buffer.alloc(32, 7)).toBase58()]);
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

test('a funded sixth observed holder can satisfy real ATA and fee simulation after the first five are unfunded', async () => {
  const owners = Array.from({ length: 6 }, (_, index) => new PublicKey(Buffer.alloc(32, 80 + index)));
  const holders: HolderFacts = {
    supplyAtomic: PAYLOAD_MINT_SUPPLY.toString(), slot: SLOT, complete: false, evidenceIds: ['holders'],
    accounts: owners.map((owner, index) => ({
      address: `ordered-holder-token-account-${index + 1}`, owner: owner.toBase58(), amount: String(6 - index),
    })),
  };
  const sixth = owners[5]!;
  const f = await fixture({ simulate: true, additionalFundedPayers: [sixth], simulationPayer: sixth });
  const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, holders, SLOT, 'https://rpc.example', f.fetcher, () => AT);

  assert.equal(read.venue?.costsReconciled, true, 'the selected sixth holder completed quote, fee, and roundtrip proof');
  assert.deepEqual(read.venue?.simulation, { setupVerified: true, buySucceeded: true, sellSucceeded: true });
  assert.equal(read.inspection.errors.simulation, undefined);
  const candidateProbe = f.methods.find(call => call.method === 'getMultipleAccounts'
    && (call.params[0] as string[]).length === owners.length + 1
    && (call.params[0] as string[])[0] === owners[0]!.toBase58());
  assert.ok(candidateProbe, 'the bounded candidate batch includes the six ranked holders and verified pool coin creator');
  assert.deepEqual((candidateProbe.params[0] as string[]).slice(0, owners.length), owners.map(owner => owner.toBase58()));
  assert.equal((candidateProbe.params[0] as string[])[owners.length], new PublicKey(Buffer.alloc(32, 7)).toBase58());

  const ataProbe = f.methods.find(call => call.method === 'getMultipleAccounts'
    && (call.params[0] as string[]).length === 2
    && (call.params[0] as string[])[0] === getAssociatedTokenAddressSync(new PublicKey(MINT), sixth, true, TOKEN_PROGRAM_ID).toBase58());
  assert.ok(ataProbe, 'the selected funded owner’s base and WSOL ATAs are checked before building instructions');
  assert.deepEqual(ataProbe.params[0], [
    getAssociatedTokenAddressSync(new PublicKey(MINT), sixth, true, TOKEN_PROGRAM_ID).toBase58(),
    getAssociatedTokenAddressSync(NATIVE_MINT, sixth, true, TOKEN_PROGRAM_ID).toBase58(),
  ]);
  assert.equal(f.methods.filter(call => call.method === 'getFeeForMessage').length, 2,
    'both unsigned swap messages receive actual fee quotes');
  assert.equal(f.methods.some(call => call.method === 'simulateTransaction'), true,
    'the complete unsigned roundtrip is simulated with the selected payer and ATA vectors');
  assert.equal(f.methods.some(call => /sendtransaction/i.test(call.method)), false, 'the test never broadcasts a transaction');
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

test('full PumpSwap uses a clean existing native WSOL fallback and subtracts the initial close refund from setup', async () => {
  const holderOwners = Array.from({ length: 20 }, (_, index) => new PublicKey(Buffer.alloc(32, index + 80)));
  const fallbackOwners = Array.from({ length: 7 }, (_, index) => new PublicKey(Buffer.alloc(32, index + 110)));
  const user = fallbackOwners[0]!;
  const holders: HolderFacts = {
    supplyAtomic: PAYLOAD_MINT_SUPPLY.toString(), slot: SLOT, complete: false, evidenceIds: ['holders'],
    accounts: holderOwners.map((owner, index) => ({ address: `unfunded-holder-${index}`, owner: owner.toBase58(), amount: String(20 - index) })),
  };
  const f = await fixture({
    simulate: true, payerLamports: 1, additionalPayerLamports: 1_000_000_000, additionalFundedPayers: fallbackOwners,
    ...fullSimulationRecipients, protocolFeeRecipients: fallbackOwners, globalAdmin: PublicKey.default,
    buybackFeeRecipients: [FULL_BUYBACK_FEE_RECIPIENT, ...Array(7).fill(PublicKey.default)],
    validNativeWsolOwners: fallbackOwners, simulationPayer: user,
  });
  const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, holders, SLOT, 'https://rpc.example', f.fetcher, () => AT,
    undefined, undefined, undefined, true);

  assert.equal(read.inspection.errors.simulation, undefined);
  assert.equal(read.inspection.errors.execution, undefined);
  assert.equal(read.venue?.costsReconciled, true);
  assert.deepEqual(read.venue?.simulation, { setupVerified: true, buySucceeded: true, sellSucceeded: true });
  assert.ok(read.rawArtifacts['pump-simulation-payers'], 'the original holder and creator payer scan remains available');
  assert.ok(read.rawArtifacts['pump-simulation-fallback-payers'], 'the configured fallback scan remains available');
  assert.ok(read.rawArtifacts['pump-simulation-fallback-user-accounts'], 'the existing quote ATA came from its observed fallback account response');
  const calculation = JSON.parse(read.rawArtifacts['pump-quote-calculation']!) as {
    actualEntryAtomic: string; exitAtomic: string;
    simulationProof: { existingWsol: { method: string; user: string; sourceId: string; sourceIndex: number }; setupLamports: string; initialQuoteRefundLamports: string; feeLamports: string };
  };
  const proof = calculation.simulationProof;
  assert.deepEqual(proof.existingWsol, {
    method: 'existing-wsol-roundtrip-v1', user: user.toBase58(),
    sourceId: 'pump-simulation-fallback-user-accounts', sourceIndex: 1,
  });
  assert.equal(proof.initialQuoteRefundLamports, String(f.nativeWsolLamports));
  assert.equal(proof.setupLamports, String(f.simulationSetupLamports), 'the native-account rent refund is removed before setup cost is measured');

  const rawSimulation = JSON.parse(read.rawArtifacts['pump-roundtrip-simulation']!) as {
    result: { value: {
      fee: number; preBalances: number[]; postBalances: number[];
      preTokenBalances: Array<{ accountIndex: number; mint: string; owner: string; programId: string; uiTokenAmount: { amount: string; decimals: number } }>;
      postTokenBalances: Array<{ accountIndex: number }>;
    } };
  };
  const request = JSON.parse(read.rawArtifacts['pump-simulation-request']!) as {
    existingWsol: typeof proof.existingWsol; wireBase64: string;
  };
  assert.deepEqual(request.existingWsol, proof.existingWsol, 'the submitted unsigned simulation binds the same source account');
  const tx = VersionedTransaction.deserialize(Buffer.from(request.wireBase64, 'base64'));
  const staticKeys = tx.message.staticAccountKeys.map(key => key.toBase58());
  const quoteAta = getAssociatedTokenAddressSync(NATIVE_MINT, user, true, TOKEN_PROGRAM_ID).toBase58();
  const quoteIndex = staticKeys.indexOf(quoteAta);
  assert.ok(quoteIndex >= 0);
  assert.equal(rawSimulation.result.value.preBalances[quoteIndex], f.nativeWsolLamports, 'the pre-vector includes native reserve plus token amount');
  assert.equal(rawSimulation.result.value.postBalances[quoteIndex], 0, 'the SDK closed the quote ATA after the roundtrip');
  assert.deepEqual(rawSimulation.result.value.preTokenBalances.filter(row => row.accountIndex === quoteIndex).map(row => ({
    mint: row.mint, owner: row.owner, programId: row.programId, amount: row.uiTokenAmount.amount, decimals: row.uiTokenAmount.decimals,
  })), [{ mint: NATIVE_MINT.toBase58(), owner: user.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), amount: String(f.nativeWsolAmount), decimals: 9 }]);
  assert.equal(rawSimulation.result.value.postTokenBalances.some(row => row.accountIndex === quoteIndex), false);
  const formulaSetup = BigInt(rawSimulation.result.value.preBalances[0]!)
    - BigInt(rawSimulation.result.value.postBalances[0]!)
    - BigInt(calculation.actualEntryAtomic)
    + BigInt(calculation.exitAtomic)
    - BigInt(rawSimulation.result.value.fee)
    + BigInt(rawSimulation.result.value.preBalances[quoteIndex]!);
  assert.equal(proof.setupLamports, formulaSetup.toString(), 'adding the preexisting quote balance cancels the buy-close refund');

  const instructions = tx.message.compiledInstructions;
  const keyAt = (index: number) => staticKeys[index]!;
  const buyDiscriminator = Buffer.from(OFFLINE_PUMP_AMM_PROGRAM.idl.instructions.find(ix => ix.name === 'buy')!.discriminator);
  const sellDiscriminator = Buffer.from(OFFLINE_PUMP_AMM_PROGRAM.idl.instructions.find(ix => ix.name === 'sell')!.discriminator);
  const buys = instructions.flatMap((ix, index) => keyAt(ix.programIdIndex) === PUMP_AMM_PROGRAM_ID.toBase58()
    && Buffer.from(ix.data).subarray(0, 8).equals(buyDiscriminator) ? [index] : []);
  const sells = instructions.flatMap((ix, index) => keyAt(ix.programIdIndex) === PUMP_AMM_PROGRAM_ID.toBase58()
    && Buffer.from(ix.data).subarray(0, 8).equals(sellDiscriminator) ? [index] : []);
  const quoteCloses = instructions.flatMap((ix, index) => keyAt(ix.programIdIndex) === TOKEN_PROGRAM_ID.toBase58()
    && ix.data.length === 1 && ix.data[0] === 9 && keyAt(ix.accountKeyIndexes[0]!) === quoteAta ? [index] : []);
  const quoteRecreates = instructions.flatMap((ix, index) => keyAt(ix.programIdIndex) === ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()
    && ix.data.length === 1 && ix.data[0] === 1 && keyAt(ix.accountKeyIndexes[1]!) === quoteAta ? [index] : []);
  assert.equal(buys.length, 1);
  assert.equal(sells.length, 1);
  const swaps = [...buys, ...sells].map(index => instructions[index]!);
  const protocolRecipients = swaps.map(ix => keyAt(ix.accountKeyIndexes[9]!));
  const buybackRecipients = swaps.map(ix => keyAt(ix.accountKeyIndexes.at(-2)!));
  assert.equal(new Set(protocolRecipients).size, 1, 'both swap legs use the same observed protocol fee recipient');
  assert.equal(new Set(buybackRecipients).size, 1, 'both swap legs use the same observed buyback fee recipient');
  assert.ok(protocolRecipients.every(recipient => recipient !== user.toBase58()), 'neither leg pays the public simulation subject as protocol fee recipient');
  assert.ok(buybackRecipients.every(recipient => recipient !== user.toBase58()), 'neither leg pays the public simulation subject as buyback fee recipient');
  assert.equal(quoteCloses.length, 2, 'the buy closes the original WSOL ATA and the sell closes the recreated ATA');
  assert.equal(quoteRecreates.length, 1, 'the sell builder was given a missing quote account and recreates it');
  assert.ok(buys[0]! < quoteCloses[0]! && quoteCloses[0]! < quoteRecreates[0]! && quoteRecreates[0]! < sells[0]! && sells[0]! < quoteCloses[1]!);
  assert.ok(tx.signatures.every(signature => signature.every(byte => byte === 0)));
  assert.equal(tx.message.addressTableLookups.length, 0);
  assert.equal(f.methods.some(call => /sendtransaction/i.test(call.method)), false);
});

test('full PumpSwap still prefers a funded candidate with an absent WSOL ATA', async () => {
  const second = new PublicKey(Buffer.alloc(32, 130));
  const holders: HolderFacts = {
    supplyAtomic: PAYLOAD_MINT_SUPPLY.toString(), slot: SLOT, complete: false, evidenceIds: ['holders'],
    accounts: [
      { address: 'holder-with-native-wsol', owner: PAYER.toBase58(), amount: '2' },
      { address: 'holder-with-absent-wsol', owner: second.toBase58(), amount: '1' },
    ],
  };
  const f = await fixture({
    simulate: true, ...fullSimulationRecipients, additionalFundedPayers: [second], validNativeWsolOwners: [PAYER], simulationPayer: second,
  });
  const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, holders, SLOT, 'https://rpc.example', f.fetcher, () => AT,
    undefined, undefined, undefined, true);
  const request = JSON.parse(read.rawArtifacts['pump-simulation-request']!) as { existingWsol?: unknown };
  const calculation = JSON.parse(read.rawArtifacts['pump-quote-calculation']!) as { simulationProof: { existingWsol?: unknown } };

  assert.equal(read.inspection.errors.simulation, undefined);
  assert.equal(read.venue?.costsReconciled, true);
  assert.equal(request.existingWsol, undefined);
  assert.equal(calculation.simulationProof.existingWsol, undefined);
  assert.equal(f.methods.some(call => call.method === 'simulateTransaction'), true);
});

test('partial PumpSwap keeps its existing payer-unavailable behavior when only a native WSOL candidate exists', async () => {
  const holders: HolderFacts = {
    supplyAtomic: PAYLOAD_MINT_SUPPLY.toString(), slot: SLOT, complete: false, evidenceIds: ['holders'],
    accounts: [{ address: 'holder-with-native-wsol', owner: PAYER.toBase58(), amount: '1' }],
  };
  const f = await fixture({ simulate: true, validNativeWsolOwners: [PAYER] });
  const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, holders, SLOT, 'https://rpc.example', f.fetcher, () => AT);

  assert.equal(read.inspection.errors.simulation, 'PUMP_SIMULATION_PAYER_UNAVAILABLE');
  assert.equal(read.venue?.costsReconciled, false);
  assert.equal(f.methods.some(call => call.method === 'simulateTransaction'), false);
});

test('full PumpSwap leaves malformed, mismatched, frozen, delegated and non-native quote ATAs unknown', async t => {
  const unsupported: Array<{ name: string; scenario: Partial<Scenario> }> = [
    { name: 'malformed account bytes', scenario: { nativeWsolAccountFailure: 'malformed' } },
    { name: 'wrong token program', scenario: { nativeWsolAccountFailure: 'wrong-program' } },
    { name: 'wrong mint', scenario: { nativeWsolAccountFailure: 'wrong-mint' } },
    { name: 'wrong token owner', scenario: { nativeWsolAccountFailure: 'wrong-owner' } },
    { name: 'frozen token state', scenario: { nativeWsolAccountFailure: 'frozen' } },
    { name: 'delegated token account', scenario: { nativeWsolAccountFailure: 'delegated' } },
    { name: 'close authority present', scenario: { nativeWsolAccountFailure: 'close-authority' } },
    { name: 'non-native quote token account', scenario: { nativeWsolAccountFailure: 'non-native' } },
    { name: 'lamports do not match reserve and amount', scenario: { nativeWsolLamports: 2_039_282 } },
  ];
  for (const item of unsupported) {
    await t.test(item.name, async () => {
      const holders: HolderFacts = {
        supplyAtomic: PAYLOAD_MINT_SUPPLY.toString(), slot: SLOT, complete: false, evidenceIds: ['holders'],
        accounts: [{ address: 'holder-with-unsupported-wsol', owner: PAYER.toBase58(), amount: '1' }],
      };
      const f = await fixture({ simulate: true, validNativeWsolOwners: [PAYER], ...item.scenario });
      const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, holders, SLOT, 'https://rpc.example', f.fetcher, () => AT,
        undefined, undefined, undefined, true);

      assert.equal(read.inspection.bindingVerified, true);
      assert.equal(read.inspection.errors.simulation, 'PUMP_SIMULATION_PAYER_UNAVAILABLE');
      assert.equal(read.inspection.errors.execution, 'PUMP_TRANSACTION_COSTS_UNAVAILABLE');
      assert.equal(read.venue?.costsReconciled, false);
      assert.equal(read.venue?.simulation, undefined);
      assert.equal(f.methods.some(call => call.method === 'simulateTransaction'), false);
      assert.ok(read.rawArtifacts['pump-quote-calculation'], 'the valid independent quote survives an unusable payer account');
    });
  }
});

test('existing native WSOL plus an existing base ATA records no setup rent', async () => {
  const holders: HolderFacts = {
    supplyAtomic: PAYLOAD_MINT_SUPPLY.toString(), slot: SLOT, complete: false, evidenceIds: ['holders'],
    accounts: [{ address: 'holder-with-native-wsol-and-base-ata', owner: PAYER.toBase58(), amount: '1' }],
  };
  const f = await fixture({ simulate: true, ...fullSimulationRecipients, existingBaseOwners: [PAYER], validNativeWsolOwners: [PAYER] });
  const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, holders, SLOT, 'https://rpc.example', f.fetcher, () => AT,
    undefined, undefined, undefined, true);
  const calculation = JSON.parse(read.rawArtifacts['pump-quote-calculation']!) as { simulationProof: { setupLamports: string } };
  const rawSimulation = JSON.parse(read.rawArtifacts['pump-roundtrip-simulation']!) as {
    result: { value: { preTokenBalances: Array<{ accountIndex: number; uiTokenAmount: { amount: string } }>; postTokenBalances: Array<{ accountIndex: number; uiTokenAmount: { amount: string } }> } };
  };
  const tx = VersionedTransaction.deserialize(Buffer.from(String(f.methods.find(call => call.method === 'simulateTransaction')?.params[0]), 'base64'));
  const baseIndex = tx.message.staticAccountKeys.findIndex(key => key.equals(f.baseAta));

  assert.equal(read.inspection.errors.simulation, undefined);
  assert.equal(read.venue?.costsReconciled, true);
  assert.equal(calculation.simulationProof.setupLamports, '0');
  assert.ok(rawSimulation.result.value.preTokenBalances.some(row => row.accountIndex === baseIndex && row.uiTokenAmount.amount === '1'));
  assert.ok(rawSimulation.result.value.postTokenBalances.some(row => row.accountIndex === baseIndex && row.uiTokenAmount.amount === '1'));
});

test('full existing-WSOL simulation stays unknown when every observed fee recipient is the public payer', async () => {
  const holders: HolderFacts = {
    supplyAtomic: PAYLOAD_MINT_SUPPLY.toString(), slot: SLOT, complete: false, evidenceIds: ['holders'],
    accounts: [{ address: 'holder-with-native-wsol', owner: PAYER.toBase58(), amount: '1' }],
  };
  const f = await fixture({
    simulate: true, protocolFeeRecipients: [PAYER, ...Array(7).fill(PublicKey.default)],
    buybackFeeRecipients: [PAYER, ...Array(7).fill(PublicKey.default)], validNativeWsolOwners: [PAYER],
  });
  const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, holders, SLOT, 'https://rpc.example', f.fetcher, () => AT,
    undefined, undefined, undefined, true);

  assert.equal(read.inspection.errors.simulation, 'PUMP_SIMULATION_SETUP_UNSUPPORTED');
  assert.equal(read.venue?.costsReconciled, false);
  assert.equal(read.venue?.simulation, undefined);
  assert.equal(f.methods.some(call => call.method === 'simulateTransaction'), false);
  assert.equal(read.rawArtifacts['pump-quote-calculation'] !== undefined, true, 'independent quotes remain observable without a qualified simulation');
});

test('Service admits and replays UNKNOWN when existing-WSOL runtime cost validation fails after a successful RPC simulation', async () => {
  const fallbackOwners = Array.from({ length: 7 }, (_, index) => new PublicKey(Buffer.alloc(32, index + 110)));
  const user = fallbackOwners[0]!;
  const holderOwners = Array.from({ length: 20 }, (_, index) => new PublicKey(Buffer.alloc(32, index + 80)));
  const holders: HolderFacts = {
    supplyAtomic: PAYLOAD_MINT_SUPPLY.toString(), slot: SLOT, complete: false, evidenceIds: ['holders'],
    accounts: holderOwners.map((owner, index) => ({ address: `unfunded-holder-${index}`, owner: owner.toBase58(), amount: String(20 - index) })),
  };
  const profile = starterProfile();
  const f = await fixture({
    simulate: true, ...fullSimulationRecipients, payerLamports: 1, additionalPayerLamports: 1_000_000_000,
    additionalFundedPayers: fallbackOwners, protocolFeeRecipients: fallbackOwners,
    buybackFeeRecipients: [FULL_BUYBACK_FEE_RECIPIENT, ...Array(7).fill(PublicKey.default)],
    globalAdmin: PublicKey.default, validNativeWsolOwners: fallbackOwners, simulationPayer: user,
    simulationFailure: 'underfunded-setup',
  });
  const read = await inspectPumpSwap(TOKEN, profile, controls, holders, SLOT, 'https://rpc.example', f.fetcher, () => AT,
    undefined, undefined, undefined, true);

  assert.equal(read.inspection.errors.simulation, 'PUMP_SIMULATION_DELTA_MISMATCH');
  assert.equal(read.venue?.costsReconciled, false);
  assert.equal(read.venue?.simulation, undefined);
  const bundle = pumpLiveBundle(read, profile);
  const request = JSON.parse(bundle.rawArtifacts['pump-simulation-request']!) as { existingWsol?: { method: string; user: string } };
  const simulation = JSON.parse(bundle.rawArtifacts['pump-roundtrip-simulation']!) as { result: { value: { err: unknown } } };
  const calculation = JSON.parse(bundle.rawArtifacts['pump-quote-calculation']!) as { simulationProof?: unknown };
  assert.deepEqual(request.existingWsol, {
    method: 'existing-wsol-roundtrip-v1', user: user.toBase58(),
    sourceId: 'pump-simulation-fallback-user-accounts', sourceIndex: 1,
  });
  assert.equal(simulation.result.value.err, null, 'the RPC executed successfully but local cost reconciliation rejected the payer delta');
  assert.equal(calculation.simulationProof, undefined, 'a failed local cost check cannot retain a certified monetary proof');
  assert.equal(bundle.details!.baseline.find(row => row.id === 'O15')?.quality, 'MISSING');
  assert.equal(bundle.details!.baseline.find(row => row.id === 'O16')?.quality, 'MISSING');

  const directory = mkdtempSync(join(tmpdir(), 'pump-existing-wsol-unknown-'));
  try {
    const database = join(directory, 'unknown.sqlite');
    const writer = new Service(database);
    let snapshotId = '';
    let snapshotHash = '';
    try {
      const saved = writer.analyzeLive(bundle);
      snapshotId = saved.id;
      snapshotHash = saved.hash;
      assert.equal(saved.details?.baseline.find(row => row.id === 'O16')?.quality, 'MISSING');
    } finally { writer.close(); }

    const reopened = new Service(database);
    try {
      const replay = reopened.replay(snapshotId);
      assert.equal(replay.hash, snapshotHash);
      assert.deepEqual(replay, reopened.show(snapshotId));
      assert.equal(replay.details?.baseline.find(row => row.id === 'O16')?.quality, 'MISSING');
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Service saves and replays existing native WSOL proof and rejects fully rehashed tampering or proof stripping', async t => {
  const fallbackOwners = Array.from({ length: 7 }, (_, index) => new PublicKey(Buffer.alloc(32, index + 110)));
  const user = fallbackOwners[0]!;
  const holderOwners = Array.from({ length: 20 }, (_, index) => new PublicKey(Buffer.alloc(32, index + 80)));
  const holders: HolderFacts = {
    supplyAtomic: PAYLOAD_MINT_SUPPLY.toString(), slot: SLOT, complete: false, evidenceIds: ['holders'],
    accounts: holderOwners.map((owner, index) => ({ address: `unfunded-holder-${index}`, owner: owner.toBase58(), amount: String(20 - index) })),
  };
  const profile = starterProfile();
  const makeBundle = async (existingBase: boolean): Promise<LiveBundle> => {
    const f = await fixture({
      simulate: true, payerLamports: 1, additionalPayerLamports: 1_000_000_000, additionalFundedPayers: fallbackOwners,
      ...fullSimulationRecipients, protocolFeeRecipients: fallbackOwners, globalAdmin: PublicKey.default,
      buybackFeeRecipients: [FULL_BUYBACK_FEE_RECIPIENT, ...Array(7).fill(PublicKey.default)],
      validNativeWsolOwners: fallbackOwners, simulationPayer: user,
      ...(existingBase ? { existingBaseOwners: [user] } : {}),
    });
    const read = await inspectPumpSwap(TOKEN, profile, controls, holders, SLOT, 'https://rpc.example', f.fetcher, () => AT,
      undefined, undefined, undefined, true);
    return pumpLiveBundle(read, profile);
  };
  const bundle = await makeBundle(false);
  const existingBaseBundle = await makeBundle(true);
  const proof = pumpProof(bundle);
  assert.equal(proof.existingWsol?.method, 'existing-wsol-roundtrip-v1');

  const directory = mkdtempSync(join(tmpdir(), 'pump-existing-wsol-'));
  try {
    for (const [name, accepted] of [['new base ATA', bundle], ['existing base ATA', existingBaseBundle]] as const) {
      await t.test(`Service saves and replays native WSOL proof with ${name}`, async () => {
        const simulation = JSON.parse(accepted.rawArtifacts['pump-roundtrip-simulation']!) as {
          result: { value: { preBalances: number[] } };
        };
        const tx = VersionedTransaction.deserialize(Buffer.from(pumpProof(accepted).wireBase64, 'base64'));
        const baseIndex = tx.message.staticAccountKeys.findIndex(key => key.equals(getAssociatedTokenAddressSync(
          new PublicKey(TOKEN.address), user, true, TOKEN_PROGRAM_ID,
        )));
        assert.notEqual(baseIndex, -1);
        assert.equal(simulation.result.value.preBalances[baseIndex]! > 0, name === 'existing base ATA');
        if (name === 'existing base ATA') assert.equal(pumpProof(accepted).setupLamports, '0');

        const database = join(directory, `accepted-${name.startsWith('new') ? 'new' : 'existing'}-base.sqlite`);
        const writer = new Service(database);
        let snapshotId = '';
        let snapshotHash = '';
        try {
          const saved = writer.analyzeLive(accepted);
          snapshotId = saved.id;
          snapshotHash = saved.hash;
          assert.equal(saved.details?.baseline.find(row => row.id === 'O15')?.quality, 'KNOWN');
          assert.equal(saved.details?.baseline.find(row => row.id === 'O16')?.quality, 'KNOWN');
          assert.equal((saved.details?.baseline.find(row => row.id === 'O15')?.data as { setupMethod?: string }).setupMethod, 'existing-wsol-roundtrip-v1');
        } finally { writer.close(); }

        const reopened = new Service(database);
        try {
          const replay = reopened.replay(snapshotId);
          assert.equal(replay.hash, snapshotHash);
          assert.deepEqual(replay, reopened.show(snapshotId));
        } finally { reopened.close(); }
      });
    }

    const mutateArtifact = (candidate: LiveBundle, id: string, update: (value: Record<string, any>) => void) => {
      const value = JSON.parse(candidate.rawArtifacts[id]!) as Record<string, any>;
      update(value);
      candidate.rawArtifacts[id] = JSON.stringify(value);
    };
    const tampering: Array<{ name: string; source?: LiveBundle; mutate: (candidate: LiveBundle) => void }> = [
      {
        name: 'returned base account is missing',
        mutate: candidate => mutateArtifact(candidate, 'pump-roundtrip-simulation', simulation => { simulation.result.value.accounts[1] = null; }),
      },
      {
        name: 'returned base account uses a different token program',
        mutate: candidate => mutateArtifact(candidate, 'pump-roundtrip-simulation', simulation => {
          simulation.result.value.accounts[1].owner = TOKEN_2022_PROGRAM;
        }),
      },
      {
        name: 'returned base account has a different mint',
        mutate: candidate => mutateArtifact(candidate, 'pump-roundtrip-simulation', simulation => {
          const account = simulation.result.value.accounts[1];
          const bytes = Buffer.from(account.data[0], 'base64');
          new PublicKey(Buffer.alloc(32, 28)).toBuffer().copy(bytes, 0);
          account.data[0] = bytes.toString('base64');
        }),
      },
      {
        name: 'returned base account has a different token owner',
        mutate: candidate => mutateArtifact(candidate, 'pump-roundtrip-simulation', simulation => {
          const account = simulation.result.value.accounts[1];
          const bytes = Buffer.from(account.data[0], 'base64');
          new PublicKey(Buffer.alloc(32, 29)).toBuffer().copy(bytes, 32);
          account.data[0] = bytes.toString('base64');
        }),
      },
      {
        name: 'post base quantity changed while returned account matches but initial quantity differs',
        source: existingBaseBundle,
        mutate: candidate => {
          const tx = VersionedTransaction.deserialize(Buffer.from(pumpProof(candidate).wireBase64, 'base64'));
          const baseIndex = tx.message.staticAccountKeys.findIndex(key => key.equals(getAssociatedTokenAddressSync(
            new PublicKey(TOKEN.address), user, true, TOKEN_PROGRAM_ID,
          )));
          assert.notEqual(baseIndex, -1);
          mutateArtifact(candidate, 'pump-roundtrip-simulation', simulation => {
            const value = simulation.result.value;
            const returned = value.accounts[1];
            const bytes = Buffer.from(returned.data[0], 'base64');
            const changed = bytes.readBigUInt64LE(64) + 1n;
            bytes.writeBigUInt64LE(changed, 64);
            returned.data[0] = bytes.toString('base64');
            const post = value.postTokenBalances.find((row: { accountIndex: number }) => row.accountIndex === baseIndex);
            assert.ok(post);
            post.uiTokenAmount.amount = changed.toString();
          });
        },
      },
      {
        name: 'captured base mint decimals disagree with simulation token vectors',
        mutate: candidate => mutateArtifact(candidate, 'pump-mints-vaults', capture => {
          const account = capture.result.value[3];
          const bytes = Buffer.from(account.data[0], 'base64');
          bytes[44] = (bytes[44]! + 1) % 256;
          account.data[0] = bytes.toString('base64');
        }),
      },
      {
        name: 'new base setup is one lamport below the returned base account rent',
        mutate: candidate => {
          const proof = pumpProof(candidate);
          const oldSetup = BigInt(proof.setupLamports);
          assert.ok(oldSetup > 0n);
          const tx = VersionedTransaction.deserialize(Buffer.from(proof.wireBase64, 'base64'));
          const baseIndex = tx.message.staticAccountKeys.findIndex(key => key.equals(getAssociatedTokenAddressSync(
            new PublicKey(TOKEN.address), user, true, TOKEN_PROGRAM_ID,
          )));
          assert.notEqual(baseIndex, -1);
          mutateArtifact(candidate, 'pump-roundtrip-simulation', simulation => {
            const value = simulation.result.value;
            assert.equal(value.preBalances[baseIndex], 0, 'the rent guard case starts with no base ATA');
            assert.equal(BigInt(value.postBalances[baseIndex]), oldSetup,
              'the unmodified setup exactly covers the returned base ATA rent');
            value.postBalances[0] += 1;
            value.accounts[0].lamports = value.postBalances[0];
          });
          mutateArtifact(candidate, 'pump-quote-calculation', calculation => {
            calculation.simulationProof.setupLamports = (oldSetup - 1n).toString();
          });
          const nativePairs = JSON.parse(candidate.rawArtifacts['pump-sol-usd']!) as Array<{
            baseToken?: { address?: string }; quoteToken?: { address?: string }; priceUsd?: string;
          }>;
          const nativeUsd = nativePairs.find(pair => pair.baseToken?.address === NATIVE_MINT.toBase58()
            && pair.quoteToken?.address === USDC)?.priceUsd;
          assert.ok(nativeUsd);
          const feeId = candidate.rawArtifacts['pump-entry-network-fee-retry'] ? 'pump-entry-network-fee-retry' : 'pump-entry-network-fee';
          const entryFee = JSON.parse(candidate.rawArtifacts[feeId]!).result.value as number;
          const lowerTotal = new Decimal(candidate.profile.sizeUsd!).add(
            new Decimal(entryFee).add((oldSetup - 1n).toString()).div(1e9).mul(nativeUsd),
          ).toFixed();
          for (const row of candidate.details!.baseline.filter(row => row.id === 'O15' || row.id === 'O16')) {
            (row.data as Record<string, unknown>).totalEntryCostUsd = lowerTotal;
          }
        },
      },
      {
        name: 'source receipt slot moved beyond its simulation',
        mutate: candidate => mutateArtifact(candidate, proof.existingWsol!.sourceId, source => { source.result.context.slot += 1; }),
      },
      {
        name: 'native account flag removed from the observed quote ATA',
        mutate: candidate => mutateArtifact(candidate, proof.existingWsol!.sourceId, source => {
          const account = source.result.value[proof.existingWsol!.sourceIndex];
          const bytes = Buffer.from(account.data[0], 'base64');
          bytes.writeUInt32LE(0, 109);
          account.data[0] = bytes.toString('base64');
        }),
      },
      {
        name: 'initial quote refund scalar changed',
        mutate: candidate => mutateArtifact(candidate, 'pump-quote-calculation', calculation => { calculation.simulationProof.initialQuoteRefundLamports = '0'; }),
      },
      {
        name: 'existing WSOL proof method marker changed in both receipts',
        mutate: candidate => {
          mutateArtifact(candidate, 'pump-quote-calculation', calculation => { calculation.simulationProof.existingWsol.method = 'unverified'; });
          mutateArtifact(candidate, 'pump-simulation-request', request => { request.existingWsol.method = 'unverified'; });
        },
      },
      {
        name: 'submitted wire no longer recreates the quote ATA for sell',
        mutate: candidate => {
          const request = JSON.parse(candidate.rawArtifacts['pump-simulation-request']!) as { wireBase64: string };
          const calculation = JSON.parse(candidate.rawArtifacts['pump-quote-calculation']!) as { simulationProof: { wireBase64: string } };
          const tx = VersionedTransaction.deserialize(Buffer.from(request.wireBase64, 'base64'));
          const keys = tx.message.staticAccountKeys.map(key => key.toBase58());
          const quoteAta = getAssociatedTokenAddressSync(NATIVE_MINT, user, true, TOKEN_PROGRAM_ID).toBase58();
          const create = tx.message.compiledInstructions.find(ix => keys[ix.programIdIndex] === ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()
            && ix.data.length === 1 && ix.data[0] === 1 && keys[ix.accountKeyIndexes[1]!] === quoteAta);
          assert.ok(create, 'the original wire contains the sell-side quote ATA recreation');
          create.data[0] = 0;
          const wireBase64 = Buffer.from(tx.serialize()).toString('base64');
          request.wireBase64 = wireBase64;
          calculation.simulationProof.wireBase64 = wireBase64;
          candidate.rawArtifacts['pump-simulation-request'] = JSON.stringify(request);
          candidate.rawArtifacts['pump-quote-calculation'] = JSON.stringify(calculation);
        },
      },
      {
        name: 'submitted buy and sell wire make the public payer its own protocol fee recipient',
        mutate: candidate => {
          const request = JSON.parse(candidate.rawArtifacts['pump-simulation-request']!) as { wireBase64: string };
          const calculation = JSON.parse(candidate.rawArtifacts['pump-quote-calculation']!) as { simulationProof: { wireBase64: string } };
          const tx = VersionedTransaction.deserialize(Buffer.from(request.wireBase64, 'base64'));
          const keys = tx.message.staticAccountKeys.map(key => key.toBase58());
          const buyDiscriminator = Buffer.from(OFFLINE_PUMP_AMM_PROGRAM.idl.instructions.find(ix => ix.name === 'buy')!.discriminator);
          const sellDiscriminator = Buffer.from(OFFLINE_PUMP_AMM_PROGRAM.idl.instructions.find(ix => ix.name === 'sell')!.discriminator);
          const swaps = tx.message.compiledInstructions.filter(ix => keys[ix.programIdIndex] === PUMP_AMM_PROGRAM_ID.toBase58()
            && (Buffer.from(ix.data).subarray(0, 8).equals(buyDiscriminator)
              || Buffer.from(ix.data).subarray(0, 8).equals(sellDiscriminator)));
          assert.equal(swaps.length, 2, 'the original wire contains both Pump swap legs');
          for (const ix of swaps) {
            assert.notEqual(keys[ix.accountKeyIndexes[9]!], user.toBase58(), 'the original protocol recipient is not the public payer');
            ix.accountKeyIndexes[9] = 0;
          }
          const wireBase64 = Buffer.from(tx.serialize()).toString('base64');
          request.wireBase64 = wireBase64;
          calculation.simulationProof.wireBase64 = wireBase64;
          candidate.rawArtifacts['pump-simulation-request'] = JSON.stringify(request);
          candidate.rawArtifacts['pump-quote-calculation'] = JSON.stringify(calculation);
        },
      },
      {
        name: 'pre-simulation quote lamports no longer match the native ATA',
        mutate: candidate => mutateArtifact(candidate, 'pump-roundtrip-simulation', simulation => {
          const calculation = JSON.parse(candidate.rawArtifacts['pump-quote-calculation']!) as { simulationProof: { quoteIndex: number } };
          simulation.result.value.preBalances[calculation.simulationProof.quoteIndex] += 1;
        }),
      },
    ];
    for (const tamper of tampering) {
      await t.test(tamper.name, async () => {
        const candidate = structuredClone(tamper.source ?? bundle);
        tamper.mutate(candidate);
        rehashPumpBundle(candidate);
        const verifier = new Service(join(directory, `${tampering.indexOf(tamper)}.sqlite`));
        try {
          assert.throws(() => verifier.analyzeLive(candidate), /PUMP_EXISTING_WSOL_PROOF_INVALID/);
        } finally { verifier.close(); }
      });
    }

    await t.test('proof artifacts removed while the new O15/O16 setup marker remains', async () => {
      const candidate = structuredClone(bundle);
      const removed = new Set([
        proof.existingWsol!.sourceId, 'pump-simulation-request', 'pump-roundtrip-simulation', 'pump-quote-calculation',
      ]);
      for (const id of removed) delete candidate.rawArtifacts[id];
      candidate.evidence = candidate.evidence.filter(record => !removed.has(record.id));
      const clearRemovedEvidenceRefs = (value: unknown): void => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) { for (const item of value) clearRemovedEvidenceRefs(item); return; }
        const row = value as Record<string, unknown>;
        if (Array.isArray(row.evidenceIds)) row.evidenceIds = row.evidenceIds.filter(id => typeof id !== 'string' || !removed.has(id));
        for (const child of Object.values(row)) clearRemovedEvidenceRefs(child);
      };
      clearRemovedEvidenceRefs(candidate);
      rehashPumpBundle(candidate);
      const verifier = new Service(join(directory, 'stripped-proof.sqlite'));
      try {
        assert.throws(() => verifier.analyzeLive(candidate), /PUMP_EXISTING_WSOL_PROOF_INVALID/,
          'a known existing-WSOL cost decision cannot survive removal of every supporting artifact');
      } finally { verifier.close(); }
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
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

test('full PumpSwap retries one verified 6004 failure at its state floor and Service admission rejects rehashed marker tampering', async () => {
  const f = await fixture({ simulate: true, ...fullSimulationRecipients, simulationFailure: 'slippage', slippageSlot: SLOT + 10, retryCaptureSlot: SLOT + 15 });
  const holders: HolderFacts = {
    supplyAtomic: PAYLOAD_MINT_SUPPLY.toString(), slot: SLOT, complete: false, evidenceIds: ['holders'],
    accounts: [{ address: 'candidate-token-account', owner: f.payer.toBase58(), amount: '1' }],
  };
  const recovered = await inspectPumpSwap(TOKEN, starterProfile(), controls, holders, SLOT, 'https://rpc.example', f.fetcher, () => AT,
    undefined, undefined, undefined, true);
  assert.equal(recovered.inspection.errors.simulation, undefined, 'the accepted second simulation is the returned execution result');
  assert.equal(recovered.inspection.errors.execution, undefined);
  assert.equal(recovered.venue?.costsReconciled, true);
  assert.equal(f.methods.filter(call => call.method === 'simulateTransaction').length, 2, 'the failed first attempt and one fresh full attempt are the only simulations');
  assert.equal(f.captureCount, 2, 'the retry recaptures the coupled pool and vault state');
  assert.equal(f.dexCalls, 2, 'the retry reacquires the independent SOL/USD price');

  const refresh = JSON.parse(recovered.rawArtifacts['pump-slippage-refresh']!) as {
    method: string; minSlot: number; nextMinSlot: number;
    first: { rawArtifacts: Record<string, string>; retrievedAt: Record<string, string> };
  };
  assert.equal(refresh.method, 'pump-slippage-refresh-v1');
  assert.equal(refresh.minSlot, SLOT);
  assert.equal(refresh.nextMinSlot, SLOT + 10);
  assert.deepEqual(verifyPumpSlippage(refresh.first.rawArtifacts, TOKEN), { slot: SLOT + 10, stateSlot: SLOT + 2 });
  const firstSimulationIndex = f.methods.findIndex(call => call.method === 'simulateTransaction');
  assert.ok(firstSimulationIndex >= 0);
  const subsequentRpc = f.methods.slice(firstSimulationIndex + 1);
  const contextFloor = (call: typeof f.methods[number]) => {
    if (call.method === 'getMultipleAccounts' || call.method === 'getAccountInfo') {
      return (call.params[1] as { minContextSlot?: number } | undefined)?.minContextSlot;
    }
    if (call.method === 'getLatestBlockhash') {
      return (call.params[0] as { minContextSlot?: number } | undefined)?.minContextSlot;
    }
    if (call.method === 'getFeeForMessage' || call.method === 'simulateTransaction') {
      return (call.params[1] as { minContextSlot?: number } | undefined)?.minContextSlot;
    }
    return undefined;
  };
  for (const call of subsequentRpc.filter(call => contextFloor(call) !== undefined)) {
    assert.ok(contextFloor(call)! >= SLOT + 10, `${call.method} is bounded to the failed simulation slot`);
  }
  for (const id of ['pump-pool-config', 'pump-mints-vaults']) {
    const capture = JSON.parse(recovered.rawArtifacts[id]!) as { result: { context: { slot: number } } };
    assert.ok(capture.result.context.slot >= SLOT + 10, `${id} is recaptured above the failed simulation floor`);
  }
  const finalSimulation = JSON.parse(recovered.rawArtifacts['pump-roundtrip-simulation']!) as { result: { context: { slot: number } } };
  const finalRequest = JSON.parse(recovered.rawArtifacts['pump-simulation-request']!) as { minContextSlot: number; wireBase64: string };
  const finalCalculation = JSON.parse(recovered.rawArtifacts['pump-quote-calculation']!) as {
    slot: number; simulationProof?: { wireBase64: string };
  };
  assert.ok(finalSimulation.result.context.slot >= SLOT + 10);
  assert.ok(finalCalculation.slot >= SLOT + 10);
  assert.ok(finalRequest.minContextSlot >= SLOT + 10);
  assert.equal(finalCalculation.simulationProof?.wireBase64, finalRequest.wireBase64,
    'the final quote calculation binds to the actual successful second wire');

  const derivedIds = new Set(['pump-simulation-request', 'pump-quote-calculation', 'pump-slippage-refresh']);
  const bundle = {
    token: TOKEN, cutoff: AT, profile: starterProfile(), features: [], rawArtifacts: structuredClone(recovered.rawArtifacts),
    evidence: Object.entries(recovered.rawArtifacts).map(([id, raw]) => ({
      id, sourceId: derivedIds.has(id) ? 'pumpswap-derived' : 'pumpswap-rpc',
      sourceType: derivedIds.has(id) ? 'CALCULATION' : 'RPC',
      accessMode: derivedIds.has(id) ? 'LOCAL_DERIVED' : 'RPC',
      retrievedAt: recovered.retrievedAt[id]!, contentHash: createHash('sha256').update(raw).digest('hex'),
    })),
  } as unknown as LiveBundle;
  validatePumpRecoveryBundle(bundle);
  const rehash = (candidate: LiveBundle) => {
    for (const evidence of candidate.evidence) {
      const raw = candidate.rawArtifacts[evidence.id];
      if (raw !== undefined) evidence.contentHash = createHash('sha256').update(raw).digest('hex');
    }
  };
  const rejectRehashed = (label: string, mutate: (candidate: LiveBundle) => void) => {
    const candidate = structuredClone(bundle);
    mutate(candidate);
    rehash(candidate);
    assert.throws(() => validatePumpRecoveryBundle(candidate), /PUMP_SLIPPAGE_PROOF_INVALID/, label);
  };
  const refreshOf = (candidate: LiveBundle) => JSON.parse(candidate.rawArtifacts['pump-slippage-refresh']!) as typeof refresh;
  const rewriteFirstArtifact = (candidate: LiveBundle, id: string, update: (packet: Record<string, unknown>) => void) => {
    const marker = refreshOf(candidate);
    const packet = JSON.parse(marker.first.rawArtifacts[id]!) as Record<string, unknown>;
    update(packet);
    marker.first.rawArtifacts[id] = JSON.stringify(packet);
    candidate.rawArtifacts['pump-slippage-refresh'] = JSON.stringify(marker);
  };
  rejectRehashed('first request token mismatch', candidate => {
    rewriteFirstArtifact(candidate, 'pump-simulation-request', packet => { packet.token = '11111111111111111111111111111111'; });
  });
  rejectRehashed('first error log moved outside the actual Pump program', candidate => {
    const marker = refreshOf(candidate);
    const packet = JSON.parse(marker.first.rawArtifacts['pump-roundtrip-simulation']!) as {
      result: { value: { logs: string[] } };
    };
    packet.result.value.logs = packet.result.value.logs.map(line => line.replaceAll(PUMP_AMM_PROGRAM_ID.toBase58(), PUMP_AMM_FEE_CONFIG_PDA.toBase58()));
    marker.first.rawArtifacts['pump-roundtrip-simulation'] = JSON.stringify(packet);
    candidate.rawArtifacts['pump-slippage-refresh'] = JSON.stringify(marker);
  });
  rejectRehashed('first Pump buy discriminator mismatch', candidate => {
    rewriteFirstArtifact(candidate, 'pump-simulation-request', packet => {
      const request = packet as { wireBase64: string };
      const tx = VersionedTransaction.deserialize(Buffer.from(request.wireBase64, 'base64'));
      const first = refreshOf(candidate);
      const response = JSON.parse(first.first.rawArtifacts['pump-roundtrip-simulation']!) as {
        result: { value: { err: { InstructionError: [number, unknown] } } };
      };
      const buyIndex = response.result.value.err.InstructionError[0];
      const bytes = Buffer.from(tx.message.compiledInstructions[buyIndex]!.data);
      bytes[0] ^= 1;
      tx.message.compiledInstructions[buyIndex]!.data = bytes;
      request.wireBase64 = Buffer.from(tx.serialize()).toString('base64');
    });
  });
  rejectRehashed('first quote amount mismatch', candidate => {
    rewriteFirstArtifact(candidate, 'pump-quote-calculation', packet => { packet.acquiredAtomic = '0'; });
  });
  rejectRehashed('retry slot floor mismatch', candidate => {
    const marker = refreshOf(candidate);
    marker.nextMinSlot--;
    candidate.rawArtifacts['pump-slippage-refresh'] = JSON.stringify(marker);
  });
  rejectRehashed('first proof timestamp occurs after its refresh receipt', candidate => {
    const marker = refreshOf(candidate);
    marker.first.retrievedAt['pump-roundtrip-simulation'] = '2026-09-30T16:00:01.000Z';
    candidate.rawArtifacts['pump-slippage-refresh'] = JSON.stringify(marker);
  });
  rejectRehashed('final request wire differs from the successful simulation proof', candidate => {
    const request = JSON.parse(candidate.rawArtifacts['pump-simulation-request']!) as { wireBase64: string };
    request.wireBase64 = Buffer.from(request.wireBase64, 'base64').subarray(1).toString('base64');
    candidate.rawArtifacts['pump-simulation-request'] = JSON.stringify(request);
  });

  const partialFixture = await fixture({ simulate: true, simulationFailure: 'slippage' });
  const partial = await inspectPumpSwap(TOKEN, starterProfile(), controls, holders, SLOT, 'https://rpc.example', partialFixture.fetcher, () => AT);
  assert.equal(partial.inspection.errors.simulation, 'PUMP_SIMULATION_SLIPPAGE');
  assert.equal(partialFixture.methods.filter(call => call.method === 'simulateTransaction').length, 1,
    'the default partial read preserves the one-attempt behavior');
  assert.equal(partial.rawArtifacts['pump-slippage-refresh'], undefined);

  const abortController = new AbortController();
  const cancelFixture = await fixture({ simulate: true, ...fullSimulationRecipients, simulationFailure: 'slippage' });
  const cancelFetcher: typeof fetch = async (input, init) => {
    const response = await cancelFixture.fetcher(input, init);
    if (String(input).startsWith('https://rpc.example')
      && JSON.parse(String(init?.body)).method === 'simulateTransaction') abortController.abort();
    return response;
  };
  const cancelled = await inspectPumpSwap(TOKEN, starterProfile(), controls, holders, SLOT, 'https://rpc.example', cancelFetcher, () => AT,
    abortController.signal, undefined, undefined, true);
  assert.equal(cancelFixture.methods.filter(call => call.method === 'simulateTransaction').length, 1,
    'caller cancellation after the verified first failure prevents a second inspection');
  assert.equal(cancelled.rawArtifacts['pump-slippage-refresh'], undefined);

  const wrongProgramFixture = await fixture({ simulate: true, ...fullSimulationRecipients, simulationFailure: 'slippage-wrong-program' });
  const wrongProgram = await inspectPumpSwap(TOKEN, starterProfile(), controls, holders, SLOT, 'https://rpc.example', wrongProgramFixture.fetcher, () => AT,
    undefined, undefined, undefined, true);
  assert.equal(wrongProgram.inspection.errors.simulation, 'PUMP_SIMULATION_SLIPPAGE');
  assert.equal(wrongProgramFixture.methods.filter(call => call.method === 'simulateTransaction').length, 1,
    'an unscoped 6004-looking log cannot authorize a retry');
  assert.equal(wrongProgram.rawArtifacts['pump-slippage-refresh'], undefined);
});

test('two verified Pump 6004 failures derive only a known entry-cost rejection and survive Service replay', async () => {
  const profile = starterProfile();
  const f = await fixture({ simulate: true, ...fullSimulationRecipients, simulationFailure: 'slippage-persistent', slippageSlot: SLOT + 10, retryCaptureSlot: SLOT + 15 });
  const holders: HolderFacts = {
    supplyAtomic: PAYLOAD_MINT_SUPPLY.toString(), slot: SLOT, complete: false, evidenceIds: ['holders'],
    accounts: [{ address: 'candidate-token-account', owner: f.payer.toBase58(), amount: '1' }],
  };
  const read = await inspectPumpSwap(TOKEN, profile, controls, holders, SLOT, 'https://rpc.example', f.fetcher, () => AT,
    undefined, { tinyfishKey: TINYFISH_KEY }, undefined, true);

  assert.equal(read.inspection.errors.simulation, 'PUMP_SIMULATION_SLIPPAGE');
  assert.equal(f.methods.filter(call => call.method === 'simulateTransaction').length, 2);
  assert.equal(f.captureCount, 2, 'the second failure follows a complete state recapture');
  assert.equal(f.dexCalls, 2, 'the second failure follows a fresh independent USD read');
  assert.equal(read.venue?.costsReconciled, false);
  assert.equal(read.venue?.simulation, undefined);
  assert.deepEqual(read.venue?.executionFailure, { method: 'pump-budget-rejection-v1', code: 'PUMP_SIMULATION_SLIPPAGE' });

  const refresh = JSON.parse(read.rawArtifacts['pump-slippage-refresh']!) as {
    nextMinSlot: number; first: { rawArtifacts: Record<string, string>; retrievedAt: Record<string, string> };
  };
  const firstProof = verifyPumpSlippage(refresh.first.rawArtifacts, TOKEN);
  assert.equal(refresh.nextMinSlot, Math.max(SLOT, firstProof.slot));
  const finalProof = verifyPumpSlippage(read.rawArtifacts, TOKEN);
  assert.ok(finalProof.stateSlot >= refresh.nextMinSlot);
  const secondSimulation = JSON.parse(read.rawArtifacts['pump-roundtrip-simulation']!) as { result: { context: { slot: number } } };
  assert.ok(secondSimulation.result.context.slot >= refresh.nextMinSlot);
  const secondState = JSON.parse(read.rawArtifacts['pump-mints-vaults']!) as { result: { context: { slot: number } } };
  assert.ok(secondState.result.context.slot >= refresh.nextMinSlot);

  const baseline = deriveBaseline({
    token: TOKEN, cutoff: AT, profile, features: [], evidence: [], observations: [],
    venueInspection: read.inspection, venue: read.venue!,
  });
  const expectedReason = {
    method: 'pump-budget-rejection-v1', code: 'PUMP_SIMULATION_SLIPPAGE',
    meaning: 'The simulated buy exceeded its exact quoted spending limit; execution cost verification failed. Monetary costs and sellability are not established.',
  };
  for (const id of ['O12', 'O16']) {
    const assessment = baseline.find(row => row.id === id)!;
    assert.equal(assessment.quality, 'KNOWN');
    assert.deepEqual(assessment.data, expectedReason);
    assert.equal(assessment.projection?.value, false);
    assert.equal(assessment.projection?.quality, 'KNOWN');
  }
  assert.equal(baseline.find(row => row.id === 'O15')?.quality, 'MISSING', 'a rejected buy does not assert numeric fees or total-loss bps');

  const derivedIds = new Set(['pump-simulation-request', 'pump-quote-calculation', 'pump-slippage-refresh']);
  const rawArtifacts = structuredClone(read.rawArtifacts);
  const evidence: LiveBundle['evidence'] = Object.entries(rawArtifacts).map(([id, raw]) => {
    const derived = derivedIds.has(id), market = id === 'pump-sol-usd';
    const retrievedAt = read.retrievedAt[id]!;
    return {
      id,
      sourceId: derived ? 'pumpswap-derived' : market ? 'dexscreener' : 'pumpswap-direct',
      sourceType: derived ? 'CALCULATION' : market ? 'PUBLIC_MARKET' : 'JSON_RPC',
      retrievedAt, availableAt: retrievedAt, contentHash: createHash('sha256').update(raw).digest('hex'),
      adapterVersion: 'pumpswap-test-v1', accessMode: derived ? 'LOCAL_DERIVED' : 'PUBLIC_API',
      scope: { operation: id, mint: TOKEN.address, pool: read.inspection.poolAddress },
    };
  });
  const collection: LiveBundle['collection'] = {
    rpc: { state: 'OBSERVED' }, dex: { state: 'NO_RESULTS', count: 0 }, web: { state: 'NOT_REQUESTED' },
  };
  const semantic: LiveBundle['semantic'] = { status: 'NOT_REQUESTED', claims: [] };
  const details: AssessmentDetails = {
    version: 1, profile, thesis: null, baseline, origins: {},
    stageInputs: { circulatingMarketCapUsd: null, tokenCreatedAt: null },
  };
  const bundle: LiveBundle = {
    analysisKind: 'LIVE', token: TOKEN, cutoff: AT, profile, evidence, rawArtifacts,
    observations: [], features: baseline.flatMap(row => row.projection ? [row.projection] : []),
    collection, semantic, market: null, details,
  };

  const directory = mkdtempSync(join(tmpdir(), 'pump-budget-rejection-'));
  try {
    const database = join(directory, 'accepted.sqlite');
    const writer = new Service(database);
    let snapshotId = '';
    let snapshotHash = '';
    try {
      const saved = writer.analyzeLive(bundle);
      snapshotId = saved.id;
      snapshotHash = saved.hash;
      assert.equal(saved.details?.baseline.find(row => row.id === 'O16')?.projection?.value, false);
    } finally { writer.close(); }

    const reopened = new Service(database);
    try {
      const replay = reopened.replay(snapshotId);
      assert.equal(replay.hash, snapshotHash);
      assert.deepEqual(replay, reopened.show(snapshotId));
    } finally { reopened.close(); }

    const candidate = structuredClone(bundle);
    const calculation = JSON.parse(candidate.rawArtifacts['pump-quote-calculation']!) as Record<string, unknown>;
    delete calculation.executionFailure;
    const raw = JSON.stringify(calculation);
    candidate.rawArtifacts['pump-quote-calculation'] = raw;
    candidate.evidence.find(record => record.id === 'pump-quote-calculation')!.contentHash = createHash('sha256').update(raw).digest('hex');
    const verifier = new Service(join(directory, 'stripped-negative-proof.sqlite'));
    try {
      assert.throws(() => verifier.analyzeLive(candidate), /PUMP_SLIPPAGE_PROOF_INVALID/,
        'a fully rehashed bundle cannot keep known negative features after stripping the embedded proof');
    } finally { verifier.close(); }

    const rejectProoflessSignal = (name: string, signal: 'feature-only' | 'assessment-only') => {
      const stripped = structuredClone(bundle);
      const removedIds = new Set(['pump-slippage-refresh', 'pump-simulation-request', 'pump-quote-calculation']);
      for (const id of removedIds) delete stripped.rawArtifacts[id];
      stripped.evidence = stripped.evidence.filter(record => !removedIds.has(record.id));
      const clearRemovedEvidenceRefs = (value: unknown): void => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
          for (const item of value) clearRemovedEvidenceRefs(item);
          return;
        }
        const row = value as Record<string, unknown>;
        if (Array.isArray(row.evidenceIds)) {
          row.evidenceIds = row.evidenceIds.filter(id => typeof id !== 'string' || !removedIds.has(id));
        }
        for (const child of Object.values(row)) clearRemovedEvidenceRefs(child);
      };
      clearRemovedEvidenceRefs(stripped);
      if (signal === 'feature-only') {
        for (const id of ['O12', 'O16']) {
          const assessment = stripped.details!.baseline.find(row => row.id === id)!;
          assessment.quality = 'MISSING';
          assessment.data = null;
          assessment.projection = undefined;
        }
        const o12 = stripped.features.find(feature => feature.id === 'O12')!;
        o12.value = null;
        o12.quality = 'MISSING';
        assert.deepEqual(stripped.features.find(feature => feature.id === 'O16')?.value, false,
          'the feature-only case retains the adverse O16 signal after clearing all adverse assessments');
      } else {
        for (const id of ['O12', 'O16']) {
          const feature = stripped.features.find(row => row.id === id)!;
          feature.value = null;
          feature.quality = 'MISSING';
        }
        assert.equal(stripped.details!.baseline.find(row => row.id === 'O16')?.data
          && (stripped.details!.baseline.find(row => row.id === 'O16')!.data as { method?: string }).method,
        'pump-budget-rejection-v1', 'the assessment-only case retains its persistent rejection decision');
      }
      for (const record of stripped.evidence) {
        const raw = stripped.rawArtifacts[record.id];
        if (raw !== undefined) record.contentHash = createHash('sha256').update(raw).digest('hex');
      }
      assert.equal(stripped.evidence.some(record => removedIds.has(record.id)), false);
      assert.equal([...removedIds].some(id => stripped.rawArtifacts[id] !== undefined), false);
      const strippedVerifier = new Service(join(directory, `${name}.sqlite`));
      try {
        assert.throws(() => strippedVerifier.analyzeLive(stripped), /PUMP_SLIPPAGE_PROOF_INVALID/,
          `${signal} rejection must be caught by Pump recovery validation after every proof artifact and reference is removed`);
      } finally { strippedVerifier.close(); }
    };
    rejectProoflessSignal('stripped-pump-proof-feature-only', 'feature-only');
    rejectProoflessSignal('stripped-pump-proof-assessment-only', 'assessment-only');
  } finally {
    rmSync(directory, { recursive: true, force: true });
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
    accounts: Array.from({ length: 55 }, (_, index) => ({ address: `token-account-${index}`, owner: new PublicKey(Buffer.alloc(32, index + 1)).toBase58(), amount: '1' })),
  };
  const f = await fixture();
  const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, holders, SLOT, 'https://rpc.example', f.fetcher, () => AT);
  assert.equal(read.inspection.bindingVerified, true);
  const payerQuery = f.methods.find(call => call.method === 'getMultipleAccounts' && (call.params[0] as string[]).length === 50);
  assert.ok(payerQuery, 'legacy selection retains fifty observed owners in one bounded batch');
  assert.deepEqual(payerQuery.params[0], holders.accounts.slice(0,50).map(account=>account.owner));
  assert.equal(read.inspection.errors.simulation, 'PUMP_SIMULATION_PAYER_UNAVAILABLE');
  assert.equal(read.venue?.simulation, undefined);
  assert.equal(read.venue?.costsReconciled, false);
});

test('a funded observed holder beyond the first five recovers unsigned simulation without admitting existing WSOL', async () => {
  const later = new PublicKey(Buffer.alloc(32, 89));
  const holders: HolderFacts = {
    supplyAtomic: PAYLOAD_MINT_SUPPLY.toString(), slot: SLOT, complete: false, evidenceIds: ['rpc-holder-population'],
    accounts: [
      { address: 'funded-existing-wsol', owner: PAYER.toBase58(), amount: '100' },
      ...Array.from({ length: 5 }, (_, index) => ({ address: `underfunded-${index}`, owner: new PublicKey(Buffer.alloc(32,index+80)).toBase58(), amount: String(90-index) })),
      { address: 'later-holder', owner: later.toBase58(), amount: '1' },
      { address: 'duplicate-owner', owner: later.toBase58(), amount: '1' },
    ],
  };
  const f = await fixture({ simulate: true, existingWsolOwners: [PAYER], additionalFundedPayers: [later], simulationPayer: later });
  const read = await inspectPumpSwap(TOKEN, starterProfile(), controls, holders, SLOT, 'https://rpc.example', f.fetcher, () => AT);
  assert.equal(read.venue?.costsReconciled, true);
  assert.deepEqual(read.venue?.simulation, { setupVerified: true, buySucceeded: true, sellSucceeded: true });
  assert.equal(read.rawArtifacts['pump-simulation-fallback-payers'], undefined);
  const calculation = JSON.parse(read.rawArtifacts['pump-quote-calculation']!);
  assert.equal(calculation.simulationProof.payerSelection.source, 'HOLDER_OBSERVATION');
  assert.deepEqual(calculation.simulationProof.payerSelection.sourceEvidenceIds, ['rpc-holder-population']);
  assert.equal(calculation.simulationProof.payerSelection.selectedIndex, 6);
  assert.equal(calculation.simulationProof.payerSelection.candidateOwners.length, 8, 'owners are deduplicated before adding the verified pool creator');
  assert.equal(calculation.simulationProof.payerSelection.candidateOwners[6], later.toBase58());
  assert.equal(calculation.simulationProof.staticAccountKeys[0], later.toBase58());
  assert.ok(read.rawArtifacts[calculation.simulationProof.payerSelection.payerAccountsEvidenceId]);
  assert.ok(read.rawArtifacts[calculation.simulationProof.payerSelection.ataAccountsEvidenceId]);
  assert.equal(f.methods.some(call => /sendtransaction/i.test(call.method)), false);
});
