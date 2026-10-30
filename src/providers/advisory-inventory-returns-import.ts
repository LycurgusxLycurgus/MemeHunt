import {constants,openSync,fstatSync,readFileSync,closeSync,lstatSync,readdirSync} from 'node:fs';
import {resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import type {TokenRef} from '../domain/contracts.js';
import {INVENTORY_RETURNS_METHOD,INVENTORY_RETURNS_ARCHIVE_METHOD,INVENTORY_RETURNS_STORED_BYTES,INVENTORY_RETURNS_MANIFEST_BYTES,inventoryReturnsManifestSchema,validateInventoryReturnReceiptShape,unpackInventoryReturnChunk,type InventoryReturnReceipts} from './advisory-inventory-returns-source.js';
const fail=(code:string):never=>{throw Error('ADVISORY_INVENTORY_RETURNS_IMPORT_'+code);};
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
/** Import of an explicitly local container; native request semantics/response clocks stay inside it unchanged. */
export function loadInventoryReturnCapture(directory:string,token:TokenRef,cutoff:string):InventoryReturnReceipts{
 const root=resolve(directory),file=(name:string,max:number)=>{if(name!==basename(name)||!(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/).test(name)||name==='.'||name==='..')return fail('BASENAME');let fd:number|undefined;try{fd=openSync(resolve(root,name),constants.O_RDONLY|constants.O_NOFOLLOW);const st=fstatSync(fd);if(!st.isFile()||st.size>max)fail('FILE_BOUND');const b=readFileSync(fd);if(b.length!==st.size||b.length>max)fail('FILE_BOUND');return b;}catch{return fail('FILE');}finally{if(fd!==undefined)closeSync(fd);}};
 let manifest:ReturnType<typeof inventoryReturnsManifestSchema.parse>,manifestRaw:string;
 try{const st=lstatSync(root);if(!st.isDirectory()||st.isSymbolicLink())fail('DIRECTORY');const b=file('capture.json',INVENTORY_RETURNS_MANIFEST_BYTES);manifestRaw=b.toString('utf8');if(!Buffer.from(manifestRaw).equals(b))fail('UTF8');manifest=inventoryReturnsManifestSchema.parse(JSON.parse(manifestRaw));}catch{return fail('MANIFEST');}
 if(manifest.token.chain!==token.chain||manifest.token.address!==token.address)fail('TOKEN');const expected=['capture.json',...manifest.chunks.map(c=>c.file)];if(new Set(expected).size!==expected.length||readdirSync(root).length!==expected.length||readdirSync(root).some(n=>!expected.includes(n)))fail('FOREIGN_FILE');
 const receipts:InventoryReturnReceipts={method:INVENTORY_RETURNS_METHOD,token:manifest.token,pool:manifest.pool,windowEnd:manifest.windowEnd,createdAt:manifest.createdAt,rawArtifacts:{manifest:manifestRaw!}};let stored=Buffer.byteLength(manifestRaw!);
 for(const[i,c]of manifest.chunks.entries()){if(c.id!=='chunk-'+i||c.file!==c.id+'.deflate')fail('CHUNK_SEQUENCE');const bytes=file(c.file,Math.min(c.archiveBytes,INVENTORY_RETURNS_STORED_BYTES));if(bytes.length!==c.archiveBytes||sha(bytes)!==c.archiveHash)fail('ARCHIVE_HASH');const text=JSON.stringify({method:INVENTORY_RETURNS_ARCHIVE_METHOD,encoding:'DEFLATE_RAW_BASE64',sourceBytes:c.sourceBytes,sourceHash:c.sourceHash,data:bytes.toString('base64')});if((stored+=Buffer.byteLength(text))>INVENTORY_RETURNS_STORED_BYTES)fail('STORED_BOUND');unpackInventoryReturnChunk(text);receipts.rawArtifacts[c.id]=text;}
 return validateInventoryReturnReceiptShape(receipts,cutoff);
}
