import { originRecoveryQuery, originRecoveryCandidates, geckoPoolBinding, verifyOriginAlias, verifiedOriginExclusion, exactOriginalSubjectForCidMirror, type OriginExclusion, type OriginRecovery } from './origin-recovery.js';
import { fetchReadResponse, readLimitedText } from './http.js';
import { publicHttpsUrl } from './tinyfish.js';
import { decodeTokenMetadataUri } from './token-discovery.js';
import type { TokenRef } from '../domain/contracts.js';
import { acquisitionEvidenceMethod as boundedAcquisitionMethod, acquisitionLedgerSchema, buildAcquisitionScope,
  type AcquisitionLedger, type AcquisitionScope, type AcquisitionSearch } from './acquisition-evidence.js';

export type AttentionSource = {id:string;url:string;text:string;publishedAt:string|null;authorId:string|null;availableAt:string;kind:'POST'|'PAGE';discoveredFrom?:string};
export type ComparisonLead={id:string;searchArtifactId:string;resultIndex:number;url:string|null;title:string;snippet:string;metadataEvidenceId:string;sourceIds:string[];acquisitionStatus:'ACQUIRED'|'FAILED'|'BLOCKED'|'OMITTED'|'CONFLICTED'|'UNSAFE';acquisitionCodes:string[];recoveryQueryIds:string[];recoverySourceIds:string[]};
export type ComparisonAcquisition={originalComplete:boolean;searchSucceeded:boolean;descriptorComplete:boolean;leadCount:number;leads:ComparisonLead[]};
export type RecoveryQueryParent={leadId:string;originalUrl:string|null};
export function requiredComparisonRecoveryParents(leads:ComparisonLead[]):ComparisonLead[]{
  return leads.filter(lead=>{
    if(lead.acquisitionStatus!=='ACQUIRED'||lead.acquisitionCodes.length)return true;
    if(!lead.url)return false;
    const url=new URL(lead.url);return /^(?:www\.)?(?:x|twitter)\.com$/.test(url.hostname)&&/^\/[A-Za-z0-9_]+\/?$/.test(url.pathname);
  });
}
/** Discovery is anchored in the indexed parent, never in a target's trending-widget mention. */
export function indexedComparisonQuery(lead:Pick<ComparisonLead,'title'|'snippet'>):string{
 const seed=(lead.title.trim()||lead.snippet).replace(/[\u0000-\u001f\u007f"\\]/g,' ').replace(/\s+/g,' ').trim().slice(0,180);
 if(!seed)throw Error('ATT_MODEL_COMPARISON_QUERY_INVALID');
 return '"'+seed+'" crypto token';
}
export type OriginAcquisition={method:'original-origin-acquisition-v1';complete:boolean;sourceIds:string[];searches:Array<{id:string;complete:boolean}>;urls:Array<{url:string;sourceId:string|null;state:'ACQUIRED'|'UNAVAILABLE'|'OMITTED'|'CLIPPED'|'CONFLICTED'|'EXCLUDED_REVIEWED'}>};
export type FallbackSelectionMethod='observed-hosts-v1';
type RecoveryPlan={fallbackSelectionMethod?:FallbackSelectionMethod;queries:string[];skipUrls:string[];maxUrls:number;queryParents?:RecoveryQueryParent[];recordQueryTimes?:boolean};
export type ComparisonRecovery={method:'comparison-acquisition-v1';fallbackSelectionMethod?:FallbackSelectionMethod;accessGapMethod?:'own-acquired-alternates-v1'|'own-acquired-alternates-v2'|'own-acquired-alternates-v3'|'own-acquired-alternates-v4'|'own-attempted-alternates-v5';selectedLeadIds:string[];recoveryQueries:Array<{queryId:string;parentLeadId:string;query:string;state:string;descriptorComplete:boolean;resultCount:number;availableAt:string}>;recoveryCapped:boolean;sourceLineage:Array<{leadId:string;queryIds:string[];sourceIds:string[]}>};
export type TerminalPostScope={method:'terminal-post-gap-v1';complete:boolean;sourceIds:string[];gaps:Array<{url:string;code:'HTTP_404'|'HTTP_410'}>;blockers:string[]};
export const recoveryOutcomeMethod='target-page-not-found-v1' as const;
export const sharedClaimProjectionMethod='complete-explanation-v1' as const;
export const narrativeContentMethod='typed-metadata-content-v1' as const;
export const semanticPremiseMethod='criterion-premises-v1' as const;
export const originSupplementMethod='same-subject-cid-mirror-v1' as const;
export type NarrativeContentScope={method:typeof narrativeContentMethod;token:TokenRef;sourceIds:string[];eligibleSourceIds:string[];identityOnlySourceIds:string[]};
export type AttentionRead = {narrativeContentMethod?:typeof narrativeContentMethod;narrativeContentScope?:NarrativeContentScope;semanticPremiseMethod?:typeof semanticPremiseMethod;originSupplementMethod?:typeof originSupplementMethod;sharedClaimProjectionMethod?:typeof sharedClaimProjectionMethod;semanticJudgmentMethod?:'evidence-constitution-v1';recoveryOutcomeMethod?:typeof recoveryOutcomeMethod;acquisitionEvidenceMethod?:typeof boundedAcquisitionMethod;acquisitionScope?:AcquisitionScope;baseQualification?:'NO_SOURCE_CONTENT'|'NO_NARRATIVE_SOURCE_CONTENT';acquisitionProjectName?:string|null;acquisitionDiscovery?:{metadataState:'OBSERVED'|'UNAVAILABLE'|'NOT_APPLICABLE';metadataArtifactId?:string;dexArtifactId?:string};claimDecisionMethod?:'independent-grounded-claims-v1';claimEvidenceMethod?:'cited-claim-view-v1';redirectBodyMethod?:'requested-final-body-v1';entryBoundsMethod?:'accepted-post-intervals-v1';pageBodyRetentionMethod?:'requested-page-bodies-v1';entrySupportMethod?:'reviewed-sample-growth-v1';outcomeBasisMethod?:'entry-outcome-basis-v1';originRecoveryCandidateMethod?:'mint-metadata-subject-v1';metadataLinkMethod?:'onchain-metadata-v1';collectionMethod?:'project-context-v2';leadershipPositiveMethod?:'source-bound-positive-v1';postSampleScope?:TerminalPostScope;entryExecutionMethod?:'entry-first-v1'|'entry-first-v2';comparisonRecovery?:ComparisonRecovery;entryEvidenceMethod?:'public-support-v2';sources:AttentionSource[];rawArtifacts:Record<string,string>;queries:string[];complete:boolean;codes:string[];start:string;end:string;comparisonSourceIds?:string[];comparisonComplete?:boolean;postSampleComplete?:boolean;discoveryUrls?:string[];comparisonAcquisition?:ComparisonAcquisition;comparisonRankingSourceIds?:string[];postSampleSourceIds?:string[];comparisonQualification?:unknown;comparisonCoverage?:import('../domain/attention.js').ComparisonCoverage;comparisonPublicSupport?:import('../domain/attention.js').ComparisonPublicSupport;narrativePublicSupport?:import('../domain/attention.js').NarrativePublicSupport;queryRetrievedAt?:Record<string,string>;metadataLinks?:true;metadataUri?:string;originRecovery?:OriginRecovery;originExclusions?:OriginExclusion[];originScope?:{method:'bounded-origin-sources-v1';complete:boolean;sourceIds:string[];acquisition?:OriginAcquisition};growthSample?:{method:'fixed-query-sample-v1';sourceIds:string[];queries:string[];complete:boolean}};
export const attentionSourceLimit=(read:Pick<AttentionRead,'collectionMethod'>)=>read.collectionMethod==='project-context-v2'?64:32;
export const attentionInitialPageLimit=(read:Pick<AttentionRead,'collectionMethod'>)=>read.collectionMethod==='project-context-v2'?40:32;
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
/** Fetch may report a browser anchor; it does not change the acquired HTTP resource. */
export function normalizeAttentionFetchUrl(value:string):string|null{
  try{const url=new URL(value);url.hash='';return normalizeAttentionSearchUrl(url.toString());}catch{return null;}
}
/** The collector and persistence reconstruction share the original seed-link boundary. */
export function originSeedLinks(seed:string,links:unknown[],method?:'project-context-v2'):string[]{
  const u=new URL(seed),metadata=/\.json(?:[?]|$)/i.test(seed),social=/^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname);
  return [...new Set(links.flatMap(link=>{
    if(typeof link!=='string')return [];const safe=publicHttpsUrl(link,true),next=safe?normalizeAttentionSearchUrl(safe):null;if(!next)return [];const v=new URL(next);
    const eligible=metadata?!/\.(?:png|jpe?g|webp|gif|svg)(?:[?]|$)/i.test(v.pathname):social?/^\/[A-Za-z0-9_]+\/?$/.test(u.pathname)&&/^\/[A-Za-z0-9_]+\/status\/\d+/.test(v.pathname)&&v.pathname.split('/')[1].toLowerCase()===u.pathname.split('/')[1]?.toLowerCase():v.hostname===u.hostname&&/^\/(?:docs?|about|whitepaper|launch|log)(?:[/.\-]|$)/i.test(v.pathname);
    // A token/profile on a shared venue does not own the venue's global docs.
    const platformNavigation=method==='project-context-v2'&&!metadata&&!social&&u.hostname.replace(/^www\./,'')==='pump.fun';
    return eligible&&!platformNavigation?[next]:[];
  }))];
}
/** Failed or omitted original pages cannot disappear behind the surviving text. */
export function reconstructOriginAcquisition(read:AttentionRead,token?:TokenRef):OriginAcquisition{
  const required=new Set(read.discoveryUrls??[]),searches:OriginAcquisition['searches']=[];
  for(let i=1;i<=2;i++){
    const id=`attention-search-${i}`;let complete=false;
    try{const r=JSON.parse(read.rawArtifacts[id]);complete=Array.isArray(r.results)&&!r.error&&(!Array.isArray(r.errors)||!r.errors.length);if(complete)for(const item of r.results){const url=typeof item?.url==='string'?normalizeAttentionSearchUrl(item.url):null;if(url)required.add(url);else complete=false;}}catch{/* Missing original search remains incomplete. */}
    searches.push({id,complete});
  }
  const results:Array<{url:string;finalUrl:string;text:string}>=[],attempted=new Set<string>();
  for(const [id,raw] of Object.entries(read.rawArtifacts))if(/^attention-fetch-\d+(?:-retry-\d+)?$/.test(id))try{
    const response=JSON.parse(raw);if(!Array.isArray(response.results)||!Array.isArray(response.errors))continue;
    for(const e of response.errors)if(typeof e?.url==='string'){const url=normalizeAttentionSearchUrl(e.url);if(url)attempted.add(url);}
    for(const r of response.results){const url=typeof r?.url==='string'?normalizeAttentionSearchUrl(r.url):null,finalUrl=typeof r?.final_url==='string'?normalizeAttentionFetchUrl(r.final_url):url;if(!url||!finalUrl||typeof r.text!=='string')continue;attempted.add(url);results.push({url,finalUrl,text:r.text});if(read.discoveryUrls?.includes(url)){const metadata=/\.json(?:[?]|$)/i.test(url)?[...r.text.matchAll(/https:\/\/[^"\s\\<>]+/g)].map(m=>m[0]):[];for(const link of originSeedLinks(url,[...(Array.isArray(r.links)?r.links:[]),...metadata],read.collectionMethod))required.add(link);}}
  }catch{/* Invalid response cannot supply a page. */}
  const urls:OriginAcquisition['urls']=[...required].map(url=>{
    const observed=results.filter(r=>r.url===url),alias=read.originRecovery?.aliases.find(a=>a.originUrl===url),verified=alias?verifyOriginAlias(alias,read.sources,read.rawArtifacts):null,source=verified??read.sources.find(s=>observed.some(r=>r.finalUrl===s.url&&r.text===s.text)&&s.text.trim()&&s.text.trim().toLowerCase()!=='safety check');
    const excluded=read.originExclusions?.find(e=>e.url===url);
    const state:OriginAcquisition['urls'][number]['state']=!source&&excluded&&verifiedOriginExclusion(read,excluded,token)?'EXCLUDED_REVIEWED':!source?(attempted.has(url)?'UNAVAILABLE':'OMITTED'):!verified&&observed.some(r=>r.text!==source.text)?'CONFLICTED':source.text.length>(read.entryEvidenceMethod?120000:6000)?'CLIPPED':'ACQUIRED';
    return {url,sourceId:source?.id??null,state};
  });
  return {method:'original-origin-acquisition-v1',complete:searches.every(s=>s.complete)&&urls.length>0&&urls.every(u=>u.state==='ACQUIRED'||u.state==='EXCLUDED_REVIEWED'),sourceIds:[...new Set(urls.flatMap(u=>u.sourceId?[u.sourceId]:[]))],searches,urls};
}
/** Definitive missing posts are retained gaps; transport/caps/omissions never qualify this negative-only scope. */
export function terminalPostScope(read:AttentionRead):TerminalPostScope{
 const blockers:string[]=[],candidates=new Set<string>(),bodies=new Set<string>(),missing=new Map<string,'HTTP_404'|'HTTP_410'>();
 const post=(value:unknown)=>{if(typeof value!=='string')return null;const safe=normalizeAttentionSearchUrl(value);if(!safe)return null;const u=new URL(safe),m=/^\/([A-Za-z0-9_]+)\/status\/(\d+)(?:\/.*)?$/.exec(u.pathname);return /^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname)&&m?'https://x.com/'+m[1].toLowerCase()+'/status/'+m[2]:null;};
 for(let n=1;n<=read.queries.length;n++)try{const r=JSON.parse(read.rawArtifacts['attention-search-'+n]);if(!Array.isArray(r.results)||r.error||r.errors&&(!Array.isArray(r.errors)||r.errors.length)||r.results.some((item:unknown)=>!object(item)||typeof item.url!=='string'))throw Error();for(const item of r.results){const url=post(item.url);if(url)candidates.add(url);}}catch{blockers.push('ATT_POST_SCOPE_SEARCH_INCOMPLETE');}
 for(const url of read.discoveryUrls??[]){const key=post(url);if(key)candidates.add(key);}
 const sources=read.sources.filter(source=>source.kind==='POST'&&(!read.postSampleSourceIds||read.postSampleSourceIds.includes(source.id)));
 for(const source of sources){const url=post(source.url);if(url)candidates.add(url);else blockers.push('ATT_POST_SCOPE_BINDING');}
 const observe=(packet:unknown)=>{
   if(!object(packet)||!Array.isArray(packet.results)||!Array.isArray(packet.errors)){blockers.push('ATT_POST_SCOPE_FETCH_INCOMPLETE');return;}
   for(const r of packet.results){if(!object(r))continue;const url=post(r.url),final=post(r.final_url??r.url);if(!url)continue;candidates.add(url);
     if(url===final&&typeof r.text==='string'&&r.text.length<=120000&&sources.some(source=>post(source.url)===url&&source.text===r.text)&&r.text.trim()&&!/^\s*(?:safety check|access denied|forbidden)\s*$/i.test(r.text)){bodies.add(url);missing.delete(url);}
   }
   for(const error of packet.errors){if(!object(error))continue;const url=post(error.url);if(!url)continue;candidates.add(url);if(bodies.has(url))continue;const status=Number(error.status),text=String(error.error??error.code??'');if(status===404||status===410||(!Number.isFinite(status)||status===0)&&/^page_not_found$/.test(text)){missing.set(url,status===410?'HTTP_410':'HTTP_404');}}
 };
 for(const [id,raw]of Object.entries(read.rawArtifacts))if(/^attention-fetch-\d+$/.test(id)){
   try{observe(JSON.parse(raw));if(read.rawArtifacts[id+'-retry-1'])observe(JSON.parse(read.rawArtifacts[id+'-retry-1']));}catch{blockers.push('ATT_POST_SCOPE_FETCH_INCOMPLETE');}
 }
 for(const url of candidates)if(!bodies.has(url)&&!missing.has(url))blockers.push('ATT_POST_SCOPE_UNRESOLVED');
 if(read.codes.some(code=>/^ATT_(?:TEXT_CAP|PAGE_CAP|SOURCE_CAP|FETCH_BINDING|FETCH_SOURCE_CONFLICT)$/.test(code)))blockers.push('ATT_POST_SCOPE_LIMIT_OR_BINDING');
 const gaps=[...missing].filter(([url])=>!bodies.has(url)).map(([url,code])=>({url,code}));
 return {method:'terminal-post-gap-v1',complete:blockers.length===0&&sources.length>0&&gaps.length>0,sourceIds:sources.map(source=>source.id),gaps,blockers:[...new Set(blockers)]};
}
/** Submission limits are versioned so old packets and replay retain their original catalog. */
export function attentionSourceText(read:AttentionRead,text:string){return read.entryEvidenceMethod?text:text.slice(0,6000);}
export function attentionSubmittedSources(read:AttentionRead){return read.sources.map(s=>({...s,text:attentionSourceText(read,s.text)}));}
/** The bounded recovery selection is shared by acquisition and entry-proof reconstruction. */
export function comparisonRecoverySelection(leads:Array<{searchArtifactId:string;resultIndex:number;url:string|null}>,queryParents:RecoveryQueryParent[],skipUrls:string[],maxUrls:number){
 const pageLimit=Math.min(8,Math.max(0,maxUrls)),urls:string[]=[];
 const parents=[...new Map(queryParents.map(p=>[p.leadId,p])).values()];
 const queues=parents.map(parent=>{
  const entries=leads.filter(l=>queryParents[Number(l.searchArtifactId.match(/-(\d+)$/)?.[1])-1]?.leadId===parent.leadId&&l.url&&!skipUrls.includes(l.url));
  entries.sort((a,b)=>a.resultIndex-b.resultIndex||Number(a.searchArtifactId.match(/-(\d+)$/)?.[1])-Number(b.searchArtifactId.match(/-(\d+)$/)?.[1]));
  const host=parent.originalUrl?new URL(parent.originalUrl).hostname.replace(/^www\./,''):null;
  const independent=entries.filter(l=>new URL(l.url!).hostname.replace(/^www\./,'')!==host),same=entries.filter(l=>new URL(l.url!).hostname.replace(/^www\./,'')===host);
  return [...new Set([...independent,...same].map(l=>l.url!))];
 });
 let progress=true;while(urls.length<pageLimit&&progress){progress=false;for(const queue of queues){while(queue.length&&urls.includes(queue[0]!))queue.shift();const next=queue.shift();if(next){urls.push(next);progress=true;}if(urls.length>=pageLimit)break;}}
 const selection=leads.map(l=>({parentId:queryParents[Number(l.searchArtifactId.match(/-(\d+)$/)?.[1])-1]!.leadId,queryId:l.searchArtifactId,resultIndex:l.resultIndex,url:l.url,selected:!!l.url&&urls.includes(l.url),reused:!!l.url&&skipUrls.includes(l.url)}));
 return {method:'fair-parent-query-v1' as const,maxUrls:pageLimit,selectedUrls:urls,selection};
}
type RecoverySlot={parentId:string;url:string};
/** Discovery lineage only: the independent model still evaluates each page's meaning. */
export function comparisonRecoveryFallback(frontier:RecoverySlot[],leads:Array<{searchArtifactId:string;resultIndex:number;url:string|null}>,parents:RecoveryQueryParent[],skipUrls:string[],acquired:Set<string>,policy?:{method:FallbackSelectionMethod;priorSelections:Array<{failedUrl:string;parentId:string;url:string}>}){
 const used=new Set(skipUrls),selections:Array<{failedUrl:string;parentId:string;url:string}>=[];
 const hostOf=(url:string)=>new URL(url).hostname.replace(/^www\./,'');
 const workingHosts=policy?new Set([...acquired].map(hostOf)):new Set<string>();
 for(const slot of frontier){
  if(acquired.has(slot.url))continue;
  const host=new URL(slot.url).hostname.replace(/^www\./,'');
  const candidates=leads.filter(lead=>lead.url&&!used.has(lead.url)&&parents[Number(lead.searchArtifactId.match(/-(\d+)$/)?.[1])-1]?.leadId===slot.parentId);
  if(policy?.method==='observed-hosts-v1'){
   const failedHosts=new Set([host]);let child=slot.url;
   for(const prior of [...policy.priorSelections].reverse())if(prior.parentId===slot.parentId&&prior.url===child){failedHosts.add(hostOf(prior.failedUrl));child=prior.failedUrl;}
   candidates.sort((a,b)=>Number(!workingHosts.has(hostOf(a.url!)))-Number(!workingHosts.has(hostOf(b.url!)))||Number(failedHosts.has(hostOf(a.url!)))-Number(failedHosts.has(hostOf(b.url!)))||Number(hostOf(a.url!)===host)-Number(hostOf(b.url!)===host)||a.resultIndex-b.resultIndex||Number(a.searchArtifactId.match(/-(\d+)$/)?.[1])-Number(b.searchArtifactId.match(/-(\d+)$/)?.[1]));
  }else{
  candidates.sort((a,b)=>Number(new URL(a.url!).hostname.replace(/^www\./,'')===host)-Number(new URL(b.url!).hostname.replace(/^www\./,'')===host)||a.resultIndex-b.resultIndex||Number(a.searchArtifactId.match(/-(\d+)$/)?.[1])-Number(b.searchArtifactId.match(/-(\d+)$/)?.[1]));
  }
  const url=candidates[0]?.url;if(url){used.add(url);selections.push({failedUrl:slot.url,parentId:slot.parentId,url});}
 }
 return selections;
}
/** Public-support review may inspect permanent access gaps; it never grades an interrupted request as token evidence. */
export function entryEvidenceScope(read:AttentionRead,token:TokenRef,cutoff:string){
 const origin=reconstructOriginAcquisition(read,token),blockers:string[]=[],gaps:Array<{url:string;code:string;cause?:string;originalAttemptIds?:string[];parentLeadId?:string;originalRoleId?:string;queryIds?:string[];alternativeSourceIds?:string[];terminalUrl?:string;terminalArtifactId?:string;terminalStatus?:number}>=[],failures=new Map<string,string>(),records:Array<{url:string;text:string;artifactId:string;requestedUrl:string}>=[],recoveryBatchOutcomes=new Map<string,Set<string>>(),recoveryBatchFailures=new Map<string,Map<string,string>>();
 const optionalMirrorFailures:Array<{artifactId:string;requestedUrl:string;subjectUrl:string;code:string}>=[];
 const investigationV5=read.comparisonRecovery?.accessGapMethod==='own-attempted-alternates-v5';
 const investigationV4=read.comparisonRecovery?.accessGapMethod==='own-acquired-alternates-v4'||investigationV5;
 const ownAlternates=['own-acquired-alternates-v1','own-acquired-alternates-v2','own-acquired-alternates-v3','own-acquired-alternates-v4','own-attempted-alternates-v5'].includes(read.comparisonRecovery?.accessGapMethod??'');
 const httpStatus=(id:string)=>{try{const recovery=id.startsWith('attention-recovery-'),role=id.startsWith('attention-origin-role-'),key=role?'attention-origin-http-outcomes':recovery?'attention-recovery-http-outcomes':'attention-http-outcomes',packet=JSON.parse(read.rawArtifacts[key]);const rows=packet.outcomes.filter((r:{artifactId:string})=>r.artifactId===(recovery?id.replace('attention-recovery-','attention-'):id));return packet.method==='fetch-http-outcomes-v1'&&rows.length===1&&Number.isInteger(rows[0].status)?rows[0].status as number:null;}catch{return null;}};
 const httpOk=(id:string)=>{const status=httpStatus(id);return status!==null&&status>=200&&status<300;};
 const httpFailure=(id:string,fallback:string)=>{const status=httpStatus(id);return status!==null&&!httpOk(id)?'ATT_FETCH_HTTP_'+status:fallback;};
 const canonical=(value:string)=>{const safe=normalizeAttentionFetchUrl(value);if(!safe)throw Error('ATT_ENTRY_SOURCE_URL_INVALID');const u=new URL(safe);if(/^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname)){u.hostname='x.com';u.pathname=u.pathname.toLowerCase();}return u.toString();};
 const fail=(id:string,url:string,code:string)=>{const key=canonical(url);failures.set(key,code);if(id.startsWith('attention-recovery-fetch-')){const batch=recoveryBatchFailures.get(id)??new Map<string,string>();batch.set(key,code);recoveryBatchFailures.set(id,batch);}};
 const terminal=(error:Record<string,unknown>)=>/bot_blocked|forbidden|not_found|not found|(?:http[ _:]*)?(?:403|404|410)\b/i.test(String(error.error??error.code??''))||[403,404,410].includes(Number(error.status));
 const searchRows=(id:string):Array<Record<string,unknown>>|null=>{try{const p=JSON.parse(read.rawArtifacts[id]);return Array.isArray(p.results)&&!p.error&&(!p.errors||Array.isArray(p.errors)&&!p.errors.length)&&p.results.every((r:unknown)=>object(r)&&typeof r.url==='string')?p.results:null;}catch{return null;}};
 const requestedUrls=new Set([...origin.urls.map(u=>u.url),...(read.comparisonAcquisition?.leads.flatMap(lead=>lead.url?[lead.url]:[])??[])]);
 for(const id of Object.keys(read.rawArtifacts))if(/^attention-(?:recovery-)?search-\d+$/.test(id))for(const row of searchRows(id)??[]){const url=normalizeAttentionSearchUrl(String(row.url));if(url)requestedUrls.add(url);}
 // Use the collector's effective per-URL state: a validated retry replaces its
 // recovered errors, while historical raw failures remain retained diagnostics.
 for(const [id,raw]of Object.entries(read.rawArtifacts))if(/^attention-(?:(?:recovery-)?fetch-\d+|origin-fetch-1|origin-role-\d+-fetch)$/.test(id))try{
  const packet=JSON.parse(raw);if(!Array.isArray(packet.results)||!Array.isArray(packet.errors)){blockers.push('ATT_ENTRY_FETCH_SHAPE');continue;}
  if(ownAlternates&&/^attention-(?:(?:recovery-)?fetch-\d+|origin-role-\d+-fetch)$/.test(id)&&(!httpOk(id)||packet.error||read.rawArtifacts[id+'-retry-1']&&!httpOk(id+'-retry-1')))blockers.push(httpFailure(!httpOk(id)?id:id+'-retry-1','ATT_ENTRY_FETCH_HTTP_INCOMPLETE'));
  let results=packet.results as Array<Record<string,unknown>>,errors=packet.errors as Array<Record<string,unknown>>;
  if(/^(?:attention-fetch|attention-recovery-fetch)-\d+$/.test(id)){
   try{const retry=JSON.parse(read.rawArtifacts[id+'-retry-1']);if(Array.isArray(retry.results)&&Array.isArray(retry.errors)){
    const permanent=new Set(errors.filter(e=>![408,429,502,503,504].includes(Number(e.status))&&e.error!=='timeout').map(e=>e.url));
    const returned=new Set(results.filter(r=>typeof r.text==='string').map(r=>r.url));
    const recovered=retry.results.filter((r:unknown)=>object(r)&&typeof r.url==='string'&&typeof r.text==='string'&&!permanent.has(r.url)&&!returned.has(r.url)&&(errors.some(e=>e.url===r.url)||requestedUrls.has(r.url)));
    const recoveredUrls=new Set(recovered.map((r:Record<string,unknown>)=>r.url));results=[...results,...recovered];errors=[...errors.filter(e=>!recoveredUrls.has(e.url)),...retry.errors];
   }}catch{/* An invalid retry cannot clear an original failure. */}
  }
  for(const r of results)if(typeof r?.url==='string'&&typeof r?.text==='string'){
   const rawText=r.text;let text=rawText;
   if(id==='attention-origin-fetch-1'){
    const source=read.sources.find(source=>source.url===(r.final_url??r.url)&&(source.text===rawText.replace(/\\_/g,'_')||read.originRecovery?.aliases.some(alias=>alias.sourceId===source.id&&alias.responseId===id&&verifyOriginAlias(alias,read.sources,read.rawArtifacts))));
    const alias=read.originRecovery?.aliases.find(a=>a.sourceId===source?.id);
    const supplement=source&&read.originRecovery?.comparisonSupplementIds.includes(source.id)&&
      (source.url===`https://api.dexscreener.com/token-pairs/v1/${token.chain}/${token.address}`?(()=>{try{const pairs=JSON.parse(source.text);return Array.isArray(pairs)&&pairs.some(p=>p.chainId===token.chain&&(p.baseToken?.address===token.address||p.quoteToken?.address===token.address));}catch{return false;}})():token.chain==='solana'&&read.comparisonAcquisition?.leads.some(lead=>lead.acquisitionStatus!=='ACQUIRED'&&geckoPoolBinding(source,lead.url)));
    if(!source||(r.final_url??r.url)!==r.url||!(alias&&verifyOriginAlias(alias,read.sources,read.rawArtifacts)||supplement))continue;
    text=source.text;
   }
   records.push({url:canonical(String(r.final_url??r.url)),text,artifactId:id,requestedUrl:String(r.url)});
   if(/^attention-recovery-fetch-/.test(id)&&read.sources.some(source=>canonical(source.url)===canonical(String(r.final_url??r.url))&&source.text===text)&&text.trim()&&!/^\s*(?:safety check|access denied|forbidden)\s*$/i.test(text)){
    const batch=recoveryBatchOutcomes.get(id)??new Set<string>();batch.add(canonical(r.url));recoveryBatchOutcomes.set(id,batch);
   }
   if(/^\s*(?:safety check|access denied|forbidden)\s*$/i.test(text))fail(id,r.url,'TARGET_BLOCKED');
  }
  for(const e of errors)if(typeof e?.url==='string'){const text=[e.error,e.code,e.status].filter(v=>v!==undefined).join(' '),code=terminal(e)?'TARGET_BLOCKED':e.error==='empty_content'||e.code==='empty_content'?'TARGET_EMPTY':/timeout|408/i.test(text)?'ATT_FETCH_TIMEOUT':/429|rate.limit/i.test(text)?'ATT_FETCH_HTTP_429':/5\d\d|transport|network/i.test(text)?'ATT_FETCH_TRANSPORT':'ATT_ENTRY_FETCH_UNRESOLVED';const subject=read.originSupplementMethod===originSupplementMethod&&id==='attention-origin-fetch-1'&&!packet.error&&code!=='ATT_ENTRY_FETCH_UNRESOLVED'&&(typeof e.error==='string'||typeof e.code==='string'||typeof e.status==='number')?exactOriginalSubjectForCidMirror(origin.urls.map(u=>u.url),e.url):null;if(subject)optionalMirrorFailures.push({artifactId:id,requestedUrl:e.url,subjectUrl:subject,code});else fail(id,e.url,code);}else blockers.push('ATT_ENTRY_FETCH_SHAPE');
 }catch{blockers.push('ATT_ENTRY_FETCH_SHAPE');}
 type InvestigationOutcome={url:string;finalUrl?:string;batch:string;attemptIds:string[];state:'ACQUIRED'|'ACCESS_GAP'|'INCOMPLETE';sourceIds:string[];targetCodes:Array<{artifactId:string;code:string;status?:number}>;blockers:string[]};
 type InvestigationSearchResult={queryId:string;resultIndex:number;url:string|null;title:string;snippet:string;selected:boolean;reused:boolean;selectedParentLeadId:string|null};
 type ParentInvestigation={searchResults?:InvestigationSearchResult[];parentLeadId:string;originalUrl:string|null;queryIds:string[];selectedUrls:string[];acquiredSourceIds:string[];originalOutcome:InvestigationOutcome|null;outcomes:InvestigationOutcome[];state:'COMPLETE'|'COMPLETE_WITH_GAPS'|'INCOMPLETE';blockers:string[]};
 const comparisonParents:ParentInvestigation[]=[],closedInvestigationUrls=new Set<string>(),investigationUrls=new Set<string>();
 const investigateUrl=(url:string,batch:string):InvestigationOutcome=>{
  const result:InvestigationOutcome={url,batch,attemptIds:[],state:'INCOMPLETE',sourceIds:[],targetCodes:[],blockers:[]};
  const key=canonical(url);let last:any,retryNeeded=false;
  for(const suffix of ['', '-retry-1']){
   const id=batch+suffix;
   if(suffix&&!retryNeeded)continue;
   result.attemptIds.push(id);
   if(!httpOk(id)){result.blockers.push(httpFailure(id,'ATT_ENTRY_RECOVERY_HTTP_INCOMPLETE'));continue;}
   let packet:any;try{packet=JSON.parse(read.rawArtifacts[id]);}catch{result.blockers.push('ATT_ENTRY_RECOVERY_OUTCOME_INCOMPLETE');continue;}
   if(!packet||packet.error||!Array.isArray(packet.results)||!Array.isArray(packet.errors)){result.blockers.push('ATT_ENTRY_RECOVERY_OUTCOME_INCOMPLETE');continue;}
   const rows=[...packet.results.map((value:any)=>({value,body:true})),...packet.errors.map((value:any)=>({value,body:false}))].filter(row=>typeof row.value?.url==='string'&&canonical(row.value.url)===key);
   if(rows.length!==1){result.blockers.push('ATT_ENTRY_RECOVERY_OUTCOME_INCOMPLETE');continue;}
   const row=rows[0];last=row;
   if(row.body){
    if(typeof row.value.text!=='string'||!row.value.text.trim()){result.blockers.push('ATT_ENTRY_RECOVERY_OUTCOME_INCOMPLETE');continue;}
    const final=canonical(String(row.value.final_url??row.value.url));
    const sources=read.sources.filter(source=>canonical(source.url)===final&&source.text===row.value.text);
    const redirected=final!==key;
    if((redirected&&(read.redirectBodyMethod!=='requested-final-body-v1'||read.claimDecisionMethod!=='independent-grounded-claims-v1'))||!sources.length){result.blockers.push('ATT_ENTRY_SOURCE_TEXT_INCOMPLETE');continue;}
    if(redirected)result.finalUrl=final;
    result.sourceIds.push(...sources.map(source=>source.id));
   }else{
    const error=row.value,code=String(error.error??error.code??'');
    const known=['timeout','empty_content','bot_blocked','forbidden','not_found','not found'].includes(code)||code==='target_http_error'&&Number.isInteger(error.status)&&error.status>=400&&error.status<=599||read.recoveryOutcomeMethod===recoveryOutcomeMethod&&code==='page_not_found'&&error.status===410;
    if(!known){result.blockers.push('ATT_ENTRY_RECOVERY_OUTCOME_INCOMPLETE');continue;}
    result.targetCodes.push({artifactId:id,code,...(Number.isInteger(error.status)?{status:error.status}:{})});
    if(!suffix)retryNeeded=code==='timeout'||[408,429,502,503,504].includes(Number(error.status));
   }
  }
  result.sourceIds=[...new Set(result.sourceIds)];
  if(!result.blockers.length&&last)result.state=last.body?'ACQUIRED':'ACCESS_GAP';
  return result;
 };
 const replaced=new Set<string>();
 const terminalClosures=new Map<string,{url:string;code:string;cause:string;parentLeadId:string;queryIds:string[];originalAttemptIds:string[];terminalUrl:string;terminalArtifactId:string;terminalStatus:number;alternativeSourceIds:string[]}>();
 if(!origin.searches.every(s=>s.complete))blockers.push('ATT_ENTRY_REQUIRED_SEARCH_INCOMPLETE');
 const q=(read.entryExecutionMethod?read.comparisonRecovery:read.comparisonQualification) as {fallbackSelectionMethod?:FallbackSelectionMethod;recoveryCapped?:boolean;recoveryQueries?:Array<{queryId:string;parentLeadId:string;state:string;descriptorComplete?:boolean;query?:string;resultCount?:number;availableAt?:string}>}|undefined;
 if(investigationV4){
  const parents=requiredComparisonRecoveryParents(read.comparisonAcquisition?.leads??[]),queries=q?.recoveryQueries??[];
  if(JSON.stringify(read.comparisonRecovery?.selectedLeadIds)!==JSON.stringify(parents.map(parent=>parent.id))||queries.length<parents.length||queries.length>parents.length*2||queries.some((query,index)=>query.queryId!=='attention-recovery-search-'+(index+1)||!parents.some(parent=>parent.id===query.parentLeadId))||parents.some((parent,index)=>queries[index]?.parentLeadId!==parent.id||queries[index]?.query!==indexedComparisonQuery(parent)||queries.filter(query=>query.parentLeadId===parent.id).length>2))blockers.push('ATT_ENTRY_RECOVERY_INDEXED_QUERY_INVALID');
 }
 // Reconstruct the actual bounded selection, then require an effective outcome
 // for every selected URL. Search success alone does not finish acquisition.
 if(q?.recoveryQueries?.length){
  try{
   const graphStart=blockers.length;
   const queries=q.recoveryQueries;if(queries.some(query=>!['OBSERVED','NO_RESULTS'].includes(query.state)||query.descriptorComplete===false||searchRows(query.queryId)===null))blockers.push('ATT_ENTRY_RECOVERY_SEARCH_INCOMPLETE');
   const initial=read.sources.filter(source=>!source.id.startsWith('attention-recovery-'));
   const parents=queries.map(query=>({leadId:query.parentLeadId,originalUrl:read.comparisonAcquisition?.leads.find(lead=>lead.id===query.parentLeadId)?.url??null}));
   const leads=queries.flatMap((query,index)=>(searchRows(query.queryId)??[]).map((row,resultIndex)=>({searchArtifactId:'attention-search-'+(index+1),resultIndex,url:normalizeAttentionSearchUrl(String(row.url))})));
   const skipUrls=[...initial.map(source=>source.url),...(read.comparisonAcquisition?.leads.flatMap(lead=>lead.url?[lead.url]:[])??[])];
   const selected=comparisonRecoverySelection(leads,parents,skipUrls,Math.min(8,attentionSourceLimit(read)-initial.length));
   if(investigationV5){if(leads.some(lead=>!lead.url))blockers.push('ATT_ENTRY_RECOVERY_SELECTION_INVALID');if(selected.maxUrls<8&&comparisonRecoverySelection(leads,parents,skipUrls,8).selectedUrls.length>selected.selectedUrls.length)blockers.push('ATT_ENTRY_RECOVERY_CAP');}
   const expected={...selected,selection:selected.selection.map(row=>({...row,collectorQueryId:row.queryId,queryId:row.queryId.replace('attention-','attention-recovery-')}))};
   const raw=read.rawArtifacts['attention-recovery-selection-scope'];
   if(raw){const actual=JSON.parse(raw);if(actual.method!==expected.method||actual.maxUrls!==expected.maxUrls||JSON.stringify(actual.selectedUrls)!==JSON.stringify(expected.selectedUrls)||(!Array.isArray(actual.selection)||actual.selection.length!==expected.selection.length||expected.selection.some((row,index)=>Object.entries(row).some(([key,value])=>actual.selection[index]?.[key]!==value))))blockers.push('ATT_ENTRY_RECOVERY_SELECTION_INVALID');}
   else if(leads.length)blockers.push('ATT_ENTRY_RECOVERY_SELECTION_MISSING');
   const fallbackRaw=read.rawArtifacts['attention-recovery-fallback-scope'];
   const attempted=[...initial.map(source=>source.url),...(read.comparisonAcquisition?.leads.flatMap(lead=>lead.url?[lead.url]:[])??[]),...selected.selectedUrls];
   let frontier=selected.selectedUrls.map(url=>({url,parentId:selected.selection.find(row=>row.url===url)!.parentId}));
   const selectedParent=new Map(investigationV5?selected.selectedUrls.map(url=>[canonical(url),selected.selection.find(row=>row.url===url)!.parentId] as const):selected.selection.flatMap(row=>row.url?[[canonical(row.url),row.parentId] as const]:[]));
   const selectedBatch=new Map(selected.selectedUrls.map(url=>[canonical(url),'attention-recovery-fetch-1']));
   const terminalLeaves=new Map<string,{terminalUrl:string;terminalArtifactId:string;terminalStatus:number}>();
   const allSelected=[...selected.selectedUrls],links:Array<{failedUrl:string;parentId:string;url:string}>=[];
   const marked=q.fallbackSelectionMethod==='observed-hosts-v1';
   if(q.fallbackSelectionMethod!==undefined&&!marked)blockers.push('ATT_ENTRY_RECOVERY_SELECTION_INVALID');
   const policy=()=>marked?{method:'observed-hosts-v1' as const,priorSelections:links}:undefined;
   const validatedOutcomes=new Set<string>(),validatedFailures=new Map<string,string>(),expectedBatches=new Set<string>();
   const investigationOutcomes=new Map<string,InvestigationOutcome>();
   const validateBatch=(batch:number,urls:string[])=>{
    const allowed=new Set(urls.map(canonical)),id=`attention-recovery-fetch-${batch}`;expectedBatches.add(id);let valid=true;
    for(const suffix of ['', '-retry-1']){
     if(suffix&&!read.rawArtifacts[id+suffix])continue;
     if(ownAlternates&&!httpOk(id+suffix)){blockers.push(httpFailure(id+suffix,'ATT_ENTRY_RECOVERY_HTTP_INCOMPLETE'));valid=false;}
     const packet=JSON.parse(read.rawArtifacts[id+suffix]??'null');
     if(!packet||!Array.isArray(packet.results)||!Array.isArray(packet.errors)||(read.comparisonRecovery?.accessGapMethod==='own-acquired-alternates-v3'||investigationV4)&&packet.error){blockers.push('ATT_ENTRY_RECOVERY_FETCH_INCOMPLETE');valid=false;continue;}
     if([...packet.results,...packet.errors].some(row=>typeof row?.url!=='string'||!allowed.has(canonical(row.url)))){blockers.push('ATT_ENTRY_RECOVERY_SELECTION_INVALID');valid=false;}
     if(investigationV4&&suffix){const first=JSON.parse(read.rawArtifacts[id]??'null');if(first&&Array.isArray(first.results)&&Array.isArray(first.errors)){const returned=new Set(first.results.filter((row:any)=>typeof row.text==='string').map((row:any)=>canonical(row.url))),permanent=new Set(first.errors.filter((row:any)=>![408,429,502,503,504].includes(Number(row.status))&&row.error!=='timeout').map((row:any)=>canonical(row.url))),retryUrls=new Set([...allowed].filter(url=>!returned.has(url)&&!permanent.has(url)));if(!retryUrls.size||[...packet.results,...packet.errors].some(row=>!retryUrls.has(canonical(row.url)))){blockers.push('ATT_ENTRY_RECOVERY_SELECTION_INVALID');valid=false;}}}
    }
    if(investigationV4)for(const url of urls){const outcome=investigateUrl(url,id);investigationOutcomes.set(canonical(url),outcome);if(outcome.blockers.length)blockers.push(...outcome.blockers);}
    if(valid)for(const url of allowed){if(recoveryBatchOutcomes.get(id)?.has(url))validatedOutcomes.add(url);const failure=recoveryBatchFailures.get(id)?.get(url);if(failure)validatedFailures.set(url,failure);if(read.comparisonRecovery?.accessGapMethod==='own-acquired-alternates-v3'&&!validatedOutcomes.has(url)){
      const attempts=[id,id+'-retry-1'].filter(key=>read.rawArtifacts[key]);
      const packets=attempts.map(key=>({key,packet:JSON.parse(read.rawArtifacts[key])}));
      if(!packets.some(({packet})=>packet.results.some((r:any)=>typeof r.url==='string'&&canonical(r.url)===url&&typeof r.text==='string'&&r.text.trim()))){
       const last=packets.flatMap(({key,packet})=>packet.errors.filter((e:any)=>typeof e.url==='string'&&canonical(e.url)===url).map((e:any)=>({key,error:e}))).at(-1);
       if(last&&[404,410].includes(last.error.status)&&httpOk(last.key))terminalLeaves.set(url,{terminalUrl:last.error.url,terminalArtifactId:last.key,terminalStatus:last.error.status});
      }
     }}
   };
   if(selected.selectedUrls.length)validateBatch(1,selected.selectedUrls);
   if(!fallbackRaw&&comparisonRecoveryFallback(frontier,leads,parents,attempted,new Set(selected.selectedUrls.filter(url=>marked?validatedOutcomes.has(canonical(url)):recoveryBatchOutcomes.get('attention-recovery-fetch-1')?.has(canonical(url)))),policy()).length)blockers.push('ATT_ENTRY_RECOVERY_SELECTION_MISSING');
   if(fallbackRaw){
    const fallback=JSON.parse(fallbackRaw);if(fallback.method!==(marked?'same-parent-alternates-v2':'same-parent-alternates-v1')||!Array.isArray(fallback.rounds))throw new Error('fallback shape');
    const acquired=new Set(selected.selectedUrls.filter(url=>validatedOutcomes.has(canonical(url))));
    const expectedRounds=[];
    for(let round=1;round<=2;round++){
     const selections=comparisonRecoveryFallback(frontier,leads,parents,attempted,acquired,policy());
     if(!selections.length)break;
     const batch=round+1;expectedRounds.push({batch,selections});
     // A selected alternative must actually appear in its own retained Fetch batch.
     // Missing result rows are tolerated only if a later acquired alternative resolves them.
     validateBatch(batch,selections.map(item=>item.url));
     for(const item of selections){selectedParent.set(canonical(item.url),item.parentId);selectedBatch.set(canonical(item.url),'attention-recovery-fetch-'+batch);attempted.push(item.url);allSelected.push(item.url);links.push(item);if(validatedOutcomes.has(canonical(item.url)))acquired.add(item.url);}
     frontier=selections.map(item=>({parentId:item.parentId,url:item.url}));
    }
    if(JSON.stringify(fallback.rounds)!==JSON.stringify(expectedRounds))blockers.push('ATT_ENTRY_RECOVERY_SELECTION_INVALID');
    for(const link of [...links].reverse())if(acquired.has(link.url)||replaced.has(canonical(link.url)))replaced.add(canonical(link.failedUrl));
    if(read.comparisonRecovery?.accessGapMethod==='own-acquired-alternates-v3')for(const link of [...links].reverse()){
     const failed=canonical(link.failedUrl),next=canonical(link.url),cause=validatedFailures.get(failed);
     if(!cause||!['ATT_FETCH_TIMEOUT','ATT_FETCH_HTTP_429'].includes(cause)||selectedParent.get(failed)!==link.parentId||selectedParent.get(next)!==link.parentId)continue;
     const leaf=terminalLeaves.get(next)??terminalClosures.get(next);if(!leaf)continue;
     const queriesForParent=queries.filter(query=>query.parentLeadId===link.parentId);
     if(!queriesForParent.length||queriesForParent.some(query=>!httpOk(query.queryId)||query.state!=='OBSERVED'||query.descriptorComplete===false))continue;
     const alternatives=read.sources.filter(source=>{const key=canonical(source.url);return selectedParent.get(key)===link.parentId&&validatedOutcomes.has(key)&&records.some(r=>r.artifactId===selectedBatch.get(key)&&r.url===key&&canonical(r.requestedUrl)===key&&r.text===source.text&&source.text.trim().length>=8&&httpOk(r.artifactId));});
     if(!alternatives.length)continue;
     const batch=selectedBatch.get(failed)!;
     const attemptIds=[batch,batch+'-retry-1'].filter(id=>!!read.rawArtifacts[id]);
     if(attemptIds.some(id=>{const packet=JSON.parse(read.rawArtifacts[id]);return !httpOk(id)||packet.error||packet.results.some((r:any)=>canonical(r.url)===failed)||!packet.errors.some((e:any)=>typeof e.url==='string'&&canonical(e.url)===failed&&(e.error==='timeout'&&e.status===undefined||e.error==='target_http_error'&&e.status===429));}))continue;
     terminalClosures.set(failed,{url:link.failedUrl,code:'RECOVERY_TERMINAL_ACCESS_GAP',cause,parentLeadId:link.parentId,queryIds:queriesForParent.map(query=>query.queryId),originalAttemptIds:attemptIds,terminalUrl:leaf.terminalUrl,terminalArtifactId:leaf.terminalArtifactId,terminalStatus:leaf.terminalStatus,alternativeSourceIds:alternatives.map(source=>source.id)});
    }
   }
   for(const id of Object.keys(read.rawArtifacts))if(id.startsWith('attention-recovery-fetch-')){const match=id.match(/^(attention-recovery-fetch-[1-9]\d*)(?:-retry-1)?$/);if(!match||!expectedBatches.has(match[1]))blockers.push('ATT_ENTRY_RECOVERY_SELECTION_INVALID');}
   if(investigationV4){
    const graphComplete=blockers.length===graphStart;
    for(const parent of requiredComparisonRecoveryParents(read.comparisonAcquisition?.leads??[])){
     const ownQueries=queries.filter(query=>query.parentLeadId===parent.id),urls=allSelected.filter(url=>selectedParent.get(canonical(url))===parent.id),outcomes=urls.map(url=>investigationOutcomes.get(canonical(url))!).filter(Boolean),ownBlockers:string[]=[];
     const queryComplete=ownQueries.length>0&&ownQueries[0].query===indexedComparisonQuery(parent)&&ownQueries.every(query=>{const rows=searchRows(query.queryId);return httpOk(query.queryId)&&query.descriptorComplete===true&&rows!==null&&query.resultCount===rows.length&&query.state===(rows.length?'OBSERVED':'NO_RESULTS')&&(!investigationV5||Number.isFinite(Date.parse(query.availableAt??''))&&Date.parse(cutoff)-Date.parse(query.availableAt??'')>=0&&Date.parse(cutoff)-Date.parse(query.availableAt??'')<=900000);});
     if(!graphComplete||!queryComplete||outcomes.length!==urls.length||outcomes.some(outcome=>outcome.state==='INCOMPLETE'))ownBlockers.push('ATT_ENTRY_RECOVERY_TARGET_ACCESS_INCOMPLETE');
     const acquiredSourceIds=[...new Set(outcomes.filter(outcome=>outcome.state==='ACQUIRED').flatMap(outcome=>outcome.sourceIds))];
     if(!investigationV5&&!acquiredSourceIds.length&&!ownQueries.every(query=>query.state==='NO_RESULTS'))ownBlockers.push('ATT_ENTRY_RECOVERY_TARGET_ACCESS_INCOMPLETE');
     let originalOutcome:InvestigationOutcome|null=null;
     if(parent.url&&parent.acquisitionStatus==='ACQUIRED'&&!parent.acquisitionCodes.length){
      const sources=read.sources.filter(source=>parent.sourceIds.includes(source.id)&&records.some(record=>record.url===canonical(source.url)&&record.text===source.text&&(canonical(record.requestedUrl)===canonical(parent.url!)||geckoPoolBinding(source,parent.url))));
      if(sources.length===parent.sourceIds.length&&sources.length)originalOutcome={url:parent.url,batch:'ORIGINAL',attemptIds:[...new Set(records.filter(record=>sources.some(source=>record.url===canonical(source.url)&&record.text===source.text)).map(record=>record.artifactId))],state:'ACQUIRED',sourceIds:sources.map(source=>source.id),targetCodes:[],blockers:[]};
     }else if(parent.url&&!['OMITTED','UNSAFE','CONFLICTED'].includes(parent.acquisitionStatus)){
      const batch=Object.keys(read.rawArtifacts).filter(id=>/^attention-fetch-\d+$/.test(id)).find(id=>{try{const packet=JSON.parse(read.rawArtifacts[id]);return [...packet.results,...packet.errors].some(row=>typeof row?.url==='string'&&canonical(row.url)===canonical(parent.url!));}catch{return false;}});
      if(batch)originalOutcome=investigateUrl(parent.url,batch);
     }
     if(!originalOutcome||originalOutcome.state==='INCOMPLETE')ownBlockers.push('ATT_ENTRY_COMPARISON_RECOVERY_INCOMPLETE');
     const hasGaps=originalOutcome?.state==='ACCESS_GAP'||outcomes.some(outcome=>outcome.state==='ACCESS_GAP');
     const state=ownBlockers.length?'INCOMPLETE':hasGaps?'COMPLETE_WITH_GAPS':'COMPLETE';
     const searchResults=investigationV5?ownQueries.flatMap(query=>(searchRows(query.queryId)??[]).map((row,resultIndex)=>{const url=normalizeAttentionSearchUrl(String(row.url)),owner=url?selectedParent.get(canonical(url))??null:null;return {queryId:query.queryId,resultIndex,url,title:typeof row.title==='string'?row.title:'',snippet:typeof row.snippet==='string'?row.snippet:'',selected:owner!==null,reused:!!url&&skipUrls.includes(url),selectedParentLeadId:owner};})):undefined;
     comparisonParents.push({...(searchResults?{searchResults}:{}),parentLeadId:parent.id,originalUrl:parent.url,queryIds:ownQueries.map(query=>query.queryId),selectedUrls:urls,acquiredSourceIds,originalOutcome,outcomes,state,blockers:[...new Set(ownBlockers)]});
     for(const outcome of [...(originalOutcome?[originalOutcome]:[]),...outcomes]){
      investigationUrls.add(canonical(outcome.url));
      if(state!=='INCOMPLETE'&&outcome.state==='ACCESS_GAP'){
       closedInvestigationUrls.add(canonical(outcome.url));
       gaps.push({url:outcome.url,code:'PARENT_INVESTIGATION_ACCESS_GAP',cause:outcome.targetCodes.at(-1)?.code,parentLeadId:parent.id,queryIds:ownQueries.map(query=>query.queryId),originalAttemptIds:outcome.attemptIds,alternativeSourceIds:acquiredSourceIds});
      }
     }
     if(ownBlockers.length)blockers.push(...ownBlockers);
    }
   }
   for(const url of allSelected){const key=canonical(url);if(investigationV4)continue;if(terminalClosures.has(key))gaps.push(terminalClosures.get(key)!);else if(replaced.has(key))gaps.push({url,code:'RECOVERED_ALTERNATE'});else if(validatedFailures.get(key)==='TARGET_BLOCKED')gaps.push({url,code:'TARGET_BLOCKED'});else if(!validatedOutcomes.has(key))blockers.push('ATT_ENTRY_RECOVERY_FETCH_INCOMPLETE');}
  }catch{blockers.push('ATT_ENTRY_RECOVERY_SELECTION_INVALID');}
 }
 const recoveredLead=(lead:ComparisonLead)=>{if(investigationV4)return comparisonParents.some(parent=>parent.parentLeadId===lead.id&&parent.state!=='INCOMPLETE');const queries=q?.recoveryQueries?.filter(r=>r.parentLeadId===lead.id)??[];return queries.length>0&&queries.every(r=>['OBSERVED','NO_RESULTS'].includes(r.state)&&r.descriptorComplete!==false&&searchRows(r.queryId)!==null);};
 // Reuse an already completed own comparison recovery for the same URL. Other
 // original gaps require their canonical free role-recovery Search/Fetch attempt.
 const originalCandidates=originRecoveryCandidates(read,reconstructOriginAcquisition({...read,originExclusions:[]},token));
 const recoveredOriginal=(url:string)=>{
  if(read.comparisonAcquisition?.leads.some(lead=>lead.url&&canonical(lead.url)===canonical(url)&&recoveredLead(lead)))return true;
  const index=originalCandidates.findIndex(lead=>lead.url===url);if(index<0)return false;
  const id=`attention-origin-role-${index+1}`,rows=searchRows(id+'-search');if(!rows||read.entryEvidenceMethod&&read.rawArtifacts[id+'-search-query']!==originRecoveryQuery(read,token,url))return false;
  if(ownAlternates&&!httpOk(id+'-search')){blockers.push(httpFailure(id+'-search','ATT_ENTRY_ORIGIN_RECOVERY_HTTP_INCOMPLETE'));return false;}
  const urls=[...new Set(rows.flatMap(row=>{const safe=publicHttpsUrl(String(row.url),true);return safe&&new URL(safe).hostname!==new URL(url).hostname?[safe]:[];}))].slice(0,2);
  if(!urls.length)return rows.length===0;
  if(ownAlternates&&!httpOk(id+'-fetch')){blockers.push(httpFailure(id+'-fetch','ATT_ENTRY_ORIGIN_RECOVERY_HTTP_INCOMPLETE'));return false;}
  try{const fetched=JSON.parse(read.rawArtifacts[id+'-fetch']);return Array.isArray(fetched.results)&&Array.isArray(fetched.errors)&&(!ownAlternates||!fetched.error&&[...fetched.results,...fetched.errors].every(r=>typeof r?.url==='string'&&urls.includes(r.url)))&&urls.every(url=>fetched.results.some((r:Record<string,unknown>)=>r.url===url&&(r.final_url??r.url)===url&&typeof r.text==='string'&&read.sources.some(s=>s.url===url&&s.text===r.text))||fetched.errors.some((e:Record<string,unknown>)=>e.url===url&&terminal(e)));}catch{return false;}
 };
 const acquiredGap=(url:string)=>{
  const cause=failures.get(canonical(url));
  if(!ownAlternates||cause!=='ATT_FETCH_TIMEOUT'&&!(['own-acquired-alternates-v2','own-acquired-alternates-v3','own-acquired-alternates-v4','own-attempted-alternates-v5'].includes(read.comparisonRecovery?.accessGapMethod??'')&&cause==='ATT_FETCH_HTTP_429'))return null;
  // Original target failures require two successful API envelopes and their own
  // acquired alternatives. Whole-request failures and omitted bodies still block.
  const attempts=Object.keys(read.rawArtifacts).filter(id=>/^attention-fetch-\d+$/.test(id)).flatMap(id=>{
   try{const same=(key:string)=>{const p=JSON.parse(read.rawArtifacts[key]);return httpOk(key)&&!p.error&&Array.isArray(p.results)&&Array.isArray(p.errors)&&p.errors.some((e:{url:string;error:string;status?:unknown;code?:unknown})=>e.url===url&&(cause==='ATT_FETCH_TIMEOUT'?e.error==='timeout'&&e.status===undefined&&(e.code===undefined||e.code==='timeout'):e.error==='target_http_error'&&e.status===429))&&!p.results.some((r:{url:string;text:string})=>r.url===url&&typeof r.text==='string'&&r.text.trim());};return same(id)&&same(id+'-retry-1')?[id,id+'-retry-1']:[];}catch{return [];}
  });
  if(attempts.length!==2)return null;
  const parent=read.comparisonAcquisition?.leads.find(lead=>lead.url&&canonical(lead.url)===canonical(url));
  if(investigationV4&&parent)return null;
  let queryIds:string[]=[],roleId:string|undefined;
  if(parent&&recoveredLead(parent))queryIds=(q?.recoveryQueries??[]).filter(r=>r.parentLeadId===parent.id&&r.state==='OBSERVED').map(r=>r.queryId);
  else {const index=originalCandidates.findIndex(lead=>lead.url===url);if(index<0||!recoveredOriginal(url))return null;roleId=`attention-origin-role-${index+1}`;queryIds=[roleId+'-search'];}
  if(!queryIds.length||queryIds.some(id=>!httpOk(id)))return null;
  const alternatives=read.sources.filter(source=>canonical(source.url)!==canonical(url)&&(!roleId||new URL(source.url).hostname!==new URL(url).hostname)&&queryIds.some(id=>(searchRows(id)??[]).some(row=>{const u=normalizeAttentionSearchUrl(String(row.url));return u&&canonical(u)===canonical(source.url);}))&&records.some(r=>(!roleId||r.artifactId===roleId+'-fetch')&&r.url===canonical(source.url)&&r.text===source.text&&r.url===canonical(r.requestedUrl)&&httpOk(r.artifactId)&&source.text.trim().length>=8&&!/^\s*(?:safety check|access denied|forbidden)\s*$/i.test(source.text)));
  if(!alternatives.length)return null;
  return {url,code:'TARGET_ACCESS_GAP',cause:cause!,originalAttemptIds:attempts,...(parent?{parentLeadId:parent.id}:{originalRoleId:roleId!}),queryIds,alternativeSourceIds:alternatives.map(s=>s.id)};
 };
 const timeoutGaps=new Map<string,NonNullable<ReturnType<typeof acquiredGap>>>();
 for(const url of new Set([...origin.urls.map(u=>u.url),...(read.comparisonAcquisition?.leads.flatMap(l=>l.url?[l.url]:[])??[])])){const gap=acquiredGap(url);if(gap){timeoutGaps.set(canonical(url),gap);gaps.push(gap);}}
 for(const [url,code] of failures)if(!closedInvestigationUrls.has(url)&&code!=='TARGET_BLOCKED'&&!terminalClosures.has(url)&&!replaced.has(url)&&!timeoutGaps.has(url)&&!(code==='TARGET_EMPTY'&&recoveredOriginal(url)))blockers.push(investigationV4&&investigationUrls.has(url)?'ATT_ENTRY_RECOVERY_TARGET_ACCESS_INCOMPLETE':code);
 for(const u of origin.urls)if(u.state!=='ACQUIRED'&&u.state!=='EXCLUDED_REVIEWED'){const code=failures.get(canonical(u.url));if((timeoutGaps.has(canonical(u.url))||closedInvestigationUrls.has(canonical(u.url)))&&u.state==='UNAVAILABLE')continue;if((code==='TARGET_BLOCKED'||code==='TARGET_EMPTY')&&u.state==='UNAVAILABLE'&&recoveredOriginal(u.url))gaps.push({url:u.url,code});else blockers.push(code==='TARGET_BLOCKED'||code==='TARGET_EMPTY'?'ATT_ENTRY_ORIGIN_RECOVERY_INCOMPLETE':'ATT_ENTRY_ORIGIN_'+u.state);}
 if(!read.comparisonAcquisition?.searchSucceeded||!read.comparisonAcquisition.descriptorComplete)blockers.push('ATT_ENTRY_COMPARISON_SEARCH_INCOMPLETE');
 if(q?.recoveryCapped)blockers.push('ATT_ENTRY_RECOVERY_CAP');
 for(const lead of read.comparisonAcquisition?.leads??[])if(lead.acquisitionStatus!=='ACQUIRED'||lead.acquisitionCodes.length){const code=lead.url&&failures.get(canonical(lead.url));if(lead.url&&(timeoutGaps.has(canonical(lead.url))||closedInvestigationUrls.has(canonical(lead.url))))continue;if((code==='TARGET_BLOCKED'||code==='TARGET_EMPTY')&&recoveredLead(lead))gaps.push({url:lead.url!,code});else blockers.push('ATT_ENTRY_COMPARISON_RECOVERY_INCOMPLETE');}
 for(const source of read.sources){if(source.text.length>120000)blockers.push('ATT_ENTRY_TEXT_CAP');if(!records.some(r=>r.url===canonical(source.url)&&r.text===source.text))blockers.push('ATT_ENTRY_SOURCE_TEXT_INCOMPLETE');const age=Date.parse(cutoff)-Date.parse(source.availableAt);if(!Number.isFinite(age)||age<0||age>900000)blockers.push('ATT_ENTRY_SOURCE_STALE');}
 for(const code of read.codes)if(/^(?:ATT_(?:SEARCH|FETCH|RECOVERY)|WEB_).*(?:TIMEOUT|TRANSPORT|HTTP_(?:408|429|5\d\d))|COLLECTION_BUDGET|RUN_ABORTED/.test(code))blockers.push(code);
 if(!read.sources.length||read.sources.length>attentionSourceLimit(read))blockers.push('ATT_ENTRY_SOURCE_CAP');
 const operational=blockers.find(c=>/TIMEOUT|TRANSPORT|DNS_ERROR|HTTP_(?:408|429|5\d\d)|COLLECTION_BUDGET|RUN_ABORTED/.test(c));
  const result={...(read.originSupplementMethod===originSupplementMethod?{optionalMirrorFailures}:{}),...(investigationV4?{comparisonParents}:{}),method:investigationV5?'attempted-public-source-scope-v4' as const:investigationV4?'attempted-public-source-scope-v3' as const:ownAlternates?'attempted-public-source-scope-v2' as const:'attempted-public-source-scope-v1' as const,...(q?.fallbackSelectionMethod?{fallbackSelectionMethod:q.fallbackSelectionMethod}:{}),complete:blockers.length===0,sourceIds:read.sources.map(s=>s.id),originSourceIds:origin.sourceIds,gaps:[...new Map(gaps.map(g=>[g.url,g])).values()],blockers:[...new Set(operational?[operational,...blockers]:blockers)]};
  if(read.acquisitionEvidenceMethod===boundedAcquisitionMethod){
   const acquisition=buildAttentionAcquisitionScope(read,token,cutoff);
   return {...result,complete:acquisition.complete,blockers:acquisition.blockers};
  }
  return result;
}
/** Rebuild the marked acquisition receipt from retained requests, actual outcomes and existing body-scope checks. */
export function buildAttentionAcquisitionScope(read:AttentionRead,token:TokenRef,cutoff:string):AcquisitionScope{
 if(read.acquisitionEvidenceMethod!==boundedAcquisitionMethod)throw new Error('ATTENTION_ACQUISITION_METHOD_INVALID');
 const blockers:string[]=[],raw=read.rawArtifacts,ledgerId='attention-acquisition-ledger';
 let ledger:AcquisitionLedger|undefined;
 try{ledger=acquisitionLedgerSchema.parse(JSON.parse(raw[ledgerId]!));}catch{blockers.push('ACQUISITION_LEDGER_MISSING_OR_INVALID');}
 const sameToken=(left:TokenRef,right:TokenRef)=>left.chain===right.chain&&(left.chain==='solana'?left.address===right.address:left.address.toLowerCase()===right.address.toLowerCase());
 if(ledger&&!sameToken(ledger.token,token))blockers.push('ACQUISITION_SCOPE_BINDING_INVALID');
 const discovery=read.acquisitionDiscovery;
 let dexPairs:Array<Record<string,any>>|null=null;
 if(!discovery?.dexArtifactId||typeof raw[discovery.dexArtifactId]!=='string')blockers.push('ACQUISITION_DEX_DISCOVERY_MISSING');
 else try{
  const value=JSON.parse(raw[discovery.dexArtifactId]!);
  if(Array.isArray(value)&&value.every(row=>row&&typeof row==='object'&&!Array.isArray(row)))dexPairs=value;
  else blockers.push('ACQUISITION_DEX_DISCOVERY_INVALID');
 }catch{blockers.push('ACQUISITION_DEX_DISCOVERY_INVALID');}
 const matches=(address:unknown)=>typeof address==='string'&&(token.chain==='solana'?address===token.address:address.toLowerCase()===token.address.toLowerCase());
 const exactPairs=(dexPairs??[]).filter(pair=>pair.chainId===token.chain&&(matches(pair.baseToken?.address)||matches(pair.quoteToken?.address)));
 const exactNames=exactPairs.flatMap(pair=>{
  const side=matches(pair.baseToken?.address)?pair.baseToken:pair.quoteToken;
  return typeof side?.name==='string'&&side.name.trim()?[side.name.trim()]:[];
 });
 if(read.acquisitionProjectName!==null&&read.acquisitionProjectName!==undefined){
  if(!read.acquisitionProjectName.trim()||read.acquisitionProjectName.length>100||!exactNames.includes(read.acquisitionProjectName.trim()))blockers.push('ACQUISITION_PROJECT_NAME_BINDING_INVALID');
 }else if(exactNames.length)blockers.push('ACQUISITION_PROJECT_NAME_BINDING_INVALID');
 if(!discovery)blockers.push('ACQUISITION_DISCOVERY_MISSING');
 else if(discovery.metadataState==='UNAVAILABLE'){
  if(!read.sources.length&&!read.acquisitionProjectName)blockers.push('ACQUISITION_METADATA_DISCOVERY_INCOMPLETE');
 }
 else if(discovery.metadataState==='OBSERVED'){
  if(!discovery.metadataArtifactId||typeof raw[discovery.metadataArtifactId]!=='string')blockers.push('ACQUISITION_METADATA_DISCOVERY_INCOMPLETE');
  else try{const decoded=decodeTokenMetadataUri(raw[discovery.metadataArtifactId]!,token.address);if(decoded.code&&!read.sources.length&&!read.acquisitionProjectName)blockers.push('ACQUISITION_METADATA_DISCOVERY_INCOMPLETE');}catch{if(!read.sources.length&&!read.acquisitionProjectName)blockers.push('ACQUISITION_METADATA_DISCOVERY_INCOMPLETE');}
 }
 if(token.chain==='solana'&&discovery?.metadataState==='NOT_APPLICABLE')blockers.push('ACQUISITION_METADATA_DISCOVERY_INCOMPLETE');
 const seeds=[...new Set((read.discoveryUrls??[]).map(url=>publicHttpsUrl(url,true)).filter((url):url is string=>!!url).map(url=>normalizeAttentionSearchUrl(url)??url))].slice(0,4);
 const seedScopes=seeds.map(url=>{const u=new URL(url);return `site:${u.hostname}${/^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname)?u.pathname:''}`;});
 const exactQueries=[`"${token.address}" ${token.chain} ${seedScopes.length?`(${seedScopes.join(' OR ')})`:'narrative origin catalyst'}`,`"${token.address}" (site:x.com OR site:twitter.com)`];
 if(read.queries[0]!==exactQueries[0]||read.queries[1]!==exactQueries[1])blockers.push('ACQUISITION_QUERY_BINDING_INVALID');
 const expectedQueries:Array<{query:string;purpose:AcquisitionSearch['purpose']}>= [
  {query:exactQueries[0]!,purpose:'EXACT_TOKEN'},
  {query:exactQueries[1]!,purpose:'SOCIAL'},
 ];
 const projectName=read.acquisitionProjectName??null;
 let primaryComparison:string|undefined,fallbackComparison:string|undefined;
 if(projectName){
  const name=projectName.replace(/["\\]/g,'');
  primaryComparison=`"${name}" ${token.chain} crypto token contract`;
  fallbackComparison=`"${name}" ${token.chain}`;
  const hasFallback=!!ledger?.searches.some(search=>search.id==='attention-search-3-fallback');
  expectedQueries.push({query:primaryComparison,purpose:'COMPARISON'});
  if(hasFallback)expectedQueries.push({query:fallbackComparison,purpose:'COMPARISON'});
  if(read.queries[2]!== (hasFallback?fallbackComparison:primaryComparison))blockers.push('ACQUISITION_QUERY_BINDING_INVALID');
 }else if(read.queries.length>2||ledger?.searches.some(search=>search.purpose==='COMPARISON'))blockers.push('ACQUISITION_COMPARISON_WITHOUT_NAME');
 const recoveryQueries=(read.comparisonRecovery?.recoveryQueries??[]).map(query=>({query:query.query,purpose:'RECOVERY' as const,id:query.queryId}));
 for(const query of recoveryQueries)expectedQueries.push({query:query.query,purpose:query.purpose});
 const rows=ledger?.searches??[];
 const expectedIds=new Set(['attention-search-1','attention-search-2',...(projectName?['attention-search-3-primary',...(rows.some(row=>row.id==='attention-search-3-fallback')?['attention-search-3-fallback']:[])]:[]),...recoveryQueries.map(query=>query.id)]);
 if(ledger&&rows.some(row=>!expectedIds.has(row.id)))blockers.push('ACQUISITION_UNEXPECTED_QUERY');
 for(const expected of expectedQueries){
  const row=rows.find(search=>search.required&&search.query===expected.query&&search.purpose===expected.purpose);
  if(!row)continue;
  const descriptorId=`attention-acquisition-${row.id}-request`;
  try{
   const descriptor=JSON.parse(raw[descriptorId]!);
   const requestUrl=new URL(String(descriptor.url));
   if(descriptor.method!=='attention-acquisition-search-request-v1'||descriptor.id!==row.id||!sameToken(descriptor.token,token)||descriptor.query!==row.query||descriptor.purpose!==row.purpose||requestUrl.hostname!=='api.search.tinyfish.ai'||requestUrl.searchParams.get('query')!==row.query)blockers.push('ACQUISITION_QUERY_BINDING_INVALID');
  }catch{blockers.push('ACQUISITION_REQUEST_MISSING');}
   try{
    const outcome=JSON.parse(raw[`attention-acquisition-${row.id}-http`]!);
    if(outcome.method!=='attention-acquisition-search-http-v1'||outcome.id!==row.id||outcome.status!==row.status||outcome.availableAt!==row.availableAt||outcome.responseArtifactId!==row.artifactId||outcome.bodyAvailable!==(typeof raw[row.artifactId]==='string'))blockers.push('ACQUISITION_HTTP_OUTCOME_INVALID');
   }catch{blockers.push('ACQUISITION_HTTP_OUTCOME_MISSING');}
   const legacyId=row.id==='attention-search-3-primary'?(raw['attention-search-3-empty-response']?'attention-search-3-empty-response':'attention-search-3'):row.id==='attention-search-3-fallback'?'attention-search-3':row.id.startsWith('attention-recovery-search-')?row.id:`attention-search-${row.id.match(/\d+$/)?.[0]}`;
   const legacyResponse=raw[legacyId]??(row.id.startsWith('attention-recovery-search-')?raw[`attention-search-${row.id.match(/\d+$/)?.[0]}`]:undefined);
   if(typeof raw[row.artifactId]==='string'&&(legacyResponse===undefined||raw[row.artifactId]!==legacyResponse))blockers.push('ACQUISITION_RESPONSE_BINDING_INVALID');
   const fallbackRow=row.id==='attention-search-3-fallback';
   const legacyOutcomeId=row.id==='attention-search-3-primary'?'attention-search-3':row.id==='attention-search-3-fallback'||row.id.startsWith('attention-recovery-search-')?null:`attention-search-${row.id.match(/\d+$/)?.[0]}`;
   if(legacyOutcomeId&&!(fallbackRow&&(row.status<200||row.status>=300)))try{
    const outcomes=JSON.parse(raw['attention-http-outcomes']!).outcomes as Array<{artifactId:string;status:number}>;
    const outcome=outcomes.filter(record=>record.artifactId===legacyOutcomeId);
    if(outcome.length!==1||outcome[0]!.status!==row.status)blockers.push('ACQUISITION_HTTP_OUTCOME_INVALID');
   }catch{blockers.push('ACQUISITION_HTTP_OUTCOME_MISSING');}
 }
 if(projectName){
  const primary=rows.find(row=>row.id==='attention-search-3-primary');
  const primaryRaw=primary&&raw[primary.artifactId];
  if(primary&&primaryRaw){try{const result=JSON.parse(primaryRaw);if(Array.isArray(result.results)&&result.results.length===0&&!rows.some(row=>row.id==='attention-search-3-fallback'))blockers.push('ACQUISITION_REQUIRED_QUERY_MISSING');}catch{/* The common scope builder records the malformed response as incomplete. */}}
 }
 const base=entryEvidenceScope({...read,acquisitionEvidenceMethod:undefined,acquisitionScope:undefined},token,cutoff);
 const requiredResults=expectedQueries.map(expected=>{
  const row=rows.find(search=>search.required&&search.query===expected.query&&search.purpose===expected.purpose);
  if(!row||row.status<200||row.status>=300)return null;
  try{const value=JSON.parse(raw[row.artifactId]!);return object(value)&&Array.isArray(value.results)&&!value.error&&(!value.errors||Array.isArray(value.errors)&&value.errors.length===0)&&value.results.every((item:unknown)=>object(item)&&typeof item.url==='string')?value.results as unknown[]:null;}catch{return null;}
 });
 const allRequiredEmpty=requiredResults.length>0&&requiredResults.every(result=>result!==null&&result.length===0);
 const discoveryComplete=!!discovery?.dexArtifactId&&dexPairs!==null&&(token.chain!=='solana'?discovery.metadataState==='NOT_APPLICABLE':discovery.metadataState==='OBSERVED');
 const bodyScopeComplete=read.sources.length>0&&base.blockers.every(code=>code==='ATT_ENTRY_COMPARISON_SEARCH_INCOMPLETE');
 const noNameCompleted=projectName===null&&!!discovery?.dexArtifactId&&dexPairs!==null&&(discoveryComplete||bodyScopeComplete);
 const baseBlockers=base.blockers.filter(code=>{
  if(code==='ATT_ENTRY_SOURCE_CAP'&&read.sources.length===0&&allRequiredEmpty)return false;
  if(code==='ATT_ENTRY_COMPARISON_SEARCH_INCOMPLETE'&&noNameCompleted)return false;
  return true;
 });
 const acquisitionSearchIds=new Set(rows.map(row=>row.id));
 acquisitionSearchIds.add('attention-search-1');acquisitionSearchIds.add('attention-search-2');
 if(projectName){acquisitionSearchIds.add('attention-search-3-primary');const fallback='attention-search-3-fallback';if(rows.some(row=>row.id===fallback)||['request','response','attempt','http'].some(kind=>raw[`attention-acquisition-${fallback}-${kind}`]!==undefined))acquisitionSearchIds.add(fallback);}
 for(const query of read.comparisonRecovery?.recoveryQueries??[])acquisitionSearchIds.add(query.queryId);
 const queryArtifactIds=[...acquisitionSearchIds].flatMap(id=>[
  `attention-acquisition-${id}-request`,`attention-acquisition-${id}-response`,`attention-acquisition-${id}-attempt`,`attention-acquisition-${id}-http`,
  ...rows.filter(row=>row.id===id).map(row=>row.artifactId),
 ]).filter((id,index,all)=>all.indexOf(id)===index&&typeof raw[id]==='string');
 const artifactIds=[...queryArtifactIds,...(discovery?.dexArtifactId?[discovery.dexArtifactId]:[]),...(discovery?.metadataArtifactId?[discovery.metadataArtifactId]:[])];
 const ledgerEnd=Date.parse(ledger?.end??read.end),retainedTimes=read.sources.map(source=>Date.parse(source.availableAt)).filter(Number.isFinite),availableAt=new Date(Math.max(Number.isFinite(ledgerEnd)?ledgerEnd:Date.parse(read.end),...retainedTimes)).toISOString();
 return buildAcquisitionScope({token,group:'PUBLIC_ENTRY',cutoff,start:ledger?.start??read.start,end:ledger?.end??read.end,availableAt,ledgerId,rawArtifacts:raw,sourceIds:read.sources.map(source=>source.id),expectedQueries,blockers:[...blockers,...baseBlockers],artifactIds});
}
/** Decode only the observed search-result redirect wire, then apply the normal public URL gate. */
export function normalizeAttentionSearchUrl(value:string):string|null{
  let target=value;
  if(value.startsWith('/url?')){
    const redirect=new URL(value,'https://www.google.com');
    const targets=redirect.searchParams.getAll('q');
    if(redirect.pathname!=='/url'||redirect.hash||targets.length!==1)return null;
    target=targets[0]!;
  }
  const safe=publicHttpsUrl(target,true);if(!safe)return null;
  const u=new URL(safe);
  return /^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname)&&/^\/[A-Za-z0-9_]+\/status\/\d+(?:\/.*)?$/.test(u.pathname)?`https://x.com/${u.pathname.split('/')[1].toLowerCase()}/status/${u.pathname.split('/')[3]}`:safe;
}
/** A declared web-search sample; never represents exhaustive platform coverage. */
function attentionFailure(error:unknown,stage:'SEARCH'|'FETCH'){
 const prefix='ATT_'+stage+'_',code=error&&typeof error==='object'&&'cause'in error&&error.cause&&typeof error.cause==='object'&&'code'in error.cause?String(error.cause.code):'';
 if(error instanceof Error&&(error.name==='TimeoutError'||['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT'].includes(code)))return prefix+'TIMEOUT';
 if(error instanceof Error&&error.message==='COLLECTION_BUDGET'||error instanceof Error&&error.name==='AbortError')return 'ATT_COLLECTION_BUDGET';
 if(['ENOTFOUND','EAI_AGAIN'].includes(code))return prefix+'DNS_ERROR';
 if(error instanceof TypeError)return prefix+'TRANSPORT';
 if(error instanceof SyntaxError)return prefix+'SHAPE';
 if(error instanceof Error&&error.message==='PROVIDER_RESPONSE_LIMIT')return prefix+'RESPONSE_LIMIT';
 return prefix+'UNAVAILABLE';
}
export async function collectAttentionSources(token:TokenRef,key:string,fetcher:typeof fetch=fetch,now:()=>string=()=>new Date().toISOString(),name?:string,discoveryUrls:string[]=[],recoveryPlan?:RecoveryPlan,entryEvidenceMethod?:'public-support-v2',pageBodyRetentionMethod?:'requested-page-bodies-v1',acquisitionEvidenceMethod?:typeof boundedAcquisitionMethod):Promise<AttentionRead>{
  const queryRetrievedAt:Record<string,string>={};
  const leads:ComparisonLead[]=[],sourceByRequested=new Map<string,string>(),blockedUrls=new Set<string>(),conflictedUrls=new Set<string>();
  let descriptorComplete=true,descriptorCharacters=0,leadCount=0;
  const pageLimit=recoveryPlan?Math.min(8,Math.max(0,recoveryPlan.maxUrls)):(entryEvidenceMethod?40:32);
  const end=now(),start=new Date(Date.parse(end)-24*3600_000).toISOString();
  const rawArtifacts:Record<string,string>={},codes:string[]=[],urls:string[]=[],sources:AttentionSource[]=[],comparisonUrls=new Set<string>(),comparisonSourceIds:string[]=[],comparisonFetched=new Set<string>(),truncatedSourceUrls=new Set<string>();
  const acquisitionStart=acquisitionEvidenceMethod?end:undefined,acquisitionSearches:AcquisitionSearch[]=[];
  const acquisitionSearchId=(index:number,role:'primary'|'fallback'='primary')=>recoveryPlan?`attention-recovery-search-${index+1}`:index===2?`attention-search-3-${role}`:`attention-search-${index+1}`;
  const acquisitionArtifactId=(searchId:string,kind:'request'|'response'|'attempt'|'http')=>`attention-acquisition-${searchId}-${kind}`;
  const captureSearchRequest=(searchId:string,query:string,purpose:AcquisitionSearch['purpose'],url:string)=>{
    if(!acquisitionEvidenceMethod)return;
    const id=acquisitionArtifactId(searchId,'request');
    rawArtifacts[id]=JSON.stringify({method:'attention-acquisition-search-request-v1',id:searchId,token,query,purpose,requestedAt:now(),url});
  };
  const captureSearchResponse=(searchId:string,query:string,purpose:AcquisitionSearch['purpose'],status:number,raw:string|undefined)=>{
    if(!acquisitionEvidenceMethod)return;
    const availableAt=now(),artifactId=acquisitionArtifactId(searchId,'response');
    if(raw!==undefined)rawArtifacts[artifactId]=raw;
    rawArtifacts[acquisitionArtifactId(searchId,'http')]=JSON.stringify({method:'attention-acquisition-search-http-v1',id:searchId,status,availableAt,responseArtifactId:artifactId,bodyAvailable:raw!==undefined});
    acquisitionSearches.push({id:searchId,query,purpose,artifactId,status,availableAt,required:true});
  };
  const captureSearchAttempt=(searchId:string,query:string,purpose:AcquisitionSearch['purpose'],error:unknown,status?:number)=>{
    if(!acquisitionEvidenceMethod)return;
    const id=acquisitionArtifactId(searchId,'attempt');
    rawArtifacts[id]=JSON.stringify({method:'attention-acquisition-search-attempt-v1',id:searchId,token,query,purpose,...(status===undefined?{}:{status}),code:attentionFailure(error,'SEARCH'),availableAt:now()});
  };
  const requestSearch=async(searchId:string,query:string,purpose:AcquisitionSearch['purpose'],url:string,legacyArtifactId:string,recordLegacyHttp:boolean)=>{
    captureSearchRequest(searchId,query,purpose,url);
    let response:Response;
    try{response=await fetchReadResponse(url,{headers:{'X-API-Key':key,accept:'application/json'}},fetcher,10000);}
    catch(error){captureSearchAttempt(searchId,query,purpose,error);throw error;}
    if(recordLegacyHttp||response.ok)httpOutcome(legacyArtifactId,response.status);
    let raw:string|undefined;
    if(response.ok||acquisitionEvidenceMethod)try{raw=await readLimitedText(response,100000);}
    catch(error){captureSearchResponse(searchId,query,purpose,response.status,undefined);captureSearchAttempt(searchId,query,purpose,error,response.status);throw error;}
    captureSearchResponse(searchId,query,purpose,response.status,raw);
    return {response,raw};
  };
  const httpOutcome=(artifactId:string,status:number)=>{if(!entryEvidenceMethod)return;const id='attention-http-outcomes',prior=rawArtifacts[id]?JSON.parse(rawArtifacts[id]).outcomes:[];rawArtifacts[id]=JSON.stringify({method:'fetch-http-outcomes-v1',outcomes:[...prior.filter((r:{artifactId:string})=>r.artifactId!==artifactId),{artifactId,status}]});};
  const isPostUrl=(url:string)=>{const u=new URL(url);return /^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname)&&/^\/[A-Za-z0-9_]+\/status\/\d+(?:\/.*)?$/.test(u.pathname);};
  const canonicalUrl=(url:string)=>{if(!isPostUrl(url))return url;const u=new URL(url);return `https://x.com/${u.pathname.split('/')[1].toLowerCase()}/status/${u.pathname.split('/')[3]}`;};
  const seeds=[...new Set(discoveryUrls.map(url=>publicHttpsUrl(url,true)).filter((u):u is string=>!!u).map(canonicalUrl))].slice(0,4);
  urls.push(...seeds);
  const discoveryParents=new Map<string,string>(),followed=new Set<string>();
  const seedScopes=seeds.map(url=>{const u=new URL(url);return `site:${u.hostname}${/^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname)?u.pathname:''}`;});
  const queries=recoveryPlan?[...recoveryPlan.queries]:[`"${token.address}" ${token.chain} ${seedScopes.length?`(${seedScopes.join(' OR ')})`:'narrative origin catalyst'}`,`"${token.address}" (site:x.com OR site:twitter.com)`];
  const comparisonIntent='Find public sources identifying distinct token contract addresses representing this named crypto project or narrative. Prioritize contract-bearing project pages and substantive original posts. Exclude non-crypto dictionary matches. Same name alone does not establish association; do not rank by price.';
  if(!recoveryPlan&&name&&name.length<=100)queries.push(`"${name.replace(/["\\]/g,'')}" ${token.chain} crypto token contract`);
  let postSampleComplete=true,comparisonSearchSucceeded=false,comparisonIncomplete=false;
  for(const [i,query] of queries.entries())try{
    const url=new URL('https://api.search.tinyfish.ai/');url.searchParams.set('query',query);
    if(recoveryPlan||i===2){const intent=recoveryPlan?'Identify and corroborate the indexed entity and distinctive subject or mechanism named in this query using descriptive independent public sources. Include descriptive context and alternate contract-bearing pages when applicable; a shared name alone is insufficient.':comparisonIntent;url.searchParams.set('intent',intent);rawArtifacts[`attention-search-${i+1}-intent`]=intent;}
    const purpose:AcquisitionSearch['purpose']=recoveryPlan?'RECOVERY':i===0?'EXACT_TOKEN':i===1?'SOCIAL':'COMPARISON';
    const searchId=acquisitionSearchId(i);
    const {response,raw:retainedRaw}=await requestSearch(searchId,query,purpose,url.toString(),'attention-search-'+(i+1),true);
    if(!response.ok){codes.push(`ATT_SEARCH_HTTP_${response.status}`);postSampleComplete=false;if(recoveryPlan||i===2)comparisonIncomplete=true;continue;}
    let raw=retainedRaw!;rawArtifacts[`attention-search-${i+1}`]=raw;if(recoveryPlan?.recordQueryTimes)queryRetrievedAt[`attention-search-${i+1}`]=now();let value:unknown=JSON.parse(raw);
    if(!recoveryPlan&&i===2&&query!==`"${name!.replace(/["\\]/g,'')}" ${token.chain}`&&object(value)&&!value.error&&Array.isArray(value.results)&&value.results.length===0&&(value.errors===undefined||Array.isArray(value.errors)&&value.errors.length===0)){
      rawArtifacts['attention-search-3-primary-query']=query;
      rawArtifacts['attention-search-3-empty-response']=raw;
      const fallback=`"${name!.replace(/["\\]/g,'')}" ${token.chain}`;
      const fallbackUrl=new URL(url);fallbackUrl.searchParams.set('query',fallback);
      const fallbackId=acquisitionSearchId(i,'fallback');
      const fallbackResult=await requestSearch(fallbackId,fallback,'COMPARISON',fallbackUrl.toString(),'attention-search-'+(i+1),false);
      const fallbackResponse=fallbackResult.response;
      if(!fallbackResponse.ok){codes.push(`ATT_SEARCH_HTTP_${fallbackResponse.status}`);comparisonIncomplete=true;continue;}
      raw=fallbackResult.raw!;value=JSON.parse(raw);rawArtifacts['attention-search-3']=raw;queries[i]=fallback;
    }
    if(!object(value)||!Array.isArray(value.results)){codes.push('ATT_SEARCH_SHAPE');postSampleComplete=false;if(recoveryPlan||i===2)comparisonIncomplete=true;continue;}
    if(recoveryPlan||i===2)comparisonSearchSucceeded=true;
    for(const [resultIndex,r] of value.results.entries()){
      if(!object(r)||typeof r.url!=='string'){if(recoveryPlan||i===2){descriptorComplete=false;comparisonIncomplete=true;leadCount++;}continue;}
      const safe=normalizeAttentionSearchUrl(r.url);
      if(recoveryPlan||i===2){
        leadCount++;
        const title=typeof r.title==='string'?r.title:'',snippet=typeof r.snippet==='string'?r.snippet:'';
        const descriptor=title+'\n'+snippet;
        if(leads.length>=(recoveryPlan?200:32)||descriptorCharacters+descriptor.length>(recoveryPlan?200000:64000)){descriptorComplete=false;comparisonIncomplete=true;codes.push('ATT_DESCRIPTOR_CAP');}
        else{
          descriptorCharacters+=descriptor.length;
          const id=`comparison-lead-${leads.length+1}`,metadataEvidenceId=`${id}-metadata`;
          rawArtifacts[metadataEvidenceId]=JSON.stringify({searchArtifactId:`attention-search-${i+1}`,resultIndex,url:r.url,normalizedUrl:safe,...(r.url.startsWith('/url?')?{urlMethod:'tinyfish-search-redirect-v1'}:{}),title,snippet});
          leads.push({id,searchArtifactId:`attention-search-${i+1}`,resultIndex,url:safe,title,snippet,metadataEvidenceId,sourceIds:[],acquisitionStatus:safe?'FAILED':'UNSAFE',acquisitionCodes:safe?[]:['ATT_UNSAFE_URL'],recoveryQueryIds:[],recoverySourceIds:[]});
        }
        if(safe)comparisonUrls.add(safe);else comparisonIncomplete=true;
      }
      if(safe&&!recoveryPlan?.queryParents&&!urls.includes(safe)&&!recoveryPlan?.skipUrls.includes(safe)){
        if(urls.length>=pageLimit){codes.push('ATT_PAGE_CAP');if(isPostUrl(safe))postSampleComplete=false;if(recoveryPlan||i===2)comparisonIncomplete=true;continue;}urls.push(safe);
      }
    }
    if(i===2&&comparisonUrls.size===0)comparisonIncomplete=true;
  }catch(error){codes.push(entryEvidenceMethod?attentionFailure(error,'SEARCH'):'ATT_SEARCH_UNAVAILABLE');postSampleComplete=false;if(recoveryPlan||i===2)comparisonIncomplete=true;}
  let fallbackFrontier:RecoverySlot[]=[];
  const fallbackRounds:Array<{batch:number;selections:ReturnType<typeof comparisonRecoveryFallback>}>=[];
  if(recoveryPlan?.queryParents){
    if(recoveryPlan.queryParents.length!==queries.length)throw new Error('ATT_RECOVERY_PARENT_INVALID');
    const selected=comparisonRecoverySelection(leads,recoveryPlan.queryParents,recoveryPlan.skipUrls,pageLimit);
    urls.push(...selected.selectedUrls);
    const selection=selected.selection;
    if(selection.some(l=>l.url&&!l.selected&&!l.reused)){codes.push('ATT_PAGE_CAP');comparisonIncomplete=true;}
    rawArtifacts['attention-selection-scope']=JSON.stringify(selected);
    fallbackFrontier=selected.selectedUrls.map(url=>({url,parentId:selection.find(row=>row.url===url)!.parentId}));
  }
  let offset=0,batch=0,comparisonCharacters=0;
  const enqueueFallback=()=>{
    if(!entryEvidenceMethod||!recoveryPlan?.queryParents||fallbackRounds.length>=2)return false;
    const selections=comparisonRecoveryFallback(fallbackFrontier,leads,recoveryPlan.queryParents,[...recoveryPlan.skipUrls,...urls],new Set(sourceByRequested.keys()),recoveryPlan.fallbackSelectionMethod?{method:recoveryPlan.fallbackSelectionMethod,priorSelections:fallbackRounds.flatMap(round=>round.selections)}:undefined);
    if(!selections.length)return false;
    fallbackRounds.push({batch:batch+1,selections});
    fallbackFrontier=selections.map(item=>({parentId:item.parentId,url:item.url}));
    urls.push(...selections.map(item=>item.url));return true;
  };
  while(offset<urls.length||enqueueFallback()){
    const requested=urls.slice(offset,offset+10);
    offset+=requested.length;batch++;
    try{
    const response=await fetchReadResponse('https://api.fetch.tinyfish.ai/',{method:'POST',headers:{'X-API-Key':key,'content-type':'application/json'},body:JSON.stringify({urls:requested,format:'markdown',links:true,ttl:0,per_url_timeout_ms:8000})},fetcher,30000);
    httpOutcome('attention-fetch-'+batch,response.status);
    if(!response.ok){codes.push(`ATT_FETCH_HTTP_${response.status}`);if(requested.some(isPostUrl))postSampleComplete=false;if(requested.some(url=>comparisonUrls.has(url)))comparisonIncomplete=true;continue;}
    const raw=await readLimitedText(response,2000000);rawArtifacts[`attention-fetch-${batch}`]=raw;const value:unknown=JSON.parse(raw);
    if(!object(value)||!Array.isArray(value.results)||!Array.isArray(value.errors)){codes.push('ATT_FETCH_SHAPE');if(requested.some(isPostUrl))postSampleComplete=false;if(requested.some(url=>comparisonUrls.has(url)))comparisonIncomplete=true;continue;}
    // HTTP-200 can contain transient per-URL failures. Recover only those URLs;
    // permanent denial and missing pages are evidence limits, not retry targets.
    const permanent=new Set(value.errors.filter(object).filter(e=>![408,429,502,503,504].includes(Number(e.status))&&e.error!=='timeout').map(e=>e.url));
    const returnedUrls=new Set(value.results.filter(object).filter(r=>typeof r.text==='string').map(r=>r.url));
    const retryUrls=requested.filter(url=>!returnedUrls.has(url)&&!permanent.has(url));
    if(retryUrls.length)try{
      const recovery=await fetchReadResponse('https://api.fetch.tinyfish.ai/',{method:'POST',headers:{'X-API-Key':key,'content-type':'application/json'},body:JSON.stringify({urls:retryUrls,format:'markdown',links:true,ttl:0,per_url_timeout_ms:15000})},fetcher,30000);
      httpOutcome('attention-fetch-'+batch+'-retry-1',recovery.status);
      const retryRaw=await readLimitedText(recovery,2000000);rawArtifacts[`attention-fetch-${batch}-retry-1`]=retryRaw;
      const recovered:unknown=JSON.parse(retryRaw);
      if(recovery.ok&&object(recovered)&&Array.isArray(recovered.results)&&Array.isArray(recovered.errors)){
        // Binding validation below applies equally to recovered responses.
        const validRecovered=recovered.results.filter(object).filter(r=>retryUrls.includes(String(r.url))&&typeof r.text==='string');
        value.results.push(...validRecovered);
        const recoveredUrls=new Set(validRecovered.map(r=>r.url));
        const unresolved=value.errors.filter(e=>!object(e)||!recoveredUrls.has(e.url));
        value.errors.splice(0,value.errors.length,...unresolved);
        value.errors.push(...recovered.errors);
      }
    }catch{/* Original failure is retained and coverage below remains incomplete. */}
    if(value.errors.length)codes.push('ATT_FETCH_URL_ERROR');
    const returned=new Set<string>();
    for(const r of value.results){
      if(!object(r)||typeof r.url!=='string'||typeof r.text!=='string')continue;
      const requestedUrl=publicHttpsUrl(r.url,true);let url=typeof r.final_url==='string'?normalizeAttentionFetchUrl(r.final_url):requestedUrl;
      const comparisonResult=!!requestedUrl&&comparisonUrls.has(requestedUrl);
      if(!requestedUrl||!url||!requested.includes(requestedUrl)||returned.has(requestedUrl)){codes.push('ATT_FETCH_BINDING');if(comparisonResult)comparisonIncomplete=true;continue;}
      if(!r.text.trim()||/^\s*(?:safety check|access denied|forbidden)\s*$/i.test(r.text)){
        codes.push('ATT_FETCH_BLOCKED_CONTENT');blockedUrls.add(requestedUrl);
        if(comparisonResult)comparisonIncomplete=true;
        if(isPostUrl(requestedUrl))postSampleComplete=false;
        continue;
      }
      const u=new URL(url),post=/^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname)&&/^\/[A-Za-z0-9_]+\/status\/\d+(?:\/.*)?$/.test(u.pathname);
      if(isPostUrl(requestedUrl)&&(!post||new URL(requestedUrl).pathname.split('/')[3]!==u.pathname.split('/')[3])){codes.push('ATT_FETCH_BINDING');postSampleComplete=false;if(comparisonResult)comparisonIncomplete=true;continue;}
      returned.add(requestedUrl);
      if(comparisonResult)comparisonFetched.add(requestedUrl);
      if(post)url=`https://x.com/${u.pathname.split('/')[1].toLowerCase()}/status/${u.pathname.split('/')[3]}`;
      const sourceWasTruncated=truncatedSourceUrls.has(url);
      if(comparisonResult&&sourceWasTruncated)comparisonIncomplete=true;
      const prior=sources.find(s=>s.url===url&&(!pageBodyRetentionMethod||post||s.text===r.text));
      const priorComparison=!!prior&&comparisonSourceIds.includes(prior.id);
      const textLimit=comparisonResult?Math.min(120000,Math.max(0,512000-comparisonCharacters+(priorComparison?prior!.text.length:0))):post||entryEvidenceMethod?120000:12000;
      if(r.text.length>textLimit){codes.push('ATT_TEXT_CAP');truncatedSourceUrls.add(url);truncatedSourceUrls.add(requestedUrl);if(post)postSampleComplete=false;}
      if(comparisonResult&&(r.text.length>textLimit||sourceWasTruncated))comparisonIncomplete=true;
      const text=r.text.slice(0,textLimit);
      if(prior){
        sourceByRequested.set(requestedUrl,prior.id);
        if(comparisonResult){
          if(prior.text!==text&&!text.startsWith(prior.text)){codes.push('ATT_FETCH_SOURCE_CONFLICT');conflictedUrls.add(requestedUrl);comparisonIncomplete=true;}
          const retained=text.length>=prior.text.length?text:prior.text;
          comparisonCharacters+=retained.length-(priorComparison?prior.text.length:0);
          prior.text=retained;
          if(!priorComparison)comparisonSourceIds.push(prior.id);
        }
        continue;
      }
      if(sources.length>=(entryEvidenceMethod?64:32)){codes.push('ATT_SOURCE_CAP');if(post)postSampleComplete=false;if(comparisonResult)comparisonIncomplete=true;continue;}
      if(comparisonResult)comparisonCharacters+=text.length;
      const at=typeof r.published_date==='string'&&/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(r.published_date)&&Number.isFinite(Date.parse(r.published_date))&&Date.parse(r.published_date)<=Date.parse(end)?new Date(r.published_date).toISOString():null;
      sources.push({id:`attention-page-${sources.length+1}`,url,text,publishedAt:at,authorId:post?`${u.hostname.replace(/^www\./,'').replace('twitter.com','x.com')}:${u.pathname.split('/')[1].toLowerCase()}`:null,availableAt:now(),kind:post?'POST':'PAGE',...(discoveryParents.has(requestedUrl)?{discoveredFrom:discoveryParents.get(requestedUrl)}:{})});
      sourceByRequested.set(requestedUrl,sources.at(-1)!.id);
      if(comparisonUrls.has(requestedUrl))comparisonSourceIds.push(sources.at(-1)!.id);
      const metadataSeed=seeds.includes(requestedUrl)&&/\.json(?:[?]|$)/i.test(requestedUrl);
      const metadataLinks=metadataSeed?[...text.matchAll(/https:\/\/[^"\s\\<>]+/g)].map(m=>m[0]):[];
      if(!recoveryPlan&&seeds.includes(requestedUrl))for(const next of originSeedLinks(requestedUrl,[...(Array.isArray(r.links)?r.links:[]),...metadataLinks],entryEvidenceMethod?'project-context-v2':undefined)){
        if(urls.includes(next))continue;
        // Follow only seed-page links, ahead of remaining search pages, without exceeding the shared page budget.
        followed.add(next);discoveryParents.set(next,requestedUrl);urls.splice(offset+followed.size-1,0,next);
        if(urls.length>pageLimit){const omitted=urls.pop()!;codes.push('ATT_PAGE_CAP');if(isPostUrl(omitted))postSampleComplete=false;if(comparisonUrls.has(omitted))comparisonIncomplete=true;}
      }
    }
    if(requested.some(u=>!returned.has(u)))codes.push('ATT_FETCH_INCOMPLETE');
    if(requested.some(u=>isPostUrl(u)&&!returned.has(u)))postSampleComplete=false;
    if(requested.some(u=>comparisonUrls.has(u)&&!returned.has(u)))comparisonIncomplete=true;
    }catch(error){codes.push(entryEvidenceMethod?attentionFailure(error,'FETCH'):'ATT_FETCH_UNAVAILABLE');if(requested.some(isPostUrl))postSampleComplete=false;if(requested.some(url=>comparisonUrls.has(url)))comparisonIncomplete=true;}
  }
  if(entryEvidenceMethod&&recoveryPlan?.queryParents)rawArtifacts['attention-fallback-scope']=JSON.stringify({method:recoveryPlan.fallbackSelectionMethod?'same-parent-alternates-v2':'same-parent-alternates-v1',rounds:fallbackRounds});
  const comparisonComplete=(!!recoveryPlan||!!name&&name.length<=100)&&comparisonSearchSucceeded&&comparisonUrls.size>0&&!comparisonIncomplete&&comparisonFetched.size===comparisonUrls.size&&comparisonSourceIds.length>0;
  for(const lead of leads){
    const sourceId=lead.url?sourceByRequested.get(lead.url):undefined;
    lead.sourceIds=sourceId?[sourceId]:[];
    if(!lead.url)continue;
    lead.acquisitionStatus=blockedUrls.has(lead.url)?'BLOCKED':conflictedUrls.has(lead.url)?'CONFLICTED':!urls.includes(lead.url)?'OMITTED':sourceId?'ACQUIRED':'FAILED';
    lead.acquisitionCodes=[...(truncatedSourceUrls.has(lead.url)?['ATT_TEXT_CAP']:[]),...(lead.acquisitionStatus==='ACQUIRED'?[]:[`ATT_LEAD_${lead.acquisitionStatus}`])];
  }
  if(acquisitionEvidenceMethod)rawArtifacts['attention-acquisition-ledger']=JSON.stringify({method:acquisitionEvidenceMethod,token,start:acquisitionStart!,end:now(),searches:acquisitionSearches});
  const collected:AttentionRead={...(pageBodyRetentionMethod?{pageBodyRetentionMethod}:{}),...(acquisitionEvidenceMethod?{acquisitionEvidenceMethod,acquisitionProjectName:name??null}:{}),...(entryEvidenceMethod&&!recoveryPlan?{collectionMethod:'project-context-v2' as const,leadershipPositiveMethod:'source-bound-positive-v1' as const}:{}),sources,rawArtifacts,queries,...(entryEvidenceMethod?{entryEvidenceMethod}:{}),...(recoveryPlan?.recordQueryTimes?{queryRetrievedAt}:{}),complete:codes.length===0,codes:[...new Set(codes)],start,end,comparisonSourceIds,comparisonComplete,postSampleComplete,discoveryUrls:seeds,...((name||recoveryPlan||entryEvidenceMethod)?{comparisonAcquisition:{originalComplete:comparisonComplete,searchSucceeded:comparisonSearchSucceeded,descriptorComplete,leadCount,leads},comparisonRankingSourceIds:[...comparisonSourceIds],postSampleSourceIds:sources.filter(s=>s.kind==='POST').map(s=>s.id)}:{})};
  if(entryEvidenceMethod&&!recoveryPlan)collected.postSampleScope=terminalPostScope(collected);
  return collected;
}


/** Free-only alternate discovery; reuses the same guarded collection boundary. */
export async function recoverComparisonSources(token:TokenRef,key:string,queries:string[],skipUrls:string[],maxUrls:number,fetcher:typeof fetch,now:()=>string,queryParents?:RecoveryQueryParent[],recordQueryTimes=false,entryEvidenceMethod?:'public-support-v2',fallbackSelectionMethod?:FallbackSelectionMethod,pageBodyRetentionMethod?:'requested-page-bodies-v1',acquisitionEvidenceMethod?:typeof boundedAcquisitionMethod,priorAcquisitionLedger?:AcquisitionLedger){
  const read=await collectAttentionSources(token,key,fetcher,now,undefined,[],{queries,skipUrls,maxUrls,queryParents,recordQueryTimes,...(fallbackSelectionMethod?{fallbackSelectionMethod}:{})},entryEvidenceMethod,pageBodyRetentionMethod,acquisitionEvidenceMethod);
  if(acquisitionEvidenceMethod){
    const current=acquisitionLedgerSchema.parse(JSON.parse(read.rawArtifacts['attention-acquisition-ledger']!));
    const prior=priorAcquisitionLedger?acquisitionLedgerSchema.parse(priorAcquisitionLedger):undefined;
    const searches=[...(prior?.searches??[]),...current.searches];
    read.rawArtifacts['attention-acquisition-ledger']=JSON.stringify({method:acquisitionEvidenceMethod,token,start:prior?.start??current.start,end:current.end,searches});
  }
  return read;
}
