import { fetchReadResponse, readLimitedText } from './http.js';
import { publicHttpsUrl } from './tinyfish.js';
import type { TokenRef } from '../domain/contracts.js';

export type AttentionSource = {id:string;url:string;text:string;publishedAt:string|null;authorId:string|null;availableAt:string;kind:'POST'|'PAGE';discoveredFrom?:string};
export type ComparisonLead={id:string;searchArtifactId:string;resultIndex:number;url:string|null;title:string;snippet:string;metadataEvidenceId:string;sourceIds:string[];acquisitionStatus:'ACQUIRED'|'FAILED'|'BLOCKED'|'OMITTED'|'CONFLICTED'|'UNSAFE';acquisitionCodes:string[];recoveryQueryIds:string[];recoverySourceIds:string[]};
export type ComparisonAcquisition={originalComplete:boolean;searchSucceeded:boolean;descriptorComplete:boolean;leadCount:number;leads:ComparisonLead[]};
export type RecoveryQueryParent={leadId:string;originalUrl:string|null};
type RecoveryPlan={queries:string[];skipUrls:string[];maxUrls:number;queryParents?:RecoveryQueryParent[];recordQueryTimes?:boolean};
export type AttentionRead = {sources:AttentionSource[];rawArtifacts:Record<string,string>;queries:string[];complete:boolean;codes:string[];start:string;end:string;comparisonSourceIds?:string[];comparisonComplete?:boolean;postSampleComplete?:boolean;discoveryUrls?:string[];comparisonAcquisition?:ComparisonAcquisition;comparisonRankingSourceIds?:string[];postSampleSourceIds?:string[];comparisonQualification?:unknown;queryRetrievedAt?:Record<string,string>;growthSample?:{method:'fixed-query-sample-v1';sourceIds:string[];queries:string[];complete:boolean}};
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
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
export async function collectAttentionSources(token:TokenRef,key:string,fetcher:typeof fetch=fetch,now:()=>string=()=>new Date().toISOString(),name?:string,discoveryUrls:string[]=[],recoveryPlan?:RecoveryPlan):Promise<AttentionRead>{
  const queryRetrievedAt:Record<string,string>={};
  const leads:ComparisonLead[]=[],sourceByRequested=new Map<string,string>(),blockedUrls=new Set<string>(),conflictedUrls=new Set<string>();
  let descriptorComplete=true,descriptorCharacters=0,leadCount=0;
  const pageLimit=recoveryPlan?Math.min(8,Math.max(0,recoveryPlan.maxUrls)):32;
  const end=now(),start=new Date(Date.parse(end)-24*3600_000).toISOString();
  const rawArtifacts:Record<string,string>={},codes:string[]=[],urls:string[]=[],sources:AttentionSource[]=[],comparisonUrls=new Set<string>(),comparisonSourceIds:string[]=[],comparisonFetched=new Set<string>(),truncatedSourceUrls=new Set<string>();
  const isPostUrl=(url:string)=>{const u=new URL(url);return /^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname)&&/^\/[A-Za-z0-9_]+\/status\/\d+(?:\/.*)?$/.test(u.pathname);};
  const canonicalUrl=(url:string)=>{if(!isPostUrl(url))return url;const u=new URL(url);return `https://x.com/${u.pathname.split('/')[1].toLowerCase()}/status/${u.pathname.split('/')[3]}`;};
  const seeds=[...new Set(discoveryUrls.map(url=>publicHttpsUrl(url,true)).filter((u):u is string=>!!u).map(canonicalUrl))].slice(0,4);
  urls.push(...seeds);
  const discoveryParents=new Map<string,string>(),followed=new Set<string>();
  const seedScopes=seeds.map(url=>{const u=new URL(url);return `site:${u.hostname}${/^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname)?u.pathname:''}`;});
  const queries=recoveryPlan?[...recoveryPlan.queries]:[`"${token.address}" ${token.chain} ${seedScopes.length?`(${seedScopes.join(' OR ')})`:'narrative origin catalyst'}`,`"${token.address}" (site:x.com OR site:twitter.com)`];
  const comparisonIntent='Find public sources identifying distinct token contract addresses representing this named crypto project or narrative. Prioritize contract-bearing project pages and substantive original posts. Exclude non-crypto dictionary matches. Same name alone does not establish association; do not rank by price.';
  if(!recoveryPlan&&name&&name.length<=100)queries.push(`"${name.replace(/["\\]/g,'')}" ${token.chain} token contract meme narrative`);
  let postSampleComplete=true,comparisonSearchSucceeded=false,comparisonIncomplete=false;
  for(const [i,query] of queries.entries())try{
    const url=new URL('https://api.search.tinyfish.ai/');url.searchParams.set('query',query);
    if(recoveryPlan||i===2){const intent=recoveryPlan?'Identify and corroborate the indexed entity and distinctive subject or mechanism named in this query using descriptive independent public sources. Include descriptive context and alternate contract-bearing pages when applicable; a shared name alone is insufficient.':comparisonIntent;url.searchParams.set('intent',intent);rawArtifacts[`attention-search-${i+1}-intent`]=intent;}
    const response=await fetchReadResponse(url.toString(),{headers:{'X-API-Key':key,accept:'application/json'}},fetcher,10000);
    if(!response.ok){codes.push(`ATT_SEARCH_HTTP_${response.status}`);postSampleComplete=false;if(recoveryPlan||i===2)comparisonIncomplete=true;continue;}
    const raw=await readLimitedText(response,100000);rawArtifacts[`attention-search-${i+1}`]=raw;if(recoveryPlan?.recordQueryTimes)queryRetrievedAt[`attention-search-${i+1}`]=now();const value:unknown=JSON.parse(raw);
    if(!object(value)||!Array.isArray(value.results)){codes.push('ATT_SEARCH_SHAPE');postSampleComplete=false;if(recoveryPlan||i===2)comparisonIncomplete=true;continue;}
    if(recoveryPlan||i===2)comparisonSearchSucceeded=true;
    for(const [resultIndex,r] of value.results.entries()){
      if(!object(r)||typeof r.url!=='string'){if(recoveryPlan||i===2){descriptorComplete=false;comparisonIncomplete=true;leadCount++;}continue;}
      const safe=normalizeAttentionSearchUrl(r.url);
      if(recoveryPlan||i===2){
        leadCount++;
        const title=typeof r.title==='string'?r.title:'',snippet=typeof r.snippet==='string'?r.snippet:'';
        const descriptor=title+'\n'+snippet;
        if(leads.length>=(recoveryPlan?128:32)||descriptorCharacters+descriptor.length>64000){descriptorComplete=false;comparisonIncomplete=true;codes.push('ATT_DESCRIPTOR_CAP');}
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
  }catch{codes.push('ATT_SEARCH_UNAVAILABLE');postSampleComplete=false;if(recoveryPlan||i===2)comparisonIncomplete=true;}
  if(recoveryPlan?.queryParents){
    if(recoveryPlan.queryParents.length!==queries.length)throw new Error('ATT_RECOVERY_PARENT_INVALID');
    const parents=[...new Map(recoveryPlan.queryParents.map(p=>[p.leadId,p])).values()];
    const queues=parents.map(parent=>{
      const entries=leads.filter(l=>recoveryPlan.queryParents![Number(l.searchArtifactId.match(/-(\d+)$/)?.[1])-1]?.leadId===parent.leadId&&l.url&&!recoveryPlan.skipUrls.includes(l.url));
      entries.sort((a,b)=>a.resultIndex-b.resultIndex||Number(a.searchArtifactId.match(/-(\d+)$/)?.[1])-Number(b.searchArtifactId.match(/-(\d+)$/)?.[1]));
      const host=parent.originalUrl?new URL(parent.originalUrl).hostname.replace(/^www\./,''):null;
      const independent=entries.filter(l=>new URL(l.url!).hostname.replace(/^www\./,'')!==host),same=entries.filter(l=>new URL(l.url!).hostname.replace(/^www\./,'')===host);
      return [...new Set([...independent,...same].map(l=>l.url!))];
    });
    let progress=true;
    while(urls.length<pageLimit&&progress){
      progress=false;
      for(const queue of queues){
        while(queue.length&&urls.includes(queue[0]!))queue.shift();
        const next=queue.shift();
        if(next){urls.push(next);progress=true;}
        if(urls.length>=pageLimit)break;
      }
    }
    const selection=leads.map(l=>({parentId:recoveryPlan.queryParents![Number(l.searchArtifactId.match(/-(\d+)$/)?.[1])-1]!.leadId,queryId:l.searchArtifactId,resultIndex:l.resultIndex,url:l.url,selected:!!l.url&&urls.includes(l.url),reused:!!l.url&&recoveryPlan.skipUrls.includes(l.url)}));
    if(selection.some(l=>l.url&&!l.selected&&!l.reused)){codes.push('ATT_PAGE_CAP');comparisonIncomplete=true;}
    rawArtifacts['attention-selection-scope']=JSON.stringify({method:'fair-parent-query-v1',maxUrls:pageLimit,selectedUrls:urls,selection});
  }
  let offset=0,batch=0,comparisonCharacters=0;
  while(offset<urls.length){
    const requested=urls.slice(offset,offset+10);
    offset+=requested.length;batch++;
    try{
    const response=await fetchReadResponse('https://api.fetch.tinyfish.ai/',{method:'POST',headers:{'X-API-Key':key,'content-type':'application/json'},body:JSON.stringify({urls:requested,format:'markdown',links:true,ttl:0,per_url_timeout_ms:8000})},fetcher,30000);
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
      const requestedUrl=publicHttpsUrl(r.url,true);let url=typeof r.final_url==='string'?publicHttpsUrl(r.final_url,true):requestedUrl;
      const comparisonResult=!!requestedUrl&&comparisonUrls.has(requestedUrl);
      if(!requestedUrl||!url||!requested.includes(requestedUrl)||returned.has(requestedUrl)){codes.push('ATT_FETCH_BINDING');if(comparisonResult)comparisonIncomplete=true;continue;}
      if(!r.text.trim()||r.text.trim().toLowerCase()==='safety check'){
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
      const textLimit=comparisonResult?Math.min(120000,Math.max(0,512000-comparisonCharacters+(priorComparison?prior!.text.length:0))):12000;
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
      if(!recoveryPlan&&seeds.includes(requestedUrl)&&Array.isArray(r.links))for(const link of r.links){
        if(typeof link!=='string'||followed.size>=4)continue;
        const safe=publicHttpsUrl(link,true);if(!safe)continue;
        const next=canonicalUrl(safe),v=new URL(next);
        const social=/^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname);
        const eligible=social?/^\/[A-Za-z0-9_]+\/?$/.test(u.pathname)&&isPostUrl(next)&&v.pathname.split('/')[1].toLowerCase()===u.pathname.split('/')[1]?.toLowerCase():v.hostname===u.hostname&&/^\/(?:docs?|about|whitepaper|launch|log)(?:[/.\-]|$)/i.test(v.pathname);
        if(!eligible||urls.includes(next))continue;
        // Follow only seed-page links, ahead of remaining search pages, without exceeding the shared page budget.
        followed.add(next);discoveryParents.set(next,requestedUrl);urls.splice(offset+followed.size-1,0,next);
        if(urls.length>32){const omitted=urls.pop()!;codes.push('ATT_PAGE_CAP');if(isPostUrl(omitted))postSampleComplete=false;if(comparisonUrls.has(omitted))comparisonIncomplete=true;}
      }
    }
    if(requested.some(u=>!returned.has(u)))codes.push('ATT_FETCH_INCOMPLETE');
    if(requested.some(u=>isPostUrl(u)&&!returned.has(u)))postSampleComplete=false;
    if(requested.some(u=>comparisonUrls.has(u)&&!returned.has(u)))comparisonIncomplete=true;
    }catch{codes.push('ATT_FETCH_UNAVAILABLE');if(requested.some(isPostUrl))postSampleComplete=false;if(requested.some(url=>comparisonUrls.has(url)))comparisonIncomplete=true;}
  }
  const comparisonComplete=(!!recoveryPlan||!!name&&name.length<=100)&&comparisonSearchSucceeded&&comparisonUrls.size>0&&!comparisonIncomplete&&comparisonFetched.size===comparisonUrls.size&&comparisonSourceIds.length>0;
  for(const lead of leads){
    const sourceId=lead.url?sourceByRequested.get(lead.url):undefined;
    lead.sourceIds=sourceId?[sourceId]:[];
    if(!lead.url)continue;
    lead.acquisitionStatus=blockedUrls.has(lead.url)?'BLOCKED':conflictedUrls.has(lead.url)?'CONFLICTED':!urls.includes(lead.url)?'OMITTED':sourceId?'ACQUIRED':'FAILED';
    lead.acquisitionCodes=[...(truncatedSourceUrls.has(lead.url)?['ATT_TEXT_CAP']:[]),...(lead.acquisitionStatus==='ACQUIRED'?[]:[`ATT_LEAD_${lead.acquisitionStatus}`])];
  }
  return {sources,rawArtifacts,queries,...(recoveryPlan?.recordQueryTimes?{queryRetrievedAt}:{}),complete:codes.length===0,codes:[...new Set(codes)],start,end,comparisonSourceIds,comparisonComplete,postSampleComplete,discoveryUrls:seeds,...((name||recoveryPlan)?{comparisonAcquisition:{originalComplete:comparisonComplete,searchSucceeded:comparisonSearchSucceeded,descriptorComplete,leadCount,leads},comparisonRankingSourceIds:[...comparisonSourceIds],postSampleSourceIds:sources.filter(s=>s.kind==='POST').map(s=>s.id)}:{})};
}


/** Free-only alternate discovery; reuses the same guarded collection boundary. */
export async function recoverComparisonSources(token:TokenRef,key:string,queries:string[],skipUrls:string[],maxUrls:number,fetcher:typeof fetch,now:()=>string,queryParents?:RecoveryQueryParent[],recordQueryTimes=false){
  return collectAttentionSources(token,key,fetcher,now,undefined,[],{queries,skipUrls,maxUrls,queryParents,recordQueryTimes});
}
