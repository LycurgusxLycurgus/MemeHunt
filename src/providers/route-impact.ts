/** Fee-inclusive quote impact under existing baseline-v1 definitions. */
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {Decimal} from 'decimal.js';
import {AccountLayout} from '@solana/spl-token';
import {PUMP_AMM_SDK} from '@pump-fun/pump-swap-sdk';
import {PublicKey} from '@solana/web3.js';
import type {EvidenceRecord,LiveBundle,Profile,TokenRef} from '../domain/contracts.js';
import type {BaselineAssessment} from '../domain/baseline.js';
import {reconstructEntryRoute,validateEntryRouteBundle} from './entry-route.js';
import {reconstructExitRoute,validateExitRouteBundle} from './exit-route.js';

export const ROUTE_IMPACT_METHOD='canonical-wbtc-pump-impacts-v1';
const ID='impact-route-derivation',SOURCE='impact-route-derived';
const LIMITATIONS=[
 'QUOTED independent entry and exact acquired-quantity exit against the same captured pre-entry bank; no sequential execution or future fill guarantee.',
 'Preserves baseline-v1 impact definitions: entry uses requested USD size; exit includes separately disclosed unspent entry WBTC. These reference losses include embedded pool fees and rounding, not curve-only slippage.',
 'USD is the admitted O10 provider reference. No simulation, signing, broadcast, full network/setup/priority-cost reconciliation or risk-limit approval.'
];
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const bad=():never=>{throw Error('ROUTE_IMPACT_PROOF_INVALID');};
type Impact={quality:'KNOWN'|'STALE';bps:string};
type Missing={quality:'MISSING';reasonCode:string};
type Reference={pool:string;stateSlot:number;availableAt:string;expiresAt:string;requestedUsd:string;quantityAtomic:string;baseDecimals:number;quoteDecimals:number;baseReserveAtomic:string;physicalQuoteReserveAtomic:string;virtualQuoteReserveAtomic:string;quoteUsdReference:string;pricePair:string;referencePriceUsd:string;quantityTokens:string;referenceValueUsd:string;unspentEntryAtomic:string};
export type RouteImpactFacts={method:typeof ROUTE_IMPACT_METHOD;level:'QUOTED';stateModel:'INDEPENDENT_QUOTES';token:TokenRef;reference:Reference|null;entry:Impact|Missing;exit:(Impact&{outputAtomic:string;exitValueWithUnspentUsd:string})|Missing;limitations:string[]};
const missing=(reasonCode:string):Missing=>({quality:'MISSING',reasonCode});
const empty=(token:TokenRef,reasonCode:string):RouteImpactFacts=>({method:ROUTE_IMPACT_METHOD,level:'QUOTED',stateModel:'INDEPENDENT_QUOTES',token,reference:null,entry:missing(reasonCode),exit:missing(reasonCode),limitations:LIMITATIONS});

/** Reuse original entry/exit admission. New math grants no new raw-account authority. */
export function reconstructRouteImpacts(token:TokenRef,profile:Profile,cutoff:string,raw:Record<string,string>,evidence:EvidenceRecord[]):RouteImpactFacts{
 const records=evidence.filter(e=>e.id.startsWith('entry-route-')&&e.id!=='entry-route-derivation');
 if(!records.length)return empty(token,'IMPACT_ROUTE_ENTRY_UNAVAILABLE');
 const entry=reconstructEntryRoute(token,profile,cutoff,raw,{records,rawArtifacts:Object.fromEntries(records.map(e=>[e.id,raw[e.id]!]))});
 if(entry.quality==='MISSING')return empty(token,'IMPACT_ROUTE_ENTRY_UNAVAILABLE');
 if(entry.baseDecimals>36)return empty(token,'IMPACT_ROUTE_DECIMALS_UNSUPPORTED');
 const values=JSON.parse(raw['entry-route-bank']!).result.value;
 const baseReserve=AccountLayout.decode(Buffer.from(values[3].data[0],'base64')).amount;
 const physicalQuoteReserve=AccountLayout.decode(Buffer.from(values[4].data[0],'base64')).amount;
 const pool=PUMP_AMM_SDK.decodePool({owner:new PublicKey(values[0].owner),data:Buffer.from(values[0].data[0],'base64'),executable:values[0].executable,lamports:values[0].lamports,rentEpoch:0});
 const baseScale=new Decimal(10).pow(entry.baseDecimals),quoteScale=new Decimal(10).pow(entry.quoteDecimals);
 // Preserve deriveExecution and existing PumpSwap reference-price operation order.
 const referencePrice=new Decimal((physicalQuoteReserve+BigInt(pool.virtualQuoteReserves.toString())).toString()).div(quoteScale).mul(entry.quoteUsdReference).div(new Decimal(baseReserve.toString()).div(baseScale));
 if(!referencePrice.isFinite()||referencePrice.lte(0))return empty(token,'IMPACT_ROUTE_REFERENCE_UNAVAILABLE');
 const quantity=new Decimal(entry.acquiredAtomic).div(baseScale);
 const entryBps=Decimal.max(0,new Decimal(1).sub(quantity.div(new Decimal(entry.inputUsd).div(referencePrice))).mul(10000)).toFixed();
 const reference:Reference={pool:entry.pool,stateSlot:entry.stateSlot,availableAt:entry.availableAt,expiresAt:entry.expiresAt,requestedUsd:entry.inputUsd,quantityAtomic:entry.acquiredAtomic,baseDecimals:entry.baseDecimals,quoteDecimals:entry.quoteDecimals,baseReserveAtomic:baseReserve.toString(),physicalQuoteReserveAtomic:physicalQuoteReserve.toString(),virtualQuoteReserveAtomic:pool.virtualQuoteReserves.toString(),quoteUsdReference:entry.quoteUsdReference,pricePair:entry.pricePair,referencePriceUsd:referencePrice.toFixed(),quantityTokens:quantity.toFixed(),referenceValueUsd:quantity.mul(referencePrice).toFixed(),unspentEntryAtomic:entry.unspentAtomic};
 const result:RouteImpactFacts={method:ROUTE_IMPACT_METHOD,level:'QUOTED',stateModel:'INDEPENDENT_QUOTES',token,reference,entry:{quality:entry.quality,bps:entryBps},exit:missing('IMPACT_ROUTE_EXIT_UNAVAILABLE'),limitations:LIMITATIONS};
 // O13 remains measurable even when the O11 exit is disabled/unquotable/not collected.
 // Require the separate exact exit witness to be present before granting O14 authority.
 if(!evidence.some(e=>e.id==='exit-route-derivation')||raw['exit-route-derivation']===undefined)return result;
 const exit=reconstructExitRoute(token,profile,cutoff,raw,evidence);
 if(exit.quality==='MISSING')return result;
 if(exit.quantityAtomic!==entry.acquiredAtomic||exit.pool!==entry.pool||exit.stateSlot!==entry.stateSlot||exit.quoteMint!==entry.quoteMint||exit.quoteDecimals!==entry.quoteDecimals||exit.availableAt!==entry.availableAt||exit.expiresAt!==entry.expiresAt)bad();
 const exitValue=new Decimal(exit.outputAtomic).add(entry.unspentAtomic).div(quoteScale).mul(entry.quoteUsdReference);
 result.exit={quality:exit.quality,bps:Decimal.max(0,new Decimal(1).sub(exitValue.div(quantity.mul(referencePrice))).mul(10000)).toFixed(),outputAtomic:exit.outputAtomic,exitValueWithUnspentUsd:exitValue.toFixed()};
 return result;
}
function assessment(id:'O13'|'O14',facts:RouteImpactFacts):BaselineAssessment|null{
 const measure=id==='O13'?facts.entry:facts.exit;
 if(measure.quality==='MISSING'||facts.reference===null)return null;
 return {id,version:'baseline-v1',evaluator:'IMPLEMENTED',collector:'IMPLEMENTED',quality:measure.quality,unit:'bps',data:{method:ROUTE_IMPACT_METHOD,level:facts.level,stateModel:facts.stateModel,token:facts.token,reference:facts.reference,measurement:id==='O13'?'ENTRY':'EXIT',...measure,limitations:LIMITATIONS},observationIds:[],evidenceIds:[ID],limitations:LIMITATIONS,causes:[],projection:{id,value:measure.bps,unit:'bps',quality:measure.quality,availableAt:facts.reference.availableAt,evidenceIds:[ID],applicability:'APPLICABLE'}};
}
export function finishRouteImpacts(token:TokenRef,profile:Profile,cutoff:string,raw:Record<string,string>,evidence:EvidenceRecord[]):{record:EvidenceRecord;raw:string;assessments:BaselineAssessment[]}{
 const facts=reconstructRouteImpacts(token,profile,cutoff,raw,evidence),body=JSON.stringify(facts);
 const dependencies=Object.keys(raw).filter(id=>id.startsWith('entry-route-')||id.startsWith('exit-route-')||['rpc-account','venue-provenance-record'].includes(id)).sort().map(id=>({id,contentHash:sha(raw[id]!)}));
 const record:EvidenceRecord={id:ID,sourceId:SOURCE,sourceType:'CALCULATION',accessMode:'LOCAL_DERIVED',adapterVersion:ROUTE_IMPACT_METHOD,scope:{method:ROUTE_IMPACT_METHOD,dependencies},retrievedAt:cutoff,availableAt:cutoff,contentHash:sha(body)};
 return {record,raw:body,assessments:([assessment('O13',facts),assessment('O14',facts)]).filter((a):a is BaselineAssessment=>a!==null)};
}
export function hasRouteImpacts(b:{evidence:EvidenceRecord[];rawArtifacts?:Record<string,string>;details?:{baseline:BaselineAssessment[]}}):boolean{return b.evidence.some(e=>e.id.startsWith('impact-route-')||e.sourceId===SOURCE||e.adapterVersion===ROUTE_IMPACT_METHOD)||Object.keys(b.rawArtifacts??{}).some(id=>id.startsWith('impact-route-'))||!!b.details?.baseline.some(a=>(a.data as {method?:string}|null)?.method===ROUTE_IMPACT_METHOD);}
export function validateRouteImpactBundle(b:LiveBundle):BaselineAssessment[]{
 const owned=b.evidence.filter(e=>e.id.startsWith('impact-route-')||e.sourceId===SOURCE||e.adapterVersion===ROUTE_IMPACT_METHOD),ids=Object.keys(b.rawArtifacts).filter(id=>id.startsWith('impact-route-'));
 if(!hasRouteImpacts(b)&&!b.features.some(f=>f.evidenceIds.some(id=>id.startsWith('impact-route-'))))return [];
 if(owned.length!==1||owned[0]!.id!==ID||ids.length!==1||ids[0]!==ID)bad();
 // Validate the full upstream source/record/cache/assessment, not just cached numbers.
 validateEntryRouteBundle(b);validateExitRouteBundle(b);
 const result=finishRouteImpacts(b.token,b.profile,b.cutoff,b.rawArtifacts,b.evidence);
 if(!isDeepStrictEqual(owned[0],result.record)||b.rawArtifacts[ID]!==result.raw)bad();
 for(const id of ['O13','O14'] as const){
  const expected=result.assessments.find(a=>a.id===id),a=b.details?.baseline.find(a=>a.id===id),f=b.features.find(f=>f.id===id);
  if(expected&&(!isDeepStrictEqual(a,expected)||!isDeepStrictEqual(f,expected.projection)))bad();
  if(!expected&&((a?.data as {method?:string}|null)?.method===ROUTE_IMPACT_METHOD||a?.evidenceIds.includes(ID)||f?.evidenceIds.includes(ID)))bad();
 }
 if(b.details?.baseline.some(a=>!['O13','O14'].includes(a.id)&&a.evidenceIds.includes(ID))||b.features.some(f=>!['O13','O14'].includes(f.id)&&f.evidenceIds.includes(ID))||b.observations.some(o=>o.evidenceIds.includes(ID)))bad();
 return result.assessments;
}
