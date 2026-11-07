import { z } from 'zod';
import type { TokenRef } from './contracts.js';
export const criterionReviewMethod = 'criterion-review-v1' as const;
export const criterionIds = ['NAR-01','NAR-02','NAR-03','CAN-01','CAN-02','ATT-01','ATT-02','ADV-03'] as const;
export type CriterionId = typeof criterionIds[number];
export type CriterionFailure = {category:'MODEL'|'COLLECTION'|'INFRA'|'EXECUTION';code:string;validationPaths:string[]};
export const criterionPremiseKinds=['referent','interest','tokenRelation','game','mechanism','attributedOrigin','explanation','prerequisites','primaryRelationship','comparableAttention','representation','noRelevantAlternative','counterevidence','boundedReview'] as const;
export const proofSchema = z.object({
  reviewAttested:z.boolean(), suppliedSourceIds:z.array(z.string()).max(256),
  premises:z.array(z.object({kind:z.enum(criterionPremiseKinds),assertion:z.string().min(1).max(1000),citationIds:z.array(z.string()).max(16)}).strict()).max(32),
  representationWitnesses:z.array(z.object({token:z.object({chain:z.enum(['solana','bsc','base','robinhood']),address:z.string().min(1).max(128)}).strict(),narrativeCitationIds:z.array(z.string()).max(16),mintCitationIds:z.array(z.string()).max(16)}).strict()).max(32),
  posts:z.array(z.object({sourceId:z.string(),role:z.enum(['CALL','NEWS','JOKE','OTHER','UNCLEAR']),original:z.boolean(),tokenBound:z.boolean(),duplicateOf:z.string().nullable(),citationIds:z.array(z.string()).max(16)}).strict()).max(256),
  missingSupport:z.array(z.string().min(1).max(1000)).max(32),
}).strict();
export type CriterionProof = z.infer<typeof proofSchema>;
export const criterionWireRowSchema=z.object({criterionId:z.enum(criterionIds),disposition:z.enum(['SUPPORTED','CONTRADICTED','INSUFFICIENT','UNFINISHED']),rationale:z.string().max(2000),citationIds:z.array(z.string()).max(256),premises:proofSchema.shape.premises,representationWitnesses:proofSchema.shape.representationWitnesses,posts:proofSchema.shape.posts,missingSupport:proofSchema.shape.missingSupport,unfinishedReason:z.string().max(1000).nullable()}).strict();
export type CriterionWireRow=z.infer<typeof criterionWireRowSchema>;
export type CriterionIssue={path:string;code:string;offendingIds:string[];allowedIds:string[]};

export const resultSchema=z.object({criterionId:z.enum(criterionIds),scopeId:z.string().min(1),evaluationState:z.enum(['COMPLETED','UNAVAILABLE']),outcome:z.enum(['SUPPORTED','CONTRADICTED','INSUFFICIENT']).nullable(),basis:z.string().max(1000),rationale:z.string().max(2000),citationIds:z.array(z.string()).max(256),proof:proofSchema,failure:z.object({category:z.enum(['MODEL','COLLECTION','INFRA','EXECUTION']),code:z.string().min(1).max(120),validationPaths:z.array(z.string()).max(64)}).strict().nullable()}).strict();
export type CriterionResult=z.infer<typeof resultSchema>;
export type CriterionReceipt={acquisitionPurposeMethod?:'acquisition-purpose-v1';method:typeof criterionReviewMethod;token:TokenRef;policyId:'research-screen-criteria-v1'|'research-fast-v3';generationMethod?:'single-generation-v1';inputId:string;qualifiedAt:string;results:CriterionResult[]};
export const criterionReceiptSchema=z.object({acquisitionPurposeMethod:z.literal('acquisition-purpose-v1').optional(),method:z.literal(criterionReviewMethod),token:z.object({chain:z.enum(['solana','bsc','base','robinhood']),address:z.string().min(1).max(128)}).strict(),policyId:z.enum(['research-screen-criteria-v1','research-fast-v3']),generationMethod:z.literal('single-generation-v1').optional(),inputId:z.string().regex(/^[a-f0-9]{64}$/),qualifiedAt:z.iso.datetime({offset:true}),results:z.array(resultSchema).max(8)}).strict().refine(v=>(v.policyId==='research-fast-v3')===(v.generationMethod==='single-generation-v1'));

/** Stored metadata for the experimental single-generation topology. */
export const fastSingleGenerationSchema=z.object({method:z.literal('fast-single-generation-v1'),policyId:z.literal('research-fast-v3'),token:z.object({chain:z.enum(['solana','bsc','base','robinhood']),address:z.string().min(1).max(128)}).strict(),inputId:z.string().regex(/^[a-f0-9]{64}$/),frozenCutoff:z.iso.datetime({offset:true}),promptSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),promptChars:z.number().int().nonnegative(),validationSchemaSha256:z.string().regex(/^[a-f0-9]{64}$/),logicalGenerations:z.union([z.literal(0),z.literal(1)]),semanticRepairAttempts:z.literal(0),independentReview:z.literal(false),transportAttempts:z.number().int().min(0).max(6),fallbackUsed:z.boolean(),finalModel:z.string().min(1).nullable(),responseSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),inputTokens:z.number().int().nonnegative().nullable(),outputTokens:z.number().int().nonnegative().nullable(),rows:z.array(z.object({criterionId:z.enum(criterionIds),outcome:z.enum(['SUPPORTED','CONTRADICTED','INSUFFICIENT']).nullable(),category:z.enum(['MODEL','COLLECTION','INFRA','EXECUTION']).nullable(),code:z.string().max(120).nullable(),unfinishedReason:z.string().max(1000).nullable()}).strict()).max(2),observed:z.object({startedAt:z.iso.datetime({offset:true}),completedAt:z.iso.datetime({offset:true})}).strict()}).strict();
export type FastSingleGeneration=z.infer<typeof fastSingleGenerationSchema>;
