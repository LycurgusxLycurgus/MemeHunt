import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { PUMP_AMM_SDK, PUMP_AMM_PROGRAM_ID, poolPda } from '@pump-fun/pump-swap-sdk';
import type { TokenRef } from '../domain/contracts.js';
import type { AdvisoryMetric } from '../domain/advisory-contracts.js';
import { pageRows, type SignatureRow } from './advisory-chain.js';
import { decodePumpSwapWindowTransaction, type DecodedTrade } from './advisory-trades.js';
import { decodeSolanaAddress, safeRpcCode, solanaRpc, SOLANA_MAINNET_GENESIS } from './solana.js';
import { PUMP_WINDOW_ABI_HASH,PUMP_WINDOW_ABI_SOURCE } from './pumpswap-window-abi.js';

type Request={method:string;params:unknown[]};
export type AdvisoryWindowReuse={rawArtifacts:Record<string,string>;retrievedAt:Record<string,string>;requests:Record<string,Request>};
type ReceiptSet=AdvisoryWindowReuse;
type Status='OBSERVED'|'UNAVAILABLE'|'INVALID'|'TRUNCATED';
export type AdvisoryWindowHistory={
 method:'pumpswap-selected-pool-window-v1'|'pumpswap-selected-pool-window-v2'|'pumpswap-selected-pool-window-v3';abi?:{source:string;sha256:string};token:TokenRef;pool:string|null;window:{start:string;end:string};
 genesisVerified:boolean;anchorSlot:number|null;anchorTime:string|null;poolVerified:boolean;stateSlot:number|null;coverageReachedStart:boolean;indexComplete:boolean;complete:boolean;sourceUniverseComplete:false;
 pages:Array<{id:string;returned:number;oldestAt:string|null;newestAt:string|null;exhausted:boolean;status:Status;code?:string}>;
 successfulSignatures:number;failedReferences:number;transactions:Array<{signature:string;slot:number;at:string;status:Status;code?:string;trades:number}>;
 trades:DecodedTrade[];buyQuoteAtomic:string;sellQuoteAtomic:string;netQuoteAtomic:string;foreignSwapLegs:number;nonSwapInvocations:number;cpiAuthorizedAccounts:string[];
 limitations:string[];reasonCode:string;
};
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const genesis:Request={method:'getGenesisHash',params:[]};
const anchorSlotRequest:Request={method:'getSlot',params:[{commitment:'finalized'}]};
const anchorTimeRequest=(slot:number):Request=>({method:'getBlockTime',params:[slot]});
const page=(pool:string,anchorSlot:number,before?:string):Request=>({method:'getSignaturesForAddress',params:[pool,{commitment:'finalized',limit:32,minContextSlot:anchorSlot,...(before?{before}:{})}]});
const transaction=(signature:string):Request=>({method:'getTransaction',params:[signature,{commitment:'finalized',encoding:'jsonParsed',maxSupportedTransactionVersion:1}]});
const state=(pool:string):Request=>({method:'getAccountInfo',params:[pool,{encoding:'base64',commitment:'finalized'}]});
const fail=(code:string):never=>{throw new Error(code);};
function scope(token:TokenRef,pool:string|null,end:string){
 if(token.chain!=='solana')fail('ADVISORY_WINDOW_SCOPE');
 decodeSolanaAddress(token.address);if(pool!==null)decodeSolanaAddress(pool);
 const endMs=Date.parse(end);if(!/^\d{4}-\d\d-\d\dT/.test(end)||!Number.isFinite(endMs)||endMs<3_600_000||endMs%3_600_000!==0)fail('ADVISORY_WINDOW_TIME');
 return {start:new Date(endMs-3_600_000).toISOString(),end};
}
function read(id:string,expected:Request,receipts:ReceiptSet,cutoff:string){
 if(JSON.stringify(receipts.requests[id])!==JSON.stringify(expected)||typeof receipts.rawArtifacts[id]!=='string')fail('ADVISORY_WINDOW_REQUEST');
 const at=Date.parse(receipts.retrievedAt[id]??'');if(!Number.isFinite(at)||at>Date.parse(cutoff))fail('ADVISORY_WINDOW_RECEIPT_TIME');
 const raw=JSON.parse(receipts.rawArtifacts[id]!);
 if(!object(raw)||raw.jsonrpc!=='2.0'||raw.id!==1)fail('ADVISORY_WINDOW_RECEIPT_SHAPE');
 if(raw.error){const c=raw.error.code;fail(typeof c==='string'&&/^RPC_[A-Z0-9_-]{1,50}$/.test(c)?c:Number.isSafeInteger(c)&&Math.abs(c)<=999999?`RPC_REMOTE_${c}`:'ADVISORY_WINDOW_REMOTE');}
 if(!Object.hasOwn(raw,'result'))fail('ADVISORY_WINDOW_RECEIPT_SHAPE');return{value:raw.result,at};
}
function errorCode(error:unknown){return error instanceof Error&&/^(ADVISORY_(?:WINDOW|TRADE)_[A-Z_]+|RPC_[A-Z0-9_-]{1,50})$/.test(error.message)?error.message:'ADVISORY_WINDOW_RECEIPT_INVALID';}
function bad(error:unknown){const code=errorCode(error);return {status:code.startsWith('RPC_')?'UNAVAILABLE' as const:'INVALID' as const,code};}
type Index={pages:AdvisoryWindowHistory['pages'];rows:SignatureRow[];reached:boolean;complete:boolean;used:Set<string>};
function index(pool:string,window:AdvisoryWindowHistory['window'],receipts:ReceiptSet,cutoff:string,anchorSlot:number,anchorRetrieved:number):Index{
 const result:Index={pages:[],rows:[],reached:false,complete:false,used:new Set()},seen=new Set<string>();let before:string|undefined,lastSlot=Infinity,lastAt=Infinity,lastRetrieved=0,unknown=false;
 for(let i=0;i<4;i++){
  const id=`window-page-${i}`;result.used.add(id);
  try{
   const response=read(id,page(pool,anchorSlot,before),receipts,cutoff),rows=pageRows(response.value,response.at);
   if(response.at<Date.parse(window.end)||response.at<anchorRetrieved||response.at<lastRetrieved)fail('ADVISORY_WINDOW_PAGE_TIME');
   for(const row of rows){if(seen.has(row.signature)||row.slot>lastSlot)fail('ADVISORY_WINDOW_PAGE_ORDER');if(row.blockTime!==null&&row.blockTime>lastAt)fail('ADVISORY_WINDOW_PAGE_ORDER');seen.add(row.signature);lastSlot=row.slot;if(row.blockTime===null)unknown=true;else lastAt=row.blockTime;}
   result.rows.push(...rows);lastRetrieved=response.at;
   const dates=rows.flatMap(r=>r.blockTime===null?[]:[new Date(r.blockTime*1000).toISOString()]);
   const exhausted=rows.length<32,older=rows.some(r=>r.blockTime!==null&&r.blockTime*1000<Date.parse(window.start));
   result.pages.push({id,returned:rows.length,oldestAt:dates.at(-1)??null,newestAt:dates[0]??null,exhausted,status:unknown?'TRUNCATED':'OBSERVED'});
   if(older||exhausted){result.reached=true;result.complete=!unknown;break;}
   before=rows.at(-1)!.signature;
  }catch(error){result.pages.push({id,returned:0,oldestAt:null,newestAt:null,exhausted:false,...bad(error)});break;}
 }
 return result;
}
function selectedRows(rows:SignatureRow[],window:AdvisoryWindowHistory['window']){return rows.filter(row=>row.err===null&&row.blockTime!==null&&row.blockTime*1000>=Date.parse(window.start)&&row.blockTime*1000<Date.parse(window.end));}

/** Rebuilds complete coverage of one declared finalized pool index window, not universal mint or wallet history. */
export function decodeAdvisoryWindow(token:TokenRef,pool:string|null,windowEnd:string,rawArtifacts:Record<string,string>,retrievedAt:Record<string,string>,requests:Record<string,Request>,cutoff:string,currentAbi=false,feeExclusive=false):AdvisoryWindowHistory{
 if(feeExclusive&&!currentAbi)fail('ADVISORY_WINDOW_FEE_SCOPE');
 const window=scope(token,pool,windowEnd),receipts={rawArtifacts,retrievedAt,requests};
 if(!Number.isFinite(Date.parse(cutoff))||Date.parse(windowEnd)>Date.parse(cutoff))fail('ADVISORY_WINDOW_TIME');
 const rawKeys=Object.keys(rawArtifacts).sort();if(rawKeys.length>48||JSON.stringify(rawKeys)!==JSON.stringify(Object.keys(requests).sort())||JSON.stringify(rawKeys)!==JSON.stringify(Object.keys(retrievedAt).sort()))fail('ADVISORY_WINDOW_RECEIPT_MEMBERSHIP');
 const result:AdvisoryWindowHistory={method:'pumpswap-selected-pool-window-v1',token,pool,window,genesisVerified:false,anchorSlot:null,anchorTime:null,poolVerified:false,stateSlot:null,coverageReachedStart:false,indexComplete:false,complete:false,sourceUniverseComplete:false,pages:[],successfulSignatures:0,failedReferences:0,transactions:[],trades:[],buyQuoteAtomic:'0',sellQuoteAtomic:'0',netQuoteAtomic:'0',foreignSwapLegs:0,nonSwapInvocations:0,cpiAuthorizedAccounts:[],reasonCode:'SELECTED_POOL_WINDOW_INCOMPLETE',limitations:['One selected pool and declared half-open hour only; other pools, venues and universal token activity are not covered.','WSOL quote notionals exclude fees and have no inferred historical USD conversion.','CPI-authorized program accounts and transaction signers are not proven economic persons; foreign pool legs are excluded.','No bot, common-control, organic-demand or inventory-history completeness is inferred.']};
 if(currentAbi){result.method='pumpswap-selected-pool-window-v2';result.abi={source:PUMP_WINDOW_ABI_SOURCE,sha256:PUMP_WINDOW_ABI_HASH};result.limitations.push('Pinned v2 swaps are quote flow; protocol/creator fee sweeps are classified non-trades and never enter buy/sell notionals. Recipient roles are verified within executed instructions, not public person or control bindings.');}
 if(feeExclusive){result.method='pumpswap-selected-pool-window-v3';result.limitations[result.limitations.length-1]='Pinned v2 swaps are quote flow; fee sweeps contribute zero notionals. Sweep recipients are checked for instruction/event consistency and associated-token-account derivation; creator/protocol economic roles and ownership are not independently verified.';result.limitations.push('The source IDL is a mutable public document pinned by hash; the upgradeable program deployed during this window is not independently version-attested. Runtime account/event/argument bindings are verified.','Instruction-specific core quote amounts reconcile LP, protocol and creator fees exactly. Buyback is not added to protocol fees again; cashback and holder-reward accounting without a supported identity prevents observation. Accrued creatorFeeUnclaimed is state, not a per-trade fee.');}
 const used=new Set(['window-genesis']);
 try{result.genesisVerified=read('window-genesis',genesis,receipts,cutoff).value===SOLANA_MAINNET_GENESIS;}catch(error){result.reasonCode=errorCode(error);}
 if(!result.genesisVerified||!pool){result.reasonCode=pool?result.reasonCode:'SELECTED_POOL_UNAVAILABLE';if(rawKeys.some(k=>!used.has(k)))fail('ADVISORY_WINDOW_RECEIPT_MEMBERSHIP');return result;}
 used.add('window-anchor-slot');used.add('window-anchor-time');let anchorRetrieved=0;
 try{
  const slot=read('window-anchor-slot',anchorSlotRequest,receipts,cutoff);if(!integer(slot.value)||slot.at<Date.parse(window.end))fail('ADVISORY_WINDOW_ANCHOR_INVALID');
  const time=read('window-anchor-time',anchorTimeRequest(slot.value),receipts,cutoff);if(!integer(time.value)||time.at<slot.at||time.value*1000<Date.parse(window.end)||time.value*1000>slot.at)fail('ADVISORY_WINDOW_ANCHOR_INVALID');
  result.anchorSlot=slot.value;result.anchorTime=new Date(time.value*1000).toISOString();anchorRetrieved=time.at;
 }catch(error){result.reasonCode=errorCode(error);if(rawKeys.some(k=>!used.has(k)))fail('ADVISORY_WINDOW_RECEIPT_MEMBERSHIP');return result;}
 const indexed=index(pool,window,receipts,cutoff,result.anchorSlot!,anchorRetrieved);result.pages=indexed.pages;result.coverageReachedStart=indexed.reached;result.indexComplete=indexed.complete;for(const id of indexed.used)used.add(id);
 const rows=selectedRows(indexed.rows,window);result.successfulSignatures=rows.length;
 result.failedReferences=indexed.rows.filter(row=>row.err!==null&&row.blockTime!==null&&row.blockTime*1000>=Date.parse(window.start)&&row.blockTime*1000<Date.parse(window.end)).length;
 if(rows.length>40)result.limitations.push('Successful transaction retention cap of 40 reached; the declared window is incomplete.');
 const selected=rows.slice(0,40);for(let i=0;i<selected.length;i++)used.add(`window-transaction-${i}`);used.add('window-pool');
 if(rawKeys.some(k=>!used.has(k)))fail('ADVISORY_WINDOW_RECEIPT_MEMBERSHIP');
 let decodedPool:ReturnType<typeof PUMP_AMM_SDK.decodePool>|null=null,poolAt=0;
 try{
  const response=read('window-pool',state(pool),receipts,cutoff),r=response.value,v=r?.value;
  if(response.at<Date.parse(window.end)||response.at<Math.max(...Object.entries(retrievedAt).filter(([id])=>id!=='window-pool').map(([,at])=>Date.parse(at)))||!integer(r?.context?.slot)||!object(v)||v.owner!==PUMP_AMM_PROGRAM_ID.toBase58()||v.executable!==false||!Array.isArray(v.data)||v.data[1]!=='base64'||typeof v.data[0]!=='string'||v.data[0].length>10000)fail('ADVISORY_WINDOW_POOL_SHAPE');
  const data=Buffer.from(v.data[0],'base64');if(data.toString('base64')!==v.data[0])fail('ADVISORY_WINDOW_POOL_SHAPE');
  decodedPool=PUMP_AMM_SDK.decodePool({data,owner:PUMP_AMM_PROGRAM_ID,lamports:0,executable:false,rentEpoch:0});
  if(decodedPool.baseMint.toBase58()!==token.address||!decodedPool.quoteMint.equals(NATIVE_MINT)||poolPda(decodedPool.index,decodedPool.creator,decodedPool.baseMint,decodedPool.quoteMint).toBase58()!==pool||r.context.slot<result.anchorSlot!||selected.some(row=>row.slot>r.context.slot))fail('ADVISORY_WINDOW_POOL_BINDING');
  result.poolVerified=true;result.stateSlot=r.context.slot;poolAt=response.at;
 }catch(error){result.reasonCode=errorCode(error);decodedPool=null;}
 for(const [i,row]of selected.entries()){
  const entry={signature:row.signature,slot:row.slot,at:new Date(row.blockTime!*1000).toISOString(),trades:0};
  try{
   const id=`window-transaction-${i}`,response=read(id,transaction(row.signature),receipts,cutoff),value=response.value;
   if(!decodedPool||result.stateSlot===null||response.at>poolAt||response.at<Date.parse(window.end)||response.at<row.blockTime!*1000||!object(value)||value.slot!==row.slot||value.blockTime!==row.blockTime||value.transaction?.signatures?.[0]!==row.signature||!value.transaction?.message?.accountKeys?.some((k:any)=>k.pubkey===pool))fail('ADVISORY_WINDOW_TRANSACTION_BINDING');
   const proof=decodePumpSwapWindowTransaction(value,entry,pool,decodedPool!,result.stateSlot!,retrievedAt[id]!,currentAbi,feeExclusive);
   result.transactions.push({...entry,status:'OBSERVED',trades:proof.trades.length});result.trades.push(...proof.trades);result.foreignSwapLegs+=proof.foreignSwapLegs;result.nonSwapInvocations+=proof.nonSwapInvocations;result.cpiAuthorizedAccounts.push(...proof.cpiAuthorizedAccounts);
  }catch(error){result.transactions.push({...entry,...bad(error)});}
 }
 result.cpiAuthorizedAccounts=[...new Set(result.cpiAuthorizedAccounts)].sort();result.trades.sort((a,b)=>a.slot-b.slot||a.signature.localeCompare(b.signature)||a.instructionIndex-b.instructionIndex);
 let buys=0n,sells=0n;for(const trade of result.trades){if(trade.side==='BUY')buys+=BigInt(trade.quoteAtomic);else sells+=BigInt(trade.quoteAtomic);}result.buyQuoteAtomic=String(buys);result.sellQuoteAtomic=String(sells);result.netQuoteAtomic=String(buys-sells);
 result.complete=result.indexComplete&&result.poolVerified&&rows.length<=40&&result.transactions.length===rows.length&&result.transactions.every(t=>t.status==='OBSERVED');
 if(result.complete)result.reasonCode='SELECTED_POOL_WINDOW_FLOW_OBSERVED';return result;
}

/** Bounded acquisition; reuse retains the original finalized raw envelope, request and clock. */
export async function collectAdvisoryWindow(token:TokenRef,pool:string|null,rpcUrl:string,fetcher:typeof fetch,now:()=>string,windowEnd:string,signal?:AbortSignal,reuse?:AdvisoryWindowReuse,currentAbi=true,feeExclusive=true):Promise<ReceiptSet&{data:AdvisoryWindowHistory}>{
 if(feeExclusive&&!currentAbi)fail('ADVISORY_WINDOW_FEE_SCOPE');
 const window=scope(token,pool,windowEnd),receipts:ReceiptSet={rawArtifacts:{},retrievedAt:{},requests:{}};
 const run=async(id:string,request:Request,reusable=false)=>{
  receipts.requests[id]=request;
  if(reusable&&reuse)for(const [key,oldRequest]of Object.entries(reuse.requests)){
   if(JSON.stringify(oldRequest)!==JSON.stringify(request))continue;
   try{read(key,request,reuse,now());receipts.rawArtifacts[id]=reuse.rawArtifacts[key]!;receipts.retrievedAt[id]=reuse.retrievedAt[key]!;return;}catch{/* Failed or invalid receipts cannot substitute for a fresh read. */}
  }
  try{await solanaRpc(rpcUrl,request.method,request.params,fetcher,500_000,signal,raw=>{receipts.rawArtifacts[id]=raw;receipts.retrievedAt[id]=now();});}
  catch(error){if(!receipts.rawArtifacts[id]){receipts.rawArtifacts[id]=JSON.stringify({jsonrpc:'2.0',id:1,error:{code:safeRpcCode(error)}});receipts.retrievedAt[id]=now();}}
 };
 await run('window-genesis',genesis,true);let verified=false;try{verified=read('window-genesis',genesis,receipts,now()).value===SOLANA_MAINNET_GENESIS;}catch{}
 if(verified&&pool){
  await run('window-anchor-slot',anchorSlotRequest);let anchorSlot:number|null=null,anchorRetrieved=0;
  try{const slot=read('window-anchor-slot',anchorSlotRequest,receipts,now());if(!integer(slot.value)||slot.at<Date.parse(window.end))fail('ADVISORY_WINDOW_ANCHOR_INVALID');await run('window-anchor-time',anchorTimeRequest(slot.value));const time=read('window-anchor-time',anchorTimeRequest(slot.value),receipts,now());if(!integer(time.value)||time.at<slot.at||time.value*1000<Date.parse(window.end)||time.value*1000>slot.at)fail('ADVISORY_WINDOW_ANCHOR_INVALID');anchorSlot=slot.value;anchorRetrieved=time.at;}catch{}
  if(anchorSlot===null)return {...receipts,data:decodeAdvisoryWindow(token,pool,windowEnd,receipts.rawArtifacts,receipts.retrievedAt,receipts.requests,now(),currentAbi,feeExclusive)};
  let before:string|undefined;
  for(let i=0;i<4;i++){
   const id=`window-page-${i}`;await run(id,page(pool,anchorSlot,before));
   try{const current=index(pool,window,receipts,now(),anchorSlot,anchorRetrieved),retained=current.pages.find(p=>p.id===id);if(!retained||retained.status==='INVALID'||retained.status==='UNAVAILABLE'||current.reached)break;const response=read(id,page(pool,anchorSlot,before),receipts,now()),rows=pageRows(response.value,response.at);before=rows.at(-1)!.signature;}catch{break;}
  }
  const indexed=index(pool,window,receipts,now(),anchorSlot,anchorRetrieved),selected=selectedRows(indexed.rows,window).slice(0,40);
  for(let offset=0;offset<selected.length;offset+=2)await Promise.all(selected.slice(offset,offset+2).map((row,j)=>run(`window-transaction-${offset+j}`,transaction(row.signature),true)));
  await run('window-pool',state(pool));
 }
 return {...receipts,data:decodeAdvisoryWindow(token,pool,windowEnd,receipts.rawArtifacts,receipts.retrievedAt,receipts.requests,now(),currentAbi,feeExclusive)};
}

export function deriveO28Window(data:AdvisoryWindowHistory,evidenceIds:string[]):AdvisoryMetric{
 return {id:'O28',quality:data.complete?'KNOWN':data.poolVerified&&data.transactions.some(t=>t.status==='OBSERVED')?'TRUNCATED':'MISSING',unit:'WSOL quote flow',data:{...data,scope:'VERIFIED_PUMPSWAP_WSOL_POOL',wholeTokenFlow:null,otherPools:'EXCLUDED',newCapital:null,quoteMint:NATIVE_MINT.toBase58(),quoteDecimals:9,uniqueBuyerAccounts:[...new Set(data.trades.filter(t=>t.side==='BUY').map(t=>t.user))].sort(),uniqueSellerAccounts:[...new Set(data.trades.filter(t=>t.side==='SELL').map(t=>t.user))].sort(),economicBuyerCount:null,economicSellerCount:null},evidenceIds:[...new Set(evidenceIds)],reasonCode:data.reasonCode};
}
