import type {TokenRef} from '../domain/contracts.js';
import {quoteBuyExactQuoteBudget,quoteSellExactBase,type DirectPrestate} from './advisory-copy-quote.js';
export type S16StudyTrade={ordinal:number;signature:string;slot:number;transactionIndex:number|null;at:string;side:'BUY'|'SELL';nativeFamily:'DIRECT'|'ROUTE'|'CPI_DIRECT';state:DirectPrestate|null;unsupportedReason:string|null;proof:Record<string,unknown>};
export type S16StudyInput={token:TokenRef;pool:string;range:{start:string;end:string};complete:true;detectedAt:string;callRefs:Array<Record<string,unknown>>;trades:S16StudyTrade[];availableAt:string;sourceSummary:Record<string,unknown>};
export type S16StudyResult={quality:'KNOWN'|'MISSING';reasonCode:string;data:Record<string,unknown>};
export const S16_STUDY_METHOD='historical-recorded-batch-direct-copy-outcome-v1';
export const S16_PROFILE_METHOD='s16-recorded-batch-direct-conditional-profile-v1';
export const S16_QUOTE_MINT='3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh';
export const S16_REQUIRED_COST_KINDS=['ENTRY_NETWORK_BASE','ENTRY_PRIORITY','EXIT_NETWORK_BASE','EXIT_PRIORITY','ATA_SETUP'] as const;
const LATENCY=60_000,HORIZON=3_600_000,BUDGET=10_000n,BPS=10_000n,IMPACT=300n;
export const s16StudyProfile=()=>({method:S16_PROFILE_METHOD,latencyMs:LATENCY,holdingHorizonMs:HORIZON,quoteMint:S16_QUOTE_MINT,quoteDecimals:8,maximumQuoteBudgetAtomic:String(BUDGET),maxPriceImpactBps:300,slippageToleranceBps:300,entry:'FIRST_NATIVE_DIRECT_BUY_AT_OR_AFTER_RECORDED_DETECTION_PLUS_LATENCY',exit:'FIRST_NATIVE_DIRECT_SELL_AT_OR_AFTER_ENTRY_PLUS_HORIZON',executionModel:'SAME_POSITION_SAME_SIDE_PRESTATE_NO_PROPAGATED_SELF_IMPACT',accountPremise:'PREEXISTING_UNFROZEN_ORDINARY_ENDOWED_ATAS_NO_EXOGENOUS_INTERVENTION',costs:{lamportsPerSignature:'5000',signaturesPerSubmittedLeg:1,priorityLamportsPerLeg:'0',ataSetupLamports:'0',basis:'DECLARED_MODEL_PARAMETERS_NOT_MEASURED_HISTORICAL_FEES'}});
export function serializeS16(value:unknown):unknown{if(typeof value==='bigint')return value.toString();if(Array.isArray(value))return value.map(serializeS16);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,serializeS16(v)]));return value;}
const epoch=(s:string)=>Date.parse(s);
const impact=(n:bigint,d:bigint)=>({numerator:n>0n?n:0n,denominator:d,maximumBps:300,passes:d>0n&&(n>0n?n:0n)*BPS<=IMPACT*d});
const anchor=(t:S16StudyTrade)=>({ordinal:t.ordinal,signature:t.signature,slot:t.slot,transactionIndex:t.transactionIndex,at:t.at,side:t.side,nativeFamily:t.nativeFamily,state:t.state,proof:t.proof});
/** All five required components exist even when a leg is deliberately not submitted. */
export function s16CompleteModeledCosts(entrySubmitted:boolean,exitSubmitted:boolean){
 if(exitSubmitted&&!entrySubmitted)throw Error('S16_COST_SUBMISSION_ORDER');
 const amounts=[entrySubmitted?5000n:0n,0n,exitSubmitted?5000n:0n,0n,0n],components=S16_REQUIRED_COST_KINDS.map((kind,i)=>({kind,lamports:amounts[i]!,provenance:'DECLARED_MODEL_PARAMETER',submission:kind==='ATA_SETUP'?'PREEXISTING_ACCOUNTS':kind.startsWith('ENTRY')?(entrySubmitted?'SUBMITTED':'NOT_SUBMITTED'):(exitSubmitted?'SUBMITTED':'NOT_SUBMITTED')}));
 return{complete:true,unit:'LAMPORTS',requiredKinds:[...S16_REQUIRED_COST_KINDS],components,totalLamports:amounts.reduce((a,b)=>a+b,0n),historicalActualNetworkFeeMeasured:false,poolFeesAlreadyIncludedInQuotes:true};
}
/** Fixed secondary-analysis rule; source provenance and admission are the adapter's responsibility. */
export function evaluateS16Study(input:S16StudyInput):S16StudyResult{
 const data:Record<string,unknown>={method:S16_STUDY_METHOD,scope:'ONE_RECORDED_CLASSIFICATION_BATCH_CONDITIONAL_NATIVE_DIRECT_OPPORTUNITY',profile:s16StudyProfile(),token:input.token,pool:input.pool,callReferences:input.callRefs,simulationOpportunities:1,sourceSummary:input.sourceSummary,sourceAvailableAt:input.availableAt,detection:{at:input.detectedAt,basis:'RECORDED_CALLER_QUALIFICATION_AVAILABLE_AT',trust:'OPERATOR_RECORDED_USER_IMPORT_NOT_AUTHENTICATED_CONTEMPORANEOUS_MONITORING'},sourceRange:input.range,completeNativeTradeRows:input.trades.length,limitations:[
  'Retrospective secondary-analysis rule fixed before hypothetical quotes/outcomes, after historical sources and calibration were inspected; not prospectively preregistered before events.',
  'All eligible calls in one recorded classification batch form one opportunity, not independent follower outcomes. The later repository import and source packaging clocks are separate.',
  'Each hypothetical leg uses its own same-side event prestate/rates under pinned published SDK semantics. The order does not rewrite the later historical tape; no actual fill, guaranteed execution or causal response is established.',
  'Preexisting unfrozen ordinary endowed token accounts and no exogenous intervention are explicit model premises, not measured historical follower account facts. There are no hypothetical external transfers or reward claims in this two-swap model.',
  'Network/signature/priority/setup figures are declared model parameters, not measured historical transaction fees. Exact target/WBTC/SOL units stay separate; no all-in USD profit or return is asserted.',
 ]};
 const missing=(reasonCode:string,extra:Record<string,unknown>={}):S16StudyResult=>({quality:'MISSING',reasonCode,data:{...data,status:'UNRESOLVED',...extra}});
 const start=epoch(input.range.start),end=epoch(input.range.end),detect=epoch(input.detectedAt),available=epoch(input.availableAt);
 if(input.complete!==true||input.token.chain!=='solana'||!input.token.address||!input.pool||![start,end,detect,available].every(Number.isFinite)||start>=end||available<end||!input.callRefs.length)return missing('S16_SOURCE_OR_BATCH_UNAVAILABLE');
 if(detect<start||detect>=end)return missing('S16_DETECTION_OUTSIDE_NATIVE_COVERAGE');
 let previous:S16StudyTrade|undefined,previousAt=-Infinity;
 for(const [i,t]of input.trades.entries()){
  const at=epoch(t.at);if(t.ordinal!==i||!Number.isFinite(at)||at%1000!==0||at<start||at>=end||!Number.isSafeInteger(t.slot)||t.slot<0||!t.signature||!['BUY','SELL'].includes(t.side)||!['DIRECT','ROUTE','CPI_DIRECT'].includes(t.nativeFamily)||at<previousAt||previous&&t.slot<previous.slot||previous&&t.slot===previous.slot&&t.transactionIndex!==null&&previous.transactionIndex!==null&&t.transactionIndex<previous.transactionIndex)return missing('S16_NATIVE_ORDER_OR_CLOCK_INVALID');
  previous=t;previousAt=at;
 }
 const trigger=detect+LATENCY;data.entryTriggerAt=new Date(trigger).toISOString();
 const entry=input.trades.find(t=>t.nativeFamily==='DIRECT'&&t.side==='BUY'&&epoch(t.at)>=trigger);
 if(!entry)return missing('S16_ENTRY_ANCHOR_NOT_COVERED');data.entryAnchor=anchor(entry);data.entryWaitingAfterTriggerMs=epoch(entry.at)-trigger;data.actualEntryDelayMs=epoch(entry.at)-detect;
 if(entry.unsupportedReason||!entry.state)return missing('S16_ENTRY_ANCHOR_UNSUPPORTED',{unsupportedReason:entry.unsupportedReason});
 if(entry.state.virtualQuoteReserve<=0n)return missing('S16_ENTRY_VIRTUAL_DOMAIN_UNCALIBRATED');
 const buy=quoteBuyExactQuoteBudget(entry.state,BUDGET);
 if(!buy.ok)return missing('S16_ENTRY_QUOTE_UNSUPPORTED',{kernelCode:buy.code});
 const b=buy.value,entryImpact=impact(b.coreQuote*entry.state.baseReserve-b.baseOut*b.domain.effectiveQuoteReserve,b.baseOut*b.domain.effectiveQuoteReserve);
 data.entryQuote=b;data.entryImpact=entryImpact;data.entryMinimumBaseOut=b.baseOut*9700n/BPS;
 const known=(status:string,reasonCode:string,entrySubmitted:boolean,exitSubmitted:boolean,quoteDelta:bigint,targetDelta:bigint,extra:Record<string,unknown>={}):S16StudyResult=>{
  const costs=s16CompleteModeledCosts(entrySubmitted,exitSubmitted);
  return{quality:'KNOWN',reasonCode,data:{...data,status,entrySubmitted,exitSubmitted,costModel:costs,assetCashflowVector:{quote:{mint:S16_QUOTE_MINT,decimals:8,atomic:quoteDelta},target:{mint:input.token.address,unit:'BASE_ATOMIC',atomic:targetDelta},sol:{unit:'LAMPORTS',atomic:-costs.totalLamports}},quotePnlAtomic:exitSubmitted?quoteDelta:null,allInValuedProfit:null,allInValuedProfitStatus:'NOT_AGGREGATED_ACROSS_ASSETS',...extra}};
 };
 if(!entryImpact.passes)return known('ENTRY_CONSTRAINT_BLOCKED','S16_ENTRY_IMPACT_LIMIT_PREVENTS_SUBMISSION',false,false,0n,0n);
 const exitTrigger=epoch(entry.at)+HORIZON;data.exitTriggerAt=new Date(exitTrigger).toISOString();
 if(exitTrigger>=end)return missing('S16_EXIT_HORIZON_NOT_FULLY_COVERED');
 const exit=input.trades.find(t=>t.nativeFamily==='DIRECT'&&t.side==='SELL'&&epoch(t.at)>=exitTrigger);
 if(!exit)return missing('S16_EXIT_ANCHOR_NOT_COVERED');data.exitAnchor=anchor(exit);data.exitWaitingAfterTriggerMs=epoch(exit.at)-exitTrigger;
 if(exit.unsupportedReason||!exit.state)return missing('S16_EXIT_ANCHOR_UNSUPPORTED',{unsupportedReason:exit.unsupportedReason});
 if(exit.state.virtualQuoteReserve<=0n)return missing('S16_EXIT_VIRTUAL_DOMAIN_UNCALIBRATED');
 const sell=quoteSellExactBase(exit.state,b.baseOut);
 if(!sell.ok){
  if(['SELL_PHYSICAL_BACKING_INSUFFICIENT','SELL_FEES_EXCEED_CORE','SELL_NET_ZERO','SELL_CORE_ZERO','POOL_RESERVE_OVERFLOW'].includes(sell.code))return known('EXIT_CONSTRAINT_BLOCKED','S16_EXIT_LIQUIDITY_PREVENTS_SUBMISSION',true,false,-b.bookedQuote,b.baseOut,{kernelCode:sell.code,heldTargetUnvalued:true});
  return missing('S16_EXIT_QUOTE_UNSUPPORTED',{kernelCode:sell.code});
 }
 const s=sell.value,exitImpact=impact(b.baseOut*s.domain.effectiveQuoteReserve-s.coreQuote*exit.state.baseReserve,b.baseOut*s.domain.effectiveQuoteReserve);
 data.exitQuote=s;data.exitImpact=exitImpact;data.exitMinimumQuoteOut=s.userNetQuote*9700n/BPS;
 if(!exitImpact.passes)return known('EXIT_CONSTRAINT_BLOCKED','S16_EXIT_IMPACT_LIMIT_PREVENTS_SUBMISSION',true,false,-b.bookedQuote,b.baseOut,{heldTargetUnvalued:true});
 return known('EXECUTED_CONDITIONALLY','S16_FIXED_PROFILE_CONDITIONAL_OUTCOME_MEASURED',true,true,s.userNetQuote-b.bookedQuote,0n,{initialQuoteBudgetAtomic:BUDGET,unusedQuoteBudgetAtomic:b.unspentBudget,endQuoteFromBudgetAtomic:b.unspentBudget+s.userNetQuote,holdingDurationMs:epoch(exit.at)-epoch(entry.at)});
}
