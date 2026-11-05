import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {isDeepStrictEqual as same} from 'node:util';
import {z} from 'zod';
import {evidenceRecordSchema,tokenRefSchema,type EvidenceRecord,type TokenRef} from '../domain/contracts.js';
import type {HolderFacts} from '../domain/baseline.js';
import {decodeHolderPopulation,decodeRawMintControls,decodeSolanaAddress,SOLANA_MAINNET_GENESIS,LEGACY_TOKEN_PROGRAM,TOKEN_2022_PROGRAM} from './solana.js';
import {HOLDER_ARCHIVE_ADAPTER,unpackHolderPopulation} from './advisory-topology.js';
import {validateHolderReference,HOLDER_AGE_SPECIAL_ADDRESSES} from './advisory-holder-age.js';

export const HOLDER_AGE_METHOD='o22-local-retained-reference-capture-v1' as const,HOLDER_AGE_CHUNK_METHOD='o22-local-retained-reference-records-v1' as const;
export const HOLDER_AGE_SOURCE_ID='advisory-holder-age',HOLDER_AGE_PREFIX=HOLDER_AGE_SOURCE_ID+'-',HOLDER_AGE_ADAPTER='o22-holder-age-receipts-v1';
export const HOLDER_AGE_STORED_BYTES=128*1024*1024,HOLDER_AGE_MANIFEST_BYTES=500_000,HOLDER_AGE_CHUNK_BYTES=32_000_000,HOLDER_AGE_SOURCE_BYTES=512*1024*1024,HOLDER_AGE_INFLATED_BYTES=768*1024*1024;
export const HOLDER_AGE_ARCHIVE_METHOD='o23-deflate-raw-v1' as const;
const int=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),positive=int.positive(),instant=z.iso.datetime({offset:true}),hash=z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema=z.object({method:z.string(),params:z.array(z.unknown())}).strict();
const common={key:z.string().min(1).max(128),id:z.string().min(1).max(100),retrievedAt:instant,sourceBytes:positive.max(64_000_000),sourceHash:hash,raw:z.string().min(1)};
const owner={...common,ownerIndex:int.max(19999),request:requestSchema};
const nativeRecordSchema=z.discriminatedUnion('kind',[
 z.object({...common,kind:z.literal('ORIGIN'),evidence:evidenceRecordSchema}).strict(),
 z.object({...common,kind:z.literal('BANK_TIME'),request:requestSchema}).strict(),
 ...(['FIRST','OLD_PREFIX','BEFORE','OLDER']as const).map(kind=>z.object({...owner,kind:z.literal(kind)}).strict()),
]);
export type HolderAgeNativeRecord=z.infer<typeof nativeRecordSchema>;
const countsSchema=z.object({ORIGIN:int,BANK_TIME:int,FIRST:int,OLD_PREFIX:int,BEFORE:int,OLDER:int}).strict();
const originSchema=z.object({snapshotId:z.string().min(1).max(128),cutoff:instant,scope:z.literal('RETAINED_LIVE_SOLANA_HOLDER_ARTIFACTS'),requestWire:z.literal('NOT_RETAINED')}).strict();
const chunkSchema=z.object({id:z.string().regex(/^chunk-(?:0|[1-9][0-9]?)$/),file:z.string(),encoding:z.literal('DEFLATE_RAW_BINARY'),sourceBytes:positive.max(HOLDER_AGE_CHUNK_BYTES),sourceHash:hash,archiveBytes:positive.max(HOLDER_AGE_STORED_BYTES),archiveHash:hash,recordCount:positive.max(32768),recordKeysHash:hash}).strict();
export const holderAgeManifestSchema=z.object({method:z.literal(HOLDER_AGE_METHOD),token:tokenRefSchema,createdAt:instant,ageThresholdHours:z.literal(24),origin:originSchema,sourceSemantics:z.literal('LOCAL_RETAINED_REFERENCE_CONTAINER'),recordCounts:countsSchema,chunks:z.array(chunkSchema).min(1).max(32),nativeRecords:positive.max(32768),nativeSourceBytes:positive.max(HOLDER_AGE_SOURCE_BYTES)}).strict();
const receiptSchema=z.object({method:z.literal(HOLDER_AGE_METHOD),token:tokenRefSchema,createdAt:instant,ageThresholdHours:z.literal(24),rawArtifacts:z.record(z.string(),z.string())}).strict();
const descriptorSchema=z.object({method:z.literal(HOLDER_AGE_METHOD),token:tokenRefSchema,createdAt:instant,ageThresholdHours:z.literal(24),manifestId:z.string(),chunkIds:z.array(z.string()).min(1).max(32)}).strict();
const archiveSchema=z.object({method:z.literal(HOLDER_AGE_ARCHIVE_METHOD),encoding:z.literal('DEFLATE_RAW_BASE64'),sourceBytes:positive.max(HOLDER_AGE_CHUNK_BYTES),sourceHash:hash,data:z.string()}).strict();
export type HolderAgeReceipts=z.infer<typeof receiptSchema>;
export type HolderAgeDescriptor=z.infer<typeof descriptorSchema>;
export type HolderAgeRecordValue={value:any;record:HolderAgeNativeRecord};
export type HolderAgeSourceContext={token:TokenRef;cutoff:string;createdAt:string;origin:z.infer<typeof originSchema>;bank:{slot:number;blockTime:number;at:string};mint:{slot:number;program:string;decimals:number;supplyAtomic:string};holders:HolderFacts;owners:Array<{owner:string;heldAtomic:string}>;first:Map<number,HolderAgeRecordValue>;prefixes:Map<number,HolderAgeRecordValue>;before:Map<number,HolderAgeRecordValue>;older:Map<number,HolderAgeRecordValue>;summary:{nativeRecords:number;nativeSourceBytes:number;storedBytes:number;chunkInflatedBytes:number;originalPopulationAccounts:number;positiveOwners:number;firstRecords:number;prefixRecords:number;beforeRecords:number;olderRecords:number;exceptionalOwners:string[];providerIndexPremise:{requestedSlotFloor:0;requestedSlotCeiling:number;status:'ANY';tokenAccounts:'NONE';retention:'DECLARED_PROVIDER_INDEX_NOT_FIRST_EVER'}}};
function fail(code:string):never{throw Error('O22_HOLDER_SOURCE_'+code);}
const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const utf8=(s:string)=>Buffer.from(s).toString('utf8')===s;
const time=(s:string)=>{const n=Date.parse(s);if(!Number.isFinite(n))fail('CLOCK');return n;};
const address=(s:string)=>{try{decodeSolanaAddress(s);}catch{fail('ADDRESS');}return s;};
/** This archive is a byte container only; its literal grants no other metric's source authority. */
export function unpackHolderAgeChunk(text:string):string{
 let a:z.infer<typeof archiveSchema>;try{a=archiveSchema.parse(JSON.parse(text));}catch{return fail('ARCHIVE');}
 if(!utf8(text)||JSON.stringify(a)!==text)fail('ARCHIVE_CANONICAL');const packed=Buffer.from(a.data,'base64');if(packed.toString('base64')!==a.data)fail('BASE64');
 let raw:Buffer;try{const info=inflateRawSync(packed,{maxOutputLength:a.sourceBytes,info:true})as unknown as{buffer:Buffer;engine:{bytesWritten:number}};if(info.engine.bytesWritten!==packed.length)fail('TRAILING');raw=info.buffer;}catch{return fail('INFLATION');}
 if(raw.length!==a.sourceBytes||sha(raw)!==a.sourceHash)fail('CHUNK_HASH');const decoded=raw.toString('utf8');if(!Buffer.from(decoded).equals(raw))fail('UTF8');return decoded;
}
export function validateHolderAgeReceiptShape(value:HolderAgeReceipts,cutoff:string):HolderAgeReceipts{
 let r:HolderAgeReceipts;try{r=receiptSchema.parse(value);}catch{return fail('RECEIPT_SCHEMA');}if(r.token.chain!=='solana'||time(r.createdAt)>time(cutoff))fail('SCOPE');address(r.token.address);
 const ids=Object.keys(r.rawArtifacts);if(ids.length<2||ids.length>33||!ids.includes('manifest')||ids.some(k=>k!=='manifest'&&!/^chunk-(?:0|[1-9][0-9]?)$/.test(k)))fail('OUTER_MEMBERSHIP');let stored=0;for(const[id,raw]of Object.entries(r.rawArtifacts)){if(!utf8(raw)||Buffer.byteLength(raw)>(id==='manifest'?HOLDER_AGE_MANIFEST_BYTES:HOLDER_AGE_STORED_BYTES)||(stored+=Buffer.byteLength(raw))>HOLDER_AGE_STORED_BYTES)fail('STORED_BOUND');}return r;
}
function decodeRecords(r:HolderAgeReceipts){
 let m:z.infer<typeof holderAgeManifestSchema>;try{m=holderAgeManifestSchema.parse(JSON.parse(r.rawArtifacts.manifest!));}catch{return fail('MANIFEST');}
 if(!same({method:m.method,token:m.token,createdAt:m.createdAt,ageThresholdHours:m.ageThresholdHours},{method:r.method,token:r.token,createdAt:r.createdAt,ageThresholdHours:r.ageThresholdHours})||time(m.origin.cutoff)>time(m.createdAt))fail('MANIFEST_SCOPE');
 if(!same(Object.keys(r.rawArtifacts).sort(),['manifest',...m.chunks.map(c=>c.id)].sort())||m.chunks.reduce((n,c)=>n+c.sourceBytes,0)>HOLDER_AGE_INFLATED_BYTES)fail('CHUNK_MEMBERSHIP');
 const all:HolderAgeNativeRecord[]=[],seen=new Set<string>(),counts={ORIGIN:0,BANK_TIME:0,FIRST:0,OLD_PREFIX:0,BEFORE:0,OLDER:0};let inflated=0;
 for(const[i,c]of m.chunks.entries()){
  if(c.id!=='chunk-'+i||c.file!==c.id+'.deflate'||(inflated+=c.sourceBytes)>HOLDER_AGE_INFLATED_BYTES)fail('CHUNK_SEQUENCE');const wrapper=r.rawArtifacts[c.id]!;let a:any;try{a=JSON.parse(wrapper);}catch{return fail('ARCHIVE');}const packed=Buffer.from(a.data??'','base64');if(a.sourceBytes!==c.sourceBytes||a.sourceHash!==c.sourceHash||packed.length!==c.archiveBytes||sha(packed)!==c.archiveHash)fail('CHUNK_CATALOG');
  let body:{method:typeof HOLDER_AGE_CHUNK_METHOD;records:HolderAgeNativeRecord[]};try{body=z.object({method:z.literal(HOLDER_AGE_CHUNK_METHOD),records:z.array(nativeRecordSchema).min(1).max(32768)}).strict().parse(JSON.parse(unpackHolderAgeChunk(wrapper)));}catch(error){if(error instanceof Error&&error.message.startsWith('O22_HOLDER_SOURCE_'))throw error;return fail('RECORD_SCHEMA');}
  if(body.records.length!==c.recordCount||sha(JSON.stringify(body.records.map(v=>v.key)))!==c.recordKeysHash)fail('RECORD_CATALOG');
  for(const v of body.records){if(!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(v.id)||v.key!==v.kind+':'+v.id||seen.has(v.key)||!utf8(v.raw)||Buffer.byteLength(v.raw)!==v.sourceBytes||sha(v.raw)!==v.sourceHash||time(v.retrievedAt)>time(r.createdAt))fail('NATIVE_RECORD');if((v.kind!=='ORIGIN'||v.id!=='rpc-holder-population')&&v.sourceBytes>500_000)fail('NATIVE_BOUND');seen.add(v.key);all.push(v);counts[v.kind]++;if(all.length>32768)fail('RECORD_BOUND');}
 }
 if(!same(counts,m.recordCounts)||all.length!==m.nativeRecords)fail('RECORD_COUNTS');return{manifest:m,all,inflated};
}
function resultRaw(raw:string):any{let v:any;try{v=JSON.parse(raw);}catch{return fail('RPC_JSON');}if(!object(v)||!same(Object.keys(v).sort(),['id','jsonrpc','result'])||v.id!==1||v.jsonrpc!=='2.0')return fail('RPC_ENVELOPE');return v.result;}
const expect=(r:HolderAgeNativeRecord,request:unknown)=>{if(!('request'in r)||!same(r.request,request))fail('REQUEST');};
/** Exact source/roster/role joins are rebuilt before storage can receive an allowance. */
export function decodeHolderAgeSource(input:HolderAgeReceipts,cutoff:string):HolderAgeSourceContext{
 const r=validateHolderAgeReceiptShape(input,cutoff),{manifest,all,inflated}=decodeRecords(r),origin=all.filter(v=>v.kind==='ORIGIN');if(origin.length!==3)fail('ORIGIN_MEMBERSHIP');const native=new Map<string,string>();let nativeSourceBytes=0;
 for(const rec of origin){if(rec.kind!=='ORIGIN')fail('ORIGIN');const e=rec.evidence;if(!['rpc-genesis','rpc-mint-raw','rpc-holder-population'].includes(rec.id)||e.id!==rec.id||e.sourceId!=='solana-rpc'||e.sourceType!=='JSON_RPC'||e.accessMode!=='PUBLIC_API'||e.contentHash!==rec.sourceHash||e.retrievedAt!==rec.retrievedAt||time(e.availableAt)>time(e.retrievedAt)||time(e.retrievedAt)>time(manifest.origin.cutoff))fail('ORIGIN_EVIDENCE');
  const scope=rec.id==='rpc-genesis'?{method:'getGenesisHash',genesisHash:SOLANA_MAINNET_GENESIS}:{operation:rec.id,commitment:'finalized',mint:r.token.address,...(rec.id==='rpc-holder-population'?{fullAccountData:true}:{})};if(!same(e.scope,scope))fail('ORIGIN_SCOPE');let raw=rec.raw;
  if(rec.id==='rpc-holder-population'&&e.adapterVersion===HOLDER_ARCHIVE_ADAPTER)raw=unpackHolderPopulation(raw);else if(e.adapterVersion!=='live-v1')fail('ORIGIN_ADAPTER');
  if(Buffer.byteLength(raw)>(rec.id==='rpc-holder-population'?64_000_000:500_000))fail('ORIGIN_BOUND');nativeSourceBytes+=Buffer.byteLength(raw);native.set(rec.id,raw);
 }
 if(native.size!==3||resultRaw(native.get('rpc-genesis')!)!==SOLANA_MAINNET_GENESIS)fail('GENESIS');const mintResult=resultRaw(native.get('rpc-mint-raw')!),account=mintResult?.value;
 if(!object(mintResult?.context)||!integer(mintResult.context.slot)||!object(account)||account.executable!==false||![LEGACY_TOKEN_PROGRAM,TOKEN_2022_PROGRAM].includes(account.owner)||!Array.isArray(account.data)||account.data[1]!=='base64'||typeof account.data[0]!=='string')fail('MINT');const bytes=Buffer.from(account.data[0],'base64');if(bytes.toString('base64')!==account.data[0]||bytes.length<82||bytes[45]!==1)fail('MINT');const controls=decodeRawMintControls(mintResult);if(controls.unsupported.some(c=>c.startsWith('EXTENSION_')))fail('MINT_LAYOUT');
 const supplyAtomic=bytes.readBigUInt64LE(36).toString(),mint={slot:mintResult.context.slot as number,program:account.owner as string,decimals:bytes[44]!,supplyAtomic};
 const population=resultRaw(native.get('rpc-holder-population')!);if(!Array.isArray(population?.value)||population.value.length>100000)fail('POPULATION_BOUND');const holders=decodeHolderPopulation(population,r.token.address,mint.program,supplyAtomic,mint.slot),totals=new Map<string,bigint>();for(const a of holders.accounts){address(a.owner);const n=BigInt(a.amount);if(n>0n)totals.set(a.owner,(totals.get(a.owner)??0n)+n);}const owners=[...totals.keys()].sort().map(owner=>({owner,heldAtomic:String(totals.get(owner)!)}));if(owners.length>20000)fail('OWNER_BOUND');
 const banks=all.filter(v=>v.kind==='BANK_TIME');if(banks.length!==1||banks[0]!.id!=='population')fail('BANK_MEMBERSHIP');const bankRecord=banks[0]!;expect(bankRecord,{method:'getBlockTime',params:[holders.slot]});const blockTime=resultRaw(bankRecord.raw);if(!integer(blockTime)||blockTime<=0||blockTime*1000>time(bankRecord.retrievedAt)||blockTime*1000>time(origin.find(v=>v.id==='rpc-holder-population')!.evidence.availableAt))fail('BANK_CLOCK');const bank={slot:holders.slot,blockTime,at:bankRecord.retrievedAt},threshold=blockTime-86400;
 const first=new Map<number,HolderAgeRecordValue>(),prefixes=new Map<number,HolderAgeRecordValue>(),before=new Map<number,HolderAgeRecordValue>(),older=new Map<number,HolderAgeRecordValue>();
 const firstRecords=all.filter(v=>v.kind==='FIRST');if(firstRecords.length!==owners.length)fail('FIRST_MEMBERSHIP');
 const request=(owner:string,old=false)=>({method:'getTransactionsForAddress',params:[owner,{transactionDetails:'full',encoding:'jsonParsed',maxSupportedTransactionVersion:1,commitment:'finalized',sortOrder:old?'desc':'asc',limit:1,filters:{slot:{gte:0,lte:holders.slot},...(old?{blockTime:{lte:threshold}}:{}),status:'any',tokenAccounts:'none'}}]});
 const references=new Map<number,ReturnType<typeof validateHolderReference>>();
 for(const rec of firstRecords){if(!('ownerIndex'in rec)||rec.id!=='owner-'+rec.ownerIndex||rec.ownerIndex>=owners.length||first.has(rec.ownerIndex))fail('FIRST_INDEX');const owner=owners[rec.ownerIndex]!.owner;expect(rec,request(owner));if(time(rec.retrievedAt)<blockTime*1000)fail('HISTORY_CLOCK');const value=resultRaw(rec.raw),reference=validateHolderReference(value,owner,bank,rec.retrievedAt);first.set(rec.ownerIndex,{value,record:rec});references.set(rec.ownerIndex,reference);nativeSourceBytes+=rec.sourceBytes;}
 const optional=all.filter(v=>['OLD_PREFIX','BEFORE','OLDER'].includes(v.kind));
 for(const rec of optional){if(!('ownerIndex'in rec)||rec.id!=='owner-'+rec.ownerIndex||rec.ownerIndex>=owners.length||time(rec.retrievedAt)<blockTime*1000)fail('OWNER_ROLE');const i=rec.ownerIndex,owner=owners[i]!.owner,reference=references.get(i),recent=reference?.blockTime!==null&&reference?.blockTime!==undefined&&reference.blockTime>threshold;
  const value=resultRaw(rec.raw);if(rec.kind==='OLD_PREFIX'){if(!recent||prefixes.has(i))fail('PREFIX_ORPHAN');expect(rec,{method:'getTransactionsForAddress',params:[owner,{transactionDetails:'signatures',commitment:'finalized',sortOrder:'desc',limit:1,filters:{slot:{gte:0,lte:holders.slot},blockTime:{lte:threshold},status:'any',tokenAccounts:'none'}}]});validatePrefix(value,holders.slot,threshold,rec.retrievedAt);prefixes.set(i,{value,record:rec});}
  else if(rec.kind==='BEFORE'){if(!recent||before.has(i)||!reference)fail('BEFORE_ORPHAN');expect(rec,{method:'getSignaturesForAddress',params:[owner,{commitment:'finalized',minContextSlot:holders.slot,limit:1,before:reference.signature}]});validateBefore(value,holders.slot,rec.retrievedAt);before.set(i,{value,record:rec});}
  else if(rec.kind==='OLDER'){if(!reference||reference.blockTime!==null||older.has(i))fail('OLDER_ORPHAN');expect(rec,request(owner,true));const ref=validateHolderReference(value,owner,bank,rec.retrievedAt);if(ref?.blockTime!==null&&ref?.blockTime!==undefined&&ref.blockTime>threshold)fail('OLDER_RANGE');older.set(i,{value,record:rec});}
  else fail('ROLE');nativeSourceBytes+=rec.sourceBytes;
 }
 nativeSourceBytes+=bankRecord.sourceBytes;for(const[i,ref]of references)if(ref?.blockTime!==null&&ref?.blockTime!==undefined&&ref.blockTime>threshold&&(!prefixes.has(i)||!before.has(i)))fail('RECENT_CORROBORATION_MISSING');
 if(nativeSourceBytes!==manifest.nativeSourceBytes||nativeSourceBytes>HOLDER_AGE_SOURCE_BYTES)fail('NATIVE_TOTAL');
 return{token:r.token,cutoff,createdAt:r.createdAt,origin:manifest.origin,bank,mint,holders,owners,first,prefixes,before,older,summary:{nativeRecords:all.length,nativeSourceBytes,storedBytes:Object.values(r.rawArtifacts).reduce((n,v)=>n+Buffer.byteLength(v),0),chunkInflatedBytes:inflated,originalPopulationAccounts:holders.accounts.length,positiveOwners:owners.length,firstRecords:first.size,prefixRecords:prefixes.size,beforeRecords:before.size,olderRecords:older.size,exceptionalOwners:owners.map(v=>v.owner).filter(a=>HOLDER_AGE_SPECIAL_ADDRESSES.includes(a)),providerIndexPremise:{requestedSlotFloor:0,requestedSlotCeiling:holders.slot,status:'ANY',tokenAccounts:'NONE',retention:'DECLARED_PROVIDER_INDEX_NOT_FIRST_EVER'}}};
}
function signature(v:unknown):string{if(typeof v!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(v))return fail('SIGNATURE');let n=0n;const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';for(const c of v)n=n*58n+BigInt(alphabet.indexOf(c));let h=n.toString(16);if(h.length%2)h='0'+h;const b=Buffer.concat([Buffer.alloc(v.match(/^1*/)?.[0].length??0),n?Buffer.from(h,'hex'):Buffer.alloc(0)]);if(b.length!==64)return fail('SIGNATURE');return v;}
function validatePrefix(v:any,slot:number,threshold:number,at:string){if(!object(v)||!same(Object.keys(v).sort(),['data','paginationToken'])||!Array.isArray(v.data)||v.data.length>1||!(v.paginationToken===null||typeof v.paginationToken==='string'))fail('PREFIX_SHAPE');if(!v.data.length){if(v.paginationToken!==null)fail('PREFIX_CURSOR');return;}const row=v.data[0];validateIndexRow(row,slot,at);if(!integer(row.transactionIndex))fail('PREFIX_POSITION');if(row.blockTime===null||row.blockTime>threshold||v.paginationToken!==`${row.slot}:${row.transactionIndex}`)fail('PREFIX_RANGE');}
function validateIndexRow(row:any,slot:number,at:string){if(!object(row)||!integer(row.slot)||row.slot>slot||!(row.blockTime===null||integer(row.blockTime)&&row.blockTime*1000<=time(at))||!('err'in row)||!(row.err===null||object(row.err)||typeof row.err==='string')||row.confirmationStatus!=='finalized')fail('INDEX_ROW');signature(row.signature);}
function validateBefore(v:any,slot:number,at:string){if(!Array.isArray(v)||v.length>1)fail('BEFORE_SHAPE');for(const row of v)validateIndexRow(row,slot,at);}
export function holderAgeContainerScope(r:Pick<HolderAgeReceipts,'method'|'rawArtifacts'>,localId:string){return{container:{method:r.method,manifestHash:sha(r.rawArtifacts.manifest??''),part:localId}};}
export function validateHolderAgeStorage(bundle:{token:TokenRef;rawArtifacts:Record<string,string>;evidence:EvidenceRecord[]},descriptor:HolderAgeDescriptor,cutoff:string):Set<string>{
 let d:HolderAgeDescriptor;try{d=descriptorSchema.parse(descriptor);}catch{return fail('DESCRIPTOR');}if(!same(d.token,bundle.token))fail('STORAGE_TOKEN');const{rawArtifacts,evidence}=bundle,ids=[d.manifestId,...d.chunkIds],owned=evidence.filter(e=>e.sourceId===HOLDER_AGE_SOURCE_ID||e.id.startsWith(HOLDER_AGE_PREFIX)),rawOwned=Object.keys(rawArtifacts).filter(id=>id.startsWith(HOLDER_AGE_PREFIX));if(new Set(ids).size!==ids.length||!same([...ids].sort(),owned.map(e=>e.id).sort())||!same([...ids].sort(),rawOwned.sort()))fail('STORAGE_MEMBERSHIP');
 const r:HolderAgeReceipts={method:d.method,token:d.token,createdAt:d.createdAt,ageThresholdHours:d.ageThresholdHours,rawArtifacts:{manifest:rawArtifacts[d.manifestId]??''}};
 for(const[local,id]of [['manifest',d.manifestId],...d.chunkIds.map((id,i)=>['chunk-'+i,id])]as Array<[string,string]>){if(id!==HOLDER_AGE_PREFIX+local||evidence.filter(e=>e.id===id).length!==1)fail('STORAGE_ID');const e=owned.find(v=>v.id===id)!;if(e.sourceId!==HOLDER_AGE_SOURCE_ID||e.sourceType!=='HISTORICAL_RECEIPT'||e.accessMode!=='USER_IMPORT'||e.adapterVersion!==HOLDER_AGE_ADAPTER||e.contentHash!==sha(rawArtifacts[id]??'')||e.availableAt!==r.createdAt||e.retrievedAt!==r.createdAt||!same(e.scope,holderAgeContainerScope(r,local)))fail('STORAGE_RECORD');r.rawArtifacts[local]=rawArtifacts[id]!;}
 decodeHolderAgeSource(r,cutoff);return new Set(ids);
}
