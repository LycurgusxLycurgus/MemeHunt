import {isDeepStrictEqual} from 'node:util';
import type {CreatorRoleDecode} from './advisory-creator-role-collector.js';
import type {CreatorQuoteReceipts,decodeCreatorQuoteAccounting} from './advisory-creator-quote.js';
import type {decodeCreatorCoverage} from './advisory-creator-coverage.js';
import {creatorRouteRequest,type decodeCreatorRoutes} from './advisory-creator-routes.js';
import {reconcileCreatorRoute} from './advisory-creator-route-ledger.js';
import {solanaRpc,safeRpcCode} from './solana.js';
import {fetchReadResponse,readLimitedText} from './http.js';

export const CREATOR_EPISODE_METHOD='creator-only-closed-target-episode-v2';
export const CREATOR_EPISODE_REQUEST_CAP=4;
type Request={method:string;params:unknown[]}|ReturnType<typeof creatorRouteRequest>;
export type CreatorEpisodeReceipts={requests:Record<string,Request>;rawArtifacts:Record<string,string>;retrievedAt:Record<string,string>};
type Accounting=ReturnType<typeof decodeCreatorQuoteAccounting>;
type Routes=ReturnType<typeof decodeCreatorRoutes>;
type Coverage=ReturnType<typeof decodeCreatorCoverage>;
function bad(code:string):never{throw new Error(code);}
const indexRequest=(account:string,before:string)=>({method:'getSignaturesForAddress',params:[account,{limit:32,commitment:'finalized',before}]});
const txRequest=(signature:string)=>({method:'getTransaction',params:[signature,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:1}]});
const blockRequest=(slot:number)=>({method:'getBlock',params:[slot,{transactionDetails:'signatures',rewards:false,commitment:'finalized',maxSupportedTransactionVersion:1}]});
function buyContext(role:CreatorRoleDecode,a:Accounting,c:CreatorQuoteReceipts){
 const buys=a.records.filter(x=>x.side==='BUY');if(buys.length!==1)bad('S15V2_SINGLE_BUY_REQUIRED');const buy=buys[0]!;
 const id=Object.keys(c.requests).find(k=>c.requests[k]?.method==='getTransaction'&&c.requests[k]?.params[0]===buy.signature);if(!id)bad('S15V2_BUY_SOURCE_REQUIRED');
 const tx=JSON.parse(c.rawArtifacts[id!]!).result;
 const balances=tx.meta.preTokenBalances.filter((x:any)=>x.owner===role.binding!.wallet&&x.mint===role.binding!.creation.quoteMint);
 if(balances.length!==1)bad('S15V2_SINGLE_QUOTE_ACCOUNT_REQUIRED');
 return{buy,tx,account:tx.transaction.message.accountKeys[balances[0].accountIndex].pubkey as string};
}
function gcd(a:bigint,b:bigint):bigint{a=a<0n?-a:a;while(b){const n=a%b;a=b;b=n;}return a;}
function fraction(n:bigint,d:bigint){if(d<=0n)bad('S15V2_ARITHMETIC');const g=gcd(n,d);return{numerator:String(n/g),denominator:String(d/g)};}
function floor(n:bigint,d:bigint){return n>=0n?n/d:-((-n+d-1n)/d);}

/** A declared closed-episode principal result. All arguments are recomputed by the provenance decoder, never caller-supplied normalized facts. */
export function decodeCreatorEpisode(role:CreatorRoleDecode,a:Accounting,c:CreatorQuoteReceipts,routes:Routes|null,coverage:Coverage|null,r:CreatorEpisodeReceipts|null,cutoff:string){
 const base={method:CREATOR_EPISODE_METHOD,scope:'SIGNED_CREATOR_CLOSED_TARGET_EPISODE',policies:['SINGLE_LOT_UNIT_COST','FINANCING_NOT_BASIS','CLOSED_EPISODE_WINDOW'],completeCreatorPerformance:false,aggregateNetProfit:null};
 const missing=(reasonCode:string)=>({...base,status:'MISSING' as const,reasonCode});
 if(!r)return missing('S15V2_ACQUISITION_NOT_COLLECTED');
 const keys=Object.keys(r.requests),cut=Date.parse(cutoff);
 if(!Number.isFinite(cut)||keys.length>4||Object.values(r.rawArtifacts).some(raw=>Buffer.byteLength(raw)>500000)||keys.some(k=>!['index','transaction','helius','block'].includes(k))||!isDeepStrictEqual([...keys].sort(),Object.keys(r.rawArtifacts).sort())||!isDeepStrictEqual([...keys].sort(),Object.keys(r.retrievedAt).sort()))bad('ADVISORY_CREATOR_EPISODE_RECEIPT');
 const read=(id:string,request:Request)=>{
  if(!keys.includes(id))bad('S15V2_ACQUISITION_SOURCE_MISSING');
  const at=Date.parse(r.retrievedAt[id]??'');if(!isDeepStrictEqual(r.requests[id],request)||!Number.isFinite(at)||at>cut||Buffer.byteLength(r.rawArtifacts[id]!)>500000)bad('ADVISORY_CREATOR_EPISODE_RECEIPT');
  const value=JSON.parse(r.rawArtifacts[id]!);if(id==='helius')return value;
  if(value?.jsonrpc!=='2.0'||value.id!==1)bad('ADVISORY_CREATOR_EPISODE_RECEIPT');if(value.error||value.result==null)bad('S15V2_ACQUISITION_SOURCE_UNAVAILABLE');return value.result;
 };
 try{
  if(role.quality!=='KNOWN'||!role.binding||!routes?.canonicalComplete||!a.canonicalContinuity?.complete||!a.coverage.closedZeroAccount||!coverage?.wholeWalletComplete||!coverage.sourceComplete||!coverage.failedFees.payerCensusComplete)bad('S15V2_COMPLETE_POSITION_CENSUS_REQUIRED');
  const {buy,tx:buyTx,account}=buyContext(role,a,c),history=read('index',indexRequest(account,buy.signature));
  if(!Array.isArray(history)||!history.length||history.length>32)bad('S15V2_ACQUISITION_INDEX');
  const row=history[0];if(row.err!==null||row.confirmationStatus!=='finalized'||row.slot!==buy.slot||typeof row.signature!=='string'||row.signature===buy.signature)bad('S15V2_ADJACENT_SOL_LOT_REQUIRED');
  const tx=read('transaction',txRequest(row.signature)),h=read('helius',creatorRouteRequest(row.signature)),block=read('block',blockRequest(buy.slot));
  if(!Array.isArray(h)||h.length!==1||tx.slot!==buy.slot||tx.blockTime!==buyTx.blockTime||tx.blockTime!==row.blockTime||tx.transaction?.signatures?.[0]!==row.signature||block.blockTime!==tx.blockTime||!Array.isArray(block.signatures)||block.signatures.filter((x:string)=>x===row.signature).length!==1||block.signatures.filter((x:string)=>x===buy.signature).length!==1||block.signatures.indexOf(buy.signature)!==block.signatures.indexOf(row.signature)+1)bad('S15V2_ACQUISITION_ORDER');
  if(Object.values(r.retrievedAt).some(at=>Date.parse(at)<tx.blockTime*1000))bad('ADVISORY_CREATOR_EPISODE_RECEIPT');
  const acquisition=reconcileCreatorRoute(tx,h[0],role,a.account,null,account),lot=acquisition.acquisition;if(!lot)bad('S15V2_SOL_LOT_REQUIRED');if(lot!.legs.length!==2)bad('S15V2_TWO_LEG_ACQUISITION_REQUIRED');
  const bi=buyTx.transaction.message.accountKeys.findIndex((x:any)=>x.pubkey===account),pre=buyTx.meta.preTokenBalances.find((x:any)=>x.accountIndex===bi),post=buyTx.meta.postTokenBalances.find((x:any)=>x.accountIndex===bi);
  const nativeBuy=routes.records.find(x=>x.signature===buy.signature),sells=routes.records.filter(x=>x.side==='SELL'),closes=routes.records.filter(x=>x.side==='CLOSE');
  if(!nativeBuy||closes.length!==1||!sells.length||routes.records.length!==sells.length+2)bad('S15V2_SINGLE_CLOSED_EPISODE_REQUIRED');
  const close=closes[0]!;
  if(close.slot<=sells.at(-1)!.slot||BigInt(pre.uiTokenAmount.amount)!==BigInt(lot!.quoteAtomic)||(post?.uiTokenAmount.amount??'0')!=='0'||BigInt(lot!.quoteAtomic)!==BigInt(nativeBuy.pumpQuoteAtomic)+BigInt(nativeBuy.extraQuoteOutAtomic))bad('S15V2_QUOTE_LOT_CONTINUITY');
  if(routes.ledger.acquiredTargetAtomic!==routes.ledger.soldTargetAtomic||BigInt(routes.ledger.acquiredTargetAtomic)<=0n||coverage.canonicalCatalogAtomic!=='0'||coverage.targetSignatures.length!==routes.records.length||coverage.targetSignatures.some(s=>!routes.records.some(x=>x.signature===s))||routes.records.some(x=>x.slot<buy.slot||x.slot>close.slot))bad('S15V2_CLOSED_POSITION_REQUIRED');
  const failed=coverage.failedFees.classification!.rows;
  if(failed.some(x=>x.slot>=tx.slot&&x.slot<=close.slot))bad('S15V2_IN_EPISODE_FAILED_TRANSACTION_UNSUPPORTED');
  const principal=BigInt(lot!.inputSolLamports),whole=BigInt(lot!.quoteAtomic),quote=BigInt(nativeBuy.pumpQuoteAtomic),units=BigInt(routes.ledger.acquiredTargetAtomic),proceeds=BigInt(routes.ledger.grossSellSolLamports),n=principal*quote;
  if(principal<=0n||whole<=0n||quote<=0n||quote>whole)bad('S15V2_ARITHMETIC');
  if(sells.reduce((sum,s)=>sum+BigInt(s.targetAtomic),0n)!==units)bad('S15V2_DISPOSED_LOTS');
  return{...base,status:'KNOWN' as const,reasonCode:'S15V2_CLOSED_EPISODE_OBSERVED',completeCreatorPerformance:true,
   window:{acquisitionSignature:row.signature,acquisitionSlot:tx.slot,acquisitionBlockIndex:block.signatures.indexOf(row.signature),creationSignature:buy.signature,closeSignature:close.signature,closeSlot:close.slot,observedCatalogHeadSlot:coverage.headSlot},
   basis:{asset:'SOL',unit:'lamports',principalLamports:String(principal),quoteAcquiredAtomic:String(whole),targetQuoteAtomic:String(quote),targetLamports:fraction(n,whole),otherQuoteLamports:fraction(principal*(whole-quote),whole),displayCeilingLamports:String((n+whole-1n)/whole)},
   realized:{asset:'SOL',unit:'lamports',grossProceedsLamports:String(proceeds),resultLamports:fraction(proceeds*whole-n,whole),displayFloorLamports:String(floor(proceeds*whole-n,whole)),disposedLots:sells.map(s=>({signature:s.signature,targetAtomic:s.targetAtomic,basisLamports:fraction(n*BigInt(s.targetAtomic),whole*units),grossProceedsLamports:s.settlement!.grossSolLamports}))},
   acquisition,episodeTransactions:routes.records,
   outsideEpisode:{failedRows:failed,status:'ENUMERATED_ATTRIBUTION_UNRESOLVED',creatorChargedLamports:coverage.failedFees.creatorChargedLamports,targetAttribution:'UNRESOLVED_NOT_ZERO_OR_UNRELATED'},
   costs:{subtractedFromPrincipalResult:false,successfulCreatorNetworkFeeLamports:String(routes.records.reduce((sum,x)=>sum+BigInt(x.creatorNetworkFeeLamports),BigInt(acquisition.creatorNetworkFeeLamports))),acquisitionNonPrincipalNativePayments:acquisition.directNativePayments.filter(x=>x.destination!==acquisition.funding[0]!.account),acquisitionNativePaymentsClassification:'WSOL_PRINCIPAL_EXCLUDED_FROM_COST_ITEMS_OTHER_PAYMENTS_UNALLOCATED',unallocated:routes.unallocatedCosts,temporarySellRentReturnedLamports:routes.ledger.temporaryRentReturnedLamports},
   limitations:['Declared closed target-position principal result, not aggregate net, lifetime or whole-wallet profit.','Funding, direct costs, deposits/refunds and later failed fees are reported separately; outside-window exclusion does not establish economic unrelatedness.','Only one immediately preceding SOL-funded quote lot, one target buy, fully reconciled sells and one closed canonical account are supported.']};
 }catch(e){if(e instanceof Error&&e.message==='ADVISORY_CREATOR_EPISODE_RECEIPT')throw e;return missing(e instanceof Error&&/^(S15V2_|CREATOR_ROUTE_)[A-Z_]+$/.test(e.message)?e.message:'S15V2_ACQUISITION_UNRESOLVED');}
}

/** Four fixed bounded reads; public RPC plus one separate free-account parsed-event receipt. */
export async function collectCreatorEpisode(role:CreatorRoleDecode,a:Accounting,c:CreatorQuoteReceipts,rpcUrl:string,key:string,fetcher:typeof fetch=fetch,now=()=>new Date().toISOString(),signal?:AbortSignal):Promise<CreatorEpisodeReceipts>{
 const r:CreatorEpisodeReceipts={requests:{},rawArtifacts:{},retrievedAt:{}};
 if(!key||role.quality!=='KNOWN'||!a.canonicalContinuity?.complete)return r;
 const run=async(id:string,request:Request)=>{signal?.throwIfAborted();r.requests[id]=request;try{
  if('params' in request)r.rawArtifacts[id]=(await solanaRpc(rpcUrl,request.method,request.params,fetcher,500000,signal,undefined,15000)).raw;
  else{const response=await fetchReadResponse(`https://${request.host}${request.path}?api-key=${encodeURIComponent(key)}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request.body),signal},fetcher,15000);if(!response.ok){await response.body?.cancel();throw Error();}const raw=await readLimitedText(response,500000);if(raw.includes(key)||raw.includes(encodeURIComponent(key)))throw Error();r.rawArtifacts[id]=raw;}
 }catch(e){signal?.throwIfAborted();r.rawArtifacts[id]=JSON.stringify({jsonrpc:'2.0',id:1,error:{code:'params' in request?safeRpcCode(e):'SOURCE_UNAVAILABLE'}});}r.retrievedAt[id]=now();};
 try{const {buy,account}=buyContext(role,a,c);await run('index',indexRequest(account,buy.signature));const row=JSON.parse(r.rawArtifacts.index!).result?.[0];if(!row||row.err!==null||row.slot!==buy.slot)return r;await run('transaction',txRequest(row.signature));await run('helius',creatorRouteRequest(row.signature));await run('block',blockRequest(buy.slot));}catch{signal?.throwIfAborted();}
 return r;
}
