import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { TokenRef,SocialPolicyFacts } from './contracts.js';
import type { AttentionRead } from '../providers/attention.js';
import { sourceSpans } from '../providers/source-model.js';
import { normalizeAttentionFetchUrl,normalizeAttentionSearchUrl,requiredComparisonRecoveryParents,attentionPostKey,attentionImageUrl } from '../providers/attention.js';
import { publicHttpsUrl } from '../providers/tinyfish.js';
import { decodeTokenMetadataUri } from '../providers/token-discovery.js';
import { narrativeContentSourceBound,identityOnlyTokenMetadata } from './attention.js';
import { verifyOriginAlias } from '../providers/origin-recovery.js';
import { primaryLeadershipOptions } from './leadership.js';
import { PublicKey } from '@solana/web3.js';
import { decodeFirecrawlArtifact } from '../providers/firecrawl.js';
import { criterionFirecrawlProjection } from '../providers/criterion-firecrawl.js';
import { buildPurposeAcquisition,purposeReceiptSpans } from '../providers/acquisition-evidence.js';
import { attentionOperationFacts } from '../providers/attention.js';
import { criterionPurpose,receiptEligible,type EvidencePurpose } from './acquisition-purpose.js';

import { criterionReviewMethod,criterionIds,proofSchema,criterionWireRowSchema,type CriterionIssue,type CriterionId,type CriterionFailure,type CriterionProof,type CriterionResult,type CriterionReceipt } from './criterion-schema.js';
export { criterionReviewMethod,criterionIds,criterionReceiptSchema } from './criterion-schema.js';
export type { CriterionId,CriterionFailure,CriterionProof,CriterionResult,CriterionReceipt,CriterionIssue,CriterionWireRow } from './criterion-schema.js';
export type CriterionScope={sourceIds:string[];requiredOperationIds:string[];complete:boolean;failures:string[];readGaps?:string[];unreadTargets?:string[]};
export const criterionStandards:Record<CriterionId,{question:string;requiredSupport:string[]}>= {
  'NAR-01':{question:'Is the narrative and game intelligible, with evidence for this exact token relation?',requiredSupport:['Grounded referent','Interest','Exact-token relation','Mechanism and game']},
  'NAR-02':{question:'Is an attributed origin or catalyst supported in the bounded scope?',requiredSupport:['Attributed observed origin or catalyst','Exact-token relationship']},
  'NAR-03':{question:'Is the narrative explainable without indispensable unexplained prerequisites?',requiredSupport:['Plain explanation','Explicit assessment of necessary prerequisites']},
  'CAN-01':{question:'Does the reviewed comparison establish the relevant representation decision?',requiredSupport:['Own narrative and literal-mint witnesses for each relevant representation','Completed comparison scope for no relevant alternative']},
  'CAN-02':{question:'Is primary relationship or comparable attention leadership supported?',requiredSupport:['Eligible primary relationship or actual comparable attention']},
  'ATT-01':{question:'Do qualified current original posts meet the existing ten-post and three-author threshold?',requiredSupport:['Ten qualified original posts','Three source authors']},
  'ATT-02':{question:'Is attention growth supported by the existing equal-interval measurement?',requiredSupport:['Current equal-bin count exceeds previous count']},
  'ADV-03':{question:'Do qualified current original posts meet the existing three-post and three-author threshold with narrative?',requiredSupport:['Grounded narrative','Three qualified original posts','Three source authors']},
};
export type CriterionInput={fastJudgmentMethod?:'read-sources-v1';metadataSymbol?:string;acquisitionPurposeMethod?:'acquisition-purpose-v1';purposeProjection?:import('./acquisition-purpose.js').AcquisitionProjection;purposeReceipt?:import('./acquisition-purpose.js').PurposeReceipt;method:typeof criterionReviewMethod;token:TokenRef;policyId:CriterionReceipt['policyId'];cutoff:string;start:string;end:string;requiredIds:CriterionId[];standards:Record<CriterionId,{question:string;requiredSupport:string[]}>;sources:AttentionRead['sources'];sourceBindings:NonNullable<AttentionRead['sourceBindings']>;narrativeSourceIds:string[];identityOnlySourceIds:string[];primaryLeadershipCitationIds:string[];auxiliarySources:Array<{id:string;kind:'INDEXED_METADATA'|'ACQUISITION_RECEIPT';text:string}>;acquisition:unknown;operationArtifacts:Array<{id:string;sha256:string}>;criterionScopes:Record<CriterionId,CriterionScope>;queries:string[];complete:boolean;codes:string[];catalog:Array<{id:string;sourceId:string;spanId:string;start:number;end:number;text:string}>;scopeId:string;inputId:string};
export function criterionComparisonEligibility(input:CriterionInput){
  const acquisition=input.acquisition as {comparison?:{originalComplete?:boolean;searchSucceeded?:boolean;descriptorComplete?:boolean;leads?:Array<{id:string;acquisitionStatus:string;acquisitionCodes:string[];recoverySourceIds:string[]}>}|null;comparisonRecovery?:{recoveryCapped?:boolean;recoveryQueries?:Array<{descriptorComplete:boolean}>}|null};
  const leads=acquisition.comparison?.leads??[];
  const unresolvedLeads=leads.filter(lead=>!(lead.acquisitionStatus==='ACQUIRED'&&!lead.acquisitionCodes.length||lead.recoverySourceIds.length>0)).map(lead=>({id:lead.id,status:lead.acquisitionStatus}));
  const accounted=!!acquisition.comparison?.leads&&unresolvedLeads.length===0;
  const eligible=accounted&&(acquisition.comparison?.originalComplete===true||!!(acquisition.comparison?.searchSucceeded&&acquisition.comparison.descriptorComplete&&acquisition.comparisonRecovery&&!acquisition.comparisonRecovery.recoveryCapped&&acquisition.comparisonRecovery.recoveryQueries?.every(query=>query.descriptorComplete)));
  return {noRelevantAlternativeEligible:eligible,unresolvedLeads};
}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function firecrawlPage(read:AttentionRead,id:string){
  const page=criterionFirecrawlProjection(read).pages.find(item=>item.producerArtifactId===id);
  return page?{url:page.requestedUrl,finalUrl:page.finalUrl,text:page.text}:null;
}
function firecrawlSearch(read:AttentionRead){
  try{
    const op=JSON.parse(read.rawArtifacts['firecrawl-search-1-request']);
    if(op.method!=='firecrawl-native-operation-v1'||op.request?.operation!=='SEARCH'||typeof op.replacesSearchId!=='string'||typeof op.httpStatus!=='number')return null;
    const original=JSON.parse(read.rawArtifacts[`attention-acquisition-${op.replacesSearchId}-request`]);
    if(original.query!==op.request.query)return null;
    const result=decodeFirecrawlArtifact(op.request,read.rawArtifacts['firecrawl-search-1'],op.httpStatus);
    if(result.status!==op.status||(result.code??null)!==op.code||!['OBSERVED','NO_RESULTS'].includes(result.status))return null;
    return {id:op.replacesSearchId,result};
  }catch{return null;}
}
/** Reconstruct retained page bodies from producer responses, never from a cloned page artifact. */
export function validateCriterionSourceBindings(read:AttentionRead):boolean {
  const bindings=read.sourceBindings;
  if(!bindings||bindings.length!==read.sources.length||new Set(bindings.map(b=>b.sourceId)).size!==bindings.length)return false;
  let requests:any;try{requests=JSON.parse(read.rawArtifacts['criterion-fetch-requests']);}catch{return false;}
  if(requests?.method!=='criterion-fetch-requests-v1'||!Array.isArray(requests.requests)||new Set(requests.requests.map((r:any)=>r.artifactId)).size!==requests.requests.length)return false;
  return read.sources.every(source=>{
    const binding=bindings.find(b=>b.sourceId===source.id);
    if(!binding||!['IDENTITY','ORIGIN_UNDERSCORE_V1'].includes(binding.transform)||!(/^(?:attention-(?:(?:recovery-)?fetch-\d+(?:-retry-\d+)?|origin-fetch-\d+|origin-role-\d+-fetch)|firecrawl-scrape-[12])$/.test(binding.producerArtifactId))||!Number.isInteger(binding.resultIndex)||binding.resultIndex<0)return false;
    if(binding.transform==='ORIGIN_UNDERSCORE_V1'&&!/^attention-origin-fetch-\d+$/.test(binding.producerArtifactId))return false;
    if(binding.producerArtifactId.startsWith('firecrawl-scrape-')){
      const page=firecrawlPage(read,binding.producerArtifactId);
      if(!page||binding.resultIndex!==0||binding.transform!=='IDENTITY'||page.url!==binding.requestedUrl||page.text!==source.text)return false;
      const final=normalizeAttentionFetchUrl(page.finalUrl??page.url);if(!final)return false;
      const url=new URL(final),post=/^(?:www\.)?(?:x|twitter)\.com$/.test(url.hostname)&&/^\/[A-Za-z0-9_]+\/status\/\d+(?:\/.*)?$/.test(url.pathname);
      const requested=new URL(page.url),requestedPost=/^(?:www\.)?(?:x|twitter)\.com$/.test(requested.hostname)&&/^\/[A-Za-z0-9_]+\/status\/\d+(?:\/.*)?$/.test(requested.pathname);
      if(requestedPost&&(!post||requested.pathname.split('/')[3]!==url.pathname.split('/')[3]))return false;
      const canonical=post?`https://x.com/${url.pathname.split('/')[1].toLowerCase()}/status/${url.pathname.split('/')[3]}`:final;
      const author=post?`${url.hostname.replace(/^www\./,'').replace('twitter.com','x.com')}:${url.pathname.split('/')[1].toLowerCase()}`:null;
      return source.url===canonical&&source.kind===(post?'POST':'PAGE')&&source.authorId===author&&source.publishedAt===null;
    }
    try{
      const packet=JSON.parse(read.rawArtifacts[binding.producerArtifactId]);
      if(!Array.isArray(packet.results)||!Array.isArray(packet.errors))return false;
      const result=packet.results[binding.resultIndex];
      if(!result||typeof result.url!=='string'||typeof result.text!=='string')return false;
      if(binding.transform==='IDENTITY'&&result.text!==source.text&&!(read.codes.includes('ATT_TEXT_CAP')&&result.text.startsWith(source.text)))return false;
      if(binding.transform==='ORIGIN_UNDERSCORE_V1'){
        const alias=read.originRecovery?.aliases.find(a=>a.sourceId===source.id);
        if(alias?!verifyOriginAlias(alias,read.sources,read.rawArtifacts):result.text.replace(/\\_/g,'_')!==source.text)return false;
      }
      const requested=publicHttpsUrl(result.url,true),final=typeof result.final_url==='string'?normalizeAttentionFetchUrl(result.final_url):requested;
      if(!requested||requested!==binding.requestedUrl||!final)return false;
      if(!requests.requests.some((r:any)=>r.artifactId===binding.producerArtifactId&&Array.isArray(r.urls)&&r.urls.includes(requested)))return false;
      const url=new URL(final),post=!binding.producerArtifactId.includes('origin-')&&/^(?:www\.)?(?:x|twitter)\.com$/.test(url.hostname)&&/^\/[A-Za-z0-9_]+\/status\/\d+(?:\/.*)?$/.test(url.pathname);
      const canonical=post?`https://x.com/${url.pathname.split('/')[1].toLowerCase()}/status/${url.pathname.split('/')[3]}`:final;
      const author=post?`${url.hostname.replace(/^www\./,'').replace('twitter.com','x.com')}:${url.pathname.split('/')[1].toLowerCase()}`:null;
      const published=binding.producerArtifactId.includes('origin-')?null:typeof result.published_date==='string'&&/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(result.published_date)&&Number.isFinite(Date.parse(result.published_date))&&Date.parse(result.published_date)<=Date.parse(read.end)?new Date(result.published_date).toISOString():null;
      return source.url===canonical&&source.kind===(post?'POST':'PAGE')&&source.authorId===author&&source.publishedAt===published;
    }catch{return false;}
  });
}
/** Every eligible returned body must be represented or explicitly accounted as omitted. */
export function validateCriterionAcceptedMembership(read:AttentionRead):boolean{
  let manifest:any;try{manifest=JSON.parse(read.rawArtifacts['criterion-fetch-requests']);}catch{return false;}
  if(!Array.isArray(manifest?.requests)||!Array.isArray(manifest?.omissions))return false;
  for(const request of manifest.requests){
    if(!request||typeof request.artifactId!=='string'||!Array.isArray(request.urls)||request.urls.some((url:unknown)=>typeof url!=='string'))return false;
    let packet:any;try{packet=JSON.parse(read.rawArtifacts[request.artifactId]);}catch{continue;}
    if(!Array.isArray(packet.results)||!Array.isArray(packet.errors))continue;
    for(const row of packet.results){
      if(!row||typeof row.url!=='string'||typeof row.text!=='string'||!request.urls.includes(row.url)||!row.text.trim()||/^\s*(?:safety check|access denied|forbidden)\s*$/i.test(row.text))continue;
      const requested=publicHttpsUrl(row.url,true),final=typeof row.final_url==='string'?normalizeAttentionFetchUrl(row.final_url):requested;
      if(!requested||!final)continue;
      const bound=read.sourceBindings?.some(b=>b.producerArtifactId===request.artifactId&&b.resultIndex===packet.results.indexOf(row));
      const duplicate=read.sources.some(s=>s.url===final&&s.text===row.text);
      if(!bound&&!duplicate&&!manifest.omissions.some((o:any)=>o?.url===requested))return false;
    }
  }
  return true;
}
export function buildCriterionInput(read:AttentionRead,token:TokenRef,reviewCutoff:string,requiredIds:CriterionId[],policyId:CriterionReceipt['policyId']):CriterionInput {
  if(new Set(requiredIds).size!==requiredIds.length||requiredIds.some(id=>!criterionIds.includes(id))||new Set(read.sources.map(s=>s.id)).size!==read.sources.length)throw Error('CRITERION_INPUT_INVALID');
  const purposeFacts=read.acquisitionPurposeMethod==='acquisition-purpose-v1'?attentionOperationFacts(read,token,reviewCutoff):undefined;
  const purpose=purposeFacts?buildPurposeAcquisition(purposeFacts):undefined;
  const auxiliarySources:CriterionInput['auxiliarySources']=[...(read.comparisonAcquisition?.leads??[]).map(lead=>({id:lead.metadataEvidenceId,kind:'INDEXED_METADATA' as const,text:lead.title+'\n'+lead.snippet})),...(read.criterionRecoveryMetadata??[]).map(lead=>({id:lead.id,kind:'INDEXED_METADATA' as const,text:lead.title+'\n'+lead.snippet})),...(read.acquisitionScope?.evidence??[]).map(e=>({id:e.id,kind:'ACQUISITION_RECEIPT' as const,text:purpose?.receipt.text??e.text}))];
  const all=[...read.sources,...auxiliarySources];
  if(new Set(all.map(s=>s.id)).size!==all.length)throw Error('CRITERION_INPUT_INVALID');
  const catalog:CriterionInput['catalog']=[],uncitable:string[]=[];
  for(const source of all)try{const spans=purpose&&source.id==='acquisition-attention-scope'?purposeReceiptSpans(purpose.projection):sourceSpans(source.id,source.text,'CRITERION');if(!spans.length)uncitable.push(source.id);for(const span of spans)catalog.push({id:`c${String(catalog.length+1).padStart(4,'0')}`,sourceId:source.id,spanId:span.id,start:span.start,end:span.end,text:span.text});}catch{uncitable.push(source.id);}
  let ledger:any=null;try{ledger=JSON.parse(read.rawArtifacts['attention-acquisition-ledger']);}catch{/* Missing operations prevent a completed scope. */}
  const searches=Array.isArray(ledger?.searches)?ledger.searches:[];
  const replacement=firecrawlSearch(read);
  let fetchRequests:any=null,http:any=null;
  try{fetchRequests=JSON.parse(read.rawArtifacts['criterion-fetch-requests']);http=JSON.parse(read.rawArtifacts['attention-http-outcomes']);}catch{/* Missing operation records prevent completed scope. */}
  const targetUrls=new Set(read.discoveryUrls??[]);
  for(const id of ['attention-search-1','attention-search-2'])try{const packet=JSON.parse(read.rawArtifacts[id]);for(const row of packet.results??[]){const url=typeof row?.url==='string'?normalizeAttentionSearchUrl(row.url):null;if(url&&(policyId!=='research-fast-v3'||!attentionImageUrl(url)))targetUrls.add(url);}}catch{/* Missing search is reflected in scope. */}
  for(const source of read.sources)if(source.discoveredFrom&&targetUrls.has(source.discoveredFrom)){const binding=read.sourceBindings?.find(b=>b.sourceId===source.id);if(binding)targetUrls.add(binding.requestedUrl);}
  const partial=policyId==='research-fast-v3'&&read.sources.length>0,seeds=new Set(read.discoveryUrls??[]);
  const criterionScopes=Object.fromEntries(criterionIds.map(id=>{
    const readGaps:string[]=[],unreadTargets:string[]=[];
    const comparison=id==='CAN-01';
    const sample=id==='ATT-01'||id==='ATT-02'||id==='ADV-03';
    const operations=searches.filter((s:any)=>s.required&&(s.purpose==='EXACT_TOKEN'||sample&&s.purpose==='SOCIAL'||comparison&&(s.purpose==='COMPARISON'||s.purpose==='RECOVERY')));
    const failures:string[]=[];
    for(const code of read.codes.filter(code=>/COLLECTION_BUDGET|RUN_ABORTED|RUN_TIMEOUT|LIVE_(?:PHASE|HARD)_DEADLINE/.test(code)))failures.push(code);
    const missingSearch=(id:string,fallback:string)=>{if(replacement?.id===id)return;try{const attempt=JSON.parse(read.rawArtifacts[`attention-acquisition-${id}-attempt`]);if(typeof attempt.code==='string'&&/^ATT_SEARCH_[A-Z0-9_]+$/.test(attempt.code)){failures.push(attempt.code);return;}}catch{/* No retained transport attempt. */}failures.push(fallback);};
    if(!operations.some((s:any)=>s.purpose==='EXACT_TOKEN'))missingSearch('attention-search-1','CRITERION_REQUIRED_SEARCH_MISSING');
    if(sample&&!operations.some((s:any)=>s.purpose==='SOCIAL'))missingSearch('attention-search-2','CRITERION_REQUIRED_SOCIAL_SEARCH_MISSING');
    if(comparison&&read.acquisitionProjectName&&!operations.some((s:any)=>s.purpose==='COMPARISON'))missingSearch('attention-search-3-primary','CRITERION_COMPARISON_SEARCH_MISSING');
    for(const operation of operations){let response:any=null;try{response=JSON.parse(read.rawArtifacts[operation.artifactId]);}catch{/* Report incomplete operation. */}
      if(!(operation.status>=200&&operation.status<300&&response&&Array.isArray(response.results)&&!response.error&&(!response.errors||Array.isArray(response.errors)&&!response.errors.length))&&!(replacement&&typeof operation.id==='string'&&replacement.id===operation.id))failures.push(Number.isInteger(operation.status)&&operation.status!==200?`ATT_SEARCH_HTTP_${operation.status}`:'CRITERION_SEARCH_INCOMPLETE');
      const age=Date.parse(reviewCutoff)-Date.parse(operation.availableAt);if(!Number.isFinite(age)||age<0||age>900000)failures.push('CRITERION_SEARCH_STALE');
    }
    if(comparison&&!read.comparisonAcquisition?.descriptorComplete)failures.push('CRITERION_COMPARISON_INCOMPLETE');
    if(comparison&&read.comparisonAcquisition&&requiredComparisonRecoveryParents(read.comparisonAcquisition.leads).length&&(!read.comparisonRecovery||read.comparisonRecovery.recoveryCapped||read.comparisonRecovery.recoveryQueries.some(query=>!query.descriptorComplete)))failures.push('CRITERION_COMPARISON_RECOVERY_INCOMPLETE');
    const comparisonUrls=new Set((read.comparisonAcquisition?.leads??[]).map(lead=>lead.url).filter(Boolean));
    const relevant=(url:string)=>comparison||targetUrls.has(url)||!comparisonUrls.has(url);
    const requiredFetches=Array.isArray(fetchRequests?.requests)?fetchRequests.requests.filter((r:any)=>(comparison||!String(r.artifactId).startsWith('attention-recovery-'))&&Array.isArray(r.urls)&&r.urls.some(relevant)):[];
    if(!Array.isArray(fetchRequests?.requests)||!Array.isArray(http?.outcomes))failures.push('CRITERION_FETCH_ACCOUNTING_MISSING');
    for(const operation of requiredFetches){
      let originHttp:any=null;try{originHttp=JSON.parse(read.rawArtifacts['criterion-origin-http']);}catch{/* Not an origin operation. */}
      let originOutcomes:any=null,recoveryOutcomes:any=null;try{originOutcomes=JSON.parse(read.rawArtifacts['attention-origin-http-outcomes']);}catch{/* Not a role operation. */}try{recoveryOutcomes=JSON.parse(read.rawArtifacts['attention-recovery-http-outcomes']);}catch{/* Not a recovery operation. */}
      const status=http?.outcomes?.find((o:any)=>o.artifactId===operation.artifactId)?.status??originOutcomes?.outcomes?.find((o:any)=>o.artifactId===operation.artifactId)?.status??recoveryOutcomes?.outcomes?.find((o:any)=>o.artifactId===operation.artifactId.replace('attention-recovery-','attention-'))?.status??(originHttp?.artifactId===operation.artifactId?originHttp.status:undefined);
      let response:any=null;try{response=JSON.parse(read.rawArtifacts[operation.artifactId]);}catch{/* Operational failure is not an evidence deficit. */}
      if(!(status>=200&&status<300&&Array.isArray(response?.results)&&Array.isArray(response?.errors))){
        const recovered=operation.urls.filter(relevant).every((url:string)=>read.sourceBindings?.some(binding=>binding.requestedUrl===url&&binding.producerArtifactId.startsWith('firecrawl-scrape-')&&!!firecrawlPage(read,binding.producerArtifactId)));
        if(!recovered)failures.push(Number.isInteger(status)&&status!==200?`ATT_FETCH_HTTP_${status}`:typeof operation.failureCode==='string'&&/^ATT_FETCH_[A-Z0-9_]+$/.test(operation.failureCode)?operation.failureCode:'CRITERION_FETCH_OPERATION_INCOMPLETE');continue;
      }
      for(const url of operation.urls.filter(relevant))if(![...response.results,...response.errors].some((item:any)=>item?.url===url))failures.push('CRITERION_FETCH_OUTCOME_MISSING');
    }
    if(purpose)for(const target of purpose.projection.targets)if(target.state!=='READ'&&target.state!=='TARGET_BLOCKED'&&(purposeFacts?.targets.find(x=>x.requestedUrl===target.requestedUrl)?.necessary&&relevant(target.requestedUrl)||comparison)){const code=`CRITERION_TARGET_${target.state}`;if(!partial||comparison)failures.push(code);else if(!sample||seeds.has(target.requestedUrl)||attentionPostKey(target.requestedUrl)){readGaps.push(code);if(read.fastJudgmentMethod==='read-sources-v1')unreadTargets.push(target.requestedUrl);}}
    if(policyId==='research-fast-v3'&&!sample&&read.metadataUri&&read.codes.includes('METADATA_FETCH_UNAVAILABLE')){readGaps.push('CRITERION_TARGET_PROVIDER_FAILED');unreadTargets.push(read.metadataUri);}
    const ids=all.filter(s=>comparison||s.kind==='ACQUISITION_RECEIPT'||s.kind!=='INDEXED_METADATA'&&(!read.comparisonSourceIds?.includes(s.id)||targetUrls.has(read.sourceBindings?.find(binding=>binding.sourceId===s.id)?.requestedUrl??''))).map(s=>s.id);
    if(ids.some(sourceId=>uncitable.includes(sourceId)))failures.push('CRITERION_SOURCE_UNCITABLE');
    for(const source of read.sources.filter(s=>ids.includes(s.id))){
      const age=Date.parse(reviewCutoff)-Date.parse(source.availableAt);if(!Number.isFinite(age)||age<0||age>900000)failures.push('CRITERION_SOURCE_STALE');
      const binding=read.sourceBindings?.find(b=>b.sourceId===source.id);let original:any=null;
      try{original=binding?.producerArtifactId.startsWith('firecrawl-scrape-')?firecrawlPage(read,binding.producerArtifactId):JSON.parse(read.rawArtifacts[binding!.producerArtifactId]).results[binding!.resultIndex];}catch{/* Missing body binding is an operational blocker. */}
      const alias=read.originRecovery?.aliases.find(a=>a.sourceId===source.id);
      const matches=policyId==='research-fast-v3'&&binding?.producerArtifactId==='metadata-json'?read.rawArtifacts['metadata-json']===source.text:binding?.transform==='ORIGIN_UNDERSCORE_V1'?(alias?!!verifyOriginAlias(alias,read.sources,read.rawArtifacts):typeof original?.text==='string'&&original.text.replace(/\\_/g,'_')===source.text):original?.text===source.text;
      if(!binding||!matches)failures.push('CRITERION_SOURCE_SCOPE_CLIPPED_OR_UNBOUND');
    }
    if(read.codes.some(code=>/ATT_(?:PAGE|SOURCE)_CAP/.test(code))&&!Array.isArray(fetchRequests?.omissions))failures.push('CRITERION_SOURCE_SCOPE_OMITTED');
    if((fetchRequests?.omissions??[]).some((item:any)=>item?.purpose==='EXACT_TOKEN'||sample&&item?.purpose==='SOCIAL'||comparison&&['COMPARISON','RECOVERY'].includes(item?.purpose)))failures.push('CRITERION_SOURCE_SCOPE_OMITTED');
    return [id,{sourceIds:ids,requiredOperationIds:[...operations.map((s:any)=>String(s.artifactId)),...requiredFetches.map((r:any)=>String(r.artifactId))],complete:failures.length===0,failures:[...new Set(failures)],...(partial?{readGaps:[...new Set(readGaps)],...(read.fastJudgmentMethod==='read-sources-v1'?{unreadTargets:[...new Set(unreadTargets)]}:{})}:{})}];
  })) as Record<CriterionId,CriterionScope>;
  const acquisition={ledger,scope:read.acquisitionScope??null,comparison:read.comparisonAcquisition??null,comparisonRecovery:read.comparisonRecovery??null,recoveryMetadata:read.criterionRecoveryMetadata??null,postSampleSourceIds:read.postSampleSourceIds??null,originScope:read.originScope??null,discoveryUrls:read.discoveryUrls??null};
  const operationArtifacts=Object.entries(read.rawArtifacts).filter(([id])=>/^firecrawl-(?:scrape-[12]|search-1)(?:-request)?$/.test(id)||id==='criterion-fetch-requests'||id==='criterion-origin-http'||id==='attention-http-outcomes'||id==='attention-origin-http-outcomes'||id==='attention-recovery-http-outcomes'||(id==='attention-acquisition-ledger'||/^attention-acquisition-attention-(?:recovery-)?search-\d+(?:-primary|-fallback)?-(?:request|response|attempt|http)$/.test(id))||/^attention-(?:(?:recovery-)?(?:fetch|search)|origin-fetch)-\d+(?:-retry-\d+)?$/.test(id)||/^attention-origin-role-\d+-(?:search|fetch|search-query)$/.test(id)).sort(([a],[b])=>a.localeCompare(b)).map(([id,raw])=>({id,sha256:createHash('sha256').update(raw).digest('hex')}));
  const narrativeSourceIds=read.sources.filter(source=>narrativeContentSourceBound(read,source.id,token)).map(source=>source.id);
  const identityOnlySourceIds=read.sources.filter(source=>identityOnlyTokenMetadata(read,source.id,token)).map(source=>source.id);
  let leadershipOptions:ReturnType<typeof primaryLeadershipOptions>=[];try{leadershipOptions=primaryLeadershipOptions(read,token,reviewCutoff);}catch{/* Uncitable sources are accounted in their scope. */}
  const primaryLeadershipCitationIds=catalog.filter(item=>leadershipOptions.some(option=>option.sourceId===item.sourceId&&option.spanId===item.spanId&&option.quote===item.text)).map(item=>item.id);
  let metadataSymbol:string|undefined;if(policyId==='research-fast-v3'&&read.rawArtifacts['discovery-token-metadata'])try{const symbol=decodeTokenMetadataUri(read.rawArtifacts['discovery-token-metadata'],token.address,true).symbol;if(symbol&&/^[A-Za-z0-9]{2,10}$/.test(symbol))metadataSymbol=symbol;}catch{/* Missing or invalid metadata cannot establish a symbol. */}
  const base={...(policyId==='research-fast-v3'&&read.fastJudgmentMethod==='read-sources-v1'?{fastJudgmentMethod:'read-sources-v1' as const}:{}),...(metadataSymbol?{metadataSymbol}:{}),...(purpose?{acquisitionPurposeMethod:'acquisition-purpose-v1' as const,purposeProjection:purpose.projection,purposeReceipt:purpose.receipt}:{}),method:criterionReviewMethod,token,policyId,cutoff:reviewCutoff,start:read.start,end:read.end,requiredIds:[...requiredIds],standards:structuredClone(criterionStandards),sources:structuredClone(read.sources),sourceBindings:structuredClone(read.sourceBindings??[]),narrativeSourceIds,identityOnlySourceIds,primaryLeadershipCitationIds,auxiliarySources,acquisition,operationArtifacts,criterionScopes,queries:[...read.queries],complete:read.complete,codes:[...read.codes],catalog};
  const scopeId=hash(base);return {...base,scopeId,inputId:hash({...base,scopeId})};
}
/** The hosted schema is typed; local envelope parsing is deliberately separate. */
export function criterionPurposeCatalog(input:CriterionInput){
  const purposes:EvidencePurpose[]=['BODY_FACT','FACTUAL_CONFLICT','BOUNDED_MEASUREMENT','BOUNDED_SUPPORT','UNRESOLVED_CONTEXT'];
  const eligible=(id:CriterionId,purpose:EvidencePurpose)=>input.catalog.filter(c=>input.criterionScopes[id].sourceIds.includes(c.sourceId)&&(c.sourceId!=='acquisition-attention-scope'||!!input.purposeProjection&&receiptEligible(input.purposeProjection,{sourceId:c.sourceId,quote:c.text,start:c.start,end:c.end},purpose,input.token,input.cutoff))).map(c=>c.id);
  return Object.fromEntries(input.requiredIds.map(id=>[id,Object.fromEntries(purposes.map(purpose=>[purpose,eligible(id,purpose)]))]));
}
export function criterionWireSchema(input:CriterionInput,requiredIds:CriterionId[]=input.requiredIds,citationRefs:'CATALOG_ENUM'|'STRING'='CATALOG_ENUM',singlePosts=citationRefs==='STRING'){
  const ids=input.catalog.map(c=>c.id),ref=citationRefs==='STRING'?z.string().min(1):ids.length?z.enum(ids as [string,...string[]]):z.string().min(1),refs=z.array(ref).max(16);
  const required=requiredIds.length?z.enum(requiredIds as [CriterionId,...CriterionId[]]):z.enum(criterionIds);
  return z.object({rows:z.array(criterionWireRowSchema.extend({criterionId:required,citationIds:z.array(ref).max(256),premises:z.array(proofSchema.shape.premises.element.extend({citationIds:refs})).max(32),representationWitnesses:z.array(proofSchema.shape.representationWitnesses.element.extend({narrativeCitationIds:refs,mintCitationIds:refs})).max(32),posts:z.array(proofSchema.shape.posts.element.extend({citationIds:refs})).max(singlePosts?64:input.sources.filter(s=>s.kind==='POST').length)})).max(requiredIds.length)}).strict();
}
const criterionEnvelopeSchema=z.object({rows:z.array(z.unknown()).max(32)}).strict();
export type CriterionBatch={rows:Partial<Record<CriterionId,CriterionResult>>;invalid:Partial<Record<CriterionId,CriterionIssue[]>>};
const issue=(path:string,code='CRITERION_FINAL_INVALID',offendingIds:string[]=[],allowedIds:string[]=[]):CriterionIssue=>({path,code,offendingIds,allowedIds});
function postBound(input:CriterionInput,text:string):boolean{
  if(input.token.chain==='solana'?text.includes(input.token.address):text.toLowerCase().includes(input.token.address.toLowerCase()))return true;
  const symbol=input.policyId==='research-fast-v3'?input.metadataSymbol:undefined;
  return !!symbol&&/^[A-Za-z0-9]{2,10}$/.test(symbol)&&new RegExp('(^|[^A-Za-z0-9_])\\$'+symbol+'(?![A-Za-z0-9_])','i').test(text);
}
export function criterionPostFacts(input:CriterionInput){
  const start=Date.parse(input.start),end=Date.parse(input.end),mid=(start+end)/2,cutoff=Date.parse(input.cutoff);
  return input.sources.filter(source=>source.kind==='POST'&&input.criterionScopes['ATT-01'].sourceIds.includes(source.id)).map(source=>{
    const date=source.publishedAt?Date.parse(source.publishedAt):NaN,available=Date.parse(source.availableAt);
    const citations=input.catalog.filter(item=>item.sourceId===source.id&&(input.token.chain==='solana'?item.text.includes(input.token.address):item.text.toLowerCase().includes(input.token.address.toLowerCase()))).map(item=>item.id);
    const exclusionReasons:string[]=[];
    if(!Number.isFinite(date))exclusionReasons.push('PUBLICATION_TIME_UNKNOWN');else if(date<start||date>=end)exclusionReasons.push('OUTSIDE_WINDOW');
    if(!source.authorId)exclusionReasons.push('AUTHOR_UNKNOWN');
    if(!input.catalog.some(item=>item.sourceId===source.id&&postBound(input,item.text)))exclusionReasons.push('LITERAL_MINT_NOT_IN_CATALOG');
    if(!Number.isFinite(available)||available<end||available>cutoff||cutoff-available>900000||Number.isFinite(date)&&date>available)exclusionReasons.push('AVAILABILITY_INVALID');
    if(/this post is only available in the x app|sensitive content|sign in to (?:x|twitter)/i.test(source.text))exclusionReasons.push('BODY_UNREADABLE');
    return {sourceId:source.id,url:source.url,authorId:source.authorId,publishedAt:source.publishedAt,availableAt:source.availableAt,window:!Number.isFinite(date)?'UNKNOWN':date<start||date>=end?'OUTSIDE':date<mid?'PREVIOUS':'CURRENT',literalMintCitationIds:citations,exactBodyHash:createHash('sha256').update(source.text).digest('hex'),exclusionReasons};
  });
}
export function criterionDiagnostics(input:CriterionInput,value:unknown){
  let batch:CriterionBatch;try{batch=decodeCriterionBatch(value,input);}catch{return {error:'INVALID_ENVELOPE',rows:{}};}
  const raw=(value as {rows?:unknown[]})?.rows??[],facts=criterionPostFacts(input),rows:Record<string,unknown>={};
  for(const id of input.requiredIds){
    if(!['ATT-01','ATT-02','ADV-03'].includes(id)){rows[id]={validationPaths:batch.invalid[id]??[],accepted:!!batch.rows[id]};continue;}
    const row=raw.find(item=>!!item&&typeof item==='object'&&(item as {criterionId?:unknown}).criterionId===id) as {posts?:unknown;disposition?:unknown}|undefined;
    const parsed=proofSchema.shape.posts.safeParse(row?.posts),posts=parsed.success?parsed.data:[];
    const measurement=measureCriterionPosts(input,posts),byId=new Map(posts.map(post=>[post.sourceId,post]));
    const perSource=facts.map(fact=>{const post=byId.get(fact.sourceId),reasons=[...fact.exclusionReasons];
      if(!post)reasons.push('CLASSIFICATION_MISSING');else{
        if(post.role==='UNCLEAR')reasons.push('ROLE_UNRESOLVED');
        if(!post.original)reasons.push('NOT_CLASSIFIED_ORIGINAL');
        if(!post.tokenBound)reasons.push('NOT_CLASSIFIED_TOKEN_BOUND');
        const selected=post.citationIds.map(ref=>input.catalog.find(item=>item.id===ref));
        if(selected.some(item=>!item||item.sourceId!==post.sourceId))reasons.push('SELECTED_CITATION_INVALID');
        if(post.original&&post.tokenBound&&!selected.some(item=>item&&(input.token.chain==='solana'?item.text.includes(input.token.address):item.text.toLowerCase().includes(input.token.address.toLowerCase()))))reasons.push('SELECTED_CITATION_LACKS_MINT');
        const selectedKey=selected.map(item=>item?.text??'').join(' ').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
        if(selectedKey&&!measurement.qualifiedSourceIds.includes(fact.sourceId)&&posts.some(other=>other.sourceId!==post.sourceId&&measurement.qualifiedSourceIds.includes(other.sourceId)&&other.citationIds.map(ref=>input.catalog.find(item=>item.id===ref)?.text??'').join(' ').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim()===selectedKey))reasons.push('SELECTED_COPY_DUPLICATE');
        if(post.duplicateOf&&!posts.some(other=>other.sourceId===post.duplicateOf&&other.sourceId!==post.sourceId&&other.citationIds.map(ref=>input.catalog.find(item=>item.id===ref)?.text??'').join(' ').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim()===post.citationIds.map(ref=>input.catalog.find(item=>item.id===ref)?.text??'').join(' ').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim()))reasons.push('DUPLICATE_REFERENCE_INVALID');
        if(!measurement.qualifiedSourceIds.includes(fact.sourceId)&&!reasons.length)reasons.push('NOT_IN_QUALIFIED_SUBSET');
      }
      return {sourceId:fact.sourceId,qualified:measurement.qualifiedSourceIds.includes(fact.sourceId),sameAuthorSourceIds:fact.authorId?facts.filter(other=>other.sourceId!==fact.sourceId&&other.authorId===fact.authorId).map(other=>other.sourceId):[],reasons};});
    const outcome=row?.disposition,threshold=id==='ATT-01'?10:3,meets=measurement.posts>=threshold&&measurement.authors>=3;
    const outcomeCompatibility=outcome==='SUPPORTED'?(id==='ATT-02'?measurement.complete&&measurement.current>measurement.previous:meets):outcome==='CONTRADICTED'?(id==='ATT-02'?measurement.complete&&measurement.current<=measurement.previous:measurement.complete&&!meets):null;
    rows[id]={validationPaths:batch.invalid[id]??[],accepted:!!batch.rows[id],outcomeCompatibility,measurement,missingSourceIds:facts.filter(fact=>!byId.has(fact.sourceId)).map(fact=>fact.sourceId),extraSourceIds:posts.filter(post=>!facts.some(fact=>fact.sourceId===post.sourceId)).map(post=>post.sourceId),perSource};
  }
  return {rows};
}
export function measureCriterionPosts(input:CriterionInput,posts:CriterionProof['posts']){
  const issues:string[]=[],qualified:CriterionInput['sources']=[],all=input.sources.filter(s=>s.kind==='POST'&&input.criterionScopes['ATT-01'].sourceIds.includes(s.id)),seenQuotes=new Set<string>(),seenUrls=new Set<string>();
  if(new Set(posts.map(p=>p.sourceId)).size!==posts.length||all.some(s=>!posts.some(p=>p.sourceId===s.id)))issues.push('POST_CLASSIFICATION_INCOMPLETE');
  const start=Date.parse(input.start),end=Date.parse(input.end),mid=(start+end)/2;
  if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end)issues.push('POST_WINDOW_INVALID');
  for(const p of posts){
    const source=all.find(s=>s.id===p.sourceId),refs=p.citationIds.map(id=>input.catalog.find(c=>c.id===id));
    if(!source||refs.some(ref=>!ref||ref.sourceId!==p.sourceId)){issues.push('POST_SOURCE_INVALID');continue;}
    if(p.role==='UNCLEAR'||!source.publishedAt||!source.authorId){issues.push('POST_UNRESOLVED');continue;}
    const quote=refs.map(ref=>ref!.text).join(' '),key=quote.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
    const bound=postBound(input,quote);
    if(p.duplicateOf&&!posts.some(other=>other.sourceId===p.duplicateOf&&other.sourceId!==source.id&&other.citationIds.map(id=>input.catalog.find(c=>c.id===id)?.text??'').join(' ').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim()===key)){issues.push('POST_DUPLICATE_INVALID');continue;}
    if(p.original&&p.tokenBound&&['CALL','NEWS','JOKE'].includes(p.role)){
      if(!bound||!p.citationIds.length){issues.push('POST_BINDING_INVALID');continue;}
      const date=Date.parse(source.publishedAt);
      const available=Date.parse(source.availableAt),cutoff=Date.parse(input.cutoff);
      if(!Number.isFinite(date)||!Number.isFinite(available)||date>available||available<end||available>cutoff||cutoff-available>900000){issues.push('POST_DATE_INVALID');continue;}
      if(/this post is only available in the x app|sensitive content|sign in to (?:x|twitter)/i.test(source.text)){issues.push('POST_UNREADABLE');continue;}
      if(date>=start&&date<end&&!p.duplicateOf&&!seenQuotes.has(key)&&!seenUrls.has(source.url)){qualified.push(source);seenQuotes.add(key);seenUrls.add(source.url);}
    }
  }
  const complete=issues.length===0,upperBound=complete&&(input.acquisitionPurposeMethod!=='acquisition-purpose-v1'||input.purposeProjection?.samples.find(s=>s.id==='posts')?.sampleComplete===true);
  return {upperBound,qualifiedSourceIds:qualified.map(s=>s.id),posts:qualified.length,authors:new Set(qualified.map(s=>s.authorId)).size,previous:qualified.filter(s=>Date.parse(s.publishedAt!)<mid).length,current:qualified.filter(s=>Date.parse(s.publishedAt!)>=mid).length,complete:issues.length===0,issues:[...new Set(issues)]};
}
export function decodeCriterionBatch(value:unknown,input:CriterionInput,stage:'draft'|'final'|'correction'|'single'='final',allowedIds:CriterionId[]=input.requiredIds):CriterionBatch {
  const packet=criterionEnvelopeSchema.safeParse(value);if(!packet.success)throw Error('CRITERION_BATCH_INVALID');
  const rows:CriterionBatch['rows']={},invalid:CriterionBatch['invalid']={};
  for(const id of allowedIds){
    if(!input.criterionScopes[id].complete)continue;
    const candidates=packet.data.rows.filter(candidate=>(candidate as {criterionId?:unknown}|null)?.criterionId===id);
    if(candidates.length!==1){invalid[id]=[issue('criterionId',candidates.length?'CRITERION_ROW_DUPLICATE':'CRITERION_ROW_MISSING')];continue;}
    let candidate=candidates[0];
    if(stage==='single'&&id==='ADV-03'&&candidate&&typeof candidate==='object'){
      const offered=candidate as {posts?:unknown};
      if(Array.isArray(offered.posts)){
        const seen=new Set<string>(),inScope=new Set(input.sources.filter(source=>source.kind==='POST'&&input.criterionScopes['ATT-01'].sourceIds.includes(source.id)).map(source=>source.id));
        candidate={...offered,posts:offered.posts.filter((post:unknown)=>{const id=(post as {sourceId?:unknown}|null)?.sourceId;if(typeof id!=='string'||!inScope.has(id)||seen.has(id))return false;seen.add(id);return true;})};
      }
    }
    const parsed=criterionWireSchema(input,input.requiredIds,'CATALOG_ENUM',stage==='single').shape.rows.element.safeParse(candidate);
    if(!parsed.success){
      const raw=candidates[0] as {citationIds?:unknown;premises?:Array<{citationIds?:unknown}>;representationWitnesses?:Array<{narrativeCitationIds?:unknown;mintCitationIds?:unknown}>;posts?:Array<{citationIds?:unknown}>};
      const values=[raw?.citationIds,...(Array.isArray(raw?.premises)?raw.premises.map(x=>x?.citationIds):[]),...(Array.isArray(raw?.representationWitnesses)?raw.representationWitnesses.flatMap(x=>[x?.narrativeCitationIds,x?.mintCitationIds]):[]),...(Array.isArray(raw?.posts)?raw.posts.map(x=>x?.citationIds):[])];
      const refs=values.flatMap(v=>Array.isArray(v)?v.filter((x):x is string=>typeof x==='string'):[]),allowed=input.catalog.map(c=>c.id);
      invalid[id]=parsed.error.issues.map(problem=>issue(problem.path.join('.')||'root','CRITERION_WIRE_INVALID',refs.filter(ref=>!allowed.includes(ref)),allowed));continue;
    }
    const wire=parsed.data;
    if(wire.disposition==='UNFINISHED'&&!(stage==='single'&&id==='ADV-03')){invalid[id]=[issue('disposition','CRITERION_REVIEW_UNFINISHED')];continue;}
    const scope=id==='CAN-02'&&wire.premises.some(p=>p.kind==='comparableAttention')?input.criterionScopes['CAN-01']:input.criterionScopes[id];
    const row:CriterionResult={criterionId:id,scopeId:input.scopeId,evaluationState:'COMPLETED',outcome:wire.disposition==='UNFINISHED'?'INSUFFICIENT':wire.disposition,basis:wire.disposition==='SUPPORTED'?'RULE_SATISFIED':wire.disposition==='CONTRADICTED'?'FACTUAL_COUNTEREVIDENCE':'PUBLIC_SUPPORT_INADEQUATE',rationale:wire.rationale,citationIds:wire.citationIds,proof:{reviewAttested:stage==='final'||stage==='correction',suppliedSourceIds:[...scope.sourceIds],premises:wire.premises,representationWitnesses:wire.representationWitnesses,posts:wire.posts,missingSupport:wire.missingSupport},failure:null},paths:string[]=[];
    if(stage==='single'&&input.purposeProjection)row.proof.posts=row.proof.posts.map(p=>({...p,citationIds:p.citationIds.filter(ref=>input.catalog.find(c=>c.id===ref)?.sourceId!=='acquisition-attention-scope')}));
    if(stage==='single'&&id==='ADV-03'){
      row.proof.posts=row.proof.posts.filter(post=>input.sources.some(source=>source.id===post.sourceId&&source.kind==='POST'&&input.criterionScopes['ATT-01'].sourceIds.includes(source.id)));
      row.proof.posts=row.proof.posts.map(post=>({...post,tokenBound:post.citationIds.some(ref=>{const text=input.catalog.find(c=>c.id===ref)?.text??'';return postBound(input,text);})}));
      const measured=measureCriterionPosts(input,row.proof.posts);
      row.outcome=measured.posts>=3&&measured.authors>=3?'SUPPORTED':'INSUFFICIENT';
      row.basis=row.outcome==='SUPPORTED'?'RULE_SATISFIED':'PUBLIC_SUPPORT_INADEQUATE';
      if(!row.proof.missingSupport.length&&row.outcome==='INSUFFICIENT')row.proof.missingSupport=[...input.standards[id].requiredSupport];
      if(scope.readGaps){row.proof.premises=[];const cited=[...new Set(row.proof.posts.flatMap(post=>post.citationIds))];row.citationIds=(cited.length?cited:criterionPurposeCatalog(input)[id]?.BOUNDED_SUPPORT??[]).slice(0,256);}else{
        if(!row.citationIds.length)row.citationIds=[...new Set(row.proof.posts.flatMap(post=>post.citationIds))];
        if(!row.citationIds.length)row.citationIds=input.catalog.filter(c=>scope.sourceIds.includes(c.sourceId)).map(c=>c.id);
      }
    }
    let noNarrativePremise=false;
    if(stage==='single'){
      const eligible=(ref:string)=>{const c=input.catalog.find(item=>item.id===ref);return !input.purposeProjection||c?.sourceId!=='acquisition-attention-scope'||receiptEligible(input.purposeProjection,{sourceId:c.sourceId,quote:c.text,start:c.start,end:c.end},criterionPurpose(row.outcome,id),input.token,input.cutoff);};
      row.citationIds=row.citationIds.filter(eligible);
      row.proof.premises=row.proof.premises.map(p=>({...p,citationIds:p.citationIds.filter(eligible)}));
      row.proof.representationWitnesses=row.proof.representationWitnesses.map(w=>({...w,narrativeCitationIds:w.narrativeCitationIds.filter(eligible),mintCitationIds:w.mintCitationIds.filter(eligible)}));
      if(row.outcome==='CONTRADICTED'&&['NAR-01','NAR-02','NAR-03','CAN-01','CAN-02'].includes(id)&&!row.proof.premises.some(p=>p.citationIds.some(ref=>{const c=input.catalog.find(item=>item.id===ref);return !!c&&input.sources.some(source=>source.id===c.sourceId);}))) {
        const refs=row.citationIds.filter(ref=>{const c=input.catalog.find(item=>item.id===ref);return !!c&&scope.sourceIds.includes(c.sourceId)&&input.sources.some(source=>source.id===c.sourceId);}).slice(0,16);
        if(refs.length&&row.rationale)row.proof.premises.push({kind:'counterevidence',assertion:row.rationale.slice(0,1000),citationIds:refs});
      }
      if(id==='NAR-01'&&row.outcome==='SUPPORTED'&&!row.proof.premises.some(p=>p.citationIds.some(ref=>{const c=input.catalog.find(item=>item.id===ref);return !!c&&scope.sourceIds.includes(c.sourceId)&&input.narrativeSourceIds.includes(c.sourceId)&&!input.identityOnlySourceIds.includes(c.sourceId);}))) {
        noNarrativePremise=true;row.outcome='INSUFFICIENT';row.basis='PUBLIC_SUPPORT_INADEQUATE';row.rationale='The model supplied no eligible cited premise to support the narrative.';row.proof.missingSupport=[...input.standards[id].requiredSupport];row.proof.premises=[];row.proof.representationWitnesses=[];row.citationIds=row.citationIds.filter(ref=>{const c=input.catalog.find(item=>item.id===ref);return !!c&&scope.sourceIds.includes(c.sourceId);});
      }
    }
    if(scope.readGaps?.length&&row.outcome!=='SUPPORTED'&&!(stage==='single'&&input.fastJudgmentMethod==='read-sources-v1')){rows[id]=readGapResult(input,id,scope.readGaps);continue;}
    if(!scope.complete){invalid[id]=[issue('proof.comparableAttention','CRITERION_ROUTE_SCOPE_INCOMPLETE',[],input.primaryLeadershipCitationIds)];continue;}
    const refs=[...row.citationIds,...row.proof.premises.flatMap(p=>p.citationIds),...row.proof.representationWitnesses.flatMap(w=>[...w.narrativeCitationIds,...w.mintCitationIds]),...row.proof.posts.flatMap(p=>p.citationIds)];
    if(refs.some(ref=>!input.catalog.some(c=>c.id===ref)))paths.push('citationIds');
    if(refs.some(ref=>{const item=input.catalog.find(c=>c.id===ref);return item&&!scope.sourceIds.includes(item.sourceId);}))paths.push('proof.suppliedSourceIds');
    if(!row.rationale)paths.push('rationale');
    if(row.outcome==='SUPPORTED'&&(!row.citationIds.length||(!row.proof.premises.length&&!(stage==='single'&&id==='ADV-03'))))paths.push('proof.premises');
    if(row.outcome==='INSUFFICIENT'&&(!row.proof.missingSupport.length||stage!=='single'&&!row.citationIds.length&&!noNarrativePremise))paths.push('proof.missingSupport');
    if(input.purposeProjection&&refs.some(ref=>{const c=input.catalog.find(x=>x.id===ref);return c?.sourceId==='acquisition-attention-scope'&&!receiptEligible(input.purposeProjection!,{sourceId:c.sourceId,quote:c.text,start:c.start,end:c.end},criterionPurpose(row.outcome,id),input.token,input.cutoff);}))paths.push('citationIds:purpose');
    const cited=(ids:string[])=>ids.map(ref=>input.catalog.find(c=>c.id===ref)).filter((x):x is NonNullable<typeof x>=>!!x);
    const namesToken=(text:string,address=input.token.address)=>input.token.chain==='solana'?text.includes(address):text.toLowerCase().includes(address.toLowerCase());
    if(row.evaluationState==='COMPLETED'&&row.outcome==='SUPPORTED'&&id==='NAR-01'){
      const required=['referent','interest','tokenRelation','game'];
      if(required.some(kind=>!row.proof.premises.some(p=>p.kind===kind&&p.citationIds.length)))paths.push('proof.premises');
      if(!row.proof.premises.filter(p=>p.kind==='tokenRelation').some(p=>cited(p.citationIds).some(c=>namesToken(c.text))))paths.push('proof.tokenRelation');
      if(row.proof.representationWitnesses.some(w=>w.token.chain!==input.token.chain||(input.token.chain==='solana'?w.token.address!==input.token.address:w.token.address.toLowerCase()!==input.token.address.toLowerCase())))paths.push('proof.representationWitnesses');
    }
    if(row.evaluationState==='COMPLETED'&&row.outcome==='SUPPORTED'&&id.startsWith('NAR-')&&row.proof.premises.some(p=>cited(p.citationIds).some(c=>!input.narrativeSourceIds.includes(c.sourceId)||input.identityOnlySourceIds.includes(c.sourceId))))paths.push('proof.narrativeEligibility');
    if(row.evaluationState==='COMPLETED'&&row.outcome==='SUPPORTED'&&id==='NAR-02'&&!row.proof.premises.some(p=>p.kind==='attributedOrigin'&&p.citationIds.length&&cited(p.citationIds).some(c=>namesToken(c.text))))paths.push('proof.attributedOrigin');
    if(row.evaluationState==='COMPLETED'&&row.outcome==='SUPPORTED'&&id==='NAR-03'&&['explanation','prerequisites'].some(kind=>!row.proof.premises.some(p=>p.kind===kind&&p.citationIds.length)))paths.push('proof.explanation');
    if(row.evaluationState==='COMPLETED'&&row.outcome==='SUPPORTED'&&id==='CAN-01'){
      const witnesses=row.proof.representationWitnesses;
      if(!witnesses.length||!witnesses.some(w=>w.token.chain===input.token.chain&&(w.token.chain==='solana'?w.token.address===input.token.address:w.token.address.toLowerCase()===input.token.address.toLowerCase())))paths.push('proof.representationWitnesses');
      if(new Set(witnesses.map(w=>`${w.token.chain}:${w.token.chain==='solana'?w.token.address:w.token.address.toLowerCase()}`)).size!==witnesses.length)paths.push('proof.representationWitnesses');
      const noAlternative=row.proof.premises.some(p=>p.kind==='noRelevantAlternative');
      if(witnesses.length===1&&!noAlternative)paths.push('proof.representationWitnesses');
      if(noAlternative&&!criterionComparisonEligibility(input).noRelevantAlternativeEligible)paths.push('proof.comparisonScope');
      for(const witness of witnesses){
        const address=witness.token.address;let valid=false;try{valid=witness.token.chain==='solana'?new PublicKey(address).toBase58()===address:['bsc','base','robinhood'].includes(witness.token.chain)&&/^0x[0-9a-fA-F]{40}$/.test(address);}catch{/* Invalid address cannot identify a representation. */}
        const story=cited(witness.narrativeCitationIds);
        if(!valid||!story.length||story.some(ref=>!input.sources.some(source=>source.id===ref.sourceId)||input.identityOnlySourceIds.includes(ref.sourceId))||!witness.mintCitationIds.length||!cited(witness.mintCitationIds).some(c=>witness.token.chain==='solana'?c.text.includes(address):c.text.toLowerCase().includes(address.toLowerCase())))paths.push('proof.representationWitnesses');
      }
    }
    if(row.evaluationState==='COMPLETED'&&row.outcome==='SUPPORTED'&&id==='CAN-02'){
      const primary=row.proof.premises.some(p=>p.kind==='primaryRelationship'&&p.citationIds.length>0&&p.citationIds.every(ref=>input.primaryLeadershipCitationIds.includes(ref)));
      const witnesses=row.proof.representationWitnesses,posts=row.proof.posts,allPosts=input.sources.filter(source=>source.kind==='POST'&&input.criterionScopes['CAN-01'].sourceIds.includes(source.id));
      let comparable=row.proof.premises.some(p=>p.kind==='comparableAttention'&&p.citationIds.length>0)&&witnesses.length>=2&&witnesses.some(w=>w.token.chain===input.token.chain&&(w.token.chain==='solana'?w.token.address===input.token.address:w.token.address.toLowerCase()===input.token.address.toLowerCase()))&&allPosts.every(source=>posts.some(post=>post.sourceId===source.id));
      const counts=witnesses.map(w=>{
        let valid=false;try{valid=w.token.chain==='solana'?new PublicKey(w.token.address).toBase58()===w.token.address:['bsc','base','robinhood'].includes(w.token.chain)&&/^0x[0-9a-fA-F]{40}$/.test(w.token.address);}catch{/* Invalid representation. */}
        const narrative=cited(w.narrativeCitationIds);
        if(!valid||!narrative.length||narrative.some(ref=>!input.sources.some(source=>source.id===ref.sourceId)||input.identityOnlySourceIds.includes(ref.sourceId))||!w.mintCitationIds.length||!cited(w.mintCitationIds).some(c=>w.token.chain==='solana'?c.text.includes(w.token.address):c.text.toLowerCase().includes(w.token.address.toLowerCase())))comparable=false;
        const seen=new Set<string>();let count=0;
        for(const post of posts){const source=allPosts.find(s=>s.id===post.sourceId),refs=cited(post.citationIds);if(!source||post.role==='UNCLEAR'||!source.authorId||!source.publishedAt||refs.some(ref=>ref.sourceId!==source.id)){comparable=false;continue;}
          const at=Date.parse(source.publishedAt),quote=refs.map(ref=>ref.text).join(' '),bound=w.token.chain==='solana'?quote.includes(w.token.address):quote.toLowerCase().includes(w.token.address.toLowerCase()),key=quote.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
          if(!Number.isFinite(at)){comparable=false;continue;}if(post.original&&['CALL','NEWS','JOKE'].includes(post.role)&&bound&&at>=Date.parse(input.start)&&at<Date.parse(input.end)&&!post.duplicateOf&&!seen.has(key)){seen.add(key);count++;}
        }
        return count;
      });
      const target=witnesses.findIndex(w=>w.token.chain===input.token.chain&&(w.token.chain==='solana'?w.token.address===input.token.address:w.token.address.toLowerCase()===input.token.address.toLowerCase()));
      comparable=comparable&&input.criterionScopes['CAN-01'].complete&&criterionComparisonEligibility(input).noRelevantAlternativeEligible&&target>=0&&counts[target]>0&&counts.every((count,index)=>index===target||counts[target]>count);
      if(!primary&&!comparable)paths.push('proof.leadership');
    }
    if(row.evaluationState==='COMPLETED'&&row.outcome==='CONTRADICTED'&&['NAR-01','NAR-02','NAR-03','CAN-01','CAN-02'].includes(id)&&!row.proof.premises.some(p=>p.citationIds.some(ref=>{const item=input.catalog.find(c=>c.id===ref);return !!item&&input.sources.some(s=>s.id===item.sourceId); })))paths.push('proof.counterevidence');
    if(row.evaluationState==='COMPLETED'&&(id==='ATT-01'||id==='ADV-03')){
      const measured=measureCriterionPosts(input,row.proof.posts),meets=measured.posts>=(id==='ATT-01'?10:3)&&measured.authors>=3;
      if(row.outcome==='CONTRADICTED'&&!measured.upperBound)paths.push('proof.posts');
      if(row.outcome==='SUPPORTED'&&!meets||row.outcome==='CONTRADICTED'&&meets)paths.push('proof.posts.threshold');
    }
    if(row.evaluationState==='COMPLETED'&&id==='ATT-02'){
      const measured=measureCriterionPosts(input,row.proof.posts);
      if(row.outcome!=='INSUFFICIENT'&&!measured.upperBound||row.outcome==='SUPPORTED'&&measured.current<=measured.previous||row.outcome==='CONTRADICTED'&&measured.current>measured.previous)paths.push('proof.growth');
    }
    if(paths.length)invalid[id]=[...new Set(paths)].map(path=>{
      let allowed=criterionPurposeCatalog(input)[id]?.[criterionPurpose(row.outcome,id)]??[];
      let offending=refs;
      if(path==='proof.narrativeEligibility'){allowed=allowed.filter(ref=>{const c=input.catalog.find(x=>x.id===ref);return !!c&&input.narrativeSourceIds.includes(c.sourceId)&&!input.identityOnlySourceIds.includes(c.sourceId);});offending=row.proof.premises.flatMap(p=>p.citationIds).filter(ref=>!allowed.includes(ref));}
      if(path==='proof.attributedOrigin'){allowed=allowed.filter(ref=>{const c=input.catalog.find(x=>x.id===ref);return !!c&&namesToken(c.text)&&input.narrativeSourceIds.includes(c.sourceId)&&!input.identityOnlySourceIds.includes(c.sourceId);});offending=row.proof.premises.filter(p=>p.kind==='attributedOrigin').flatMap(p=>p.citationIds);}
      if(path==='proof.leadership')allowed=input.primaryLeadershipCitationIds;
      if(path.startsWith('proof.posts')||path==='proof.growth'){offending=row.proof.posts.map(p=>p.sourceId);allowed=input.sources.filter(source=>source.kind==='POST'&&scope.sourceIds.includes(source.id)).map(source=>source.id);}
      return issue(path,path==='citationIds:purpose'?'CRITERION_RECEIPT_PURPOSE_INELIGIBLE':'CRITERION_PROOF_INVALID',[...new Set(offending)],[...new Set(allowed)]);
    });else if(stage!=='draft'){
      const measured=['ATT-01','ATT-02','ADV-03'].includes(id)&&row.evaluationState==='COMPLETED'?measureCriterionPosts(input,row.proof.posts):undefined;
      const resolved=measured?{...row,rationale:`${stage==='single'?'Single generation outcome':'Independent review outcome'} ${row.outcome}. Code-qualified ${measured.upperBound?'sample':'lower bound'}: ${measured.posts} posts from ${measured.authors} source authors; ${measured.previous} previous and ${measured.current} current interval posts.${measured.upperBound?'':' Exact totals remain unresolved.'}${stage==='single'&&id==='ADV-03'&&measured.issues.includes('POST_CLASSIFICATION_INCOMPLETE')?' Some in-scope posts were unclassified and were not counted.':''}`} : row;
      rows[id]=scope.readGaps?.length?{...resolved,rationale:stage==='single'&&input.fastJudgmentMethod==='read-sources-v1'?`${resolved.rationale.slice(0,1800)} Partial judgment on read sources; unread targets remain: ${(scope.unreadTargets??scope.readGaps).join(', ')}.`:`${resolved.rationale.slice(0,1800)} Supported on read sources only; unread targets remain: ${scope.readGaps.join(', ')}.`}:resolved;
    }
  }
  return {rows,invalid};
}
const emptyProof=():CriterionProof=>({reviewAttested:false,suppliedSourceIds:[],premises:[],representationWitnesses:[],posts:[],missingSupport:[]});
const readGapResult=(input:CriterionInput,id:CriterionId,gaps:string[]):CriterionResult=>({criterionId:id,scopeId:input.scopeId,evaluationState:'UNAVAILABLE',outcome:null,basis:'EVALUATION_INCOMPLETE',rationale:'Read sources did not establish support while necessary targets stayed unread; no negative is recorded.',citationIds:[],proof:emptyProof(),failure:{category:gaps[0]==='CRITERION_TARGET_PROVIDER_FAILED'?'INFRA':'COLLECTION',code:gaps[0]!,validationPaths:gaps}});
export function finalizeCriterionResults(input:CriterionInput,initial:CriterionBatch,correction?:CriterionBatch,topology:'REVIEWED'|'SINGLE'='REVIEWED'):CriterionResult[]{
  if(topology==='SINGLE'&&input.fastJudgmentMethod==='read-sources-v1'&&!input.sources.length)return input.requiredIds.map(id=>({criterionId:id,scopeId:input.scopeId,evaluationState:'COMPLETED',outcome:'INSUFFICIENT',basis:'NO_READABLE_SOURCES',rationale:'No readable sources were available for this criterion.',citationIds:[],proof:{...emptyProof(),missingSupport:[...input.standards[id].requiredSupport]},failure:null}));
  return input.requiredIds.map(id=>initial.rows[id]??correction?.rows[id]??{criterionId:id,scopeId:input.scopeId,evaluationState:'UNAVAILABLE',outcome:null,basis:'EVALUATION_INCOMPLETE',rationale:topology==='SINGLE'?'Single generation produced no valid result.':'Independent final review was unavailable.',citationIds:[],proof:emptyProof(),failure:input.criterionScopes[id].failures.length?{category:input.acquisitionPurposeMethod==='acquisition-purpose-v1'&&input.criterionScopes[id].failures[0]==='CRITERION_TARGET_PROVIDER_FAILED'?'INFRA':'COLLECTION',code:input.criterionScopes[id].failures[0],validationPaths:input.criterionScopes[id].failures}:{category:'MODEL',code:(correction?.invalid[id]??initial.invalid[id])?.some(x=>x.code==='CRITERION_REVIEW_UNFINISHED')?(topology==='SINGLE'?'CRITERION_SINGLE_UNFINISHED':'CRITERION_REVIEW_UNFINISHED'):(topology==='SINGLE'?'CRITERION_SINGLE_INVALID':'CRITERION_FINAL_INVALID'),validationPaths:(correction?.invalid[id]??initial.invalid[id]??[issue('criterionId','CRITERION_ROW_MISSING')]).map(x=>x.path)}});
}
export function resolveCriterionDecision(receipt:CriterionReceipt,id:CriterionId,cutoff:string,social?:SocialPolicyFacts,input?:CriterionInput):{status:'PASS'|'FAIL'|'UNKNOWN';outcome:CriterionResult['outcome'];basis:string;rationale:string;evidenceIds:string[];failure?:CriterionFailure}{
  const row=receipt.results.find(r=>r.criterionId===id);
  const age=Date.parse(cutoff)-Date.parse(receipt.qualifiedAt);
  let valid=Number.isFinite(age)&&age>=0&&age<=900000;
  if(valid&&input&&row?.evaluationState==='COMPLETED'){
    const acquisition=input.acquisition as {ledger?:{searches?:Array<{id:string;purpose:string;availableAt:string}>};scope?:{evidence?:Array<{id:string;availableAt:string}>};comparison?:{leads?:Array<{metadataEvidenceId:string;searchArtifactId:string}>};recoveryMetadata?:Array<{id:string;searchArtifactId:string}>};
    const sourceTime=(sourceId:string)=>{
      const source=input.sources.find(s=>s.id===sourceId);if(source)return source.availableAt;
      const receiptSource=acquisition.scope?.evidence?.find(s=>s.id===sourceId);if(receiptSource)return receiptSource.availableAt;
      const metadata=acquisition.comparison?.leads?.find(s=>s.metadataEvidenceId===sourceId)??acquisition.recoveryMetadata?.find(s=>s.id===sourceId);
      if(!metadata)return undefined;
      const searches=acquisition.ledger?.searches??[];return searches.filter(s=>s.id===metadata.searchArtifactId||metadata.searchArtifactId==='attention-search-3'&&s.purpose==='COMPARISON').at(-1)?.availableAt;
    };
    const usedRefs=[...row.citationIds,...row.proof.premises.flatMap(p=>p.citationIds),...row.proof.representationWitnesses.flatMap(w=>[...w.narrativeCitationIds,...w.mintCitationIds]),...row.proof.posts.flatMap(p=>p.citationIds)];
    valid=[...new Set(usedRefs.flatMap(id=>input.catalog.find(c=>c.id===id)?.sourceId??[]))].every(sourceId=>{const at=sourceTime(sourceId),sourceAge=at?Date.parse(cutoff)-Date.parse(at):NaN;return Number.isFinite(sourceAge)&&sourceAge>=0&&sourceAge<=900000;});
  }
  const refs=(r:CriterionResult|undefined)=>[...new Set((r?.citationIds??[]).flatMap(id=>{const c=input?.catalog.find(item=>item.id===id);return c?[c.sourceId]:[];}))];
  let result:{status:'PASS'|'FAIL'|'UNKNOWN';outcome:CriterionResult['outcome'];basis:string;rationale:string;evidenceIds:string[];failure?:CriterionFailure}=!valid||!row||row.evaluationState!=='COMPLETED'?{status:'UNKNOWN',outcome:null,basis:row?.basis??'',rationale:!valid?'The reviewed source scope is stale or its availability is unproven.':row?.rationale??'Criterion review unavailable.',evidenceIds:[],...(!valid?{failure:{category:'COLLECTION' as const,code:'CRITERION_SCOPE_STALE',validationPaths:['availableAt']}}:row?.failure?{failure:row.failure}:{})}:{status:row.outcome==='SUPPORTED'?'PASS':'FAIL',outcome:row.outcome,basis:row.basis,rationale:row.rationale,evidenceIds:refs(row)};
  if(valid&&row?.basis==='NO_READABLE_SOURCES')result={...result,status:'UNKNOWN',failure:{category:'COLLECTION',code:'NO_READABLE_SOURCES',validationPaths:[]}};
  if(id==='ADV-03'&&result.status==='PASS'){
    const narrative=resolveCriterionDecision(receipt,'NAR-01',cutoff,social,input);
    if(narrative.status!=='PASS')result={...narrative,basis:'NAR-01 dependency: '+narrative.basis};
  }
  if(id==='ATT-02'){
    const socialAge=social?Date.parse(cutoff)-Date.parse(social.availableAt):NaN;
    const review=social&&Number.isFinite(socialAge)&&socialAge>=0&&socialAge<=900000&&Date.parse(social.start)<Date.parse(social.end)&&Date.parse(social.end)<=Date.parse(cutoff)?social.communityBreadthReview:undefined;
    const community=review?.verdict==='SUPPORTED'?'PASS':review&&review.verdict!=='UNRESOLVED'?'FAIL':'UNKNOWN';
    if(result.status!=='PASS'&&community==='PASS')result={status:'PASS',outcome:'SUPPORTED',basis:'Qualified Social community breadth',rationale:review!.rationale,evidenceIds:social?.evidenceIds??[]};
    else if(result.status==='FAIL'&&community==='FAIL')result={...result,outcome:result.outcome==='INSUFFICIENT'||review?.negativeBasis==='PUBLIC_SUPPORT_INADEQUATE'?'INSUFFICIENT':'CONTRADICTED',basis:result.basis+'; Social community breadth',rationale:result.rationale+' '+review!.rationale,evidenceIds:[...new Set([...result.evidenceIds,...(social?.evidenceIds??[])])]};
    else if(result.status!=='PASS')result={status:'UNKNOWN',outcome:null,basis:result.basis,rationale:'Growth or community breadth remains unavailable.',evidenceIds:result.evidenceIds,...(result.failure?{failure:result.failure}:{})};
  }
  return result;
}
export function resolveCriterion(receipt:CriterionReceipt,id:CriterionId,cutoff:string,social?:SocialPolicyFacts):'PASS'|'FAIL'|'UNKNOWN'{return resolveCriterionDecision(receipt,id,cutoff,social).status;}
export function criterionResolutions(receipt:CriterionReceipt,input:CriterionInput,cutoff:string,social?:SocialPolicyFacts){
  return Object.fromEntries(criterionIds.map(id=>[id,resolveCriterionDecision(receipt,id,cutoff,social,input)])) as Record<CriterionId,ReturnType<typeof resolveCriterionDecision>>;
}
export function criterionSharedClaims(receipt:CriterionReceipt,input:CriterionInput,social?:SocialPolicyFacts,cutoff=input.cutoff){
  return input.requiredIds.flatMap(id=>{
    const decision=resolveCriterionDecision(receipt,id,cutoff,social,input);if(decision.status==='UNKNOWN')return [];
    const own=receipt.results.find(r=>r.criterionId===id),dependency=id==='ADV-03'&&own?.outcome==='SUPPORTED'?receipt.results.find(r=>r.criterionId==='NAR-01'):undefined;
    const selected=dependency&&resolveCriterion(receipt,'NAR-01',cutoff)!=='PASS'?dependency:own;
    const citations=(selected?.citationIds??[]).flatMap(ref=>{const span=input.catalog.find(c=>c.id===ref);return span?[{sourceId:span.sourceId,quote:span.text}]:[];});
    if(id==='ATT-02'&&social?.communityBreadthReview&&decision.basis.includes('Social community breadth'))citations.push(...social.communityBreadthReview.citations);
    const effective=selected?.evaluationState==='COMPLETED'?selected:undefined;
    const sample=['ATT-01','ATT-02','ADV-03'].includes(id)&&selected===own&&!decision.basis.includes('Social community breadth');
    const expand=(refs:string[])=>refs.flatMap(ref=>{const span=input.catalog.find(c=>c.id===ref);return span?[{sourceId:span.sourceId,quote:span.text}]:[];});
    const premises=sample?(effective?.proof.posts??[]).map(post=>({kind:'reviewedPost',assertion:`Source ${post.sourceId}; role ${post.role}; original ${post.original}; token-bound ${post.tokenBound}; duplicate of ${post.duplicateOf??'none'}.`,citations:expand(post.citationIds)})):(effective?.proof.premises??[]).map(p=>({kind:p.kind,assertion:p.assertion,citations:expand(p.citationIds)}));
    const measured=sample&&own?.evaluationState==='COMPLETED'?measureCriterionPosts(input,own.proof.posts):undefined;
    if(sample&&decision.outcome!=='INSUFFICIENT'&&measured?.upperBound&&input.purposeProjection){const span=input.catalog.find(c=>c.sourceId==='acquisition-attention-scope'&&receiptEligible(input.purposeProjection!,{sourceId:c.sourceId,quote:c.text,start:c.start,end:c.end},'BOUNDED_MEASUREMENT',input.token,input.cutoff));if(span&&!citations.some(c=>c.sourceId===span.sourceId&&c.quote===span.text))citations.push({sourceId:span.sourceId,quote:span.text});}
    return [{id:`criterion:${id}`,statement:`${decision.outcome}: ${decision.basis} ${decision.rationale}`,supportBasis:decision.outcome==='INSUFFICIENT'?'BOUNDED_SUPPORT_DECISION' as const:sample&&input.acquisitionPurposeMethod?'BOUNDED_MEASUREMENT' as const:'BODY_FACT' as const,citations,criterionReviewContext:{method:criterionReviewMethod,criterionId:id,outcome:decision.outcome!,basis:decision.basis,question:input.standards[id].question,requiredSupport:input.standards[id].requiredSupport,missingSupport:sample?(effective?.proof.missingSupport??[]).map(value=>'Reviewer gap assertion (unverified): '+value):effective?.proof.missingSupport??[],premises,suppliedSourceIds:effective?.proof.suppliedSourceIds??[],...(measured?{measured:{posts:measured.posts,authors:measured.authors,previous:measured.previous,current:measured.current,complete:measured.upperBound}}:{})}}];
  });
}
