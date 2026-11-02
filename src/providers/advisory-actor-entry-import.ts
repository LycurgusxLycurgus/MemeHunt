import {createHash} from 'node:crypto';
import {constants,openSync,fstatSync,readFileSync,closeSync} from 'node:fs';
import {z} from 'zod';
import {tokenRefSchema,type TokenRef} from '../domain/contracts.js';
export const S14_SOURCE_ID='advisory-s14-entry',S14_SOURCE_PREFIX=S14_SOURCE_ID+'-',S14_CAPTURE_ID=S14_SOURCE_PREFIX+'capture';
export const S14_ADAPTER='s14-creator-birth-call-source-v1',S14_PURPOSE='CREATOR_BIRTH_ENTRY_VS_OBSERVED_INDEPENDENT_CALLS',S14_CAPTURE_METHOD='s14-creator-birth-call-capture-v1';
export const S14_CAPTURE_BYTES=8*1024*1024;
export const S14_ROLES=['genesis','role-page','role-index','role-transaction','callers'] as const;
const instant=z.iso.datetime({offset:true}),request=z.object({method:z.string(),params:z.array(z.unknown())}).strict();
const receipt=z.object({role:z.enum(S14_ROLES),retrievedAt:instant,request:z.unknown(),sourceBytes:z.number().int().positive().max(S14_CAPTURE_BYTES),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const s14EntryManifestSchema=z.object({method:z.literal(S14_CAPTURE_METHOD),purpose:z.literal(S14_PURPOSE),token:tokenRefSchema,captureCreatedAt:instant,roleIndexBefore:z.string().min(64).max(88).optional(),receipts:z.array(receipt).length(5)}).strict();
export type S14EntryManifest=z.infer<typeof s14EntryManifestSchema>;
export type S14EntryRecord={id:string;raw:string;scope:Record<string,unknown>;retrievedAt:string};
export const s14EntryScope=(role:string,request?:unknown)=>({method:S14_ADAPTER,purpose:S14_PURPOSE,role,...(request===undefined?{}:{request})});
export const s14EntryHash=(raw:string)=>createHash('sha256').update(raw).digest('hex');
export function decodeS14EntryManifest(raw:string,token:TokenRef,cutoff:string):S14EntryManifest{
 const m=s14EntryManifestSchema.parse(JSON.parse(raw)),cut=Date.parse(cutoff);
 if(raw.length>100000||!Number.isFinite(cut)||m.token.chain!=='solana'||m.token.chain!==token.chain||m.token.address!==token.address||Date.parse(m.captureCreatedAt)>cut||new Set(m.receipts.map(r=>r.role)).size!==5)throw Error('S14_ENTRY_MANIFEST');
 for(const r of m.receipts){if(Date.parse(r.retrievedAt)>Date.parse(m.captureCreatedAt))throw Error('S14_ENTRY_CLOCK');if(r.role!=='role-page'&&r.role!=='callers')request.parse(r.request);}
 return m;
}
/** A single bounded portable file; persisted metadata never duplicates its native raw strings. */
export function loadS14EntryCapture(file:string,token:TokenRef,cutoff:string):{manifest:S14EntryManifest;records:S14EntryRecord[]}{
 let fd:number|undefined;let bytes:Buffer;
 try{fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);const st=fstatSync(fd);if(!st.isFile()||st.size>S14_CAPTURE_BYTES)throw Error('S14_ENTRY_FILE_BOUND');bytes=readFileSync(fd);if(bytes.length!==st.size||bytes.length>S14_CAPTURE_BYTES)throw Error('S14_ENTRY_FILE_BOUND');}finally{if(fd!==undefined)closeSync(fd);}
 const raw=bytes!.toString('utf8');if(!Buffer.from(raw).equals(bytes!))throw Error('S14_ENTRY_UTF8');
 const portable=z.object({manifest:s14EntryManifestSchema,rawArtifacts:z.record(z.enum(S14_ROLES),z.string())}).strict().parse(JSON.parse(raw));
 const metadata=JSON.stringify(portable.manifest),manifest=decodeS14EntryManifest(metadata,token,cutoff);
 const records:S14EntryRecord[]=[{id:S14_CAPTURE_ID,raw:metadata,scope:s14EntryScope('CAPTURE'),retrievedAt:manifest.captureCreatedAt}];
 for(const r of manifest.receipts){const text=portable.rawArtifacts[r.role];if(Buffer.byteLength(text)!==r.sourceBytes||s14EntryHash(text)!==r.sha256||Buffer.from(text).toString('utf8')!==text)throw Error('S14_ENTRY_SOURCE_HASH');records.push({id:S14_SOURCE_PREFIX+r.role,raw:text,scope:s14EntryScope(r.role,r.request),retrievedAt:r.retrievedAt});}
 return{manifest,records};
}
