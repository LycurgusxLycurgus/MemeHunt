import { originRecoveryQuery, originRecoveryCandidates, geckoPoolBinding, verifyOriginAlias, verifiedOriginExclusion, type OriginExclusion, type OriginRecovery } from './origin-recovery.js';
import { fetchReadResponse, readLimitedText } from './http.js';
import { publicHttpsUrl } from './tinyfish.js';
import type { TokenRef } from '../domain/contracts.js';

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
export type OriginAcquisition={method:'original-origin-acquisition-v1';complete:boolean;sourceIds:string[];searches:Array<{id:string;complete:boolean}>;urls:Array<{url:string;sourceId:string|null;state:'ACQUIRED'|'UNAVAILABLE'|'OMITTED'|'CLIPPED'|'CONFLICTED'|'EXCLUDED_REVIEWED'}>};
export type FallbackSelectionMethod='observed-hosts-v1';
type RecoveryPlan={fallbackSelectionMethod?:FallbackSelectionMethod;queries:string[];skipUrls:string[];maxUrls:number;queryParents?:RecoveryQueryParent[];recordQueryTimes?:boolean};
export type ComparisonRecovery={method:'comparison-acquisition-v1';fallbackSelectionMethod?:FallbackSelectionMethod;accessGapMethod?:'own-acquired-alternates-v1';selectedLeadIds:string[];recoveryQueries:Array<{queryId:string;parentLeadId:string;query:string;state:string;descriptorComplete:boolean;resultCount:number;availableAt:string}>;recoveryCapped:boolean;sourceLineage:Array<{leadId:string;queryIds:string[];sourceIds:string[]}>};
export type TerminalPostScope={method:'terminal-post-gap-v1';complete:boolean;sourceIds:string[];gaps:Array<{url:string;code:'HTTP_404'|'HTTP_410'}>;blockers:string[]};
export type AttentionRead = {metadataLinkMethod?:'onchain-metadata-v1';collectionMethod?:'project-context-v2';leadershipPositiveMethod?:'source-bound-positive-v1';postSampleScope?:TerminalPostScope;entryExecutionMethod?:'entry-first-v1'|'entry-first-v2';comparisonRecovery?:ComparisonRecovery;entryEvidenceMethod?:'public-support-v2';sources:AttentionSource[];rawArtifacts:Record<string,string>;queries:string[];complete:boolean;codes:string[];start:string;end:string;comparisonSourceIds?:string[];comparisonComplete?:boolean;postSampleComplete?:boolean;discoveryUrls?:string[];comparisonAcquisition?:ComparisonAcquisition;comparisonRankingSourceIds?:string[];postSampleSourceIds?:string[];comparisonQualification?:unknown;comparisonCoverage?:import('../domain/attention.js').ComparisonCoverage;comparisonPublicSupport?:import('../domain/attention.js').ComparisonPublicSupport;narrativePublicSupport?:import('../domain/attention.js').NarrativePublicSupport;queryRetrievedAt?:Record<string,string>;metadataLinks?:true;metadataUri?:string;originRecovery?:OriginRecovery;originExclusions?:OriginExclusion[];originScope?:{method:'bounded-origin-sources-v1';complete:boolean;sourceIds:string[];acquisition?:OriginAcquisition};growthSample?:{method:'fixed-query-sample-v1';sourceIds:string[];queries:string[];complete:boolean}};
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
 const origin=reconstructOriginAcquisition(read,token),blockers:string[]=[],gaps:Array<{url:string;code:string;cause?:string;originalAttemptIds?:string[];parentLeadId?:string;originalRoleId?:string;queryIds?:string[];alternativeSourceIds?:string[]}>=[],failures=new Map<string,string>(),records:Array<{url:string;text:string;artifactId:string;requestedUrl:string}>=[],recoveryBatchOutcomes=new Map<string,Set<string>>(),recoveryBatchFailures=new Map<string,Map<string,string>>();
 const ownAlternates=read.comparisonRecovery?.accessGapMethod==='own-acquired-alternates-v1';
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
  for(const e of errors)if(typeof e?.url==='string'){const text=[e.error,e.code,e.status].filter(v=>v!==undefined).join(' ');fail(id,e.url,terminal(e)?'TARGET_BLOCKED':e.error==='empty_content'||e.code==='empty_content'?'TARGET_EMPTY':/timeout|408/i.test(text)?'ATT_FETCH_TIMEOUT':/429|rate.limit/i.test(text)?'ATT_FETCH_HTTP_429':/5\d\d|transport|network/i.test(text)?'ATT_FETCH_TRANSPORT':'ATT_ENTRY_FETCH_UNRESOLVED');}else blockers.push('ATT_ENTRY_FETCH_SHAPE');
 }catch{blockers.push('ATT_ENTRY_FETCH_SHAPE');}
 const replaced=new Set<string>();
 if(!origin.searches.every(s=>s.complete))blockers.push('ATT_ENTRY_REQUIRED_SEARCH_INCOMPLETE');
 const q=(read.entryExecutionMethod?read.comparisonRecovery:read.comparisonQualification) as {fallbackSelectionMethod?:FallbackSelectionMethod;recoveryCapped?:boolean;recoveryQueries?:Array<{queryId:string;parentLeadId:string;state:string;descriptorComplete?:boolean}>}|undefined;
 // Reconstruct the actual bounded selection, then require an effective outcome
 // for every selected URL. Search success alone does not finish acquisition.
 if(q?.recoveryQueries?.length){
  try{
   const queries=q.recoveryQueries;if(queries.some(query=>!['OBSERVED','NO_RESULTS'].includes(query.state)||query.descriptorComplete===false||searchRows(query.queryId)===null))blockers.push('ATT_ENTRY_RECOVERY_SEARCH_INCOMPLETE');
   const initial=read.sources.filter(source=>!source.id.startsWith('attention-recovery-'));
   const parents=queries.map(query=>({leadId:query.parentLeadId,originalUrl:read.comparisonAcquisition?.leads.find(lead=>lead.id===query.parentLeadId)?.url??null}));
   const leads=queries.flatMap((query,index)=>(searchRows(query.queryId)??[]).map((row,resultIndex)=>({searchArtifactId:'attention-search-'+(index+1),resultIndex,url:normalizeAttentionSearchUrl(String(row.url))})));
   const selected=comparisonRecoverySelection(leads,parents,[...initial.map(source=>source.url),...(read.comparisonAcquisition?.leads.flatMap(lead=>lead.url?[lead.url]:[])??[])],Math.min(8,attentionSourceLimit(read)-initial.length));
   const expected={...selected,selection:selected.selection.map(row=>({...row,collectorQueryId:row.queryId,queryId:row.queryId.replace('attention-','attention-recovery-')}))};
   const raw=read.rawArtifacts['attention-recovery-selection-scope'];
   if(raw){const actual=JSON.parse(raw);if(actual.method!==expected.method||actual.maxUrls!==expected.maxUrls||JSON.stringify(actual.selectedUrls)!==JSON.stringify(expected.selectedUrls)||(!Array.isArray(actual.selection)||actual.selection.length!==expected.selection.length||expected.selection.some((row,index)=>Object.entries(row).some(([key,value])=>actual.selection[index]?.[key]!==value))))blockers.push('ATT_ENTRY_RECOVERY_SELECTION_INVALID');}
   else if(leads.length)blockers.push('ATT_ENTRY_RECOVERY_SELECTION_MISSING');
   const fallbackRaw=read.rawArtifacts['attention-recovery-fallback-scope'];
   const attempted=[...initial.map(source=>source.url),...(read.comparisonAcquisition?.leads.flatMap(lead=>lead.url?[lead.url]:[])??[]),...selected.selectedUrls];
   let frontier=selected.selectedUrls.map(url=>({url,parentId:selected.selection.find(row=>row.url===url)!.parentId}));
   const allSelected=[...selected.selectedUrls],links:Array<{failedUrl:string;parentId:string;url:string}>=[];
   const marked=q.fallbackSelectionMethod==='observed-hosts-v1';
   if(q.fallbackSelectionMethod!==undefined&&!marked)blockers.push('ATT_ENTRY_RECOVERY_SELECTION_INVALID');
   const policy=()=>marked?{method:'observed-hosts-v1' as const,priorSelections:links}:undefined;
   const validatedOutcomes=new Set<string>(),validatedFailures=new Map<string,string>(),expectedBatches=new Set<string>();
   const validateBatch=(batch:number,urls:string[])=>{
    const allowed=new Set(urls.map(canonical)),id=`attention-recovery-fetch-${batch}`;expectedBatches.add(id);let valid=true;
    for(const suffix of ['', '-retry-1']){
     if(suffix&&!read.rawArtifacts[id+suffix])continue;
     if(ownAlternates&&!httpOk(id+suffix)){blockers.push(httpFailure(id+suffix,'ATT_ENTRY_RECOVERY_HTTP_INCOMPLETE'));valid=false;}
     const packet=JSON.parse(read.rawArtifacts[id+suffix]??'null');
     if(!packet||!Array.isArray(packet.results)||!Array.isArray(packet.errors)){blockers.push('ATT_ENTRY_RECOVERY_FETCH_INCOMPLETE');valid=false;continue;}
     if([...packet.results,...packet.errors].some(row=>typeof row?.url!=='string'||!allowed.has(canonical(row.url)))){blockers.push('ATT_ENTRY_RECOVERY_SELECTION_INVALID');valid=false;}
    }
    if(valid)for(const url of allowed){if(recoveryBatchOutcomes.get(id)?.has(url))validatedOutcomes.add(url);const failure=recoveryBatchFailures.get(id)?.get(url);if(failure)validatedFailures.set(url,failure);}
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
     for(const item of selections){attempted.push(item.url);allSelected.push(item.url);links.push(item);if(validatedOutcomes.has(canonical(item.url)))acquired.add(item.url);}
     frontier=selections.map(item=>({parentId:item.parentId,url:item.url}));
    }
    if(JSON.stringify(fallback.rounds)!==JSON.stringify(expectedRounds))blockers.push('ATT_ENTRY_RECOVERY_SELECTION_INVALID');
    for(const link of [...links].reverse())if(acquired.has(link.url)||replaced.has(canonical(link.url)))replaced.add(canonical(link.failedUrl));
   }
   for(const id of Object.keys(read.rawArtifacts))if(id.startsWith('attention-recovery-fetch-')){const match=id.match(/^(attention-recovery-fetch-[1-9]\d*)(?:-retry-1)?$/);if(!match||!expectedBatches.has(match[1]))blockers.push('ATT_ENTRY_RECOVERY_SELECTION_INVALID');}
   for(const url of allSelected){const key=canonical(url);if(replaced.has(key))gaps.push({url,code:'RECOVERED_ALTERNATE'});else if(validatedFailures.get(key)==='TARGET_BLOCKED')gaps.push({url,code:'TARGET_BLOCKED'});else if(!validatedOutcomes.has(key))blockers.push('ATT_ENTRY_RECOVERY_FETCH_INCOMPLETE');}
  }catch{blockers.push('ATT_ENTRY_RECOVERY_SELECTION_INVALID');}
 }
 const recoveredLead=(lead:ComparisonLead)=>{const queries=q?.recoveryQueries?.filter(r=>r.parentLeadId===lead.id)??[];return queries.length>0&&queries.every(r=>['OBSERVED','NO_RESULTS'].includes(r.state)&&r.descriptorComplete!==false&&searchRows(r.queryId)!==null);};
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
  if(!ownAlternates||failures.get(canonical(url))!=='ATT_FETCH_TIMEOUT')return null;
  // Only an original target's explicit per-URL timeout in two successful API
  // responses is eligible. A request failure or omitted selected body is not.
  const attempts=Object.keys(read.rawArtifacts).filter(id=>/^attention-fetch-\d+$/.test(id)).flatMap(id=>{
   try{const same=(key:string)=>{const p=JSON.parse(read.rawArtifacts[key]);return httpOk(key)&&!p.error&&Array.isArray(p.results)&&Array.isArray(p.errors)&&p.errors.some((e:{url:string;error:string;status?:unknown;code?:unknown})=>e.url===url&&e.error==='timeout'&&e.status===undefined&&(e.code===undefined||e.code==='timeout'))&&!p.results.some((r:{url:string;text:string})=>r.url===url&&typeof r.text==='string'&&r.text.trim());};return same(id)&&same(id+'-retry-1')?[id,id+'-retry-1']:[];}catch{return [];}
  });
  if(attempts.length!==2)return null;
  const parent=read.comparisonAcquisition?.leads.find(lead=>lead.url&&canonical(lead.url)===canonical(url));
  let queryIds:string[]=[],roleId:string|undefined;
  if(parent&&recoveredLead(parent))queryIds=(q?.recoveryQueries??[]).filter(r=>r.parentLeadId===parent.id&&r.state==='OBSERVED').map(r=>r.queryId);
  else {const index=originalCandidates.findIndex(lead=>lead.url===url);if(index<0||!recoveredOriginal(url))return null;roleId=`attention-origin-role-${index+1}`;queryIds=[roleId+'-search'];}
  if(!queryIds.length||queryIds.some(id=>!httpOk(id)))return null;
  const alternatives=read.sources.filter(source=>canonical(source.url)!==canonical(url)&&(!roleId||new URL(source.url).hostname!==new URL(url).hostname)&&queryIds.some(id=>(searchRows(id)??[]).some(row=>{const u=normalizeAttentionSearchUrl(String(row.url));return u&&canonical(u)===canonical(source.url);}))&&records.some(r=>(!roleId||r.artifactId===roleId+'-fetch')&&r.url===canonical(source.url)&&r.text===source.text&&r.url===canonical(r.requestedUrl)&&httpOk(r.artifactId)&&source.text.trim().length>=8&&!/^\s*(?:safety check|access denied|forbidden)\s*$/i.test(source.text)));
  if(!alternatives.length)return null;
  return {url,code:'TARGET_ACCESS_GAP',cause:'ATT_FETCH_TIMEOUT',originalAttemptIds:attempts,...(parent?{parentLeadId:parent.id}:{originalRoleId:roleId!}),queryIds,alternativeSourceIds:alternatives.map(s=>s.id)};
 };
 const timeoutGaps=new Map<string,NonNullable<ReturnType<typeof acquiredGap>>>();
 for(const url of new Set([...origin.urls.map(u=>u.url),...(read.comparisonAcquisition?.leads.flatMap(l=>l.url?[l.url]:[])??[])])){const gap=acquiredGap(url);if(gap){timeoutGaps.set(canonical(url),gap);gaps.push(gap);}}
 for(const [url,code] of failures)if(code!=='TARGET_BLOCKED'&&!replaced.has(url)&&!timeoutGaps.has(url)&&!(code==='TARGET_EMPTY'&&recoveredOriginal(url)))blockers.push(code);
 for(const u of origin.urls)if(u.state!=='ACQUIRED'&&u.state!=='EXCLUDED_REVIEWED'){const code=failures.get(canonical(u.url));if(timeoutGaps.has(canonical(u.url))&&u.state==='UNAVAILABLE')continue;if((code==='TARGET_BLOCKED'||code==='TARGET_EMPTY')&&u.state==='UNAVAILABLE'&&recoveredOriginal(u.url))gaps.push({url:u.url,code});else blockers.push(code==='TARGET_BLOCKED'||code==='TARGET_EMPTY'?'ATT_ENTRY_ORIGIN_RECOVERY_INCOMPLETE':'ATT_ENTRY_ORIGIN_'+u.state);}
 if(!read.comparisonAcquisition?.searchSucceeded||!read.comparisonAcquisition.descriptorComplete)blockers.push('ATT_ENTRY_COMPARISON_SEARCH_INCOMPLETE');
 if(q?.recoveryCapped)blockers.push('ATT_ENTRY_RECOVERY_CAP');
 for(const lead of read.comparisonAcquisition?.leads??[])if(lead.acquisitionStatus!=='ACQUIRED'||lead.acquisitionCodes.length){const code=lead.url&&failures.get(canonical(lead.url));if(lead.url&&timeoutGaps.has(canonical(lead.url)))continue;if((code==='TARGET_BLOCKED'||code==='TARGET_EMPTY')&&recoveredLead(lead))gaps.push({url:lead.url!,code});else blockers.push('ATT_ENTRY_COMPARISON_RECOVERY_INCOMPLETE');}
 for(const source of read.sources){if(source.text.length>120000)blockers.push('ATT_ENTRY_TEXT_CAP');if(!records.some(r=>r.url===canonical(source.url)&&r.text===source.text))blockers.push('ATT_ENTRY_SOURCE_TEXT_INCOMPLETE');const age=Date.parse(cutoff)-Date.parse(source.availableAt);if(!Number.isFinite(age)||age<0||age>900000)blockers.push('ATT_ENTRY_SOURCE_STALE');}
 for(const code of read.codes)if(/^(?:ATT_(?:SEARCH|FETCH|RECOVERY)|WEB_).*(?:TIMEOUT|TRANSPORT|HTTP_(?:408|429|5\d\d))|COLLECTION_BUDGET|RUN_ABORTED/.test(code))blockers.push(code);
 if(!read.sources.length||read.sources.length>attentionSourceLimit(read))blockers.push('ATT_ENTRY_SOURCE_CAP');
 const operational=blockers.find(c=>/TIMEOUT|TRANSPORT|DNS_ERROR|HTTP_(?:408|429|5\d\d)|COLLECTION_BUDGET|RUN_ABORTED/.test(c));
 return {method:ownAlternates?'attempted-public-source-scope-v2' as const:'attempted-public-source-scope-v1' as const,...(q?.fallbackSelectionMethod?{fallbackSelectionMethod:q.fallbackSelectionMethod}:{}),complete:blockers.length===0,sourceIds:read.sources.map(s=>s.id),originSourceIds:origin.sourceIds,gaps:[...new Map(gaps.map(g=>[g.url,g])).values()],blockers:[...new Set(operational?[operational,...blockers]:blockers)]};
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
export async function collectAttentionSources(token:TokenRef,key:string,fetcher:typeof fetch=fetch,now:()=>string=()=>new Date().toISOString(),name?:string,discoveryUrls:string[]=[],recoveryPlan?:RecoveryPlan,entryEvidenceMethod?:'public-support-v2'):Promise<AttentionRead>{
  const queryRetrievedAt:Record<string,string>={};
  const leads:ComparisonLead[]=[],sourceByRequested=new Map<string,string>(),blockedUrls=new Set<string>(),conflictedUrls=new Set<string>();
  let descriptorComplete=true,descriptorCharacters=0,leadCount=0;
  const pageLimit=recoveryPlan?Math.min(8,Math.max(0,recoveryPlan.maxUrls)):(entryEvidenceMethod?40:32);
  const end=now(),start=new Date(Date.parse(end)-24*3600_000).toISOString();
  const rawArtifacts:Record<string,string>={},codes:string[]=[],urls:string[]=[],sources:AttentionSource[]=[],comparisonUrls=new Set<string>(),comparisonSourceIds:string[]=[],comparisonFetched=new Set<string>(),truncatedSourceUrls=new Set<string>();
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
    const response=await fetchReadResponse(url.toString(),{headers:{'X-API-Key':key,accept:'application/json'}},fetcher,10000);
    httpOutcome('attention-search-'+(i+1),response.status);
    if(!response.ok){codes.push(`ATT_SEARCH_HTTP_${response.status}`);postSampleComplete=false;if(recoveryPlan||i===2)comparisonIncomplete=true;continue;}
    let raw=await readLimitedText(response,100000);rawArtifacts[`attention-search-${i+1}`]=raw;if(recoveryPlan?.recordQueryTimes)queryRetrievedAt[`attention-search-${i+1}`]=now();let value:unknown=JSON.parse(raw);
    if(!recoveryPlan&&i===2&&query!==`"${name!.replace(/["\\]/g,'')}" ${token.chain}`&&object(value)&&!value.error&&Array.isArray(value.results)&&value.results.length===0&&(value.errors===undefined||Array.isArray(value.errors)&&value.errors.length===0)){
      rawArtifacts['attention-search-3-primary-query']=query;
      rawArtifacts['attention-search-3-empty-response']=raw;
      const fallback=`"${name!.replace(/["\\]/g,'')}" ${token.chain}`;
      const fallbackUrl=new URL(url);fallbackUrl.searchParams.set('query',fallback);
      const fallbackResponse=await fetchReadResponse(fallbackUrl.toString(),{headers:{'X-API-Key':key,accept:'application/json'}},fetcher,10000);
      if(!fallbackResponse.ok){codes.push(`ATT_SEARCH_HTTP_${fallbackResponse.status}`);comparisonIncomplete=true;continue;}
      httpOutcome('attention-search-'+(i+1),fallbackResponse.status);
      raw=await readLimitedText(fallbackResponse,100000);value=JSON.parse(raw);rawArtifacts['attention-search-3']=raw;queries[i]=fallback;
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
      const prior=sources.find(s=>s.url===url);
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
  const collected:AttentionRead={...(entryEvidenceMethod&&!recoveryPlan?{collectionMethod:'project-context-v2' as const,leadershipPositiveMethod:'source-bound-positive-v1' as const}:{}),sources,rawArtifacts,queries,...(entryEvidenceMethod?{entryEvidenceMethod}:{}),...(recoveryPlan?.recordQueryTimes?{queryRetrievedAt}:{}),complete:codes.length===0,codes:[...new Set(codes)],start,end,comparisonSourceIds,comparisonComplete,postSampleComplete,discoveryUrls:seeds,...((name||recoveryPlan)?{comparisonAcquisition:{originalComplete:comparisonComplete,searchSucceeded:comparisonSearchSucceeded,descriptorComplete,leadCount,leads},comparisonRankingSourceIds:[...comparisonSourceIds],postSampleSourceIds:sources.filter(s=>s.kind==='POST').map(s=>s.id)}:{})};
  if(entryEvidenceMethod&&!recoveryPlan)collected.postSampleScope=terminalPostScope(collected);
  return collected;
}


/** Free-only alternate discovery; reuses the same guarded collection boundary. */
export async function recoverComparisonSources(token:TokenRef,key:string,queries:string[],skipUrls:string[],maxUrls:number,fetcher:typeof fetch,now:()=>string,queryParents?:RecoveryQueryParent[],recordQueryTimes=false,entryEvidenceMethod?:'public-support-v2',fallbackSelectionMethod?:FallbackSelectionMethod){
  return collectAttentionSources(token,key,fetcher,now,undefined,[],{queries,skipUrls,maxUrls,queryParents,recordQueryTimes,...(fallbackSelectionMethod?{fallbackSelectionMethod}:{})},entryEvidenceMethod);
}
