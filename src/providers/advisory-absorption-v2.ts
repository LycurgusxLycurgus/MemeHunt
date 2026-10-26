/** A29 v2: explicit WSOL/USDC/WBTC quote absorption over strict per-receipt DEFLATE archives. Separate from v1; v1 exports and native behavior stay unchanged.
 * Descriptive only. Any unresolved component leaves the whole vector null; missing or invalid sources never become zero. */
import {createHash} from 'node:crypto';
import {solveExitCapacity} from './advisory-exit-capacity.js';
import {quoteAdmission,validateVaultData} from './advisory-exit-capacity-custom.js';
import {demandTransactionRequest,unpackDemandReceipt} from './advisory-demand-windows.js';
import {decodeRawMintControls,SOLANA_MAINNET_GENESIS} from './solana.js';
import {decodeA29Whirlpool,a29FxThreshold} from './a29-fx-whirlpool.js';
import {decodeA29TradesV2,bindA29TradeAccountV2} from './advisory-absorption-v2-owner.js';
import {canonicalJson,fmt,rank,endpointData,eligibleBuyer,info,populationState,A29Gap,type Entry} from './advisory-absorption.js';
import type {AdvisoryMetric} from '../domain/advisory-contracts.js';
import {a29DataSchemaV2} from '../domain/advisory-contracts.js';
import {PUMP_AMM_SDK,PUMP_AMM_PROGRAM_ID,PUMP_FEE_PROGRAM_ID,GLOBAL_CONFIG_PDA,PUMP_AMM_FEE_CONFIG_PDA,pumpPoolAuthorityPda,poolPda,computeFeesBps,sellBaseInput} from '@pump-fun/pump-swap-sdk';
import {MintLayout,AccountLayout,getAssociatedTokenAddressSync,NATIVE_MINT,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID} from '@solana/spl-token';
import {PublicKey,type AccountInfo} from '@solana/web3.js';
import BN from 'bn.js';
import {Decimal} from 'decimal.js';

type Request={method:string;params:unknown[]};
type Pool=ReturnType<typeof PUMP_AMM_SDK.decodePool>;
type Window='warmup'|'baseline'|'measured';
type Row={signature:string;slot:number;blockTime:number|null;err:unknown};
type Interval={slot0:number;slot1:number;t0:string;t1:string;seconds:number};
type Fx={pool:string;sqrtPriceX64:string;bankSlot:number};
type EntryV2=Entry&{quoteMint:string;quoteDecimals:number;quoteVault:string;fxPool:string|null;threshold:bigint;fxSqrt:string|null;endpoint1Attempt:number};
export type A29V2Record={key:string;sourceBytes:number;sourceSha256:string;startedAt:string;completedAt:string;httpStatus:200;requestSha256?:string};
export type A29V2Receipts={requests:Record<string,Request>;rawArtifacts:Record<string,string>;retrievedAt:Record<string,string>;records:Record<string,A29V2Record>};
export type A29V2Capture={freeze:Record<string,any>;label:string;receipts:A29V2Receipts;maxClock:string;provenance:unknown};

export const A29_DATA_METHOD_V2='prospective-same-slot-absorption-v2';
export const A29_FREEZE_KIND_V2='A29_PROSPECTIVE_OBSERVATIONAL_SCOPE_V2';
export const A29_V2_BOUNDS=Object.freeze({tapeMaxPages:20,pageLimit:1000,maxSuccessfulTransactionsPerToken:10000,maxTransactionResponseBytes:500000,maxEndpointPopulationResponseBytes:20000000,maxPageResponseBytes:2000000,maxSmallResponseBytes:1000000,maxInflatedSourceBytes:320000000,maxPacketBytes:128000000,hardCaptureDeadlineSeconds:5400});
export const A29_V2_QUOTES:Readonly<Record<string,{symbol:'WSOL'|'USDC'|'WBTC';decimals:number;fxPool:string|null}>>=Object.freeze({
 So11111111111111111111111111111111111111112:{symbol:'WSOL',decimals:9,fxPool:null},
 EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:{symbol:'USDC',decimals:6,fxPool:'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE'},
 '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh':{symbol:'WBTC',decimals:8,fxPool:'B5EwJVDuAauzUEEdwvbuXzbFFgEYnUqqS37TUM1c4PQA'},
});

const COHORT=5,IMPACT_BPS=300n,NATIVE_MEANINGFUL=10000000n,MIN_SECONDS=600,B=A29_V2_BOUNDS;
const WSOL=NATIVE_MINT.toBase58(),TOKENKEG=TOKEN_PROGRAM_ID.toBase58(),TOKEN_PROGRAMS=new Set([TOKENKEG,TOKEN_2022_PROGRAM_ID.toBase58()]);
const SIGNATURE=/^[1-9A-HJ-NP-Za-km-z]{43,88}$/,HEX=/^[a-f0-9]{64}$/,SQRT=/^[1-9][0-9]{0,38}$/;
const RECEIPT_ID=/^a29-(e[01]-(genesis|bank|population|clock)|page-([0-9]|1[0-9])|transaction-(0|[1-9][0-9]{0,3}))$/;
const RECORD_KEYS=new Set(['key','sourceBytes','sourceSha256','startedAt','completedAt','httpStatus','requestSha256']);
const D=Decimal.clone({precision:80,rounding:Decimal.ROUND_DOWN});
const LIMITATIONS=[
 'Descriptive same-interval vector only: no absorption boolean, causal or predictive claim.',
 'USER_IMPORT storage integrity only: no provider signature, TLS attestation or authenticated preregistration; imported history, not fresh live data.',
 'Selling covers verified selected-pool trades from cohort-owned token accounts only; transfers are not sales and wallet- or person-wide selling is not asserted.',
 'Meaningful buyers use a fee-exclusive core-quote threshold: 0.01 WSOL natively, or for USDC/WBTC ceil(1e7*S^2/2^128) from the endpoint0 Orca Whirlpool marginal rate; this is not an execution price, peg or manipulation-proof oracle.',
 'Depth is fee-inclusive quoted exit proceeds in quote atomic units at 300 bps impact from endpoint-bound state; network, setup costs and execution simulation are excluded.',
 'Cohort owners and buyers are addresses, never people; the inventory residual is descriptive arithmetic, not a reconciliation gate.',
];
const consumed=new WeakMap<A29V2Receipts,Set<string>>();
function fail(code:string):never{throw new Error(code);}
function missing(code:string):never{throw new A29Gap(code,'MISSING');}
function truncated(code:string):never{throw new A29Gap(code,'TRUNCATED');}
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const instant=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const iso=(seconds:number)=>new Date(seconds*1000).toISOString();
const atomic=(v:unknown,code:string):string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v)&&BigInt(v)<=18446744073709551615n?v:fail(code);
function address(v:unknown,code:string):string{if(typeof v==='string')try{if(new PublicKey(v).toBase58()===v)return v;}catch{}return fail(code);}
const roleLimit=(id:string)=>id.endsWith('-population')?B.maxEndpointPopulationResponseBytes:id.startsWith('a29-page-')?B.maxPageResponseBytes:id.startsWith('a29-transaction-')?B.maxTransactionResponseBytes:B.maxSmallResponseBytes;

function entryV2(freeze:unknown,label:string):EntryV2{
 if(!object(freeze)||freeze.kind!==A29_FREEZE_KIND_V2||!Array.isArray(freeze.tokens)||!object(freeze.measurement)||freeze.measurement.minimumIntervalSeconds!==MIN_SECONDS||!object(freeze.bounds))fail('A29_V2_FREEZE_SHAPE');
 for(const [name,value] of Object.entries(B))if(freeze.bounds[name]!==value)fail('A29_V2_FREEZE_BOUNDS');
 const matches=freeze.tokens.filter((t:unknown)=>object(t)&&t.label===label);
 if(matches.length!==1)fail('A29_V2_FREEZE_LABEL');
 const t=matches[0],z=t.endpoint0,route=(v:unknown)=>address(v,'A29_V2_FREEZE_ROUTE');
 if(!integer(t.endpoint1Attempt)||t.endpoint1Attempt<1||t.endpoint1Attempt>3)fail('A29_V2_FREEZE_ENDPOINT1_ATTEMPT');
 const mint=route(t.mint),pool=route(t.pool),program=route(t.program),baseVault=route(t.baseVault),quoteMint=route(t.quoteMint),quoteVault=route(t.quoteVault);
 const q=Object.hasOwn(A29_V2_QUOTES,quoteMint)?A29_V2_QUOTES[quoteMint]!:fail('A29_V2_FREEZE_QUOTE');
 if(!TOKEN_PROGRAMS.has(program)||t.quoteProgram!==TOKENKEG||t.quoteDecimals!==q.decimals||t.fxPool!==q.fxPool)fail('A29_V2_FREEZE_QUOTE');
 // Canonical index-0 route and ATAs derived from the mints, never from private constants.
 const m=new PublicKey(mint),qm=new PublicKey(quoteMint),pk=poolPda(0,pumpPoolAuthorityPda(m),m,qm);
 if(pk.toBase58()!==pool||getAssociatedTokenAddressSync(m,pk,true,new PublicKey(program)).toBase58()!==baseVault||getAssociatedTokenAddressSync(qm,pk,true,TOKEN_PROGRAM_ID).toBase58()!==quoteVault)fail('A29_V2_FREEZE_ROUTE');
 const bankKeys=[GLOBAL_CONFIG_PDA.toBase58(),PUMP_AMM_FEE_CONFIG_PDA.toBase58(),quoteMint,pool,mint,baseVault,quoteVault,...(q.fxPool?[WSOL,q.fxPool]:[])];
 if(canonicalJson(t.bankKeys)!==canonicalJson(bankKeys))fail('A29_V2_FREEZE_BANK_KEYS');
 if(!object(z)||!integer(z.attempt)||z.attempt<1||z.attempt>3||!integer(z.bankSlot)||!integer(z.populationSlot)||z.exactSameSlot!==true||z.populationComplete!==true||z.supplyReconciled!==true||!integer(z.accounts)||!instant(z.chainTime))fail('A29_V2_FREEZE_ENDPOINT0');
 for(const k of ['supplyAtomic','totalAtomic','baseVaultAtomic','quoteVaultAtomic','meaningfulQuoteAtomic'])atomic(z[k],'A29_V2_FREEZE_ENDPOINT0');
 const fx=z.fx;
 if(q.fxPool?!object(fx)||fx.pool!==q.fxPool||typeof fx.sqrtPriceX64!=='string'||!SQRT.test(fx.sqrtPriceX64)||fx.bankSlot!==z.bankSlot||String(a29FxThreshold(BigInt(fx.sqrtPriceX64)))!==z.meaningfulQuoteAtomic:fx!==null||z.meaningfulQuoteAtomic!==String(NATIVE_MEANINGFUL))fail('A29_V2_FREEZE_THRESHOLD');
 if(!Array.isArray(t.cohort)||t.cohort.length!==COHORT)fail('A29_V2_FREEZE_COHORT');
 const cohort=t.cohort.map((c:unknown)=>object(c)?{owner:address(c.owner,'A29_V2_FREEZE_COHORT'),balanceAtomic:atomic(c.balanceAtomic,'A29_V2_FREEZE_COHORT')}:fail('A29_V2_FREEZE_COHORT'));
 if(new Set(cohort.map((c:{owner:string})=>c.owner)).size!==COHORT)fail('A29_V2_FREEZE_COHORT');
 return{mint,pool,program,baseVault,bankKeys,endpoint0:z,cohort,quoteMint,quoteDecimals:q.decimals,quoteVault,fxPool:q.fxPool,threshold:BigInt(z.meaningfulQuoteAtomic),fxSqrt:q.fxPool?fx.sqrtPriceX64:null,endpoint1Attempt:t.endpoint1Attempt};
}

/** Parses one imported v2 packet. Archives stay compressed; declared per-receipt bytes are summed against the aggregate budget before any inflation. */
export function decodeA29CaptureV2(raw:string):A29V2Capture{
 if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>B.maxPacketBytes)fail('A29_V2_CAPTURE_SIZE');
 let packet:any;
 try{packet=JSON.parse(raw);}catch{fail('A29_V2_CAPTURE_JSON');}
 if(!object(packet)||Object.keys(packet).sort().join()!=='freeze,label,method,provenance,rawArtifacts,requests,retrievedAt,token'||packet.method!=='a29-retained-sources-v2'||typeof packet.label!=='string'||!packet.label||!object(packet.requests)||!object(packet.rawArtifacts)||!object(packet.retrievedAt)||!object(packet.provenance)||packet.provenance.accessMode!=='USER_IMPORT'||!Array.isArray(packet.provenance.records))fail('A29_V2_CAPTURE_SHAPE');
 const entry=entryV2(packet.freeze,packet.label);
 if(!object(packet.token)||packet.token.chain!=='solana'||packet.token.address!==entry.mint)fail('A29_V2_CAPTURE_TOKEN');
 const ids=Object.keys(packet.requests).sort(),same=(o:Record<string,unknown>)=>canonicalJson(Object.keys(o).sort())===canonicalJson(ids);
 if(!ids.length||!same(packet.rawArtifacts)||!same(packet.retrievedAt))fail('A29_V2_CAPTURE_KEYS');
 const receipts:A29V2Receipts={requests:{},rawArtifacts:{},retrievedAt:{},records:{}};let latest=-Infinity,declared=0;
 for(const r of packet.provenance.records as unknown[]){
  if(!object(r)||Object.keys(r).some(k=>!RECORD_KEYS.has(k))||typeof r.key!=='string'||!Object.hasOwn(packet.requests,r.key)||Object.hasOwn(receipts.records,r.key))fail('A29_V2_CAPTURE_RECORD');
  const at=packet.retrievedAt[r.key];
  if(!integer(r.sourceBytes)||typeof r.sourceSha256!=='string'||!HEX.test(r.sourceSha256)||r.httpStatus!==200||!instant(r.startedAt)||!instant(r.completedAt)||Date.parse(r.startedAt)>Date.parse(r.completedAt)||!instant(at)||Date.parse(r.completedAt)!==Date.parse(at)||Object.hasOwn(r,'requestSha256')&&!(typeof r.requestSha256==='string'&&HEX.test(r.requestSha256)))fail('A29_V2_CAPTURE_RECORD');
  declared+=r.sourceBytes;
  if(declared>B.maxInflatedSourceBytes)fail('A29_V2_CAPTURE_INFLATE_BUDGET');
  receipts.records[r.key]=r as A29V2Record;
 }
 if(Object.keys(receipts.records).length!==ids.length)fail('A29_V2_CAPTURE_RECORD');
 for(const id of ids){
  const request=packet.requests[id],archive=packet.rawArtifacts[id],at=packet.retrievedAt[id];
  if(!RECEIPT_ID.test(id)||!object(request)||Object.keys(request).sort().join()!=='method,params'||typeof request.method!=='string'||!Array.isArray(request.params)||typeof archive!=='string'||!archive||!instant(at))fail('A29_V2_CAPTURE_RECEIPT');
  receipts.requests[id]=request as Request;receipts.rawArtifacts[id]=archive;receipts.retrievedAt[id]=at;latest=Math.max(latest,Date.parse(at));
 }
 // Integrity admission is independent of semantic availability: an early MISSING endpoint must not hide an invalid unused archive.
 for(const id of ids)if(receipts.records[id]!.sourceBytes>roleLimit(id))truncated('A29_V2_RECEIPT_BYTES');
 for(const id of ids){
  const request=receipts.requests[id]!,params=request.params;
  let expected:Request;
  if(id.endsWith('-genesis'))expected={method:'getGenesisHash',params:[]};
  else if(id.endsWith('-bank'))expected={method:'getMultipleAccounts',params:[entry.bankKeys,options(receipts,id,{encoding:'base64',commitment:'finalized'}).options]};
  else if(id.endsWith('-population'))expected={method:'getProgramAccounts',params:[entry.program,options(receipts,id,{encoding:'base64',commitment:'finalized',withContext:true,filters:[{memcmp:{offset:0,bytes:entry.mint}}]}).options]};
  else if(id.endsWith('-clock')){if(params.length!==1||!integer(params[0])||params[0]===0)fail('A29_V2_REQUEST_MISMATCH');expected={method:'getBlockTime',params};}
  else if(id.startsWith('a29-transaction-')){if(typeof params[0]!=='string'||!SIGNATURE.test(params[0]))fail('A29_V2_REQUEST_MISMATCH');expected=demandTransactionRequest(params[0]);}
  else{const o=params[1];if(!object(o))fail('A29_V2_REQUEST_MISMATCH');const base:Record<string,unknown>={commitment:'finalized',limit:1000};if(Object.hasOwn(o,'before')){if(typeof o.before!=='string'||!SIGNATURE.test(o.before))fail('A29_V2_REQUEST_MISMATCH');base.before=o.before;}expected={method:'getSignaturesForAddress',params:[entry.pool,options(receipts,id,base).options]};}
  if(canonicalJson(request)!==canonicalJson(expected))fail('A29_V2_REQUEST_MISMATCH');
  let body:any;try{body=JSON.parse(a29V2Payload(receipts,id));}catch(error){if(error instanceof A29Gap)throw error;fail('A29_V2_RECEIPT_INTEGRITY');}
  if(!object(body)||body.jsonrpc!=='2.0'||body.id!==1||!Object.hasOwn(body,'result')&&!Object.hasOwn(body,'error'))fail('A29_V2_RECEIPT_SHAPE');
 }
 return{freeze:packet.freeze,label:packet.label,receipts,maxClock:new Date(latest).toISOString(),provenance:packet.provenance};
}

/** Lazy payload contract: rawArtifacts[id] is one strict single-stream DEFLATE archive (unpackDemandReceipt format); records[id] binds the original UTF-8 response bytes by length and SHA-256.
 * The declared length is checked against its role limit before inflation; output is bounded by that length, read one receipt at a time, never cached, and must be strict UTF-8. */
export function a29V2Payload(r:A29V2Receipts,id:string):string{
 const record=r.records[id],archive=r.rawArtifacts[id];
 if(!record||typeof archive!=='string')fail('A29_V2_RECEIPT_SHAPE');
 if(record.sourceBytes>roleLimit(id))truncated('A29_V2_RECEIPT_BYTES');
 const out:unknown=unpackDemandReceipt(archive,record.sourceBytes),bytes=Buffer.isBuffer(out)?out:typeof out==='string'?Buffer.from(out,'utf8'):fail('A29_V2_RECEIPT_ARCHIVE');
 if(bytes.length!==record.sourceBytes||createHash('sha256').update(bytes).digest('hex')!==record.sourceSha256)fail('A29_V2_RECEIPT_INTEGRITY');
 try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{return fail('A29_V2_RECEIPT_UTF8');}
}

function read(r:A29V2Receipts,id:string,expected:Request,cutoff:string){
 if(!Object.hasOwn(r.requests,id))missing('A29_V2_RECEIPT_ABSENT');
 consumed.get(r)?.add(id);
 if(canonicalJson(r.requests[id])!==canonicalJson(expected))fail('A29_V2_REQUEST_MISMATCH');
 const retrieved=r.retrievedAt[id]!,at=Date.parse(retrieved);
 if(at>Date.parse(cutoff))missing('A29_V2_RECEIPT_AFTER_CUTOFF');
 const body=a29V2Payload(r,id);let response:any;
 try{response=JSON.parse(body);}catch{fail('A29_V2_RECEIPT_JSON');}
 if(!object(response)||response.jsonrpc!=='2.0'||response.id!==1)fail('A29_V2_RECEIPT_SHAPE');
 if(response.error!==undefined&&response.error!==null)missing('A29_V2_RPC_ERROR');
 if(!Object.hasOwn(response,'result'))fail('A29_V2_RECEIPT_SHAPE');
 return{value:response.result as any,at,retrieved};
}
// The captured options define the expected request; an optional floor is kept exactly as captured, never added or rewritten.
function options(r:A29V2Receipts,id:string,base:Record<string,unknown>){
 if(!Object.hasOwn(r.requests,id))missing('A29_V2_RECEIPT_ABSENT');
 const o=r.requests[id]!.params?.[1];
 if(!object(o))fail('A29_V2_REQUEST_MISMATCH');
 if(!Object.hasOwn(o,'minContextSlot'))return{options:base,floor:null as number|null};
 return integer(o.minContextSlot)?{options:{...base,minContextSlot:o.minContextSlot},floor:o.minContextSlot as number|null}:fail('A29_V2_REQUEST_FLOOR');
}

// The v1 A12 model with the actual quote mint: passive quote admission, quote vault validation, SDK fee tier and the exact 300 bps solver.
function bankV2(value:any,e:EntryV2,first:boolean){
 if(!object(value)||!object(value.context)||!integer(value.context.slot)||!Array.isArray(value.value)||value.value.length!==e.bankKeys.length)fail('A29_V2_BANK_SHAPE');
 if(value.value.some((v:unknown)=>v===null))missing('A29_V2_BANK_ACCOUNT_ABSENT');
 const a=(value.value as unknown[]).map(info),g=a[0]!,f=a[1]!,qm=a[2]!,pa=a[3]!,ma=a[4]!,bv=a[5]!,qv=a[6]!;
 const slot=value.context.slot as number,mint=new PublicKey(e.mint),pk=new PublicKey(e.pool),quote=new PublicKey(e.quoteMint);
 try{
  if(!g.owner.equals(PUMP_AMM_PROGRAM_ID)||!f.owner.equals(PUMP_FEE_PROGRAM_ID)||!qm.owner.equals(TOKEN_PROGRAM_ID)||qm.data.length!==82)fail('A29_V2_BANK_CONFIG');
  const globalConfig=PUMP_AMM_SDK.decodeGlobalConfig(g),feeConfig=PUMP_AMM_SDK.decodeFeeConfig(f),admission=quoteAdmission(qm);
  if(admission.mint.decimals!==e.quoteDecimals)fail('A29_V2_BANK_QUOTE_MINT');
  let threshold:bigint|null=e.fxPool?null:NATIVE_MEANINGFUL,fx:Fx|null=null;
  if(e.fxPool){
   const native=a[7]!;
   if(!native.owner.equals(TOKEN_PROGRAM_ID)||native.data.length!==82)fail('A29_V2_BANK_NATIVE_MINT');
   const n=MintLayout.decode(native.data);
   if(!n.isInitialized||n.decimals!==9)fail('A29_V2_BANK_NATIVE_MINT');
   // The threshold binds to the endpoint0 bank only; endpoint1 never refits it.
   if(first){const w=decodeA29Whirlpool(e.fxPool,value.value[8],e.quoteMint);threshold=a29FxThreshold(w.sqrtPriceX64);fx={pool:w.pool,sqrtPriceX64:String(w.sqrtPriceX64),bankSlot:slot};}
  }
  if(!pa.owner.equals(PUMP_AMM_PROGRAM_ID)||ma.owner.toBase58()!==e.program)fail('A29_V2_BANK_ROUTE');
  const p=PUMP_AMM_SDK.decodePool(pa),m=MintLayout.decode(ma.data),control=decodeRawMintControls({context:{slot},value:{owner:ma.owner.toBase58(),data:[ma.data.toString('base64'),'base64']}});
  if(p.index!==0||!p.creator.equals(pumpPoolAuthorityPda(mint))||!p.baseMint.equals(mint)||!p.quoteMint.equals(quote)||p.isMayhemMode||p.virtualQuoteReserves.isNeg()||globalConfig.disableFlags&16||!m.isInitialized||!control.complete||!control.transferAllowed||control.currentFeeBps!=='0'||!control.feeImmutable)fail('A29_V2_BANK_ROUTE');
  if(p.poolBaseTokenAccount.toBase58()!==e.baseVault||p.poolQuoteTokenAccount.toBase58()!==e.quoteVault)fail('A29_V2_BANK_ROUTE');
  const vault=(x:AccountInfo<Buffer>,owner:PublicKey,vaultMint:PublicKey,isQuote:boolean)=>{
   if(!x.owner.equals(owner)||x.data.length<165)fail('A29_V2_BANK_VAULT');
   if(isQuote)validateVaultData(x,admission);
   const v=AccountLayout.decode(x.data);
   if(!v.mint.equals(vaultMint)||!v.owner.equals(pk)||v.state!==1||v.delegateOption||v.closeAuthorityOption)fail('A29_V2_BANK_VAULT');
   return v.amount;
  };
  const Bv=vault(bv,ma.owner,mint,false),P=vault(qv,TOKEN_PROGRAM_ID,quote,true);
  if(Bv<=0n||m.supply<Bv)fail('A29_V2_BANK_SUPPLY');
  const args={baseReserve:new BN(String(Bv)),quoteReserve:new BN(String(P)),virtualQuoteReserves:p.virtualQuoteReserves,globalConfig,baseMintAccount:m,baseMint:mint,coinCreator:p.coinCreator,creator:p.creator,feeConfig,quoteMint:quote,isMayhemMode:p.isMayhemMode,creatorFeeBps:p.creatorFeeBps,slippage:0};
  const rates=computeFeesBps({...args,baseMintSupply:new BN(String(m.supply)),quoteReserve:args.quoteReserve.add(p.virtualQuoteReserves)}),V=BigInt(p.virtualQuoteReserves.toString());
  const boundary=solveExitCapacity({base:Bv,physicalQuote:P,virtualQuote:V,sellDomain:m.supply-Bv,fees:[BigInt(rates.lpFeeBps.toString()),BigInt(rates.protocolFeeBps.toString()),p.coinCreator.equals(PublicKey.default)?0n:BigInt(rates.creatorFeeBps.toString())],impactBps:IMPACT_BPS});
  if(boundary.status!=='KNOWN')truncated('A29_V2_DEPTH_INTERVAL_CAP');
  if(BigInt(boundary.inputAtomic!)>0n&&sellBaseInput({...args,base:new BN(boundary.inputAtomic!)}).uiQuote.toString()!==boundary.quoteAtomic)fail('A29_V2_DEPTH_CROSSCHECK');
  return{slot,B:Bv,P,supply:m.supply,decimals:m.decimals,pool:p as Pool,spot:new D(String(P+V)).div(String(Bv)),depth:{inputAtomic:boundary.inputAtomic!,quoteAtomic:boundary.quoteAtomic!},threshold,fx,risks:admission.authorityRisks};
 }catch(error){
  if(error instanceof A29Gap)throw error;
  const message=error instanceof Error?error.message:'';
  throw new Error(/^A29_[A-Z0-9_]+$/.test(message)?message:/^EXIT_CAPACITY_[A-Z0-9_]+$/.test(message)?`A29_V2_${message}`:'A29_V2_BANK_INVALID');
 }
}

function endpointV2(prefix:string,e:EntryV2,r:A29V2Receipts,cutoff:string,first:boolean){
 const id=(name:string)=>`${prefix}-${name}`,mismatch=(code:string):never=>first?fail(code):missing(code);
 // Endpoint1 may reuse the one immutable endpoint0 genesis response; that read time is then not an endpoint1 retrieval.
 const alias=!first&&!Object.hasOwn(r.requests,id('genesis'));
 const genesis=read(r,alias?'a29-e0-genesis':id('genesis'),{method:'getGenesisHash',params:[]},cutoff);
 if(genesis.value!==SOLANA_MAINNET_GENESIS)fail('A29_V2_GENESIS');
 const finalized={encoding:'base64',commitment:'finalized'};
 const b=options(r,id('bank'),finalized),q=options(r,id('population'),{...finalized,withContext:true,filters:[{memcmp:{offset:0,bytes:e.mint}}]});
 const bank=read(r,id('bank'),{method:'getMultipleAccounts',params:[e.bankKeys,b.options]},cutoff);
 const population=read(r,id('population'),{method:'getProgramAccounts',params:[e.program,q.options]},cutoff);
 const state=bankV2(bank.value,e,first),people=populationState(population.value,e);
 // A supplied floor must be met; finalized same-slot and interval checks hold independently of any floor.
 if(b.floor!==null&&state.slot<b.floor||q.floor!==null&&people.slot<q.floor)fail('A29_V2_CONTEXT_FLOOR');
 if(state.slot!==people.slot)mismatch('A29_V2_ENDPOINT_SLOT_MISMATCH');
 if(people.total!==state.supply)mismatch('A29_V2_SUPPLY_UNRECONCILED');
 if(people.vault!==state.B)mismatch('A29_V2_BASE_VAULT_UNRECONCILED');
 const clock=read(r,id('clock'),{method:'getBlockTime',params:[state.slot]},cutoff);
 if(!integer(clock.value)||clock.value<=0)fail('A29_V2_CLOCK');
 return{slot:state.slot,time:clock.value as number,state,people,retrieved:[...(alias?[]:[genesis.at]),bank.at,population.at,clock.at]};
}

/** Same tape semantics as v1 under v2 bounds: back to t0-2L, coverage proved by an exhausted page or an older row. */
function tapeV2(e:EntryV2,slot0:number,slot1:number,t0:number,L:number,r:A29V2Receipts,cutoff:string,after:number){
 const rows:Row[]=[],seen=new Set<string>(),lower=t0-2*L;let before:string|undefined,lastSlot=Infinity,lastTime=Infinity,lastAt=-Infinity,covered=false,firstAt=Infinity;
 for(let i=0;i<B.tapeMaxPages&&!covered;i++){
  const id=`a29-page-${i}`,base={commitment:'finalized',limit:B.pageLimit,...(before?{before}:{})};
  const page=read(r,id,{method:'getSignaturesForAddress',params:[e.pool,options(r,id,base).options]},cutoff);
  if(page.at<after||page.at<lastAt)fail('A29_V2_PAGE_TIME');
  firstAt=Math.min(firstAt,page.at);lastAt=page.at;
  if(!Array.isArray(page.value)||page.value.length>B.pageLimit)fail('A29_V2_PAGE_SHAPE');
  for(const x of page.value as unknown[]){
   if(!object(x)||typeof x.signature!=='string'||!SIGNATURE.test(x.signature)||!integer(x.slot)||!(x.blockTime===null||integer(x.blockTime))||!Object.hasOwn(x,'err')||!(x.err===null||typeof x.err==='object'||typeof x.err==='string'))fail('A29_V2_PAGE_ROW');
   if(seen.has(x.signature)||x.slot>lastSlot||x.blockTime!==null&&x.blockTime>lastTime)fail('A29_V2_PAGE_ORDER');
   seen.add(x.signature);lastSlot=x.slot;if(x.blockTime!==null)lastTime=x.blockTime;rows.push({signature:x.signature,slot:x.slot,blockTime:x.blockTime,err:x.err});
  }
  covered=page.value.length<B.pageLimit||page.value.some((x:any)=>x.slot<=slot0&&x.blockTime!==null&&x.blockTime<lower);
  before=page.value.at(-1)?.signature;
 }
 if(!covered)truncated('A29_V2_TAPE_PAGE_CAP');
 const selected:Array<{row:Row;window:Window}>=[];
 for(const row of rows){
  if(row.slot>slot1)continue;
  if(row.slot<=slot0&&row.blockTime!==null&&row.blockTime<lower)break;
  // Failed rows stay retained in the tape and get no transaction read.
  if(row.err!==null)continue;
  if(row.blockTime===null)truncated('A29_V2_TAPE_NULL_CLOCK');
  const t=row.blockTime as number;
  selected.push({row,window:row.slot>slot0?'measured':t>=t0-L?'baseline':'warmup'});
  if(selected.length>B.maxSuccessfulTransactionsPerToken)truncated('A29_V2_TAPE_TRANSACTION_CAP');
 }
 return{selected,firstAt};
}

function measure(e:EntryV2,scope:Record<string,any>,r:A29V2Receipts,cutoff:string,used:Set<string>,onInterval:(value:Interval)=>void){
 const z=e.endpoint0,e0=endpointV2('a29-e0',e,r,cutoff,true);
 if(e0.slot!==z.bankSlot||e0.people.slot!==z.populationSlot||String(e0.state.supply)!==z.supplyAtomic||String(e0.people.total)!==z.totalAtomic||e0.people.accounts!==z.accounts||e0.time*1000!==Date.parse(z.chainTime)||String(e0.state.B)!==z.baseVaultAtomic||String(e0.state.P)!==z.quoteVaultAtomic)fail('A29_V2_FREEZE_ENDPOINT0_MISMATCH');
 if(e0.state.threshold!==e.threshold||(e0.state.fx?.sqrtPriceX64??null)!==e.fxSqrt)fail('A29_V2_FREEZE_THRESHOLD_MISMATCH');
 const top=rank(e0.people.adjusted).slice(0,COHORT);
 if(top.length!==COHORT||top.some(([owner,amount],i)=>owner!==e.cohort[i]!.owner||String(amount)!==e.cohort[i]!.balanceAtomic))fail('A29_V2_FREEZE_COHORT_MISMATCH');
 const frozenAt=Date.parse(scope.frozenAt),revisions=scope.evidenceBasedRevisions??[];
 if(!Array.isArray(revisions)||!Number.isFinite(frozenAt)||frozenAt<Math.max(...e0.retrieved))fail('A29_V2_FREEZE_TIMING');
 const revisedAt=revisions.map((x:unknown)=>object(x)&&typeof x.at==='string'?Date.parse(x.at):NaN);
 if(revisedAt.some((t:number)=>!Number.isFinite(t)||t<frozenAt))fail('A29_V2_FREEZE_TIMING');
 const e1=endpointV2('a29-e1',e,r,cutoff,false);
 if(Math.max(frozenAt,...revisedAt)>=Math.min(...e1.retrieved))fail('A29_V2_FREEZE_TIMING');
 if(e1.slot<=e0.slot||e1.state.decimals!==e0.state.decimals)fail('A29_V2_ENDPOINT_ORDER');
 const t0=e0.time,t1=e1.time,L=t1-t0;
 if(L<MIN_SECONDS)missing('A29_V2_INTERVAL_SHORT');
 onInterval({slot0:e0.slot,slot1:e1.slot,t0:iso(t0),t1:iso(t1),seconds:L});
 const {selected,firstAt}=tapeV2(e,e0.slot,e1.slot,t0,L,r,cutoff,Math.max(...e1.retrieved));
 const sets:Record<Window,Set<string>>={warmup:new Set(),baseline:new Set(),measured:new Set()};
 const cohort=new Set(e.cohort.map(c=>c.owner)),flow={trades:0,sellBase:0n,sellQuote:0n,buyBase:0n,buyQuote:0n};
 selected.forEach(({row,window},n)=>{
  const tx=read(r,`a29-transaction-${n}`,demandTransactionRequest(row.signature),cutoff),v=tx.value;
  if(tx.at<firstAt)fail('A29_V2_TRANSACTION_TIME');
  if(v===null)missing('A29_V2_TRANSACTION_ABSENT');
  if(!object(v)||v.slot!==row.slot||v.blockTime!==row.blockTime||!object(v.meta)||v.meta.err!==null)fail('A29_V2_TRANSACTION_MISMATCH');
  let decoded:ReturnType<typeof decodeA29TradesV2>;
  try{decoded=decodeA29TradesV2(v,{signature:row.signature,slot:row.slot,at:iso(row.blockTime as number)},e.pool,e1.state.pool,e1.slot,tx.retrieved,TOKENKEG,e.quoteDecimals);}
  catch(error){if(error instanceof Error&&['A29_TRANSACTION_SIGNATURE','A29_V2_TRANSACTION_SIGNATURE'].includes(error.message))throw error;missing('A29_V2_TRADE_UNSUPPORTED');}
  const legs=new Set<number>(),cpi=(decoded as unknown as Record<string,unknown>).cpiAuthorizedAccounts;
  for(const trade of decoded.trades){
   if(trade.signature!==row.signature||trade.slot!==row.slot||!trade.quoteAccounting||trade.quoteAccounting.coreQuoteAtomic!==trade.quoteAtomic)missing('A29_V2_TRADE_CORE_QUOTE');
   if(trade.side==='BUY'&&BigInt(trade.quoteAtomic)>=e.threshold){
    if(!Array.isArray(cpi)||cpi.some(k=>typeof k!=='string'))missing('A29_V2_BUYER_AUTHORITY_UNSUPPORTED');
    if(eligibleBuyer(decoded.projected,cpi as string[],trade.user))sets[window].add(trade.user);
   }
   if(window!=='measured')continue;
   let bound:ReturnType<typeof bindA29TradeAccountV2>;
   try{bound=bindA29TradeAccountV2(decoded.projected,trade,e.mint,e.baseVault);}catch{missing('A29_V2_OWNER_BINDING_UNSUPPORTED');}
   // Any measured ambiguity or reused leg withholds the whole vector.
   if(bound.ambiguous)missing('A29_V2_OWNER_AMBIGUOUS');
   if(legs.has(bound.legPosition))missing('A29_V2_OWNER_LEG_DUPLICATE');
   legs.add(bound.legPosition);
   if(!bound.owners.some(o=>cohort.has(o)))continue;
   flow.trades++;
   if(trade.side==='SELL'){flow.sellBase+=BigInt(trade.baseAtomic);flow.sellQuote+=BigInt(trade.quoteAtomic);}
   else{flow.buyBase+=BigInt(trade.baseAtomic);flow.buyQuote+=BigInt(trade.quoteAtomic);}
  }
 });
 const deadline=Math.min(...e0.retrieved)+B.hardCaptureDeadlineSeconds*1000;
 if([...used].some(id=>Date.parse(r.retrievedAt[id]!)>deadline))truncated('A29_V2_CAPTURE_DEADLINE');
 const fresh=(current:Window,prior:Window)=>[...sets[current]].filter(u=>!sets[prior].has(u)).length;
 const warmup=sets.warmup.size,baseline=fresh('baseline','warmup'),measured=fresh('measured','baseline');
 const held=(x:typeof e0)=>e.cohort.map(c=>x.people.raw.get(c.owner)??0n),sum=(h:bigint[])=>h.reduce((s,k)=>s+k,0n),h0=held(e0),h1=held(e1);
 const q0=BigInt(e0.state.depth.quoteAtomic),q1=BigInt(e1.state.depth.quoteAtomic),net=flow.sellBase-flow.buyBase,delta=sum(h1)-sum(h0);
 const d0=endpointData(e0,z.attempt,sum(h0)),d1=endpointData(e1,e.endpoint1Attempt,sum(h1));
 const signed=(a:string,b:string)=>{const s=new Decimal(a).minus(b).toFixed();return s==='-0'?'0':s;};
 const change=(k:'supply'|'vaultAdjusted')=>({top1:signed(d1.concentration[k].top1,d0.concentration[k].top1),top5:signed(d1.concentration[k].top5,d0.concentration[k].top5),top10:signed(d1.concentration[k].top10,d0.concentration[k].top10)});
 return{
  units:{quoteMint:e.quoteMint,quoteProgram:TOKENKEG,quoteDecimals:e.quoteDecimals,baseDecimals:e0.state.decimals,fx:e0.state.fx,quoteAuthorityRisks:e0.state.risks},
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

/** A29 v2 metric: KNOWN only when all five components resolve; otherwise MISSING or TRUNCATED with a null vector. Malformed sources throw. */
export function deriveA29AbsorptionV2(freeze:unknown,label:string,receipts:A29V2Receipts,cutoff:string,evidenceIds:string[]):AdvisoryMetric{
 if(!instant(cutoff))fail('A29_V2_CUTOFF');
 const e=entryV2(freeze,label);
 const frame={method:A29_DATA_METHOD_V2,freezeKind:A29_FREEZE_KIND_V2,freezeSha256:createHash('sha256').update(canonicalJson(freeze)).digest('hex'),token:{chain:'solana',address:e.mint},label,
  provenance:{accessMode:'USER_IMPORT',source:'IMPORTED_PRIOR_PUBLIC_CAPTURE',freshLive:false},
  instrument:{cohortSize:COHORT,depthImpactBps:Number(IMPACT_BPS),meaningfulBuyerQuoteAtomic:String(e.threshold),thresholdSource:e.fxPool?'E0_ORCA_WHIRLPOOL_MARGINAL':'NATIVE',minimumIntervalSeconds:MIN_SECONDS},
  claim:'DESCRIPTIVE_SAME_INTERVAL_VECTOR',limitations:LIMITATIONS};
 let interval:Interval|null=null;
 const metric=(quality:'KNOWN'|'MISSING'|'TRUNCATED',reasonCode:string,vector:unknown):AdvisoryMetric=>{
  let data:unknown;
  try{data=a29DataSchemaV2.parse({...frame,status:quality,interval,vector});}catch{fail('A29_V2_DATA_CONTRACT');}
  return{id:'A29',quality,unit:'distribution-absorption-vector',data,evidenceIds:[...evidenceIds],reasonCode};
 };
 const ids=Object.keys(receipts.requests).sort(),sameKeys=(o:Record<string,unknown>)=>canonicalJson(Object.keys(o).sort())===canonicalJson(ids);
 if(!sameKeys(receipts.rawArtifacts)||!sameKeys(receipts.retrievedAt)||!sameKeys(receipts.records)||ids.some(id=>!RECEIPT_ID.test(id)))fail('A29_V2_RECEIPT_KEYS');
 const used=new Set<string>();consumed.set(receipts,used);
 let vector:unknown;
 try{
  vector=measure(e,freeze as Record<string,any>,receipts,cutoff,used,value=>{interval=value;});
  if(ids.length!==used.size||ids.some(id=>!used.has(id)))fail('A29_V2_RECEIPT_UNUSED');
 }
 catch(error){
  if(error instanceof A29Gap)return metric(error.quality,error.code,null);
  throw error instanceof Error&&/^A29_[A-Z0-9_]+$/.test(error.message)?error:new Error('A29_V2_CAPTURE_INVALID');
 }
 return metric('KNOWN','A29_PROSPECTIVE_VECTOR_OBSERVED',vector);
}
