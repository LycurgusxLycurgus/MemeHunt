import {createHash} from 'node:crypto';
import {constants,openSync,fstatSync,readFileSync,closeSync} from 'node:fs';
import {z} from 'zod';
import {tokenRefSchema,type TokenRef} from '../domain/contracts.js';
// Dedicated S19 source purpose; existing S14 helpers confer no external S14 authority.
export const S19_SOURCE_ID='advisory-s19-singleton',S19_SOURCE_PREFIX=S19_SOURCE_ID+'-',S19_CAPTURE_ID=S19_SOURCE_PREFIX+'capture';
export const S19_ADAPTER='s19-creator-singleton-birth-source-v1',S19_PURPOSE='CREATOR_ONLY_SINGLETON_BIRTH_ENTRY_FIRST_6H',S19_CAPTURE_METHOD='s19-creator-singleton-birth-capture-v1';
export const S19_METRIC_METHOD='s19-creator-singleton-birth-first6h-v1',S19_SCOPE='CREATOR_ONLY_SINGLETON_PUBLIC_SIGNED_CREATION_ROLE';
export const S19_CAPTURE_BYTES=8*1024*1024,S19_MANIFEST_BYTES=100_000,S19_INTERVAL_SECONDS=21600,S19_INTERVAL_ANCHOR='UNIQUE_MINT_BIRTH';
export const S19_ROLES=['genesis','role-page','role-index','role-transaction'] as const;
export type S19Role=typeof S19_ROLES[number];
export const S19_EVIDENCE_IDS:readonly string[]=[S19_CAPTURE_ID,...S19_ROLES.map(role=>S19_SOURCE_PREFIX+role)];
export type S19WireRecord={id:string;raw:string;scope:Record<string,unknown>;retrievedAt:string};
const instant=z.iso.datetime({offset:true}),request=z.object({method:z.string(),params:z.array(z.unknown())}).strict();
const receipt=z.object({role:z.enum(S19_ROLES),retrievedAt:instant,request:z.unknown(),sourceBytes:z.number().int().positive().max(S19_CAPTURE_BYTES),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const s19ManifestSchema=z.object({method:z.literal(S19_CAPTURE_METHOD),purpose:z.literal(S19_PURPOSE),token:tokenRefSchema,captureCreatedAt:instant,interval:z.object({anchor:z.literal(S19_INTERVAL_ANCHOR),durationSeconds:z.literal(S19_INTERVAL_SECONDS)}).strict(),roleIndexBefore:z.string().min(64).max(88).optional(),receipts:z.array(receipt).length(S19_ROLES.length)}).strict();
export type S19Manifest=z.infer<typeof s19ManifestSchema>;
const fail=(code:string):never=>{throw Error('S19_SINGLETON_'+code);};
export const s19Scope=(role:string,request?:unknown)=>({method:S19_ADAPTER,purpose:S19_PURPOSE,role,...(request===undefined?{}:{request})});
export const s19Hash=(raw:string)=>createHash('sha256').update(raw).digest('hex');
/** Strict four-role manifest: fixed interval literal, original receipt requests and clocks, capture<=cutoff and every receipt<=capture. */
export function decodeS19Manifest(raw:string,token:TokenRef,cutoff:string):S19Manifest{
 if(Buffer.byteLength(raw)>S19_MANIFEST_BYTES||Buffer.from(raw).toString('utf8')!==raw)fail('MANIFEST');
 const m=s19ManifestSchema.parse(JSON.parse(raw)),capture=Date.parse(m.captureCreatedAt);
 if(!instant.safeParse(cutoff).success||token.chain!=='solana'||m.token.chain!==token.chain||m.token.address!==token.address||capture>Date.parse(cutoff)||new Set(m.receipts.map(r=>r.role)).size!==S19_ROLES.length)fail('MANIFEST');
 for(const r of m.receipts){if(Date.parse(r.retrievedAt)>capture)fail('CLOCK');if(r.role!=='role-page')request.parse(r.request);}
 return m;
}
/** One bounded regular UTF-8 portable file {manifest,rawArtifacts}; no manifest-named path is ever opened. */
export function loadS19Capture(file:string,token:TokenRef,cutoff:string):{manifest:S19Manifest;records:S19WireRecord[]}{
 let fd:number|undefined;let bytes:Buffer;
 try{fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);const st=fstatSync(fd);if(!st.isFile()||st.size>S19_CAPTURE_BYTES)fail('FILE_BOUND');bytes=readFileSync(fd);if(bytes.length!==st.size||bytes.length>S19_CAPTURE_BYTES)fail('FILE_BOUND');}finally{if(fd!==undefined)closeSync(fd);}
 const text=bytes!.toString('utf8');if(!Buffer.from(text).equals(bytes!))fail('UTF8');
 const portable=z.object({manifest:s19ManifestSchema,rawArtifacts:z.record(z.string(),z.string())}).strict().parse(JSON.parse(text));
 if(JSON.stringify(Object.keys(portable.rawArtifacts).sort())!==JSON.stringify([...S19_ROLES].sort()))fail('PORTABLE_MEMBERS');
 const metadata=JSON.stringify(portable.manifest),manifest=decodeS19Manifest(metadata,token,cutoff);
 const records:S19WireRecord[]=[{id:S19_CAPTURE_ID,raw:metadata,scope:s19Scope('CAPTURE'),retrievedAt:manifest.captureCreatedAt}];
 for(const r of manifest.receipts){const raw=portable.rawArtifacts[r.role]!;if(Buffer.byteLength(raw)!==r.sourceBytes||s19Hash(raw)!==r.sha256||Buffer.from(raw).toString('utf8')!==raw)fail('SOURCE_HASH');records.push({id:S19_SOURCE_PREFIX+r.role,raw,scope:s19Scope(r.role,r.request),retrievedAt:r.retrievedAt});}
 if(records.reduce((n,x)=>n+Buffer.byteLength(x.raw),0)>S19_CAPTURE_BYTES)fail('SOURCE_BOUND');
 return{manifest,records:records.sort((a,b)=>S19_EVIDENCE_IDS.indexOf(a.id)-S19_EVIDENCE_IDS.indexOf(b.id))};
}

