import { Decimal } from 'decimal.js';
import { NATIVE_MINT } from '@solana/spl-token';
import type { TokenRef } from '../domain/contracts.js';
import { decodeAdvisoryDemandWindows, DEMAND_METHOD, MEANINGFUL_CORE_QUOTE_ATOMIC, type DemandHistory, type DemandTrade } from './advisory-demand-windows.js';
import type { AdvisoryWindowHistory, AdvisoryWindowReuse } from './advisory-window.js';

type Request={method:string;params:unknown[]};
type Transaction=DemandHistory['transactions'][number];
export const SHORT_DEMAND_METHOD='supplementary-short-demand-windows-v1' as const;
const HOUR=3_600_000,WINDOW=600_000,WINDOWS=6,HOURS=12,WSOL=NATIVE_MINT.toBase58();
export type ShortDemandFlow={decodedTrades:number;buyQuoteAtomic:string;sellQuoteAtomic:string;netQuoteAtomic:string;programAccountTrades:number;programAccountQuoteAtomic:string};
export type ShortDemandBuyer={user:string;signature:string;slot:number;at:string;coreQuoteAtomic:string;baselineSell:boolean;baselineSubThresholdBuy:boolean};
export type ShortDemandWindow={index:number;start:string;end:string;flow:ShortDemandFlow|null;firstObservedBuyers:ShortDemandBuyer[]|null;firstObservedBuyerCount:number|null;condition:boolean|null};
export type ShortDemandReport={
 method:typeof SHORT_DEMAND_METHOD;role:'SUPPLEMENTARY';canonicalMetricId:'A30';substitutesCanonical:false;countsTowardKnownMetrics:false;
 status:'COMPLETE'|'INCOMPLETE'|'NOT_ELIGIBLE';complete:boolean;reasonCode:string;sourceReasonCode:string;
 token:TokenRef;scope:'VERIFIED_PUMPSWAP_WSOL_POOL';pool:string|null;anchorSlot:number|null;stateSlot:number|null;
 canonical:{method:string;range:{start:string;baselineEnd:string;end:string};complete:boolean};
 reportEnd:string;interval:{start:string;end:string};
 baseline:{start:string;end:string;flow:ShortDemandFlow|null;meaningfulBuyers:number|null};
 measured:{start:string;end:string;flow:ShortDemandFlow|null};
 windowMinutes:10;denominator:6;windows:ShortDemandWindow[];satisfiedWindows:number|null;share:string|null;
 comparison:{buyQuoteDeltaAtomic:string|null;netQuoteDeltaAtomic:string|null;firstObservedBuyers:number|null;baselineMeaningfulBuyers:number|null;buyerRatio:string|null;rule:string};
 coverage:{indexReached:boolean;indexComplete:boolean;indexReachesScopeStart:boolean;indexPages:DemandHistory['pages'];capExceeded:boolean;poolVerified:boolean;transactionsCollected:boolean;
  scopeSuccessfulReferences:number|null;scopeObservedTransactions:number|null;scopeReceipts:{window:number;demand:number}|null;
  scopeUnresolvedTransactions:Array<{signature:string;at:string;receipt:'WINDOW'|'DEMAND';status:string;code:string|null}>;outsideScopeUnresolvedTransactions:number|null;
  logRecovery:{truncatedTransactions:number;unresolvedNonFlowInvocations:number;emptyForeignSweeps:number;unresolvedForeignSwaps?:number}|null};
 quoteMint:string;quoteDecimals:9;quoteBasis:string;meaningfulThreshold:{coreQuoteAtomic:string;quoteUnits:'0.01'};identityUnit:string;newBuyerRule:string;
 programAccounts:{rule:string;accounts:string[]};evidenceIds:string[];limitations:string[];
};
const NEW_BUYER_RULE='A decoded non-program user account whose first fee-exclusive core BUY of at least 0.01 WSOL in the complete two-hour tape falls in that ten-minute window. Accounts with such a buy in the one-hour baseline are excluded and each account counts once.';
const RECOVERY_LIMITATION='Truncated logs pass only through the pinned decoder opt-in recovery; unresolved later invocations are disclosed as non-flow and not proven executed.';
// Replaces RECOVERY_LIMITATION only for histories decoded with foreign-flow recovery.
const FOREIGN_RECOVERY_LIMITATION='Truncated logs pass only through the pinned decoder opt-in recovery. Unresolved foreign-pool swaps are disclosed separately: each is bound to its own instruction-trace event witness and disjoint from the selected pool and vaults, is not proven executed and is never counted in selected-pool flow. Other unresolved later invocations are disclosed as non-flow and not proven executed.';
const LIMITATIONS=[
 'Supplementary scoped report only: the latest completed UTC hour at or before the frozen canonical A30 end, after the preceding one-hour baseline, in one verified PumpSwap WSOL pool. It never replaces canonical A30, its twelve-hour tape and six measured hours, or the 25 USD six-hour risk profile, and it never counts toward the KNOWN metric total.',
 'New means first observed as a meaningful buyer within the declared complete two-hour pool tape; an account that bought earlier in the canonical tape can count here. It is not first-ever buying, a new wallet, a person, organic demand or new capital.',
 'Completeness requires the canonical pool index to be complete and within its 480-transaction cap, the pool state verified, and every successful in-scope reference decoded from its own validated receipt. Unresolved transactions before the two-hour start are excluded and counted; any unresolved in-scope transaction leaves every condition, the satisfied count and the share null.',
 'Collection is unchanged: when the canonical index does not reach the twelve-hour start or exceeds the transaction cap, no transaction receipts exist, so this report stays incomplete even when the index pages reach the two-hour start.',
 'CPI-authorized program accounts observed in any decoded transaction of the canonical tape are excluded from buyer sets and kept in net flow; every in-scope transaction is decoded, and unresolved outside-scope transactions cannot add classifications.',
 RECOVERY_LIMITATION,
 'Comparison fields are integer differences between the measured and baseline hours; the buyer ratio is null when the baseline has no meaningful buyer.',
];
const iso=(ms:number)=>new Date(ms).toISOString();
const order=(x:DemandTrade,y:DemandTrade)=>x.slot-y.slot||(x.transactionIndex??-1)-(y.transactionIndex??-1)||x.signature.localeCompare(y.signature)||x.instructionIndex-y.instructionIndex;
function flow(trades:DemandTrade[],program:Set<string>):ShortDemandFlow{
 let buy=0n,sell=0n,programQuote=0n,programTrades=0;
 for(const t of trades){const q=BigInt(t.quoteAtomic);if(t.side==='BUY')buy+=q;else sell+=q;if(program.has(t.user)){programTrades++;programQuote+=q;}}
 return{decodedTrades:trades.length,buyQuoteAtomic:String(buy),sellQuoteAtomic:String(sell),netQuoteAtomic:String(buy-sell),programAccountTrades:programTrades,programAccountQuoteAtomic:String(programQuote)};
}
/** A decoded history is self-consistent only with one entry per successful reference inside the canonical range and every trade bound to an OBSERVED transaction of equal slot, clock and trade count. */
function consistent(h:DemandHistory):boolean{
 const start=Date.parse(h.range.start),end=Date.parse(h.range.end),seen=new Set<string>(),observed=new Map<string,Transaction>(),counts=new Map<string,number>();
 if(h.transactions.length!==h.successfulReferences||h.hours.length!==HOURS)return false;
 for(const t of h.transactions){const at=Date.parse(t.at);if(seen.has(t.signature)||!(at>=start&&at<end))return false;seen.add(t.signature);if(t.status==='OBSERVED')observed.set(t.signature,t);}
 for(const t of h.trades){const x=observed.get(t.signature);if(!x||x.slot!==t.slot||x.at!==t.at||t.side!=='BUY'&&t.side!=='SELL'||typeof t.quoteAtomic!=='string'||!/^(0|[1-9][0-9]{0,39})$/.test(t.quoteAtomic))return false;counts.set(t.signature,(counts.get(t.signature)??0)+1);}
 return [...observed.values()].every(t=>(counts.get(t.signature)??0)===t.trades);
}

/** Supplementary [E-2h,E) report over one decoded A30 history: a one-hour baseline, then six fixed ten-minute windows. Pass only decodeAdvisoryDemandWindows output; canonical A30 is never altered or replaced. */
export function deriveShortDemandReport(history:DemandHistory,evidenceIds:string[]):ShortDemandReport{
 const canonicalStart=Date.parse(history.range.start),canonicalEnd=Date.parse(history.range.end);
 if(!Number.isFinite(canonicalStart)||!Number.isFinite(canonicalEnd))throw new Error('ADVISORY_SHORT_DEMAND_TIME');
 // E is the latest completed UTC hour at or before the frozen canonical end, never the wall clock or a chosen hour.
 const end=Math.floor(canonicalEnd/HOUR)*HOUR,start=end-2*HOUR,split=end-HOUR,ms=(s:string)=>Date.parse(s),inside=(s:string)=>ms(s)>=start&&ms(s)<end;
 const collected=history.method===DEMAND_METHOD&&history.eligible&&history.indexComplete&&!history.capExceeded;
 // Diagnostic only: index pages can reach the scope start while the canonical gate stopped every transaction read.
 const reachesScope=history.pages.length>0&&history.pages.every(p=>p.status==='OBSERVED')&&history.pages.some(p=>p.oldestAt!==null&&ms(p.oldestAt)<start);
 const scopeTransactions=collected?history.transactions.filter(t=>inside(t.at)):[],unresolved=scopeTransactions.filter(t=>t.status!=='OBSERVED'),observed=scopeTransactions.filter(t=>t.status==='OBSERVED');
 const blocked=history.method!==DEMAND_METHOD?'ADVISORY_SHORT_DEMAND_SOURCE_METHOD'
  :!history.eligible?history.reasonCode
  :start<canonicalStart?'ADVISORY_SHORT_DEMAND_TIME'
  :!history.indexComplete?(reachesScope?'ADVISORY_SHORT_DEMAND_SCOPE_NOT_COLLECTED':'ADVISORY_SHORT_DEMAND_INDEX_INCOMPLETE')
  :history.capExceeded?'ADVISORY_SHORT_DEMAND_SCOPE_NOT_COLLECTED'
  :!history.poolVerified?'ADVISORY_SHORT_DEMAND_POOL_UNVERIFIED'
  :!consistent(history)?'ADVISORY_SHORT_DEMAND_HISTORY_INCONSISTENT'
  :unresolved.length?'ADVISORY_SHORT_DEMAND_SCOPE_TRANSACTION_UNRESOLVED'
  :history.hours.some(h=>ms(h.start)>=start&&ms(h.end)<=end&&!h.complete)?'ADVISORY_SHORT_DEMAND_SCOPE_HOUR_INCOMPLETE':null;
 const known=blocked===null,program=new Set(history.programAccounts),threshold=BigInt(MEANINGFUL_CORE_QUOTE_ATOMIC);
 const trades=known?history.trades.filter(t=>inside(t.at)).sort(order):[],baselineTrades=trades.filter(t=>ms(t.at)<split),measuredTrades=trades.filter(t=>ms(t.at)>=split);
 // First observation is defined over the complete declared two-hour tape only.
 const first=new Map<string,DemandTrade>();
 for(const t of trades)if(t.side==='BUY'&&!program.has(t.user)&&BigInt(t.quoteAtomic)>=threshold&&!first.has(t.user))first.set(t.user,t);
 const bin=(t:DemandTrade)=>Math.floor((ms(t.at)-split)/WINDOW);
 const windows:ShortDemandWindow[]=Array.from({length:WINDOWS},(_,k)=>{
  const bounds={index:k,start:iso(split+k*WINDOW),end:iso(split+(k+1)*WINDOW)};
  if(!known)return{...bounds,flow:null,firstObservedBuyers:null,firstObservedBuyerCount:null,condition:null};
  const f=flow(measuredTrades.filter(t=>bin(t)===k),program);
  const buyers=[...first.values()].filter(t=>ms(t.at)>=split&&bin(t)===k).map(t=>({user:t.user,signature:t.signature,slot:t.slot,at:t.at,coreQuoteAtomic:t.quoteAtomic,
   baselineSell:baselineTrades.some(x=>x.user===t.user&&x.side==='SELL'),baselineSubThresholdBuy:baselineTrades.some(x=>x.user===t.user&&x.side==='BUY'&&BigInt(x.quoteAtomic)<threshold)}));
  return{...bounds,flow:f,firstObservedBuyers:buyers,firstObservedBuyerCount:buyers.length,condition:buyers.length>0&&BigInt(f.netQuoteAtomic)>=0n};
 });
 const baseFlow=known?flow(baselineTrades,program):null,measuredFlow=known?flow(measuredTrades,program):null;
 const baseBuyers=known?[...first.values()].filter(t=>ms(t.at)<split).length:null,newBuyers=known?windows.reduce((n,w)=>n+(w.firstObservedBuyerCount??0),0):null;
 const satisfied=known?windows.filter(w=>w.condition===true).length:null;
 const delta=(key:'buyQuoteAtomic'|'netQuoteAtomic')=>baseFlow&&measuredFlow?String(BigInt(measuredFlow[key])-BigInt(baseFlow[key])):null;
 const status=history.method===DEMAND_METHOD&&!history.eligible?'NOT_ELIGIBLE' as const:known?'COMPLETE' as const:'INCOMPLETE' as const;
 return{
  method:SHORT_DEMAND_METHOD,role:'SUPPLEMENTARY',canonicalMetricId:'A30',substitutesCanonical:false,countsTowardKnownMetrics:false,
  status,complete:known,reasonCode:blocked??'COMPLETE_SHORT_DEMAND_SCOPE_OBSERVED',sourceReasonCode:history.reasonCode,
  token:{...history.token},scope:'VERIFIED_PUMPSWAP_WSOL_POOL',pool:history.pool,anchorSlot:history.anchorSlot,stateSlot:history.stateSlot,
  canonical:{method:history.method,range:{...history.range},complete:history.complete},
  reportEnd:iso(end),interval:{start:iso(start),end:iso(end)},
  baseline:{start:iso(start),end:iso(split),flow:baseFlow,meaningfulBuyers:baseBuyers},
  measured:{start:iso(split),end:iso(end),flow:measuredFlow},
  windowMinutes:10,denominator:6,windows,satisfiedWindows:satisfied,share:satisfied===null?null:new Decimal(satisfied).div(WINDOWS).toFixed(),
  comparison:{buyQuoteDeltaAtomic:delta('buyQuoteAtomic'),netQuoteDeltaAtomic:delta('netQuoteAtomic'),firstObservedBuyers:newBuyers,baselineMeaningfulBuyers:baseBuyers,
   buyerRatio:newBuyers!==null&&baseBuyers?new Decimal(newBuyers).div(baseBuyers).toFixed():null,rule:'measured minus baseline hour in fee-exclusive atomic WSOL; buyerRatio is measured first-observed buyers over baseline meaningful buyers and null for a zero baseline'},
  coverage:{indexReached:history.indexReached,indexComplete:history.indexComplete,indexReachesScopeStart:reachesScope,indexPages:history.pages.map(p=>({...p})),capExceeded:history.capExceeded,poolVerified:history.poolVerified,transactionsCollected:collected,
   scopeSuccessfulReferences:collected?scopeTransactions.length:null,scopeObservedTransactions:collected?observed.length:null,
   scopeReceipts:collected?{window:observed.filter(t=>t.receipt==='WINDOW').length,demand:observed.filter(t=>t.receipt==='DEMAND').length}:null,
   scopeUnresolvedTransactions:unresolved.slice(0,20).map(t=>({signature:t.signature,at:t.at,receipt:t.receipt,status:t.status,code:t.code??null})),
   outsideScopeUnresolvedTransactions:collected?history.transactions.filter(t=>!inside(t.at)&&t.status!=='OBSERVED').length:null,
   // Witnessed foreign swaps are disclosed separately and only under foreign-flow recovery, matching canonical A30.
   logRecovery:collected?{truncatedTransactions:observed.filter(t=>t.logRecovery?.truncated).length,unresolvedNonFlowInvocations:observed.reduce((n,t)=>n+(t.logRecovery?.unresolvedInvocations??0)-(t.logRecovery?.unresolvedForeignSwaps??0),0),emptyForeignSweeps:observed.reduce((n,t)=>n+(t.logRecovery?.emptyForeignSweeps??0),0),
    ...(history.foreignFlowRecovery?{unresolvedForeignSwaps:observed.reduce((n,t)=>n+(t.logRecovery?.unresolvedForeignSwaps??0),0)}:{})}:null},
  quoteMint:WSOL,quoteDecimals:9,quoteBasis:'fee-exclusive core quote atomic units',meaningfulThreshold:{coreQuoteAtomic:MEANINGFUL_CORE_QUOTE_ATOMIC,quoteUnits:'0.01'},
  identityUnit:'decoded PumpSwap trade user account; never merged and not a person',newBuyerRule:NEW_BUYER_RULE,
  programAccounts:{rule:'CPI-authorized decoded users in the canonical tape; excluded from buyer sets, retained in flow',accounts:[...history.programAccounts]},
  evidenceIds:[...new Set(evidenceIds)],limitations:history.foreignFlowRecovery?LIMITATIONS.map(l=>l===RECOVERY_LIMITATION?FOREIGN_RECOVERY_LIMITATION:l):[...LIMITATIONS],
 };
}

/** Rebuilds the canonical demand history from its retained raw receipts, then derives the supplementary report; derived flags are never accepted as input. */
export function decodeAdvisoryShortDemand(token:TokenRef,window:AdvisoryWindowHistory,windowReceipts:AdvisoryWindowReuse,rawArtifacts:Record<string,string>,retrievedAt:Record<string,string>,requests:Record<string,Request>,cutoff:string,evidenceIds:string[]=[],foreignFlowRecovery=false):ShortDemandReport{
 return deriveShortDemandReport(decodeAdvisoryDemandWindows(token,window,windowReceipts,rawArtifacts,retrievedAt,requests,cutoff,false,foreignFlowRecovery),evidenceIds);
}
