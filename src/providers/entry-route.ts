import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import BN from 'bn.js';
import {Decimal} from 'decimal.js';
import {PublicKey,type AccountInfo} from '@solana/web3.js';
import {AccountLayout,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {PUMP_AMM_SDK,PUMP_AMM_PROGRAM_ID,PUMP_FEE_PROGRAM_ID,GLOBAL_CONFIG_PDA,PUMP_AMM_FEE_CONFIG_PDA,pumpPoolAuthorityPda,poolPda,buyQuoteInput,buyBaseInput,computeFeesBps} from '@pump-fun/pump-swap-sdk';
import type {EvidenceRecord,LiveBundle,Profile,TokenRef} from '../domain/contracts.js';
import type {BaselineAssessment} from '../domain/baseline.js';
import {quoteAdmission,validateVaultData} from './advisory-exit-capacity-custom.js';
import {fetchReadResponse,readLimitedText} from './http.js';
import {SOLANA_MAINNET_GENESIS} from './solana.js';

/** A separate, explicit QUOTED O10 witness. No exit, simulation, wallet or external-cost authority. */
export const ENTRY_ROUTE_METHOD='canonical-wbtc-pump-entry-v1';
export const ENTRY_ROUTE_PREFIX='entry-route-';
export const ENTRY_ROUTE_QUOTE='3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh';
const USD_URL='https://api.dexscreener.com/tokens/v1/solana/'+ENTRY_ROUTE_QUOTE;
const IDS=['entry-route-genesis','entry-route-bank','entry-route-usd'] as const;
const DERIVED='entry-route-derivation',RPC_SOURCE='entry-route-rpc',USD_SOURCE='entry-route-market',DERIVED_SOURCE='entry-route-derived';
const PROGRAMS=[TOKEN_PROGRAM_ID.toBase58(),TOKEN_2022_PROGRAM_ID.toBase58()];
const CASH=['So11111111111111111111111111111111111111112','EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v','Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'];
const LIMITATIONS=['QUOTED canonical WBTC PumpSwap entry only; assumes an ordinary funded WBTC source account. No wallet availability, simulation, signing, broadcast or guaranteed fill.', 'USD is a contemporaneous DEX provider reference, not executable fiat conversion. Quote rounding leaves the disclosed unspent balance.', 'No exit, impact-limit approval, network/setup/priority cost or future token/program safety conclusion. Only current ordinary transfers and the pinned static fee schedule are supported.'];
type Request={method:string;params:unknown[]}|{url:string};
export type EntryRouteCapture={records:EvidenceRecord[];rawArtifacts:Record<string,string>};
type Quote={quality:'KNOWN'|'STALE';method:typeof ENTRY_ROUTE_METHOD;level:'QUOTED';token:TokenRef;pool:string;quoteMint:string;quoteDecimals:number;baseDecimals:number;stateSlot:number;availableAt:string;expiresAt:string;inputUsd:string;quoteUsdReference:string;pricePair:string;budgetAtomic:string;actualDebitAtomic:string;unspentAtomic:string;acquiredAtomic:string;feesBps:{lp:string;protocol:string;creator:string};limitations:string[]};
export type EntryRouteFacts=Quote|{quality:'MISSING';method:typeof ENTRY_ROUTE_METHOD;reasonCode:string;limitations:string[]};
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const bad=():never=>{throw Error('ENTRY_ROUTE_PROOF_INVALID');};
const missing=(reasonCode:string):EntryRouteFacts=>({quality:'MISSING',method:ENTRY_ROUTE_METHOD,reasonCode,limitations:LIMITATIONS});
const parse=(s:string|undefined):any=>{try{return JSON.parse(s??'null');}catch{return null;}};
function context(token:TokenRef,raw:Record<string,string>,cutoff:string,requireCurrent=true){
 const p=parse(raw['venue-provenance-record']),a=parse(raw['rpc-account']),mint=new PublicKey(token.address),quote=new PublicKey(ENTRY_ROUTE_QUOTE),program=a?.result?.value?.owner;
 if(token.chain!=='solana'||!p?.bindingVerified||p.token?.address!==token.address||p.poolAddress!==poolPda(0,pumpPoolAuthorityPda(mint),mint,quote).toBase58()||p.lifecycle?.quoteMint!==ENTRY_ROUTE_QUOTE||!PROGRAMS.includes(program)||!Number.isSafeInteger(p.lifecycle?.stateSlot)||!Number.isSafeInteger(a?.result?.context?.slot)||!Number.isFinite(Date.parse(p.availableAt))||!Number.isFinite(Date.parse(p.expiresAt))||Date.parse(p.availableAt)>Date.parse(cutoff)||requireCurrent&&Date.parse(p.expiresAt)<Date.parse(cutoff))throw Error('ENTRY_ROUTE_CANONICAL_PROVENANCE_REQUIRED');
 const pool=new PublicKey(p.poolAddress),baseVault=getAssociatedTokenAddressSync(mint,pool,true,new PublicKey(program)),quoteVault=getAssociatedTokenAddressSync(quote,pool,true,TOKEN_PROGRAM_ID);
 return {pool,mint,quote,program,expiresAt:p.expiresAt as string,floor:Math.max(p.lifecycle.stateSlot,a.result.context.slot),keys:[pool.toBase58(),mint.toBase58(),quote.toBase58(),baseVault.toBase58(),quoteVault.toBase58(),GLOBAL_CONFIG_PDA.toBase58(),PUMP_AMM_FEE_CONFIG_PDA.toBase58()]};
}
function requests(c:ReturnType<typeof context>):Request[]{return [{method:'getGenesisHash',params:[]},{method:'getMultipleAccounts',params:[c.keys,{encoding:'base64',commitment:'finalized',minContextSlot:c.floor}]},{url:USD_URL}];}
function record(id:string,raw:string,at:string,req:Request):EvidenceRecord{return {id,sourceId:id===DERIVED?DERIVED_SOURCE:'url' in req?USD_SOURCE:RPC_SOURCE,sourceType:id===DERIVED?'CALCULATION':'url' in req?'PUBLIC_MARKET':'JSON_RPC',accessMode:id===DERIVED?'LOCAL_DERIVED':'PUBLIC_API',adapterVersion:ENTRY_ROUTE_METHOD,scope:id===DERIVED?{method:ENTRY_ROUTE_METHOD}:{method:ENTRY_ROUTE_METHOD,request:req},retrievedAt:at,availableAt:at,contentHash:sha(raw)};}
/** At most two RPC reads and one credential-free public read; no existing request pool is consumed. */
export async function collectEntryRoute(token:TokenRef,profile:Profile,dependencies:Record<string,string>,rpcUrl:string,fetcher:typeof fetch,now:()=>string,signal:AbortSignal):Promise<EntryRouteCapture>{
 const out:EntryRouteCapture={records:[],rawArtifacts:{}};let c:ReturnType<typeof context>;let attempts=0;
 const bounded:typeof fetch=(url,init)=>{if(attempts>=3)throw Error('ENTRY_ROUTE_REQUEST_CAP');attempts++;return fetcher(url,init);};
 try{c=context(token,dependencies,now());}catch{return out;}
 for(const [i,req]of requests(c).entries()){
  let raw:string;
  try{const isUrl='url' in req,r=await fetchReadResponse(isUrl?req.url:rpcUrl,isUrl?{redirect:'error',credentials:'omit',signal}:{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,...req}),signal},bounded,8000);raw=await readLimitedText(r,isUrl?2_000_000:64_000);if(r.status!==200||r.redirected)raw=JSON.stringify({error:'ENTRY_ROUTE_HTTP_FAILED'});}catch{raw=JSON.stringify({error:'ENTRY_ROUTE_READ_FAILED'});}
  const id=IDS[i]!;out.rawArtifacts[id]=raw;out.records.push(record(id,raw,now(),req));
 }
 return out;
}
function account(v:any):AccountInfo<Buffer>{
 if(!v||typeof v.owner!=='string'||v.executable!==false||!Number.isSafeInteger(v.lamports)||v.lamports<0||!Array.isArray(v.data)||v.data.length!==2||v.data[1]!=='base64'||typeof v.data[0]!=='string')bad();
 const data=Buffer.from(v.data[0],'base64');if(data.toString('base64')!==v.data[0])bad();return {owner:new PublicKey(v.owner),executable:false,lamports:v.lamports,data,rentEpoch:0};
}
export function reconstructEntryRoute(token:TokenRef,profile:Profile,cutoff:string,dependencies:Record<string,string>,capture:EntryRouteCapture):EntryRouteFacts{
 const c=context(token,dependencies,cutoff,false),reqs=requests(c),cut=Date.parse(cutoff);
 if(capture.records.length!==3||Object.keys(capture.rawArtifacts).length!==3||new Set(capture.records.map(e=>e.id)).size!==3)bad();
 for(const [i,id]of IDS.entries()){
  const e=capture.records.find(e=>e.id===id),raw=capture.rawArtifacts[id];if(!e||typeof raw!=='string'||!isDeepStrictEqual(e,record(id,raw,e.availableAt,reqs[i]!))||!Number.isFinite(Date.parse(e.availableAt))||Date.parse(e.availableAt)>cut||Buffer.byteLength(raw)>(i===2?2_000_000:64_000))bad();
 }
 for(let i=1;i<IDS.length;i++)if(Date.parse(capture.records.find(e=>e.id===IDS[i])!.availableAt)<Date.parse(capture.records.find(e=>e.id===IDS[i-1])!.availableAt))bad();
 if(cut>Date.parse(c.expiresAt))return missing('ENTRY_ROUTE_PROVENANCE_EXPIRED');
 const g=parse(capture.rawArtifacts[IDS[0]]),b=parse(capture.rawArtifacts[IDS[1]]),prices=parse(capture.rawArtifacts[IDS[2]]);
 if(g?.error||b?.error||!Array.isArray(prices))return missing('ENTRY_ROUTE_SOURCE_UNAVAILABLE');
 if(g?.jsonrpc!=='2.0'||g.id!==1||g.result!==SOLANA_MAINNET_GENESIS||b?.jsonrpc!=='2.0'||b.id!==1||!Number.isSafeInteger(b.result?.context?.slot)||b.result.context.slot<c.floor||!Array.isArray(b.result?.value)||b.result.value.length!==c.keys.length)bad();
 if(b.result.value.some((v:any)=>v===null))return missing('ENTRY_ROUTE_BANK_INCOMPLETE');
 try{
  const [pa,ma,qa,ba,qva,ga,fa]=b.result.value.map(account) as AccountInfo<Buffer>[];
  if(!pa!.owner.equals(PUMP_AMM_PROGRAM_ID)||!ga!.owner.equals(PUMP_AMM_PROGRAM_ID)||!fa!.owner.equals(PUMP_FEE_PROGRAM_ID)||ma!.owner.toBase58()!==c.program||!qa!.owner.equals(TOKEN_PROGRAM_ID))bad();
  const p=PUMP_AMM_SDK.decodePool(pa!),global=PUMP_AMM_SDK.decodeGlobalConfig(ga!),fee=PUMP_AMM_SDK.decodeFeeConfig(fa!),base=quoteAdmission(ma!),quote=quoteAdmission(qa!);
  if(pa!.data.length!==301||p.index!==0||!p.creator.equals(pumpPoolAuthorityPda(c.mint))||!p.baseMint.equals(c.mint)||!p.quoteMint.equals(c.quote)||!p.poolBaseTokenAccount.equals(new PublicKey(c.keys[3]!))||!p.poolQuoteTokenAccount.equals(new PublicKey(c.keys[4]!))||quote.mint.decimals!==8)bad();
  if(p.isMayhemMode||p.isCashbackCoin||global.disableFlags&8)return missing('ENTRY_ROUTE_MODE_UNSUPPORTED');
  const vault=(a:AccountInfo<Buffer>,mint:PublicKey,program:PublicKey,adm:ReturnType<typeof quoteAdmission>)=>{if(!a.owner.equals(program))bad();validateVaultData(a,adm);const v=AccountLayout.decode(a.data);if(!v.mint.equals(mint)||!v.owner.equals(c.pool)||v.state!==1||v.delegateOption||v.closeAuthorityOption)bad();return v.amount;};
  const B=vault(ba!,c.mint,ma!.owner,base),Q=vault(qva!,c.quote,TOKEN_PROGRAM_ID,quote);
  if(B===0n||Q===0n||base.mint.supply<B||p.virtualQuoteReserves.isNeg())return missing('ENTRY_ROUTE_RESERVES_UNAVAILABLE');
  const eligible=prices.filter((p:any)=>p?.chainId==='solana'&&p.baseToken?.address===ENTRY_ROUTE_QUOTE&&CASH.includes(p.quoteToken?.address)&&typeof p.pairAddress==='string'&&typeof p.priceUsd==='string'&&/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(p.priceUsd)&&new Decimal(p.priceUsd).gt(0)&&typeof p.liquidity?.usd==='number'&&Number.isFinite(p.liquidity.usd)&&p.liquidity.usd>=0).sort((a:any,b:any)=>new Decimal(b.liquidity.usd).cmp(a.liquidity.usd)||a.pairAddress.localeCompare(b.pairAddress));
  if(!eligible.length||!profile.sizeUsd)return missing('ENTRY_ROUTE_USD_OR_SIZE_UNAVAILABLE');
  const usd=eligible[0].priceUsd,budget=new BN(new Decimal(profile.sizeUsd).div(usd).mul(100_000_000).floor().toFixed());
  if(budget.lte(new BN(0))||budget.gt(new BN('18446744073709551615')))return missing('ENTRY_ROUTE_SIZE_UNAVAILABLE');
  const args={slippage:0,baseReserve:new BN(B.toString()),quoteReserve:new BN(Q.toString()),virtualQuoteReserves:p.virtualQuoteReserves,globalConfig:global,baseMintAccount:base.mint,baseMint:c.mint,coinCreator:p.coinCreator,creator:p.creator,feeConfig:fee,quoteMint:c.quote,isMayhemMode:false,creatorFeeBps:p.creatorFeeBps},buy=buyQuoteInput({...args,quote:budget}),actual=buyBaseInput({...args,base:buy.base});
  if(buy.base.lte(new BN(0))||buy.base.gt(new BN(B.toString()))||actual.uiQuote.lte(new BN(0))||actual.uiQuote.gt(budget))return missing('ENTRY_ROUTE_BUDGET_UNQUOTABLE');
  const rates=computeFeesBps({...args,baseMintSupply:new BN(base.mint.supply.toString()),quoteReserve:args.quoteReserve.add(p.virtualQuoteReserves)}),stateAt=capture.records.find(e=>e.id===IDS[1])!.availableAt,priceAt=capture.records.find(e=>e.id===IDS[2])!.availableAt,availableAt=new Date(Math.max(Date.parse(stateAt),Date.parse(priceAt))).toISOString(),expiresAt=new Date(Math.min(Date.parse(stateAt),Date.parse(priceAt))+30_000).toISOString();
  return {quality:cut>Date.parse(expiresAt)?'STALE':'KNOWN',method:ENTRY_ROUTE_METHOD,level:'QUOTED',token,pool:c.pool.toBase58(),quoteMint:ENTRY_ROUTE_QUOTE,quoteDecimals:8,baseDecimals:base.mint.decimals,stateSlot:b.result.context.slot,availableAt,expiresAt,inputUsd:profile.sizeUsd,quoteUsdReference:usd,pricePair:eligible[0].pairAddress,budgetAtomic:budget.toString(),actualDebitAtomic:actual.uiQuote.toString(),unspentAtomic:budget.sub(actual.uiQuote).toString(),acquiredAtomic:buy.base.toString(),feesBps:{lp:rates.lpFeeBps.toString(),protocol:rates.protocolFeeBps.toString(),creator:p.coinCreator.equals(PublicKey.default)?'0':rates.creatorFeeBps.toString()},limitations:LIMITATIONS};
 }catch(e){if(e instanceof Error&&e.message==='ENTRY_ROUTE_PROOF_INVALID')throw e;return missing('ENTRY_ROUTE_UNSUPPORTED_OR_INVALID');}
}
export function entryRouteAssessment(facts:EntryRouteFacts,cutoff:string,ids:string[]):BaselineAssessment|null{
 if(facts.quality==='MISSING')return null;
 return {id:'O10',version:'baseline-v1',evaluator:'IMPLEMENTED',collector:'IMPLEMENTED',quality:facts.quality,unit:'scoped-record',data:facts,observationIds:[],evidenceIds:ids,limitations:LIMITATIONS,causes:[],projection:{id:'O10',value:true,unit:'bool',quality:facts.quality,availableAt:cutoff,evidenceIds:ids,applicability:'APPLICABLE'}};
}
export function finishEntryRoute(token:TokenRef,profile:Profile,cutoff:string,dependencies:Record<string,string>,capture:EntryRouteCapture):{capture:EntryRouteCapture;assessment:BaselineAssessment|null}{
 const facts=reconstructEntryRoute(token,profile,cutoff,dependencies,capture),raw=JSON.stringify(facts),derived=record(DERIVED,raw,cutoff,{url:''});return {capture:{records:[...capture.records,derived],rawArtifacts:{...capture.rawArtifacts,[DERIVED]:raw}},assessment:entryRouteAssessment(facts,cutoff,[...IDS,DERIVED])};
}
/** Reconstruct first; the caller may then authorize only this exact O10 assessment in the independent O08 guard. */
export function hasEntryRoute(b:{evidence:EvidenceRecord[];rawArtifacts?:Record<string,string>;details?:{baseline:BaselineAssessment[]}}):boolean{return b.evidence.some(e=>e.id.startsWith(ENTRY_ROUTE_PREFIX)||e.adapterVersion===ENTRY_ROUTE_METHOD||[RPC_SOURCE,USD_SOURCE,DERIVED_SOURCE].includes(e.sourceId))||Object.keys(b.rawArtifacts??{}).some(id=>id.startsWith(ENTRY_ROUTE_PREFIX))||!!b.details?.baseline.some(a=>(a.data as {method?:string}|null)?.method===ENTRY_ROUTE_METHOD);}
export function validateEntryRouteBundle(b:LiveBundle):BaselineAssessment|null{
 const owned=b.evidence.filter(e=>e.id.startsWith(ENTRY_ROUTE_PREFIX)||[RPC_SOURCE,USD_SOURCE,DERIVED_SOURCE].includes(e.sourceId)||e.adapterVersion===ENTRY_ROUTE_METHOD),rawIds=Object.keys(b.rawArtifacts).filter(id=>id.startsWith(ENTRY_ROUTE_PREFIX)),marked=b.details?.baseline.some(a=>(a.data as {method?:string}|null)?.method===ENTRY_ROUTE_METHOD)||b.features.some(f=>f.evidenceIds.some(id=>id.startsWith(ENTRY_ROUTE_PREFIX)));
 if(!owned.length&&!rawIds.length&&!marked)return null;
 if(owned.length!==4||rawIds.length!==4||!isDeepStrictEqual([...owned.map(e=>e.id)].sort(),[...IDS,DERIVED].sort()))bad();
 const capture={records:owned.filter(e=>e.id!==DERIVED),rawArtifacts:Object.fromEntries(IDS.map(id=>[id,b.rawArtifacts[id]!]))},finished=finishEntryRoute(b.token,b.profile,b.cutoff,b.rawArtifacts,capture),derived=owned.find(e=>e.id===DERIVED)!;
 if(!isDeepStrictEqual(derived,finished.capture.records.at(-1))||b.rawArtifacts[DERIVED]!==finished.capture.rawArtifacts[DERIVED])bad();
 const actual=b.details?.baseline.find(a=>a.id==='O10'),f=b.features.find(f=>f.id==='O10');
 if(finished.assessment&&(!isDeepStrictEqual(actual,finished.assessment)||!isDeepStrictEqual(f,finished.assessment.projection)))bad();
 const ownedIds=new Set(owned.map(e=>e.id));
 if(b.details?.baseline.some(a=>a.id!=='O10'&&a.evidenceIds.some(id=>ownedIds.has(id)))||b.features.some(f=>f.id!=='O10'&&f.evidenceIds.some(id=>ownedIds.has(id)))||b.observations.some(o=>o.evidenceIds.some(id=>ownedIds.has(id))))bad();
 if(!finished.assessment&&((actual?.data as {method?:string}|null)?.method===ENTRY_ROUTE_METHOD||f?.evidenceIds.some(id=>ownedIds.has(id))))bad();
 return finished.assessment;
}
