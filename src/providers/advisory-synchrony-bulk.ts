import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {isDeepStrictEqual as same} from 'node:util';
import {z} from 'zod';
import {PublicKey} from '@solana/web3.js';
import {PUMP_AMM_PROGRAM_ID,PUMP_AMM_SDK,poolPda,pumpPoolAuthorityPda} from '@pump-fun/pump-swap-sdk';
import {tokenRefSchema,type TokenRef,type EvidenceRecord} from '../domain/contracts.js';
import type {AdvisoryMetric} from '../domain/advisory-contracts.js';
import {SOLANA_MAINNET_GENESIS,encodeSolanaAddress} from './solana.js';
import {decodeWindowQuote} from './advisory-window.js';
import {projectCompiledTransaction} from './advisory-demand-windows.js';
import {decodePumpSwapSynchronyTransaction} from './advisory-trades.js';
import {computeSynchronyStatistics,SYNCHRONY_BINS,SYNCHRONY_PERMUTATIONS,type SynchronyRole} from './advisory-synchrony.js';

export const O23_BULK_METHOD='o23-complete-quote-tape-v1' as const;
export const O23_BULK_SOURCE_ID='advisory-synchrony-bulk';
export const O23_BULK_PREFIX=O23_BULK_SOURCE_ID+'-';
export const O23_BULK_ADAPTER='o23-bulk-receipts-v1';
export const O23_BULK_STORED_BYTES=512*1024*1024;
export const O23_BULK_REQUEST_CAP=248;
export const O23_BULK_PAGE_BYTES=32_000_000;
export const O23_BULK_OTHER_BYTES=500_000;
export const O23_BULK_SOURCE_BYTES=3_000_000_000;
export const O23_BULK_ARCHIVE_METHOD='o23-deflate-raw-v1';
export const O23_BULK_QUOTE='3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh';
type Request={method:string;params:unknown[]};
export type O23BulkReceipts={method:typeof O23_BULK_METHOD;token:TokenRef;pool:string;range:{start:string;end:string};anchorSlot:number;requests:Record<string,Request>;rawArtifacts:Record<string,string>;retrievedAt:Record<string,string>};
export type O23BulkDescriptor=Omit<O23BulkReceipts,'rawArtifacts'|'retrievedAt'>&{artifactIds:Record<string,string>};
const instant=z.iso.datetime({offset:true}),hash=z.string().regex(/^[a-f0-9]{64}$/),request=z.object({method:z.string(),params:z.array(z.unknown())}).strict();
const header={method:z.literal(O23_BULK_METHOD),token:tokenRefSchema,pool:z.string(),range:z.object({start:instant,end:instant}).strict(),anchorSlot:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),requests:z.record(z.string(),request)};
const receiptSchema=z.object({...header,rawArtifacts:z.record(z.string(),z.string()),retrievedAt:z.record(z.string(),instant)}).strict();
const descriptorSchema=z.object({...header,artifactIds:z.record(z.string(),z.string())}).strict();
const archiveSchema=z.object({method:z.literal(O23_BULK_ARCHIVE_METHOD),encoding:z.literal('DEFLATE_RAW_BASE64'),sourceBytes:z.number().int().positive().max(O23_BULK_PAGE_BYTES),sourceHash:hash,data:z.string()}).strict();
const sha=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex');
const obj=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
function fail(code:string):never{throw new Error('ADVISORY_SYNCHRONY_BULK_'+code);}
const time=(v:string)=>{if(!instant.safeParse(v).success)fail('CLOCK');return Date.parse(v);};
const keysEqual=(a:object,b:object)=>same(Object.keys(a).sort(),Object.keys(b).sort());
const address=(v:string)=>{try{if(new PublicKey(v).toBase58()!==v)fail('ADDRESS');}catch{fail('ADDRESS');}};
const signature=(v:unknown)=>{
 if(typeof v!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(v))return fail('SIGNATURE');
 const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=0n;for(const c of v)n=n*58n+BigInt(alphabet.indexOf(c));const hex=n.toString(16),b=Buffer.concat([Buffer.alloc(v.match(/^1*/)?.[0].length??0),n===0n?Buffer.alloc(0):Buffer.from(hex.length%2?'0'+hex:hex,'hex')]);
 if(b.length!==64||encodeSolanaAddress(b)!==v)fail('SIGNATURE');return v;
};
/** Exact reversible bulk container. Only this format receives the new namespace bound. */
export function unpackO23BulkSource(text:string,bulk:boolean):string{
 if(typeof text!=='string'||Buffer.from(text,'utf8').toString('utf8')!==text)fail('UTF8');
 if(!bulk){if(Buffer.byteLength(text)>O23_BULK_OTHER_BYTES)fail('SOURCE_SIZE');return text;}
 let c:z.infer<typeof archiveSchema>;try{c=archiveSchema.parse(JSON.parse(text));}catch{return fail('ARCHIVE');}
 if(JSON.stringify(c)!==text)fail('ARCHIVE_CANONICAL');
 const packed=Buffer.from(c.data,'base64');if(packed.toString('base64')!==c.data)fail('ARCHIVE_BASE64');
 let raw:Buffer;try{const x=inflateRawSync(packed,{maxOutputLength:c.sourceBytes,info:true}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};if(x.engine.bytesWritten!==packed.length)fail('ARCHIVE_TRAILING');raw=x.buffer;}catch{return fail('ARCHIVE_INFLATION');}
 if(raw.length!==c.sourceBytes||sha(raw)!==c.sourceHash)fail('ARCHIVE_HASH');
 const decoded=raw.toString('utf8');if(!Buffer.from(decoded).equals(raw))fail('UTF8');return decoded;
}
/** Header/membership checks are shared with the thin loader; no classification or derived facts are accepted. */
export function validateO23BulkReceiptShape(input:O23BulkReceipts,cutoff:string):O23BulkReceipts{
 let r:O23BulkReceipts;try{r=receiptSchema.parse(input);}catch{return fail('SCHEMA');}
 if(r.token.chain!=='solana')fail('CHAIN');address(r.token.address);address(r.pool);
 const start=time(r.range.start),end=time(r.range.end),cut=time(cutoff);
 if(end-start!==12*3600000||end%3600000!==0||end>cut)fail('RANGE');
 if(!keysEqual(r.requests,r.rawArtifacts)||!keysEqual(r.requests,r.retrievedAt)||Object.keys(r.requests).length>O23_BULK_REQUEST_CAP)fail('MEMBERSHIP');
 let stored=0;for(const id of Object.keys(r.requests)){if(!/^(?:index-page-(?:0|[1-9][0-9]?)|bulk-page-(?:0|[1-9][0-9]{0,2})|compiled-(?:0|[1-9][0-9]?)|genesis|anchor-slot|anchor-time|pool)$/.test(id))fail('ID');if(time(r.retrievedAt[id]!)>cut)fail('CLOCK');stored+=Buffer.byteLength(r.rawArtifacts[id]!);}
 if(stored>O23_BULK_STORED_BYTES)fail('STORED_SIZE');return r;
}
type Indexed={signature:string;slot:number;blockTime:number;order:number};
type Companion={id:string;value:any;projected:any;at:string};
type SourceContext={pool:ReturnType<typeof PUMP_AMM_SDK.decodePool>;stateSlot:number;quote:{mint:string;decimals:number;program:string};success:Map<string,Indexed>;counts:Record<string,number>;sourceBytes:number;storedBytes:number;sourceHashes:string[];companions:Map<string,Companion>};
const requestIs=(r:O23BulkReceipts,id:string,expected:Request)=>{if(!same(r.requests[id],expected))fail('REQUEST');};
function sequence(r:O23BulkReceipts,prefix:string,limit:number):string[]{const found=Object.keys(r.requests).filter(k=>k.startsWith(prefix));if(!found.length||found.length>limit)fail('PAGE_COUNT');const ids=found.map((_,i)=>prefix+i);if(!same([...found].sort(),[...ids].sort()))fail('PAGE_SEQUENCE');return ids;}
function decodeSources(input:O23BulkReceipts,cutoff:string,consume?:(tx:any,indexed:Indexed,at:string,companion:Companion|undefined,context:SourceContext)=>void):SourceContext{
 const r=validateO23BulkReceiptShape(input,cutoff),start=time(r.range.start)/1000,end=time(r.range.end)/1000;
 const context:SourceContext={pool:null as any,stateSlot:0,quote:{mint:'',decimals:0,program:''},success:new Map(),counts:{indexReferences:0,inWindowReferences:0,failedReferences:0,successfulReferences:0,bulkBodies:0,indexPages:0,bulkPages:0,compiledCompanions:0},sourceBytes:0,storedBytes:Object.values(r.rawArtifacts).reduce((n,s)=>n+Buffer.byteLength(s),0),sourceHashes:[],companions:new Map()};
 const read=(id:string)=>{const text=unpackO23BulkSource(r.rawArtifacts[id]!,id.startsWith('bulk-page-'));context.sourceBytes+=Buffer.byteLength(text);if(context.sourceBytes>O23_BULK_SOURCE_BYTES)fail('SOURCE_TOTAL');context.sourceHashes.push(sha(text));let v:any;try{v=JSON.parse(text);}catch{return fail('JSON');}if(!obj(v)||v.jsonrpc!=='2.0'||v.id!==1||v.error!==undefined||!Object.hasOwn(v,'result'))fail('RPC');return v.result;};
 for(const id of ['genesis','anchor-slot','anchor-time','pool'])if(!(id in r.requests))fail('FIXED_SOURCE_MISSING');
 requestIs(r,'genesis',{method:'getGenesisHash',params:[]});if(read('genesis')!==SOLANA_MAINNET_GENESIS)fail('GENESIS');
 requestIs(r,'anchor-slot',{method:'getSlot',params:[{commitment:'finalized'}]});if(read('anchor-slot')!==r.anchorSlot||time(r.retrievedAt['anchor-slot']!)<end*1000)fail('ANCHOR');
 requestIs(r,'anchor-time',{method:'getBlockTime',params:[r.anchorSlot]});const anchorTime=read('anchor-time');if(!integer(anchorTime)||Math.floor(anchorTime/3600)*3600!==end||anchorTime*1000>time(r.retrievedAt['anchor-slot']!)||time(r.retrievedAt['anchor-time']!)<time(r.retrievedAt['anchor-slot']!))fail('ANCHOR');
 let maximumSourceTime=0;for(const at of Object.values(r.retrievedAt))maximumSourceTime=Math.max(maximumSourceTime,time(at));if(time(r.retrievedAt.pool!)<maximumSourceTime)fail('FINAL_BANK_CLOCK');
 requestIs(r,'pool',{method:'getMultipleAccounts',params:[[r.pool,O23_BULK_QUOTE],{encoding:'base64',commitment:'finalized'}]});const bank=read('pool');if(!obj(bank)||!integer(bank.context?.slot)||bank.context.slot<r.anchorSlot||!Array.isArray(bank.value)||bank.value.length!==2)fail('BANK');
 const pa=bank.value[0];if(!obj(pa)||pa.owner!==PUMP_AMM_PROGRAM_ID.toBase58()||pa.executable!==false||!Array.isArray(pa.data)||pa.data[1]!=='base64')fail('POOL');const bytes=Buffer.from(pa.data[0],'base64');if(bytes.toString('base64')!==pa.data[0]||bytes.length>20000)fail('POOL');
 try{context.pool=PUMP_AMM_SDK.decodePool({data:bytes,owner:PUMP_AMM_PROGRAM_ID,lamports:0,executable:false,rentEpoch:0});context.quote=decodeWindowQuote(bank.value[1],O23_BULK_QUOTE);}catch{return fail('POOL');}
 const pool=context.pool;if(pool.index!==0||!pool.creator.equals(pumpPoolAuthorityPda(new PublicKey(r.token.address)))||pool.baseMint.toBase58()!==r.token.address||pool.quoteMint.toBase58()!==O23_BULK_QUOTE||poolPda(pool.index,pool.creator,pool.baseMint,pool.quoteMint).toBase58()!==r.pool||context.quote.decimals!==8||context.quote.program!=='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')fail('POOL_BINDING');context.stateSlot=bank.context.slot;
 const indexIds=sequence(r,'index-page-',100),bulkIds=sequence(r,'bulk-page-',120),compiledIds=Object.keys(r.requests).filter(k=>k.startsWith('compiled-')).sort((a,b)=>Number(a.slice(9))-Number(b.slice(9)));if(compiledIds.length>24||compiledIds.some((k,i)=>k!=='compiled-'+i))fail('COMPANION_SEQUENCE');
 if(Object.keys(r.requests).length!==4+indexIds.length+bulkIds.length+compiledIds.length)fail('MEMBERSHIP');
 const seenIndex=new Set<string>();let before:string|undefined,lastSlot=Infinity,lastTime=Infinity,indexClock=time(r.retrievedAt['anchor-time']!),reached=false;
 for(const [page,id] of indexIds.entries()){
  if(reached)fail('INDEX_AFTER_TERMINAL');requestIs(r,id,{method:'getSignaturesForAddress',params:[r.pool,{commitment:'finalized',limit:1000,minContextSlot:r.anchorSlot,...(before?{before}:{})}]});const at=time(r.retrievedAt[id]!);if(at<indexClock)fail('INDEX_CLOCK');indexClock=at;const rows=read(id);if(!Array.isArray(rows)||rows.length>1000)fail('INDEX_SHAPE');
  for(const row of rows){if(!obj(row))fail('INDEX_SHAPE');const sig=signature(row.signature);if(seenIndex.has(sig)||!integer(row.slot)||row.slot>lastSlot||row.slot>r.anchorSlot||!integer(row.blockTime)||row.blockTime>lastTime||row.blockTime*1000>at||row.confirmationStatus!=='finalized'||!(row.err===null||obj(row.err)||typeof row.err==='string'))fail('INDEX_ROW');seenIndex.add(sig);lastSlot=row.slot;lastTime=row.blockTime;context.counts.indexReferences++;
   if(row.blockTime>=start&&row.blockTime<end){context.counts.inWindowReferences++;if(row.err===null){context.success.set(sig,{signature:sig,slot:row.slot,blockTime:row.blockTime,order:context.success.size});context.counts.successfulReferences++;}else context.counts.failedReferences++;}}
  before=rows.at(-1)?.signature;reached=rows.length<1000||rows.some((row:any)=>row.blockTime<start);if(reached&&page!==indexIds.length-1)fail('INDEX_AFTER_TERMINAL');context.counts.indexPages++;
 }
 if(!reached)fail('INDEX_INCOMPLETE');
 for(const id of compiledIds){const req=r.requests[id]!;if(req.method!=='getTransaction'||req.params.length!==2)fail('COMPANION_REQUEST');const sig=signature(req.params[0]);requestIs(r,id,{method:'getTransaction',params:[sig,{encoding:'json',commitment:'finalized',maxSupportedTransactionVersion:1}]});if(!context.success.has(sig)||context.companions.has(sig))fail('COMPANION_MEMBERSHIP');const value=read(id);let projected:any;try{projected=projectCompiledTransaction(value);}catch{return fail('COMPANION_FORMAT');}context.companions.set(sig,{id,value,projected,at:r.retrievedAt[id]!});context.counts.compiledCompanions++;}
 const seen=new Set<string>(),cursorSet=new Set<string>(),matched=new Set<string>();let cursor:string|null=null,lastPosition=[Infinity,Infinity],bulkClock=indexClock,terminal=false;
 for(const [page,id] of bulkIds.entries()){
  if(terminal)fail('BULK_AFTER_TERMINAL');requestIs(r,id,{method:'getTransactionsForAddress',params:[r.pool,{transactionDetails:'full',encoding:'jsonParsed',maxSupportedTransactionVersion:1,commitment:'finalized',minContextSlot:r.anchorSlot,sortOrder:'desc',limit:500,...(cursor?{paginationToken:cursor}:{}),filters:{blockTime:{gte:start,lt:end},status:'succeeded',tokenAccounts:'none'}}]});const at=time(r.retrievedAt[id]!);if(at<bulkClock)fail('BULK_CLOCK');bulkClock=at;const result=read(id);if(!obj(result)||!keysEqual(result,{data:0,paginationToken:0})||!Array.isArray(result.data)||result.data.length>500)fail('BULK_SHAPE');
  for(const tx of result.data){if(!obj(tx)||!keysEqual(tx,{transaction:0,meta:0,version:0,slot:0,transactionIndex:0,blockTime:0})||!obj(tx.transaction)||!Array.isArray(tx.transaction.signatures)||!obj(tx.meta)||tx.meta.err!==null||!['legacy',0,1].includes(tx.version))fail('BODY');const sig=signature(tx.transaction.signatures[0]),indexed=context.success.get(sig);if(!indexed||seen.has(sig)||tx.slot!==indexed.slot||tx.blockTime!==indexed.blockTime||!integer(tx.transactionIndex)||tx.slot>context.stateSlot||tx.blockTime*1000>at)fail('BODY_BIJECTION');const position=[tx.slot,tx.transactionIndex];if(position[0]>lastPosition[0]||position[0]===lastPosition[0]&&position[1]>=lastPosition[1])fail('BODY_ORDER');lastPosition=position;seen.add(sig);
   const message=tx.transaction.message;if(!obj(message)||!Array.isArray(message.accountKeys)||!message.accountKeys.some((k:any)=>k.pubkey===r.pool)||!Array.isArray(message.instructions)||!Array.isArray(tx.meta.innerInstructions)||!Array.isArray(tx.meta.logMessages))fail('BODY_SHAPE');const companion=context.companions.get(sig);if(companion){if(time(companion.at)<at)fail('COMPANION_CLOCK');assertCompanionParity(tx,companion.value,companion.projected);matched.add(sig);}consume?.(tx,indexed,r.retrievedAt[id]!,companion,context);context.counts.bulkBodies++;}
  const next=result.paginationToken;if(!(next===null||typeof next==='string'&&/^(0|[1-9]\d*):(0|[1-9]\d*)$/.test(next))||next!==null&&(next===cursor||cursorSet.has(next)))fail('CURSOR');if(next!==null){cursorSet.add(next);const last=result.data.at(-1);if(!last||next!==`${last.slot}:${last.transactionIndex}`)fail('CURSOR_POSITION');}terminal=next===null;cursor=next;if(terminal&&page!==bulkIds.length-1)fail('BULK_AFTER_TERMINAL');context.counts.bulkPages++;
 }
 if(!terminal||seen.size!==context.success.size||matched.size!==context.companions.size)fail('BODY_CENSUS');return context;
}
function raw58(text:unknown):Buffer{
 if(typeof text!=='string'||!/^[1-9A-HJ-NP-Za-km-z]*$/.test(text))return fail('COMPANION_INSTRUCTION');const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=0n;for(const c of text)n=n*58n+BigInt(alphabet.indexOf(c));const hex=n.toString(16);return Buffer.concat([Buffer.alloc(text.match(/^1*/)?.[0].length??0),n===0n?Buffer.alloc(0):Buffer.from(hex.length%2?'0'+hex:hex,'hex')]);
}
/** Closed native-parser/compiled-ABI equivalence; unknown parsed instructions are never omitted. */
function nativeInstructionMatches(native:any,compiled:any,keyFlags:any[]):boolean{
 if(!obj(native)||!obj(compiled)||native.programId!==compiled.programId||(native.stackHeight??null)!==(compiled.stackHeight??null))return false;
 if(!Object.hasOwn(native,'parsed'))return same(native.accounts,compiled.accounts)&&native.data===compiled.data;
 const a=compiled.accounts,b=raw58(compiled.data),parsed=native.parsed;if(!Array.isArray(a))return false;
 if(compiled.programId==='MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')return typeof parsed==='string'&&Buffer.from(parsed,'utf8').equals(b)&&a.every((k:string)=>keyFlags.some(f=>f.pubkey===k&&f.signer===true));
 if(!obj(parsed)||!obj(parsed.info)||typeof parsed.type!=='string')return false;const t=parsed.type,i=parsed.info;
 const only=(x:object)=>same(i,x),u64=(offset:number)=>b.readBigUInt64LE(offset).toString();
 if(compiled.programId==='11111111111111111111111111111111'){
  if(b.length===12&&b.readUInt32LE(0)===2&&a.length>=2&&t==='transfer')return only({source:a[0],destination:a[1],lamports:Number(b.readBigUInt64LE(4))})&&Number.isSafeInteger(i.lamports);
  if(b.length===52&&b.readUInt32LE(0)===0&&a.length===2&&t==='createAccount')return only({source:a[0],newAccount:a[1],lamports:Number(b.readBigUInt64LE(4)),space:Number(b.readBigUInt64LE(12)),owner:encodeSolanaAddress(b.subarray(20))})&&Number.isSafeInteger(i.lamports)&&Number.isSafeInteger(i.space);
  return false;
 }
 if(compiled.programId==='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')return b.length===1&&b[0]===1&&a.length===6&&t==='createIdempotent'&&only({source:a[0],account:a[1],wallet:a[2],mint:a[3],systemProgram:a[4],tokenProgram:a[5]});
 if(!['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].includes(compiled.programId))return false;
 if(b.length===10&&b[0]===12&&a.length>=4&&t==='transferChecked'){
  if(!obj(i.tokenAmount)||!same(Object.keys(i.tokenAmount).sort(),['amount','decimals','uiAmount','uiAmountString']))return false;
  const amount=u64(1),decimals=b[9]!,digits=amount.padStart(decimals+1,'0'),ui=decimals?(digits.slice(0,-decimals)+'.'+digits.slice(-decimals)).replace(/\.?0+$/,'')||'0':amount;
  if(i.tokenAmount.amount!==amount||i.tokenAmount.decimals!==decimals||i.tokenAmount.uiAmountString!==ui||!(i.tokenAmount.uiAmount===null||typeof i.tokenAmount.uiAmount==='number'&&Number.isFinite(i.tokenAmount.uiAmount)&&i.tokenAmount.uiAmount===Number(amount)/10**decimals))return false;
  return only({source:a[0],mint:a[1],destination:a[2],...(a.length===4?{authority:a[3]}:{multisigAuthority:a[3],signers:a.slice(4)}),tokenAmount:i.tokenAmount});
 }
 if(b.length===9&&b[0]===3&&a.length===3&&t==='transfer')return only({source:a[0],destination:a[1],authority:a[2],amount:u64(1)});
 if(b.length===1&&b[0]===9&&a.length===3&&t==='closeAccount')return only({account:a[0],destination:a[1],owner:a[2]});
 if(b.length===1&&b[0]===17&&a.length===1&&t==='syncNative'||b.length===1&&b[0]===22&&a.length===1&&t==='initializeImmutableOwner')return only({account:a[0]});
 if(b.length===33&&b[0]===18&&a.length===2&&t==='initializeAccount3')return only({account:a[0],mint:a[1],owner:encodeSolanaAddress(b.subarray(1))});
 if(b.length===3&&b[0]===21&&b.readUInt16LE(1)===7&&a.length===1&&t==='getAccountDataSize')return only({mint:a[0],extensionTypes:['immutableOwner']});
 return false;
}
function assertCompanionParity(native:any,compiled:any,projected:any):void{
 for(const k of ['slot','blockTime','version'])if(!same(native[k],compiled[k]))fail('COMPANION_PARITY');
 if(!same(native.transaction.signatures,compiled.transaction.signatures)||native.meta.err!==null||compiled.meta.err!==null)fail('COMPANION_PARITY');
 const meta=(v:any)=>{const{innerInstructions,loadedAddresses,...rest}=v;if(loadedAddresses!==undefined&&loadedAddresses!==null&&!same(loadedAddresses,{writable:[],readonly:[]}))fail('COMPANION_LOADED_ADDRESSES');return rest;};
 if(!same(meta(native.meta),meta(compiled.meta))||!same(native.transaction.message.accountKeys,projected.transaction.message.accountKeys)||native.transaction.message.recentBlockhash!==projected.transaction.message.recentBlockhash||!same(native.transaction.message.transactionConfig,compiled.transaction.message.transactionConfig))fail('COMPANION_PARITY');
 // Known native parsers omit ignored System-transfer tails and expose SPL multisig signer tails by name. The compiled raw tree retains every account for the unchanged runtime/tail guards.
 const n=native.transaction.message.instructions,p=projected.transaction.message.instructions;if(n.length!==p.length)fail('COMPANION_INSTRUCTION_PARITY');
 const pair=(left:any[],right:any[])=>{if(left.length!==right.length)fail('COMPANION_INSTRUCTION_PARITY');for(let i=0;i<left.length;i++)if(!nativeInstructionMatches(left[i],right[i],projected.transaction.message.accountKeys))fail('COMPANION_INSTRUCTION_PARITY');};pair(n,p);
 if(native.meta.innerInstructions.length!==projected.meta.innerInstructions.length)fail('COMPANION_INSTRUCTION_PARITY');for(let i=0;i<native.meta.innerInstructions.length;i++){const left=native.meta.innerInstructions[i],right=projected.meta.innerInstructions[i];if(left.index!==right.index)fail('COMPANION_INSTRUCTION_PARITY');pair(left.instructions,right.instructions);}
}
/** Service storage allowance covers only this exact, fully reconstructed source namespace. No permutations run here. */
export function validateO23BulkStorage(descriptor:O23BulkDescriptor,rawArtifacts:Record<string,string>,evidence:EvidenceRecord[],cutoff:string):Set<string>{
 let d:O23BulkDescriptor;try{d=descriptorSchema.parse(descriptor);}catch{return fail('DESCRIPTOR');}
 if(!keysEqual(d.requests,d.artifactIds))fail('STORAGE_MEMBERSHIP');
 const ids=Object.values(d.artifactIds),owned=evidence.filter(e=>e.sourceId===O23_BULK_SOURCE_ID||e.id.startsWith(O23_BULK_PREFIX)),rawOwned=Object.keys(rawArtifacts).filter(id=>id.startsWith(O23_BULK_PREFIX));
 if(new Set(ids).size!==ids.length||owned.length!==ids.length||rawOwned.length!==ids.length||!same([...ids].sort(),owned.map(e=>e.id).sort())||!same([...ids].sort(),rawOwned.sort()))fail('STORAGE_MEMBERSHIP');
 const receipts:O23BulkReceipts={method:d.method,token:d.token,pool:d.pool,range:d.range,anchorSlot:d.anchorSlot,requests:d.requests,rawArtifacts:{},retrievedAt:{}};
 for(const[local,id]of Object.entries(d.artifactIds)){if(id!==O23_BULK_PREFIX+local||evidence.filter(e=>e.id===id).length!==1)fail('STORAGE_ID');const e=owned.find(e=>e.id===id)!;if(e.sourceId!==O23_BULK_SOURCE_ID||e.accessMode!=='USER_IMPORT'||e.sourceType!=='HISTORICAL_RECEIPT'||e.adapterVersion!==O23_BULK_ADAPTER||!same(e.scope,{request:d.requests[local]})||e.availableAt!==e.retrievedAt||e.contentHash!==sha(rawArtifacts[id]??''))fail('STORAGE_RECORD');receipts.rawArtifacts[local]=rawArtifacts[id]!;receipts.retrievedAt[local]=e.availableAt;}
 decodeSources(receipts,cutoff);return new Set(ids);
}
/** Only count/side/user/fee-role DTOs leave the decoder; monetary fields never enter the O23 tape. */
export function deriveO23BulkSynchrony(receipts:O23BulkReceipts,cutoff:string,evidenceIds:string[]):AdvisoryMetric{
 const roles=new Map<string,SynchronyRole>(),gaps:Array<{signature:string;code:string}>=[],clockDifferences:Array<{signature:string;indexTime:string;programTimestamp:string}>=[];const pairedClockHash=createHash('sha256');let decoded=0,legCount=0,pairedClocks=0,compiledFallbacks=0,clockDifferenceCount=0,maximumClockDifference=0,truncated=0,executionProven=0,foreignSwapLegs=0,nonSwapInvocations=0;
 const context=decodeSources(receipts,cutoff,(tx,indexed,at,companion,c)=>{
  const expected={signature:indexed.signature,slot:indexed.slot,at:new Date(indexed.blockTime*1000).toISOString()};
  try{
   let proof:ReturnType<typeof decodePumpSwapSynchronyTransaction>;
   try{proof=decodePumpSwapSynchronyTransaction(tx,expected,receipts.pool,c.pool,c.stateSlot,at,c.quote.program,c.quote.decimals,{logRecovery:tx.meta.logMessages.includes('Log truncated')});}
   catch(first){if(companion){proof=decodePumpSwapSynchronyTransaction(companion.projected,expected,receipts.pool,c.pool,c.stateSlot,companion.at,c.quote.program,c.quote.decimals,{logRecovery:true,foreignFlowRecovery:true,compiledRecovery:true});compiledFallbacks++;}else if(!tx.meta.logMessages.includes('Log truncated'))proof=decodePumpSwapSynchronyTransaction(tx,expected,receipts.pool,c.pool,c.stateSlot,at,c.quote.program,c.quote.decimals,{logRecovery:true});else throw first;}
   const keys=tx.transaction.message.accountKeys,payer=keys[0];if(proof.trades.length&&(!obj(payer)||payer.signer!==true||payer.writable!==true||!integer(tx.meta.fee)||tx.meta.fee<=0))fail('FEE_ROLE');
   const legs:SynchronyRole['legs']=proof.trades.map(t=>{const key=keys.find((k:any)=>k.pubkey===t.user);if(!key||typeof key.signer!=='boolean')fail('FEE_ROLE');if(t.signature!==indexed.signature||t.slot!==indexed.slot||t.at!==expected.at||!['BUY','SELL'].includes(t.side))fail('COUNT_BINDING');if(Number(t.programTimestamp)*1000>time(at))fail('PROGRAM_SOURCE_CLOCK');pairedClocks++;pairedClockHash.update(JSON.stringify([t.signature,t.instructionIndex,expected.at,t.programTimestamp]));const difference=Math.abs(Number(t.programTimestamp)-indexed.blockTime);maximumClockDifference=Math.max(maximumClockDifference,difference);if(difference){clockDifferenceCount++;if(clockDifferences.length<64)clockDifferences.push({signature:t.signature,indexTime:expected.at,programTimestamp:t.programTimestamp});}return{user:t.user,side:t.side,funding:!key.signer?'PROGRAM':t.user===payer.pubkey?'SELF':'SPONSORED'};});
   if(legs.length)roles.set(indexed.signature,{signature:indexed.signature,slot:indexed.slot,stratum:Math.floor((indexed.blockTime*1000-time(receipts.range.start))/3600000),feePayer:payer.pubkey,legs});legCount+=legs.length;decoded++;foreignSwapLegs+=proof.foreignSwapLegs;nonSwapInvocations+=proof.nonSwapInvocations;if(proof.logRecovery?.truncated){truncated++;executionProven+=proof.logRecovery.executionProvenInvocations??0;}
  }catch(error){if(gaps.length<64)gaps.push({signature:indexed.signature,code:error instanceof Error&&/^(ADVISORY_[A-Z0-9_]+|A29_[A-Z0-9_]+)$/.test(error.message)?error.message:'ADVISORY_SYNCHRONY_BULK_ROLE_UNRESOLVED'});}
 });
 const receiptManifestHash=sha(JSON.stringify(Object.keys(receipts.requests).sort().map(id=>[id,receipts.requests[id],receipts.retrievedAt[id],sha(receipts.rawArtifacts[id]!)])));
 const scope={method:'sponsored-fee-payer-synchrony-v2',tapeMethod:O23_BULK_METHOD,scope:'HISTORICAL_FIXED_12H_POOL_TAPE',token:receipts.token,pool:receipts.pool,range:receipts.range,anchorSlot:receipts.anchorSlot,stateSlot:context.stateSlot,tapeComplete:decoded===context.success.size,quote:{mint:context.quote.mint,decimals:context.quote.decimals,program:context.quote.program},sourceTrust:'RETAINED_PROVIDER_RPC_IMPORT',sourceAuthentication:'Hashes bind retained bytes, not provider authentication or independent onchain attestation.',permutations:SYNCHRONY_PERMUTATIONS,commonControl:null,coordination:null,identityUnit:'decoded trade user account and transaction fee payer, not a person',coverage:{...context.counts,decodedTransactions:decoded,unresolvedTransactions:context.success.size-decoded,compiledFallbacks,truncatedTransactions:truncated,executionProvenInvocations:executionProven,foreignSwapLegs,nonSwapInvocations,sourceBytes:context.sourceBytes,storedBytes:context.storedBytes,sourceHash:sha(JSON.stringify(context.sourceHashes)),receiptManifestHash,compiledNormalization:'CLOSED_NATIVE_PARSER_ABI_EQUIVALENCE_WITH_ALL_RAW_COMPILED_ACCOUNTS_RETAINED',gaps},pairedClocks:{cohortAndStrata:'CANONICAL_INDEX_BLOCK_TIME',programTime:'INDEPENDENT_NONNEGATIVE_INTEGER_AT_OR_BEFORE_SOURCE_RETRIEVAL',observations:pairedClocks,observationHash:pairedClockHash.digest('hex'),differenceWitnessesComplete:clockDifferenceCount<=64,differentFromIndex:clockDifferenceCount,maximumAbsoluteDifferenceSeconds:maximumClockDifference,differences:clockDifferences},limitations:['Only the complete declared pool/quote twelve-hour tape; other venues and users outside it are unobserved.','Funding means the transaction fee payer, never incoming capital, common ownership or coordination.','Program and index timestamps stay separate; program time never changes cohort membership or permutation strata.','Only count/side/user/runtime and fee-role proof is consumed. No monetary flow, FX, A30 threshold or entry authority.','Retrospective provider RPC receipts acquired later preserve their actual clocks; not evidence of availability at the historical event time.']};
 const ids=[...new Set(evidenceIds)];if(decoded!==context.success.size||legCount===0)return{id:'O23',quality:'MISSING',unit:'fraction-vector',evidenceIds:ids,reasonCode:decoded!==context.success.size?'SYNCHRONY_BULK_TAPE_UNRESOLVED':'SYNCHRONY_DENOMINATOR_ZERO',data:{...scope,denominator:legCount===0&&decoded===context.success.size?0:null,fundingClasses:null,transactions:null,sponsors:null,seed:null,bins:SYNCHRONY_BINS.map(bin=>({...bin,synchronizedTrades:null,fraction:null,null:null}))}};
 const ordered=[...roles.values()].sort((a,b)=>context.success.get(a.signature)!.order-context.success.get(b.signature)!.order),statistics=computeSynchronyStatistics(ordered,receipts.pool,receipts.range.end,'sponsored-fee-payer-synchrony-v2');
 return{id:'O23',quality:'KNOWN',unit:'fraction-vector',evidenceIds:ids,reasonCode:'SPONSORED_SYNCHRONY_OBSERVED',data:{...scope,...statistics}};
}
