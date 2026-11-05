import {constants,openSync,fstatSync,readFileSync,closeSync,lstatSync,readdirSync} from 'node:fs';
import {resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import type {TokenRef} from '../domain/contracts.js';
import {HOLDER_AGE_METHOD,HOLDER_AGE_ARCHIVE_METHOD,HOLDER_AGE_STORED_BYTES,HOLDER_AGE_MANIFEST_BYTES,holderAgeManifestSchema,validateHolderAgeReceiptShape,unpackHolderAgeChunk,type HolderAgeReceipts} from './advisory-holder-age-source.js';
const fail=(code:string):never=>{throw Error('O22_HOLDER_IMPORT_'+code);};
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
/** Read-only import of local retained sources, never a claim this CLI made their original RPC calls. */
export function loadHolderAgeCapture(directory:string,token:TokenRef,cutoff:string):HolderAgeReceipts{
 const root=resolve(directory),file=(name:string,max:number)=>{if(name!==basename(name)||!(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/).test(name)||name==='.'||name==='..')return fail('BASENAME');let fd:number|undefined;try{fd=openSync(resolve(root,name),constants.O_RDONLY|constants.O_NOFOLLOW);const st=fstatSync(fd);if(!st.isFile()||st.size>max)fail('FILE_BOUND');const b=readFileSync(fd);if(b.length!==st.size||b.length>max)fail('FILE_BOUND');return b;}catch{return fail('FILE');}finally{if(fd!==undefined)closeSync(fd);}};
 let manifest:ReturnType<typeof holderAgeManifestSchema.parse>,manifestRaw:string;
 try{const st=lstatSync(root);if(!st.isDirectory()||st.isSymbolicLink())fail('DIRECTORY');const bytes=file('capture.json',HOLDER_AGE_MANIFEST_BYTES);manifestRaw=bytes.toString('utf8');if(!Buffer.from(manifestRaw).equals(bytes))fail('UTF8');manifest=holderAgeManifestSchema.parse(JSON.parse(manifestRaw));}catch{return fail('MANIFEST');}
 if(manifest.token.chain!==token.chain||manifest.token.address!==token.address)fail('TOKEN');const expected=['capture.json',...manifest.chunks.map(c=>c.file)],actual=readdirSync(root);if(new Set(expected).size!==expected.length||actual.length!==expected.length||actual.some(n=>!expected.includes(n)))fail('FOREIGN_FILE');
 const r:HolderAgeReceipts={method:HOLDER_AGE_METHOD,token:manifest.token,createdAt:manifest.createdAt,ageThresholdHours:24,rawArtifacts:{manifest:manifestRaw!}};let stored=Buffer.byteLength(manifestRaw!);
 for(const[i,c]of manifest.chunks.entries()){if(c.id!=='chunk-'+i||c.file!==c.id+'.deflate')fail('CHUNK_SEQUENCE');const bytes=file(c.file,Math.min(c.archiveBytes,HOLDER_AGE_STORED_BYTES));if(bytes.length!==c.archiveBytes||sha(bytes)!==c.archiveHash)fail('ARCHIVE_HASH');const text=JSON.stringify({method:HOLDER_AGE_ARCHIVE_METHOD,encoding:'DEFLATE_RAW_BASE64',sourceBytes:c.sourceBytes,sourceHash:c.sourceHash,data:bytes.toString('base64')});if((stored+=Buffer.byteLength(text))>HOLDER_AGE_STORED_BYTES)fail('STORED_BOUND');unpackHolderAgeChunk(text);r.rawArtifacts[c.id]=text;}
 return validateHolderAgeReceiptShape(r,cutoff);
}
