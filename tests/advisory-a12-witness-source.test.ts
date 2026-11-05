import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {a12WitnessSourcesFromAcquisition,decodeA12ZeroWitnessCapture,loadA12ZeroWitnessCapture,a12WitnessScope,type A12ZeroWitnessCapture} from '../src/providers/advisory-exit-capacity-witness.js';
import {attentionReviewSchema} from '../src/domain/attention.js';
import {decodeNativeQualificationResponse} from '../src/providers/native-attention.js';
import {a12WitnessSourceFixture,rebindA12WitnessFixture,WITNESS_TEST_TARGET,WITNESS_TEST_CUTOFF} from './a12-witness-source-fixtures.js';
const decode=(c:A12ZeroWitnessCapture,cutoff=WITNESS_TEST_CUTOFF)=>decodeA12ZeroWitnessCapture(JSON.stringify(c),WITNESS_TEST_TARGET,cutoff);
test('witness purpose replays entire actual result text and metadata preimage; formatter is transport only',()=>{
 const c=a12WitnessSourceFixture(),d=decode(c),result=JSON.parse(c.acquisition.batches[0]!.raw).results[0];
 assert.equal(d.qualified,true);assert.deepEqual(d.members.map(m=>m.id),['target','witness']);assert.equal(d.sourceReadyAt,c.createdAt);assert.equal(d.capture.sources[0]!.text,result.text);assert.ok(result.metadata);assert.ok(!d.capture.sources[0]!.text.includes('raw only'));assert.equal('complete' in d,false);assert.equal(c.diagnostics.membershipComplete,false);
 assert.deepEqual(a12WitnessScope(JSON.stringify(c)),{method:c.method,purpose:c.purpose,contentHash:createHash('sha256').update(JSON.stringify(c)).digest('hex')});
});
test('actual semantic rejection remains retained and unqualified',()=>{const c=a12WitnessSourceFixture(true),d=decode(c);assert.equal(d.qualified,false);assert.deepEqual(d.capture,c);});
test('omitted/error/empty bodies retain honest incomplete acquisition and exact pointers',()=>{
 const c=a12WitnessSourceFixture(),a=c.acquisition,b=a.batches[0]!;b.requestedUrls.push('https://lantern.example/empty','https://lantern.example/error','https://lantern.example/omitted');const raw=JSON.parse(b.raw);raw.results.push({url:b.requestedUrls[1],text:''});raw.errors.push({url:b.requestedUrls[2],error:'timeout'});b.raw=JSON.stringify(raw);
 const rebuilt=a12WitnessSourcesFromAcquisition(a);assert.equal(rebuilt.complete,false);assert.equal(rebuilt.sources[1]!.text,'');assert.equal(rebuilt.sources[1]!.resultIndex,1);c.sources=rebuilt.sources;a.sourceIds=rebuilt.sourceIds;a.complete=false;rebindA12WitnessFixture(c);assert.equal(decode(c).qualified,true);
 a.complete=true;assert.throws(()=>decode(c),/SOURCE_REPLAY/);
});
test('raw batch replay rejects duplicate/orphan/unsafe/oversize inputs rather than dropping sources',()=>{
 const mutations:Array<(c:A12ZeroWitnessCapture)=>void>=[c=>{const b=c.acquisition.batches[0]!,v=JSON.parse(b.raw);v.results.push(v.results[0]);b.raw=JSON.stringify(v);},c=>{const b=c.acquisition.batches[0]!,v=JSON.parse(b.raw);v.results[0].url='https://orphan.example/';b.raw=JSON.stringify(v);},c=>{const b=c.acquisition.batches[0]!,v=JSON.parse(b.raw);v.results[0].final_url='http://localhost/private';b.raw=JSON.stringify(v);},c=>{const b=c.acquisition.batches[0]!,v=JSON.parse(b.raw);v.results[0].text='x'.repeat(120001);b.raw=JSON.stringify(v);},c=>{c.sources[0]!.text=c.sources[0]!.text.trim();},c=>{c.sources[0]!.resultIndex=1;},c=>{c.sources[0]!.availableAt='2026-10-01T12:00:02Z';},c=>{c.acquisition.sourceIds=[];},c=>{c.acquisition.batches[0]!.raw='x'.repeat(2000001);}];
 for(const mutate of mutations){const c=a12WitnessSourceFixture();mutate(c);assert.throws(()=>decode(c),/A12_ZERO_WITNESS_/,String(mutate));}
});
test('strict purpose, causality, source TTL and execution carrier cannot be rehashed into authority',()=>{
 const mutations:Array<(c:any)=>void>=[c=>c.purpose='NARRATIVE_GAME_QUALIFICATION',c=>c.diagnostics.membershipComplete=true,c=>c.scope.impactBps='0300',c=>c.cachedCapacity='0',c=>c.executions[1].startedAt='2026-10-01T12:01:59Z',c=>c.createdAt='2026-10-01T12:11:01Z',c=>c.acquisition.batches[0].availableAt='2026-10-01T12:02:00Z',c=>c.executions[1].provenance.tools=['Read'],c=>c.executions[1].input.schemaJson='{}',c=>c.executions[1].provenance.command.push('--resume'),c=>c.executions[0].response.raw='```json\n'+c.executions[0].response.raw+'\n```'];
 for(const mutate of mutations){const c=a12WitnessSourceFixture();mutate(c);assert.throws(()=>decode(c),/A12_ZERO_WITNESS_/,String(mutate));}
 assert.throws(()=>decode(a12WitnessSourceFixture(),'2026-10-01T12:16:00Z'),/SOURCE_TTL/);
});
test('fixed pair coverage, exact citations and canonical source-bound routes are required',()=>{
 for(const alter of [(p:any)=>p.competitors.reverse(),(p:any)=>p.competitors.pop(),(p:any)=>p.competitors[1].id='peer',(p:any)=>p.competitors[1].quote='An invented narrative quote with no current exact contract address.']){const c=a12WitnessSourceFixture(),p=JSON.parse(c.executions[0].response.raw);alter(p);rebindA12WitnessFixture(c,p);assert.throws(()=>decode(c),/A12_ZERO_WITNESS_/);}
 for(const alter of [(r:any)=>r.decisions.pop(),(r:any)=>r.decisions[1].id='target',(r:any)=>r.candidateSet.complete=true,(r:any)=>r.originRelationship.status='SUPPORTED']){const c=a12WitnessSourceFixture(),r=JSON.parse(c.executions[1].response.raw);alter(r);rebindA12WitnessFixture(c,undefined,r);assert.throws(()=>decode(c),/A12_ZERO_WITNESS_/);}
 const c=a12WitnessSourceFixture();c.routeHints[1].pool=c.routeHints[0].pool;assert.throws(()=>decode(c),/ROUTE_HINT/);
});
test('historical leads require explicit rejected catalog linkage; do not become members',()=>{
 const c=a12WitnessSourceFixture();c.diagnostics.priorCatalog={sourcePacketHash:'a'.repeat(64),reviewResultHash:'b'.repeat(64),status:'UNQUALIFIED',availableAt:'2026-10-01T11:00:00Z'};c.diagnostics.knownLeads=[{token:{chain:'solana',address:'11111111111111111111111111111111'},sourceIds:[],status:'UNRESOLVED_RESEARCH_LEAD',rationale:'A prior catalog lead remains explicitly unmeasured.'}];rebindA12WitnessFixture(c);assert.equal(decode(c).members.length,2);c.diagnostics.priorCatalog=null;assert.throws(()=>decode(c),/DIAGNOSTICS/);
});
test('bounded loader rejects symlinks, malformed UTF8 and nonregular paths',()=>{
 const dir=mkdtempSync(join(tmpdir(),'a12-witness-'));try{const path=join(dir,'capture.json');writeFileSync(path,JSON.stringify(a12WitnessSourceFixture()));assert.equal(loadA12ZeroWitnessCapture(path,WITNESS_TEST_TARGET,WITNESS_TEST_CUTOFF).decoded.qualified,true);symlinkSync(path,join(dir,'link'));assert.throws(()=>loadA12ZeroWitnessCapture(join(dir,'link'),WITNESS_TEST_TARGET,WITNESS_TEST_CUTOFF),/FILE/);writeFileSync(path,Buffer.from([0xff]));assert.throws(()=>loadA12ZeroWitnessCapture(path,WITNESS_TEST_TARGET,WITNESS_TEST_CUTOFF),/FILE_UTF8/);assert.throws(()=>loadA12ZeroWitnessCapture(dir,WITNESS_TEST_TARGET,WITNESS_TEST_CUTOFF),/FILE/);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('batch/result order and failed transport remain original rather than becoming completed body sources',()=>{
 const c=a12WitnessSourceFixture(),a=c.acquisition;a.batches.push({id:'constructed-second',requestedUrls:['https://lantern.example/second','https://lantern.example/third'],status:200,availableAt:'2026-10-01T12:00:02Z',raw:JSON.stringify({results:[{url:'https://lantern.example/third',text:'Third body\n '},{url:'https://lantern.example/second',text:' Second body'}],errors:[]})},{id:'constructed-failed',requestedUrls:['https://lantern.example/unavailable'],status:503,availableAt:'2026-10-01T12:00:03Z',raw:'Actual retained error text, without fabricated JSON.'});
 const rebuilt=a12WitnessSourcesFromAcquisition(a);assert.equal(rebuilt.complete,false);assert.deepEqual(rebuilt.sources.map(s=>[s.id,s.batchId,s.resultIndex]),[['a12-witness-source-1','constructed-batch',0],['a12-witness-source-2','constructed-second',0],['a12-witness-source-3','constructed-second',1]]);assert.equal(rebuilt.sources[1]!.url,'https://lantern.example/third');assert.equal(rebuilt.sources[1]!.text,'Third body\n ');c.sources=rebuilt.sources;a.sourceIds=rebuilt.sourceIds;a.complete=false;rebindA12WitnessFixture(c);assert.equal(decode(c).qualified,true);
 c.sources.reverse();assert.throws(()=>decode(c),/SOURCE_REPLAY/);
});

/** Constructed transport reproducing the observed origin-only formatter error;
 * neither this stream nor its synthetic model identity is actual execution evidence. */
function originFormatterRepair(firstEdit?:(first:any)=>void,finalEdit?:(final:any)=>void){
 const c=a12WitnessSourceFixture(),execution=c.executions[1];
 if(finalEdit){const final=JSON.parse(execution.response.raw);finalEdit(final);rebindA12WitnessFixture(c,undefined,final);}
 const final=JSON.parse(execution.response.raw),first=structuredClone(final);
 // The actual malformed field had a trailing bracket; admission does not give
 // this non-adjudicated string any semantic authority or parse it into a claim.
 first.originRelationship=JSON.stringify(first.originRelationship)+']';firstEdit?.(first);
 const emission=(id:string,input:unknown)=>({type:'assistant',message:{content:[{type:'tool_use',id,name:'StructuredOutput',input}]}});
 const feedback={type:'user',message:{content:[{type:'tool_result',tool_use_id:'constructed-origin-invalid',is_error:true,content:'/originRelationship: must be object'}]}};
 execution.response.transportRaw=[execution.provenance.initRaw,JSON.stringify(emission('constructed-origin-invalid',first)),JSON.stringify(feedback),JSON.stringify(emission('constructed-origin-final',final)),execution.provenance.resultRaw].join('\n')+'\n';
 return c;
}
test('origin-only schema repair is admitted for the fixed A12 purpose and rejected by default C10 transport',()=>{
 const c=originFormatterRepair(),execution=c.executions[1],originalStream=execution.response.transportRaw;
 assert.equal(decode(c).qualified,true);
 assert.deepEqual(decodeNativeQualificationResponse(execution,execution.canonicalPrompt,attentionReviewSchema,'A12_WITNESS_UNADJUDICATED_ORIGIN'),JSON.parse(execution.response.raw));
 assert.throws(()=>decodeNativeQualificationResponse(execution,execution.canonicalPrompt,attentionReviewSchema),/NATIVE_ATTENTION_CLAUDE_FORMATTER_REPAIR/);
 assert.equal(execution.response.transportRaw,originalStream);assert.ok(originalStream!.includes('must be object'));
});
test('A12 origin formatter allowance cannot change membership, completeness, rationale or other fields',()=>{
 const edits:Array<[string,(first:any)=>void]>=[
  ['membership decision',first=>{first.decisions[1].accepted=false;}],
  ['candidate completeness',first=>{first.candidateSet.complete=true;}],
  ['candidate rationale',first=>{first.candidateSet.rationale='A different assessment.';}],
  ['decision rationale',first=>{first.decisions[0].rationale='A different explanation.';}],
  ['unrecognized field',first=>{first.additionalAuthority=true;}],
  ['non-origin schema error',first=>{first.decisions[0].accepted='true';}]
 ];
 for(const [label,edit] of edits){const c=originFormatterRepair(edit),execution=c.executions[1];assert.throws(()=>decodeNativeQualificationResponse(execution,execution.canonicalPrompt,attentionReviewSchema,'A12_WITNESS_UNADJUDICATED_ORIGIN'),/NATIVE_ATTENTION_CLAUDE_FORMATTER_REPAIR/,label);assert.throws(()=>decode(c),/A12_ZERO_WITNESS_/,label);}
});
test('A12 repair requires final UNKNOWN origin with empty citations and linked error feedback',()=>{
 for(const [label,edit] of [
  ['positive origin',(final:any)=>{final.originRelationship.status='SUPPORTED';}],
  ['origin citations',(final:any)=>{final.originRelationship.citations=[{sourceId:'a12-witness-source-1',quote:'A new cited claim.'}];}]
 ] as Array<[string,(final:any)=>void]>){const c=originFormatterRepair(undefined,edit),execution=c.executions[1];assert.throws(()=>decodeNativeQualificationResponse(execution,execution.canonicalPrompt,attentionReviewSchema,'A12_WITNESS_UNADJUDICATED_ORIGIN'),/NATIVE_ATTENTION_CLAUDE_FORMATTER_REPAIR/,label);}
 for(const edit of [(feedback:any)=>{feedback.message.content[0].is_error=false;},(feedback:any)=>{feedback.message.content[0].tool_use_id='unlinked-error';}]){
  const c=originFormatterRepair(),execution=c.executions[1],lines=execution.response.transportRaw!.trimEnd().split('\n').map(line=>JSON.parse(line));edit(lines[2]);execution.response.transportRaw=lines.map(line=>JSON.stringify(line)).join('\n')+'\n';assert.throws(()=>decodeNativeQualificationResponse(execution,execution.canonicalPrompt,attentionReviewSchema,'A12_WITNESS_UNADJUDICATED_ORIGIN'),/NATIVE_ATTENTION_CLAUDE_FORMATTER_REPAIR/);
 }
});
