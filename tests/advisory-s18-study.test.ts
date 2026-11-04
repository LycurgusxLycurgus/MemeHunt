import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {evaluateS18Study,deriveS18ObservabilityMetric,s18StudyResultSchema,s18Instant,S18_PROFILE_METHOD,S18_PROFILE_SHA256,S18_PROFILE_FROZEN_AT,S18_SELECTION,S18_REASONS,S18_U64_MAX,type S18StudyInput,type S18StudyEvent,type S18StudyResult} from '../src/providers/advisory-s18-study.js';
import {advisoryMetricSchema} from '../src/domain/advisory-contracts.js';

// CONSTRUCTED unit inputs. Only the frozen selected identity (mint, actor, pool, signature, announcement and quote ids, block second) and the
// root freeze clock are reused as fixed geometry. Every other signature, user, author id, amount, balance, count and clock is invented; none is a
// genuine source value or an S18 outcome, and no constructed COMPLETE flag here is presented as genuine source authority.
const T=S18_SELECTION.entrySecond,H=3600,CUTOFF='2026-11-05T00:00:00.000Z';
const SUBJECT={chain:'solana' as const,address:S18_SELECTION.mint};
const IDS=['constructed-s18-capture','constructed-s18-entry','constructed-s18-reference','constructed-s18-tracker','constructed-s18-flow'];
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58=(n:number,len:number)=>{let s='',x=n;for(let i=0;i<len;i++){s=B58[x%58]+s;x=Math.floor(x/58);}return s;};
const sig=(n:number)=>('ConstructedSig'+b58(n,8)).padEnd(88,'z');
const wallet=(label:string)=>('Constructed'+label).padEnd(44,'z');
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const iso=(second:number)=>new Date(second*1000).toISOString();
const ACTOR=S18_SELECTION.actor,U1=wallet('UserA'),U2=wallet('UserB'),U3=wallet('UserC'),ROUTER=wallet('Router'),ACCOUNT=wallet('Account');
const slotOf=(dt:number)=>457470153+dt*3;
type Leg={n:number;dt:number;user:string;side:'BUY'|'SELL';core:string;programTimestamp?:number|null;top?:number;position?:number;pumpOrdinal?:number;hop?:number|null;routeEvent?:number|null;payload?:string;signature?:string;txIndex?:number};
const leg=(l:Leg):S18StudyEvent=>({id:{signature:l.signature??sig(l.n),slot:slotOf(l.dt),transactionIndex:l.txIndex??1100+l.n,top:l.top??0,position:l.position??-1,pumpOrdinal:l.pumpOrdinal??0,hop:l.hop??null,routeEvent:l.routeEvent??null,payloadSha256:l.payload??sha('constructed-payload-'+l.n)},blockTime:T+l.dt,programTimestamp:l.programTimestamp===undefined?T+l.dt:l.programTimestamp,user:l.user,side:l.side,coreQuoteAtomic:l.core});
const HOP=sha('constructed-same-frame-payload');
// Index k of LEGS is constructed leg n=k; index 0 is the selected entry.
const LEGS:S18StudyEvent[]=[
 leg({n:0,dt:0,user:ACTOR,side:'BUY',core:'20000000',signature:S18_SELECTION.signature,txIndex:1027,top:5,position:2,payload:sha('constructed-selected-entry')}),
 leg({n:1,dt:-H,user:U1,side:'BUY',core:'1000000'}),
 leg({n:2,dt:-1800,user:U2,side:'SELL',core:'2500000'}),
 leg({n:3,dt:-2,user:ROUTER,side:'BUY',core:'3000000',programTimestamp:T+10}),
 leg({n:4,dt:-1,user:ACTOR,side:'SELL',core:'300000'}),
 leg({n:5,dt:0,user:U1,side:'BUY',core:'4000000'}),
 leg({n:6,dt:0,user:ACTOR,side:'SELL',core:'100'}),
 leg({n:7,dt:1,user:U3,side:'BUY',core:'7000000'}),
 leg({n:8,dt:5,user:U2,side:'BUY',core:'600000',programTimestamp:T}),
 leg({n:9,dt:H,user:U1,side:'SELL',core:'9000000'}),
 leg({n:10,dt:1200,user:ACTOR,side:'BUY',core:'50'}),
 leg({n:11,dt:30,user:ROUTER,side:'BUY',core:'1000',signature:sig(11),txIndex:1111,top:3,position:1,pumpOrdinal:0,hop:0,payload:HOP}),
 leg({n:12,dt:30,user:ROUTER,side:'BUY',core:'1000',signature:sig(11),txIndex:1111,top:3,position:1,pumpOrdinal:1,hop:1,payload:HOP})];
function base():S18StudyInput{
 return{
  profile:{method:S18_PROFILE_METHOD,sha256:S18_PROFILE_SHA256,frozenAt:S18_PROFILE_FROZEN_AT,horizonSeconds:3600},
  subject:{token:{...SUBJECT},actor:ACTOR,pool:S18_SELECTION.pool,quoteMint:S18_SELECTION.quoteMint,quoteDecimals:9},
  entry:{status:'COMPLETE',value:{event:structuredClone(LEGS[0]!),selectedBaseAccountKey:ACCOUNT,selectedBaseAccountPreAtomic:'1000',selectedBaseAccountPostAtomic:'5000',retrievedAt:'2026-11-04T19:38:00.000Z'},availableAt:'2026-11-04T19:38:00.000Z',evidenceIds:['constructed-s18-entry']},
  reference:{status:'COMPLETE',value:{signature:S18_SELECTION.signature,original:{id:S18_SELECTION.publicAnnouncement,authorId:'1000000000000000001',publishedAt:iso(T+100)},quote:{id:S18_SELECTION.publicQuoteRepost,authorId:'1000000000000000002',publishedAt:iso(T+250.5),quotedOriginalId:S18_SELECTION.publicAnnouncement},currentRetainedRevisionOnly:true,retrievedAt:{syndication:'2026-11-04T19:30:00.000Z',fxtwitter:'2026-11-04T19:31:00.000Z'}},availableAt:'2026-11-04T19:31:00.000Z',evidenceIds:['constructed-s18-reference']},
  tracker:{status:'COMPLETE',value:{wallet:ACTOR,provider:'GMGN',followCount:'7',responseRetrievedAt:'2026-11-04T19:40:00.000Z',domObservedAt:'2026-11-04T19:40:01.250Z',semanticsAvailableAt:'2026-11-04T19:41:00.000Z',semantics:'GMGN_DOCUMENTED_FIELD_SEMANTICS_SIBLING_PATH_INFERRED'},availableAt:'2026-11-04T19:41:00.000Z',evidenceIds:['constructed-s18-tracker']},
  flow:{status:'COMPLETE',value:{range:{startSecond:T-H,endSecondExclusive:T+H+1},firstRequestStartedAt:'2026-11-04T19:50:00.000Z',events:LEGS.map(e=>structuredClone(e))},availableAt:'2026-11-04T20:10:00.000Z',evidenceIds:['constructed-s18-flow']},
  packagedAt:'2026-11-04T21:00:00.000Z',evaluationCutoff:CUTOFF};
}
const entryOf=(i:S18StudyInput)=>{if(i.entry.status!=='COMPLETE')throw Error('constructed entry missing');return i.entry.value;};
const refOf=(i:S18StudyInput)=>{if(i.reference.status!=='COMPLETE')throw Error('constructed reference missing');return i.reference.value;};
const trackerOf=(i:S18StudyInput)=>{if(i.tracker.status!=='COMPLETE')throw Error('constructed tracker missing');return i.tracker.value;};
const flowOf=(i:S18StudyInput)=>{if(i.flow.status!=='COMPLETE')throw Error('constructed flow missing');return i.flow.value;};
const ev=(i:S18StudyInput,n:number)=>flowOf(i).events[n]!;
const knownFlow=(r:S18StudyResult)=>{const c=r.components.flow;if(c.status!=='KNOWN')throw Error('flow not KNOWN: '+c.reasonCode);return c.value;};
const knownRepost=(r:S18StudyResult)=>{const c=r.components.repost;if(c.status!=='KNOWN')throw Error('repost not KNOWN');return c.value;};
const knownEntry=(r:S18StudyResult)=>{const c=r.components.entry;if(c.status!=='KNOWN')throw Error('entry not KNOWN');return c.value;};
const knownTracking=(r:S18StudyResult)=>{const c=r.components.tracking;if(c.status!=='KNOWN')throw Error('tracking not KNOWN');return c.value;};
const edited=(edit:(i:S18StudyInput)=>void)=>{const i=base();edit(i);return i;};
const code=(c:string)=>new RegExp('S18_OBSERVABILITY_('+c+')$');
const missingSource=(reasonCode:string,availableAt:string,id:string)=>({status:'MISSING' as const,reasonCode,availableAt,evidenceIds:[id]});
const zeroView={buyTrades:0,sellTrades:0,trades:0,buyQuoteAtomic:'0',sellQuoteAtomic:'0',netQuoteAtomic:'0'};

test('constructed complete source yields a KNOWN descriptive vector with exact pre, tied and post partitions',()=>{
 const r=evaluateS18Study(base()),f=knownFlow(r);
 assert.equal(r.quality,'KNOWN');assert.equal(r.reasonCode,S18_REASONS.known);assert.deepEqual(r.blockers,[]);
 assert.ok(s18StudyResultSchema.safeParse(r).success);
 assert.deepEqual(f.range,{startSecond:T-H,endSecondExclusive:T+H+1,horizonSeconds:3600,membershipClock:'CHAIN_BLOCK_TIME',programTimestampUsed:false});
 assert.equal(f.retainedEvents,LEGS.length);
 assert.deepEqual(f.pre.actor,{buyTrades:0,sellTrades:1,trades:1,buyQuoteAtomic:'0',sellQuoteAtomic:'300000',netQuoteAtomic:'-300000'});
 assert.deepEqual(f.pre.other,{buyTrades:2,sellTrades:1,trades:3,buyQuoteAtomic:'4000000',sellQuoteAtomic:'2500000',netQuoteAtomic:'1500000'});
 // The selected entry is identified separately and counted exactly once in the actor tied total; other tied legs stay.
 assert.deepEqual(f.sameSecond.actor,{buyTrades:1,sellTrades:1,trades:2,buyQuoteAtomic:'20000000',sellQuoteAtomic:'100',netQuoteAtomic:'19999900'});
 assert.deepEqual(f.sameSecond.actorExcludingSelectedEntry,{buyTrades:0,sellTrades:1,trades:1,buyQuoteAtomic:'0',sellQuoteAtomic:'100',netQuoteAtomic:'-100'});
 assert.deepEqual(f.sameSecond.other,{buyTrades:1,sellTrades:0,trades:1,buyQuoteAtomic:'4000000',sellQuoteAtomic:'0',netQuoteAtomic:'4000000'});
 assert.equal(f.sameSecond.selectedEntry.id.signature,S18_SELECTION.signature);assert.equal(f.sameSecond.selectedEntry.coreQuoteAtomic,'20000000');
 assert.deepEqual(f.post.actor,{buyTrades:1,sellTrades:0,trades:1,buyQuoteAtomic:'50',sellQuoteAtomic:'0',netQuoteAtomic:'50'});
 assert.deepEqual(f.post.other,{buyTrades:4,sellTrades:1,trades:5,buyQuoteAtomic:'7602000',sellQuoteAtomic:'9000000',netQuoteAtomic:'-1398000'});
 assert.deepEqual(f.postMinusPre,{actorNetQuoteAtomic:'300050',otherNetQuoteAtomic:'-2898000'});
 assert.deepEqual(f.thresholds,{meaningfulBuyer:null,minimumTrade:null,significance:null});
});

test('exact boundaries: T-3600 and T+3600 are retained, one second beyond either edge is a range conflict',()=>{
 const f=knownFlow(evaluateS18Study(base()));assert.equal(f.pre.other.buyQuoteAtomic,'4000000');assert.equal(f.post.other.sellQuoteAtomic,'9000000');
 const shift=(n:number,dt:number)=>edited(i=>{const e=ev(i,n);e.blockTime=T+dt;e.id.slot=slotOf(dt);});
 assert.throws(()=>evaluateS18Study(shift(1,-H-1)),code('FLOW_RANGE'));
 assert.throws(()=>evaluateS18Study(shift(9,H+1)),code('FLOW_RANGE'));
 // A leg moved onto T leaves pre and joins the tied bucket.
 const tied=knownFlow(evaluateS18Study(shift(4,0)));assert.deepEqual(tied.pre.actor,zeroView);assert.equal(tied.sameSecond.actor.sellQuoteAtomic,'300100');
});

test('program timestamps are preserved but never bucket legs',()=>{
 const r=knownFlow(evaluateS18Study(base()));
 const moved=knownFlow(evaluateS18Study(edited(i=>{ev(i,3).programTimestamp=null;ev(i,8).programTimestamp=T-5000;ev(i,7).programTimestamp=T+99999;})));
 assert.deepEqual([moved.pre,moved.sameSecond,moved.post],[r.pre,r.sameSecond,r.post]);
 const shifted=edited(i=>{entryOf(i).event.programTimestamp=T-1;ev(i,0).programTimestamp=T-1;}),s=evaluateS18Study(shifted);
 assert.equal(knownEntry(s).event.programTimestamp,T-1);assert.equal(knownEntry(s).event.blockTime,T);
 assert.equal(knownFlow(s).sameSecond.selectedEntry.programTimestamp,T-1);assert.deepEqual(knownFlow(s).sameSecond.actor,r.sameSecond.actor);
});

test('occurrence identity keeps repeated same-frame hops and rejects duplicate or incoherent composites',()=>{
 const dropHop=knownFlow(evaluateS18Study(edited(i=>{flowOf(i).events.splice(12,1);})));assert.equal(dropHop.post.other.buyQuoteAtomic,'7601000');
 assert.throws(()=>evaluateS18Study(edited(i=>{flowOf(i).events.push(structuredClone(ev(i,7)));})),code('DUPLICATE_OCCURRENCE'));
 assert.throws(()=>evaluateS18Study(edited(i=>{const e=structuredClone(ev(i,7));e.id.pumpOrdinal=1;flowOf(i).events.push(e);})),code('OCCURRENCE_CONFLICT'),'invented ordinal');
 assert.throws(()=>evaluateS18Study(edited(i=>{const e=structuredClone(ev(i,7));e.id.slot=slotOf(2);e.blockTime=T+2;e.id.payloadSha256=sha('other');flowOf(i).events.push(e);})),code('OCCURRENCE_CONFLICT'),'signature at two slots');
 assert.throws(()=>evaluateS18Study(edited(i=>{const e=leg({n:16,dt:1,user:U2,side:'BUY',core:'1'});e.blockTime=T+2;flowOf(i).events.push(e);})),code('OCCURRENCE_CONFLICT'),'slot with two block times');
 assert.throws(()=>evaluateS18Study(edited(i=>{flowOf(i).events.push(leg({n:17,dt:1,user:U2,side:'BUY',core:'1',txIndex:1107}));})),code('OCCURRENCE_CONFLICT'),'two signatures at one slot index');
 // An equal payload at a different leg of the same transaction is legitimate and is not deduplicated by payload.
 const legit=knownFlow(evaluateS18Study(edited(i=>{const e=structuredClone(ev(i,12));e.id.pumpOrdinal=2;e.id.hop=2;flowOf(i).events.push(e);})));assert.equal(legit.post.other.buyTrades,5);
});

test('per-leg u64 with exact unbounded sums, valid zero legs and strict canonical amounts',()=>{
 const max=String(S18_U64_MAX),r=knownFlow(evaluateS18Study(edited(i=>{flowOf(i).events.push(leg({n:13,dt:40,user:U3,side:'BUY',core:max}),leg({n:14,dt:41,user:U3,side:'BUY',core:max}),leg({n:15,dt:-100,user:U2,side:'SELL',core:'0'}));})));
 assert.equal(r.post.other.buyQuoteAtomic,String(7602000n+2n*S18_U64_MAX));assert.equal(r.post.other.netQuoteAtomic,String(7602000n+2n*S18_U64_MAX-9000000n));
 assert.equal(r.pre.other.sellTrades,2);assert.equal(r.pre.other.sellQuoteAtomic,'2500000');
 assert.equal(JSON.parse(JSON.stringify(r)).post.other.buyQuoteAtomic,r.post.other.buyQuoteAtomic);
 for(const bad of ['-0','-1','+1','01','007','1.0','','1e3',' 1','0x10','99999999999999999999999'])assert.throws(()=>evaluateS18Study(edited(i=>{ev(i,7).coreQuoteAtomic=bad;})),code('INPUT_SHAPE|AMOUNT'),JSON.stringify(bad));
 assert.throws(()=>evaluateS18Study(edited(i=>{ev(i,7).coreQuoteAtomic=String(S18_U64_MAX+1n);})),code('AMOUNT'));
});

test('native identity integers, clocks and users are validated; position -1 is top level',()=>{
 assert.equal(ev(base(),7).id.position,-1);
 const cases:[string,(i:S18StudyInput)=>void][]=[
  ['negative slot',i=>{ev(i,7).id.slot=-1;}],['position -2',i=>{ev(i,7).id.position=-2;}],['fractional position',i=>{ev(i,7).id.position=1.5;}],
  ['NaN ordinal',i=>{ev(i,7).id.pumpOrdinal=Number.NaN;}],['negative hop',i=>{ev(i,7).id.hop=-1;}],['fractional route event',i=>{ev(i,7).id.routeEvent=0.5;}],
  ['unsafe index',i=>{ev(i,7).id.transactionIndex=2**53;}],['zero block time',i=>{ev(i,7).blockTime=0;}],['fractional program time',i=>{ev(i,7).programTimestamp=1.5;}],
  ['uppercase payload',i=>{ev(i,7).id.payloadSha256=ev(i,7).id.payloadSha256.toUpperCase();}],['empty user',i=>{ev(i,7).user='';}],['non-base58 user',i=>{ev(i,7).user='0'.repeat(44);}],
  ['extra event field',i=>{Object.assign(ev(i,7),{extra:1});}],['extra id field',i=>{Object.assign(ev(i,7).id,{eventOrdinal:0});}],['extra top field',i=>{Object.assign(i,{complete:true});}]];
 for(const [label,edit] of cases)assert.throws(()=>evaluateS18Study(edited(edit)),code('INPUT_SHAPE|EVENT_IDENTITY|EVENT'),label);
});

test('actor and every other event user are separated; program and routing keys are retained, not filtered',()=>{
 const asActor=knownFlow(evaluateS18Study(edited(i=>{ev(i,3).user=ACTOR;})));
 assert.equal(asActor.pre.actor.buyQuoteAtomic,'3000000');assert.equal(asActor.pre.other.buyQuoteAtomic,'1000000');
 const asOther=knownFlow(evaluateS18Study(edited(i=>{ev(i,10).user=U2;})));assert.deepEqual(asOther.post.actor,zeroView);assert.equal(asOther.post.other.buyTrades,5);
 assert.equal(knownFlow(evaluateS18Study(base())).participants.programAndRoutingKeysRetained,true);
});

test('a complete flow with only the selected entry gives true zero pre and post vectors',()=>{
 const r=evaluateS18Study(edited(i=>{flowOf(i).events=[structuredClone(LEGS[0]!)];})),f=knownFlow(r);
 assert.equal(r.quality,'KNOWN');assert.deepEqual(f.pre.actor,zeroView);assert.deepEqual(f.pre.other,zeroView);assert.deepEqual(f.post.actor,zeroView);assert.deepEqual(f.post.other,zeroView);
 assert.deepEqual(f.postMinusPre,{actorNetQuoteAtomic:'0',otherNetQuoteAtomic:'0'});assert.equal(f.sameSecond.actor.buyQuoteAtomic,'20000000');
});

test('explicit source gaps are MISSING with exact reasons, known components kept and no fabricated zero',()=>{
 const noEntry=evaluateS18Study(edited(i=>{i.entry=missingSource('CONSTRUCTED_ENTRY_UNSUPPORTED','2026-11-04T19:38:00.000Z','constructed-s18-entry');}));
 assert.equal(noEntry.quality,'MISSING');assert.equal(noEntry.reasonCode,S18_REASONS.entry);assert.equal(noEntry.clocks.measurementAvailableAt,null);
 assert.deepEqual(noEntry.blockers,[{component:'entry',reasonCode:S18_REASONS.entry,sourceReasonCode:'CONSTRUCTED_ENTRY_UNSUPPORTED'},{component:'flow',reasonCode:S18_REASONS.flowEntryPrerequisite,sourceReasonCode:null}]);
 assert.equal(knownTracking(noEntry).followCount,'7');
 assert.equal(knownRepost(noEntry).quoteMinusOriginal.seconds,'150.5');
 assert.deepEqual(knownRepost(noEntry).quoteMinusNativeEntry,{seconds:null,clocks:'MIXED_X_STATUS_CREATION_MINUS_CHAIN_BLOCK_TIME',label:'SELECTED_OBSERVED_QUOTE_MINUS_SELECTED_NATIVE_BUY',reasonCode:S18_REASONS.repostEntryPrerequisite});
 assert.equal(noEntry.components.flow.value,null);assert.ok(s18StudyResultSchema.safeParse(noEntry).success);
 const metric=deriveS18ObservabilityMetric(SUBJECT,CUTOFF,edited(i=>{i.entry=missingSource('CONSTRUCTED_ENTRY_UNSUPPORTED','2026-11-04T19:38:00.000Z','constructed-s18-entry');}),IDS);
 assert.equal(metric.quality,'MISSING');assert.equal(metric.reasonCode,S18_REASONS.entry);
 // The flow source is still fully validated without an entry prerequisite.
 assert.throws(()=>evaluateS18Study(edited(i=>{i.entry=missingSource('X','2026-11-04T19:38:00.000Z','constructed-s18-entry');flowOf(i).events.push(structuredClone(ev(i,7)));})),code('DUPLICATE_OCCURRENCE'));
 const gaps:[keyof typeof S18_REASONS,'repost'|'tracking'|'flow',(i:S18StudyInput)=>void][]=[
  ['repost','repost',i=>{i.reference=missingSource('CONSTRUCTED_QUOTE_UNAVAILABLE','2026-11-04T19:31:00.000Z','constructed-s18-reference');}],
  ['tracking','tracking',i=>{i.tracker=missingSource('CONSTRUCTED_GMGN_UNAVAILABLE','2026-11-04T19:41:00.000Z','constructed-s18-tracker');}],
  ['flow','flow',i=>{i.flow=missingSource('CONSTRUCTED_TAPE_INCOMPLETE','2026-11-04T20:10:00.000Z','constructed-s18-flow');}]];
 for(const [reason,component,edit] of gaps){
  const r=evaluateS18Study(edited(edit)),c=r.components[component];
  assert.equal(r.quality,'MISSING');assert.equal(r.reasonCode,S18_REASONS[reason]);assert.equal(c.status,'MISSING');assert.equal(c.value,null);
  assert.equal(r.blockers.length,1);assert.match(r.blockers[0]!.sourceReasonCode??'',/^CONSTRUCTED_/);
  assert.equal(knownEntry(r).kind,'SELECTED_INCREMENTAL_BUY');
  if(component!=='flow')assert.equal(knownFlow(r).post.other.netQuoteAtomic,'-1398000');
  if(component!=='tracking')assert.equal(knownTracking(r).followCount,'7');
  assert.equal(deriveS18ObservabilityMetric(SUBJECT,CUTOFF,edited(edit),IDS).quality,'MISSING');
 }
});

test('membership: another requested token gets honest MISSING without study values after full validation',()=>{
 const control={chain:'solana' as const,address:'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump'};
 const m=deriveS18ObservabilityMetric(control,CUTOFF,base(),IDS),data=m.data as {study:unknown;membership:{currentTokenMember:boolean;studySubject:unknown}};
 assert.equal(m.quality,'MISSING');assert.equal(m.reasonCode,S18_REASONS.notMember);assert.equal(data.study,null);assert.equal(data.membership.currentTokenMember,false);assert.deepEqual(data.membership.studySubject,SUBJECT);
 const evm=deriveS18ObservabilityMetric({chain:'base',address:'0x0000000000000000000000000000000000000001'},CUTOFF,base(),IDS);
 assert.equal(evm.quality,'MISSING');assert.equal(evm.reasonCode,S18_REASONS.chainUnsupported);
 assert.throws(()=>deriveS18ObservabilityMetric(control,CUTOFF,edited(i=>{flowOf(i).events.push(structuredClone(ev(i,7)));}),IDS),code('DUPLICATE_OCCURRENCE'));
});

test('profile, subject, geometry, entry, reference, tracker and clock bindings fail closed',()=>{
 const cases:[string,(i:S18StudyInput)=>void,string][]=[
  ['earlier freeze clock',i=>{i.profile.frozenAt='2026-11-04T19:40:00.000Z';},'PROFILE'],
  ['profile hash',i=>{(i.profile as {sha256:string}).sha256='0'.repeat(64);},'INPUT_SHAPE'],
  ['profile method',i=>{(i.profile as {method:string}).method='s18-other-v1';},'INPUT_SHAPE'],
  ['horizon',i=>{(i.profile as {horizonSeconds:number}).horizonSeconds=60;},'INPUT_SHAPE'],
  ['actor',i=>{i.subject.actor=U1;},'SUBJECT'],['pool',i=>{i.subject.pool=U2;},'SUBJECT'],['mint',i=>{i.subject.token.address=U3;},'SUBJECT'],
  ['chain',i=>{i.subject.token.chain='base';},'SUBJECT'],['quote mint',i=>{i.subject.quoteMint=U1;},'SUBJECT'],
  ['range start',i=>{flowOf(i).range.startSecond=T-H+1;},'GEOMETRY'],['range end',i=>{flowOf(i).range.endSecondExclusive=T+H;},'GEOMETRY'],
  ['entry signature',i=>{entryOf(i).event.id.signature=sig(99);},'ENTRY'],['entry side',i=>{entryOf(i).event.side='SELL';},'ENTRY'],
  ['entry user',i=>{entryOf(i).event.user=U1;},'ENTRY'],['entry second',i=>{entryOf(i).event.blockTime=T+1;},'ENTRY'],['entry zero quote',i=>{entryOf(i).event.coreQuoteAtomic='0';},'ENTRY'],
  ['account is wallet',i=>{entryOf(i).selectedBaseAccountKey=ACTOR;},'ENTRY_ACCOUNT'],['zero pre',i=>{entryOf(i).selectedBaseAccountPreAtomic='0';},'ENTRY_ACCOUNT'],
  ['no increase',i=>{entryOf(i).selectedBaseAccountPostAtomic='1000';},'ENTRY_ACCOUNT'],['pre above u64',i=>{entryOf(i).selectedBaseAccountPreAtomic=String(S18_U64_MAX+1n);},'ENTRY_ACCOUNT'],
  ['entry retrieved before block',i=>{entryOf(i).retrievedAt=iso(T-1);},'CLOCK'],['entry available before retrieval',i=>{i.entry.availableAt='2026-11-04T19:37:00.000Z';},'CLOCK'],
  ['entry differs in flow',i=>{ev(i,0).coreQuoteAtomic='20000001';},'ENTRY_FLOW_CONFLICT'],['entry absent from flow',i=>{flowOf(i).events.splice(0,1);},'ENTRY_FLOW_CONFLICT'],
  ['reference signature',i=>{refOf(i).signature=sig(98);},'REFERENCE'],['quoted original',i=>{refOf(i).quote.quotedOriginalId='1';},'REFERENCE'],
  ['same author',i=>{refOf(i).quote.authorId=refOf(i).original.authorId;},'REFERENCE'],['original id',i=>{refOf(i).original.id='123';},'REFERENCE'],
  ['quote before original',i=>{refOf(i).quote.publishedAt=iso(T+50);},'REFERENCE_CHRONOLOGY'],['original before BUY',i=>{refOf(i).original.publishedAt=iso(T-1);},'REFERENCE_CHRONOLOGY'],
  ['syndication before quote',i=>{refOf(i).retrievedAt.syndication=iso(T+200);},'CLOCK'],['reference available before retrieval',i=>{i.reference.availableAt='2026-11-04T19:30:30.000Z';},'CLOCK'],
  ['tracker wallet',i=>{trackerOf(i).wallet=U1;},'TRACKER'],['tracker count',i=>{trackerOf(i).followCount='07';},'INPUT_SHAPE'],['tracker count above u64',i=>{trackerOf(i).followCount=String(S18_U64_MAX+1n);},'TRACKER'],
  ['tracker provider',i=>{(trackerOf(i) as {provider:string}).provider='OTHER';},'INPUT_SHAPE'],['tracker before DOM',i=>{i.tracker.availableAt='2026-11-04T19:40:00.500Z';},'CLOCK'],
  ['component after packaging by 1us',i=>{i.tracker.availableAt='2026-11-04T21:00:00.000001Z';},'CLOCK'],['packaging after cutoff',i=>{i.packagedAt='2026-11-05T00:00:00.001Z';},'CLOCK'],
  ['missing component after packaging',i=>{i.tracker=missingSource('X','2026-11-04T21:00:01.000Z','constructed-s18-tracker');},'CLOCK'],
  ['impossible calendar',i=>{i.packagedAt='2026-02-30T00:00:00Z';},'INPUT_SHAPE'],
  ['first request at freeze',i=>{flowOf(i).firstRequestStartedAt=S18_PROFILE_FROZEN_AT;},'FIRST_REQUEST'],
  ['first request microseconds before freeze',i=>{flowOf(i).firstRequestStartedAt='2026-11-04T19:46:52.598Z';},'FIRST_REQUEST'],
  ['first request before window close',i=>{flowOf(i).firstRequestStartedAt=iso(T+H);},'FIRST_REQUEST'],
  ['flow available before request',i=>{i.flow.availableAt='2026-11-04T19:49:00.000Z';},'CLOCK'],
  ['duplicate evidence ids',i=>{i.flow.evidenceIds=['constructed-s18-flow','constructed-s18-flow'];},'EVIDENCE_IDS'],['complete without evidence',i=>{i.flow.evidenceIds=[];},'EVIDENCE_IDS']];
 for(const [label,edit,expected] of cases)assert.throws(()=>evaluateS18Study(edited(edit)),code(expected),label);
 // The same freeze instant in another spelling and a first request one microsecond after it are accepted; exact source strings are kept.
 const zulu=evaluateS18Study(edited(i=>{i.profile.frozenAt='2026-11-04T19:46:52.598914Z';flowOf(i).firstRequestStartedAt='2026-11-04T19:46:52.598915+00:00';}));
 assert.equal(zulu.quality,'KNOWN');assert.equal(zulu.profile.frozenAt,'2026-11-04T19:46:52.598914Z');assert.equal(knownFlow(zulu).firstRequestStartedAt,'2026-11-04T19:46:52.598915+00:00');
});

test('derive binds the run cutoff, evidence catalog and token and returns the exact AdvisoryMetric shape',()=>{
 const m=deriveS18ObservabilityMetric(SUBJECT,CUTOFF,base(),IDS);
 assert.deepEqual(Object.keys(m).sort(),['data','evidenceIds','id','quality','reasonCode','unit']);assert.ok(advisoryMetricSchema.safeParse(m).success);
 assert.equal(m.id,'S18');assert.equal(m.quality,'KNOWN');assert.equal(m.unit,'scoped-record');assert.equal(m.reasonCode,S18_REASONS.known);assert.deepEqual(m.evidenceIds,IDS);
 assert.deepEqual((m.data as {study:unknown}).study,evaluateS18Study(base()));
 assert.equal(deriveS18ObservabilityMetric(SUBJECT,'2026-11-05T01:00:00+01:00',base(),IDS).quality,'KNOWN');
 assert.throws(()=>deriveS18ObservabilityMetric(SUBJECT,'2026-11-05T00:00:01.000Z',base(),IDS),code('CUTOFF'));
 assert.throws(()=>deriveS18ObservabilityMetric(SUBJECT,CUTOFF,base(),IDS.filter(id=>id!=='constructed-s18-flow')),code('EVIDENCE_IDS'));
 assert.throws(()=>deriveS18ObservabilityMetric(SUBJECT,CUTOFF,base(),[...IDS,IDS[0]!]),code('EVIDENCE_IDS'));
 assert.throws(()=>deriveS18ObservabilityMetric(SUBJECT,CUTOFF,base(),[]),code('EVIDENCE_IDS'));
 assert.throws(()=>deriveS18ObservabilityMetric({chain:'solana',address:''},CUTOFF,base(),IDS),code('TOKEN'));
});

test('selected-account scope, labelled quote lags, revision limits and tracker semantics are explicit',()=>{
 const r=evaluateS18Study(base()),e=knownEntry(r),q=knownRepost(r),t=knownTracking(r);
 assert.deepEqual(e.selectedBaseAccount,{key:ACCOUNT,preAtomic:'1000',postAtomic:'5000',increaseAtomic:'4000',scope:'ONE_SELECTED_BASE_TOKEN_ACCOUNT',wholeWalletPositionAsserted:false,allTokenAccountsAsserted:false,costBasisAsserted:false});
 assert.equal(e.firstEntryAsserted,false);assert.equal(e.zeroToPositiveAsserted,false);assert.equal(e.additionalAcquisitionProven,true);
 assert.deepEqual(q.quoteMinusOriginal,{seconds:'150.5',clocks:'X_STATUS_CREATION_CLOCKS',label:'SELECTED_OBSERVED_QUOTE_MINUS_ORIGINAL_PUBLICATION'});
 assert.deepEqual(q.quoteMinusNativeEntry,{seconds:'250.5',clocks:'MIXED_X_STATUS_CREATION_MINUS_CHAIN_BLOCK_TIME',label:'SELECTED_OBSERVED_QUOTE_MINUS_SELECTED_NATIVE_BUY',reasonCode:null});
 assert.equal(q.currentRetainedRevisionOnly,true);assert.equal(q.historicalTextVerified,false);assert.equal(q.firstRepostAsserted,false);
 assert.equal(t.entryTimeTracking,'UNKNOWN');assert.equal(t.globalTrackerPopulation,'UNKNOWN');
 const zero=evaluateS18Study(edited(i=>{trackerOf(i).followCount='0';refOf(i).original.publishedAt=iso(T);refOf(i).quote.publishedAt=iso(T);}));
 assert.equal(zero.quality,'KNOWN');assert.equal(knownTracking(zero).followCount,'0');assert.equal(knownTracking(zero).zeroMeansNoWatchers,false);
 assert.equal(knownRepost(zero).quoteMinusOriginal.seconds,'0');assert.equal(knownRepost(zero).quoteMinusNativeEntry.seconds,'0');
});

test('component clocks stay separate, the latest exact source string is reported and availability is bounded by packaging',()=>{
 const r=evaluateS18Study(base());
 assert.equal(r.clocks.latestComponentAvailableAt,'2026-11-04T20:10:00.000Z');assert.equal(r.clocks.measurementAvailableAt,'2026-11-04T21:00:00.000Z');assert.equal(r.clocks.jointInstant,false);
 assert.deepEqual(r.clocks.componentAvailableAt,{entry:'2026-11-04T19:38:00.000Z',reference:'2026-11-04T19:31:00.000Z',tracker:'2026-11-04T19:41:00.000Z',flow:'2026-11-04T20:10:00.000Z'});
 const late=evaluateS18Study(edited(i=>{i.tracker.availableAt='2026-11-04T21:30:00.123456+01:00';}));
 assert.equal(late.clocks.latestComponentAvailableAt,'2026-11-04T21:30:00.123456+01:00');
 assert.equal(evaluateS18Study(edited(i=>{i.flow.availableAt=i.packagedAt;})).quality,'KNOWN');
});

test('evaluation is deterministic, JSON-safe and does not mutate its input',()=>{
 const input=base(),before=structuredClone(input),r=evaluateS18Study(input);
 assert.deepEqual(input,before);
 assert.deepEqual(evaluateS18Study(edited(i=>{flowOf(i).events.reverse();})),r);
 assert.deepEqual(JSON.parse(JSON.stringify(r)),r);
 const m=deriveS18ObservabilityMetric(SUBJECT,CUTOFF,input,IDS);assert.deepEqual(deriveS18ObservabilityMetric(SUBJECT,CUTOFF,input,IDS),m);assert.deepEqual(JSON.parse(JSON.stringify(m)),m);assert.deepEqual(input,before);
});

test('instants compare exact sub-millisecond digits across offsets',()=>{
 assert.equal(s18Instant('2026-11-04T19:46:52.598914+00:00'),s18Instant('2026-11-04T21:46:52.598914+02:00'));
 assert.ok(s18Instant('2026-11-04T19:46:52.598915Z')!>s18Instant(S18_PROFILE_FROZEN_AT)!);
 assert.ok(s18Instant('2026-11-04T19:46:52.598Z')!<s18Instant(S18_PROFILE_FROZEN_AT)!);
 for(const bad of ['2026-02-30T00:00:00Z','2026-11-04T24:00:00Z','2026-11-04 19:46:52Z','2026-11-04T19:46:52','2026-11-04T19:46:52.1234567890Z',12])assert.equal(s18Instant(bad),null,String(bad));
});
