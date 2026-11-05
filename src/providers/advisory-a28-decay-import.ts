import {createHash} from 'node:crypto';
import {constants,openSync,fstatSync,readSync,closeSync} from 'node:fs';
import {isDeepStrictEqual as same} from 'node:util';
import {z} from 'zod';
import {tokenRefSchema,type TokenRef} from '../domain/contracts.js';
import {s18Instant} from './advisory-s18-study.js';
import {rederiveA28Source,CODE_PINS} from './advisory-a28-native-source.js';
export const A28_SOURCE_ID='advisory-a28-decay',A28_SOURCE_PREFIX=A28_SOURCE_ID+'-',A28_CAPTURE_ID=A28_SOURCE_PREFIX+'capture';
export const A28_ADAPTER='a28-native-interval-decay-source-v1',A28_PURPOSE='HISTORICAL_MODEL_CONDITIONAL_PROVIDED_ATTENTION_DECAY';
export const A28_FILE_BYTES=4*1024*1024,A28_RECORD_BYTES=500000,A28_RECORDS=64;
export const a28Hash=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex');
export const a28Fail=(code:string):never=>{throw Error('A28_DECAY_'+code);};
export const a28Check=(v:unknown,code:string):void=>{if(!v)a28Fail(code);};
const instant=z.string().refine(v=>s18Instant(v)!==null),hex=z.string().regex(/^[a-f0-9]{64}$/);
const bodySchema=z.object({raw:z.string(),bytes:z.number().int().nonnegative().max(A28_RECORD_BYTES),sha256:hex}).strict();
export const a28PacketSchema=z.object({kind:z.literal('A28_PORTABLE_ORIGINAL_NATIVE_SOURCE_V1'),method:z.literal(A28_ADAPTER),namespace:z.literal(A28_SOURCE_ID),sourceId:z.literal(A28_CAPTURE_ID),purpose:z.literal(A28_PURPOSE),packagedAt:instant,token:tokenRefSchema,codePins:z.object({publicNativeHelperSourceSha256:z.literal(CODE_PINS.publicNativeHelperSourceSha256),ownUrlProjectorSha256:z.literal(CODE_PINS.ownUrlProjectorSha256)}).strict(),records:z.array(z.object({role:z.string().regex(/^[a-z0-9-]{1,80}$/),body:bodySchema}).strict()).min(1).max(A28_RECORDS)}).strict();
export type A28Packet=z.infer<typeof a28PacketSchema>;
export const a28ReceiptSchema=z.object({role:z.string().regex(/^[a-z0-9-]{1,80}$/),request:z.record(z.string(),z.unknown()),retrievedAt:instant,sourceBytes:z.number().int().nonnegative().max(A28_RECORD_BYTES),sourceHash:hex}).strict();
export const a28ManifestSchema=a28PacketSchema.omit({records:true}).extend({receipts:z.array(a28ReceiptSchema).min(1).max(A28_RECORDS)}).strict();
export type A28Manifest=z.infer<typeof a28ManifestSchema>;
export type A28Receipt=z.infer<typeof a28ReceiptSchema>;
export type A28WireRecord={id:string;raw:string;scope:Record<string,unknown>;retrievedAt:string};
export const a28Id=(role:string)=>A28_SOURCE_PREFIX+role;
export const a28CaptureScope=()=>({method:A28_ADAPTER,purpose:A28_PURPOSE,role:'CAPTURE'});
export const a28RoleScope=(r:A28Receipt)=>({method:A28_ADAPTER,purpose:A28_PURPOSE,role:r.role,request:r.request});
export const A28_ORIGINAL_BODIES:Record<string,{bytes:number;sha256:string}>={"original-scope":{"bytes":1511,"sha256":"2096241d6f81f26a1b6f6f6a833dee7922f7f38f82e07967b65d5cad526474e3"},"original-manifest":{"bytes":12970,"sha256":"15c357dc883614187000b8b63dd30f1f8c5dbf16a66887ec2e2e645bdbc94dc4"},"native-page-00":{"bytes":245177,"sha256":"1ce1707653da54162c062120186717ce7a020364bafa8e24440675a6de85d1d0"},"native-page-01":{"bytes":14093,"sha256":"5b7c33d0e5010093344845f2c70e9f7c68f0e45909350aaa9e7eac5d637d71d9"},"native-page-02":{"bytes":1599,"sha256":"5016c30e8db696bf24d7bdf888b83f4ddea94d8fc3814d53809e7e35adf9c78a"},"client-end-witness":{"bytes":440,"sha256":"cf03904f019871ebeb5ef2c4ac03ece45f5cae3227f55d86072c0ecf2add0383"},"observation-notes":{"bytes":668,"sha256":"b2423d2366df086b716e2050eee6c02e3af6dcae965b04f4cf204afa9ea751b5"},"qualification-contract":{"bytes":3244,"sha256":"a18c9f2476e9ad2da772520790fb367b1c4be2ae8992f76d35851eab636b7b3d"},"root-qualification-context":{"bytes":175314,"sha256":"3ddc464a8cadb28831abfd1dd6b2ce75cd3309712206610d9f33e9b0a58b8fb8"},"catalyst-dispositions":{"bytes":9500,"sha256":"233bff0e84e63df15a2a27e05cd3f9d97f4753442911ed542bd27ea27eedf103"},"model-profile":{"bytes":5640,"sha256":"d08352c04405b80c41bf9c1b53d2f3c54571bceb8d87d8692cd707484894401c"},"parent-context-receipts":{"bytes":754,"sha256":"f033efc83acc76f1bc1786fdf83626e8b33ad3fc4197092878406cf60a9ffb13"},"parent-context-syndication":{"bytes":7779,"sha256":"45c76c71c7a351cbd70847358dabdda7aab548ef4461db6ab9f10d98db424cab"},"parent-context-fxtwitter":{"bytes":2500,"sha256":"3a7dc5d6d889ce0e25b58fc03702adfd91c3bbd0948cb93f44935ac12322cd0a"},"omission-context-catalog":{"bytes":4894,"sha256":"3e90be8c3af1113f77cb533e98cf7da91f3a467f3dfdb5de6f38db03813770d2"},"omission-native-manifest":{"bytes":8943,"sha256":"69fa48fe532bde59728bf4b3e65d099fd6ed0b929d389a9940321db0e803ea33"},"omission-native-page-00":{"bytes":39462,"sha256":"95b6f9aaeef2f91ae3e15e167c0a716ff39f890d947a60c9fa0cdc85813d673b"},"omission-native-page-01":{"bytes":1083,"sha256":"c710c79d28580b828d9a972d2188d59a8fbeabdd8eb6a71dc5e1a4c48d239747"},"omission-fx-receipt":{"bytes":7018,"sha256":"ef53e69f7c4e5d0add3ad741ee096ee992363b061af0b5c53431e5e5a6d7d9b1"}};
const ns=(s:string)=>{const t=s18Instant(s);a28Check(t!==null,'CLOCK');return t!;};
/** Exact original-source snapshot, not an extensible caller-selected source catalogue. */
function packet(raw:string,cutoff:string):A28Packet{
 a28Check(Buffer.byteLength(raw)<=A28_FILE_BYTES,'FILE_BOUND');const p=a28PacketSchema.parse(JSON.parse(raw));
 a28Check(ns(p.packagedAt)<=ns(cutoff),'PACKAGING_CLOCK');
 const roles=p.records.map(r=>r.role);a28Check(new Set(roles).size===roles.length&&same([...roles].sort(),Object.keys(A28_ORIGINAL_BODIES).sort()),'ORIGINAL_ROLE_CATALOG');
 for(const r of p.records){const b=Buffer.from(r.body.raw,'utf8'),pin=A28_ORIGINAL_BODIES[r.role];a28Check(b.length===r.body.bytes&&a28Hash(b)===r.body.sha256&&pin.bytes===b.length&&pin.sha256===r.body.sha256,'ORIGINAL_BODY');}
 return p;
}
/** Original clocks/requests are reconstructed; opaque context-notes/catalog packaging has no invented historical clock. */
function manifestFor(p:A28Packet):A28Manifest{
 const raw=new Map(p.records.map(r=>[r.role,r.body.raw])),json=(role:string):any=>JSON.parse(raw.get(role)!);
 const m=json('original-manifest'),old=json('omission-native-manifest'),w=json('client-end-witness'),parent=json('parent-context-receipts');
 const receipts=p.records.map((r):A28Receipt=>{
  let request:Record<string,unknown>,retrievedAt:string;
  const page=/^(native-page|omission-native-page)-([0-9]{2})$/.exec(r.role);
  if(page){const e=(page[1]==='native-page'?m:old).entries[Number(page[2])];a28Check(e&&e.sha256===r.body.sha256&&e.bytes===r.body.bytes,'NATIVE_RECEIPT');request={method:e.method,url:e.url,variables:e.variables,startedAt:e.startedAt,durationMs:e.durationMs};retrievedAt=new Date(Date.parse(e.startedAt)+e.durationMs).toISOString();}
  else if(r.role==='original-scope'){request={kind:'ORIGINAL_QUERY_SCOPE'};retrievedAt=json(r.role).frozenAt;}
  else if(r.role==='original-manifest'||r.role==='omission-native-manifest'){request={kind:r.role==='original-manifest'?'ORIGINAL_QUOTED_EXPORT_MANIFEST':'OLD_QUERY_CONTEXT_MANIFEST'};retrievedAt=json(r.role).capturedAt;}
  else if(r.role==='client-end-witness'){request={kind:'ORIGINAL_CLIENT_END_OBSERVATION',query:w.query};retrievedAt=w.observedAt;}
  else if(r.role==='qualification-contract'||r.role==='catalyst-dispositions'||r.role==='model-profile'){request={kind:r.role.toUpperCase().replaceAll('-','_')};retrievedAt=json(r.role).frozenAt;}
  else if(r.role==='root-qualification-context'){request={kind:'ROOT_NATIVE_ADJUDICATION_NOT_REMOTE_MODEL_EXECUTION'};retrievedAt=json(r.role).adoptedAt;}
  else if(r.role==='parent-context-syndication'||r.role==='parent-context-fxtwitter'){const q=parent.find((x:any)=>x.file===(r.role.endsWith('syndication')?'syndication.body':'fxtwitter.body'));a28Check(q&&q.sha256===r.body.sha256&&q.bytes===r.body.bytes,'PARENT_RECEIPT');request={method:'GET',url:q.url,httpStatus:q.httpStatus,startedAt:q.startedAt};retrievedAt=q.receivedAt;}
  else if(r.role==='parent-context-receipts'){request={kind:'ORIGINAL_PARENT_CONTEXT_PUBLIC_RECEIPTS'};retrievedAt=parent.reduce((a:string,x:any)=>ns(x.receivedAt)>ns(a)?x.receivedAt:a,parent[0].receivedAt);}
  else if(r.role==='omission-fx-receipt'){const q=json(r.role);request={provider:q.provider,url:q.request,statusUrl:q.statusUrl,httpStatus:q.status};retrievedAt=q.retrievedAt;}
  else {request={kind:r.role==='observation-notes'?'ORIGINAL_OBSERVATION_NOTES_CONTEXT':'ORIGINAL_OMISSION_CATALOG_CONTEXT',historicalCreationClock:'NOT_RECORDED'};retrievedAt=p.packagedAt;}
  a28Check(ns(retrievedAt)<=ns(p.packagedAt),'ORIGINAL_SOURCE_CLOCK');return{role:r.role,request,retrievedAt,sourceBytes:r.body.bytes,sourceHash:r.body.sha256};
 });
 const{records,...header}=p;return a28ManifestSchema.parse({...header,receipts});
}
export function decodeA28Portable(manifestRaw:string,rawSources:Record<string,string>,cutoff:string){
 a28Check(Buffer.byteLength(manifestRaw)<=A28_FILE_BYTES,'CAPTURE_BOUND');const m=a28ManifestSchema.parse(JSON.parse(manifestRaw));
 a28Check(same(Object.keys(rawSources).sort(),m.receipts.map(r=>r.role).sort()),'RAW_CATALOG');
 const{receipts,...header}=m;const candidate={...header,records:receipts.map(r=>({role:r.role,body:{raw:rawSources[r.role],bytes:r.sourceBytes,sha256:r.sourceHash}}))};
 const p=packet(JSON.stringify(candidate),cutoff),expected=manifestFor(p);a28Check(same(m,expected),'EXACT_ORIGINAL_RECEIPTS');
 return{manifest:m,packet:p,texts:new Map(p.records.map(r=>[r.role,r.body.raw]))};
}
function load(file:string,token:TokenRef,cutoff:string){
 a28Check(tokenRefSchema.safeParse(token).success&&token.chain==='solana'&&s18Instant(cutoff)!==null,'TOKEN_CUTOFF');
 let fd:number|undefined,b:Buffer;
 try{fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);const st=fstatSync(fd);a28Check(st.isFile()&&st.size<=A28_FILE_BYTES,'FILE_BOUND');const bytes=Buffer.alloc(st.size+1);let n=0;while(n<bytes.length){const got=readSync(fd,bytes,n,bytes.length-n,n);if(!got)break;n+=got;}a28Check(n===st.size,'FILE_GROWTH');b=bytes.subarray(0,n);}finally{if(fd!==undefined)closeSync(fd);}
 const raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(b!);a28Check(Buffer.from(raw).equals(b!),'UTF8');const p=packet(raw,cutoff);
 // Import also exercises all original native/qualification source gates before app/API work.
 rederiveA28Source(raw,{now:Date.parse(cutoff)});const manifest=manifestFor(p),manifestRaw=JSON.stringify(manifest);
 const records:A28WireRecord[]=[{id:A28_CAPTURE_ID,raw:manifestRaw,scope:a28CaptureScope(),retrievedAt:manifest.packagedAt},...manifest.receipts.map(r=>({id:a28Id(r.role),raw:p.records.find(x=>x.role===r.role)!.body.raw,scope:a28RoleScope(r),retrievedAt:r.retrievedAt}))];return{manifest,records};
}
export function loadA28DecayCapture(file:string,token:TokenRef,cutoff:string){try{return load(file,token,cutoff);}catch(e){if(e instanceof Error&&/^A28_DECAY_[A-Z_]+$/.test(e.message))throw e;return a28Fail('IMPORT_INVALID');}}
