import {isDeepStrictEqual as same} from 'node:util';
import {z} from 'zod';
import {tokenRefSchema,type TokenRef} from '../domain/contracts.js';
import type {AdvisoryMetric} from '../domain/advisory-contracts.js';

// Pure S18 study over one internal DTO the source adapter freshly re-derives from all original bytes. It binds the root-frozen profile and
// selection, checks occurrence identity and clocks and does exact bigint arithmetic. It owns no financial parser, performs no I/O and never
// imports the source module; a DTO flag or type brand is not source authority, the source validator remains the coverage authority.
export const S18_PROFILE_METHOD='s18-selected-buy-observability-components-v1' as const;
export const S18_PROFILE_SHA256='ff2d36ab99dd7dcb26e16aba029680e3e07bf2f40c1d40fc3a4eb4759e7ddfe7' as const;
/** Exact freeze clock of the root contract. A matching hash with any other clock fails, so no later profile can claim to precede the flow reads. */
export const S18_PROFILE_FROZEN_AT='2026-11-04T19:46:52.598914+00:00' as const;
export const S18_HORIZON_SECONDS=3600 as const;
export const S18_STUDY_METHOD='s18-selected-buy-observability-study-v1' as const;
export const S18_METRIC_METHOD='s18-selected-buy-observability-metric-v1' as const;
/** The root contract's frozen selection; the profile admits only this selected study. */
export const S18_SELECTION={mint:'8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump',actor:'4B5v7ydA66fABiEwNTkdzEuqsjYdLQv5BMHF3QEZxJhX',signature:'4fYPGquBzCHnAeq2SwKHrM7PDPmaKfMXa7b4bqkMvtFfn2yfT4r9Eb5mKpJ5JVxTt5PqhhBFkh9aZkRQv18UTuAJ',pool:'GBzd5ooMFkYtYgzUMKfzyaEJpvzxvm5FK4FDJcpVJJcH',quoteMint:'So11111111111111111111111111111111111111112',quoteDecimals:9,publicAnnouncement:'2110920686352863465',publicQuoteRepost:'2110921003983397064',entrySecond:1792117613} as const;
export const S18_REASONS={
 known:'S18_SELECTED_BUY_OBSERVABILITY_VECTOR_MEASURED',notMember:'S18_TOKEN_NOT_MEMBER',chainUnsupported:'S18_CHAIN_UNSUPPORTED',
 entry:'S18_ENTRY_COMPONENT_MISSING',repost:'S18_REPOST_COMPONENT_MISSING',tracking:'S18_TRACKING_COMPONENT_MISSING',flow:'S18_FLOW_COMPONENT_MISSING',
 flowEntryPrerequisite:'S18_FLOW_ENTRY_PREREQUISITE_MISSING',repostEntryPrerequisite:'S18_REPOST_NATIVE_LAG_ENTRY_PREREQUISITE_MISSING'} as const;
export const S18_U64_MAX=(1n<<64n)-1n;

export type S18EventId={signature:string;slot:number;transactionIndex:number;top:number;position:number;pumpOrdinal:number;hop:number|null;routeEvent:number|null;payloadSha256:string};
export type S18StudyEvent={id:S18EventId;blockTime:number;programTimestamp:number|null;user:string;side:'BUY'|'SELL';coreQuoteAtomic:string};
export type S18Clocks={availableAt:string;evidenceIds:string[]};
export type S18Measured<T>=({status:'COMPLETE';value:T}|{status:'MISSING';reasonCode:string})&S18Clocks;
export type S18StudyInput={
 profile:{method:typeof S18_PROFILE_METHOD;sha256:typeof S18_PROFILE_SHA256;frozenAt:string;horizonSeconds:3600};
 subject:{token:TokenRef;actor:string;pool:string;quoteMint:string;quoteDecimals:9};
 entry:S18Measured<{event:S18StudyEvent;selectedBaseAccountKey:string;selectedBaseAccountPreAtomic:string;selectedBaseAccountPostAtomic:string;retrievedAt:string}>;
 reference:S18Measured<{signature:string;original:{id:string;authorId:string;publishedAt:string};quote:{id:string;authorId:string;publishedAt:string;quotedOriginalId:string};currentRetainedRevisionOnly:true;retrievedAt:{syndication:string;fxtwitter:string}}>;
 tracker:S18Measured<{wallet:string;provider:'GMGN';followCount:string;responseRetrievedAt:string;domObservedAt:string;semanticsAvailableAt:string;semantics:'GMGN_DOCUMENTED_FIELD_SEMANTICS_SIBLING_PATH_INFERRED'}>;
 flow:S18Measured<{range:{startSecond:number;endSecondExclusive:number};firstRequestStartedAt:string;events:S18StudyEvent[]}>;
 packagedAt:string;
 evaluationCutoff:string;
};

const NS=1_000_000_000n;
const INSTANT=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;
/** Exact nanoseconds since the epoch. Sub-millisecond source digits are compared exactly, never rounded through Date or toISOString. */
export function s18Instant(value:unknown):bigint|null{
 if(typeof value!=='string')return null;
 const m=INSTANT.exec(value);if(!m)return null;
 const y=Number(m[1]),mo=Number(m[2]),d=Number(m[3]),h=Number(m[4]),mi=Number(m[5]),s=Number(m[6]);
 if(mo<1||mo>12||d<1||h>23||mi>59||s>59)return null;
 const ms=Date.UTC(y,mo-1,d,h,mi,s),date=new Date(ms);
 if(!Number.isFinite(ms)||date.getUTCFullYear()!==y||date.getUTCMonth()!==mo-1||date.getUTCDate()!==d)return null;
 let offset=0n;
 if(m[8]!==undefined){const oh=Number(m[9]),om=Number(m[10]);if(oh>23||om>59)return null;offset=BigInt(oh*3600+om*60)*NS*(m[8]==='-'?-1n:1n);}
 return BigInt(ms)*1_000_000n+BigInt((m[7]??'').padEnd(9,'0'))-offset;
}
const FROZEN_NS=s18Instant(S18_PROFILE_FROZEN_AT)!;
const fail=(code:string):never=>{throw Error('S18_OBSERVABILITY_'+code);};
const check=(v:unknown,code:string):void=>{if(!v)fail(code);};
const at=(v:string,code='CLOCK'):bigint=>s18Instant(v)??fail(code);
const U64=/^(0|[1-9][0-9]{0,19})$/;
/** One canonical unsigned 64-bit leg or balance; aggregates built from these stay unbounded bigint strings. */
const u64=(v:string,code:string):bigint=>{check(typeof v==='string'&&U64.test(v),code);const n=BigInt(v);check(n<=S18_U64_MAX,code);return n;};
const seconds=(ns:bigint):string=>{const negative=ns<0n,a=negative?-ns:ns,frac=(a%NS).toString().padStart(9,'0').replace(/0+$/,'');return (negative?'-':'')+(a/NS).toString()+(frac?'.'+frac:'');};
const plain=<T>(v:T):T=>JSON.parse(JSON.stringify(v)) as T;

const instantString=z.string().refine(v=>s18Instant(v)!==null);
const base58=(min:number,max:number)=>z.string().regex(new RegExp(`^[1-9A-HJ-NP-Za-km-z]{${min},${max}}$`));
const signatureString=base58(64,88),keyString=base58(32,44),hexString=z.string().regex(/^[a-f0-9]{64}$/),u64String=z.string().regex(U64);
const nativeId=z.string().regex(/^[1-9][0-9]{0,19}$/),index=z.number().int().nonnegative();
const evidenceIdsSchema=z.array(z.string().min(1).max(128)).max(1000),sourceReason=z.string().min(1).max(256);
const eventIdSchema=z.object({signature:signatureString,slot:index,transactionIndex:index,top:index,position:z.number().int().min(-1),pumpOrdinal:index,hop:index.nullable(),routeEvent:index.nullable(),payloadSha256:hexString}).strict();
const eventSchema=z.object({id:eventIdSchema,blockTime:z.number().int().positive(),programTimestamp:z.number().int().nullable(),user:keyString,side:z.enum(['BUY','SELL']),coreQuoteAtomic:u64String}).strict();
const sourceMissing=z.object({status:z.literal('MISSING'),reasonCode:sourceReason,availableAt:instantString,evidenceIds:evidenceIdsSchema}).strict();
/** Strict internal DTO boundary; field names and literals are the frozen shared DTO. Shape failures throw before any arithmetic. */
export const s18StudyInputSchema:z.ZodType<S18StudyInput>=z.object({
 profile:z.object({method:z.literal(S18_PROFILE_METHOD),sha256:z.literal(S18_PROFILE_SHA256),frozenAt:instantString,horizonSeconds:z.literal(3600)}).strict(),
 subject:z.object({token:tokenRefSchema,actor:keyString,pool:keyString,quoteMint:keyString,quoteDecimals:z.literal(9)}).strict(),
 entry:z.union([z.object({status:z.literal('COMPLETE'),value:z.object({event:eventSchema,selectedBaseAccountKey:keyString,selectedBaseAccountPreAtomic:u64String,selectedBaseAccountPostAtomic:u64String,retrievedAt:instantString}).strict(),availableAt:instantString,evidenceIds:evidenceIdsSchema}).strict(),sourceMissing]),
 reference:z.union([z.object({status:z.literal('COMPLETE'),value:z.object({signature:signatureString,original:z.object({id:nativeId,authorId:nativeId,publishedAt:instantString}).strict(),quote:z.object({id:nativeId,authorId:nativeId,publishedAt:instantString,quotedOriginalId:nativeId}).strict(),currentRetainedRevisionOnly:z.literal(true),retrievedAt:z.object({syndication:instantString,fxtwitter:instantString}).strict()}).strict(),availableAt:instantString,evidenceIds:evidenceIdsSchema}).strict(),sourceMissing]),
 tracker:z.union([z.object({status:z.literal('COMPLETE'),value:z.object({wallet:keyString,provider:z.literal('GMGN'),followCount:u64String,responseRetrievedAt:instantString,domObservedAt:instantString,semanticsAvailableAt:instantString,semantics:z.literal('GMGN_DOCUMENTED_FIELD_SEMANTICS_SIBLING_PATH_INFERRED')}).strict(),availableAt:instantString,evidenceIds:evidenceIdsSchema}).strict(),sourceMissing]),
 flow:z.union([z.object({status:z.literal('COMPLETE'),value:z.object({range:z.object({startSecond:z.number().int(),endSecondExclusive:z.number().int()}).strict(),firstRequestStartedAt:instantString,events:z.array(eventSchema)}).strict(),availableAt:instantString,evidenceIds:evidenceIdsSchema}).strict(),sourceMissing]),
 packagedAt:instantString,
 evaluationCutoff:instantString,
}).strict();

const atomicString=z.string().regex(/^(0|[1-9][0-9]*)$/),signedAtomicString=z.string().regex(/^(0|-?[1-9][0-9]*)$/),countNumber=z.number().int().nonnegative();
const secondsString=z.string().regex(/^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/);
const missingComponentSchema=z.object({status:z.literal('MISSING'),availableAt:instantString,evidenceIds:evidenceIdsSchema,reasonCode:z.string().min(1),sourceReasonCode:sourceReason.nullable(),value:z.null()}).strict();
const knownClocks={status:z.literal('KNOWN'),availableAt:instantString,evidenceIds:evidenceIdsSchema};
const entryValueSchema=z.object({kind:z.literal('SELECTED_INCREMENTAL_BUY'),event:eventSchema,
 selectedBaseAccount:z.object({key:keyString,preAtomic:atomicString,postAtomic:atomicString,increaseAtomic:atomicString,scope:z.literal('ONE_SELECTED_BASE_TOKEN_ACCOUNT'),wholeWalletPositionAsserted:z.literal(false),allTokenAccountsAsserted:z.literal(false),costBasisAsserted:z.literal(false)}).strict(),
 additionalAcquisitionProven:z.literal(true),firstEntryAsserted:z.literal(false),zeroToPositiveAsserted:z.literal(false),humanOrControllerAsserted:z.literal(false),
 retrievedAt:instantString,eventClock:z.literal('CHAIN_BLOCK_TIME'),programTimestampUsedForMembership:z.literal(false)}).strict();
const repostValueSchema=z.object({relation:z.literal('SELECTED_OBSERVED_QUOTE_OF_RECEIPT_BEARING_ORIGINAL'),signature:signatureString,
 original:z.object({id:nativeId,authorId:nativeId,publishedAt:instantString}).strict(),quote:z.object({id:nativeId,authorId:nativeId,publishedAt:instantString,quotedOriginalId:nativeId}).strict(),
 currentRetainedRevisionOnly:z.literal(true),retrievedAt:z.object({syndication:instantString,fxtwitter:instantString}).strict(),
 quoteMinusOriginal:z.object({seconds:secondsString,clocks:z.literal('X_STATUS_CREATION_CLOCKS'),label:z.literal('SELECTED_OBSERVED_QUOTE_MINUS_ORIGINAL_PUBLICATION')}).strict(),
 quoteMinusNativeEntry:z.object({seconds:secondsString.nullable(),clocks:z.literal('MIXED_X_STATUS_CREATION_MINUS_CHAIN_BLOCK_TIME'),label:z.literal('SELECTED_OBSERVED_QUOTE_MINUS_SELECTED_NATIVE_BUY'),reasonCode:z.string().min(1).nullable()}).strict(),
 distinctNativeAuthorIds:z.literal(true),firstRepostAsserted:z.literal(false),minimumGlobalOrTypicalLagAsserted:z.literal(false),independentHumansOrCommunitiesAsserted:z.literal(false),authorWalletOwnershipAsserted:z.literal(false),historicalTextVerified:z.literal(false)}).strict();
const trackingValueSchema=z.object({provider:z.literal('GMGN'),wallet:keyString,followCount:atomicString,unit:z.literal('PROVIDER_REPORTED_CURRENT_TRACKED_COUNT'),semantics:z.literal('GMGN_DOCUMENTED_FIELD_SEMANTICS_SIBLING_PATH_INFERRED'),
 responseRetrievedAt:instantString,domObservedAt:instantString,semanticsAvailableAt:instantString,zeroMeansNoWatchers:z.literal(false),
 entryTimeTracking:z.literal('UNKNOWN'),globalTrackerPopulation:z.literal('UNKNOWN'),uniqueHumans:z.literal('UNKNOWN'),cacheFreshness:z.literal('UNKNOWN')}).strict();
const flowViewSchema=z.object({buyTrades:countNumber,sellTrades:countNumber,trades:countNumber,buyQuoteAtomic:atomicString,sellQuoteAtomic:atomicString,netQuoteAtomic:signedAtomicString}).strict();
const flowValueSchema=z.object({
 venue:z.object({pool:keyString,quoteMint:keyString,quoteDecimals:z.literal(9),quantity:z.literal('FEE_EXCLUSIVE_NATIVE_WSOL_CORE_QUOTE_ATOMIC')}).strict(),
 anchor:z.object({signature:signatureString,blockTime:z.number().int().positive(),eventClock:z.literal('CHAIN_BLOCK_TIME')}).strict(),
 range:z.object({startSecond:z.number().int(),endSecondExclusive:z.number().int(),horizonSeconds:z.literal(3600),membershipClock:z.literal('CHAIN_BLOCK_TIME'),programTimestampUsed:z.literal(false)}).strict(),
 firstRequestStartedAt:instantString,retainedEvents:countNumber,
 participants:z.object({actor:keyString,rule:z.literal('EXACT_EVENT_USER_LEDGER_KEY'),programAndRoutingKeysRetained:z.literal(true),peopleOrWatchersAsserted:z.literal(false)}).strict(),
 pre:z.object({rule:z.literal('T-3600<=blockTime<T'),actor:flowViewSchema,other:flowViewSchema}).strict(),
 sameSecond:z.object({rule:z.literal('blockTime==T'),actor:flowViewSchema,other:flowViewSchema,actorExcludingSelectedEntry:flowViewSchema,
  selectedEntry:z.object({id:eventIdSchema,blockTime:z.number().int().positive(),programTimestamp:z.number().int().nullable(),coreQuoteAtomic:u64String,includedOnceInActorTotal:z.literal(true)}).strict(),excludedFromPreAndPost:z.literal(true)}).strict(),
 post:z.object({rule:z.literal('T<blockTime<=T+3600'),actor:flowViewSchema,other:flowViewSchema}).strict(),
 postMinusPre:z.object({actorNetQuoteAtomic:signedAtomicString,otherNetQuoteAtomic:signedAtomicString}).strict(),
 thresholds:z.object({meaningfulBuyer:z.null(),minimumTrade:z.null(),significance:z.null()}).strict()}).strict();
const scopeSchema=z.object({entry:z.string(),tracking:z.string(),repost:z.string(),flow:z.string(),population:z.string()}).strict();
const interpretationSchema=z.object({causalCopyAsserted:z.literal(false),predictiveSkillAsserted:z.literal(false),firstEntryAsserted:z.literal(false),globalTrackerCensusAsserted:z.literal(false),independentHumansAsserted:z.literal(false),jointInstantAsserted:z.literal(false),empiricalHorizonCalibration:z.literal(false),preregistered:z.literal(false),blinded:z.literal(false),retrospectiveAfterExposure:z.literal(true)}).strict();
/** Canonical study result; a stored S18 row is accepted only as the deep-equal fresh recomputation, this schema adds arithmetic coherence. */
export const s18StudyResultSchema=z.object({
 method:z.literal(S18_STUDY_METHOD),
 profile:z.object({method:z.literal(S18_PROFILE_METHOD),sha256:z.literal(S18_PROFILE_SHA256),frozenAt:instantString,horizonSeconds:z.literal(3600)}).strict(),
 subject:z.object({token:tokenRefSchema,actor:keyString,pool:keyString,quoteMint:keyString,quoteDecimals:z.literal(9)}).strict(),
 selection:z.object({signature:z.literal(S18_SELECTION.signature),entrySecond:z.literal(S18_SELECTION.entrySecond),publicAnnouncement:z.literal(S18_SELECTION.publicAnnouncement),publicQuoteRepost:z.literal(S18_SELECTION.publicQuoteRepost),label:z.literal('SELECTED_INCREMENTAL_BUY')}).strict(),
 quality:z.enum(['KNOWN','MISSING']),reasonCode:z.string().min(1),
 blockers:z.array(z.object({component:z.enum(['entry','repost','tracking','flow']),reasonCode:z.string().min(1),sourceReasonCode:sourceReason.nullable()}).strict()).max(4),
 components:z.object({
  entry:z.union([z.object({...knownClocks,value:entryValueSchema}).strict(),missingComponentSchema]),
  repost:z.union([z.object({...knownClocks,value:repostValueSchema}).strict(),missingComponentSchema]),
  tracking:z.union([z.object({...knownClocks,value:trackingValueSchema}).strict(),missingComponentSchema]),
  flow:z.union([z.object({...knownClocks,value:flowValueSchema}).strict(),missingComponentSchema])}).strict(),
 clocks:z.object({componentAvailableAt:z.object({entry:instantString,reference:instantString,tracker:instantString,flow:instantString}).strict(),latestComponentAvailableAt:instantString,
  packagedAt:instantString,evaluationCutoff:instantString,sourceAvailableAt:instantString,measurementAvailableAt:instantString.nullable(),jointInstant:z.literal(false),mixedClocks:z.literal(true)}).strict(),
 scope:scopeSchema,interpretation:interpretationSchema,priorExposure:z.string().min(1),limitations:z.array(z.string().min(1)).min(1),
}).strict().superRefine((r,ctx)=>{
 const issue=(message:string)=>ctx.addIssue({code:'custom',message}),c=r.components,all=[c.entry,c.repost,c.tracking,c.flow];
 if((r.quality==='KNOWN')!==(r.blockers.length===0&&all.every(x=>x.status==='KNOWN'))||(r.quality==='KNOWN')!==(r.clocks.measurementAvailableAt!==null)||r.blockers.length!==all.filter(x=>x.status==='MISSING').length)issue('S18_RESULT_QUALITY');
 if(c.flow.status!=='KNOWN')return;
 const v=c.flow.value,counted=[v.pre.actor,v.pre.other,v.sameSecond.actor,v.sameSecond.other,v.post.actor,v.post.other],net=(x:{netQuoteAtomic:string})=>BigInt(x.netQuoteAtomic);
 if([...counted,v.sameSecond.actorExcludingSelectedEntry].some(x=>x.trades!==x.buyTrades+x.sellTrades||net(x)!==BigInt(x.buyQuoteAtomic)-BigInt(x.sellQuoteAtomic)))issue('S18_RESULT_FLOW');
 if(BigInt(v.postMinusPre.actorNetQuoteAtomic)!==net(v.post.actor)-net(v.pre.actor)||BigInt(v.postMinusPre.otherNetQuoteAtomic)!==net(v.post.other)-net(v.pre.other)||v.retainedEvents!==counted.reduce((n,x)=>n+x.trades,0))issue('S18_RESULT_FLOW');
});
export type S18StudyResult=z.infer<typeof s18StudyResultSchema>;
type Components=S18StudyResult['components'];
type MissingComponent=z.infer<typeof missingComponentSchema>;
type FlowView=z.infer<typeof flowViewSchema>;

const SCOPE:z.infer<typeof scopeSchema>={
 entry:'One explicitly selected, publicly referenced native PumpSwap BUY by the exact actor ledger key, bound to the frozen signature and native block second: SELECTED_INCREMENTAL_BUY, never first entry or position opening.',
 tracking:'One current provider-reported GMGN tracked count for the exact actor wallet, with separate response, DOM and semantics clocks.',
 repost:'One exact selected quote of the receipt-bearing original announcement by a distinct native X author id; the original is not its own repost.',
 flow:'Every retained native leg of the fixed selected pool in [T-3600,T+3601) native block seconds, partitioned pre, same second and post with the actor and all other event users separated.',
 population:'Only this frozen selected study. Another requested token is not a member and is never relabelled with these events; earlier genuine controls stay MISSING.'};
const INTERPRETATION:z.infer<typeof interpretationSchema>={causalCopyAsserted:false,predictiveSkillAsserted:false,firstEntryAsserted:false,globalTrackerCensusAsserted:false,independentHumansAsserted:false,jointInstantAsserted:false,empiricalHorizonCalibration:false,preregistered:false,blinded:false,retrospectiveAfterExposure:true};
const PRIOR='The selected native receipt, public reference bodies and clocks, and current GMGN response and DOM were exposed before the root profile froze; the complete native venue-flow tape and pre-baseline quantities were unread at the freeze. Retrospective secondary analysis, not preregistration, blinding or an optimal-horizon claim.';
const LIMITATIONS=[
 'The positive pre-balance of one selected base token account proves an additional acquisition into that account only; no first-entry, zero-to-positive, whole-wallet, all-account, cost-basis, human or current-controller claim is made.',
 'Tracking is a provider-reported current GMGN count whose follow_count meaning is a sibling-path inference; zero is a measured provider value, not absence of watchers. Entry-time tracking, the true tracker population, unique humans and cache freshness are unknown.',
 'The two repost lags describe one selected observed quote pair: quote minus original on X creation clocks, and quote minus native BUY on mixed X and chain clocks. Neither is a first, minimum, global or typical repost delay; distinct native author ids establish no independent people, communities or wallet ownership; only the currently retained revision is observed.',
 'Lag values subtract retained source clock labels at their supplied precision; they do not establish exact execution or publication wall-clock latency.',
 'Flow membership uses native block time only; program timestamps are preserved, never bucketed. Ledger keys are event users, not people; program and routing keys are retained. Exact fee-exclusive WSOL core quote lamports; no meaningful-buyer threshold, significance, organic, copy, causal or predictive claim; negative or empty complete windows are valid data.',
 'The 3600 s horizon is the declared operating scale matching the independently existing S16 holding scale, not an empirical calibration on this token.',
 'Components carry separate clocks and form a descriptive mixed-clock vector without a joint instant. Historical native times are never a fresh current timestamp. Hashes and source flags bind retained bytes, not provider, binary or cryptographic attestation.',
 'One selected study is not three independent positive studies or universal asset coverage; any explicit source gap reports MISSING with null values, never a fabricated zero.'];

const occurrenceKey=(i:S18EventId)=>JSON.stringify([i.signature,i.slot,i.transactionIndex,i.top,i.position,i.pumpOrdinal,i.hop,i.routeEvent,i.payloadSha256]);
/** Integer identity fields, native clocks and one canonical u64 leg; returns the exact leg amount. */
function eventAmount(e:S18StudyEvent):bigint{
 const i=e.id,nonnegative=(n:number)=>Number.isSafeInteger(n)&&n>=0;
 check(i.signature.length>0&&nonnegative(i.slot)&&nonnegative(i.transactionIndex)&&nonnegative(i.top)&&nonnegative(i.pumpOrdinal)&&Number.isSafeInteger(i.position)&&i.position>=-1&&(i.hop===null||nonnegative(i.hop))&&(i.routeEvent===null||nonnegative(i.routeEvent))&&/^[a-f0-9]{64}$/.test(i.payloadSha256),'EVENT_IDENTITY');
 check(Number.isSafeInteger(e.blockTime)&&e.blockTime>0&&(e.programTimestamp===null||Number.isSafeInteger(e.programTimestamp))&&e.user.length>0,'EVENT');
 return u64(e.coreQuoteAtomic,'AMOUNT');
}
/** Validates every retained leg and coherent occurrence identity; the source adapter owns occurrence proof, this only rejects collisions. */
function occurrences(events:S18StudyEvent[],start:number,endExclusive:number):bigint[]{
 const exact=new Set<string>(),physical=new Set<string>(),bySignature=new Map<string,string>(),bySlotIndex=new Map<string,string>(),slotTime=new Map<number,number>();
 return events.map(e=>{
  const amount=eventAmount(e),i=e.id,key=occurrenceKey(i);
  check(e.blockTime>=start&&e.blockTime<endExclusive,'FLOW_RANGE');
  check(!exact.has(key),'DUPLICATE_OCCURRENCE');exact.add(key);
  // One transaction sits at one slot, index and block time; one slot has one block time; one slot index holds one transaction.
  const placed=JSON.stringify([i.slot,i.transactionIndex,e.blockTime]),slotIndex=JSON.stringify([i.slot,i.transactionIndex]);
  check((bySignature.get(i.signature)??placed)===placed&&(bySlotIndex.get(slotIndex)??i.signature)===i.signature&&(slotTime.get(i.slot)??e.blockTime)===e.blockTime,'OCCURRENCE_CONFLICT');
  bySignature.set(i.signature,placed);bySlotIndex.set(slotIndex,i.signature);slotTime.set(i.slot,e.blockTime);
  // One physical leg (frame, hop, route event and payload) cannot reappear under another ordinal; an equal payload at a different leg stays.
  const leg=JSON.stringify([i.signature,i.top,i.position,i.hop,i.routeEvent,i.payloadSha256]);
  check(!physical.has(leg),'OCCURRENCE_CONFLICT');physical.add(leg);
  return amount;
 });
}
type Tally={buyTrades:number;sellTrades:number;buy:bigint;sell:bigint};
const tally=():Tally=>({buyTrades:0,sellTrades:0,buy:0n,sell:0n});
const add=(t:Tally,side:'BUY'|'SELL',amount:bigint)=>{if(side==='BUY'){t.buyTrades++;t.buy+=amount;}else{t.sellTrades++;t.sell+=amount;}};
const view=(t:Tally):FlowView=>({buyTrades:t.buyTrades,sellTrades:t.sellTrades,trades:t.buyTrades+t.sellTrades,buyQuoteAtomic:String(t.buy),sellQuoteAtomic:String(t.sell),netQuoteAtomic:String(t.buy-t.sell)});
const missing=(c:{availableAt:string;evidenceIds:string[]},reasonCode:string,sourceReasonCode:string|null):MissingComponent=>({status:'MISSING',availableAt:c.availableAt,evidenceIds:[...c.evidenceIds],reasonCode,sourceReasonCode,value:null});

/** Pure S18 evaluation of the subject study. Shape and hard conflicts throw S18_OBSERVABILITY_*; an explicit source gap is MISSING with known parts kept. */
export function evaluateS18Study(input:S18StudyInput):S18StudyResult{
 const parsed=s18StudyInputSchema.safeParse(input),d=parsed.success?parsed.data:fail('INPUT_SHAPE');
 const T=S18_SELECTION.entrySecond,H=S18_HORIZON_SECONDS,anchor=BigInt(T)*NS,frozen=at(d.profile.frozenAt,'PROFILE'),subject=d.subject;
 check(frozen===FROZEN_NS,'PROFILE');
 check(subject.token.chain==='solana'&&subject.token.address===S18_SELECTION.mint&&subject.actor===S18_SELECTION.actor&&subject.pool===S18_SELECTION.pool&&subject.quoteMint===S18_SELECTION.quoteMint&&subject.quoteDecimals===S18_SELECTION.quoteDecimals,'SUBJECT');
 const packaged=at(d.packagedAt),cutoff=at(d.evaluationCutoff);check(packaged<=cutoff,'CLOCK');
 // Every component, complete or missing, is available no later than packaging, which is no later than the evaluation cutoff.
 for(const c of [d.entry,d.reference,d.tracker,d.flow]){check(at(c.availableAt)<=packaged,'CLOCK');check(new Set(c.evidenceIds).size===c.evidenceIds.length&&(c.status==='MISSING'||c.evidenceIds.length>0),'EVIDENCE_IDS');}

 let entryEvent:S18StudyEvent|null=null,entry:Components['entry'];
 if(d.entry.status==='COMPLETE'){
  const v=d.entry.value,e=v.event,core=eventAmount(e);
  check(e.id.signature===S18_SELECTION.signature&&e.blockTime===T&&e.side==='BUY'&&e.user===subject.actor&&core>0n,'ENTRY');
  const pre=u64(v.selectedBaseAccountPreAtomic,'ENTRY_ACCOUNT'),post=u64(v.selectedBaseAccountPostAtomic,'ENTRY_ACCOUNT');
  // Only the one selected base account increased; that is an additional acquisition, not a wallet position or first entry.
  check(pre>0n&&post>pre&&v.selectedBaseAccountKey!==subject.actor&&v.selectedBaseAccountKey!==subject.pool,'ENTRY_ACCOUNT');
  const retrieved=at(v.retrievedAt);check(retrieved>=anchor&&retrieved<=at(d.entry.availableAt),'CLOCK');
  entryEvent=e;
  entry={status:'KNOWN',availableAt:d.entry.availableAt,evidenceIds:[...d.entry.evidenceIds],value:{kind:'SELECTED_INCREMENTAL_BUY',event:{...e,id:{...e.id}},
   selectedBaseAccount:{key:v.selectedBaseAccountKey,preAtomic:v.selectedBaseAccountPreAtomic,postAtomic:v.selectedBaseAccountPostAtomic,increaseAtomic:String(post-pre),scope:'ONE_SELECTED_BASE_TOKEN_ACCOUNT',wholeWalletPositionAsserted:false,allTokenAccountsAsserted:false,costBasisAsserted:false},
   additionalAcquisitionProven:true,firstEntryAsserted:false,zeroToPositiveAsserted:false,humanOrControllerAsserted:false,retrievedAt:v.retrievedAt,eventClock:'CHAIN_BLOCK_TIME',programTimestampUsedForMembership:false}};
 }else entry=missing(d.entry,S18_REASONS.entry,d.entry.reasonCode);

 let repost:Components['repost'];
 if(d.reference.status==='COMPLETE'){
  const v=d.reference.value,o=at(v.original.publishedAt),q=at(v.quote.publishedAt),syndication=at(v.retrievedAt.syndication),fxtwitter=at(v.retrievedAt.fxtwitter),available=at(d.reference.availableAt);
  check(v.signature===S18_SELECTION.signature&&(entryEvent===null||v.signature===entryEvent.id.signature)&&v.original.id===S18_SELECTION.publicAnnouncement&&v.quote.id===S18_SELECTION.publicQuoteRepost&&v.quote.quotedOriginalId===v.original.id&&v.quote.authorId!==v.original.authorId,'REFERENCE');
  // The receipt-bearing original follows the native BUY and the quote follows the original.
  check(o>=anchor&&q>=o,'REFERENCE_CHRONOLOGY');
  check(syndication>=q&&fxtwitter>=q&&available>=syndication&&available>=fxtwitter,'CLOCK');
  repost={status:'KNOWN',availableAt:d.reference.availableAt,evidenceIds:[...d.reference.evidenceIds],value:{relation:'SELECTED_OBSERVED_QUOTE_OF_RECEIPT_BEARING_ORIGINAL',signature:v.signature,original:{...v.original},quote:{...v.quote},currentRetainedRevisionOnly:true,retrievedAt:{...v.retrievedAt},
   quoteMinusOriginal:{seconds:seconds(q-o),clocks:'X_STATUS_CREATION_CLOCKS',label:'SELECTED_OBSERVED_QUOTE_MINUS_ORIGINAL_PUBLICATION'},
   quoteMinusNativeEntry:entryEvent?{seconds:seconds(q-anchor),clocks:'MIXED_X_STATUS_CREATION_MINUS_CHAIN_BLOCK_TIME',label:'SELECTED_OBSERVED_QUOTE_MINUS_SELECTED_NATIVE_BUY',reasonCode:null}:{seconds:null,clocks:'MIXED_X_STATUS_CREATION_MINUS_CHAIN_BLOCK_TIME',label:'SELECTED_OBSERVED_QUOTE_MINUS_SELECTED_NATIVE_BUY',reasonCode:S18_REASONS.repostEntryPrerequisite},
   distinctNativeAuthorIds:true,firstRepostAsserted:false,minimumGlobalOrTypicalLagAsserted:false,independentHumansOrCommunitiesAsserted:false,authorWalletOwnershipAsserted:false,historicalTextVerified:false}};
 }else repost=missing(d.reference,S18_REASONS.repost,d.reference.reasonCode);

 let tracking:Components['tracking'];
 if(d.tracker.status==='COMPLETE'){
  const v=d.tracker.value,available=at(d.tracker.availableAt);
  check(v.wallet===subject.actor,'TRACKER');u64(v.followCount,'TRACKER');
  check(available>=at(v.responseRetrievedAt)&&available>=at(v.domObservedAt)&&available>=at(v.semanticsAvailableAt),'CLOCK');
  tracking={status:'KNOWN',availableAt:d.tracker.availableAt,evidenceIds:[...d.tracker.evidenceIds],value:{provider:'GMGN',wallet:v.wallet,followCount:v.followCount,unit:'PROVIDER_REPORTED_CURRENT_TRACKED_COUNT',semantics:v.semantics,
   responseRetrievedAt:v.responseRetrievedAt,domObservedAt:v.domObservedAt,semanticsAvailableAt:v.semanticsAvailableAt,zeroMeansNoWatchers:false,entryTimeTracking:'UNKNOWN',globalTrackerPopulation:'UNKNOWN',uniqueHumans:'UNKNOWN',cacheFreshness:'UNKNOWN'}};
 }else tracking=missing(d.tracker,S18_REASONS.tracking,d.tracker.reasonCode);

 let flow:Components['flow'];
 if(d.flow.status==='COMPLETE'){
  const v=d.flow.value,first=at(v.firstRequestStartedAt);
  check(v.range.startSecond===T-H&&v.range.endSecondExclusive===T+H+1,'GEOMETRY');
  // Flow requests start strictly after the freeze and after the fixed window closed; entry, public and tracker sources may be earlier.
  check(first>frozen&&first>=BigInt(T+H+1)*NS,'FIRST_REQUEST');
  check(at(d.flow.availableAt)>=first,'CLOCK');
  const amounts=occurrences(v.events,v.range.startSecond,v.range.endSecondExclusive);
  const selected=entryEvent;
  if(selected){
   const selectedKey=occurrenceKey(selected.id),matches=v.events.filter(e=>occurrenceKey(e.id)===selectedKey);
   check(matches.length===1&&same(matches[0],selected),'ENTRY_FLOW_CONFLICT');
   const pre={actor:tally(),other:tally()},tie={actor:tally(),other:tally()},post={actor:tally(),other:tally()},actorExcludingSelected=tally();
   for(let k=0;k<v.events.length;k++){
    const e=v.events[k]!,bucket=e.blockTime<T?pre:e.blockTime===T?tie:post,actor=e.user===subject.actor,amount=amounts[k]!;
    add(actor?bucket.actor:bucket.other,e.side,amount);
    if(bucket===tie&&actor&&occurrenceKey(e.id)!==selectedKey)add(actorExcludingSelected,e.side,amount);
   }
   flow={status:'KNOWN',availableAt:d.flow.availableAt,evidenceIds:[...d.flow.evidenceIds],value:{
    venue:{pool:subject.pool,quoteMint:subject.quoteMint,quoteDecimals:9,quantity:'FEE_EXCLUSIVE_NATIVE_WSOL_CORE_QUOTE_ATOMIC'},
    anchor:{signature:selected.id.signature,blockTime:T,eventClock:'CHAIN_BLOCK_TIME'},
    range:{startSecond:v.range.startSecond,endSecondExclusive:v.range.endSecondExclusive,horizonSeconds:3600,membershipClock:'CHAIN_BLOCK_TIME',programTimestampUsed:false},
    firstRequestStartedAt:v.firstRequestStartedAt,retainedEvents:v.events.length,
    participants:{actor:subject.actor,rule:'EXACT_EVENT_USER_LEDGER_KEY',programAndRoutingKeysRetained:true,peopleOrWatchersAsserted:false},
    pre:{rule:'T-3600<=blockTime<T',actor:view(pre.actor),other:view(pre.other)},
    sameSecond:{rule:'blockTime==T',actor:view(tie.actor),other:view(tie.other),actorExcludingSelectedEntry:view(actorExcludingSelected),
     selectedEntry:{id:{...selected.id},blockTime:selected.blockTime,programTimestamp:selected.programTimestamp,coreQuoteAtomic:selected.coreQuoteAtomic,includedOnceInActorTotal:true},excludedFromPreAndPost:true},
    post:{rule:'T<blockTime<=T+3600',actor:view(post.actor),other:view(post.other)},
    postMinusPre:{actorNetQuoteAtomic:String(post.actor.buy-post.actor.sell-(pre.actor.buy-pre.actor.sell)),otherNetQuoteAtomic:String(post.other.buy-post.other.sell-(pre.other.buy-pre.other.sell))},
    thresholds:{meaningfulBuyer:null,minimumTrade:null,significance:null}}};
  }else flow=missing(d.flow,S18_REASONS.flowEntryPrerequisite,null);
 }else flow=missing(d.flow,S18_REASONS.flow,d.flow.reasonCode);

 const components:Components={entry,repost,tracking,flow};
 const blockers=(['entry','repost','tracking','flow'] as const).flatMap(name=>{const c=components[name];return c.status==='MISSING'?[{component:name,reasonCode:c.reasonCode,sourceReasonCode:c.sourceReasonCode}]:[];});
 const known=blockers.length===0,latest=[d.entry,d.reference,d.tracker,d.flow].map(c=>c.availableAt).reduce((a,b)=>at(b)>at(a)?b:a);
 const result:S18StudyResult={method:S18_STUDY_METHOD,profile:{...d.profile},subject:{token:{chain:subject.token.chain,address:subject.token.address},actor:subject.actor,pool:subject.pool,quoteMint:subject.quoteMint,quoteDecimals:9},
  selection:{signature:S18_SELECTION.signature,entrySecond:S18_SELECTION.entrySecond,publicAnnouncement:S18_SELECTION.publicAnnouncement,publicQuoteRepost:S18_SELECTION.publicQuoteRepost,label:'SELECTED_INCREMENTAL_BUY'},
  quality:known?'KNOWN':'MISSING',reasonCode:known?S18_REASONS.known:blockers[0]!.reasonCode,blockers,components,
  // Source availability includes packaging; every component is at or before it, so the packaging clock is the source availability.
  clocks:{componentAvailableAt:{entry:d.entry.availableAt,reference:d.reference.availableAt,tracker:d.tracker.availableAt,flow:d.flow.availableAt},latestComponentAvailableAt:latest,
   packagedAt:d.packagedAt,evaluationCutoff:d.evaluationCutoff,sourceAvailableAt:d.packagedAt,measurementAvailableAt:known?d.packagedAt:null,jointInstant:false,mixedClocks:true},
  scope:{...SCOPE},interpretation:{...INTERPRETATION},priorExposure:PRIOR,limitations:[...LIMITATIONS]};
 return plain(result);
}

/** S18 advisory metric for the requested token. The source is fully evaluated first; a non-member token is MISSING and never relabelled. */
export function deriveS18ObservabilityMetric(token:TokenRef,cutoff:string,input:S18StudyInput,ids:readonly string[]):AdvisoryMetric{
 check(tokenRefSchema.safeParse(token).success,'TOKEN');
 check(Array.isArray(ids)&&ids.length>0&&ids.every(id=>typeof id==='string'&&id.length>0)&&new Set(ids).size===ids.length,'EVIDENCE_IDS');
 const result=evaluateS18Study(input);
 check(at(cutoff,'CUTOFF')===at(result.clocks.evaluationCutoff),'CUTOFF');
 const cited=new Set(ids),c=result.components;
 check([c.entry,c.repost,c.tracking,c.flow].every(x=>x.evidenceIds.every(id=>cited.has(id))),'EVIDENCE_IDS');
 const subject=result.subject.token,supported=token.chain==='solana',member=supported&&token.address===subject.address;
 const reasonCode=!supported?S18_REASONS.chainUnsupported:!member?S18_REASONS.notMember:result.reasonCode;
 const data={method:S18_METRIC_METHOD,token:{chain:token.chain,address:token.address},
  membership:{currentTokenMember:member,studySubject:subject,selectedSignature:S18_SELECTION.signature,sourceValidated:true,rule:'Only the frozen selected study token is a member; any other requested token reports MISSING without the study values.'},
  study:member?result:null};
 return{id:'S18',quality:member&&result.quality==='KNOWN'?'KNOWN':'MISSING',unit:'scoped-record',reasonCode,evidenceIds:[...ids],data:plain(data)};
}
