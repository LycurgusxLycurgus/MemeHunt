import { isDeepStrictEqual } from 'node:util';
import type { CreatorRoleDecode } from './advisory-creator-role-collector.js';
import { decodeCreatorQuoteAccounting, type CreatorQuoteReceipts } from './advisory-creator-quote.js';
import { fetchReadResponse, readLimitedText } from './http.js';
import { reconcileCreatorRoute } from './advisory-creator-route-ledger.js';

export const CREATOR_ROUTE_REQUEST_CAP=64,CREATOR_ROUTE_BYTES=6_000_000;
export const creatorRouteRequest=(signature:string)=>({method:'POST',host:'mainnet.helius-rpc.com',path:'/v1/parsed-events/transactions',body:{transactions:[signature],includeRawTransaction:true,commitment:'finalized'}});
export type CreatorRouteReceipts={requests:Record<string,ReturnType<typeof creatorRouteRequest>>;rawArtifacts:Record<string,string>;retrievedAt:Record<string,string>};
type Accounting=ReturnType<typeof decodeCreatorQuoteAccounting>;
const invalid=():never=>{throw new Error('ADVISORY_CREATOR_ROUTES_RECEIPT');};
function candidates(r:CreatorQuoteReceipts,accounting:Accounting){
 if(!accounting.coverage.indexComplete)return [];
 return (JSON.parse(r.rawArtifacts.index!).result as any[]).filter(x=>x.err===null);
}
/** Free-plan Parsed Events, one signature per bounded request. Auth never enters retained metadata or errors. */
export async function collectCreatorRoutes(accounting:Accounting,r:CreatorQuoteReceipts,key:string,fetcher:typeof fetch=fetch,now=()=>new Date().toISOString(),signal?:AbortSignal):Promise<CreatorRouteReceipts>{
 const out:CreatorRouteReceipts={requests:{},rawArtifacts:{},retrievedAt:{}};
 const rows=candidates(r,accounting);if(!key||!rows.length||rows.length>CREATOR_ROUTE_REQUEST_CAP)return out;
 let bytes=0;
 // Sequential acquisition avoids bursting the free RPC allowance; bounded recovery is owned by the HTTP adapter.
 for(const [i,row]of rows.entries()){
  signal?.throwIfAborted();const id=`transaction-${i}`,request=creatorRouteRequest(row.signature);let raw:string;
  try{
   const response=await fetchReadResponse(`https://${request.host}${request.path}?api-key=${encodeURIComponent(key)}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request.body),signal},fetcher,15000);
   if(!response.ok){await response.body?.cancel();throw new Error('SOURCE_UNAVAILABLE');}
   raw=await readLimitedText(response,500000);
   if(raw.includes(key)||raw.includes(encodeURIComponent(key)))throw new Error('SOURCE_UNAVAILABLE');
  }catch{signal?.throwIfAborted();raw=JSON.stringify({error:{code:'HELIUS_ROUTE_SOURCE_UNAVAILABLE'}});}
  if(bytes+Buffer.byteLength(raw)>CREATOR_ROUTE_BYTES)break;
  bytes+=Buffer.byteLength(raw);out.requests[id]=request;out.rawArtifacts[id]=raw;out.retrievedAt[id]=now();
 }
 return out;
}
/** Join only exact canonical signatures to verified native Pump accounting; partial rows never imply a complete ledger. */
export function decodeCreatorRoutes(role:CreatorRoleDecode,accounting:Accounting,canonical:CreatorQuoteReceipts,r:CreatorRouteReceipts,cutoff:string){
 const keys=Object.keys(r.requests),cut=Date.parse(cutoff),rows=candidates(canonical,accounting),used=new Set<string>();
 if(!Number.isFinite(cut)||keys.length>CREATOR_ROUTE_REQUEST_CAP||!isDeepStrictEqual(keys.sort(),Object.keys(r.rawArtifacts).sort())||!isDeepStrictEqual(keys.sort(),Object.keys(r.retrievedAt).sort())||Object.values(r.rawArtifacts).reduce((n,x)=>n+Buffer.byteLength(x),0)>CREATOR_ROUTE_BYTES)invalid();
 const records:ReturnType<typeof reconcileCreatorRoute>[]=[],unresolved:Array<{signature:string;code:string}>=[];
 for(const [i,row]of rows.entries()){
  const id=`transaction-${i}`;if(!keys.includes(id)){unresolved.push({signature:row.signature,code:'CREATOR_ROUTE_NOT_COLLECTED'});continue;}used.add(id);
  const at=Date.parse(r.retrievedAt[id]??'');
  if(!isDeepStrictEqual(r.requests[id],creatorRouteRequest(row.signature))||!Number.isFinite(at)||at>cut||at<row.blockTime*1000||Buffer.byteLength(r.rawArtifacts[id]!)>500000)invalid();
  try{
   const value=JSON.parse(r.rawArtifacts[id]!),tx=JSON.parse(canonical.rawArtifacts[id]!).result;
   if(tx?.slot!==row.slot||tx?.blockTime!==row.blockTime||tx?.transaction?.signatures?.[0]!==row.signature)invalid();
   if(!Array.isArray(value)||value.length!==1)throw new Error('CREATOR_ROUTE_SOURCE_UNAVAILABLE');
   records.push(reconcileCreatorRoute(tx,value[0],role,accounting.account,accounting.records.find(t=>t.signature===row.signature)??null));
  }catch(error){if(error instanceof Error&&error.message==='ADVISORY_CREATOR_ROUTES_RECEIPT')throw error;unresolved.push({signature:row.signature,code:error instanceof Error&&/^CREATOR_ROUTE_[A-Z_]+$/.test(error.message)?error.message:'CREATOR_ROUTE_RECONCILIATION_UNRESOLVED'});}
 }
 if(keys.some(k=>!used.has(k)))invalid();
 records.sort((a,b)=>a.slot-b.slot);
 const sum=(fn:(x:typeof records[number])=>string)=>records.reduce((n,x)=>n+BigInt(fn(x)),0n).toString();
 const complete=rows.length>0&&unresolved.length===0&&accounting.canonicalContinuity?.complete===true;
 return{method:'creator-native-route-ledger-v1',wallet:role.binding!.wallet,scope:'SIGNED_CREATOR_CANONICAL_TARGET_ACCOUNT',canonicalComplete:complete,expectedTransactions:rows.length,verifiedTransactions:records.length,unresolved,records,
  ledger:{quoteMint:role.binding!.creation.quoteMint,buyQuoteAtomic:sum(x=>x.side==='BUY'?x.pumpQuoteAtomic:'0'),soldTargetAtomic:sum(x=>x.side==='SELL'?x.targetAtomic:'0'),acquiredTargetAtomic:sum(x=>x.side==='BUY'?x.targetAtomic:'0'),grossSellSolLamports:sum(x=>x.settlement?.grossSolLamports??'0'),sellWalletNetSolLamports:sum(x=>x.side==='SELL'?x.walletNativeDeltaLamports:'0'),directTradeNetworkFeeLamports:sum(x=>x.side!=='CLOSE'?x.creatorNetworkFeeLamports:'0'),temporaryRentOutLamports:sum(x=>x.settlement?.temporaryRentLamports??'0'),temporaryRentReturnedLamports:sum(x=>x.settlement?.temporaryRentLamports??'0')},
  unallocatedCosts:{extraBuyQuotePaymentsAtomic:sum(x=>x.side==='BUY'?x.extraQuoteOutAtomic:'0'),directNativePaymentsLamports:sum(x=>x.directNativePaymentsLamports),accountFunding:records.flatMap(x=>x.funding.filter(f=>f.allocation!=='TEMPORARY_RENT_RETURNED').map(f=>({signature:x.signature,...f}))),accountRefunds:records.flatMap(x=>x.refunds.filter(f=>f.allocation==='SHARED_OR_OTHER_ACCOUNT_REFUND').map(f=>({signature:x.signature,...f}))),allocation:'UNALLOCATED_DO_NOT_SUBTRACT_AS_TARGET_COST'},
  realizedProfit:null,verifiedHistoricalConversion:null,completeCreatorPerformance:false};
}
