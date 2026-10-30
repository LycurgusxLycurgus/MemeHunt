import {createHash} from 'node:crypto';
import {Decimal} from 'decimal.js';
import type {AdvisoryMetric} from '../domain/advisory-contracts.js';
import {O23_BULK_QUOTE} from './advisory-synchrony-bulk.js';
import {decodeBulkQuoteFinancialTape} from './advisory-reserve-bulk.js';
import type {ReservePathHistory,ReservePathTrade} from './advisory-reserve-path.js';
import {a30NativeBodyDigests,projectA30C5Receipts,type A30SourceReceipts,type A30NativeBodyDigest} from './advisory-demand-fx-source.js';
import {buildA30FxReference,resolveA30FxState,type A30FxReference} from './advisory-demand-fx-state.js';

export const A30_FX_DEMAND_METHOD='complete-pool-baseline-demand-fx-cells-v1' as const;
const HOUR=3_600_000,HOURS=12,BASELINE_HOURS=6,Q128=1n<<128n,THRESHOLD=10_000_000n,U64=(1n<<64n)-1n;
const fail=(code:string):never=>{throw Error('A30_FX_'+code);};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
const NEW_BUYER_RULE='A decoded non-program user whose first core BUY worth at least the incoming historical 0.01 SOL marginal reference in the complete twelve-hour tape falls in that window. Baseline meaningful buyers are excluded; every account counts once.';
const LIMITATIONS=[
 'Only the declared canonical PumpSwap WBTC pool and fixed twelve hours; other pools, venues and whole-token flow are unobserved.',
 'First meaningful buyer means first observed in this complete pool tape, not first-ever buying, a person, organic demand, a new wallet or new capital.',
 'CPI-authorized program users anywhere in the tape are excluded from buyer sets; every one of their decoded BUY and SELL amounts remains in native WBTC flow.',
 'Historical incoming Whirlpool marginal reference is used only for the 0.01 SOL meaningful-BUY threshold. Native WBTC net is not reweighted or relabeled WSOL.',
 'Every leg in transaction X uses its incoming FX state. Exact writer-free cells may be observed by the next writer pre-state retrospectively; source availability is never backdated.',
 'Missing or unproved writer events remain mutation barriers. An unqueried unanchored cell supplies no price and is not claimed known.',
 'A source, financial, owner/epoch, required state or body-coherence gap leaves all window conditions, buyer counts, satisfied count and share null.',
 'Window closure assumes canonical finalized ledger blockTime from a chain with nondecreasing bank clocks, as supported by the pinned Agave source; retained provider responses and the historical deployed binary are not independently authenticated.',
 'This is not actual WSOL expenditure, an executable conversion, a peg, a fair-price guarantee or historical deployed-binary/provider authentication.',
];
type Resolved=ReturnType<typeof resolveA30FxState>;
type Buyer={user:string;signature:string;slot:number;transactionIndex:number;at:string;coreQuoteAtomic:string;baselineSell:boolean;baselineSubThresholdBuy:boolean};
type Coherence={overlappingTransactions:number;unionTransactions:number;nativeOrderAndBlockTime:'VERIFIED_OBSERVED_UNION';manifestHash:string};
const pos=(v:Pick<A30NativeBodyDigest,'slot'|'transactionIndex'>)=>`${v.slot}:${v.transactionIndex}`;

function range(history:ReservePathHistory){
 const start=Date.parse(history.range.start),end=Date.parse(history.range.end);
 if(!Number.isFinite(start)||!Number.isFinite(end)||end-start!==HOURS*HOUR||end%HOUR!==0)fail('DEMAND_RANGE');
 return{start,end,baselineEnd:start+BASELINE_HOURS*HOUR};
}
function quantity(trade:ReservePathTrade):bigint|null{
 if(typeof trade.quoteAtomic!=='string'||!/^(0|[1-9]\d{0,19})$/.test(trade.quoteAtomic))return null;
 const q=BigInt(trade.quoteAtomic);return q<=U64?q:null;
}
function incomingSummary(reference:A30FxReference){
 const context=reference.sourceContext,identity=context?.identity;
 if(!context||!identity)return{method:'POOL_MARGINAL_PREVIOUS_COMMITTED_TRANSACTION',sourceCoverage:null,stateCoverage:reference.coverage,sourceHash:null,identityBankPriceUsed:false,executableConversion:null,actualWsolExpenditure:null,referenceNetComputed:false};
 return{method:'POOL_MARGINAL_PREVIOUS_COMMITTED_TRANSACTION',pool:identity.pool,mintA:identity.mintA,mintB:identity.mintB,decimalsA:identity.decimalsA,decimalsB:identity.decimalsB,
  identity:{program:identity.program,config:identity.config,tickSpacing:identity.tickSpacing,vaultA:identity.vaultA,vaultB:identity.vaultB,bankSlot:identity.bankSlot,sourceId:identity.sourceId,sourceAt:identity.sourceAt,purpose:'STATIC_IDENTITY_ONLY'},
  sourceCoverage:context.coverage,stateCoverage:reference.coverage,sourceHash:context.sourceHash,
  stateRule:'Every possible writer is a barrier. A required incoming cell has an admitted left final.post or right first.pre; two admitted anchors must agree exactly.',
  identityBankPriceUsed:false,executableConversion:null,actualWsolExpenditure:null,referenceNetComputed:false};
}

/** Deterministic demand arithmetic over an already source-bound financial tape/reference.
 * This pure function grants no source/import authority; the public receipt wrapper below reconstructs both inputs.
 */
export function deriveA30FxDemandFromHistory(history:ReservePathHistory,programAccounts:readonly string[],reference:A30FxReference,evidenceIds:string[]):AdvisoryMetric{
 const b=range(history),program=new Set(programAccounts),ids=[...new Set(evidenceIds)],resolutions=new Map<string,Resolved>(),queryPositions=new Map<string,string>(),queryTuples=new Map<string,{slot:number;transactionIndex:number;at:string}>();
 let reason=!history.eligible||!history.pool?'A30_FINANCIAL_POOL_REQUIRED':!history.complete?history.reasonCode||'A30_FINANCIAL_TAPE_INCOMPLETE':!reference.complete?reference.reasonCode:'COMPLETE_FX_REFERENCED_DEMAND_WINDOWS_OBSERVED';
 if(Date.parse(reference.range.start)!==b.start||Date.parse(reference.range.end)!==b.end)reason='A30_FX_REFERENCE_RANGE_MISMATCH';
 if(history.hours.length!==HOURS||history.hours.some((h,i)=>Date.parse(h.start)!==b.start+i*HOUR||Date.parse(h.end)!==b.start+(i+1)*HOUR||history.complete&&!h.complete))reason='A30_FINANCIAL_HOUR_COVERAGE';
 const trades=[...history.trades];let valid=true;
 for(const t of trades){
  const at=Date.parse(t.at),q=quantity(t);
  if(!integer(t.slot)||!integer(t.transactionIndex)||!Number.isFinite(at)||at<b.start||at>=b.end||q===null||!['BUY','SELL'].includes(t.side)||typeof t.user!=='string'||!t.user||typeof t.signature!=='string'||!t.signature||!t.provenance||!integer(t.provenance.pumpOrdinal)){valid=false;reason='A30_FINANCIAL_TRADE_BINDING';break;}
  const key=pos({slot:t.slot,transactionIndex:t.transactionIndex}),prior=queryPositions.get(key);if(prior&&prior!==t.signature){valid=false;reason='A30_NATIVE_POSITION_CONFLICT';break;}queryPositions.set(key,t.signature);
  const previous=queryTuples.get(t.signature);if(previous){if(previous.slot!==t.slot||previous.transactionIndex!==t.transactionIndex||previous.at!==t.at){valid=false;reason='A30_FINANCIAL_TRANSACTION_BINDING';break;}continue;}queryTuples.set(t.signature,{slot:t.slot,transactionIndex:t.transactionIndex,at:t.at});
  if(reference.complete){const resolved=resolveA30FxState(reference,{slot:t.slot,transactionIndex:t.transactionIndex,signature:t.signature});resolutions.set(t.signature,resolved);if(resolved.status!=='KNOWN'||typeof resolved.sqrtPriceX64!=='string'||!/^[1-9]\d*$/.test(resolved.sqrtPriceX64)||BigInt(resolved.sqrtPriceX64)>=(1n<<128n)){valid=false;reason=resolved.reasonCode||'A30_REQUIRED_FX_STATE_UNAVAILABLE';}}
 }
 if(valid)trades.sort((a,c)=>a.slot-c.slot||a.transactionIndex!-c.transactionIndex!||a.provenance.pumpOrdinal-c.provenance.pumpOrdinal||(a.provenance.routeEvent??-1)-(c.provenance.routeEvent??-1));
 const known=reason==='COMPLETE_FX_REFERENCED_DEMAND_WINDOWS_OBSERVED'&&valid;
 const hourOf=(t:ReservePathTrade)=>Math.floor((Date.parse(t.at)-b.start)/HOUR);
 const meaningful=(t:ReservePathTrade)=>{const s=BigInt(resolutions.get(t.signature)!.sqrtPriceX64!);return BigInt(t.quoteAtomic)*Q128>=THRESHOLD*s*s;};
 const first=new Map<string,ReservePathTrade>();
 if(known)for(const t of trades)if(t.side==='BUY'&&!program.has(t.user)&&meaningful(t)&&!first.has(t.user))first.set(t.user,t);
 const baseline=trades.filter(t=>hourOf(t)<BASELINE_HOURS),baselineSell=new Set(baseline.filter(t=>t.side==='SELL').map(t=>t.user)),baselineSmall=new Set<string>();
 if(known)for(const t of baseline)if(t.side==='BUY'&&!meaningful(t))baselineSmall.add(t.user);
 const flows=Array.from({length:HOURS},(_,i)=>{
  let buy=0n,sell=0n,programQuote=0n,programTrades=0,decoded=0;
  if(known)for(const t of trades){if(hourOf(t)!==i)continue;decoded++;const q=BigInt(t.quoteAtomic);if(t.side==='BUY')buy+=q;else sell+=q;if(program.has(t.user)){programTrades++;programQuote+=q;}}
  return{start:new Date(b.start+i*HOUR).toISOString(),end:new Date(b.start+(i+1)*HOUR).toISOString(),complete:known,coverage:known?'COMPLETE':'INCOMPLETE',decodedTrades:known?decoded:null,buyQuoteAtomic:known?String(buy):null,sellQuoteAtomic:known?String(sell):null,netQuoteAtomic:known?String(buy-sell):null,programAccountTrades:known?programTrades:null,programAccountQuoteAtomic:known?String(programQuote):null};
 });
 const windows=flows.slice(BASELINE_HOURS).map((flow,k)=>{
  const buyers:Buyer[]|null=known?[...first.values()].filter(t=>hourOf(t)===BASELINE_HOURS+k).map(t=>({user:t.user,signature:t.signature,slot:t.slot,transactionIndex:t.transactionIndex!,at:t.at,coreQuoteAtomic:t.quoteAtomic,baselineSell:baselineSell.has(t.user),baselineSubThresholdBuy:baselineSmall.has(t.user)})):null;
  return{...flow,newMeaningfulBuyers:buyers,newMeaningfulBuyerCount:buyers?buyers.length:null,condition:buyers?buyers.length>0&&BigInt(flow.netQuoteAtomic!)>=0n:null};
 });
 const satisfied=known?windows.filter(w=>w.condition===true).length:null;
 const queryRecords=[...resolutions].map(([signature,resolved])=>[signature,resolved.status,resolved.sqrtPriceX64,resolved.cellIndex,resolved.anchors]);
 return{id:'A30',quality:known?'KNOWN':'MISSING',unit:'complete selected-pool demand windows of six',evidenceIds:ids,reasonCode:reason,data:{
  method:A30_FX_DEMAND_METHOD,scope:'VERIFIED_PUMPSWAP_WBTC_POOL_WITH_INCOMING_FX_THRESHOLD',pool:history.pool,range:{start:history.range.start,baselineEnd:new Date(b.baselineEnd).toISOString(),end:history.range.end},windowEnd:history.range.end,anchorSlot:history.anchorSlot,stateSlot:history.stateSlot,poolVerified:history.eligible,
  quoteMint:O23_BULK_QUOTE,quoteDecimals:8,quoteBasis:'fee-exclusive native core WBTC atomic units',netFlowUnit:'NATIVE_CORE_WBTC_ATOMIC',netFlowRule:'Native core WBTC BUY minus SELL; no time-varying FX reweighting.',
  meaningfulThreshold:{referenceMint:reference.sourceContext?.identity.mintA??null,referenceDecimals:9,referenceAtomic:String(THRESHOLD),referenceUnits:'0.01',referenceMethod:'POOL_MARGINAL_PREVIOUS_COMMITTED_TRANSACTION',predicate:'q_WBTC * 2^128 >= 10000000 * incoming_sqrt_x64^2',meaning:'descriptive historical marginal reference, not actual WSOL spent, execution or organic demand'},
  fx:{...incomingSummary(reference),requiredQueryTransactions:new Set(trades.map(t=>t.signature)).size,identifiedQueryTransactions:[...resolutions.values()].filter(v=>v.status==='KNOWN').length,resolutionManifestHash:hash(queryRecords),queryExamples:[...resolutions].slice(0,16).map(([signature,v])=>({signature,status:v.status,cellIndex:v.cellIndex,sqrtPriceX64:v.sqrtPriceX64,anchors:v.anchors.length}))},
  identityUnit:'decoded PumpSwap trade user account; never merged and not a person',newBuyerRule:NEW_BUYER_RULE,
  programAccounts:{rule:'CPI-authorized decoded users anywhere in the tape; excluded from buyers and retained in flow',accounts:known?[...program].sort():null},
  baseline:{start:history.range.start,end:new Date(b.baselineEnd).toISOString(),complete:known,meaningfulBuyers:known?[...first.values()].filter(t=>hourOf(t)<BASELINE_HOURS).length:null,hours:flows.slice(0,BASELINE_HOURS)},
  windows,denominator:6,satisfiedWindows:satisfied,share:satisfied===null?null:new Decimal(satisfied).div(6).toFixed(),complete:known,sourceUniverseComplete:false,wholeTokenFlow:null,newCapital:null,limitations:LIMITATIONS,
 }};
}

/** Only native receipt reconstruction enters the production A30 path. */
export function deriveA30FxDemandWindows(receipts:A30SourceReceipts,cutoff:string,evidenceIds:string[]):AdvisoryMetric{
 const reference=buildA30FxReference(receipts,cutoff),fx=reference.sourceContext?.bodyHashes??new Map<string,A30NativeBodyDigest>(),union=new Map<string,A30NativeBodyDigest>(),c5Seen=new Set<string>(),overlap=new Set<string>();
 let coherenceReason:string|null=null;
 const conflict=(code:string)=>{coherenceReason??='A30_FX_'+code;};
 for(const body of fx.values()){const key=pos(body),prior=union.get(key);if(prior&&prior.signature!==body.signature)conflict('UNION_POSITION_CONFLICT');union.set(key,body);}
 const financial=decodeBulkQuoteFinancialTape(projectA30C5Receipts(receipts),cutoff,(_id,raw)=>{
  for(const[sig,body]of a30NativeBodyDigests(raw)){
   if(c5Seen.has(sig))conflict('C5_BODY_DUPLICATE');c5Seen.add(sig);
   const other=fx.get(sig);if(other){if(body.slot!==other.slot||body.transactionIndex!==other.transactionIndex||body.blockTime!==other.blockTime||body.hash!==other.hash)conflict('C5_BODY_COHERENCE');overlap.add(sig);}
   const key=pos(body),prior=union.get(key);if(prior&&prior.signature!==sig)conflict('UNION_POSITION_CONFLICT');union.set(key,body);
  }
 });
 const ordered=[...union.values()].sort((a,b)=>a.slot-b.slot||a.transactionIndex-b.transactionIndex);
 for(let i=1;i<ordered.length;i++){const before=ordered[i-1]!,after=ordered[i]!;if(after.slot===before.slot&&after.blockTime!==before.blockTime||after.blockTime<before.blockTime)conflict('UNION_BLOCK_TIME_ORDER');}
 const expectedOverlap=financial.history.transactions.filter(t=>fx.has(t.signature)).length;if(expectedOverlap!==overlap.size)conflict('C5_OVERLAP_BIJECTION');
 const coherence:Coherence={overlappingTransactions:overlap.size,unionTransactions:ordered.length,nativeOrderAndBlockTime:'VERIFIED_OBSERVED_UNION',manifestHash:hash(ordered.map(v=>[v.signature,v.slot,v.transactionIndex,v.blockTime,v.hash]))};
 const metric=deriveA30FxDemandFromHistory(coherenceReason?{...financial.history,complete:false,reasonCode:coherenceReason}:financial.history,financial.programAccounts,reference,evidenceIds);
 return{...metric,data:{...(metric.data as object),sourceTrust:'RETAINED_PROVIDER_RPC_IMPORT',sourceAuthentication:'Hashes bind retained bytes, not provider authentication or independent onchain attestation.',financialPurpose:'A30_DEMAND_WINDOWS_ONLY',sourceCoverage:{...financial.sourceCoverage,a30SourceBytes:reference.sourceContext?.sourceBytes??null,a30StoredBytes:reference.sourceContext?.storedBytes??null},pairedClocks:financial.pairedClocks,crossSourceCoherence:{...coherence,complete:!coherenceReason,reasonCode:coherenceReason}}};
}
