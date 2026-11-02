/** Adapted from actual Claude Code S17 proposal under the frozen S17 contract. Pure quantities, no valuation. */
import type {TokenRef} from '../domain/contracts.js';
export type LegKind='PURCHASE'|'CROSS_ASSET_EXCHANGE'|'CREATOR_FEE'|'HOLDER_DISTRIBUTION'|'SALE'|'PLAIN_TRANSFER';
export type Counterasset={kind:'SPL';mint:string;program:string;decimals:number;amountAtomic:bigint;basis:string}|{kind:'NATIVE_LAMPORTS';decimals:9;amountAtomic:bigint;basis:string};
export type S17Leg={rawLegId:string;signature:string;slot:number;
  position:{ledgerOrdinal:number;txIndex:number|null;legOrder:number;top:number;source:'O25_VERIFIED_VIEW_ORDER'|'V25_VERIFIER_INSTRUCTION_ORDER'};
  blockTimeSec:bigint;programTimestamp:{sec:bigint;source:'PROGRAM_EVENT'|'COPIED_BLOCK_TIME_NOT_INDEPENDENT'}|null;
  direction:'IN'|'OUT';kind:LegKind;amountAtomic:bigint;counterasset:Counterasset|null;sourceSemantics:string};
export type S17ActorRelation={kind:'SIGNED_CREATION_ROLE_HISTORICAL';token:TokenRef;wallet:string;
  creation:{signature:string;slot:number;blockTimeSec:bigint;uniqueness:'MINT_ALLOCATED_AND_INITIALIZED_IN_THIS_TRANSACTION'|'UNVERIFIED'};validity:'AT_CREATION_TRANSACTION_ONLY'};
export type S17Coverage={kind:'COMPLETE_LIFETIME_FROM_CREATION';token:TokenRef;wallet:string;canonicalAccount:string;startSignature:string;
  headSlot:number;headBlockTimeSec:bigint;headBlockTimeReceipt:{sourceHash:string;retrievedAt:string};headAtomic:bigint;
  typedLegCensus:number;walletCensus:{successfulReferences:number;inspected:number};canonicalIndexExhausted:true;unresolvedEvents:0;
  sourceHash:string;receiptManifestHash:string;availableAt:string;producer:'O25_BULK_LIFETIME_LIVE_REDERIVED'|'PARASITE_V25_REVERIFIED_RAW_CLOSURE'};
export type S17TargetLedger={actor:S17ActorRelation|null;coverage:S17Coverage|null;gap:string|null;legs:S17Leg[]};
type ValidS17Ledger=S17TargetLedger&{actor:S17ActorRelation;coverage:S17Coverage};
export type S17CallEvent={sourceId:string;statusId:string;authorId:string;publishedAtSec:bigint;timePrecision:'SECOND';bodySha256:string;editState:string};
export type S17CallSet={status:'KNOWN';token:TokenRef;method:string;selectionHash:string;availableAt:string;events:S17CallEvent[]}|{status:'MISSING';reason:string};
export const S17_HORIZON_SECONDS=86400;
export const s17InventoryConfig=():S17Config=>({horizonSeconds:86400n,boundary:'PRE_[c-H,c)_TIE_{c}_POST_(c,c+H]',clock:'INTEGER_SECOND_LABELS',headRule:'POST_END_LABEL_STRICTLY_BEFORE_HEAD_LABEL'});
export type S17Config={horizonSeconds:bigint;boundary:'PRE_[c-H,c)_TIE_{c}_POST_(c,c+H]';clock:'INTEGER_SECOND_LABELS';headRule:'POST_END_LABEL_STRICTLY_BEFORE_HEAD_LABEL'};
export type S17Flow={legs:number;targetAtomic:bigint;counterassetAtomic:Record<string,bigint>};
export type S17FlowVector=Record<LegKind,S17Flow>;
export type S17CallRef={sourceId:string;statusId:string;authorId:string;publishedAtSec:bigint};
export type S17CallVector={status:'COMPLETE';call:S17CallRef;horizonSeconds:bigint;
  preBirth:{fromInclusiveSec:bigint;toExclusiveSec:bigint;inventoryAtomic:0n;basis:'VERIFIED_MINT_UNIQUENESS'}|null; postBirthZero:{fromInclusiveSec:bigint;toExclusiveSec:bigint;inventoryAtomic:0n;basis:'VERIFIED_MINT_UNIQUENESS'}|null;
  inventory:{atPreStartAtomic:bigint;strictlyBeforeCallAtomic:bigint;atCall:{exactAtomic:bigint|null;loAtomic:bigint;hiAtomic:bigint;nativePrefixExtrema:Array<{afterRawLegId:string|null;atomic:bigint}>};afterCallSecondAtomic:bigint;atPostEndAtomic:bigint};
  change:{preNetAtomic:bigint;tieNetAtomic:bigint;postNetAtomic:bigint;windowNetAtomic:bigint};
  pre:{fromInclusiveSec:bigint;toExclusiveSec:bigint;flows:S17FlowVector;rawLegIds:string[]};
  tie:{secondLabel:bigint;order:'NONE'|'UNKNOWN_RELATIVE_TO_CALL';flows:S17FlowVector;rawLegIds:string[]};
  post:{fromExclusiveSec:bigint;toInclusiveSec:bigint;flows:S17FlowVector;rawLegIds:string[]};
  edgeLabels:{preStartLabelRawLegIds:string[];postEndLabelRawLegIds:string[]};
  association:'HISTORICAL_CREATION_ROLE_WALLET_ADDRESS_ONLY';followers:null;valued:'NOT_REQUESTED'}
  |{status:'CENSORED';call:S17CallRef;reason:'S17_POST_WINDOW_NOT_FULLY_COVERED'|'S17_PRE_WINDOW_BEFORE_PROVEN_BIRTH'};
export type S17Result={status:'MISSING';reason:string;upstream:string|null}|{status:'INVALID_INPUT';reason:string}
  |{status:'NO_ELIGIBLE_EVENTS';eligible:0;calls:[]}
  |{status:'EVALUATED';eligible:number;calls:S17CallVector[];crossCallAggregate:null;
     actor:{relation:'SIGNED_CREATION_ROLE_HISTORICAL';wallet:string;creationSignature:string;validity:'AT_CREATION_TRANSACTION_ONLY'};
     coverage:{headSlot:number;headBlockTimeSec:bigint;typedLegCensus:number;sourceHash:string;receiptManifestHash:string};callSelectionHash:string;availableAt:string;config:S17Config};
export const S17_KINDS:readonly LegKind[]=['PURCHASE','CROSS_ASSET_EXCHANGE','CREATOR_FEE','HOLDER_DISTRIBUTION','SALE','PLAIN_TRANSFER'];
const IN=new Set<LegKind>(['PURCHASE','CROSS_ASSET_EXCHANGE','CREATOR_FEE','HOLDER_DISTRIBUTION']),PRICED=new Set<LegKind>(['PURCHASE','CROSS_ASSET_EXCHANGE','SALE']);
const U64=(1n<<64n)-1n,MAX_SEC=253402300799n;
const isSec=(v:unknown):v is bigint=>typeof v==='bigint'&&v>=0n&&v<=MAX_SEC; // rejects number/NaN/undefined: invalid date => INVALID_INPUT, never 0
const sameToken=(a:TokenRef,b:TokenRef)=>a.chain===b.chain&&a.address===b.address;
const signed=(x:S17Leg)=>x.direction==='IN'?x.amountAtomic:-x.amountAtomic;
const net=(xs:readonly S17Leg[])=>xs.reduce((n,x)=>n+signed(x),0n);
export const counterKey=(q:Counterasset)=>q.kind==='SPL'?`SPL:${q.program}:${q.mint}:${q.decimals}`:'NATIVE_LAMPORTS:9';
export function validateS17Ledger(l:S17TargetLedger):{ok:true}|{ok:false;status:'MISSING'|'INVALID_INPUT';reason:string}{
 const bad=(reason:string)=>({ok:false as const,status:'INVALID_INPUT' as const,reason});
 if(!l.actor)return{ok:false,status:'MISSING',reason:'S17_ACTOR_RELATION_UNAVAILABLE'};
 if(!l.coverage)return{ok:false,status:'MISSING',reason:'S17_LEDGER_COVERAGE_UNPROVEN'}; // legs presence never implies coverage
 const a=l.actor,c=l.coverage;
 if(a.kind!=='SIGNED_CREATION_ROLE_HISTORICAL'||a.validity!=='AT_CREATION_TRANSACTION_ONLY')return bad('S17_ACTOR_RELATION_UNSUPPORTED');
 if(c.kind!=='COMPLETE_LIFETIME_FROM_CREATION'||c.canonicalIndexExhausted!==true||c.unresolvedEvents!==0||c.walletCensus.successfulReferences<1||c.walletCensus.inspected!==c.walletCensus.successfulReferences)return bad('S17_COVERAGE_PROOF_INCOMPLETE');
 if(!sameToken(a.token,c.token)||a.wallet!==c.wallet||a.creation.signature!==c.startSignature)return bad('S17_COVERAGE_ACTOR_MISMATCH');
 if(!Number.isSafeInteger(a.creation.slot)||a.creation.slot<0||!Number.isSafeInteger(c.headSlot)||c.headSlot<0||typeof c.headAtomic!=='bigint'||!isSec(a.creation.blockTimeSec)||!isSec(c.headBlockTimeSec)||c.headBlockTimeSec<a.creation.blockTimeSec||c.headSlot<a.creation.slot||c.headAtomic<0n)return bad('S17_COVERAGE_CLOCK_INVALID');
 if(l.legs.length!==c.typedLegCensus)return bad('S17_LEG_CENSUS_MISMATCH');
 const ids=new Set<string>(),closed=new Set<string>(),scale=new Map<string,number>();let held=0n,prev:S17Leg|null=null;
 for(const [i,x] of l.legs.entries()){
  if(!Number.isSafeInteger(x.slot)||x.slot<0||!Number.isSafeInteger(x.position.legOrder)||x.position.legOrder<0||!Number.isSafeInteger(x.position.top)||x.position.top<0||x.position.txIndex!==null&&(!Number.isSafeInteger(x.position.txIndex)||x.position.txIndex<0)||x.position.source!=='O25_VERIFIED_VIEW_ORDER'||x.position.ledgerOrdinal!==i||!isSec(x.blockTimeSec)||x.programTimestamp!==null&&!isSec(x.programTimestamp.sec))return bad('S17_LEG_CLOCK_OR_POSITION');
  if(typeof x.signature!=='string'||!x.signature||typeof x.sourceSemantics!=='string'||!x.sourceSemantics||x.programTimestamp!==null&&!['PROGRAM_EVENT','COPIED_BLOCK_TIME_NOT_INDEPENDENT'].includes(x.programTimestamp.source)||ids.has(x.rawLegId)||x.rawLegId!==`${x.signature}:${x.position.legOrder}`)return bad('S17_LEG_IDENTITY');
  // no target leg can precede verified creation; legs after the pinned head slot cannot be in a head-pinned census
  if(x.slot<a.creation.slot||x.slot>c.headSlot||x.blockTimeSec<a.creation.blockTimeSec||x.blockTimeSec>c.headBlockTimeSec)return bad('S17_LEG_OUTSIDE_COVERAGE');
  if(prev){const same=prev.signature===x.signature;
   if(x.slot<prev.slot||x.blockTimeSec<prev.blockTimeSec)return bad('S17_ORDER_OR_BLOCKTIME_NONMONOTONIC');
   if(same&&(x.slot!==prev.slot||x.blockTimeSec!==prev.blockTimeSec||x.position.txIndex!==prev.position.txIndex||x.position.legOrder<=prev.position.legOrder))return bad('S17_SAME_TRANSACTION_INCONSISTENT');
   if(!same){closed.add(prev.signature);if(closed.has(x.signature))return bad('S17_TRANSACTION_NOT_CONTIGUOUS');
    if(x.slot===prev.slot&&x.position.txIndex!==null&&prev.position.txIndex!==null&&x.position.txIndex<=prev.position.txIndex)return bad('S17_TRANSACTION_INDEX_ORDER');}}
  if(!S17_KINDS.includes(x.kind)||!['IN','OUT'].includes(x.direction)||IN.has(x.kind)!==(x.direction==='IN'))return bad('S17_KIND_DIRECTION');
  if(typeof x.amountAtomic!=='bigint'||x.amountAtomic<=0n||x.amountAtomic>U64)return bad('S17_TARGET_AMOUNT');
  if(PRICED.has(x.kind)!==(x.counterasset!==null))return bad('S17_COUNTERASSET_PRESENCE');
  const q=x.counterasset;
  if(q){if(typeof q.amountAtomic!=='bigint'||q.amountAtomic<0n||q.amountAtomic>U64)return bad('S17_COUNTERASSET_AMOUNT');
   if(q.kind==='SPL'){if(typeof q.mint!=='string'||!q.mint||typeof q.program!=='string'||!q.program||q.mint===a.token.address||!Number.isSafeInteger(q.decimals)||q.decimals<0||q.decimals>255)return bad('S17_COUNTERASSET_IDENTITY');
    const id=`${q.program}:${q.mint}`;if(scale.has(id)&&scale.get(id)!==q.decimals)return bad('S17_COUNTERASSET_DECIMALS_CONFLICT');scale.set(id,q.decimals);}
   else if(q.kind!=='NATIVE_LAMPORTS'||q.decimals!==9)return bad('S17_COUNTERASSET_IDENTITY');}
  held+=signed(x);if(held<0n)return bad('S17_NEGATIVE_PREFIX'); // negative inventory => invalid, never clamped to 0
  ids.add(x.rawLegId);prev=x;}
 if(held!==c.headAtomic)return bad('S17_HEAD_CONSERVATION');
 return{ok:true};
}
function flowVector(xs:readonly S17Leg[]):S17FlowVector{
 const o=Object.fromEntries(S17_KINDS.map(k=>[k,{legs:0,targetAtomic:0n,counterassetAtomic:{} as Record<string,bigint>}])) as S17FlowVector;
 for(const x of xs){const f=o[x.kind];f.legs++;f.targetAtomic+=x.amountAtomic;const q=x.counterasset;if(q){const k=counterKey(q);f.counterassetAtomic[k]=(f.counterassetAtomic[k]??0n)+q.amountAtomic;}}
 return o; // computed zeros over a proven-covered segment; never defaults for missing data
}
const prefixBefore=(legs:readonly S17Leg[],label:bigint)=>net(legs.filter(x=>x.blockTimeSec<label)); // independent pass
export function s17CallVector(l:ValidS17Ledger,call:S17CallEvent,cfg:S17Config):S17CallVector{
 const H=cfg.horizonSeconds,c=call.publishedAtSec,a=l.actor,birth=a.creation.blockTimeSec;
 const ref={sourceId:call.sourceId,statusId:call.statusId,authorId:call.authorId,publishedAtSec:c};
 // slot-pinned head: later slots may share the head second label, so labels <= c+H are covered only if c+H < head label
 if(c+H>=l.coverage.headBlockTimeSec)return{status:'CENSORED',call:ref,reason:'S17_POST_WINDOW_NOT_FULLY_COVERED'};
 const clipped=c-H<birth;
 if(clipped&&a.creation.uniqueness!=='MINT_ALLOCATED_AND_INITIALIZED_IN_THIS_TRANSACTION')return{status:'CENSORED',call:ref,reason:'S17_PRE_WINDOW_BEFORE_PROVEN_BIRTH'};
 const pre:S17Leg[]=[],tie:S17Leg[]=[],post:S17Leg[]=[];let preStart=0n;
 for(const x of l.legs){const s=x.blockTimeSec;if(s<c-H)preStart+=signed(x);else if(s<c)pre.push(x);else if(s===c)tie.push(x);else if(s<=c+H)post.push(x);}
 const before=preStart+net(pre),afterTie=before+net(tie),end=afterTie+net(post);
 if(preStart!==prefixBefore(l.legs,c-H)||before!==prefixBefore(l.legs,c)||afterTie!==prefixBefore(l.legs,c+1n)||end!==prefixBefore(l.legs,c+H+1n))throw Error('S17_WINDOW_CONSERVATION'); // programming fault, never a value
 // the call instant may fall between any two same-second legs: report every native-order prefix
 let run=before,lo=before,hi=before;const extrema:Array<{afterRawLegId:string|null;atomic:bigint}>=[{afterRawLegId:null,atomic:before}];
 for(const x of tie){run+=signed(x);extrema.push({afterRawLegId:x.rawLegId,atomic:run});if(run<lo)lo=run;if(run>hi)hi=run;}
 const ids=(xs:S17Leg[])=>xs.map(x=>x.rawLegId);
 return{status:'COMPLETE',call:ref,horizonSeconds:H,
  preBirth:clipped?{fromInclusiveSec:c-H,toExclusiveSec:birth<c?birth:c,inventoryAtomic:0n,basis:'VERIFIED_MINT_UNIQUENESS'}:null,
  postBirthZero:c+1n<birth?{fromInclusiveSec:c+1n,toExclusiveSec:birth<c+H+1n?birth:c+H+1n,inventoryAtomic:0n,basis:'VERIFIED_MINT_UNIQUENESS'}:null,
  inventory:{atPreStartAtomic:preStart,strictlyBeforeCallAtomic:before,atCall:{exactAtomic:lo===hi?lo:null,loAtomic:lo,hiAtomic:hi,nativePrefixExtrema:extrema},afterCallSecondAtomic:afterTie,atPostEndAtomic:end},
  change:{preNetAtomic:before-preStart,tieNetAtomic:afterTie-before,postNetAtomic:end-afterTie,windowNetAtomic:end-preStart},
  pre:{fromInclusiveSec:c-H,toExclusiveSec:c,flows:flowVector(pre),rawLegIds:ids(pre)},
  tie:{secondLabel:c,order:tie.length?'UNKNOWN_RELATIVE_TO_CALL':'NONE',flows:flowVector(tie),rawLegIds:ids(tie)},
  post:{fromExclusiveSec:c,toInclusiveSec:c+H,flows:flowVector(post),rawLegIds:ids(post)}, // strict post ALWAYS summed
  edgeLabels:{preStartLabelRawLegIds:ids(pre.filter(x=>x.blockTimeSec===c-H)),postEndLabelRawLegIds:ids(post.filter(x=>x.blockTimeSec===c+H))},
  association:'HISTORICAL_CREATION_ROLE_WALLET_ADDRESS_ONLY',followers:null,valued:'NOT_REQUESTED'};
}
function orderCalls(events:S17CallEvent[]):S17CallEvent[]|null{
 const st=new Set<string>(),src=new Set<string>();
 for(const e of events){if(typeof e.sourceId!=='string'||!e.sourceId||typeof e.authorId!=='string'||!e.authorId||typeof e.bodySha256!=='string'||!/^[a-f0-9]{64}$/.test(e.bodySha256)||typeof e.editState!=='string'||!e.editState||e.timePrecision!=='SECOND'||!isSec(e.publishedAtSec)||!/^[1-9][0-9]{0,19}$/.test(e.statusId)||st.has(e.statusId)||src.has(e.sourceId))return null;st.add(e.statusId);src.add(e.sourceId);}
 return [...events].sort((a,b)=>a.publishedAtSec<b.publishedAtSec?-1:a.publishedAtSec>b.publishedAtSec?1:BigInt(a.statusId)<BigInt(b.statusId)?-1:1);
}
export function evaluateS17(ledger:S17TargetLedger|null,calls:S17CallSet,cfg:S17Config):S17Result{
 if(typeof cfg.horizonSeconds!=='bigint'||cfg.horizonSeconds!==86400n||cfg.horizonSeconds>MAX_SEC||cfg.boundary!=='PRE_[c-H,c)_TIE_{c}_POST_(c,c+H]'||cfg.clock!=='INTEGER_SECOND_LABELS'||cfg.headRule!=='POST_END_LABEL_STRICTLY_BEFORE_HEAD_LABEL')throw Error('S17_CONFIG');
 if(calls.status!=='KNOWN')return{status:'MISSING',reason:'S17_ELIGIBLE_CALLS_UNAVAILABLE',upstream:calls.reason};
 if(!ledger||!ledger.actor)return{status:'MISSING',reason:'S17_ACTOR_RELATION_UNAVAILABLE',upstream:ledger?.gap??null};
 if(!ledger.coverage)return{status:'MISSING',reason:'S17_LEDGER_COVERAGE_UNPROVEN',upstream:ledger.gap};
 if(!sameToken(calls.token,ledger.actor.token))return{status:'INVALID_INPUT',reason:'S17_TOKEN_MISMATCH'};
 const v=validateS17Ledger(ledger);if(!v.ok)return v.status==='MISSING'?{status:'MISSING',reason:v.reason,upstream:null}:{status:'INVALID_INPUT',reason:v.reason};
 if(!Number.isFinite(Date.parse(calls.availableAt))||!Number.isFinite(Date.parse(ledger.coverage.availableAt)))return{status:'INVALID_INPUT',reason:'S17_AVAILABILITY_CLOCK'};
 const events=orderCalls(calls.events);if(!events)return{status:'INVALID_INPUT',reason:'S17_CALL_EVENT_INVALID'};
 if(!events.length)return{status:'NO_ELIGIBLE_EVENTS',eligible:0,calls:[]}; // undefined set, never a zero vector
 const l=ledger as ValidS17Ledger,availableAt=[l.coverage.availableAt,calls.availableAt].sort((x,y)=>Date.parse(x)-Date.parse(y)).at(-1)!;
 return{status:'EVALUATED',eligible:events.length,calls:events.map(e=>s17CallVector(l,e,cfg)),crossCallAggregate:null,
  actor:{relation:l.actor.kind,wallet:l.actor.wallet,creationSignature:l.actor.creation.signature,validity:l.actor.validity},
  coverage:{headSlot:l.coverage.headSlot,headBlockTimeSec:l.coverage.headBlockTimeSec,typedLegCensus:l.coverage.typedLegCensus,sourceHash:l.coverage.sourceHash,receiptManifestHash:l.coverage.receiptManifestHash},
  callSelectionHash:calls.selectionHash,availableAt,config:cfg};
}
export function serializeS17(v:unknown):unknown{
 if(typeof v==='bigint')return v.toString();if(Array.isArray(v))return v.map(serializeS17); // arrays keep native order
 if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,serializeS17((v as Record<string,unknown>)[k])]));
 return v;
}
