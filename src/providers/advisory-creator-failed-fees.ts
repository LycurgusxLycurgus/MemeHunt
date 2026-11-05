import { createHash } from 'node:crypto';
import { archiveDemandReceipt, unpackDemandReceipt, DEMAND_ARCHIVE_METHOD } from './advisory-demand-windows.js';

/** S15 failed-attempt fees for the fixed signed creator: every accepted indexed failed row of the creator wallet since creation needs one validated finalized receipt before any charged-overhead total exists. Pure; integration binds rows, cutoff and the target census to accepted raw proof. */
export const CREATOR_FAILED_FEES_METHOD='creator-failed-attempt-fees-v1' as const;
// Exact reuse of the demand archive codec: stored containers keep method advisory-demand-rpc-archive-v1. The adapter and receipt namespace belong to S15, not to demand evidence.
export const FAILED_FEE_ADAPTER='creator-failed-fee-archive-v1' as const,FAILED_FEE_PREFIX='s15-failed-' as const;
// Provider sourceId of every S15 failed receipt. Membership is this sourceId OR the reserved prefix, so a misfiled entry cannot leave the namespace.
export const FAILED_FEE_SOURCE_ID='advisory-creator-failed-fees' as const;
// Dedicated cap from the accepted complete creator index (130 failed rows since creation); a larger index fails closed.
export const EXPANDED_FAILED_FEE_RECEIPT_CAP=256,NATIVE_FAILED_FEE_RECEIPT_CAP=512,EPISODE_FAILED_FEE_RECEIPT_CAP=1024;
export const FAILED_FEE_RECEIPT_CAP=130,FAILED_FEE_RESPONSE_BYTES=500_000,FAILED_FEE_SOURCE_LIMIT=3*FAILED_FEE_RESPONSE_BYTES;
const CLASSES=['TARGET_ASSOCIATED_CHARGED','NOT_ACTOR_CHARGED','UNRESOLVED','UNAVAILABLE','MISSING'] as const;
const SETTLED=new Set<string>(CLASSES.slice(0,2));
const BASE58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',NANOS=1_000_000_000n;
const MEANING='Network fees charged to the signed creator on failed transactions that reference the target mint or a creator-owned target account, over the complete accepted failed index. Whole transaction overhead; not a per-asset allocation, profit or PnL.';
const LIMITATIONS=[
 'Rows are the accepted creator-wallet index of failed transactions since creation; index completeness is a provider property pinned to a finalized slot.',
 'A failed transaction keeps only the fee debit: the payer moves by exactly meta.fee and every other balance and token balance is unchanged, so protocol, buyback, creator and tip transfers are zero for these rows.',
 'Target association means a resolved account key, static or lookup-table, equals the mint or a creator-owned target-mint account from the accepted census. The creator wallet itself is not a target account.',
 'When another account pays, the creator is charged nothing for that row regardless of the attempted instructions.',
 'An actor-paid failure without a target key stays UNRESOLVED whatever its programs; no unrelated-instruction contract is certified.',
 'Foreign mints are observed from token balances only; coverage is partial and overhead is never allocated.',
 'No total exists until every indexed row has a validated receipt and a settled class; partial sums are never reported.',
];

export type FailedIndexRow={signature:string;slot:number;blockTime:number;err:unknown;transactionIndex:number|null;confirmationStatus:'finalized'};
/** One stored evidence entry, translated unfiltered by integration. stored is the archive container and contentHash its SHA-256. Access mode, source type and availability are checked at the app boundary, not here. */
export type FailedFeeReceipt={id:string;sourceId:string;adapterVersion:string;request:unknown;retrievedAt:string;contentHash:string;stored:string};
/** rows: the accepted complete failed index since creation. targetAccounts: creator-owned target-mint accounts from the accepted lifetime census. receipts: every stored evidence entry, unfiltered. */
export type FailedFeeInput={actor:string;mint:string;targetAccounts:string[];creationSlot:number;headSlot:number;cutoff:string;rows:FailedIndexRow[];receipts:FailedFeeReceipt[]};
export type FailedFeeClass=typeof CLASSES[number];
export type FailedFeeRow={signature:string;slot:number;blockTime:number;classification:FailedFeeClass;code:string|null;version:'legacy'|0|1|null;feePayer:string|null;actorSigner:boolean|null;targetReference:boolean|null;lookupKeys:number|null;metaFeeLamports:string|null;actorChargedLamports:string|null;foreignMintReferencesObserved:string[]};
export type FailedFeeResult={method:typeof CREATOR_FAILED_FEES_METHOD;status:'COMPLETE'|'INCOMPLETE'|'INVALID';reasonCode:string;actor:string|null;mint:string|null;targetSet:string[];
 coverage:{indexedRows:number;receipts:number;settled:number;unresolved:number;unavailable:number;missing:number;complete:boolean};counts:Record<FailedFeeClass,number>;
 failedTargetAssociatedChargedTransactionOverheadLamports:string|null;
 foreignAssetCoverage:'PARTIAL_OR_NOT_EVALUATED';overheadAllocation:'NOT_ATTEMPTED';
 storage:{archiveMethod:typeof DEMAND_ARCHIVE_METHOD;adapterVersion:typeof FAILED_FEE_ADAPTER;receipts:number;storedBytes:number;sourceBytes:number};
 rows:FailedFeeRow[];meaning:string;limitations:string[]};
type Body=Omit<FailedFeeRow,'signature'|'slot'|'blockTime'>;
type Context={actor:string;mint:string;targets:Set<string>};

class Invalid extends Error {}
function invalid(code:string):never{throw new Invalid(code);}
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const sha256=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');
function decode58(s:unknown):Buffer|null{
 if(typeof s!=='string'||!s.length||s.length>100||!/^[1-9A-HJ-NP-Za-km-z]+$/.test(s))return null;
 let n=0n;for(const c of s)n=n*58n+BigInt(BASE58.indexOf(c));
 const hex=n.toString(16),body=n===0n?Buffer.alloc(0):Buffer.from(hex.length%2?'0'+hex:hex,'hex');
 return Buffer.concat([Buffer.alloc(s.match(/^1*/)![0].length),body]);
}
const isKey=(s:unknown):s is string=>decode58(s)?.length===32;
const isSignature=(s:unknown):s is string=>decode58(s)?.length===64;
const canonical=(v:unknown):string=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:object(v)?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v)??'null';
/** UTC instant in nanoseconds; accepts Z or +00:00 with up to nine fractional digits so receipt clocks are compared without rounding. */
function nanos(s:unknown):bigint|null{
 if(typeof s!=='string')return null;
 const m=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(?:Z|\+00:00)$/.exec(s);if(!m)return null;
 const base=Date.parse(`${m[1]}Z`);if(!Number.isFinite(base)||new Date(base).toISOString().slice(0,19)!==m[1])return null;
 return BigInt(base)*1_000_000n+BigInt((m[2]??'').padEnd(9,'0'));
}
const blank=():Omit<Body,'classification'|'code'>=>({version:null,feePayer:null,actorSigner:null,targetReference:null,lookupKeys:null,metaFeeLamports:null,actorChargedLamports:null,foreignMintReferencesObserved:[]});

export const failedFeeRequest=(signature:string)=>({method:'getTransaction',params:[signature,{commitment:'finalized',encoding:'jsonParsed',maxSupportedTransactionVersion:1}]});
export const failedFeeReceiptId=(signature:string)=>`${FAILED_FEE_PREFIX}tx-${signature}`;
/** Compression, never truncation: a body over the fixed source ceiling is refused. */
export function archiveCreatorFailedFeeReceipt(raw:string):string{
 if(typeof raw!=='string'||!raw.length||Buffer.byteLength(raw,'utf8')>FAILED_FEE_SOURCE_LIMIT)throw new Error('S15_FAILED_ARCHIVE_SOURCE_LIMIT');
 return archiveDemandReceipt(raw);
}
export const unpackCreatorFailedFeeReceipt=(stored:string):string=>unpackDemandReceipt(stored,FAILED_FEE_SOURCE_LIMIT);
function unpacked(stored:string):string{try{return unpackCreatorFailedFeeReceipt(stored);}catch{return invalid('S15_FAILED_ARCHIVE_INVALID');}}

/** One jsonParsed receipt against its index row. Identity mismatches are forgeries (INVALID); unsupported shapes stay UNRESOLVED. */
function decodeRow(raw:string,row:FailedIndexRow,ctx:Context,version1=false):Body{
 const unresolved=(code:string,extra:Partial<Body>={}):Body=>({...blank(),...extra,classification:'UNRESOLVED',code});
 const unavailable=(code:string):Body=>({...blank(),classification:'UNAVAILABLE',code});
 let env:unknown=null;try{env=JSON.parse(raw);}catch{return unresolved('ENVELOPE_INVALID');}
 if(!object(env)||env.jsonrpc!=='2.0'||env.id!==1)return unresolved('ENVELOPE_INVALID');
 if(env.error!==undefined){const c=env.error?.code;return unavailable(typeof c==='string'&&/^RPC_[A-Z0-9_-]{1,50}$/.test(c)?c:Number.isSafeInteger(c)&&Math.abs(c)<=999999?`RPC_REMOTE_${c}`:'RPC_REMOTE');}
 if(!Object.hasOwn(env,'result'))return unresolved('ENVELOPE_INVALID');
 const v=env.result;if(v===null)return unavailable('RESULT_NULL');
 if(!object(v)||!object(v.transaction)||!object(v.transaction.message)||!Array.isArray(v.transaction.signatures)||!object(v.meta))return unresolved('SHAPE_INVALID');
 const message:Record<string,any>=v.transaction.message,meta:Record<string,any>=v.meta,signatures:unknown[]=v.transaction.signatures;
 if(signatures[0]!==row.signature||v.slot!==row.slot||v.blockTime!==row.blockTime||v.transactionIndex!==undefined&&row.transactionIndex!==null&&v.transactionIndex!==row.transactionIndex||meta.err===null||meta.err===undefined||canonical(meta.err)!==canonical(row.err))invalid('S15_FAILED_RECEIPT_BINDING');
 const version=v.version==='legacy'||v.version===0||version1&&v.version===1?v.version as 'legacy'|0|1:null;
 if(version===null)return unresolved('VERSION_UNSUPPORTED');
 if(meta.status!==undefined&&canonical(meta.status)!==canonical({Err:row.err}))return unresolved('STATUS_MISMATCH',{version});
 const list:unknown=message.accountKeys;
 if(!Array.isArray(list)||!list.length||list.length>256||!list.every(k=>object(k)&&isKey(k.pubkey)&&typeof k.signer==='boolean'&&typeof k.writable==='boolean'&&(k.source==='transaction'||k.source==='lookupTable')))return unresolved('KEYS_INVALID',{version});
 const keys:Array<{pubkey:string;signer:boolean;writable:boolean;source:string}>=list;
 const pubkeys=keys.map(k=>k.pubkey),lookup=keys.filter(k=>k.source==='lookupTable'),statics=keys.length-lookup.length,signers=keys.filter(k=>k.signer).length;
 // Resolved jsonParsed keys: signers lead the static keys and lookup-table keys follow every static key without signing.
 if(new Set(pubkeys).size!==pubkeys.length||keys.slice(statics).some(k=>k.source!=='lookupTable')||keys.some((k,i)=>k.signer!==(i<signers))||version==='legacy'&&lookup.length>0||signatures.length!==signers||!signatures.every(isSignature))return unresolved('KEYS_INVALID',{version});
 // loadedAddresses may be omitted because lookup keys are already resolved above; when present it must agree in order and writability.
 const loaded:unknown=meta.loadedAddresses;
 if(loaded!==undefined&&(!object(loaded)||!Array.isArray(loaded.writable)||!Array.isArray(loaded.readonly)||canonical([...loaded.writable,...loaded.readonly])!==canonical(lookup.map(k=>k.pubkey))||lookup.some((k,i)=>k.writable!==(i<loaded.writable.length))))return unresolved('LOADED_ADDRESSES_MISMATCH',{version,lookupKeys:lookup.length});
 const payer=keys[0]!,shape={version,lookupKeys:lookup.length};
 if(payer.source!=='transaction'||!payer.signer||!payer.writable)return unresolved('FEE_PAYER_INVALID',shape);
 const fee:unknown=meta.fee,pre:unknown=meta.preBalances,post:unknown=meta.postBalances,amounts=(x:unknown):x is number[]=>Array.isArray(x)&&x.length===keys.length&&x.every(integer);
 if(!integer(fee)||!amounts(pre)||!amounts(post))return unresolved('BALANCES_INVALID',shape);
 // A failed transaction keeps only the fee debit: the payer moves by exactly meta.fee and every other account is unchanged.
 if((pre[0]??0)-(post[0]??0)!==fee||pre.some((n,i)=>i>0&&post[i]!==n))return unresolved('EFFECTS_NOT_FEE_ONLY',shape);
 const preTokens:unknown=meta.preTokenBalances,postTokens:unknown=meta.postTokenBalances;
 const tokens=(x:unknown):x is Array<{mint:string}>=>Array.isArray(x)&&x.every(b=>object(b)&&integer(b.accountIndex)&&b.accountIndex<keys.length&&typeof b.mint==='string');
 if(!tokens(preTokens)||!tokens(postTokens))return unresolved('TOKEN_BALANCES_INVALID',shape);
 if(canonical(preTokens)!==canonical(postTokens))return unresolved('TOKEN_BALANCES_CHANGED',shape);
 // Observational only: failed receipts may carry empty balances or opaque instructions, so absence never proves a single asset.
 const foreign=[...new Set([...preTokens,...postTokens].map(b=>b.mint).filter(m=>m!==ctx.mint))].sort();
 const targetReference=pubkeys.some(k=>ctx.targets.has(k)),actorSigner=keys.some(k=>k.pubkey===ctx.actor&&k.signer);
 const base={...blank(),...shape,code:null,feePayer:payer.pubkey,actorSigner,targetReference,metaFeeLamports:String(fee),foreignMintReferencesObserved:foreign};
 // Another payer bears the whole fee; the creator balance is proven unchanged above, whatever the instructions intended.
 if(payer.pubkey!==ctx.actor)return{...base,classification:'NOT_ACTOR_CHARGED',actorChargedLamports:'0'};
 if(targetReference)return{...base,classification:'TARGET_ASSOCIATED_CHARGED',actorChargedLamports:String(fee)};
 // Without a target key, a creator-paid failure stays unresolved whatever its programs: a missing key never proves unrelatedness.
 return{...base,classification:'UNRESOLVED',code:'ACTOR_CHARGED_TARGET_UNPROVEN',actorChargedLamports:String(fee)};
}

function result(input:FailedFeeInput,status:FailedFeeResult['status'],reasonCode:string,targets:string[],rows:FailedFeeRow[],receipts:number,storedBytes:number,sourceBytes:number):FailedFeeResult{
 const counts=Object.fromEntries(CLASSES.map(c=>[c,rows.filter(r=>r.classification===c).length])) as Record<FailedFeeClass,number>;
 const sum=(c:FailedFeeClass)=>status==='COMPLETE'?String(rows.filter(r=>r.classification===c).reduce((n,r)=>n+BigInt(r.actorChargedLamports!),0n)):null;
 const given=object(input)?input:null;
 return{method:CREATOR_FAILED_FEES_METHOD,status,reasonCode,actor:typeof given?.actor==='string'?given.actor:null,mint:typeof given?.mint==='string'?given.mint:null,targetSet:targets,
  coverage:{indexedRows:Array.isArray(given?.rows)?given!.rows.length:0,receipts,settled:counts.TARGET_ASSOCIATED_CHARGED+counts.NOT_ACTOR_CHARGED,unresolved:counts.UNRESOLVED,unavailable:counts.UNAVAILABLE,missing:counts.MISSING,complete:status==='COMPLETE'},counts,
  failedTargetAssociatedChargedTransactionOverheadLamports:sum('TARGET_ASSOCIATED_CHARGED'),
  foreignAssetCoverage:'PARTIAL_OR_NOT_EVALUATED',overheadAllocation:'NOT_ATTEMPTED',
  storage:{archiveMethod:DEMAND_ARCHIVE_METHOD,adapterVersion:FAILED_FEE_ADAPTER,receipts,storedBytes,sourceBytes},rows,meaning:MEANING,limitations:LIMITATIONS};
}

/** Classifies every accepted failed index row; any forgery yields INVALID and any unsettled row leaves the total null. */
export function classifyCreatorFailedFees(input:FailedFeeInput,expanded=false,version1=false,episode=false):FailedFeeResult{
 let targets:string[]=[];
 try{
  if(!object(input)||!isKey(input.actor)||!isKey(input.mint)||!Array.isArray(input.targetAccounts)||!input.targetAccounts.every(isKey)||new Set(input.targetAccounts).size!==input.targetAccounts.length||input.targetAccounts.includes(input.mint)||input.targetAccounts.includes(input.actor)||!integer(input.creationSlot)||!integer(input.headSlot)||input.creationSlot>input.headSlot||!Array.isArray(input.rows)||!Array.isArray(input.receipts))invalid('S15_FAILED_INPUT_INVALID');
  const cutoff=nanos(input.cutoff);if(cutoff===null)return invalid('S15_FAILED_INPUT_INVALID');
  if(input.rows.length>(episode?EPISODE_FAILED_FEE_RECEIPT_CAP:version1?NATIVE_FAILED_FEE_RECEIPT_CAP:expanded?EXPANDED_FAILED_FEE_RECEIPT_CAP:FAILED_FEE_RECEIPT_CAP))invalid('S15_FAILED_INDEX_CAP');
  const expected=new Map<string,FailedIndexRow>();
  for(const r of input.rows){
   if(!object(r)||!isSignature(r.signature)||expected.has(failedFeeReceiptId(r.signature))||!integer(r.slot)||r.slot<input.creationSlot||r.slot>input.headSlot||!integer(r.blockTime)||BigInt(r.blockTime)*NANOS>cutoff||r.err===null||r.err===undefined||r.confirmationStatus!=='finalized'||!(r.transactionIndex===null||integer(r.transactionIndex)))invalid('S15_FAILED_INPUT_INVALID');
   expected.set(failedFeeReceiptId(r.signature),r);
  }
  targets=[input.mint,...input.targetAccounts];
  const ctx:Context={actor:input.actor,mint:input.mint,targets:new Set(targets)},byId=new Map<string,FailedFeeReceipt>();
  // Membership is the S15 sourceId OR the reserved id prefix; a matching adapter also counts, so orphans and misfiled cache entries cannot hide outside the namespace.
  for(const r of input.receipts){
   if(!object(r))invalid('S15_FAILED_RECEIPT_SHAPE');
   if(r.sourceId!==FAILED_FEE_SOURCE_ID&&!(typeof r.id==='string'&&r.id.startsWith(FAILED_FEE_PREFIX))&&r.adapterVersion!==FAILED_FEE_ADAPTER)continue;
   const row=expected.get(r.id);if(!row)return invalid('S15_FAILED_RECEIPT_ORPHAN');
   if(byId.has(r.id))invalid('S15_FAILED_RECEIPT_DUPLICATE');
   if(r.sourceId!==FAILED_FEE_SOURCE_ID)invalid('S15_FAILED_RECEIPT_SOURCE');
   if(r.adapterVersion!==FAILED_FEE_ADAPTER)invalid('S15_FAILED_RECEIPT_ADAPTER');
   if(JSON.stringify(r.request)!==JSON.stringify(failedFeeRequest(row.signature)))invalid('S15_FAILED_RECEIPT_REQUEST');
   if(typeof r.stored!=='string'||typeof r.contentHash!=='string'||sha256(r.stored)!==r.contentHash)invalid('S15_FAILED_RECEIPT_HASH');
   const at=nanos(r.retrievedAt);if(at===null||at>cutoff||at<BigInt(row.blockTime)*NANOS)invalid('S15_FAILED_RECEIPT_CLOCK');
   byId.set(r.id,r);
  }
  const rows:FailedFeeRow[]=[];let storedBytes=0,sourceBytes=0;
  const ordered=[...expected.values()].sort((a,b)=>a.slot-b.slot||(a.transactionIndex??Infinity)-(b.transactionIndex??Infinity)||(a.signature<b.signature?-1:a.signature>b.signature?1:0));
  for(const row of ordered){
   const head={signature:row.signature,slot:row.slot,blockTime:row.blockTime},receipt=byId.get(failedFeeReceiptId(row.signature));
   if(!receipt){rows.push({...head,...blank(),classification:'MISSING',code:'RECEIPT_MISSING'});continue;}
   const raw=unpacked(receipt.stored);
   storedBytes+=Buffer.byteLength(receipt.stored,'utf8');sourceBytes+=Buffer.byteLength(raw,'utf8');
   rows.push({...head,...decodeRow(raw,row,ctx,version1)});
  }
  const complete=rows.every(r=>SETTLED.has(r.classification));
  return result(input,complete?'COMPLETE':'INCOMPLETE',complete?'S15_FAILED_FEES_COMPLETE':'S15_FAILED_FEES_INCOMPLETE',targets,rows,byId.size,storedBytes,sourceBytes);
 }catch(error){
  if(error instanceof Invalid)return result(input,'INVALID',error.message,targets,[],0,0,0);
  throw error;
 }
}
