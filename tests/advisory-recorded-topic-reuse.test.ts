import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import type {EvidenceRecord, TokenRef} from '../src/domain/contracts.js';
import {decodeRecordedCallerCapture, deriveRecordedCallerMetrics, deriveRecordedCallerTopicReuse, recordedCallerProposalPrompt, recordedCallerReviewPrompt, type RecordedCallerTopicAuthority} from '../src/providers/advisory-recorded-callers.js';
import {decodeExecutorSocialBodies, executorSocialBodyRanges} from '../src/providers/executor-social-bodies.js';
import {sourceSpans} from '../src/providers/source-model.js';
import {qualifyExecutorSemantic, validateExecutorSemantic} from '../src/providers/executor-semantic.js';

// Source-relative fixture URL works from dist/tests.
// Base fixture contains exact retained public receipts/model bytes; no new classification.
// Derived negative packets below are explicitly synthetic conformance controls.
const retained = JSON.parse(readFileSync(new URL('../../tests/fixtures/a23-retained-c5.json', import.meta.url), 'utf8'));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const CAP='advisory-recorded-callers-capture', EXEC='advisory-executor-capture', BODY='advisory-executor-bodies', ACQ='advisory-executor-acquisition';
const OLD='caller-2114322990536294691', NEXT='attention-page-5';
function fixture() {
 const f=structuredClone(retained), record=(id:string):EvidenceRecord=>f.records.find((r:EvidenceRecord)=>r.id===id);
 return {token:f.token as TokenRef,cutoff:f.cutoff as string,raw:f.rawArtifacts[CAP] as string,
  authority:{recorded:record(CAP),executor:{raw:f.rawArtifacts[EXEC],record:record(EXEC)},bodies:{raw:f.rawArtifacts[BODY],record:record(BODY)},acquisition:record(ACQ)} satisfies RecordedCallerTopicAuthority};
}
type Fixture=ReturnType<typeof fixture>;
const call=(f:Fixture)=>deriveRecordedCallerTopicReuse(f.raw,f.token,f.cutoff,f.authority);
const data=(metric:any)=>metric.data as any;
function saveRecorded(f:Fixture,c:any) { f.raw=JSON.stringify(c);f.authority.recorded.contentHash=sha(f.raw); }
function patchOldReview(f:Fixture, patch:(row:any)=>void) {
 const c=JSON.parse(f.raw),stage=c.qualification.review,v=JSON.parse(stage.response);patch(v.sources.find((s:any)=>s.id===OLD));
 stage.response=JSON.stringify(v);stage.execution.responseSha256=sha(stage.response);saveRecorded(f,c);
}
// Rebuild canonical old prompts after a synthetic provider-body edit. Do not merely
// invalidate a prompt hash and mistake decoder rejection for identity-gate coverage.
function rebindOldPrompts(f:Fixture,c:any) {
 const q=c.qualification;c.qualification=null;
 const d=decodeRecordedCallerCapture(JSON.stringify(c),f.token,f.authority.recorded.availableAt);
 q.proposal.prompt=recordedCallerProposalPrompt(d);q.proposal.execution.promptSha256=sha(q.proposal.prompt);
 q.review.prompt=recordedCallerReviewPrompt(d,q.proposal.response);q.review.execution.promptSha256=sha(q.review.prompt);
 for(const s of [q.proposal,q.review])s.execution.executionId='synthetic-conformance-'+s.execution.executor;
 c.qualification=q;saveRecorded(f,c);return decodeRecordedCallerCapture(f.raw,f.token,f.authority.recorded.availableAt);
}
// Public packet constructor supplies canonical prompts, selectors and response hashes.
// This is deterministic in-process conformance data, with no network/model execution.
async function requalify(f:Fixture,patch:(sources:any[],packet:any)=>void) {
 const c=JSON.parse(f.authority.executor.raw), responses=new Map<string,string>();
 for(const stage of Object.values(c.stages) as any[])if(stage) {const p=JSON.parse(stage.packet);responses.set(p.protocol+':'+p.stage,stage.response);}
 let tick=Date.parse('2026-10-26T08:26:00.000Z');
 const out=await qualifyExecutorSemantic(c.read,f.token,async req=>{
  let response=responses.get(req.protocol+':'+req.stage)!;
  if(req.protocol==='executor-advisory-v3'&&req.stage==='proposal') {const v=JSON.parse(response);patch(v.sources,JSON.parse(req.packet));response=JSON.stringify(v);}
  return {response,executionId:'synthetic-conformance-'+req.protocol+'-'+req.stage,modelId:null,modelIdSource:'UNREPORTED',tools:'NONE',freshSession:true};
 },()=>new Date(tick++).toISOString(),new AbortController().signal,{wire:'v3',bodyBySourceId:c.bodyBySourceId});
 f.authority.executor.raw=out.capture;f.authority.executor.record.contentHash=sha(out.capture);
 return validateExecutorSemantic(out.capture,f.token,f.authority.executor.record.availableAt);
}

test('exact retained source qualifies historical A23 only, preserves eight-member denominator and all original refs',()=>{
 const f=fixture(),before=f.raw,other=deriveRecordedCallerMetrics(f.raw,f.token,f.cutoff,[CAP]);
 const old=other.find(m=>m.id==='A23')!;assert.equal(old.quality,'MISSING');assert.equal(old.reasonCode,'HISTORICAL_CLASSIFIED_FRACTION_INCOMPLETE');assert.equal(data(old).eligible,8);assert.equal(data(old).classified,7);assert.equal(data(old).fraction,null);
 const m=call(f)!;assert.equal(m.id,'A23');assert.equal(m.quality,'KNOWN');assert.equal(data(m).eligible,8);assert.equal(data(m).classified,8);assert.equal(data(m).numerator,0);assert.equal(data(m).fraction,'0');
 assert.deepEqual(data(m).scope,data(old).scope);assert.deepEqual(data(m).recordedClassification,data(old).recordedClassification);
 const witness=data(m).topicReuse,refs=JSON.parse(JSON.parse(f.authority.executor.raw).stages.advisoryProposal.response).sources.find((s:any)=>s.id===NEXT).citations;
 assert.equal(witness.availableAt,'2026-10-26T08:26:30.654Z');assert.equal(witness.scope,'HISTORICAL_FIXED_SAMPLE_TOPIC_ONLY');assert.equal(witness.reuse.length,1);assert.deepEqual(witness.reuse[0].citations,refs);assert.equal(refs.length,5);
 assert.equal(witness.citationOffsetUnit,'UTF16_CODE_UNITS');assert.equal(witness.contextInfluence,'NOT_EXCLUDED');assert.equal(witness.classificationInput,'COMPOUND_SOURCE_WITH_PROVIDER_TRUST_OWN_BODY_AND_ORIGINAL_RENDERED_PAGE');assert.equal(witness.reuse[0].historicalProposedTopic,'PRICE_CHART');assert.equal(witness.reuse[0].historicalReviewTopic,false);
 const body=decodeExecutorSocialBodies(f.authority.bodies.raw,f.token,f.authority.bodies.record.availableAt),currentRead=JSON.parse(f.authority.executor.raw).read;
 const binding=body.sourceBindings.find(s=>s.sourceId===NEXT)!,originalSource=currentRead.sources.find((s:any)=>s.id===NEXT),spans=sourceSpans(NEXT,originalSource.text,'RECORDED_CALLER');
 assert.ok(binding.layer);assert.ok(binding.range);
 const resolved=refs.map((ref:any)=>spans.find(s=>s.id===ref.spanId&&s.sourceId===ref.sourceId)!);
 const core=(r:any)=>Object.fromEntries(['sourceId','statusId','bodyStart','bodyEnd','firstLineId','lastLineId','bodySha256','bodyUtf16','literalContract'].map(k=>[k,r[k]]));
 const range=executorSocialBodyRanges(body.read,body.bodyBySourceId,f.token).get(NEXT)!;
 assert.equal(witness.reuse[0].rangeWitness.method,'COMPOSE_AND_REDERIVED_CORE_EQUAL');
 assert.deepEqual(witness.reuse[0].rangeWitness.composed,core(binding.range));assert.deepEqual(witness.reuse[0].rangeWitness.rederived,core(range));assert.deepEqual(core(binding.range),core(range));
 const historical=decodeRecordedCallerCapture(f.raw,f.token,f.authority.recorded.availableAt).history.layers.find(l=>l.sourceId===OLD)!;
 const semantics={completeness:historical.completeness,mintLocation:historical.mintLocation};
 assert.deepEqual(witness.reuse[0].rangeWitness.historical,semantics);assert.deepEqual(witness.reuse[0].rangeWitness.executor,semantics);
 assert.equal(binding.layer.completeness,historical.completeness);assert.equal(binding.layer.mintLocation,historical.mintLocation);
 for(const [i,actual] of witness.reuse[0].canonicalCitations.entries()) {
  const exact=resolved[i];assert.deepEqual({id:actual.id,sourceId:actual.sourceId,start:actual.start,end:actual.end,text:actual.text},exact);
  const prefixUnits:number=Math.max(0,Math.min(exact.end,binding.range.bodyStart)-exact.start);
  const bodyUnits:number=exact.end-Math.max(exact.start,binding.range.bodyStart);
  assert.equal(actual.prefixUtf16,prefixUnits);assert.equal(actual.bodyUtf16,bodyUnits);
  assert.equal(actual.scope,prefixUnits?'BODY_AND_PROVIDER_TRUST_PREFIX':'OWN_BODY');assert.ok(bodyUnits>0);assert.ok(exact.end<=binding.range.bodyEnd);
 }
 assert.equal(witness.reuse[0].canonicalCitations.filter((c:any)=>c.scope==='BODY_AND_PROVIDER_TRUST_PREFIX').length,1);
 assert.equal(witness.reuse[0].canonicalCitations.filter((c:any)=>c.scope==='OWN_BODY').length,4);
 assert.equal(witness.reuse[0].bodySha256,'b636a34e0e8ee4f02853b5ad4614898de031fb0ce6bd408f72bc4574f76fce51');
 assert.equal(f.raw,before);assert.deepEqual(deriveRecordedCallerMetrics(f.raw,f.token,f.cutoff,[CAP]),other);
 const current=validateExecutorSemantic(f.authority.executor.raw,f.token,f.authority.executor.record.availableAt);assert.equal(current.semantic!.sources.find(s=>s.id==='attention-page-6')!.accepted,false);
});

test('historical result remains usable at later cutoff while executor admission uses actual stored source time',()=>{
 const f=fixture();f.cutoff='2026-10-29T09:00:00.000Z';assert.equal(call(f)!.quality,'KNOWN');
 // Source clocks and execution clocks must remain their retained historical values.
 assert.equal(data(call(f)).topicReuse.executorRecordAvailableAt,retained.records.find((r:any)=>r.id===EXEC).availableAt);
});

test('individually valid historical review rejects cannot be laundered and known old topics are never replaced',()=>{
 for(const [field,value] of [['binding',false],['complete',false],['topic',true]] as const) {
  const f=fixture();patchOldReview(f,row=>{row[field]=value;});
  decodeRecordedCallerCapture(f.raw,f.token,f.authority.recorded.availableAt);assert.equal(call(f),null,field);
 }
 const f=fixture(),c=JSON.parse(f.raw);c.qualification=null;saveRecorded(f,c);assert.equal(call(f),null);
});

test('retained executor whole-source rejection or UNKNOWN topic cannot supply positive authority',async()=>{
 const f=fixture(),c=JSON.parse(f.authority.executor.raw),s=c.stages.advisoryReview,v=JSON.parse(s.response);
 v.sources.find((r:any)=>r.id===NEXT).accepted=false;s.response=JSON.stringify(v);s.receipt.responseSha256=sha(s.response);
 f.authority.executor.raw=JSON.stringify(c);f.authority.executor.record.contentHash=sha(f.authority.executor.raw);
 const decoded=validateExecutorSemantic(f.authority.executor.raw,f.token,f.authority.executor.record.availableAt);assert.equal(decoded.semantic!.sources.find(r=>r.id===NEXT)!.accepted,false);assert.equal(call(f),null);
 const unknown=fixture();const result=await requalify(unknown,rows=>{rows.find(r=>r.id===NEXT).topic='UNKNOWN';});
 assert.equal(result.semantic!.sources.find(r=>r.id===NEXT)!.topic,'UNKNOWN');assert.equal(call(unknown),null);
});

test('complete valid changed historical own body is refused despite re-bound canonical prompts',()=>{
 const f=fixture(),c=JSON.parse(f.raw),key='caller-history:2114322990536294691:fxtwitter',receipt=JSON.parse(c.callers.rawArtifacts[key]),payload=JSON.parse(receipt.body),t=payload.tweet;
 // Change final non-facet body character without changing length, official prefix, status or target.
 const replace=(s:string)=>s.slice(0,-1)+(s.at(-1)==='x'?'y':'x');t.text=replace(t.text);t.raw_text.text=replace(t.raw_text.text);
 receipt.body=JSON.stringify(payload);c.callers.rawArtifacts[key]=JSON.stringify(receipt);
 const decoded=rebindOldPrompts(f,c);assert.equal(decoded.history.complete,true);assert.ok(decoded.history.layers.find(l=>l.sourceId===OLD)!.bodyComplete);assert.equal(call(f),null);
});

test('canonical citations to rendered context are not promoted even with an accepted review',async()=>{
 const f=fixture();const decoded=await requalify(f,(rows,packet)=>{
  const source=packet.canonical.sources.find((s:any)=>s.id===NEXT),row=rows.find(r=>r.id===NEXT);
  const context=source.spans.find((s:any)=>s.text.includes('[[ORIGINAL_RENDERED_PAGE'));
  assert.ok(context,'fixture must retain context boundary');row.citations.push({sourceId:NEXT,spanId:context.id});
 });
 // Canonical packet generation must succeed; the helper owns the stricter own-body boundary.
 assert.ok(decoded.semantic);assert.equal(call(f),null);
});

test('outer hashes, future clocks, repeated authority IDs and wrong target cannot authorize reuse',()=>{
 const mutations:Array<(f:Fixture)=>void>=[
  f=>{f.authority.recorded.contentHash='0'.repeat(64);},
  f=>{f.authority.executor.record.contentHash='0'.repeat(64);},
  f=>{f.authority.bodies.record.contentHash='0'.repeat(64);},
  f=>{f.authority.acquisition.availableAt=f.authority.acquisition.retrievedAt='2026-10-30T00:00:00.000Z';},
  f=>{f.authority.bodies.record.retrievedAt='2026-10-20T00:00:00.000Z';},
  f=>{f.authority.acquisition.id=f.authority.recorded.id;},
  f=>{f.token={...f.token,address:'3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump'};},
 ];
 for(const change of mutations){const f=fixture();change(f);assert.throws(()=>call(f));}
 const f=fixture();assert.throws(()=>deriveRecordedCallerTopicReuse(f.raw,f.token,f.cutoff,undefined as unknown as RecordedCallerTopicAuthority));
});


test('accepted UNKNOWN is deliberate uncertainty and is not a rejected topic eligible for filling',()=>{
 const f=fixture(),c=JSON.parse(f.raw),stage=c.qualification.proposal,response=JSON.parse(stage.response);
 response.sources.find((r:any)=>r.id===OLD).topic='UNKNOWN';stage.response=JSON.stringify(response);stage.execution.responseSha256=sha(stage.response);
 const review=c.qualification.review,value=JSON.parse(review.response);value.sources.find((r:any)=>r.id===OLD).topic=true;review.response=JSON.stringify(value);review.execution.responseSha256=sha(review.response);
 rebindOldPrompts(f,c);
 const baseline=deriveRecordedCallerMetrics(f.raw,f.token,f.cutoff,[CAP]).find(m=>m.id==='A23')!;
 assert.equal(baseline.quality,'MISSING');assert.equal(baseline.reasonCode,'HISTORICAL_CLASSIFIED_FRACTION_INCOMPLETE');assert.equal(data(baseline).classified,7);assert.equal(call(f),null);
});

test('body completion after the actual proposal start is refused despite an admissible earlier outer import clock',()=>{
 const f=fixture(),c=JSON.parse(f.authority.bodies.raw),proposalStarted=JSON.parse(f.authority.executor.raw).stages.advisoryProposal.receipt.startedAt;
 c.finishedAt='2026-10-26T08:25:00.000Z';f.authority.bodies.raw=JSON.stringify(c);f.authority.bodies.record.contentHash=sha(f.authority.bodies.raw);
 const decoded=decodeExecutorSocialBodies(f.authority.bodies.raw,f.token,f.authority.bodies.record.availableAt);
 assert.ok(Date.parse(decoded.availableAt)>Date.parse(proposalStarted));assert.ok(Date.parse(decoded.availableAt)<Date.parse(f.authority.bodies.record.availableAt));
 // Canonical body decode succeeds: this isolates body-versus-proposal ordering, not an invalid provider packet.
 assert.throws(()=>call(f),/TOPIC_CLOCK/);
});

test('known topic conflict elsewhere in the qualified identical-body history blocks completing the remaining rejected topic',()=>{
 const f=fixture(),c=JSON.parse(f.raw),old=decodeRecordedCallerCapture(f.raw,f.token,f.authority.recorded.availableAt),current=validateExecutorSemantic(f.authority.executor.raw,f.token,f.authority.executor.record.availableAt),bodies=decodeExecutorSocialBodies(f.authority.bodies.raw,f.token,f.authority.bodies.record.availableAt);
 const claims=JSON.parse(c.qualification.proposal.response),reviews=JSON.parse(c.qualification.review.response);
 const target=old.history.socialInput.sources.find(source=>source.id!==OLD&&claims.sources.find((r:any)=>r.id===source.id)?.binding==='EXACT_CONTRACT'&&reviews.sources.find((r:any)=>r.id===source.id)?.topic===true&&current.read.sources.some(next=>next.url===source.url&&next.authorId===source.authorId&&next.publishedAt===source.publishedAt&&bodies.bodyBySourceId[next.id]===source.text&&current.semantic!.sources.some(row=>row.id===next.id&&row.complete&&row.accepted&&row.binding==='EXACT_CONTRACT'&&row.topic==='OTHER')));
 assert.ok(target,'retained corpus must offer a distinct complete positive same-body known topic control');
 claims.sources.find((r:any)=>r.id===target.id).topic='PRICE_CHART';c.qualification.proposal.response=JSON.stringify(claims);c.qualification.proposal.execution.responseSha256=sha(c.qualification.proposal.response);rebindOldPrompts(f,c);
 assert.equal(deriveRecordedCallerMetrics(f.raw,f.token,f.cutoff,[CAP]).find(m=>m.id==='A23')!.reasonCode,'HISTORICAL_CLASSIFIED_FRACTION_INCOMPLETE');assert.equal(call(f),null);
});

test('accepted binding disagreement on an otherwise fully qualified historical exact-contract member voids transfer',async()=>{
 const f=fixture();const decoded=await requalify(f,rows=>{rows.find(r=>r.id===NEXT).binding='UNRELATED';});
 const row=decoded.semantic!.sources.find(r=>r.id===NEXT)!;assert.equal(row.accepted,true);assert.equal(row.complete,true);assert.equal(row.binding,'UNRELATED');assert.equal(call(f),null);
});
