import {createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
import {z} from 'zod';
import {PublicKey} from '@solana/web3.js';
import {getAssociatedTokenAddressSync,TOKEN_2022_PROGRAM_ID} from '@solana/spl-token';
import {tokenRefSchema,type TokenRef,type EvidenceRecord} from '../domain/contracts.js';
import {SOLANA_MAINNET_GENESIS,encodeSolanaAddress} from './solana.js';
import {unpackO23BulkSource,O23_BULK_ARCHIVE_METHOD} from './advisory-synchrony-bulk.js';
import {verifyPublicCreatorRole,CREATOR_ROLE_RECEIPTS,type PublicCreatorRole} from './advisory-creator-role.js';

export const O24_BULK_METHOD='o24-creator-wallet-absence-v2' as const;
export const O24_BULK_SOURCE_ID='advisory-creator-inventory-bulk';
export const O24_BULK_PREFIX=O24_BULK_SOURCE_ID+'-';
export const O24_BULK_ADAPTER='o24-wallet-absence-receipts-v1';
export const O24_BULK_STORED_BYTES=64*1024*1024,O24_BULK_SOURCE_BYTES=256_000_000,O24_BULK_PAGE_BYTES=32_000_000,O24_BULK_OTHER_BYTES=500_000,O24_BULK_REQUEST_CAP=49;
export const O24_BULK_ARCHIVE_METHOD=O23_BULK_ARCHIVE_METHOD;
export type O24BulkReceipts={method:typeof O24_BULK_METHOD;token:TokenRef;wallet:string;interval:{start:string;end:string};stateSlot:number;stateFloorSlot:number;roleIndexBefore:string|null;requests:Record<string,unknown>;rawArtifacts:Record<string,string>;retrievedAt:Record<string,string>};
export type O24BulkDescriptor=Omit<O24BulkReceipts,'rawArtifacts'|'retrievedAt'>&{artifactIds:Record<string,string>};
export type O24BulkIndexed={signature:string;slot:number;blockTime:number;transactionIndex:number|null;err:unknown};
export type O24BulkSourceContext={role:PublicCreatorRole;canonicalAccount:string;stateSlot:number;stateFloorSlot:number;interval:{start:string;end:string};head:any;ownerCatalog:any;stateBlockTime:number;canonicalRows:O24BulkIndexed[];walletRows:O24BulkIndexed[];counts:Record<string,number>;sourceBytes:number;storedBytes:number;sourceHashes:string[];receiptManifestHash:string};
export type O24BulkSourceVisitor=(tx:any,indexed:O24BulkIndexed,at:string,context:O24BulkSourceContext)=>void;
const instant=z.iso.datetime({offset:true}),slot=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const header={method:z.literal(O24_BULK_METHOD),token:tokenRefSchema,wallet:z.string(),interval:z.object({start:instant,end:instant}).strict(),stateSlot:slot,stateFloorSlot:slot,roleIndexBefore:z.string().nullable(),requests:z.record(z.string(),z.unknown())};
const receiptSchema=z.object({...header,rawArtifacts:z.record(z.string(),z.string()),retrievedAt:z.record(z.string(),instant)}).strict();
const descriptorSchema=z.object({...header,artifactIds:z.record(z.string(),z.string())}).strict();
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const obj=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const keysEqual=(a:object,b:object)=>same(Object.keys(a).sort(),Object.keys(b).sort());
const fail=(code:string):never=>{throw Error('ADVISORY_CREATOR_INVENTORY_BULK_'+code);};
const time=(s:string)=>{if(!instant.safeParse(s).success)return fail('CLOCK');return Date.parse(s);};
const address=(s:string)=>{try{if(new PublicKey(s).toBase58()!==s)fail('ADDRESS');}catch{return fail('ADDRESS');}};
const signature=(v:unknown):string=>{if(typeof v!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(v))return fail('SIGNATURE');const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=0n;for(const c of v)n=n*58n+BigInt(alphabet.indexOf(c));const hex=n.toString(16),b=Buffer.concat([Buffer.alloc(v.match(/^1*/)?.[0].length??0),n===0n?Buffer.alloc(0):Buffer.from(hex.length%2?'0'+hex:hex,'hex')]);if(b.length!==64||encodeSolanaAddress(b)!==v)fail('SIGNATURE');return v;};
export const isO24BulkLocalId=(s:string)=>/^(?:genesis|state-block-time|ata-head|owner-catalog|role-page|role-index|role-transaction|ata-page-[01]|wallet-page-(?:[0-9]|1[0-5])|bulk-page-(?:[0-9]|1[0-9]|2[0-3]))$/.test(s);
/** Reuse only the bounded reversible byte container, never O23 admission or semantic authority. */
export function unpackO24BulkSource(text:string,bulk:boolean):string{return unpackO23BulkSource(text,bulk);}
export function validateO24BulkReceiptShape(input:O24BulkReceipts,cutoff:string):O24BulkReceipts{
 let r:O24BulkReceipts;try{r=receiptSchema.parse(input);}catch{return fail('SCHEMA');}
 if(r.token.chain!=='solana')fail('CHAIN');address(r.token.address);address(r.wallet);if(r.roleIndexBefore!==null)signature(r.roleIndexBefore);
 const start=time(r.interval.start),end=time(r.interval.end);if(end-start!==6*3_600_000||end%3_600_000!==0||end>time(cutoff)||r.stateFloorSlot>r.stateSlot)fail('INTERVAL');
 if(!keysEqual(r.requests,r.rawArtifacts)||!keysEqual(r.requests,r.retrievedAt)||Object.keys(r.requests).length>O24_BULK_REQUEST_CAP)fail('MEMBERSHIP');
 let bytes=0;for(const id of Object.keys(r.requests)){if(!isO24BulkLocalId(id))fail('ID');if(time(r.retrievedAt[id]!)>time(cutoff))fail('CLOCK');bytes+=Buffer.byteLength(r.rawArtifacts[id]!);}
 if(bytes>O24_BULK_STORED_BYTES)fail('STORED_SIZE');return r;
}
const sequence=(r:O24BulkReceipts,prefix:string,cap:number)=>{const found=Object.keys(r.requests).filter(k=>k.startsWith(prefix)),ids=found.map((_,i)=>prefix+i);if(!found.length||found.length>cap||!same(found.sort(),[...ids].sort()))fail('PAGE_SEQUENCE');return ids;};
/** Every callback is provisional until the returned context proves the complete native-body/index bijection. */
export function visitO24BulkSources(input:O24BulkReceipts,cutoff:string,visitor?:O24BulkSourceVisitor):O24BulkSourceContext{
 const r=validateO24BulkReceiptShape(input,cutoff),used=new Set<string>();let sourceBytes=0;const hashes:string[]=[];
 const raw=(id:string)=>{if(!Object.hasOwn(r.requests,id)||used.has(id))return fail('SOURCE_MEMBERSHIP');used.add(id);const text=unpackO24BulkSource(r.rawArtifacts[id]!,id.startsWith('bulk-page-'));sourceBytes+=Buffer.byteLength(text);if(sourceBytes>O24_BULK_SOURCE_BYTES)fail('SOURCE_TOTAL');hashes.push(sha(text));return text;};
 const rpc=(id:string)=>{let v:any;try{v=JSON.parse(raw(id));}catch(error){if(error instanceof Error&&error.message.startsWith('ADVISORY_'))throw error;return fail('JSON');}if(!obj(v)||v.jsonrpc!=='2.0'||v.id!==1||v.error!==undefined||!Object.hasOwn(v,'result'))fail('RPC');return v.result;};
 const req=(id:string,expected:unknown)=>{if(!same(r.requests[id],expected))fail('REQUEST');};
 const roleMap={'role-page':CREATOR_ROLE_RECEIPTS.page,'role-index':CREATOR_ROLE_RECEIPTS.walletIndex,'role-transaction':CREATOR_ROLE_RECEIPTS.transaction},roleReceipts={rawArtifacts:{} as Record<string,string>,requests:{} as Record<string,unknown>,retrievedAt:{} as Record<string,string>};
 for(const[id,k]of Object.entries(roleMap)){roleReceipts.rawArtifacts[k]=raw(id);roleReceipts.requests[k]=r.requests[id];roleReceipts.retrievedAt[k]=r.retrievedAt[id]!;}
 const role=verifyPublicCreatorRole(r.token,roleReceipts,cutoff,r.roleIndexBefore??undefined,true);if(role.wallet!==r.wallet||role.creation.slot>r.stateFloorSlot)fail('ROLE');
 const canonicalAccount=getAssociatedTokenAddressSync(new PublicKey(r.token.address),new PublicKey(r.wallet),true,TOKEN_2022_PROGRAM_ID).toBase58();
 req('genesis',{method:'getGenesisHash',params:[]});if(rpc('genesis')!==SOLANA_MAINNET_GENESIS)fail('GENESIS');
 req('state-block-time',{method:'getBlockTime',params:[r.stateSlot]});const stateBlockTime=rpc('state-block-time');if(!integer(stateBlockTime)||stateBlockTime*1000<time(r.interval.end)||stateBlockTime*1000>time(r.retrievedAt['state-block-time']!))fail('STATE_TIME');
 req('ata-head',{method:'getAccountInfo',params:[canonicalAccount,{encoding:'jsonParsed',commitment:'finalized',minContextSlot:r.stateFloorSlot}]});const head=rpc('ata-head');
 req('owner-catalog',{method:'getTokenAccountsByOwner',params:[r.wallet,{mint:r.token.address},{encoding:'jsonParsed',commitment:'finalized',minContextSlot:r.stateSlot}]});const ownerCatalog=rpc('owner-catalog');
 for(const [v,id]of [[head,'ata-head'],[ownerCatalog,'owner-catalog']] as const)if(!obj(v)||!obj(v.context)||v.context.slot!==r.stateSlot||!Object.hasOwn(v,'value')||stateBlockTime*1000>time(r.retrievedAt[id]!))fail('STATE_CONTEXT');
 if(!Array.isArray(ownerCatalog.value))fail('CATALOG');
 const context:O24BulkSourceContext={role,canonicalAccount,stateSlot:r.stateSlot,stateFloorSlot:r.stateFloorSlot,interval:r.interval,head,ownerCatalog,stateBlockTime,canonicalRows:[],walletRows:[],counts:{canonicalIndexReferences:0,walletIndexReferences:0,eligibleWalletReferences:0,successfulReferences:0,failedReferences:0,bulkBodies:0,ataPages:0,walletPages:0,bulkPages:0},sourceBytes:0,storedBytes:Object.values(r.rawArtifacts).reduce((n,v)=>n+Buffer.byteLength(v),0),sourceHashes:hashes,receiptManifestHash:sha(JSON.stringify(Object.keys(r.requests).sort().map(id=>[id,r.requests[id],r.retrievedAt[id],sha(r.rawArtifacts[id]!)])))};
 const walk=(prefix:'ata'|'wallet',who:string,cap:number)=>{
  const ids=sequence(r,prefix+'-page-',cap),out:O24BulkIndexed[]=[],seen=new Set<string>();let before:string|undefined,lastSlot=Infinity,lastTime=Infinity,lastPosition:number|null=null,lastClock=0,reached=false;
  for(const [page,id] of ids.entries()){
   if(reached)fail('INDEX_AFTER_TERMINAL');req(id,{method:'getSignaturesForAddress',params:[who,{limit:1000,commitment:'finalized',minContextSlot:r.stateSlot,...(before?{before}:{})}]});const at=time(r.retrievedAt[id]!);if(at<lastClock||at<stateBlockTime*1000)fail('INDEX_CLOCK');lastClock=at;const rows=rpc(id);if(!Array.isArray(rows)||rows.length>1000)fail('INDEX_SHAPE');
   for(const row of rows){if(!obj(row))fail('INDEX_SHAPE');const sig=signature(row.signature),position=integer(row.transactionIndex)?row.transactionIndex:null;if(seen.has(sig)||!integer(row.slot)||row.slot>r.stateSlot||row.slot>lastSlot||!integer(row.blockTime)||row.blockTime>lastTime||row.blockTime*1000>at||row.blockTime>stateBlockTime||row.confirmationStatus!=='finalized'||!(row.err===null||obj(row.err))||!(row.transactionIndex===undefined||row.transactionIndex===null||integer(row.transactionIndex)))fail('INDEX_ROW');if(row.slot===lastSlot&&position!==null&&lastPosition!==null&&position>=lastPosition)fail('INDEX_POSITION');seen.add(sig);lastSlot=row.slot;lastTime=row.blockTime;lastPosition=position;out.push({signature:sig,slot:row.slot,blockTime:row.blockTime,transactionIndex:position,err:row.err});}
   before=rows.at(-1)?.signature;reached=rows.length<1000||(prefix==='ata'?rows.some((v:any)=>v.err===null&&v.blockTime*1000<time(r.interval.start)):rows.some((v:any)=>v.slot<role.creation.slot));if(reached&&page!==ids.length-1)fail('INDEX_AFTER_TERMINAL');context.counts[prefix==='ata'?'ataPages':'walletPages']!++;
  }
  if(!reached)fail('INDEX_INCOMPLETE');return out;
 };
 context.canonicalRows=walk('ata',canonicalAccount,2);const allWallet=walk('wallet',r.wallet,16);context.walletRows=allWallet.filter(v=>v.slot>=role.creation.slot);
 context.counts.canonicalIndexReferences=context.canonicalRows.length;context.counts.walletIndexReferences=allWallet.length;context.counts.eligibleWalletReferences=context.walletRows.length;
 const success=new Map(context.walletRows.filter(v=>v.err===null).map(v=>[v.signature,v]));context.counts.successfulReferences=success.size;context.counts.failedReferences=context.walletRows.length-success.size;
 if(!success.has(role.creation.signature)||success.get(role.creation.signature)!.slot!==role.creation.slot)fail('CREATION_INDEX');
 for(const row of context.canonicalRows.filter(v=>v.err===null&&v.blockTime*1000>=time(r.interval.start))){const w=success.get(row.signature);if(!w||w.slot!==row.slot||w.blockTime!==row.blockTime||w.transactionIndex!==null&&row.transactionIndex!==null&&w.transactionIndex!==row.transactionIndex)fail('CANONICAL_WALLET_MEMBERSHIP');}
 const pin=context.canonicalRows.find(v=>v.err===null&&v.blockTime*1000<time(r.interval.start));if(pin){const w=success.get(pin.signature);if(!w||w.slot!==pin.slot||w.blockTime!==pin.blockTime)fail('CANONICAL_WALLET_MEMBERSHIP');}
 const bulkIds=sequence(r,'bulk-page-',24),seen=new Set<string>(),cursors=new Set<string>();let cursor:string|null=null,terminal=false,previous=[Infinity,Infinity],lastClock=0,creationMatched=false;
 const originalCreation=JSON.parse(roleReceipts.rawArtifacts[CREATOR_ROLE_RECEIPTS.transaction]!).result;
 for(const [page,id]of bulkIds.entries()){
  if(terminal)fail('BULK_AFTER_TERMINAL');req(id,{method:'getTransactionsForAddress',params:[r.wallet,{transactionDetails:'full',encoding:'jsonParsed',maxSupportedTransactionVersion:1,commitment:'finalized',minContextSlot:r.stateSlot,sortOrder:'desc',limit:500,...(cursor?{paginationToken:cursor}:{}),filters:{slot:{gte:role.creation.slot,lte:r.stateSlot},status:'succeeded',tokenAccounts:'none'}}]});const at=time(r.retrievedAt[id]!);if(at<lastClock||at<stateBlockTime*1000)fail('BULK_CLOCK');lastClock=at;const value=rpc(id);if(!obj(value)||!keysEqual(value,{data:0,paginationToken:0})||!Array.isArray(value.data)||value.data.length>500)fail('BULK_SHAPE');
  for(const tx of value.data){if(!obj(tx)||!keysEqual(tx,{slot:0,blockTime:0,transactionIndex:0,transaction:0,meta:0,version:0})||!obj(tx.transaction)||!Array.isArray(tx.transaction.signatures)||!obj(tx.meta)||tx.meta.err!==null||!['legacy',0,1].includes(tx.version))fail('BODY');const sig=signature(tx.transaction.signatures[0]),indexed=success.get(sig);if(!indexed||seen.has(sig)||tx.slot!==indexed.slot||tx.blockTime!==indexed.blockTime||!integer(tx.transactionIndex)||indexed.transactionIndex!==null&&tx.transactionIndex!==indexed.transactionIndex||tx.blockTime*1000>at)fail('BODY_BIJECTION');if(tx.slot>previous[0]!||tx.slot===previous[0]&&tx.transactionIndex>=previous[1]!)fail('BODY_ORDER');previous=[tx.slot,tx.transactionIndex];seen.add(sig);
   const message=tx.transaction.message;if(!obj(message)||!Array.isArray(message.accountKeys)||!message.accountKeys.some((k:any)=>k.pubkey===r.wallet)||!Array.isArray(message.instructions)||!Array.isArray(tx.meta.innerInstructions)||!Array.isArray(tx.meta.logMessages))fail('BODY_SHAPE');
   if(sig===role.creation.signature){if(['transaction','meta','slot','blockTime','version'].some(k=>!same(tx[k],originalCreation[k])))fail('CREATION_BODY_PARITY');creationMatched=true;}
   visitor?.(tx,indexed!,r.retrievedAt[id]!,context);context.counts.bulkBodies!++;
  }
  const next=value.paginationToken;if(!(next===null||typeof next==='string'&&/^(0|[1-9]\d*):(0|[1-9]\d*)$/.test(next)))fail('CURSOR');if(next!==null){const last=value.data.at(-1);if(cursors.has(next)||next===cursor||!last||next!==`${last.slot}:${last.transactionIndex}`)fail('CURSOR_POSITION');cursors.add(next);}terminal=next===null;cursor=next;if(terminal&&page!==bulkIds.length-1)fail('BULK_AFTER_TERMINAL');context.counts.bulkPages!++;
 }
 if(!terminal||seen.size!==success.size||!creationMatched||used.size!==Object.keys(r.requests).length)fail('BODY_CENSUS');context.sourceBytes=sourceBytes;return context;
}
/** Namespace allowance is bound to exact imported source records; no normalized cache supplies authority. */
export function validateO24BulkStorage(descriptor:O24BulkDescriptor,rawArtifacts:Record<string,string>,evidence:EvidenceRecord[],cutoff:string):Set<string>{
 let d:O24BulkDescriptor;try{d=descriptorSchema.parse(descriptor);}catch{return fail('DESCRIPTOR');}if(!keysEqual(d.requests,d.artifactIds))fail('STORAGE_MEMBERSHIP');
 const ids=Object.values(d.artifactIds),owned=evidence.filter(e=>e.sourceId===O24_BULK_SOURCE_ID||e.id.startsWith(O24_BULK_PREFIX)),rawOwned=Object.keys(rawArtifacts).filter(id=>id.startsWith(O24_BULK_PREFIX));if(new Set(ids).size!==ids.length||owned.length!==ids.length||rawOwned.length!==ids.length||!same([...ids].sort(),owned.map(e=>e.id).sort())||!same([...ids].sort(),rawOwned.sort()))fail('STORAGE_MEMBERSHIP');
 const receipts:O24BulkReceipts={method:d.method,token:d.token,wallet:d.wallet,interval:d.interval,stateSlot:d.stateSlot,stateFloorSlot:d.stateFloorSlot,roleIndexBefore:d.roleIndexBefore,requests:d.requests,rawArtifacts:{},retrievedAt:{}};
 for(const[local,id]of Object.entries(d.artifactIds)){if(id!==O24_BULK_PREFIX+local||evidence.filter(e=>e.id===id).length!==1)fail('STORAGE_ID');const e=owned.find(e=>e.id===id)!;if(e.sourceId!==O24_BULK_SOURCE_ID||e.accessMode!=='USER_IMPORT'||e.sourceType!=='HISTORICAL_RECEIPT'||e.adapterVersion!==O24_BULK_ADAPTER||!same(e.scope,{request:d.requests[local]})||e.availableAt!==e.retrievedAt||e.contentHash!==sha(rawArtifacts[id]??''))fail('STORAGE_RECORD');receipts.rawArtifacts[local]=rawArtifacts[id]!;receipts.retrievedAt[local]=e.availableAt;}
 visitO24BulkSources(receipts,cutoff);return new Set(ids);
}
