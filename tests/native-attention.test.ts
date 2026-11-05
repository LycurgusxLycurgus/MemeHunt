import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,symlinkSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {z} from 'zod';
import {createSubmittedAttentionProgram} from '../src/providers/attention-model.js';
import {decodeNativeAttentionCapture,loadNativeAttentionCapture,nativeAttentionScope,NATIVE_ATTENTION_ID,NATIVE_ATTENTION_MAX_BYTES} from '../src/providers/native-attention.js';
import {nativeAttentionFixture,replaceFixtureReview,NATIVE_TEST_TOKEN,NATIVE_TEST_CUTOFF} from './native-attention-fixtures.js';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const decode=(capture:unknown,cutoff=NATIVE_TEST_CUTOFF)=>decodeNativeAttentionCapture(JSON.stringify(capture),NATIVE_TEST_TOKEN,cutoff);

test('native purpose replays full original source and canonical pair, projecting only A01/A02',async()=>{
 const capture=await nativeAttentionFixture({post:true,seed:true,structured:true}),result=decode(capture);
 assert.deepEqual(result.assessments.map(a=>[a.id,a.quality,a.projection?.value]),[['A01','KNOWN',true],['A02','KNOWN',true]]);
 assert.ok(result.assessments.every(a=>a.evidenceIds.length===1&&a.evidenceIds[0]===NATIVE_ATTENTION_ID));
 assert.deepEqual(result.read,capture.read);assert.equal(result.proposal.posts.length,1);assert.equal(result.review.decisions.length,3);
 assert.deepEqual(nativeAttentionScope(JSON.stringify(capture)),{method:capture.method,purpose:capture.purpose,contentHash:sha(JSON.stringify(capture))});
});

test('native canonical program retains literal token and narrative beyond the legacy 6000-character prefix',async()=>{
 const capture=await nativeAttentionFixture({prefix:'A bounded long project page. '.repeat(260)}),result=decode(capture);
 assert.ok(capture.read.sources[0]!.text.indexOf(NATIVE_TEST_TOKEN.address)>6000);
 assert.ok(result.proposal.claims[0]!.citations[0]!.quote.includes(NATIVE_TEST_TOKEN.address));
 assert.ok(result.assessments.every(a=>a.quality==='KNOWN'));
});

test('native rejected and stale claims remain missing rather than opposite or freshened',async()=>{
 const capture=await nativeAttentionFixture({reject:true}),result=decode(capture);
 assert.equal(result.assessments.find(a=>a.id==='A01')?.quality,'KNOWN');assert.equal(result.assessments.find(a=>a.id==='A02')?.quality,'MISSING');
 assert.equal(result.assessments.find(a=>a.id==='A02')?.projection?.value,null);
 const stale=decode(capture,'2026-10-01T12:16:00.001Z');assert.ok(stale.assessments.every(a=>a.quality==='MISSING'));
 assert.equal(stale.read.sources[0]?.availableAt,'2026-10-01T12:00:00.000Z');
});

test('native gap corpus retains incomplete collection and genuine HTTP outcome',async()=>{
 const capture=await nativeAttentionFixture({seed:true,gap:true}),result=decode(capture);
 assert.equal(result.read.complete,false);assert.ok(result.read.codes.includes('ATT_FETCH_URL_ERROR'));
 assert.equal(result.assessments[0]?.quality,'KNOWN');
});

test('native source cache cannot replace original acquisition bodies, metadata, queues or flags',async()=>{
 const original=await nativeAttentionFixture({post:true,seed:true});
 const mutations:Array<(v:any)=>void>=[
  v=>v.read.sources[1].text+=' invented prose',v=>v.read.sources[1].authorId='x.com:someoneelse',v=>v.read.sources[1].publishedAt='2026-09-01T00:00:00.000Z',v=>v.read.sources[1].url='https://x.com/other/status/100',v=>v.read.sources[1].discoveredFrom='https://foreign.example/',v=>v.read.sources.reverse(),v=>v.read.complete=false,v=>v.read.codes.push('INVENTED'),v=>v.read.postSampleComplete=false,v=>v.read.postSampleScope.complete=true,v=>v.read.queries[0]='different query',v=>delete v.read.rawArtifacts['attention-search-2'],v=>v.read.rawArtifacts['attention-orphan']='{}',v=>v.read.metadataLinks=true,v=>v.read.originRecovery={},v=>v.read.comparisonQualification={},v=>v.read.sources[0].availableAt='2026-10-01T11:59:59Z',v=>v.read.sources[0].availableAt='2026-10-01T12:01:01Z',
 ];
 for(const mutate of mutations){const copy=structuredClone(original);mutate(copy);assert.throws(()=>decode(copy),/^Error: NATIVE_ATTENTION_/,String(mutate));}
});

test('native receipt rejects changed prompt, response, causal ordering, identity or hidden stage',async()=>{
 const original=await nativeAttentionFixture({structured:true});
 const mutations:Array<(v:any)=>void>=[v=>v.token.address='11111111111111111111111111111111',v=>v.method='advisory-model-v1',v=>v.purpose='EXIT_CAPACITY',v=>v.executions.push(v.executions[1]),v=>v.executions[0].canonicalPrompt+=' altered',v=>v.executions[0].response.raw+='\n',v=>v.executions[0].provenance.exitCode=0,v=>v.executions[0].provenance.modelId='invented',v=>v.executions[0].provenance.canonicalFile.sha256='0'.repeat(64),v=>v.executions[1].startedAt='2026-10-01T12:01:59Z',v=>v.createdAt='2026-10-01T12:11:00Z',v=>v.executions[1].provenance.sessionId='other-session',v=>v.executions[1].provenance.tools=['Read'],v=>v.executions[1].provenance.exitCode=1,...['--resume','-r','--continue','-c','--fork-session','--resume=old-session'].map(flag=>(v:any)=>v.executions[1].provenance.command.push(flag)),v=>v.executions[1].input.schemaJson='{}',v=>v.executions[1].response.transportRaw='',v=>v.executions[1].provenance.initRaw='{}',v=>v.executions[1].response.raw='```json\n'+v.executions[1].response.raw+'\n```'];
 for(const mutate of mutations){const copy=structuredClone(original);mutate(copy);assert.throws(()=>decode(copy),/^Error: NATIVE_ATTENTION_/,String(mutate));}
});

test('native full review coverage and literal selector binding cannot be bypassed with rehashed JSON',async()=>{
 const capture=await nativeAttentionFixture(),review=JSON.parse(capture.executions[1].response.raw);delete review.decisions.game;replaceFixtureReview(capture,review);assert.throws(()=>decode(capture),/NATIVE_ATTENTION_CANONICAL_PROGRAM/);
 const second=await nativeAttentionFixture(),native=second.executions[0],wire=JSON.parse(native.response.raw);wire.claims[0].citations[0].spanId='invented';native.response.raw=JSON.stringify(wire);native.response.sha256=sha(native.response.raw);assert.throws(()=>decode(second),/NATIVE_ATTENTION_CANONICAL_PROGRAM/);
});

test('native file ingress rejects symlink, directory, oversized, invalid UTF8 and foreign fields',async()=>{
 const root=mkdtempSync(join(tmpdir(),'native-attention-'));
 try{const capture=await nativeAttentionFixture(),file=join(root,'capture.json');writeFileSync(file,JSON.stringify(capture));assert.equal(loadNativeAttentionCapture(file,NATIVE_TEST_TOKEN,NATIVE_TEST_CUTOFF).decoded.assessments.length,2);
 symlinkSync(file,join(root,'link'));assert.throws(()=>loadNativeAttentionCapture(join(root,'link'),NATIVE_TEST_TOKEN,NATIVE_TEST_CUTOFF),/NATIVE_ATTENTION_FILE/);
 mkdirSync(join(root,'directory'));assert.throws(()=>loadNativeAttentionCapture(join(root,'directory'),NATIVE_TEST_TOKEN,NATIVE_TEST_CUTOFF),/NATIVE_ATTENTION_FILE/);
 writeFileSync(file,Buffer.from([0xff,0xfe]));assert.throws(()=>loadNativeAttentionCapture(file,NATIVE_TEST_TOKEN,NATIVE_TEST_CUTOFF),/NATIVE_ATTENTION_FILE_UTF8/);
 writeFileSync(file,' '.repeat(NATIVE_ATTENTION_MAX_BYTES+1));assert.throws(()=>loadNativeAttentionCapture(file,NATIVE_TEST_TOKEN,NATIVE_TEST_CUTOFF),/NATIVE_ATTENTION_FILE_BOUND/);
 assert.throws(()=>decode({...capture,assessments:[]}),/NATIVE_ATTENTION_CAPTURE_SCHEMA/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

/** Constructed CLI formatter events; these do not represent actual model execution. */
function formatterCarrier(capture:Awaited<ReturnType<typeof nativeAttentionFixture>>,repair=false){
 const e=capture.executions[1],final=JSON.parse(e.response.raw),first=structuredClone(final),init=JSON.parse(e.provenance.initRaw),result=JSON.parse(e.provenance.resultRaw);
 init.tools=['StructuredOutput'];e.provenance.tools=['StructuredOutput'];
 if(repair){first.citations=first.originRelationship.citations;delete first.originRelationship.citations;}
 const firstUse={type:'tool_use',id:'constructed-format-1',name:'StructuredOutput',input:first};
 const lastUse=repair?{type:'tool_use',id:'constructed-format-2',name:'StructuredOutput',input:structuredClone(final)}:firstUse;
 const feedback={type:'tool_result',tool_use_id:'constructed-format-1',is_error:true,content:'Constructed schema failure: originRelationship.citations is required; root citations is not allowed.'};
 const packets:any[]=[init,{type:'assistant',message:{content:[firstUse]}},...(repair?[{type:'user',message:{content:[feedback]}},{type:'assistant',message:{content:[lastUse]}}]:[]),result];
 const commit=()=>{e.provenance.initRaw=JSON.stringify(init);e.provenance.resultRaw=JSON.stringify(result);e.response.transportRaw=packets.map(packet=>JSON.stringify(packet)).join('\n')+'\n';e.response.raw=JSON.stringify(result.structured_output);e.response.sha256=sha(e.response.raw);};
 commit();return {capture,init,result,firstUse,lastUse,feedback,packets,commit};
}

test('native Claude draft7 structured carrier admits one output-only formatter with exact final result',async()=>{
 const carrier=formatterCarrier(await nativeAttentionFixture({structured:true}));
 const result=decode(carrier.capture);
 assert.deepEqual(result.capture.executions[1].provenance.tools,['StructuredOutput']);
 assert.deepEqual(result.assessments.map(a=>[a.id,a.quality,a.projection?.value]),[['A01','KNOWN',true],['A02','KNOWN',true]]);
 assert.equal(JSON.parse(carrier.capture.executions[1].input.schemaJson!).$schema,'http://json-schema.org/draft-07/schema#');
});

test('native Claude formatter repair only moves unchanged root citations to missing origin citations',async()=>{
 const carrier=formatterCarrier(await nativeAttentionFixture({post:true,structured:true}),true),before=structuredClone(carrier.firstUse.input);
 const result=decode(carrier.capture),after=structuredClone(before);after.originRelationship.citations=after.citations;delete after.citations;
 assert.deepEqual(after,carrier.result.structured_output);
 assert.deepEqual(before.decisions,carrier.result.structured_output.decisions);
 assert.equal(result.review.decisions.length,3);assert.ok(result.assessments.every(a=>a.quality==='KNOWN'));
});

test('native Claude formatter cannot advertise or invoke IO tools, emit extra judgments, or detach final result',async()=>{
 const mutations:Array<(v:ReturnType<typeof formatterCarrier>)=>void>=[
  v=>{v.init.tools=['StructuredOutput','Read'];(v.capture.executions[1].provenance as any).tools=v.init.tools;},
  v=>v.firstUse.name='Bash',
  v=>{v.init.tools=[];v.capture.executions[1].provenance.tools=[];},
  v=>v.lastUse.input.decisions.game.accepted=false,
  v=>v.packets.splice(2,0,{type:'assistant',message:{content:[{type:'tool_use',id:'constructed-format-extra',name:'StructuredOutput',input:v.result.structured_output}]}}),
 ];
 for(const mutate of mutations){const carrier=formatterCarrier(await nativeAttentionFixture({structured:true}),true);mutate(carrier);carrier.commit();assert.throws(()=>decode(carrier.capture),/^Error: NATIVE_ATTENTION_/,String(mutate));}
});

test('native Claude rejects valid multiple emissions and formatter repair without linked error feedback',async()=>{
 const mutations:Array<(v:ReturnType<typeof formatterCarrier>)=>void>=[
  v=>v.firstUse.input=structuredClone(v.result.structured_output),
  v=>v.feedback.is_error=false,
  v=>v.feedback.tool_use_id='unrelated-tool-result',
  v=>v.packets.splice(v.packets.findIndex(packet=>packet.type==='user'),1),
  v=>{v.firstUse.input.originRelationship.citations=v.firstUse.input.citations;},
 ];
 for(const mutate of mutations){const carrier=formatterCarrier(await nativeAttentionFixture({structured:true}),true);mutate(carrier);carrier.commit();assert.throws(()=>decode(carrier.capture),/NATIVE_ATTENTION_CLAUDE_FORMATTER_REPAIR/,String(mutate));}
});

test('native Claude structural repair preserves every decision, rationale, citation, status and other field',async()=>{
 const mutations:Array<(v:ReturnType<typeof formatterCarrier>)=>void>=[
  v=>v.firstUse.input.decisions.game.accepted=false,
  v=>v.firstUse.input.decisions.game.rationale+=' Changed semantic rationale.',
  v=>v.firstUse.input.candidateSet.complete=true,
  v=>v.firstUse.input.candidateSet.rationale+=' Different scope rationale.',
  v=>v.firstUse.input.originRelationship.status='CONTRADICTED',
  v=>v.firstUse.input.originRelationship.rationale+=' Different origin rationale.',
  v=>v.firstUse.input.citations.push({sourceId:'attention-page-1',spanId:'attention-page-1:span:0'}),
  v=>v.firstUse.input.token={chain:'solana',address:'11111111111111111111111111111111'},
  v=>{v.firstUse.input.unrelatedFormatField=true;},
 ];
 for(const mutate of mutations){const carrier=formatterCarrier(await nativeAttentionFixture({structured:true}),true);mutate(carrier);carrier.commit();assert.throws(()=>decode(carrier.capture),/NATIVE_ATTENTION_CLAUDE_FORMATTER_REPAIR/,String(mutate));}
});

test('native Claude rejects a rehashed unsupported schema dialect even when command and carrier agree',async()=>{
 const capture=await nativeAttentionFixture({structured:true}),e=capture.executions[1],program=createSubmittedAttentionProgram(capture.read,NATIVE_TEST_TOKEN,true),proposal=program.normalizeProposal(JSON.parse(capture.executions[0].response.raw)),review=program.buildReview(proposal)!;
 const prior=e.input.schemaJson!,unsupported=JSON.stringify(z.toJSONSchema(review.wireReviewSchema));
 assert.notEqual(unsupported,prior);e.input.schemaJson=unsupported;e.input.schemaSha256=sha(unsupported);e.provenance.command=e.provenance.command.map(arg=>arg===prior?unsupported:arg);
 assert.throws(()=>decode(capture),/NATIVE_ATTENTION_EXECUTION_SCHEMA/);
});
