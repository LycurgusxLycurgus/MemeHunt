import { z } from 'zod';

export const qualityStateSchema = z.enum(['KNOWN', 'MISSING', 'STALE', 'CONFLICT', 'UNSUPPORTED', 'TRUNCATED', 'INVALID']);
export type QualityState = z.infer<typeof qualityStateSchema>;
export const chainSchema = z.enum(['solana', 'bsc', 'base', 'robinhood']);
export const tokenRefSchema = z.object({ chain: chainSchema, address: z.string().min(1).max(128) }).strict();
export type TokenRef = z.infer<typeof tokenRefSchema>;
export const evidenceRecordSchema = z.object({
  id: z.string().min(1).max(128), sourceId: z.string().min(1).max(128), sourceType: z.string().min(1).max(64),
  retrievedAt: z.iso.datetime({ offset: true }), availableAt: z.iso.datetime({ offset: true }),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/), adapterVersion: z.string().min(1),
  accessMode: z.enum(['PUBLIC_API', 'FREE_ACCOUNT', 'USER_IMPORT', 'LOCAL_DERIVED', 'PAID_API']),
  scope: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;
export const observationSchema = z.object({
  id: z.string().min(1), subject: tokenRefSchema, field: z.string().min(1), value: z.union([z.string(), z.boolean(), z.null()]),
  unit: z.string().min(1), evidenceIds: z.array(z.string()).min(1), observedAt: z.iso.datetime({ offset: true }),
  availableAt: z.iso.datetime({ offset: true }), quality: qualityStateSchema,
}).strict();
export type Observation = z.infer<typeof observationSchema>;
export const featureResultSchema = z.object({
  id: z.string().min(1), value: z.union([z.string(), z.boolean(), z.null()]), unit: z.string().min(1),
  quality: qualityStateSchema, availableAt: z.iso.datetime({ offset: true }), evidenceIds: z.array(z.string()),
  applicability: z.enum(['APPLICABLE', 'NOT_APPLICABLE', 'UNRESOLVED']).default('APPLICABLE'),
}).strict();
export type FeatureResult = z.infer<typeof featureResultSchema>;
export const predicateSchema: z.ZodType<Predicate> = z.lazy(() => z.union([
  z.object({ op: z.enum(['lt', 'lte', 'gt', 'gte', 'eq']), feature: z.string().min(1), value: z.union([z.string(), z.boolean()]), unit: z.string().min(1) }).strict(),
  z.object({ op: z.enum(['all', 'any']), children: z.array(predicateSchema).min(1) }).strict(),
]));
export type Predicate = { op: 'lt' | 'lte' | 'gt' | 'gte' | 'eq'; feature: string; value: string | boolean; unit: string } | { op: 'all' | 'any'; children: Predicate[] };
export const profileSchema = z.object({
  id: z.string().min(1), sizeUsd: z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/).optional(), horizonSeconds: z.number().int().positive().optional(), risk: z.record(z.string(), z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/)).default({}),
  /** Weakest exit proof management accepts: QUOTED accepts quotes and simulations, SIMULATED only simulations. Absent means no exact exit can be confirmed. */
  exitProofLevel: z.enum(['QUOTED', 'SIMULATED']).optional(),
  stage: z.object({ ageBands: z.array(z.object({ name: z.string(), minSeconds: z.number().int().nonnegative(), maxSeconds: z.number().int().positive().nullable() })).default([]) }).default({ ageBands: [] }),
}).strict().superRefine((p, ctx) => {
  if (p.sizeUsd !== undefined && Number(p.sizeUsd) <= 0) ctx.addIssue({ code: 'custom', message: 'sizeUsd must be positive' });
  for (const k of ['maxTransferFeeBps','maxEntryImpactBps','maxExitImpactBps','maxRoundTripLossBps']) if (p.risk[k] !== undefined && Number(p.risk[k]) > 10000) ctx.addIssue({ code: 'custom', message: `${k} must be at most 10000 bps` });
  for (const k of ['maxDirectControlShare','maxRemovableLiquidityShare']) if (p.risk[k] !== undefined && Number(p.risk[k]) > 1) ctx.addIssue({ code: 'custom', message: `${k} must be at most 1` });
  let next = 0;
  for (const [index,b] of p.stage.ageBands.entries()) {
    if (b.minSeconds !== next || (b.maxSeconds !== null && b.maxSeconds <= b.minSeconds) || (b.maxSeconds === null && index !== p.stage.ageBands.length-1)) ctx.addIssue({ code: 'custom', message: 'ageBands must be ordered, contiguous and end with an open band' });
    if (b.maxSeconds !== null) next = b.maxSeconds;
  }
  if (p.stage.ageBands.length && p.stage.ageBands.at(-1)?.maxSeconds !== null) ctx.addIssue({ code: 'custom', message: 'ageBands must cover all ages' });
});
export type Profile = z.infer<typeof profileSchema>;
export const exitLegSchema = z.object({ id: z.string().min(1), quantityBps: z.number().int().min(1).max(10000).nullable(), allRemaining: z.boolean(), trigger: predicateSchema });
export const thesisSchema = z.object({
  support: z.array(predicateSchema).min(1), invalidation: z.array(predicateSchema).min(1),
  catalyst: predicateSchema.nullable().default(null), expiryAt: z.iso.datetime({ offset: true }).nullable().default(null),
  onchainTraction: predicateSchema.nullable().default(null), externalTraction: predicateSchema.nullable().default(null),
  warning: predicateSchema.nullable().default(null), legs: z.array(exitLegSchema).default([]),
}).strict().superRefine((t, ctx) => {
  if (new Set(t.legs.map(l => l.id)).size !== t.legs.length) ctx.addIssue({ code: 'custom', message: 'duplicate exit leg ID' });
  if (t.legs.some((l,i) => l.allRemaining ? l.quantityBps !== null || i !== t.legs.length-1 : l.quantityBps === null)) ctx.addIssue({ code: 'custom', message: 'invalid ordered exit leg quantities' });
  if (t.legs.reduce((s,l) => s + (l.quantityBps ?? 0), 0) > 10000) ctx.addIssue({ code: 'custom', message: 'exit percentages exceed original quantity' });
});
export type Thesis = z.infer<typeof thesisSchema>;
export type EntryCheckResult = { checkId: string; checklistKind: 'ENTRY'; role: 'HARD_GATE' | 'REQUIRED_EVIDENCE' | 'OPPORTUNITY' | 'ADVISORY'; pillar: 'ONCHAIN' | 'ATTENTION' | 'SOCIAL' | 'SHARED'; required: boolean; status: 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_APPLICABLE'; reasonCode: string; featureRefs: string[]; evidenceRefs: string[] };
export type EntryCheckDefinition = Pick<EntryCheckResult, 'checkId' | 'role' | 'pillar' | 'required'> & { featureIds: string[] };
export type ManagementCheckDefinition = { checkId: string; managementRole: string; requiredFor: 'THESIS' | 'QUANTIFIED_PROPOSAL' | 'CONTEXT' | 'WARNING' };
export type ManagementBasisRef = { kind: 'EPISODE' | 'BASELINE_SNAPSHOT' | 'THESIS_FIELD' | 'EXIT_LEG' | 'PROFILE_FIELD' | 'STAGE_INPUT' | 'POSITION' | 'LEDGER_REVISION' | 'ENTRY_CHECK' | 'EXECUTION_BASIS' | 'EXIT_PROOF'; ref: string };
export type ManagementCheckResult = { checkId: string; checklistKind: 'MANAGEMENT'; managementRole: string; requiredFor: 'THESIS' | 'QUANTIFIED_PROPOSAL' | 'CONTEXT' | 'WARNING'; status: 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_APPLICABLE'; reasonCode: string; featureRefs: string[]; evidenceRefs: string[]; basisRefs?: ManagementBasisRef[] };
export type EntryResult = { checks: EntryCheckResult[]; binary: 'PASS' | 'FAIL'; classification: 'RESEARCH_ELIGIBLE' | 'REJECTED' | 'UNSUPPORTED' | 'INSUFFICIENT_DATA' | 'WATCH'; coverage: { known: number; total: number } };
export type ManagementResult = {
  checks: ManagementCheckResult[]; thesisState: 'INVALIDATED' | 'UNVERIFIABLE' | 'WEAKENING' | 'VALIDATED'; proposal: 'EXIT_REVIEW' | 'REASSESS_REQUIRED' | 'REDUCE_REVIEW' | 'DCA_OUT_PROPOSED' | 'MAINTAIN_THESIS';
  proposedQuantityAtomic?: string; proposedLegId?: string; remainingQuantityAtomic?: string; positionMode?: PositionRecord['mode'];
  /** v7: whether the remaining position can be sold, from its exact exit proof. An exit review never promises a fill. */
  executionFeasibility?: ExitQuoteCheck['feasibility'];
  /** v7: the position every amount above is measured against, or explicitly none. */
  position?: PositionContext;
  /** v7: each exact exit quote management needs, with the request shown even when no proof was supplied. */
  exitQuotes?: ExitQuoteCheck[];
};
export const executionBasisRefSchema = z.object({ version: z.string().min(1).max(64), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type ExecutionBasisRef = z.infer<typeof executionBasisRefSchema>;
export type PositionContext =
  | { status: 'NONE' }
  | {
    status: 'KNOWN'; positionId: string; mode: PositionRecord['mode']; units: 'ATOMIC'; decimals: number;
    initialQuantityAtomic: string; remainingQuantityAtomic: string;
    /** Remaining cost in quoteCurrency; null when any cost is unknown. */
    knownCost: string | null; quoteCurrency: string;
    planBasis: { mode: 'ORIGIN' | PlanBasisDeclaration['mode']; anchorAt: string | null; baseQuantityAtomic: string } | { mode: 'UNRESOLVED' };
    executionBasis: ExecutionBasisRef;
  };
export type ExitQuoteRequest = {
  /** CANDIDATE_LEG is the due step; NEXT_LEG is the next planned step while none is due, quoted early so a hold is checkable too. */
  purpose: 'REMAINING_POSITION' | 'CANDIDATE_LEG' | 'NEXT_LEG'; token: TokenRef | null; caseId: string; episodeId: string; positionId: string;
  legId: string | null; quantityAtomic: string; decimals: number; executionBasis: ExecutionBasisRef;
};
export type ExitQuoteCheck = {
  request: ExitQuoteRequest; status: 'PASS' | 'FAIL' | 'UNKNOWN'; feasibility: 'FILLABLE' | 'BLOCKED' | 'OVER_LIMIT' | 'UNKNOWN';
  reasonCode: string; proofIds: string[]; trust: 'VERIFIED' | 'SCENARIO' | null; label: string | null;
  /** The most conservative agreeing fillable quote, in atomic units of its output asset. */
  quote: { outputAsset: string; outputDecimals: number; expectedOutputAtomic: string; minimumOutputAtomic: string; feesInOutputAtomic: string; priceImpactBps: string } | null;
};
export const positionEventSchema = z.object({ id: z.string().min(1), kind: z.enum(['BUY_REPORTED','SELL_REPORTED','FEE_REPORTED','TRANSFER_ADJUSTMENT','CORRECTION']), quantityAtomic: z.string().regex(/^(0|[1-9]\d*)$/), quoteAmount: z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/), effectiveAt: z.iso.datetime({ offset: true }), recordedAt: z.iso.datetime({ offset: true }), idempotencyKey: z.string().min(1), legId: z.string().optional(), replacesId: z.string().optional(), feeIncluded: z.boolean().optional(), direction: z.enum(['IN','OUT']).optional() }).strict();
export type PositionEvent = z.infer<typeof positionEventSchema>;
export const positionRecordSchema = z.object({ id: z.string().min(1), caseId: z.string().min(1), mode: z.enum(['MANUAL_REPORTED','HYPOTHETICAL']), initialQuantityAtomic: z.string().regex(/^[1-9]\d*$/), initialCost: z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/).nullable(), quoteCurrency: z.string().min(1), decimals: z.number().int().min(0).max(36), entryAt: z.iso.datetime({ offset: true }), recordedAt: z.iso.datetime({ offset: true }) }).strict().superRefine((p, ctx) => { if (Date.parse(p.recordedAt) < Date.parse(p.entryAt)) ctx.addIssue({ code: 'custom', message: 'position recordedAt precedes entryAt' }); });
export type PositionRecord = z.infer<typeof positionRecordSchema>;
/**
 * How a successor's sell plan is measured. CONTINUE: same leg IDs keep their sales and shares stay on the predecessor's base.
 * FRESH_START: shares rebase to the inventory held at anchorAt and only later sales count. anchorAt null means the position's origin.
 */
export type PlanBasisDeclaration = { mode: 'CONTINUE' | 'FRESH_START'; anchorAt: string | null };
export type ThesisEpisode = { id: string; caseId: string; baselineSnapshotId: string; thesis: Thesis; createdAt: string; supersedesEpisodeId?: string; planBasis?: PlanBasisDeclaration };
export type EntrySnapshot = { id: string; caseId: string; checklistKind: 'ENTRY'; token: TokenRef; cutoff: string; analysisKind: 'FIXTURE' | 'USER_IMPORT' | 'MANUAL_EMPTY' | 'LIVE'; features: FeatureResult[]; evidence: EvidenceRecord[]; result: EntryResult; hash: string };
export type ManagementSnapshot = { id: string; checklistKind: 'MANAGEMENT'; caseId: string; episodeId: string; baselineSnapshotId: string; cutoff: string; features: FeatureResult[]; evidence: EvidenceRecord[]; result: ManagementResult; hash: string };
const atomicPositive = z.string().regex(/^[1-9]\d*$/), atomicAmount = z.string().regex(/^(0|[1-9]\d*)$/), instant = z.iso.datetime({ offset: true });
const exitFeeSchema = z.object({
  asset: z.string().min(1).max(64), decimals: z.number().int().min(0).max(36), amountAtomic: atomicAmount, includedInOutput: z.boolean(),
  /** The fee expressed in the output asset, required for an excluded fee in another asset and backed by conversionEvidenceIds. */
  outputAmountAtomic: atomicAmount.nullable().default(null), conversionEvidenceIds: z.array(z.string().min(1)).max(8).default([]),
}).strict();
const exitProofFields = {
  id: z.string().min(1).max(128), purpose: z.enum(['REMAINING_POSITION', 'CANDIDATE_LEG', 'NEXT_LEG']), token: tokenRefSchema,
  caseId: z.string().min(1).max(128), episodeId: z.string().min(1).max(128), positionId: z.string().min(1).max(128), legId: z.string().min(1).max(128).nullable(),
  quantityAtomic: atomicPositive, decimals: z.number().int().min(0).max(36), executionBasis: executionBasisRefSchema,
  level: z.enum(['QUOTED', 'SIMULATED']), route: z.object({ adapter: z.string().min(1).max(128), venue: z.string().min(1).max(128) }).strict(),
  asOf: instant, availableAt: instant, expiresAt: instant, evidenceIds: z.array(z.string().min(1)).min(1).max(32),
};
/**
 * Exact-quantity exit evidence for one quote request. FILLABLE states what the sale yields; BLOCKED states that a supported route cannot fill it,
 * for this quantity or for the token. Missing evidence is no proof at all, never a BLOCKED one.
 */
export const exitProofSchema = z.discriminatedUnion('outcome', [
  z.object({
    ...exitProofFields, outcome: z.literal('FILLABLE'),
    output: z.object({
      asset: z.string().min(1).max(64), decimals: z.number().int().min(0).max(36), expectedAtomic: atomicPositive, minimumAtomic: atomicPositive,
      priceImpactBps: z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/), slippageToleranceBps: z.number().int().min(0).max(10000).nullable().default(null),
    }).strict(),
    fees: z.array(exitFeeSchema).max(16).default([]),
  }).strict(),
  z.object({ ...exitProofFields, outcome: z.literal('BLOCKED'), blockedScope: z.enum(['QUANTITY', 'TOKEN']), blockedReason: z.string().min(1).max(256) }).strict(),
]).superRefine((p, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if ((p.purpose !== 'REMAINING_POSITION') !== (p.legId !== null)) issue('a candidate-leg or next-leg proof names its leg and a remaining-position proof names none');
  if (Date.parse(p.asOf) > Date.parse(p.availableAt) || Date.parse(p.availableAt) >= Date.parse(p.expiresAt)) issue('exit proof times must satisfy asOf <= availableAt < expiresAt');
  if (p.outcome !== 'FILLABLE') return;
  const expected = BigInt(p.output.expectedAtomic), minimum = BigInt(p.output.minimumAtomic), slippage = p.output.slippageToleranceBps;
  if (minimum > expected) issue('minimum output exceeds expected output');
  if (slippage !== null && minimum * 10000n < expected * BigInt(10000 - slippage)) issue('minimum output is below the declared slippage tolerance');
  if (Number(p.output.priceImpactBps) > 10000) issue('price impact must be at most 10000 bps');
  if (p.fees.some(f => f.asset === p.output.asset && f.decimals !== p.output.decimals)) issue('a fee in the output asset must use its decimals');
});
export type ExitProof = z.infer<typeof exitProofSchema>;
export const bundleSchema = z.object({ token: tokenRefSchema, cutoff: z.iso.datetime({ offset: true }), analysisKind: z.enum(['FIXTURE', 'USER_IMPORT', 'MANUAL_EMPTY']), evidence: z.array(evidenceRecordSchema), rawArtifacts: z.record(z.string(), z.string()).optional(), observations: z.array(observationSchema).default([]), features: z.array(featureResultSchema), profile: profileSchema, thesis: thesisSchema.optional(), exitProofs: z.array(exitProofSchema).max(16).optional() }).strict();
export type Bundle = z.infer<typeof bundleSchema>;
