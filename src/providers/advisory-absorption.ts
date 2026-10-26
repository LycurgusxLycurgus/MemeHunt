/** A29 prospective same-slot absorption: one frozen top-5 cohort over one actual endpoint interval, every component recomputed from imported raw receipts.
 * Descriptive only. Any unresolved component leaves the whole vector null; missing or invalid sources never become zero. */
import {createHash} from 'node:crypto';
import {solveExitCapacity} from './advisory-exit-capacity.js';
import {executedWindowInstructions} from './advisory-window-accounts.js';
import {projectCompiledTransaction,demandTransactionRequest} from './advisory-demand-windows.js';
import {decodePumpSwapWindowTransaction,type DecodedTrade} from './advisory-trades.js';
import {decodeRawMintControls,SOLANA_MAINNET_GENESIS} from './solana.js';
import type {AdvisoryMetric} from '../domain/advisory-contracts.js';
import {a29DataSchema,A29_DATA_METHOD} from '../domain/advisory-contracts.js';
import {PUMP_AMM_SDK,PUMP_AMM_PROGRAM_ID,PUMP_FEE_PROGRAM_ID,GLOBAL_CONFIG_PDA,PUMP_AMM_FEE_CONFIG_PDA,pumpPoolAuthorityPda,poolPda,computeFeesBps,sellBaseInput} from '@pump-fun/pump-swap-sdk';
import {MintLayout,AccountLayout,getAssociatedTokenAddressSync,NATIVE_MINT,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID} from '@solana/spl-token';
import {PublicKey,type AccountInfo} from '@solana/web3.js';
import BN from 'bn.js';
import {Decimal} from 'decimal.js';

type Request={method:string;params:unknown[]};
type Pool=ReturnType<typeof PUMP_AMM_SDK.decodePool>;
type Step={ix:any;depth:number;top:number;executed:boolean};
type Window='warmup'|'baseline'|'measured';
type Row={signature:string;slot:number;blockTime:number|null;err:unknown};
export type Entry={mint:string;pool:string;program:string;baseVault:string;bankKeys:string[];endpoint0:Record<string,any>;cohort:Array<{owner:string;balanceAtomic:string}>};
type Interval={slot0:number;slot1:number;t0:string;t1:string;seconds:number};
export type A29Receipts={requests:Record<string,Request>;rawArtifacts:Record<string,string>;retrievedAt:Record<string,string>};
export type A29Capture={freeze:Record<string,any>;label:string;receipts:A29Receipts;maxClock:string;provenance:unknown};
export type A29Binding={account:string;owners:string[];ambiguous:boolean};
export type A29BoundTrade=A29Binding&{trade:DecodedTrade};

const FREEZE_KIND='A29_PROSPECTIVE_OBSERVATIONAL_SCOPE_V1',COHORT=5,IMPACT_BPS=300n,MEANINGFUL_QUOTE=10000000n,MIN_SECONDS=600;
// The frozen capture bounds; a capture recorded under other bounds is a different instrument.
const BOUNDS={tapeMaxPages:2,pageLimit:1000,maxSuccessfulTransactionsPerToken:480,maxTransactionResponseBytes:500000,maxEndpointPopulationResponseBytes:20000000,maxStoredNamespaceBytes:24000000};
const PUMP=PUMP_AMM_PROGRAM_ID.toBase58(),TOKEN_PROGRAMS=new Set([TOKEN_PROGRAM_ID.toBase58(),TOKEN_2022_PROGRAM_ID.toBase58()]);
const SIGNATURE=/^[1-9A-HJ-NP-Za-km-z]{43,88}$/,ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const D=Decimal.clone({precision:80,rounding:Decimal.ROUND_DOWN});
const LIMITATIONS=[
 'Descriptive same-interval vector only: no absorption boolean, causal or predictive claim.',
 'freezeSha256 is SHA-256 over recursively key-sorted canonical JSON of the parsed freeze; it is not the original pretty source-file hash.',
 'USER_IMPORT storage integrity only: no provider signature, TLS attestation or authenticated preregistration.',
 'Selling covers verified selected-pool trades from cohort-owned token accounts only; transfers are not sales and wallet- or person-wide selling is not asserted.',
 'Meaningful buyers are first observed within a fixed equal-duration lookback at 0.01 WSOL fee-exclusive core quote, never first-ever buyers, people or capital.',
 'Depth is fee-inclusive quoted exit proceeds at 300 bps impact from endpoint-bound state; network, setup costs and execution simulation are excluded.',
 'spotQuotePerBase is quote atomic units per base atomic unit including virtual quote reserves.',
 'Cohort owners and buyers are addresses, never people; the inventory residual is descriptive arithmetic, not a reconciliation gate.',
];

export class A29Gap extends Error{
 code:string;quality:'MISSING'|'TRUNCATED';
 constructor(code:string,quality:'MISSING'|'TRUNCATED'){super(code);this.code=code;this.quality=quality;}
}
// Receipt ids each derivation actually reads; a capture must contain exactly these and nothing else.
const consumed=new WeakMap<A29Receipts,Set<string>>();
const RECEIPT_ID=/^a29-(e[01]-(genesis|bank|population|clock)|page-[01]|transaction-(0|[1-9][0-9]{0,2}))$/;
function fail(code:string):never{throw new Error(code);}
function missing(code:string):never{throw new A29Gap(code,'MISSING');}
function truncated(code:string):never{throw new A29Gap(code,'TRUNCATED');}
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const iso=(seconds:number)=>new Date(seconds*1000).toISOString();
const atomic=(v:unknown,code:string):string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v)&&BigInt(v)<=18446744073709551615n?v:fail(code);
function address(v:unknown,code:string):string{if(typeof v==='string')try{if(new PublicKey(v).toBase58()===v)return v;}catch{}return fail(code);}
export function fmt(d:Decimal):string{const s=d.toFixed(30).replace(/0+$/,'').replace(/[.]$/,'');return s==='-0'?'0':s;}

/** Recursively key-sorted JSON; the freeze hash is defined over this form, not over the original file bytes. */
export function canonicalJson(value:unknown):string{
 if(Array.isArray(value))return `[${value.map(canonicalJson).join(',')}]`;
 if(object(value))return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 return fail('A29_CANONICAL_JSON');
}

function entryOf(freeze:unknown,label:string):Entry{
 if(!object(freeze)||freeze.kind!==FREEZE_KIND||!Array.isArray(freeze.tokens)||!object(freeze.measurement)||freeze.measurement.minimumIntervalSeconds!==MIN_SECONDS||!object(freeze.bounds))fail('A29_FREEZE_SHAPE');
 for(const [name,value] of Object.entries(BOUNDS))if(freeze.bounds[name]!==value)fail('A29_FREEZE_BOUNDS');
 const matches=freeze.tokens.filter((t:unknown)=>object(t)&&t.label===label);
 if(matches.length!==1)fail('A29_FREEZE_LABEL');
 const t=matches[0],z=t.endpoint0;
 const mint=address(t.mint,'A29_FREEZE_ROUTE'),pool=address(t.pool,'A29_FREEZE_ROUTE'),program=address(t.program,'A29_FREEZE_ROUTE'),baseVault=address(t.baseVault,'A29_FREEZE_ROUTE');
 if(!TOKEN_PROGRAMS.has(program))fail('A29_FREEZE_PROGRAM');
 // Generic canonical route: derived from the mint, never from private constants.
 const m=new PublicKey(mint),pk=poolPda(0,pumpPoolAuthorityPda(m),m,NATIVE_MINT),quoteVault=getAssociatedTokenAddressSync(NATIVE_MINT,pk,true,TOKEN_PROGRAM_ID).toBase58();
 if(pk.toBase58()!==pool||getAssociatedTokenAddressSync(m,pk,true,new PublicKey(program)).toBase58()!==baseVault)fail('A29_FREEZE_ROUTE');
 const bankKeys=[GLOBAL_CONFIG_PDA.toBase58(),PUMP_AMM_FEE_CONFIG_PDA.toBase58(),NATIVE_MINT.toBase58(),pool,mint,baseVault,quoteVault];
 if(canonicalJson(t.bankKeys)!==canonicalJson(bankKeys))fail('A29_FREEZE_BANK_KEYS');
 if(!object(z)||!integer(z.attempt)||z.attempt<1||z.attempt>3||!integer(z.bankSlot)||!integer(z.populationSlot)||z.exactSameSlot!==true||z.populationComplete!==true||z.supplyReconciled!==true||!integer(z.accounts)||typeof z.chainTime!=='string'||!Number.isFinite(Date.parse(z.chainTime)))fail('A29_FREEZE_ENDPOINT0');
 atomic(z.supplyAtomic,'A29_FREEZE_ENDPOINT0');atomic(z.totalAtomic,'A29_FREEZE_ENDPOINT0');
 if(!Array.isArray(t.cohort)||t.cohort.length!==COHORT)fail('A29_FREEZE_COHORT');
 const cohort=t.cohort.map((c:unknown)=>object(c)?{owner:address(c.owner,'A29_FREEZE_COHORT'),balanceAtomic:atomic(c.balanceAtomic,'A29_FREEZE_COHORT')}:fail('A29_FREEZE_COHORT'));
 if(new Set(cohort.map((c:{owner:string})=>c.owner)).size!==COHORT)fail('A29_FREEZE_COHORT');
 return{mint,pool,program,baseVault,bankKeys,endpoint0:z,cohort};
}

// Optional source records bind each raw response string by SHA-256 and byte length. This is storage integrity, not provider authenticity.
// requestSha256 hashes original request file bytes that the packet does not carry, so it is not recomputed; method and params are bound by the capture archive.
function bindRecords(records:unknown,receipts:A29Receipts,ids:string[]){
 if(!Array.isArray(records))fail('A29_CAPTURE_RECORD');
 const keys=records.map((r:unknown)=>object(r)&&typeof r.key==='string'?r.key:fail('A29_CAPTURE_RECORD'));
 if(new Set(keys).size!==keys.length||canonicalJson([...keys].sort())!==canonicalJson(ids))fail('A29_CAPTURE_RECORD');
 for(const r of records as Array<Record<string,any>>){
  const body=receipts.rawArtifacts[r.key]!,start=Date.parse(r.startedAt),done=Date.parse(r.completedAt);
  if(typeof r.startedAt!=='string'||typeof r.completedAt!=='string'||!Number.isFinite(start)||!Number.isFinite(done)||start>done||done!==Date.parse(receipts.retrievedAt[r.key]!)||r.httpStatus!==200)fail('A29_CAPTURE_RECORD');
  if(r.sourceSha256!==createHash('sha256').update(body,'utf8').digest('hex')||r.sourceBytes!==Buffer.byteLength(body,'utf8'))fail('A29_CAPTURE_RECORD');
 }
}

/** Parses one imported A29 packet. Original raw response strings are kept unchanged for the provider to verify. */
export function decodeA29Capture(raw:string):A29Capture{
 if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>BOUNDS.maxStoredNamespaceBytes)fail('A29_CAPTURE_SIZE');
 let packet:any;
 try{packet=JSON.parse(raw);}catch{fail('A29_CAPTURE_JSON');}
 // The outer packet carries sources only; no metric cache or other derived field is admitted.
 if(object(packet)&&Object.keys(packet).sort().join()!=='freeze,label,method,provenance,rawArtifacts,requests,retrievedAt,token')fail('A29_CAPTURE_SHAPE');
 if(!object(packet)||packet.method!=='a29-retained-sources-v1'||!object(packet.freeze)||packet.freeze.kind!==FREEZE_KIND||typeof packet.label!=='string'||!packet.label||!object(packet.requests)||!object(packet.rawArtifacts)||!object(packet.retrievedAt)||!object(packet.provenance)||packet.provenance.accessMode!=='USER_IMPORT')fail('A29_CAPTURE_SHAPE');
 const entry=entryOf(packet.freeze,packet.label);
 if(!object(packet.token)||packet.token.chain!=='solana'||packet.token.address!==entry.mint)fail('A29_CAPTURE_TOKEN');
 const ids=Object.keys(packet.requests).sort(),same=(o:Record<string,unknown>)=>canonicalJson(Object.keys(o).sort())===canonicalJson(ids);
 if(!ids.length||!same(packet.rawArtifacts)||!same(packet.retrievedAt))fail('A29_CAPTURE_KEYS');
 const receipts:A29Receipts={requests:{},rawArtifacts:{},retrievedAt:{}};let latest=-Infinity;
 for(const id of ids){
  const request=packet.requests[id],body=packet.rawArtifacts[id],at=packet.retrievedAt[id];
  if(!/^a29-[a-z0-9-]+$/.test(id)||!object(request)||typeof request.method!=='string'||!Array.isArray(request.params)||typeof body!=='string'||typeof at!=='string'||!Number.isFinite(Date.parse(at)))fail('A29_CAPTURE_RECEIPT');
  receipts.requests[id]=request as Request;receipts.rawArtifacts[id]=body;receipts.retrievedAt[id]=at;latest=Math.max(latest,Date.parse(at));
 }
 if(Object.hasOwn(packet.provenance,'records'))bindRecords(packet.provenance.records,receipts,ids);
 return{freeze:packet.freeze,label:packet.label,receipts,maxClock:new Date(latest).toISOString(),provenance:packet.provenance};
}

// Request identity is structural: key order is irrelevant, every value must match.
function read(id:string,expected:Request,receipts:A29Receipts,cutoff:string,maxBytes=Infinity){
 if(!Object.hasOwn(receipts.requests,id))missing('A29_RECEIPT_ABSENT');
 consumed.get(receipts)?.add(id);
 if(canonicalJson(receipts.requests[id])!==canonicalJson(expected))fail('A29_REQUEST_MISMATCH');
 const body=receipts.rawArtifacts[id],retrieved=receipts.retrievedAt[id],at=Date.parse(retrieved??'');
 if(typeof body!=='string'||typeof retrieved!=='string'||!Number.isFinite(at))fail('A29_RECEIPT_SHAPE');
 if(at>Date.parse(cutoff))missing('A29_RECEIPT_AFTER_CUTOFF');
 if(Buffer.byteLength(body,'utf8')>maxBytes)truncated('A29_RECEIPT_BYTES');
 let response:any;
 try{response=JSON.parse(body);}catch{fail('A29_RECEIPT_JSON');}
 if(!object(response)||response.jsonrpc!=='2.0'||response.id!==1)fail('A29_RECEIPT_SHAPE');
 if(response.error!==undefined&&response.error!==null)missing('A29_RPC_ERROR');
 if(!Object.hasOwn(response,'result'))fail('A29_RECEIPT_SHAPE');
 return{value:response.result as any,at,retrieved};
}
// The recorded minContextSlot floor is accepted as captured; the response context must reach it.
function floor(receipts:A29Receipts,id:string):number{
 if(!Object.hasOwn(receipts.requests,id))missing('A29_RECEIPT_ABSENT');
 const options=receipts.requests[id]!.params?.[1];
 return object(options)&&integer(options.minContextSlot)?options.minContextSlot:fail('A29_REQUEST_FLOOR');
}
export function info(v:unknown):AccountInfo<Buffer>{
 if(!object(v)||!Array.isArray(v.data)||v.data.length!==2||v.data[1]!=='base64'||typeof v.data[0]!=='string'||typeof v.executable!=='boolean'||!integer(v.lamports))fail('A29_ACCOUNT_SHAPE');
 return{owner:new PublicKey(address(v.owner,'A29_ACCOUNT_SHAPE')),data:Buffer.from(v.data[0],'base64'),executable:v.executable,lamports:v.lamports};
}

// Same validation and model as the accepted A12 exit-capacity call site.
function bankState(value:any,e:Entry){
 if(!object(value)||!object(value.context)||!integer(value.context.slot)||!Array.isArray(value.value)||value.value.length!==e.bankKeys.length)fail('A29_BANK_SHAPE');
 if(value.value.some((v:unknown)=>v===null))missing('A29_BANK_ACCOUNT_ABSENT');
 const a=(value.value as unknown[]).map(info),g=a[0]!,f=a[1]!,qm=a[2]!,pa=a[3]!,ma=a[4]!,bv=a[5]!,qv=a[6]!;
 const slot=value.context.slot as number,mint=new PublicKey(e.mint),pk=new PublicKey(e.pool);
 try{
  if(!g.owner.equals(PUMP_AMM_PROGRAM_ID)||!f.owner.equals(PUMP_FEE_PROGRAM_ID)||!qm.owner.equals(TOKEN_PROGRAM_ID)||qm.data.length!==82)fail('A29_BANK_CONFIG');
  const globalConfig=PUMP_AMM_SDK.decodeGlobalConfig(g),feeConfig=PUMP_AMM_SDK.decodeFeeConfig(f),quoteMint=MintLayout.decode(qm.data);
  if(!quoteMint.isInitialized||quoteMint.decimals!==9)fail('A29_BANK_QUOTE_MINT');
  if(!pa.owner.equals(PUMP_AMM_PROGRAM_ID)||ma.owner.toBase58()!==e.program)fail('A29_BANK_ROUTE');
  const p=PUMP_AMM_SDK.decodePool(pa),m=MintLayout.decode(ma.data),control=decodeRawMintControls({context:{slot},value:{owner:ma.owner.toBase58(),data:[ma.data.toString('base64'),'base64']}});
  if(p.index!==0||!p.creator.equals(pumpPoolAuthorityPda(mint))||!p.baseMint.equals(mint)||!p.quoteMint.equals(NATIVE_MINT)||p.isMayhemMode||p.virtualQuoteReserves.isNeg()||globalConfig.disableFlags&16||!m.isInitialized||!control.complete||!control.transferAllowed||control.currentFeeBps!=='0'||!control.feeImmutable)fail('A29_BANK_ROUTE');
  if(p.poolBaseTokenAccount.toBase58()!==e.baseVault||!p.poolQuoteTokenAccount.equals(getAssociatedTokenAddressSync(NATIVE_MINT,pk,true,TOKEN_PROGRAM_ID)))fail('A29_BANK_ROUTE');
  const vault=(x:AccountInfo<Buffer>,owner:PublicKey,vaultMint:PublicKey)=>{if(!x.owner.equals(owner)||x.data.length<165)fail('A29_BANK_VAULT');const v=AccountLayout.decode(x.data);if(!v.mint.equals(vaultMint)||!v.owner.equals(pk)||v.state!==1||v.delegateOption||v.closeAuthorityOption)fail('A29_BANK_VAULT');return v.amount;};
  const B=vault(bv,ma.owner,mint),P=vault(qv,TOKEN_PROGRAM_ID,NATIVE_MINT);
  if(B<=0n||m.supply<B)fail('A29_BANK_SUPPLY');
  const args={baseReserve:new BN(String(B)),quoteReserve:new BN(String(P)),virtualQuoteReserves:p.virtualQuoteReserves,globalConfig,baseMintAccount:m,baseMint:mint,coinCreator:p.coinCreator,creator:p.creator,feeConfig,quoteMint:NATIVE_MINT,isMayhemMode:p.isMayhemMode,creatorFeeBps:p.creatorFeeBps,slippage:0};
  const rates=computeFeesBps({...args,baseMintSupply:new BN(String(m.supply)),quoteReserve:args.quoteReserve.add(p.virtualQuoteReserves)}),V=BigInt(p.virtualQuoteReserves.toString());
  const boundary=solveExitCapacity({base:B,physicalQuote:P,virtualQuote:V,sellDomain:m.supply-B,fees:[BigInt(rates.lpFeeBps.toString()),BigInt(rates.protocolFeeBps.toString()),p.coinCreator.equals(PublicKey.default)?0n:BigInt(rates.creatorFeeBps.toString())],impactBps:IMPACT_BPS});
  if(boundary.status!=='KNOWN')truncated('A29_DEPTH_INTERVAL_CAP');
  if(BigInt(boundary.inputAtomic!)>0n&&sellBaseInput({...args,base:new BN(boundary.inputAtomic!)}).uiQuote.toString()!==boundary.quoteAtomic)fail('A29_DEPTH_CROSSCHECK');
  return{slot,B,P,supply:m.supply,decimals:m.decimals,pool:p as Pool,spot:new D(String(P+V)).div(String(B)),depth:{inputAtomic:boundary.inputAtomic!,quoteAtomic:boundary.quoteAtomic!}};
 }catch(error){
  if(error instanceof A29Gap)throw error;
  throw new Error(error instanceof Error&&/^A29_[A-Z0-9_]+$/.test(error.message)?error.message:'A29_BANK_INVALID');
 }
}

export function populationState(value:any,e:Entry){
 if(!object(value)||!object(value.context)||!integer(value.context.slot)||!Array.isArray(value.value))fail('A29_POPULATION_SHAPE');
 const mint=new PublicKey(e.mint),raw=new Map<string,bigint>(),adjusted=new Map<string,bigint>(),seen=new Set<string>();let total=0n,vault:bigint|null=null;
 const add=(owners:Map<string,bigint>,owner:string,amount:bigint)=>owners.set(owner,(owners.get(owner)??0n)+amount);
 for(const row of value.value as unknown[]){
  if(!object(row))fail('A29_POPULATION_ROW');
  const pubkey=address(row.pubkey,'A29_POPULATION_ROW'),a=info(row.account),d=a.data;
  if(seen.has(pubkey))fail('A29_POPULATION_ROW');seen.add(pubkey);
  if(a.owner.toBase58()!==e.program||d.length<165||d.length>165&&d[165]!==2||!mint.equals(new PublicKey(d.subarray(0,32))))fail('A29_POPULATION_ACCOUNT');
  if(d[108]!==1&&d[108]!==2)fail('A29_POPULATION_STATE');
  const owner=new PublicKey(d.subarray(32,64)).toBase58(),amount=d.readBigUInt64LE(64);
  total+=amount;
  // Raw keeps every account. The adjusted population drops only the selected pool base vault account, before aggregation.
  if(amount>0n)add(raw,owner,amount);
  if(pubkey===e.baseVault){vault=amount;continue;}
  if(amount>0n)add(adjusted,owner,amount);
 }
 return{slot:value.context.slot as number,accounts:seen.size,total,vault,raw,adjusted};
}

/** One endpoint: mainnet genesis, same-slot bank and population, supply and base-vault reconciliation, then the actual block time. */
function endpoint(prefix:string,e:Entry,receipts:A29Receipts,cutoff:string,minimumFloor:number|null,adopted:boolean){
 const id=(name:string)=>`${prefix}-${name}`,mismatch=(code:string):never=>adopted?fail(code):missing(code);
 const genesis=read(id('genesis'),{method:'getGenesisHash',params:[]},receipts,cutoff);
 if(genesis.value!==SOLANA_MAINNET_GENESIS)fail('A29_GENESIS');
 const bankFloor=floor(receipts,id('bank')),populationFloor=floor(receipts,id('population'));
 if(minimumFloor!==null&&(bankFloor<minimumFloor||populationFloor<minimumFloor))fail('A29_REQUEST_FLOOR');
 const bank=read(id('bank'),{method:'getMultipleAccounts',params:[e.bankKeys,{encoding:'base64',commitment:'finalized',minContextSlot:bankFloor}]},receipts,cutoff);
 const population=read(id('population'),{method:'getProgramAccounts',params:[e.program,{encoding:'base64',commitment:'finalized',minContextSlot:populationFloor,withContext:true,filters:[{memcmp:{offset:0,bytes:e.mint}}]}]},receipts,cutoff,BOUNDS.maxEndpointPopulationResponseBytes);
 const state=bankState(bank.value,e),people=populationState(population.value,e);
 if(state.slot<bankFloor||people.slot<populationFloor)fail('A29_CONTEXT_FLOOR');
 if(state.slot!==people.slot)mismatch('A29_ENDPOINT_SLOT_MISMATCH');
 if(people.total!==state.supply)mismatch('A29_SUPPLY_UNRECONCILED');
 if(people.vault!==state.B)mismatch('A29_BASE_VAULT_UNRECONCILED');
 const clock=read(id('clock'),{method:'getBlockTime',params:[state.slot]},receipts,cutoff);
 if(!integer(clock.value)||clock.value<=0)fail('A29_CLOCK');
 return{slot:state.slot,time:clock.value as number,state,people,retrieved:[genesis.at,bank.at,population.at,clock.at]};
}
export type Endpoint=ReturnType<typeof endpoint>;

export const rank=(owners:Map<string,bigint>)=>[...owners].sort((a,b)=>a[1]!==b[1]?(a[1]>b[1]?-1:1):a[0]<b[0]?-1:a[0]>b[0]?1:0);
function shares(ranked:Array<[string,bigint]>,denominator:bigint){
 if(denominator<=0n)missing('A29_CONCENTRATION_DENOMINATOR');
 const top=(n:number)=>fmt(new D(String(ranked.slice(0,n).reduce((s,x)=>s+x[1],0n))).div(String(denominator)));
 return{top1:top(1),top5:top(5),top10:top(10)};
}
export function endpointData(x:Endpoint,attempt:number,cohortAtomic:bigint){
 return{slot:x.slot,chainTime:iso(x.time),attempt,supplyAtomic:String(x.state.supply),baseVaultAtomic:String(x.state.B),cohortAtomic:String(cohortAtomic),spotQuotePerBase:fmt(x.state.spot),depth:x.state.depth,
  concentration:{supply:shares(rank(x.people.raw),x.state.supply),vaultAdjusted:shares(rank(x.people.adjusted),x.state.supply-x.state.B)}};
}

/** Selected-pool tape back to t0-2L only: warmup is the prior exclusion for baseline, and baseline is the prior exclusion for measured. Coverage is proved by an exhausted page or an older row. */
function tape(e:Entry,slot0:number,slot1:number,t0:number,L:number,receipts:A29Receipts,cutoff:string,after:number){
 const rows:Row[]=[],seen=new Set<string>(),lower=t0-2*L;let before:string|undefined,lastSlot=Infinity,lastTime=Infinity,lastAt=-Infinity,covered=false,firstAt=Infinity;
 for(let i=0;i<BOUNDS.tapeMaxPages&&!covered;i++){
  const page=read(`a29-page-${i}`,{method:'getSignaturesForAddress',params:[e.pool,{commitment:'finalized',limit:BOUNDS.pageLimit,minContextSlot:slot1,...(before?{before}:{})}]},receipts,cutoff);
  // Each page follows endpoint1 and every earlier page.
  if(page.at<after||page.at<lastAt)fail('A29_PAGE_TIME');
  firstAt=Math.min(firstAt,page.at);lastAt=page.at;
  if(!Array.isArray(page.value)||page.value.length>BOUNDS.pageLimit)fail('A29_PAGE_SHAPE');
  for(const r of page.value as unknown[]){
   if(!object(r)||typeof r.signature!=='string'||!SIGNATURE.test(r.signature)||!integer(r.slot)||!(r.blockTime===null||integer(r.blockTime))||!Object.hasOwn(r,'err')||!(r.err===null||typeof r.err==='object'||typeof r.err==='string'))fail('A29_PAGE_ROW');
   // Slots and every known block time descend, so an older row can never precede a later in-window row.
   if(seen.has(r.signature)||r.slot>lastSlot||r.blockTime!==null&&r.blockTime>lastTime)fail('A29_PAGE_ORDER');
   seen.add(r.signature);lastSlot=r.slot;if(r.blockTime!==null)lastTime=r.blockTime;rows.push({signature:r.signature,slot:r.slot,blockTime:r.blockTime,err:r.err});
  }
  covered=page.value.length<BOUNDS.pageLimit||page.value.some((r:any)=>r.slot<=slot0&&r.blockTime!==null&&r.blockTime<lower);
  before=page.value.at(-1)?.signature;
 }
 if(!covered)truncated('A29_TAPE_PAGE_CAP');
 // Slot endpoints govern ties: (slot0,slot1] is measured whatever its block time.
 const selected:Array<{row:Row;window:Window}>=[];
 for(const row of rows){
  if(row.slot>slot1)continue;
  if(row.slot<=slot0&&row.blockTime!==null&&row.blockTime<lower)break;
  if(row.err!==null)continue;
  if(row.blockTime===null)truncated('A29_TAPE_NULL_CLOCK');
  const t=row.blockTime as number;
  selected.push({row,window:row.slot>slot0?'measured':t>=t0-L?'baseline':'warmup'});
  if(selected.length>BOUNDS.maxSuccessfulTransactionsPerToken)truncated('A29_TAPE_TRANSACTION_CAP');
 }
 return{selected,firstAt};
}

/** The pinned strict full-log decoder on the compiled JSON projection; no recovery modes. */
export function decodeA29Trades(result:unknown,expected:{signature:string;slot:number;at:string},poolKey:string,pool:Pool,stateSlot:number,retrieved:string){
 const projected=projectCompiledTransaction(result);
 if(projected.transaction.signatures[0]!==expected.signature)fail('A29_TRANSACTION_SIGNATURE');
 const proof=decodePumpSwapWindowTransaction(projected,expected,poolKey,pool,stateSlot,retrieved,true,true,false,true,false,false,undefined,false,9);
 for(const t of proof.trades)if(t.signature!==expected.signature||t.slot!==expected.slot||!t.quoteAccounting||t.quoteAccounting.coreQuoteAtomic!==t.quoteAtomic)fail('A29_TRADE_CORE_QUOTE');
 return{projected,proof};
}
export function decodeA29BoundTrades(result:unknown,expected:{signature:string;slot:number;at:string},poolKey:string,pool:Pool,stateSlot:number,retrieved:string):A29BoundTrade[]{
 const {projected,proof}=decodeA29Trades(result,expected,poolKey,pool,stateSlot,retrieved),mint=pool.baseMint.toBase58(),vault=pool.poolBaseTokenAccount.toBase58();
 return proof.trades.map(trade=>({trade,...bindA29TradeAccount(projected,trade,mint,vault)}));
}

// A meaningful buyer is a signing wallet: CPI-authorized accounts and invoked programs are excluded.
export function eligibleBuyer(projected:any,cpiAuthorized:string[],user:string){
 const programs=new Set<string>([...projected.transaction.message.instructions,...projected.meta.innerInstructions.flatMap((g:any)=>g.instructions)].map((ix:any)=>ix.programId));
 return projected.transaction.message.accountKeys.some((k:any)=>k.pubkey===user&&k.signer)&&!cpiAuthorized.includes(user)&&!programs.has(user);
}

function decode58(text:unknown):Uint8Array{
 if(typeof text!=='string'||text.length>2048)fail('A29_TOKEN_INSTRUCTION');
 const bytes:number[]=[];
 for(const c of text){const v=ALPHABET.indexOf(c);if(v<0)fail('A29_TOKEN_INSTRUCTION');let carry=v;for(let i=0;i<bytes.length;i++){carry+=bytes[i]!*58;bytes[i]=carry&255;carry>>=8;}while(carry){bytes.push(carry&255);carry>>=8;}}
 for(const c of text){if(c!=='1')break;bytes.push(0);}
 return Uint8Array.from(bytes.reverse());
}
const u64=(d:Uint8Array,offset:number)=>Buffer.from(d.buffer,d.byteOffset,d.byteLength).readBigUInt64LE(offset);
const pubkeyAt=(d:Uint8Array,offset:number)=>d.length>=offset+32?new PublicKey(d.subarray(offset,offset+32)).toBase58():fail('A29_TOKEN_INSTRUCTION');
// Raw Transfer and TransferChecked only; this locates the owner leg and never classifies or prices a trade.
function legOf(ix:any){
 const a=ix.accounts,d=decode58(ix.data);
 if(!Array.isArray(a)||a.some((k:unknown)=>typeof k!=='string'))fail('A29_TOKEN_INSTRUCTION');
 if(d[0]===3&&d.length===9&&a.length>=3)return{source:a[0] as string,destination:a[1] as string,amount:u64(d,1),mint:null as string|null};
 if(d[0]===12&&d.length===10&&a.length>=4)return{source:a[0] as string,destination:a[2] as string,amount:u64(d,1),mint:a[1] as string};
 return null;
}

/** Binds a decoded trade to the token account on its exact executed base leg, then resolves that account owner.
 * The trade user is never taken as owner. Owner changes, close and reinit, or missing balances stay ambiguous. */
export function bindA29TradeAccount(projected:any,trade:Pick<DecodedTrade,'side'|'baseAtomic'|'instructionIndex'>,baseMint:string,baseVault:string):A29Binding{
 const list=executedWindowInstructions(projected) as Step[];
 // instructionIndex counts every PumpSwap invocation, including event CPIs and failed attempts; map that ordinal back to its runtime position.
 const pumps=list.flatMap((s,position)=>s.ix.programId===PUMP?[position]:[]),at=integer(trade.instructionIndex)?pumps[trade.instructionIndex]:undefined,step=at===undefined?undefined:list[at];
 if(at===undefined||!step||!step.executed)fail('A29_TRADE_STEP');
 const legs:Array<NonNullable<ReturnType<typeof legOf>>>=[];
 for(let q=at+1;q<list.length&&list[q]!.top===step.top&&list[q]!.depth>step.depth;q++){
  const s=list[q]!;
  // Caught failed CPIs are rolled back; meta.err null alone does not prove a leg.
  if(!s.executed||!TOKEN_PROGRAMS.has(s.ix.programId)||!Array.isArray(s.ix.accounts)||!s.ix.accounts.includes(baseVault))continue;
  const leg=legOf(s.ix);
  if(!leg||leg.source!==baseVault&&leg.destination!==baseVault)fail('A29_TRADE_VAULT_UNRECOGNIZED');
  if(leg.mint!==null&&leg.mint!==baseMint)fail('A29_TRADE_LEG_MINT');
  legs.push(leg);
 }
 if(legs.length!==1)fail('A29_TRADE_LEG');
 const leg=legs[0]!;
 if(leg.amount!==BigInt(trade.baseAtomic))fail('A29_TRADE_LEG_AMOUNT');
 const account=trade.side==='SELL'&&leg.destination===baseVault&&leg.source!==baseVault?leg.source:trade.side==='BUY'&&leg.source===baseVault&&leg.destination!==baseVault?leg.destination:fail('A29_TRADE_LEG_DIRECTION');
 const keys=projected.transaction.message.accountKeys.map((k:any)=>k.pubkey),index=keys.indexOf(account);
 if(index<0)fail('A29_TRADE_ACCOUNT');
 const balance=(rows:unknown):string|null|undefined=>{
  if(!Array.isArray(rows))fail('A29_TOKEN_BALANCES');
  const hits=rows.filter((r:unknown)=>object(r)&&r.accountIndex===index);
  if(hits.length>1)fail('A29_TOKEN_BALANCES');
  const r=hits[0];if(!r)return undefined;
  if(r.mint!==baseMint)fail('A29_TOKEN_BALANCE_MINT');
  // A present owner must be a canonical address; an invalid string is never read as a known non-cohort owner.
  return typeof r.owner==='string'?address(r.owner,'A29_TOKEN_BALANCE_OWNER'):null;
 };
 const pre=balance(projected.meta.preTokenBalances),post=balance(projected.meta.postTokenBalances),owners=new Set<string>();
 // Without a pre-owner the account may have been created or reassigned in this transaction, so its owner stays ambiguous.
 let ambiguous=pre===null||post===null||pre===undefined||typeof pre==='string'&&typeof post==='string'&&pre!==post,closed=false,initialized=false;
 if(pre)owners.add(pre);if(post)owners.add(post);
 for(const s of list){
  if(!s.executed||!TOKEN_PROGRAMS.has(s.ix.programId)||!Array.isArray(s.ix.accounts)||s.ix.accounts[0]!==account)continue;
  const d=decode58(s.ix.data);
  if(d[0]===6){if(d.length<3)fail('A29_TOKEN_INSTRUCTION');if(d[1]===2){ambiguous=true;if(d[2]===1)owners.add(pubkeyAt(d,3));}}
  else if(d[0]===9)closed=true;
  else if(d[0]===1){initialized=true;if(typeof s.ix.accounts[2]==='string')owners.add(s.ix.accounts[2]);}
  else if(d[0]===16||d[0]===18){initialized=true;owners.add(pubkeyAt(d,1));}
 }
 if(closed&&initialized||owners.size!==1)ambiguous=true;
 return{account,owners:[...owners].sort(),ambiguous};
}

function measure(e:Entry,scope:Record<string,any>,receipts:A29Receipts,cutoff:string,onInterval:(value:Interval)=>void){
 const z=e.endpoint0,e0=endpoint('a29-e0',e,receipts,cutoff,null,true);
 if(e0.slot!==z.bankSlot||e0.people.slot!==z.populationSlot||String(e0.state.supply)!==z.supplyAtomic||String(e0.people.total)!==z.totalAtomic||e0.people.accounts!==z.accounts||e0.time*1000!==Date.parse(z.chainTime))fail('A29_FREEZE_ENDPOINT0_MISMATCH');
 // The frozen cohort must equal the recomputed endpoint0 top five; it is never re-pinned.
 const top=rank(e0.people.adjusted).slice(0,COHORT);
 if(top.length!==COHORT||top.some(([owner,amount],i)=>owner!==e.cohort[i]!.owner||String(amount)!==e.cohort[i]!.balanceAtomic))fail('A29_FREEZE_COHORT_MISMATCH');
 const frozenAt=Date.parse(scope.frozenAt),revisions=scope.evidenceBasedRevisions??[];
 if(!Array.isArray(revisions)||!Number.isFinite(frozenAt)||frozenAt<Math.max(...e0.retrieved))fail('A29_FREEZE_TIMING');
 const revisedAt=revisions.map((r:unknown)=>object(r)&&typeof r.at==='string'?Date.parse(r.at):NaN);
 if(revisedAt.some((t:number)=>!Number.isFinite(t)||t<frozenAt))fail('A29_FREEZE_TIMING');
 const e1=endpoint('a29-e1',e,receipts,cutoff,e0.slot,false);
 // The freeze and every revision precede endpoint1, hence any interval flow or outcome.
 if(Math.max(frozenAt,...revisedAt)>=Math.min(...e1.retrieved))fail('A29_FREEZE_TIMING');
 if(e1.slot<=e0.slot||e1.state.decimals!==e0.state.decimals)fail('A29_ENDPOINT_ORDER');
 const t0=e0.time,t1=e1.time,L=t1-t0;
 if(L<MIN_SECONDS)missing('A29_INTERVAL_SHORT');
 onInterval({slot0:e0.slot,slot1:e1.slot,t0:iso(t0),t1:iso(t1),seconds:L});
 const {selected,firstAt}=tape(e,e0.slot,e1.slot,t0,L,receipts,cutoff,Math.max(...e1.retrieved));
 const sets:Record<Window,Set<string>>={warmup:new Set(),baseline:new Set(),measured:new Set()};
 const cohort=new Set(e.cohort.map(c=>c.owner)),flow={trades:0,sellBase:0n,sellQuote:0n,buyBase:0n,buyQuote:0n};
 selected.forEach(({row,window},n)=>{
  const tx=read(`a29-transaction-${n}`,demandTransactionRequest(row.signature),receipts,cutoff,BOUNDS.maxTransactionResponseBytes),v=tx.value;
  if(tx.at<firstAt)fail('A29_TRANSACTION_TIME');
  if(v===null)missing('A29_TRANSACTION_ABSENT');
  if(!object(v)||v.slot!==row.slot||v.blockTime!==row.blockTime||!object(v.meta)||v.meta.err!==null)fail('A29_TRANSACTION_MISMATCH');
  let decoded:ReturnType<typeof decodeA29Trades>;
  try{decoded=decodeA29Trades(v,{signature:row.signature,slot:row.slot,at:iso(row.blockTime as number)},e.pool,e1.state.pool,e1.slot,tx.retrieved);}
  catch(error){if(error instanceof Error&&error.message==='A29_TRANSACTION_SIGNATURE')throw error;missing('A29_TRADE_UNSUPPORTED');}
  for(const trade of decoded.proof.trades){
   if(trade.side==='BUY'&&BigInt(trade.quoteAtomic)>=MEANINGFUL_QUOTE&&eligibleBuyer(decoded.projected,decoded.proof.cpiAuthorizedAccounts,trade.user))sets[window].add(trade.user);
   if(window!=='measured')continue;
   let bound:A29Binding;
   try{bound=bindA29TradeAccount(decoded.projected,trade,e.mint,e.baseVault);}catch{missing('A29_OWNER_BINDING_UNSUPPORTED');}
   const hits=bound.owners.filter(o=>cohort.has(o));
   // An ambiguous owner may have moved into the cohort between endpoints, so any measured ambiguity withholds the vector.
   if(bound.ambiguous)missing('A29_OWNER_AMBIGUOUS');
   if(!hits.length)continue;
   flow.trades++;
   if(trade.side==='SELL'){flow.sellBase+=BigInt(trade.baseAtomic);flow.sellQuote+=BigInt(trade.quoteAtomic);}
   else{flow.buyBase+=BigInt(trade.baseAtomic);flow.buyQuote+=BigInt(trade.quoteAtomic);}
  }
 });
 // Baseline excludes warmup buyers and measured excludes baseline buyers; warmup only reports its own buyers.
 const fresh=(current:Window,prior:Window)=>[...sets[current]].filter(u=>!sets[prior].has(u)).length;
 const warmup=sets.warmup.size,baseline=fresh('baseline','warmup'),measured=fresh('measured','baseline');
 // Inventory counts every account a cohort owner holds, including the base vault only if that owner owns it.
 const held=(x:Endpoint)=>e.cohort.map(c=>x.people.raw.get(c.owner)??0n),sum=(h:bigint[])=>h.reduce((s,n)=>s+n,0n),h0=held(e0),h1=held(e1);
 const q0=BigInt(e0.state.depth.quoteAtomic),q1=BigInt(e1.state.depth.quoteAtomic),net=flow.sellBase-flow.buyBase,delta=sum(h1)-sum(h0);
 const d0=endpointData(e0,z.attempt,sum(h0)),d1=endpointData(e1,1,sum(h1));
 // Signed e1 minus e0 share difference in default Decimal arithmetic, exactly as the data contract recomputes it.
 const signed=(a:string,b:string)=>{const s=new Decimal(a).minus(b).toFixed();return s==='-0'?'0':s;};
 const change=(k:'supply'|'vaultAdjusted')=>({top1:signed(d1.concentration[k].top1,d0.concentration[k].top1),top5:signed(d1.concentration[k].top5,d0.concentration[k].top5),top10:signed(d1.concentration[k].top10,d0.concentration[k].top10)});
 return{
  units:{quoteMint:NATIVE_MINT.toBase58(),quoteDecimals:9,baseDecimals:e0.state.decimals},
  endpoints:{e0:d0,e1:d1},
  cohort:e.cohort.map((c,i)=>({owner:c.owner,e0Atomic:String(h0[i]),e1Atomic:String(h1[i])})),
  selling:{trades:flow.trades,sellBaseAtomic:String(flow.sellBase),sellQuoteAtomic:String(flow.sellQuote),buyBaseAtomic:String(flow.buyBase),buyQuoteAtomic:String(flow.buyQuote),netSellBaseAtomic:String(net)},
  priceChange:{fraction:e0.state.spot.isZero()?null:fmt(e1.state.spot.minus(e0.state.spot).div(e0.state.spot))},
  newBuyerGrowth:{warmup:{start:iso(t0-2*L),end:iso(t0-L),meaningfulBuyers:warmup},baseline:{start:iso(t0-L),end:iso(t0),meaningfulBuyers:baseline},measured:{start:iso(t0),end:iso(t1),meaningfulBuyers:measured},
   difference:measured-baseline,ratio:baseline?fmt(new D(measured).div(baseline)):null},
  depthChange:{quoteDeltaAtomic:String(q1-q0),ratio:q0===0n?null:fmt(new D(String(q1)).div(String(q0)))},
  concentrationChange:{supply:change('supply'),vaultAdjusted:change('vaultAdjusted')},
  inventory:{deltaAtomic:String(delta),residualAtomic:String(delta+net)},
 };
}

/** A29 metric: KNOWN only when all five components resolve; otherwise MISSING or TRUNCATED with a null vector. Malformed sources throw. */
export function deriveA29Absorption(freeze:unknown,label:string,receipts:A29Receipts,cutoff:string,evidenceIds:string[]):AdvisoryMetric{
 if(typeof cutoff!=='string'||!Number.isFinite(Date.parse(cutoff)))fail('A29_CUTOFF');
 const e=entryOf(freeze,label),scope=freeze as Record<string,any>;
 const frame={method:A29_DATA_METHOD,freezeKind:FREEZE_KIND,freezeSha256:createHash('sha256').update(canonicalJson(freeze)).digest('hex'),token:{chain:'solana',address:e.mint},label,
  provenance:{accessMode:'USER_IMPORT',source:'IMPORTED_PRIOR_PUBLIC_CAPTURE',freshLive:false},
  instrument:{cohortSize:COHORT,depthImpactBps:Number(IMPACT_BPS),meaningfulBuyerQuoteAtomic:String(MEANINGFUL_QUOTE),minimumIntervalSeconds:MIN_SECONDS},
  claim:'DESCRIPTIVE_SAME_INTERVAL_VECTOR',limitations:LIMITATIONS};
 let interval:Interval|null=null;
 const metric=(quality:'KNOWN'|'MISSING'|'TRUNCATED',reasonCode:string,vector:unknown):AdvisoryMetric=>{
  let data:unknown;
  try{data=a29DataSchema.parse({...frame,status:quality,interval,vector});}catch{fail('A29_DATA_CONTRACT');}
  return{id:'A29',quality,unit:'distribution-absorption-vector',data,evidenceIds:[...evidenceIds],reasonCode};
 };
 const ids=Object.keys(receipts.requests).sort(),sameKeys=(o:Record<string,unknown>)=>canonicalJson(Object.keys(o).sort())===canonicalJson(ids);
 if(!sameKeys(receipts.rawArtifacts)||!sameKeys(receipts.retrievedAt)||ids.some(id=>!RECEIPT_ID.test(id)||id.startsWith('a29-transaction-')&&Number(id.slice(16))>=BOUNDS.maxSuccessfulTransactionsPerToken))fail('A29_RECEIPT_KEYS');
 const used=new Set<string>();consumed.set(receipts,used);
 let vector:unknown;
 try{
  vector=measure(e,scope,receipts,cutoff,value=>{interval=value;});
  // Exactly the eight endpoint receipts, the linked pages and the selected successful transactions; nothing stale or aliased.
  if(ids.length!==used.size||ids.some(id=>!used.has(id)))fail('A29_RECEIPT_UNUSED');
 }
 catch(error){
  if(error instanceof A29Gap)return metric(error.quality,error.code,null);
  throw error instanceof Error&&/^A29_[A-Z0-9_]+$/.test(error.message)?error:new Error('A29_CAPTURE_INVALID');
 }
 return metric('KNOWN','A29_PROSPECTIVE_VECTOR_OBSERVED',vector);
}
