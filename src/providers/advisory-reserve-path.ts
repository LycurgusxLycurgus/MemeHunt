import { Decimal } from 'decimal.js';
import { NATIVE_MINT } from '@solana/spl-token';
import type { AdvisoryMetric } from '../domain/advisory-contracts.js';
import type { DemandHistory, DemandTrade } from './advisory-demand-windows.js';

/**
 * O29 over the complete A30 selected-pool tape decoded once with per-event virtual quote reserves retained (opt-in); it issues no reads and decodes nothing.
 * - Curve: every trade reproduces the pinned SDK integer formula on its event pre-trade reserves and its own event virtual quote reserve V.
 * - Path: consecutive trades keep base and effective quote Q + V exactly; physical Q and V may differ from the model only by equal and opposite amounts, counted without a cause.
 * - Vector: per A30 hour and whole range, observed event pre endpoints, the modelled curve endpoint after the last trade, fee-exclusive flow, physical, virtual and effective reserve change and modelled curve impact.
 */
type Kind='BUY'|'EXACT'|'SELL';
type Step={trade:DemandTrade;hour:number;kind:Kind;base:bigint;core:bigint;lp:bigint;protocol:bigint;creator:bigint;B:bigint;Q:bigint;V:bigint;postB:bigint;postQ:bigint;expected:bigint;observed:bigint;offset:bigint};
export const RESERVE_PATH_METHOD='complete-pool-effective-reserve-path-v1' as const;
const HOUR=3_600_000,HOURS=12,SAMPLE=20,UNIT='reserve-path-vector',WSOL=NATIVE_MINT.toBase58(),I128=2n**127n;
const KINDS:Record<string,Kind>={buy:'BUY',buy_v2:'BUY',buy_exact_quote_in:'EXACT',buy_exact_quote_in_v2:'EXACT',sell:'SELL',sell_v2:'SELL'};
const BASIS:Record<Kind,string>={BUY:'BUY_CORE',EXACT:'EXACT_QUOTE_BUY_GROSS',SELL:'SELL_CORE'};
const RULES={
 reserves:'B and Q are the pool base and quote token reserves the verified event reports before its trade; V is the same event signed i128 virtual_quote_reserves, retained only by the opt-in A30 decode. Effective quote Qe = Q + V. can_boost and other event fields are not interpreted.',
 curve:'Pinned @pump-fun/pump-swap-sdk 1.20.0 integer formulas with the trade own V: buy and buy_v2 core quote = ceil(Qe*base/(B-base)) (buyBaseInput); buy_exact_quote_in and buy_exact_quote_in_v2 base = floor(B*(core-1)/(Qe+core-1)) (buyQuoteInput, core = userQuoteAmountIn); sell and sell_v2 core quote = floor(Qe*base/(B+base)) (sellBaseInput). One atomic unit of difference fails; V and rounding are never fitted.',
 path:'The modelled curve endpoint of a trade adds core + LP fee (event quote_amount_in_with_lp_fee) and removes base for buys, removes core - LP fee (event quote_amount_out_without_lp_fee) and adds base for sells, priced with the trade own V. The next event base must equal the modelled base and its Q + V the modelled Q + V, exactly. Protocol and creator fees are outside the reported pool reserves.',
 offsets:'A physical quote offset is the next event Q minus the modelled Q; the path admits it only when the event V moved by the exact opposite amount. Offsets are counted and summed; no cause (boost, sweep, deposit or other) is attributed and can_boost is not evidence of any action.',
 order:'Decoder order: slot, RPC transactionIndex, then log invocation order within one transaction. Consecutive trades of different transactions in one slot need both transaction indexes; order is never taken from signatures.',
 endpoints:'eventPre values are reported by verified events at that trade block time. modelledPost is the curve endpoint after the last trade of the window at that trade block time; it is not an observed vault balance or virtual reserve state. Endpoints are never moved to window edges and no post-tape state is used.',
 spot:'Spot = (Q + V) / B in quote atomic units per base atomic unit. curveImpact = modelled post spot / event pre spot - 1 with the trade own V; observedPriceChange = last event pre spot / first event pre spot - 1 (null below two trades); modelledPriceChange = last modelled post spot / first event pre spot - 1; all from exact integer cross products.',
 changes:'Physical quote change = modelled post Q - first event Q; virtual change = last event V - first event V; effective change = their sum, which the path makes equal to net core flow plus LP fees.',
 hours:'The twelve A30 hours by block time, half-open. An hour without trades keeps zero flow and null endpoints, changes and impact; nothing is carried forward or backward.',
};
const LIMITATIONS=[
 'One verified PumpSwap WSOL pool and the twelve A30 hours only; other pools, venues and whole-token flow are excluded.',
 'Reserves and V are program-reported event values bound to the exact signature, receipt, instruction and pinned event; vault token balances are not read by this measurement.',
 'The post-trade endpoint after the last trade of each window is a modelled curve endpoint; no actual vault balance or later virtual reserve is asserted and no post-tape state is grafted into the twelve hours.',
 'Physical quote and virtual reserve offsets between trades are observed with exact opposite magnitude; their cause is unattributed and can_boost is not evidence that any boost action occurred.',
 'Curve impact is the modelled move of the pool spot by each executed trade. It is not a fixed-size depth certificate; depthAtDefinedImpact stays null.',
 'No cohort baseline exists, so no thin-liquidity anomaly, inflation or manipulation is asserted.',
 'Spot is an effective reserve ratio in atomic units, not USD and not an execution price.',
];
function fail(code:string):never{throw new Error(code);}
const errorCode=(error:unknown)=>error instanceof Error&&/^RESERVE_PATH_[A-Z0-9_]+$/.test(error.message)?error.message:'RESERVE_PATH_TRADE_INVALID';
const ceil=(a:bigint,b:bigint)=>(a+b-1n)/b;
const ratio=(n:bigint,d:bigint)=>new Decimal(n.toString()).div(d.toString());
const spot=(B:bigint,Qe:bigint)=>ratio(Qe,B).toFixed();
/** (toQe/toB)/(fromQe/fromB) - 1 from exact integer cross products. */
const change=(fromB:bigint,fromQe:bigint,toB:bigint,toQe:bigint)=>ratio(toQe*fromB-fromQe*toB,fromQe*toB);

/** The retained event V: absent on default decodes, otherwise a canonical signed i128 decimal. */
function virtualQuote(t:DemandTrade):bigint{
 const s:unknown=t.virtualQuoteReservesAtomic;
 if(s===undefined)return fail('RESERVE_PATH_VIRTUAL_QUOTE_MISSING');
 if(typeof s!=='string'||!/^(0|-?[1-9][0-9]{0,38})$/.test(s))return fail('RESERVE_PATH_VIRTUAL_QUOTE_INVALID');
 const v=BigInt(s);
 if(v< -I128||v>I128-1n)fail('RESERVE_PATH_VIRTUAL_QUOTE_INVALID');
 return v;
}
/** One trade under the pinned SDK formula with its own event V. */
function step(t:DemandTrade,hour:number):Step{
 const qa=t.quoteAccounting,kind=KINDS[t.instructionName??''];
 if(!qa||!kind||t.side!==(kind==='SELL'?'SELL':'BUY')||qa.basis!==BASIS[kind]||t.quoteAtomic!==qa.coreQuoteAtomic)return fail('RESERVE_PATH_QUOTE_ACCOUNTING_MISSING');
 const V=virtualQuote(t),B=BigInt(t.poolBaseReservesAtomic),Q=BigInt(t.poolQuoteReservesAtomic),b=BigInt(t.baseAtomic),c=BigInt(qa.coreQuoteAtomic),lp=BigInt(qa.lpFeeAtomic),Qe=Q+V;
 const postB=kind==='SELL'?B+b:B-b,postQ=kind==='SELL'?Q-(c-lp):Q+c+lp;
 if(B<=0n||b<=0n||c<=0n||Qe<=0n||postB<=0n||postQ<0n||postQ+V<=0n)fail('RESERVE_PATH_NONPOSITIVE_RESERVE');
 const expected=kind==='BUY'?ceil(Qe*b,postB):kind==='SELL'?Qe*b/postB:B*(c-1n)/(Qe+c-1n);
 return{trade:t,hour,kind,base:b,core:c,lp,protocol:BigInt(qa.protocolFeeAtomic),creator:BigInt(qa.creatorFeeAtomic),B,Q,V,postB,postQ,expected,observed:kind==='EXACT'?b:c,offset:0n};
}
const pre=(s:Step)=>({basis:'EVENT_REPORTED',signature:s.trade.signature,at:s.trade.at,baseReserveAtomic:String(s.B),quoteReserveAtomic:String(s.Q),virtualQuoteReserveAtomic:String(s.V),effectiveQuoteReserveAtomic:String(s.Q+s.V),spot:spot(s.B,s.Q+s.V)});
const post=(s:Step)=>({basis:'MODELLED_CURVE_ENDPOINT',afterSignature:s.trade.signature,at:s.trade.at,baseReserveAtomic:String(s.postB),quoteReserveAtomic:String(s.postQ),pricingVirtualQuoteReserveAtomic:String(s.V),effectiveQuoteReserveAtomic:String(s.postQ+s.V),spot:spot(s.postB,s.postQ+s.V)});
/** One window of contiguous decoder-order steps; an empty window keeps zero sums and null endpoints. */
function summary(steps:Step[]){
 let buys=0,sells=0,buy=0n,sell=0n,lp=0n,protocol=0n,creator=0n,bought=0n,sold=0n,offsetPairs=0,offsetSum=0n,min:Decimal|null=null,max:Decimal|null=null;
 for(const [k,s] of steps.entries()){
  if(s.kind==='SELL'){sells++;sell+=s.core;sold+=s.base;}else{buys++;buy+=s.core;bought+=s.base;}
  lp+=s.lp;protocol+=s.protocol;creator+=s.creator;
  if(k&&s.offset!==0n){offsetPairs++;offsetSum+=s.offset;}
  const x=change(s.B,s.Q+s.V,s.postB,s.postQ+s.V);if(!min||x.lt(min))min=x;if(!max||x.gt(max))max=x;
 }
 const flow={trades:steps.length,buyTrades:buys,sellTrades:sells,buyCoreQuoteAtomic:String(buy),sellCoreQuoteAtomic:String(sell),netCoreQuoteAtomic:String(buy-sell),lpFeeAtomic:String(lp),protocolFeeAtomic:String(protocol),creatorFeeAtomic:String(creator),baseBoughtAtomic:String(bought),baseSoldAtomic:String(sold),
  internalPairs:Math.max(0,steps.length-1),offsetPairs,physicalQuoteOffsetSumAtomic:String(offsetSum)};
 const a=steps[0],z=steps.at(-1);
 if(!a||!z||!min||!max)return{...flow,firstEventPre:null,lastEventPre:null,modelledPost:null,observedPriceChange:null,modelledPriceChange:null,baseReserveChangeAtomic:null,physicalQuoteReserveChangeAtomic:null,virtualQuoteReserveChangeAtomic:null,effectiveQuoteReserveChangeAtomic:null,curveImpact:null};
 return{...flow,firstEventPre:pre(a),lastEventPre:pre(z),modelledPost:post(z),
  observedPriceChange:steps.length>1?change(a.B,a.Q+a.V,z.B,z.Q+z.V).toFixed():null,modelledPriceChange:change(a.B,a.Q+a.V,z.postB,z.postQ+z.V).toFixed(),
  baseReserveChangeAtomic:String(z.postB-a.B),physicalQuoteReserveChangeAtomic:String(z.postQ-a.Q),virtualQuoteReserveChangeAtomic:String(z.V-a.V),effectiveQuoteReserveChangeAtomic:String(z.postQ+z.V-a.Q-a.V),
  curveImpact:{min:min.toFixed(),max:max.toFixed()}};
}

/** O29 from the retained-V A30 tape; null keeps the older sampled row when the tape is not eligible. */
export function deriveO29ReservePath(history:DemandHistory,evidenceIds:string[]):AdvisoryMetric|null{
 if(!history.eligible)return null;
 const ids=[...new Set(evidenceIds)];
 const scope={method:RESERVE_PATH_METHOD,tapeMethod:history.method,scope:'VERIFIED_PUMPSWAP_WSOL_POOL',pool:history.pool,range:history.range,anchorSlot:history.anchorSlot,stateSlot:history.stateSlot,tapeComplete:history.complete,
  quoteMint:WSOL,quoteDecimals:9,flowBasis:'fee-exclusive core quote atomic units',priceUnit:'effective quote atomic per base atomic',virtualQuoteSource:'each trade own verified event virtual_quote_reserves (signed i128)',rules:RULES,
  depthAtDefinedImpact:null,depthStatus:'FIXED_SIZE_NOT_DECLARED',cohortBaseline:null,anomaly:null,anomalyStatus:'ANOMALY_REQUIRES_COHORT_BASELINE',thinLiquidity:null,offsetCause:null,limitations:LIMITATIONS};
 const missing=(reasonCode:string,extra:Record<string,unknown>={}):AdvisoryMetric=>({id:'O29',quality:'MISSING',unit:UNIT,evidenceIds:ids,reasonCode,data:{...scope,gates:null,offsets:null,whole:null,hours:null,...extra}});
 if(!history.complete)return missing(history.reasonCode);
 const start=Date.parse(history.range.start);
 if(history.hours.length!==HOURS||history.hours.some((h,i)=>Date.parse(h.start)!==start+i*HOUR||Date.parse(h.end)!==start+(i+1)*HOUR||!h.complete))return missing('RESERVE_PATH_HOURS_UNALIGNED');
 // Every decoded trade of every observed transaction is checked; nothing is dropped from the path.
 const transactionTrades=history.transactions.reduce((n,x)=>n+x.trades,0);
 if(transactionTrades!==history.trades.length||history.transactions.some(x=>x.status!=='OBSERVED'))return missing('RESERVE_PATH_TAPE_SHRUNK');
 if(!history.trades.length)return missing('RESERVE_PATH_NO_TRADES');
 const steps:Step[]=[],failures:Array<{code:string;signature:string}>=[],mismatchSample:unknown[]=[],discontinuitySample:unknown[]=[],unorderedSample:unknown[]=[],offsetSample:unknown[]=[],byInstruction:Record<string,{trades:number;curveMatches:number}>={};
 const flag=(code:string,signature:string)=>{if(!failures.length)failures.push({code,signature});};
 let matches=0,mismatches=0,pairs=0,breaks=0,unchanged=0,offsetPairs=0,virtualChanges=0,sameSlot=0,unordered=0,offsetSum=0n,previous:Step|null=null;
 for(const [i,t] of history.trades.entries()){
  const p=i?history.trades[i-1]!:null,hour=Math.floor((Date.parse(t.at)-start)/HOUR);
  if(!(hour>=0&&hour<HOURS)||p&&(t.slot<p.slot||Date.parse(t.at)<Date.parse(p.at)||t.signature===p.signature&&t.instructionIndex<=p.instructionIndex))flag('RESERVE_PATH_ORDER_INVALID',t.signature);
  if(p&&t.slot===p.slot&&t.signature!==p.signature){
   sameSlot++;
   if(p.transactionIndex===null||t.transactionIndex===null||p.transactionIndex>=t.transactionIndex){unordered++;if(unorderedSample.length<SAMPLE)unorderedSample.push({slot:t.slot,previousSignature:p.signature,signature:t.signature});flag('INTRA_SLOT_ORDER_UNKNOWN',t.signature);}
  }
  let s:Step|null=null;
  try{s=step(t,hour);}catch(error){flag(errorCode(error),t.signature);}
  if(s){
   const n=byInstruction[t.instructionName!]??={trades:0,curveMatches:0};n.trades++;
   if(s.expected===s.observed){matches++;n.curveMatches++;}
   else{mismatches++;if(mismatchSample.length<SAMPLE)mismatchSample.push({signature:t.signature,instructionName:t.instructionName,checkedField:s.kind==='EXACT'?'baseAtomic':'coreQuoteAtomic',expectedAtomic:String(s.expected),observedAtomic:String(s.observed)});flag('RESERVE_CURVE_MISMATCH',t.signature);}
   if(previous){
    pairs++;
    const rb=s.B-previous.postB,rq=s.Q-previous.postQ,dv=s.V-previous.V;s.offset=rq;
    if(dv!==0n)virtualChanges++;
    if(rb!==0n||rq+dv!==0n){breaks++;if(discontinuitySample.length<SAMPLE)discontinuitySample.push({previousSignature:previous.trade.signature,signature:t.signature,baseResidualAtomic:String(rb),physicalQuoteResidualAtomic:String(rq),virtualQuoteChangeAtomic:String(dv),effectiveQuoteResidualAtomic:String(rq+dv)});flag('RESERVE_PATH_EFFECTIVE_DISCONTINUOUS',t.signature);}
    else if(rq===0n)unchanged++;
    else{offsetPairs++;offsetSum+=rq;if(offsetSample.length<SAMPLE)offsetSample.push({previousSignature:previous.trade.signature,signature:t.signature,physicalQuoteOffsetAtomic:String(rq),virtualQuoteChangeAtomic:String(dv)});}
   }
   steps.push(s);
  }
  previous=s;
 }
 const first=failures[0]??null;
 const gates={checkedTrades:history.trades.length,transactionTrades,curveMatches:matches,curveMismatches:mismatches,byInstruction,continuityPairs:pairs,effectiveDiscontinuities:breaks,sameSlotPairs:sameSlot,unorderedSameSlotPairs:unordered,firstFailure:first,mismatchSample,discontinuitySample,unorderedSample};
 if(first)return missing(first.code,{gates});
 const offsets={pairs,unchangedPairs:unchanged,offsetPairs,physicalQuoteOffsetSumAtomic:String(offsetSum),virtualQuoteChangePairs:virtualChanges,distinctVirtualQuoteValues:new Set(steps.map(x=>String(x.V))).size,
  firstEventVirtualQuoteAtomic:String(steps[0]!.V),lastEventVirtualQuoteAtomic:String(steps.at(-1)!.V),cause:null,sample:offsetSample};
 return{id:'O29',quality:'KNOWN',unit:UNIT,evidenceIds:ids,reasonCode:'EFFECTIVE_RESERVE_PATH_OBSERVED',data:{...scope,gates,offsets,
  whole:{start:history.range.start,end:history.range.end,...summary(steps)},
  hours:history.hours.map((h,i)=>({start:h.start,end:h.end,complete:h.complete,...summary(steps.filter(x=>x.hour===i))}))}};
}
