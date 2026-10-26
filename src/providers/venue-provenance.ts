import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { AccountLayout, NATIVE_MINT, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { bondingCurvePda, canonicalPumpPoolPda, canonicalPumpPoolPdaWithQuote, isBondingCurveMigrated, pumpPoolAuthorityPda } from '@pump-fun/pump-sdk';
import type { BaselineAssessment, ProgramFacts, VenueInspection } from '../domain/baseline.js';
import type { EvidenceRecord, FeatureResult, LiveBundle, TokenRef } from '../domain/contracts.js';
import type { DexArtifact } from './dexscreener.js';
import type { PumpSwapRead } from './pumpswap.js';
import { LEGACY_TOKEN_PROGRAM, SOLANA_MAINNET_GENESIS, TOKEN_2022_PROGRAM, decodeProgramHeader, resolveProgramData, safeRpcCode } from './solana.js';
import { validateCurveBundle } from './pumpcurve.js';
import { validateDammBundle } from './meteora-damm-v2.js';

/**
 * Binding-only O08 fallback for migrated Pump curves whose canonical PumpSwap pool uses the curve quote
 * instead of WSOL. One pure planner/decoder owns request geometry, identity, lifecycle, deployment and
 * inventory semantics for both the collector and the Service validator. It never produces VenueFacts,
 * liquidity fractions, quotes, fees, disable flags or simulation results.
 */
export const VENUE_PROVENANCE_METHOD = 'pump-venue-provenance-v1';
export const VENUE_PROVENANCE_VERSION = 'pump-venue-provenance-v1';
export const VENUE_PROVENANCE_PREFIX = 'venue-provenance-';
export const VENUE_PROVENANCE_RECORD_ID = 'venue-provenance-record';
export const VENUE_PROVENANCE_TTL_SECONDS = 300;
export const VENUE_PROVENANCE_STAGES = ['discovery', 'pool', 'state', 'deployment'] as const;
export type VenueProvenanceStage = typeof VENUE_PROVENANCE_STAGES[number];
export const VENUE_PROVENANCE_RECEIPT_IDS: Record<VenueProvenanceStage, string> = { discovery: 'venue-provenance-discovery', pool: 'venue-provenance-pool', state: 'venue-provenance-state', deployment: 'venue-provenance-deployment' };
const METHOD = VENUE_PROVENANCE_METHOD, VERSION = VENUE_PROVENANCE_VERSION, PREFIX = VENUE_PROVENANCE_PREFIX, RECORD_ID = VENUE_PROVENANCE_RECORD_ID;
const STAGES = VENUE_PROVENANCE_STAGES, RECEIPT_ID = VENUE_PROVENANCE_RECEIPT_IDS;
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const FEE_PROGRAM = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
const PROGRAMS = [AMM_PROGRAM, PUMP_PROGRAM, FEE_PROGRAM];
const PROGRAM_ROLES = ['PUMPSWAP_AMM', 'PUMP_CURVE', 'PUMP_FEES'];
const OWNER_CLASS: Record<string, string> = { [AMM_PROGRAM]: 'PUMPSWAP_AMM', [PUMP_PROGRAM]: 'PUMP_CURVE', cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: 'METEORA_DAMM_V2', LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'METEORA_DLMM' };
const WSOL = NATIVE_MINT.toBase58();
const POOL_DISCRIMINATOR = 'f19a6d0411b16dbc', CURVE_DISCRIMINATOR = '17b7f83760d8ac60';
const MAX_KEYS = 100, FIXED_DISCOVERY_KEYS = 3, MAX_CANDIDATES = MAX_KEYS - FIXED_DISCOVERY_KEYS;
const DISCOVERY_SLICE = 1024, PROGRAM_DATA_SLICE = 45, MAX_POOL_PROBE_KEYS = 1;
const DEPENDENCY_IDS = ['rpc-genesis', 'rpc-account', 'pump-pool-config', 'dex-pairs'];
const PROMOTION_IDS = ['O09', 'O10', 'O11', 'O12', 'O13', 'O14', 'O15', 'O16'];
const NATIVE_FALLBACK_VERSIONS = new Set(['pump-curve-sdk-4.0.0-sol-v1', 'meteora-damm-v2-sdk-1.5.1-native-b-v1']);
const STOP_CODE = /^LIVE_(?:PHASE_DEADLINE|HARD_DEADLINE|OPERATION_LIMIT|CALLER_CANCELLED|STAGE_FINISHED)$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_-]{2,79}$/;
const SAFE_ID = /^[a-zA-Z0-9_.-]{1,64}$/;
const BINDING_ONLY_ERRORS: Record<string, string> = { liquidity: 'VENUE_PROVENANCE_BINDING_ONLY_LIQUIDITY_UNASSESSED', execution: 'VENUE_PROVENANCE_BINDING_ONLY_EXECUTION_UNSUPPORTED', simulation: 'VENUE_PROVENANCE_BINDING_ONLY_SIMULATION_UNSUPPORTED' };
const LIMITATIONS = [
  'Binding-only venue provenance: no liquidity, quote, USD, fee, LP withdrawal, disable or simulation result is produced.',
  'Lifecycle MIGRATED is a current finalized-state classification (complete curve with four zero reserves); no historical migration time, transaction, amounts or binary attestation.',
  'Observed upgrade authorities are read-only facts, not human, controller-constraint or immutability proof; deployed binaries are not downloaded and current SDK/IDL layouts are interpretation references, not deployed version attestation.',
  'Inventory is bounded to exact-mint rows of the admitted raw DexScreener pairs response plus derived canonical candidates; no universal recall, best or deepest route, or DEX legitimacy claim.',
  'Identity binding does not imply transfer safety, sellability or route executability.',
];

export type VenueProvenanceRequest = { jsonrpc: '2.0'; id: string; method: 'getMultipleAccounts'; params: [string[], Record<string, unknown>] };
export type VenueProvenanceReceipt = { raw: string; retrievedAt: string };
export type VenueProvenanceFailure = { stage: VenueProvenanceStage; code: string };
export type VenueProvenanceInput = {
  token: TokenRef; floorSlot: number; recordAt: string;
  genesisRaw?: string; accountRaw?: string; nativeAbsenceRaw?: string; dexRaw?: string;
  receipts: Partial<Record<VenueProvenanceStage, VenueProvenanceReceipt>>;
  failure?: VenueProvenanceFailure | null;
};
type CurveReserves = { virtualTokenReserves: string; virtualQuoteReserves: string; realTokenReserves: string; realQuoteReserves: string };
type CurveFacts = { complete: boolean; reservesZero: boolean; reserves: CurveReserves; classification: 'ACTIVE_CURVE' | 'AWAITING_MIGRATION' | 'MIGRATED'; quoteMint: string; quoteSource: 'CURVE_FIELD' | 'ZERO_NORMALIZED_WSOL' | 'PRE_QUOTE_LAYOUT_WSOL' };
export type VenueProvenanceLifecycle = { basis: 'CURRENT_FINALIZED_STATE'; curveAddress: string; curveProgram: string; complete: boolean; reservesZero: boolean; reserves: CurveReserves; classification: CurveFacts['classification']; quoteMint: string; quoteSource: CurveFacts['quoteSource']; migrationTransaction: null; discoverySlot: number; stateSlot: number | null };
export type VenueProvenanceDeployment = { role: string; program: string; loader: string; programDataAddress: string | null; deploymentSlot: number | null; upgradeAuthority: string | null; immutable: boolean; authorityObservedSlot: number; headerLinked: true; binaryAttested: false };
export type VenueProvenanceRecord = {
  method: typeof VENUE_PROVENANCE_METHOD; version: typeof VENUE_PROVENANCE_VERSION; token: TokenRef;
  floorSlot: number; availableAt: string; expiresAt: string; ttlSeconds: number;
  dependencies: Array<{ id: string; contentHash: string }>;
  receipts: Array<{ id: string; stage: VenueProvenanceStage; retrievedAt: string; contentHash: string; request: VenueProvenanceRequest }>;
  failure: VenueProvenanceFailure | null;
  poolAddress: string; lifecycle: VenueProvenanceLifecycle | null; identity: Record<string, unknown> | null;
  deployments: VenueProvenanceDeployment[]; inventory: Record<string, unknown>;
  selected: { route: 'PUMPSWAP_CANONICAL_CURVE_QUOTE_POOL'; poolAddress: string; certification: 'VERIFIED' } | null;
  bindingVerified: boolean; certificateId: string; errors: Record<string, string>; limitations: string[];
};

type Account = { owner: string; executable: boolean; lamports: number; data: Buffer };
type Bank = { slot: number; values: unknown[]; accounts: Array<Account | null> };
type MintFacts = { address: string; program: string; decimals: number };
type PoolFacts = { index: number; creator: string; baseMint: string; quoteMint: string; lpMint: string; baseVault: string; quoteVault: string; pointers: string };
type DexRow = { address: string; dexIds: string[]; mintSides: string[]; rawIndexes: number[] };
type DexInventory = { source: 'dex-pairs' | 'UNAVAILABLE'; reportedRows: number; exactRows: number; duplicateRows: number; exclusions: Record<string, number>; rows: DexRow[]; error: string | null };
type Step = { stage: VenueProvenanceStage; request: VenueProvenanceRequest };
class Halt extends Error {}

const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');
const parseJson = (raw: string): unknown => { try { return JSON.parse(raw); } catch { return undefined; } };
const pk = (data: Buffer, at: number) => new PublicKey(data.subarray(at, at + 32)).toBase58();
const codeOf = (error: unknown) => error instanceof Error && !(error instanceof Halt) && SAFE_CODE.test(error.message) ? error.message : 'VENUE_PROVENANCE_DECODE';
function isKey(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  try { return new PublicKey(v).toBase58() === v; } catch { return false; }
}
function key(v: unknown): string { if (!isKey(v)) throw new Error('VENUE_PROVENANCE_ADDRESS'); return v; }
function jsonResult(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  const parsed = parseJson(raw);
  return obj(parsed) && !('error' in parsed) ? parsed.result : undefined;
}
function nativePrimary(raw: string | undefined): unknown {
  const result = jsonResult(raw);
  return obj(result) && Array.isArray(result.value) && result.value.length > 0 ? result.value[0] : undefined;
}

function account(v: unknown): Account | null {
  if (v === null) return null;
  if (!obj(v) || typeof v.owner !== 'string' || typeof v.executable !== 'boolean' || typeof v.lamports !== 'number' || !Number.isSafeInteger(v.lamports) || v.lamports < 0 || !Array.isArray(v.data) || v.data.length !== 2 || v.data[1] !== 'base64' || typeof v.data[0] !== 'string') throw new Error('VENUE_PROVENANCE_RPC_SHAPE');
  const encoded = v.data[0] as string, data = Buffer.from(encoded, 'base64');
  if (data.toString('base64') !== encoded) throw new Error('VENUE_PROVENANCE_RPC_SHAPE');
  return { owner: key(v.owner), executable: v.executable, lamports: v.lamports, data };
}
function bank(raw: string, id: string, length: number, minSlot: number): Bank {
  const parsed = parseJson(raw);
  // Each receipt must answer its own planned request id; transports never rewrite it.
  if (!obj(parsed) || parsed.id !== id) throw new Error('VENUE_PROVENANCE_RPC_ID');
  if (obj(parsed.error)) { const c = parsed.error.code; throw new Error(typeof c === 'number' && Number.isSafeInteger(c) && Math.abs(c) < 1e6 ? `RPC_REMOTE_${c}` : 'RPC_REMOTE_INVALID'); }
  const result = obj(parsed) && parsed.jsonrpc === '2.0' && obj(parsed.result) ? parsed.result : null;
  const context = result && obj(result.context) ? result.context : null;
  if (!result || !context || typeof context.slot !== 'number' || !Number.isSafeInteger(context.slot) || !Array.isArray(result.value)) throw new Error('VENUE_PROVENANCE_RPC_SHAPE');
  const slot = context.slot as number, values = result.value as unknown[];
  if (slot < minSlot) throw new Error('VENUE_PROVENANCE_SLOT_REGRESSION');
  if (values.length !== length) throw new Error('VENUE_PROVENANCE_RPC_SHAPE');
  return { slot, values, accounts: values.map(value => account(value)) };
}

function mintFacts(address: string, a: Account | null, code: string): MintFacts {
  if (!a || a.executable || (a.owner !== LEGACY_TOKEN_PROGRAM && a.owner !== TOKEN_2022_PROGRAM) || a.data.length < 82 || a.data[45] !== 1) throw new Error(code);
  if (a.owner === LEGACY_TOKEN_PROGRAM ? a.data.length !== 82 : a.data.length > 82 && (a.data.length < 166 || a.data[165] !== 1)) throw new Error(code);
  return { address, program: a.owner, decimals: a.data[44]! };
}
/** The admitted rpc-account receipt anchors floorSlot and the initialized target mint program/decimals (base64 or jsonParsed). */
function anchorMint(raw: string | undefined, address: string, floorSlot: number): MintFacts {
  const parsed = raw === undefined ? undefined : parseJson(raw);
  const result = obj(parsed) && !('error' in parsed) && obj(parsed.result) ? parsed.result : null;
  if (!result || !obj(result.context) || result.context.slot !== floorSlot) throw new Error('VENUE_PROVENANCE_FLOOR_SLOT');
  const v = result.value;
  if (obj(v) && Array.isArray(v.data)) return mintFacts(address, account(v), 'VENUE_PROVENANCE_ANCHOR_MINT');
  const info = obj(v) && obj(v.data) && obj(v.data.parsed) && v.data.parsed.type === 'mint' && obj(v.data.parsed.info) ? v.data.parsed.info : null;
  if (!obj(v) || !info || v.executable !== false || typeof v.owner !== 'string' || (v.owner !== LEGACY_TOKEN_PROGRAM && v.owner !== TOKEN_2022_PROGRAM) || info.isInitialized !== true || typeof info.decimals !== 'number' || !Number.isInteger(info.decimals) || info.decimals < 0 || info.decimals > 255) throw new Error('VENUE_PROVENANCE_ANCHOR_MINT');
  return { address, program: v.owner, decimals: info.decimals };
}
function vaultFacts(a: Account | null, address: string, mint: MintFacts, pool: string) {
  if (!a || a.executable || a.owner !== mint.program || a.data.length < 165) throw new Error('VENUE_PROVENANCE_VAULT');
  if (address !== getAssociatedTokenAddressSync(new PublicKey(mint.address), new PublicKey(pool), true, new PublicKey(mint.program)).toBase58()) throw new Error('VENUE_PROVENANCE_VAULT_ATA');
  if (mint.program === LEGACY_TOKEN_PROGRAM ? a.data.length !== 165 : a.data.length > 165 && a.data[165] !== 2) throw new Error('VENUE_PROVENANCE_VAULT');
  const v = AccountLayout.decode(a.data.subarray(0, 165));
  if (!v.mint.equals(new PublicKey(mint.address)) || !v.owner.equals(new PublicKey(pool)) || v.state !== 1 || v.delegateOption !== 0 || v.closeAuthorityOption !== 0) throw new Error('VENUE_PROVENANCE_VAULT');
  return { address, mint: mint.address, owner: pool, program: mint.program, associatedTokenAccount: true, state: 'INITIALIZED', delegate: null, closeAuthority: null };
}
function curveFacts(a: Account | null): CurveFacts {
  if (!a) throw new Error('VENUE_PROVENANCE_CURVE_ABSENT');
  const data = a.data;
  if (a.owner !== PUMP_PROGRAM || a.executable || data.length < 81 || data.subarray(0, 8).toString('hex') !== CURVE_DISCRIMINATOR || data[48]! > 1) throw new Error('VENUE_PROVENANCE_CURVE');
  const values = [8, 16, 24, 32].map(at => data.readBigUInt64LE(at));
  const reserve = (value: bigint) => ({ isZero: () => value === 0n });
  // The SDK migration predicate reads only isZero() of the four reserves; the full curve decode stays with the native curve adapter.
  const reservesZero = isBondingCurveMigrated({ virtualTokenReserves: reserve(values[0]!), virtualQuoteReserves: reserve(values[1]!), realTokenReserves: reserve(values[2]!), realQuoteReserves: reserve(values[3]!) } as unknown as Parameters<typeof isBondingCurveMigrated>[0]);
  const reserves: CurveReserves = { virtualTokenReserves: values[0]!.toString(), virtualQuoteReserves: values[1]!.toString(), realTokenReserves: values[2]!.toString(), realQuoteReserves: values[3]!.toString() };
  const complete = data[48] === 1;
  let quoteMint = WSOL, quoteSource: CurveFacts['quoteSource'] = 'PRE_QUOTE_LAYOUT_WSOL';
  if (data.length >= 115) {
    const field = pk(data, 83);
    if (field === PublicKey.default.toBase58()) quoteSource = 'ZERO_NORMALIZED_WSOL';
    else { quoteMint = field; quoteSource = 'CURVE_FIELD'; }
  }
  return { complete, reservesZero, reserves, classification: !complete ? 'ACTIVE_CURVE' : reservesZero ? 'MIGRATED' : 'AWAITING_MIGRATION', quoteMint, quoteSource };
}
function poolFacts(a: Account | null): PoolFacts {
  if (!a) throw new Error('VENUE_PROVENANCE_POOL_ABSENT');
  const d = a.data;
  if (a.owner !== AMM_PROGRAM || a.executable || d.length < 211 || d.subarray(0, 8).toString('hex') !== POOL_DISCRIMINATOR) throw new Error('VENUE_PROVENANCE_POOL');
  return { index: d.readUInt16LE(9), creator: pk(d, 11), baseMint: pk(d, 43), quoteMint: pk(d, 75), lpMint: pk(d, 107), baseVault: pk(d, 139), quoteVault: pk(d, 171), pointers: d.subarray(0, 203).toString('base64') };
}
function programHeader(value: unknown, slot: number, address: string, ids: string[]): ProgramFacts {
  try { return decodeProgramHeader({ context: { slot }, value }, address, ids); } catch { throw new Error('VENUE_PROVENANCE_PROGRAM_HEADER'); }
}
function programData(header: ProgramFacts, value: unknown, slot: number, ids: string[]): ProgramFacts {
  try { return resolveProgramData(header, { context: { slot }, value }, ids); } catch { throw new Error('VENUE_PROVENANCE_PROGRAM_DATA'); }
}

function dexInventory(raw: string | undefined, mintAddress: string): DexInventory {
  const exclusions: Record<string, number> = { NOT_OBJECT: 0, NON_SOLANA_CHAIN: 0, MISSING_PAIR_ADDRESS: 0, INVALID_PAIR_ADDRESS: 0, NOT_EXACT_MINT: 0 };
  const empty = (source: DexInventory['source'], error: string): DexInventory => ({ source, reportedRows: 0, exactRows: 0, duplicateRows: 0, exclusions, rows: [], error });
  if (raw === undefined) return empty('UNAVAILABLE', 'VENUE_PROVENANCE_DEX_UNAVAILABLE');
  const parsed = parseJson(raw);
  const list: unknown[] | null = Array.isArray(parsed) ? parsed : obj(parsed) && Array.isArray(parsed.pairs) ? parsed.pairs : null;
  if (!list) return empty('dex-pairs', 'VENUE_PROVENANCE_DEX_SHAPE');
  const rows = new Map<string, DexRow>();
  let exactRows = 0, duplicateRows = 0;
  list.forEach((item, index) => {
    if (!obj(item)) { exclusions.NOT_OBJECT++; return; }
    if (item.chainId !== 'solana') { exclusions.NON_SOLANA_CHAIN++; return; }
    const address = item.pairAddress;
    if (typeof address !== 'string' || !address) { exclusions.MISSING_PAIR_ADDRESS++; return; }
    if (!isKey(address)) { exclusions.INVALID_PAIR_ADDRESS++; return; }
    const base = obj(item.baseToken) ? item.baseToken.address : undefined, quote = obj(item.quoteToken) ? item.quoteToken.address : undefined;
    if (base !== mintAddress && quote !== mintAddress) { exclusions.NOT_EXACT_MINT++; return; }
    exactRows++;
    const side = base === mintAddress ? 'base' : 'quote', dexId = typeof item.dexId === 'string' && SAFE_ID.test(item.dexId) ? item.dexId : 'UNKNOWN';
    const row = rows.get(address);
    if (!row) { rows.set(address, { address, dexIds: [dexId], mintSides: [side], rawIndexes: [index] }); return; }
    duplicateRows++;
    if (!row.dexIds.includes(dexId)) row.dexIds.push(dexId);
    if (!row.mintSides.includes(side)) row.mintSides.push(side);
    row.rawIndexes.push(index);
  });
  return { source: 'dex-pairs', reportedRows: list.length, exactRows, duplicateRows, exclusions, rows: [...rows.values()], error: null };
}
function certify(address: string, owner: string | null | undefined, canonicalPool: string, bound: boolean): [string, string] {
  if (owner === undefined) return ['NOT_OBSERVED', 'DISCOVERY_NOT_COMPLETED_OR_NOT_REQUESTED'];
  if (owner === null) return ['ABSENT', 'ACCOUNT_ABSENT_AT_FINALIZED_DISCOVERY'];
  if (canonicalPool && address === canonicalPool) return bound ? ['VERIFIED', 'SELECTED_CANONICAL_ROUTE_FULLY_BOUND'] : ['UNVERIFIED', 'CANONICAL_ROUTE_BINDING_INCOMPLETE'];
  const cls = OWNER_CLASS[owner];
  if (cls === 'PUMPSWAP_AMM') return ['UNVERIFIED', 'PUMPSWAP_ACCOUNT_NOT_THE_SELECTED_CANONICAL_ROUTE'];
  if (cls) return ['UNSUPPORTED', 'NO_BINDING_ADAPTER_IN_PROVENANCE_FALLBACK'];
  return ['UNVERIFIED', 'UNRECOGNIZED_OWNER_PROGRAM'];
}
function inventoryRecord(inv: DexInventory, discoveryKeys: number, probeKeys: number, observed: Map<string, string | null>, wsolPool: string, curveQuotePool: string, bound: boolean): Record<string, unknown> {
  const entries = new Map<string, { address: string; origins: string[]; dexIds: string[]; mintSides: string[]; rawIndexes: number[] }>();
  const add = (address: string, origin: string, row?: DexRow) => {
    const entry = entries.get(address) ?? { address, origins: [], dexIds: [], mintSides: [], rawIndexes: [] };
    if (!entry.origins.includes(origin)) entry.origins.push(origin);
    if (row) { entry.dexIds.push(...row.dexIds); entry.mintSides.push(...row.mintSides); entry.rawIndexes.push(...row.rawIndexes); }
    entries.set(address, entry);
  };
  for (const row of inv.rows) add(row.address, 'DEX_PAIR', row);
  if (wsolPool) add(wsolPool, 'DERIVED_WSOL_CANONICAL');
  if (curveQuotePool) add(curveQuotePool, 'DERIVED_CURVE_QUOTE_CANONICAL');
  const dexOwnerCounts: Record<string, number> = {};
  const candidates = [...entries.values()].map(entry => {
    const owner = observed.has(entry.address) ? observed.get(entry.address) ?? null : undefined;
    const ownerClass = owner === undefined ? 'NOT_OBSERVED' : owner === null ? 'ABSENT' : OWNER_CLASS[owner] ?? 'OTHER';
    if (entry.origins.includes('DEX_PAIR')) dexOwnerCounts[ownerClass] = (dexOwnerCounts[ownerClass] ?? 0) + 1;
    const [certification, reason] = certify(entry.address, owner, curveQuotePool, bound);
    return { ...entry, observedOwner: owner ?? null, ownerClass, certification, reason };
  });
  return {
    source: inv.source, scope: 'ADMITTED_RAW_DEX_PAIRS_EXACT_MINT_ROWS_PLUS_DERIVED_CANONICAL_CANDIDATES',
    reportedRows: inv.reportedRows, exactRows: inv.exactRows, uniqueDexPairs: inv.rows.length, duplicateRows: inv.duplicateRows, exclusions: inv.exclusions,
    cap: { maxKeys: MAX_KEYS, fixedKeys: FIXED_DISCOVERY_KEYS, maxCandidates: MAX_CANDIDATES, discoveryKeys, maxPoolProbeKeys: MAX_POOL_PROBE_KEYS, poolProbeKeys: probeKeys, failClosedOnCap: true },
    dexOwnerCounts, candidates,
    certificationRule: 'Only the selected fully bound canonical curve-quote PumpSwap pool is VERIFIED; other owners are recorded without binding.',
  };
}

function evaluate(input: VenueProvenanceInput): { next: Step | null; consumed: Set<VenueProvenanceStage>; failureUsed: boolean; record: VenueProvenanceRecord } {
  const mintAddress = input.token.address, st = { next: null as Step | null, failureUsed: false, failureCode: '' };
  const consumed = new Set<VenueProvenanceStage>(), receipts: VenueProvenanceRecord['receipts'] = [], deployments: VenueProvenanceDeployment[] = [];
  const inv = dexInventory(input.dexRaw, mintAddress);
  let code: string | null = null, lifecycle: VenueProvenanceLifecycle | null = null, identity: Record<string, unknown> | null = null;
  let poolAddress = '', wsolPool = '', keys: string[] = [], probed: Bank | null = null;
  const observed = new Map<string, string | null>();
  const take = (stage: VenueProvenanceStage, stageKeys: string[], config: Record<string, unknown>, minSlot: number): Bank => {
    const request: VenueProvenanceRequest = { jsonrpc: '2.0', id: RECEIPT_ID[stage], method: 'getMultipleAccounts', params: [stageKeys, config] };
    const receipt = input.receipts[stage];
    if (!receipt) {
      if (input.failure && input.failure.stage === stage) { st.failureUsed = true; st.failureCode = SAFE_CODE.test(input.failure.code) ? input.failure.code : 'RPC_TRANSPORT'; throw new Error(st.failureCode); }
      st.next = { stage, request }; throw new Halt();
    }
    consumed.add(stage);
    receipts.push({ id: RECEIPT_ID[stage], stage, retrievedAt: receipt.retrievedAt, contentHash: sha(receipt.raw), request });
    return bank(receipt.raw, request.id, stageKeys.length, minSlot);
  };
  try {
    if (input.token.chain !== 'solana') throw new Error('VENUE_PROVENANCE_CHAIN');
    const mintKey = new PublicKey(key(mintAddress));
    if (!Number.isSafeInteger(input.floorSlot) || input.floorSlot < 0) throw new Error('VENUE_PROVENANCE_FLOOR_SLOT');
    if (jsonResult(input.genesisRaw) !== SOLANA_MAINNET_GENESIS) throw new Error('VENUE_PROVENANCE_GENESIS');
    const anchor = anchorMint(input.accountRaw, mintAddress, input.floorSlot);
    if (nativePrimary(input.nativeAbsenceRaw) !== null) throw new Error('VENUE_PROVENANCE_NATIVE_ABSENCE_UNPROVEN');
    if (inv.error) throw new Error(inv.error);
    const curveAddress = bondingCurvePda(mintKey).toBase58();
    wsolPool = canonicalPumpPoolPda(mintKey).toBase58();
    const fixed = [mintAddress, curveAddress, wsolPool];
    const candidates = inv.rows.map(row => row.address).filter(address => !fixed.includes(address));
    if (candidates.length > MAX_CANDIDATES) throw new Error('VENUE_PROVENANCE_DISCOVERY_CAP');
    keys = [...fixed, ...candidates];
    const d = take('discovery', keys, { encoding: 'base64', commitment: 'finalized', minContextSlot: input.floorSlot, dataSlice: { offset: 0, length: DISCOVERY_SLICE } }, input.floorSlot);
    keys.forEach((address, i) => observed.set(address, d.accounts[i]?.owner ?? null));
    if (d.accounts[2] !== null) throw new Error('VENUE_PROVENANCE_WSOL_POOL_PRESENT');
    const firstMint = mintFacts(mintAddress, d.accounts[0] ?? null, 'VENUE_PROVENANCE_MINT');
    if (firstMint.program !== anchor.program || firstMint.decimals !== anchor.decimals) throw new Error('VENUE_PROVENANCE_ANCHOR_MINT_CHANGED');
    const c1 = curveFacts(d.accounts[1] ?? null);
    lifecycle = { basis: 'CURRENT_FINALIZED_STATE', curveAddress, curveProgram: PUMP_PROGRAM, complete: c1.complete, reservesZero: c1.reservesZero, reserves: { ...c1.reserves }, classification: c1.classification, quoteMint: c1.quoteMint, quoteSource: c1.quoteSource, migrationTransaction: null, discoverySlot: d.slot, stateSlot: null };
    if (c1.classification === 'ACTIVE_CURVE') throw new Error('VENUE_PROVENANCE_CURVE_ACTIVE');
    if (c1.classification === 'AWAITING_MIGRATION') throw new Error('VENUE_PROVENANCE_AWAITING_MIGRATION');
    if (c1.quoteMint === WSOL) throw new Error('VENUE_PROVENANCE_WSOL_QUOTE_POOL_ABSENT');
    poolAddress = canonicalPumpPoolPdaWithQuote(mintKey, new PublicKey(c1.quoteMint)).toBase58();
    const poolIndex = keys.indexOf(poolAddress);
    if (poolIndex >= 0 && poolIndex < FIXED_DISCOVERY_KEYS) throw new Error('VENUE_PROVENANCE_POOL_NOT_DISCOVERED');
    // The canonical PDA does not depend on a DEX listing: an unlisted pool gets one bounded direct probe for its pointers.
    if (poolIndex < 0) {
      probed = take('pool', [poolAddress], { encoding: 'base64', commitment: 'finalized', minContextSlot: d.slot, dataSlice: { offset: 0, length: DISCOVERY_SLICE } }, d.slot);
      observed.set(poolAddress, probed.accounts[0]?.owner ?? null);
    }
    const p1 = poolFacts(probed ? probed.accounts[0] ?? null : d.accounts[poolIndex] ?? null);
    const pointerSlot = probed ? probed.slot : d.slot;
    const poolKey = new PublicKey(poolAddress), ammKey = new PublicKey(AMM_PROGRAM);
    const globalConfig = PublicKey.findProgramAddressSync([Buffer.from('global_config')], ammKey)[0].toBase58();
    const feeConfig = PublicKey.findProgramAddressSync([Buffer.from('fee_config'), ammKey.toBuffer()], new PublicKey(FEE_PROGRAM))[0].toBase58();
    const stateKeys = [mintAddress, curveAddress, poolAddress, c1.quoteMint, key(p1.baseVault), key(p1.quoteVault), key(p1.lpMint), globalConfig, feeConfig, ...PROGRAMS];
    const s = take('state', stateKeys, { encoding: 'base64', commitment: 'finalized', minContextSlot: pointerSlot }, pointerSlot);
    lifecycle.stateSlot = s.slot;
    const target = mintFacts(mintAddress, s.accounts[0] ?? null, 'VENUE_PROVENANCE_MINT');
    if (target.program !== firstMint.program) throw new Error('VENUE_PROVENANCE_MINT_PROGRAM_CHANGED');
    if (target.decimals !== anchor.decimals) throw new Error('VENUE_PROVENANCE_ANCHOR_MINT_CHANGED');
    if (JSON.stringify(curveFacts(s.accounts[1] ?? null)) !== JSON.stringify(c1)) throw new Error('VENUE_PROVENANCE_CURVE_CHANGED');
    const p2 = poolFacts(s.accounts[2] ?? null);
    if (p2.pointers !== p1.pointers) throw new Error('VENUE_PROVENANCE_POOL_POINTERS_CHANGED');
    if (p2.index !== 0) throw new Error('VENUE_PROVENANCE_POOL_INDEX');
    if (p2.creator !== pumpPoolAuthorityPda(mintKey).toBase58()) throw new Error('VENUE_PROVENANCE_POOL_CREATOR');
    if (p2.baseMint !== mintAddress || p2.quoteMint !== c1.quoteMint) throw new Error('VENUE_PROVENANCE_POOL_MINTS');
    if (p2.lpMint !== PublicKey.findProgramAddressSync([Buffer.from('pool_lp_mint'), poolKey.toBuffer()], ammKey)[0].toBase58()) throw new Error('VENUE_PROVENANCE_LP_PDA');
    const quote = mintFacts(c1.quoteMint, s.accounts[3] ?? null, 'VENUE_PROVENANCE_QUOTE_MINT');
    const baseVault = vaultFacts(s.accounts[4] ?? null, p2.baseVault, target, poolAddress);
    const quoteVault = vaultFacts(s.accounts[5] ?? null, p2.quoteVault, quote, poolAddress);
    const lp = mintFacts(p2.lpMint, s.accounts[6] ?? null, 'VENUE_PROVENANCE_LP_MINT');
    const auxiliary = [{ role: 'PUMPSWAP_GLOBAL_CONFIG', address: globalConfig, expectedOwner: AMM_PROGRAM }, { role: 'PUMP_FEE_CONFIG', address: feeConfig, expectedOwner: FEE_PROGRAM }].map((aux, i) => {
      const a = s.accounts[7 + i] ?? null;
      return { role: aux.role, address: aux.address, observedOwner: a?.owner ?? null, ownerMatches: a?.owner === aux.expectedOwner, discriminator: a ? a.data.subarray(0, 8).toString('hex') : null, interpreted: false };
    });
    const headers = PROGRAMS.map((address, i) => programHeader(s.values[9 + i], s.slot, address, [RECEIPT_ID.state]));
    const upgradeable = headers.filter(header => header.programDataAddress);
    const deploymentKeys = [...PROGRAMS, ...upgradeable.map(header => header.programDataAddress as string)];
    const dep = take('deployment', deploymentKeys, { encoding: 'base64', commitment: 'finalized', minContextSlot: s.slot, dataSlice: { offset: 0, length: PROGRAM_DATA_SLICE } }, s.slot);
    headers.forEach((header, i) => {
      const before = s.accounts[9 + i] ?? null, after = dep.accounts[i] ?? null;
      if (!before || !after || after.owner !== before.owner || after.executable !== before.executable || !after.data.equals(before.data)) throw new Error('VENUE_PROVENANCE_PROGRAM_HEADER_CHANGED');
      const again = programHeader(dep.values[i], dep.slot, header.address, [RECEIPT_ID.deployment]);
      if (again.loader !== header.loader || again.programDataAddress !== header.programDataAddress) throw new Error('VENUE_PROVENANCE_PROGRAM_HEADER_CHANGED');
      let facts = header;
      if (header.programDataAddress) {
        facts = programData(header, dep.values[PROGRAMS.length + upgradeable.indexOf(header)], dep.slot, [RECEIPT_ID.state, RECEIPT_ID.deployment]);
        if (facts.deploymentSlot === undefined || facts.deploymentSlot > s.slot) throw new Error('VENUE_PROVENANCE_DEPLOYMENT_AFTER_STATE');
      }
      deployments.push({ role: PROGRAM_ROLES[i]!, program: header.address, loader: header.loader, programDataAddress: header.programDataAddress ?? null, deploymentSlot: facts.deploymentSlot ?? null, upgradeAuthority: facts.upgradeAuthority, immutable: facts.immutable, authorityObservedSlot: dep.slot, headerLinked: true, binaryAttested: false });
    });
    identity = {
      genesis: SOLANA_MAINNET_GENESIS,
      mint: { address: mintAddress, program: target.program, decimals: target.decimals, initialized: true },
      curve: { address: curveAddress, program: PUMP_PROGRAM, derivation: 'bondingCurvePda(mint)' },
      pool: { address: poolAddress, program: AMM_PROGRAM, discriminator: POOL_DISCRIMINATOR, index: 0, creator: p2.creator, creatorDerivation: 'pumpPoolAuthorityPda(mint)', baseMint: p2.baseMint, quoteMint: p2.quoteMint, derivation: 'canonicalPumpPoolPdaWithQuote(mint,curveQuote)', pointersStableFromDiscovery: true },
      lpMint: { address: lp.address, program: lp.program, decimals: lp.decimals, initialized: true, derivation: 'PDA(pool_lp_mint,pool)' },
      quoteMint: { address: quote.address, program: quote.program, decimals: quote.decimals, initialized: true, source: c1.quoteSource },
      baseVault, quoteVault, auxiliary,
      slots: { floor: input.floorSlot, discovery: d.slot, poolProbe: probed ? probed.slot : null, state: s.slot, deployment: dep.slot },
    };
  } catch (error) { if (!(error instanceof Halt)) code = codeOf(error); }
  const bound = code === null && st.next === null && identity !== null && deployments.length === PROGRAMS.length;
  const at = Date.parse(input.recordAt);
  const clocks = { stateRetrievedAt: input.receipts.state?.retrievedAt, observedRetrievedAt: receipts.at(-1)?.retrievedAt };
  const stateAt = Date.parse(clocks.stateRetrievedAt ?? '');
  const observedAt = Date.parse(clocks.observedRetrievedAt ?? '');
  const anchor = Number.isFinite(stateAt) ? Math.min(stateAt, Number.isFinite(at) ? at : stateAt) : Number.isFinite(observedAt) ? Math.min(observedAt, Number.isFinite(at) ? at : observedAt) : at;
  const errors: Record<string, string> = bound ? { ...BINDING_ONLY_ERRORS } : { binding: code ?? 'VENUE_PROVENANCE_INCOMPLETE', ...BINDING_ONLY_ERRORS };
  const dependencies = ([['rpc-genesis', input.genesisRaw], ['rpc-account', input.accountRaw], ['pump-pool-config', input.nativeAbsenceRaw], ['dex-pairs', input.dexRaw]] as Array<[string, string | undefined]>).flatMap(([id, raw]) => raw === undefined ? [] : [{ id, contentHash: sha(raw) }]);
  const record: VenueProvenanceRecord = {
    method: METHOD, version: VERSION, token: structuredClone(input.token), floorSlot: input.floorSlot,
    availableAt: input.recordAt, expiresAt: Number.isFinite(anchor) ? new Date(anchor + VENUE_PROVENANCE_TTL_SECONDS * 1000).toISOString() : input.recordAt, ttlSeconds: VENUE_PROVENANCE_TTL_SECONDS,
    dependencies, receipts, failure: st.failureUsed && input.failure ? { stage: input.failure.stage, code: st.failureCode } : null,
    poolAddress, lifecycle, identity: bound ? identity : null, deployments: bound ? deployments : [],
    inventory: inventoryRecord(inv, keys.length, probed ? 1 : 0, observed, wsolPool, poolAddress, bound),
    selected: bound ? { route: 'PUMPSWAP_CANONICAL_CURVE_QUOTE_POOL', poolAddress, certification: 'VERIFIED' } : null,
    bindingVerified: bound,
    certificateId: bound ? `venue-provenance:${sha(JSON.stringify({ method: METHOD, token: input.token, poolAddress, identity, lifecycle, deployments }))}` : '',
    errors, limitations: [...LIMITATIONS],
  };
  return { next: st.next, consumed, failureUsed: st.failureUsed, record };
}

/** Pure planner: the next exact request the collector must issue, or null when evaluation is final. */
export function planVenueProvenance(input: VenueProvenanceInput): Step | null { return evaluate(input).next; }

/** Pure decoder shared by collector and Service validator. Throws on incomplete, orphaned or clock-inconsistent inputs. */
export function decodeVenueProvenance(input: VenueProvenanceInput): VenueProvenanceRecord {
  const result = evaluate(input);
  if (result.next) throw new Error('VENUE_PROVENANCE_RECEIPT_MISSING');
  for (const stage of STAGES) if (input.receipts[stage] && !result.consumed.has(stage)) throw new Error('VENUE_PROVENANCE_ORPHAN_RECEIPT');
  if (input.failure && !result.failureUsed) throw new Error('VENUE_PROVENANCE_FAILURE_ORPHAN');
  const times = [...result.record.receipts.map(r => r.retrievedAt), input.recordAt].map(t => Date.parse(t));
  if (times.some((t, i) => !Number.isFinite(t) || (i > 0 && t < times[i - 1]!))) throw new Error('VENUE_PROVENANCE_CLOCK');
  return result.record;
}
export const encodeVenueProvenance = (record: VenueProvenanceRecord): string => JSON.stringify(record);

export function venueProvenanceInspection(record: VenueProvenanceRecord): VenueInspection {
  const provenance: Record<string, unknown> = structuredClone({ method: record.method, version: record.version, lifecycle: record.lifecycle, identity: record.identity, deployments: record.deployments, inventory: record.inventory, selected: record.selected, floorSlot: record.floorSlot, availableAt: record.availableAt, expiresAt: record.expiresAt, ttlSeconds: record.ttlSeconds });
  return { token: structuredClone(record.token), poolAddress: record.poolAddress, certificateId: record.certificateId, version: VERSION, availableAt: record.availableAt, bindingVerified: record.bindingVerified, evidenceIds: [RECORD_ID, ...record.receipts.map(r => r.id)], errors: { ...record.errors }, limitations: [...record.limitations], provenance };
}
const receiptScope = (record: VenueProvenanceRecord, r: VenueProvenanceRecord['receipts'][number]): Record<string, unknown> => ({ method: METHOD, operation: r.stage, mint: record.token.address, request: r.request });
const recordScope = (record: VenueProvenanceRecord): Record<string, unknown> => ({ method: METHOD, operation: 'record', mint: record.token.address, pool: record.poolAddress || null });

function venueProvenanceRead(record: VenueProvenanceRecord, receipts: Partial<Record<VenueProvenanceStage, VenueProvenanceReceipt>>): PumpSwapRead {
  const rawArtifacts: Record<string, string> = {}, retrievedAt: Record<string, string> = {}, marketEvidence: Record<string, DexArtifact> = {};
  const artifact = (sourceId: string, sourceType: string, accessMode: 'PUBLIC_API' | 'LOCAL_DERIVED', scope: Record<string, unknown>) => ({ sourceId, sourceType, accessMode, scope }) as unknown as DexArtifact;
  for (const r of record.receipts) { rawArtifacts[r.id] = receipts[r.stage]!.raw; retrievedAt[r.id] = r.retrievedAt; marketEvidence[r.id] = artifact('pumpswap-direct', 'JSON_RPC', 'PUBLIC_API', receiptScope(record, r)); }
  rawArtifacts[RECORD_ID] = encodeVenueProvenance(record); retrievedAt[RECORD_ID] = record.availableAt;
  marketEvidence[RECORD_ID] = artifact('pumpswap-derived', 'CALCULATION', 'LOCAL_DERIVED', recordScope(record));
  return { inspection: venueProvenanceInspection(record), rawArtifacts, retrievedAt, marketEvidence };
}

/**
 * The transport must return the exact raw JSON-RPC response body (including JSON-RPC error objects) and
 * throw sanitized codes for transport failure. Endpoint, key and byte/request limits stay with the caller.
 */
export type VenueProvenanceTransport = (request: VenueProvenanceRequest) => Promise<string>;
export type VenueProvenanceCollectInput = { token: TokenRef; floorSlot: number; genesisRaw?: string; accountRaw?: string; nativeAbsenceRaw?: string; dexRaw?: string; transport: VenueProvenanceTransport; now: () => string };

export async function collectVenueProvenance(input: VenueProvenanceCollectInput): Promise<PumpSwapRead> {
  const base = { token: input.token, floorSlot: input.floorSlot, genesisRaw: input.genesisRaw, accountRaw: input.accountRaw, nativeAbsenceRaw: input.nativeAbsenceRaw, dexRaw: input.dexRaw };
  const receipts: Partial<Record<VenueProvenanceStage, VenueProvenanceReceipt>> = {};
  let failure: VenueProvenanceFailure | null = null;
  for (let step = 0; step < STAGES.length; step++) {
    const next = planVenueProvenance({ ...base, receipts, failure, recordAt: input.now() });
    if (!next) break;
    try {
      const raw = await input.transport(next.request);
      if (typeof raw !== 'string') throw new Error('RPC_SHAPE');
      receipts[next.stage] = { raw, retrievedAt: input.now() };
    } catch (error) { failure = { stage: next.stage, code: safeRpcCode(error) }; break; }
  }
  return venueProvenanceRead(decodeVenueProvenance({ ...base, receipts, failure, recordAt: input.now() }), receipts);
}

const stable = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => { if (!obj(x)) return x; const o = x; return Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]])); });
const withoutErrors = (v: Record<string, unknown>) => Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'errors'));

/** Dependencies must carry the exact admitted producer metadata; anything else fails closed. */
function admittedDependency(e: EvidenceRecord, record: VenueProvenanceRecord): boolean {
  if (e.adapterVersion !== 'live-v1') return false;
  const rpc = e.sourceId === 'solana-rpc' && e.sourceType === 'JSON_RPC' && e.accessMode === 'PUBLIC_API';
  if (e.id === 'rpc-genesis') return rpc && e.scope.method === 'getGenesisHash';
  if (e.id === 'rpc-account') return rpc && e.scope.method === 'getAccountInfo' && e.scope.commitment === 'finalized' && e.scope.slot === record.floorSlot;
  if (e.id === 'pump-pool-config') return e.sourceId === 'pumpswap-direct' && e.sourceType === 'JSON_RPC' && e.accessMode === 'PUBLIC_API' && e.scope.operation === 'pump-pool-config' && e.scope.mint === record.token.address;
  if (e.id === 'dex-pairs') return (e.sourceId === 'dexscreener' && e.accessMode === 'PUBLIC_API') || (e.sourceId === 'tinyfish-fetch' && e.scope.method === 'tinyfish-live-dex-json-v1');
  return false;
}

/**
 * Narrow guard: a KNOWN legacy native Pump O08 is contradicted by its own retained null primary pool receipt,
 * whatever poolAddress it claims, so a stripped provenance bundle rewritten to a legacy version cannot escape.
 * Genuine named curve/DAMM fallback versions stay exempt.
 */
function selectedFallback(bundle: LiveBundle, version: string): boolean {
  const parse = (id: string): unknown => { try { return JSON.parse(bundle.rawArtifacts[id] ?? 'null'); } catch { return null; } };
  const packet = parse('shared-derivation');
  if (!obj(packet) || !obj(packet.venueInspection) || packet.venueInspection.version !== version) return false;
  const engaged = (id: string) => bundle.rawArtifacts[id] !== undefined && bundle.evidence.some(e => e.id === id);
  const curve = parse('venue-route-selection'), damm = parse('damm-route-selection');
  if (engaged('venue-route-selection') && obj(curve) && curve.method === 'pump-venue-selection-v1' && curve.selected === 'BONDING_CURVE' && curve.primaryStateId === 'pump-pool-config') { validateCurveBundle(bundle); return true; }
  if (engaged('damm-route-selection') && obj(damm) && damm.method === 'verified-native-route-v1' && damm.selected === 'METEORA_DAMM_V2') { validateDammBundle(bundle); return true; }
  return false;
}

function rejectContradictedLegacy(bundle: LiveBundle, o08: BaselineAssessment | undefined, features: FeatureResult[]): void {
  if (bundle.token.chain !== 'solana') return;
  const f08 = features.find(f => f.id === 'O08');
  const known = (o08?.quality === 'KNOWN' && obj(o08.data)) || (f08?.quality === 'KNOWN' && f08.value === true);
  if (!known) return;
  const version = o08 && obj(o08.data) ? o08.data.version : undefined;
  if (typeof version === 'string' && NATIVE_FALLBACK_VERSIONS.has(version) && selectedFallback(bundle, version)) return;
  const raw = bundle.rawArtifacts['pump-pool-config'];
  if (raw === undefined || nativePrimary(raw) !== null) return;
  throw new Error('VENUE_PROVENANCE_LEGACY_CONTRADICTED');
}

export function validateVenueProvenanceBundle(bundle: LiveBundle): void {
  const raw = bundle.rawArtifacts, baseline = bundle.details?.baseline ?? [];
  const o08 = baseline.find(a => a.id === 'O08');
  if (bundle.evidence.some(e => !e.id.startsWith(PREFIX) && typeof e.scope.method === 'string' && e.scope.method.startsWith('pump-venue-provenance'))) throw new Error('VENUE_PROVENANCE_FOREIGN_METHOD');
  const owned = bundle.evidence.filter(e => e.id.startsWith(PREFIX)), ownedRaw = Object.keys(raw).filter(id => id.startsWith(PREFIX));
  const features = bundle.features ?? [];
  const marked = baseline.some(a => a.evidenceIds.some(id => id.startsWith(PREFIX)) || (obj(a.data) && (a.data.version === VERSION || (a.id === 'O08' && 'provenance' in a.data) || (typeof a.data.certificateId === 'string' && a.data.certificateId.startsWith('venue-provenance:'))))) || features.some(f => f.evidenceIds.some(id => id.startsWith(PREFIX)));
  if (!owned.length && !ownedRaw.length && !marked) { rejectContradictedLegacy(bundle, o08, features); return; }
  const ids = owned.map(e => e.id);
  if (new Set(ids).size !== ids.length || ownedRaw.length !== ids.length || ownedRaw.some(id => !ids.includes(id))) throw new Error('VENUE_PROVENANCE_ORPHAN');
  if (owned.some(e => e.scope.method !== METHOD)) throw new Error('VENUE_PROVENANCE_UNKNOWN_METHOD');
  const recordRaw = raw[RECORD_ID];
  if (!ids.includes(RECORD_ID) || recordRaw === undefined) throw new Error('VENUE_PROVENANCE_RECORD_MISSING');
  const parsed = parseJson(recordRaw);
  if (!obj(parsed)) throw new Error('VENUE_PROVENANCE_RECORD_SHAPE');
  if (parsed.method !== METHOD || parsed.version !== VERSION) throw new Error('VENUE_PROVENANCE_UNKNOWN_METHOD');
  const floorSlot = parsed.floorSlot, availableAt = parsed.availableAt, failure = parsed.failure;
  if (typeof floorSlot !== 'number' || typeof availableAt !== 'string') throw new Error('VENUE_PROVENANCE_RECORD_SHAPE');
  let failureIn: VenueProvenanceFailure | null = null;
  if (failure !== null) {
    if (!obj(failure) || typeof failure.code !== 'string' || !STAGES.some(stage => stage === failure.stage)) throw new Error('VENUE_PROVENANCE_RECORD_SHAPE');
    failureIn = { stage: failure.stage as VenueProvenanceStage, code: failure.code };
  }
  const receipts: Partial<Record<VenueProvenanceStage, VenueProvenanceReceipt>> = {};
  for (const e of owned) {
    if (e.id === RECORD_ID) continue;
    const stage = STAGES.find(s => RECEIPT_ID[s] === e.id);
    if (!stage) throw new Error('VENUE_PROVENANCE_ORPHAN');
    receipts[stage] = { raw: raw[e.id]!, retrievedAt: e.retrievedAt };
  }
  const dependency = (id: string): string | undefined => {
    const e = bundle.evidence.find(x => x.id === id), r = raw[id];
    if (!e && r === undefined) return undefined;
    if (!e || r === undefined || e.contentHash !== sha(r)) throw new Error('VENUE_PROVENANCE_DEPENDENCY');
    return r;
  };
  const expected = encodeVenueProvenance(decodeVenueProvenance({ token: bundle.token, floorSlot, recordAt: availableAt, genesisRaw: dependency('rpc-genesis'), accountRaw: dependency('rpc-account'), nativeAbsenceRaw: dependency('pump-pool-config'), dexRaw: dependency('dex-pairs'), receipts, failure: failureIn }));
  if (expected !== recordRaw) throw new Error('VENUE_PROVENANCE_RECORD_MISMATCH');
  const record = parsed as unknown as VenueProvenanceRecord;
  for (const e of owned) {
    const r = e.id === RECORD_ID ? null : record.receipts.find(x => x.id === e.id);
    if (r === undefined) throw new Error('VENUE_PROVENANCE_ORPHAN');
    const [sourceId, sourceType, accessMode, scope, at] = r ? ['pumpswap-direct', 'JSON_RPC', 'PUBLIC_API', receiptScope(record, r), r.retrievedAt] as const : ['pumpswap-derived', 'CALCULATION', 'LOCAL_DERIVED', recordScope(record), record.availableAt] as const;
    if (e.sourceId !== sourceId || e.sourceType !== sourceType || e.accessMode !== accessMode || e.adapterVersion !== 'live-v1' || e.retrievedAt !== at || e.availableAt !== at || e.contentHash !== sha(raw[e.id]!) || JSON.stringify(e.scope) !== JSON.stringify(scope)) throw new Error('VENUE_PROVENANCE_RECEIPT_BINDING');
  }
  const firstAt = Date.parse(record.receipts[0]?.retrievedAt ?? record.availableAt), recordAt = Date.parse(record.availableAt), cutoffAt = Date.parse(bundle.cutoff);
  if (![firstAt, recordAt, cutoffAt].every(t => Number.isFinite(t)) || firstAt > recordAt) throw new Error('VENUE_PROVENANCE_CLOCK');
  if (record.bindingVerified && DEPENDENCY_IDS.some(id => !record.dependencies.some(dep => dep.id === id))) throw new Error('VENUE_PROVENANCE_DEPENDENCY_MISSING');
  for (const dep of record.dependencies) {
    const e = bundle.evidence.find(x => x.id === dep.id);
    if (!e || !admittedDependency(e, record)) throw new Error('VENUE_PROVENANCE_DEPENDENCY_SOURCE');
    const at = Date.parse(e.retrievedAt), available = Date.parse(e.availableAt);
    if (!Number.isFinite(at) || !Number.isFinite(available) || at > firstAt || available > firstAt) throw new Error('VENUE_PROVENANCE_DEPENDENCY_CLOCK');
  }
  const rpcAccount = bundle.evidence.find(e => e.id === 'rpc-account');
  if (!rpcAccount || rpcAccount.scope.slot !== record.floorSlot) throw new Error('VENUE_PROVENANCE_FLOOR_SLOT');
  if (Date.parse(record.availableAt) > Date.parse(bundle.cutoff)) throw new Error('VENUE_PROVENANCE_FUTURE');
  for (const id of ['venue-route-selection', 'damm-route-selection']) {
    const marker = raw[id];
    if (marker === undefined) continue;
    const selection = parseJson(marker);
    if (!obj(selection) || (typeof selection.selected === 'string' && selection.selected !== 'UNVERIFIED' && selection.selected !== 'NONE')) throw new Error('VENUE_PROVENANCE_ROUTE_CONTRADICTION');
  }
  if (features.some(f => PROMOTION_IDS.includes(f.id) && (f.quality === 'KNOWN' || f.quality === 'STALE'))) throw new Error('VENUE_PROVENANCE_PROMOTION');
  if (!bundle.details) {
    if (features.some(f => f.id === 'O08' && (f.quality === 'KNOWN' || f.quality === 'STALE'))) throw new Error('VENUE_PROVENANCE_DETAILS_MISSING');
    return;
  }
  const inspection = venueProvenanceInspection(record), d = o08?.data;
  if (!o08 || !obj(d) || d.version !== VERSION || d.certificateId !== inspection.certificateId || d.bindingVerified !== inspection.bindingVerified || d.poolAddress !== inspection.poolAddress || d.availableAt !== inspection.availableAt || 'removableLiquidityFraction' in d || 'executionDisabled' in d || JSON.stringify(d.token) !== JSON.stringify(inspection.token) || JSON.stringify(d.evidenceIds) !== JSON.stringify(inspection.evidenceIds) || JSON.stringify(d.limitations) !== JSON.stringify(inspection.limitations) || JSON.stringify(o08.evidenceIds) !== JSON.stringify(inspection.evidenceIds)) throw new Error('VENUE_PROVENANCE_O08_DATA');
  // Exact equality apart from stop-code error overrides, including provenance: no forged extra or dropped fields.
  if (stable(withoutErrors(d)) !== stable(withoutErrors(inspection as unknown as Record<string, unknown>))) throw new Error('VENUE_PROVENANCE_O08_DATA');
  const errors = d.errors, expectedErrors = inspection.errors;
  if (!obj(errors) || Object.keys(errors).sort().join() !== Object.keys(expectedErrors).sort().join() || Object.entries(errors).some(([k, v]) => v !== expectedErrors[k] && !(typeof v === 'string' && STOP_CODE.test(v)))) throw new Error('VENUE_PROVENANCE_O08_ERRORS');
  if (!(inspection.bindingVerified ? ['KNOWN', 'STALE'] : ['MISSING']).includes(o08.quality)) throw new Error('VENUE_PROVENANCE_O08_QUALITY');
  if (o08.quality === 'KNOWN' && o08.projection !== undefined && o08.projection.value !== true) throw new Error('VENUE_PROVENANCE_O08_TTL');
  const f08 = features.find(f => f.id === 'O08');
  const inspectedEvidenceIds = JSON.stringify(inspection.evidenceIds);
  // Assessment, projection and feature must carry one quality, and expiry applies to any KNOWN copy.
  if (o08.projection !== undefined && o08.projection.quality !== o08.quality) throw new Error('VENUE_PROVENANCE_O08_FEATURE');
  if (f08 !== undefined && f08.quality !== o08.quality) throw new Error('VENUE_PROVENANCE_O08_FEATURE');
  if ([o08.quality, o08.projection?.quality, f08?.quality].includes('KNOWN') && Date.parse(bundle.cutoff) > Date.parse(record.expiresAt)) throw new Error('VENUE_PROVENANCE_O08_TTL');
  if (o08.projection !== undefined && JSON.stringify(o08.projection.evidenceIds) !== inspectedEvidenceIds) throw new Error('VENUE_PROVENANCE_O08_FEATURE');
  if (f08 && (o08.projection === undefined ? f08.quality === 'KNOWN' : f08.quality !== o08.projection.quality || f08.value !== o08.projection.value || JSON.stringify(f08.evidenceIds) !== inspectedEvidenceIds)) throw new Error('VENUE_PROVENANCE_O08_FEATURE');
  if (f08?.quality === 'KNOWN' && (!inspection.bindingVerified || f08.value !== true)) throw new Error('VENUE_PROVENANCE_O08_FEATURE');
  for (const id of ['O09', 'O10', 'O11', 'O12', 'O13', 'O14', 'O15', 'O16']) {
    const a = baseline.find(x => x.id === id);
    if (a && (a.quality === 'KNOWN' || a.data !== null)) throw new Error('VENUE_PROVENANCE_PROMOTION');
  }
}
