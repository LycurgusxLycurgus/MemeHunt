import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { PublicKey } from '@solana/web3.js';
import type { TokenRef } from './contracts.js';
import { tokenRefSchema } from './contracts.js';
import type { BaselineAssessment } from './baseline.js';
import type { AttentionRead } from '../providers/attention.js';
import { sourceSpans } from '../providers/source-model.js';

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
      if('sourceId'in record&&'spanId'in record){const ref=comparisonRefSchema.parse(record),span=spans.get(ref.spanId);if(!span||span.sourceId!==ref.sourceId)throw new Error('ATT_MODEL_COMPARISON_LEAD_REF_INVALID');return {sourceId:ref.sourceId,quote:span.text};}
      return Object.fromEntries(Object.entries(record).map(([k,v])=>[k,walk(v)]));
    }
    return v;
  };
  return walk(value);
}
const reviewAssessment=z.object({accepted:z.boolean(),rationale:z.string().min(8).max(1000)}).strict();
export const comparisonScopeV2Schema=z.object({mode:z.literal('qualified-identified-leads-v2'),wireMethod:z.literal('comparison-lead-array-v1').optional(),proposalResponseId:z.literal('attention-comparison-lead-repair-proposal-response').optional(),requiredProfileComparisonIds:z.array(z.string()),selectedLeadIds:z.array(z.string()).max(4),deferredLeadIds:z.array(z.string()),recoveryCapped:z.boolean(),adequacySourceLengths:z.array(z.object({id:z.string(),retainedLength:z.number().int().nonnegative()}).strict()),recoveryQueries:z.array(z.object({queryId:z.string(),parentLeadId:z.string(),query:z.string().min(8).max(240),state:z.enum(['OBSERVED','NO_RESULTS','UNAVAILABLE','INVALID']),descriptorComplete:z.boolean(),resultCount:z.number().int().nonnegative(),availableAt:z.iso.datetime()}).strict()),decisions:z.array(z.object({leadId:z.string(),subjectComparison:comparisonSubjectWireSchema.omit({descriptorRefs:true,fetchedRefs:true}).extend({descriptorRefs:z.array(citation).min(1).max(3),fetchedRefs:z.array(citation).max(5)}),evidenceAdequacy:comparisonAdequacyWireSchema.omit({citations:true}).extend({citations:z.array(citation).max(5)}),review:reviewAssessment.extend({subjectComparison:reviewAssessment,evidenceAdequacy:reviewAssessment})}).passthrough())}).passthrough();
export function qualifiedComparisonEvidence(read:AttentionRead,cutoff:string):z.infer<typeof comparisonEvidenceAssessmentSchema>|null{
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
export const attentionExplanationSchema=z.object({
  referent:z.string().trim().min(1).max(200),
  interest:z.string().trim().min(1).max(200),
  tokenRelation:z.string().trim().min(1).max(200),
  prerequisites:z.array(z.string().trim().min(1).max(200)).max(10),
}).strict();
export const attentionProposalSchema=z.object({
  claims:z.array(z.object({id:z.string().min(1),feature:z.enum(['A01','A02','A03','A04','A05']),value:z.boolean(),summary:z.string().min(8).max(500),citations:z.array(citation).min(1).max(5),explanation:attentionExplanationSchema.optional()}).strict()).max(5),
  posts:z.array(z.object({id:z.string().min(1),sourceId:z.string(),quote:z.string().min(8).max(1000),role:z.enum(['CALL','NEWS','JOKE','WARNING','RETROSPECTIVE','PRICE_ONLY','OTHER','UNCLEAR'])}).strict()).max(32),
  competitors:z.array(z.object({id:z.string().min(1),token:tokenRefSchema,sourceId:z.string(),quote:z.string().min(8).max(1000)}).strict()).max(10),
}).strict();
export const attentionReviewSchema=z.object({
  decisions:z.array(z.object({id:z.string().min(1),accepted:z.boolean(),rationale:z.string().min(8).max(1000)}).strict()).max(47),
  candidateSet:z.object({complete:z.boolean(),rationale:z.string().min(8).max(1000)}).strict().optional(),
  originRelationship:z.object({status:z.enum(['SUPPORTED','CONTRADICTED','UNKNOWN']),citations:z.array(citation).max(5),rationale:z.string().min(8).max(1000)}).strict().optional(),
}).strict();
const featureIds=['A01','A02','A03','A04','A05','A09','A10','A11','A14','A15','A16','A17'];
export function deriveAttention(read:AttentionRead,proposal:unknown,review:unknown,token:TokenRef,cutoff:string,evidenceIds:string[],growth=false):BaselineAssessment[]{
  const output=new Map<string,BaselineAssessment>();
  const routeData=(id:string,data:unknown)=>id==='A14'&&read.comparisonComplete!==undefined?{
    originRelationship:{status:'UNKNOWN',rationale:'Primary-origin relationship has not been independently qualified.',citations:[]},
    measuredAttention:{status:'UNKNOWN',shares:[]},...(data as Record<string,unknown>),method:'representation-routes-v2',
  }:data;
  const set=(id:string,value:string|boolean|null,data:unknown,known:boolean,code='ATT_QUALIFICATION_MISSING',unit=typeof value==='string'?'count':'bool')=>output.set(id,{id,version:'baseline-v1',evaluator:'IMPLEMENTED',collector:'IMPLEMENTED',quality:known?'KNOWN':'MISSING',unit,data:routeData(id,data),observationIds:[],evidenceIds,limitations:['automated-source-review-v1; bounded search sample, not verified reality or exhaustive social coverage'],causes:known?[]:[{category:code.includes('REVIEW')||code.includes('QUALIFICATION')?'CLAIM_UNVALIDATED':'EVIDENCE_UNAVAILABLE',code,featureId:id,evidenceIds,action:'Refresh the bounded attention sources and automated review; inspect retained source and reviewer decisions.'}],projection:{id,value:known?value:null,unit,quality:known?'KNOWN':'MISSING',availableAt:cutoff,evidenceIds,applicability:'APPLICABLE'}});
  const activeIds=growth?[...featureIds,'A18']:featureIds;
  for(const id of activeIds)set(id,null,{method:'automated-source-review-v1',codes:read.codes},false,read.codes[0]??'ATT_QUALIFICATION_MISSING');
  const invalid=(code:string)=>{for(const id of activeIds)set(id,null,{method:'automated-source-review-v1',codes:[code,...read.codes]},false,code);return [...output.values()];};
  const p=attentionProposalSchema.safeParse(proposal),r=attentionReviewSchema.safeParse(review);
  if(!p.success||!r.success)return read.codes.some(c=>c.startsWith('ATT_MODEL_')||c==='ATT_NO_SOURCES')?[...output.values()]:invalid(!p.success?'ATT_PROPOSAL_SCHEMA_INVALID':'ATT_REVIEW_SCHEMA_INVALID');
  if(read.comparisonComplete!==undefined&&(!r.data.candidateSet||!r.data.originRelationship))return invalid('ATT_REVIEW_SCOPE_COVERAGE_INVALID');
  const items=[...p.data.claims,...p.data.posts,...p.data.competitors],ids=items.map(i=>i.id),decisions=new Map(r.data.decisions.map(d=>[d.id,d]));
  if(new Set(ids).size!==ids.length||new Set(p.data.claims.map(c=>c.feature)).size!==p.data.claims.length||decisions.size!==r.data.decisions.length||decisions.size!==ids.length||ids.some(id=>!decisions.has(id)))return invalid('ATT_REVIEW_COVERAGE_INVALID');
  const sources=new Map(read.sources.map(s=>[s.id,s]));
  const same=(t:TokenRef)=>t.chain===token.chain&&(t.chain==='solana'?t.address===token.address:t.address.toLowerCase()===token.address.toLowerCase());
  const names=(text:string,t:TokenRef)=>t.chain==='solana'?text.includes(t.address):text.toLowerCase().includes(t.address.toLowerCase());
  const cite=(c:{sourceId:string;quote:string})=>{const s=sources.get(c.sourceId);return s&&s.text.includes(c.quote)&&Date.parse(s.availableAt)<=Date.parse(cutoff)&&Date.parse(cutoff)-Date.parse(s.availableAt)<=900000?s:undefined;};
  const accepted=(id:string)=>decisions.get(id)?.accepted===true;
  for(const c of p.data.claims){
    const bound=c.citations.every(ref=>{const s=cite(ref);return s&&names(s.text,token);});
    const explanation=c.explanation?{explanation:c.explanation}:{};
    const consistent=!c.explanation||c.feature==='A05'&&c.value===(c.explanation.prerequisites.length===0);
    if(!consistent)set(c.feature,null,{proposedSummary:c.summary,...explanation,citations:c.citations,review:decisions.get(c.id)},false,'ATT_QUALIFICATION_EXPLANATION_INVALID');
    else if(bound&&accepted(c.id))set(c.feature,c.value,{summary:c.summary,...explanation,citations:c.citations,review:decisions.get(c.id),method:'automated-source-review-v1'},true);
    else {set(c.feature,null,{proposedSummary:c.summary,...explanation,citations:c.citations,review:decisions.get(c.id)},false,bound?'ATT_REVIEW_REJECTED':'ATT_CITATION_BINDING_INVALID');const a=output.get(c.feature)!;if(bound)a.causes[0].action=`Automated review rejected this source judgment: ${decisions.get(c.id)!.rationale}`;}
  }
  const validAddress=(t:TokenRef)=>{if(t.chain!=='solana')return /^0x[0-9a-fA-F]{40}$/.test(t.address);try{return new PublicKey(t.address).toBase58()===t.address;}catch{return false;}};
  const v2=read.comparisonComplete!==undefined;
  const candidates=p.data.competitors.filter(c=>validAddress(c.token)&&accepted(c.id)&&cite(c)&&names(c.quote,c.token)&&(!v2||read.comparisonSourceIds?.includes(c.sourceId)));
  const keys=candidates.map(c=>`${c.token.chain}:${c.token.chain==='solana'?c.token.address:c.token.address.toLowerCase()}`);
  const candidateComplete=(v2?read.comparisonComplete&&r.data.candidateSet?.complete===true:read.complete)&&candidates.length===p.data.competitors.length&&new Set(keys).size===keys.length&&candidates.some(c=>same(c.token));
  const comparisonCode=read.codes.find(c=>c.startsWith('ATT_MODEL_COMPARISON_'));
  set('A09',true,{queries:read.queries,candidates,review:r.data.candidateSet,scope:read.comparisonQualification?'qualified identified-lead sample; unread original pages and refinement proofs retained; not undiscovered representations':'discovered source-reviewed representations; absence outside this sample is not established',...(read.comparisonQualification?{qualification:read.comparisonQualification}:{})},!!candidateComplete,comparisonCode??'ATT_CANDIDATE_SCOPE_INCOMPLETE');
  set('A10',true,{candidates},!!candidateComplete,'ATT_BINDING_UNRESOLVED');
  const adequacy=growth&&!candidateComplete?qualifiedComparisonEvidence(read,cutoff):null;
  if(adequacy)set('A09',false,{method:'public-representation-screen-v1',evidenceAdequacy:adequacy,scope:'Reviewed inadequate public representation evidence; not a proven competitor or fraud finding'},true);
  const posts=read.sources.filter(s=>s.kind==='POST'&&(!read.postSampleSourceIds||read.postSampleSourceIds.includes(s.id)));
  const rankingIds=read.comparisonRankingSourceIds??read.comparisonSourceIds;
  const rankingPosts=read.sources.filter(s=>s.kind==='POST'&&rankingIds?.includes(s.id));
  const labels=new Map(p.data.posts.map(post=>[post.sourceId,post]));
  const allLabeled=labels.size===p.data.posts.length&&posts.every(s=>{const post=labels.get(s.id);return post&&post.role!=='UNCLEAR'&&accepted(post.id)&&cite(post)&&s.authorId&&s.publishedAt;})&&p.data.posts.every(post=>sources.get(post.sourceId)?.kind==='POST');
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
  set('A16',String(qualified.length),{qualified:qualified.length,excluded:originals.filter(s=>!qualified.includes(s)).map(s=>({id:s.id,role:labels.get(s.id)?.role})),sampleProblems,method:'reviewed-original-source-posts-v1'},complete,sampleCode,'count');
  set('A17',String(authors.size),{authors:[...authors],sampleProblems,meaning:'source account IDs; not unique humans'},complete,sampleCode,'count');
  if(growth){
    const start=Date.parse(read.start),end=Date.parse(read.end),mid=start+(end-start)/2;
    const sample=read.growthSample;
    const comparable=complete&&Number.isSafeInteger(mid)&&read.queries.length>0&&sample?.method==='fixed-query-sample-v1'&&sample.complete&&new Set(sample.sourceIds).size===posts.length&&sample.sourceIds.length===posts.length&&posts.every(s=>sample.sourceIds.includes(s.id)&&Date.parse(s.publishedAt!)<=Date.parse(s.availableAt))&&JSON.stringify(sample.queries)===JSON.stringify(read.queries);
    const previous=qualified.filter(s=>Date.parse(s.publishedAt!)<mid),current=qualified.filter(s=>Date.parse(s.publishedAt!)>=mid);
    set('A18',current.length>previous.length,{method:'fixed-sample-equal-bins-v1',start:read.start,midpoint:Number.isFinite(mid)?new Date(mid).toISOString():null,end:read.end,bucketSeconds:Number.isFinite(end-start)?(end-start)/2000:null,previous:previous.length,current:current.length,previousSourceIds:previous.map(s=>s.id),currentSourceIds:current.map(s=>s.id),queries:read.queries,sample:sample??null,dispositions:posts.map(s=>({id:s.id,publishedAt:s.publishedAt,authorId:s.authorId,role:labels.get(s.id)?.role??'UNCLEAR',accepted:accepted(labels.get(s.id)?.id??''),qualified:qualified.includes(s),bin:Date.parse(s.publishedAt!)<start||Date.parse(s.publishedAt!)>=end?'OUTSIDE':Date.parse(s.publishedAt!)<mid?'PREVIOUS':'CURRENT'})),scope:'Two equal bins in one fixed acquired and independently reviewed sample; not platform-wide growth'},!!comparable,comparable?'':'ATT_GROWTH_SCOPE_INCOMPLETE');
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
    const provenance=p.data.claims.find(c=>c.feature==='A03'&&c.value&&accepted(c.id));
    const primarySources=provenance?.citations.map(cite).filter(s=>!!s)??[];
    const primaryAccounts=primarySources.flatMap(s=>{if(s.authorId)return [s.authorId];try{const u=new URL(s.url);return /^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname)&&/^\/[A-Za-z0-9_]+\/?$/.test(u.pathname)?[`x.com:${u.pathname.split('/')[1].toLowerCase()}`]:[];}catch{return [];}});
    const datedPrimary=originCitations.some(ref=>{const s=cite(ref);return s?.kind==='POST'&&s.publishedAt&&Date.parse(s.publishedAt)<=Date.parse(read.end)&&s.authorId&&(primarySources.some(primary=>primary.id===s.id)||primaryAccounts.includes(s.authorId));});
    // A03 carries independently accepted primary provenance; origin review separately judges representation/contestation.
    const primary=output.get('A03')?.projection?.value===true;
    const originStatus=originBound&&datedPrimary&&primary?origin!.status:'UNKNOWN';
    const measuredStatus=rankingKnown?leader&&ties===1?'SUPPORTED':'CONTRADICTED':'UNKNOWN';
    const value=originStatus==='SUPPORTED'||measuredStatus==='SUPPORTED'?true:originStatus==='CONTRADICTED'&&measuredStatus==='CONTRADICTED'?false:null;
    const originRationale=origin?.status&&origin.status!=='UNKNOWN'&&originStatus==='UNKNOWN'?`Source review proposed ${origin.status.toLowerCase()}, but primary-account, dated-post or exact-contract citation validation is incomplete. ${origin.rationale}`:origin?.rationale??'Primary-origin relationship has not been independently qualified.';
    set('A14',value,{method:'representation-routes-v2',originRelationship:{status:originStatus,citations:originCitations,rationale:originRationale},measuredAttention:{status:measuredStatus,...ranking},basis:originStatus==='SUPPORTED'?'ORIGIN':measuredStatus==='SUPPORTED'?'MEASURED_ATTENTION':null},value!==null,'ATT_REPRESENTATION_ROUTES_UNRESOLVED');
  }
  return [...output.values()];
}
