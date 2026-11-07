import type { LiveBundle } from '../domain/contracts.js';
import { criterionIds,criterionReviewMethod,buildCriterionInput,validateCriterionSourceBindings,validateCriterionAcceptedMembership,type CriterionInput } from '../domain/criterion-review.js';
import { attentionOperationFacts,buildAttentionAcquisitionScope,normalizeAttentionSearchUrl,attentionSeedLinks,indexedComparisonQuery,requiredComparisonRecoveryParents,comparisonRecoverySelection,attentionSourceLimit,type AttentionRead } from '../providers/attention.js';
import { decodeCriterionAttention } from '../providers/attention-model.js';
import { isRetiredFastPolicy } from '../domain/fast-checklist.js';
import { sourceModelEvidenceAllowed } from '../providers/source-model.js';
import { decodeTokenMetadataUri } from '../providers/token-discovery.js';
import { publicHttpsUrl } from '../providers/tinyfish.js';
import { geckoPoolBinding,verifyOriginAlias } from '../providers/origin-recovery.js';
import { isDeepStrictEqual } from 'node:util';
import { decodeFirecrawlArtifact } from '../providers/firecrawl.js';
import { buildPurposeAcquisition,readAcquisitionPurposePlan,validAcquisitionPurposePlan } from '../providers/acquisition-evidence.js';

/** Reconstruct source, acquisition and independently authored criterion proof. */
export function validateCriterionProof(bundle:LiveBundle):{read:AttentionRead;input:CriterionInput;receipt:NonNullable<NonNullable<LiveBundle['details']>['criteria']>} {
  const raw=bundle.rawArtifacts;
  const owned=(id:string,source:string)=>bundle.evidence.some(e=>e.id===id&&e.sourceId===source&&e.accessMode==='LOCAL_DERIVED'&&typeof raw[id]==='string');
  if(!owned('criterion-source-read','attention-collector')||!owned('criterion-input','attention-collector')||!owned('criterion-receipt','attention-collector'))throw Error('CRITERION_PROOF_REQUIRED');
  let read:AttentionRead;
  try{read=JSON.parse(raw['criterion-source-read']);}catch{throw Error('CRITERION_PROOF_INVALID');}
  if(read.criterionReviewMethod!==criterionReviewMethod||read.acquisitionPurposeMethod!=='acquisition-purpose-v1'||bundle.details?.acquisitionPurposeMethod!=='acquisition-purpose-v1'||bundle.details?.criteria?.acquisitionPurposeMethod!=='acquisition-purpose-v1'||!Array.isArray(read.sources)||!Array.isArray(read.sourceBindings))throw Error('CRITERION_PROOF_INVALID');
  if(isRetiredFastPolicy(read.criterionPolicyId))throw Error('FAST_POLICY_RETIRED');
  if(Object.keys(raw).some(id=>id.startsWith('criterion-single-')||id==='fast-single-generation'))throw Error('FAST_SINGLE_PROOF_INVALID');
  if(read.criterionPolicyId!==undefined)throw Error('CRITERION_POLICY_INVALID');
  read={...read,rawArtifacts:raw};
  try{
    const attention=JSON.parse(raw['attention-qualified-receipt']);
    if(attention?.read?.criterionReviewMethod!==criterionReviewMethod||attention.read.acquisitionPurposeMethod!==read.acquisitionPurposeMethod||!isDeepStrictEqual(attention.read.purposeProjection,read.purposeProjection)||!isDeepStrictEqual(attention.read.purposeReceipt,read.purposeReceipt)||attention.read.criterionPolicyId!==read.criterionPolicyId||attention.proposal!==null||attention.review!==null||JSON.stringify(attention.read.sources)!==JSON.stringify(read.sources)||JSON.stringify(attention.read.sourceBindings)!==JSON.stringify(read.sourceBindings)||JSON.stringify(attention.read.queries)!==JSON.stringify(read.queries)||JSON.stringify(attention.read.discoveryUrls??[])!==JSON.stringify(read.discoveryUrls??[])||attention.token?.chain!==bundle.token.chain||attention.token?.address!==bundle.token.address)throw Error();
    if(bundle.semantic.status==='VALIDATED'||bundle.semantic.claims.length)throw Error();
  }catch{throw Error('CRITERION_PROOF_INVALID');}
  if(!validateCriterionSourceBindings(read)||!validateCriterionAcceptedMembership(read))throw Error('CRITERION_SOURCE_INVALID');
  if(Object.keys(raw).some(id=>id.startsWith('firecrawl-')&&!/^firecrawl-(?:scrape-[12]|search-1)(?:-request)?$/.test(id)))throw Error('CRITERION_SOURCE_INVALID');
  for(const base of ['firecrawl-search-1','firecrawl-scrape-1','firecrawl-scrape-2'])if(raw[base]!==undefined&&raw[base+'-request']===undefined)throw Error('CRITERION_SOURCE_INVALID');
  // Native operations are admitted only after reconstructing their producer
  // body and confirming that the same requested URL actually failed upstream.
  const nativeIds=Object.keys(raw).filter(id=>/^firecrawl-scrape-[12]-request$/.test(id)).sort();
  if(nativeIds.some((id,index)=>id!==`firecrawl-scrape-${index+1}-request`))throw Error('CRITERION_SOURCE_INVALID');
  const nativeUrls=new Set<string>();
  for(const id of nativeIds){
    const base=id.slice(0,-8),record=bundle.evidence.find(e=>e.id===id&&e.sourceId==='attention-collector'&&e.accessMode==='LOCAL_DERIVED');
    try{
      const operation=JSON.parse(raw[id]),url=operation.request?.url;
      if(!record||operation.method!=='firecrawl-native-operation-v1'||operation.request?.operation!=='SCRAPE'||typeof url!=='string'||nativeUrls.has(url))throw Error();
      nativeUrls.add(url);
      const original=JSON.parse(raw['criterion-fetch-requests']);
      const requests=(original.requests as Array<{artifactId:string;urls:string[];failureCode?:string}>).filter(request=>/^attention-fetch-\d+$/.test(request.artifactId)&&request.urls.includes(url));
      if(!requests.length||!requests.some(request=>{try{const packet=JSON.parse(raw[request.artifactId]),retry=JSON.parse(raw[request.artifactId+'-retry-1']??'null'),rows=[...(packet.results??[]),...(retry?.results??[])],usable=(row:any)=>row?.url===url&&typeof row.text==='string'&&row.text.trim()&&!/^\s*(?:safety check|access denied|forbidden)\s*$/i.test(row.text);return Array.isArray(packet.errors)&&(packet.errors.some((error:any)=>error?.url===url)||rows.some((row:any)=>row?.url===url&&!usable(row)))&&!rows.some(usable);}catch{return typeof request.failureCode==='string'&&/^ATT_FETCH_[A-Z0-9_]+$/.test(request.failureCode);}}))throw Error();
      if(raw[base]!==undefined){
        const evidence=bundle.evidence.find(e=>e.id===base&&e.sourceId==='firecrawl'&&e.accessMode==='FREE_ACCOUNT');
        if(!evidence||typeof operation.httpStatus!=='number')throw Error();
        const result=decodeFirecrawlArtifact(operation.request,raw[base],operation.httpStatus);
        if(result.status!==operation.status||(result.code??null)!==operation.code)throw Error();
        if(result.status==='OBSERVED'&&!read.sourceBindings?.some(binding=>binding.producerArtifactId===base)&&!read.sources.some(source=>source.url===result.pages[0]?.finalUrl&&source.text===result.pages[0]?.text)&&!JSON.parse(raw['criterion-fetch-requests']).omissions?.some((item:any)=>item.url===url))throw Error();
      }else if(operation.status==='OBSERVED')throw Error();
    }catch{throw Error('CRITERION_SOURCE_INVALID');}
  }
  if(read.sourceBindings?.some(binding=>binding.producerArtifactId.startsWith('firecrawl-')&&!nativeIds.includes(binding.producerArtifactId+'-request')))throw Error('CRITERION_SOURCE_INVALID');
  if(read.sources.some((source,index)=>{const match=source.id.match(/^attention-(?:origin-)?page-(\d+)$/);return !!match&&Number(match[1])!==index+1;}))throw Error('CRITERION_SOURCE_INVALID');
  const recoveryStart=read.sources.findIndex(source=>source.id.startsWith('attention-recovery-page-'));
  if(recoveryStart>=0&&read.sources.some((source,index)=>index>=recoveryStart&&source.id!==`attention-recovery-page-${index-recoveryStart+1}`))throw Error('CRITERION_SOURCE_INVALID');
  const discovery:string[]=[];
  try{
    const pairs=JSON.parse(raw['dex-discovery']??'[]');
    if(!Array.isArray(pairs))throw Error();
    const matches=(value:unknown)=>typeof value==='string'&&(bundle.token.chain==='solana'?value===bundle.token.address:value.toLowerCase()===bundle.token.address.toLowerCase());
    for(const pair of pairs.filter((p:any)=>p.chainId===bundle.token.chain&&matches(p.baseToken?.address)))for(const link of [...(Array.isArray(pair.info?.websites)?pair.info.websites:[]),...(Array.isArray(pair.info?.socials)?pair.info.socials:[])])if(typeof link?.url==='string'&&!discovery.includes(link.url)&&discovery.length<4)discovery.push(link.url);
    if(raw['discovery-token-metadata'])try{const decoded=decodeTokenMetadataUri(raw['discovery-token-metadata'],bundle.token.address);if(decoded.uri&&!discovery.includes(decoded.uri))discovery.unshift(decoded.uri);else if(read.metadataUri)throw Error();}catch{if(read.metadataUri)throw Error();}
    const normalize=(value:string)=>{const safe=publicHttpsUrl(value,true);if(!safe)return null;const u=new URL(safe);return /^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname)&&/^\/[A-Za-z0-9_]+\/status\/\d+(?:\/.*)?$/.test(u.pathname)?`https://x.com/${u.pathname.split('/')[1].toLowerCase()}/status/${u.pathname.split('/')[3]}`:safe;};
    const canonical=(value:string|null)=>value&&read.metadataTextMethod==='markdown-unescape-v1'?normalizeAttentionSearchUrl(value):value;
    const seeds=[...new Set(discovery.map(normalize).map(canonical).filter((url):url is string=>!!url))].slice(0,4);
    if(JSON.stringify(seeds)!==JSON.stringify(read.discoveryUrls??[]))throw Error();
  }catch{throw Error('CRITERION_SOURCE_INVALID');}
  const normalizeTarget=(url:string)=>normalizeAttentionSearchUrl(url);
  const allowed=new Set((read.discoveryUrls??[]).map(url=>normalizeTarget(url)).filter((url):url is string=>!!url));
  let nativeSearchUrls:string[]=[];
  if(raw['firecrawl-search-1-request'])try{
    const op=JSON.parse(raw['firecrawl-search-1-request']),id=op.replacesSearchId;
    const request=JSON.parse(raw[`attention-acquisition-${id}-request`]);
    if(op.method!=='firecrawl-native-operation-v1'||op.request?.operation!=='SEARCH'||op.request.query!==request.query||!bundle.evidence.some(e=>e.id==='firecrawl-search-1-request'&&e.sourceId==='attention-collector'))throw Error();
    const ledger=JSON.parse(raw['attention-acquisition-ledger']),searches=Array.isArray(ledger.searches)?ledger.searches:[];
    const requests=Object.keys(raw).filter(key=>/^attention-acquisition-attention-search-\d+(?:-primary|-fallback)?-request$/.test(key)).map(key=>JSON.parse(raw[key]) as {id:string}).sort((a,b)=>Number(a.id.match(/search-(\d+)/)?.[1])-Number(b.id.match(/search-(\d+)/)?.[1])||Number(a.id.endsWith('-fallback'))-Number(b.id.endsWith('-fallback')));
    const firstFailure=requests.find(item=>{
      const searchId=item.id,attempt=raw[`attention-acquisition-${searchId}-attempt`],row=searches.find((item:any)=>item.id===searchId);
      if(attempt||!row||row.status!==200)return true;
      try{const value=JSON.parse(raw[row.artifactId]);return !Array.isArray(value.results)||!!value.error||Array.isArray(value.errors)&&value.errors.length>0;}catch{return true;}
    });
    if(!firstFailure||id!==firstFailure.id)throw Error();
    const http=raw[`attention-acquisition-${id}-http`]?JSON.parse(raw[`attention-acquisition-${id}-http`]):null;
    const body=raw[`attention-acquisition-${id}-response`]?JSON.parse(raw[`attention-acquisition-${id}-response`]):null;
    if(!http&&!raw[`attention-acquisition-${id}-attempt`])throw Error();
    if(http?.status===200&&Array.isArray(body?.results)&&!body.error&&(!body.errors||Array.isArray(body.errors)&&!body.errors.length))throw Error();
    if(raw['firecrawl-search-1']!==undefined){
      if(!bundle.evidence.some(e=>e.id==='firecrawl-search-1'&&e.sourceId==='firecrawl'&&e.accessMode==='FREE_ACCOUNT')||typeof op.httpStatus!=='number')throw Error();
      const decoded=decodeFirecrawlArtifact(op.request,raw['firecrawl-search-1'],op.httpStatus);
      if(decoded.status!==op.status||(decoded.code??null)!==op.code)throw Error();
      nativeSearchUrls=(decoded.results??[]).flatMap(result=>{const url=normalizeTarget(result.url);return url?[url]:[];});
    }else if(op.status==='OBSERVED')throw Error();
  }catch{throw Error('CRITERION_SOURCE_INVALID');}
  let manifest:any;try{manifest=JSON.parse(raw['criterion-fetch-requests']);}catch{throw Error('CRITERION_SOURCE_INVALID');}
  if(!Array.isArray(manifest.requests)||!Array.isArray(manifest.omissions))throw Error('CRITERION_SOURCE_INVALID');
  if(nativeIds.length){
    const candidates:string[]=[];
    for(const request of manifest.requests.filter((row:any)=>/^attention-fetch-\d+$/.test(row?.artifactId)))try{
      const packet=JSON.parse(raw[request.artifactId]),retry=JSON.parse(raw[request.artifactId+'-retry-1']??'null');
      if(!Array.isArray(packet.results)||!Array.isArray(packet.errors))continue;
      const rows=[...packet.results,...(Array.isArray(retry?.results)?retry.results:[])],errors=[...packet.errors,...(Array.isArray(retry?.errors)?retry.errors:[])];
      const usable=(row:any)=>typeof row?.text==='string'&&!!row.text.trim()&&!/^\s*(?:safety check|access denied|forbidden)\s*$/i.test(row.text);
      for(const url of request.urls)if(!rows.some((row:any)=>row?.url===url&&usable(row))&&(errors.some((error:any)=>error?.url===url)||rows.some((row:any)=>row?.url===url&&!usable(row))))candidates.push(url);
    }catch{if(typeof request.failureCode==='string'&&/^ATT_FETCH_[A-Z0-9_]+$/.test(request.failureCode))candidates.push(...request.urls);}
    const actual=nativeIds.map(id=>JSON.parse(raw[id]).request.url);
    if(JSON.stringify(actual)!==JSON.stringify(candidates.slice(0,actual.length)))throw Error('CRITERION_SOURCE_INVALID');
  }
  const queue=[...(read.discoveryUrls??[])],plannedOmissions:string[]=[];
  for(let index=1;index<=3;index++)try{
    const packet=JSON.parse(raw[`attention-search-${index}`]);
    if(Array.isArray(packet.results))for(const row of packet.results){const url=typeof row?.url==='string'?normalizeTarget(row.url):null;if(!url||queue.includes(url))continue;if(queue.length>=40)plannedOmissions.push(url);else queue.push(url);}
  }catch{/* The acquisition scope records failed searches. */}
  for(const url of nativeSearchUrls){if(queue.includes(url))continue;if(queue.length>=40)plannedOmissions.push(url);else queue.push(url);}
  let offset=0,batch=0;const followed=new Set<string>();
  while(offset<queue.length){
    const urls=queue.slice(offset,offset+10);offset+=urls.length;batch++;
    const request=manifest.requests.find((item:any)=>item?.artifactId===`attention-fetch-${batch}`);
    if(!request){if(read.codes.some(code=>/RUN_ABORTED|RUN_TIMEOUT|COLLECTION_BUDGET|LIVE_(?:PHASE|HARD)_DEADLINE/.test(code)))break;throw Error('CRITERION_SOURCE_INVALID');}
    if(JSON.stringify(request.urls)!==JSON.stringify(urls))throw Error('CRITERION_SOURCE_INVALID');
    let body:any;try{body=JSON.parse(raw[request.artifactId]);}catch{continue;}
    if(!Array.isArray(body?.results)||!Array.isArray(body?.errors))continue;
    const original=body.results.filter((row:any)=>row&&typeof row.url==='string'&&typeof row.text==='string');
    const retry=manifest.requests.find((item:any)=>item?.artifactId===`${request.artifactId}-retry-1`);
    const returned=new Set(original.map((row:any)=>row.url)),permanent=new Set(body.errors.filter((row:any)=>row&&![408,429,502,503,504].includes(Number(row.status))&&row.error!=='timeout').map((row:any)=>row.url));
    const retryUrls=urls.filter(url=>!returned.has(url)&&!permanent.has(url));
    if(retry&&JSON.stringify(retry.urls)!==JSON.stringify(retryUrls))throw Error('CRITERION_SOURCE_INVALID');
    let recovered:any[]=[];if(retry)try{const packet=JSON.parse(raw[retry.artifactId]);if(Array.isArray(packet.results)&&Array.isArray(packet.errors))recovered=packet.results.filter((row:any)=>retryUrls.includes(row?.url)&&typeof row.text==='string');}catch{/* A failed retry remains unavailable. */}
    const seen=new Set<string>();
    for(const row of [...original,...recovered]){
      const requested=publicHttpsUrl(row.url,true),final=typeof row.final_url==='string'?normalizeTarget(row.final_url):requested;
      if(!requested||!final||!urls.includes(requested)||seen.has(requested)||!row.text.trim()||/^\s*(?:safety check|access denied|forbidden)\s*$/i.test(row.text))continue;
      seen.add(requested);
      if(!(read.discoveryUrls??[]).includes(requested))continue;
      const metadataLinks=/\.json(?:[?]|$)/i.test(requested)?[...row.text.matchAll(/https:\/\/[^"\s\\<>]+/g)].map((match:RegExpMatchArray)=>match[0]):[];
      for(const next of attentionSeedLinks(requested,[...(Array.isArray(row.links)?row.links:[]),...metadataLinks],read.collectionMethod,row.text,false)){
        if(queue.includes(next))continue;followed.add(next);queue.splice(offset+followed.size-1,0,next);
        if(queue.length>40)plannedOmissions.push(queue.pop()!);
      }
    }
  }
  const recordedOmissions=(manifest.omissions as Array<{url:string;purpose:string}>).filter(item=>item.purpose!=='RECOVERY').map(item=>item.url);
  if(plannedOmissions.some(url=>!recordedOmissions.includes(url))||recordedOmissions.some(url=>!plannedOmissions.includes(url)))throw Error('CRITERION_SOURCE_INVALID');
  const accounted=new Set<string>();
  for(const request of manifest.requests??[])for(const value of request.urls??[]){const url=typeof value==='string'?normalizeTarget(value):null;if(url)accounted.add(url);}
  for(const omission of manifest.omissions??[]){const url=typeof omission?.url==='string'?normalizeTarget(omission.url):null;if(url)accounted.add(url);}
  const initialRequested=new Set((manifest.requests??[]).filter((r:any)=>/^attention-fetch-\d+$/.test(r?.artifactId)).flatMap((r:any)=>r.urls??[]));
  if(recordedOmissions.length&&initialRequested.size<40&&!read.codes.some(code=>/RUN_ABORTED|RUN_TIMEOUT|COLLECTION_BUDGET|LIVE_(?:PHASE|HARD)_DEADLINE/.test(code)))throw Error('CRITERION_SOURCE_INVALID');
  const expected=new Set(allowed);
  for(const url of nativeSearchUrls){allowed.add(url);expected.add(url);}
  for(const [id,body] of Object.entries(raw))if(/^attention-(?:(?:recovery-)?search-\d+|origin-role-\d+-search)$/.test(id))try{
    const packet=JSON.parse(body);if(Array.isArray(packet.results))for(const row of packet.results){const url=typeof row?.url==='string'?normalizeTarget(row.url):null;if(url){allowed.add(url);if(/^attention-search-\d+$/.test(id))expected.add(url);}}
  }catch{/* Invalid search responses cannot authorize sources. */}
  if([...expected].some(url=>!accounted.has(url)))throw Error('CRITERION_SOURCE_INVALID');
  for(const binding of read.sourceBindings??[])if(!binding.producerArtifactId.includes('origin-'))try{
    const packet=JSON.parse(raw[binding.producerArtifactId]),row=packet.results[binding.resultIndex],parent=normalizeTarget(binding.requestedUrl);
    if(parent&&allowed.has(parent)&&read.discoveryUrls?.some(seed=>normalizeTarget(seed)===parent)){
      const metadataLinks=/\.json(?:[?]|$)/i.test(binding.requestedUrl)&&typeof row?.text==='string'?[...row.text.matchAll(/https:\/\/[^"\s\\<>]+/g)].map(match=>match[0]):[];
      for(const link of attentionSeedLinks(binding.requestedUrl,[...(Array.isArray(row?.links)?row.links:[]),...metadataLinks],read.collectionMethod,row?.text??'',false))allowed.add(normalizeTarget(link)??link);
    }
  }catch{/* Invalid bodies are rejected by binding validation. */}
  for(const binding of read.sourceBindings??[]){
    if(binding.producerArtifactId.startsWith('firecrawl-'))continue;
    if(binding.producerArtifactId.startsWith('attention-origin-fetch-')){
      const source=read.sources.find(s=>s.id===binding.sourceId),alias=read.originRecovery?.aliases.find(item=>item.sourceId===binding.sourceId);
      const supplement=source&&read.originRecovery?.comparisonSupplementIds.includes(source.id)&&(source.url===`https://api.dexscreener.com/token-pairs/v1/${bundle.token.chain}/${bundle.token.address}`?(()=>{try{const rows=JSON.parse(source.text);return Array.isArray(rows)&&rows.some((row:any)=>row.chainId===bundle.token.chain&&(row.baseToken?.address===bundle.token.address||row.quoteToken?.address===bundle.token.address));}catch{return false;}})():read.comparisonAcquisition?.leads.some(lead=>lead.acquisitionStatus!=='ACQUIRED'&&geckoPoolBinding(source,lead.url)));
      if(!source||!(alias&&verifyOriginAlias(alias,read.sources,raw)||supplement))throw Error('CRITERION_SOURCE_INVALID');
      continue;
    }
    const role=binding.producerArtifactId.match(/^(attention-origin-role-\d+)-fetch$/);
    if(role){try{const search=JSON.parse(raw[role[1]+'-search']);if(!Array.isArray(search.results)||!search.results.some((row:any)=>normalizeTarget(row.url)===normalizeTarget(binding.requestedUrl))||!raw[role[1]+'-search-query']?.includes(bundle.token.address))throw Error();}catch{throw Error('CRITERION_SOURCE_INVALID');}}
    const url=normalizeTarget(binding.requestedUrl);if(!url||!allowed.has(url))throw Error('CRITERION_SOURCE_INVALID');
  }
  for(const source of read.sources){
    const evidence=bundle.evidence.find(e=>e.id===source.id);
    const binding=read.sourceBindings!.find(item=>item.sourceId===source.id),producer=bundle.evidence.find(e=>e.id===binding?.producerArtifactId);
    const provider=binding?.producerArtifactId.startsWith('firecrawl-')?'firecrawl':'tinyfish-fetch';
    if(!evidence||evidence.sourceId!==provider||evidence.accessMode!=='FREE_ACCOUNT'||raw[source.id]!==source.text||evidence.availableAt!==source.availableAt||evidence.scope.url!==source.url||evidence.scope.kind!==source.kind||evidence.scope.authorId!==source.authorId||evidence.scope.publishedAt!==source.publishedAt||!producer||producer.sourceId!==provider||producer.accessMode!=='FREE_ACCOUNT'||provider==='firecrawl'&&Date.parse(source.availableAt)>Date.parse(producer.availableAt))throw Error('CRITERION_SOURCE_INVALID');
  }
  for(const lead of read.comparisonAcquisition?.leads??[]){
    try{
      const descriptor=JSON.parse(raw[lead.metadataEvidenceId]),search=JSON.parse(raw[lead.searchArtifactId]),row=search.results[lead.resultIndex],e=bundle.evidence.find(item=>item.id===lead.metadataEvidenceId);
      if(!e||e.sourceId!=='attention-collector'||e.sourceType!=='INDEXED_LEAD'||e.accessMode!=='LOCAL_DERIVED'||!row||descriptor.searchArtifactId!==lead.searchArtifactId||descriptor.resultIndex!==lead.resultIndex||descriptor.url!==row.url||descriptor.title!==(row.title??'')||descriptor.snippet!==(row.snippet??'')||descriptor.normalizedUrl!==lead.url||lead.title!==descriptor.title||lead.snippet!==descriptor.snippet)throw Error();
    }catch{throw Error('CRITERION_SOURCE_INVALID');}
  }
  try{
    const search=JSON.parse(raw['attention-search-3']??'null');
    if(Array.isArray(search?.results))for(const [resultIndex,row] of search.results.entries())if(typeof row?.url==='string'&&!(read.comparisonAcquisition?.leads??[]).some(lead=>lead.searchArtifactId==='attention-search-3'&&lead.resultIndex===resultIndex)&&!read.codes.includes('ATT_DESCRIPTOR_CAP'))throw Error();
  }catch(error){if(!(error instanceof SyntaxError))throw Error('CRITERION_SOURCE_INVALID');}
  if(read.comparisonRecovery){
    const parents=requiredComparisonRecoveryParents(read.comparisonAcquisition?.leads??[]),selected=parents.slice(0,4),recovery=read.comparisonRecovery;
    if(JSON.stringify(recovery.selectedLeadIds)!==JSON.stringify(selected.map(lead=>lead.id))||recovery.recoveryQueries.length!==selected.length)throw Error('CRITERION_SOURCE_INVALID');
    for(const [index,query] of recovery.recoveryQueries.entries()){
      const parent=selected[index];if(!parent||query.parentLeadId!==parent.id||query.queryId!==`attention-recovery-search-${index+1}`||query.query!==indexedComparisonQuery(parent))throw Error('CRITERION_SOURCE_INVALID');
      try{const response=JSON.parse(raw[query.queryId]);if(Array.isArray(response.results))for(const [resultIndex,row] of response.results.entries())if(typeof row?.url==='string'&&!(read.criterionRecoveryMetadata??[]).some(item=>item.searchArtifactId===query.queryId&&item.resultIndex===resultIndex)&&!read.codes.includes('ATT_DESCRIPTOR_CAP'))throw Error();}catch(error){if(error instanceof SyntaxError){/* Failed search remains unavailable. */}else throw Error('CRITERION_SOURCE_INVALID');}
    }
    for(const descriptor of read.criterionRecoveryMetadata??[])try{
      const body=JSON.parse(raw[descriptor.id]),search=JSON.parse(raw[descriptor.searchArtifactId]),row=search.results[descriptor.resultIndex],e=bundle.evidence.find(item=>item.id===descriptor.id);
      const queryIndex=Number(descriptor.searchArtifactId.match(/-(\d+)$/)?.[1])-1;
      if(!e||e.sourceId!=='attention-collector'||e.sourceType!=='INDEXED_LEAD'||!row||body.originalLeadId!==selected[queryIndex]?.id||body.searchArtifactId!==descriptor.searchArtifactId||body.resultIndex!==descriptor.resultIndex||body.url!==row.url||body.title!==(row.title??'')||body.snippet!==(row.snippet??'')||body.normalizedUrl!==descriptor.url||descriptor.title!==body.title||descriptor.snippet!==body.snippet)throw Error();
    }catch{throw Error('CRITERION_SOURCE_INVALID');}
    try{
      const descriptors=(read.criterionRecoveryMetadata??[]).map(item=>({searchArtifactId:item.searchArtifactId,resultIndex:item.resultIndex,url:item.url}));
      const baseSources=read.sources.filter(source=>!source.id.startsWith('attention-recovery-'));
      const expected=comparisonRecoverySelection(descriptors,selected.map(lead=>({leadId:lead.id,originalUrl:lead.url})),[...baseSources.map(source=>source.url),...(read.comparisonAcquisition?.leads??[]).flatMap(lead=>lead.url?[lead.url]:[])],Math.min(8,attentionSourceLimit(read)-baseSources.length));
      const actual=JSON.parse(raw['attention-recovery-selection-scope']);
      if(JSON.stringify(actual.selectedUrls)!==JSON.stringify(expected.selectedUrls))throw Error();
    }catch{throw Error('CRITERION_SOURCE_INVALID');}
  }
  let cutoff:string;
  try{cutoff=JSON.parse(raw['criterion-receipt']).qualifiedAt;}catch{throw Error('CRITERION_PROOF_INVALID');}
  const age=Date.parse(bundle.cutoff)-Date.parse(cutoff);
  if(!Number.isFinite(age)||age<0||age>900000)throw Error('CRITERION_PROOF_INVALID');
  try{if(!read.acquisitionEvidenceMethod||JSON.stringify(buildAttentionAcquisitionScope(read,bundle.token,cutoff))!==JSON.stringify(read.acquisitionScope))throw Error('CRITERION_SOURCE_INVALID');}catch{throw Error('CRITERION_SOURCE_INVALID');}
  if(read.acquisitionPurposeMethod==='acquisition-purpose-v1'){
    const plan=readAcquisitionPurposePlan(raw,'PUBLIC_ENTRY',bundle.token);
    if(!owned('attention-acquisition-purpose-plan','attention-collector')||!validAcquisitionPurposePlan(plan,raw,'PUBLIC_ENTRY',bundle.token))throw Error('CRITERION_PROOF_REQUIRED');
    const rebuilt=buildPurposeAcquisition(attentionOperationFacts(read,bundle.token,cutoff,plan));
    if(!isDeepStrictEqual(rebuilt.projection,read.purposeProjection)||!isDeepStrictEqual(rebuilt.receipt,read.purposeReceipt))throw Error('CRITERION_PROJECTION_INVALID');
  }
  const failure=raw['criterion-failure']?JSON.parse(raw['criterion-failure']):null;
  if(failure&&!owned('criterion-failure','attention-collector'))throw Error('CRITERION_PROOF_REQUIRED');
  if(raw['criterion-draft-invalid']&&!owned('criterion-draft-invalid','attention-collector'))throw Error('CRITERION_PROOF_REQUIRED');
  if(raw['criterion-final-invalid']&&!owned('criterion-final-invalid','attention-collector'))throw Error('CRITERION_PROOF_REQUIRED');
  const blockedInput=buildCriterionInput(read,bundle.token,cutoff,[...criterionIds],read.criterionPolicyId??'research-screen-criteria-v1');
  const allBlocked=blockedInput.fastJudgmentMethod==='read-sources-v1'&&!blockedInput.sources.length||blockedInput.requiredIds.every(id=>!blockedInput.criterionScopes[id].complete);
  for(const stage of allBlocked?[]:['draft',...(raw['criterion-final-prompt']?['final']:[]),...(raw['criterion-correction-prompt']?['correction']:[])]){
    for(const suffix of ['prompt',...(raw[`criterion-${stage}-response`]?['response']:[])]){
      const id=`criterion-${stage}-${suffix}`,e=bundle.evidence.find(record=>record.id===id);
      if(!e||!sourceModelEvidenceAllowed(e,raw))throw Error('CRITERION_PROOF_REQUIRED');
    }
    if(!raw[`criterion-${stage}-response`]&&failure?.stage!==stage)throw Error('CRITERION_PROOF_REQUIRED');
    const attempts=Object.keys(raw).filter(id=>id.startsWith(`criterion-${stage}-transport-attempt-`));
    if((!attempts.length&&!(failure?.stage===stage&&['CRITERION_MODEL_PACKET_LIMIT','CRITERION_MODEL_RUN_TIMEOUT','CRITERION_MODEL_RUN_ABORTED'].includes(failure.code)))||attempts.some(id=>!owned(id,'source-model')))throw Error('CRITERION_PROOF_REQUIRED');
  }
  let receipt:ReturnType<typeof decodeCriterionAttention>;
  try{receipt=decodeCriterionAttention(read,bundle.token,cutoff,raw);}catch{throw Error('CRITERION_PROOF_INVALID');}
  if(receipt.generationMethod)throw Error('FAST_SINGLE_PROOF_INVALID');
  if(!isDeepStrictEqual(receipt,bundle.details?.criteria))throw Error('CRITERION_PROJECTION_INVALID');
  const input=buildCriterionInput(read,bundle.token,cutoff,receipt.results.map(r=>r.criterionId),receipt.policyId);
  for(const operation of input.operationArtifacts){const record=bundle.evidence.find(e=>e.id===operation.id);if(!record||!['attention-collector','tinyfish-fetch','tinyfish-search','firecrawl'].includes(record.sourceId))throw Error('CRITERION_PROOF_REQUIRED');}
  return {read,input,receipt};
}
