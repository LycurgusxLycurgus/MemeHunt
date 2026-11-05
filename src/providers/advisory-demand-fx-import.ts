import {constants,openSync,fstatSync,readFileSync,closeSync,lstatSync,readdirSync} from 'node:fs';
import {resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {TokenRef} from '../domain/contracts.js';
import {O23_BULK_ARCHIVE_METHOD,unpackO23BulkSource} from './advisory-synchrony-bulk.js';
import {a30SourceHeaderShape,a30SourceRole,validateA30ReceiptShape,A30_SOURCE_RECORD_CAP,A30_SOURCE_STORED_BYTES,A30_SOURCE_BYTES,A30_FX_SOURCE_BYTES,type A30SourceReceipts} from './advisory-demand-fx-source.js';
const hash=z.string().regex(/^[a-f0-9]{64}$/),instant=z.iso.datetime({offset:true});
const schema=z.object({...a30SourceHeaderShape,receipts:z.array(z.object({id:z.string(),request:z.object({method:z.string().min(1).max(100),params:z.array(z.unknown()).max(4)}).strict(),retrievedAt:instant,file:z.string(),encoding:z.enum(['PLAIN','DEFLATE_RAW_BINARY']),sourceBytes:z.number().int().positive(),sourceHash:hash,archiveBytes:z.number().int().positive().optional(),archiveHash:hash.optional()}).strict()).min(7).max(A30_SOURCE_RECORD_CAP)}).strict();
function fail(code:string):never{throw Error('ADVISORY_A30_IMPORT_'+code);}
const sha=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
/** Local retained native RPC files. Import time never replaces original retrieval clocks. */
export function loadA30SourceCapture(directory:string,token:TokenRef,cutoff:string):A30SourceReceipts{
 const root=resolve(directory);const file=(name:string,max:number)=>{if(name!==basename(name)||!(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/).test(name)||name==='.'||name==='..')return fail('BASENAME');let fd:number|undefined;try{fd=openSync(resolve(root,name),constants.O_RDONLY|constants.O_NOFOLLOW);const st=fstatSync(fd);if(!st.isFile()||st.size>max)fail('FILE_BOUND');const bytes=readFileSync(fd);if(bytes.length!==st.size||bytes.length>max)fail('FILE_BOUND');return bytes;}catch{return fail('FILE');}finally{if(fd!==undefined)closeSync(fd);}};
 let m:z.infer<typeof schema>;try{const st=lstatSync(root);if(!st.isDirectory()||st.isSymbolicLink())fail('DIRECTORY');const bytes=file('capture.json',2_000_000);if(!Buffer.from(bytes.toString('utf8')).equals(bytes))fail('UTF8');m=schema.parse(JSON.parse(bytes.toString('utf8')));}catch{return fail('MANIFEST');}if(m.token.chain!==token.chain||m.token.address!==token.address)fail('TOKEN');
 const ids=new Set<string>(),files=new Set<string>(['capture.json']);for(const r of m.receipts){a30SourceRole(r.id);if(ids.has(r.id)||files.has(r.file))fail('DUPLICATE');ids.add(r.id);files.add(r.file);}const present=readdirSync(root);if(present.length!==files.size||present.some(name=>!files.has(name)))fail('FOREIGN_FILE');const {receipts,...header}=m;const out:A30SourceReceipts={...header,requests:{},rawArtifacts:{},retrievedAt:{}};let stored=0,source=0,fx=0;
 for(const r of receipts){const role=a30SourceRole(r.id);if((r.encoding==='DEFLATE_RAW_BINARY')!==role.archive||r.sourceBytes>role.max)fail('ENCODING_OR_SIZE');source+=r.sourceBytes;if(role.fx)fx+=r.sourceBytes;if(source>A30_SOURCE_BYTES||fx>A30_FX_SOURCE_BYTES)fail('SOURCE_TOTAL');let text:string;
  if(role.archive){if(r.archiveBytes===undefined||r.archiveHash===undefined)fail('ARCHIVE_METADATA');const bytes=file(r.file,Math.min(r.archiveBytes,A30_SOURCE_STORED_BYTES));if(bytes.length!==r.archiveBytes||sha(bytes)!==r.archiveHash)fail('ARCHIVE_HASH');text=JSON.stringify({method:O23_BULK_ARCHIVE_METHOD,encoding:'DEFLATE_RAW_BASE64',sourceBytes:r.sourceBytes,sourceHash:r.sourceHash,data:bytes.toString('base64')});try{unpackO23BulkSource(text,true);}catch{return fail('ARCHIVE');}}
  else{if(r.archiveBytes!==undefined||r.archiveHash!==undefined)fail('PLAIN_METADATA');const bytes=file(r.file,role.max);if(bytes.length!==r.sourceBytes||sha(bytes)!==r.sourceHash)fail('SOURCE_HASH');text=bytes.toString('utf8');if(!Buffer.from(text).equals(bytes))fail('UTF8');}
  stored+=Buffer.byteLength(text);if(stored>A30_SOURCE_STORED_BYTES)fail('STORED_TOTAL');out.requests[r.id]=r.request;out.rawArtifacts[r.id]=text;out.retrievedAt[r.id]=r.retrievedAt;
 }
 return validateA30ReceiptShape(out,cutoff);
}
