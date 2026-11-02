import {constants,openSync,fstatSync,readFileSync,closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {z} from 'zod';
import {tokenRefSchema,evidenceRecordSchema,type TokenRef} from '../domain/contracts.js';
export const A25_CAPTURE_METHOD='a25-historical-lead-lag-capture-v1' as const;
export const A25_SOURCE_ID='advisory-a25-lead-lag' as const,A25_CAPTURE_ID='advisory-a25-lead-lag-capture' as const;
export const A25_ADAPTER='a25-historical-lead-lag-source-v1' as const,A25_PURPOSE='HISTORICAL_OBSERVED_ATTENTION_PRICE_LEAD_LAG' as const;
export const A25_CAPTURE_BYTES=8*1024*1024,A25_DECODED_BYTES=24*1024*1024;
export const a25LeadLagScope=()=>({method:A25_ADAPTER,purpose:A25_PURPOSE});
const label=z.string().regex(/^[a-z0-9][a-z0-9-]{0,159}$/),hash=z.string().regex(/^[a-f0-9]{64}$/),instant=z.iso.datetime({offset:true});
const recordSchema=z.object({id:label,kind:z.enum(['SOCIAL','NATIVE_MANIFEST','NATIVE_BANK','NATIVE_GENESIS','MARKET_BODY','MARKET_RECEIPTS','PROFILE','DISCLOSURE','CLARIFICATION']),sourcePath:z.string().min(1).max(1500),sourceBytes:z.number().int().positive().max(A25_CAPTURE_BYTES),sourceHash:hash,encoding:z.enum(['PLAIN_UTF8','DEFLATE_RAW_BASE64']),archiveBytes:z.number().int().positive().optional(),archiveHash:hash.optional(),data:z.string(),originalEvidence:evidenceRecordSchema.optional(),request:z.unknown(),retrievedAt:instant.nullable()}).strict();
export const a25CaptureSchema=z.object({method:z.literal(A25_CAPTURE_METHOD),token:tokenRefSchema,captureCreatedAt:instant,social:z.object({originalCutoff:instant,records:z.record(z.string(),label)}).strict(),identity:z.object({manifestId:label,bankId:label,genesisId:label}).strict(),market:z.object({bodyId:label,receiptId:label}).strict(),registration:z.object({profileId:label,disclosureId:label,clarificationId:label}).strict(),records:z.array(recordSchema).min(1).max(64)}).strict();
export type A25LeadLagCapture=z.infer<typeof a25CaptureSchema>;
export type A25LeadLagRecord=A25LeadLagCapture['records'][number]&{raw:string};
export type A25DecodedCapture=A25LeadLagCapture&{decodedRecords:A25LeadLagRecord[]};
const sha=(x:Buffer|string)=>createHash('sha256').update(x).digest('hex');
const fail:(code:string)=>never=code=>{throw Error('A25_LEAD_LAG_SOURCE_'+code);};
export function a25Record(c:A25DecodedCapture,id:string):A25LeadLagRecord{return c.decodedRecords.find(r=>r.id===id)??fail('MISSING_RECORD');}
/** All filesystem references are provenance metadata; every runtime byte lives in this bounded archive. */
export function decodeA25LeadLagCapture(raw:string,cutoff:string):A25DecodedCapture{
 if(typeof raw!=='string'||Buffer.byteLength(raw)>A25_CAPTURE_BYTES||Buffer.from(raw).toString('utf8')!==raw)fail('SIZE_OR_UTF8');let c:A25LeadLagCapture;
 try{c=a25CaptureSchema.parse(JSON.parse(raw));}catch{return fail('SCHEMA');}
 const end=Date.parse(cutoff),created=Date.parse(c.captureCreatedAt);if(c.token.chain!=='solana'||!Number.isFinite(end)||created>end||Date.parse(c.social.originalCutoff)>created)fail('CLOCK_OR_TOKEN');
 const refs=[...Object.values(c.social.records),...Object.values(c.identity),...Object.values(c.market),...Object.values(c.registration)];if(new Set(refs).size!==refs.length||new Set(c.records.map(r=>r.id)).size!==c.records.length||refs.length!==c.records.length||c.records.some(r=>!refs.includes(r.id)))fail('DUPLICATE_MISSING_OR_ORPHAN');
 let total=0;const decodedRecords:A25LeadLagRecord[]=[];
 for(const r of c.records){
  const executor=r.originalEvidence?.id==='advisory-executor-capture'||r.originalEvidence?.id==='advisory-executor-bodies';if(r.sourceBytes>(executor?8:2)*1024*1024||r.retrievedAt!==null&&Date.parse(r.retrievedAt)>created)fail('RECORD_BOUND_OR_CLOCK');let bytes:Buffer;
  if(r.encoding==='PLAIN_UTF8'){if(r.archiveBytes!==undefined||r.archiveHash!==undefined)fail('PLAIN_METADATA');bytes=Buffer.from(r.data);}
  else{
   if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(r.data))fail('BASE64');const packed=Buffer.from(r.data,'base64');if(packed.toString('base64')!==r.data||packed.length!==r.archiveBytes||sha(packed)!==r.archiveHash)fail('ARCHIVE_HASH');
   try{const value=inflateRawSync(packed,{maxOutputLength:Math.min(r.sourceBytes+1,A25_DECODED_BYTES-total+1),info:true}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};if(value.engine.bytesWritten!==packed.length)fail('ARCHIVE_TRAILING');bytes=value.buffer;}catch(e){if(e instanceof Error&&e.message.startsWith('A25_LEAD_LAG_SOURCE_'))throw e;return fail('ARCHIVE_INVALID');}
  }
  total+=bytes.length;const text=bytes.toString('utf8');if(total>A25_DECODED_BYTES||bytes.length!==r.sourceBytes||sha(bytes)!==r.sourceHash||!Buffer.from(text).equals(bytes))fail('HASH_BOUND_OR_UTF8');
  if(r.kind==='SOCIAL'){const e=r.originalEvidence;if(!e||e.contentHash!==r.sourceHash||e.availableAt!==e.retrievedAt||r.retrievedAt!==e.retrievedAt||Date.parse(e.availableAt)>Date.parse(c.social.originalCutoff)||r.request!==null)fail('SOCIAL_EVIDENCE');}
  else if(r.originalEvidence!==undefined)fail('FOREIGN_EVIDENCE');
  decodedRecords.push({...r,raw:text});
 }
 return{...c,decodedRecords};
}
export function loadA25LeadLagCapture(file:string,token:TokenRef,cutoff:string):{raw:string;capture:A25DecodedCapture}{
 let fd:number|undefined;try{fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=fstatSync(fd);if(!stat.isFile()||stat.size>A25_CAPTURE_BYTES)fail('FILE_BOUND');const bytes=readFileSync(fd);if(bytes.length!==stat.size||bytes.length>A25_CAPTURE_BYTES)fail('FILE_BOUND');const raw=bytes.toString('utf8');if(!Buffer.from(raw).equals(bytes))fail('UTF8');const capture=decodeA25LeadLagCapture(raw,cutoff);if(token.chain!==capture.token.chain||token.address!==capture.token.address)fail('TOKEN');return{raw,capture};}catch(e){if(e instanceof Error&&e.message.startsWith('A25_LEAD_LAG_SOURCE_'))throw e;return fail('FILE');}finally{if(fd!==undefined)closeSync(fd);}
}
