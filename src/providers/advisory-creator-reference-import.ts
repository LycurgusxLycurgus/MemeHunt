import {constants,openSync,fstatSync,readFileSync,closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {isDeepStrictEqual as same} from 'node:util';
import {z} from 'zod';
import {tokenRefSchema,type TokenRef} from '../domain/contracts.js';
import {O24_BULK_METHOD,O24_BULK_ARCHIVE_METHOD,O24_BULK_REQUEST_CAP,O24_BULK_SOURCE_BYTES,O24_BULK_STORED_BYTES,O24_BULK_PAGE_BYTES,O24_BULK_OTHER_BYTES,isO24BulkLocalId,validateO24BulkReceiptShape,type O24BulkReceipts} from './advisory-creator-inventory-bulk.js';
import {O25_CAPTURE_METHOD,O25_BANK_BYTES,O25_QUOTE_MINT,type O25LifetimeBank} from './advisory-creator-lifetime-import.js';
export const S15_REFERENCE_CAPTURE_METHOD='s15-target-reference-book-capture-v1' as const;
export const S15_REFERENCE_SOURCE_ID='advisory-s15-reference' as const;
export const S15_REFERENCE_CAPTURE_ID='advisory-s15-reference-capture' as const;
export const S15_REFERENCE_ADAPTER='s15-native-reference-book-source-v1' as const;
export const S15_REFERENCE_PURPOSE='CREATOR_TARGET_REFERENCE_BOOK' as const;
export const S15_REFERENCE_STORED_BYTES=32*1024*1024,S15_REFERENCE_DECODED_BYTES=160*1024*1024;
export const s15ReferenceScope=()=>({method:S15_REFERENCE_ADAPTER,purpose:S15_REFERENCE_PURPOSE});
const hash=z.string().regex(/^[a-f0-9]{64}$/),instant=z.iso.datetime({offset:true}),id=z.string().regex(/^[a-z0-9][a-z0-9-]{0,159}$/);
const kinds=['O25_ORIGINAL_MANIFEST','O25_ORIGINAL_INVENTORY_MANIFEST','O25_IDENTITY_BANK','O25_INVENTORY','FAILED_SELECTED_PRIMARY_BODY','FAILED_ORIGINAL_NULL_ALTERNATE','FAILED_SELECTED_ARCHIVE_BODY','ARCHIVE_CHAIN_BINDING','PRICE_REQUIRED_BODY','PRICE_OPTIONAL_EARLIER_EMPTY'] as const;
const bodySchema=z.object({id,kind:z.enum(kinds),sourcePath:z.string().min(1).max(1500),request:z.unknown(),retrievedAt:instant.nullable(),sourceBytes:z.number().int().positive().max(O24_BULK_PAGE_BYTES),sourceHash:hash,encoding:z.enum(['PLAIN_UTF8','DEFLATE_RAW_BASE64']),archiveBytes:z.number().int().positive().optional(),archiveHash:hash.optional(),data:z.string(),receipt:z.record(z.string(),z.unknown()).optional()}).strict();
export const s15ReferenceCaptureSchema=z.object({method:z.literal(S15_REFERENCE_CAPTURE_METHOD),token:tokenRefSchema,captureCreatedAt:instant,lifetime:z.object({manifestRecordId:id,inventoryManifestRecordId:id,inventorySourceRecords:z.record(z.string(),id),poolRecordId:id}).strict(),failed:z.object({primaryRecordIds:z.array(id).max(512),archiveRecordIds:z.array(id).max(512),genesisRecordId:id,archiveEndpoint:z.literal('https://mainnet.helius-rpc.com/'),authentication:z.literal('EXISTING_CONFIGURED_KEY_NOT_RETAINED')}).strict(),prices:z.object({requiredRecordIds:z.array(id).min(1).max(20),optionalHistoryRecordIds:z.array(id).max(20)}).strict(),records:z.array(bodySchema).min(1).max(256)}).strict();
export type S15ReferenceCapture=z.infer<typeof s15ReferenceCaptureSchema>;
export type S15ReferenceRecord=S15ReferenceCapture['records'][number]&{raw:string};
export type S15DecodedReferenceCapture=S15ReferenceCapture&{decodedRecords:S15ReferenceRecord[]};
const sha=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex');
const fail:(code:string)=>never=code=>{throw Error('S15_REFERENCE_SOURCE_'+code);};
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const sameKeys=(a:string[],b:string[])=>new Set(a).size===a.length&&new Set(b).size===b.length&&same([...a].sort(),[...b].sort());
export function s15ReferenceRecord(c:S15DecodedReferenceCapture,id:string):S15ReferenceRecord{return c.decodedRecords.find(r=>r.id===id)??fail('MISSING_RECORD');}

/** Original byte hashes and bounded reversible compression precede every JSON/native interpretation. */
export function decodeS15ReferenceCapture(raw:string,cutoff:string):S15DecodedReferenceCapture{
 if(typeof raw!=='string'||Buffer.byteLength(raw)>S15_REFERENCE_STORED_BYTES||Buffer.from(raw).toString('utf8')!==raw)fail('SIZE_OR_UTF8');
 let c:S15ReferenceCapture;try{c=s15ReferenceCaptureSchema.parse(JSON.parse(raw));}catch{return fail('SCHEMA');}
 const at=Date.parse(cutoff),created=Date.parse(c.captureCreatedAt);if(c.token.chain!=='solana'||!Number.isFinite(at)||created>at)fail('TOKEN_OR_CLOCK');
 const refs=[c.lifetime.manifestRecordId,c.lifetime.inventoryManifestRecordId,c.lifetime.poolRecordId,...Object.values(c.lifetime.inventorySourceRecords),...c.failed.primaryRecordIds,...c.failed.archiveRecordIds,c.failed.genesisRecordId,...c.prices.requiredRecordIds,...c.prices.optionalHistoryRecordIds];
 if(!sameKeys(refs,c.records.map(r=>r.id)))fail('DUPLICATE_MISSING_OR_ORPHAN');
 let total=0;const decodedRecords:S15ReferenceRecord[]=[];
 for(const r of c.records){
  const local=r.kind==='O25_ORIGINAL_MANIFEST'||r.kind==='O25_ORIGINAL_INVENTORY_MANIFEST';if(local?(r.request!==null||r.retrievedAt!==null):(r.request===null||r.retrievedAt===null||Date.parse(r.retrievedAt)>created))fail('RECORD_CLOCK_OR_REQUEST');
  const bound=r.kind==='O25_INVENTORY'?(r.id.startsWith('o25-inventory-bulk-page-')?O24_BULK_PAGE_BYTES:O24_BULK_OTHER_BYTES):r.kind.startsWith('FAILED_')?1_500_000:r.kind==='O25_IDENTITY_BANK'?O25_BANK_BYTES:2*1024*1024;
  if(r.sourceBytes>bound)fail('BODY_BOUND');let bytes:Buffer;
  if(r.encoding==='PLAIN_UTF8'){if(r.archiveBytes!==undefined||r.archiveHash!==undefined)fail('PLAIN_ARCHIVE_METADATA');bytes=Buffer.from(r.data);}
  else{
   if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(r.data))fail('BASE64');const packed=Buffer.from(r.data,'base64');if(packed.toString('base64')!==r.data||packed.length!==r.archiveBytes||sha(packed)!==r.archiveHash)fail('ARCHIVE_HASH');
   try{const value=inflateRawSync(packed,{maxOutputLength:Math.min(r.sourceBytes+1,S15_REFERENCE_DECODED_BYTES-total+1),info:true}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};if(value.engine.bytesWritten!==packed.length)fail('ARCHIVE_TRAILING');bytes=value.buffer;}catch(e){if(e instanceof Error&&e.message.startsWith('S15_REFERENCE_SOURCE_'))throw e;return fail('ARCHIVE_INVALID');}
  }
  total+=bytes.length;if(total>S15_REFERENCE_DECODED_BYTES||bytes.length!==r.sourceBytes||sha(bytes)!==r.sourceHash)fail('SOURCE_HASH_OR_BOUND');const text=bytes.toString('utf8');if(!Buffer.from(text).equals(bytes))fail('UTF8');
  if(r.receipt){const p=r.receipt as Record<string,any>,observedHash=p.sha256??p.response?.sha256,observedBytes=p.bytes??p.response?.bytes,finished=p.finishedAt??p.retrievedAt;
   if(p.request!==undefined&&!same(p.request,r.request)||observedHash!==undefined&&observedHash!==r.sourceHash||observedBytes!==undefined&&observedBytes!==r.sourceBytes||finished!==undefined&&finished!==r.retrievedAt||p.startedAt!==undefined&&(!Number.isFinite(Date.parse(p.startedAt))||Date.parse(p.startedAt)>Date.parse(r.retrievedAt!))||p.truncated===true||p.transportError!=null)fail('OBSERVATION_BINDING');
  }
  decodedRecords.push({...r,raw:text});
 }
 return{...c,decodedRecords};
}

/** Translate only exact validated original manifests into the unchanged native source types. */
export function projectS15Lifetime(c:S15DecodedReferenceCapture,cutoff:string):{inventory:O24BulkReceipts;bank:O25LifetimeBank}{
 const get=(id:string)=>s15ReferenceRecord(c,id),m=get(c.lifetime.manifestRecordId),im=get(c.lifetime.inventoryManifestRecordId),b=get(c.lifetime.poolRecordId);
 if(m.kind!=='O25_ORIGINAL_MANIFEST'||im.kind!=='O25_ORIGINAL_INVENTORY_MANIFEST'||b.kind!=='O25_IDENTITY_BANK')fail('LIFETIME_RECORD_KIND');
 const manifest=JSON.parse(m.raw),inv=JSON.parse(im.raw);if(!object(manifest)||manifest.method!==O25_CAPTURE_METHOD||!same(manifest.token,c.token)||manifest.file!=='pool.json'||manifest.quoteMint!==O25_QUOTE_MINT||manifest.sourceBytes!==b.sourceBytes||manifest.sourceHash!==b.sourceHash||manifest.retrievedAt!==b.retrievedAt||!same(manifest.request,b.request))fail('POOL_MANIFEST');
 if(!object(inv)||inv.method!==O24_BULK_METHOD||!same(inv.token,c.token)||!Array.isArray(inv.receipts)||inv.receipts.length>O24_BULK_REQUEST_CAP||!sameKeys(inv.receipts.map((r:any)=>r.id),Object.keys(c.lifetime.inventorySourceRecords)))fail('INVENTORY_MANIFEST');
 const inventory:O24BulkReceipts={method:O24_BULK_METHOD,token:c.token,wallet:inv.wallet,interval:inv.interval,stateSlot:inv.stateSlot,stateFloorSlot:inv.stateFloorSlot,roleIndexBefore:inv.roleIndexBefore,requests:{},rawArtifacts:{},retrievedAt:{}};
 let source=0,stored=0;const files=new Set<string>();
 for(const p of inv.receipts){
  const r=get(c.lifetime.inventorySourceRecords[p.id]!);if(!isO24BulkLocalId(p.id)||r.kind!=='O25_INVENTORY'||typeof p.file!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(p.file)||files.has(p.file)||!same(p.request,r.request)||p.retrievedAt!==r.retrievedAt||p.sourceBytes!==r.sourceBytes||p.sourceHash!==r.sourceHash)fail('INVENTORY_SOURCE');files.add(p.file);
  const bulk=p.id.startsWith('bulk-page-');if(p.encoding!==(bulk?'DEFLATE_RAW_BINARY':'PLAIN')||r.sourceBytes>(bulk?O24_BULK_PAGE_BYTES:O24_BULK_OTHER_BYTES))fail('INVENTORY_ENCODING');
  let value=r.raw;if(bulk){if(r.encoding!=='DEFLATE_RAW_BASE64'||p.archiveBytes!==r.archiveBytes||p.archiveHash!==r.archiveHash)fail('ORIGINAL_ARCHIVE');value=JSON.stringify({method:O24_BULK_ARCHIVE_METHOD,encoding:'DEFLATE_RAW_BASE64',sourceBytes:r.sourceBytes,sourceHash:r.sourceHash,data:r.data});}
  else if(p.archiveBytes!==undefined||p.archiveHash!==undefined)fail('INVENTORY_PLAIN_METADATA');
  source+=r.sourceBytes;stored+=Buffer.byteLength(value);if(source>O24_BULK_SOURCE_BYTES||stored>O24_BULK_STORED_BYTES)fail('INVENTORY_TOTAL');inventory.requests[p.id]=p.request;inventory.rawArtifacts[p.id]=value;inventory.retrievedAt[p.id]=r.retrievedAt!;
 }
 return{inventory:validateO24BulkReceiptShape(inventory,cutoff),bank:{method:O25_CAPTURE_METHOD,token:c.token,pool:manifest.pool,quoteMint:manifest.quoteMint,requests:{pool:b.request},rawArtifacts:{pool:b.raw},retrievedAt:{pool:b.retrievedAt!}}};
}

export function loadS15ReferenceCapture(file:string,token:TokenRef,cutoff:string):{raw:string;capture:S15DecodedReferenceCapture}{
 let fd:number|undefined;try{fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=fstatSync(fd);if(!stat.isFile()||stat.size>S15_REFERENCE_STORED_BYTES)fail('FILE_BOUND');const bytes=readFileSync(fd);if(bytes.length!==stat.size||bytes.length>S15_REFERENCE_STORED_BYTES)fail('FILE_BOUND');const raw=bytes.toString('utf8');if(!Buffer.from(raw).equals(bytes))fail('UTF8');const capture=decodeS15ReferenceCapture(raw,cutoff);if(!same(capture.token,token))fail('TOKEN');projectS15Lifetime(capture,cutoff);return{raw,capture};}catch(e){if(e instanceof Error&&e.message.startsWith('S15_REFERENCE_SOURCE_'))throw e;return fail('FILE');}finally{if(fd!==undefined)closeSync(fd);}
}
