import {constants,openSync,fstatSync,readFileSync,closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {z} from 'zod';
import type {TokenRef} from '../domain/contracts.js';
import {A13_CANDIDATE_MINTS,type A13NativeInput,type A13NativeRecord} from './advisory-participation-native.js';

export const A13_CAPTURE_METHOD='a13-observed-peer-participation-capture-v1' as const;
export const A13_SOURCE_ID='advisory-a13-participation' as const;
export const A13_CAPTURE_ID='advisory-a13-participation-capture' as const;
export const A13_ADAPTER='a13-native-participation-source-v1' as const;
export const A13_PURPOSE='OBSERVED_PEER_OWNER_GROWTH' as const;
export const A13_CAPTURE_BYTES=16*1024*1024;
export const A13_DECODED_BYTES=96*1024*1024;
const hash=z.string().regex(/^[a-f0-9]{64}$/), instant=z.iso.datetime({offset:true});
const id=z.string().regex(/^[a-z0-9][a-z0-9-]{0,159}$/);
const request=z.object({method:z.string().min(1).max(100),params:z.array(z.unknown()).max(16),id:z.unknown().optional(),jsonrpc:z.string().optional()}).strict();
const record=z.object({id,sourcePath:z.string().min(1).max(1500),sha256:hash,bytes:z.number().int().nonnegative().max(64*1024*1024),encoding:z.enum(['UTF8','DEFLATE_RAW_BASE64']),data:z.string(),availableAt:instant,requestedAt:instant.optional(),httpStatus:z.number().int().min(100).max(599).optional(),request:request.optional()}).strict();
export const a13CaptureSchema=z.object({method:z.literal(A13_CAPTURE_METHOD),captureCreatedAt:instant,native:z.object({scopeRecordId:id,varianceRecordId:id,rounds:z.object({T0:z.array(id).min(1).max(32),T1:z.array(id).min(1).max(32)}).strict(),roleCatalogRecordId:id,roleRecordIds:z.array(id).min(1).max(100)}).strict(),qualification:z.object({packetRecordId:id,proposalRecordId:id,reviewRecordId:id,sourceRecords:z.record(z.string(),id),executionRecordIds:z.array(id).min(1).max(8)}).strict(),records:z.array(record).min(1).max(256)}).strict();
export type A13ParticipationCapture=z.infer<typeof a13CaptureSchema>;
export type A13DecodedCapture=A13ParticipationCapture&{decodedRecords:A13NativeRecord[]};
export const a13ParticipationScope=()=>({method:A13_ADAPTER,purpose:A13_PURPOSE});
const fail:(reason:string)=>never=(reason)=>{throw Error('A13_PARTICIPATION_SOURCE_'+reason);};
const sha=(raw:string)=>createHash('sha256').update(raw).digest('hex');

/** A bounded portable archive of exact original bodies; no runtime filesystem references. */
export function decodeA13ParticipationCapture(raw:string,cutoff:string):A13DecodedCapture{
 if(typeof raw!=='string'||Buffer.byteLength(raw)>A13_CAPTURE_BYTES||Buffer.from(raw).toString('utf8')!==raw)fail('SIZE_OR_UTF8');
 let capture:A13ParticipationCapture;try{capture=a13CaptureSchema.parse(JSON.parse(raw));}catch{return fail('SCHEMA');}
 const cutoffMs=Date.parse(cutoff),created=Date.parse(capture.captureCreatedAt);if(!Number.isFinite(cutoffMs)||created>cutoffMs)fail('CLOCK');
 const ids=new Set<string>(),decodedRecords:A13NativeRecord[]=[];let total=0;
 const nativeIds=new Set([capture.native.scopeRecordId,capture.native.varianceRecordId,capture.native.roleCatalogRecordId,...capture.native.rounds.T0,...capture.native.rounds.T1,...capture.native.roleRecordIds]);
 const allRefs=[...nativeIds,capture.qualification.packetRecordId,capture.qualification.proposalRecordId,capture.qualification.reviewRecordId,...Object.values(capture.qualification.sourceRecords),...capture.qualification.executionRecordIds];
 for(const r of capture.records){
  if(ids.has(r.id))fail('DUPLICATE_RECORD');ids.add(r.id);
  if(r.bytes>(nativeIds.has(r.id)?64:2)*1024*1024||Date.parse(r.availableAt)>created||r.requestedAt&&Date.parse(r.requestedAt)>Date.parse(r.availableAt))fail('RECORD_BOUND_OR_CLOCK');
  let bytes:Buffer;
  if(r.encoding==='UTF8')bytes=Buffer.from(r.data);
  else{
   if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(r.data))fail('BASE64');
   const compressed=Buffer.from(r.data,'base64');if(compressed.toString('base64')!==r.data)fail('BASE64');
   try{const inflated=inflateRawSync(compressed,{maxOutputLength:Math.min(r.bytes+1,A13_DECODED_BYTES-total+1),info:true}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};if(inflated.engine.bytesWritten!==compressed.length)fail('DEFLATE_TRAILING');bytes=inflated.buffer;}catch(error){if(error instanceof Error&&error.message.startsWith('A13_PARTICIPATION_SOURCE_'))throw error;return fail('DEFLATE');}
  }
  total+=bytes.length;if(total>A13_DECODED_BYTES||bytes.length!==r.bytes)fail('DECODED_BOUND');
  const text=bytes.toString('utf8');if(!Buffer.from(text).equals(bytes)||sha(text)!==r.sha256)fail('HASH_OR_UTF8');
  decodedRecords.push({id:r.id,raw:text,sha256:r.sha256,sourcePath:r.sourcePath,availableAt:r.availableAt,...r.request?{request:r.request}:{},...r.requestedAt?{requestedAt:r.requestedAt}:{},...r.httpStatus!==undefined?{httpStatus:r.httpStatus}:{}});
 }
 if(allRefs.some(ref=>!ids.has(ref))||[...ids].some(ref=>!allRefs.includes(ref)))fail('MISSING_OR_ORPHAN_RECORD');
 return{...capture,decodedRecords};
}

export function a13NativeInput(capture:A13DecodedCapture):A13NativeInput{return{...capture.native,records:capture.decodedRecords};}

export function loadA13ParticipationCapture(file:string,token:TokenRef,cutoff:string):{raw:string;capture:A13DecodedCapture}{
 let fd:number|undefined;
 try{
  fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=fstatSync(fd);if(!stat.isFile()||stat.size>A13_CAPTURE_BYTES)fail('FILE_BOUND');const bytes=readFileSync(fd);if(bytes.length!==stat.size||bytes.length>A13_CAPTURE_BYTES)fail('FILE_BOUND');const raw=bytes.toString('utf8');if(!Buffer.from(raw).equals(bytes))fail('UTF8');
  const capture=decodeA13ParticipationCapture(raw,cutoff),packetRecord=capture.decodedRecords.find(r=>r.id===capture.qualification.packetRecordId)!;
  let candidates:unknown;try{candidates=JSON.parse(packetRecord.raw).candidates;}catch{return fail('QUALIFICATION_PACKET');}
  if(token.chain!=='solana'||!A13_CANDIDATE_MINTS.includes(token.address)||!Array.isArray(candidates)||!candidates.some((c:unknown)=>!!c&&typeof c==='object'&&'address'in c&&c.address===token.address))fail('TOKEN_OUTSIDE_FRAME');
  return{raw,capture};
 }catch(error){if(error instanceof Error&&error.message.startsWith('A13_PARTICIPATION_SOURCE_'))throw error;return fail('FILE');}
 finally{if(fd!==undefined)closeSync(fd);}
}
