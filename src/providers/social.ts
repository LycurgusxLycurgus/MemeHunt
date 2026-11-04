import { fetchReadResponse, readLimitedText } from './http.js';
import { publicHttpsUrl } from './tinyfish.js';
import { attentionSourceLimit, originSeedLinks, type AttentionRead } from './attention.js';
import type { TokenRef } from '../domain/contracts.js';
import { canonicalSocialUrl, socialAccount, socialInputSchema, type SocialInput } from '../domain/social.js';
import { acquisitionEvidenceMethod as boundedAcquisitionMethod, acquisitionLedgerSchema, buildAcquisitionScope,
  type AcquisitionLedger, type AcquisitionScope, type AcquisitionSearch } from './acquisition-evidence.js';

export type SocialRead=SocialInput & {rawArtifacts:Record<string,string>};
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const host=(url:string)=>{try{return new URL(url).hostname;}catch{return null;}};
function collectionError(error:unknown,operation:'SEARCH'|'FETCH',signal?:AbortSignal):string {
  const stage='SOC_'+operation+'_',cause=object(error)&&object(error.cause)?error.cause:undefined;
  const codes=[object(error)?error.code:undefined,cause?.code];
  if(signal?.aborted||error instanceof Error&&error.message==='COLLECTION_BUDGET')return 'SOC_COLLECTION_BUDGET';
  if(error instanceof Error&&new RegExp('^'+stage+'(?:HTTP_[0-9]{3}|SHAPE)$').test(error.message))return error.message;
  if(error instanceof Error&&error.message==='PROVIDER_RESPONSE_LIMIT')return stage+'RESPONSE_LIMIT';
  if(error instanceof SyntaxError)return stage+'SHAPE';
  if(error instanceof Error&&error.name==='TimeoutError'||codes.some(code=>['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT'].includes(String(code))))return stage+'TIMEOUT';
  if(codes.some(code=>['ENOTFOUND','EAI_AGAIN'].includes(String(code))))return stage+'DNS_ERROR';
  if(codes.some(code=>['EACCES','EPERM'].includes(String(code))))return stage+'NETWORK_ACCESS_DENIED';
  if(error instanceof TypeError||codes.some(code=>['ECONNRESET','ECONNREFUSED','EPIPE','UND_ERR_SOCKET'].includes(String(code))))return stage+'TRANSPORT';
  return stage+'UNAVAILABLE';
}
/** Supplements preserve the frozen attention sample and its retained evidence. */
export async function collectSocialSources(token:TokenRef,attention:AttentionRead,key:string,fetcher:typeof fetch=fetch,now:()=>string=()=>new Date().toISOString(),signal?:AbortSignal):Promise<SocialRead>{
  const sourceLimit=attentionSourceLimit(attention);
  const acquisitionEnabled=attention.acquisitionEvidenceMethod===boundedAcquisitionMethod;
  const retained=attention.sources,rawArtifacts:Record<string,string>=acquisitionEnabled?{...attention.rawArtifacts}:{},codes:string[]=[],queries:string[]=[],acquisitionSearches:AcquisitionSearch[]=[];
  const acquisitionSearchArtifact=(id:string,kind:'request'|'response'|'attempt')=>`social-acquisition-${id}-${kind}`;
  const targetPostIds=(attention.postSampleSourceIds??retained.filter(s=>s.kind==='POST'&&!attention.comparisonSourceIds?.includes(s.id)).map(s=>s.id)).filter(id=>retained.some(s=>s.id===id));
  const identitySourceIds=retained.filter(s=>s.kind==='PAGE'&&s.url!==attention.metadataUri&&(!attention.comparisonSourceIds?.includes(s.id)||attention.discoveryUrls?.some(url=>canonicalSocialUrl(url)===canonicalSocialUrl(s.url)))).map(s=>s.id);
  const sources=retained.filter(s=>targetPostIds.includes(s.id)||identitySourceIds.includes(s.id)).map(s=>({...s}));
  const baseSocialSourceCount=sources.length,clippedIds=new Set<string>(),fullTexts=new Map<string,{text:string;url:string}>();
  for(const [id,raw] of Object.entries(attention.rawArtifacts))if(id.includes('fetch'))try{const value:unknown=JSON.parse(raw);if(object(value)&&Array.isArray(value.results))for(const r of value.results){if(!object(r)||typeof r.text!=='string'||typeof r.url!=='string')continue;const requested=publicHttpsUrl(r.url,true),final=publicHttpsUrl(typeof r.final_url==='string'?r.final_url:r.url,true);if(!requested||!final||socialAccount(requested)&&socialAccount(requested)!==socialAccount(final))continue;const url=canonicalSocialUrl(final),s=sources.find(s=>canonicalSocialUrl(s.url)===url);if(s&&r.text.startsWith(s.text)&&r.text.length>s.text.length){clippedIds.add(s.id);if(r.text.length<=120000)fullTexts.set(s.id,{text:r.text,url});}}}catch{/* A failed transport supplies no text. */}
  const originalClipped=[...clippedIds],selection:Array<{url:string;selected:boolean;reason:string;required:boolean;status:string;parent?:string}>=[],requestedUrlsByBatch:string[][]=[];
  const seenLeads=new Set<string>(),identityUnavailableSources:Array<{url:string;code:'HTTP_404'|'HTTP_410'}>=[];let additions=0,requiredFailed=false;
  const accounts=[...new Set(targetPostIds.filter(id=>{const s=sources.find(s=>s.id===id)!;return !!s.publishedAt&&Date.parse(s.publishedAt)>=Date.parse(attention.start)&&Date.parse(s.publishedAt)<Date.parse(attention.end);}).map(id=>socialAccount(sources.find(s=>s.id===id)!.url)).filter((a):a is string=>!!a))].sort();
  const aborted=()=>signal?.aborted===true;
  const fail=(lead:typeof selection[number],code:string)=>{lead.status=code;codes.push(lead.required?code:'SOC_ACCOUNT_CONTEXT_UNAVAILABLE');if(lead.required)requiredFailed=true;};
  const add=(value:unknown,reason:string,required:boolean,parent?:string)=>{if(typeof value!=='string')return;const safe=publicHttpsUrl(value,true);if(!safe)return;const url=canonicalSocialUrl(safe);if(seenLeads.has(url))return;seenLeads.add(url);const prior=sources.find(s=>canonicalSocialUrl(s.url)===url);
    const lead={url,selected:true,reason,required,status:'PENDING',...(parent?{parent}:{})};selection.push(lead);
    if(prior&&!clippedIds.has(prior.id)){lead.status='REUSED';if(required&&prior.kind==='PAGE'&&!identitySourceIds.includes(prior.id))identitySourceIds.push(prior.id);return;}
    const pending=selection.filter(l=>l.status==='PENDING');if(additions+pending.length>8||sources.length+pending.filter(l=>!sources.some(s=>canonicalSocialUrl(s.url)===l.url&&clippedIds.has(s.id))).length>sourceLimit){lead.selected=false;fail(lead,required?'SOC_SOURCE_CAP':'SOC_ACCOUNT_CONTEXT_CAP');}
  };
  const retain=(lead:typeof selection[number],text:string,url:string,date:string|null,availableAt:string)=>{const prior=sources.find(s=>canonicalSocialUrl(s.url)===url),completes=!!prior&&identitySourceIds.includes(prior.id)&&clippedIds.has(prior.id)&&text.startsWith(prior.text);
    if(prior&&!completes){if(prior.text===text){lead.status='REUSED';return;}fail(lead,'SOC_SOURCE_CONFLICT');return;}
    if(!text.trim()){fail(lead,'SOC_FETCH_EMPTY');return;}if(text.length>120000){fail(lead,'SOC_TEXT_CAP');return;}if(additions>=8||sources.length>=sourceLimit&&!completes){fail(lead,'SOC_SOURCE_CAP');return;}
    const id=`social-page-${retained.length+additions+1}`,account=socialAccount(url),kind=/\/status\/\d+/.test(new URL(url).pathname)&&account?'POST' as const:'PAGE' as const;
    if(completes){sources.splice(sources.indexOf(prior!),1);identitySourceIds.splice(identitySourceIds.indexOf(prior!.id),1);clippedIds.delete(prior!.id);}
    sources.push({id,url,text,publishedAt:date,authorId:account,availableAt,kind,discoveredFrom:lead.url});additions++;if(kind==='PAGE'&&lead.required)identitySourceIds.push(id);lead.status='RETAINED';
  };
  for(const source of sources.filter(s=>identitySourceIds.includes(s.id)&&clippedIds.has(s.id)))add(source.url,'COMPLETE_IDENTITY_TEXT',true);
  for(const lead of selection.filter(l=>l.status==='PENDING')){const prior=sources.find(s=>canonicalSocialUrl(s.url)===lead.url),raw=prior&&fullTexts.get(prior.id);if(prior&&raw)retain(lead,raw.text,raw.url,prior.publishedAt,prior.availableAt);}
  for(const url of (attention.discoveryUrls??[]).filter(url=>url!==attention.metadataUri))add(url,'DEX_DISCOVERY',true);
  const search=async(query:string,required:boolean)=>{
    if(aborted()){if(required)requiredFailed=true;codes.push('SOC_COLLECTION_BUDGET');return;}
    queries.push(query);const index=queries.length,id=`social-search-${index}`,responseId=acquisitionSearchArtifact(id,'response');let requestUrl='',status:number|undefined;
    try{
      const url=new URL('https://api.search.tinyfish.ai/');url.searchParams.set('query',query);requestUrl=url.toString();
      if(acquisitionEnabled)rawArtifacts[acquisitionSearchArtifact(id,'request')]=JSON.stringify({method:'social-acquisition-search-request-v1',id,token,query,purpose:'SOCIAL',required,requestedAt:now(),url:requestUrl});
      let response:Response;
      try{response=await fetchReadResponse(requestUrl,{headers:{'X-API-Key':key,accept:'application/json'},signal},fetcher,10000);}
      catch(error){if(acquisitionEnabled)rawArtifacts[acquisitionSearchArtifact(id,'attempt')]=JSON.stringify({method:'social-acquisition-search-attempt-v1',id,token,query,purpose:'SOCIAL',required,code:collectionError(error,'SEARCH',signal),availableAt:now()});throw error;}
      status=response.status;
      const raw=await readLimitedText(response,100000);rawArtifacts[`social-search-${index}`]=raw;
      if(acquisitionEnabled){const availableAt=now();rawArtifacts[responseId]=raw;rawArtifacts[`social-search-http-outcome-${index}`]=JSON.stringify({method:'social-search-http-v1',id,status:response.status,ok:response.ok,availableAt,responseArtifactId:responseId,bodyAvailable:true});acquisitionSearches.push({id,query,purpose:'SOCIAL',artifactId:responseId,status:response.status,availableAt,required});}
      if(!response.ok)throw new Error(`SOC_SEARCH_HTTP_${response.status}`);
      const result:unknown=JSON.parse(raw);if(!object(result)||!Array.isArray(result.results))throw new Error('SOC_SEARCH_SHAPE');for(const r of result.results)if(object(r))add(r.url,'INDEXED_DISCOVERY_ONLY',required);
    }catch(error){
      const code=collectionError(error,'SEARCH',signal);
      if(acquisitionEnabled&&!acquisitionSearches.some(row=>row.id===id)){
        if(status!==undefined){const availableAt=now();acquisitionSearches.push({id,query,purpose:'SOCIAL',artifactId:responseId,status,availableAt,required});rawArtifacts[`social-search-http-outcome-${index}`]=JSON.stringify({method:'social-search-http-v1',id,status,ok:status>=200&&status<300,availableAt,responseArtifactId:responseId,bodyAvailable:false});}
        rawArtifacts[acquisitionSearchArtifact(id,'attempt')]=JSON.stringify({method:'social-acquisition-search-attempt-v1',id,token,query,purpose:'SOCIAL',required,...(requestUrl?{url:requestUrl}:{}),...(status===undefined?{}:{status}),code,availableAt:now()});
      }
      rawArtifacts[`social-collection-search-${index}-error`]=JSON.stringify({method:'social-collection-error-v1',operation:'SEARCH',code,required});codes.push(required?code:'SOC_ACCOUNT_CONTEXT_UNAVAILABLE');if(required)requiredFailed=true;
    }
  };
  if(!selection.length&&!identitySourceIds.length)await search(`"${token.address.replace(/["\\]/g,'')}" official project website social account`,true);
  const fetchBatch=async()=>{const leads=selection.filter(l=>l.status==='PENDING');if(!leads.length)return;const urls=leads.map(l=>l.url);requestedUrlsByBatch.push(urls);if(aborted()){for(const l of leads)fail(l,'SOC_COLLECTION_BUDGET');return;}
    try{const response=await fetchReadResponse('https://api.fetch.tinyfish.ai/',{method:'POST',headers:{'X-API-Key':key,'content-type':'application/json'},body:JSON.stringify({urls,format:'markdown',links:true,ttl:0,per_url_timeout_ms:8000}),signal},fetcher,30000);if(attention.leadershipPositiveMethod)rawArtifacts[`social-http-outcome-${requestedUrlsByBatch.length}`]=JSON.stringify({method:'social-fetch-http-v1',status:response.status,ok:response.ok});const raw=await readLimitedText(response,2000000);rawArtifacts[`social-fetch-${requestedUrlsByBatch.length}`]=raw;if(!response.ok)throw new Error(`SOC_FETCH_HTTP_${response.status}`);const result:unknown=JSON.parse(raw);if(!object(result)||!Array.isArray(result.results)||!Array.isArray(result.errors))throw new Error('SOC_FETCH_SHAPE');
      for(const r of result.results){if(!object(r)||typeof r.url!=='string'||typeof r.text!=='string')continue;const requested=publicHttpsUrl(r.url,true),final=publicHttpsUrl(typeof r.final_url==='string'?r.final_url:r.url,true);if(!requested)continue;const lead=leads.find(l=>l.url===canonicalSocialUrl(requested));if(!lead||lead.status!=='PENDING')continue;if(!final||socialAccount(requested)&&socialAccount(requested)!==socialAccount(final)){fail(lead,'SOC_REDIRECT_BINDING');continue;}const date=typeof r.published_date==='string'&&Number.isFinite(Date.parse(r.published_date))?new Date(r.published_date).toISOString():null;retain(lead,r.text,canonicalSocialUrl(final),date,now());}
      for(const l of leads.filter(l=>l.status==='PENDING')){
        const errors=result.errors.filter((e:unknown)=>object(e)&&typeof e.url==='string'&&canonicalSocialUrl(e.url)===l.url);
        if(attention.leadershipPositiveMethod&&l.required&&errors.length>0&&errors.every((e:any)=>e.status===404||e.status===410)){
          const code=errors.some((e:any)=>e.status===410)?'HTTP_410' as const:'HTTP_404' as const;
          l.status='TERMINAL_'+code;identityUnavailableSources.push({url:l.url,code});codes.push('SOC_IDENTITY_'+code);
        }else fail(l,result.errors.length?'SOC_FETCH_URL_ERROR':'SOC_FETCH_REQUIRED_MISSING');
      }
    }catch(error){const code=collectionError(error,'FETCH',signal);rawArtifacts[`social-collection-fetch-${requestedUrlsByBatch.length}-error`]=JSON.stringify({method:'social-collection-error-v1',operation:'FETCH',code,required:leads.some(l=>l.required)});for(const l of leads.filter(l=>l.status==='PENDING'))fail(l,code);}
  };
  await fetchBatch();
  // One observed level only: exact project account links and same-host identity documents.
  for(const source of sources.filter(s=>s.kind==='PAGE'&&attention.discoveryUrls?.some(url=>canonicalSocialUrl(url)===canonicalSocialUrl(s.url))))for(const match of source.text.matchAll(/\]\((https:\/\/[^\s)]+)\)/g)){const safe=publicHttpsUrl(match[1]!,true);if(!safe)continue;const account=socialAccount(safe),sourceAccount=socialAccount(source.url);if(sourceAccount?account!==sourceAccount||!/\/status\/\d+/.test(new URL(safe).pathname):!account&&(attention.collectionMethod==='project-context-v2'?!originSeedLinks(source.url,[safe],attention.collectionMethod).includes(safe):host(safe)!==host(source.url)||!/(?:docs|about|whitepaper|launch|log)/i.test(new URL(safe).pathname)))continue;add(safe,`OBSERVED_IDENTITY_LINK:${source.id}`,true,source.id);}
  for(const account of accounts)add(`https://x.com/${account.slice(6)}`,'PUBLIC_ACCOUNT_PROFILE',false);
  if(queries.length<2&&accounts.length&&additions+selection.filter(l=>l.status==='PENDING').length<8)await search(`site:x.com/${accounts[0]!.slice(6)} "${token.address.replace(/["\\]/g,'')}"`,false);
  await fetchBatch();
  const inheritedComplete=(attention.postSampleComplete??attention.complete)&&!targetPostIds.some(id=>clippedIds.has(id));
  if(clippedIds.size)codes.push('SOC_TEXT_CAP');
  const identityComplete=!requiredFailed&&sources.length>0&&!identitySourceIds.some(id=>clippedIds.has(id));
  if(acquisitionEnabled){
    for(const source of sources)rawArtifacts[source.id]=source.text;
    try{
      const attentionLedger=acquisitionLedgerSchema.parse(JSON.parse(attention.rawArtifacts['attention-acquisition-ledger']!));
      const requiredSeedSearches=attentionLedger.searches.filter(search=>search.required&&(search.purpose==='EXACT_TOKEN'||search.purpose==='SOCIAL'));
      rawArtifacts['social-acquisition-ledger']=JSON.stringify({method:boundedAcquisitionMethod,token,start:attentionLedger.start,end:now(),searches:[...requiredSeedSearches,...acquisitionSearches]});
    }catch{rawArtifacts['social-acquisition-ledger']=JSON.stringify({method:boundedAcquisitionMethod,token,start:attention.start,end:now(),searches:acquisitionSearches});}
  }
  const read=socialInputSchema.parse({schemaVersion:1,...(acquisitionEnabled?{acquisitionEvidenceMethod:boundedAcquisitionMethod}:{}),...(attention.outcomeBasisMethod?{outcomeBasisMethod:attention.outcomeBasisMethod}:{}),...(identityUnavailableSources.length?{identityUnavailableSources}:{}),...(attention.leadershipPositiveMethod?{inspectionRecoveryMethod:'retained-source-inspection-v2',associationCitationMethod:'literal-associations-v1',screeningConstraintMethod:'frozen-positive-guards-v2'}:{}),...(attention.postSampleScope?{postSampleScope:attention.postSampleScope}:{}),reviewCriterionMethod:'verdict-aware-v4',entryDecisionMethod:'public-support-v3',sources,start:attention.start,end:attention.end,targetPostIds:[...targetPostIds],identitySourceIds:[...new Set(identitySourceIds)],sampleComplete:inheritedComplete,identityComplete,previousComparable:inheritedComplete,codes:[...new Set(codes)],queries:[...attention.queries,...queries]});
  rawArtifacts['social-acquisition-scope']=JSON.stringify({read,selection,requestedUrls:requestedUrlsByBatch.flat(),requestedUrlsByBatch,supplementLimit:8,actualSupplements:additions,socialSourceLimit:sourceLimit,baseSocialSourceCount,submittedSocialSourceCount:sources.length,budgetBasis:'social-input',clippedSourceIds:originalClipped,remainingClippedSourceIds:[...clippedIds],retainedAttentionSourceCount:retained.length,excludedComparisonSourceIds:retained.filter(s=>!targetPostIds.includes(s.id)&&!identitySourceIds.includes(s.id)).map(s=>s.id),method:'free-social-supplements-v2'});
  return {...read,rawArtifacts};
}

/** Rebuild the Social receipt from its required seed searches, own supplement searches, full text and selection ledger. */
export function buildSocialAcquisitionScope(attention:AttentionRead,read:SocialInput,rawArtifacts:Record<string,string>,token:TokenRef,cutoff:string):AcquisitionScope{
  const blockers:string[]=[],ledgerId='social-acquisition-ledger';
  const sameToken=(a:TokenRef,b:TokenRef)=>a.chain===b.chain&&(a.chain==='solana'?a.address===b.address:a.address.toLowerCase()===b.address.toLowerCase());
  let attentionLedger:AcquisitionLedger|undefined,ledger:AcquisitionLedger|undefined;
  try{attentionLedger=acquisitionLedgerSchema.parse(JSON.parse(attention.rawArtifacts['attention-acquisition-ledger']!));}catch{blockers.push('ACQUISITION_ATTENTION_LEDGER_INVALID');}
  try{ledger=acquisitionLedgerSchema.parse(JSON.parse(rawArtifacts[ledgerId]!));}catch{blockers.push('ACQUISITION_LEDGER_MISSING_OR_INVALID');}
  if(attention.acquisitionEvidenceMethod!==boundedAcquisitionMethod||read.acquisitionEvidenceMethod!==boundedAcquisitionMethod||!sameToken(attentionLedger?.token??token,token)||!sameToken(ledger?.token??token,token))blockers.push('ACQUISITION_SCOPE_BINDING_INVALID');
  if(attentionLedger&&ledger){
    const seeds=attentionLedger.searches.filter(search=>search.required&&(search.purpose==='EXACT_TOKEN'||search.purpose==='SOCIAL'));
    if(seeds.length!==2||seeds[0]?.id!=='attention-search-1'||seeds[1]?.id!=='attention-search-2')blockers.push('ACQUISITION_REQUIRED_QUERY_MISSING');
    if(JSON.stringify(ledger.searches.slice(0,seeds.length))!==JSON.stringify(seeds))blockers.push('ACQUISITION_ATTENTION_SEARCH_MISMATCH');
  }
  if(JSON.stringify(read.queries.slice(0,attention.queries.length))!==JSON.stringify(attention.queries))blockers.push('ACQUISITION_QUERY_BINDING_INVALID');
  const expectedQueries:Array<{query:string;purpose:AcquisitionSearch['purpose']}>=[];
  for(const [index,purpose] of (['EXACT_TOKEN','SOCIAL'] as const).entries()){
    const query=attention.queries[index];if(typeof query!=='string'){blockers.push('ACQUISITION_REQUIRED_QUERY_MISSING');continue;}
    expectedQueries.push({query,purpose});
  }
  const rows=ledger?.searches??[];
  const ownSearches=rows.filter(row=>row.id.startsWith('social-search-'));
  if(rows.some(row=>!row.id.startsWith('social-search-')&&!['attention-search-1','attention-search-2'].includes(row.id)||!['EXACT_TOKEN','SOCIAL'].includes(row.purpose)))blockers.push('ACQUISITION_UNEXPECTED_QUERY');
  for(const row of ownSearches)if(row.required)expectedQueries.push({query:row.query,purpose:'SOCIAL'});
  const expectedIds=new Set(['attention-search-1','attention-search-2',...ownSearches.map(row=>row.id)]);
  if(rows.some(row=>!expectedIds.has(row.id)))blockers.push('ACQUISITION_UNEXPECTED_QUERY');
  for(const row of rows){
    const attentionSearch=row.id.startsWith('attention-search-'),requestId=attentionSearch?`attention-acquisition-${row.id}-request`:`social-acquisition-${row.id}-request`;
    const outcomeId=attentionSearch?`attention-acquisition-${row.id}-http`:`social-search-http-outcome-${row.id.match(/\d+$/)?.[0]}`;
    try{
      const request=JSON.parse(rawArtifacts[requestId]!);
      const url=new URL(String(request.url));
      if(request.method!==(attentionSearch?'attention-acquisition-search-request-v1':'social-acquisition-search-request-v1')||request.id!==row.id||request.query!==row.query||request.purpose!==row.purpose||!sameToken(request.token,token)||url.hostname!=='api.search.tinyfish.ai'||url.searchParams.get('query')!==row.query)blockers.push('ACQUISITION_QUERY_BINDING_INVALID');
    }catch{blockers.push('ACQUISITION_REQUEST_MISSING');}
    try{
      const outcome=JSON.parse(rawArtifacts[outcomeId]!);
      if(outcome.method!==(attentionSearch?'attention-acquisition-search-http-v1':'social-search-http-v1')||outcome.id!==row.id||outcome.status!==row.status||outcome.availableAt!==row.availableAt||outcome.responseArtifactId!==row.artifactId||outcome.bodyAvailable!==(typeof rawArtifacts[row.artifactId]==='string'))blockers.push('ACQUISITION_HTTP_OUTCOME_INVALID');
    }catch{blockers.push('ACQUISITION_HTTP_OUTCOME_MISSING');}
    const legacyResponse=attentionSearch?rawArtifacts[`attention-search-${row.id.match(/\d+$/)?.[0]}`]:rawArtifacts[`social-search-${row.id.match(/\d+$/)?.[0]}`];
    if(typeof rawArtifacts[row.artifactId]==='string'&&(legacyResponse===undefined||legacyResponse!==rawArtifacts[row.artifactId]))blockers.push('ACQUISITION_RESPONSE_BINDING_INVALID');
    if(attentionSearch)try{
      const outcomes=JSON.parse(rawArtifacts['attention-http-outcomes']!).outcomes as Array<{artifactId:string;status:number}>;
      const outcome=outcomes.filter(item=>item.artifactId===`attention-search-${row.id.match(/\d+$/)?.[0]}`);
      if(outcome.length!==1||outcome[0]!.status!==row.status)blockers.push('ACQUISITION_HTTP_OUTCOME_INVALID');
    }catch{blockers.push('ACQUISITION_HTTP_OUTCOME_MISSING');}
  }
  const selectionArtifact='social-acquisition-scope';
  try{
    const selectionPacket=JSON.parse(rawArtifacts[selectionArtifact]!);
    const packetRead=selectionPacket.read as Record<string,unknown>;
    const {acquisitionScope:_scope,qualifiedAt:_packetQualifiedAt,...packetUnscoped}=packetRead;
    const {rawArtifacts:_rawArtifacts,...readFields}=read as SocialRead;
    const {acquisitionScope:_readScope,qualifiedAt:_qualifiedAt,...readUnscoped}=socialInputSchema.parse(readFields);
    const packetCodes=Array.isArray(packetUnscoped.codes)?packetUnscoped.codes as string[]:[],readCodes=Array.isArray(readUnscoped.codes)?readUnscoped.codes as string[]:[];
    const modelCodeCount=Math.max(0,readCodes.length-packetCodes.length),modelCodes=readCodes.slice(0,modelCodeCount);
    const retainedCollectorCodes=JSON.stringify(readCodes.slice(modelCodeCount))===JSON.stringify(packetCodes);
    const validModelCodes=modelCodes.every(code=>code.startsWith('SOC_MODEL_')||code==='SOC_TEXT_CAP'||code==='SOC_MODEL_PACKET_LIMIT'||code==='SOC_POST_CORPUS_UNAVAILABLE');
    if(retainedCollectorCodes&&validModelCodes)readUnscoped.codes=packetCodes;
    if(!Array.isArray(selectionPacket.selection)||JSON.stringify(packetUnscoped)!==JSON.stringify(readUnscoped))blockers.push('ACQUISITION_SELECTION_SCOPE_INVALID');
    else{
      const selection=selectionPacket.selection as Array<{url:string;selected:boolean;required:boolean;status:string}>;
      if(selection.some(row=>row.required&&(!row.selected||!['RETAINED','REUSED','TERMINAL_HTTP_404','TERMINAL_HTTP_410'].includes(row.status))))blockers.push('ACQUISITION_REQUIRED_SOURCE_UNACCOUNTED');
      for(const url of attention.discoveryUrls??[])if(url!==attention.metadataUri&&!selection.some(row=>row.required&&canonicalSocialUrl(row.url)===canonicalSocialUrl(url)))blockers.push('ACQUISITION_REQUIRED_SOURCE_UNACCOUNTED');
      for(const unavailable of read.identityUnavailableSources??[])if(!selection.some(row=>row.url===canonicalSocialUrl(unavailable.url)&&row.status===`TERMINAL_${unavailable.code}`))blockers.push('ACQUISITION_TERMINAL_SOURCE_MISMATCH');
    }
  }catch{blockers.push('ACQUISITION_SELECTION_SCOPE_INVALID');}
  if(read.codes.some(code=>/^SOC_(?:TEXT_CAP|SOURCE_CAP|COLLECTION_BUDGET|SEARCH_|FETCH_|REDIRECT_BINDING|SOURCE_CONFLICT)/.test(code)))blockers.push('ACQUISITION_SOCIAL_COLLECTION_INCOMPLETE');
  for(const source of read.sources){
    const age=Date.parse(cutoff)-Date.parse(source.availableAt);
    if(rawArtifacts[source.id]!==source.text||!source.text.trim()||source.text.length>120000||!Number.isFinite(age)||age<0||age>900000)blockers.push('ACQUISITION_SOCIAL_SOURCE_INCOMPLETE');
  }
  const start=ledger?.start??read.start,end=ledger?.end??read.end,ledgerEnd=Date.parse(end),sourceTimes=read.sources.map(source=>Date.parse(source.availableAt)).filter(Number.isFinite);
  const availableAt=new Date(Math.max(Number.isFinite(ledgerEnd)?ledgerEnd:Date.parse(read.end),...sourceTimes)).toISOString();
  const attentionSearchArtifacts=rows.filter(row=>row.id==='attention-search-1'||row.id==='attention-search-2').flatMap(row=>[`attention-acquisition-${row.id}-request`,`attention-acquisition-${row.id}-http`,row.artifactId]);
  const socialSearchCount=Math.max(0,read.queries.length-attention.queries.length),searchIds=new Set(rows.map(row=>row.id));
  for(let index=1;index<=socialSearchCount;index++)searchIds.add(`social-search-${index}`);
  const ownSearchArtifacts=[...searchIds].flatMap(id=>{
    const attentionSearch=id==='attention-search-1'||id==='attention-search-2';
    const prefix=attentionSearch?'attention-acquisition-':'social-acquisition-';
    const suffixes=[`${prefix}${id}-request`,`${prefix}${id}-response`,`${prefix}${id}-attempt`,...(attentionSearch?[`${prefix}${id}-http`]:[])];
    const row=rows.find(item=>item.id===id);
    if(row)suffixes.push(row.artifactId);
    if(!attentionSearch){const index=id.match(/\d+$/)?.[0];if(index)suffixes.push(`social-search-http-outcome-${index}`);}
    return suffixes;
  }).filter((id,index,all)=>all.indexOf(id)===index&&typeof rawArtifacts[id]==='string');
  const artifactIds=[selectionArtifact,...ownSearchArtifacts,...attentionSearchArtifacts,...Object.keys(rawArtifacts).filter(id=>/^social-(?:search-http-outcome|fetch-|http-outcome|collection-)/.test(id)),...read.sources.map(source=>source.id),...(attention.acquisitionDiscovery?.dexArtifactId?[attention.acquisitionDiscovery.dexArtifactId]:[]),...(attention.acquisitionDiscovery?.metadataArtifactId?[attention.acquisitionDiscovery.metadataArtifactId]:[])];
  return buildAcquisitionScope({token,group:'SOCIAL_ENTRY',cutoff,start,end,availableAt,ledgerId,rawArtifacts,sourceIds:read.sources.map(source=>source.id),expectedQueries,blockers,artifactIds});
}
