import type { TokenRef } from '../domain/contracts.js';
import type { AdvisoryMetric } from '../domain/advisory-contracts.js';
import { fetchReadResponse, readLimitedText } from './http.js';
import { safeRpcCode, solanaRpc } from './solana.js';
import { CREATOR_ROLE_RECEIPTS as R, creatorRolePageRequest, creatorRoleIndexRequest, creatorRoleTransactionRequest, creatorRoleRpcResult, creatorRoleIndexRows, publicCreatorClaim, verifyPublicCreatorRole, type CreatorRoleReceipts, type PublicCreatorRole } from './advisory-creator-role.js';

/** Bounded S13 creator-role collection: one coin page, one wallet index page and at most eight candidate transactions. */
export const CREATOR_CANDIDATE_CAP=8,CREATOR_DISCOVERY_SECONDS=120,CREATOR_RECEIPT_CAP=2+CREATOR_CANDIDATE_CAP;
const PAGE_BYTES=400_000,INDEX_BYTES=2_000_000,TRANSACTION_BYTES=500_000,INDEX_LIMIT=1000,CONCURRENCY=2;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const transactionKey=(i:number)=>`transaction-${i}`,iso=(seconds:number)=>new Date(seconds*1000).toISOString();
const message=(e:unknown,fallback:string)=>e instanceof Error&&/^CREATOR_ROLE_[A-Z_]{1,60}$/.test(e.message)?e.message:fallback;
type Candidate={signature:string;slot:number;blockTime:number};
type WalletDiscovery={ok:true;wallet:string;publishedDate:string;publishedSeconds:number}|{ok:false;code:string;wallet:string|null};
type CandidateDiscovery={ok:true;candidates:Candidate[];failedInWindow:string[];returned:number}|{ok:false;quality:'MISSING'|'TRUNCATED';code:string;candidates:Candidate[];failedInWindow:string[];returned:number|null};
export type CreatorRoleDecode={binding:PublicCreatorRole|null;quality:'KNOWN'|'MISSING'|'TRUNCATED'|'INVALID';reasonCode:string;data:Record<string,unknown>};

/** The page claim supplies the wallet; published_date is only a discovery hint, never creation evidence. */
function discoverWallet(mint:string,raw:string):WalletDiscovery{
 let v:any;try{v=JSON.parse(raw);}catch{return{ok:false,code:'CREATOR_ROLE_PAGE_SHAPE',wallet:null};}
 if(v!==null&&typeof v==='object'&&!Array.isArray(v)&&'error' in v&&!('results' in v)){const code=v.error?.code;return{ok:false,code:typeof code==='string'&&/^WEB_[A-Z0-9_]{1,40}$/.test(code)?code:'CREATOR_ROLE_PAGE_UNAVAILABLE',wallet:null};}
 let claim:ReturnType<typeof publicCreatorClaim>;
 try{claim=publicCreatorClaim(raw,mint);}catch(e){return{ok:false,code:message(e,'CREATOR_ROLE_PAGE_SHAPE'),wallet:null};}
 const date=claim.publishedDate,seconds=date!==null&&ISO.test(date)?Date.parse(date)/1000:NaN;
 if(!Number.isFinite(seconds))return{ok:false,code:'CREATOR_DISCOVERY_DATE_UNAVAILABLE',wallet:claim.wallet};
 return{ok:true,wallet:claim.wallet,publishedDate:date!,publishedSeconds:seconds};
}

/** Successful timestamped index rows within the discovery window, in index order; failed rows are disclosed, never selected. */
function discoverCandidates(raw:string,retrieved:number,published:number):CandidateDiscovery{
 let rows:ReturnType<typeof creatorRoleIndexRows>;
 try{rows=creatorRoleIndexRows(creatorRoleRpcResult(raw),retrieved);}catch(e){return{ok:false,quality:'MISSING',code:message(e,'CREATOR_ROLE_INDEX_SHAPE'),candidates:[],failedInWindow:[],returned:null};}
 const start=published-CREATOR_DISCOVERY_SECONDS,end=published+CREATOR_DISCOVERY_SECONDS,returned=rows.length;
 const inWindow=rows.filter(r=>r.blockTime!==null&&r.blockTime>=start&&r.blockTime<=end);
 const candidates=inWindow.filter(r=>r.err===null).map(r=>({signature:r.signature,slot:r.slot,blockTime:r.blockTime!})),failedInWindow=inWindow.filter(r=>r.err!==null).map(r=>r.signature);
 if(candidates.length>CREATOR_CANDIDATE_CAP)return{ok:false,quality:'TRUNCATED',code:'CREATOR_CANDIDATES_OVER_CAP',candidates,failedInWindow,returned};
 // Untimed rows or a full page that never reaches back past the window cannot exclude an unseen creation.
 if(rows.some(r=>r.blockTime===null))return{ok:false,quality:'TRUNCATED',code:'CREATOR_INDEX_UNTIMED_ROWS',candidates,failedInWindow,returned};
 if(rows.length>=INDEX_LIMIT&&!rows.some(r=>r.blockTime!<start))return{ok:false,quality:'TRUNCATED',code:'CREATOR_INDEX_WINDOW_NOT_REACHED',candidates,failedInWindow,returned};
 if(!candidates.length)return{ok:false,quality:'MISSING',code:'CREATOR_CANDIDATE_NONE',candidates,failedInWindow,returned};
 return{ok:true,candidates,failedInWindow,returned};
}

/** Uses the shared admitted fetcher only; never throws, and retains every response or safe error envelope with its completion clock. */
export async function collectCreatorRole(token:TokenRef,tinyfishKey:string,rpcUrl:string,fetcher:typeof fetch,now:()=>string,signal?:AbortSignal):Promise<CreatorRoleReceipts>{
 const r:CreatorRoleReceipts={rawArtifacts:{},retrievedAt:{},requests:{}};
 if(token.chain!=='solana')return r;
 const page=creatorRolePageRequest(token.address);r.requests.page=page;
 try{
  const response=await fetchReadResponse(page.url,{method:page.method,headers:{'X-API-Key':tinyfishKey,accept:'application/json','content-type':'application/json'},body:JSON.stringify(page.body),signal},fetcher,30_000);
  if(response.status!==200){await response.body?.cancel();r.rawArtifacts.page=JSON.stringify({error:{code:`WEB_FETCH_HTTP_${response.status}`}});}
  else r.rawArtifacts.page=await readLimitedText(response,PAGE_BYTES);
 }catch(e){r.rawArtifacts.page=JSON.stringify({error:{code:e instanceof Error&&e.message==='PROVIDER_RESPONSE_LIMIT'?'WEB_RESPONSE_LIMIT':'WEB_TRANSPORT'}});}
 r.retrievedAt.page=now();
 const wallet=discoverWallet(token.address,r.rawArtifacts.page);
 if(!wallet.ok||signal?.aborted)return r;
 const rpc=async(key:string,request:{method:string;params:unknown[]},maxBytes:number)=>{
  r.requests[key]=request;
  try{await solanaRpc(rpcUrl,request.method,request.params,fetcher,maxBytes,signal,raw=>{r.rawArtifacts[key]=raw;r.retrievedAt[key]=now();});}
  catch(e){if(r.rawArtifacts[key]===undefined){r.rawArtifacts[key]=JSON.stringify({jsonrpc:'2.0',id:1,error:{code:safeRpcCode(e)}});r.retrievedAt[key]=now();}}
 };
 await rpc('index',creatorRoleIndexRequest(wallet.wallet),INDEX_BYTES);
 const found=discoverCandidates(r.rawArtifacts.index!,Date.parse(r.retrievedAt.index!),wallet.publishedSeconds);
 if(!found.ok)return r;
 for(let i=0;i<found.candidates.length&&!signal?.aborted;i+=CONCURRENCY)await Promise.all(found.candidates.slice(i,i+CONCURRENCY).map((c,j)=>rpc(transactionKey(i+j),creatorRoleTransactionRequest(c.signature),TRANSACTION_BYTES)));
 return r;
}

/** Replays the exact discovery from frozen receipts and verifies each selected candidate with the pure role decoder. */
export function decodeCreatorRole(token:TokenRef,receipts:CreatorRoleReceipts,cutoff:string):CreatorRoleDecode{
 const invalid=():never=>{throw new Error('ADVISORY_CREATOR_ROLE_RECEIPT');};
 const keys=Object.keys(receipts.requests),cut=Date.parse(cutoff);
 if(token.chain!=='solana'||!Number.isFinite(cut)||!keys.length||keys.length>CREATOR_RECEIPT_CAP||JSON.stringify(Object.keys(receipts.rawArtifacts).sort())!==JSON.stringify([...keys].sort()))invalid();
 const at=(key:string)=>{const t=Date.parse(receipts.retrievedAt[key]??'');if(!Number.isFinite(t)||t>cut||typeof receipts.rawArtifacts[key]!=='string')invalid();return t;};
 if(JSON.stringify(receipts.requests.page)!==JSON.stringify(creatorRolePageRequest(token.address)))invalid();
 const pageAt=at('page'),page=receipts.rawArtifacts.page!;
 const base={method:'pump-public-creator-role-collection-v1',metadataDiscoveryHintUsed:true,metadataUsedAsBirthProof:false,windowSeconds:CREATOR_DISCOVERY_SECONDS,candidateCap:CREATOR_CANDIDATE_CAP,receipts:keys.length};
 const done=(quality:CreatorRoleDecode['quality'],reasonCode:string,extra:Record<string,unknown>,binding:PublicCreatorRole|null=null):CreatorRoleDecode=>({binding,quality,reasonCode,data:{...base,...extra}});
 const wallet=discoverWallet(token.address,page);
 if(!wallet.ok){if(keys.length!==1)invalid();return done('MISSING',wallet.code,{wallet:wallet.wallet});}
 const discovery={wallet:wallet.wallet,publishedDate:wallet.publishedDate,window:{start:iso(wallet.publishedSeconds-CREATOR_DISCOVERY_SECONDS),end:iso(wallet.publishedSeconds+CREATOR_DISCOVERY_SECONDS)}};
 if(!keys.includes('index')){if(keys.length!==1)invalid();return done('MISSING','CREATOR_INDEX_NOT_COLLECTED',discovery);}
 if(JSON.stringify(receipts.requests.index)!==JSON.stringify(creatorRoleIndexRequest(wallet.wallet)))invalid();
 const indexAt=at('index');if(indexAt<pageAt)invalid();
 const found=discoverCandidates(receipts.rawArtifacts.index!,indexAt,wallet.publishedSeconds);
 const listed={...discovery,indexReturned:found.returned,failedInWindow:found.failedInWindow};
 if(!found.ok){if(keys.length!==2)invalid();return done(found.quality,found.code,{...listed,candidates:found.candidates.map(c=>({...c,outcome:'NOT_SELECTED',code:null}))});}
 const expected=found.candidates.map((candidate,i)=>({key:transactionKey(i),candidate,request:creatorRoleTransactionRequest(candidate.signature)}));
 if(keys.some(k=>k!=='page'&&k!=='index'&&!expected.some(e=>e.key===k)))invalid();
 const outcomes=expected.map(({key,candidate,request})=>{
  if(!keys.includes(key))return{...candidate,outcome:'NOT_COLLECTED',code:null as string|null,role:null as PublicCreatorRole|null};
  if(JSON.stringify(receipts.requests[key])!==JSON.stringify(request)||at(key)<indexAt)invalid();
  try{
   const role=verifyPublicCreatorRole(token,{rawArtifacts:{[R.page]:page,[R.walletIndex]:receipts.rawArtifacts.index!,[R.transaction]:receipts.rawArtifacts[key]!},retrievedAt:{[R.page]:receipts.retrievedAt.page!,[R.walletIndex]:receipts.retrievedAt.index!,[R.transaction]:receipts.retrievedAt[key]!},requests:{[R.page]:receipts.requests.page,[R.walletIndex]:receipts.requests.index,[R.transaction]:request}},cutoff);
   return{...candidate,outcome:'VERIFIED_CREATION',code:null,role};
  }catch(e){const code=message(e,'CREATOR_ROLE_TRANSACTION_SHAPE');return{...candidate,outcome:code==='CREATOR_ROLE_NON_CREATE'?'NON_CREATE':code.endsWith('_CONTRADICTION')?'CONTRADICTED':'UNVERIFIED',code,role:null};}
 });
 const catalog={...listed,candidates:outcomes.map(({role:_role,...o})=>o)},verified=outcomes.filter(o=>o.role);
 if(outcomes.some(o=>o.outcome==='CONTRADICTED'))return done('INVALID','CREATOR_ROLE_CONTRADICTED',catalog);
 if(outcomes.some(o=>o.outcome==='UNVERIFIED'||o.outcome==='NOT_COLLECTED'))return done('TRUNCATED','CREATOR_CANDIDATE_UNVERIFIED',catalog);
 if(verified.length>1)return done('INVALID','CREATOR_CREATION_AMBIGUOUS',catalog);
 if(!verified.length)return done('MISSING','CREATOR_CREATION_NOT_FOUND',catalog);
 return done('KNOWN','PUBLIC_CREATOR_ROLE_BINDING_VERIFIED',catalog,verified[0]!.role);
}

/** S13 keeps every prior co-signing component; only one exact verified creation appends a public binding and sets KNOWN. */
export function creatorRoleS13(prior:AdvisoryMetric|undefined,role:CreatorRoleDecode,ids:string[]):AdvisoryMetric{
 const base:AdvisoryMetric=prior??{id:'S13',quality:'MISSING',unit:'separate inferred wallet edges',data:{publicActorBindings:[]},evidenceIds:[],reasonCode:'PUBLIC_ACTOR_WALLET_BINDING_UNAVAILABLE'};
 const data=base.data!==null&&typeof base.data==='object'&&!Array.isArray(base.data)?base.data as Record<string,unknown>:{};
 const bindings=Array.isArray(data.publicActorBindings)?data.publicActorBindings:[];
 const merged={...data,publicActorBindings:role.binding?[...bindings,role.binding]:bindings,creatorRole:{quality:role.quality,reasonCode:role.reasonCode,...role.data}};
 const evidenceIds=[...new Set([...base.evidenceIds,...ids])];
 return role.binding?{id:'S13',quality:'KNOWN',unit:'public actor bindings and separate inferred wallet edges',data:merged,evidenceIds,reasonCode:'PUBLIC_CREATOR_ROLE_BINDING_VERIFIED'}:{...base,id:'S13',data:merged,evidenceIds};
}
