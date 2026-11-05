import {constants,openSync,fstatSync,readFileSync,closeSync,lstatSync,readdirSync} from 'node:fs';
import {resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
import {z} from 'zod';
import {tokenRefSchema,evidenceRecordSchema,type TokenRef,type EvidenceRecord} from '../domain/contracts.js';
import {loadA30SourceCapture} from './advisory-demand-fx-import.js';
import {a30SourceHeaderShape,a30SourceRole,validateA30ReceiptShape,A30_SOURCE_STORED_BYTES,type A30SourceReceipts} from './advisory-demand-fx-source.js';
import {O23_BULK_ARCHIVE_METHOD} from './advisory-synchrony-bulk.js';
export const A26_SOURCE_ID='advisory-a26-buyer-post' as const,A26_SOURCE_PREFIX=A26_SOURCE_ID+'-';
export const A26_ADAPTER='a26-historical-buyer-post-source-v1' as const,A26_PURPOSE='HISTORICAL_FIRST_BUYER_POST_COMPONENTS' as const;
export const A26_CAPTURE_METHOD='a26-historical-buyer-post-capture-v1' as const,A26_CAPTURE_ID=A26_SOURCE_PREFIX+'capture',A26_NATIVE_MANIFEST_ID=A26_SOURCE_PREFIX+'native-manifest';
export const A26_NATIVE_STORED_BYTES=A30_SOURCE_STORED_BYTES,A26_MANIFEST_BYTES=2_000_000,A26_SOCIAL_BYTES=8_000_000;
export const A26_NATIVE_MANIFEST_HASH='4bb39cef07496edd4480148c5c6e7820d6fe67c6ac9ee2d63c0397bf0be55a8e';
export const A26_PROFILE=Object.freeze({method:'fixed-a30-twelve-hour-first-buyer-v1',historyStart:'2026-10-25T20:00:00.000Z',foregroundStart:'2026-10-26T02:00:00.000Z',end:'2026-10-26T08:00:00.000Z',postPolicy:'EMPTY_RAW_RETAINED_FOREGROUND_ONLY'} as const);
export const a26BuyerPostScope=(role:'CAPTURE'|'NATIVE_MANIFEST')=>({method:A26_ADAPTER,purpose:A26_PURPOSE,role});
const hash=z.string().regex(/^[a-f0-9]{64}$/),instant=z.iso.datetime({offset:true}),file=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/);
export const a26CaptureSchema=z.object({method:z.literal(A26_CAPTURE_METHOD),token:tokenRefSchema,captureCreatedAt:instant,profile:z.object({method:z.literal(A26_PROFILE.method),historyStart:z.literal(A26_PROFILE.historyStart),foregroundStart:z.literal(A26_PROFILE.foregroundStart),end:z.literal(A26_PROFILE.end),postPolicy:z.literal(A26_PROFILE.postPolicy)}).strict(),nativeManifest:z.object({bytes:z.number().int().positive().max(A26_MANIFEST_BYTES),sha256:hash}).strict(),social:z.object({originalCutoff:instant,records:z.array(z.object({file,sourceBytes:z.number().int().positive().max(2_000_000),originalEvidence:evidenceRecordSchema}).strict()).min(1).max(64)}).strict()}).strict();
export type A26Manifest=z.infer<typeof a26CaptureSchema>;
export type A26WireRecord={id:string;raw:string;retrievedAt:string;scope:Record<string,unknown>};
export type A26SocialRecord={raw:string;evidence:EvidenceRecord};
export type A26ProjectedCapture={manifest:A26Manifest;native:A30SourceReceipts;social:Record<string,A26SocialRecord>;ids:string[];nativeIds:Set<string>};
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
function fail(code:string):never{throw Error('A26_BUYER_POST_SOURCE_'+code);}
export const a26NativeId=(role:string)=>A26_SOURCE_PREFIX+'native-'+role;
export const a26SocialId=(oldId:string)=>A26_SOURCE_PREFIX+'social-'+oldId;
export function decodeA26Manifest(raw:string,cutoff:string):A26Manifest{
 if(Buffer.byteLength(raw)>A26_MANIFEST_BYTES||Buffer.from(raw).toString('utf8')!==raw)fail('MANIFEST_BOUND');let m:A26Manifest;try{m=a26CaptureSchema.parse(JSON.parse(raw));}catch{return fail('MANIFEST_SCHEMA');}
 const cut=Date.parse(cutoff),created=Date.parse(m.captureCreatedAt);if(!Number.isFinite(cut)||created>cut||Date.parse(m.social.originalCutoff)>created||m.token.chain!=='solana'||m.nativeManifest.sha256!==A26_NATIVE_MANIFEST_HASH)fail('CLOCK_TOKEN_OR_NATIVE_IDENTITY');
 const ids=new Set<string>(),files=new Set<string>();let total=0;for(const r of m.social.records){const e=r.originalEvidence;if(r.file!==basename(r.file)||r.file==='.'||r.file==='..'||ids.has(e.id)||files.has(r.file))fail('SOCIAL_MEMBERSHIP');ids.add(e.id);files.add(r.file);total+=r.sourceBytes;if(total>A26_SOCIAL_BYTES||e.availableAt!==e.retrievedAt||Date.parse(e.availableAt)>Date.parse(m.social.originalCutoff))fail('SOCIAL_BOUND_OR_CLOCK');}return m;
}
function nativeManifest(raw:string,m:A26Manifest):{header:Omit<A30SourceReceipts,'requests'|'rawArtifacts'|'retrievedAt'>;receipts:any[]}{
 if(Buffer.byteLength(raw)!==m.nativeManifest.bytes||sha(raw)!==m.nativeManifest.sha256||Buffer.from(raw).toString('utf8')!==raw)fail('NATIVE_MANIFEST_HASH');let x:any;try{x=JSON.parse(raw);}catch{return fail('NATIVE_MANIFEST_JSON');}
 if(!Array.isArray(x.receipts)||x.receipts.length<7||x.receipts.length>448)fail('NATIVE_MEMBERSHIP');const{receipts,...input}=x;let header;try{header=z.object(a30SourceHeaderShape).strict().parse(input);}catch{return fail('NATIVE_HEADER');}
 if(!same(header.token,m.token)||!same(header.range,{start:A26_PROFILE.historyStart,end:A26_PROFILE.end}))fail('FIXED_NATIVE_SCOPE');const ids=new Set<string>();for(const r of receipts){a30SourceRole(r.id);if(ids.has(r.id))fail('NATIVE_MEMBERSHIP');ids.add(r.id);}return{header,receipts};
}
/** Strict new ownership, then an internal old-codec projection; no old external source authority. */
export function projectA26BuyerPostCapture(token:TokenRef,cutoff:string,evidence:EvidenceRecord[],rawArtifacts:Record<string,string>):A26ProjectedCapture{
 const raw=rawArtifacts[A26_CAPTURE_ID];if(typeof raw!=='string')fail('CAPTURE_REQUIRED');const m=decodeA26Manifest(raw,cutoff);if(!same(m.token,token))fail('TOKEN');const metadata=nativeManifest(rawArtifacts[A26_NATIVE_MANIFEST_ID]??'',m),native:A30SourceReceipts={...metadata.header,requests:{},rawArtifacts:{},retrievedAt:{}},social:Record<string,A26SocialRecord>={},expected=new Map<string,{scope:Record<string,unknown>;at:string}>(),nativeIds=new Set<string>();
 expected.set(A26_CAPTURE_ID,{scope:a26BuyerPostScope('CAPTURE'),at:m.captureCreatedAt});expected.set(A26_NATIVE_MANIFEST_ID,{scope:a26BuyerPostScope('NATIVE_MANIFEST'),at:m.captureCreatedAt});
 let nativeStored=0;
 for(const r of metadata.receipts){if(Date.parse(r.retrievedAt)>Date.parse(m.captureCreatedAt))fail('NATIVE_CLOCK');const id=a26NativeId(r.id),text=rawArtifacts[id];if(typeof text!=='string')fail('MISSING_NATIVE');const role=a30SourceRole(r.id),bytes=Buffer.byteLength(text);nativeStored+=bytes;if(r.sourceBytes>role.max||bytes>(role.archive?4*Math.ceil((r.sourceBytes+(r.sourceBytes>>>10)+64)/3)+512:role.max)||nativeStored>A26_NATIVE_STORED_BYTES)fail('NATIVE_BOUND');
  if(role.archive){let packed:any;try{packed=JSON.parse(text);}catch{return fail('NATIVE_ARCHIVE');}if(!packed||packed.method!==O23_BULK_ARCHIVE_METHOD||packed.encoding!=='DEFLATE_RAW_BASE64'||packed.sourceBytes!==r.sourceBytes||packed.sourceHash!==r.sourceHash||typeof packed.data!=='string'||JSON.stringify(packed)!==text)fail('NATIVE_ARCHIVE_MANIFEST');const archive=Buffer.from(packed.data,'base64');if(archive.toString('base64')!==packed.data||archive.length!==r.archiveBytes||sha(archive)!==r.archiveHash)fail('NATIVE_ARCHIVE_MANIFEST');}
  else if(bytes!==r.sourceBytes||sha(text)!==r.sourceHash||Buffer.from(text).toString('utf8')!==text)fail('NATIVE_SOURCE_HASH');
  native.requests[r.id]=r.request;native.rawArtifacts[r.id]=text;native.retrievedAt[r.id]=r.retrievedAt;nativeIds.add(id);expected.set(id,{scope:{request:r.request},at:r.retrievedAt});
 }
 for(const r of m.social.records){const e=r.originalEvidence,id=a26SocialId(e.id),text=rawArtifacts[id];if(typeof text!=='string'||Buffer.byteLength(text)!==r.sourceBytes||sha(text)!==e.contentHash||Buffer.from(text).toString('utf8')!==text)fail('SOCIAL_HASH');social[e.id]={raw:text,evidence:e};expected.set(id,{scope:{originalId:e.id},at:e.retrievedAt});}
 const owned=evidence.filter(e=>e.sourceId===A26_SOURCE_ID||e.adapterVersion===A26_ADAPTER||e.id.startsWith(A26_SOURCE_PREFIX)),rawIds=Object.keys(rawArtifacts).filter(id=>id.startsWith(A26_SOURCE_PREFIX));if(owned.length!==expected.size||new Set(owned.map(e=>e.id)).size!==owned.length||rawIds.length!==expected.size||rawIds.some(id=>!expected.has(id)))fail('OWNERSHIP');
 for(const e of owned){const want=expected.get(e.id),text=rawArtifacts[e.id];if(!want||typeof text!=='string'||e.sourceId!==A26_SOURCE_ID||e.sourceType!=='HISTORICAL_RECEIPT'||e.accessMode!=='USER_IMPORT'||e.adapterVersion!==A26_ADAPTER||e.contentHash!==sha(text)||e.availableAt!==want.at||e.retrievedAt!==want.at||!same(e.scope,want.scope))fail('EVIDENCE');}
 validateA30ReceiptShape(native,cutoff);return{manifest:m,native,social,ids:[...expected.keys()],nativeIds};
}
function strictDirectory(path:string,expected:string[]){try{const st=lstatSync(path);if(!st.isDirectory()||st.isSymbolicLink())fail('DIRECTORY');const names=readdirSync(path);if(names.length!==expected.length||names.some(n=>!expected.includes(n)))fail('FOREIGN_FILE');}catch(e){if(e instanceof Error&&e.message.startsWith('A26_'))throw e;return fail('DIRECTORY');}}
function boundedFile(root:string,name:string,max:number):Buffer{
 if(name!==basename(name)||!file.safeParse(name).success||name==='.'||name==='..')fail('BASENAME');let fd:number|undefined;try{fd=openSync(resolve(root,name),constants.O_RDONLY|constants.O_NOFOLLOW);const st=fstatSync(fd);if(!st.isFile()||st.size>max)fail('FILE_BOUND');const b=readFileSync(fd);if(b.length!==st.size||b.length>max)fail('FILE_BOUND');return b;}catch(e){if(e instanceof Error&&e.message.startsWith('A26_'))throw e;return fail('FILE');}finally{if(fd!==undefined)closeSync(fd);}
}
/** Portable nested import. No path is dereferenced after projection into separate owned raw artifacts. */
export function loadA26BuyerPostCapture(directory:string,token:TokenRef,cutoff:string):{manifest:A26Manifest;records:A26WireRecord[];nativeIds:Set<string>}{
 const root=resolve(directory);strictDirectory(root,['capture.json','native','social']);const outer=boundedFile(root,'capture.json',A26_MANIFEST_BYTES),manifestRaw=outer.toString('utf8');if(!Buffer.from(manifestRaw).equals(outer))fail('UTF8');const m=decodeA26Manifest(manifestRaw,cutoff);if(!same(m.token,token))fail('TOKEN');
 const nativeRoot=resolve(root,'native');try{const st=lstatSync(nativeRoot);if(!st.isDirectory()||st.isSymbolicLink())fail('DIRECTORY');}catch{return fail('DIRECTORY');}const nativeBytes=boundedFile(nativeRoot,'capture.json',A26_MANIFEST_BYTES),nativeRaw=nativeBytes.toString('utf8');nativeManifest(nativeRaw,m);const native=loadA30SourceCapture(nativeRoot,token,m.captureCreatedAt),socialRoot=resolve(root,'social');strictDirectory(socialRoot,m.social.records.map(r=>r.file));
 const records:A26WireRecord[]=[{id:A26_CAPTURE_ID,raw:manifestRaw,retrievedAt:m.captureCreatedAt,scope:a26BuyerPostScope('CAPTURE')},{id:A26_NATIVE_MANIFEST_ID,raw:nativeRaw,retrievedAt:m.captureCreatedAt,scope:a26BuyerPostScope('NATIVE_MANIFEST')}],nativeIds=new Set<string>();
 for(const role of Object.keys(native.requests)){const id=a26NativeId(role);records.push({id,raw:native.rawArtifacts[role]!,retrievedAt:native.retrievedAt[role]!,scope:{request:native.requests[role]}});nativeIds.add(id);}
 for(const r of m.social.records){const b=boundedFile(socialRoot,r.file,r.sourceBytes),text=b.toString('utf8');if(b.length!==r.sourceBytes||sha(b)!==r.originalEvidence.contentHash||!Buffer.from(text).equals(b))fail('SOCIAL_HASH');records.push({id:a26SocialId(r.originalEvidence.id),raw:text,retrievedAt:r.originalEvidence.retrievedAt,scope:{originalId:r.originalEvidence.id}});}
 return{manifest:m,records,nativeIds};
}
