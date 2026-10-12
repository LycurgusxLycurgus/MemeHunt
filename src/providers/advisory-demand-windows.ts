import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { Decimal } from 'decimal.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { PUMP_AMM_SDK, PUMP_AMM_PROGRAM_ID, poolPda } from '@pump-fun/pump-swap-sdk';
import type { TokenRef } from '../domain/contracts.js';
import type { AdvisoryMetric } from '../domain/advisory-contracts.js';
import { decodePumpSwapWindowTransaction, type DecodedTrade, type LogRecovery } from './advisory-trades.js';
import type { AdvisoryWindowHistory, AdvisoryWindowReuse } from './advisory-window.js';
import { encodeSolanaAddress, safeRpcCode, solanaRpc } from './solana.js';

type Request={method:string;params:unknown[]};
type ReceiptSet=AdvisoryWindowReuse;
type Status='OBSERVED'|'UNAVAILABLE'|'INVALID'|'TRUNCATED';
type Bounds={start:number;baselineEnd:number;end:number};
type Row={signature:string;slot:number;blockTime:number|null;err:unknown;transactionIndex:number|null};
type Page={id:string;returned:number;oldestAt:string|null;newestAt:string|null;exhausted:boolean;status:Status;code?:string};
type Hour={start:string;end:string;successfulReferences:number;failedReferences:number;complete:boolean};
type Selected={row:Row;id:string;reused:boolean};
type Index={pages:Page[];rows:Row[];reached:boolean;complete:boolean;code:string|null;used:string[]};
export type DemandTrade=DecodedTrade&{transactionIndex:number|null};
export type DemandTransaction={signature:string;slot:number;at:string;receipt:'WINDOW'|'DEMAND';status:Status;code?:string;trades:number;logRecovery?:LogRecovery};
export const DEMAND_METHOD='complete-pool-baseline-demand-windows-v1' as const;
export type DemandHistory={
 method:typeof DEMAND_METHOD;eligible:boolean;token:TokenRef;pool:string|null;range:{start:string;baselineEnd:string;end:string};anchorSlot:number|null;
 poolVerified:boolean;stateSlot:number|null;pages:Page[];indexReached:boolean;indexComplete:boolean;
 successfulReferences:number;failedReferences:number;freshTransactions:number;reusedTransactions:number;transactionCap:number;capExceeded:boolean;
 transactions:DemandTransaction[];hours:Hour[];trades:DemandTrade[];programAccounts:string[];storage:DemandStorage;complete:boolean;reasonCode:string;
};
export type DemandStorage={archiveMethod:typeof DEMAND_ARCHIVE_METHOD;adapterVersion:typeof DEMAND_ARCHIVE_ADAPTER;receipts:number;storedBytes:number;sourceBytes:number};
// Dedicated budget: two 1000-row finalized index pages, 480 fresh transactions and one post-tape pool state.
export const DEMAND_PAGE_LIMIT=1000,DEMAND_MAX_PAGES=2,DEMAND_TRANSACTION_CAP=480,DEMAND_REQUEST_CAP=DEMAND_MAX_PAGES+DEMAND_TRANSACTION_CAP+1;
export const DEMAND_PAGE_TIMEOUT_MS=16_000;
export const MEANINGFUL_CORE_QUOTE_ATOMIC='10000000';
// Fresh demand receipts are stored as exact reversible archives; the uncompressed RPC bodies stay recoverable byte for byte.
export const DEMAND_ARCHIVE_METHOD='advisory-demand-rpc-archive-v1' as const,DEMAND_ARCHIVE_ENCODING='DEFLATE_RAW_BASE64' as const,DEMAND_ARCHIVE_ADAPTER='demand-archive-v1' as const;
const PAGE_RESPONSE_BYTES=2_000_000,RECEIPT_RESPONSE_BYTES=500_000,ARCHIVE_KEYS='data,encoding,method,sourceBytes,sourceHash',ARCHIVE_INVALID='ADVISORY_DEMAND_ARCHIVE_INVALID';
const sha256=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
/** Source ceiling per receipt key. Bodies are read under the response caps and decoded as text; UTF-8 re-encoding of replaced invalid bytes can at most triple them. */
export function demandArchiveSourceLimit(key:string):number{
 if(/^demand-page-[01]$/.test(key))return 3*PAGE_RESPONSE_BYTES;
 if(/^demand-(?:transaction-(?:0|[1-9]\d{0,2})|pool)$/.test(key))return 3*RECEIPT_RESPONSE_BYTES;
 return fail('ADVISORY_DEMAND_RECEIPT_MEMBERSHIP');
}
export function archiveDemandReceipt(raw:string):string{
 const bytes=Buffer.from(raw,'utf8');
 return JSON.stringify({method:DEMAND_ARCHIVE_METHOD,encoding:DEMAND_ARCHIVE_ENCODING,sourceBytes:bytes.length,sourceHash:sha256(bytes),data:deflateRawSync(bytes).toString('base64')});
}
/** Strict single-level unpack: canonical container, claimed size checked before a bounded inflate, then exact consumption, length, hash and UTF-8 round trip. */
export function unpackDemandReceipt(archive:string,limit:number):string{
 const deflateBound=(n:number)=>n+(n>>>10)+64,maxData=(n:number)=>4*Math.ceil(deflateBound(n)/3);
 if(typeof archive!=='string'||archive.length>maxData(limit)+512)fail(ARCHIVE_INVALID);
 let c:any=null;try{c=JSON.parse(archive);}catch{c=null;}
 if(!object(c)||Object.keys(c).sort().join()!==ARCHIVE_KEYS||c.method!==DEMAND_ARCHIVE_METHOD||c.encoding!==DEMAND_ARCHIVE_ENCODING||!Number.isSafeInteger(c.sourceBytes)||c.sourceBytes<1||c.sourceBytes>limit||typeof c.sourceHash!=='string'||!/^[a-f0-9]{64}$/.test(c.sourceHash)||typeof c.data!=='string')fail(ARCHIVE_INVALID);
 if(JSON.stringify({method:c.method,encoding:c.encoding,sourceBytes:c.sourceBytes,sourceHash:c.sourceHash,data:c.data})!==archive)fail(ARCHIVE_INVALID);
 const data=c.data as string,sourceBytes=c.sourceBytes as number;
 if(!data.length||data.length%4!==0||data.length>maxData(sourceBytes)||!/^[A-Za-z0-9+/]+={0,2}$/.test(data))fail(ARCHIVE_INVALID);
 const compressed=Buffer.from(data,'base64');if(compressed.toString('base64')!==data)fail(ARCHIVE_INVALID);
 // maxOutputLength stops inflation at the claimed size, so a bomb never allocates past the receipt ceiling.
 let inflated:{buffer:Buffer;engine:{bytesWritten:number}}|null=null;
 try{inflated=inflateRawSync(compressed,{maxOutputLength:sourceBytes,info:true}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};}catch{inflated=null;}
 if(!inflated||inflated.engine.bytesWritten!==compressed.length||inflated.buffer.length!==sourceBytes||sha256(inflated.buffer)!==c.sourceHash)fail(ARCHIVE_INVALID);
 const bytes=inflated!.buffer,text=bytes.toString('utf8');
 if(!Buffer.from(text,'utf8').equals(bytes))fail(ARCHIVE_INVALID);
 return text;
}
const HOUR=3_600_000,HOURS=12,BASELINE_HOURS=6,WSOL=NATIVE_MINT.toBase58(),PROGRAM=PUMP_AMM_PROGRAM_ID.toBase58();
const ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const HEADER_KEYS='numReadonlySignedAccounts,numReadonlyUnsignedAccounts,numRequiredSignatures';
const MESSAGE_KEYS=new Set(['header','accountKeys','recentBlockhash','instructions','addressTableLookups']),INSTRUCTION_KEYS=new Set(['programIdIndex','accounts','data','stackHeight']);
// Observed RPC version-1 json: static keys only plus this four-field config; no lookup field.
const V1_MESSAGE_KEYS=new Set(['header','accountKeys','recentBlockhash','instructions','transactionConfig']),V1_CONFIG_KEYS='computeUnitLimit,heapSize,loadedAccountsDataSizeLimit,priorityFee';
const UNIT='complete selected-pool demand windows of six';
const NEW_BUYER_RULE='A decoded non-program user account whose first fee-exclusive core BUY of at least 0.01 WSOL in the complete twelve-hour tape falls in that window. Accounts with such a buy in the six-hour baseline are excluded and each account counts once.';
const LIMITATIONS=[
 'One verified PumpSwap WSOL pool and twelve declared UTC hours only; other pools, venues and whole-token flow are excluded.',
 'New means first observed as a meaningful buyer within this complete pool tape. It is not first-ever buying, a new wallet, a person, organic demand or new capital.',
 'CPI-authorized program user accounts are excluded from baseline and candidate buyer sets; their decoded flow stays in hourly net quote.',
 'Baseline sells and sub-threshold buys are disclosed per new buyer and never change eligibility.',
 'Any incomplete hour leaves every condition, the satisfied count and the share null; the denominator is fixed at six windows.',
 'Fresh transactions use official json encoding, validated and projected in memory into account-key form for the unchanged pinned decoder; retained receipts remain the original RPC responses. Version-1 json is admitted only in the observed fully static layout (no lookup field, empty loaded addresses, a four-field transactionConfig); any other version-1 or future layout stays MISSING.',
 'Truncated logs pass only through the pinned decoder opt-in recovery when every selected-pool flow frame, event and CPI closed before the marker with proven ancestors; later unresolved invocations are disclosed as unproven non-flow, never as executed.',
 'Fresh demand receipts are stored as exact deflate-raw archives with the original byte length and SHA-256; stored bytes count against the unchanged 24 MB live cap, while uncompressed source bytes are reported separately and not claimed to fit it.',
 'Upgradeable program bytecode during the tape is not independently attested; runtime account, event and argument bindings are verified.',
];
function fail(code:string):never{throw new Error(code);}
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const iso=(ms:number)=>new Date(ms).toISOString();
const errorCode=(error:unknown)=>error instanceof Error&&/^(ADVISORY_(?:DEMAND|TRADE)_[A-Z0-9_]+|RPC_[A-Z0-9_-]{1,50})$/.test(error.message)?error.message:'ADVISORY_DEMAND_RECEIPT_INVALID';
const bad=(error:unknown)=>{const code=errorCode(error);return{status:code.startsWith('RPC_')?'UNAVAILABLE' as const:'INVALID' as const,code};};

export const demandPageRequest=(pool:string,anchorSlot:number,before?:string):Request=>({method:'getSignaturesForAddress',params:[pool,{commitment:'finalized',limit:DEMAND_PAGE_LIMIT,minContextSlot:anchorSlot,...(before?{before}:{})}]});
export const demandTransactionRequest=(signature:string):Request=>({method:'getTransaction',params:[signature,{commitment:'finalized',encoding:'json',maxSupportedTransactionVersion:1}]});
export const demandPoolRequest=(pool:string,anchorSlot:number):Request=>({method:'getAccountInfo',params:[pool,{encoding:'base64',commitment:'finalized',minContextSlot:anchorSlot}]});
// The exact O28 jsonParsed request; only an identical retained request is reused.
const windowTransactionRequest=(signature:string):Request=>({method:'getTransaction',params:[signature,{commitment:'finalized',encoding:'jsonParsed',maxSupportedTransactionVersion:1}]});

const eligible=(w:AdvisoryWindowHistory)=>w.complete&&w.method==='pumpswap-selected-pool-window-v3'&&w.genesisVerified&&w.pool!==null&&w.anchorSlot!==null&&Number.isFinite(Date.parse(w.window.end));
function bounds(w:AdvisoryWindowHistory):Bounds{const end=Date.parse(w.window.end);return{start:end-HOURS*HOUR,baselineEnd:end-BASELINE_HOURS*HOUR,end};}
function base58(text:unknown,code:string):Buffer{
 if(typeof text!=='string'||text.length>2000||!/^[1-9A-HJ-NP-Za-km-z]*$/.test(text))fail(code);
 const s=text as string;let n=0n;for(const c of s)n=n*58n+BigInt(ALPHABET.indexOf(c));
 let hex=n.toString(16);if(hex.length%2)hex=`0${hex}`;
 return Buffer.concat([Buffer.alloc(s.match(/^1*/)![0].length),n===0n?Buffer.alloc(0):Buffer.from(hex,'hex')]);
}
function canonical(text:unknown,length:number,code:string):string{const bytes=base58(text,code);if(bytes.length!==length||encodeSolanaAddress(bytes)!==text)fail(code);return text as string;}
function read(id:string,expected:Request,receipts:ReceiptSet,cutoff:string):{value:any;at:number}{
 if(JSON.stringify(receipts.requests[id])!==JSON.stringify(expected)||typeof receipts.rawArtifacts[id]!=='string')fail('ADVISORY_DEMAND_REQUEST');
 const at=Date.parse(receipts.retrievedAt[id]??'');if(!Number.isFinite(at)||at>Date.parse(cutoff))fail('ADVISORY_DEMAND_RECEIPT_TIME');
 let raw:any=null;try{raw=JSON.parse(receipts.rawArtifacts[id]!);}catch{raw=null;}
 if(!object(raw)||raw.jsonrpc!=='2.0'||raw.id!==1)fail('ADVISORY_DEMAND_RECEIPT_SHAPE');
 if(raw.error!==undefined){const c=object(raw.error)?raw.error.code:null;fail(typeof c==='string'&&/^RPC_[A-Z0-9_-]{1,50}$/.test(c)?c:Number.isSafeInteger(c)&&Math.abs(c)<=999999?`RPC_REMOTE_${c}`:'ADVISORY_DEMAND_REMOTE');}
 if(!Object.hasOwn(raw,'result'))fail('ADVISORY_DEMAND_RECEIPT_SHAPE');
 return{value:raw.result,at};
}
function pageRows(value:unknown,retrieved:number):Row[]{
 if(!Array.isArray(value)||value.length>DEMAND_PAGE_LIMIT)fail('ADVISORY_DEMAND_PAGE_SHAPE');
 return (value as unknown[]).map(v=>{
  if(!object(v)||!integer(v.slot)||!(v.blockTime===null||integer(v.blockTime)&&v.blockTime*1000<=retrieved)||!('err' in v)||!(v.err===null||object(v.err))||v.confirmationStatus!=='finalized'||!(v.transactionIndex===undefined||v.transactionIndex===null||integer(v.transactionIndex)))fail('ADVISORY_DEMAND_PAGE_SHAPE');
  const row=v as Record<string,any>;
  return{signature:canonical(row.signature,64,'ADVISORY_DEMAND_PAGE_SHAPE'),slot:row.slot as number,blockTime:row.blockTime as number|null,err:row.err,transactionIndex:integer(row.transactionIndex)?row.transactionIndex:null};
 });
}

/** Validates one compiled json transaction and projects it in memory into the account-key form the pinned decoder reads. Never persisted. */
export function projectCompiledTransaction(value:unknown):any{
 if(value===null)fail('ADVISORY_DEMAND_TRANSACTION_MISSING');
 if(!object(value)||!object(value.transaction)||!object(value.meta))fail('ADVISORY_DEMAND_JSON_SHAPE');
 const v=value as Record<string,any>;
 if(v.version!=='legacy'&&v.version!==0&&v.version!==1)fail('ADVISORY_DEMAND_JSON_VERSION');
 const t=v.transaction,m=t.message,meta=v.meta,v1=v.version===1;
 const loaded=meta.loadedAddresses,emptyLoaded=loaded===undefined||loaded===null||object(loaded)&&Array.isArray(loaded.writable)&&Array.isArray(loaded.readonly)&&!loaded.writable.length&&!loaded.readonly.length;
 // Version 1 is admitted only in the observed fully static layout; lookup or other layouts stay unproven.
 if(v1&&object(m)&&(Object.hasOwn(m,'addressTableLookups')||!emptyLoaded||!object(m.transactionConfig)||Object.keys(m.transactionConfig).sort().join()!==V1_CONFIG_KEYS||Object.values(m.transactionConfig).some(x=>x!==null&&!integer(x))))fail('ADVISORY_DEMAND_JSON_V1_LAYOUT');
 if(Object.keys(t).sort().join()!=='message,signatures'||!object(m)||Object.keys(m).some(k=>!(v1?V1_MESSAGE_KEYS:MESSAGE_KEYS).has(k))||!object(m.header)||Object.keys(m.header).sort().join()!==HEADER_KEYS||!Array.isArray(t.signatures)||!Array.isArray(m.accountKeys)||!Array.isArray(m.instructions)||!Array.isArray(meta.innerInstructions)||!Array.isArray(meta.logMessages))fail('ADVISORY_DEMAND_JSON_SHAPE');
 const statics=(m.accountKeys as unknown[]).map(k=>canonical(k,32,'ADVISORY_DEMAND_JSON_ADDRESS'));
 const required=m.header.numRequiredSignatures,readonlySigned=m.header.numReadonlySignedAccounts,readonlyUnsigned=m.header.numReadonlyUnsignedAccounts;
 if(!integer(required)||!integer(readonlySigned)||!integer(readonlyUnsigned)||required<1||readonlySigned>=required||required+readonlyUnsigned>statics.length||t.signatures.length!==required)fail('ADVISORY_DEMAND_JSON_HEADER');
 for(const signature of t.signatures as unknown[])canonical(signature,64,'ADVISORY_DEMAND_JSON_SIGNATURE');
 canonical(m.recentBlockhash,32,'ADVISORY_DEMAND_JSON_SHAPE');
 let writable:string[]=[],readonly:string[]=[];
 if(v.version!==0){if(!(m.addressTableLookups===undefined||Array.isArray(m.addressTableLookups)&&!m.addressTableLookups.length)||!emptyLoaded)fail('ADVISORY_DEMAND_JSON_LOOKUP');}
 else{
  if(!Array.isArray(m.addressTableLookups)||!object(loaded)||!Array.isArray(loaded.writable)||!Array.isArray(loaded.readonly))fail('ADVISORY_DEMAND_JSON_LOOKUP');
  let w=0,r=0;
  for(const lookup of m.addressTableLookups as unknown[]){
   if(!object(lookup)||!Array.isArray(lookup.writableIndexes)||!Array.isArray(lookup.readonlyIndexes)||[...lookup.writableIndexes,...lookup.readonlyIndexes].some((i:unknown)=>!integer(i)||i>255))fail('ADVISORY_DEMAND_JSON_LOOKUP');
   const l=lookup as Record<string,any>;canonical(l.accountKey,32,'ADVISORY_DEMAND_JSON_LOOKUP');w+=l.writableIndexes.length;r+=l.readonlyIndexes.length;
  }
  writable=(loaded.writable as unknown[]).map(k=>canonical(k,32,'ADVISORY_DEMAND_JSON_ADDRESS'));readonly=(loaded.readonly as unknown[]).map(k=>canonical(k,32,'ADVISORY_DEMAND_JSON_ADDRESS'));
  if(writable.length!==w||readonly.length!==r)fail('ADVISORY_DEMAND_JSON_LOOKUP');
 }
 const keys=[...statics,...writable,...readonly];
 if(keys.length>256||new Set(keys).size!==keys.length)fail('ADVISORY_DEMAND_JSON_ADDRESS');
 const accountKeys=keys.map((pubkey,i)=>({pubkey,signer:i<required,writable:i<statics.length?(i<required?i<required-readonlySigned:i<statics.length-readonlyUnsigned):i<statics.length+writable.length,source:i<statics.length?'transaction':'lookupTable'}));
 // Top-level programs must be static keys; CPI programs may be any loaded account.
 const convert=(ix:unknown,programLimit:number)=>{
  if(!object(ix)||Object.keys(ix).some(k=>!INSTRUCTION_KEYS.has(k))||!integer(ix.programIdIndex)||ix.programIdIndex>=programLimit||!Array.isArray(ix.accounts)||ix.accounts.length>256||ix.accounts.some((i:unknown)=>!integer(i)||i>=keys.length))fail('ADVISORY_DEMAND_JSON_INSTRUCTION');
  const x=ix as Record<string,any>;base58(x.data,'ADVISORY_DEMAND_JSON_INSTRUCTION');
  return{programId:keys[x.programIdIndex]!,accounts:(x.accounts as number[]).map(i=>keys[i]!),data:x.data as string,stackHeight:(x.stackHeight??null) as number|null};
 };
 const instructions=(m.instructions as unknown[]).map(ix=>{const out=convert(ix,statics.length);if(!(out.stackHeight===null||out.stackHeight===1))fail('ADVISORY_DEMAND_JSON_INSTRUCTION');return out;});
 const groups=new Set<number>();
 const inner=(meta.innerInstructions as unknown[]).map(g=>{
  if(!object(g)||Object.keys(g).sort().join()!=='index,instructions'||!integer(g.index)||g.index>=instructions.length||groups.has(g.index)||!Array.isArray(g.instructions))fail('ADVISORY_DEMAND_JSON_INSTRUCTION');
  const group=g as Record<string,any>;groups.add(group.index);let previous=1;
  return{index:group.index as number,instructions:(group.instructions as unknown[]).map(ix=>{const out=convert(ix,keys.length);if(!integer(out.stackHeight)||out.stackHeight<2||out.stackHeight>previous+1)fail('ADVISORY_DEMAND_JSON_INSTRUCTION');previous=out.stackHeight as number;return out;})};
 });
 return{...v,transaction:{signatures:[...t.signatures],message:{accountKeys,instructions,recentBlockhash:m.recentBlockhash,...(v.version===0?{addressTableLookups:m.addressTableLookups}:{})}},meta:{...meta,innerInstructions:inner}};
}

function index(pool:string,anchorSlot:number,anchorRetrieved:number,b:Bounds,receipts:ReceiptSet,cutoff:string):Index{
 const result:Index={pages:[],rows:[],reached:false,complete:false,code:null,used:[]},seen=new Set<string>();
 let before:string|undefined,lastSlot=Infinity,lastAt=Infinity,lastRetrieved=0,unknown=false;
 for(let i=0;i<DEMAND_MAX_PAGES;i++){
  const id=`demand-page-${i}`;
  if(!(id in receipts.requests)){result.code='ADVISORY_DEMAND_PAGE_MISSING';break;}
  result.used.push(id);
  try{
   const response=read(id,demandPageRequest(pool,anchorSlot,before),receipts,cutoff),list=pageRows(response.value,response.at);
   if(response.at<b.end||response.at<anchorRetrieved||response.at<lastRetrieved)fail('ADVISORY_DEMAND_PAGE_TIME');
   for(const row of list){
    if(seen.has(row.signature)||row.slot>lastSlot||row.blockTime!==null&&row.blockTime>lastAt)fail('ADVISORY_DEMAND_PAGE_ORDER');
    seen.add(row.signature);lastSlot=row.slot;if(row.blockTime===null)unknown=true;else lastAt=row.blockTime;
   }
   result.rows.push(...list);lastRetrieved=response.at;
   const times=list.flatMap(r=>r.blockTime===null?[]:[iso(r.blockTime*1000)]),exhausted=list.length<DEMAND_PAGE_LIMIT,older=list.some(r=>r.blockTime!==null&&r.blockTime*1000<b.start);
   result.pages.push({id,returned:list.length,oldestAt:times.at(-1)??null,newestAt:times[0]??null,exhausted,status:unknown?'TRUNCATED':'OBSERVED'});
   if(older||exhausted){result.reached=true;result.complete=!unknown;if(unknown)result.code='ADVISORY_DEMAND_NULL_CLOCK';break;}
   before=list.at(-1)!.signature;
  }catch(error){const failure=bad(error);result.pages.push({id,returned:0,oldestAt:null,newestAt:null,exhausted:false,...failure});result.code=failure.code;break;}
 }
 if(!result.reached&&!result.code)result.code='ADVISORY_DEMAND_PAGE_CAP';
 return result;
}
/** Deterministic receipt keys: identical O28 requests are reused, all other successful in-range references get fresh demand keys in index order. */
function assign(rows:Row[],b:Bounds,windowReceipts:ReceiptSet){
 const inside=(r:Row)=>r.blockTime!==null&&r.blockTime*1000>=b.start&&r.blockTime*1000<b.end;
 const reusable=new Map<string,string>();for(const [key,request] of Object.entries(windowReceipts.requests))reusable.set(JSON.stringify(request),key);
 let fresh=0;
 const selected:Selected[]=rows.filter(r=>r.err===null&&inside(r)).map(row=>{const key=reusable.get(JSON.stringify(windowTransactionRequest(row.signature)));return key?{row,id:key,reused:true}:{row,id:`demand-transaction-${fresh++}`,reused:false};});
 return{selected,failed:rows.filter(r=>r.err!==null&&inside(r)).length,fresh,capExceeded:fresh>DEMAND_TRANSACTION_CAP};
}
function hours(b:Bounds,rows:Row[],selected:Selected[],transactions:DemandTransaction[],ready:boolean):Hour[]{
 return Array.from({length:HOURS},(_,i)=>{
  const start=b.start+i*HOUR,end=start+HOUR,inside=(r:Row)=>r.blockTime!==null&&r.blockTime*1000>=start&&r.blockTime*1000<end;
  const own=new Set(selected.filter(s=>inside(s.row)).map(s=>s.row.signature)),seen=transactions.filter(t=>own.has(t.signature));
  return{start:iso(start),end:iso(end),successfulReferences:own.size,failedReferences:rows.filter(r=>r.err!==null&&inside(r)).length,complete:ready&&seen.length===own.size&&seen.every(t=>t.status==='OBSERVED')};
 });
}
function verifyPool(token:TokenRef,pool:string,anchorSlot:number,b:Bounds,receipts:ReceiptSet,cutoff:string,after:number,maxSlot:number){
 const response=read('demand-pool',demandPoolRequest(pool,anchorSlot),receipts,cutoff),r=response.value,v=object(r)?r.value:null;
 if(response.at<b.end||response.at<after||!object(r)||!object(r.context)||!integer(r.context.slot)||r.context.slot<anchorSlot||r.context.slot<maxSlot||!object(v)||v.owner!==PROGRAM||v.executable!==false||!Array.isArray(v.data)||v.data[1]!=='base64'||typeof v.data[0]!=='string'||v.data[0].length>10000)fail('ADVISORY_DEMAND_POOL_SHAPE');
 const encoded=v.data[0] as string,data=Buffer.from(encoded,'base64');if(data.toString('base64')!==encoded)fail('ADVISORY_DEMAND_POOL_SHAPE');
 let decoded:ReturnType<typeof PUMP_AMM_SDK.decodePool>|null=null;
 try{decoded=PUMP_AMM_SDK.decodePool({data,owner:PUMP_AMM_PROGRAM_ID,lamports:0,executable:false,rentEpoch:0});}catch{decoded=null;}
 if(!decoded)return fail('ADVISORY_DEMAND_POOL_SHAPE');
 if(decoded.baseMint.toBase58()!==token.address||!decoded.quoteMint.equals(NATIVE_MINT)||poolPda(decoded.index,decoded.creator,decoded.baseMint,decoded.quoteMint).toBase58()!==pool)fail('ADVISORY_DEMAND_POOL_BINDING');
 return{decoded,slot:r.context.slot as number,at:response.at};
}
function emptyHistory(token:TokenRef,window:AdvisoryWindowHistory,b:Bounds):DemandHistory{
 return{method:DEMAND_METHOD,eligible:false,token,pool:window.pool,range:{start:iso(b.start),baselineEnd:iso(b.baselineEnd),end:iso(b.end)},anchorSlot:window.anchorSlot,poolVerified:false,stateSlot:null,pages:[],indexReached:false,indexComplete:false,
  successfulReferences:0,failedReferences:0,freshTransactions:0,reusedTransactions:0,transactionCap:DEMAND_TRANSACTION_CAP,capExceeded:false,transactions:[],hours:[],trades:[],programAccounts:[],
  storage:{archiveMethod:DEMAND_ARCHIVE_METHOD,adapterVersion:DEMAND_ARCHIVE_ADAPTER,receipts:0,storedBytes:0,sourceBytes:0},complete:false,reasonCode:'SELECTED_POOL_WINDOW_INCOMPLETE'};
}

/** Rebuilds the complete [E-12h,E) selected-pool tape from retained raw receipts; any gap leaves it incomplete, never zero.
 * retainVirtualQuote (default false) only adds each trade's verified event virtual quote reserves for O29. */
export function decodeAdvisoryDemandWindows(token:TokenRef,window:AdvisoryWindowHistory,windowReceipts:ReceiptSet,rawArtifacts:Record<string,string>,retrievedAt:Record<string,string>,requests:Record<string,Request>,cutoff:string,retainVirtualQuote=false):DemandHistory{
 if(token.chain!=='solana'||window.token.chain!==token.chain||window.token.address!==token.address)fail('ADVISORY_DEMAND_SCOPE');
 const cut=Date.parse(cutoff),endMs=Date.parse(window.window.end);
 if(!Number.isFinite(cut)||!Number.isFinite(endMs)||endMs>cut)fail('ADVISORY_DEMAND_TIME');
 const rawKeys=Object.keys(rawArtifacts).sort();
 if(rawKeys.length>DEMAND_REQUEST_CAP||JSON.stringify(rawKeys)!==JSON.stringify(Object.keys(requests).sort())||JSON.stringify(rawKeys)!==JSON.stringify(Object.keys(retrievedAt).sort()))fail('ADVISORY_DEMAND_RECEIPT_MEMBERSHIP');
 if(rawKeys.length&&!eligible(window))fail('ADVISORY_DEMAND_RECEIPT_MEMBERSHIP');
 // Only this namespace's archives are unpacked, each under its own response ceiling; reused O28 receipts stay plain.
 const plain:Record<string,string>={};let storedBytes=0,sourceBytes=0;
 for(const k of rawKeys){const text=unpackDemandReceipt(rawArtifacts[k]!,demandArchiveSourceLimit(k));plain[k]=text;storedBytes+=Buffer.byteLength(rawArtifacts[k]!);sourceBytes+=Buffer.byteLength(text);}
 const b=bounds(window),result=emptyHistory(token,window,b),receipts:ReceiptSet={rawArtifacts:plain,retrievedAt,requests},used=new Set<string>();
 result.storage={...result.storage,receipts:rawKeys.length,storedBytes,sourceBytes};
 const finish=()=>{if(rawKeys.some(k=>!used.has(k)))fail('ADVISORY_DEMAND_RECEIPT_MEMBERSHIP');return result;};
 if(!eligible(window))return finish();
 result.eligible=true;result.reasonCode='ADVISORY_DEMAND_INCOMPLETE';
 const anchorRetrieved=Date.parse(windowReceipts.retrievedAt['window-anchor-time']??'');
 if(!Number.isFinite(anchorRetrieved)){result.reasonCode='ADVISORY_DEMAND_ANCHOR';result.hours=hours(b,[],[],[],false);return finish();}
 const pool=window.pool!,anchorSlot=window.anchorSlot!;
 const indexed=index(pool,anchorSlot,anchorRetrieved,b,receipts,cutoff);for(const id of indexed.used)used.add(id);
 const plan=assign(indexed.rows,b,windowReceipts);
 Object.assign(result,{pages:indexed.pages,indexReached:indexed.reached,indexComplete:indexed.complete,successfulReferences:plan.selected.length,failedReferences:plan.failed,freshTransactions:plan.fresh,reusedTransactions:plan.selected.length-plan.fresh,capExceeded:plan.capExceeded});
 const blocked=!indexed.complete?indexed.code??'ADVISORY_DEMAND_INDEX_INCOMPLETE':plan.capExceeded?'ADVISORY_DEMAND_TRANSACTION_CAP':null;
 // Collection reads no transactions or pool state after an incomplete index or over-cap tape.
 if(blocked){result.reasonCode=blocked;result.hours=hours(b,indexed.rows,plan.selected,[],false);return finish();}
 for(const s of plan.selected)if(!s.reused)used.add(s.id);used.add('demand-pool');
 if(rawKeys.some(k=>!used.has(k)))fail('ADVISORY_DEMAND_RECEIPT_MEMBERSHIP');
 const earlier=[...rawKeys.filter(k=>k!=='demand-pool').map(k=>Date.parse(retrievedAt[k]!)),...plan.selected.filter(s=>s.reused).map(s=>Date.parse(windowReceipts.retrievedAt[s.id]??''))].filter(Number.isFinite);
 let state:ReturnType<typeof verifyPool>|null=null,firstFailure:string|null=null;
 try{state=verifyPool(token,pool,anchorSlot,b,receipts,cutoff,Math.max(0,...earlier),Math.max(0,...plan.selected.map(s=>s.row.slot)));result.poolVerified=true;result.stateSlot=state.slot;}catch(error){firstFailure=errorCode(error);}
 const programs=new Set<string>();
 for(const s of plan.selected){
  const row=s.row,entry={signature:row.signature,slot:row.slot,at:iso(row.blockTime!*1000)},receipt=s.reused?'WINDOW' as const:'DEMAND' as const;
  try{
   if(!state)fail('ADVISORY_DEMAND_POOL_UNVERIFIED');
   const source=s.reused?windowReceipts:receipts,response=read(s.id,s.reused?windowTransactionRequest(row.signature):demandTransactionRequest(row.signature),source,cutoff);
   const value=s.reused?response.value:projectCompiledTransaction(response.value);
   if(response.at>state.at||response.at<b.end||response.at<row.blockTime!*1000||!object(value)||value.slot!==row.slot||value.blockTime!==row.blockTime||value.transaction?.signatures?.[0]!==row.signature||!Array.isArray(value.transaction?.message?.accountKeys)||!value.transaction.message.accountKeys.some((k:unknown)=>object(k)&&k.pubkey===pool))fail('ADVISORY_DEMAND_TRANSACTION_BINDING');
   // Opt-in log recovery: only closed, ancestor-proven flow survives a truncated log; unresolved invocations stay disclosed as unproven.
   const proof=decodePumpSwapWindowTransaction(value,entry,pool,state.decoded,state.slot,source.retrievedAt[s.id]!,true,true,true,retainVirtualQuote);
   result.transactions.push({...entry,receipt,status:'OBSERVED',trades:proof.trades.length,...(proof.logRecovery?{logRecovery:proof.logRecovery}:{})});
   for(const trade of proof.trades)result.trades.push({...trade,transactionIndex:row.transactionIndex});
   for(const account of proof.cpiAuthorizedAccounts)programs.add(account);
  }catch(error){const failure=bad(error);result.transactions.push({...entry,receipt,trades:0,...failure});firstFailure??=failure.code;}
 }
 result.trades.sort((x,y)=>x.slot-y.slot||(x.transactionIndex??-1)-(y.transactionIndex??-1)||x.signature.localeCompare(y.signature)||x.instructionIndex-y.instructionIndex);
 result.programAccounts=[...programs].sort();
 result.hours=hours(b,indexed.rows,plan.selected,result.transactions,result.poolVerified);
 result.complete=result.poolVerified&&result.transactions.length===plan.selected.length&&result.transactions.every(t=>t.status==='OBSERVED')&&result.hours.every(h=>h.complete);
 result.reasonCode=result.complete?'COMPLETE_POOL_BASELINE_DEMAND_OBSERVED':firstFailure??'ADVISORY_DEMAND_INCOMPLETE';
 return finish();
}

/** Bounded acquisition only after a complete fee-exclusive O28 hour; failures are retained as sanitized receipts, never thrown. */
async function collectPlainDemandWindows(token:TokenRef,window:ReceiptSet&{data:AdvisoryWindowHistory},rpcUrl:string,fetcher:typeof fetch,now:()=>string,signal?:AbortSignal):Promise<ReceiptSet>{
 if(token.chain!=='solana'||window.data.token.chain!==token.chain||window.data.token.address!==token.address)fail('ADVISORY_DEMAND_SCOPE');
 const receipts:ReceiptSet={rawArtifacts:{},retrievedAt:{},requests:{}},w=window.data,anchorRetrieved=Date.parse(window.retrievedAt['window-anchor-time']??'');
 if(!eligible(w)||!Number.isFinite(anchorRetrieved))return receipts;
 const b=bounds(w),pool=w.pool!,anchorSlot=w.anchorSlot!;
 const run=async(id:string,request:Request,maxBytes:number,readTimeoutMs?:number)=>{
  receipts.requests[id]=request;
  try{await solanaRpc(rpcUrl,request.method,request.params,fetcher,maxBytes,signal,raw=>{receipts.rawArtifacts[id]=raw;receipts.retrievedAt[id]=now();},readTimeoutMs);}
  catch(error){if(!receipts.rawArtifacts[id]){receipts.rawArtifacts[id]=JSON.stringify({jsonrpc:'2.0',id:1,error:{code:safeRpcCode(error)}});receipts.retrievedAt[id]=now();}}
 };
 let before:string|undefined;
 for(let i=0;i<DEMAND_MAX_PAGES;i++){
  await run(`demand-page-${i}`,demandPageRequest(pool,anchorSlot,before),PAGE_RESPONSE_BYTES,DEMAND_PAGE_TIMEOUT_MS);
  const current=index(pool,anchorSlot,anchorRetrieved,b,receipts,now()),last=current.pages.at(-1);
  if(current.reached||!last||last.id!==`demand-page-${i}`||last.status==='INVALID'||last.status==='UNAVAILABLE')break;
  before=current.rows.at(-1)?.signature;if(!before)break;
 }
 const indexed=index(pool,anchorSlot,anchorRetrieved,b,receipts,now());
 if(!indexed.complete)return receipts;
 const plan=assign(indexed.rows,b,window);
 if(plan.capExceeded)return receipts;
 const fresh=plan.selected.filter(s=>!s.reused);
 for(let offset=0;offset<fresh.length;offset+=2)await Promise.all(fresh.slice(offset,offset+2).map(s=>run(s.id,demandTransactionRequest(s.row.signature),RECEIPT_RESPONSE_BYTES)));
 await run('demand-pool',demandPoolRequest(pool,anchorSlot),RECEIPT_RESPONSE_BYTES);
 return receipts;
}
/** Bounded acquisition; every fresh receipt, including sanitized error envelopes, is retained as its exact reversible archive with the original clock and request. */
export async function collectAdvisoryDemandWindows(token:TokenRef,window:ReceiptSet&{data:AdvisoryWindowHistory},rpcUrl:string,fetcher:typeof fetch,now:()=>string,signal?:AbortSignal):Promise<ReceiptSet>{
 const plain=await collectPlainDemandWindows(token,window,rpcUrl,fetcher,now,signal);
 return{rawArtifacts:Object.fromEntries(Object.entries(plain.rawArtifacts).map(([key,raw])=>[key,archiveDemandReceipt(raw)])),retrievedAt:plain.retrievedAt,requests:plain.requests};
}

/** A30 over the preregistered six completed hours after a six-hour baseline; null keeps the older sampled metric when O28 is not eligible. */
export function deriveA30DemandWindows(history:DemandHistory,evidenceIds:string[]):AdvisoryMetric|null{
 if(!history.eligible)return null;
 const start=Date.parse(history.range.start),threshold=BigInt(MEANINGFUL_CORE_QUOTE_ATOMIC),program=new Set(history.programAccounts),known=history.complete;
 const hourOf=(t:DemandTrade)=>Math.floor((Date.parse(t.at)-start)/HOUR);
 const flows=history.hours.map((hour,i)=>{
  let buy=0n,sell=0n,programQuote=0n,programTrades=0,decoded=0;
  for(const t of history.trades){if(hourOf(t)!==i)continue;decoded++;const q=BigInt(t.quoteAtomic);if(t.side==='BUY')buy+=q;else sell+=q;if(program.has(t.user)){programTrades++;programQuote+=q;}}
  return{...hour,coverage:hour.complete?'COMPLETE' as const:'INCOMPLETE' as const,decodedTrades:decoded,buyQuoteAtomic:String(buy),sellQuoteAtomic:String(sell),netQuoteAtomic:String(buy-sell),programAccountTrades:programTrades,programAccountQuoteAtomic:String(programQuote)};
 });
 // First observation is defined over the complete tape only; partial tape cannot certify novelty.
 const first=new Map<string,DemandTrade>();
 if(known)for(const t of history.trades)if(t.side==='BUY'&&!program.has(t.user)&&BigInt(t.quoteAtomic)>=threshold&&!first.has(t.user))first.set(t.user,t);
 const baseline=history.trades.filter(t=>hourOf(t)<BASELINE_HOURS);
 const windows=flows.slice(BASELINE_HOURS).map((flow,k)=>{
  const buyers=known?[...first.values()].filter(t=>hourOf(t)===BASELINE_HOURS+k).map(t=>({user:t.user,signature:t.signature,slot:t.slot,at:t.at,coreQuoteAtomic:t.quoteAtomic,
   baselineSell:baseline.some(x=>x.user===t.user&&x.side==='SELL'),baselineSubThresholdBuy:baseline.some(x=>x.user===t.user&&x.side==='BUY'&&BigInt(x.quoteAtomic)<threshold)})):null;
  return{...flow,newMeaningfulBuyers:buyers,newMeaningfulBuyerCount:buyers?buyers.length:null,condition:buyers?buyers.length>0&&BigInt(flow.netQuoteAtomic)>=0n:null};
 });
 const satisfied=known?windows.filter(w=>w.condition===true).length:null,observed=history.transactions.filter(t=>t.status==='OBSERVED');
 return{id:'A30',quality:known?'KNOWN':'MISSING',unit:UNIT,evidenceIds:[...new Set(evidenceIds)],reasonCode:history.reasonCode,data:{
  method:DEMAND_METHOD,scope:'VERIFIED_PUMPSWAP_WSOL_POOL',pool:history.pool,range:history.range,windowEnd:history.range.end,anchorSlot:history.anchorSlot,stateSlot:history.stateSlot,poolVerified:history.poolVerified,
  index:{pageLimit:DEMAND_PAGE_LIMIT,maxPages:DEMAND_MAX_PAGES,pages:history.pages,reached:history.indexReached,complete:history.indexComplete},
  transactionCap:history.transactionCap,capExceeded:history.capExceeded,successfulReferences:history.successfulReferences,failedReferences:history.failedReferences,freshTransactions:history.freshTransactions,reusedTransactions:history.reusedTransactions,
  unresolvedTransactions:history.transactions.filter(t=>t.status!=='OBSERVED').slice(0,20).map(t=>({signature:t.signature,receipt:t.receipt,status:t.status,code:t.code??null})),
  storage:{...history.storage,encoding:DEMAND_ARCHIVE_ENCODING,storedAggregateCapBytes:24_000_000,meaning:'storedBytes are encoded archives counted against the unchanged 24 MB live artifact cap; sourceBytes are the exact uncompressed RPC bodies, reported only and not claimed to fit that cap'},
  logRecovery:{truncatedTransactions:observed.filter(t=>t.logRecovery?.truncated).length,unresolvedNonFlowInvocations:observed.reduce((n,t)=>n+(t.logRecovery?.unresolvedInvocations??0),0),emptyForeignSweeps:observed.reduce((n,t)=>n+(t.logRecovery?.emptyForeignSweeps??0),0),
   rule:'truncated logs certify only selected-pool flow closed before the marker; unresolved later invocations are non-flow and not proven executed'},
  quoteMint:WSOL,quoteDecimals:9,quoteBasis:'fee-exclusive core quote atomic units',meaningfulThreshold:{coreQuoteAtomic:MEANINGFUL_CORE_QUOTE_ATOMIC,quoteUnits:'0.01',meaning:'existing descriptive research threshold, not profitability or organic demand'},
  identityUnit:'decoded PumpSwap trade user account; never merged and not a person',newBuyerRule:NEW_BUYER_RULE,
  programAccounts:{rule:'CPI-authorized decoded users anywhere in the tape; excluded from buyer sets, retained in flow',accounts:history.programAccounts},
  baseline:{start:history.range.start,end:history.range.baselineEnd,complete:flows.slice(0,BASELINE_HOURS).every(f=>f.complete),meaningfulBuyers:known?[...first.values()].filter(t=>hourOf(t)<BASELINE_HOURS).length:null,hours:flows.slice(0,BASELINE_HOURS)},
  windows,denominator:windows.length,satisfiedWindows:satisfied,share:satisfied===null?null:new Decimal(satisfied).div(windows.length).toFixed(),complete:known,
  sourceUniverseComplete:false,wholeTokenFlow:null,newCapital:null,limitations:LIMITATIONS,
 }};
}
