import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import BN from 'bn.js';
import {Decimal} from 'decimal.js';
import {PublicKey,type AccountInfo} from '@solana/web3.js';
import {AccountLayout} from '@solana/spl-token';
import {PUMP_AMM_SDK,sellBaseInput} from '@pump-fun/pump-swap-sdk';
import type {EvidenceRecord,LiveBundle,Profile,TokenRef} from '../domain/contracts.js';
import type {BaselineAssessment} from '../domain/baseline.js';
import {reconstructEntryRoute,validateEntryRouteBundle} from './entry-route.js';
import {quoteAdmission} from './advisory-exit-capacity-custom.js';

export const EXIT_ROUTE_METHOD='canonical-wbtc-pump-exit-v1';
const ID='exit-route-derivation',SOURCE='exit-route-derived';
const LIMITATIONS=['QUOTED independent exit of exactly the O10 acquired quantity against the same captured pre-entry bank; not a sequential post-buy execution or a future fill guarantee.', 'Assumes ordinary unrestricted source and WBTC destination accounts. No wallet availability, simulation, signing or broadcast.', 'Net WBTC includes pinned pool trading fees only. USD is the O10 provider reference; unspent entry WBTC is separate. No impact-limit approval or network/setup/priority/full-cost conclusion.'];
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const bad=():never=>{throw Error('EXIT_ROUTE_PROOF_INVALID');};
type ExitQuote={quality:'KNOWN'|'STALE';method:typeof EXIT_ROUTE_METHOD;level:'QUOTED';stateModel:'INDEPENDENT_QUOTES';token:TokenRef;pool:string;stateSlot:number;availableAt:string;expiresAt:string;quantityAtomic:string;quoteMint:string;quoteDecimals:number;grossOutputAtomic:string;outputAtomic:string;embeddedFeeAtomic:string;outputUsd:string;quoteUsdReference:string;unspentEntryAtomic:string;limitations:string[]};
export type ExitRouteFacts=ExitQuote|{quality:'MISSING';method:typeof EXIT_ROUTE_METHOD;reasonCode:string;limitations:string[]};
const missing=(reasonCode:string):ExitRouteFacts=>({quality:'MISSING',method:EXIT_ROUTE_METHOD,reasonCode,limitations:LIMITATIONS});
/** Admission and entry arithmetic remain owned by the unchanged O10-v1 reconstruction. */
export function reconstructExitRoute(token:TokenRef,profile:Profile,cutoff:string,raw:Record<string,string>,evidence:EvidenceRecord[]):ExitRouteFacts{
 const records=evidence.filter(e=>e.id.startsWith('entry-route-')&&e.id!=='entry-route-derivation');
 if(!records.length)return missing('EXIT_ROUTE_ENTRY_UNAVAILABLE');
 const entry=reconstructEntryRoute(token,profile,cutoff,raw,{records,rawArtifacts:Object.fromEntries(records.map(e=>[e.id,raw[e.id]!]))});
 if(entry.quality==='MISSING')return missing('EXIT_ROUTE_ENTRY_UNAVAILABLE');
 const values=JSON.parse(raw['entry-route-bank']!).result.value;
 const accounts=values.map((v:any):AccountInfo<Buffer>=>({owner:new PublicKey(v.owner),data:Buffer.from(v.data[0],'base64'),executable:v.executable,lamports:v.lamports,rentEpoch:0}));
 const [poolAccount,mintAccount,,baseVault,quoteVault,globalAccount,feeAccount]=accounts as AccountInfo<Buffer>[];
 const pool=PUMP_AMM_SDK.decodePool(poolAccount!),global=PUMP_AMM_SDK.decodeGlobalConfig(globalAccount!);
 if(global.disableFlags&16)return missing('EXIT_ROUTE_SELL_DISABLED');
 try{
  const base=quoteAdmission(mintAccount!),B=new BN(AccountLayout.decode(baseVault!.data).amount.toString()),Q=new BN(AccountLayout.decode(quoteVault!.data).amount.toString());
  const sell=sellBaseInput({base:new BN(entry.acquiredAtomic),slippage:0,baseReserve:B,quoteReserve:Q,virtualQuoteReserves:pool.virtualQuoteReserves,globalConfig:global,baseMintAccount:base.mint,baseMint:new PublicKey(token.address),coinCreator:pool.coinCreator,creator:pool.creator,feeConfig:PUMP_AMM_SDK.decodeFeeConfig(feeAccount!),quoteMint:new PublicKey(entry.quoteMint),isMayhemMode:false,creatorFeeBps:pool.creatorFeeBps});
  // Protocol and creator fees leave the physical quote vault too; LP fees stay in it.
  const gross=sell.internalQuoteAmountOut,lp=gross.mul(new BN(entry.feesBps.lp)).addn(9999).divn(10000);
  if(sell.uiQuote.lte(new BN(0))||gross.sub(lp).gt(Q)||sell.uiQuote.gt(gross))return missing('EXIT_ROUTE_QUANTITY_UNQUOTABLE');
  return {quality:entry.quality,method:EXIT_ROUTE_METHOD,level:'QUOTED',stateModel:'INDEPENDENT_QUOTES',token,pool:entry.pool,stateSlot:entry.stateSlot,availableAt:entry.availableAt,expiresAt:entry.expiresAt,quantityAtomic:entry.acquiredAtomic,quoteMint:entry.quoteMint,quoteDecimals:entry.quoteDecimals,grossOutputAtomic:gross.toString(),outputAtomic:sell.uiQuote.toString(),embeddedFeeAtomic:gross.sub(sell.uiQuote).toString(),outputUsd:new Decimal(sell.uiQuote.toString()).div(new Decimal(10).pow(entry.quoteDecimals)).mul(entry.quoteUsdReference).toFixed(),quoteUsdReference:entry.quoteUsdReference,unspentEntryAtomic:entry.unspentAtomic,limitations:LIMITATIONS};
 }catch{return missing('EXIT_ROUTE_QUANTITY_UNQUOTABLE');}
}
export function finishExitRoute(token:TokenRef,profile:Profile,cutoff:string,raw:Record<string,string>,evidence:EvidenceRecord[]):{record:EvidenceRecord;raw:string;assessment:BaselineAssessment|null}{
 const facts=reconstructExitRoute(token,profile,cutoff,raw,evidence),body=JSON.stringify(facts);
 const dependencies=Object.keys(raw).filter(id=>id.startsWith('entry-route-')||['rpc-account','venue-provenance-record'].includes(id)).sort().map(id=>({id,contentHash:sha(raw[id]!)}));
 const record:EvidenceRecord={id:ID,sourceId:SOURCE,sourceType:'CALCULATION',accessMode:'LOCAL_DERIVED',adapterVersion:EXIT_ROUTE_METHOD,scope:{method:EXIT_ROUTE_METHOD,dependencies},retrievedAt:cutoff,availableAt:cutoff,contentHash:sha(body)};
 const assessment:BaselineAssessment|null=facts.quality==='MISSING'?null:{id:'O11',version:'baseline-v1',evaluator:'IMPLEMENTED',collector:'IMPLEMENTED',quality:facts.quality,unit:'scoped-record',data:facts,observationIds:[],evidenceIds:[ID],limitations:LIMITATIONS,causes:[],projection:{id:'O11',value:true,unit:'bool',quality:facts.quality,availableAt:cutoff,evidenceIds:[ID],applicability:'APPLICABLE'}};
 return {record,raw:body,assessment};
}
export function hasExitRoute(b:{evidence:EvidenceRecord[];rawArtifacts?:Record<string,string>;details?:{baseline:BaselineAssessment[]}}):boolean{return b.evidence.some(e=>e.id.startsWith('exit-route-')||e.sourceId===SOURCE||e.adapterVersion===EXIT_ROUTE_METHOD)||Object.keys(b.rawArtifacts??{}).some(id=>id.startsWith('exit-route-'))||!!b.details?.baseline.some(a=>(a.data as {method?:string}|null)?.method===EXIT_ROUTE_METHOD);}
export function validateExitRouteBundle(b:LiveBundle):BaselineAssessment|null{
 const owned=b.evidence.filter(e=>e.id.startsWith('exit-route-')||e.sourceId===SOURCE||e.adapterVersion===EXIT_ROUTE_METHOD),ids=Object.keys(b.rawArtifacts).filter(id=>id.startsWith('exit-route-'));
 if(!hasExitRoute(b)&&!b.features.some(f=>f.evidenceIds.some(id=>id.startsWith('exit-route-'))))return null;
 if(owned.length!==1||owned[0]!.id!==ID||ids.length!==1||ids[0]!==ID)bad();
 validateEntryRouteBundle(b);
 const result=finishExitRoute(b.token,b.profile,b.cutoff,b.rawArtifacts,b.evidence),a=b.details?.baseline.find(a=>a.id==='O11'),f=b.features.find(f=>f.id==='O11');
 if(!isDeepStrictEqual(owned[0],result.record)||b.rawArtifacts[ID]!==result.raw)bad();
 if(result.assessment&&(!isDeepStrictEqual(a,result.assessment)||!isDeepStrictEqual(f,result.assessment.projection)))bad();
 if(!result.assessment&&((a?.data as {method?:string}|null)?.method===EXIT_ROUTE_METHOD||f?.evidenceIds.includes(ID)))bad();
 if(b.details?.baseline.some(a=>a.id!=='O11'&&a.evidenceIds.includes(ID))||b.features.some(f=>f.id!=='O11'&&f.evidenceIds.includes(ID))||b.observations.some(o=>o.evidenceIds.includes(ID)))bad();
 return result.assessment;
}
