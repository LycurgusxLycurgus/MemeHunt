import {isDeepStrictEqual as same} from 'node:util';
import type {TokenRef,EvidenceRecord} from '../domain/contracts.js';
import {s18Instant} from './advisory-s18-study.js';
import {C07_METHOD,C07_PROFILE_SHA256,C07_PARENT_SHA256,C07_DISCOVERY_SHA256,C07_SOURCE_PLAN_SHA256,C07_COHORT,C07_WSOL,C07_START,C07_END,deriveC07LifecycleMetric,type C07StudyAttention,type C07StudyInput} from './advisory-c07-study.js';
import {reconstructC07Native} from './advisory-c07-native-source.js';
import {C07_SOURCE_ID,C07_SOURCE_PREFIX,C07_CAPTURE_ID,C07_ADAPTER,C07_PURPOSE,c07Hash as sha,c07Check as must,c07Fail,decodeC07Portable,c07Id,c07CaptureScope,c07RoleScope,type C07Receipt} from './advisory-c07-lifecycle-import.js';
export * from './advisory-c07-lifecycle-import.js';
export const c07Owns=(e:EvidenceRecord)=>e.id===C07_SOURCE_ID||e.id.startsWith(C07_SOURCE_PREFIX)||e.sourceId===C07_SOURCE_ID||e.adapterVersion===C07_ADAPTER;
const sec=(v:string)=>{const t=s18Instant(v);must(t!==null,'SOURCE_CLOCK');return t!/1000000000n;};
/** Reconstruct this frozen finite sample. No search projection is an all-X census, and
 * no provider's date-filter compliance or normalized qualification cache is assumed. */
function attention(texts:Map<string,string>,receipts:Map<string,C07Receipt>):C07StudyAttention[]{
 const seeds=JSON.parse(texts.get('status-seeds')!),hr=JSON.parse(texts.get('hydration-receipts')!).records,hs=JSON.parse(texts.get('hydration-scope')!),q=JSON.parse(texts.get('attention-qualification')!);
 must(Array.isArray(seeds.groups)&&seeds.groups.length===7&&Array.isArray(hr)&&hr.length===12&&hs.requests.length===12&&hs.seedSelectionSha256===sha(texts.get('status-seeds')!),'ATTENTION_CATALOG');
 must(q.contractSha256===C07_PROFILE_SHA256&&s18Instant(q.qualifiedAt)!>=s18Instant(receipts.get('hydration-receipts')!.retrievedAt)!,'QUALIFICATION_CLOCK');
 const seen=new Set<string>(),usedHydration=new Set<string>();
 const result=seeds.groups.map((g:any,i:number):C07StudyAttention=>{
  must(same(g.token,{chain:'solana',address:C07_COHORT[i][0]})&&g.queries.length===2,'QUERY_SUBJECT');
  const nativeIds=new Set<string>(),ids:string[]=[];
  for(const [j,query]of g.queries.entries()){
   const role='search-'+String(i*2+j).padStart(2,'0'),record=JSON.parse(texts.get(role)!);
   const expected=`site:${j===0?'x.com':'twitter.com'} ${g.token.address} after:2026-11-04 before:2026-11-06`;
   must(query.file===role+'.json'&&query.query===expected&&query.sha256===sha(texts.get(role)!)&&record.id===role&&record.query===expected&&same(record.token,g.token)&&record.sourceRepresentation==='TINYFISH_MCP_RETURNED_PROJECTION_NOT_ORIGINAL_HTTP_WIRE','QUERY_IDENTITY');
   must(record.result?.isError!==true&&record.result?.content?.length===1&&record.result.content[0].type==='text','QUERY_RESPONSE');
   const projection=JSON.parse(record.result.content[0].text);
   must(projection.query===expected&&Array.isArray(projection.results)&&projection.results.length<=10&&projection.total_results===projection.results.length&&projection.page===0&&query.results===projection.results.length,'FINITE_QUERY_RESULTS');
   const receipt=receipts.get(role)!;must(receipt.startedAt===record.startedAt&&receipt.retrievedAt===record.finishedAt&&same(receipt.request,{tool:'tinyfish.search',query:expected,topResults:10}),'QUERY_REQUEST');
   for(const hit of projection.results){
    const m=/^https:\/\/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]+)\/status\/([1-9][0-9]*)$/.exec(hit.url);
    if(m){nativeIds.add(m[2]);must(g.seeds[m[2]]?.urls.includes(hit.url),'SEED_MEMBERSHIP');}
    else must(/^https:\/\/x\.com\/[A-Za-z0-9_]+\/status\/[1-9][0-9]*\/photo\/1$/.test(hit.url)&&g.excludedReturnedUrls.some((e:any)=>e.url===hit.url&&e.searchRecord===query.file),'NON_STATUS_EXCLUSION');
   }ids.push(c07Id(role));
  }
  must(same([...nativeIds].sort(),Object.keys(g.seeds).sort()),'COMPLETE_STATUS_SEEDS');
  let missing=false;
  for(const status of nativeIds){
   must(!seen.has(status),'DUPLICATE_STATUS_ASSET');seen.add(status);
   const pair:any={};
   for(const provider of ['syndication','fxtwitter']){
    const role=status+'-'+provider,rr=hr.filter((r:any)=>r.id===status&&r.provider===provider),raw=texts.get(role)!;
    must(rr.length===1&&!usedHydration.has(role),'HYDRATION_CATALOG');usedHydration.add(role);const r=rr[0],receipt=receipts.get(role)!;
    must(r.status===200&&r.url===r.finalUrl&&r.bytes===Buffer.byteLength(raw)&&r.sha256===sha(raw)&&r.startedAt===receipt.startedAt&&r.retrievedAt===receipt.retrievedAt&&same(receipt.request,{method:'GET',url:r.url})&&hs.requests.filter((v:any)=>v.id===status&&v.provider===provider&&v.url===r.url).length===1,'HYDRATION_RECEIPT');
    if(provider==='syndication')must(r.url.startsWith('https://cdn.syndication.twimg.com/tweet-result?id='+status+'&lang=en&token='),'SYNDICATION_REQUEST');
    else must(r.url==='https://api.fxtwitter.com/'+g.seeds[status].urls[0].split('x.com/')[1],'FX_REQUEST');
    pair[provider]=JSON.parse(raw);ids.push(c07Id(role));
   }
   const sy=pair.syndication,fx=pair.fxtwitter,t=fx.tweet;
   must(fx.code===200&&sy.id_str===status&&t.id===status&&sy.user.id_str===t.author.id&&sy.user.screen_name===t.author.screen_name&&g.seeds[status].urls.includes(t.url),'NATIVE_POST_IDENTITY');
   must(Number.isSafeInteger(t.created_timestamp)&&s18Instant(sy.created_at)===BigInt(t.created_timestamp)*1000000000n&&Number.isFinite(Date.parse(t.created_at))&&Date.parse(t.created_at)===t.created_timestamp*1000,'NATIVE_PUBLICATION');
   must(typeof sy.text==='string'&&typeof t.raw_text?.text==='string','OWN_BODY_FIELDS');
   const outside=t.created_timestamp<1793822400||t.created_timestamp>=1793865600;
   if(outside)continue; // Both agreeing native publication clocks positively exclude this status.
   if(sy.text!==t.raw_text.text){missing=true;continue;}
   // This sole concordant in-range body is baseline-only. The other NX note remains
   // unresolved, so no accepted aggregate can be emitted for NX under this profile.
   must(status==='2118139164726329509'&&t.created_timestamp===1793838704&&sy.text.includes(g.token.address)&&sy.text.includes('5分钟内'),'FIXED_BASELINE_NEWS');
   must(q.posts.some((p:any)=>p.statusId===status&&p.disposition==='ACCEPTED_BASELINE_NEWS'&&p.accepted===true&&p.role==='NEWS'&&p.originalKind==='ORIGINAL'&&p.selectedOwnBody===sy.text),'BASELINE_QUALIFICATION');
  }
  // No semantically adopted current post is needed on the five complete finite samples:
  // each has zero status seeds or all seeds positively outside the source range.
  must(missing||[...nativeIds].every(id=>{const s=JSON.parse(texts.get(id+'-syndication')!);return sec(s.created_at)<1793822400n||sec(s.created_at)>=1793865600n;}),'UNQUALIFIED_IN_RANGE_POST');
  const status=missing?'MISSING':'COMPLETE',reason=missing?'OWN_BODY_CONCORDANCE_UNRESOLVED':null;
  return{status,reason,sourceIds:[...ids,c07Id('attention-qualification')],availableAt:q.qualifiedAt,windows:[{status,reason},{status,reason},{status,reason}],posts:[]};
 });
 must(seen.size===6&&usedHydration.size===12,'HYDRATION_EXHAUSTION');return result;
}
function reconstruct(texts:Map<string,string>,receipts:Map<string,C07Receipt>,packagedAt:string,cutoff:string):C07StudyInput{
 const contract=JSON.parse(texts.get('contract')!);
 must(sha(texts.get('contract')!)===C07_PROFILE_SHA256&&sha(texts.get('parent-selection')!)===C07_PARENT_SHA256&&sha(texts.get('source-plan')!)===C07_SOURCE_PLAN_SHA256&&sha(texts.get('discovery')!)===C07_DISCOVERY_SHA256,'PROFILE_PINS');
 const discovery=JSON.parse(texts.get('discovery')!);
 must(discovery.rows.length===7,'DISCOVERY_CATALOG');
 for(const [i,row]of discovery.rows.entries()){
  const role='dex-'+i,pairs=JSON.parse(texts.get(role)!);must(row.status===200&&row.sha256===sha(texts.get(role)!)&&row.bytes===Buffer.byteLength(texts.get(role)!)&&same(row.token,contract.cohort[i].token),'DISCOVERY_SOURCE');
  const eligible=pairs.filter((p:any)=>p.chainId==='solana'&&p.dexId==='pumpswap'&&p.baseToken?.address===row.token.address&&p.quoteToken?.address===C07_WSOL&&typeof p.pairAddress==='string'&&Number.isFinite(p.liquidity?.usd)&&p.liquidity.usd>=0).sort((a:any,b:any)=>b.liquidity.usd-a.liquidity.usd||a.pairAddress.localeCompare(b.pairAddress,'en'));
  must((eligible[0]?.pairAddress??null)===(contract.selectedPools[i].selected?.pool??null)&&same(row.selected,contract.selectedPools[i].selected),'FIXED_POOL_SELECTION');
 }
 const cap=JSON.parse(texts.get('native-capture')!),nativeReceipts=JSON.parse(texts.get('native-requests')!),raw=new Map<string,string>();
 for(const r of nativeReceipts){const role='native-'+r.id;must(texts.has(role),'NATIVE_SOURCE');raw.set(r.id,texts.get(role)!);const receipt=receipts.get(role)!;must(receipt.startedAt===r.startedAt&&receipt.retrievedAt===r.receivedAt&&receipt.httpStatus===r.httpStatus&&receipt.sourceBytes===r.sourceBytes&&receipt.sourceHash===r.sourceHash&&receipt.originalArchiveBytes===r.archiveBytes&&receipt.originalArchiveHash===r.archiveHash&&same(receipt.request,r.request),'NATIVE_ORIGINAL_RECEIPT');}
 const assets=reconstructC07Native(raw,cap,nativeReceipts),posts=attention(texts,receipts);
 return{method:C07_METHOD,profileSha256:C07_PROFILE_SHA256,parentSelectionSha256:C07_PARENT_SHA256,poolDiscoverySha256:C07_DISCOVERY_SHA256,sourcePlanSha256:C07_SOURCE_PLAN_SHA256,range:{start:C07_START,end:C07_END},packagedAt,evaluationCutoff:cutoff,assets:assets.map((a,i)=>({token:{chain:'solana' as const,address:a.token.address},pool:a.pool,quoteMint:C07_WSOL,quoteDecimals:9,native:{...a.native,sourceIds:a.native.sourceIds.map(id=>c07Id('native-'+id))},attention:posts[i]!}))};
}
function validateSource(token:TokenRef,cutoff:string,evidence:EvidenceRecord[],rawArtifacts:Record<string,string>){
 const owned=evidence.filter(c07Owns),capture=owned.find(e=>e.id===C07_CAPTURE_ID);must(capture&&owned.filter(e=>e.id===C07_CAPTURE_ID).length===1,'CAPTURE');const manifestRaw=rawArtifacts[C07_CAPTURE_ID];must(typeof manifestRaw==='string','CAPTURE');
 const m=JSON.parse(manifestRaw),sources:Record<string,string>={};for(const r of m.receipts??[])sources[r.role]=rawArtifacts[c07Id(r.role)]!;
 const{manifest,texts,receipts}=decodeC07Portable(manifestRaw,sources,cutoff);must(manifestRaw===JSON.stringify(manifest),'CAPTURE_CANONICAL');
 const ids=[C07_CAPTURE_ID,...manifest.receipts.map(r=>c07Id(r.role))];must(owned.length===ids.length&&new Set(owned.map(e=>e.id)).size===ids.length&&owned.every(e=>ids.includes(e.id))&&same(Object.keys(rawArtifacts).filter(id=>id===C07_SOURCE_ID||id.startsWith(C07_SOURCE_PREFIX)).sort(),[...ids].sort()),'OWNERSHIP');
 for(const e of owned){const r=e.id===C07_CAPTURE_ID?null:receipts.get(e.id.slice(C07_SOURCE_PREFIX.length));must(e.sourceId===C07_SOURCE_ID&&e.sourceType==='HISTORICAL_RECEIPT'&&e.adapterVersion===C07_ADAPTER&&e.accessMode==='USER_IMPORT'&&e.contentHash===sha(rawArtifacts[e.id]!)&&e.retrievedAt===e.availableAt&&e.retrievedAt===(r?r.retrievedAt:manifest.packagedAt)&&same(e.scope,r?c07RoleScope(r):c07CaptureScope()),'EVIDENCE');}
 const input=reconstruct(texts,receipts,manifest.packagedAt,cutoff);return{ids,input,metric:deriveC07LifecycleMetric(token,cutoff,input,new Set(ids))};
}
/** Every original source is revalidated even for a missing control or nonmember. */
export function validateC07LifecycleSource(token:TokenRef,cutoff:string,evidence:EvidenceRecord[],rawArtifacts:Record<string,string>){try{return validateSource(token,cutoff,evidence,rawArtifacts);}catch(e){if(e instanceof Error&&/^C07_LIFECYCLE_[A-Z_]+$/.test(e.message))throw e;return c07Fail('SOURCE_INVALID');}}
