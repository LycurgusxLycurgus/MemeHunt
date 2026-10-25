import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, unpackMint } from '@solana/spl-token';
import { PUMP_AMM_SDK, PUMP_AMM_PROGRAM_ID, poolPda } from '@pump-fun/pump-swap-sdk';
import type { TokenRef } from '../domain/contracts.js';
import type { AdvisoryMetric } from '../domain/advisory-contracts.js';
import { pageRows, type SignatureRow } from './advisory-chain.js';
import { decodePumpSwapWindowTransaction, type DecodedTrade, type LogRecovery } from './advisory-trades.js';
import { archiveDemandReceipt, unpackDemandReceipt, DEMAND_ARCHIVE_METHOD } from './advisory-demand-windows.js';
import { decodeSolanaAddress, encodeSolanaAddress, safeRpcCode, solanaRpc, SOLANA_MAINNET_GENESIS, LEGACY_TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from './solana.js';
import { PUMP_WINDOW_ABI_HASH,PUMP_WINDOW_ABI_SOURCE,PUMP_WINDOW_V35_ABI_HASH,PUMP_WINDOW_V35_ABI_SOURCE,PUMP_WINDOW_V36_HOLDER_ABI_HASH,PUMP_WINDOW_V36_HOLDER_ABI_SOURCE } from './pumpswap-window-abi.js';

type Request={method:string;params:unknown[]};
export type AdvisoryWindowReuse={rawArtifacts:Record<string,string>;retrievedAt:Record<string,string>;requests:Record<string,Request>};
type ReceiptSet=AdvisoryWindowReuse;
type Status='OBSERVED'|'UNAVAILABLE'|'INVALID'|'TRUNCATED';
// Dense acquisition (opt-in, version-gated by the caller): 3 genesis/anchor + 4 pages + 64 transactions + 1 pool state.
export const WINDOW_RESPONSE_BYTES=500_000,WINDOW_DENSE_PAGE_LIMIT=256,WINDOW_DENSE_MAX_PAGES=4,WINDOW_DENSE_TRANSACTION_CAP=64;
export const WINDOW_DENSE_REQUEST_CAP=3+WINDOW_DENSE_MAX_PAGES+WINDOW_DENSE_TRANSACTION_CAP+1,WINDOW_DENSE_STORED_BYTES=1_250_000;
export const WINDOW_EXPANDED_PAGE_LIMIT=1000,WINDOW_EXPANDED_MAX_PAGES=16,WINDOW_EXPANDED_TRANSACTION_CAP=1024,WINDOW_EXPANDED_REQUEST_CAP=1045,WINDOW_EXPANDED_STORED_BYTES=8_000_000;
export const WINDOW_DENSE_VERSION='window-dense-v1' as const,WINDOW_ARCHIVE_ADAPTER='window-archive-v1' as const;
// Same text-decoding headroom as demand archives: a body read under the response cap re-encodes to at most three times its bytes.
export const WINDOW_ARCHIVE_SOURCE_BYTES=3*WINDOW_RESPONSE_BYTES;
export type AdvisoryWindowAcquisition={version:typeof WINDOW_DENSE_VERSION|'window-dense-v2';pageLimit:number;maxPages:number;transactionCap:number;requestCap:number;responseBytes:number;storedBytesCap:number;
 indexedReferences:number;newerReferences:number;witnessRow:number|null;stopCode:string|null};
export type AdvisoryWindowStorage={adapterVersion:typeof WINDOW_ARCHIVE_ADAPTER;archiveMethod:typeof DEMAND_ARCHIVE_METHOD;receipts:number;storedBytes:number;sourceBytes:number;storedBytesCap:number};
export type AdvisoryWindowHistory={
 method:'pumpswap-selected-pool-window-v1'|'pumpswap-selected-pool-window-v2'|'pumpswap-selected-pool-window-v3'|'pumpswap-selected-pool-window-v4'|'pumpswap-selected-pool-window-v5'|'pumpswap-selected-pool-window-v6';abi?:{source:string;sha256:string};quote?:{mint:string;decimals:number;program:string};token:TokenRef;pool:string|null;window:{start:string;end:string};
 // poolAdmission status 'CUSTOM_QUOTE' is only recorded on a modern (proof35) window whose non-WSOL quote is actually supported; legacy windows keep the exact SUPPORTED_WSOL/UNSUPPORTED_QUOTE values.
 genesisVerified:boolean;anchorSlot:number|null;anchorTime:string|null;poolVerified:boolean;stateSlot:number|null;coverageReachedStart:boolean;indexComplete:boolean;complete:boolean;sourceUniverseComplete:false;
 pages:Array<{id:string;returned:number;oldestAt:string|null;newestAt:string|null;exhausted:boolean;status:Status;code?:string}>;
 successfulSignatures:number;failedReferences:number;transactions:Array<{signature:string;slot:number;at:string;status:Status;code?:string;trades:number;logRecovery?:LogRecovery}>;
 trades:DecodedTrade[];buyQuoteAtomic:string;sellQuoteAtomic:string;netQuoteAtomic:string;foreignSwapLegs:number;nonSwapInvocations:number;cpiAuthorizedAccounts:string[];
 limitations:string[];reasonCode:string;acquisition?:AdvisoryWindowAcquisition;
 poolAdmission?:{quoteMint:string;status:'SUPPORTED_WSOL'|'UNSUPPORTED_QUOTE'|'CUSTOM_QUOTE'};
 logRecovery?:{truncatedTransactions:number;unresolvedNonFlowInvocations:number;emptyForeignSweeps:number};
};
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const genesis:Request={method:'getGenesisHash',params:[]};
const anchorSlotRequest:Request={method:'getSlot',params:[{commitment:'finalized'}]};
const anchorTimeRequest=(slot:number):Request=>({method:'getBlockTime',params:[slot]});
const page=(pool:string,anchorSlot:number,before?:string,limit=32):Request=>({method:'getSignaturesForAddress',params:[pool,{commitment:'finalized',limit,minContextSlot:anchorSlot,...(before?{before}:{})}]});
const transaction=(signature:string):Request=>({method:'getTransaction',params:[signature,{commitment:'finalized',encoding:'jsonParsed',maxSupportedTransactionVersion:1}]});
const state=(pool:string):Request=>({method:'getAccountInfo',params:[pool,{encoding:'base64',commitment:'finalized'}]});
const multi=(pool:string,quoteMint:string):Request=>({method:'getMultipleAccounts',params:[[pool,quoteMint],{encoding:'base64',commitment:'finalized'}]});
/** Modern final bank read decodes the exact requested quote mint account through the installed SPL unpackMint: it binds the account owner to its token program, requires a genuine initialized (SPL or Token-2022) mint account and reads only the immutable decimals. Current transfer-fee, hook or pause state is never read as a historical attestation. */
export function decodeWindowQuote(v:unknown,quoteMint:string):{mint:string;decimals:number;program:string}{
 if(!object(v)||(v.owner!==LEGACY_TOKEN_PROGRAM&&v.owner!==TOKEN_2022_PROGRAM)||v.executable!==false||!Array.isArray(v.data)||v.data[1]!=='base64'||typeof v.data[0]!=='string'||v.data[0].length>20000)throw new Error('ADVISORY_WINDOW_QUOTE_SHAPE');
 const data=Buffer.from(v.data[0],'base64');if(data.toString('base64')!==v.data[0])throw new Error('ADVISORY_WINDOW_QUOTE_SHAPE');
 const programId=new PublicKey(v.owner);
 const mint=(()=>{try{return unpackMint(new PublicKey(quoteMint),{data,owner:programId,executable:false,lamports:0,rentEpoch:0},programId);}catch{throw new Error('ADVISORY_WINDOW_QUOTE_SHAPE');}})();
 if(!mint.isInitialized)throw new Error('ADVISORY_WINDOW_QUOTE_SHAPE');
 return {mint:quoteMint,decimals:mint.decimals,program:v.owner as string};
}
const fail=(code:string):never=>{throw new Error(code);};
// Sanitized receipt that replaces a body whose archive would overflow the namespace ceiling; it never decodes as evidence.
const STORAGE_CAP_RECEIPT=JSON.stringify({jsonrpc:'2.0',id:1,error:{code:'ADVISORY_WINDOW_STORAGE_CAP'}});
const STORAGE_CAP_STORED=Buffer.byteLength(archiveDemandReceipt(STORAGE_CAP_RECEIPT));
const DENSE_LIMITATION='Dense acquisition: finalized 256-row signature pages (at most four) must reach an older witness without null clocks, and at most 64 successful references are read two at a time, before any transaction or pool state is read; otherwise the window stops incomplete with a reason code. Stored receipts are exact reversible archives under a 1,250,000-byte namespace ceiling; overflow is incomplete, never zero.';
function scope(token:TokenRef,pool:string|null,end:string){
 if(token.chain!=='solana')fail('ADVISORY_WINDOW_SCOPE');
 decodeSolanaAddress(token.address);if(pool!==null)decodeSolanaAddress(pool);
 const endMs=Date.parse(end);if(!/^\d{4}-\d\d-\d\dT/.test(end)||!Number.isFinite(endMs)||endMs<3_600_000||endMs%3_600_000!==0)fail('ADVISORY_WINDOW_TIME');
 return {start:new Date(endMs-3_600_000).toISOString(),end};
}
function read(id:string,expected:Request,receipts:ReceiptSet,cutoff:string,dense=false){
 if(JSON.stringify(receipts.requests[id])!==JSON.stringify(expected)||typeof receipts.rawArtifacts[id]!=='string')fail('ADVISORY_WINDOW_REQUEST');
 const at=Date.parse(receipts.retrievedAt[id]??'');if(!Number.isFinite(at)||at>Date.parse(cutoff))fail('ADVISORY_WINDOW_RECEIPT_TIME');
 const raw=JSON.parse(receipts.rawArtifacts[id]!);
 if(!object(raw)||raw.jsonrpc!=='2.0'||raw.id!==1)fail('ADVISORY_WINDOW_RECEIPT_SHAPE');
 if(dense&&receipts.rawArtifacts[id]===STORAGE_CAP_RECEIPT)fail('ADVISORY_WINDOW_STORAGE_CAP');
 if(raw.error){const c=raw.error.code;fail(typeof c==='string'&&/^RPC_[A-Z0-9_-]{1,50}$/.test(c)?c:Number.isSafeInteger(c)&&Math.abs(c)<=999999?`RPC_REMOTE_${c}`:'ADVISORY_WINDOW_REMOTE');}
 if(!Object.hasOwn(raw,'result'))fail('ADVISORY_WINDOW_RECEIPT_SHAPE');return{value:raw.result,at};
}
function errorCode(error:unknown){return error instanceof Error&&/^(ADVISORY_(?:WINDOW|TRADE)_[A-Z_]+|RPC_[A-Z0-9_-]{1,50})$/.test(error.message)?error.message:'ADVISORY_WINDOW_RECEIPT_INVALID';}
function bad(error:unknown){const code=errorCode(error);return {status:code.startsWith('RPC_')?'UNAVAILABLE' as const:'INVALID' as const,code};}
const BASE58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function canonicalSignature(text:unknown):text is string{
 if(typeof text!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(text))return false;
 let n=0n;for(const c of text)n=n*58n+BigInt(BASE58.indexOf(c));
 let hex=n.toString(16);if(hex.length%2)hex=`0${hex}`;
 const bytes=Buffer.concat([Buffer.alloc(text.match(/^1*/)![0].length),n===0n?Buffer.alloc(0):Buffer.from(hex,'hex')]);
 return bytes.length===64&&encodeSolanaAddress(bytes)===text;
}
/** Bounded local parser for dense pages only; the shared 32-row chain parser stays unchanged for chain and window-v3 replay. */
function densePageRows(value:unknown,retrieved:number,limit=WINDOW_DENSE_PAGE_LIMIT):SignatureRow[]{
 if(!Array.isArray(value)||value.length>limit)fail('ADVISORY_WINDOW_PAGE_SHAPE');
 const seen=new Set<string>();let previous=Infinity;
 return (value as unknown[]).map(v=>{
  if(!object(v)||!canonicalSignature(v.signature)||seen.has(v.signature)||!integer(v.slot)||v.slot>previous||!(v.blockTime===null||integer(v.blockTime)&&v.blockTime*1000<=retrieved)||!('err' in v)||!(v.err===null||object(v.err))||v.confirmationStatus!=='finalized')fail('ADVISORY_WINDOW_PAGE_SHAPE');
  const row=v as Record<string,any>;seen.add(row.signature);previous=row.slot;
  return {signature:row.signature as string,slot:row.slot as number,blockTime:row.blockTime as number|null,err:row.err};
 });
}
type Geometry={limit:number;rows:(value:unknown,retrieved:number)=>SignatureRow[];dense:boolean;maxPages?:number};
const LEGACY:Geometry={limit:32,rows:pageRows,dense:false},DENSE:Geometry={limit:WINDOW_DENSE_PAGE_LIMIT,rows:densePageRows,dense:true};
const EXPANDED:Geometry={limit:WINDOW_EXPANDED_PAGE_LIMIT,rows:(v,t)=>densePageRows(v,t,WINDOW_EXPANDED_PAGE_LIMIT),dense:true,maxPages:WINDOW_EXPANDED_MAX_PAGES};
type Index={pages:AdvisoryWindowHistory['pages'];rows:SignatureRow[];reached:boolean;complete:boolean;used:Set<string>;code:string|null};
function index(pool:string,window:AdvisoryWindowHistory['window'],receipts:ReceiptSet,cutoff:string,anchorSlot:number,anchorRetrieved:number,g:Geometry=LEGACY):Index{
 const result:Index={pages:[],rows:[],reached:false,complete:false,used:new Set(),code:null},seen=new Set<string>();let before:string|undefined,lastSlot=Infinity,lastAt=Infinity,lastRetrieved=0,unknown=false;
 for(let i=0;i<(g.maxPages??4);i++){
  const id=`window-page-${i}`;result.used.add(id);
  try{
   const response=read(id,page(pool,anchorSlot,before,g.limit),receipts,cutoff,g.dense),rows=g.rows(response.value,response.at);
   if(response.at<Date.parse(window.end)||response.at<anchorRetrieved||response.at<lastRetrieved)fail('ADVISORY_WINDOW_PAGE_TIME');
   for(const row of rows){if(seen.has(row.signature)||row.slot>lastSlot)fail('ADVISORY_WINDOW_PAGE_ORDER');if(row.blockTime!==null&&row.blockTime>lastAt)fail('ADVISORY_WINDOW_PAGE_ORDER');seen.add(row.signature);lastSlot=row.slot;if(row.blockTime===null)unknown=true;else lastAt=row.blockTime;}
   result.rows.push(...rows);lastRetrieved=response.at;
   const dates=rows.flatMap(r=>r.blockTime===null?[]:[new Date(r.blockTime*1000).toISOString()]);
   const exhausted=rows.length<g.limit,older=rows.some(r=>r.blockTime!==null&&r.blockTime*1000<Date.parse(window.start));
   result.pages.push({id,returned:rows.length,oldestAt:dates.at(-1)??null,newestAt:dates[0]??null,exhausted,status:unknown?'TRUNCATED':'OBSERVED'});
   // A dense index stops at its first null clock: it can no longer certify coverage, so further pages are not read.
   if(g.dense&&unknown){result.reached=older||exhausted;result.code='ADVISORY_WINDOW_NULL_CLOCK';break;}
   if(older||exhausted){result.reached=true;result.complete=!unknown;break;}
   before=rows.at(-1)!.signature;
  }catch(error){const failure=bad(error);result.pages.push({id,returned:0,oldestAt:null,newestAt:null,exhausted:false,...failure});result.code=failure.code;break;}
 }
 if(g.dense&&!result.reached&&!result.code)result.code='ADVISORY_WINDOW_PAGE_CAP';
 return result;
}
function selectedRows(rows:SignatureRow[],window:AdvisoryWindowHistory['window']){return rows.filter(row=>row.err===null&&row.blockTime!==null&&row.blockTime*1000>=Date.parse(window.start)&&row.blockTime*1000<Date.parse(window.end));}

/** Quote admission is separate from complete trade decoding; reject an unsupported quote before costly receipt reads. */
function admittedPool(receipts:ReceiptSet,cutoff:string,pool:string,token:TokenRef,anchor:number,rows:SignatureRow[]){
 const response=read('window-pool-check',state(pool),receipts,cutoff,true),r=response.value,v=r?.value;
 const prior=Math.max(...Object.entries(receipts.retrievedAt).filter(([id])=>id.startsWith('window-page-')||id==='window-anchor-time').map(([,at])=>Date.parse(at)));
 if(response.at<prior||!integer(r?.context?.slot)||r.context.slot<anchor||rows.some(row=>row.slot>r.context.slot)||!object(v)||v.owner!==PUMP_AMM_PROGRAM_ID.toBase58()||v.executable!==false||!Array.isArray(v.data)||v.data[1]!=='base64'||typeof v.data[0]!=='string'||v.data[0].length>10000)fail('ADVISORY_WINDOW_POOL_SHAPE');
 const data=Buffer.from(v.data[0],'base64');if(data.toString('base64')!==v.data[0])fail('ADVISORY_WINDOW_POOL_SHAPE');
 const decoded=PUMP_AMM_SDK.decodePool({data,owner:PUMP_AMM_PROGRAM_ID,lamports:0,executable:false,rentEpoch:0});
 if(decoded.baseMint.toBase58()!==token.address||poolPda(decoded.index,decoded.creator,decoded.baseMint,decoded.quoteMint).toBase58()!==pool)fail('ADVISORY_WINDOW_POOL_BINDING');
 return{quoteMint:decoded.quoteMint.toBase58(),status:decoded.quoteMint.equals(NATIVE_MINT)?'SUPPORTED_WSOL' as const:'UNSUPPORTED_QUOTE' as const};
}

const RECOVERY_LIMITATION='Terminal log truncation: a receipt with its single runtime "Log truncated" marker is retained only when guarded decoding proves every selected-pool flow frame closed before the marker, with no unbound or open invocation after it and no empty fee sweep; meta.err proves top-level success, and every other truncated, malformed or incomplete frame stays unobserved.';
const MODERN_RECOVERY_LIMITATION='Proof35 execution-proof recovery: a terminally truncated receipt is also retained when a Pump invocation recorded in the complete instruction trace - whether its frame opened before "Log truncated" or lies wholly after the marker - is proven executed, because a finalized meta.err-null transaction whose trace ancestry (resolved from stackHeights, not the open log stack) is entirely ordinary non-builtin SBF programs cannot have a failed callee (Agave v4.3.2 program-runtime/src/cpi.rs propagates a failed CPI via the ? operator and returns Ok(SUCCESS) only on success). Only a direct selected-pool swap bound once to its own buy/sell event-CPI child, or a canonical selected-disjoint close_user_volume_accumulator with its own close event-CPI child, is admitted; the unclosed-invocation count stays reported, and multi-hop buys and unknown roles remain unsupported.';
// The exact verified shape: truncation after the last flow frame, nothing unresolved and no empty sweep.
const terminalTruncation=(r:LogRecovery|undefined)=>r?.truncated===true&&r.unresolvedInvocations===(r.executionProvenInvocations??0)&&r.emptyForeignSweeps===0;
// Proof36 only: recorded once on a window that consumed any extended mode; a non-direct-quote window then becomes native v6, which the v3/v4-only native consumers fence.
const EXTENDED_LIMITATION=`Proof36 extended modes: a quote-transfer-taxed swap reconciles to exactly one Token-2022 TransferChecked or TransferCheckedWithFee witness binding mint, verified decimals, source, destination, authority and any explicit fee; BUY maximums and SELL minimums bind the wallet amount, and an exact-in budget remainder is never flow. v1 cashback is charged once inside the fee total. Multi-hop routes bind every PumpSwap hop event in order to its own pool, roles, chain link, fee mask and route endpoint; bonding-curve hops are identified by their curve PDA, add no event and are never priced. A truncated route is recovered only from its own immediate event-CPI children under ordinary SBF ancestry; a truncated direct swap is completed only from its own sole event-CPI child (byte-identical to its logged event when logged), and an open or unlogged foreign-pool direct swap is proven executed only by its own bound event-CPI child and adds no flow. The historical 16-byte holder appendix is pinned to ${PUMP_WINDOW_V36_HOLDER_ABI_SOURCE} (SHA-256 ${PUMP_WINDOW_V36_HOLDER_ABI_HASH}). A WSOL window that consumes any of these modes is native v6, outside the v3/v4-only native consumers.`;

/** Rebuilds complete coverage of one declared finalized pool index window, not universal mint or wallet history.
 * dense (requires feeExclusive) selects the bounded 256x4/64 acquisition geometry; without it the v3 replay path is unchanged.
 * expanded (requires dense) selects proof28 acquisition limits and verifies quote admission before any transaction download.
 * logRecovery (requires dense) is the O28-only v4 decode: strict receipts decode exactly as v3, and only a strict failure with terminal log truncation is retained.
 * extended (proof36, requires modern) admits the proof36-only modes; a non-v5 window that consumes any of them becomes native v6, which v3/v4-only consumers fence. */
export function decodeAdvisoryWindow(token:TokenRef,pool:string|null,windowEnd:string,rawArtifacts:Record<string,string>,retrievedAt:Record<string,string>,requests:Record<string,Request>,cutoff:string,currentAbi=false,feeExclusive=false,dense=false,logRecovery=false,expanded=false,modern=false,extended=false):AdvisoryWindowHistory{
 if(extended&&!modern)fail('ADVISORY_WINDOW_EXTENDED_SCOPE');
 if(feeExclusive&&!currentAbi)fail('ADVISORY_WINDOW_FEE_SCOPE');
 if(dense&&!feeExclusive)fail('ADVISORY_WINDOW_DENSE_SCOPE');
 if(expanded&&!dense)fail('ADVISORY_WINDOW_EXPANDED_SCOPE');
 if(logRecovery&&!dense)fail('ADVISORY_WINDOW_RECOVERY_SCOPE');
 if(modern&&!expanded)fail('ADVISORY_WINDOW_MODERN_SCOPE');
 const window=scope(token,pool,windowEnd),receipts={rawArtifacts,retrievedAt,requests},g=expanded?EXPANDED:dense?DENSE:LEGACY,transactionCap=expanded?WINDOW_EXPANDED_TRANSACTION_CAP:WINDOW_DENSE_TRANSACTION_CAP,requestCap=expanded?WINDOW_EXPANDED_REQUEST_CAP:WINDOW_DENSE_REQUEST_CAP,storedCap=expanded?WINDOW_EXPANDED_STORED_BYTES:WINDOW_DENSE_STORED_BYTES;
 if(!Number.isFinite(Date.parse(cutoff))||Date.parse(windowEnd)>Date.parse(cutoff))fail('ADVISORY_WINDOW_TIME');
 const rawKeys=Object.keys(rawArtifacts).sort();if(rawKeys.length>(dense?requestCap:48)||JSON.stringify(rawKeys)!==JSON.stringify(Object.keys(requests).sort())||JSON.stringify(rawKeys)!==JSON.stringify(Object.keys(retrievedAt).sort()))fail('ADVISORY_WINDOW_RECEIPT_MEMBERSHIP');
 const result:AdvisoryWindowHistory={method:'pumpswap-selected-pool-window-v1',token,pool,window,genesisVerified:false,anchorSlot:null,anchorTime:null,poolVerified:false,stateSlot:null,coverageReachedStart:false,indexComplete:false,complete:false,sourceUniverseComplete:false,pages:[],successfulSignatures:0,failedReferences:0,transactions:[],trades:[],buyQuoteAtomic:'0',sellQuoteAtomic:'0',netQuoteAtomic:'0',foreignSwapLegs:0,nonSwapInvocations:0,cpiAuthorizedAccounts:[],reasonCode:'SELECTED_POOL_WINDOW_INCOMPLETE',limitations:['One selected pool and declared half-open hour only; other pools, venues and universal token activity are not covered.','WSOL quote notionals exclude fees and have no inferred historical USD conversion.','CPI-authorized program accounts and transaction signers are not proven economic persons; foreign pool legs are excluded.','No bot, common-control, organic-demand or inventory-history completeness is inferred.']};
 if(currentAbi){result.method='pumpswap-selected-pool-window-v2';result.abi=modern?{source:PUMP_WINDOW_V35_ABI_SOURCE,sha256:PUMP_WINDOW_V35_ABI_HASH}:{source:PUMP_WINDOW_ABI_SOURCE,sha256:PUMP_WINDOW_ABI_HASH};result.limitations.push('Pinned v2 swaps are quote flow; protocol/creator fee sweeps are classified non-trades and never enter buy/sell notionals. Recipient roles are verified within executed instructions, not public person or control bindings.');}
 if(feeExclusive){result.method='pumpswap-selected-pool-window-v3';result.limitations[result.limitations.length-1]='Pinned v2 swaps are quote flow; fee sweeps contribute zero notionals. Sweep recipients are checked for instruction/event consistency and associated-token-account derivation; creator/protocol economic roles and ownership are not independently verified.';result.limitations.push('The source IDL is a mutable public document pinned by hash; the upgradeable program deployed during this window is not independently version-attested. Runtime account/event/argument bindings are verified.','Instruction-specific core quote amounts reconcile LP, protocol and creator fees exactly. Buyback is not added to protocol fees again; cashback and holder-reward accounting without a supported identity prevents observation. Accrued creatorFeeUnclaimed is state, not a per-trade fee.');}
 if(logRecovery){result.method='pumpswap-selected-pool-window-v4';result.limitations.push(RECOVERY_LIMITATION);if(modern)result.limitations.push(MODERN_RECOVERY_LIMITATION);result.logRecovery={truncatedTransactions:0,unresolvedNonFlowInvocations:0,emptyForeignSweeps:0};}
 if(dense){result.limitations.push(expanded?'Expanded acquisition: finalized cursor-linked 1000-row pages (at most16),1024 successful selected-hour receipts, two concurrent reads,500KB per response and8MB stored namespace. Every selected receipt must decode; missing/capped/unsupported evidence remains incomplete.':DENSE_LIMITATION);result.acquisition={version:expanded?'window-dense-v2':WINDOW_DENSE_VERSION,pageLimit:g.limit,maxPages:g.maxPages??4,transactionCap,requestCap,responseBytes:WINDOW_RESPONSE_BYTES,storedBytesCap:storedCap,indexedReferences:0,newerReferences:0,witnessRow:null,stopCode:null};}
 // A receipt replaced at the namespace ceiling leaves the whole dense window incomplete under one precise reason.
 const capped=dense&&Object.values(rawArtifacts).includes(STORAGE_CAP_RECEIPT);
 const settle=()=>{if(capped&&!result.complete){result.reasonCode='ADVISORY_WINDOW_STORAGE_CAP';result.acquisition!.stopCode=result.reasonCode;}return result;};
 const used=new Set(['window-genesis']);
 try{result.genesisVerified=read('window-genesis',genesis,receipts,cutoff,dense).value===SOLANA_MAINNET_GENESIS;}catch(error){result.reasonCode=errorCode(error);}
 if(!result.genesisVerified||!pool){result.reasonCode=pool?result.reasonCode:'SELECTED_POOL_UNAVAILABLE';if(rawKeys.some(k=>!used.has(k)))fail('ADVISORY_WINDOW_RECEIPT_MEMBERSHIP');return settle();}
 used.add('window-anchor-slot');used.add('window-anchor-time');let anchorRetrieved=0;
 try{
  const slot=read('window-anchor-slot',anchorSlotRequest,receipts,cutoff,dense);if(!integer(slot.value)||slot.at<Date.parse(window.end))fail('ADVISORY_WINDOW_ANCHOR_INVALID');
  const time=read('window-anchor-time',anchorTimeRequest(slot.value),receipts,cutoff,dense);if(!integer(time.value)||time.at<slot.at||time.value*1000<Date.parse(window.end)||time.value*1000>slot.at)fail('ADVISORY_WINDOW_ANCHOR_INVALID');
  result.anchorSlot=slot.value;result.anchorTime=new Date(time.value*1000).toISOString();anchorRetrieved=time.at;
 }catch(error){result.reasonCode=errorCode(error);if(rawKeys.some(k=>!used.has(k)))fail('ADVISORY_WINDOW_RECEIPT_MEMBERSHIP');return settle();}
 const indexed=index(pool,window,receipts,cutoff,result.anchorSlot!,anchorRetrieved,g);result.pages=indexed.pages;result.coverageReachedStart=indexed.reached;result.indexComplete=indexed.complete;for(const id of indexed.used)used.add(id);
 const rows=selectedRows(indexed.rows,window);result.successfulSignatures=rows.length;
 result.failedReferences=indexed.rows.filter(row=>row.err!==null&&row.blockTime!==null&&row.blockTime*1000>=Date.parse(window.start)&&row.blockTime*1000<Date.parse(window.end)).length;
 if(dense){const witness=indexed.rows.findIndex(r=>r.blockTime!==null&&r.blockTime*1000<Date.parse(window.start));Object.assign(result.acquisition!,{indexedReferences:indexed.rows.length,newerReferences:indexed.rows.filter(r=>r.blockTime!==null&&r.blockTime*1000>=Date.parse(window.end)).length,witnessRow:witness<0?null:witness+1});}
 // Dense collection reads no transaction or pool state after an incomplete index or over-cap hour, so replay admits none.
 if(expanded&&indexed.complete){
  used.add('window-pool-check');
  try{result.poolAdmission=admittedPool(receipts,cutoff,pool,token,result.anchorSlot!,rows);if(!modern&&result.poolAdmission.status==='UNSUPPORTED_QUOTE')fail('ADVISORY_WINDOW_QUOTE_UNSUPPORTED');if(modern&&result.poolAdmission.status==='UNSUPPORTED_QUOTE')result.poolAdmission={...result.poolAdmission,status:'CUSTOM_QUOTE'};}
  catch(error){if(rawKeys.some(k=>!used.has(k)))fail('ADVISORY_WINDOW_RECEIPT_MEMBERSHIP');result.reasonCode=errorCode(error);result.acquisition!.stopCode=result.reasonCode;return settle();}
 }
 const stop=!dense?null:!indexed.complete?indexed.code??'ADVISORY_WINDOW_INDEX_INCOMPLETE':rows.length>transactionCap?'ADVISORY_WINDOW_TRANSACTION_CAP':null;
 if(stop){
  if(stop==='ADVISORY_WINDOW_TRANSACTION_CAP')result.limitations.push(`Successful transaction cap of ${transactionCap} exceeded; no transaction or pool state was read and the declared window is incomplete.`);
  if(rawKeys.some(k=>!used.has(k)))fail('ADVISORY_WINDOW_RECEIPT_MEMBERSHIP');
  result.reasonCode=stop;result.acquisition!.stopCode=stop;return settle();
 }
 if(!dense&&rows.length>40)result.limitations.push('Successful transaction retention cap of 40 reached; the declared window is incomplete.');
 const selected=dense?rows:rows.slice(0,40);for(let i=0;i<selected.length;i++)used.add(`window-transaction-${i}`);used.add('window-pool');
 if(rawKeys.some(k=>!used.has(k)))fail('ADVISORY_WINDOW_RECEIPT_MEMBERSHIP');
 let decodedPool:ReturnType<typeof PUMP_AMM_SDK.decodePool>|null=null,poolAt=0;
 try{
  const response=read('window-pool',modern?multi(pool,result.poolAdmission!.quoteMint):state(pool),receipts,cutoff,dense),r=response.value,v=modern?r?.value?.[0]:r?.value;
  if(response.at<Date.parse(window.end)||response.at<Math.max(...Object.entries(retrievedAt).filter(([id])=>id!=='window-pool').map(([,at])=>Date.parse(at)))||!integer(r?.context?.slot)||(modern&&(!Array.isArray(r.value)||r.value.length!==2))||!object(v)||v.owner!==PUMP_AMM_PROGRAM_ID.toBase58()||v.executable!==false||!Array.isArray(v.data)||v.data[1]!=='base64'||typeof v.data[0]!=='string'||v.data[0].length>10000)fail('ADVISORY_WINDOW_POOL_SHAPE');
  const data=Buffer.from(v.data[0],'base64');if(data.toString('base64')!==v.data[0])fail('ADVISORY_WINDOW_POOL_SHAPE');
  decodedPool=PUMP_AMM_SDK.decodePool({data,owner:PUMP_AMM_PROGRAM_ID,lamports:0,executable:false,rentEpoch:0});
  if(decodedPool.baseMint.toBase58()!==token.address||(modern&&result.poolAdmission!.quoteMint!==decodedPool.quoteMint.toBase58())||(!modern&&!decodedPool.quoteMint.equals(NATIVE_MINT))||poolPda(decodedPool.index,decodedPool.creator,decodedPool.baseMint,decodedPool.quoteMint).toBase58()!==pool||r.context.slot<result.anchorSlot!||selected.some(row=>row.slot>r.context.slot))fail('ADVISORY_WINDOW_POOL_BINDING');
  if(modern){result.quote=decodeWindowQuote(r.value?.[1],decodedPool.quoteMint.toBase58());if(result.quote.mint!==NATIVE_MINT.toBase58()){result.method='pumpswap-selected-pool-window-v5';result.limitations[1]=`Quote notionals are exact fee-exclusive core in the pool quote mint ${result.quote.mint} atomic units (${result.quote.decimals} decimals verified from the quote mint account) and have no inferred historical USD conversion.`;result.limitations.push('Direct non-WSOL quote pool: WSOL-only inventory, demand, automation and exit-capacity metrics stay scoped out and remain MISSING independently.');}}
  result.poolVerified=true;result.stateSlot=r.context.slot;poolAt=response.at;
 }catch(error){result.reasonCode=errorCode(error);decodedPool=null;}
 let extendedLegs=0;
 for(const [i,row]of selected.entries()){
  const entry={signature:row.signature,slot:row.slot,at:new Date(row.blockTime!*1000).toISOString(),trades:0};
  try{
   const id=`window-transaction-${i}`,response=read(id,transaction(row.signature),receipts,cutoff,dense),value=response.value;
   if(!decodedPool||result.stateSlot===null||response.at>poolAt||response.at<Date.parse(window.end)||response.at<row.blockTime!*1000||!object(value)||value.slot!==row.slot||value.blockTime!==row.blockTime||value.transaction?.signatures?.[0]!==row.signature||!value.transaction?.message?.accountKeys?.some((k:any)=>k.pubkey===pool))fail('ADVISORY_WINDOW_TRANSACTION_BINDING');
   const strict=()=>decodePumpSwapWindowTransaction(value,entry,pool,decodedPool!,result.stateSlot!,retrievedAt[id]!,currentAbi,feeExclusive,false,false,false,modern,result.quote?.program,extended,result.quote?.decimals);
   const hasTruncationMarker=Array.isArray(value.meta?.logMessages)&&value.meta.logMessages.includes('Log truncated');
   const proof=!logRecovery||!hasTruncationMarker?strict():(()=>{
    const recovered=decodePumpSwapWindowTransaction(value,entry,pool,decodedPool!,result.stateSlot!,retrievedAt[id]!,currentAbi,feeExclusive,true,false,false,modern,result.quote?.program,extended,result.quote?.decimals);
    if(!terminalTruncation(recovered.logRecovery))fail('ADVISORY_TRADE_LOG_TRUNCATED');
    result.logRecovery!.truncatedTransactions++;return recovered;
   })();
   result.transactions.push({...entry,status:'OBSERVED',trades:proof.trades.length,...(proof.logRecovery?{logRecovery:proof.logRecovery}:{})});result.trades.push(...proof.trades);result.foreignSwapLegs+=proof.foreignSwapLegs;result.nonSwapInvocations+=proof.nonSwapInvocations;result.cpiAuthorizedAccounts.push(...proof.cpiAuthorizedAccounts);extendedLegs+=proof.extendedLegs??0;
  }catch(error){result.transactions.push({...entry,...bad(error)});}
 }
 if(extendedLegs>0){if(result.method!=='pumpswap-selected-pool-window-v5')result.method='pumpswap-selected-pool-window-v6';result.limitations.push(EXTENDED_LIMITATION);}
 result.cpiAuthorizedAccounts=[...new Set(result.cpiAuthorizedAccounts)].sort();result.trades.sort((a,b)=>a.slot-b.slot||a.signature.localeCompare(b.signature)||a.instructionIndex-b.instructionIndex);
 let buys=0n,sells=0n;for(const trade of result.trades){if(trade.side==='BUY')buys+=BigInt(trade.quoteAtomic);else sells+=BigInt(trade.quoteAtomic);}result.buyQuoteAtomic=String(buys);result.sellQuoteAtomic=String(sells);result.netQuoteAtomic=String(buys-sells);
 result.complete=result.indexComplete&&result.poolVerified&&rows.length<=(dense?transactionCap:40)&&result.transactions.length===rows.length&&result.transactions.every(t=>t.status==='OBSERVED');
 if(result.complete)result.reasonCode='SELECTED_POOL_WINDOW_FLOW_OBSERVED';return settle();
}

/** Bounded acquisition; reuse retains the original finalized raw envelope, request and clock.
 * dense returns plain receipts for in-run consumers while metering their archive size against the namespace ceiling. */
export async function collectAdvisoryWindow(token:TokenRef,pool:string|null,rpcUrl:string,fetcher:typeof fetch,now:()=>string,windowEnd:string,signal?:AbortSignal,reuse?:AdvisoryWindowReuse,currentAbi=true,feeExclusive=true,dense=false,logRecovery=false,expanded=false,modern=false,extended=false):Promise<ReceiptSet&{data:AdvisoryWindowHistory}>{
 if(extended&&!modern)fail('ADVISORY_WINDOW_EXTENDED_SCOPE');
 if(feeExclusive&&!currentAbi)fail('ADVISORY_WINDOW_FEE_SCOPE');
 if(dense&&!feeExclusive)fail('ADVISORY_WINDOW_DENSE_SCOPE');
 if(expanded&&!dense)fail('ADVISORY_WINDOW_EXPANDED_SCOPE');
 if(logRecovery&&!dense)fail('ADVISORY_WINDOW_RECOVERY_SCOPE');
 if(modern&&!expanded)fail('ADVISORY_WINDOW_MODERN_SCOPE');
 const window=scope(token,pool,windowEnd),receipts:ReceiptSet={rawArtifacts:{},retrievedAt:{},requests:{}},g=expanded?EXPANDED:dense?DENSE:LEGACY,transactionCap=expanded?WINDOW_EXPANDED_TRANSACTION_CAP:WINDOW_DENSE_TRANSACTION_CAP,requestCap=expanded?WINDOW_EXPANDED_REQUEST_CAP:WINDOW_DENSE_REQUEST_CAP,storedCap=expanded?WINDOW_EXPANDED_STORED_BYTES:WINDOW_DENSE_STORED_BYTES;
 // Dense only: a receipt whose archive would overflow the ceiling (room is kept for one in-flight sibling) is replaced, and no later request is made.
 let storedBytes=0,capped=false;
 const keep=(id:string,raw:string,at:string)=>{
  if(dense){const size=Buffer.byteLength(archiveDemandReceipt(raw));if(capped||storedBytes+size+2*STORAGE_CAP_STORED>storedCap){capped=true;raw=STORAGE_CAP_RECEIPT;storedBytes+=STORAGE_CAP_STORED;}else storedBytes+=size;}
  receipts.rawArtifacts[id]=raw;receipts.retrievedAt[id]=at;
 };
 const decode=()=>decodeAdvisoryWindow(token,pool,windowEnd,receipts.rawArtifacts,receipts.retrievedAt,receipts.requests,now(),currentAbi,feeExclusive,dense,logRecovery,expanded,modern,extended);
 const run=async(id:string,request:Request,reusable=false)=>{
  if(capped)return;
  receipts.requests[id]=request;
  if(reusable&&reuse)for(const [key,oldRequest]of Object.entries(reuse.requests)){
   if(JSON.stringify(oldRequest)!==JSON.stringify(request))continue;
   try{read(key,request,reuse,now());keep(id,reuse.rawArtifacts[key]!,reuse.retrievedAt[key]!);return;}catch{/* Failed or invalid receipts cannot substitute for a fresh read. */}
  }
  try{await solanaRpc(rpcUrl,request.method,request.params,fetcher,WINDOW_RESPONSE_BYTES,signal,raw=>keep(id,raw,now()));}
  catch(error){if(!receipts.rawArtifacts[id])keep(id,JSON.stringify({jsonrpc:'2.0',id:1,error:{code:safeRpcCode(error)}}),now());}
 };
 await run('window-genesis',genesis,true);let verified=false;try{verified=read('window-genesis',genesis,receipts,now()).value===SOLANA_MAINNET_GENESIS;}catch{}
 if(verified&&pool){
  await run('window-anchor-slot',anchorSlotRequest);let anchorSlot:number|null=null,anchorRetrieved=0;
  try{const slot=read('window-anchor-slot',anchorSlotRequest,receipts,now());if(!integer(slot.value)||slot.at<Date.parse(window.end))fail('ADVISORY_WINDOW_ANCHOR_INVALID');await run('window-anchor-time',anchorTimeRequest(slot.value));const time=read('window-anchor-time',anchorTimeRequest(slot.value),receipts,now());if(!integer(time.value)||time.at<slot.at||time.value*1000<Date.parse(window.end)||time.value*1000>slot.at)fail('ADVISORY_WINDOW_ANCHOR_INVALID');anchorSlot=slot.value;anchorRetrieved=time.at;}catch{}
  if(anchorSlot===null)return {...receipts,data:decode()};
  let before:string|undefined;
  for(let i=0;i<(g.maxPages??4);i++){
   const id=`window-page-${i}`;await run(id,page(pool,anchorSlot,before,g.limit));
   try{const current=index(pool,window,receipts,now(),anchorSlot,anchorRetrieved,g),retained=current.pages.find(p=>p.id===id);if(!retained||retained.status==='INVALID'||retained.status==='UNAVAILABLE'||current.reached||dense&&retained.status!=='OBSERVED')break;const response=read(id,page(pool,anchorSlot,before,g.limit),receipts,now(),dense),rows=g.rows(response.value,response.at);before=rows.at(-1)!.signature;}catch{break;}
  }
  const indexed=index(pool,window,receipts,now(),anchorSlot,anchorRetrieved,g),eligible=selectedRows(indexed.rows,window);
  // Dense: no transaction or pool read unless the index is complete and within the successful-reference cap.
  if(dense&&!indexed.complete)return {...receipts,data:decode()};
  let quoteMint:string|null=null;
  if(expanded){
   await run('window-pool-check',state(pool));
   try{const adm=admittedPool(receipts,now(),pool,token,anchorSlot,eligible);quoteMint=adm.quoteMint;if(!modern&&adm.status!=='SUPPORTED_WSOL')return {...receipts,data:decode()};}catch{return {...receipts,data:decode()};}
  }
  if(dense&&eligible.length>transactionCap)return {...receipts,data:decode()};
  const selected=dense?eligible:eligible.slice(0,40);
  for(let offset=0;offset<selected.length;offset+=2)await Promise.all(selected.slice(offset,offset+2).map((row,j)=>run(`window-transaction-${offset+j}`,transaction(row.signature),true)));
  await run('window-pool',modern&&quoteMint?multi(pool,quoteMint):state(pool));
 }
 return {...receipts,data:decode()};
}

const WINDOW_KEY=/^window-(?:genesis|anchor-slot|anchor-time|page-[0-3]|transaction-(?:[1-5]?\d|6[0-3])|pool)$/;
function archiveMembership(set:ReceiptSet,expanded=false){
 const keys=Object.keys(set.rawArtifacts).sort();
 if(keys.length>(expanded?WINDOW_EXPANDED_REQUEST_CAP:WINDOW_DENSE_REQUEST_CAP)||!keys.every(k=>(expanded?/^window-(?:genesis|anchor-slot|anchor-time|page-(?:[0-9]|1[0-5])|transaction-(?:[0-9]|[1-9][0-9]{1,2}|10[01][0-9]|102[0-3])|pool|pool-check)$/:WINDOW_KEY).test(k)&&typeof set.rawArtifacts[k]==='string')||JSON.stringify(keys)!==JSON.stringify(Object.keys(set.requests).sort())||JSON.stringify(keys)!==JSON.stringify(Object.keys(set.retrievedAt).sort()))fail('ADVISORY_WINDOW_ARCHIVE_MEMBERSHIP');
 return keys;
}
const storage=(receipts:number,storedBytes:number,sourceBytes:number,expanded=false):AdvisoryWindowStorage=>({adapterVersion:WINDOW_ARCHIVE_ADAPTER,archiveMethod:DEMAND_ARCHIVE_METHOD,receipts,storedBytes,sourceBytes,storedBytesCap:expanded?WINDOW_EXPANDED_STORED_BYTES:WINDOW_DENSE_STORED_BYTES});
/** Storage form for dense window receipts: each exact RPC body becomes a reversible demand-container archive; requests and clocks are copied unchanged. Fails closed above the namespace ceiling. */
export function archiveAdvisoryWindowReceipts(plain:ReceiptSet,expanded=false):ReceiptSet&{storage:AdvisoryWindowStorage}{
 archiveMembership(plain,expanded);
 const rawArtifacts:Record<string,string>={};let storedBytes=0,sourceBytes=0;
 for(const [key,raw]of Object.entries(plain.rawArtifacts)){
  const source=Buffer.byteLength(raw);if(source>WINDOW_ARCHIVE_SOURCE_BYTES)fail('ADVISORY_WINDOW_ARCHIVE_INVALID');
  rawArtifacts[key]=archiveDemandReceipt(raw);storedBytes+=Buffer.byteLength(rawArtifacts[key]!);sourceBytes+=source;
 }
 if(storedBytes>(expanded?WINDOW_EXPANDED_STORED_BYTES:WINDOW_DENSE_STORED_BYTES))fail('ADVISORY_WINDOW_STORAGE_CAP');
 return {rawArtifacts,retrievedAt:{...plain.retrievedAt},requests:structuredClone(plain.requests),storage:storage(Object.keys(rawArtifacts).length,storedBytes,sourceBytes,expanded)};
}
/** Inverse at the replay boundary: ceiling check before any inflate, then strict bounded unpack of every key to its exact original body. */
export function unpackAdvisoryWindowReceipts(archived:ReceiptSet,expanded=false):ReceiptSet&{storage:AdvisoryWindowStorage}{
 const keys=archiveMembership(archived,expanded),storedBytes=keys.reduce((n,k)=>n+Buffer.byteLength(archived.rawArtifacts[k]!),0);
 if(storedBytes>(expanded?WINDOW_EXPANDED_STORED_BYTES:WINDOW_DENSE_STORED_BYTES))fail('ADVISORY_WINDOW_STORAGE_CAP');
 const rawArtifacts:Record<string,string>={};let sourceBytes=0;
 for(const [key,archive]of Object.entries(archived.rawArtifacts)){
  const text=(()=>{try{return unpackDemandReceipt(archive,WINDOW_ARCHIVE_SOURCE_BYTES);}catch{return fail('ADVISORY_WINDOW_ARCHIVE_INVALID');}})();
  rawArtifacts[key]=text;sourceBytes+=Buffer.byteLength(text);
 }
 return {rawArtifacts,retrievedAt:{...archived.retrievedAt},requests:structuredClone(archived.requests),storage:storage(keys.length,storedBytes,sourceBytes,expanded)};
}

export function deriveO28Window(data:AdvisoryWindowHistory,evidenceIds:string[]):AdvisoryMetric{
 const quality=data.complete?'KNOWN':data.poolVerified&&data.transactions.some(t=>t.status==='OBSERVED')?'TRUNCATED':'MISSING';
 const buyers=[...new Set(data.trades.filter(t=>t.side==='BUY').map(t=>t.user))].sort(),sellers=[...new Set(data.trades.filter(t=>t.side==='SELL').map(t=>t.user))].sort(),ids=[...new Set(evidenceIds)];
 // Proofs 1-34 (modern=false) never decode a quote descriptor and keep their exact WSOL shape byte-for-byte; only a proof35 modern window adds the verified quote mint, decimals and token program.
 if(!data.quote)return {id:'O28',quality,unit:'WSOL quote flow',data:{...data,scope:'VERIFIED_PUMPSWAP_WSOL_POOL',wholeTokenFlow:null,otherPools:'EXCLUDED',newCapital:null,quoteMint:NATIVE_MINT.toBase58(),quoteDecimals:9,uniqueBuyerAccounts:buyers,uniqueSellerAccounts:sellers,economicBuyerCount:null,economicSellerCount:null},evidenceIds:ids,reasonCode:data.reasonCode};
 const custom=data.method==='pumpswap-selected-pool-window-v5';
 return {id:'O28',quality,unit:custom?'quote-token fee-exclusive core flow':'WSOL quote flow',data:{...data,scope:custom?'VERIFIED_PUMPSWAP_DIRECT_QUOTE_POOL':'VERIFIED_PUMPSWAP_WSOL_POOL',wholeTokenFlow:null,otherPools:'EXCLUDED',newCapital:null,quoteMint:data.quote.mint,quoteDecimals:data.quote.decimals,quoteProgram:data.quote.program,uniqueBuyerAccounts:buyers,uniqueSellerAccounts:sellers,economicBuyerCount:null,economicSellerCount:null},evidenceIds:ids,reasonCode:data.reasonCode};
}
