/** Source-bound accounting for the selected unsigned WBTC execution plan. */
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {Decimal} from 'decimal.js';
import {PublicKey,SystemProgram,TransactionMessage,VersionedTransaction,ComputeBudgetProgram} from '@solana/web3.js';
import {NATIVE_MINT,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {PUMP_AMM_SDK,PUMP_AMM_PROGRAM_ID,coinCreatorVaultAuthorityPda,coinCreatorVaultAtaPda,userVolumeAccumulatorPda} from '@pump-fun/pump-swap-sdk';
import type {TokenRef,Profile,EvidenceRecord,LiveBundle} from '../domain/contracts.js';
import type {BaselineAssessment} from '../domain/baseline.js';
import {reconstructEntryRoute,validateEntryRouteBundle} from './entry-route.js';
import {reconstructExitRoute,validateExitRouteBundle} from './exit-route.js';
import {finishSimulationRoute,validateSimulationRouteBundle,type SimulationRouteCapture} from './simulation-route.js';
import {fetchReadResponse,readLimitedText} from './http.js';

export const ROUTE_COST_METHOD='canonical-wbtc-pump-cost-v1';
const PREFIX='cost-route-',IDS=[PREFIX+'entry-fee',PREFIX+'exit-fee',PREFIX+'sol-usd'],DERIVED=PREFIX+'derivation';
const RPC_SOURCE='cost-route-rpc',PRICE_SOURCE='cost-route-market',DERIVED_SOURCE='cost-route-derived';
const SOL_USD_URL='https://api.dexscreener.com/tokens/v1/solana/'+NATIVE_MINT.toBase58(),USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ENTRY_IDS=['entry-route-genesis','entry-route-bank','entry-route-usd'],SIM_IDS=['largest','token-accounts','payers','setup','blockhash','result'].map(x=>'simulation-route-'+x),DEPENDENCIES=['rpc-account','venue-provenance-record',...ENTRY_IDS,...SIM_IDS];
const LIMITATIONS=['The independent entry/exit benchmark includes the original unspent WBTC. Atomic simulation establishes setup accounting; it does not replace the independent quoted exit.', 'Separate message network fees are quoted for the selected no-tip instruction policy. All observed retained native setup deposits are conservatively charged at entry even if recoverable later.', 'SOL and WBTC use separate current provider USD references, not executable fiat conversion. Reconciled selected-plan accounting is not risk approval, a future fill guarantee or coverage of unrelated external charges.'];
const sha=(s:string)=>createHash('sha256').update(s).digest('hex'),bad=():never=>{throw Error('ROUTE_COST_PROOF_INVALID');};
class Unavailable extends Error{}
const unavailable=(code:string):never=>{throw new Unavailable(code);};
const parse=(raw:string|undefined):any=>{try{return JSON.parse(raw??'null');}catch{return null;}};
const integer=(x:unknown):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0;
const atomic=(x:unknown):bigint=>{if(typeof x!=='string'||!/^(0|[1-9]\d{0,19})$/.test(x)||BigInt(x)>18446744073709551615n)return unavailable('ROUTE_COST_TOKEN_BALANCES_UNAVAILABLE');return BigInt(x);};
const time=(x:string)=>{const t=Date.parse(x);if(!Number.isFinite(t))bad();return t;};
type Request={method:string;params:unknown[]}|{url:string};
export type RouteCostCapture={records:EvidenceRecord[];rawArtifacts:Record<string,string>};
type SetupDeposit={account:string;kind:'BASE_ATA'|'USER_VOLUME_ACCUMULATOR'|'PROTOCOL_FEE_ATA'|'BUYBACK_FEE_ATA'|'CREATOR_VAULT_ATA';lamports:string;space:number};
type PositiveFacts={quality:'KNOWN'|'STALE';method:typeof ROUTE_COST_METHOD;benchmarkMethod:'INDEPENDENT_QUOTES';feeProofLevel:'QUOTED';setupProofLevel:'SIMULATED';token:TokenRef;pool:string;subject:string;quantityAtomic:string;quoteMint:string;entryFeeLamports:string;exitFeeLamports:string;atomicSimulationFeeLamports:string;retainedNativeSetupDebitLamports:string;retainedSetupDeposits:SetupDeposit[];solUsdReference:string;solPricePair:string;quoteUsdReference:string;entryExternalCostUsd:string;exitExternalCostUsd:string;totalEntryCostUsd:string;netExitUsd:string;roundTripLossBps:string;embeddedFeesUsd:string;costsReconciled:true;availableAt:string;expiresAt:string;limitations:string[]};
export type RouteCostFacts=PositiveFacts|{quality:'MISSING';method:typeof ROUTE_COST_METHOD;reasonCode:string;limitations:string[]};
const missing=(reasonCode:string):RouteCostFacts=>({quality:'MISSING',method:ROUTE_COST_METHOD,reasonCode,limitations:LIMITATIONS});
function dependencyHashes(raw:Record<string,string>){return DEPENDENCIES.filter(id=>typeof raw[id]==='string').map(id=>({id,contentHash:sha(raw[id]!)}));}
function record(id:string,raw:string,at:string,deps:Record<string,string>,request?:Request):EvidenceRecord{return {id,sourceId:!request?DERIVED_SOURCE:'url'in request?PRICE_SOURCE:RPC_SOURCE,sourceType:!request?'CALCULATION':'url'in request?'PUBLIC_MARKET':'JSON_RPC',accessMode:request?'PUBLIC_API':'LOCAL_DERIVED',adapterVersion:ROUTE_COST_METHOD,scope:{method:ROUTE_COST_METHOD,dependencies:dependencyHashes(deps),...(request?{request}:{})},retrievedAt:at,availableAt:at,contentHash:sha(raw)};}
export function buildRouteCostMessages(wireBase64:string){
 let tx:VersionedTransaction;try{const wire=Buffer.from(wireBase64,'base64');if(wire.toString('base64')!==wireBase64)bad();tx=VersionedTransaction.deserialize(wire);}catch{return unavailable('ROUTE_COST_WIRE_UNSUPPORTED');}
 const message=tx.message;if(message.addressTableLookups.length||message.header.numRequiredSignatures!==1||tx.signatures.length!==1||tx.signatures[0]!.some(n=>n!==0))return unavailable('ROUTE_COST_WIRE_UNSUPPORTED');
 const d=TransactionMessage.decompile(message),ix=d.instructions;if(!ix[0]?.programId.equals(ComputeBudgetProgram.programId)||!ix[0].data.equals(ComputeBudgetProgram.setComputeUnitLimit({units:1_400_000}).data))return unavailable('ROUTE_COST_WIRE_UNSUPPORTED');
 const trades=ix.flatMap((instruction,index)=>instruction.programId.equals(PUMP_AMM_PROGRAM_ID)?[{index,name:instruction.data.subarray(0,8).equals(createHash('sha256').update('global:buy').digest().subarray(0,8))?'buy':instruction.data.subarray(0,8).equals(createHash('sha256').update('global:sell').digest().subarray(0,8))?'sell':null}]:[]);
 if(trades.length!==2||trades[0]!.name!=='buy'||trades[1]!.name!=='sell'||trades[1]!.index!==ix.length-1)return unavailable('ROUTE_COST_WIRE_UNSUPPORTED');
 if(!((ix.length===3&&trades[0]!.index===1)||(ix.length===4&&trades[0]!.index===2&&ix[1]!.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)&&ix[1]!.data.equals(Buffer.from([1])))))return unavailable('ROUTE_COST_WIRE_UNSUPPORTED');
 const compile=(instructions:typeof ix)=>{const m=new TransactionMessage({payerKey:d.payerKey,recentBlockhash:d.recentBlockhash,instructions}).compileToV0Message();if(m.addressTableLookups.length||m.header.numRequiredSignatures!==1)return unavailable('ROUTE_COST_WIRE_UNSUPPORTED');return Buffer.from(m.serialize()).toString('base64');};
 return {tx,decoded:d,buyIndex:trades[0]!.index,sellIndex:trades[1]!.index,entryMessage:compile(ix.slice(0,trades[1]!.index)),exitMessage:compile([ix[0]!,ix[trades[1]!.index]!])};
}
function context(token:TokenRef,profile:Profile,raw:Record<string,string>,evidence:EvidenceRecord[]){
 const entryRecords=ENTRY_IDS.map(id=>evidence.find(e=>e.id===id)),simulationRecords=SIM_IDS.map(id=>evidence.find(e=>e.id===id));
 if(entryRecords.some(e=>!e)||simulationRecords.some(e=>!e)||[...ENTRY_IDS,...SIM_IDS].some(id=>typeof raw[id]!=='string'))return null;
 const entryAt=new Date(Math.max(...entryRecords.map(e=>time(e!.availableAt)))).toISOString(),sourceAt=new Date(Math.max(...simulationRecords.map(e=>time(e!.availableAt)))).toISOString();
 const entry=reconstructEntryRoute(token,profile,entryAt,raw,{records:entryRecords as EvidenceRecord[],rawArtifacts:Object.fromEntries(ENTRY_IDS.map(id=>[id,raw[id]!]))});if(entry.quality==='MISSING')return null;
 const exit=reconstructExitRoute(token,profile,sourceAt,raw,evidence);if(exit.quality==='MISSING')return null;
 const capture:SimulationRouteCapture={records:simulationRecords as EvidenceRecord[],rawArtifacts:Object.fromEntries(SIM_IDS.map(id=>[id,raw[id]!]))},simulation=finishSimulationRoute(token,profile,sourceAt,raw,evidence,capture),facts=parse(simulation.capture.rawArtifacts['simulation-route-derivation']);if(facts?.quality==='MISSING'||!simulation.assessment)return null;
 const simRecord=simulationRecords[5]!,request=simRecord.scope.request as {method:string;params:unknown[]},sim=parse(raw[SIM_IDS[5]!])?.result;
 if(request?.method!=='simulateTransaction'||typeof request.params?.[0]!=='string'||!sim||!integer(sim.context?.slot))return unavailable('ROUTE_COST_SIMULATION_UNAVAILABLE');
 const messages=buildRouteCostMessages(request.params[0]),poolAccount=parse(raw['entry-route-bank'])?.result?.value?.[0];if(!poolAccount?.data?.[0])return unavailable('ROUTE_COST_BANK_UNAVAILABLE');
 const pool=PUMP_AMM_SDK.decodePool({...poolAccount,owner:new PublicKey(poolAccount.owner),data:Buffer.from(poolAccount.data[0],'base64')}),globalAccount=parse(raw['entry-route-bank'])?.result?.value?.[5],global=PUMP_AMM_SDK.decodeGlobalConfig({...globalAccount,owner:new PublicKey(globalAccount.owner),data:Buffer.from(globalAccount.data[0],'base64')});
 const provenance=parse(raw['venue-provenance-record']);if(typeof provenance?.expiresAt!=='string')bad();
 return {entry,exit,simulation:facts,sim,messages,pool,global,sourceAt,provenanceExpires:provenance.expiresAt as string};
}
function requests(c:NonNullable<ReturnType<typeof context>>):Request[]{return [{method:'getFeeForMessage',params:[c.messages.entryMessage,{commitment:'finalized',minContextSlot:c.sim.context.slot}]},{method:'getFeeForMessage',params:[c.messages.exitMessage,{commitment:'finalized',minContextSlot:c.sim.context.slot}]},{url:SOL_USD_URL}];}
function base58(raw:string):Buffer{
 if(!/^[1-9A-HJ-NP-Za-km-z]{1,200}$/.test(raw))return unavailable('ROUTE_COST_INNER_INSTRUCTIONS_UNSUPPORTED');const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=0n;for(const ch of raw)n=n*58n+BigInt(alphabet.indexOf(ch));let hex=n.toString(16);if(hex.length%2)hex='0'+hex;return Buffer.concat([Buffer.alloc(raw.length-raw.replace(/^1+/,'').length),n?Buffer.from(hex,'hex'):Buffer.alloc(0)]);
}
function nativeSetup(c:NonNullable<ReturnType<typeof context>>){
 const v=c.sim.value,keys=c.messages.tx.message.staticAccountKeys,pre=v?.preBalances,post=v?.postBalances;
 if(!Array.isArray(pre)||!Array.isArray(post)||pre.length!==keys.length||post.length!==keys.length||!pre.every(integer)||!post.every(integer)||!integer(v.fee)||new Set(keys.map(k=>k.toBase58())).size!==keys.length)return unavailable('ROUTE_COST_NATIVE_BALANCES_UNAVAILABLE');
 const before:bigint[]=pre.map((n:number)=>BigInt(n)),after:bigint[]=post.map((n:number)=>BigInt(n));const fee=BigInt(v.fee),sum=(a:bigint[])=>a.reduce((s,n)=>s+n,0n);
 if(sum(before)-sum(after)!==fee)return unavailable('ROUTE_COST_NATIVE_CONSERVATION');
 const user=new PublicKey(c.simulation.subject);
 // O12 returned token bytes/owner are already independently reconstructed. Their lamports must agree with the complete vector too.
 const simRequest=(c.messages.decoded.payerKey.toBase58()===user.toBase58());if(!simRequest||!keys[0]?.equals(user)||!Array.isArray(v.accounts)||v.accounts.length!==3)return unavailable('ROUTE_COST_NATIVE_CONSERVATION');
 const userBase=getAssociatedTokenAddressSync(c.pool.baseMint,user,false,new PublicKey(v.accounts[1]?.owner)),userQuote=getAssociatedTokenAddressSync(c.pool.quoteMint,user,false,TOKEN_PROGRAM_ID);
 for(const [index,address]of [user,userBase,userQuote].entries()){const keyIndex=keys.findIndex(k=>k.equals(address)),a=v.accounts[index];if(keyIndex<0||!a||!integer(a.lamports)||BigInt(a.lamports)!==after[keyIndex])return unavailable('ROUTE_COST_NATIVE_CONSERVATION');}
 const payer=v.accounts[0];if(payer.owner!==SystemProgram.programId.toBase58()||payer.executable!==false||!Array.isArray(payer.data)||payer.data[0]!==''||payer.data[1]!=='base64')return unavailable('ROUTE_COST_NATIVE_CONSERVATION');
 const retained=before[0]!-after[0]!-fee;if(retained<0n)return unavailable('ROUTE_COST_NATIVE_CONSERVATION');
 const protocol=c.global.protocolFeeRecipients.find(k=>!k.equals(PublicKey.default)&&!k.equals(user)),buyback=c.global.buybackFeeRecipients.find(k=>!k.equals(PublicKey.default)&&!k.equals(user));if(!protocol||!buyback)return unavailable('ROUTE_COST_SETUP_UNSUPPORTED');
 const allowed=new Map<string,{kind:SetupDeposit['kind'];owner:string;outer:number[];space?:number}>();
 const put=(key:PublicKey,kind:SetupDeposit['kind'],owner:PublicKey,outer:number[],space?:number)=>{if(allowed.has(key.toBase58()))return unavailable('ROUTE_COST_SETUP_UNSUPPORTED');allowed.set(key.toBase58(),{kind,owner:owner.toBase58(),outer,space});};
 put(userBase,'BASE_ATA',new PublicKey(v.accounts[1].owner),c.messages.decoded.instructions[c.messages.buyIndex-1]?.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)?[c.messages.buyIndex-1]:[],Buffer.from(v.accounts[1].data[0],'base64').length);
 put(userVolumeAccumulatorPda(user),'USER_VOLUME_ACCUMULATOR',PUMP_AMM_PROGRAM_ID,[c.messages.buyIndex]);
 put(getAssociatedTokenAddressSync(c.pool.quoteMint,protocol,true,TOKEN_PROGRAM_ID),'PROTOCOL_FEE_ATA',TOKEN_PROGRAM_ID,[c.messages.buyIndex,c.messages.sellIndex],165);
 put(getAssociatedTokenAddressSync(c.pool.quoteMint,buyback,true,TOKEN_PROGRAM_ID),'BUYBACK_FEE_ATA',TOKEN_PROGRAM_ID,[c.messages.buyIndex,c.messages.sellIndex],165);
 put(coinCreatorVaultAtaPda(coinCreatorVaultAuthorityPda(c.pool.coinCreator),c.pool.quoteMint,TOKEN_PROGRAM_ID),'CREATOR_VAULT_ATA',TOKEN_PROGRAM_ID,[c.messages.buyIndex,c.messages.sellIndex],165);
 if(!Array.isArray(v.innerInstructions))return unavailable('ROUTE_COST_SETUP_UNAVAILABLE');
 const created=new Map<string,{lamports:bigint;space:number}>(),groups=new Set<number>();
 for(const group of v.innerInstructions){if(!integer(group?.index)||group.index>=c.messages.decoded.instructions.length||groups.has(group.index)||!Array.isArray(group.instructions))return unavailable('ROUTE_COST_INNER_INSTRUCTIONS_UNSUPPORTED');groups.add(group.index);
  for(const ix of group.instructions){let programId:string;if(typeof ix?.programId==='string')programId=ix.programId;else if(integer(ix?.programIdIndex)&&ix.programIdIndex<keys.length)programId=keys[ix.programIdIndex]!.toBase58();else return unavailable('ROUTE_COST_INNER_INSTRUCTIONS_UNSUPPORTED');if(programId!==SystemProgram.programId.toBase58())continue;
   let destination:string,source:string,owner:string,lamports:bigint,space:number;
   if(ix.parsed){const info=ix.parsed.info;if(ix.parsed.type!=='createAccount'||!info||typeof info.newAccount!=='string'||typeof info.source!=='string'||typeof info.owner!=='string'||!integer(info.lamports)||!integer(info.space))return unavailable('ROUTE_COST_SETUP_UNSUPPORTED');destination=info.newAccount;source=info.source;owner=info.owner;lamports=BigInt(info.lamports);space=info.space;}
   else{if(typeof ix.data!=='string'||!Array.isArray(ix.accounts)||ix.accounts.length!==2||!ix.accounts.every((i:unknown)=>integer(i)&&i<keys.length))return unavailable('ROUTE_COST_INNER_INSTRUCTIONS_UNSUPPORTED');const data=base58(ix.data);if(data.length!==52||data.readUInt32LE(0)!==0)return unavailable('ROUTE_COST_SETUP_UNSUPPORTED');source=keys[ix.accounts[0]]!.toBase58();destination=keys[ix.accounts[1]]!.toBase58();lamports=data.readBigUInt64LE(4);const size=data.readBigUInt64LE(12);if(size>10_240n)return unavailable('ROUTE_COST_SETUP_UNSUPPORTED');space=Number(size);owner=new PublicKey(data.subarray(20,52)).toBase58();}
   const rule=allowed.get(destination),i=keys.findIndex(k=>k.toBase58()===destination);if(!rule||created.has(destination)||source!==user.toBase58()||owner!==rule.owner||!rule.outer.includes(group.index)||!integer(space)||space<1||space>10240||rule.space!==undefined&&space!==rule.space||i<=0||before[i]!==0n||after[i]!==lamports)return unavailable('ROUTE_COST_SETUP_UNSUPPORTED');created.set(destination,{lamports,space});
  }
 }
 const deposits:SetupDeposit[]=[];let measured=0n;for(let i=1;i<keys.length;i++){const delta=after[i]!-before[i]!;if(delta<0n)return unavailable('ROUTE_COST_NATIVE_REFUND_UNSUPPORTED');if(delta===0n)continue;const key=keys[i]!.toBase58(),rule=allowed.get(key),creation=created.get(key);if(!rule||!creation||creation.lamports!==delta)return unavailable('ROUTE_COST_SETUP_UNSUPPORTED');measured+=delta;deposits.push({account:key,kind:rule.kind,lamports:delta.toString(),space:creation.space});}
 if(measured!==retained||deposits.length!==created.size)return unavailable('ROUTE_COST_NATIVE_CONSERVATION');
 // Complete runtime token rows conserve both admitted currencies; newly created rows need a zero-lamport pre-state.
 const rows=(entries:any)=>{if(!Array.isArray(entries))return unavailable('ROUTE_COST_TOKEN_BALANCES_UNAVAILABLE');const map=new Map<number,{mint:string;owner:string;programId:string;decimals:number;amount:bigint}>();for(const e of entries){if(!integer(e?.accountIndex)||e.accountIndex>=keys.length||map.has(e.accountIndex)||typeof e.mint!=='string'||typeof e.owner!=='string'||typeof e.programId!=='string'||!integer(e.uiTokenAmount?.decimals)||![c.pool.baseMint.toBase58(),c.pool.quoteMint.toBase58()].includes(e.mint))return unavailable('ROUTE_COST_TOKEN_BALANCES_UNAVAILABLE');const expectedProgram=e.mint===c.pool.baseMint.toBase58()?v.accounts[1].owner:TOKEN_PROGRAM_ID.toBase58(),expectedDecimals=e.mint===c.pool.baseMint.toBase58()?c.entry.baseDecimals:8;if(e.programId!==expectedProgram||e.uiTokenAmount.decimals!==expectedDecimals)return unavailable('ROUTE_COST_TOKEN_BALANCES_UNAVAILABLE');map.set(e.accountIndex,{mint:e.mint,owner:e.owner,programId:e.programId,decimals:e.uiTokenAmount.decimals,amount:atomic(e.uiTokenAmount.amount)});}return map;};
 const preTokens=rows(v.preTokenBalances),postTokens=rows(v.postTokenBalances);
 // Conservation alone cannot prove coverage: an unchanged vault omitted from both vectors cancels out.
 const required=new Map<number,{mint:string;owner:string;programId:string;decimals:number}>();
 const requireToken=(address:PublicKey,mint:PublicKey,owner:PublicKey,program:PublicKey,decimals:number)=>{const index=keys.findIndex(k=>k.equals(address));if(index<0||required.has(index))return unavailable('ROUTE_COST_TOKEN_COVERAGE_UNAVAILABLE');required.set(index,{mint:mint.toBase58(),owner:owner.toBase58(),programId:program.toBase58(),decimals});};
 const baseProgram=new PublicKey(v.accounts[1].owner),poolKey=new PublicKey(c.entry.pool),creatorAuthority=coinCreatorVaultAuthorityPda(c.pool.coinCreator);
 requireToken(userBase,c.pool.baseMint,user,baseProgram,c.entry.baseDecimals);requireToken(userQuote,c.pool.quoteMint,user,TOKEN_PROGRAM_ID,8);
 requireToken(c.pool.poolBaseTokenAccount,c.pool.baseMint,poolKey,baseProgram,c.entry.baseDecimals);requireToken(c.pool.poolQuoteTokenAccount,c.pool.quoteMint,poolKey,TOKEN_PROGRAM_ID,8);
 requireToken(getAssociatedTokenAddressSync(c.pool.quoteMint,protocol,true,TOKEN_PROGRAM_ID),c.pool.quoteMint,protocol,TOKEN_PROGRAM_ID,8);
 requireToken(getAssociatedTokenAddressSync(c.pool.quoteMint,buyback,true,TOKEN_PROGRAM_ID),c.pool.quoteMint,buyback,TOKEN_PROGRAM_ID,8);
 requireToken(coinCreatorVaultAtaPda(creatorAuthority,c.pool.quoteMint,TOKEN_PROGRAM_ID),c.pool.quoteMint,creatorAuthority,TOKEN_PROGRAM_ID,8);
 const identity=(row:ReturnType<typeof preTokens.get>,expected:{mint:string;owner:string;programId:string;decimals:number})=>!!row&&row.mint===expected.mint&&row.owner===expected.owner&&row.programId===expected.programId&&row.decimals===expected.decimals;
 if([...preTokens.keys(),...postTokens.keys()].some(i=>!required.has(i)))return unavailable('ROUTE_COST_TOKEN_COVERAGE_UNAVAILABLE');
 for(const [index,expected]of required){if(!identity(postTokens.get(index),expected))return unavailable('ROUTE_COST_TOKEN_COVERAGE_UNAVAILABLE');if(before[index]!>0n){if(!identity(preTokens.get(index),expected))return unavailable('ROUTE_COST_TOKEN_COVERAGE_UNAVAILABLE');}else if(preTokens.has(index)||!created.has(keys[index]!.toBase58()))return unavailable('ROUTE_COST_TOKEN_COVERAGE_UNAVAILABLE');}
 for(const [i,e]of preTokens){const other=postTokens.get(i);if(!other||e.mint!==other.mint||e.owner!==other.owner||e.programId!==other.programId||e.decimals!==other.decimals)return unavailable('ROUTE_COST_TOKEN_CONSERVATION');}
 for(const [i]of postTokens)if(!preTokens.has(i)&&(before[i]!==0n||after[i]===0n))return unavailable('ROUTE_COST_TOKEN_CONSERVATION');
 for(const mint of [c.pool.baseMint.toBase58(),c.pool.quoteMint.toBase58()]){const total=(map:typeof preTokens)=>[...map.values()].filter(e=>e.mint===mint).reduce((s,e)=>s+e.amount,0n);if(total(preTokens)!==total(postTokens))return unavailable('ROUTE_COST_TOKEN_CONSERVATION');}
 return {retained,fee,deposits};
}
function reconstruct(token:TokenRef,profile:Profile,cutoff:string,deps:Record<string,string>,evidence:EvidenceRecord[],capture:RouteCostCapture):RouteCostFacts{
 let c:ReturnType<typeof context>;try{c=context(token,profile,deps,evidence);}catch(e){if(e instanceof Unavailable){if(capture.records.length)bad();return missing(e.message);}throw e;}
 if(!c){if(capture.records.length||Object.keys(capture.rawArtifacts).length)bad();return missing('ROUTE_COST_UPSTREAM_UNAVAILABLE');}
 if(capture.records.length===0&&Object.keys(capture.rawArtifacts).length===0)return missing('ROUTE_COST_NOT_COLLECTED');
 if(capture.records.length!==3||Object.keys(capture.rawArtifacts).length!==3||new Set(capture.records.map(e=>e.id)).size!==3)bad();const req=requests(c);let previous=time(c.sourceAt);
 for(const [i,id]of IDS.entries()){const e=capture.records[i],raw=capture.rawArtifacts[id];if(!e||e.id!==id||typeof raw!=='string'||!isDeepStrictEqual(e,record(id,raw,e.availableAt,deps,req[i]!))||time(e.availableAt)<previous||time(e.availableAt)>time(cutoff)||Buffer.byteLength(raw)>(i===2?2_000_000:64_000))bad();previous=time(e.availableAt);}
 try{
  const fees=IDS.slice(0,2).map(id=>{const body=parse(capture.rawArtifacts[id]);if(!body||body.error||body.jsonrpc!=='2.0'||body.id!==1||!integer(body.result?.context?.slot)||body.result.context.slot<c!.sim.context.slot||!integer(body.result.value))return unavailable('ROUTE_COST_FEE_UNAVAILABLE');return BigInt(body.result.value);});
  const prices=parse(capture.rawArtifacts[IDS[2]!]);if(!Array.isArray(prices))return missing('ROUTE_COST_PRICE_UNAVAILABLE');
  const eligible=prices.filter(p=>p?.chainId==='solana'&&p.baseToken?.address===NATIVE_MINT.toBase58()&&p.quoteToken?.address===USDC&&typeof p.pairAddress==='string'&&typeof p.priceUsd==='string'&&/^(0|[1-9]\d*)(\.\d+)?$/.test(p.priceUsd)&&new Decimal(p.priceUsd).isFinite()&&new Decimal(p.priceUsd).gt(0)&&typeof p.liquidity?.usd==='number'&&Number.isFinite(p.liquidity.usd)&&p.liquidity.usd>=0).sort((a,b)=>new Decimal(b.liquidity.usd).cmp(a.liquidity.usd)||a.pairAddress.localeCompare(b.pairAddress));
  if(!eligible.length)return missing('ROUTE_COST_PRICE_UNAVAILABLE');const price=eligible[0],setup=nativeSetup(c);if(fees[0]!+fees[1]!<setup.fee)return missing('ROUTE_COST_FEE_CONSERVATIVE_BOUND');
  const solUsd=new Decimal(price.priceUsd),quoteUsd=new Decimal(c.entry.quoteUsdReference),entryExternal=new Decimal((fees[0]!+setup.retained).toString()).div(1e9).mul(solUsd),exitExternal=new Decimal(fees[1]!.toString()).div(1e9).mul(solUsd),total=new Decimal(profile.sizeUsd!).add(entryExternal),net=new Decimal((BigInt(c.exit.outputAtomic)+BigInt(c.entry.unspentAtomic)).toString()).div(1e8).mul(quoteUsd).sub(exitExternal),loss=Decimal.max(0,new Decimal(1).sub(net.div(total)).mul(10000));
  const bank=parse(deps['entry-route-bank'])!.result.value,B=Buffer.from(bank[3].data[0],'base64').readBigUInt64LE(64),Q=Buffer.from(bank[4].data[0],'base64').readBigUInt64LE(64),A=BigInt(c.entry.acquiredAtomic),V=BigInt(c.pool.virtualQuoteReserves.toString()),numerator=(Q+V)*A,denominator=B-A;if(denominator<=0n)return missing('ROUTE_COST_QUOTE_UNAVAILABLE');const core=(numerator+denominator-1n)/denominator,embedded=BigInt(c.entry.actualDebitAtomic)-core+BigInt(c.exit.embeddedFeeAtomic);if(embedded<0n)return missing('ROUTE_COST_QUOTE_UNAVAILABLE');
  const availableAt=capture.records.at(-1)!.availableAt,expiresAt=new Date(Math.min(time(c.entry.expiresAt),time(c.simulation.expiresAt),...capture.records.map(e=>time(e.availableAt)+30_000))).toISOString();if(time(cutoff)>time(c.provenanceExpires))return missing('ROUTE_COST_PROVENANCE_EXPIRED');
  return {quality:time(cutoff)>time(expiresAt)?'STALE':'KNOWN',method:ROUTE_COST_METHOD,benchmarkMethod:'INDEPENDENT_QUOTES',feeProofLevel:'QUOTED',setupProofLevel:'SIMULATED',token,pool:c.entry.pool,subject:c.simulation.subject,quantityAtomic:c.entry.acquiredAtomic,quoteMint:c.entry.quoteMint,entryFeeLamports:fees[0]!.toString(),exitFeeLamports:fees[1]!.toString(),atomicSimulationFeeLamports:setup.fee.toString(),retainedNativeSetupDebitLamports:setup.retained.toString(),retainedSetupDeposits:setup.deposits,solUsdReference:price.priceUsd,solPricePair:price.pairAddress,quoteUsdReference:c.entry.quoteUsdReference,entryExternalCostUsd:entryExternal.toFixed(),exitExternalCostUsd:exitExternal.toFixed(),totalEntryCostUsd:total.toFixed(),netExitUsd:net.toFixed(),roundTripLossBps:loss.toFixed(),embeddedFeesUsd:new Decimal(embedded.toString()).div(1e8).mul(quoteUsd).toFixed(),costsReconciled:true,availableAt,expiresAt,limitations:LIMITATIONS};
 }catch(e){if(e instanceof Unavailable)return missing(e.message);throw e;}
}
/** Three typed operations share at most three actual transport attempts, including retries. */
export async function collectRouteCosts(token:TokenRef,profile:Profile,dependencies:Record<string,string>,evidence:EvidenceRecord[],rpcUrl:string,fetcher:typeof fetch,now:()=>string,signal:AbortSignal):Promise<RouteCostCapture>{
 const capture:RouteCostCapture={records:[],rawArtifacts:{}};let c:ReturnType<typeof context>;try{c=context(token,profile,dependencies,evidence);}catch(e){if(e instanceof Unavailable)return capture;throw e;}if(!c||time(now())>Math.min(time(c.entry.expiresAt),time(c.simulation.expiresAt),time(c.provenanceExpires)))return capture;
 let attempts=0;const bounded:typeof fetch=(url,init)=>{if(attempts>=3)throw Error('ROUTE_COST_REQUEST_CAP');attempts++;return fetcher(url,init);};
 for(const [i,request]of requests(c).entries()){let raw:string;try{const price='url'in request,response=await fetchReadResponse(price?request.url:rpcUrl,price?{redirect:'error',credentials:'omit',signal}:{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,...request}),signal},bounded,8000);raw=await readLimitedText(response,price?2_000_000:64_000);if(response.status!==200||response.redirected)raw=JSON.stringify({error:'ROUTE_COST_HTTP_FAILED'});}catch{raw=JSON.stringify({error:'ROUTE_COST_READ_FAILED'});}const id=IDS[i]!;capture.rawArtifacts[id]=raw;capture.records.push(record(id,raw,now(),dependencies,request));}
 return capture;
}
export function finishRouteCosts(token:TokenRef,profile:Profile,cutoff:string,dependencies:Record<string,string>,evidence:EvidenceRecord[],capture:RouteCostCapture):{capture:RouteCostCapture;assessments:BaselineAssessment[]}{
 const facts=reconstruct(token,profile,cutoff,dependencies,evidence,capture),raw=JSON.stringify(facts),derived=record(DERIVED,raw,cutoff,dependencies),ids=[...capture.records.map(e=>e.id),DERIVED];
 const assessments:BaselineAssessment[]=facts.quality==='MISSING'?[]:['O15','O16'].map(id=>({id,version:'baseline-v1',evaluator:'IMPLEMENTED',collector:'IMPLEMENTED',quality:facts.quality,unit:id==='O15'?'bps':'bool',data:facts,observationIds:[],evidenceIds:ids,limitations:LIMITATIONS,causes:[],projection:{id,value:id==='O15'?facts.roundTripLossBps:true,unit:id==='O15'?'bps':'bool',quality:facts.quality,availableAt:cutoff,evidenceIds:ids,applicability:'APPLICABLE'}}));
 return {capture:{records:[...capture.records,derived],rawArtifacts:{...capture.rawArtifacts,[DERIVED]:raw}},assessments};
}
export function hasRouteCosts(b:{evidence:EvidenceRecord[];rawArtifacts?:Record<string,string>;details?:{baseline:BaselineAssessment[]}}):boolean{return b.evidence.some(e=>e.id.startsWith(PREFIX)||e.adapterVersion===ROUTE_COST_METHOD||[RPC_SOURCE,PRICE_SOURCE,DERIVED_SOURCE].includes(e.sourceId))||Object.keys(b.rawArtifacts??{}).some(id=>id.startsWith(PREFIX))||!!b.details?.baseline.some(a=>(a.data as {method?:string}|null)?.method===ROUTE_COST_METHOD);}
export function validateRouteCostBundle(b:LiveBundle):BaselineAssessment[]{
 const owned=b.evidence.filter(e=>e.id.startsWith(PREFIX)||e.adapterVersion===ROUTE_COST_METHOD||[RPC_SOURCE,PRICE_SOURCE,DERIVED_SOURCE].includes(e.sourceId)),rawIds=Object.keys(b.rawArtifacts).filter(id=>id.startsWith(PREFIX));if(!hasRouteCosts(b)&&!b.features.some(f=>f.evidenceIds.some(id=>id.startsWith(PREFIX))))return [];
 if(!owned.some(e=>e.id===DERIVED)||owned.length!==rawIds.length||new Set(owned.map(e=>e.id)).size!==owned.length||owned.some(e=>!rawIds.includes(e.id)))bad();
 const upstream=[validateEntryRouteBundle(b),validateExitRouteBundle(b),validateSimulationRouteBundle(b)];
 const finished=finishRouteCosts(b.token,b.profile,b.cutoff,b.rawArtifacts,b.evidence,{records:owned.filter(e=>e.id!==DERIVED),rawArtifacts:Object.fromEntries(rawIds.filter(id=>id!==DERIVED).map(id=>[id,b.rawArtifacts[id]!]))});
 if(finished.assessments.length&&upstream.some(a=>!a))bad();
 if(!isDeepStrictEqual(owned.find(e=>e.id===DERIVED),finished.capture.records.at(-1))||b.rawArtifacts[DERIVED]!==finished.capture.rawArtifacts[DERIVED])bad();
 const ownIds=new Set(owned.map(e=>e.id));for(const id of ['O15','O16']){const expected=finished.assessments.find(a=>a.id===id),a=b.details?.baseline.find(a=>a.id===id),f=b.features.find(f=>f.id===id);if(expected&&(!isDeepStrictEqual(a,expected)||!isDeepStrictEqual(f,expected.projection)))bad();if(!expected&&((a?.data as {method?:string}|null)?.method===ROUTE_COST_METHOD||f?.evidenceIds.some(id=>ownIds.has(id))))bad();}
 if(b.details?.baseline.some(a=>!['O15','O16'].includes(a.id)&&a.evidenceIds.some(id=>ownIds.has(id)))||b.features.some(f=>!['O15','O16'].includes(f.id)&&f.evidenceIds.some(id=>ownIds.has(id)))||b.observations.some(o=>o.evidenceIds.some(id=>ownIds.has(id))))bad();return finished.assessments;
}
