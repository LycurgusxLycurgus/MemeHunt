import {socialInputSchema,socialNamesAddress,canonicalSocialUrl,socialAccount,type SocialInput} from '../domain/social.js';
import {tokenRefSchema,type TokenRef} from '../domain/contracts.js';
import type {AdvisoryMetric} from '../domain/advisory-contracts.js';
import type {AdvisorySemantic} from './advisory-semantic.js';
import {publicHttpsUrl} from './tinyfish.js';
import {reconstructOriginAcquisition} from './attention.js';

export const PUBLIC_SOURCE_INCENTIVES_METHOD='observed-public-source-incentives-v1' as const;
export type PublicSourceIncentivesBodyContext={originalRead:SocialInput;read:SocialInput};
const categories=new Set(['COMPENSATION','CREATOR_FEE','PUBLIC_HOLDINGS','AFFILIATION']);
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function requireFact(value:unknown,code:string):asserts value{if(!value)throw Error(code);}
const withoutQualification=(read:SocialInput)=>{const {qualifiedAt:_,...rest}=read;return rest;};
function canonical(value:string):string{
 const safe=publicHttpsUrl(value,true);requireFact(safe,'S08_PUBLIC_SOURCE_URL_INVALID');const u=new URL(safe);u.hash='';
 const status=/^\/([A-Za-z0-9_]+)\/status\/(\d+)(?:\/.*)?$/.exec(u.pathname);
 return /^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname)&&status?`https://x.com/${status[1]!.toLowerCase()}/status/${status[2]}`:canonicalSocialUrl(u.toString());
}

/** Reuses a bound full-source classification; it does not run a classifier or
 * reinterpret a recorded own-post protocol. Publication and observation clocks
 * remain distinct, and no PAGE author is inferred from an affiliation label.
 */
export function derivePublicSourceIncentives(input:SocialInput,semantic:AdvisorySemantic|null,token:TokenRef,cutoff:string,evidenceIds:string[],legacyPost:AdvisoryMetric|undefined,acquisition:unknown,bodyContext?:PublicSourceIncentivesBodyContext):AdvisoryMetric{
 const parsed=socialInputSchema.safeParse(input),read=parsed.success?parsed.data:null,legacyRow=legacyPost?.id==='S08'?legacyPost:undefined,legacy=object(legacyRow?.data)?legacyRow.data:null;
 const currentPostMeasurement={quality:legacyRow?.quality??'MISSING',incentives:legacyRow?.quality==='KNOWN'&&Array.isArray(legacy?.incentives)?structuredClone(legacy.incentives):null,scope:legacy?.scope?structuredClone(legacy.scope):null,reasonCode:legacyRow?.reasonCode??'CURRENT_POST_MEASUREMENT_UNAVAILABLE'};
 let underlyingAdvisoryCorpusAccepted=false,primarySourceAcquisition:ReturnType<typeof reconstructOriginAcquisition>|null=null;
 const row=(known:boolean,reasonCode:string,disclosures:unknown=null,excludedUnrelatedSourceIds:unknown=null):AdvisoryMetric=>({id:'S08',quality:known?'KNOWN':'MISSING',unit:'scoped-record',data:{method:PUBLIC_SOURCE_INCENTIVES_METHOD,scope:{asOf:cutoff,sourceIds:read?.sources.map(s=>s.id)??[],currentPostWindow:read?{start:read.start,end:read.end,targetPostIds:[...read.targetPostIds]}:null,meaning:'Current retained full-source representations only, not internet-wide coverage. Primary attention queries and DEX seeds require acquired source counterparts; comparison-only query leads remain outside this curated scope.'},disclosures,currentPostMeasurement,hiddenCompensation:null,underlyingAdvisoryCorpusAccepted,primarySourceAcquisition,excludedUnrelatedSourceIds,interpretation:{authorId:'Source posting-account metadata only, not the incentive subject.',incentiveSubject:'Not extracted or established; null for every record.',citations:'Shared source-level citations, not a separate proof for each category or necessarily own-post-body evidence.',pageAffiliation:'Frame-classified website/token self-association, not promoter compensation or a rate denominator.',observedAt:'Original source-availability bound, not first disclosure or a per-request instant.'},meaning:'Frame-classified public-source disclosures may vary between frames over identical source bytes. No verified human identity, legal ownership, actual payment, position or fee-income claim. Publication, prior versions and hidden compensation are not inferred.'},evidenceIds:[...new Set(evidenceIds)],reasonCode});
 try{
  requireFact(read&&tokenRefSchema.safeParse(token).success,'S08_PUBLIC_SOURCE_SCOPE_INVALID');
  underlyingAdvisoryCorpusAccepted=!!semantic&&semantic.token.chain===token.chain&&semantic.token.address===token.address&&Array.isArray(semantic.sources)&&semantic.sources.length===read.sources.length&&new Set(semantic.sources.map(s=>s.id)).size===read.sources.length&&semantic.sources.every(s=>s.complete===true&&s.accepted===true&&read.sources.some(source=>source.id===s.id));
  const at=Date.parse(cutoff),end=Date.parse(read.end);requireFact(Number.isFinite(at)&&Date.parse(read.start)<end&&end<=at,'S08_PUBLIC_SOURCE_CLOCK_INVALID');
  requireFact(read.sources.length>0&&read.sampleComplete&&read.identityComplete&&!read.identityUnavailableSources?.length&&read.sources.every(s=>s.text.trim()&&!/^\s*(?:safety check|access denied|forbidden)\s*$/i.test(s.text)),'S08_PUBLIC_SOURCE_SCOPE_INCOMPLETE');
  requireFact(read.codes.every(c=>!/(?:CAP|CLIP|BUDGET|CONFLICT|BINDING|FETCH|SEARCH|UNAVAILABLE|MISSING|TRUNCAT)/.test(c)),'S08_PUBLIC_SOURCE_SCOPE_INCOMPLETE');
  requireFact(at-end<=900000&&read.sources.every(s=>Date.parse(s.availableAt)<=at&&at-Date.parse(s.availableAt)<=900000&&(!s.publishedAt||Date.parse(s.publishedAt)<=Date.parse(s.availableAt))),'S08_PUBLIC_SOURCE_STALE_OR_FUTURE');
  const sourceIds=new Set(read.sources.map(s=>s.id));requireFact(sourceIds.size===read.sources.length&&new Set(read.targetPostIds).size===read.targetPostIds.length&&new Set(read.identitySourceIds).size===read.identitySourceIds.length&&[...read.targetPostIds,...read.identitySourceIds].every(id=>sourceIds.has(id))&&read.targetPostIds.every(id=>read.sources.find(s=>s.id===id)?.kind==='POST'),'S08_PUBLIC_SOURCE_SCOPE_INVALID');
  requireFact(object(acquisition)&&object(acquisition.attention)&&Object.values(acquisition.attention).every(v=>typeof v==='string')&&object(acquisition.social)&&typeof acquisition.social['social-acquisition-scope']==='string','S08_PUBLIC_ACQUISITION_INCOMPLETE');
  const scope=JSON.parse(acquisition.social['social-acquisition-scope']);requireFact(object(scope)&&scope.method==='free-social-supplements-v2'&&scope.budgetBasis==='social-input','S08_PUBLIC_ACQUISITION_INCOMPLETE');
  const original=socialInputSchema.parse(scope.read);
  // The app validates the body triplet and hashes before supplying this context.
  // Bind both complete parsed representations; classification uses the refined
  // read below, while primary acquisition retains the original fetched bodies.
  const boundOriginal=bodyContext?socialInputSchema.parse(bodyContext.originalRead):read,boundRead=bodyContext?socialInputSchema.parse(bodyContext.read):read;
  requireFact(same(withoutQualification(original),withoutQualification(boundOriginal))&&same(withoutQualification(read),withoutQualification(boundRead))&&original.sampleComplete&&original.identityComplete,'S08_PUBLIC_ACQUISITION_BINDING');
  requireFact(Array.isArray(scope.clippedSourceIds)&&scope.clippedSourceIds.length===0&&Array.isArray(scope.remainingClippedSourceIds)&&scope.remainingClippedSourceIds.length===0&&scope.submittedSocialSourceCount===read.sources.length&&Number.isInteger(scope.baseSocialSourceCount)&&scope.baseSocialSourceCount>=0&&scope.baseSocialSourceCount<=read.sources.length&&scope.socialSourceLimit===64&&scope.supplementLimit===8,'S08_PUBLIC_ACQUISITION_INCOMPLETE');
  requireFact(Array.isArray(scope.selection)&&scope.selection.every((s:unknown)=>object(s)&&typeof s.url==='string'&&publicHttpsUrl(s.url,true)&&s.selected===true&&['REUSED','RETAINED'].includes(s.status))&&Array.isArray(scope.requestedUrls)&&scope.requestedUrls.every((url:unknown)=>typeof url==='string'&&publicHttpsUrl(url,true))&&Array.isArray(scope.requestedUrlsByBatch)&&same(scope.requestedUrlsByBatch.flat(),scope.requestedUrls),'S08_PUBLIC_ACQUISITION_INCOMPLETE');
  // SOCIAL completeness covers POST acquisition, not every primary PAGE. Rebuild
  // that existing primary-query/DEX-seed boundary from original source bodies;
  // a recovered PAGE is admissible, an omitted nonidentity PAGE is not.
  const http=JSON.parse(acquisition.attention['attention-http-outcomes']);requireFact(object(http)&&http.method==='fetch-http-outcomes-v1'&&Array.isArray(http.outcomes),'S08_PUBLIC_PRIMARY_ACQUISITION_INCOMPLETE');
  const statuses=new Map<string,number>();for(const outcome of http.outcomes){requireFact(object(outcome)&&typeof outcome.artifactId==='string'&&!statuses.has(outcome.artifactId)&&Number.isInteger(outcome.status)&&outcome.status>=100&&outcome.status<=599,'S08_PUBLIC_PRIMARY_ACQUISITION_INCOMPLETE');statuses.set(outcome.artifactId,outcome.status);}
  for(let i=1;i<=2;i++){const id=`attention-search-${i}`,query=JSON.parse(acquisition.attention[id]);requireFact(statuses.get(id)===200&&object(query)&&query.query===original.queries[i-1]&&Array.isArray(query.results)&&!query.error&&(query.errors===undefined||Array.isArray(query.errors)&&query.errors.length===0),'S08_PUBLIC_PRIMARY_ACQUISITION_INCOMPLETE');}
  const usableRaw:Record<string,string>={...acquisition.attention};for(const id of Object.keys(usableRaw))if(/^attention-fetch-\d+(?:-retry-\d+)?$/.test(id)&&statuses.get(id)!==200)delete usableRaw[id];
  primarySourceAcquisition=reconstructOriginAcquisition({sources:original.sources,rawArtifacts:usableRaw,queries:original.queries,start:original.start,end:original.end,complete:false,codes:original.codes,discoveryUrls:scope.selection.filter((lead:any)=>lead.reason==='DEX_DISCOVERY').map((lead:any)=>lead.url),entryEvidenceMethod:'public-support-v2',collectionMethod:'project-context-v2'},token);
  requireFact(primarySourceAcquisition.complete,'S08_PUBLIC_PRIMARY_ACQUISITION_INCOMPLETE');
  requireFact(semantic&&['advisory-source-classification-v3','advisory-source-classification-v4'].includes(semantic.method)&&semantic.token.chain===token.chain&&semantic.token.address===token.address&&Array.isArray(semantic.sources)&&semantic.sources.length===read.sources.length&&new Set(semantic.sources.map(s=>s.id)).size===sourceIds.size&&semantic.sources.every(s=>sourceIds.has(s.id)),'S08_PUBLIC_CLASSIFICATION_INCOMPLETE');
  requireFact(underlyingAdvisoryCorpusAccepted,'S08_PUBLIC_CLASSIFICATION_INCOMPLETE');
  const urls=new Set<string>(),disclosures:Array<Record<string,unknown>>=[],excluded:string[]=[];
  for(const source of read.sources){
   const key=canonical(source.url);requireFact(!urls.has(key),'S08_PUBLIC_SOURCE_CANONICAL_CONFLICT');urls.add(key);
   const sourceUrl=new URL(source.url),status=/^(?:www\.)?(?:x|twitter)\.com$/.test(sourceUrl.hostname)&&/^\/[A-Za-z0-9_]+\/status\/\d+(?:\/.*)?$/.test(sourceUrl.pathname);requireFact((source.kind==='POST')===status&&(source.kind!=='POST'||source.authorId===null||source.authorId===socialAccount(key)),'S08_PUBLIC_SOURCE_KIND_INVALID');
   const claim=semantic.sources.find(s=>s.id===source.id)!;
   requireFact(['EXACT_CONTRACT','UNRELATED','UNCLEAR'].includes(claim.binding)&&Array.isArray(claim.incentives)&&claim.incentives.length<=4&&new Set(claim.incentives).size===claim.incentives.length&&claim.incentives.every(c=>categories.has(c)),'S08_PUBLIC_CLASSIFICATION_INVALID');
   requireFact(Array.isArray(claim.citations)&&claim.citations.length<=8&&claim.citations.every(c=>c.sourceId===source.id&&typeof c.quote==='string'&&c.quote.length>=8&&source.text.includes(c.quote)),'S08_PUBLIC_SOURCE_CITATION_INVALID');
   if(claim.binding==='EXACT_CONTRACT')requireFact(socialNamesAddress(source.text,token)&&claim.citations.some(c=>socialNamesAddress(c.quote,token)),'S08_PUBLIC_SOURCE_CITATION_INVALID');
   if(!claim.incentives.length)continue;
   requireFact(claim.citations.length>0,'S08_PUBLIC_SOURCE_CITATION_INVALID');
   if(claim.binding==='UNRELATED'){excluded.push(source.id);continue;}
   requireFact(claim.binding==='EXACT_CONTRACT','S08_PUBLIC_SOURCE_BINDING_UNRESOLVED');
   disclosures.push({sourceId:source.id,url:source.url,sourceKind:source.kind,token:{...token},incentives:[...claim.incentives],citations:claim.citations.map(c=>({...c})),publishedAt:source.publishedAt,observedAt:source.availableAt,authorId:source.kind==='POST'?source.authorId:null,incentiveSubject:null,editHistory:'PRIOR_VERSIONS_UNOBSERVED'});
  }
  return row(true,'PUBLIC_SOURCE_INCENTIVES_OBSERVED',disclosures,excluded);
 }catch(error){return row(false,error instanceof Error&&/^S08_PUBLIC_[A-Z_]+$/.test(error.message)?error.message:'S08_PUBLIC_SOURCE_INVALID');}
}
