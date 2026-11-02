import {constants,openSync,fstatSync,readFileSync,closeSync,lstatSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
import {z} from 'zod';
import {tokenRefSchema,type TokenRef} from '../domain/contracts.js';
import {loadO25LifetimeCapture,O25_CAPTURE_METHOD,O25_QUOTE_MINT,O25_BANK_BYTES,type O25LifetimeBank} from './advisory-creator-lifetime-import.js';
import {O24_BULK_METHOD,O24_BULK_REQUEST_CAP,O24_BULK_PAGE_BYTES,O24_BULK_OTHER_BYTES,O24_BULK_SOURCE_BYTES,O24_BULK_ARCHIVE_METHOD,isO24BulkLocalId,validateO24BulkReceiptShape,type O24BulkReceipts} from './advisory-creator-inventory-bulk.js';
export const S17_SOURCE_ID='advisory-s17-inventory',S17_SOURCE_PREFIX=S17_SOURCE_ID+'-',S17_CAPTURE_ID=S17_SOURCE_PREFIX+'capture';
export const S17_ADAPTER='s17-creator-call-inventory-source-v1',S17_PURPOSE='HISTORICAL_CREATOR_INVENTORY_AROUND_INDEPENDENT_CALLS',S17_CAPTURE_METHOD='s17-creator-call-inventory-capture-v1';
export const S17_NATIVE_STORED_BYTES=32*1024*1024,S17_MANIFEST_BYTES=2_000_000;
export const S17_NATIVE_MANIFEST_ID=S17_SOURCE_PREFIX+'native-manifest',S17_INVENTORY_MANIFEST_ID=S17_SOURCE_PREFIX+'inventory-manifest',S17_POOL_ID=S17_SOURCE_PREFIX+'pool',S17_CALLERS_ID=S17_SOURCE_PREFIX+'callers';
export const s17InventoryScope=(role:string,request?:unknown)=>({method:S17_ADAPTER,purpose:S17_PURPOSE,role,...(request===undefined?{}:{request})});
export const s17InventoryHash=(raw:string|Buffer)=>createHash('sha256').update(raw).digest('hex');
export type S17WireRecord={id:string;raw:string;scope:Record<string,unknown>;retrievedAt:string};
const instant=z.iso.datetime({offset:true}),hash=z.string().regex(/^[a-f0-9]{64}$/),pin=z.object({bytes:z.number().int().positive().max(S17_MANIFEST_BYTES),sha256:hash}).strict();
export const s17InventoryManifestSchema=z.object({method:z.literal(S17_CAPTURE_METHOD),purpose:z.literal(S17_PURPOSE),token:tokenRefSchema,captureCreatedAt:instant,nativeManifest:pin,inventoryManifest:pin,callers:z.object({bytes:z.number().int().positive().max(8*1024*1024),sha256:hash,retrievedAt:instant}).strict()}).strict();
export type S17InventoryManifest=z.infer<typeof s17InventoryManifestSchema>;
const originalPoolSchema=z.object({method:z.literal(O25_CAPTURE_METHOD),token:tokenRefSchema,pool:z.string(),quoteMint:z.literal(O25_QUOTE_MINT),request:z.unknown(),retrievedAt:instant,file:z.literal('pool.json'),sourceBytes:z.number().int().positive().max(O25_BANK_BYTES),sourceHash:hash}).strict();
const originalInventorySchema=z.object({method:z.literal(O24_BULK_METHOD),token:tokenRefSchema,wallet:z.string(),interval:z.object({start:instant,end:instant}).strict(),stateSlot:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),stateFloorSlot:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),roleIndexBefore:z.string().nullable(),receipts:z.array(z.object({id:z.string(),request:z.unknown(),retrievedAt:instant,file:z.string(),encoding:z.enum(['PLAIN','DEFLATE_RAW_BINARY']),sourceBytes:z.number().int().positive(),sourceHash:hash,archiveBytes:z.number().int().positive().optional(),archiveHash:hash.optional()}).strict()).min(4).max(O24_BULK_REQUEST_CAP)}).strict();
const fail=(code:string):never=>{throw Error('S17_INVENTORY_'+code);};
export function decodeS17InventoryManifest(raw:string,token:TokenRef,cutoff:string){
 if(typeof raw!=='string'||Buffer.byteLength(raw)>S17_MANIFEST_BYTES||Buffer.from(raw).toString('utf8')!==raw)fail('MANIFEST_SIZE');const m=s17InventoryManifestSchema.parse(JSON.parse(raw));
 if(!same(m.token,token)||token.chain!=='solana'||!instant.safeParse(cutoff).success||Date.parse(m.captureCreatedAt)>Date.parse(cutoff)||Date.parse(m.callers.retrievedAt)>Date.parse(m.captureCreatedAt))fail('TOKEN_OR_CLOCK');return m;
}
/** Pure original-byte projection. No old external source IDs, allowances or cached metrics are introduced. */
export function projectS17InventoryNative(m:S17InventoryManifest,nativeRaw:string,inventoryRaw:string,rawArtifacts:Record<string,string>,cutoff:string):{inventory:O24BulkReceipts;bank:O25LifetimeBank;nativeIds:Set<string>}{
 for(const [raw,pin]of [[nativeRaw,m.nativeManifest],[inventoryRaw,m.inventoryManifest]] as const)if(typeof raw!=='string'||Buffer.byteLength(raw)!==pin.bytes||s17InventoryHash(raw)!==pin.sha256||Buffer.from(raw).toString('utf8')!==raw)fail('ORIGINAL_MANIFEST_HASH');
 const p=originalPoolSchema.parse(JSON.parse(nativeRaw)),i=originalInventorySchema.parse(JSON.parse(inventoryRaw));if(!same(p.token,m.token)||!same(i.token,m.token))fail('ORIGINAL_TOKEN');
 const inventory:O24BulkReceipts={method:i.method,token:i.token,wallet:i.wallet,interval:i.interval,stateSlot:i.stateSlot,stateFloorSlot:i.stateFloorSlot,roleIndexBefore:i.roleIndexBefore,requests:{},rawArtifacts:{},retrievedAt:{}};
 let source=0,stored=0;const files=new Set<string>(),nativeIds=new Set<string>();
 for(const r of i.receipts){const id=S17_SOURCE_PREFIX+'native-'+r.id,text=rawArtifacts[id],bulk=r.id.startsWith('bulk-page-');
  if(!isO24BulkLocalId(r.id)||nativeIds.has(id)||!(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/).test(r.file)||r.file==='capture.json'||files.has(r.file)||r.encoding!==(bulk?'DEFLATE_RAW_BINARY':'PLAIN')||r.sourceBytes>(bulk?O24_BULK_PAGE_BYTES:O24_BULK_OTHER_BYTES)||Date.parse(r.retrievedAt)>Date.parse(m.captureCreatedAt)||typeof text!=='string')fail('NATIVE_MEMBERSHIP_OR_BOUND');
  source+=r.sourceBytes;stored+=Buffer.byteLength(text);if(source>O24_BULK_SOURCE_BYTES||stored>S17_NATIVE_STORED_BYTES)fail('NATIVE_TOTAL');files.add(r.file);nativeIds.add(id);
  if(bulk){let packed:any;try{packed=JSON.parse(text);}catch{return fail('ARCHIVE');}if(packed?.method!==O24_BULK_ARCHIVE_METHOD||packed.encoding!=='DEFLATE_RAW_BASE64'||packed.sourceBytes!==r.sourceBytes||packed.sourceHash!==r.sourceHash||typeof packed.data!=='string'||JSON.stringify(packed)!==text||r.archiveBytes===undefined||r.archiveHash===undefined)fail('ARCHIVE');const bytes=Buffer.from(packed.data,'base64');if(bytes.toString('base64')!==packed.data||bytes.length!==r.archiveBytes||s17InventoryHash(bytes)!==r.archiveHash)fail('ARCHIVE_HASH');}
  else if(r.archiveBytes!==undefined||r.archiveHash!==undefined||Buffer.byteLength(text)!==r.sourceBytes||s17InventoryHash(text)!==r.sourceHash||Buffer.from(text).toString('utf8')!==text)fail('SOURCE_HASH');
  inventory.requests[r.id]=r.request;inventory.rawArtifacts[r.id]=text;inventory.retrievedAt[r.id]=r.retrievedAt;
 }
 const pool=rawArtifacts[S17_POOL_ID];if(typeof pool!=='string'||Buffer.byteLength(pool)!==p.sourceBytes||s17InventoryHash(pool)!==p.sourceHash||Buffer.from(pool).toString('utf8')!==pool||Date.parse(p.retrievedAt)>Date.parse(m.captureCreatedAt))fail('POOL_SOURCE');
 return{inventory:validateO24BulkReceiptShape(inventory,cutoff),bank:{method:p.method,token:p.token,pool:p.pool,quoteMint:p.quoteMint,requests:{pool:p.request},rawArtifacts:{pool},retrievedAt:{pool:p.retrievedAt}},nativeIds};
}
function directory(path:string,names:string[]){const st=lstatSync(path);if(!st.isDirectory()||st.isSymbolicLink())fail('DIRECTORY');const actual=readdirSync(path);if(actual.length!==names.length||actual.some(n=>!names.includes(n)))fail('FOREIGN_FILE');}
function bounded(path:string,max:number){let fd:number|undefined;try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);const st=fstatSync(fd);if(!st.isFile()||st.size>max)fail('FILE_BOUND');const bytes=readFileSync(fd);if(bytes.length!==st.size||bytes.length>max||!Buffer.from(bytes.toString('utf8')).equals(bytes))fail('FILE_BOUND_OR_UTF8');return bytes.toString('utf8');}finally{if(fd!==undefined)closeSync(fd);}}
export function loadS17InventoryCapture(path:string,token:TokenRef,cutoff:string):{manifest:S17InventoryManifest;records:S17WireRecord[];nativeIds:Set<string>}{
 const root=resolve(path);directory(root,['capture.json','native','callers.json']);const raw=bounded(resolve(root,'capture.json'),S17_MANIFEST_BYTES),m=decodeS17InventoryManifest(raw,token,cutoff),native=loadO25LifetimeCapture(resolve(root,'native'),token,cutoff),nativeRaw=bounded(resolve(root,'native/capture.json'),S17_MANIFEST_BYTES),inventoryRaw=bounded(resolve(root,'native/inventory/capture.json'),S17_MANIFEST_BYTES),callers=bounded(resolve(root,'callers.json'),8*1024*1024);
 if(Buffer.byteLength(callers)!==m.callers.bytes||s17InventoryHash(callers)!==m.callers.sha256)fail('CALLERS_HASH');
 const records:S17WireRecord[]=[{id:S17_CAPTURE_ID,raw,scope:s17InventoryScope('CAPTURE'),retrievedAt:m.captureCreatedAt},{id:S17_NATIVE_MANIFEST_ID,raw:nativeRaw,scope:s17InventoryScope('NATIVE_MANIFEST'),retrievedAt:m.captureCreatedAt},{id:S17_INVENTORY_MANIFEST_ID,raw:inventoryRaw,scope:s17InventoryScope('INVENTORY_MANIFEST'),retrievedAt:m.captureCreatedAt},{id:S17_POOL_ID,raw:native.bank.rawArtifacts.pool!,scope:s17InventoryScope('POOL',native.bank.requests.pool),retrievedAt:native.bank.retrievedAt.pool!},{id:S17_CALLERS_ID,raw:callers,scope:s17InventoryScope('CALLERS'),retrievedAt:m.callers.retrievedAt}];
 for(const id of Object.keys(native.inventory.requests))records.push({id:S17_SOURCE_PREFIX+'native-'+id,raw:native.inventory.rawArtifacts[id]!,scope:s17InventoryScope('NATIVE',native.inventory.requests[id]),retrievedAt:native.inventory.retrievedAt[id]!});
 const raws=Object.fromEntries(records.map(r=>[r.id,r.raw])),projected=projectS17InventoryNative(m,nativeRaw,inventoryRaw,raws,cutoff);return{manifest:m,records,nativeIds:projected.nativeIds};
}
