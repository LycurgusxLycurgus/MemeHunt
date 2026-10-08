import { z } from 'zod';
import { tokenRefSchema } from './contracts.js';

const decimal = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);
const timestamp = z.iso.datetime({offset:true});
const publicUrl = z.string().url().refine(value=>{try {const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}},'public HTTPS source required');
const citation = z.object({recordId:z.string(),quote:z.string().min(8).max(1000)}).strict();
export const researchRecordSchema = z.object({
  id:z.string().min(1).max(128), platform:z.string().min(1).max(64), url:publicUrl,
  text:z.string().min(1).max(12000), publishedAt:timestamp, availableAt:timestamp,
  authorId:z.string().max(128).nullable(), communityId:z.string().max(128).nullable(),
  tokenRefs:z.array(tokenRefSchema).min(1).max(10), repostOf:z.string().optional(),
  originId:z.string().max(128).optional(),
  accountCreatedAt:timestamp.optional(), activityIntervalsSeconds:z.array(z.number().nonnegative()).max(200).optional(),
  metrics:z.object({observedAt:timestamp,likes:decimal.optional(),replies:decimal.optional(),reposts:decimal.optional()}).strict().optional(),
}).strict();
const reviewSchema=z.object({
  recordId:z.string(),quote:z.string().min(8).max(1000),reviewedBy:z.string().min(1).max(128),reviewedAt:timestamp,
  methodVersion:z.literal('human-adjudication-v1'),rationale:z.string().min(8).max(1000),
  role:z.enum(['CALL','NEWS','JOKE','WARNING','RETROSPECTIVE','PRICE_ONLY','OTHER','UNCLEAR']),
  binding:z.enum(['EXACT_CONTRACT','REVIEWED_RELATION','UNRESOLVED']),entailment:z.enum(['DIRECT','INFERRED','INSUFFICIENT']),
  paidDisclosure:z.boolean().optional(),independentOriginProof:citation.optional(),
}).strict();
const narrativeSchema=z.object({
  description:z.string().min(1).max(500),game:z.enum(['VIRAL','EVENT','CREATOR','COMMUNITY','MIXED','UNKNOWN']),
  style:z.enum(['SPARK','WAVE','COMMUNITY','UNKNOWN']),citations:z.array(citation).min(1).max(10),
  reviewedBy:z.string().min(1),reviewedAt:timestamp,rationale:z.string().min(8),
  referent:z.string().min(1).max(200),interest:z.string().min(1).max(200),tokenRelation:z.string().min(1).max(200),
  prerequisites:z.array(z.string().max(200)).max(10),
  origin:z.object({citation,primary:z.boolean(),firstObservedAt:timestamp}).strict().optional(),
  catalyst:z.object({citation,kind:z.enum(['FACT','CLAIM','RUMOR']),at:timestamp.nullable(),dependency:z.string().min(1)}).strict().optional(),
  officialIdentity:z.object({citation,account:z.string(),primaryProof:citation}).strict().optional(),
  incentives:z.array(z.object({citation,kind:z.enum(['COMPENSATION','FEE_RIGHT','HOLDING','AFFILIATION'])}).strict()).max(20).default([]),
}).strict();
export const candleSchema=z.object({start:timestamp,end:timestamp,availableAt:timestamp,open:decimal,high:decimal,low:decimal,close:decimal,volumeQuote:decimal.nullable()}).strict();
export const researchPacketSchema=z.object({
  schemaVersion:z.literal(1),token:tokenRefSchema,
  records:z.array(researchRecordSchema).max(200).default([]),reviews:z.array(reviewSchema).max(200).default([]),
  corpus:z.object({query:z.string().min(1),sourceSet:z.array(z.string()).min(1),start:timestamp,end:timestamp,bucketSeconds:z.number().int().positive(),complete:z.boolean(),cap:z.number().int().min(1).max(200),coordinationBaselineFraction:decimal.optional()}).strict().optional(),
  narrative:narrativeSchema.optional(),
  competitors:z.object({query:z.string().min(1),complete:z.boolean(),candidates:z.array(z.object({token:tokenRefSchema,association:citation,reviewedBy:z.string().min(1),identityEvidence:citation}).strict()).min(1).max(10)}).strict().optional(),
  candles:z.object({market:z.string().min(1),quote:z.string().min(1),intervalSeconds:z.number().int().positive(),leftBars:z.number().int().min(1).max(50),rightBars:z.number().int().min(1).max(50),comparisonToleranceBps:decimal,bars:z.array(candleSchema).max(1000),chartCondition:z.enum(['UP','DOWN','RANGE','MIXED']).optional()}).strict().optional(),
  context:z.object({
    window:z.object({start:timestamp,end:timestamp,availableAt:timestamp}).strict(),
    chainVolumes:z.array(z.object({chain:z.enum(['solana','bsc','base','robinhood']),usd:decimal,complete:z.boolean(),previousUsd:decimal.optional()}).strict()).max(4).default([]),
    bridges:z.array(z.object({canonicalId:z.string().min(1),from:z.string(),to:z.string(),usd:decimal,completedAt:timestamp.nullable(),finalized:z.boolean()}).strict()).max(200).default([]),
    bridgeComplete:z.boolean().default(false),
    macro:z.array(z.object({instrument:z.enum(['BTC','ETH','SOL']),quote:z.literal('USD'),bars:z.array(candleSchema).max(1000)}).strict()).max(3).default([]),
    launch:z.object({source:z.string(),launches:z.number().int().nonnegative(),migrations:z.number().int().nonnegative(),volumeUsd:decimal.nullable(),feesUsd:decimal.nullable(),revenueUsd:decimal.nullable(),cohortEnd:timestamp.nullable(),followupSeconds:z.number().int().positive().nullable(),survivors:z.number().int().nonnegative().nullable(),complete:z.boolean()}).strict().optional(),
  }).strict().optional(),
}).strict();
export type ResearchPacket=z.infer<typeof researchPacketSchema>;
export type ResearchRecord=z.infer<typeof researchRecordSchema>;
