import {constants,openSync,fstatSync,readFileSync,closeSync,lstatSync,readdirSync} from 'node:fs';
import {resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {tokenRefSchema,type TokenRef} from '../domain/contracts.js';
import {O23_BULK_METHOD,O23_BULK_REQUEST_CAP,O23_BULK_STORED_BYTES,O23_BULK_SOURCE_BYTES,O23_BULK_PAGE_BYTES,O23_BULK_OTHER_BYTES,O23_BULK_ARCHIVE_METHOD,unpackO23BulkSource,validateO23BulkReceiptShape,type O23BulkReceipts} from './advisory-synchrony-bulk.js';
const hash=z.string().regex(/^[a-f0-9]{64}$/),instant=z.iso.datetime({offset:true});
const schema=z.object({method:z.literal(O23_BULK_METHOD),token:tokenRefSchema,pool:z.string(),range:z.object({start:instant,end:instant}).strict(),anchorSlot:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),receipts:z.array(z.object({id:z.string(),request:z.object({method:z.string(),params:z.array(z.unknown())}).strict(),retrievedAt:instant,file:z.string(),encoding:z.enum(['PLAIN','DEFLATE_RAW_BINARY']),sourceBytes:z.number().int().positive(),sourceHash:hash,archiveBytes:z.number().int().positive().optional(),archiveHash:hash.optional()}).strict()).min(4).max(O23_BULK_REQUEST_CAP)}).strict();
const fail=(code:string):never=>{throw Error('ADVISORY_SYNCHRONY_BULK_IMPORT_'+code);};
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
/** Retained provider-RPC import, never a claim this invocation fetched or authenticated the provider. */
export function loadO23BulkCapture(directory:string,token:TokenRef,cutoff:string):O23BulkReceipts{
 const root=resolve(directory);let manifest:z.infer<typeof schema>;
 const file=(name:string,max:number)=>{
  if(name!==basename(name)||!(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/).test(name)||name==='.'||name==='..')return fail('BASENAME');
  let fd:number|undefined;try{fd=openSync(resolve(root,name),constants.O_RDONLY|constants.O_NOFOLLOW);const stat=fstatSync(fd);if(!stat.isFile()||stat.size>max)return fail('FILE_BOUND');const bytes=readFileSync(fd);if(bytes.length!==stat.size||bytes.length>max)return fail('FILE_BOUND');return bytes;}catch{return fail('FILE');}finally{if(fd!==undefined)closeSync(fd);}
 };
 try{const stat=lstatSync(root);if(!stat.isDirectory()||stat.isSymbolicLink())return fail('DIRECTORY');const bytes=file('capture.json',2_000_000);if(!Buffer.from(bytes.toString('utf8')).equals(bytes))return fail('UTF8');manifest=schema.parse(JSON.parse(bytes.toString('utf8')));}catch{return fail('MANIFEST');}
 if(manifest.token.chain!==token.chain||manifest.token.address!==token.address)return fail('TOKEN');
 const ids=new Set<string>(),files=new Set<string>(['capture.json']);for(const r of manifest.receipts){if(!/^(?:index-page-(?:0|[1-9][0-9]?)|bulk-page-(?:0|[1-9][0-9]{0,2})|compiled-(?:0|[1-9][0-9]?)|genesis|anchor-slot|anchor-time|pool)$/.test(r.id))return fail('ID');if(ids.has(r.id)||files.has(r.file))return fail('DUPLICATE');ids.add(r.id);files.add(r.file);}
 const present=readdirSync(root);if(present.length!==files.size||present.some(name=>!files.has(name)))return fail('FOREIGN_FILE');
 const out:O23BulkReceipts={method:manifest.method,token:manifest.token,pool:manifest.pool,range:manifest.range,anchorSlot:manifest.anchorSlot,requests:{},rawArtifacts:{},retrievedAt:{}};
 let source=0,stored=0;
 for(const r of manifest.receipts){
  const bulk=r.id.startsWith('bulk-page-');if((r.encoding==='DEFLATE_RAW_BINARY')!==bulk||r.sourceBytes>(bulk?O23_BULK_PAGE_BYTES:O23_BULK_OTHER_BYTES))return fail('ENCODING_OR_SIZE');source+=r.sourceBytes;if(source>O23_BULK_SOURCE_BYTES)return fail('SOURCE_TOTAL');
  let text:string;
  if(bulk){if(r.archiveBytes===undefined||r.archiveHash===undefined)return fail('ARCHIVE_METADATA');const bytes=file(r.file,Math.min(r.archiveBytes,O23_BULK_STORED_BYTES));if(bytes.length!==r.archiveBytes||sha(bytes)!==r.archiveHash)return fail('ARCHIVE_HASH');text=JSON.stringify({method:O23_BULK_ARCHIVE_METHOD,encoding:'DEFLATE_RAW_BASE64',sourceBytes:r.sourceBytes,sourceHash:r.sourceHash,data:bytes.toString('base64')});unpackO23BulkSource(text,true);}
  else{if(r.archiveBytes!==undefined||r.archiveHash!==undefined)return fail('PLAIN_METADATA');const bytes=file(r.file,O23_BULK_OTHER_BYTES);if(bytes.length!==r.sourceBytes||sha(bytes)!==r.sourceHash)return fail('SOURCE_HASH');text=bytes.toString('utf8');if(!Buffer.from(text).equals(bytes))return fail('UTF8');}
  stored+=Buffer.byteLength(text);if(stored>O23_BULK_STORED_BYTES)return fail('STORED_TOTAL');out.requests[r.id]=r.request;out.rawArtifacts[r.id]=text;out.retrievedAt[r.id]=r.retrievedAt;
 }
 return validateO23BulkReceiptShape(out,cutoff);
}
