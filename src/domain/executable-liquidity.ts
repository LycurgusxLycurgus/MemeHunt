import type { QualityState, TokenRef } from './contracts.js';

/** Executable sell capacity boundary shared by core and the DLMM/DAMM adapters. Pure data: no providers, no network, no BN/Buffer/PublicKey. */

/** Unsigned decimal integer string /^(0|[1-9][0-9]*)$/ in raw token atoms; never a JS number. */
export type Atomic = string;
/** Exact rational num/den as Atomic strings, den positive, not reduced. */
export type Rational = { readonly num: Atomic; readonly den: Atomic };
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type ExecLiqVenue = 'PUMPSWAP' | 'DLMM' | 'DAMM_V2';

/** One JSON-RPC base64 account body exactly as returned by getMultipleAccounts/getProgramAccounts; core validates the shape first. */
export type RpcAccount = { readonly data: readonly [string, 'base64']; readonly executable: boolean; readonly lamports: number; readonly owner: string; readonly rentEpoch?: number; readonly space?: number };
/** Base58 key to body. null: read and observed missing. Absent property: not read. */
export type RawAccountMap = Readonly<Record<string, RpcAccount | null>>;
/** The decoded 40-byte Clock sysvar of the same bank, all safe integers. */
export type SolanaClock = { readonly slot: number; readonly epochStartTimestamp: number; readonly epoch: number; readonly leaderScheduleEpoch: number; readonly unixTimestamp: number };
/** One finalized coherent bank: response context slot, its Clock and every requested key (null for returned nulls). */
export type CoherentBank = { readonly slot: number; readonly clock: SolanaClock; readonly accounts: RawAccountMap };

export type ExecLiqReason =
  | 'ACCOUNT_NOT_READ' | 'ACCOUNT_NULL' | 'ACCOUNT_SHAPE' | 'ACCOUNT_BINDING'
  | 'LAYOUT_UNSUPPORTED' | 'MODE_UNSUPPORTED' | 'TOKEN_MODE_UNSUPPORTED' | 'NOT_TARGET_ROUTE' | 'ROUTE_DISABLED'
  | 'KEY_SET_OPEN' | 'CLOCK_MISMATCH' | 'BIN_COVERAGE_INCOMPLETE' | 'MAX_UNPROVED' | 'OUTPUT_BACKING_INSUFFICIENT' | 'ARITHMETIC_RANGE'
  | `DLMM_${Uppercase<string>}` | `DAMM_${Uppercase<string>}` | `PUMP_${Uppercase<string>}`;

export type RouteMeta = {
  readonly outputMint: string;
  /** FIRST is tokenX (DLMM) or tokenA (DAMM/Pump base); the target mint is always the input. */
  readonly direction: 'FIRST_TO_SECOND' | 'SECOND_TO_FIRST';
  readonly vaults: { readonly input: string; readonly output: string };
  /** Owners of the input/output mint bodies; null until both are read. */
  readonly tokenPrograms: { readonly input: string; readonly output: string } | null;
};

/** Phase A: deterministic key plan from whatever map core holds. Keys sorted ascending (code units), unique; Clock is excluded and always added by core. */
export type RoutePlan = {
  readonly venue: ExecLiqVenue;
  readonly programId: string;
  readonly pool: string;
  readonly targetMint: string;
  /** Null until the pool body is present and admitted. */
  readonly route: RouteMeta | null;
  /** Fixed route keys known so far: pool, both mints, both vaults, the DLMM bitmap-extension PDA, any venue config the quote reads. */
  readonly requiredKeys: readonly string[];
  /** Dynamically derived keys, disjoint from requiredKeys and uncapped: DLMM bin arrays flagged by the pool bitmap and a decoded extension in the sell direction. */
  readonly additionalKeys: readonly string[];
  /** Planned keys absent from the map; core reads every one. */
  readonly missingKeys: readonly string[];
  /** Planned keys observed null; solve decides meaning (null extension proves no extension bits, a null flagged array is a coverage gap). */
  readonly nullKeys: readonly string[];
  /** True while an unread body (pool, mint, extension) may still add keys. */
  readonly open: boolean;
  /** Raw-state-owned mutable keys (pool, reserve vaults, bin arrays), a subset of the planned keys; shared readonly mints/configs never appear. */
  readonly mutableKeys: readonly string[];
  /** Terminal strict non-admission; core keeps the route visible and non-KNOWN. */
  readonly rejected: ExecLiqReason | null;
};

export type ExecLiqRouteInput = { readonly token: TokenRef; readonly pool: string };
export type ExecLiqPlanInput = ExecLiqRouteInput & { readonly accounts: RawAccountMap };
export type ExecLiqQuoteInput = ExecLiqRouteInput & { readonly bank: CoherentBank; readonly inputAtoms: Atomic };
/** impactBps is the integer L in [0,10000] of N*den*10000 >= x*num*(10000-L). */
export type ExecLiqSolveInput = ExecLiqRouteInput & { readonly bank: CoherentBank; readonly impactBps: number };

/** One exact-in sell of inputAtoms debited from the seller. netAtoms is received after quoted trading and transfer fees. complete=false is a partial fill and never admissible. */
export type RouteQuote = {
  readonly inputAtoms: Atomic; readonly consumedAtoms: Atomic; readonly netAtoms: Atomic; readonly complete: boolean;
  readonly fees: { readonly tradingInputAtoms: Atomic; readonly tradingOutputAtoms: Atomic; readonly transferInputAtoms: Atomic; readonly transferOutputAtoms: Atomic };
};

export type CapacityWitness = {
  readonly role: 'CHOSEN' | 'BELOW_CHOSEN' | 'MAX_ADMISSIBLE' | 'ABOVE_MAX_ADMISSIBLE' | 'DOMAIN_END' | 'BOUNDARY';
  readonly inputAtoms: Atomic; readonly netAtoms: Atomic; readonly complete: boolean; readonly admissible: boolean;
};
export type CapacityCertificate = {
  readonly kind: `${'DLMM' | 'DAMM' | 'PUMP'}_${Uppercase<string>}`;
  /** True only when the recorded argument excludes every other supported input from exceeding the chosen net or attaining it with less input. */
  readonly maximal: boolean;
  /** Largest fully consumable input; null when not bounded by the bank state. */
  readonly domainEndAtoms: Atomic | null;
  /** Points core re-quotes; each recomputation must match exactly. */
  readonly witnesses: readonly CapacityWitness[];
  /** Venue proof data (segments, layers, coverage, rounding holes, L0, EXHAUSTIVE_PHYS), JSON only and recomputable from the bank. */
  readonly diagnostics: { readonly [key: string]: JsonValue };
};

export type VaultBalance = { readonly address: string; readonly mint: string; readonly tokenProgram: string; readonly amountAtoms: Atomic };
/** p0 is pretrade output atoms per input atom without fees; amountAtoms is the token amount, never lamports. */
export type RouteFacts = {
  readonly p0: Rational;
  readonly decimals: { readonly input: number; readonly output: number };
  readonly vaults: { readonly input: VaultBalance; readonly output: VaultBalance };
};
export type ZeroReason = 'ZERO_LIQUIDITY' | 'EMPTY_OUTPUT_SIDE' | 'NO_ADMISSIBLE_INPUT';
export type RouteOutcome =
  | { readonly status: 'KNOWN'; readonly netAtoms: Atomic; readonly inputAtoms: Atomic; readonly maxAdmissibleInputAtoms: Atomic | null; readonly zero: ZeroReason | null; readonly facts: RouteFacts; readonly certificate: CapacityCertificate }
  | { readonly status: Exclude<QualityState, 'KNOWN'>; readonly reasons: readonly [ExecLiqReason, ...ExecLiqReason[]]; readonly facts: RouteFacts | null; readonly certificate: CapacityCertificate | null };

/** Phase B: pure solve on one final bank. plan is recomputed from bank.accounts alone. */
export type RouteSolve = {
  readonly adapterVersion: string;
  readonly plan: RoutePlan;
  readonly bankSlot: number;
  readonly clock: SolanaClock;
  readonly impactBps: number;
  readonly outcome: RouteOutcome;
};

import { z } from 'zod';

/* executable-sell-capacity-v1 core boundary: frozen constants and strict schemas of the retained facts and request artifacts.
   contracts.ts imports this module at runtime for AssessmentDetails.executableLiquidity, so this module imports contracts.ts for types only. */

export const EXEC_LIQ_METHOD = 'executable-sell-capacity-v1';
export const EXEC_LIQ_DEFINITIONS_VERSION = 'enumerated-direct-route-local-average-impact-v1';
export const EXEC_LIQ_CASH_SET = 'SOLANA_CASH_OUTPUT_SET_V1';
/** The frozen L. Adapters accept any integer L; retained facts carry only this one. */
export const EXEC_LIQ_IMPACT_BPS = 300;
/** expiresAt = min(bank Clock, needed USD observation) + this, judged at the original cutoff. */
export const EXEC_LIQ_EXPIRY_SECONDS = 30;
/** Keys per getMultipleAccounts request; a larger bank is several parts with one identical slot and Clock. */
export const EXEC_LIQ_MAX_BANK_KEYS = 100;
export const EXEC_LIQ_CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111';
/** Solana mainnet-beta genesis hash. Duplicates SOLANA_MAINNET_GENESIS of src/providers/solana.ts on purpose: the domain never imports providers. */
export const EXEC_LIQ_MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
/** The single network-proof request of a capture, sent before the inventory frames; only a retained OK body accepted by verifyExecLiqGenesisArtifact proves mainnet. */
export const EXEC_LIQ_GENESIS_REQUEST_ID = 'genesis';
/** Explicit per-read byte limits of this feature; existing solanaRpc defaults and shared request pools stay unchanged. */
export const EXEC_LIQ_RPC_MAX_BYTES = 16_000_000;
export const EXEC_LIQ_USD_MAX_BYTES = 2_000_000;

export const EXEC_LIQ_RECORD_PREFIX = 'execliq-';
export const EXEC_LIQ_DERIVATION_ID = 'execliq-derivation';
/** Every request attempt, failed or not, is one record execliq-req-<sequence>; sequences run 1..n in send order without gaps. */
export const EXEC_LIQ_REQUEST_RECORD_PATTERN = /^execliq-req-[1-9][0-9]*$/;
export const EXEC_LIQ_SOURCE_IDS = { rpc: 'execliq-solana-rpc', usd: 'execliq-dexscreener', derivation: 'execliq-collector' } as const;
export const EXEC_LIQ_CAPTURE_ADAPTER = 'execliq-capture-v1';
export const EXEC_LIQ_REQUEST_ARTIFACT_VERSION = 'execliq-request-artifact-v1';
export const EXEC_LIQ_PROGRAMS = { PUMPSWAP: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', DLMM: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', DAMM_V2: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG' } as const satisfies Record<ExecLiqVenue, string>;
/** PUMPSWAP routes are solved by core; DLMM and DAMM_V2 by their pinned adapters. */
export const EXEC_LIQ_ROUTE_ADAPTERS = { PUMPSWAP: 'execliq-pumpswap-core-v1', DLMM: 'execliq-dlmm-sdk-1.9.14-v1', DAMM_V2: 'execliq-damm-v2-sdk-1.5.1-v1' } as const satisfies Record<ExecLiqVenue, string>;
/** Any receipt with one of these adapterVersions belongs to this feature. */
export const EXEC_LIQ_OWNED_ADAPTERS: readonly string[] = [EXEC_LIQ_METHOD, EXEC_LIQ_CAPTURE_ADAPTER, ...Object.values(EXEC_LIQ_ROUTE_ADAPTERS)];

/** SOLANA_CASH_OUTPUT_SET_V1, matched by exact mint address only, ascending by mint. */
export const EXEC_LIQ_CASH_OUTPUTS = [
  { asset: 'WBTC', mint: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh' },
  { asset: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { asset: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' },
  { asset: 'WSOL', mint: 'So11111111111111111111111111111111111111112' },
] as const;
export type ExecLiqCashAsset = typeof EXEC_LIQ_CASH_OUTPUTS[number]['asset'];
/** The one public USD request: all four cash mints in EXEC_LIQ_CASH_OUTPUTS order. No key, no other endpoint. */
export const EXEC_LIQ_USD_URL = 'https://api.dexscreener.com/tokens/v1/solana/3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v,Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB,So11111111111111111111111111111111111111112';

/** The six inventory frames: the target mint at targetOffset under the pinned discriminator. No dataSize filter; a length other than supportedDataLength stays visible. */
export const EXEC_LIQ_INVENTORY_FRAMES = [
  { frameId: 'pumpswap-first', venue: 'PUMPSWAP', programId: EXEC_LIQ_PROGRAMS.PUMPSWAP, discriminator: 'hQrXeCntzbV', side: 'FIRST', targetOffset: 43, counterOffset: 75, supportedDataLength: 301 },
  { frameId: 'pumpswap-second', venue: 'PUMPSWAP', programId: EXEC_LIQ_PROGRAMS.PUMPSWAP, discriminator: 'hQrXeCntzbV', side: 'SECOND', targetOffset: 75, counterOffset: 43, supportedDataLength: 301 },
  { frameId: 'dlmm-first', venue: 'DLMM', programId: EXEC_LIQ_PROGRAMS.DLMM, discriminator: '6XZoLajBWVJ', side: 'FIRST', targetOffset: 88, counterOffset: 120, supportedDataLength: 904 },
  { frameId: 'dlmm-second', venue: 'DLMM', programId: EXEC_LIQ_PROGRAMS.DLMM, discriminator: '6XZoLajBWVJ', side: 'SECOND', targetOffset: 120, counterOffset: 88, supportedDataLength: 904 },
  { frameId: 'damm-v2-first', venue: 'DAMM_V2', programId: EXEC_LIQ_PROGRAMS.DAMM_V2, discriminator: 'hQrXeCntzbV', side: 'FIRST', targetOffset: 168, counterOffset: 200, supportedDataLength: 1112 },
  { frameId: 'damm-v2-second', venue: 'DAMM_V2', programId: EXEC_LIQ_PROGRAMS.DAMM_V2, discriminator: 'hQrXeCntzbV', side: 'SECOND', targetOffset: 200, counterOffset: 168, supportedDataLength: 1112 },
] as const;
export type ExecLiqFrameId = typeof EXEC_LIQ_INVENTORY_FRAMES[number]['frameId'];

export const EXEC_LIQ_REJECT_CODES = ['EXEC_LIQ_CHAIN_UNSUPPORTED', 'EXEC_LIQ_FOREIGN_CITATION', 'EXEC_LIQ_ORPHAN_PROOF', 'EXEC_LIQ_DETAIL_WITHOUT_PROOF', 'EXEC_LIQ_RECORD_INVALID', 'EXEC_LIQ_ARTIFACT_INVALID', 'EXEC_LIQ_SEQUENCE_GAP', 'EXEC_LIQ_DETAILS_INVALID', 'EXEC_LIQ_TOKEN_OR_CUTOFF_MISMATCH', 'EXEC_LIQ_DERIVATION_MISMATCH', 'EXEC_LIQ_RECONSTRUCTION_MISMATCH'] as const;
export type ExecLiqRejectCode = typeof EXEC_LIQ_REJECT_CODES[number];

/** True for any receipt owned by this feature: its id prefix, source, adapter or scope method. */
export function isExecLiqOwnedRecord(e: { readonly id: string; readonly sourceId: string; readonly adapterVersion: string; readonly scope?: { readonly [key: string]: unknown } }): boolean {
  return e.id.startsWith(EXEC_LIQ_RECORD_PREFIX) || Object.values<string>(EXEC_LIQ_SOURCE_IDS).includes(e.sourceId) || EXEC_LIQ_OWNED_ADAPTERS.includes(e.adapterVersion) || e.scope?.['method'] === EXEC_LIQ_METHOD;
}

const atomic = z.string().regex(/^(0|[1-9][0-9]*)$/);
const positiveAtomic = z.string().regex(/^[1-9][0-9]*$/);
const signedInteger = z.string().regex(/^(0|-?[1-9][0-9]*)$/);
const decimalText = z.string().regex(/^(0|[1-9][0-9]*)([.][0-9]+)?$/);
const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const instant = z.iso.datetime({ offset: true });
/** zod 4 int() admits safe integers only. */
const natural = z.number().int().nonnegative();
const positiveInt = z.number().int().positive();
const decimalsSchema = z.number().int().min(0).max(255);
const httpStatus = z.number().int().min(100).max(599);
const recordId = z.string().regex(EXEC_LIQ_REQUEST_RECORD_PATTERN);
const sortedUnique = (values: readonly string[]): boolean => values.every((v, i) => i === 0 || values[i - 1]! < v);
const keyList = z.array(address).refine(sortedUnique, 'keys must be sorted ascending by code unit and unique');

export const atomicSchema = atomic;
export const rationalSchema: z.ZodType<Rational> = z.object({ num: atomic, den: positiveAtomic }).strict();
/** Exact signed rational; only weighted impact may be negative. */
export type SignedRational = { readonly num: string; readonly den: Atomic };
export const signedRationalSchema: z.ZodType<SignedRational> = z.object({ num: signedInteger, den: positiveAtomic }).strict();
/** Explicitly recursive JSON with finite numbers only. */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([z.string(), z.number().refine(Number.isFinite), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]));

const EXEC_LIQ_FIXED_REASONS = ['ACCOUNT_NOT_READ', 'ACCOUNT_NULL', 'ACCOUNT_SHAPE', 'ACCOUNT_BINDING', 'LAYOUT_UNSUPPORTED', 'MODE_UNSUPPORTED', 'TOKEN_MODE_UNSUPPORTED', 'NOT_TARGET_ROUTE', 'ROUTE_DISABLED', 'KEY_SET_OPEN', 'CLOCK_MISMATCH', 'BIN_COVERAGE_INCOMPLETE', 'MAX_UNPROVED', 'OUTPUT_BACKING_INSUFFICIENT', 'ARITHMETIC_RANGE'] as const satisfies readonly ExecLiqReason[];
const reasonPattern = new RegExp(`^(?:${EXEC_LIQ_FIXED_REASONS.join('|')}|(?:DLMM|DAMM|PUMP)_[A-Z0-9_]+)$`);
export const execLiqReasonSchema = z.custom<ExecLiqReason>(v => typeof v === 'string' && reasonPattern.test(v));
export const execLiqVenueSchema = z.enum(['PUMPSWAP', 'DLMM', 'DAMM_V2']);
export const solanaClockSchema: z.ZodType<SolanaClock> = z.object({ slot: natural, epochStartTimestamp: z.number().int(), epoch: natural, leaderScheduleEpoch: natural, unixTimestamp: z.number().int() }).strict();
/**
 * Shape gate for one returned body. lamports is arithmetic-admitted and must be a safe integer. rentEpoch and space are metadata only:
 * a u64::MAX rentEpoch arrives rounded by JSON.parse, so any finite number is accepted and it is never a math input.
 */
export const rpcAccountSchema: z.ZodType<RpcAccount> = z.object({
  data: z.tuple([z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/), z.literal('base64')]),
  executable: z.boolean(), lamports: natural, owner: address, rentEpoch: z.number().optional(), space: z.number().optional(),
}).strict();

const directionSchema = z.enum(['FIRST_TO_SECOND', 'SECOND_TO_FIRST']);
export const routeMetaSchema: z.ZodType<RouteMeta> = z.object({
  outputMint: address, direction: directionSchema, vaults: z.object({ input: address, output: address }).strict(),
  tokenPrograms: z.object({ input: address, output: address }).strict().nullable(),
}).strict();
export const routePlanSchema: z.ZodType<RoutePlan> = z.object({
  venue: execLiqVenueSchema, programId: address, pool: address, targetMint: address, route: routeMetaSchema.nullable(),
  requiredKeys: keyList, additionalKeys: keyList, missingKeys: keyList, nullKeys: keyList, open: z.boolean(), mutableKeys: keyList,
  rejected: execLiqReasonSchema.nullable(),
}).strict().superRefine((p, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  const planned = new Set([...p.requiredKeys, ...p.additionalKeys]);
  if (p.additionalKeys.some(k => p.requiredKeys.includes(k))) issue('additionalKeys are disjoint from requiredKeys');
  if ([...p.missingKeys, ...p.nullKeys, ...p.mutableKeys].some(k => !planned.has(k))) issue('missing, null and mutable keys are planned keys');
  if (p.missingKeys.some(k => p.nullKeys.includes(k))) issue('a key is either unread or observed null');
  if (planned.has(EXEC_LIQ_CLOCK_SYSVAR)) issue('the Clock is added by core, never planned');
});
const witnessSchema: z.ZodType<CapacityWitness> = z.object({
  role: z.enum(['CHOSEN', 'BELOW_CHOSEN', 'MAX_ADMISSIBLE', 'ABOVE_MAX_ADMISSIBLE', 'DOMAIN_END', 'BOUNDARY']),
  inputAtoms: atomic, netAtoms: atomic, complete: z.boolean(), admissible: z.boolean(),
}).strict();
export const capacityCertificateSchema: z.ZodType<CapacityCertificate> = z.object({
  kind: z.custom<CapacityCertificate['kind']>(v => typeof v === 'string' && /^(DLMM|DAMM|PUMP)_[A-Z0-9_]+$/.test(v)),
  maximal: z.boolean(), domainEndAtoms: atomic.nullable(), witnesses: z.array(witnessSchema), diagnostics: z.record(z.string(), jsonValueSchema),
}).strict();
const vaultBalanceSchema: z.ZodType<VaultBalance> = z.object({ address, mint: address, tokenProgram: address, amountAtoms: atomic }).strict();
export const routeFactsSchema: z.ZodType<RouteFacts> = z.object({
  p0: rationalSchema, decimals: z.object({ input: decimalsSchema, output: decimalsSchema }).strict(),
  vaults: z.object({ input: vaultBalanceSchema, output: vaultBalanceSchema }).strict(),
}).strict();
export const routeOutcomeSchema: z.ZodType<RouteOutcome> = z.union([
  z.object({
    status: z.literal('KNOWN'), netAtoms: atomic, inputAtoms: atomic, maxAdmissibleInputAtoms: atomic.nullable(),
    zero: z.enum(['ZERO_LIQUIDITY', 'EMPTY_OUTPUT_SIDE', 'NO_ADMISSIBLE_INPUT']).nullable(), facts: routeFactsSchema, certificate: capacityCertificateSchema,
  }).strict(),
  z.object({
    status: z.enum(['MISSING', 'STALE', 'CONFLICT', 'UNSUPPORTED', 'TRUNCATED', 'INVALID']), reasons: z.tuple([execLiqReasonSchema], execLiqReasonSchema),
    facts: routeFactsSchema.nullable(), certificate: capacityCertificateSchema.nullable(),
  }).strict(),
]).superRefine((o, ctx) => {
  if (o.status !== 'KNOWN') return;
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  const zeroNet = o.netAtoms === '0';
  if ((o.zero !== null) !== zeroNet) issue('a zero reason is present exactly when the maximum net is zero');
  if (zeroNet !== (o.inputAtoms === '0')) issue('the minimum input attaining the maximum net is zero exactly when that net is zero');
  if (!o.certificate.maximal) issue('KNOWN needs a maximal certificate');
  if (o.maxAdmissibleInputAtoms !== null && BigInt(o.maxAdmissibleInputAtoms) < BigInt(o.inputAtoms)) issue('the maximum admissible input is at least the chosen input');
});

export const execLiqTokenSchema = z.object({ chain: z.literal('solana'), address }).strict();
const memcmpSchema = z.object({ memcmp: z.object({ offset: natural, bytes: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{1,44}$/) }).strict() }).strict();
export const execLiqInventoryRequestSchema = z.object({
  jsonrpc: z.literal('2.0'), id: z.literal(1), method: z.literal('getProgramAccounts'),
  params: z.tuple([address, z.object({ encoding: z.literal('base64'), commitment: z.literal('finalized'), withContext: z.literal(true), minContextSlot: natural.optional(), filters: z.tuple([memcmpSchema, memcmpSchema]) }).strict()]),
}).strict();
export const execLiqAccountsRequestSchema = z.object({
  jsonrpc: z.literal('2.0'), id: z.literal(1), method: z.literal('getMultipleAccounts'),
  params: z.tuple([z.array(address).min(1).max(EXEC_LIQ_MAX_BANK_KEYS).refine(sortedUnique, 'keys must be sorted ascending by code unit and unique'), z.object({ encoding: z.literal('base64'), commitment: z.literal('finalized'), minContextSlot: natural.optional() }).strict()]),
}).strict();
export const execLiqUsdRequestSchema = z.object({ method: z.literal('GET'), url: z.literal(EXEC_LIQ_USD_URL) }).strict();
export const execLiqGenesisRequestSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.literal(1), method: z.literal('getGenesisHash'), params: z.tuple([]) }).strict();
/** The parsed OK genesis body: strict, so an error member, a wrong id or any other network's hash is rejected. */
export const execLiqGenesisResponseSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.literal(1), result: z.literal(EXEC_LIQ_MAINNET_GENESIS) }).strict();
export const execLiqRequestSchema = z.union([execLiqGenesisRequestSchema, execLiqInventoryRequestSchema, execLiqAccountsRequestSchema, execLiqUsdRequestSchema]);
export const execLiqRequestIdSchema = z.string().regex(/^(?:genesis|inventory-(?:pumpswap|dlmm|damm-v2)-(?:first|second)|discovery-[1-9][0-9]*|bank-[1-9][0-9]*-[1-9][0-9]*|usd-refs)$/);
export const execLiqFailureCodeSchema = z.enum(['NETWORK', 'DEADLINE', 'HTTP_STATUS', 'RATE_LIMITED', 'BODY_TOO_LARGE', 'BODY_INVALID', 'RPC_ERROR', 'CONTEXT_SLOT_BEHIND']);
const frameIdSchema = z.enum(['pumpswap-first', 'pumpswap-second', 'dlmm-first', 'dlmm-second', 'damm-v2-first', 'damm-v2-second']);
const roleSchema = z.enum(['GENESIS', 'INVENTORY', 'DISCOVERY', 'BANK', 'USD']);
const responseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('OK'), httpStatus: z.number().int().min(200).max(299), body: z.string() }).strict(),
  z.object({ status: z.literal('FAILED'), code: execLiqFailureCodeSchema, httpStatus: httpStatus.nullable(), body: z.string().nullable() }).strict(),
]);
const artifactBase = {
  artifactVersion: z.literal(EXEC_LIQ_REQUEST_ARTIFACT_VERSION), method: z.literal(EXEC_LIQ_METHOD), token: execLiqTokenSchema, sequence: positiveInt,
  requestId: execLiqRequestIdSchema, startedAt: instant, completedAt: instant, response: responseSchema,
};
/** The raw text of every execliq-req-<sequence> artifact is JSON.stringify of this object. The body stays the received text, so u64 fields keep their bytes; the RPC URL is never part of it. */
export const execLiqRequestArtifactSchema = z.discriminatedUnion('role', [
  z.object({ ...artifactBase, role: z.literal('GENESIS'), request: execLiqGenesisRequestSchema }).strict(),
  z.object({ ...artifactBase, role: z.literal('INVENTORY'), frameId: frameIdSchema, request: execLiqInventoryRequestSchema }).strict(),
  z.object({ ...artifactBase, role: z.literal('DISCOVERY'), round: positiveInt, request: execLiqAccountsRequestSchema }).strict(),
  z.object({ ...artifactBase, role: z.literal('BANK'), round: positiveInt, part: positiveInt, partCount: positiveInt, request: execLiqAccountsRequestSchema }).strict(),
  z.object({ ...artifactBase, role: z.literal('USD'), request: execLiqUsdRequestSchema }).strict(),
]).superRefine((a, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (Date.parse(a.startedAt) > Date.parse(a.completedAt)) issue('startedAt must not follow completedAt');
  const expected = a.role === 'GENESIS' ? EXEC_LIQ_GENESIS_REQUEST_ID : a.role === 'INVENTORY' ? `inventory-${a.frameId}` : a.role === 'DISCOVERY' ? `discovery-${a.round}` : a.role === 'BANK' ? `bank-${a.round}-${a.part}` : 'usd-refs';
  if (a.requestId !== expected) issue(`requestId must be ${expected}`);
  if (a.role === 'BANK' && (a.part > a.partCount || !a.request.params[0].includes(EXEC_LIQ_CLOCK_SYSVAR))) issue('a bank part lies within its round and reads the Clock');
  if (a.role === 'INVENTORY') {
    const frame = EXEC_LIQ_INVENTORY_FRAMES.find(f => f.frameId === a.frameId)!, [program, config] = a.request.params, [kind, target] = config.filters;
    if (program !== frame.programId || kind.memcmp.offset !== 0 || kind.memcmp.bytes !== frame.discriminator || target.memcmp.offset !== frame.targetOffset || target.memcmp.bytes !== a.token.address) issue('an inventory request is the pinned frame body for the token');
  }
});

const parseGenesisJson = (text: string): unknown => { try { return JSON.parse(text); } catch { return undefined; } };
/**
 * Mainnet proof from one retained execliq-req-<sequence> raw artifact text: a valid GENESIS artifact for the token with requestId genesis,
 * the exact getGenesisHash body, status OK and a response body that parses to exactly the mainnet genesis result. Never throws; anything else is false.
 */
export function verifyExecLiqGenesisArtifact(rawArtifact: unknown, token: ExecLiqToken): boolean {
  if (typeof rawArtifact !== 'string') return false;
  const parsed = execLiqRequestArtifactSchema.safeParse(parseGenesisJson(rawArtifact));
  if (!parsed.success) return false;
  const a = parsed.data;
  if (a.role !== 'GENESIS' || a.requestId !== EXEC_LIQ_GENESIS_REQUEST_ID || a.token.address !== token.address || a.response.status !== 'OK') return false;
  return execLiqGenesisResponseSchema.safeParse(parseGenesisJson(a.response.body)).success;
}

const attemptSchema = z.object({
  artifactId: recordId, sequence: positiveInt, status: z.enum(['OK', 'FAILED']), code: execLiqFailureCodeSchema.nullable(), httpStatus: httpStatus.nullable(), startedAt: instant, completedAt: instant,
}).strict().refine(a => (a.status === 'OK') === (a.code === null) && a.artifactId === `execliq-req-${a.sequence}`, 'an OK attempt has no code, a FAILED one has one, and its artifact is execliq-req-<sequence>');
/** Public request catalog: exact bodies and every retained attempt. Never an RPC URL or key. */
export const execLiqRequestEntrySchema = z.object({
  requestId: execLiqRequestIdSchema, role: roleSchema, transport: z.enum(['SOLANA_RPC', 'DEXSCREENER']), request: execLiqRequestSchema, attempts: z.array(attemptSchema).min(1),
}).strict().refine(q => (q.role === 'USD') === (q.transport === 'DEXSCREENER') && (q.role === 'USD') === ('url' in q.request), 'only the USD request goes to the public DEX endpoint')
  .refine(q => (q.role === 'GENESIS') === (q.request.method === 'getGenesisHash') && (q.role === 'GENESIS') === (q.requestId === EXEC_LIQ_GENESIS_REQUEST_ID), 'only the genesis entry carries the getGenesisHash body');

const notAttempted = z.union([execLiqFailureCodeSchema, z.literal('NOT_ATTEMPTED')]);
const frameSchema = z.union([
  z.object({ frameId: frameIdSchema, status: z.literal('OBSERVED'), requestId: execLiqRequestIdSchema, artifactId: recordId, contextSlot: natural, retrievedAt: instant, pools: keyList }).strict(),
  z.object({ frameId: frameIdSchema, status: z.enum(['MISSING', 'TRUNCATED', 'INVALID']), requestId: execLiqRequestIdSchema, artifactIds: z.array(recordId), code: notAttempted }).strict(),
]);
const candidateBase = { pool: address, venue: execLiqVenueSchema, programId: address, frameIds: z.array(frameIdSchema).min(1), dataLength: natural };
export const execLiqInventorySchema = z.object({
  frames: z.array(frameSchema).length(EXEC_LIQ_INVENTORY_FRAMES.length),
  /** Scope R: every returned pool, deduplicated, whose counter mint is an exact cash mint. */
  cashPools: keyList,
  excluded: z.array(z.object({ ...candidateBase, counterMint: address, reason: z.literal('OTHER_ASSET_CONVERSION') }).strict()),
  /** Returned pools whose counter mint is unreadable or that frames disagree on; possibly cash, so they block PRIMARY_KNOWN. */
  unclassified: z.array(z.object({ ...candidateBase, reason: z.enum(['COUNTER_MINT_UNREADABLE', 'FRAME_CONFLICT']) }).strict()),
  /** Context against the accepted diagnostic cash set of the frozen token only; never the scope, never a count. */
  comparison: z.object({ referenceId: z.literal('exec-liq-C5-2026-10-26-accepted-baseline'), added: keyList, vanished: keyList }).strict().nullable(),
}).strict();

export const execLiqBankSchema = z.union([
  z.object({ status: z.literal('OBSERVED'), round: positiveInt, artifactIds: z.array(recordId).min(1), slot: natural, clock: solanaClockSchema, keys: keyList, closed: z.boolean() }).strict()
    .refine(b => b.keys.includes(EXEC_LIQ_CLOCK_SYSVAR), 'the bank reads the Clock'),
  z.object({ status: z.enum(['MISSING', 'CONFLICT', 'INVALID']), code: z.enum(['NOT_ATTEMPTED', 'NO_SUCCESSFUL_ROUND', 'SLOT_MISMATCH', 'CLOCK_MISMATCH', 'CLOCK_INVALID']), artifactIds: z.array(recordId) }).strict(),
]);

const cashAssetSchema = z.enum(['WBTC', 'USDC', 'USDT', 'WSOL']);
const usdRefSchema = z.union([
  z.object({ mint: address, asset: cashAssetSchema, status: z.literal('KNOWN'), pairAddress: z.string().min(1).max(128), dexId: z.string().min(1).max(64).nullable(), priceUsdText: decimalText, priceUsd: rationalSchema, liquidityUsd: z.number().nonnegative().nullable() }).strict()
    .refine(r => r.priceUsd.num !== '0', 'a USD reference is positive'),
  z.object({ mint: address, asset: cashAssetSchema, status: z.literal('MISSING'), code: z.enum(['NO_BASE_ROW', 'NO_POSITIVE_PRICE']) }).strict(),
]);
export const execLiqUsdSchema = z.union([
  z.object({ status: z.literal('OBSERVED'), requestId: z.literal('usd-refs'), artifactId: recordId, observedAt: instant, refs: z.array(usdRefSchema) }).strict()
    .refine(u => u.refs.length === EXEC_LIQ_CASH_OUTPUTS.length && u.refs.every((r, i) => r.mint === EXEC_LIQ_CASH_OUTPUTS[i]!.mint && r.asset === EXEC_LIQ_CASH_OUTPUTS[i]!.asset), 'one reference per cash mint in EXEC_LIQ_CASH_OUTPUTS order'),
  z.object({ status: z.literal('MISSING'), requestId: z.literal('usd-refs'), artifactIds: z.array(recordId), code: notAttempted }).strict(),
]);

const domainLabel = { kind: z.literal('MINT_SUPPLY_MINUS_SCOPE_INPUT_VAULTS'), label: z.literal('HYPOTHETICAL_NOT_WALLET_AVAILABILITY') };
export const execLiqInputDomainSchema = z.union([
  z.object({ ...domainLabel, status: z.literal('KNOWN'), supplyAtoms: atomic, excludedInputVaults: z.array(z.object({ address, amountAtoms: atomic }).strict()), domainAtoms: atomic, chosenInputSumAtoms: atomic, withinDomain: z.boolean() }).strict()
    .superRefine((d, ctx) => {
      const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
      if (!sortedUnique(d.excludedInputVaults.map(v => v.address))) issue('excluded input vaults are deduplicated and sorted');
      if (BigInt(d.supplyAtoms) - d.excludedInputVaults.reduce((s, v) => s + BigInt(v.amountAtoms), 0n) !== BigInt(d.domainAtoms)) issue('domainAtoms is supply minus the excluded input vaults');
      if (d.withinDomain !== (BigInt(d.chosenInputSumAtoms) <= BigInt(d.domainAtoms))) issue('withinDomain is chosenInputSumAtoms <= domainAtoms');
    }),
  z.object({ ...domainLabel, status: z.literal('UNKNOWN'), code: z.enum(['BANK_NOT_OBSERVED', 'TARGET_MINT_UNREADABLE', 'ROUTE_FACTS_MISSING', 'VAULTS_EXCEED_SUPPLY']) }).strict(),
]);

export const execLiqRouteSchema = z.object({
  pool: address, venue: execLiqVenueSchema, programId: address, frameIds: z.array(frameIdSchema).min(1), dataLength: natural,
  outputMint: address, cashAsset: cashAssetSchema, direction: directionSchema,
  adapterVersion: z.enum([EXEC_LIQ_ROUTE_ADAPTERS.PUMPSWAP, EXEC_LIQ_ROUTE_ADAPTERS.DLMM, EXEC_LIQ_ROUTE_ADAPTERS.DAMM_V2]).nullable(),
  /** Plan recomputed from the final bank alone; null when no bank was observed. */
  plan: routePlanSchema.nullable(),
  outcome: routeOutcomeSchema,
  /** Exact USD of the chosen net and of input*p0 at the actual output asset reference; null unless KNOWN and valued (a KNOWN zero is 0/1 without a reference). */
  usd: z.object({ netUsd: rationalSchema, referenceNotionalUsd: rationalSchema }).strict().nullable(),
}).strict().superRefine((r, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (r.programId !== EXEC_LIQ_PROGRAMS[r.venue]) issue('route program is the pinned venue program');
  if (EXEC_LIQ_CASH_OUTPUTS.find(o => o.mint === r.outputMint)?.asset !== r.cashAsset) issue('route output is its exact cash mint');
  if ((r.plan === null) !== (r.adapterVersion === null) || (r.adapterVersion !== null && r.adapterVersion !== EXEC_LIQ_ROUTE_ADAPTERS[r.venue])) issue('plan and its venue adapterVersion are recorded together');
  if (r.plan !== null && (r.plan.pool !== r.pool || r.plan.venue !== r.venue || r.plan.programId !== r.programId)) issue('plan binds this route');
  if (r.outcome.status === 'KNOWN' && (r.plan === null || r.plan.rejected !== null || r.plan.open || r.plan.missingKeys.length > 0 || r.plan.route === null || r.plan.route.outputMint !== r.outputMint || r.plan.route.direction !== r.direction)) issue('a KNOWN route needs its closed admitted plan');
  if (r.outcome.status !== 'KNOWN' && r.usd !== null) issue('only a KNOWN route carries USD values');
});

const blockerSchema = z.object({
  code: z.enum(['INVENTORY_FRAME_NOT_OBSERVED', 'INVENTORY_UNCLASSIFIED', 'BANK_NOT_OBSERVED', 'ROUTE_NOT_KNOWN', 'SHARED_MUTABLE_ACCOUNT', 'USD_MISSING', 'DOMAIN_UNKNOWN', 'PRIMARY_DOMAIN_BINDING', 'STALE_AT_CUTOFF', 'NETWORK_NOT_VERIFIED']),
  subjects: z.array(z.string().min(1).max(128)).refine(sortedUnique, 'subjects are sorted and unique'),
}).strict();
const assetBase = { outputMint: address, cashAsset: cashAssetSchema, decimals: decimalsSchema };
export const execLiqAggregateSchema = z.union([
  z.object({
    status: z.literal('PRIMARY_KNOWN'),
    assets: z.array(z.object({ ...assetBase, netAtoms: atomic, routePools: keyList, usdPerUnit: rationalSchema.nullable(), netUsd: rationalSchema }).strict()),
    chosenInputSumAtoms: atomic, netUsd: rationalSchema, referenceNotionalUsd: rationalSchema,
    /** 10000*(1-netUsd/referenceNotionalUsd); null when every chosen input is zero. */
    weightedImpactBps: signedRationalSchema.nullable(),
  }).strict(),
  z.object({
    status: z.literal('NOT_PRIMARY'), blockers: z.array(blockerSchema).min(1),
    /** Sums over KNOWN routes only, labelled as such; never a completion. */
    knownSubtotals: z.array(z.object({ ...assetBase, knownSubtotalAtoms: atomic, knownPools: keyList }).strict()),
  }).strict(),
]);
export const execLiqFreshnessSchema = z.object({ bankClockAt: instant.nullable(), usdObservedAt: instant.nullable(), expiresAt: instant.nullable(), freshAtCutoff: z.boolean() }).strict()
  .refine(f => f.expiresAt !== null || !f.freshAtCutoff, 'fresh needs an expiry');

export const executableLiquidityFactsSchema = z.object({
  method: z.literal(EXEC_LIQ_METHOD), definitionsVersion: z.literal(EXEC_LIQ_DEFINITIONS_VERSION), cashSet: z.literal(EXEC_LIQ_CASH_SET),
  token: execLiqTokenSchema, cutoff: instant, impactBps: z.literal(EXEC_LIQ_IMPACT_BPS), proofLevel: z.literal('QUOTED'), expirySeconds: z.literal(EXEC_LIQ_EXPIRY_SECONDS),
  units: z.object({ atoms: z.literal('OUTPUT_MINT_ATOMS'), usd: z.literal('USD_EXACT_RATIONAL'), impact: z.literal('BPS_EXACT_RATIONAL') }).strict(),
  limitations: z.tuple([z.literal('QUOTED_TRADING_FEES_ONLY'), z.literal('NETWORK_RENT_SETUP_PRIORITY_UNWRAP_UNMODELED'), z.literal('NO_SIGNING_SEND_OR_SIMULATION'), z.literal('NOT_WALLET_AVAILABILITY'), z.literal('VAULT_BALANCES_CONTEXT_NOT_CAPACITY'), z.literal('DIRECT_ENUMERATED_ROUTES_ONLY'), z.literal('AS_OF_CUTOFF_NOT_CURRENT_PRICE')]),
  derivationId: z.literal(EXEC_LIQ_DERIVATION_ID),
  requests: z.array(execLiqRequestEntrySchema),
  inventory: execLiqInventorySchema, bank: execLiqBankSchema, usd: execLiqUsdSchema, inputDomain: execLiqInputDomainSchema,
  routes: z.array(execLiqRouteSchema), aggregate: execLiqAggregateSchema, freshness: execLiqFreshnessSchema,
}).strict().superRefine((f, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  EXEC_LIQ_INVENTORY_FRAMES.forEach((frame, i) => { if (f.inventory.frames[i]?.frameId !== frame.frameId) issue('inventory frames follow EXEC_LIQ_INVENTORY_FRAMES order'); });
  const pools = f.routes.map(r => r.pool), excluded = f.inventory.excluded.map(e => e.pool), unclassified = f.inventory.unclassified.map(u => u.pool);
  if (!sortedUnique(pools) || pools.join() !== f.inventory.cashPools.join()) issue('routes are exactly the sorted inventory cash pools');
  if (!sortedUnique(excluded) || !sortedUnique(unclassified) || new Set([...pools, ...excluded, ...unclassified]).size !== pools.length + excluded.length + unclassified.length) issue('each returned pool appears once as cash route, excluded or unclassified');
  if (new Set(f.requests.map(q => q.requestId)).size !== f.requests.length) issue('request ids are unique');
  const sequences = f.requests.flatMap(q => q.attempts.map(a => a.sequence)).sort((x, y) => x - y);
  if (sequences.some((s, i) => s !== i + 1)) issue('request attempts are numbered 1..n without gaps');
  if (f.routes.some(r => r.plan !== null) && f.bank.status !== 'OBSERVED') issue('route plans and KNOWN outcomes come from the observed bank');
  const a = f.aggregate;
  if (a.status === 'NOT_PRIMARY' && !sortedUnique(a.blockers.map(b => b.code))) issue('blockers are sorted and unique by code');
  const genesis = f.requests.find(q => q.role === 'GENESIS');
  if (genesis && f.requests.some(q => q !== genesis && q.attempts.some(x => genesis.attempts.some(g => g.sequence > x.sequence)))) issue('genesis attempts precede every other request attempt');
  if (a.status !== 'PRIMARY_KNOWN') return;
  /** Catalog shape only: the reconstruction admits PRIMARY_KNOWN solely after verifyExecLiqGenesisArtifact accepts the retained raw artifact. */
  if (!genesis || !genesis.attempts.some(x => x.status === 'OK')) issue('PRIMARY_KNOWN needs an OK genesis attempt whose retained body proves mainnet');
  if (f.inventory.frames.some(fr => fr.status !== 'OBSERVED') || f.inventory.unclassified.length > 0) issue('PRIMARY_KNOWN needs every inventory frame observed and every pool classified');
  if (f.bank.status !== 'OBSERVED' || !f.bank.closed) issue('PRIMARY_KNOWN needs one closed coherent bank');
  if (f.routes.some(r => r.outcome.status !== 'KNOWN' || r.usd === null)) issue('PRIMARY_KNOWN needs every scope route KNOWN and valued');
  if (f.inputDomain.status !== 'KNOWN' || !f.inputDomain.withinDomain) issue('PRIMARY_KNOWN needs the chosen inputs within the declared hypothetical domain');
  if (!f.freshness.freshAtCutoff) issue('PRIMARY_KNOWN is fresh at the original cutoff');
  if (a.assets.map(x => x.outputMint).join() !== [...new Set(f.routes.map(r => r.outputMint))].sort().join()) issue('assets are exactly the sorted route output mints');
  if (a.assets.some(x => x.netAtoms !== '0' && x.usdPerUnit === null)) issue('a positive asset needs its positive USD reference');
});

export type ExecLiqToken = z.infer<typeof execLiqTokenSchema>;
export type ExecLiqInventoryRequest = z.infer<typeof execLiqInventoryRequestSchema>;
export type ExecLiqAccountsRequest = z.infer<typeof execLiqAccountsRequestSchema>;
export type ExecLiqUsdRequest = z.infer<typeof execLiqUsdRequestSchema>;
export type ExecLiqGenesisRequest = z.infer<typeof execLiqGenesisRequestSchema>;
export type ExecLiqRequest = z.infer<typeof execLiqRequestSchema>;
export type ExecLiqFailureCode = z.infer<typeof execLiqFailureCodeSchema>;
export type ExecLiqRequestArtifact = z.infer<typeof execLiqRequestArtifactSchema>;
export type ExecLiqRequestEntry = z.infer<typeof execLiqRequestEntrySchema>;
export type ExecLiqInventory = z.infer<typeof execLiqInventorySchema>;
export type ExecLiqBank = z.infer<typeof execLiqBankSchema>;
export type ExecLiqUsd = z.infer<typeof execLiqUsdSchema>;
export type ExecLiqInputDomain = z.infer<typeof execLiqInputDomainSchema>;
export type ExecLiqRoute = z.infer<typeof execLiqRouteSchema>;
export type ExecLiqAggregate = z.infer<typeof execLiqAggregateSchema>;
export type ExecLiqFreshness = z.infer<typeof execLiqFreshnessSchema>;
export type ExecutableLiquidityFacts = z.infer<typeof executableLiquidityFactsSchema>;
