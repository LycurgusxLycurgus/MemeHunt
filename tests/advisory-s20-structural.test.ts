import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,symlinkSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';
import type {EvidenceRecord,TokenRef} from '../src/domain/contracts.js';
import {S20_FILE_BYTES,S20_IDENTITY,S20_IMPORT_METHOD,S20_FRAME_METHOD,S20_PURPOSE as S20_FRAME_PURPOSE,decodeS20SourceFrames,type S20FrameResult} from '../src/providers/advisory-s20-source-frames.js';
import {S20_SOURCE_ID,S20_SOURCE_PREFIX,S20_CAPTURE_ID,S20_ADAPTER,S20_PURPOSE,S20_METRIC_METHOD,S20_REASONS,S20_EVIDENCE_IDS,deriveS20StructuralMetric,loadS20StructuralCapture,validateS20StructuralSource,s20Owns,s20Scope,s20Hash,type S20Decoded,type S20WireRecord} from '../src/providers/advisory-s20-structural.js';

type Data={[k:string]:any};
const sha=(s:string)=>createHash('sha256').update(s).digest('hex'),dataOf=(m:{data:unknown})=>m.data as Data;

// CONSTRUCTED synthetic typed fixtures for the pure metric only. They confer no source authority and represent no retained source, receipt, model output or real account.
const A:TokenRef={chain:'solana',address:'synthetic-token-a'},B:TokenRef={chain:'solana',address:'synthetic-token-b'},C:TokenRef={chain:'solana',address:'synthetic-token-c'},OUTSIDE:TokenRef={chain:'solana',address:'synthetic-token-outside'};
const PACKAGED='2026-11-01T00:00:00.000Z',CUT='2026-11-02T00:00:00.000Z',PAIR=['syndication.body.user.id_str','fxtwitter.body.tweet.author.id'];
type Post={handle:string;userId:string};
const p=(handle:string,userId:string):Post=>({handle,userId});
let serial=0n;
function closed(token:TokenRef,posts:Post[],exclusions=1):S20FrameResult{
 const universe:Array<Record<string,unknown>>=[],events:Array<Record<string,unknown>>=[];
 posts.forEach((post,i)=>{
  serial++;const statusId=String(1900000000000000000n+serial),sourceId='caller-'+statusId,publishedAt=new Date(Date.parse('2026-10-20T00:00:00.000Z')+Number(serial)*1000).toISOString();
  universe.push({seedSourceId:'synthetic-page-'+i,statusId,sourceId,identity:{userId:post.userId},disposition:'ELIGIBLE',role:'ORIGINAL'});
  events.push({sourceId,statusId,publishedAt,retrievedAt:'2026-10-25T00:00:00.000Z',role:'ORIGINAL',classification:'FORWARD_CALL',binding:'EXACT_CONTRACT',textSha256:sha('text '+statusId),bodySha256:sha('body '+statusId),nativeUserId:post.userId,handleAtRetrieval:post.handle,
   identityProof:{statusId,handleAtRetrieval:post.handle,createdSecond:publishedAt,paths:[...PAIR],receiptSha256:{syndication:sha('syn '+statusId),fxtwitter:sha('fx '+statusId)}}});
 });
 for(let i=0;i<exclusions;i++)universe.push({seedSourceId:'synthetic-excluded-'+i,disposition:'SEED_EXCLUDED',reason:'OUTSIDE_PERIOD'});
 const frame={method:S20_FRAME_METHOD,purpose:S20_FRAME_PURPOSE,token,format:'RECORDED_CALLER_CAPTURE_V2',wire:'constructed-synthetic-v1',
  scope:{kind:'PROVIDED_CALL_SAMPLE',seedMethod:'constructed-synthetic-v1',period:{start:'2026-10-11T00:00:00.000Z',end:'2026-10-25T00:00:00.000Z'},frozenAt:'2026-10-25T00:00:00.000Z',selectionHash:sha('selection '+token.address),sourceScopeHash:sha('scope '+token.address),queries:['constructed synthetic query']},
  rawSourceCatalog:{entries:1,sha256:sha('catalog '+token.address)},universe,events,
  closure:{kind:'PROVIDED_FIXED_SAMPLE_EXHAUSTED',rows:universe.length,queryExhaustive:false,platformExhaustive:false,unobserved:['CONSTRUCTED_SYNTHETIC']},
  identity:S20_IDENTITY,classification:{method:'constructed-synthetic-v1',ingress:'CONSTRUCTED'},clocks:{seedFrozenAt:'2026-10-25T00:00:00.000Z',packagedAt:PACKAGED,frameAvailableAt:PACKAGED},
  trust:['CONSTRUCTED synthetic frame; confers no source authority.']};
 return{status:'CLOSED',frameHash:sha(JSON.stringify(frame)),frame};
}
const rehash=(r:S20FrameResult,edit:(frame:Data)=>void):S20FrameResult=>{if(r.status!=='CLOSED')throw Error('FIXTURE');const frame=structuredClone(r.frame);edit(frame);return{status:'CLOSED',frameHash:sha(JSON.stringify(frame)),frame};};
type Entry={frameId:string;token:TokenRef;result:S20FrameResult};
const entry=(frameId:string,token:TokenRef,result:S20FrameResult):Entry=>({frameId,token,result});
function pack(...entries:Entry[]):S20Decoded{
 return{method:S20_IMPORT_METHOD,purpose:S20_FRAME_PURPOSE,sha256:sha('constructed synthetic pack'),packagedAt:PACKAGED,cutoff:CUT,
  frames:entries.map(e=>({frameId:e.frameId,token:e.token,format:'RECORDED_CALLER_CAPTURE_V2' as const,result:e.result})),
  comparability:{identity:S20_IDENTITY,identityBasisIdenticalAcrossClosedFrames:true,searchCoverageEqual:'NOT_ASSERTED' as const,windowAligned:'NOT_ASSERTED' as const,sharedIdentitiesComputed:false as const}};
}
const derive=(token:TokenRef,...entries:Entry[])=>deriveS20StructuralMetric(token,pack(...entries),S20_EVIDENCE_IDS);
const fa=(...posts:Post[])=>entry('synthetic-a',A,closed(A,posts)),fb=(...posts:Post[])=>entry('synthetic-b',B,closed(B,posts)),fc=(...posts:Post[])=>entry('synthetic-c',C,closed(C,posts));
const ZERO={value:0,unit:'RECURRING_ORDERED_CALLER_SET_FAMILY',scope:'SUPPLIED_PROVIDED_CALL_SAMPLES_ONLY',globalPointValue:null};

test('repeated posts by one native id inside a frame count once; disjoint provided samples identify zero',()=>{
 const m=derive(A,fa(p('alpha','1001'),p('alpha','1001'),p('alpha','1001'),p('beta','1002'),p('beta','1002')),fb(p('gamma','1003'))),d=dataOf(m);
 assert.equal(m.id,'S20');assert.equal(m.quality,'KNOWN');assert.equal(m.unit,'scoped-record');assert.equal(m.reasonCode,S20_REASONS.known);assert.deepEqual(m.evidenceIds,[S20_CAPTURE_ID]);
 assert.equal(d.method,S20_METRIC_METHOD);assert.equal(d.purpose,S20_PURPOSE);assert.deepEqual(d.blockers,[]);assert.equal(d.membership.frameId,'synthetic-a');
 assert.deepEqual(d.universe.frames[0].callers,[{nativeUserId:'1001',posts:3,handlesAtRetrieval:['alpha']},{nativeUserId:'1002',posts:2,handlesAtRetrieval:['beta']}]);
 assert.deepEqual([d.universe.frames[0].eventCount,d.universe.frames[0].rows,d.universe.rows,d.universe.events],[5,6,8,6]);
 assert.deepEqual(d.necessaryPredicate.frameOccurrences,[{nativeUserId:'1001',frameIds:['synthetic-a']},{nativeUserId:'1002',frameIds:['synthetic-a']},{nativeUserId:'1003',frameIds:['synthetic-b']}]);
 assert.deepEqual([d.necessaryPredicate.distinctNativeIds,d.necessaryPredicate.recurringIdCount,d.necessaryPredicate.disprovesRecurrence],[3,0,true]);
 assert.deepEqual(d.recurrence,ZERO);
 assert.deepEqual([d.campaignFlag,d.campaignFlagStatus,d.flow,d.positiveExamples,d.nullModel],[null,'NOT_EVALUATED','NOT_EVALUATED','NOT_EVALUATED','NOT_EVALUATED']);
 assert.deepEqual([d.threshold.minimumDistinctCallers,d.threshold.minimumDistinctTokenFrames,d.threshold.basis],[2,2,'HARD_FROZEN_ORIGINAL_COMPATIBLE']);
 assert.equal(d.interpretation.globalNoCampaignAsserted,false);assert.equal(d.clocks.measurementAvailableAt,PACKAGED);
 assert.ok(d.universe.frames[0].events.every((e:Data)=>!('text' in e)&&!('citations' in e)));
});

test('one native id shared across two token frames still identifies zero recurring caller-set families',()=>{
 const m=derive(A,fa(p('alpha','1001'),p('beta','1002')),fb(p('alpha','1001'),p('gamma','1003'))),d=dataOf(m);
 assert.equal(m.quality,'KNOWN');assert.equal(m.reasonCode,S20_REASONS.known);
 assert.deepEqual(d.necessaryPredicate.idsInAtLeastTwoFrames,[{nativeUserId:'1001',frameIds:['synthetic-a','synthetic-b']}]);
 assert.deepEqual([d.necessaryPredicate.recurringIdCount,d.necessaryPredicate.satisfied],[1,false]);assert.deepEqual(d.recurrence,ZERO);
});

test('two native ids each in two token frames leave the necessary condition undisproven and the count missing',()=>{
 const m=derive(A,fa(p('alpha','1001'),p('beta','1002')),fb(p('alpha','1001'),p('beta','1002'))),d=dataOf(m);
 assert.equal(m.quality,'MISSING');assert.equal(m.reasonCode,S20_REASONS.notDisproven);assert.deepEqual(d.blockers,[]);
 assert.deepEqual([d.necessaryPredicate.recurringIdCount,d.necessaryPredicate.satisfied,d.necessaryPredicate.disprovesRecurrence],[2,true,false]);
 assert.equal(d.recurrence.value,null);assert.equal(d.clocks.measurementAvailableAt,null);assert.equal(d.campaignFlag,null);
 // The necessary predicate is conservative: two ids recurring over different frame pairs already block a zero.
 const chain=derive(B,fa(p('alpha','1001')),fb(p('alpha','1001'),p('beta','1002')),fc(p('beta','1002')));
 assert.equal(chain.quality,'MISSING');assert.equal(chain.reasonCode,S20_REASONS.notDisproven);
 assert.deepEqual(dataOf(chain).necessaryPredicate.idsInAtLeastTwoFrames,[{nativeUserId:'1001',frameIds:['synthetic-a','synthetic-b']},{nativeUserId:'1002',frameIds:['synthetic-b','synthetic-c']}]);
});

test('unclosed or unavailable source frames are missing, never empty frames',()=>{
 const gaps:Array<Extract<S20FrameResult,{code:string}>>=[{status:'UNCLOSED',code:'SOURCE_BODY_INCOMPLETE',details:['CALLER_OFFICIAL_NOT_FOUND:synthetic-page-1']},{status:'SOURCE_UNAVAILABLE',code:'RECORDED_CLASSIFICATION_ABSENT',details:[]}];
 for(const gap of gaps){
  const m=derive(A,fa(p('alpha','1001')),entry('synthetic-b',B,gap)),d=dataOf(m);
  assert.equal(m.quality,'MISSING');assert.equal(m.reasonCode,S20_REASONS.unclosed);assert.deepEqual(d.blockers,[S20_REASONS.unclosed]);
  assert.deepEqual(d.universe.frames[1],{frameId:'synthetic-b',token:B,format:'RECORDED_CALLER_CAPTURE_V2',member:false,status:gap.status,code:gap.code,details:gap.details,frameHash:null,rows:null,eventCount:null,callers:null,events:null});
  assert.deepEqual([d.universe.rows,d.universe.events,d.necessaryPredicateEvaluated,d.necessaryPredicate,d.recurrence.value],[null,null,false,null,null]);
 }
});

test('membership and the two-frame threshold gate the count; a genuinely closed empty sample may prove zero',()=>{
 const outside=derive(OUTSIDE,fa(p('alpha','1001')),fb(p('beta','1002'))),o=dataOf(outside);
 assert.equal(outside.quality,'MISSING');assert.equal(outside.reasonCode,S20_REASONS.notMember);assert.deepEqual(o.blockers,[S20_REASONS.notMember]);
 assert.deepEqual([o.membership.currentTokenMember,o.membership.frameId,o.necessaryPredicate,o.recurrence.value],[false,null,null,null]);
 assert.deepEqual(o.universe.frames.map((f:Data)=>[f.status,f.member]),[['CLOSED',false],['CLOSED',false]]);
 const single=derive(A,fa(p('alpha','1001'))),s=dataOf(single);
 assert.equal(single.quality,'MISSING');assert.equal(single.reasonCode,S20_REASONS.insufficient);assert.deepEqual(s.blockers,[S20_REASONS.insufficient]);assert.equal(s.membership.frameId,'synthetic-a');assert.equal(s.recurrence.value,null);
 assert.deepEqual(dataOf(derive(OUTSIDE,fa(p('alpha','1001')))).blockers,[S20_REASONS.notMember,S20_REASONS.insufficient]);
 const empty=derive(A,fa(p('alpha','1001')),entry('synthetic-b',B,closed(B,[],0)));
 assert.equal(empty.quality,'KNOWN');assert.equal(empty.reasonCode,S20_REASONS.known);assert.equal(dataOf(empty).universe.frames[1].rows,0);assert.deepEqual(dataOf(empty).recurrence,ZERO);
 const bothEmpty=derive(A,entry('synthetic-a',A,closed(A,[],0)),entry('synthetic-b',B,closed(B,[],0)));assert.equal(bothEmpty.quality,'KNOWN');assert.deepEqual(dataOf(bothEmpty).recurrence,ZERO);
 const allMissing=derive(A,entry('synthetic-a',A,{status:'SOURCE_UNAVAILABLE',code:'MISSING',details:[]}),entry('synthetic-b',B,{status:'SOURCE_UNAVAILABLE',code:'MISSING',details:[]}));assert.equal(allMissing.quality,'MISSING');assert.equal(dataOf(allMissing).recurrence.value,null);
});

test('a closed frame of only positive exclusions contributes no caller and may still prove zero',()=>{
 const m=derive(A,fa(p('alpha','1001')),entry('synthetic-b',B,closed(B,[],3))),d=dataOf(m);
 assert.equal(m.quality,'KNOWN');
 assert.deepEqual([d.universe.frames[1].rows,d.universe.frames[1].eventCount,d.universe.frames[1].callers,d.universe.frames[1].exclusions.length],[3,0,[],3]);
 assert.deepEqual(d.universe.frames[1].exclusions[0],{seedSourceId:'synthetic-excluded-0',disposition:'SEED_EXCLUDED',reason:'OUTSIDE_PERIOD'});
});

test('native decimal ids, not mutable handles, define callers; malformed identity or frame shape throws',()=>{
 const handles=derive(A,fa(p('alpha','1001')),fb(p('alpha','2001')));
 assert.equal(handles.quality,'KNOWN');assert.deepEqual([dataOf(handles).necessaryPredicate.distinctNativeIds,dataOf(handles).necessaryPredicate.recurringIdCount],[2,0]);
 const renamed=derive(A,fa(p('alpha','1001'),p('beta','1002')),fb(p('alpha-renamed','1001'),p('beta-renamed','1002'))),r=dataOf(renamed);
 assert.equal(renamed.quality,'MISSING');assert.equal(renamed.reasonCode,S20_REASONS.notDisproven);
 assert.deepEqual(r.necessaryPredicate.idsInAtLeastTwoFrames.map((x:Data)=>x.nativeUserId),['1001','1002']);assert.deepEqual(r.universe.frames[1].callers[0].handlesAtRetrieval,['alpha-renamed']);
 const companion=fb(p('gamma','1003')),base=()=>closed(A,[p('alpha','1001')]);
 const cases:Array<[string,()=>S20FrameResult,RegExp]>=[
  ['handle-style id',()=>rehash(base(),f=>{f.events[0].nativeUserId='x.com:alpha';f.universe[0].identity={userId:'x.com:alpha'};}),/S20_STRUCTURAL_FRAME_SHAPE/],
  ['numeric JSON id',()=>rehash(base(),f=>{f.events[0].nativeUserId=1001;}),/S20_STRUCTURAL_FRAME_SHAPE/],
  ['leading-zero id',()=>rehash(base(),f=>{f.events[0].nativeUserId='01001';}),/S20_STRUCTURAL_FRAME_SHAPE/],
  ['handle-derived authorId',()=>rehash(base(),f=>{f.events[0].authorId='x.com:alpha';}),/S20_STRUCTURAL_IDENTITY_FIELD/],
  ['bare userId field',()=>rehash(base(),f=>{f.events[0].userId='1001';}),/S20_STRUCTURAL_IDENTITY_FIELD/],
  ['row and event disagree',()=>rehash(base(),f=>{f.universe[0].identity={userId:'1009'};}),/S20_STRUCTURAL_IDENTITY_PROOF/],
  ['proof names another status',()=>rehash(base(),f=>{f.events[0].identityProof.statusId='1900000000000009999';}),/S20_STRUCTURAL_IDENTITY_PROOF/],
  ['proof names another handle',()=>rehash(base(),f=>{f.events[0].identityProof.handleAtRetrieval='other';}),/S20_STRUCTURAL_IDENTITY_PROOF/],
  ['stale frame hash',()=>{const x=base();if(x.status!=='CLOSED')throw Error('FIXTURE');return{...x,frameHash:sha('stale')};},/S20_STRUCTURAL_FRAME_HASH/],
  ['eligible row without event',()=>rehash(base(),f=>{f.events=[];}),/S20_STRUCTURAL_EVENT_MEMBERSHIP/],
  ['exclusion without reason',()=>rehash(base(),f=>{delete f.universe[1].reason;}),/S20_STRUCTURAL_EXCLUSION/],
  ['foreign identity basis',()=>rehash(base(),f=>{f.identity={...S20_IDENTITY,method:'handle-lookup-v1'};}),/S20_STRUCTURAL_FRAME_BINDING/],
  ['restamped frame clock',()=>rehash(base(),f=>{f.clocks.packagedAt=CUT;}),/S20_STRUCTURAL_FRAME_BINDING/],
  ['frame bound to another token',()=>rehash(base(),f=>{f.token=C;}),/S20_STRUCTURAL_FRAME_BINDING/],
 ];
 for(const [name,make,re] of cases)assert.throws(()=>derive(A,entry('synthetic-a',A,make()),companion),re,name);
 assert.throws(()=>derive(A,fa(p('alpha','1001')),entry('synthetic-duplicate',A,closed(A,[p('beta','1002')]))),/S20_STRUCTURAL_FRAME_IDENTITY/);
 assert.throws(()=>deriveS20StructuralMetric(A,pack(fa(p('alpha','1001')),companion),[S20_SOURCE_PREFIX+'frames']),/S20_STRUCTURAL_EVIDENCE_IDS/);
 const incomparable=pack(fa(p('alpha','1001')),companion);incomparable.comparability.identityBasisIdenticalAcrossClosedFrames=false;
 assert.throws(()=>deriveS20StructuralMetric(A,incomparable,S20_EVIDENCE_IDS),/S20_STRUCTURAL_COMPARABILITY/);
 assert.throws(()=>deriveS20StructuralMetric(A,{...pack(fa(p('alpha','1001')),companion),method:'s20-other-import' as never},S20_EVIDENCE_IDS),/S20_STRUCTURAL_SOURCE/);
 const many=Array.from({length:17},(_,i)=>{const t:TokenRef={chain:'solana',address:'synthetic-many-'+i};return entry('synthetic-many-'+i,t,closed(t,[p('h'+i,String(3000+i))]));});
 assert.throws(()=>derive(A,...many),/S20_STRUCTURAL_FRAME_COUNT/);
});

// Genuine retained portable source-frame file, read at runtime only through the unchanged frame decoder. Pins are the public projection.
const C5:TokenRef={chain:'solana',address:'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump'},PARASITE:TokenRef={chain:'solana',address:'3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump'};
// Labelled non-member stand-in (the WSOL mint, absent from the frozen frame universe); root substitutes the actual ClaudeCoin control mint.
const NON_MEMBER:TokenRef={chain:'solana',address:'So11111111111111111111111111111111111111112'};
const CUTOFF='2026-11-05T00:00:00.000Z';
const PIN={sha256:'b1c52971a353ae4a730a63dbb86cbd6a971dfc351182c662aaac4173f041fc41',packagedAt:'2026-11-04T13:53:52.566Z',
 frames:[{frameId:'c5-original-provided-call-sample',frameHash:'6fb487057cf26907f804c5461d6b44a24053be281ac2ebd0fa5930fe3e1b4cfd',rows:10,events:3,callers:2},{frameId:'parasite-original-provided-call-sample',frameHash:'5b08a5dcce1aa8c8a2f01861e1fdceed765aaf0bc5bc2c36b5e5671667b3b22a',rows:14,events:7,callers:6}]};
const portable=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(gunzipSync(readFileSync('tests/fixtures/s20-provided-call-samples.json.gz')));
function withDir<T>(run:(dir:string)=>T):T{const dir=mkdtempSync(join(tmpdir(),'s20-structural-'));try{return run(dir);}finally{rmSync(dir,{recursive:true,force:true});}}
const recordOf=(r:S20WireRecord):EvidenceRecord=>({id:r.id,sourceId:S20_SOURCE_ID,sourceType:'HISTORICAL_RECEIPT',accessMode:'USER_IMPORT',adapterVersion:S20_ADAPTER,scope:r.scope,retrievedAt:r.retrievedAt,availableAt:r.retrievedAt,contentHash:s20Hash(r.raw)});
const loaded=(text:string,token:TokenRef)=>withDir(dir=>{const file=join(dir,'capture.json');writeFileSync(file,text);return loadS20StructuralCapture(file,token,CUTOFF).records;});
const catalog=(records:S20WireRecord[])=>({evidence:records.map(recordOf),raw:Object.fromEntries(records.map(r=>[r.id,r.raw])) as Record<string,string>});
/** A strict subset of the genuine portable file: one declared frame with exactly its own raw sources, still re-derived by the decoder. */
function onlyFrame(text:string,frameId:string):string{
 const parsed=JSON.parse(text) as {manifest:{frames:Array<{frameId:string;format:string;capture?:{key:string};sources?:Record<string,{key:string}>}>};rawSources:Record<string,string>};
 const frame=parsed.manifest.frames.find(f=>f.frameId===frameId)!,keys=frame.format==='RECORDED_CALLER_CAPTURE_V2'?[frame.capture!.key]:Object.values(frame.sources!).map(r=>r.key);
 return JSON.stringify({manifest:{...parsed.manifest,frames:[frame]},rawSources:Object.fromEntries(keys.map(k=>[k,parsed.rawSources[k]!]))});
}

test('genuine provided samples: one exact capture record, pinned closed frames, both members zero and the non-member control missing',()=>{
 const records=loaded(portable,C5),r=records[0]!;
 assert.equal(records.length,1);assert.equal(r.id,S20_CAPTURE_ID);assert.equal(r.raw,portable);assert.deepEqual(r.scope,{method:S20_ADAPTER,purpose:S20_PURPOSE,role:'CAPTURE'});assert.equal(r.retrievedAt,PIN.packagedAt);
 const decoded=decodeS20SourceFrames(portable,CUTOFF);
 assert.deepEqual([decoded.sha256,decoded.packagedAt,decoded.comparability.sharedIdentitiesComputed],[PIN.sha256,PIN.packagedAt,false]);
 assert.deepEqual(decoded.frames.map(f=>[f.frameId,f.result.status]),PIN.frames.map(f=>[f.frameId,'CLOSED']));
 const {evidence,raw}=catalog(records);
 const c5=validateS20StructuralSource(C5,CUTOFF,evidence,raw).metric,parasite=validateS20StructuralSource(PARASITE,CUTOFF,evidence,raw).metric,outside=validateS20StructuralSource(NON_MEMBER,CUTOFF,evidence,raw).metric;
 for(const [m,frameId] of [[c5,PIN.frames[0]!.frameId],[parasite,PIN.frames[1]!.frameId]] as const){
  const d=dataOf(m);
  assert.equal(m.id,'S20');assert.equal(m.quality,'KNOWN');assert.equal(m.reasonCode,S20_REASONS.known);assert.deepEqual(m.evidenceIds,[S20_CAPTURE_ID]);
  assert.equal(d.membership.frameId,frameId);assert.equal(d.source.sha256,PIN.sha256);assert.equal(d.source.packagedAt,PIN.packagedAt);assert.equal(d.clocks.cutoff,CUTOFF);
  assert.deepEqual(d.universe.frames.map((f:Data)=>[f.frameId,f.status,f.frameHash,f.rows,f.eventCount,f.callers.length]),PIN.frames.map(f=>[f.frameId,'CLOSED',f.frameHash,f.rows,f.events,f.callers]));
  assert.deepEqual([d.necessaryPredicate.distinctNativeIds,d.necessaryPredicate.recurringIdCount,d.necessaryPredicate.idsInAtLeastTwoFrames],[8,0,[]]);
  assert.deepEqual(d.recurrence,ZERO);assert.deepEqual([d.campaignFlag,d.campaignFlagStatus,d.flow],[null,'NOT_EVALUATED','NOT_EVALUATED']);assert.equal(d.clocks.measurementAvailableAt,PIN.packagedAt);
 }
 assert.deepEqual(dataOf(c5).necessaryPredicate,dataOf(parasite).necessaryPredicate);
 const frames=dataOf(c5).universe.frames;
 // The C5 seed row by account 1624959407594274818 is a positive NON_FORWARD_CALL exclusion, so that account is a caller only in the Parasite frame.
 assert.ok(!frames[0].callers.some((c:Data)=>c.nativeUserId==='1624959407594274818'));
 assert.deepEqual(frames[1].callers.find((c:Data)=>c.nativeUserId==='1624959407594274818'),{nativeUserId:'1624959407594274818',posts:1,handlesAtRetrieval:['cfm_sol']});
 assert.deepEqual(frames[0].callers.find((c:Data)=>c.nativeUserId==='1509239489021030405'),{nativeUserId:'1509239489021030405',posts:2,handlesAtRetrieval:['slingoorio']});
 assert.deepEqual(frames[1].callers.find((c:Data)=>c.nativeUserId==='522211824'),{nativeUserId:'522211824',posts:2,handlesAtRetrieval:['sol_alpha_t01']});
 assert.deepEqual(frames[0].exclusions.map((x:Data)=>x.reason),['NON_FORWARD_CALL','NON_FORWARD_CALL','NON_FORWARD_CALL','NON_FORWARD_CALL','NON_FORWARD_CALL','OUTSIDE_PERIOD','UNRELATED']);
 assert.deepEqual(frames[0].clocks,{seedFrozenAt:'2026-10-25T21:45:41.038Z',qualifiedAt:'2026-10-25T22:26:09.276Z',outerImportAt:'2026-10-26T08:26:30.654Z',originalCutoff:'2026-10-26T08:26:30.786Z',packagedAt:PIN.packagedAt,receiptsRetrievedThrough:'2026-10-25T21:45:48.758Z',frameAvailableAt:PIN.packagedAt});
 const json=JSON.stringify(c5);
 assert.ok(!json.includes('please continue to make new pairs')&&!json.includes('thoughtSignature'));assert.ok(frames.every((f:Data)=>f.events.every((e:Data)=>!('text' in e)&&!('citations' in e))));
 const o=dataOf(outside);
 assert.equal(outside.quality,'MISSING');assert.equal(outside.reasonCode,S20_REASONS.notMember);assert.deepEqual(o.blockers,[S20_REASONS.notMember]);
 assert.deepEqual([o.membership.currentTokenMember,o.necessaryPredicate,o.recurrence.value,o.clocks.measurementAvailableAt],[false,null,null,null]);
 assert.deepEqual(o.universe.frames.map((f:Data)=>f.status),['CLOSED','CLOSED']);
});

test('a single genuine provided frame is missing for insufficient comparison frames, never a vacuous zero',()=>{
 const records=loaded(onlyFrame(portable,PIN.frames[0]!.frameId),C5),{evidence,raw}=catalog(records);
 const m=validateS20StructuralSource(C5,CUTOFF,evidence,raw).metric,d=dataOf(m);
 assert.equal(m.quality,'MISSING');assert.equal(m.reasonCode,S20_REASONS.insufficient);assert.deepEqual(d.blockers,[S20_REASONS.insufficient]);
 assert.deepEqual([d.universe.frames.length,d.universe.frames[0].frameHash,d.necessaryPredicate,d.recurrence.value],[1,PIN.frames[0]!.frameHash,null,null]);
 assert.deepEqual(dataOf(validateS20StructuralSource(PARASITE,CUTOFF,evidence,raw).metric).blockers,[S20_REASONS.notMember,S20_REASONS.insufficient]);
});

test('the loader reads one bounded regular UTF-8 file once without following links and leaves source errors to the frame decoder',()=>withDir(dir=>{
 const file=join(dir,'capture.json'),link=join(dir,'link.json'),folder=join(dir,'folder'),big=join(dir,'big.json'),bad=join(dir,'bad.json');
 writeFileSync(file,portable);symlinkSync(file,link);mkdirSync(folder);writeFileSync(big,Buffer.alloc(S20_FILE_BYTES+1,32));writeFileSync(bad,Buffer.concat([Buffer.from(portable,'utf8'),Buffer.from([0xc3])]));
 assert.throws(()=>loadS20StructuralCapture(link,C5,CUTOFF),/ELOOP|S20_STRUCTURAL_FILE_BOUND/);
 assert.throws(()=>loadS20StructuralCapture(folder,C5,CUTOFF),/S20_STRUCTURAL_FILE_BOUND|EISDIR/);
 assert.throws(()=>loadS20StructuralCapture(big,C5,CUTOFF),/S20_STRUCTURAL_FILE_BOUND/);
 assert.throws(()=>loadS20StructuralCapture(bad,C5,CUTOFF),/S20_STRUCTURAL_UTF8/);
 assert.throws(()=>loadS20StructuralCapture(join(dir,'absent.json'),C5,CUTOFF),/ENOENT/);
 assert.throws(()=>loadS20StructuralCapture(file,{chain:'base',address:'0x0000000000000000000000000000000000000001'},CUTOFF),/S20_STRUCTURAL_TOKEN/);
 assert.throws(()=>loadS20StructuralCapture(file,C5,'2026-11-04T13:53:52.565Z'),/S20_SOURCE_CLOCK/);
 const mutated=(edit:(parsed:Data)=>void)=>{const parsed=JSON.parse(portable) as Data;edit(parsed);const target=join(dir,'mutated.json');writeFileSync(target,JSON.stringify(parsed));return target;};
 assert.throws(()=>loadS20StructuralCapture(mutated(x=>{const k=Object.keys(x.rawSources)[0]!;x.rawSources[k]+=' ';}),C5,CUTOFF),/S20_SOURCE_SOURCE_HASH/);
 assert.throws(()=>loadS20StructuralCapture(mutated(x=>{x.manifest.method='s19-creator-singleton-birth-capture-v1';}),C5,CUTOFF),/S20_SOURCE_SCHEMA/);
 assert.throws(()=>loadS20StructuralCapture(mutated(x=>{x.manifest.frames[0].sourcePath=file;}),C5,CUTOFF),/S20_SOURCE_SCHEMA/);
 assert.throws(()=>loadS20StructuralCapture(mutated(x=>{x.rawSources.orphan='x';}),C5,CUTOFF),/S20_SOURCE_MEMBERSHIP/);
}));

test('the source guard admits exactly one owned capture record with its original bytes, scope and packaging clock',()=>{
 const r=loaded(portable,C5)[0]!,good=()=>({evidence:[recordOf(r)],raw:{[S20_CAPTURE_ID]:portable} as Record<string,string>});
 const inner=JSON.parse(portable) as {manifest:{frames:Array<{format:string;capture?:{key:string}}>};rawSources:Record<string,string>};
 const recordedCallers=inner.rawSources[inner.manifest.frames.find(f=>f.format==='RECORDED_CALLER_CAPTURE_V2')!.capture!.key]!;
 const s19=gunzipSync(readFileSync('tests/fixtures/s19-creator-singleton-birth.json.gz')).toString('utf8');
 type Catalog=ReturnType<typeof good>;
 const graft=(c:Catalog,text:string)=>{c.raw[S20_CAPTURE_ID]=text;c.evidence[0]!.contentHash=s20Hash(text);};
 const cases:Array<[string,(c:Catalog)=>void,RegExp]>=[
  ['missing raw',c=>{delete c.raw[S20_CAPTURE_ID];},/S20_STRUCTURAL_CAPTURE_REQUIRED/],
  ['missing record',c=>{c.evidence=[];},/S20_STRUCTURAL_CATALOG/],
  ['orphan reserved raw',c=>{c.raw[S20_SOURCE_PREFIX+'frames']='{}';},/S20_STRUCTURAL_CATALOG/],
  ['duplicate record',c=>{c.evidence.push({...c.evidence[0]!});},/S20_STRUCTURAL_CATALOG/],
  ['S20 adapter on foreign id',c=>{c.evidence.push({...c.evidence[0]!,id:'advisory-foreign',sourceId:'advisory-foreign'});c.raw['advisory-foreign']=portable;},/S20_STRUCTURAL_CATALOG/],
  ['S20 source on foreign id',c=>{c.evidence.push({...c.evidence[0]!,id:'advisory-other',adapterVersion:'live-v1'});},/S20_STRUCTURAL_CATALOG/],
  ['foreign source',c=>{c.evidence[0]!.sourceId='advisory-s19-singleton';},/S20_STRUCTURAL_EVIDENCE/],
  ['foreign adapter',c=>{c.evidence[0]!.adapterVersion='s19-creator-singleton-birth-source-v1';},/S20_STRUCTURAL_EVIDENCE/],
  ['public access',c=>{c.evidence[0]!.accessMode='PUBLIC_API';},/S20_STRUCTURAL_EVIDENCE/],
  ['source type',c=>{c.evidence[0]!.sourceType='RECONSTRUCTED_HISTORY';},/S20_STRUCTURAL_EVIDENCE/],
  ['hash',c=>{c.evidence[0]!.contentHash=sha('other');},/S20_STRUCTURAL_EVIDENCE/],
  ['byte edit',c=>{c.raw[S20_CAPTURE_ID]=portable+' ';},/S20_STRUCTURAL_EVIDENCE/],
  ['scope source path',c=>{c.evidence[0]!.scope={...s20Scope(),sourcePath:'/tmp/s20-capture.json'};},/S20_STRUCTURAL_EVIDENCE/],
  ['scope role',c=>{c.evidence[0]!.scope={...s20Scope(),role:'FRAME'};},/S20_STRUCTURAL_EVIDENCE/],
  ['restamped retrieval',c=>{c.evidence[0]!.retrievedAt=CUTOFF;},/S20_STRUCTURAL_CLOCK/],
  ['restamped availability',c=>{c.evidence[0]!.availableAt=CUTOFF;},/S20_STRUCTURAL_CLOCK/],
  ['old recorded caller capture graft',c=>graft(c,recordedCallers),/S20_SOURCE_SCHEMA/],
  ['old S19 capture graft',c=>graft(c,s19),/S20_SOURCE_SCHEMA/],
  ['lone surrogate',c=>graft(c,portable+String.fromCharCode(0xd800)),/S20_SOURCE_FILE_BOUND/],
  ['inner raw source edit',c=>{const x=JSON.parse(portable) as Data;const k=Object.keys(x.rawSources)[0]!;x.rawSources[k]+=' ';graft(c,JSON.stringify(x));},/S20_SOURCE_SOURCE_HASH/],
 ];
 const ok=good();assert.equal(validateS20StructuralSource(C5,CUTOFF,ok.evidence,ok.raw).metric.quality,'KNOWN');
 assert.throws(()=>validateS20StructuralSource(C5,'2026-11-04T13:53:52.565Z',ok.evidence,ok.raw),/S20_SOURCE_CLOCK/);
 for(const [name,edit,re] of cases){const c=good();edit(c);assert.throws(()=>validateS20StructuralSource(C5,CUTOFF,c.evidence,c.raw),re,name);}
 assert.ok(s20Owns(recordOf(r)));assert.ok(!s20Owns({...recordOf(r),id:'advisory-other',sourceId:'advisory-other',adapterVersion:'live-v1'}));
});
