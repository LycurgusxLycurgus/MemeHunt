import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import BN from 'bn.js';
import {PublicKey,SystemProgram,TransactionInstruction,TransactionMessage,VersionedTransaction,ComputeBudgetProgram,type AccountInfo,type AccountMeta} from '@solana/web3.js';
import {AccountLayout,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction} from '@solana/spl-token';
import {PUMP_AMM_SDK,OFFLINE_PUMP_AMM_PROGRAM,PUMP_AMM_PROGRAM_ID,PUMP_FEE_PROGRAM_ID,GLOBAL_CONFIG_PDA,PUMP_AMM_FEE_CONFIG_PDA,PUMP_AMM_EVENT_AUTHORITY_PDA,GLOBAL_VOLUME_ACCUMULATOR_PDA,userVolumeAccumulatorPda,coinCreatorVaultAuthorityPda,coinCreatorVaultAtaPda,poolV2Pda} from '@pump-fun/pump-swap-sdk';
import type {TokenRef,Profile,EvidenceRecord,LiveBundle} from '../domain/contracts.js';
import type {BaselineAssessment} from '../domain/baseline.js';
import {ENTRY_ROUTE_QUOTE,reconstructEntryRoute,validateEntryRouteBundle,type EntryRouteCapture} from './entry-route.js';
import {quoteAdmission,validateVaultData} from './advisory-exit-capacity-custom.js';
import {fetchReadResponse,readLimitedText} from './http.js';

export const SIMULATION_ROUTE_METHOD='canonical-wbtc-pump-simulation-v1';
const PREFIX='simulation-route-',RPC_SOURCE='simulation-route-rpc',DERIVED_SOURCE='simulation-route-derived',DERIVED=PREFIX+'derivation';
const IDS=['largest','token-accounts','payers','setup','blockhash','result'].map(x=>PREFIX+x);
const ENTRY_IDS=['entry-route-genesis','entry-route-bank','entry-route-usd'];
const LIMITATIONS=['SIMULATED unsigned atomic buy and exact-quantity sell for an observed public simulation subject; no wallet ownership, signing, broadcast or future-fill claim.', 'The buy cap is the admitted O10 debit; sell minimum is zero solely to test the supported sell path. This is not impact or execution-price approval.', 'WBTC remains in its ordinary token account. Native fees, setup rent, full costs and O13–O16 are not certified by this O12-only witness.'];
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const bad=():never=>{throw Error('SIMULATION_ROUTE_PROOF_INVALID');};
class Unavailable extends Error{}
const unavailable=(code:string):never=>{throw new Unavailable(code);};
const parse=(raw:string):any=>{try{return JSON.parse(raw);}catch{return null;}};
const integer=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
const atomic=(n:unknown):bigint=>{const s=String(n);if(!/^(0|[1-9]\d{0,19})$/.test(s)||BigInt(s)>18446744073709551615n)return unavailable('SIMULATION_ROUTE_SOURCE_SHAPE');return BigInt(s);};
const at=(s:string)=>{const n=Date.parse(s);if(!Number.isFinite(n))bad();return n;};
type Request={method:string;params:unknown[]};
type Operation={id:string;request:Request};
export type SimulationRouteCapture={records:EvidenceRecord[];rawArtifacts:Record<string,string>};
type PositiveFacts={quality:'KNOWN'|'STALE';method:typeof SIMULATION_ROUTE_METHOD;level:'SIMULATED';token:TokenRef;pool:string;subject:string;quantityAtomic:string;spentQuoteAtomic:string;receivedQuoteAtomic:string;quoteMint:string;simulationSlot:number;availableAt:string;expiresAt:string;setupVerified:true;buySucceeded:true;sellSucceeded:true;sellMinimumAtomic:'0';wireBytes:number;limitations:string[]};
export type SimulationRouteFacts=PositiveFacts|{quality:'MISSING';method:typeof SIMULATION_ROUTE_METHOD;reasonCode:string;limitations:string[]};
const missing=(reasonCode:string):SimulationRouteFacts=>({quality:'MISSING',method:SIMULATION_ROUTE_METHOD,reasonCode,limitations:LIMITATIONS});
function dependencies(raw:Record<string,string>){return ['rpc-account','venue-provenance-record',...ENTRY_IDS].filter(id=>typeof raw[id]==='string').map(id=>({id,contentHash:sha(raw[id]!)}));}
function record(id:string,raw:string,time:string,deps:Record<string,string>,request?:Request):EvidenceRecord{return {id,sourceId:request?RPC_SOURCE:DERIVED_SOURCE,sourceType:request?'JSON_RPC':'CALCULATION',accessMode:request?'PUBLIC_API':'LOCAL_DERIVED',adapterVersion:SIMULATION_ROUTE_METHOD,scope:{method:SIMULATION_ROUTE_METHOD,dependencies:dependencies(deps),...(request?{request}:{})},retrievedAt:time,availableAt:time,contentHash:sha(raw)};}
function account(v:any):AccountInfo<Buffer>|null{
 if(v===null)return null;
 if(!v||typeof v.owner!=='string'||v.executable!==false||!integer(v.lamports)||!Array.isArray(v.data)||v.data.length!==2||v.data[1]!=='base64'||typeof v.data[0]!=='string')return unavailable('SIMULATION_ROUTE_ACCOUNT_SHAPE');
 const data=Buffer.from(v.data[0],'base64');if(data.toString('base64')!==v.data[0])return unavailable('SIMULATION_ROUTE_ACCOUNT_SHAPE');
 try{return {owner:new PublicKey(v.owner),executable:false,lamports:v.lamports,data,rentEpoch:0};}catch{return unavailable('SIMULATION_ROUTE_ACCOUNT_SHAPE');}
}
function system(a:AccountInfo<Buffer>|null):boolean{return !!a&&a.owner.equals(SystemProgram.programId)&&a.data.length===0&&a.lamports>=30_000_000;}
function tokenAccount(a:AccountInfo<Buffer>|null,mint:PublicKey,owner:PublicKey,program:PublicKey,admission?:ReturnType<typeof quoteAdmission>){
 if(!a||!a.owner.equals(program)||a.data.length<165||!admission&&a.data.length!==165)return null;
 try{if(admission)validateVaultData(a,admission);const t=AccountLayout.decode(a.data);return t.mint.equals(mint)&&t.owner.equals(owner)&&t.state===1&&!t.delegateOption&&!t.closeAuthorityOption&&!t.isNativeOption&&t.delegatedAmount===0n?t:null;}catch{return null;}
}
function resultBank(v:any,count:number,floor:number){if(!v||!integer(v.context?.slot)||v.context.slot<floor||!Array.isArray(v.value)||v.value.length!==count)return unavailable('SIMULATION_ROUTE_BANK_UNAVAILABLE');return {slot:v.context.slot as number,accounts:v.value.map(account) as Array<AccountInfo<Buffer>|null>};}
const multiple=(keys:PublicKey[],floor:number):Request=>({method:'getMultipleAccounts',params:[keys.map(k=>k.toBase58()),{encoding:'base64',commitment:'finalized',minContextSlot:floor}]});
function entryContext(token:TokenRef,profile:Profile,raw:Record<string,string>,entryCapture:EntryRouteCapture|undefined,cutoff:string){
 if(!entryCapture?.records.length)return null;
 const entryAt=new Date(Math.max(...entryCapture.records.map(e=>at(e.availableAt)))).toISOString();if(at(entryAt)>at(cutoff))bad();
 const entry=reconstructEntryRoute(token,profile,entryAt,raw,entryCapture);if(entry.quality==='MISSING')return null;
 const values=parse(entryCapture.rawArtifacts['entry-route-bank']!)?.result?.value;if(!Array.isArray(values))bad();
 const accounts=values.map(account),pool=PUMP_AMM_SDK.decodePool(accounts[0]!),global=PUMP_AMM_SDK.decodeGlobalConfig(accounts[5]!);
 if(global.disableFlags&24)return unavailable('SIMULATION_ROUTE_DISABLED');
 const base=quoteAdmission(accounts[1]!);
 return {entry,pool,global,base,program:accounts[1]!.owner,mint:new PublicKey(token.address),quote:new PublicKey(ENTRY_ROUTE_QUOTE),poolKey:new PublicKey(entry.pool),entryAt,provenanceExpires:parse(raw['venue-provenance-record']!)?.expiresAt as string};
}
export type SimulationRouteState={pool:ReturnType<typeof PUMP_AMM_SDK.decodePool>;global:ReturnType<typeof PUMP_AMM_SDK.decodeGlobalConfig>;poolKey:PublicKey;baseProgram:PublicKey;user:PublicKey;userBase:PublicKey;userQuote:PublicKey;createBase:boolean};
/** Static SDK1.20.0 ordinary-WBTC ABI. The same synchronous builder produces and revalidates every wire byte. */
export function buildSimulationRouteTransaction(state:SimulationRouteState,blockhash:string,quantityAtomic:string,maxQuoteAtomic:string):VersionedTransaction{
 const {pool,global,poolKey,baseProgram,user,userBase,userQuote}=state;
 const protocol=global.protocolFeeRecipients.find(k=>!k.equals(PublicKey.default)&&!k.equals(user)),buyback=global.buybackFeeRecipients.find(k=>!k.equals(PublicKey.default)&&!k.equals(user));
 if(!protocol||!buyback)return unavailable('SIMULATION_ROUTE_RECIPIENT_UNAVAILABLE');
 const m=(pubkey:PublicKey,isWritable=false,isSigner=false):AccountMeta=>({pubkey,isWritable,isSigner}),authority=coinCreatorVaultAuthorityPda(pool.coinCreator);
 const common=[m(poolKey,true),m(user,true,true),m(GLOBAL_CONFIG_PDA),m(pool.baseMint),m(pool.quoteMint),m(userBase,true),m(userQuote,true),m(pool.poolBaseTokenAccount,true),m(pool.poolQuoteTokenAccount,true),m(protocol),m(getAssociatedTokenAddressSync(pool.quoteMint,protocol,true,TOKEN_PROGRAM_ID),true),m(baseProgram),m(TOKEN_PROGRAM_ID),m(SystemProgram.programId),m(ASSOCIATED_TOKEN_PROGRAM_ID),m(PUMP_AMM_EVENT_AUTHORITY_PDA),m(PUMP_AMM_PROGRAM_ID),m(coinCreatorVaultAtaPda(authority,pool.quoteMint,TOKEN_PROGRAM_ID),true),m(authority)];
 const fee=[m(PUMP_AMM_FEE_CONFIG_PDA),m(PUMP_FEE_PROGRAM_ID)],remaining=[...(!pool.coinCreator.equals(PublicKey.default)?[m(poolV2Pda(pool.baseMint))]:[]),m(buyback),m(getAssociatedTokenAddressSync(pool.quoteMint,buyback,true,TOKEN_PROGRAM_ID),true)];
 const buy=new TransactionInstruction({programId:PUMP_AMM_PROGRAM_ID,keys:[...common,m(GLOBAL_VOLUME_ACCUMULATOR_PDA),m(userVolumeAccumulatorPda(user),true),...fee,...remaining],data:OFFLINE_PUMP_AMM_PROGRAM.coder.instruction.encode('buy',{baseAmountOut:new BN(quantityAtomic),maxQuoteAmountIn:new BN(maxQuoteAtomic),trackVolume:{0:true}})});
 const sell=new TransactionInstruction({programId:PUMP_AMM_PROGRAM_ID,keys:[...common,...fee,...remaining],data:OFFLINE_PUMP_AMM_PROGRAM.coder.instruction.encode('sell',{baseAmountIn:new BN(quantityAtomic),minQuoteAmountOut:new BN(0)})});
 const instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:1_400_000}),...(state.createBase?[createAssociatedTokenAccountIdempotentInstruction(user,userBase,user,pool.baseMint,baseProgram)]:[]),buy,sell];
 const tx=new VersionedTransaction(new TransactionMessage({payerKey:user,recentBlockhash:blockhash,instructions}).compileToV0Message());
 if(tx.message.addressTableLookups.length||tx.message.header.numRequiredSignatures!==1||tx.signatures.length!==1||tx.signatures[0]!.some(n=>n!==0)||tx.message.staticAccountKeys[0]!.toBase58()!==user.toBase58()||Buffer.from(tx.serialize()).length>1232)return unavailable('SIMULATION_ROUTE_WIRE_UNSUPPORTED');
 return tx;
}
function tokenBalances(entries:any,keys:PublicKey[]){
 if(!Array.isArray(entries))return unavailable('SIMULATION_ROUTE_RUNTIME_BALANCES_UNAVAILABLE');
 const out=new Map<number,{mint:string;owner:string;programId:string;decimals:number;amount:bigint}>();
 for(const e of entries){if(!e||!integer(e.accountIndex)||e.accountIndex>=keys.length||out.has(e.accountIndex)||typeof e.mint!=='string'||typeof e.owner!=='string'||typeof e.programId!=='string'||typeof e.uiTokenAmount?.amount!=='string'||!integer(e.uiTokenAmount?.decimals))return unavailable('SIMULATION_ROUTE_RUNTIME_BALANCE_MISMATCH');out.set(e.accountIndex,{mint:e.mint,owner:e.owner,programId:e.programId,decimals:e.uiTokenAmount.decimals,amount:atomic(e.uiTokenAmount.amount)});}
 return out;
}
function events(logs:any){
 if(!Array.isArray(logs))return unavailable('SIMULATION_ROUTE_LOGS_UNAVAILABLE');
 const stack:string[]=[],found:Array<{name:string;data:Record<string,any>}>=[];
 for(const line of logs){if(typeof line!=='string')return unavailable('SIMULATION_ROUTE_LOG_SCOPE');const invoke=/^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[\d+\]$/.exec(line),done=/^Program ([1-9A-HJ-NP-Za-km-z]+) (?:success|failed:)/.exec(line);if(invoke)stack.push(invoke[1]!);else if(done){if(stack.pop()!==done[1])return unavailable('SIMULATION_ROUTE_LOG_SCOPE');}else if(stack.at(-1)===PUMP_AMM_PROGRAM_ID.toBase58()&&line.startsWith('Program data: ')){let e;try{e=OFFLINE_PUMP_AMM_PROGRAM.coder.events.decode(line.slice(14));}catch{return unavailable('SIMULATION_ROUTE_LOG_SCOPE');}if(e&&['buyEvent','sellEvent'].includes(e.name))found.push(e as {name:string;data:Record<string,any>});}}
 if(stack.length||found.length!==2||found[0]!.name!=='buyEvent'||found[1]!.name!=='sellEvent')return unavailable('SIMULATION_ROUTE_EVENTS_UNAVAILABLE');return found;
}
function* proof(token:TokenRef,profile:Profile,cutoff:string,raw:Record<string,string>,entryCapture:EntryRouteCapture|undefined):Generator<Operation,SimulationRouteFacts,any>{
 const c=entryContext(token,profile,raw,entryCapture,cutoff);if(!c)return missing('SIMULATION_ROUTE_ENTRY_UNAVAILABLE');
 const largest=yield {id:IDS[0]!,request:{method:'getTokenLargestAccounts',params:[ENTRY_ROUTE_QUOTE,{commitment:'finalized'}]}};
 if(!integer(largest?.context?.slot)||!Array.isArray(largest?.value)||largest.value.length>20)return unavailable('SIMULATION_ROUTE_DISCOVERY_UNAVAILABLE');
 const seen=new Set<string>(),keys:PublicKey[]=[];
 for(const row of largest.value){if(typeof row?.address!=='string'||typeof row.amount!=='string'||seen.has(row.address)||row.decimals!==8)return unavailable('SIMULATION_ROUTE_DISCOVERY_SHAPE');atomic(row.amount);try{keys.push(new PublicKey(row.address));}catch{return unavailable('SIMULATION_ROUTE_DISCOVERY_SHAPE');}seen.add(row.address);}
 if(!keys.length)return missing('SIMULATION_ROUTE_SUBJECT_UNAVAILABLE');
 const first=resultBank(yield {id:IDS[1]!,request:multiple(keys,Math.max(c.entry.stateSlot,largest.context.slot))},keys.length,Math.max(c.entry.stateSlot,largest.context.slot));
 const candidates:Array<{user:PublicKey;quote:PublicKey}>=[],owners=new Set<string>();
 first.accounts.forEach((a,i)=>{if(!a||!a.owner.equals(TOKEN_PROGRAM_ID)||a.data.length!==165)return;const t=AccountLayout.decode(a.data),owner=t.owner.toBase58();if(!PublicKey.isOnCurve(t.owner)||owners.has(owner)||!keys[i]!.equals(getAssociatedTokenAddressSync(c.quote,t.owner))||!tokenAccount(a,c.quote,t.owner,TOKEN_PROGRAM_ID)||t.amount<BigInt(c.entry.actualDebitAtomic))return;candidates.push({user:t.owner,quote:keys[i]!});owners.add(owner);});
 if(!candidates.length)return missing('SIMULATION_ROUTE_SUBJECT_UNAVAILABLE');
 const payerBank=resultBank(yield {id:IDS[2]!,request:multiple(candidates.map(x=>x.user),first.slot)},candidates.length,first.slot),selected=candidates.find((_,i)=>system(payerBank.accounts[i]!));
 if(!selected)return missing('SIMULATION_ROUTE_SUBJECT_UNAVAILABLE');
 const userBase=getAssociatedTokenAddressSync(c.mint,selected.user,false,c.program),setup=resultBank(yield {id:IDS[3]!,request:multiple([selected.user,userBase,selected.quote],payerBank.slot)},3,payerBank.slot);
 if(!system(setup.accounts[0]!))return missing('SIMULATION_ROUTE_SETUP_UNAVAILABLE');
 const beforeQuote=tokenAccount(setup.accounts[2]!,c.quote,selected.user,TOKEN_PROGRAM_ID);if(!beforeQuote||beforeQuote.amount<BigInt(c.entry.actualDebitAtomic)||setup.accounts[1]!==null&&!tokenAccount(setup.accounts[1]!,c.mint,selected.user,c.program,c.base))return missing('SIMULATION_ROUTE_SETUP_UNAVAILABLE');
 const block=yield {id:IDS[4]!,request:{method:'getLatestBlockhash',params:[{commitment:'finalized',minContextSlot:setup.slot}]}};
 if(!integer(block?.context?.slot)||block.context.slot<setup.slot||typeof block.value?.blockhash!=='string'||!integer(block.value.lastValidBlockHeight))return unavailable('SIMULATION_ROUTE_BLOCKHASH_UNAVAILABLE');
 try{new PublicKey(block.value.blockhash);}catch{return unavailable('SIMULATION_ROUTE_BLOCKHASH_UNAVAILABLE');}
 const tx=buildSimulationRouteTransaction({pool:c.pool,global:c.global,poolKey:c.poolKey,baseProgram:c.program,user:selected.user,userBase,userQuote:selected.quote,createBase:setup.accounts[1]===null},block.value.blockhash,c.entry.acquiredAtomic,c.entry.actualDebitAtomic),wire=Buffer.from(tx.serialize());
 const sim=yield {id:IDS[5]!,request:{method:'simulateTransaction',params:[wire.toString('base64'),{encoding:'base64',sigVerify:false,replaceRecentBlockhash:true,commitment:'finalized',minContextSlot:block.context.slot,accounts:{encoding:'base64',addresses:[selected.user.toBase58(),userBase.toBase58(),selected.quote.toBase58()]},innerInstructions:true}]}};
 if(!integer(sim?.context?.slot)||sim.context.slot<block.context.slot||!sim.value)return unavailable('SIMULATION_ROUTE_RESULT_UNAVAILABLE');
 if(sim.value.err!==null)return missing('SIMULATION_ROUTE_REJECTED');
 const v=sim.value;if(!Array.isArray(v.accounts)||v.accounts.length!==3)return unavailable('SIMULATION_ROUTE_RESULT_ACCOUNTS_UNAVAILABLE');
 const returned=v.accounts.map(account),afterBase=tokenAccount(returned[1]!,c.mint,selected.user,c.program,c.base),afterQuote=tokenAccount(returned[2]!,c.quote,selected.user,TOKEN_PROGRAM_ID);
 if(!returned[0]||!returned[0].owner.equals(SystemProgram.programId)||returned[0].data.length||!afterBase||!afterQuote)return unavailable('SIMULATION_ROUTE_RESULT_ACCOUNT_MISMATCH');
 const found=events(v.logs),buy=found[0]!.data,sell=found[1]!.data,quantity=BigInt(c.entry.acquiredAtomic);
 for(const e of [buy,sell])if(String(e.user)!==selected.user.toBase58()||String(e.pool)!==c.entry.pool||String(e.userBaseTokenAccount)!==userBase.toBase58()||String(e.userQuoteTokenAccount)!==selected.quote.toBase58())return unavailable('SIMULATION_ROUTE_EVENT_BINDING');
 const spent=atomic(buy.userQuoteAmountIn),received=atomic(sell.userQuoteAmountOut),beforeBaseAmount=atomic(buy.userBaseTokenReserves),beforeQuoteAmount=atomic(buy.userQuoteTokenReserves);
 if(atomic(buy.baseAmountOut)!==quantity||atomic(sell.baseAmountIn)!==quantity||atomic(buy.maxQuoteAmountIn)!==BigInt(c.entry.actualDebitAtomic)||atomic(sell.minQuoteAmountOut)!==0n||spent<=0n||spent>BigInt(c.entry.actualDebitAtomic)||received<=0n||beforeQuoteAmount<spent||atomic(sell.userBaseTokenReserves)!==beforeBaseAmount+quantity||atomic(sell.userQuoteTokenReserves)!==beforeQuoteAmount-spent||afterBase.amount!==beforeBaseAmount||afterQuote.amount!==beforeQuoteAmount-spent+received)return unavailable('SIMULATION_ROUTE_RUNTIME_CONSERVATION');
 // Current RPC pre/post token rows corroborate event-declared runtime balances; no mutable setup-bank balance is restamped as simulation pre-state.
 const staticKeys=tx.message.staticAccountKeys,baseIndex=staticKeys.findIndex(k=>k.equals(userBase)),quoteIndex=staticKeys.findIndex(k=>k.equals(selected.quote)),pre=tokenBalances(v.preTokenBalances,staticKeys),post=tokenBalances(v.postTokenBalances,staticKeys);
 const bound=(row:ReturnType<typeof pre.get>,mint:PublicKey,program:PublicKey,decimals:number,amount:bigint)=>!!row&&row.mint===mint.toBase58()&&row.owner===selected.user.toBase58()&&row.programId===program.toBase58()&&row.decimals===decimals&&row.amount===amount;
 if(!bound(pre.get(quoteIndex),c.quote,TOKEN_PROGRAM_ID,8,beforeQuoteAmount)||!bound(post.get(quoteIndex),c.quote,TOKEN_PROGRAM_ID,8,afterQuote.amount)||!bound(post.get(baseIndex),c.mint,c.program,c.base.mint.decimals,afterBase.amount)||(pre.has(baseIndex)?!bound(pre.get(baseIndex),c.mint,c.program,c.base.mint.decimals,beforeBaseAmount):beforeBaseAmount!==0n))return unavailable('SIMULATION_ROUTE_RUNTIME_BALANCE_MISMATCH');
 if(v.loadedAddresses&&(!Array.isArray(v.loadedAddresses.writable)||!Array.isArray(v.loadedAddresses.readonly)||v.loadedAddresses.writable.length||v.loadedAddresses.readonly.length))return unavailable('SIMULATION_ROUTE_RUNTIME_BALANCE_MISMATCH');
 if(at(cutoff)>at(c.provenanceExpires))return missing('SIMULATION_ROUTE_PROVENANCE_EXPIRED');
 return {quality:at(cutoff)>at(c.entry.expiresAt)?'STALE':'KNOWN',method:SIMULATION_ROUTE_METHOD,level:'SIMULATED',token,pool:c.entry.pool,subject:selected.user.toBase58(),quantityAtomic:c.entry.acquiredAtomic,spentQuoteAtomic:spent.toString(),receivedQuoteAtomic:received.toString(),quoteMint:ENTRY_ROUTE_QUOTE,simulationSlot:sim.context.slot,availableAt:cutoff,expiresAt:c.entry.expiresAt,setupVerified:true,buySucceeded:true,sellSucceeded:true,sellMinimumAtomic:'0',wireBytes:wire.length,limitations:LIMITATIONS};
}
function evaluate(token:TokenRef,profile:Profile,cutoff:string,deps:Record<string,string>,entryCapture:EntryRouteCapture|undefined,capture:SimulationRouteCapture):{facts:SimulationRouteFacts;next?:Operation}{
 if(capture.records.length!==Object.keys(capture.rawArtifacts).length||new Set(capture.records.map(e=>e.id)).size!==capture.records.length)bad();
 let used=0,last=entryCapture?.records.length?Math.max(...entryCapture.records.map(e=>at(e.availableAt))):-Infinity;
 try{
  const g=proof(token,profile,cutoff,deps,entryCapture);let step=g.next();
  while(!step.done){const op=step.value,e=capture.records[used];if(!e){if(used!==capture.records.length)bad();return {facts:missing('SIMULATION_ROUTE_COLLECTION_INCOMPLETE'),next:op};}
   const raw=capture.rawArtifacts[e.id];if(e.id!==op.id||typeof raw!=='string'||!isDeepStrictEqual(e,record(op.id,raw,e.availableAt,deps,op.request))||at(e.availableAt)<last||at(e.availableAt)>at(cutoff)||Buffer.byteLength(raw)>(op.id===IDS[5]?2_000_000:64_000))bad();last=at(e.availableAt);used++;
   const body=parse(raw);if(!body||typeof body!=='object'||Array.isArray(body)||body.error)return unavailable('SIMULATION_ROUTE_SOURCE_UNAVAILABLE');if(body.jsonrpc!=='2.0'||body.id!==1||!('result'in body))return unavailable('SIMULATION_ROUTE_SOURCE_SHAPE');step=g.next(body.result);
  }
  if(used!==capture.records.length)bad();const facts=step.value;
  if(facts.quality!=='MISSING'){facts.availableAt=capture.records.at(-1)!.availableAt;const expiry=new Date(Math.min(at(facts.expiresAt),...capture.records.map(e=>at(e.availableAt)+30_000))).toISOString();facts.expiresAt=expiry;facts.quality=at(cutoff)>at(expiry)?'STALE':'KNOWN';}
  return {facts};
 }catch(e){if(e instanceof Unavailable){if(used!==capture.records.length)bad();return {facts:missing(e.message)};}throw e;}
}
/** Six typed RPC operations share at most eight transport attempts, including helper retries; redirects never follow. */
export async function collectSimulationRoute(token:TokenRef,profile:Profile,dependencies:Record<string,string>,entryCapture:EntryRouteCapture|undefined,rpcUrl:string,fetcher:typeof fetch,now:()=>string,signal:AbortSignal):Promise<SimulationRouteCapture>{
 const boundDependencies={...dependencies,...(entryCapture?.rawArtifacts??{})},capture:SimulationRouteCapture={records:[],rawArtifacts:{}};let attempts=0;
 const bounded:typeof fetch=(url,init)=>{if(attempts>=8)throw Error('SIMULATION_ROUTE_REQUEST_CAP');attempts++;return fetcher(url,init);};
 for(;;){const plan=evaluate(token,profile,now(),boundDependencies,entryCapture,capture);if(!plan.next)return capture;const {id,request}=plan.next;let raw:string;
  try{const response=await fetchReadResponse(rpcUrl,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,...request}),signal},bounded,8000);raw=await readLimitedText(response,id===IDS[5]?2_000_000:64_000);if(response.status!==200||response.redirected)raw=JSON.stringify({error:'SIMULATION_ROUTE_HTTP_FAILED'});}catch{raw=JSON.stringify({error:'SIMULATION_ROUTE_READ_FAILED'});}
  capture.rawArtifacts[id]=raw;capture.records.push(record(id,raw,now(),boundDependencies,request));
 }
}
export function finishSimulationRoute(token:TokenRef,profile:Profile,cutoff:string,dependencies:Record<string,string>,evidence:EvidenceRecord[],capture:SimulationRouteCapture):{capture:SimulationRouteCapture;assessment:BaselineAssessment|null}{
 const records=evidence.filter(e=>ENTRY_IDS.includes(e.id)),entryCapture:EntryRouteCapture|undefined=records.length?{records,rawArtifacts:Object.fromEntries(records.map(e=>[e.id,dependencies[e.id]!]))}:undefined;
 const {facts}=evaluate(token,profile,cutoff,dependencies,entryCapture,capture),raw=JSON.stringify(facts),derived=record(DERIVED,raw,cutoff,dependencies),ids=[...capture.records.map(e=>e.id),DERIVED];
 const assessment:BaselineAssessment|null=facts.quality==='MISSING'?null:{id:'O12',version:'baseline-v1',evaluator:'IMPLEMENTED',collector:'IMPLEMENTED',quality:facts.quality,unit:'scoped-record',data:facts,observationIds:[],evidenceIds:ids,limitations:LIMITATIONS,causes:[],projection:{id:'O12',value:true,unit:'bool',quality:facts.quality,availableAt:cutoff,evidenceIds:ids,applicability:'APPLICABLE'}};
 return {capture:{records:[...capture.records,derived],rawArtifacts:{...capture.rawArtifacts,[DERIVED]:raw}},assessment};
}
export function hasSimulationRoute(b:{evidence:EvidenceRecord[];rawArtifacts?:Record<string,string>;details?:{baseline:BaselineAssessment[]}}):boolean{return b.evidence.some(e=>e.id.startsWith(PREFIX)||e.adapterVersion===SIMULATION_ROUTE_METHOD||[RPC_SOURCE,DERIVED_SOURCE].includes(e.sourceId))||Object.keys(b.rawArtifacts??{}).some(id=>id.startsWith(PREFIX))||!!b.details?.baseline.some(a=>(a.data as {method?:string}|null)?.method===SIMULATION_ROUTE_METHOD);}
export function validateSimulationRouteBundle(b:LiveBundle):BaselineAssessment|null{
 const owned=b.evidence.filter(e=>e.id.startsWith(PREFIX)||e.adapterVersion===SIMULATION_ROUTE_METHOD||[RPC_SOURCE,DERIVED_SOURCE].includes(e.sourceId)),rawIds=Object.keys(b.rawArtifacts).filter(id=>id.startsWith(PREFIX));
 if(!hasSimulationRoute(b)&&!b.features.some(f=>f.evidenceIds.some(id=>id.startsWith(PREFIX))))return null;
 if(!owned.some(e=>e.id===DERIVED)||owned.length!==rawIds.length||new Set(owned.map(e=>e.id)).size!==owned.length||owned.some(e=>!rawIds.includes(e.id)))bad();
 validateEntryRouteBundle(b);
 const capture={records:owned.filter(e=>e.id!==DERIVED),rawArtifacts:Object.fromEntries(rawIds.filter(id=>id!==DERIVED).map(id=>[id,b.rawArtifacts[id]!]))},finished=finishSimulationRoute(b.token,b.profile,b.cutoff,b.rawArtifacts,b.evidence,capture);
 if(!isDeepStrictEqual(owned.find(e=>e.id===DERIVED),finished.capture.records.at(-1))||b.rawArtifacts[DERIVED]!==finished.capture.rawArtifacts[DERIVED])bad();
 const a=b.details?.baseline.find(a=>a.id==='O12'),f=b.features.find(f=>f.id==='O12'),ownIds=new Set(owned.map(e=>e.id));
 if(finished.assessment&&(!isDeepStrictEqual(a,finished.assessment)||!isDeepStrictEqual(f,finished.assessment.projection)))bad();
 if(!finished.assessment&&((a?.data as {method?:string}|null)?.method===SIMULATION_ROUTE_METHOD||f?.evidenceIds.some(id=>ownIds.has(id))))bad();
 if(b.details?.baseline.some(a=>a.id!=='O12'&&a.evidenceIds.some(id=>ownIds.has(id)))||b.features.some(f=>f.id!=='O12'&&f.evidenceIds.some(id=>ownIds.has(id)))||b.observations.some(o=>o.evidenceIds.some(id=>ownIds.has(id))))bad();
 return finished.assessment;
}
