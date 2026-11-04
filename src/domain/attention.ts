import { primaryLeadershipOptions, validateLeadershipPositive, type LeadershipRoutes } from './leadership.js';
export { primaryLeadershipOptions, validateLeadershipPositive } from './leadership.js';
import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { PublicKey } from '@solana/web3.js';
import type { TokenRef } from './contracts.js';
import { tokenRefSchema } from './contracts.js';
import type { BaselineAssessment } from './baseline.js';
import { requiredComparisonRecoveryParents, normalizeAttentionSearchUrl, reconstructOriginAcquisition, entryEvidenceScope, terminalPostScope, type AttentionRead } from '../providers/attention.js';
import { parseSourceResponse, sourceSpans } from '../providers/source-model.js';
import { comparisonSupplementForLead, verifyOriginAlias } from '../providers/origin-recovery.js';
import { acquisitionEvidenceMethod, acquisitionScopeSchema, acquisitionCitationAllowed } from '../providers/acquisition-evidence.js';

/** Origin screening excludes later comparison recovery, but requires all original source text. */
export function originSourceScope(read:AttentionRead,token:TokenRef){
  const acquisition=reconstructOriginAcquisition(read,token),sources=read.sources.filter(s=>acquisition.sourceIds.includes(s.id));
  const searched=[1,2].every(i=>read.queries[i-1]?.includes(token.address));
  const complete=searched&&acquisition.complete&&sources.some(s=>originEntryCitationAllowed(read,s.id,token,'FAIL'));
  return {method:'bounded-origin-sources-v1' as const,complete,sourceIds:acquisition.sourceIds,acquisition};
}

export const comparisonCoverageSchema=z.object({method:z.literal('required-comparison-evidence-v1'),sourceIds:z.array(z.string()).max(64),sourceRequirements:z.array(z.object({sourceId:z.string(),obligation:z.enum(['REQUIRED','OPTIONAL_UNUSABLE_SUPPLEMENT']),parentLeadIds:z.array(z.string()).max(32),reasons:z.array(z.string()).max(12)}).strict()).max(64),batches:z.array(z.object({batch:z.number().int().positive(),sourceIds:z.array(z.string()).max(8),proposalResponseId:z.string(),reviewResponseId:z.string(),rawComplete:z.boolean(),effectiveComplete:z.boolean(),blockingSourceIds:z.array(z.string()).max(8)}).strict()).max(16),finalReviewResponseId:z.string(),complete:z.boolean()}).strict();
export type ComparisonCoverage=z.output<typeof comparisonCoverageSchema>;

const comparisonPublicSupportV1Schema=z.object({method:z.literal('comparison-public-support-v1'),criterion:z.literal('EXACT_TOKEN_REPRESENTATION_BINDING'),verdict:z.enum(['INADEQUATE','UNRESOLVED']),rationale:z.string().min(8).max(1000),citations:z.array(z.object({sourceId:z.string(),quote:z.string().min(8).max(1000)}).strict()).min(1).max(5),leadIds:z.array(z.string()).max(32),sourceIds:z.array(z.string()).max(64),batchIds:z.array(z.number().int().positive()).max(16),proposalResponseId:z.literal('attention-comparison-support-proposal-response'),reviewResponseId:z.literal('attention-comparison-final-review-response'),review:z.object({accepted:z.boolean(),rationale:z.string().min(8).max(1000)}).strict()}).strict();
const comparisonTargetSummarySchema=z.object({method:z.literal('comparison-target-context-v1'),mode:z.enum(['SUPPORTED_NARRATIVE','REVIEWED_NARRATIVE_SUPPORT_GAP','UNRESOLVED']),narrativeClaimIds:z.array(z.string()).max(5),narrativeSupportReceiptId:z.literal('attention-narrative-public-support').nullable()}).strict();
export const comparisonLeadPublicScopeSchema=z.object({leadId:z.string(),status:z.enum(['REVIEWED','UNRESOLVED']),basis:z.enum(['ORIGINAL_COMPLETE','MATCHED_ENTITY_RECOVERY','REVIEWED_MARKET_RECOVERY','NONE']),role:z.enum(['PROJECT_OR_PUBLICATION','MARKET_OR_INDEX_RECORD','UNRESOLVED']),blocker:z.enum(['NONE','MATERIAL_ASSOCIATION_CONFLICT','MISSING_NECESSARY_CONTEXT','INCOMPLETE_COLLECTION_OR_REVIEW']),rationale:z.string().min(8).max(1000),citations:z.array(z.object({sourceId:z.string(),quote:z.string().min(8).max(1000)}).strict()).min(1).max(5),review:z.object({accepted:z.boolean(),rationale:z.string().min(8).max(1000)}).strict()}).strict();
export type ComparisonLeadPublicScope=z.output<typeof comparisonLeadPublicScopeSchema>;
const comparisonSourceSupportSchema=z.object({batch:z.number().int().positive(),sourceId:z.string(),status:z.enum(['BINDING_EVIDENCE','PUBLIC_SUPPORT_GAP','CONTEXT_ONLY','UNRESOLVED']),rationale:z.string().min(8).max(1000),citations:z.array(z.object({sourceId:z.string(),quote:z.string().min(8).max(1000)}).strict()).max(3),leadIds:z.array(z.string()).max(32),accepted:z.boolean(),inspectionComplete:z.boolean()}).strict();
const entryCitation=z.object({sourceId:z.string(),quote:z.string().min(8).max(1000)}).strict();
const semanticReview=z.object({accepted:z.boolean(),rationale:z.string().min(8).max(1000)}).strict();
export const comparisonBodyObservationSchema=z.object({sourceId:z.string(),batch:z.number().int().positive(),bodyRole:z.object({kind:z.enum(['MARKET_OR_INDEX_RECORD','PROJECT_OR_PUBLICATION','OTHER_CONTEXT','UNRESOLVED']),rationale:semanticReview.shape.rationale,citations:z.array(entryCitation).max(3)}).strict(),description:z.object({kind:z.enum(['SPECIFIC_PROJECT_OR_MECHANISM','MARKET_FIELDS_OR_BOILERPLATE','DISTINCT_OTHER_SUBJECT','NO_SUBSTANTIVE_CONTENT','UNINTERPRETABLE']),rationale:semanticReview.shape.rationale,citations:z.array(entryCitation).max(3)}).strict(),review:z.object({bodyRole:semanticReview,description:semanticReview,inspectionComplete:z.boolean()}).strict()}).strict();
export const comparisonSemanticBlockerSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('MATERIAL_CONFLICT'),proposition:z.string().min(8).max(1000),sameSubjectRefs:z.array(entryCitation).min(1).max(3),affirmative:z.object({statement:z.string().min(8).max(1000),refs:z.array(entryCitation).min(1).max(3)}).strict(),contrary:z.object({statement:z.string().min(8).max(1000),refs:z.array(entryCitation).min(1).max(3)}).strict()}).strict(),
  z.object({kind:z.literal('NECESSARY_PROJECT_CONTEXT'),unreadContextId:z.string(),necessity:z.string().min(8).max(1000),rationale:semanticReview.shape.rationale,refs:z.array(entryCitation).min(1).max(3)}).strict(),
  z.object({kind:z.literal('AMBIGUOUS_RETAINED_MEANING'),question:z.string().min(8).max(1000),rationale:semanticReview.shape.rationale,refs:z.array(entryCitation).min(1).max(3)}).strict(),
]);
export const comparisonEntrySchema=z.object({leadRoles:z.record(z.string(),z.object({role:z.enum(['MARKET_OR_INDEX_RECORD','PROJECT_OR_PUBLICATION','UNRESOLVED']),rationale:semanticReview.shape.rationale,descriptorRefs:z.array(entryCitation).min(1).max(3),ownContextRefs:z.array(entryCitation).max(2)}).strict()),sourceSupport:z.record(z.string(),z.object({status:comparisonSourceSupportSchema.shape.status,rationale:semanticReview.shape.rationale,citations:z.array(entryCitation).max(3),blockerProof:comparisonSemanticBlockerSchema.nullable()}).strict()),leadBlockers:z.record(z.string(),comparisonSemanticBlockerSchema.nullable()),grade:z.object({verdict:z.enum(['INADEQUATE','UNRESOLVED']),rationale:semanticReview.shape.rationale,citations:z.array(entryCitation).min(1).max(5)}).strict()}).strict();
export const comparisonEntryReviewSchema=z.object({leadRoles:z.record(z.string(),semanticReview),sourceSupport:z.record(z.string(),semanticReview),leadBlockers:z.record(z.string(),semanticReview),grade:semanticReview}).strict();
const comparisonPublicSupportV4Schema=comparisonPublicSupportV1Schema.extend({method:z.literal('comparison-public-support-v4'),targetContext:comparisonTargetSummarySchema,leadScopes:z.array(comparisonLeadPublicScopeSchema).max(32),sourceSupport:z.array(comparisonSourceSupportSchema).max(64),bodyObservations:z.array(comparisonBodyObservationSchema).max(64),entry:comparisonEntrySchema,entryReview:comparisonEntryReviewSchema}).strict();
export const binaryEntryDecisionSchema=z.object({verdict:z.enum(['PASS','FAIL']),negativeBasis:z.enum(['FACTUAL_COUNTEREVIDENCE','PUBLIC_SUPPORT_INADEQUATE']).optional(),rationale:semanticReview.shape.rationale,citations:z.array(entryCitation).min(1).max(5)}).strict();
const comparisonPublicSupportV6Schema=comparisonPublicSupportV4Schema.extend({method:z.literal('comparison-public-support-v6'),researchComplete:z.boolean(),decision:binaryEntryDecisionSchema}).strict();
export const comparisonPublicSupportSchema=z.union([comparisonPublicSupportV6Schema,comparisonPublicSupportV1Schema,comparisonPublicSupportV1Schema.extend({method:z.literal('comparison-public-support-v2'),targetContext:comparisonTargetSummarySchema}).strict(),comparisonPublicSupportV1Schema.extend({method:z.literal('comparison-public-support-v3'),targetContext:comparisonTargetSummarySchema,leadScopes:z.array(comparisonLeadPublicScopeSchema).max(32),sourceSupport:z.array(comparisonSourceSupportSchema).max(64)}).strict(),comparisonPublicSupportV4Schema,comparisonPublicSupportV4Schema.extend({method:z.literal('comparison-public-support-v5')}).strict()]);
export type ComparisonPublicSupport=z.output<typeof comparisonPublicSupportSchema>;

export const narrativeCriterionSchema=z.enum(['NARRATIVE_DESCRIPTION','EXPLAINABLE_THESIS']);
const narrativeJudgment=z.object({verdict:z.enum(['INADEQUATE','UNRESOLVED']),rationale:z.string().min(8).max(1000),citations:z.array(z.object({sourceId:z.string(),quote:z.string().min(8).max(1000)}).strict()).min(1).max(5),review:z.object({accepted:z.boolean(),rationale:z.string().min(8).max(1000)}).strict()}).strict();
export const narrativePublicSupportSchema=z.object({method:z.literal('narrative-public-support-v1'),scope:z.object({method:z.literal('bounded-origin-sources-v1'),sourceIds:z.array(z.string()).max(64)}).strict(),sourceSupport:z.array(z.object({sourceId:z.string(),status:z.enum(['SUBSTANTIVE_SUPPORT','PUBLIC_SUPPORT_GAP','CONTEXT_ONLY','UNRESOLVED']),criteria:z.array(narrativeCriterionSchema).max(2),rationale:z.string().min(8).max(1000),citations:z.array(z.object({sourceId:z.string(),quote:z.string().min(8).max(1000)}).strict()).max(3),review:z.object({accepted:z.boolean(),rationale:z.string().min(8).max(1000),inspectionComplete:z.boolean()}).strict()}).strict()).max(64),judgments:z.object({NARRATIVE_DESCRIPTION:narrativeJudgment,EXPLAINABLE_THESIS:narrativeJudgment}).strict(),proposalResponseId:z.literal('attention-narrative-support-proposal-response'),reviewResponseId:z.literal('attention-narrative-support-review-response')}).strict();
export type NarrativePublicSupport=z.output<typeof narrativePublicSupportSchema>;
type PublicLeadDecision={accounted:boolean;accounting:{status:string;basis:string;role:string;descriptorRefs?:Array<{sourceId:string;quote:string}>};representation:{status:string;unresolvedKind?:string;citations?:Array<{sourceId:string;quote:string}>};review:Record<string,{accepted:boolean}>};
/** Collection facts are independent of the model's factual representation verdict. */
export function comparisonPublicScopeFacts(read:AttentionRead,cutoff:string,includeReviewedRole=false){
  const q=read.comparisonQualification as {recoveryCapped?:boolean;recoveryQueries?:Array<{queryId:string;parentLeadId:string;state:string;descriptorComplete:boolean;availableAt:string}>;decisions?:Array<PublicLeadDecision&{leadId:string}>};
  const fresh=(at:string)=>Number.isFinite(Date.parse(at))&&Number.isFinite(Date.parse(cutoff))&&Date.parse(at)<=Date.parse(cutoff)&&Date.parse(cutoff)-Date.parse(at)<=900000;
  const successful=(id:string)=>{try{const raw=JSON.parse(read.rawArtifacts[id]);return Array.isArray(raw.results)&&!raw.error&&(!raw.errors||Array.isArray(raw.errors)&&!raw.errors.length);}catch{return false;}};
  const records:Array<{url:string;finalUrl:string;text:string}>=[];
  for(const [id,raw] of Object.entries(read.rawArtifacts))if(/^attention-(?:(?:recovery|origin)-)?fetch-\d+(?:-retry-\d+)?$/.test(id))try{for(const r of JSON.parse(raw).results??[]){const url=normalizeAttentionSearchUrl(r.url),finalUrl=normalizeAttentionSearchUrl(r.final_url??r.url);if(url&&finalUrl&&typeof r.text==='string')records.push({url,finalUrl,text:id.startsWith('attention-origin-fetch-')?r.text.replace(/\\_/g,'_'):r.text});}}catch{/* No acquisition proof. */}
  const sourceComplete=(id:string)=>{const s=read.sources.find(s=>s.id===id);return !!s&&s.text.length<=120000&&fresh(s.availableAt)&&records.some(r=>r.finalUrl===s.url&&r.text===s.text);};
  return (read.comparisonAcquisition?.leads??[]).map(lead=>{
    const queries=(q.recoveryQueries??[]).filter(r=>r.parentLeadId===lead.id);
    const queryReady=queries.length===lead.recoveryQueryIds.length&&queries.every(r=>lead.recoveryQueryIds.includes(r.queryId)&&r.descriptorComplete&&['OBSERVED','NO_RESULTS'].includes(r.state)&&fresh(r.availableAt)&&successful(r.queryId));
    let descriptorComplete=false;try{const row=JSON.parse(read.rawArtifacts[lead.searchArtifactId]).results[lead.resultIndex];descriptorComplete=row.title===lead.title&&row.snippet===lead.snippet&&normalizeAttentionSearchUrl(row.url)===lead.url;}catch{/* Invalid descriptor. */}
    const ownRecoveryIds=new Set<string>();
    for(const r of queries)try{for(const row of JSON.parse(read.rawArtifacts[r.queryId]).results){const url=normalizeAttentionSearchUrl(row.url);for(const s of read.sources)if(s.url===url||records.some(record=>record.url===url&&record.finalUrl===s.url&&record.text===s.text))ownRecoveryIds.add(s.id);}}catch{/* Failed own query. */}
    for(const id of lead.recoverySourceIds){const s=read.sources.find(s=>s.id===id);if(s&&(read.originRecovery?.comparisonSupplementIds??[]).includes(id)&&comparisonSupplementForLead(s,lead.url))ownRecoveryIds.add(id);}
    const originalComplete=lead.acquisitionStatus==='ACQUIRED'&&lead.sourceIds.length>0&&lead.sourceIds.every(id=>{const s=read.sources.find(s=>s.id===id);return sourceComplete(id)&&records.some(r=>r.url===lead.url&&r.finalUrl===s?.url&&r.text===s?.text);});
    const recoveryComplete=lead.recoverySourceIds.every(id=>ownRecoveryIds.has(id)&&sourceComplete(id));
    const d=q.decisions?.find(d=>d.leadId===lead.id);
    return {leadId:lead.id,indexedMetadataSourceId:lead.metadataEvidenceId,originalSourceIds:lead.sourceIds,recoverySourceIds:lead.recoverySourceIds,acquisitionStatus:lead.acquisitionStatus,acquisitionCodes:lead.acquisitionCodes,descriptorComplete,originalComplete,recoveryComplete,queryReady,queryCount:queries.length,descriptorFresh:fresh(read.queryRetrievedAt?.[lead.searchArtifactId]??read.end),effectiveAccounted:d?.accounted===true,effectiveQualified:(d as {qualified?:boolean}|undefined)?.qualified===true,...(includeReviewedRole?{reviewedIndexedRole:d?.review.accounting.accepted?d.accounting.role:'UNRESOLVED'}:{}),leadReviewsComplete:!!d&&['accounting','representation','subjectComparison','evidenceAdequacy'].every(k=>d.review[k]?.accepted===true),collectionBlocked:q.recoveryCapped===true||lead.acquisitionCodes.some(c=>/CAP|CONFLICT/.test(c))||read.codes.some(c=>/TEXT_CAP|BINDING|CONFLICT|DESCRIPTOR_CAP|ATT_PAGE_CAP/.test(c))};
  });
}
export type ComparisonPublicClosurePolicy='FACTUAL_AND_PUBLIC_V1'|'INDEPENDENT_ENTRY_V1';
export function comparisonLeadPublicScopeReviewed(read:AttentionRead,lead:NonNullable<AttentionRead['comparisonAcquisition']>['leads'][number],scope:ComparisonLeadPublicScope,cutoff:string,supports:Array<z.output<typeof comparisonSourceSupportSchema>>,policy:ComparisonPublicClosurePolicy='FACTUAL_AND_PUBLIC_V1'){
  const facts=comparisonPublicScopeFacts(read,cutoff).find(f=>f.leadId===lead.id);
  if(!facts||scope.leadId!==lead.id||scope.status!=='REVIEWED'||scope.basis==='NONE'||scope.role==='UNRESOLVED'||scope.blocker!=='NONE'||!scope.review.accepted||!facts.descriptorComplete||!facts.descriptorFresh||facts.collectionBlocked||policy==='FACTUAL_AND_PUBLIC_V1'&&!facts.leadReviewsComplete||!facts.queryReady||!facts.recoveryComplete)return false;
  const own=lead.title+'\n'+lead.snippet,owned=new Set([lead.metadataEvidenceId,...lead.sourceIds,...lead.recoverySourceIds]);
  if(!scope.citations.some(c=>c.sourceId===lead.metadataEvidenceId&&own.includes(c.quote))||!scope.citations.every(c=>owned.has(c.sourceId)&&(c.sourceId===lead.metadataEvidenceId?own.includes(c.quote):read.sources.some(s=>s.id===c.sourceId&&s.text.includes(c.quote)))))return false;
  const inspected=(id:string)=>supports.some(s=>s.sourceId===id&&s.accepted&&s.inspectionComplete&&s.status!=='UNRESOLVED');
  if(![...lead.sourceIds,...lead.recoverySourceIds].every(inspected))return false;
  if(scope.basis==='ORIGINAL_COMPLETE')return facts.originalComplete&&scope.citations.some(c=>lead.sourceIds.includes(c.sourceId));
  if(scope.basis==='MATCHED_ENTITY_RECOVERY')return facts.effectiveAccounted&&facts.queryCount>0&&scope.citations.some(c=>lead.recoverySourceIds.includes(c.sourceId));
  return scope.basis==='REVIEWED_MARKET_RECOVERY'&&scope.role==='MARKET_OR_INDEX_RECORD'&&!!lead.url&&!!lead.title.trim()&&!!lead.snippet.trim()&&!lead.acquisitionCodes.some(c=>/UNSAFE/.test(c))&&facts.queryCount>0;
}
/** Derive collection closure from raw facts and independently reviewed semantic evidence. */
export function deriveComparisonEntryScopes(read:AttentionRead,entry:z.output<typeof comparisonEntrySchema>,review:z.output<typeof comparisonEntryReviewSchema>,observations:Array<z.output<typeof comparisonBodyObservationSchema>>,cutoff:string,policy:ComparisonPublicClosurePolicy='FACTUAL_AND_PUBLIC_V1'){
  const leads=read.comparisonAcquisition?.leads??[],ids=read.sources.filter(s=>read.comparisonSourceIds?.includes(s.id)).map(s=>s.id);
  const exact=(keys:string[],wanted:string[])=>keys.length===wanted.length&&wanted.every(id=>keys.includes(id));
  const allIds=leads.map(l=>l.id);
  let valid=exact(Object.keys(entry.leadRoles),allIds)&&exact(Object.keys(entry.leadBlockers),allIds)&&exact(Object.keys(entry.sourceSupport),ids)&&exact(Object.keys(review.leadRoles),allIds)&&exact(Object.keys(review.leadBlockers),allIds)&&exact(Object.keys(review.sourceSupport),ids)&&JSON.stringify(observations.map(o=>o.sourceId))===JSON.stringify(ids);
  const literal=(c:{sourceId:string;quote:string},owned:Set<string>)=>owned.has(c.sourceId)&&(read.sources.some(s=>s.id===c.sourceId&&s.text.includes(c.quote))||leads.some(l=>l.metadataEvidenceId===c.sourceId&&(l.title+'\n'+l.snippet).includes(c.quote)));
  const blockerValid=(blocker:z.output<typeof comparisonSemanticBlockerSchema>|null,owned:Set<string>,leadId?:string)=>{
    if(!blocker)return true;
    if(blocker.kind==='MATERIAL_CONFLICT')return blocker.sameSubjectRefs.length>0&&blocker.sameSubjectRefs.every(c=>literal(c,owned))&&blocker.affirmative.refs.length>0&&blocker.contrary.refs.length>0&&[...blocker.affirmative.refs,...blocker.contrary.refs].every(c=>literal(c,owned))&&blocker.affirmative.refs.some(a=>blocker.contrary.refs.some(b=>a.quote!==b.quote));
    if(!blocker.refs.length||!blocker.refs.every(c=>literal(c,owned)))return false;
    if(blocker.kind==='NECESSARY_PROJECT_CONTEXT'){const lead=leads.find(l=>l.id===blocker.unreadContextId);return !!lead&&(!leadId||lead.id===leadId)&&!lead.sourceIds.length&&entry.leadRoles[lead.id]?.role==='PROJECT_OR_PUBLICATION'&&review.leadRoles[lead.id]?.accepted===true;}
    return true;
  };
  const sourceSupport=ids.map(sourceId=>{
    const selected=entry.sourceSupport[sourceId],checked=review.sourceSupport[sourceId],observation=observations.find(o=>o.sourceId===sourceId);
    const parents=leads.filter(l=>[...l.sourceIds,...l.recoverySourceIds].includes(sourceId)).map(l=>l.id),owned=new Set([sourceId,...leads.filter(l=>parents.includes(l.id)).flatMap(l=>[l.metadataEvidenceId,...l.sourceIds,...l.recoverySourceIds])]);
    const ownLiteral=!!selected&&selected.citations.every(c=>c.sourceId===sourceId&&literal(c,owned));
    const inspected=observation?.review.inspectionComplete===true&&observation.review.bodyRole.accepted&&observation.review.description.accepted&&observation.description.kind!=='UNINTERPRETABLE';
    if(selected&&(selected.status==='UNRESOLVED')!==(selected.blockerProof!==null))valid=false;
    const proof=!!selected&&blockerValid(selected.blockerProof,owned)&&selected.blockerProof===null;
    return {batch:observation?.batch??1,sourceId,status:selected?.status??'UNRESOLVED' as const,rationale:selected?.rationale??'The actual source support review is missing.',citations:selected?.citations??[],leadIds:parents,accepted:!!checked?.accepted&&ownLiteral&&proof&&!!inspected,inspectionComplete:!!inspected};
  });
  const facts=comparisonPublicScopeFacts(read,cutoff);
  const leadScopes=leads.map(lead=>{
    const role=entry.leadRoles[lead.id],roleReview=review.leadRoles[lead.id],blocker=entry.leadBlockers[lead.id],blockerReview=review.leadBlockers[lead.id],fact=facts.find(f=>f.leadId===lead.id)!;
    const owned=new Set([lead.metadataEvidenceId,...lead.sourceIds,...lead.recoverySourceIds]);
    // Reuse the already independently reviewed own-body role citation when the
    // final lead-role task did not repeat it. This does not change that raw task.
    const bodyRole=(read.comparisonQualification as {entryScopeMethod?:string})?.entryScopeMethod==='code-owned-origin-scope-v1'&&!role?.ownContextRefs.length?observations.find(o=>lead.sourceIds.includes(o.sourceId)&&o.bodyRole.kind===role?.role&&o.review.inspectionComplete&&o.review.bodyRole.accepted&&o.review.description.accepted&&o.description.kind!=='UNINTERPRETABLE'):undefined;
    const reused=bodyRole?.bodyRole.citations.find(c=>c.sourceId===bodyRole.sourceId&&literal(c,owned));
    const citations=[...(role?.descriptorRefs??[]),...(role?.ownContextRefs??[]),...(reused?[reused]:[])];
    const roleValid=!!role&&role.descriptorRefs.length>0&&role.descriptorRefs.every(c=>c.sourceId===lead.metadataEvidenceId&&literal(c,owned))&&role.ownContextRefs.every(c=>c.sourceId!==lead.metadataEvidenceId&&literal(c,owned));
    const semanticReady=roleValid&&roleReview?.accepted===true&&blockerReview?.accepted===true&&blocker===null&&blockerValid(blocker,owned,lead.id)&&role.role!=='UNRESOLVED';
    const bodyReady=[...lead.sourceIds,...lead.recoverySourceIds].every(id=>sourceSupport.some(s=>s.sourceId===id&&s.accepted&&s.inspectionComplete&&s.status!=='UNRESOLVED'));
    const basis=semanticReady&&bodyReady?(fact.originalComplete?'ORIGINAL_COMPLETE':fact.effectiveAccounted&&fact.queryCount>0?'MATCHED_ENTITY_RECOVERY':role.role==='MARKET_OR_INDEX_RECORD'&&fact.queryCount>0?'REVIEWED_MARKET_RECOVERY':'NONE'):'NONE';
    const proposal=comparisonLeadPublicScopeSchema.parse({leadId:lead.id,status:basis==='NONE'?'UNRESOLVED':'REVIEWED',basis,role:role?.role??'UNRESOLVED',blocker:basis==='NONE'?'INCOMPLETE_COLLECTION_OR_REVIEW':'NONE',rationale:basis==='NONE'?'Public review did not establish every required semantic or collection condition.':'Bounded public review closure derived from raw collection facts and accepted role, content and support reviews.',citations,review:{accepted:!!semanticReady,rationale:'Derived from the retained independent role and blocker decisions; factual association is separate.'}});
    if(proposal.status==='REVIEWED'&&!comparisonLeadPublicScopeReviewed(read,lead,proposal,cutoff,sourceSupport,policy)){proposal.status='UNRESOLVED';proposal.basis='NONE';proposal.blocker='INCOMPLETE_COLLECTION_OR_REVIEW';}
    return proposal;
  });
  for(const observation of observations){const owned=new Set([observation.sourceId]);if(![...observation.bodyRole.citations,...observation.description.citations].every(c=>literal(c,owned)))valid=false;}
  return {valid,leadScopes,sourceSupport};
}
/** Identity binding and an independently reviewed support grade are separate axes. */
export function hasReviewedComparisonGapWitness(read:AttentionRead,entry:z.output<typeof comparisonEntrySchema>,review:z.output<typeof comparisonEntryReviewSchema>,observations:Array<z.output<typeof comparisonBodyObservationSchema>>,supports:Array<z.output<typeof comparisonSourceSupportSchema>>){
  const required=(id:string)=>read.comparisonCoverage?.sourceRequirements.some(r=>r.sourceId===id&&r.obligation==='REQUIRED')===true;
  if(supports.some(s=>s.status==='PUBLIC_SUPPORT_GAP'&&s.accepted&&s.inspectionComplete&&s.citations.length&&required(s.sourceId)))return true;
  const q=read.comparisonQualification as {wireMethod?:string;supportScopeMethod?:string}|undefined;
  if(q?.wireMethod!=='comparison-lead-tasks-v4'&&q?.wireMethod!=='comparison-lead-tasks-v5'||q.supportScopeMethod!=='comparison-lead-support-scope-v4'||entry.grade.verdict!=='INADEQUATE'||!review.grade.accepted)return false;
  return entry.grade.citations.some(ref=>{
    const body=observations.find(o=>o.sourceId===ref.sourceId),support=supports.find(s=>s.sourceId===ref.sourceId),source=read.sources.find(s=>s.id===ref.sourceId);
    return required(ref.sourceId)&&!!source?.text.includes(ref.quote)&&support?.status==='BINDING_EVIDENCE'&&support.accepted&&support.inspectionComplete&&body?.bodyRole.kind==='MARKET_OR_INDEX_RECORD'&&body.description.kind==='MARKET_FIELDS_OR_BOILERPLATE'&&body.review.inspectionComplete&&body.review.bodyRole.accepted&&body.review.description.accepted&&body.description.citations.some(c=>c.sourceId===ref.sourceId&&c.quote===ref.quote);
  });
}
export function comparisonPublicLeadScopeReviewed(read:AttentionRead,lead:NonNullable<AttentionRead['comparisonAcquisition']>['leads'][number],d:PublicLeadDecision){
  if(['accounting','representation','subjectComparison','evidenceAdequacy'].some(k=>d.review[k]?.accepted!==true)||d.representation.status==='UNRESOLVED'&&d.representation.unresolvedKind!=='PUBLIC_SUPPORT_GAP')return false;
  if(d.accounted)return true;
  const own=lead.title+'\n'+lead.snippet;
  if(d.accounting.status!=='UNRESOLVED'||d.accounting.basis!=='NONE'||d.accounting.role!=='MARKET_OR_INDEX_RECORD'||!['INADEQUATE','UNRESOLVED'].includes(d.representation.status)||!lead.url||!lead.title.trim()||!lead.snippet.trim()||lead.acquisitionCodes.some(c=>/CAP|CONFLICT|UNSAFE/.test(c))||!d.accounting.descriptorRefs?.length||!d.accounting.descriptorRefs.every(c=>c.sourceId===lead.metadataEvidenceId&&own.includes(c.quote))||!d.representation.citations?.some(c=>c.sourceId===lead.metadataEvidenceId&&own.includes(c.quote)))return false;
  if(lead.acquisitionStatus==='ACQUIRED'&&lead.sourceIds.length&&lead.sourceIds.every(id=>read.sources.some(s=>s.id===id)))return true;
  const queries=(read.comparisonQualification as {recoveryQueries?:Array<{queryId:string;parentLeadId:string}>})?.recoveryQueries?.filter(q=>q.parentLeadId===lead.id)??[];
  return !!read.sources.length&&!!queries.length&&queries.length===lead.recoveryQueryIds.length&&queries.every(q=>lead.recoveryQueryIds.includes(q.queryId)&&(()=>{try{const raw=JSON.parse(read.rawArtifacts[q.queryId]);return Array.isArray(raw.results)&&!raw.error&&(!raw.errors||Array.isArray(raw.errors)&&!raw.errors.length);}catch{return false;}})());
}

/** A reviewed entry-support grade does not establish a factual narrative. */
export function qualifiedNarrativeSupport(read:AttentionRead,token:TokenRef,cutoff:string,criterion:z.output<typeof narrativeCriterionSchema>){
  const parsed=narrativePublicSupportSchema.safeParse(read.narrativePublicSupport);
  if(!parsed.success)return null;
  const receipt=parsed.data,scope=originSourceScope(read,token),judgment=receipt.judgments[criterion];
  if(!scope.complete||JSON.stringify(receipt.scope.sourceIds)!==JSON.stringify(scope.sourceIds)||JSON.stringify(receipt.sourceSupport.map(s=>s.sourceId))!==JSON.stringify(scope.sourceIds)||judgment.verdict!=='INADEQUATE'||!judgment.review.accepted)return null;
  const literal=(ref:{sourceId:string;quote:string})=>{const s=read.sources.find(s=>s.id===ref.sourceId);return !!s&&scope.sourceIds.includes(s.id)&&s.text.length<=6000&&s.text.includes(ref.quote)&&Number.isFinite(Date.parse(cutoff))&&Date.parse(s.availableAt)<=Date.parse(cutoff)&&Date.parse(cutoff)-Date.parse(s.availableAt)<=900000;};
  if(receipt.sourceSupport.some(s=>!s.review.accepted||!s.review.inspectionComplete||s.status==='UNRESOLVED'||new Set(s.criteria).size!==s.criteria.length||s.citations.some(c=>c.sourceId!==s.sourceId||!literal(c)))||receipt.sourceSupport.some(s=>s.status==='SUBSTANTIVE_SUPPORT'&&s.criteria.includes(criterion))||scope.sourceIds.some(id=>{const s=read.sources.find(s=>s.id===id);return !s||s.text.length>6000||!Number.isFinite(Date.parse(s.availableAt))||Date.parse(s.availableAt)>Date.parse(cutoff)||Date.parse(cutoff)-Date.parse(s.availableAt)>900000;})||!judgment.citations.every(literal))return null;
  const gaps=receipt.sourceSupport.filter(s=>s.status==='PUBLIC_SUPPORT_GAP'&&s.criteria.includes(criterion)&&narrativeSourceBound(read,s.sourceId,token));
  if(!gaps.some(s=>s.citations.some(c=>judgment.citations.some(j=>j.sourceId===c.sourceId&&j.quote===c.quote))))return null;
  return {scope:receipt.scope,...judgment};
}

/** One literal metadata link binds a source-described reference, never identity or origin. */
export function narrativeSourceBound(read:AttentionRead,sourceId:string,token:TokenRef):boolean{
  const source=read.sources.find(s=>s.id===sourceId);
  if(!source)return false;
  const names=(text:string)=>token.chain==='solana'?text.includes(token.address):text.toLowerCase().includes(token.address.toLowerCase());
  if(names(source.text))return true;
  if(read.metadataLinkMethod==='onchain-metadata-v1'&&read.metadataLinks&&read.metadataUri&&read.discoveryUrls?.includes(read.metadataUri)){
    const parent=read.sources.find(s=>s.kind==='PAGE'&&(s.url===read.metadataUri||read.originRecovery?.aliases.some(a=>a.originUrl===read.metadataUri&&a.sourceId===s.id&&verifyOriginAlias(a,read.sources,read.rawArtifacts))));
    if(!parent)return false;
    try{
      const metadata=JSON.parse(parent.text);
      if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))return false;
      if(source.id===parent.id)return true;
      const canonical=(value:string)=>normalizeAttentionSearchUrl(value);
      // Only literal links in this token's acquired metadata, not recursive links
      // or a shared name. This establishes a claimed narrative association only.
      return Object.values(metadata).some(value=>typeof value==='string'&&canonical(value)!==null&&canonical(value)===canonical(source.url));
    }catch{return false;}
  }
  if(!read.metadataLinks||!read.metadataUri||!source.discoveredFrom)return false;
  const parent=read.sources.find(s=>s.url===source.discoveredFrom&&s.url===read.metadataUri&&s.kind==='PAGE'&&read.discoveryUrls?.includes(s.url)&&/\.json(?:[?]|$)/i.test(s.url)&&names(s.text));
  if(!parent)return false;
  const canonical=(value:string)=>{try{const u=new URL(value);return /^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname)&&/^\/[A-Za-z0-9_]+\/status\/\d+/.test(u.pathname)?`https://x.com/${u.pathname.split('/')[1].toLowerCase()}/status/${u.pathname.split('/')[3]}`:u.toString();}catch{return null;}};
  return [...parent.text.matchAll(/https:\/\/[^"\s\\<>]+/g)].some(m=>canonical(m[0])===canonical(source.url));
}

/** Only the acquired, mint-linked metadata parent can be classified as identity-only. */
export function identityOnlyTokenMetadata(read:AttentionRead,sourceId:string,token:TokenRef):boolean{
 if(read.metadataLinkMethod!=='onchain-metadata-v1'||!read.metadataLinks||!read.metadataUri||!read.discoveryUrls?.includes(read.metadataUri))return false;
 const source=read.sources.find(s=>s.id===sourceId&&s.kind==='PAGE');if(!source||!narrativeSourceBound(read,sourceId,token))return false;
 if(source.url!==read.metadataUri&&!read.originRecovery?.aliases.some(a=>a.originUrl===read.metadataUri&&a.sourceId===sourceId&&verifyOriginAlias(a,read.sources,read.rawArtifacts)))return false;
 try{
  const text=source.text;let i=0;const ws=()=>{while(/\s/.test(text[i]??'')&&i<text.length)i++;};
  const string=()=>{const start=i++;while(i<text.length){if(text[i]==='\\'){i+=2;continue;}if(text[i++]==='"')return JSON.parse(text.slice(start,i)) as string;}throw Error('JSON_STRING');};
  const value=():void=>{ws();if(text[i]==='{'){i++;const seen=new Set<string>();ws();if(text[i]==='}'){i++;return;}for(;;){ws();if(text[i]!=='"')throw Error('JSON_KEY');const key=string();if(seen.has(key))throw Error('JSON_DUPLICATE');seen.add(key);ws();if(text[i++]!==':')throw Error('JSON_COLON');value();ws();const c=text[i++];if(c==='}')return;if(c!==',')throw Error('JSON_OBJECT');}}else if(text[i]==='['){i++;ws();if(text[i]===']'){i++;return;}for(;;){value();ws();const c=text[i++];if(c===']')return;if(c!==',')throw Error('JSON_ARRAY');}}else if(text[i]==='"')string();else{const m=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));if(!m)throw Error('JSON_VALUE');i+=m[0].length;}};
  value();ws();if(i!==text.length)return false;
  const metadata=JSON.parse(text);if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))return false;
  const allowed=new Set(['name','symbol','description','tags','image','website','twitter','telegram','extensions']);if(Object.keys(metadata).some(k=>!allowed.has(k)))return false;
  if(typeof metadata.name!=='string'||!metadata.name.trim()||typeof metadata.symbol!=='string'||!metadata.symbol.trim()||metadata.description!==undefined&&(typeof metadata.description!=='string'||metadata.description.trim()!=='')||metadata.tags!==undefined&&(!Array.isArray(metadata.tags)||metadata.tags.length!==0))return false;
  const link=(v:unknown)=>{if(typeof v!=='string')return false;if(v.trim()==='')return true;try{const u=new URL(v);return ['https:','http:','ipfs:'].includes(u.protocol);}catch{return false;}};
  if(['image','website','twitter','telegram'].some(k=>metadata[k]!==undefined&&!link(metadata[k])))return false;
  if(metadata.extensions!==undefined){const x=metadata.extensions;if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(k=>!['image','website','twitter','telegram'].includes(k)||!link(x[k])))return false;}
  return true;
 }catch{return false;}
}
export function narrativeContentSourceBound(read:AttentionRead,sourceId:string,token:TokenRef):boolean{
 return narrativeSourceBound(read,sourceId,token)&&!(read.narrativeContentMethod==='typed-metadata-content-v1'&&identityOnlyTokenMetadata(read,sourceId,token));
}
export function buildNarrativeContentScope(read:AttentionRead,token:TokenRef,sourceIds:string[]=read.sources.map(s=>s.id)){
 if(read.narrativeContentMethod!=='typed-metadata-content-v1'||new Set(sourceIds).size!==sourceIds.length||sourceIds.some(id=>!read.sources.some(s=>s.id===id)))throw Error('ATT_NARRATIVE_CONTENT_SCOPE_INVALID');
 return {method:read.narrativeContentMethod,token,sourceIds,eligibleSourceIds:sourceIds.filter(id=>narrativeContentSourceBound(read,id,token)),identityOnlySourceIds:sourceIds.filter(id=>identityOnlyTokenMetadata(read,id,token))};
}

/** Metadata may ground an inadequate-origin entry grade, never a positive origin claim. */
export function originEntryCitationAllowed(read:AttentionRead,sourceId:string,token:TokenRef,verdict:'PASS'|'FAIL'):boolean{
  const source=read.sources.find(s=>s.id===sourceId);
  if(!source)return false;
  const literal=token.chain==='solana'?source.text.includes(token.address):source.text.toLowerCase().includes(token.address.toLowerCase());
  return literal||verdict==='FAIL'&&read.metadataLinkMethod==='onchain-metadata-v1'&&narrativeSourceBound(read,sourceId,token);
}

const citation=z.object({sourceId:z.string().min(1),quote:z.string().min(8).max(1000)}).strict();
export const comparisonEvidenceAssessmentSchema=z.object({verdict:z.enum(['INADEQUATE','UNRESOLVED']),leadId:z.string().min(1),rationale:z.string().min(8).max(1000),citations:z.array(citation).min(1).max(5)}).strict();
export const comparisonRefSchema=z.object({sourceId:z.string().min(1),spanId:z.string().min(1)}).strict();
export const comparisonSubjectWireSchema=z.object({status:z.enum(['CONSISTENT','MISMATCH','UNRESOLVED']),indexedSubject:z.string().min(1).max(300),currentSubject:z.string().min(1).max(300).nullable(),rationale:z.string().min(8).max(1000),descriptorRefs:z.array(comparisonRefSchema).min(1).max(3),fetchedRefs:z.array(comparisonRefSchema).max(5)}).strict();
export const comparisonAdequacyWireSchema=z.object({verdict:z.enum(['INADEQUATE','UNRESOLVED']),rationale:z.string().min(8).max(1000),citations:z.array(comparisonRefSchema).max(5)}).strict();
/** Resolve the wire against code-owned spans; reused by persistence proof validation. */
export function normalizeComparisonRefs(value:unknown,sources:Array<{id:string;text:string}>):unknown{
  const spans=new Map(sources.flatMap(s=>sourceSpans(s.id,s.text)).map(s=>[s.id,s]));
  const walk=(v:unknown):unknown=>{
    if(Array.isArray(v))return v.map(walk);
    if(v&&typeof v==='object'){
      const record=v as Record<string,unknown>;
      if('sourceId'in record&&'spanId'in record&&'assertion'in record&&'extract'in record){const premise=sourcePremiseSchema.parse(record),span=spans.get(premise.spanId);if(!span||span.sourceId!==premise.sourceId||!span.text.includes(premise.extract))throw new Error('ATT_MODEL_PREMISE_INVALID');return premise;}
      if('sourceId'in record&&'spanId'in record){const ref=comparisonRefSchema.parse(record),span=spans.get(ref.spanId);if(!span||span.sourceId!==ref.sourceId)throw new Error('ATT_MODEL_COMPARISON_LEAD_REF_INVALID');return {sourceId:ref.sourceId,quote:span.text};}
      return Object.fromEntries(Object.entries(record).map(([k,v])=>[k,walk(v)]));
    }
    return v;
  };
  return walk(value);
}
const reviewAssessment=z.object({accepted:z.boolean(),rationale:z.string().min(8).max(1000)}).strict();
export const comparisonScopeV2Schema=z.object({mode:z.literal('qualified-identified-leads-v2'),wireMethod:z.literal('comparison-lead-array-v1').optional(),proposalResponseId:z.literal('attention-comparison-lead-repair-proposal-response').optional(),requiredProfileComparisonIds:z.array(z.string()),selectedLeadIds:z.array(z.string()).max(4),deferredLeadIds:z.array(z.string()),recoveryCapped:z.boolean(),adequacySourceLengths:z.array(z.object({id:z.string(),retainedLength:z.number().int().nonnegative()}).strict()),recoveryQueries:z.array(z.object({queryId:z.string(),parentLeadId:z.string(),query:z.string().min(8).max(240),state:z.enum(['OBSERVED','NO_RESULTS','UNAVAILABLE','INVALID']),descriptorComplete:z.boolean(),resultCount:z.number().int().nonnegative(),availableAt:z.iso.datetime()}).strict()),decisions:z.array(z.object({leadId:z.string(),subjectComparison:comparisonSubjectWireSchema.omit({descriptorRefs:true,fetchedRefs:true}).extend({descriptorRefs:z.array(citation).min(1).max(3),fetchedRefs:z.array(citation).max(5)}),evidenceAdequacy:comparisonAdequacyWireSchema.omit({citations:true}).extend({citations:z.array(citation).max(5)}),review:reviewAssessment.extend({subjectComparison:reviewAssessment,evidenceAdequacy:reviewAssessment})}).passthrough())}).passthrough();
export function qualifiedComparisonEvidence(read:AttentionRead,cutoff:string,token?:TokenRef):{verdict:'INADEQUATE'|'UNRESOLVED';leadId?:string;rationale:string;citations:Array<{sourceId:string;quote:string}>}|null{
  if((read.comparisonQualification as {mode?:string}|undefined)?.mode==='qualified-identified-leads-v3'){
    const parsed=comparisonPublicSupportSchema.safeParse(read.comparisonPublicSupport);
    if(!parsed.success||parsed.data.method==='comparison-public-support-v6'||parsed.data.verdict!=='INADEQUATE'||!parsed.data.review.accepted)return null;
    const p=parsed.data,q=read.comparisonQualification as {accountingComplete?:boolean;recoveryCapped?:boolean;decisions?:Array<{leadId:string;accounted:boolean;accounting:{status:string;basis:string;role:string};representation:{status:string;unresolvedKind?:string};review:{accounting:{accepted:boolean};representation:{accepted:boolean};subjectComparison:{accepted:boolean};evidenceAdequacy:{accepted:boolean}}}>;recoveryQueries?:Array<{parentLeadId:string;queryId:string;state:string;descriptorComplete:boolean;availableAt:string}>};
    const independentEntry=p.method==='comparison-public-support-v5';
    const entryTasks=independentEntry||p.method==='comparison-public-support-v4';
    const scopeV2=entryTasks||p.method==='comparison-public-support-v3';
    const marked=p.method!=='comparison-public-support-v1';
    const context=(read.comparisonQualification as {wireMethod?:string;supportScopeMethod?:string;targetContext?:{method:string;mode:string;narrativeClaims:Array<{id:string}>;narrativeSupportReceiptId:string|null}});
    if(marked&&(context.supportScopeMethod!==(independentEntry?'comparison-lead-support-scope-v4':entryTasks?'comparison-lead-support-scope-v3':scopeV2?'comparison-lead-support-scope-v2':'comparison-lead-support-scope-v1')||!context.targetContext||JSON.stringify(p.targetContext)!==JSON.stringify({method:context.targetContext.method,mode:context.targetContext.mode,narrativeClaimIds:context.targetContext.narrativeClaims.map(c=>c.id),narrativeSupportReceiptId:context.targetContext.narrativeSupportReceiptId})||p.targetContext.mode==='UNRESOLVED'||p.targetContext.mode==='REVIEWED_NARRATIVE_SUPPORT_GAP'&&(!token||!qualifiedNarrativeSupport(read,token,cutoff,'NARRATIVE_DESCRIPTION'))))return null;
    if(entryTasks){
      if(independentEntry&&context.wireMethod!=='comparison-lead-tasks-v3'&&context.wireMethod!=='comparison-lead-tasks-v4'&&context.wireMethod!=='comparison-lead-tasks-v5')return null;
      if(context.wireMethod!=='comparison-lead-tasks-v2'&&context.wireMethod!=='comparison-lead-tasks-v3'&&context.wireMethod!=='comparison-lead-tasks-v4'&&context.wireMethod!=='comparison-lead-tasks-v5'||(context.wireMethod==='comparison-lead-tasks-v4'||context.wireMethod==='comparison-lead-tasks-v5')&&!independentEntry)return null;
      const derived=deriveComparisonEntryScopes(read,p.entry,p.entryReview,p.bodyObservations,cutoff,independentEntry?'INDEPENDENT_ENTRY_V1':'FACTUAL_AND_PUBLIC_V1');
      if(!derived.valid||JSON.stringify(derived.leadScopes)!==JSON.stringify(p.leadScopes)||JSON.stringify(derived.sourceSupport)!==JSON.stringify(p.sourceSupport)||!p.entryReview.grade.accepted||p.entry.grade.verdict!=='INADEQUATE')return null;
    }
    if(independentEntry){
      const parents=requiredComparisonRecoveryParents(read.comparisonAcquisition?.leads??[]);
      const selected=(read.comparisonQualification as {selectedLeadIds?:string[]}).selectedLeadIds;
      if(JSON.stringify(selected)!==JSON.stringify(parents.map(l=>l.id))||parents.some(l=>!(q.recoveryQueries??[]).some(query=>query.parentLeadId===l.id)))return null;
      try{if((read.comparisonCoverage?.batches??[]).some(batch=>{const raw=parseSourceResponse(read.rawArtifacts[batch.reviewResponseId]) as {missingRepresentations?:unknown[]};return (raw.missingRepresentations?.length??0)>0;}))return null;}catch{return null;}
    }
    const scopes=read.comparisonAcquisition?.leads.every(lead=>{const d=q.decisions?.find(d=>d.leadId===lead.id);if(p.method==='comparison-public-support-v3'||entryTasks){const scope=p.leadScopes.find(s=>s.leadId===lead.id);return !!scope&&comparisonLeadPublicScopeReviewed(read,lead,scope,cutoff,p.sourceSupport,independentEntry?'INDEPENDENT_ENTRY_V1':'FACTUAL_AND_PUBLIC_V1');}if(marked)return !!d&&comparisonPublicLeadScopeReviewed(read,lead,d);if(!d||!Object.values(d.review).every(r=>r.accepted)||d.representation.status==='UNRESOLVED'&&d.accounting.role!=='MARKET_OR_INDEX_RECORD')return false;if(d.accounted)return true;const queries=q.recoveryQueries?.filter(r=>r.parentLeadId===lead.id)??[];return d.accounting.status==='UNRESOLVED'&&d.accounting.basis==='NONE'&&d.accounting.role==='MARKET_OR_INDEX_RECORD'&&['INADEQUATE','UNRESOLVED'].includes(d.representation.status)&&!!lead.url&&!!lead.title.trim()&&!!lead.snippet.trim()&&(lead.acquisitionStatus==='ACQUIRED'&&lead.sourceIds.length>0&&lead.sourceIds.every(id=>read.sources.some(s=>s.id===id))||queries.length>0&&queries.length===lead.recoveryQueryIds.length&&queries.every(r=>lead.recoveryQueryIds.includes(r.queryId)&&r.descriptorComplete&&['OBSERVED','NO_RESULTS'].includes(r.state)&&Date.parse(r.availableAt)<=Date.parse(cutoff)&&Date.parse(cutoff)-Date.parse(r.availableAt)<=900000));});
    if(!scopes||!read.comparisonAcquisition?.searchSucceeded||!read.comparisonAcquisition.descriptorComplete||q.recoveryCapped||(q.recoveryQueries??[]).some(r=>!r.descriptorComplete||!['OBSERVED','NO_RESULTS'].includes(r.state))||JSON.stringify(p.leadIds)!==JSON.stringify(read.comparisonAcquisition?.leads.map(l=>l.id))||JSON.stringify(p.sourceIds)!==JSON.stringify(read.comparisonSourceIds)||JSON.stringify(p.batchIds)!==JSON.stringify(read.comparisonCoverage?.batches.map(b=>b.batch)))return null;
    if((p.method==='comparison-public-support-v3'||entryTasks)&&(JSON.stringify(p.leadScopes.map(s=>s.leadId))!==JSON.stringify(p.leadIds)||JSON.stringify(p.sourceSupport.map(s=>s.sourceId))!==JSON.stringify(p.sourceIds)||p.sourceSupport.some(s=>!s.accepted||!s.inspectionComplete||s.status==='UNRESOLVED'||s.citations.some(c=>c.sourceId!==s.sourceId||!read.sources.some(source=>source.id===c.sourceId&&source.text.includes(c.quote))))||!(p.method==='comparison-public-support-v5'?hasReviewedComparisonGapWitness(read,p.entry,p.entryReview,p.bodyObservations,p.sourceSupport):p.sourceSupport.some(s=>s.status==='PUBLIC_SUPPORT_GAP'&&s.citations.length&&read.comparisonCoverage?.sourceRequirements.some(r=>r.sourceId===s.sourceId&&r.obligation==='REQUIRED')))))return null;
    const texts=new Map(read.sources.map(s=>[s.id,{text:s.text,availableAt:s.availableAt}]));
    for(const l of read.comparisonAcquisition?.leads??[])texts.set(l.metadataEvidenceId,{text:l.title+'\n'+l.snippet,availableAt:read.queryRetrievedAt?.[l.searchArtifactId]??read.end});
    if(!p.citations.every(c=>{const s=texts.get(c.sourceId);return s&&s.text.includes(c.quote)&&Date.parse(s.availableAt)<=Date.parse(cutoff)&&Date.parse(cutoff)-Date.parse(s.availableAt)<=900000;}))return null;
    return p;
  }
  const raw=read.comparisonQualification as {mode?:string}|undefined;
  const parsed=raw?.mode==='qualified-identified-leads-v2'?comparisonScopeV2Schema.safeParse(raw):null;
  if(parsed&&!parsed.success)return null;
  const v2=parsed?.success?parsed.data:undefined;
  if(v2?.mode==='qualified-identified-leads-v2'){
    const acquisition=read.comparisonAcquisition,leads=acquisition?.leads??[],ids=leads.map(l=>l.id),decisions=v2.decisions??[];
    const profiles=leads.filter(l=>{try{const u=new URL(l.url??'');return /^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname)&&/^\/[A-Za-z0-9_]+\/?$/.test(u.pathname);}catch{return false;}}).map(l=>l.id);
    const exact=(a:string[],b:string[])=>a.length===b.length&&new Set(a).size===a.length&&a.every(id=>b.includes(id));
    const selected=[...profiles,...leads.filter(l=>!profiles.includes(l.id)&&(l.acquisitionStatus!=='ACQUIRED'||l.acquisitionCodes.length)).map(l=>l.id)].slice(0,4);
    if(!acquisition?.searchSucceeded||!acquisition.descriptorComplete||acquisition.leadCount!==ids.length||new Set(ids).size!==ids.length||!exact(decisions.map(d=>d.leadId),ids)||!exact(v2.requiredProfileComparisonIds,profiles)||JSON.stringify(v2.selectedLeadIds)!==JSON.stringify(selected)||!exact(v2.deferredLeadIds,profiles.filter(id=>!selected.includes(id))))return null;
    for(const lead of leads){
      const d=decisions.find(d=>d.leadId===lead.id),subject=d?.subjectComparison;
      if(!d||d.evidenceAdequacy?.verdict!=='INADEQUATE'||d.review?.evidenceAdequacy?.accepted!==true||subject?.status!=='MISMATCH'||d.review?.subjectComparison?.accepted!==true)continue;
      const own=subject.descriptorRefs??[],current=subject.fetchedRefs??[];
      if(!own.length||!own.every((r:{sourceId:string;quote:string})=>r.sourceId===lead.metadataEvidenceId&&(lead.title+'\n'+lead.snippet).includes(r.quote))||!current.length||!current.every((r:{sourceId:string;quote:string})=>lead.sourceIds.includes(r.sourceId)))continue;
      const queries=(v2.recoveryQueries??[]).filter(q=>q.parentLeadId===lead.id);
      if(!queries.length||!exact(queries.map(q=>q.queryId),lead.recoveryQueryIds)||!queries.every(q=>['OBSERVED','NO_RESULTS'].includes(q.state)&&q.descriptorComplete&&Number.isSafeInteger(q.resultCount)&&q.resultCount>=0&&Date.parse(q.availableAt)<=Date.parse(cutoff)&&Date.parse(cutoff)-Date.parse(q.availableAt)<=900000))continue;
      const merged={verdict:'INADEQUATE',leadId:lead.id,rationale:d.evidenceAdequacy.rationale,citations:d.evidenceAdequacy.citations};
      const legacy={...read,comparisonQualification:{...v2,mode:'qualified-identified-leads-v1',evidenceAdequacy:merged,evidenceAdequacyReview:d.review.evidenceAdequacy}};
      const found=qualifiedComparisonEvidence(legacy,cutoff);
      if(found&&current.every((r:{sourceId:string;quote:string})=>found.citations.some(c=>c.sourceId===r.sourceId&&c.quote===r.quote)))return found;
    }
    return null;
  }
  const scope=read.comparisonQualification as {evidenceAdequacy?:unknown;evidenceAdequacyReview?:{accepted:boolean};adequacySourceLengths?:Array<{id:string;retainedLength:number}>;recoveryCapped?:boolean}|undefined;
  const assessment=comparisonEvidenceAssessmentSchema.safeParse(scope?.evidenceAdequacy),acquisition=read.comparisonAcquisition;
  if(!assessment.success||assessment.data.verdict!=='INADEQUATE'||scope?.evidenceAdequacyReview?.accepted!==true||scope.recoveryCapped||!acquisition?.searchSucceeded||!acquisition.descriptorComplete||acquisition.leadCount!==acquisition.leads.length||read.codes.some(c=>/ATT_(?:PAGE|DESCRIPTOR)_CAP/.test(c)))return null;
  const lead=acquisition.leads.find(l=>l.id===assessment.data.leadId);
  if(!lead||!lead.recoveryQueryIds.length||lead.acquisitionCodes.some(c=>/CAP|CONFLICT/.test(c)))return null;
  const refs=assessment.data.citations;
  if(!refs.filter(ref=>ref.sourceId===lead.metadataEvidenceId).every(ref=>(lead.title+'\n'+lead.snippet).includes(ref.quote)))return null;
  if(!refs.some(ref=>ref.sourceId===lead.metadataEvidenceId&&(lead.title+'\n'+lead.snippet).includes(ref.quote)))return null;
  const fetched=refs.filter(ref=>ref.sourceId!==lead.metadataEvidenceId);
  if(!fetched.length||!fetched.every(ref=>{const s=read.sources.find(s=>s.id===ref.sourceId),length=scope.adequacySourceLengths?.find(x=>x.id===ref.sourceId);return s&&length?.retainedLength===s.text.length&&s.text.length<=6000&&[...lead.sourceIds,...lead.recoverySourceIds].includes(s.id)&&s.text.includes(ref.quote)&&Date.parse(s.availableAt)<=Date.parse(cutoff)&&Date.parse(cutoff)-Date.parse(s.availableAt)<=900000;}))return null;
  return assessment.data;
}
/** Completion is separate from whether the reviewed evidence meets the entry standard. */
export function comparisonResearchComplete(read:AttentionRead,cutoff:string){
 const parsed=comparisonPublicSupportV6Schema.safeParse(read.comparisonPublicSupport),q=read.comparisonQualification as {wireMethod?:string;supportScopeMethod?:string;entryDecisionMethod?:string;selectedLeadIds?:string[];recoveryCapped?:boolean;targetContext?:{method:string;mode:string;narrativeClaims:Array<{id:string}>;narrativeSupportReceiptId:string|null}}|undefined;
 if(!parsed.success||!parsed.data.researchComplete||q?.wireMethod!=='comparison-lead-tasks-v5'||q.supportScopeMethod!=='comparison-lead-support-scope-v4'||q.entryDecisionMethod!=='binary-public-support-v1'||q.recoveryCapped)return false;
 const p=parsed.data,leads=read.comparisonAcquisition?.leads??[],ids=read.comparisonSourceIds??[];
 if(!q.targetContext||q.targetContext.mode==='UNRESOLVED'||JSON.stringify(p.targetContext)!==JSON.stringify({method:q.targetContext.method,mode:q.targetContext.mode,narrativeClaimIds:q.targetContext.narrativeClaims.map(c=>c.id),narrativeSupportReceiptId:q.targetContext.narrativeSupportReceiptId})||read.comparisonAcquisition?.leadCount!==leads.length||new Set(leads.map(l=>l.id)).size!==leads.length||new Set(ids).size!==ids.length||ids.some(id=>{const s=read.sources.find(s=>s.id===id),age=s?Date.parse(cutoff)-Date.parse(s.availableAt):NaN;return !s||s.text.length>120000||!Number.isFinite(age)||age<0||age>900000;}))return false;
 if(!leads.length||!ids.length||!read.comparisonAcquisition?.searchSucceeded||!read.comparisonAcquisition.descriptorComplete||JSON.stringify(p.leadIds)!==JSON.stringify(leads.map(l=>l.id))||JSON.stringify(p.sourceIds)!==JSON.stringify(ids)||JSON.stringify(read.comparisonCoverage?.sourceIds)!==JSON.stringify(ids)||JSON.stringify(p.batchIds)!==JSON.stringify(read.comparisonCoverage?.batches.map(b=>b.batch))||JSON.stringify(q.selectedLeadIds)!==JSON.stringify(requiredComparisonRecoveryParents(leads).map(l=>l.id))||read.codes.some(c=>/ATT_(?:PAGE|DESCRIPTOR)_CAP/.test(c)))return false;
 const derived=deriveComparisonEntryScopes(read,p.entry,p.entryReview,p.bodyObservations,cutoff,'INDEPENDENT_ENTRY_V1');
 if(!derived.valid||JSON.stringify(derived.leadScopes)!==JSON.stringify(p.leadScopes)||JSON.stringify(derived.sourceSupport)!==JSON.stringify(p.sourceSupport)||derived.leadScopes.some(l=>l.status!=='REVIEWED')||derived.sourceSupport.length!==ids.length||derived.sourceSupport.some(s=>!s.accepted||!s.inspectionComplete||s.status==='UNRESOLVED')||JSON.stringify(p.bodyObservations.map(o=>o.sourceId))!==JSON.stringify(ids)||p.bodyObservations.some(o=>!o.review.inspectionComplete||!o.review.bodyRole.accepted||!o.review.description.accepted||o.description.kind==='UNINTERPRETABLE'))return false;
 try{if((read.comparisonCoverage?.batches??[]).some(b=>((parseSourceResponse(read.rawArtifacts[b.reviewResponseId]) as {missingRepresentations?:unknown[]}).missingRepresentations?.length??0)>0))return false;}catch{return false;}
 return leads.every(l=>{const scope=p.leadScopes.find(s=>s.leadId===l.id);return !!scope&&comparisonLeadPublicScopeReviewed(read,l,scope,cutoff,p.sourceSupport,'INDEPENDENT_ENTRY_V1');});
}
export function qualifiedBinaryComparisonDecision(read:AttentionRead,cutoff:string){
 if(!comparisonResearchComplete(read,cutoff))return null;
 const p=comparisonPublicSupportV6Schema.parse(read.comparisonPublicSupport);
 return p.decision.citations.every(c=>{const s=read.sources.find(s=>s.id===c.sourceId);return !!s&&p.sourceIds.includes(s.id)&&s.text.includes(c.quote)&&Date.parse(s.availableAt)<=Date.parse(cutoff)&&Date.parse(cutoff)-Date.parse(s.availableAt)<=900000;})?p.decision:null;
}
export const attentionExplanationSchema=z.object({
  referent:z.string().trim().min(1).max(200),
  interest:z.string().trim().min(1).max(200),
  tokenRelation:z.string().trim().min(1).max(200),
  prerequisites:z.array(z.string().trim().min(1).max(200)).max(10),
}).strict();
export const sourcePremiseSchema=z.object({assertion:z.string().trim().min(1).max(500),sourceId:z.string().min(1),spanId:z.string().min(1),extract:z.string().min(1).max(1000)}).strict();
export const factualCriterionProofSchema=z.object({referent:sourcePremiseSchema,interest:sourcePremiseSchema,tokenRelation:sourcePremiseSchema,prerequisiteAssessment:z.string().trim().min(1).max(500).optional(),prerequisites:z.array(sourcePremiseSchema).max(10)}).strict();
export const criterionProofSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('SUPPORTED'),criterion:z.enum(['NAR-01','NAR-02','NAR-03']),premises:z.array(sourcePremiseSchema).min(1).max(8),referent:sourcePremiseSchema.optional(),interest:sourcePremiseSchema.optional(),tokenRelation:sourcePremiseSchema.optional(),gameClass:z.enum(['VIRAL','EVENT','CREATOR','COMMUNITY','CRYPTO_MECHANISM','MIXED']).optional(),mechanism:sourcePremiseSchema.optional(),prerequisiteAssessment:z.string().trim().min(1).max(500).optional(),prerequisites:z.array(sourcePremiseSchema).max(10).optional()}).strict(),
 z.object({kind:z.literal('FACTUAL_COUNTEREVIDENCE'),criterion:z.enum(['NAR-01','NAR-02','NAR-03']),proposition:z.enum(['NARRATIVE_GAME_SUPPORTED','ORIGIN_TRACEABLE','THESIS_EXPLAINABLE']),incompatibleAssertion:z.string().trim().min(1).max(500),premise:sourcePremiseSchema,incompatibility:z.string().trim().min(1).max(500)}).strict(),
 z.object({kind:z.literal('PUBLIC_SUPPORT_INADEQUATE'),criterion:z.enum(['NAR-01','NAR-02','NAR-03']),gap:z.string().trim().min(1).max(500)}).strict(),
]);
export function validCriterionProof(read:AttentionRead,criterion:'NAR-01'|'NAR-02'|'NAR-03',grade:{verdict:'PASS'|'FAIL';negativeBasis?:string;citations:Array<{sourceId:string;quote:string}>;criterionProof?:unknown}){
 const parsed=criterionProofSchema.safeParse(grade.criterionProof);if(!parsed.success)return false;const proof=parsed.data;
 if(proof.criterion!==criterion||proof.kind!==(grade.verdict==='PASS'?'SUPPORTED':grade.negativeBasis))return false;
 if(proof.kind==='FACTUAL_COUNTEREVIDENCE'&&proof.proposition!==({'NAR-01':'NARRATIVE_GAME_SUPPORTED','NAR-02':'ORIGIN_TRACEABLE','NAR-03':'THESIS_EXPLAINABLE'} as const)[criterion])return false;
 if(proof.kind==='SUPPORTED'&&criterion==='NAR-01'&&(!proof.referent||!proof.interest||!proof.tokenRelation||!proof.gameClass||!proof.mechanism))return false;
 if(proof.kind==='SUPPORTED'&&criterion==='NAR-03'&&(!proof.referent||!proof.interest||!proof.tokenRelation||!proof.prerequisiteAssessment||!proof.prerequisites))return false;
 const premises=proof.kind==='SUPPORTED'?[...proof.premises,...[proof.referent,proof.interest,proof.tokenRelation,proof.mechanism].filter((p):p is z.output<typeof sourcePremiseSchema>=>!!p),...(proof.prerequisites??[])]:proof.kind==='FACTUAL_COUNTEREVIDENCE'?[proof.premise]:[];
 return premises.every(p=>{const source=read.sources.find(s=>s.id===p.sourceId),span=source&&sourceSpans(source.id,source.text).find(s=>s.id===p.spanId);return !!span&&span.text.includes(p.extract)&&grade.citations.some(c=>c.sourceId===p.sourceId&&c.quote===span.text);});
}
export const attentionProposalSchema=z.object({
  claims:z.array(z.object({id:z.string().min(1),feature:z.enum(['A01','A02','A03','A04','A05']),value:z.boolean(),summary:z.string().min(8).max(500),citations:z.array(citation).min(1).max(5),explanation:attentionExplanationSchema.optional(),criterionProof:factualCriterionProofSchema.optional(),originBasis:z.literal('PUBLIC_EVIDENCE_INADEQUATE').optional()}).strict()).max(5),
  posts:z.array(z.object({id:z.string().min(1),sourceId:z.string(),quote:z.string().min(8).max(1000),role:z.enum(['CALL','NEWS','JOKE','WARNING','RETROSPECTIVE','PRICE_ONLY','OTHER','UNCLEAR'])}).strict()).max(64),
  competitors:z.array(z.object({id:z.string().min(1),token:tokenRefSchema,sourceId:z.string(),quote:z.string().min(8).max(1000)}).strict()).max(10),
}).strict();
const finalizedAttentionClaimSchema=attentionProposalSchema.shape.claims.element;
export const publicRepresentationWitnessSchema=z.object({token:tokenRefSchema,citations:z.array(citation).min(1).max(5)}).strict();
export const publicRepresentationBasisSchema=z.object({verdict:z.enum(['PASS','FAIL']),negativeBasis:z.enum(['FACTUAL_COUNTEREVIDENCE','PUBLIC_SUPPORT_INADEQUATE']).optional(),basis:z.enum(['IDENTIFIED_REPRESENTATIONS','NO_RELEVANT_ALTERNATIVE','EVIDENCE_INADEQUACY','FACTUAL_COUNTEREVIDENCE']),rationale:semanticReview.shape.rationale,citations:z.array(citation).min(1).max(5),witnesses:z.array(publicRepresentationWitnessSchema).max(10).optional()}).strict().superRefine((decision,ctx)=>{
 if(decision.verdict==='PASS'){
  if(decision.negativeBasis!==undefined)ctx.addIssue({code:'custom',path:['negativeBasis'],message:'PASS cannot carry a negative basis'});
  if(decision.basis==='IDENTIFIED_REPRESENTATIONS'&&(!decision.witnesses||decision.witnesses.length<2))ctx.addIssue({code:'custom',path:['witnesses'],message:'Identified representations require target and alternative witnesses'});
  if(decision.basis==='NO_RELEVANT_ALTERNATIVE'&&(!decision.witnesses||decision.witnesses.length!==1))ctx.addIssue({code:'custom',path:['witnesses'],message:'No-alternative support requires only the target witness'});
  if(decision.basis==='EVIDENCE_INADEQUACY'||decision.basis==='FACTUAL_COUNTEREVIDENCE')ctx.addIssue({code:'custom',path:['basis'],message:'PASS requires an affirmative support basis'});
 }else{
  if(!decision.negativeBasis)ctx.addIssue({code:'custom',path:['negativeBasis'],message:'FAIL requires its negative basis'});
  if(decision.basis==='IDENTIFIED_REPRESENTATIONS'||decision.basis==='NO_RELEVANT_ALTERNATIVE')ctx.addIssue({code:'custom',path:['basis'],message:'FAIL requires a negative basis'});
  if(decision.basis==='EVIDENCE_INADEQUACY'&&decision.negativeBasis!=='PUBLIC_SUPPORT_INADEQUATE')ctx.addIssue({code:'custom',path:['negativeBasis'],message:'Evidence inadequacy must align with public support inadequacy'});
  if(decision.basis==='FACTUAL_COUNTEREVIDENCE'&&decision.negativeBasis!=='FACTUAL_COUNTEREVIDENCE')ctx.addIssue({code:'custom',path:['negativeBasis'],message:'Factual counterevidence must align with its negative basis'});
  if(decision.witnesses?.length)ctx.addIssue({code:'custom',path:['witnesses'],message:'Negative decisions do not supply positive representation witnesses'});
 }
});
export const binaryPublicEntryDecisionV5Schema=z.object({verdict:z.enum(['PASS','FAIL']),negativeBasis:z.enum(['FACTUAL_COUNTEREVIDENCE','PUBLIC_SUPPORT_INADEQUATE']).optional(),rationale:semanticReview.shape.rationale,citations:z.array(citation).min(1).max(5),criterionProof:criterionProofSchema.optional()}).strict().superRefine((decision,ctx)=>{
 if(decision.verdict==='PASS'&&decision.negativeBasis!==undefined)ctx.addIssue({code:'custom',path:['negativeBasis'],message:'PASS cannot carry a negative basis'});
 if(decision.verdict==='FAIL'&&!decision.negativeBasis)ctx.addIssue({code:'custom',path:['negativeBasis'],message:'FAIL requires its negative basis'});
});
export const leadershipPublicEntryDecisionV5Schema=z.object({verdict:z.enum(['PASS','FAIL']),negativeBasis:z.enum(['FACTUAL_COUNTEREVIDENCE','PUBLIC_SUPPORT_INADEQUATE']).optional(),basis:z.enum(['PRIMARY_PUBLIC_SUPPORT','MEASURED_ATTENTION','EVIDENCE_INADEQUACY']),rationale:semanticReview.shape.rationale,citations:z.array(citation).min(1).max(5)}).strict().superRefine((decision,ctx)=>{
 if(decision.verdict==='PASS'&&decision.negativeBasis!==undefined)ctx.addIssue({code:'custom',path:['negativeBasis'],message:'PASS cannot carry a negative basis'});
 if(decision.verdict==='FAIL'&&!decision.negativeBasis)ctx.addIssue({code:'custom',path:['negativeBasis'],message:'FAIL requires its negative basis'});
 if(decision.verdict==='PASS'&&decision.basis==='EVIDENCE_INADEQUACY')ctx.addIssue({code:'custom',path:['basis'],message:'PASS requires positive leadership support'});
 if(decision.verdict==='FAIL'&&decision.basis!=='EVIDENCE_INADEQUACY')ctx.addIssue({code:'custom',path:['basis'],message:'FAIL requires the existing evidence inadequacy basis'});
});
export const attentionSupportJudgmentSchema=z.discriminatedUnion('verdict',[
 z.object({verdict:z.literal('INADEQUATE'),negativeBasis:z.literal('PUBLIC_SUPPORT_INADEQUATE'),rationale:semanticReview.shape.rationale,citations:z.array(entryCitation).min(1).max(5)}).strict(),
 z.object({verdict:z.literal('UNRESOLVED'),rationale:semanticReview.shape.rationale,citations:z.array(entryCitation).min(1).max(5)}).strict(),
]);
export const attentionEntrySupportSchema=z.object({attentionContext:attentionSupportJudgmentSchema,qualifiedSample:attentionSupportJudgmentSchema,growth:attentionSupportJudgmentSchema}).strict();
export type AttentionSupportCriterion=keyof z.output<typeof attentionEntrySupportSchema>;
const entryIntervalSchema=z.object({lower:z.number().int().nonnegative().max(64),upper:z.number().int().nonnegative().max(64)}).strict().refine(x=>x.lower<=x.upper);
export const attentionEntryBoundsSchema=z.object({method:z.literal('accepted-post-intervals-v1'),complete:z.boolean(),start:z.string(),end:z.string(),midpoint:z.string().nullable(),queries:z.array(z.string()),sourceIds:z.array(z.string()).max(64),blockers:z.array(z.string()),dispositions:z.array(z.object({sourceId:z.string(),originalContent:z.enum(['RETAINED','UNAVAILABLE_ACCESS_WALL']),bin:z.enum(['PREVIOUS','CURRENT','OUTSIDE','UNRESOLVED']),classification:z.enum(['QUALIFIED','EXCLUDED','POTENTIAL']),reasons:z.array(z.string()),citations:z.array(entryCitation).max(5)}).strict()).max(64),posts:entryIntervalSchema,accounts:entryIntervalSchema,previous:entryIntervalSchema,current:entryIntervalSchema}).strict();
export type AttentionEntryBounds=z.output<typeof attentionEntryBoundsSchema>;
export type AttentionEntryBoundWitness={method:'accepted-post-intervals-v1';criterion:AttentionSupportCriterion;status:'PASS'|'FAIL';rationale:string;citations:z.output<typeof entryCitation>[];evidenceIds:string[];availableAt:string;start:string;end:string;bounds:Pick<AttentionEntryBounds,'posts'|'accounts'|'previous'|'current'>};
const legacyEntryDecisionsSchema=z.object({narrativeContentMethod:z.literal('typed-metadata-content-v1').optional(),contentScope:z.object({method:z.literal('typed-metadata-content-v1'),token:tokenRefSchema,sourceIds:z.array(z.string()).max(64),eligibleSourceIds:z.array(z.string()).max(64),identityOnlySourceIds:z.array(z.string()).max(64)}).strict().optional(),semanticPremiseMethod:z.literal('criterion-premises-v1').optional(),acquisitionEvidenceMethod:z.literal(acquisitionEvidenceMethod).optional(),acquisitionScope:acquisitionScopeSchema.optional(),acquisitionInspection:z.array(z.object({sourceId:z.string(),complete:z.boolean(),rationale:z.string().min(8).max(1000)}).strict()).max(2).optional(),entryBoundsMethod:z.literal('accepted-post-intervals-v1').optional(),entryBounds:attentionEntryBoundsSchema.optional(),pageBodyRetentionMethod:z.literal('requested-page-bodies-v1').optional(),entrySupportMethod:z.literal('reviewed-sample-growth-v1').optional(),entrySupport:attentionEntrySupportSchema.optional(),entrySupportScope:z.unknown().optional(),outcomeBasisMethod:z.literal('entry-outcome-basis-v1').optional(),method:z.literal('binary-public-support-v1'),originTraceability:binaryEntryDecisionSchema,leadership:binaryEntryDecisionSchema,inspectionComplete:z.boolean(),sourceIds:z.array(z.string()).max(64)}).strict();
export const entryDecisionsSchema=z.discriminatedUnion('method',[legacyEntryDecisionsSchema,legacyEntryDecisionsSchema.extend({method:z.literal('binary-public-support-v2'),representations:binaryEntryDecisionSchema}).strict(),legacyEntryDecisionsSchema.extend({method:z.literal('binary-public-support-v3'),representations:binaryEntryDecisionSchema,explainableThesis:binaryEntryDecisionSchema}).strict(),legacyEntryDecisionsSchema.extend({method:z.literal('binary-public-support-v4'),leadership:binaryEntryDecisionSchema.extend({basis:z.enum(['PRIMARY_PUBLIC_SUPPORT','MEASURED_ATTENTION','EVIDENCE_INADEQUACY'])}).strict(),representations:binaryEntryDecisionSchema,explainableThesis:binaryEntryDecisionSchema}).strict(),legacyEntryDecisionsSchema.extend({method:z.literal('binary-public-support-v5'),originTraceability:binaryPublicEntryDecisionV5Schema,leadership:leadershipPublicEntryDecisionV5Schema,representations:publicRepresentationBasisSchema,explainableThesis:binaryPublicEntryDecisionV5Schema,narrativeGame:binaryPublicEntryDecisionV5Schema.optional()}).strict()]);
export const attentionReviewSchema=z.object({
 entryDecisions:entryDecisionsSchema.optional(),
  decisions:z.array(z.object({id:z.string().min(1),accepted:z.boolean(),rationale:z.string().min(8).max(1000)}).strict()).max(79),
 finalClaims:z.record(z.string(),finalizedAttentionClaimSchema.nullable()).optional(),
  candidateSet:z.object({complete:z.boolean(),rationale:z.string().min(8).max(1000)}).strict().optional(),
  originRelationship:z.object({status:z.enum(['SUPPORTED','CONTRADICTED','UNKNOWN']),citations:z.array(citation).max(5),rationale:z.string().min(8).max(1000)}).strict().optional(),
  originScopeReview:z.object({complete:z.boolean(),sourceIds:z.array(z.string()).max(64),rationale:z.string().min(8).max(1000)}).strict().optional(),
  leadershipScreening:z.union([z.object({method:z.literal('reviewed-public-support-v1'),verdict:z.enum(['INADEQUATE','UNRESOLVED']),rationale:z.string().min(8).max(1000),citations:z.array(citation).min(1).max(5),sourceIds:z.array(z.string()).max(64),review:reviewAssessment}).strict(),z.object({method:z.literal('reviewed-public-support-v2'),verdict:z.enum(['INADEQUATE','UNRESOLVED']),rationale:z.string().min(8).max(1000),citations:z.array(citation).min(1).max(5),sourceIds:z.array(z.string()).max(64),review:reviewAssessment.extend({inspectionComplete:z.boolean(),sourceIds:z.array(z.string()).max(64)}).strict(),originTraceability:z.object({verdict:z.enum(['INADEQUATE','UNRESOLVED']),rationale:z.string().min(8).max(1000),citations:z.array(citation).min(1).max(5),review:reviewAssessment}).strict()}).strict()]).optional(),
}).strict();
/** Select actual independently authored claim finals; the draft review bits stay untouched. */
/** An empty structural base is not an extraction, a model review, or a factual assertion. */
export function noSourceAttentionContext(read:AttentionRead,proposal:unknown,review:unknown):boolean{
 if(read.narrativeContentMethod!==undefined&&read.narrativeContentMethod!=='typed-metadata-content-v1')return false;
 if(read.acquisitionEvidenceMethod!==acquisitionEvidenceMethod)return false;
 if(read.baseQualification==='NO_NARRATIVE_SOURCE_CONTENT'){
  const scope=read.narrativeContentScope;if(read.narrativeContentMethod!=='typed-metadata-content-v1'||!scope)return false;
  try{if(JSON.stringify(scope)!==JSON.stringify(buildNarrativeContentScope(read,scope.token,scope.sourceIds))||scope.eligibleSourceIds.length||scope.sourceIds.some(id=>read.sources.find(s=>s.id===id)?.kind==='POST'))return false;}catch{return false;}
 }else if(read.baseQualification!=='NO_SOURCE_CONTENT'||read.sources.length)return false;
 const p=attentionProposalSchema.safeParse(proposal),r=attentionReviewSchema.safeParse(review);
 return p.success&&r.success&&!p.data.claims.length&&!p.data.posts.length&&!p.data.competitors.length&&!r.data.decisions.length&&r.data.finalClaims===undefined&&['attention-proposal-prompt','attention-proposal-response','attention-review-prompt','attention-review-response'].every(id=>read.rawArtifacts[id]===undefined);
}
export function attentionEntryContext(read:AttentionRead,proposal:unknown,review:unknown){
 if(noSourceAttentionContext(read,proposal,review))return attentionProposalSchema.parse(proposal);
 return selectGroundedAttentionProposal(read,proposal,review);
}
/** Eligible evidence kinds are shared by the hosted selector and local validator. */
export function attentionPublicCitationAllowed(read:AttentionRead,token:TokenRef,cutoff:string,criterion:'originTraceability'|'leadership'|'representations'|'explainableThesis'|'narrativeGame',grade:{verdict:'PASS'|'FAIL';negativeBasis?:string},ref:{sourceId:string;quote:string}):boolean{
 return attentionPublicCitationPredicate(read,token,cutoff)(criterion,grade,ref);
}
/** One immutable source scope per selector build; final admission constructs its own. */
export function attentionPublicCitationPredicate(read:AttentionRead,token:TokenRef,cutoff:string){
 const scope=entryEvidenceScope(read,token,cutoff);
 const narrative=new Map<string,boolean>(),origin=new Map<string,boolean>();
 return (criterion:'originTraceability'|'leadership'|'representations'|'explainableThesis'|'narrativeGame',grade:{verdict:'PASS'|'FAIL';negativeBasis?:string},ref:{sourceId:string;quote:string}):boolean=>{
 const inadequate=grade.verdict==='FAIL'&&grade.negativeBasis==='PUBLIC_SUPPORT_INADEQUATE';
 if(read.acquisitionEvidenceMethod===acquisitionEvidenceMethod&&acquisitionCitationAllowed(read.acquisitionScope,ref,token,cutoff))return inadequate;
 const source=read.sources.find(s=>s.id===ref.sourceId);
 if(!source||!scope.sourceIds.includes(source.id)||!source.text.includes(ref.quote))return false;
 if(read.narrativeContentMethod==='typed-metadata-content-v1'&&!inadequate&&['originTraceability','narrativeGame','explainableThesis'].includes(criterion)&&!narrativeContentSourceBound(read,source.id,token))return false;
 if(criterion==='originTraceability'){const key=source.id+'\0'+grade.verdict;if(!origin.has(key))origin.set(key,originEntryCitationAllowed(read,source.id,token,grade.verdict));return scope.originSourceIds.includes(source.id)&&origin.get(key)!;}
 if(criterion==='narrativeGame'||criterion==='explainableThesis'){if(!narrative.has(source.id))narrative.set(source.id,narrativeSourceBound(read,source.id,token));return narrative.get(source.id)!;}
 return true;
 };
}
export function attentionAcquisitionInspected(read:AttentionRead,decision:{acquisitionEvidenceMethod?:string;acquisitionScope?:unknown;acquisitionInspection?:Array<{sourceId:string;complete:boolean}>}):boolean{
 if(read.acquisitionEvidenceMethod!==acquisitionEvidenceMethod)return decision.acquisitionEvidenceMethod===undefined;
 const scope=read.acquisitionScope,inspection=decision.acquisitionInspection;
 return !!scope?.complete&&decision.acquisitionEvidenceMethod===acquisitionEvidenceMethod&&JSON.stringify(decision.acquisitionScope)===JSON.stringify(scope)&&!!inspection&&scope.requiredEvidenceIds.length>0&&inspection.length===scope.requiredEvidenceIds.length&&new Set(inspection.map(i=>i.sourceId)).size===inspection.length&&inspection.every(i=>i.complete&&scope.requiredEvidenceIds.includes(i.sourceId));
}
export function selectGroundedAttentionProposal(read:AttentionRead,proposal:unknown,review:unknown,requireExactFinalKeys=false):z.output<typeof attentionProposalSchema>|null{
 if(read.narrativeContentMethod!==undefined&&read.narrativeContentMethod!=='typed-metadata-content-v1')return null;
 if(read.semanticPremiseMethod!==undefined&&read.semanticPremiseMethod!=='criterion-premises-v1')return null;
 const parsedProposal=attentionProposalSchema.safeParse(proposal),parsedReview=attentionReviewSchema.safeParse(review);
 if(!parsedProposal.success||!parsedReview.success)return null;
 if(read.claimDecisionMethod!=='independent-grounded-claims-v1')return parsedProposal.data;
 const citedView=read.claimEvidenceMethod==='cited-claim-view-v1';
 if(citedView&&(read.entryExecutionMethod!=='entry-first-v2'||read.entryEvidenceMethod!=='public-support-v2'||read.comparisonComplete!==false||!read.comparisonAcquisition))return null;
 const finals=parsedReview.data.finalClaims;if(!finals)return null;
 const ids=parsedProposal.data.claims.map(c=>c.id),byId=new Map(parsedProposal.data.claims.map(c=>[c.id,c]));
 if(new Set(ids).size!==ids.length||new Set(parsedProposal.data.claims.map(c=>c.feature)).size!==parsedProposal.data.claims.length)return null;
 const finalIds=Object.keys(finals);
 if(ids.some(id=>!Object.hasOwn(finals,id))||finalIds.some(id=>!byId.has(id)&&finals[id]!==null)||(requireExactFinalKeys||citedView)&&(finalIds.length!==ids.length||finalIds.some(id=>!byId.has(id))))return null;
 const claims:typeof parsedProposal.data.claims=[];
 for(const original of parsedProposal.data.claims){
  if(citedView&&original.feature==='A03'&&(!original.value||original.originBasis!==undefined))return null;
  const final=finals[original.id];
  if(final===null)continue;
  if(!final||final.id!==original.id||final.feature!==original.feature||final.value!==original.value||final.originBasis!==original.originBasis)return null;
  if(!read.semanticPremiseMethod&&final.criterionProof)return null;
  if(citedView){
   const allowed=new Set(original.citations.map(c=>JSON.stringify([c.sourceId,c.quote])));
   const selected=new Set(final.citations.map(c=>JSON.stringify([c.sourceId,c.quote])));
   if(final.citations.some(c=>!allowed.has(JSON.stringify([c.sourceId,c.quote])))||selected.size!==final.citations.length)return null;
  }
  if(read.narrativeContentMethod==='typed-metadata-content-v1'&&(!read.narrativeContentScope||!final.citations.every(c=>narrativeContentSourceBound(read,c.sourceId,read.narrativeContentScope!.token))))return null;
  if(read.semanticPremiseMethod==='criterion-premises-v1'&&(final.feature==='A01'||final.feature==='A05')){
   const proof=final.criterionProof;if(!proof||final.feature==='A05'&&(!final.explanation||!proof.prerequisiteAssessment||proof.prerequisites.length!==final.explanation.prerequisites.length))return null;
   const premises=[proof.referent,proof.interest,proof.tokenRelation,...proof.prerequisites];
   if(!premises.every(p=>{const source=read.sources.find(s=>s.id===p.sourceId),span=source&&sourceSpans(source.id,source.text).find(s=>s.id===p.spanId);return !!span&&span.text.includes(p.extract)&&final.citations.some(c=>c.sourceId===p.sourceId&&c.quote===span.text);}))return null;
  }
  claims.push(final);
 }
 if(new Set(claims.map(c=>c.id)).size!==claims.length||new Set(claims.map(c=>c.feature)).size!==claims.length)return null;
 return {...parsedProposal.data,claims};
}
/** Completed public screening is separate from the original factual origin claim. */
export function qualifiedOriginScreen(read:AttentionRead,review:z.output<typeof attentionReviewSchema>,token:TokenRef,cutoff:string){
  const screen=review.leadershipScreening,q=read.comparisonQualification as {wireMethod?:string;supportScopeMethod?:string}|undefined;
  if(screen?.method!=='reviewed-public-support-v2'||q?.wireMethod!=='comparison-lead-tasks-v5'||q.supportScopeMethod!=='comparison-lead-support-scope-v4'||!screen.review.inspectionComplete)return null;
  const scope=originSourceScope(read,token),ids=scope.sourceIds;
  if(!scope.complete||!ids.length||JSON.stringify(scope)!==JSON.stringify(read.originScope)||JSON.stringify(screen.sourceIds)!==JSON.stringify(ids)||JSON.stringify(screen.review.sourceIds)!==JSON.stringify(ids)||!(read.comparisonComplete||qualifiedComparisonEvidence(read,cutoff,token)))return null;
  const sources=read.sources.filter(s=>ids.includes(s.id));
  if(sources.length!==ids.length||sources.some(s=>s.text.length>6000||!Number.isFinite(Date.parse(s.availableAt))||Date.parse(s.availableAt)>Date.parse(cutoff)||Date.parse(cutoff)-Date.parse(s.availableAt)>900000))return null;
  const literal=(c:{sourceId:string;quote:string},bound=false)=>{const s=sources.find(s=>s.id===c.sourceId);return !!s&&s.text.includes(c.quote)&&(!bound||(token.chain==='solana'?s.text.includes(token.address):s.text.toLowerCase().includes(token.address.toLowerCase())));};
  if(!screen.citations.every(c=>literal(c))||!screen.originTraceability.citations.every(c=>literal(c,true)))return null;
  return screen;
}
/** Public-support closure is distinct from a measured original-post sample. */
export function entrySupportScope(read:AttentionRead,token:TokenRef,cutoff:string,proposal:unknown,review:unknown){
 const blockers:string[]=[],scope=entryEvidenceScope(read,token,cutoff),p=attentionProposalSchema.safeParse(proposal),r=attentionReviewSchema.safeParse(review);
 const posts=read.sources.filter(s=>s.kind==='POST'&&(!read.postSampleSourceIds||read.postSampleSourceIds.includes(s.id)));
 const acquiredEmpty=read.acquisitionEvidenceMethod===acquisitionEvidenceMethod&&read.acquisitionScope?.complete===true&&!posts.length;
 if(read.entrySupportMethod!=='reviewed-sample-growth-v1'||!scope.complete)blockers.push('ATT_SUPPORT_ACQUISITION_INCOMPLETE');
 if(!acquiredEmpty&&(read.postSampleComplete!==true||!posts.length)||read.codes.some(c=>/ATT_(?:TEXT_CAP|PAGE_CAP|SOURCE_CAP|FETCH_BINDING|FETCH_SOURCE_CONFLICT)/.test(c)))blockers.push('ATT_SUPPORT_POST_SCOPE_INCOMPLETE');
 const start=Date.parse(read.start),end=Date.parse(read.end),now=Date.parse(cutoff);
 if(!(start<end&&end<=now&&now-end<=900000))blockers.push('ATT_SUPPORT_WINDOW_INVALID');
 if(read.queries.length<2||!read.queries.slice(0,2).every(q=>q.includes(token.address)))blockers.push('ATT_SUPPORT_SEARCH_INCOMPLETE');
 for(let n=1;n<=read.queries.length;n++)try{const raw=JSON.parse(read.rawArtifacts['attention-search-'+n]),http=JSON.parse(read.rawArtifacts['attention-http-outcomes']).outcomes.filter((x:{artifactId:string})=>x.artifactId==='attention-search-'+n);if(raw.error||!Array.isArray(raw.results)||raw.errors&&(!Array.isArray(raw.errors)||raw.errors.length)||http.length!==1||http[0].status<200||http[0].status>=300)throw Error();}catch{blockers.push('ATT_SUPPORT_SEARCH_INCOMPLETE');}
 for(const [id,raw]of Object.entries(read.rawArtifacts))if(/^attention-fetch-\d+(?:-retry-1)?$/.test(id))try{const packet=JSON.parse(raw),http=JSON.parse(read.rawArtifacts['attention-http-outcomes']);const rows=http.outcomes.filter((x:{artifactId:string})=>x.artifactId===id);if(http.method!=='fetch-http-outcomes-v1'||rows.length!==1||!Number.isInteger(rows[0].status)||rows[0].status<200||rows[0].status>=300||packet.error||!Array.isArray(packet.results)||!Array.isArray(packet.errors))throw Error();}catch{blockers.push('ATT_SUPPORT_FETCH_INCOMPLETE');}
 for(const post of posts){
  const label=p.success?p.data.posts.find(x=>x.sourceId===post.id):undefined,decision=r.success&&label?r.data.decisions.find(x=>x.id===label.id):undefined;
  if(!label||!decision?.accepted||!post.text.includes(label.quote))blockers.push('ATT_SUPPORT_POST_REVIEW_INCOMPLETE');
  const attempts=Object.entries(read.rawArtifacts).filter(([id])=>/^attention-fetch-\d+(?:-retry-1)?$/.test(id));
  const acquired=attempts.some(([id,raw])=>{try{const packet=JSON.parse(raw),http=JSON.parse(read.rawArtifacts['attention-http-outcomes']).outcomes.filter((x:{artifactId:string})=>x.artifactId===id);return http.length===1&&http[0].status>=200&&http[0].status<300&&!packet.error&&Array.isArray(packet.results)&&packet.results.some((row:{url:string;final_url?:string;text:string})=>normalizeAttentionSearchUrl(row.final_url??row.url)===normalizeAttentionSearchUrl(post.url)&&row.text===post.text);}catch{return false;}});
  if(!acquired)blockers.push('ATT_SUPPORT_POST_BODY_MISSING');
 }
 return {method:'reviewed-sample-growth-scope-v1' as const,complete:blockers.length===0,start:read.start,end:read.end,queries:read.queries,sourceIds:[...posts.map(s=>s.id),...(acquiredEmpty?read.acquisitionScope!.requiredEvidenceIds:[])],posts:posts.map(s=>({sourceId:s.id,publishedAt:s.publishedAt,authorId:s.authorId,originalContent:/this post is only available in the x app|sensitive content|sign in to (?:x|twitter)/i.test(s.text)?'UNAVAILABLE_ACCESS_WALL':'RETAINED',role:p.success?p.data.posts.find(x=>x.sourceId===s.id)?.role??'UNCLEAR':'UNCLEAR'})),blockers:[...new Set(blockers)]};
}
/** Conservative bounds decide predicates without claiming complete exact measurements. */
export function attentionEntryBounds(read:AttentionRead,token:TokenRef,cutoff:string,proposal:unknown,review:unknown):AttentionEntryBounds{
 const support=entrySupportScope(read,token,cutoff,proposal,review),blockers=[...support.blockers],p=attentionProposalSchema.safeParse(proposal),r=attentionReviewSchema.safeParse(review);
 if(read.acquisitionEvidenceMethod===acquisitionEvidenceMethod&&!read.sources.some(s=>s.kind==='POST'))blockers.push('ATT_BOUNDS_NO_MEASURED_POSTS');
 if(read.entryBoundsMethod!=='accepted-post-intervals-v1')blockers.push('ATT_BOUNDS_METHOD_REQUIRED');
 const posts=read.sources.filter(s=>s.kind==='POST'&&(!read.postSampleSourceIds||read.postSampleSourceIds.includes(s.id))),ids=posts.map(s=>s.id),start=Date.parse(read.start),end=Date.parse(read.end),mid=start+(end-start)/2;
 const sample=read.growthSample;
 if(!sample?.complete||sample.method!=='fixed-query-sample-v1'||JSON.stringify(sample.sourceIds)!==JSON.stringify(ids)||JSON.stringify(sample.queries)!==JSON.stringify(read.queries)||!Number.isSafeInteger(mid))blockers.push('ATT_BOUNDS_FIXED_SAMPLE_INCOMPLETE');
 if(new Set(ids).size!==ids.length||read.postSampleSourceIds&&JSON.stringify(read.postSampleSourceIds)!==JSON.stringify(ids)||!p.success||!r.success||p.success&&new Set(p.data.posts.map(x=>x.sourceId)).size!==p.data.posts.length||r.success&&new Set(r.data.decisions.map(x=>x.id)).size!==r.data.decisions.length)blockers.push('ATT_BOUNDS_REVIEW_SCOPE_INVALID');
 const guaranteed=(source:AttentionRead['sources'][number])=>{const label=p.success?p.data.posts.find(x=>x.sourceId===source.id):undefined,at=source.publishedAt?Date.parse(source.publishedAt):NaN;return !!(label&&r.success&&r.data.decisions.find(x=>x.id===label.id)?.accepted&&['CALL','NEWS','JOKE'].includes(label.role)&&source.authorId&&Number.isFinite(at)&&at>=start&&at<end&&at<=Date.parse(source.availableAt)&&!( /this post is only available in the x app|sensitive content|sign in to (?:x|twitter)/i.test(source.text))&&(token.chain==='solana'?label.quote.includes(token.address):label.quote.toLowerCase().includes(token.address.toLowerCase())));};
 const guaranteedUrls=new Set(posts.filter(guaranteed).map(s=>normalizeAttentionSearchUrl(s.url)));
 const dispositions:AttentionEntryBounds['dispositions']=[],authors=new Set<string>(),seenUrls=new Set<string>(),seenQuotes=new Set<string>();let lower=0,potential=0,previous=0,current=0,previousPotential=0,currentPotential=0;
 for(const source of posts){
  const label=p.success?p.data.posts.find(x=>x.sourceId===source.id):undefined,decision=r.success&&label?r.data.decisions.find(x=>x.id===label.id):undefined;
  const available=Date.parse(source.availableAt),at=source.publishedAt?Date.parse(source.publishedAt):NaN,url=normalizeAttentionSearchUrl(source.url),handle=url?new URL(url).pathname.split('/')[1]?.toLowerCase():null;
  const wall=/this post is only available in the x app|sensitive content|sign in to (?:x|twitter)/i.test(source.text),trustedDate=Number.isFinite(at)&&at<=available&&at<=Date.parse(cutoff);
  if(!Number.isFinite(available)||available<Date.parse(read.end)||available>Date.parse(cutoff)||Date.parse(cutoff)-available>900000||!url||source.authorId!==null&&source.authorId!==('x.com:'+handle))blockers.push('ATT_BOUNDS_SOURCE_METADATA_INVALID');
  if(!label||!decision?.accepted||!source.text.includes(label.quote))blockers.push('ATT_BOUNDS_POST_REVIEW_INCOMPLETE');
  const rawRows=Object.entries(read.rawArtifacts).filter(([id])=>/^attention-fetch-\d+(?:-retry-1)?$/.test(id)).flatMap(([,raw])=>{try{return JSON.parse(raw).results??[];}catch{return [];}}).filter((row:{url:string;final_url?:string;text:string})=>normalizeAttentionSearchUrl(row.final_url??row.url)===url&&row.text===source.text);
  const dateFromRaw=(row:{published_date?:unknown})=>typeof row.published_date==='string'&&/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(row.published_date)&&Number.isFinite(Date.parse(row.published_date))&&Date.parse(row.published_date)<=end?new Date(row.published_date).toISOString():null;
  if(!rawRows.length||!rawRows.some((row:{published_date?:unknown})=>dateFromRaw(row)===source.publishedAt))blockers.push('ATT_BOUNDS_SOURCE_METADATA_INVALID');
  const bin:AttentionEntryBounds['dispositions'][number]['bin']=trustedDate?(at<start||at>=end?'OUTSIDE':at<mid?'PREVIOUS':'CURRENT'):'UNRESOLVED';
  const quote=label?.quote??'',key=quote.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim(),duplicate=!!url&&(seenUrls.has(url)||guaranteedUrls.has(url)&&!guaranteed(source))||!wall&&trustedDate&&bin!=='OUTSIDE'&&seenQuotes.has(key);
  if(url&&(!guaranteedUrls.has(url)||guaranteed(source)))seenUrls.add(url);
  const bound=token.chain==='solana'?quote.includes(token.address):quote.toLowerCase().includes(token.address.toLowerCase()),eligible=!!label&&['CALL','NEWS','JOKE'].includes(label.role),unclear=label?.role==='UNCLEAR';
  let classification:AttentionEntryBounds['dispositions'][number]['classification']='EXCLUDED',reasons:string[]=[];
  if(duplicate)reasons=['DUPLICATE_PUBLICATION_OR_CONTENT'];
  else if(wall){classification='POTENTIAL';reasons=['ORIGINAL_CONTENT_UNAVAILABLE'];}
  else if(bin==='OUTSIDE')reasons=['OUTSIDE_FIXED_WINDOW'];
  else if(unclear){classification='POTENTIAL';reasons=['ORIGINAL_ROLE_UNRESOLVED'];}
  else if(!eligible||!bound)reasons=['REVIEWED_NONQUALIFYING_OR_UNBOUND'];
  else if(!trustedDate||!source.authorId){classification='POTENTIAL';reasons=['ORIGINAL_METADATA_UNRESOLVED'];}
  else{classification='QUALIFIED';reasons=['ACCEPTED_DATED_EXACT_TOKEN_ORIGINAL'];}
  if(classification==='QUALIFIED'){seenQuotes.add(key);lower++;authors.add(source.authorId!);if(bin==='PREVIOUS')previous++;else current++;}
  if(classification==='POTENTIAL'&&bin!=='OUTSIDE'){potential++;if(bin==='PREVIOUS'||bin==='UNRESOLVED')previousPotential++;if(bin==='CURRENT'||bin==='UNRESOLVED')currentPotential++;}
  dispositions.push({sourceId:source.id,originalContent:wall?'UNAVAILABLE_ACCESS_WALL':'RETAINED',bin,classification,reasons,citations:label?[{sourceId:source.id,quote:label.quote}]:[]});
 }
 return {method:'accepted-post-intervals-v1',complete:blockers.length===0,start:read.start,end:read.end,midpoint:Number.isFinite(mid)?new Date(mid).toISOString():null,queries:read.queries,sourceIds:ids,blockers:[...new Set(blockers)],dispositions,posts:{lower,upper:lower+potential},accounts:{lower:authors.size,upper:Math.min(lower+potential,authors.size+potential)},previous:{lower:previous,upper:previous+previousPotential},current:{lower:current,upper:current+currentPotential}};
}
export function qualifiedAttentionEntryBound(baseline:BaselineAssessment[],criterion:AttentionSupportCriterion):AttentionEntryBoundWitness|null{
 const a=baseline.find(a=>a.id===(criterion==='growth'?'A18':'A15')&&a.quality!=='STALE'),raw=(a?.data as {entryBounds?:unknown}|undefined)?.entryBounds;
 const parsed=attentionEntryBoundsSchema.extend({inspectionComplete:z.literal(true)}).safeParse(raw);
 if(!a||!parsed.success||!parsed.data.complete||!a.projection||!a.evidenceIds.length)return null;
 const b=parsed.data;if(new Set(b.sourceIds).size!==b.sourceIds.length||JSON.stringify(b.sourceIds)!==JSON.stringify(b.dispositions.map(d=>d.sourceId))||!b.sourceIds.every(id=>a.evidenceIds.includes(id))||!b.dispositions.every(d=>d.citations.length>0&&d.citations.every(c=>c.sourceId===d.sourceId)))return null;
 const status=criterion==='growth'?(b.current.lower>b.previous.upper?'PASS':b.current.upper<=b.previous.lower?'FAIL':null):b.posts.lower>=(criterion==='qualifiedSample'?10:3)&&b.accounts.lower>=3?'PASS':b.posts.upper<(criterion==='qualifiedSample'?10:3)||b.accounts.upper<3?'FAIL':null;
 if(!status)return null;
 const refs=b.dispositions.filter(d=>d.classification!=='EXCLUDED').flatMap(d=>d.citations).slice(0,10),citations=refs.length?refs:b.dispositions.flatMap(d=>d.citations).slice(0,10);
 const rationale=criterion==='growth'?'Within this fixed collected sample, previous originals are bounded '+b.previous.lower+'–'+b.previous.upper+' and current originals '+b.current.lower+'–'+b.current.upper+'.':'Within this fixed collected sample, original posts are bounded '+b.posts.lower+'–'+b.posts.upper+' and accounts '+b.accounts.lower+'–'+b.accounts.upper+' against the '+(criterion==='qualifiedSample'?10:3)+' posts / 3 accounts criterion.';
 return {method:b.method,criterion,status,rationale,citations,evidenceIds:a.evidenceIds,availableAt:a.projection.availableAt,start:b.start,end:b.end,bounds:{posts:b.posts,accounts:b.accounts,previous:b.previous,current:b.current}};
}
/** One selected evidence route for fresh bounded entry criteria; exact facts remain independent. */
export type AttentionEntryOutcome='SUPPORTED'|'CONTRADICTED'|'INSUFFICIENT'|'UNKNOWN';
export const combineAttentionOutcomes=(outcomes:AttentionEntryOutcome[],any=false):AttentionEntryOutcome=>any?outcomes.includes('SUPPORTED')?'SUPPORTED':outcomes.every(x=>x==='CONTRADICTED')?'CONTRADICTED':outcomes.includes('UNKNOWN')?'UNKNOWN':'INSUFFICIENT':outcomes.includes('CONTRADICTED')?'CONTRADICTED':outcomes.includes('UNKNOWN')?'UNKNOWN':outcomes.includes('INSUFFICIENT')?'INSUFFICIENT':'SUPPORTED';
export type AttentionEntryResolution={criterion:AttentionSupportCriterion;outcome:'SUPPORTED'|'CONTRADICTED'|'INSUFFICIENT'|'UNKNOWN';status:'PASS'|'FAIL'|'UNKNOWN';basis:'RULE_SATISFIED'|'FACTUAL_COUNTEREVIDENCE'|'PUBLIC_SUPPORT_INADEQUATE'|'EVALUATION_INCOMPLETE';route:'measured'|'bounded'|'composite'|'blocked';featureIds:string[];evidenceIds:string[];citations:Array<{sourceId:string;quote:string}>;availableAt:string;start:string;end:string;rationale:string;bounds?:AttentionEntryBoundWitness['bounds'];components?:AttentionEntryResolution[]};
export type OriginEntryResolution={criterion:'originTraceability';outcome:'SUPPORTED'|'CONTRADICTED'|'INSUFFICIENT'|'UNKNOWN';status:'PASS'|'FAIL'|'UNKNOWN';basis:'RULE_SATISFIED'|'FACTUAL_COUNTEREVIDENCE'|'PUBLIC_SUPPORT_INADEQUATE'|'EVALUATION_INCOMPLETE';route:'reviewed'|'blocked';featureIds:string[];evidenceIds:string[];citations:Array<{sourceId:string;quote:string}>;availableAt:string;start:string;end:string;rationale:string};
const originEntryRecordSchema=z.object({method:z.literal('evidence-constitution-v1'),criterion:z.literal('NAR-02'),decision:binaryPublicEntryDecisionV5Schema,availableAt:z.string(),start:z.string(),end:z.string(),evidenceIds:z.array(z.string()).min(1)}).strict();
export function resolveOriginEntryCriterion(baseline:BaselineAssessment[]):OriginEntryResolution|null{
 const owner=baseline.find(a=>a.id==='A03'),data=owner?.data as {semanticJudgmentMethod?:unknown;entryCriterionDecision?:unknown;originResolutionBlocker?:string}|undefined;
 if(data?.semanticJudgmentMethod!=='evidence-constitution-v1')return null;
 const parsed=originEntryRecordSchema.safeParse(data.entryCriterionDecision),record=parsed.success?parsed.data:undefined;
 const valid=!!record&&owner?.quality!=='STALE'&&record.evidenceIds.every(id=>owner?.evidenceIds.includes(id))&&Number.isFinite(Date.parse(record.availableAt))&&Date.parse(record.start)<Date.parse(record.end)&&Date.parse(record.end)<=Date.parse(record.availableAt)&&owner?.projection?.availableAt===record.availableAt;
 const outcome:OriginEntryResolution['outcome']=!valid?'UNKNOWN':record!.decision.verdict==='PASS'?'SUPPORTED':record!.decision.negativeBasis==='FACTUAL_COUNTEREVIDENCE'?'CONTRADICTED':'INSUFFICIENT';
 return {criterion:'originTraceability',outcome,status:outcome==='SUPPORTED'?'PASS':outcome==='UNKNOWN'?'UNKNOWN':'FAIL',basis:outcome==='SUPPORTED'?'RULE_SATISFIED':outcome==='CONTRADICTED'?'FACTUAL_COUNTEREVIDENCE':outcome==='INSUFFICIENT'?'PUBLIC_SUPPORT_INADEQUATE':'EVALUATION_INCOMPLETE',route:valid?'reviewed':'blocked',featureIds:['A03'],evidenceIds:valid?record!.evidenceIds:[],citations:valid?record!.decision.citations:[],availableAt:record?.availableAt??owner?.projection?.availableAt??'',start:record?.start??'',end:record?.end??'',rationale:valid?record!.decision.rationale:data.originResolutionBlocker??owner?.causes[0]?.code??'ATT_ENTRY_REVIEW_INCOMPLETE'};
}
export function resolveAttentionEntryCriterion(baseline:BaselineAssessment[],criterion:AttentionSupportCriterion):AttentionEntryResolution|null{
 const owner=baseline.find(a=>a.id===(criterion==='growth'?'A18':'A15'));
 const raw=(owner?.data as {entryBounds?:unknown}|undefined)?.entryBounds;
 if(raw===undefined)return null;
 const parsed=attentionEntryBoundsSchema.extend({inspectionComplete:z.literal(true)}).safeParse(raw);
 const known=(id:string)=>baseline.find(a=>a.id===id&&a.quality==='KNOWN'&&a.projection?.quality==='KNOWN');
 const make=(outcome:AttentionEntryResolution['outcome'],route:AttentionEntryResolution['route'],ids:string[],rationale:string,extra:Partial<AttentionEntryResolution>={}):AttentionEntryResolution=>({criterion,outcome,status:outcome==='SUPPORTED'?'PASS':outcome==='UNKNOWN'?'UNKNOWN':'FAIL',basis:outcome==='SUPPORTED'?'RULE_SATISFIED':outcome==='CONTRADICTED'?'FACTUAL_COUNTEREVIDENCE':outcome==='INSUFFICIENT'?'PUBLIC_SUPPORT_INADEQUATE':'EVALUATION_INCOMPLETE',route,featureIds:ids,evidenceIds:[...new Set(ids.flatMap(id=>baseline.find(a=>a.id===id)?.evidenceIds??[]))],citations:[],availableAt:owner?.projection?.availableAt??'',start:parsed.success?parsed.data.start:'',end:parsed.success?parsed.data.end:'',rationale,...extra});
 const b=parsed.success?parsed.data:null;
 const valid=!!b&&b.complete&&owner?.quality!=='STALE'&&!!owner?.projection&&!!owner.evidenceIds.length&&new Set(b.sourceIds).size===b.sourceIds.length&&JSON.stringify(b.sourceIds)===JSON.stringify(b.dispositions.map(d=>d.sourceId))&&b.sourceIds.every(id=>owner.evidenceIds.includes(id))&&b.dispositions.every(d=>d.citations.length>0&&d.citations.every(c=>c.sourceId===d.sourceId));
 const measured=known('A15')?.projection?.value===true&&typeof known('A16')?.projection?.value==='string'&&typeof known('A17')?.projection?.value==='string';
 let sample:AttentionEntryResolution;
 if(criterion==='growth'&&typeof known('A18')?.projection?.value==='boolean')sample=make(known('A18')!.projection!.value?'SUPPORTED':'CONTRADICTED','measured',['A18'],'Qualified fixed-sample growth measurement.');
 else if(criterion!=='growth'&&measured){const pass=new Decimal(known('A16')!.projection!.value as string).gte(criterion==='qualifiedSample'?10:3)&&new Decimal(known('A17')!.projection!.value as string).gte(3);sample=make(pass?'SUPPORTED':'CONTRADICTED','measured',['A15','A16','A17'],'Qualified original post and source-account measurements.');}
 else if(valid&&b){const bound=qualifiedAttentionEntryBound(baseline,criterion),citations=b.dispositions.flatMap(d=>d.citations).slice(0,10);sample=make(bound?(bound.status==='PASS'?'SUPPORTED':'CONTRADICTED'):'INSUFFICIENT','bounded',[criterion==='growth'?'A18':'A15'],bound?.rationale??'The complete independently inspected fixed sample cannot establish this minimum from its conservative intervals; exact activity remains unresolved.',{citations:bound?.citations??citations,bounds:{posts:b.posts,accounts:b.accounts,previous:b.previous,current:b.current}});}
 else {const support=qualifiedAttentionEntrySupport(baseline,criterion);sample=support?make('INSUFFICIENT','bounded',[criterion==='growth'?'A18':'A15'],support.rationale,{citations:support.citations}):make('UNKNOWN','blocked',[criterion==='growth'?'A18':'A15'],'Acquisition, accepted role review or independent full-source inspection is incomplete.');}
 if(criterion!=='attentionContext')return sample;
 const narrative=['A01','A02','A05'].map(id=>{
  const a=known(id),d=a?.data as {method?:string;outcomeBasisMethod?:string;entryDecisionMethod?:string;originBasis?:string;decision?:{verdict?:string;negativeBasis?:string;basis?:string;citations?:Array<{sourceId:string;quote:string}>};publicSupport?:{citations?:Array<{sourceId:string;quote:string}>};citations?:Array<{sourceId:string;quote:string}>}|undefined;
  let outcome:AttentionEntryOutcome=!a?'UNKNOWN':a.projection?.value===true?'SUPPORTED':'CONTRADICTED';
  if(a?.projection?.value===false){if(d?.entryDecisionMethod&&d.decision?.verdict==='FAIL')outcome=d.outcomeBasisMethod==='entry-outcome-basis-v1'?(d.decision.negativeBasis==='FACTUAL_COUNTEREVIDENCE'?'CONTRADICTED':d.decision.negativeBasis==='PUBLIC_SUPPORT_INADEQUATE'?'INSUFFICIENT':'UNKNOWN'):d.decision.basis==='EVIDENCE_INADEQUACY'?'INSUFFICIENT':'UNKNOWN';else if(d?.method==='narrative-public-support-v1'||d?.originBasis==='PUBLIC_EVIDENCE_INADEQUATE')outcome='INSUFFICIENT';}
  return make(outcome,a?'measured':'blocked',[id],'Qualified narrative component '+id,{citations:d?.decision?.citations??d?.publicSupport?.citations??d?.citations??[]});
 });
 const all=[...narrative,sample],outcome=combineAttentionOutcomes(all.map(r=>r.outcome));
 const selected=outcome==='CONTRADICTED'?[all.find(r=>r.outcome==='CONTRADICTED')!]:all;
 return make(outcome,'composite',[...new Set(selected.flatMap(r=>r.featureIds))],selected.map(r=>r.rationale).join(' '),{components:selected,evidenceIds:[...new Set(selected.flatMap(r=>r.evidenceIds))],citations:selected.flatMap(r=>r.citations).slice(0,10),...(sample.bounds?{bounds:sample.bounds}:{})});
}
/** Only a fresh, independently selected entry-support witness can replace an unresolved fact route. */
export function qualifiedAttentionEntrySupport(baseline:BaselineAssessment[],criterion:AttentionSupportCriterion){
 const known=(id:string)=>baseline.find(a=>a.id===id&&a.quality==='KNOWN'&&a.projection?.quality==='KNOWN');
 const measured=known('A15')?.projection?.value===true&&typeof known('A16')?.projection?.value==='string'&&typeof known('A17')?.projection?.value==='string';
 if(criterion==='growth'&&known('A18')||criterion==='qualifiedSample'&&measured||criterion==='attentionContext'&&(measured&&['A01','A02','A05'].every(id=>known(id))||['A01','A02','A05'].some(id=>known(id)?.projection?.value===false)))return null;
 const a=baseline.find(a=>a.id===(criterion==='growth'?'A18':'A15')&&a.quality!=='STALE'),d=a?.data as {entrySupport?:{method?:string;scope?:{complete?:boolean;sourceIds?:string[]};judgments?:unknown}}|undefined;
 const record=d?.entrySupport,parsed=attentionEntrySupportSchema.safeParse(record?.judgments);
 if(record?.method!=='reviewed-sample-growth-v1'||record.scope?.complete!==true||!parsed.success)return null;
 const judgment=parsed.data[criterion];return judgment.verdict==='INADEQUATE'&&judgment.citations.every(c=>record.scope!.sourceIds?.includes(c.sourceId))?{...judgment,evidenceIds:a!.evidenceIds,availableAt:a!.projection?.availableAt}:null;
}
function validatePublicRepresentationDecision(read:AttentionRead,decision:z.output<typeof publicRepresentationBasisSchema>,proposal:z.output<typeof attentionProposalSchema>,review:z.output<typeof attentionReviewSchema>,token:TokenRef,cutoff:string,scope:ReturnType<typeof entryEvidenceScope>){
 if(decision.verdict!=='PASS')return true;
 const citedView=read.claimEvidenceMethod==='cited-claim-view-v1';
 if(!scope.complete||!citedView&&(read.comparisonComplete!==true||review.candidateSet?.complete!==true)||!read.comparisonAcquisition?.searchSucceeded||!read.comparisonAcquisition.descriptorComplete)return false;
 const tokenKey=(value:TokenRef)=>`${value.chain}:${value.chain==='solana'?value.address:value.address.toLowerCase()}`;
 const names=(text:string,value:TokenRef)=>value.chain==='solana'?text.includes(value.address):text.toLowerCase().includes(value.address.toLowerCase());
 const validAddress=(value:TokenRef)=>{if(value.chain!=='solana')return /^0x[0-9a-fA-F]{40}$/.test(value.address);try{return new PublicKey(value.address).toBase58()===value.address;}catch{return false;}};
 const allowed=new Set(scope.sourceIds),available=(sourceId:string)=>{const source=read.sources.find(s=>s.id===sourceId),at=source?Date.parse(source.availableAt):NaN;return !!source&&allowed.has(sourceId)&&Number.isFinite(at)&&at<=Date.parse(cutoff)&&Date.parse(cutoff)-at<=900000?source:undefined;};
 if(!decision.citations.every(c=>{const source=available(c.sourceId);return !!source&&source.text.includes(c.quote);})||!decision.citations.some(c=>names(c.quote,token)))return false;
 if(citedView){
  if(!validAddress(token))return false;
  const witnesses=decision.witnesses??[],actual=new Map<string,TokenRef>();
  for(const witness of witnesses){
   if(!validAddress(witness.token))return false;
   const key=tokenKey(witness.token);if(actual.has(key))return false;
   const refs=witness.citations;
   if(!refs.every(c=>{const source=available(c.sourceId);return !!source&&source.text.includes(c.quote)&&!(read.narrativeContentMethod==='typed-metadata-content-v1'&&identityOnlyTokenMetadata(read,c.sourceId,token));})
      ||!refs.some(c=>names(c.quote,witness.token))
      ||key===tokenKey(token)&&!refs.every(c=>narrativeSourceBound(read,c.sourceId,token)))return false;
   actual.set(key,witness.token);
  }
  const targetKey=tokenKey(token);
  if(!actual.has(targetKey))return false;
  if(decision.basis==='IDENTIFIED_REPRESENTATIONS')return actual.size>1;
  return decision.basis==='NO_RELEVANT_ALTERNATIVE'&&actual.size===1;
 }
 const accepted=new Set(review.decisions.filter(d=>d.accepted).map(d=>d.id)),expected=new Map<string,TokenRef>();
 let targetCandidate=false;
 for(const candidate of proposal.competitors){
  if(!accepted.has(candidate.id))continue;
  if(!read.comparisonSourceIds?.includes(candidate.sourceId)||!validAddress(candidate.token))return false;
  const source=available(candidate.sourceId);
  if(!source||!source.text.includes(candidate.quote)||!names(candidate.quote,candidate.token))return false;
  const key=tokenKey(candidate.token);expected.set(key,candidate.token);if(key===tokenKey(token))targetCandidate=true;
 }
 if(!targetCandidate)return false;
 expected.set(tokenKey(token),token);
 const witnesses=decision.witnesses??[],actual=new Map<string,TokenRef>();
 for(const witness of witnesses){
  if(!validAddress(witness.token))return false;
  const key=tokenKey(witness.token);if(actual.has(key))return false;
  const refs=witness.citations;
  if(!refs.every(c=>{const source=available(c.sourceId);return !!source&&source.text.includes(c.quote);})||!refs.some(c=>names(c.quote,witness.token)))return false;
  actual.set(key,witness.token);
 }
 if(actual.size!==expected.size||[...expected.keys()].some(key=>!actual.has(key)))return false;
 if(decision.basis==='IDENTIFIED_REPRESENTATIONS')return expected.size>1&&actual.has(tokenKey(token));
 return decision.basis==='NO_RELEVANT_ALTERNATIVE'&&expected.size===1&&actual.size===1&&actual.has(tokenKey(token));
}
export function qualifiedBinaryEntryDecisions(read:AttentionRead,review:z.output<typeof attentionReviewSchema>,token:TokenRef,cutoff:string,proposal?:unknown){
 if(read.semanticPremiseMethod!==undefined&&read.semanticPremiseMethod!=='criterion-premises-v1')return null;
 if(read.narrativeContentMethod!==undefined&&read.narrativeContentMethod!=='typed-metadata-content-v1')return null;
 if(read.entryEvidenceMethod){
  const d=review.entryDecisions;
  if(read.outcomeBasisMethod&&(d?.outcomeBasisMethod!==read.outcomeBasisMethod||[d.originTraceability,d.leadership,...('representations' in d?[d.representations]:[]),...('explainableThesis' in d?[d.explainableThesis]:[]),...(d.method==='binary-public-support-v5'&&d.narrativeGame?[d.narrativeGame]:[])].some(g=>g.verdict==='FAIL'?!g.negativeBasis:g.negativeBasis!==undefined)))return null;
  const scope=entryEvidenceScope(read,token,cutoff),expectedMethod=read.claimDecisionMethod==='independent-grounded-claims-v1'?'binary-public-support-v5':read.leadershipPositiveMethod==='source-bound-positive-v1'?'binary-public-support-v4':read.entryExecutionMethod==='entry-first-v2'?'binary-public-support-v3':'binary-public-support-v2';
  if(d?.method!==expectedMethod||!d.inspectionComplete||!scope.complete||JSON.stringify(d.sourceIds)!==JSON.stringify(scope.sourceIds))return null;
  if(read.narrativeContentMethod==='typed-metadata-content-v1'){try{if(d?.narrativeContentMethod!==read.narrativeContentMethod||JSON.stringify(d.contentScope)!==JSON.stringify(buildNarrativeContentScope(read,token)))return null;}catch{return null;}}else if(d?.narrativeContentMethod!==undefined||d?.contentScope!==undefined)return null;
  const narrativeGame=d.method==='binary-public-support-v5'?d.narrativeGame:undefined;
  if(read.claimEvidenceMethod==='cited-claim-view-v1'?!narrativeGame:narrativeGame!==undefined)return null;
  if(!read.semanticPremiseMethod&&(d.semanticPremiseMethod!==undefined||d.method==='binary-public-support-v5'&&[d.originTraceability,d.explainableThesis,d.narrativeGame].some(g=>g?.criterionProof!==undefined)))return null;
  if(read.semanticPremiseMethod==='criterion-premises-v1'&&(d.method!=='binary-public-support-v5'||d.semanticPremiseMethod!==read.semanticPremiseMethod||!narrativeGame||!validCriterionProof(read,'NAR-01',narrativeGame)||!validCriterionProof(read,'NAR-02',d.originTraceability)||!validCriterionProof(read,'NAR-03',d.explainableThesis)))return null;
  if(!attentionAcquisitionInspected(read,d))return null;
  const criteria=[['originTraceability',d.originTraceability],['leadership',d.leadership],...('representations'in d?[['representations',d.representations]]:[]),...('explainableThesis'in d?[['explainableThesis',d.explainableThesis]]:[]),...(narrativeGame?[['narrativeGame',narrativeGame]]:[])] as Array<[Parameters<typeof attentionPublicCitationAllowed>[3],{verdict:'PASS'|'FAIL';negativeBasis?:string;citations:Array<{sourceId:string;quote:string}>}]>;
  if(!criteria.every(([criterion,grade])=>grade.citations.every(ref=>attentionPublicCitationAllowed(read,token,cutoff,criterion,grade,ref))))return null;
  if(d.method==='binary-public-support-v5'){
   const selected=attentionEntryContext(read,proposal,review);
   if(!selected||!validatePublicRepresentationDecision(read,d.representations,selected,review,token,cutoff,scope))return null;
  }
  return d;
 }

 const d=review.entryDecisions,scope=originSourceScope(read,token);
 if(!d?.inspectionComplete||!scope.complete||!scope.sourceIds.length||JSON.stringify(scope)!==JSON.stringify(read.originScope)||JSON.stringify(d.sourceIds)!==JSON.stringify(scope.sourceIds)||!comparisonResearchComplete(read,cutoff))return null;
 const sources=read.sources.filter(s=>scope.sourceIds.includes(s.id));
 if(sources.some(s=>s.text.length>6000||!Number.isFinite(Date.parse(s.availableAt))||Date.parse(s.availableAt)>Date.parse(cutoff)||Date.parse(cutoff)-Date.parse(s.availableAt)>900000))return null;
 if(![d.originTraceability,d.leadership].every(g=>g.citations.every(c=>sources.some(s=>s.id===c.sourceId&&s.text.includes(c.quote)))))return null;
 if(!d.originTraceability.citations.every(c=>{const s=sources.find(s=>s.id===c.sourceId)!;return token.chain==='solana'?s.text.includes(token.address):s.text.toLowerCase().includes(token.address.toLowerCase());}))return null;
 return d;
}
const featureIds=['A01','A02','A03','A04','A05','A09','A10','A11','A14','A15','A16','A17'];
export function deriveAttention(read:AttentionRead,proposal:unknown,review:unknown,token:TokenRef,cutoff:string,evidenceIds:string[],growth=false,entryGroups=false):BaselineAssessment[]{
  const output=new Map<string,BaselineAssessment>();
  const routeData=(id:string,data:unknown)=>id==='A14'&&read.comparisonComplete!==undefined?{
    originRelationship:{status:'UNKNOWN',rationale:'Primary-origin relationship has not been independently qualified.',citations:[]},
    measuredAttention:{status:'UNKNOWN',shares:[]},...(data as Record<string,unknown>),method:'representation-routes-v2',
  }:data;
  const entryBlocker=read.entryEvidenceMethod?entryEvidenceScope(read,token,cutoff).blockers[0]??read.codes.find(c=>c.startsWith('ATT_MODEL_ENTRY_')):undefined;
  const set=(id:string,value:string|boolean|null,data:unknown,known:boolean,code='ATT_QUALIFICATION_MISSING',unit=typeof value==='string'?'count':'bool')=>{if(!known&&['A03','A09','A11','A14'].includes(id)&&entryBlocker)code=entryBlocker;return output.set(id,{id,version:'baseline-v1',evaluator:'IMPLEMENTED',collector:'IMPLEMENTED',quality:known?'KNOWN':'MISSING',unit,data:routeData(id,{...data as object,...(['A01','A02','A03','A05'].includes(id)&&read.semanticPremiseMethod?{semanticPremiseMethod:read.semanticPremiseMethod}:{}),...(id==='A05'&&read.sharedClaimProjectionMethod?{sharedClaimProjectionMethod:read.sharedClaimProjectionMethod}:{}),...(id==='A03'&&read.semanticJudgmentMethod?{semanticJudgmentMethod:read.semanticJudgmentMethod,originResolutionBlocker:entryBlocker??read.codes.find(c=>c.startsWith('ATT_MODEL_'))??(/^(ATT_(?:PROPOSAL_SCHEMA_INVALID|REVIEW_SCHEMA_INVALID|CLAIM_FINALS_INVALID|REVIEW_SCOPE_COVERAGE_INVALID|REVIEW_COVERAGE_INVALID))$/.test(code)?code:'ATT_ENTRY_REVIEW_INCOMPLETE')}:{}) ,...(read.outcomeBasisMethod?{outcomeBasisMethod:read.outcomeBasisMethod}:{}),...(read.acquisitionEvidenceMethod?{acquisitionEvidenceMethod:read.acquisitionEvidenceMethod}:{})}),observationIds:[],evidenceIds,limitations:['automated-source-review-v1; bounded search sample, not verified reality or exhaustive social coverage'],causes:known?[]:[{category:code.includes('REVIEW')||code.includes('QUALIFICATION')?'CLAIM_UNVALIDATED':'EVIDENCE_UNAVAILABLE',code,featureId:id,evidenceIds,action:'Refresh the bounded attention sources and automated review; inspect retained source and reviewer decisions.'}],projection:{id,value:known?value:null,unit,quality:known?'KNOWN':'MISSING',availableAt:cutoff,evidenceIds,applicability:'APPLICABLE'}})};
  const activeIds=growth?[...featureIds,'A18']:featureIds;
  for(const id of activeIds)set(id,null,{method:'automated-source-review-v1',codes:read.codes},false,read.codes[0]??'ATT_QUALIFICATION_MISSING');
  const invalid=(code:string)=>{for(const id of activeIds)set(id,null,{method:'automated-source-review-v1',codes:[code,...read.codes]},false,code);return [...output.values()];};
  const p=attentionProposalSchema.safeParse(proposal),r=attentionReviewSchema.safeParse(review);
  if(!p.success||!r.success)return read.codes.some(c=>c.startsWith('ATT_MODEL_')||c==='ATT_NO_SOURCES')?[...output.values()]:invalid(!p.success?'ATT_PROPOSAL_SCHEMA_INVALID':'ATT_REVIEW_SCHEMA_INVALID');
  const selectedProposal=attentionEntryContext(read,p.data,r.data);
  if(!selectedProposal)return invalid('ATT_CLAIM_FINALS_INVALID');
  if(read.comparisonComplete!==undefined&&(!r.data.candidateSet||!r.data.originRelationship))return invalid('ATT_REVIEW_SCOPE_COVERAGE_INVALID');
  const items=[...p.data.claims,...p.data.posts,...p.data.competitors],ids=items.map(i=>i.id),decisions=new Map(r.data.decisions.map(d=>[d.id,d]));
  if(new Set(ids).size!==ids.length||new Set(p.data.claims.map(c=>c.feature)).size!==p.data.claims.length||decisions.size!==r.data.decisions.length||decisions.size!==ids.length||ids.some(id=>!decisions.has(id)))return invalid('ATT_REVIEW_COVERAGE_INVALID');
  const sources=new Map(read.sources.map(s=>[s.id,s]));
  const same=(t:TokenRef)=>t.chain===token.chain&&(t.chain==='solana'?t.address===token.address:t.address.toLowerCase()===token.address.toLowerCase());
  const names=(text:string,t:TokenRef)=>t.chain==='solana'?text.includes(t.address):text.toLowerCase().includes(t.address.toLowerCase());
  const cite=(c:{sourceId:string;quote:string})=>{const s=sources.get(c.sourceId);return s&&s.text.includes(c.quote)&&Date.parse(s.availableAt)<=Date.parse(cutoff)&&Date.parse(cutoff)-Date.parse(s.availableAt)<=900000?s:undefined;};
  const accepted=(id:string)=>decisions.get(id)?.accepted===true;
  const acceptedClaim=(id:string)=>read.claimDecisionMethod==='independent-grounded-claims-v1'?selectedProposal.claims.some(c=>c.id===id):accepted(id);
  if(!selectedProposal.claims.some(c=>c.feature==='A03'))set('A03',null,{method:'automated-source-review-v1',originScope:read.originScope},false,read.originScope?.complete===false?'ATT_ORIGIN_DISCOVERY_INCOMPLETE':'ATT_PRIMARY_ORIGIN_REVIEW_UNRESOLVED');
  for(const c of selectedProposal.claims){
    const bound=c.citations.every(ref=>{const s=cite(ref);return s&&(names(s.text,token)||c.feature!=='A03'&&narrativeSourceBound(read,s.id,token));});
    const explanation=c.explanation?{explanation:c.explanation}:{};
    const consistent=!c.explanation||c.feature==='A05'&&c.value===(c.explanation.prerequisites.length===0);
    const scope=read.originScope,inspected=r.data.originScopeReview;
    const inadequate=c.originBasis==='PUBLIC_EVIDENCE_INADEQUATE';
    const originReady=!inadequate||c.feature==='A03'&&c.value===false&&scope?.complete===true&&c.citations.every(ref=>scope.sourceIds.includes(ref.sourceId))&&inspected?.complete===true&&new Set(inspected.sourceIds).size===scope.sourceIds.length&&inspected.sourceIds.length===scope.sourceIds.length&&scope.sourceIds.every(id=>inspected.sourceIds.includes(id));
    if(!originReady)set(c.feature,null,{proposedSummary:c.summary,citations:c.citations,review:decisions.get(c.id)},false,'ATT_ORIGIN_EVIDENCE_REVIEW_INCOMPLETE');
    else if(!consistent)set(c.feature,null,{proposedSummary:c.summary,...explanation,citations:c.citations,review:decisions.get(c.id)},false,'ATT_QUALIFICATION_EXPLANATION_INVALID');
    else if(bound&&acceptedClaim(c.id))set(c.feature,c.value,{summary:c.summary,...explanation,...(c.criterionProof?{criterionProof:c.criterionProof}:{}),citations:c.citations,review:decisions.get(c.id),...(read.claimDecisionMethod?{claimDecisionMethod:read.claimDecisionMethod,proposalReviewAccepted:accepted(c.id)}:{}),method:'automated-source-review-v1',...(inadequate?{originBasis:c.originBasis,originScopeReview:inspected,meaning:'Inadequate public origin evidence in the reviewed discovery scope; not proof of fraud or absence everywhere.'}:{})},true);
    else {set(c.feature,null,{proposedSummary:c.summary,...explanation,citations:c.citations,review:decisions.get(c.id)},false,bound?'ATT_REVIEW_REJECTED':'ATT_CITATION_BINDING_INVALID');const a=output.get(c.feature)!;if(bound)a.causes[0].action=`Automated review rejected this source judgment: ${decisions.get(c.id)!.rationale}`;}
  }
  const factualOrigin=output.get('A03')!;
 const binary=growth?qualifiedBinaryEntryDecisions(read,r.data,token,cutoff,p.data):null;
 if(read.semanticJudgmentMethod==='evidence-constitution-v1'&&!binary)factualOrigin.data={...factualOrigin.data as object,originResolutionBlocker:entryBlocker??read.codes.find(c=>c.startsWith('ATT_MODEL_'))??'ATT_ENTRY_REVIEW_INCOMPLETE'};
 if(read.semanticJudgmentMethod==='evidence-constitution-v1'&&binary){factualOrigin.data={...factualOrigin.data as object,entryCriterionDecision:{method:read.semanticJudgmentMethod,criterion:'NAR-02',decision:binary.originTraceability,availableAt:cutoff,start:read.start,end:read.end,evidenceIds}};}
 if(!read.semanticJudgmentMethod&&factualOrigin.quality!=='KNOWN'&&binary){const d=binary.originTraceability;set('A03',d.verdict==='PASS',{method:binary.method,entryCriterion:'NAR-02',entryDecisionMethod:binary.method,decision:d,assertion:'MODEL_INFERENCE',summary:'Entry origin/catalyst evidence standard '+d.verdict+': '+d.rationale,citations:d.citations,factualAssessment:{quality:factualOrigin.quality,value:factualOrigin.projection?.value,data:factualOrigin.data},meaning:'Public entry evidence sufficiency; factual provenance is unchanged.'},true);}
  const publicOrigin=growth?qualifiedOriginScreen(read,r.data,token,cutoff):null;
  const trace=publicOrigin?.originTraceability;
  if(!read.semanticJudgmentMethod&&factualOrigin.quality!=='KNOWN'&&trace?.verdict==='INADEQUATE'&&trace.review.accepted)set('A03',false,{method:'origin-traceability-screen-v2',entryCriterion:'ORIGIN_TRACEABILITY',originBasis:'PUBLIC_EVIDENCE_INADEQUATE',assertion:'MODEL_INFERENCE',summary:trace.rationale,citations:trace.citations,review:trace.review,publicSupport:trace,factualAssessment:{quality:factualOrigin.quality,value:factualOrigin.projection?.value,data:factualOrigin.data},meaning:'Bounded public traceability grade; factual provenance remains unresolved.'},true);
  for(const [id,criterion]of [['A01','NARRATIVE_DESCRIPTION'],['A05','EXPLAINABLE_THESIS']] as const){
    const prior=output.get(id),support=growth&&!read.semanticPremiseMethod&&prior?.quality!=='KNOWN'?qualifiedNarrativeSupport(read,token,cutoff,criterion):null;
    if(support)set(id,false,{method:'narrative-public-support-v1',entryCriterion:criterion,publicSupport:support,factualAssessment:{quality:'MISSING',value:null,data:prior?.data},meaning:'Reviewed inadequate public narrative support; factual narrative remains unresolved.'},true);
  }
  const validAddress=(t:TokenRef)=>{if(t.chain!=='solana')return /^0x[0-9a-fA-F]{40}$/.test(t.address);try{return new PublicKey(t.address).toBase58()===t.address;}catch{return false;}};
  const v2=read.comparisonComplete!==undefined;
  const candidates=p.data.competitors.filter(c=>validAddress(c.token)&&accepted(c.id)&&cite(c)&&names(c.quote,c.token)&&(!v2||read.comparisonSourceIds?.includes(c.sourceId)));
  const keys=candidates.map(c=>`${c.token.chain}:${c.token.chain==='solana'?c.token.address:c.token.address.toLowerCase()}`);
  const coverage=read.comparisonCoverage===undefined?null:comparisonCoverageSchema.safeParse(read.comparisonCoverage);
  const coverageComplete=coverage===null||coverage.success&&coverage.data.complete&&coverage.data.sourceIds.length===read.comparisonSourceIds?.length&&new Set(coverage.data.sourceIds).size===coverage.data.sourceIds.length&&coverage.data.sourceIds.every(id=>read.comparisonSourceIds?.includes(id))&&JSON.stringify(coverage.data.sourceRequirements.map(s=>s.sourceId))===JSON.stringify(coverage.data.sourceIds);
  const candidateComplete=!entryBlocker&&coverageComplete&&(v2?read.comparisonComplete&&r.data.candidateSet?.complete===true:read.complete)&&candidates.length===p.data.competitors.length&&new Set(keys).size===keys.length&&candidates.some(c=>same(c.token));
  const comparisonCode=read.codes.find(c=>c.startsWith('ATT_MODEL_COMPARISON_'));
  set('A09',true,{queries:read.queries,candidates,review:r.data.candidateSet,scope:read.comparisonQualification?'qualified identified-lead sample; unread original pages and refinement proofs retained; not undiscovered representations':'discovered source-reviewed representations; absence outside this sample is not established',...(read.comparisonQualification?{qualification:read.comparisonQualification}:{})},!!candidateComplete,comparisonCode??'ATT_CANDIDATE_SCOPE_INCOMPLETE');
  set('A10',true,{candidates},!!candidateComplete,'ATT_BINDING_UNRESOLVED');
  const adequacy=growth&&!entryBlocker&&!candidateComplete?qualifiedComparisonEvidence(read,cutoff,token):null;
  if(adequacy)set('A09',false,{method:'public-representation-screen-v1',evidenceAdequacy:adequacy,scope:'Reviewed inadequate public representation evidence; not a proven competitor or fraud finding'},true);
 const factualComparison=output.get('A09')!;
 const comparisonDecision=growth&&!entryBlocker&&factualComparison.quality!=='KNOWN'?(binary&&'representations' in binary?binary.representations:qualifiedBinaryComparisonDecision(read,cutoff)):null;
 if(comparisonDecision)set('A09',comparisonDecision.verdict==='PASS',{method:binary?.method??'binary-public-support-v1',entryDecisionMethod:binary?.method??'binary-public-support-v1',entryCriterion:'CAN-01',decision:comparisonDecision,factualAssessment:{quality:factualComparison.quality,value:factualComparison.projection?.value,data:factualComparison.data},meaning:'Public entry evidence sufficiency; factual representations remain separately qualified.'},true);
  const posts=read.sources.filter(s=>s.kind==='POST'&&(!read.postSampleSourceIds||read.postSampleSourceIds.includes(s.id)));
  const rankingIds=read.comparisonRankingSourceIds??read.comparisonSourceIds;
  const rankingPosts=read.sources.filter(s=>s.kind==='POST'&&rankingIds?.includes(s.id));
  const labels=new Map(p.data.posts.map(post=>[post.sourceId,post]));
  const reviewedQualification=read.collectionMethod==='project-context-v2';
  const roleReviewed=(id:string)=>r.data.decisions.some(decision=>decision.id===id);
  const allLabeled=labels.size===p.data.posts.length&&posts.every(s=>{const post=labels.get(s.id);if(!post||!s.authorId||!s.publishedAt||!Number.isFinite(Date.parse(s.publishedAt)))return false;const current=Date.parse(s.publishedAt)>=Date.parse(read.start)&&Date.parse(s.publishedAt)<Date.parse(read.end);return reviewedQualification?roleReviewed(post.id)&&!!cite(post):!current||post.role!=='UNCLEAR'&&accepted(post.id)&&!!cite(post);})&&p.data.posts.every(post=>sources.get(post.sourceId)?.kind==='POST');
  const windowValid=Date.parse(read.start)<Date.parse(read.end)&&Date.parse(read.end)<=Date.parse(cutoff)&&Date.parse(cutoff)-Date.parse(read.end)<=900000;
  const complete=posts.length>0&&(read.postSampleComplete??read.complete)&&allLabeled&&windowValid;
  const sampleProblems={
    collectionIncomplete:!(read.postSampleComplete??read.complete),windowInvalid:!windowValid,corpusEmpty:posts.length===0,
    missingMetadata:posts.filter(s=>!s.authorId||!s.publishedAt).map(s=>s.id),
    unqualifiedPosts:posts.filter(s=>{const label=labels.get(s.id);return !label||label.role==='UNCLEAR'||!accepted(label.id)||!cite(label);}).map(s=>s.id),
  };
  const sampleCode=sampleProblems.collectionIncomplete?'ATT_SAMPLE_COLLECTION_INCOMPLETE':sampleProblems.windowInvalid?'ATT_SAMPLE_WINDOW_INVALID':sampleProblems.corpusEmpty?'ATT_POST_CORPUS_UNAVAILABLE':sampleProblems.missingMetadata.length?'ATT_AUTHOR_OR_DATE_MISSING':'ATT_POST_REVIEW_INCOMPLETE';
  const seen=new Set<string>();
  const originals=posts.filter(s=>s.publishedAt&&Date.parse(s.publishedAt)>=Date.parse(read.start)&&Date.parse(s.publishedAt)<Date.parse(read.end)).filter(s=>{const label=labels.get(s.id);const key=(label?.quote??s.text).normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();if(seen.has(key))return false;seen.add(key);return true;});
  const qualified=originals.filter(s=>{const label=labels.get(s.id);return label&&accepted(label.id)&&['CALL','NEWS','JOKE'].includes(label.role)&&names(label.quote,token);});
  const authors=new Set(qualified.map(s=>s.authorId));
  set('A15',true,{raw:posts.length,originals:originals.length,queries:read.queries,start:read.start,end:read.end,sampleProblems,scope:'bounded web-search post sample'},complete,sampleCode);
  set('A16',String(qualified.length),{qualified:qualified.length,excluded:originals.filter(s=>!qualified.includes(s)).map(s=>({id:s.id,role:labels.get(s.id)?.role,...(reviewedQualification?{accepted:accepted(labels.get(s.id)?.id??''),reason:accepted(labels.get(s.id)?.id??'')?'NON_QUALIFYING_ROLE':'ROLE_NOT_QUALIFIED'}:{})})),sampleProblems,method:reviewedQualification?'accepted-original-source-posts-v2':'reviewed-original-source-posts-v1'},complete,sampleCode,'count');
  set('A17',String(authors.size),{authors:[...authors],sampleProblems,meaning:'source account IDs; not unique humans'},complete,sampleCode,'count');
  if(growth){
    const start=Date.parse(read.start),end=Date.parse(read.end),mid=start+(end-start)/2;
    const sample=read.growthSample;
    const comparable=complete&&Number.isSafeInteger(mid)&&read.queries.length>0&&sample?.method==='fixed-query-sample-v1'&&sample.complete&&new Set(sample.sourceIds).size===posts.length&&sample.sourceIds.length===posts.length&&posts.every(s=>sample.sourceIds.includes(s.id)&&Date.parse(s.publishedAt!)<=Date.parse(s.availableAt))&&JSON.stringify(sample.queries)===JSON.stringify(read.queries);
    const previous=qualified.filter(s=>Date.parse(s.publishedAt!)<mid),current=qualified.filter(s=>Date.parse(s.publishedAt!)>=mid);
    set('A18',current.length>previous.length,{method:'fixed-sample-equal-bins-v1',start:read.start,midpoint:Number.isFinite(mid)?new Date(mid).toISOString():null,end:read.end,bucketSeconds:Number.isFinite(end-start)?(end-start)/2000:null,previous:previous.length,current:current.length,previousSourceIds:previous.map(s=>s.id),currentSourceIds:current.map(s=>s.id),queries:read.queries,sample:sample??null,dispositions:posts.map(s=>({id:s.id,publishedAt:s.publishedAt,authorId:s.authorId,role:labels.get(s.id)?.role??'UNCLEAR',accepted:accepted(labels.get(s.id)?.id??''),qualified:qualified.includes(s),bin:read.entrySupportMethod&&!s.publishedAt?'UNRESOLVED':Date.parse(s.publishedAt!)<start||Date.parse(s.publishedAt!)>=end?'OUTSIDE':Date.parse(s.publishedAt!)<mid?'PREVIOUS':'CURRENT'})),scope:'Two equal bins in one fixed acquired and independently reviewed sample; not platform-wide growth'},!!comparable,comparable?'':'ATT_GROWTH_SCOPE_INCOMPLETE');
  }
  const comparisonSeen=new Set<string>();
  const comparable=v2?rankingPosts.filter(s=>s.publishedAt&&Date.parse(s.publishedAt)>=Date.parse(read.start)&&Date.parse(s.publishedAt)<Date.parse(read.end)).filter(s=>{
    const key=(labels.get(s.id)?.quote??s.text).normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
    if(comparisonSeen.has(key))return false;comparisonSeen.add(key);return true;
  }):originals.filter(s=>read.comparisonSourceIds?.includes(s.id));
  const counts=candidates.map(c=>{let count=new Decimal(0);for(const s of comparable){const label=labels.get(s.id);if(!label||!accepted(label.id)||!['CALL','NEWS','JOKE'].includes(label.role))continue;const associated=candidates.filter(x=>names(label.quote,x.token));if(associated.some(x=>x.id===c.id))count=count.add(new Decimal(1).div(associated.length));}return {token:c.token,count};});
  const total=counts.reduce((sum,c)=>sum.add(c.count),new Decimal(0)),target=counts.find(c=>same(c.token));
  const highest=counts.reduce((max,c)=>Decimal.max(max,c.count),new Decimal(0)),ties=counts.filter(c=>c.count.eq(highest)).length;
  const comparablePosts=rankingPosts;
  const comparativeComplete=comparablePosts.length>0&&read.comparisonComplete===true&&windowValid&&comparablePosts.every(s=>{const label=labels.get(s.id);return label&&label.role!=='UNCLEAR'&&accepted(label.id)&&cite(label)&&s.authorId&&s.publishedAt;});
  const comparableQualified=comparable.filter(s=>{const label=labels.get(s.id);return label&&accepted(label.id)&&['CALL','NEWS','JOKE'].includes(label.role)&&candidates.some(c=>names(label.quote,c.token));});
  const leader=!!target&&target.count.eq(highest),rankingKnown=!!candidateComplete&&candidates.length>1&&total.gt(0)&&(v2?comparativeComplete&&comparableQualified.length>=10&&new Set(comparableQualified.map(s=>s.authorId)).size>=3:complete&&comparable.filter(s=>qualified.includes(s)).length>=10);
  const ranking={shares:counts.map(c=>({token:c.token,count:c.count.toFixed(),share:total.gt(0)?c.count.div(total).toFixed():null})),tied:ties>1,sourceIds:comparable.map(s=>s.id),scope:'same common-name query post sample across discovered candidates; exact-target searches excluded'};
  set('A11',leader&&(!v2||ties===1),ranking,rankingKnown,comparisonCode??'ATT_COMPARABLE_SAMPLE_INSUFFICIENT');
  if(!v2)set('A14',leader&&ties===1,ranking,rankingKnown,'ATT_COMPARABLE_SAMPLE_INSUFFICIENT');
  else {
    const origin=r.data.originRelationship;
    const originCitations=origin?.citations??[];
    const originBound=originCitations.length>0&&originCitations.every(ref=>{const s=cite(ref);return s&&names(ref.quote,token);});
    const provenance=selectedProposal.claims.find(c=>c.feature==='A03'&&c.value&&acceptedClaim(c.id));
    const primarySources=provenance?.citations.map(cite).filter(s=>!!s)??[];
    const primaryAccounts=primarySources.flatMap(s=>{if(s.authorId)return [s.authorId];try{const u=new URL(s.url);return /^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname)&&/^\/[A-Za-z0-9_]+\/?$/.test(u.pathname)?[`x.com:${u.pathname.split('/')[1].toLowerCase()}`]:[];}catch{return [];}});
    const datedPrimary=originCitations.some(ref=>{const s=cite(ref);return s?.kind==='POST'&&s.publishedAt&&Date.parse(s.publishedAt)<=Date.parse(read.end)&&s.authorId&&(primarySources.some(primary=>primary.id===s.id)||primaryAccounts.includes(s.authorId));});
    // A03 carries independently accepted primary provenance; origin review separately judges representation/contestation.
    const primary=factualOrigin.projection?.value===true;
    const primaryOptions=read.leadershipPositiveMethod?primaryLeadershipOptions(read,token,cutoff):null;
    const primaryEligible=!primaryOptions||originCitations.some(c=>primaryOptions.some(o=>o.sourceId===c.sourceId&&o.quote===c.quote&&(o.kind!=='POST'||origin?.status==='CONTRADICTED'||p.data.posts.some(post=>post.sourceId===c.sourceId&&post.quote===c.quote&&accepted(post.id)&&['CALL','NEWS','JOKE'].includes(post.role)))));
    const originStatus=originBound&&datedPrimary&&primary&&primaryEligible?origin!.status:'UNKNOWN';
    const measuredStatus=rankingKnown?leader&&ties===1?'SUPPORTED':'CONTRADICTED':'UNKNOWN';
    const screening=r.data.leadershipScreening;
    const screened=!entryBlocker&&originStatus!=='SUPPORTED'&&measuredStatus!=='SUPPORTED'&&screening?.verdict==='INADEQUATE'&&screening.review.accepted&&read.originScope?.complete===true&&(read.comparisonComplete===true||!!qualifiedComparisonEvidence(read,cutoff))&&screening.sourceIds.length===read.originScope.sourceIds.length&&new Set(screening.sourceIds).size===screening.sourceIds.length&&screening.sourceIds.every(id=>read.originScope!.sourceIds.includes(id))&&screening.citations.every(ref=>!!cite(ref))&&(screening.method==='reviewed-public-support-v2'?!!publicOrigin:factualOrigin.quality==='KNOWN');
    const value=originStatus==='SUPPORTED'||measuredStatus==='SUPPORTED'?true:originStatus==='CONTRADICTED'&&measuredStatus==='CONTRADICTED'||screened?false:null;
    const originRationale=origin?.status&&origin.status!=='UNKNOWN'&&originStatus==='UNKNOWN'?`Source review proposed ${origin.status.toLowerCase()}, but primary-account, dated-post or exact-contract citation validation is incomplete. ${origin.rationale}`:origin?.rationale??'Primary-origin relationship has not been independently qualified.';
    set('A14',value,{method:'representation-routes-v2',originRelationship:{status:originStatus,citations:originCitations,rationale:originRationale},measuredAttention:{status:measuredStatus,...ranking},...(screened?{leadershipScreening:screening}:{}),basis:originStatus==='SUPPORTED'?'ORIGIN':measuredStatus==='SUPPORTED'?'MEASURED_ATTENTION':screened?'EVIDENCE_INADEQUACY':null},value!==null,'ATT_REPRESENTATION_ROUTES_UNRESOLVED');
  }
 if((binary?.method==='binary-public-support-v3'||binary?.method==='binary-public-support-v4'||binary?.method==='binary-public-support-v5')&&output.get('A05')?.quality!=='KNOWN'){const prior=output.get('A05')!,d=binary.explainableThesis;set('A05',d.verdict==='PASS',{entryDecisionMethod:binary.method,entryCriterion:'NAR-03',summary:`Entry explainable-thesis evidence standard ${d.verdict}: ${d.rationale}`,citations:d.citations,decision:d,factualAssessment:{quality:prior.quality,value:prior.projection?.value,data:prior.data},meaning:'Explainable-thesis entry public evidence standard after independent full-source review.'},true);}
 if(read.claimEvidenceMethod==='cited-claim-view-v1'&&binary?.method==='binary-public-support-v5'&&'narrativeGame'in binary&&binary.narrativeGame){for(const id of ['A01','A02'] as const){const prior=output.get(id)!;if(prior.quality==='KNOWN')continue;const d=binary.narrativeGame;set(id,d.verdict==='PASS',{entryDecisionMethod:binary.method,entryCriterion:'NAR-01',summary:`Entry narrative/game evidence standard ${d.verdict}: ${d.rationale}`,citations:d.citations,decision:d,factualAssessment:{quality:prior.quality,value:prior.projection?.value,data:prior.data},meaning:'Entry criterion sufficiency only; the underlying factual narrative or game classification remains unresolved.'},true);}}
 if(binary&&output.get('A14')?.quality!=='KNOWN'){const prior=output.get('A14')!,d=binary.leadership;const routes:LeadershipRoutes={...(prior.data as LeadershipRoutes),reviewedPosts:p.data.posts.filter(post=>accepted(post.id)&&['CALL','NEWS','JOKE'].includes(post.role)&&!!cite(post)).map(post=>({sourceId:post.sourceId,quote:post.quote}))};if(!['binary-public-support-v4','binary-public-support-v5'].includes(binary.method)||read.acquisitionEvidenceMethod===acquisitionEvidenceMethod&&binary.leadership.verdict==='FAIL'&&binary.leadership.negativeBasis==='PUBLIC_SUPPORT_INADEQUATE'||validateLeadershipPositive(read,token,cutoff,binary.leadership as Parameters<typeof validateLeadershipPositive>[3],routes))set('A14',d.verdict==='PASS',{...(prior.data as object),entryDecisionMethod:binary.method,entryCriterion:'CAN-02',decision:d,factualAssessment:{quality:prior.quality,value:prior.projection?.value,data:prior.data},meaning:'Public entry evidence sufficiency; factual origin and measured leadership are separate.'},true);}
  if(read.postSampleScope?.complete&&binary?.inspectionComplete&&entryEvidenceScope(read,token,cutoff).complete&&JSON.stringify(read.postSampleScope)===JSON.stringify(terminalPostScope(read))){
    for(const [id,criterion]of [['A15','ATT-01'],['A18','ATT-02']] as const){const a=output.get(id);if(a&&a.quality!=='KNOWN')a.data={method:'entry-evidence-gate-v1',entryCriterion:criterion,verdict:'FAIL',reason:'Complete bounded research and independent inspection left a declared deleted-post gap; the public sample/growth evidence standard is unmet. Actual counts and growth remain unknown.',postSampleScope:read.postSampleScope,factualAssessment:{quality:a.quality,value:a.projection?.value,data:a.data}};}
  }
  // A successfully searched and independently inspected empty sample is poor
  // entry support, not an unfinished review or a claim of global inactivity.
  const emptySearchComplete=read.acquisitionEvidenceMethod!==acquisitionEvidenceMethod&&entryGroups&&posts.length===0&&read.postSampleComplete===true&&windowValid&&read.queries.length>=2&&read.queries.some(q=>q.includes(token.address))&&read.queries.every((_,index)=>{
    try{const packet=JSON.parse(read.rawArtifacts['attention-search-'+(index+1)]);return Array.isArray(packet.results)&&!packet.error&&(!packet.errors||Array.isArray(packet.errors)&&packet.errors.length===0)&&packet.results.every((item:{url?:unknown})=>{if(typeof item?.url!=='string')return false;const url=new URL(item.url);return url.protocol==='https:'&&!(/^(?:www\.)?(?:x|twitter)\.com$/.test(url.hostname)&&/\/status\/\d+/.test(url.pathname));});}catch{return false;}
  });
  if(emptySearchComplete&&binary?.inspectionComplete&&entryEvidenceScope(read,token,cutoff).complete){
    for(const [id,criterion]of [['A15','ATT-01'],['A18','ATT-02']] as const){const a=output.get(id);if(a&&a.quality!=='KNOWN')a.data={method:'entry-evidence-gate-v1',entryCriterion:criterion,verdict:'FAIL',reason:'Successful exact-token bounded searches and independent source inspection did not establish a current post sample. This fails the entry evidence standard; actual global counts and growth remain unknown.',postSampleScope:{method:'reviewed-empty-post-scope-v1',complete:true,sourceIds:[],queries:read.queries},factualAssessment:{quality:a.quality,value:a.projection?.value,data:a.data}};}
  }
  if(read.entrySupportMethod&&binary?.entrySupportMethod===read.entrySupportMethod&&binary.entrySupport){
    const scope=entrySupportScope(read,token,cutoff,p.data,r.data);
    if(scope.complete&&JSON.stringify(binary.entrySupportScope)===JSON.stringify(scope)&&Object.values(binary.entrySupport).every(j=>j.citations.every(c=>(j.verdict==='UNRESOLVED'||scope.sourceIds.includes(c.sourceId))&&(read.sources.some(s=>s.id===c.sourceId&&s.text.includes(c.quote))||read.acquisitionEvidenceMethod===acquisitionEvidenceMethod&&acquisitionCitationAllowed(read.acquisitionScope,c,token,cutoff))))){
      for(const id of ['A15','A18']){const a=output.get(id),needed=id==='A18'?a?.quality!=='KNOWN':a?.quality!=='KNOWN'||['A01','A02','A05'].some(id=>output.get(id)?.quality!=='KNOWN');if(a&&needed)a.data={...a.data as object,entrySupport:{method:read.entrySupportMethod,scope,judgments:binary.entrySupport}};}
    }
  }
  if(read.entryBoundsMethod&&binary?.entryBoundsMethod===read.entryBoundsMethod&&binary.entryBounds){const bounds=attentionEntryBounds(read,token,cutoff,p.data,r.data);if(bounds.complete&&JSON.stringify(bounds)===JSON.stringify(binary.entryBounds))for(const id of ['A15','A18']){const a=output.get(id);if(a)a.data={...a.data as object,entryBounds:{...bounds,inspectionComplete:true}};}}
  if(read.semanticPremiseMethod==='criterion-premises-v1'&&binary?.method==='binary-public-support-v5'&&binary.narrativeGame){
   for(const [id,criterion,decision] of [['A01','NAR-01',binary.narrativeGame],['A02','NAR-01',binary.narrativeGame],['A05','NAR-03',binary.explainableThesis]] as const){const a=output.get(id);if(a)a.data={...a.data as object,entryCriterionDecision:{method:read.semanticPremiseMethod,criterion,decision}};}
  }
  return [...output.values()];
}
