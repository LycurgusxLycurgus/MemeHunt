import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {isDeepStrictEqual as same} from 'node:util';
import {z} from 'zod';
import {PUMP_AMM_SDK,PUMP_AMM_PROGRAM_ID} from '@pump-fun/pump-swap-sdk';
import {tokenRefSchema,type TokenRef,type EvidenceRecord} from '../domain/contracts.js';
import {decodeAdvisoryWindow,type AdvisoryWindowHistory,type AdvisoryWindowReuse} from './advisory-window.js';
import {decodeSolanaAddress,encodeSolanaAddress} from './solana.js';
import {bindInventoryReturnEndpoints,type InventoryReturnBinding} from './advisory-inventory-return-accounts.js';
import {assertInventoryReturnCompanionParity} from './advisory-inventory-return-runtime.js';

export const INVENTORY_RETURNS_METHOD='o26-local-retained-rpc-capture-v1' as const;
export const INVENTORY_RETURNS_CHUNK_METHOD='o26-local-retained-rpc-records-v1' as const;
export const INVENTORY_RETURNS_SOURCE_ID='advisory-inventory-returns';
export const INVENTORY_RETURNS_PREFIX=INVENTORY_RETURNS_SOURCE_ID+'-';
export const INVENTORY_RETURNS_ADAPTER='o26-account-receipts-v1';
export const INVENTORY_RETURNS_ARCHIVE_METHOD='o23-deflate-raw-v1' as const;
export const INVENTORY_RETURNS_STORED_BYTES=32*1024*1024,INVENTORY_RETURNS_SOURCE_BYTES=128*1024*1024,INVENTORY_RETURNS_CHUNK_BYTES=32_000_000,INVENTORY_RETURNS_MANIFEST_BYTES=500_000,INVENTORY_RETURNS_NATIVE_BYTES=500_000;
const int=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),positive=int.positive(),instant=z.iso.datetime({offset:true}),hash=z.string().regex(/^[a-f0-9]{64}$/);
const family=z.enum(['WINDOW','INDEX','OFFPOOL','COMPILED_POOL','COMPILED_OFFPOOL']);
const requestSchema=z.object({method:z.string(),params:z.array(z.unknown())}).strict();
const recordSchema=z.object({key:z.string(),kind:family,id:z.string(),request:requestSchema,retrievedAt:instant,sourceBytes:positive.max(INVENTORY_RETURNS_NATIVE_BYTES),sourceHash:hash,raw:z.string()}).strict();
const chunkSchema=z.object({id:z.string().regex(/^chunk-(?:0|[1-9][0-9]?)$/),file:z.string(),encoding:z.literal('DEFLATE_RAW_BINARY'),sourceBytes:positive.max(INVENTORY_RETURNS_CHUNK_BYTES),sourceHash:hash,archiveBytes:positive.max(INVENTORY_RETURNS_STORED_BYTES),archiveHash:hash,recordKeys:z.array(z.string()).min(1).max(3072)}).strict();
export const inventoryReturnsManifestSchema=z.object({method:z.literal(INVENTORY_RETURNS_METHOD),token:tokenRefSchema,pool:z.string(),windowEnd:instant,createdAt:instant,sourceSemantics:z.string().min(1).max(1000),windowOrigin:z.object({snapshot:z.string().min(1),source:z.literal('ACCEPTED_ARCHIVED_WINDOW'),bankClock:instant}).strict(),recordCounts:z.object({WINDOW:int,INDEX:int,OFFPOOL:int,COMPILED_POOL:int,COMPILED_OFFPOOL:int}).strict(),nativeRecords:positive.max(3072),nativeSourceBytes:positive.max(INVENTORY_RETURNS_SOURCE_BYTES),chunks:z.array(chunkSchema).min(1).max(15)}).strict();
const receiptsSchema=z.object({method:z.literal(INVENTORY_RETURNS_METHOD),token:tokenRefSchema,pool:z.string(),windowEnd:instant,createdAt:instant,rawArtifacts:z.record(z.string(),z.string())}).strict();
const descriptorSchema=z.object({method:z.literal(INVENTORY_RETURNS_METHOD),token:tokenRefSchema,pool:z.string(),windowEnd:instant,createdAt:instant,manifestId:z.string(),chunkIds:z.array(z.string()).min(1).max(15)}).strict();
const archiveSchema=z.object({method:z.literal(INVENTORY_RETURNS_ARCHIVE_METHOD),encoding:z.literal('DEFLATE_RAW_BASE64'),sourceBytes:positive.max(INVENTORY_RETURNS_CHUNK_BYTES),sourceHash:hash,data:z.string()}).strict();
export type InventoryReturnReceipts=z.infer<typeof receiptsSchema>;
export type InventoryReturnDescriptor=z.infer<typeof descriptorSchema>;
export type InventoryReturnNativeRecord=z.infer<typeof recordSchema>;
export type InventoryReturnPoolContext={poolKey:string;pool:ReturnType<typeof PUMP_AMM_SDK.decodePool>;stateSlot:number;quote:{mint:string;program:string;decimals:number}};
export type InventoryReturnIndexRow={signature:string;slot:number;blockTime:number;transactionIndex:number;err:null|object|string};
export type InventoryReturnTransaction={value:any;at:string;record:InventoryReturnNativeRecord};
export type InventoryReturnSourceContext={cutoff:string;window:AdvisoryWindowHistory;windowReceipts:AdvisoryWindowReuse;poolContext:InventoryReturnPoolContext;windowNativeRecords:Map<string,InventoryReturnTransaction>;transactions:Map<string,InventoryReturnTransaction>;indexes:Map<string,InventoryReturnIndexRow[]>;companions:Map<string,InventoryReturnTransaction>;bindings:InventoryReturnBinding;summary:{nativeRecords:number;nativeSourceBytes:number;storedBytes:number;indexPages:number;accountReferences:number;uniqueReferences:number;successfulReferences:number;failedReferences:number;successfulBodyContexts:number;windowBodies:number;contextPoolBodies:number;offpoolBodies:number;compiledCompanions:number}};
const fail=(code:string):never=>{throw Error('ADVISORY_INVENTORY_RETURNS_'+code);};
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const utf8=(s:string)=>Buffer.from(s).toString('utf8')===s;
const time=(s:string)=>{const n=Date.parse(s);if(!Number.isFinite(n))fail('CLOCK');return n;};
const address=(s:string)=>{try{decodeSolanaAddress(s);}catch{fail('ADDRESS');}return s;};
const signature=(s:unknown)=>{if(typeof s!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s))return fail('SIGNATURE');let n=0n;const a='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';for(const c of s)n=n*58n+BigInt(a.indexOf(c));const h=n.toString(16),b=Buffer.concat([Buffer.alloc(s.match(/^1*/)?.[0].length??0),n?Buffer.from(h.length%2?'0'+h:h,'hex'):Buffer.alloc(0)]);if(b.length!==64||encodeSolanaAddress(b)!==s)fail('SIGNATURE');return s;};
const unitErrors=new Set(['AccountInUse','AccountLoadedTwice','AccountNotFound','ProgramAccountNotFound','InsufficientFundsForFee','InvalidAccountForFee','AlreadyProcessed','BlockhashNotFound','CallChainTooDeep','MissingSignatureForFee','InvalidAccountIndex','SignatureFailure','InvalidProgramForExecution','SanitizeFailure','ClusterMaintenance','AccountBorrowOutstanding','WouldExceedMaxBlockCostLimit','UnsupportedVersion','InvalidWritableAccount','WouldExceedMaxAccountCostLimit','WouldExceedAccountDataBlockLimit','TooManyAccountLocks','AddressLookupTableNotFound','InvalidAddressLookupTableOwner','InvalidAddressLookupTableData','InvalidAddressLookupTableIndex','InvalidRentPayingAccount','WouldExceedMaxVoteCostLimit','WouldExceedAccountDataTotalLimit','MaxLoadedAccountsDataSizeExceeded','InvalidLoadedAccountsDataSizeLimit','ResanitizationNeeded','UnbalancedTransaction','ProgramCacheHitMaxLimit','CommitCancelled']);
/** Existing archive literal is reused only as a reversible byte container, never as O23 source authority. */
export function unpackInventoryReturnChunk(text:string):string{
 let a:z.infer<typeof archiveSchema>;try{a=archiveSchema.parse(JSON.parse(text));}catch{return fail('ARCHIVE');}
 if(!utf8(text)||JSON.stringify(a)!==text)fail('ARCHIVE_CANONICAL');const packed=Buffer.from(a.data,'base64');if(packed.toString('base64')!==a.data)fail('BASE64');
 let raw:Buffer;try{const result=inflateRawSync(packed,{maxOutputLength:a.sourceBytes,info:true}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};if(result.engine.bytesWritten!==packed.length)fail('TRAILING_BYTES');raw=result.buffer;}catch{return fail('INFLATION');}
 if(raw.length!==a.sourceBytes||sha(raw)!==a.sourceHash)fail('CHUNK_HASH');const decoded=raw.toString('utf8');if(!Buffer.from(decoded).equals(raw))fail('UTF8');return decoded;
}
export function validateInventoryReturnReceiptShape(value:InventoryReturnReceipts,cutoff:string):InventoryReturnReceipts{
 let r:InventoryReturnReceipts;try{r=receiptsSchema.parse(value);}catch{return fail('RECEIPT_SCHEMA');}address(r.token.address);address(r.pool);if(r.token.chain!=='solana'||time(r.createdAt)>time(cutoff)||time(r.windowEnd)>time(r.createdAt))fail('SCOPE');
 const ids=Object.keys(r.rawArtifacts);if(ids.length<2||ids.length>16||!ids.includes('manifest')||ids.some(k=>k!=='manifest'&&!/^chunk-(?:0|[1-9][0-9]?)$/.test(k)))fail('OUTER_MEMBERSHIP');let stored=0;for(const[id,raw]of Object.entries(r.rawArtifacts)){if(!utf8(raw)||Buffer.byteLength(raw)>(id==='manifest'?INVENTORY_RETURNS_MANIFEST_BYTES:INVENTORY_RETURNS_STORED_BYTES)||(stored+=Buffer.byteLength(raw))>INVENTORY_RETURNS_STORED_BYTES)fail('STORED_BOUND');}return r;
}
function records(r:InventoryReturnReceipts){
 let m:z.infer<typeof inventoryReturnsManifestSchema>;try{m=inventoryReturnsManifestSchema.parse(JSON.parse(r.rawArtifacts.manifest!));}catch{return fail('MANIFEST');}
 if(!same({method:m.method,token:m.token,pool:m.pool,windowEnd:m.windowEnd,createdAt:m.createdAt},{method:r.method,token:r.token,pool:r.pool,windowEnd:r.windowEnd,createdAt:r.createdAt}))fail('MANIFEST_SCOPE');
 const all:InventoryReturnNativeRecord[]=[],seen=new Set<string>();let inflated=0,sourceBytes=0;const counts={WINDOW:0,INDEX:0,OFFPOOL:0,COMPILED_POOL:0,COMPILED_OFFPOOL:0};
 if(!same(Object.keys(r.rawArtifacts).sort(),['manifest',...m.chunks.map(c=>c.id)].sort()))fail('CHUNK_MEMBERSHIP');if(m.chunks.reduce((n,c)=>n+c.sourceBytes,0)>INVENTORY_RETURNS_SOURCE_BYTES)fail('INFLATED_TOTAL');
 for(const[i,c]of m.chunks.entries()){
  if(c.id!=='chunk-'+i||c.file!==c.id+'.deflate'||(inflated+=c.sourceBytes)>INVENTORY_RETURNS_SOURCE_BYTES)fail('CHUNK_CATALOG');const wrapper=r.rawArtifacts[c.id]!;let a:any;try{a=JSON.parse(wrapper);}catch{return fail('ARCHIVE');}const packed=Buffer.from(a.data??'','base64');if(a.sourceBytes!==c.sourceBytes||a.sourceHash!==c.sourceHash||packed.length!==c.archiveBytes||sha(packed)!==c.archiveHash)fail('CHUNK_CATALOG');
  let body:{method:typeof INVENTORY_RETURNS_CHUNK_METHOD;records:InventoryReturnNativeRecord[]};try{body=z.object({method:z.literal(INVENTORY_RETURNS_CHUNK_METHOD),records:z.array(recordSchema).min(1).max(3072)}).strict().parse(JSON.parse(unpackInventoryReturnChunk(wrapper)));}catch(error){if(error instanceof Error&&error.message.startsWith('ADVISORY_INVENTORY_RETURNS_'))throw error;return fail('CHUNK_RECORDS');}
  if(!same(body.records.map(v=>v.key),c.recordKeys))fail('RECORD_CATALOG');
  for(const v of body.records){if(!(/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/).test(v.id)||v.key!==v.kind+':'+v.id||seen.has(v.key)||!utf8(v.raw)||Buffer.byteLength(v.raw)!==v.sourceBytes||sha(v.raw)!==v.sourceHash||time(v.retrievedAt)>time(r.createdAt)||time(v.retrievedAt)<time(r.windowEnd))fail('NATIVE_RECORD');seen.add(v.key);all.push(v);counts[v.kind]++;sourceBytes+=v.sourceBytes;if(all.length>3072||sourceBytes>INVENTORY_RETURNS_SOURCE_BYTES)fail('NATIVE_BOUND');}
 }
 if(!same(counts,m.recordCounts)||all.length!==m.nativeRecords||sourceBytes!==m.nativeSourceBytes||counts.INDEX>1024||counts.OFFPOOL>1024||counts.COMPILED_POOL+counts.COMPILED_OFFPOOL>128)fail('RECORD_COUNTS');
 return{manifest:m,all};
}
function result(r:InventoryReturnNativeRecord):any{let x:any;try{x=JSON.parse(r.raw);}catch{return fail('RPC_JSON');}if(!object(x)||!same(Object.keys(x).sort(),['id','jsonrpc','result'])||x.jsonrpc!=='2.0'||x.id!==1)return fail('RPC_ENVELOPE');return x.result;}
const expect=(r:InventoryReturnNativeRecord,request:unknown)=>{if(!same(r.request,request))fail('NATIVE_REQUEST');};
function sequence(list:InventoryReturnNativeRecord[],prefix:string){const sorted=[...list].sort((a,b)=>Number(a.id.slice(prefix.length))-Number(b.id.slice(prefix.length)));if(sorted.some((r,i)=>r.id!==prefix+i))fail('RECORD_SEQUENCE');return sorted;}
function transaction(r:InventoryReturnNativeRecord,encoding:'json'|'jsonParsed'){
 const sig=signature(r.request.params[0]);expect(r,{method:'getTransaction',params:[sig,{encoding,commitment:'finalized',maxSupportedTransactionVersion:1}]});const v=result(r);if(!object(v)||!integer(v.slot)||!integer(v.blockTime)||!integer(v.transactionIndex)||!object(v.meta)||v.meta.err!==null||!['legacy',0,1].includes(v.version)||v.transaction?.signatures?.[0]!==sig||v.blockTime*1000>time(r.retrievedAt))fail('TRANSACTION');return{signature:sig,value:v,at:r.retrievedAt,record:r};
}
/** Full source reconstruction, including roster derivation and the reverse body/index join, precedes any storage allowance. */
export function decodeInventoryReturnSource(input:InventoryReturnReceipts,cutoff:string):InventoryReturnSourceContext{
 const r=validateInventoryReturnReceiptShape(input,cutoff),{manifest,all}=records(r),wr:AdvisoryWindowReuse={rawArtifacts:{},retrievedAt:{},requests:{}};
 for(const rec of all.filter(v=>v.kind==='WINDOW')){wr.rawArtifacts[rec.id]=rec.raw;wr.retrievedAt[rec.id]=rec.retrievedAt;wr.requests[rec.id]=rec.request;}
 if(wr.retrievedAt['window-pool']!==manifest.windowOrigin.bankClock)fail('WINDOW_ORIGIN');
 const window=decodeAdvisoryWindow(r.token,r.pool,r.windowEnd,wr.rawArtifacts,wr.retrievedAt,wr.requests,cutoff,true,true,true,true,true,true,true,true,true);if(!window.complete||!window.pool||window.stateSlot===null||!window.quote||window.anchorSlot===null)return fail('WINDOW_INCOMPLETE');
 const{stateSlot,quote,anchorSlot}=window;
 const bank=result(all.find(v=>v.kind==='WINDOW'&&v.id==='window-pool')??fail('WINDOW_BANK'));let pool:ReturnType<typeof PUMP_AMM_SDK.decodePool>;try{pool=PUMP_AMM_SDK.decodePool({data:Buffer.from(bank.value[0].data[0],'base64'),owner:PUMP_AMM_PROGRAM_ID,lamports:0,executable:false,rentEpoch:0});}catch{return fail('WINDOW_BANK');}
 const poolContext:InventoryReturnPoolContext={poolKey:r.pool,pool:pool!,stateSlot,quote},windowNativeRecords=new Map<string,InventoryReturnTransaction>();
 for(const rec of all.filter(v=>v.kind==='WINDOW'&&v.id.startsWith('window-transaction-'))){const t=transaction(rec,'jsonParsed');if(windowNativeRecords.has(t.signature))fail('WINDOW_DUPLICATE');windowNativeRecords.set(t.signature,t);}
 const bindings=bindInventoryReturnEndpoints(window,poolContext,windowNativeRecords),accounts=bindings.accounts;if(accounts.length<1||accounts.length>512||!same(accounts,[...new Set(accounts)].sort()))fail('ROSTER');
 const indexes=new Map<string,InventoryReturnIndexRow[]>(),unique=new Map<string,InventoryReturnIndexRow>(),indexedByAccount=new Map<string,Map<string,InventoryReturnIndexRow>>();let pages=0,accountReferences=0;
 const indexRecords=all.filter(v=>v.kind==='INDEX'),usedIndex=new Set<string>(),start=Date.parse(window.window.start)/1000,end=Date.parse(window.window.end)/1000;
 for(const[k,account]of accounts.entries()){
  const rows:InventoryReturnIndexRow[]=[],own=new Map<string,InventoryReturnIndexRow>();let cursor:string|null=null,lastSlot=Infinity,lastPosition=Infinity,lastTime=Infinity,lastClock=time(wr.retrievedAt['window-anchor-time']!),terminal=false;
  for(let page=0;page<8;page++){
   const rec=indexRecords.find(v=>v.id===`account-${k}-page-${page}`);if(!rec)fail('INDEX_INCOMPLETE');usedIndex.add(rec!.key);pages++;const at=time(rec!.retrievedAt);if(at<lastClock)fail('INDEX_CLOCK');lastClock=at;
   expect(rec!,{method:'getTransactionsForAddress',params:[account,{transactionDetails:'signatures',commitment:'finalized',minContextSlot:anchorSlot,sortOrder:'desc',limit:1000,...(cursor?{paginationToken:cursor}:{}),filters:{blockTime:{gte:start,lt:end},status:'any',tokenAccounts:'none'}}]});const body=result(rec!);if(!object(body)||!same(Object.keys(body).sort(),['data','paginationToken'])||!Array.isArray(body.data)||body.data.length>1000||!(body.paginationToken===null||typeof body.paginationToken==='string'))fail('INDEX_SHAPE');
   for(const row of body.data){if(!object(row)||!integer(row.slot)||row.slot>anchorSlot||!integer(row.transactionIndex)||!integer(row.blockTime)||row.blockTime<start||row.blockTime>=end||row.blockTime*1000>at||row.confirmationStatus!=='finalized'||!(row.err===null||object(row.err)||typeof row.err==='string'&&unitErrors.has(row.err)))fail('INDEX_ROW');const sig=signature(row.signature);if(own.has(sig)||row.slot>lastSlot||row.slot===lastSlot&&row.transactionIndex>=lastPosition||row.blockTime>lastTime)fail('INDEX_ORDER');lastSlot=row.slot;lastPosition=row.transactionIndex;lastTime=row.blockTime;const item:InventoryReturnIndexRow={signature:sig,slot:row.slot,blockTime:row.blockTime,transactionIndex:row.transactionIndex,err:row.err};const old=unique.get(sig);if(old&&!same(old,item))fail('CROSS_ACCOUNT_METADATA');unique.set(sig,item);own.set(sig,item);rows.push(item);accountReferences++;}
   const next=body.paginationToken;if(next===null){if(body.data.length!==0)fail('INDEX_TERMINAL');terminal=true;break;}if(!body.data.length||next!==`${lastSlot}:${lastPosition}`||next===cursor)fail('INDEX_CURSOR');cursor=next;
  }
  if(!terminal)fail('INDEX_INCOMPLETE');indexes.set(account,rows);indexedByAccount.set(account,own);
 }
 if(usedIndex.size!==indexRecords.length)fail('INDEX_ORPHAN');
 const transactions=new Map(windowNativeRecords),offpool=sequence(all.filter(v=>v.kind==='OFFPOOL'),'missing-transaction-');
 for(const rec of offpool){const t=transaction(rec,'jsonParsed');if(transactions.has(t.signature)||!unique.has(t.signature)||unique.get(t.signature)!.err!==null)fail('BODY_ORPHAN');transactions.set(t.signature,t);}
 let contexts=0,contextPoolBodies=0;
 for(const[sig,t]of transactions){const row=unique.get(sig),keys=t.value.transaction?.message?.accountKeys;if(!Array.isArray(keys)||keys.some((v:any)=>!object(v)||typeof v.pubkey!=='string'))fail('BODY_KEYS');const keySet=new Set(keys.map((v:any)=>address(v.pubkey)));let touched=0;
  if(row&&(row.err!==null||row.slot!==t.value.slot||row.blockTime!==t.value.blockTime||row.transactionIndex!==t.value.transactionIndex))fail('BODY_METADATA');
  for(const account of accounts){const own=indexedByAccount.get(account)!,has=own.has(sig),present=keySet.has(account);if(has!==present)fail('REVERSE_BODY_INDEX');if(has){touched++;contexts++;}}
  if(!touched){if(!windowNativeRecords.has(sig)||row)fail('BODY_ORPHAN');contextPoolBodies++;}
 }
 for(const[sig,row]of unique)if(row.err===null&&!transactions.has(sig))fail('BODY_MISSING');
 for(const b of bindings.bindings)if(!indexedByAccount.get(b.account)?.has(b.signature))fail('SELECTED_INDEX_MISSING');
 const companions=new Map<string,InventoryReturnTransaction>();for(const[kind,prefix]of [['COMPILED_POOL','compiled-'],['COMPILED_OFFPOOL','offpool-compiled-']]as const)for(const rec of sequence(all.filter(v=>v.kind===kind),prefix)){const t=transaction(rec,'json'),native=transactions.get(t.signature);if(!native||!unique.has(t.signature)||companions.has(t.signature)||t.value.transactionIndex!==native.value.transactionIndex||(kind==='COMPILED_POOL')!==windowNativeRecords.has(t.signature)||time(t.at)<time(native.at))fail('COMPANION_MEMBERSHIP');assertInventoryReturnCompanionParity(native!.value,t.value);companions.set(t.signature,t);}
 const successful=[...unique.values()].filter(v=>v.err===null).length;
 return{cutoff,window,windowReceipts:wr,poolContext,windowNativeRecords,transactions,indexes,companions,bindings,summary:{nativeRecords:all.length,nativeSourceBytes:manifest.nativeSourceBytes,storedBytes:Object.values(r.rawArtifacts).reduce((n,s)=>n+Buffer.byteLength(s),0),indexPages:pages,accountReferences,uniqueReferences:unique.size,successfulReferences:successful,failedReferences:unique.size-successful,successfulBodyContexts:contexts,windowBodies:windowNativeRecords.size,contextPoolBodies,offpoolBodies:offpool.length,compiledCompanions:companions.size}};
}
export function inventoryReturnContainerScope(r:Pick<InventoryReturnReceipts,'method'|'rawArtifacts'>,localId:string){return{container:{method:r.method,manifestHash:sha(r.rawArtifacts.manifest??''),part:localId}};}
export function validateInventoryReturnStorage(bundle:{token:TokenRef;rawArtifacts:Record<string,string>;evidence:EvidenceRecord[]},descriptor:InventoryReturnDescriptor,cutoff:string):Set<string>{
 const{rawArtifacts,evidence}=bundle;
 let d:InventoryReturnDescriptor;try{d=descriptorSchema.parse(descriptor);}catch{return fail('DESCRIPTOR');}if(!same(d.token,bundle.token))fail('STORAGE_TOKEN');const ids=[d.manifestId,...d.chunkIds],owned=evidence.filter(e=>e.sourceId===INVENTORY_RETURNS_SOURCE_ID||e.id.startsWith(INVENTORY_RETURNS_PREFIX)),rawOwned=Object.keys(rawArtifacts).filter(id=>id.startsWith(INVENTORY_RETURNS_PREFIX));if(new Set(ids).size!==ids.length||!same([...ids].sort(),owned.map(e=>e.id).sort())||!same([...ids].sort(),rawOwned.sort()))fail('STORAGE_MEMBERSHIP');
 const r:InventoryReturnReceipts={method:d.method,token:d.token,pool:d.pool,windowEnd:d.windowEnd,createdAt:d.createdAt,rawArtifacts:{manifest:rawArtifacts[d.manifestId]??''}};
 for(const[local,id]of [['manifest',d.manifestId],...d.chunkIds.map((id,i)=>['chunk-'+i,id])]as Array<[string,string]>){if(id!==INVENTORY_RETURNS_PREFIX+local||evidence.filter(e=>e.id===id).length!==1)fail('STORAGE_ID');const e=owned.find(v=>v.id===id)!;if(e.sourceId!==INVENTORY_RETURNS_SOURCE_ID||e.accessMode!=='USER_IMPORT'||e.sourceType!=='HISTORICAL_RECEIPT'||e.adapterVersion!==INVENTORY_RETURNS_ADAPTER||!same(e.scope,inventoryReturnContainerScope(r,local))||e.availableAt!==r.createdAt||e.retrievedAt!==r.createdAt||e.contentHash!==sha(rawArtifacts[id]??''))fail('STORAGE_RECORD');r.rawArtifacts[local]=rawArtifacts[id]!;}
 decodeInventoryReturnSource(r,cutoff);return new Set(ids);
}
