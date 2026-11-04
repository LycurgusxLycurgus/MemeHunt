import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { EvidenceRecord, TokenRef } from '../src/domain/contracts.js';
import { CALLER_SEED_METHOD, CALLER_SELECTION_ID, callerSeedFromEvidence } from '../src/providers/advisory-caller-measures.js';
import { collectCallerHistory, decodeCallerHistory } from '../src/providers/advisory-caller-history.js';
import { advisorySemanticPacketPlan, advisorySemanticRequests } from '../src/providers/advisory-semantic.js';
import { RECORDED_CALLER_METHOD, decodeRecordedCallerCapture, recordedCallerProposalPrompt, recordedCallerReviewPrompt } from '../src/providers/advisory-recorded-callers.js';
import { S20_FILE_BYTES, S20_IDENTITY, S20_IMPORT_METHOD, S20_PURPOSE, decodeS20SourceFrames, loadS20SourceFrames } from '../src/providers/advisory-s20-source-frames.js';

/** CONSTRUCTED synthetic data only: no retained source, provider receipt, model output or real account is represented. */
const A:TokenRef={chain:'solana',address:'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump'},B:TokenRef={chain:'solana',address:'3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump'};
const T0=Date.parse('2026-10-12T00:00:00.000Z'),at=(s:number)=>new Date(T0+s*1000).toISOString(),POST='2026-10-11T12:00:00.000Z';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const sid=(seq:number)=>String(((BigInt(Date.parse(POST))-1288834974657n)<<22n)+BigInt(seq));
const uid=(h:string)=>'9'+[...h].map(c=>c.charCodeAt(0)%10).join('');
type P={h:string;seq:number;binding?:string;event?:string;syn?:unknown;fx?:unknown;edit?:'EDITED'|'STALE';status?:number;accept?:boolean;badCite?:boolean};
type Built={frame:any;raws:Record<string,string>};
const pOf=(id:string,posts:P[])=>posts.find(p=>`caller-${sid(p.seq)}`===id)!;
const rec=(id:string,sourceId:string,sourceType:string,accessMode:EvidenceRecord['accessMode'],scope:Record<string,unknown>,raw:string,t=at(0)):EvidenceRecord=>({id,sourceId,sourceType,accessMode,scope,retrievedAt:t,availableAt:t,contentHash:sha(raw),adapterVersion:'live-v1'});
function payload(p:P,tok:TokenRef):Record<string,unknown>{
  const id=sid(p.seq),text=`Buy now ${tok.address} ${p.h}`,ids=p.edit==='EDITED'?[sid(p.seq+500),id]:p.edit==='STALE'?[id,sid(p.seq+500)]:[id];
  return {oembed:{url:`https://x.com/${p.h}/status/${id}`,author_url:`https://x.com/${p.h}`},
    syndication:{__typename:'Tweet',id_str:id,created_at:POST,text,user:{screen_name:p.h,...(p.syn==='OMIT'?{}:{id_str:p.syn??uid(p.h)})},edit_control:{edit_tweet_ids:ids,editable_until_msecs:String(Date.parse(POST)+3600000)},isEdited:ids.length>1,isStaleEdit:false},
    fxtwitter:{code:200,message:'OK',tweet:{id,text,raw_text:{text,facets:[]},author:{screen_name:p.h,...(p.fx==='OMIT'?{}:{id:p.fx??uid(p.h)})},created_timestamp:Date.parse(POST)/1000,is_note_tweet:false,replying_to_status:null,reposted_by:null}}};
}
async function base(tok:TokenRef,posts:P[]){
  const raws:Record<string,string>={},evidence:EvidenceRecord[]=[],ids=posts.map((_,i)=>`page-${i}`);
  posts.forEach((p,i)=>{raws[ids[i]!]=`page ${p.h}`;evidence.push(rec(ids[i]!,'tinyfish-fetch','WEB_PAGE','FREE_ACCOUNT',{kind:'POST',url:`https://x.com/${p.h}/status/${sid(p.seq)}`,publishedAt:POST},raws[ids[i]!]!));});
  raws['page-x']='not a post page';evidence.push(rec('page-x','tinyfish-fetch','WEB_PAGE','FREE_ACCOUNT',{kind:'PAGE',url:'https://example.com/a'},raws['page-x']));
  raws['attention-scope']=JSON.stringify({queries:[`${tok.address} site:x.com`],postSampleSourceIds:[...ids,'page-x']});
  evidence.unshift(rec('attention-scope','attention-collector','SAMPLE_SCOPE','LOCAL_DERIVED',{method:'comparison-scope-v2'},raws['attention-scope']));
  const seed=callerSeedFromEvidence(tok,evidence,raws,at(0));
  if(seed.selection===null)throw new Error('fixture seed');
  raws[CALLER_SELECTION_ID]=seed.raw;evidence.push(rec(CALLER_SELECTION_ID,'advisory-collector','SAMPLE_SCOPE','LOCAL_DERIVED',{method:CALLER_SEED_METHOD},seed.raw));
  const fetcher=(async(input:unknown)=>{const u=String(input),p=posts.find(x=>u.includes(sid(x.seq)))!,k=u.includes('oembed')?'oembed':u.includes('syndication')?'syndication':'fxtwitter';
    return new Response(JSON.stringify(payload(p,tok)[k]),{status:k==='syndication'?p.status??200:200});}) as typeof fetch;
  return {raws,evidence,selection:seed.selection,callers:await collectCallerHistory(seed.selection,fetcher,()=>at(5))};
}
async function recorded(posts:P[],qualify=true):Promise<Built>{
  const b=await base(A,posts);
  const capture:any={method:RECORDED_CALLER_METHOD,token:A,seed:{evidence:b.evidence,rawArtifacts:b.raws},qualification:null,
    callers:{requests:b.callers.requests,rawArtifacts:b.callers.rawArtifacts,times:Object.fromEntries(Object.keys(b.callers.rawArtifacts).map(k=>[k,at(5)]))}};
  if(qualify){
    const d=decodeRecordedCallerCapture(JSON.stringify(capture)),pp=recordedCallerProposalPrompt(d),cat=JSON.parse(pp).sources as Array<{id:string}>;
    const pr=JSON.stringify({sources:cat.map(s=>{const p=pOf(s.id,posts);return {id:s.id,binding:p.binding??'EXACT_CONTRACT',event:p.event??'FORWARD_CALL',category:'CRYPTO_CALLER',topic:'OTHER',citations:[{sourceId:s.id,spanId:`${s.id}:span:0`}],rationale:'Synthetic constructed classification.'};})});
    const rp=recordedCallerReviewPrompt(d,pr),rr=JSON.stringify({sources:cat.map(s=>({id:s.id,complete:true,binding:true,event:true,category:true,topic:true}))});
    const pass=(executor:string,prompt:string,response:string,s:number)=>({prompt,response,execution:{executor,executionId:`synthetic-${executor}`,modelId:null,modelIdSource:'UNREPORTED',startedAt:at(s),finishedAt:at(s+4),promptSha256:sha(prompt),responseSha256:sha(response),tools:'NONE',freshSession:true}});
    capture.qualification={proposal:pass('CODEX',pp,pr,6),review:pass('CLAUDE_CODE',rp,rr,11)};
  }
  const raw=JSON.stringify(capture),h=sha(raw);
  return {raws:{'c5-capture':raw},frame:{frameId:'c5',format:'RECORDED_CALLER_CAPTURE_V2',token:A,originalCutoff:at(30),capture:{key:'c5-capture',sha256:h,bytes:Buffer.byteLength(raw)},
    outerImport:{id:'advisory-recorded-callers-capture',sourceId:'advisory-recorded-callers',sourceType:'HISTORICAL_RECEIPT',retrievedAt:at(25),availableAt:at(25),contentHash:h,adapterVersion:RECORDED_CALLER_METHOD,accessMode:'USER_IMPORT',scope:{method:RECORDED_CALLER_METHOD}}}};
}
async function hosted(posts:P[]):Promise<Built>{
  const b=await base(B,posts),evidence=[...b.evidence],raws:Record<string,string>={...b.raws},artifactIds:Record<string,string>={},semIds:Record<string,string>={},requests:Record<string,unknown>={};
  for(const [k,v] of Object.entries(b.callers.rawArtifacts)){const id=`advisory-callers-${k}`;artifactIds[k]=id;raws[id]=v;evidence.push(rec(id,'advisory-callers','HISTORICAL_RECEIPT','PUBLIC_API',{request:b.callers.requests[k]},v,at(5)));}
  const read=decodeCallerHistory(b.selection,b.callers.rawArtifacts).socialInput,plan=advisorySemanticPacketPlan(read,B,'v3');
  const proposal={sources:read.sources.map(s=>{const p=pOf(s.id,posts);return {id:s.id,binding:p.binding??'EXACT_CONTRACT',event:p.event??'FORWARD_CALL',category:'CRYPTO_CALLER',topic:'OTHER',artifact:'NONE',theme:null,paidDisclosure:'NOT_OBSERVED',incentives:[],
    citations:[{sourceId:s.id,spanId:p.badCite?'bad':`${s.id}:span:0`}],rationale:'Synthetic constructed classification.'};}),persistence:null};
  const env=(v:unknown)=>JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(v)}]}}]});
  const sem:Record<string,string>={'advisory-semantic-selection':plan.selection,'advisory-semantic-proposal-prompt':plan.proposalPacket,'advisory-semantic-proposal-response':env(proposal),'advisory-semantic-review-prompt':plan.reviewPacket(proposal),
    'advisory-semantic-review-response':env({sources:read.sources.map(s=>({id:s.id,complete:true,accepted:pOf(s.id,posts).accept??true})),persistence:false})};
  for(const [k,v] of Object.entries(sem)){const id=`advisory-callerSemantic-${k}`,model=/prompt|response/.test(k),request={operation:k,modelRequests:advisorySemanticRequests()};
    semIds[k]=id;requests[k]=request;raws[id]=v;evidence.push(rec(id,model?'gemini':'advisory-collector','HISTORICAL_RECEIPT',model?'FREE_ACCOUNT':'LOCAL_DERIVED',{request},v,at(20)));}
  return {raws:Object.fromEntries(evidence.map(e=>[`p:${e.id}`,raws[e.id]!])),frame:{frameId:'parasite',format:'HOSTED_CALLER_PROOF_V23',token:B,originalCutoff:at(30),proofMethod:'advisory-provenance-v23',
    callers:{requests:b.callers.requests,artifactIds,selectionId:CALLER_SELECTION_ID},callerSemantic:{requests,artifactIds:semIds},evidence,
    sources:Object.fromEntries(evidence.map(e=>[e.id,{key:`p:${e.id}`,sha256:e.contentHash,bytes:Buffer.byteLength(raws[e.id]!)}]))}};
}
const pack=(...built:Built[])=>({manifest:{method:S20_IMPORT_METHOD,purpose:S20_PURPOSE,packagedAt:at(40),frames:built.map(b=>b.frame)},rawSources:Object.assign({},...built.map(b=>b.raws))});
const run=(p:unknown)=>decodeS20SourceFrames(JSON.stringify(p),at(60));
const only=async(b:Promise<Built>)=>run(pack(await b)).frames[0]!.result as any;
const OK:P[]=[{h:'alpha',seq:1},{h:'beta',seq:2,binding:'UNRELATED',event:'NEWS'},{h:'gamma',seq:3,event:'NEWS'},{h:'alpha',seq:4}];

test('constructed recorded and hosted frames close only from full raw rederivation with corroborated native X user ids', async()=>{
  const p=pack(await recorded(OK),await hosted(OK)),out=run(p);
  for(const f of out.frames){const r=f.result as any;assert.equal(r.status,'CLOSED');
    assert.deepEqual(r.frame.events.map((e:any)=>[e.nativeUserId,e.handleAtRetrieval,'authorId' in e]),[[uid('alpha'),'alpha',false],[uid('alpha'),'alpha',false]]);
    assert.deepEqual(r.frame.universe.map((u:any)=>[u.disposition,u.reason??null]),[['ELIGIBLE',null],['SELECTED_EXCLUDED','UNRELATED'],['SELECTED_EXCLUDED','NON_FORWARD_CALL'],['ELIGIBLE',null],['SEED_EXCLUDED','NOT_POST']]);
    assert.deepEqual(r.frame.identity,S20_IDENTITY);assert.equal(r.frame.closure.platformExhaustive,false);}
  assert.deepEqual(run(p).frames.map(f=>(f.result as any).frameHash),out.frames.map(f=>(f.result as any).frameHash));
  assert.equal(out.comparability.sharedIdentitiesComputed,false);assert.equal(out.comparability.searchCoverageEqual,'NOT_ASSERTED');
});
test('native ids must be positively corroborated; missing, numeric, conflicting or cross-status inconsistent ids block', async()=>{
  for(const [patch,code] of [[{syn:'OMIT'},'NATIVE_ID_MISSING'],[{fx:1509239489},'NATIVE_ID_NUMERIC_AMBIGUOUS'],[{fx:'123456789'},'NATIVE_ID_CONFLICT']] as const){
    const r=await only(recorded([{h:'alpha',seq:1,...patch}]));assert.deepEqual([r.status,r.code],['UNCLOSED',code]);}
  const x=await only(hosted([{h:'alpha',seq:1},{h:'alpha',seq:2,syn:'555',fx:'555'}]));
  assert.deepEqual([x.status,x.code],['UNCLOSED','NATIVE_ID_CROSS_STATUS_CONFLICT']);
  const ex=await only(recorded([{h:'alpha',seq:1},{h:'beta',seq:2,binding:'UNRELATED',event:'NEWS',syn:'OMIT'}]));
  assert.equal(ex.status,'CLOSED');assert.deepEqual(ex.frame.universe[1].identity,{code:'NATIVE_ID_MISSING'});
});
test('malformed portable imports throw: hash, orphan, path field, format graft, token reuse, clocks, request and evidence binding', async()=>{
  const good=pack(await recorded(OK),await hosted(OK));
  const cases:Array<[(p:any)=>void,RegExp]>=[
    [p=>{p.rawSources['c5-capture']+=' ';},/SOURCE_HASH/],[p=>{p.rawSources.orphan='x';},/MEMBERSHIP/],
    [p=>{p.manifest.frames[0].sourcePath='/etc/passwd';},/SCHEMA/],[p=>{p.manifest.frames[0].proofMethod='advisory-provenance-v23';},/SCHEMA/],
    [p=>{p.manifest.frames[1].token=A;},/FRAME_IDENTITY/],[p=>{p.manifest.packagedAt=at(61);},/CLOCK/],
    [p=>{p.manifest.frames[0].outerImport.availableAt=at(31);p.manifest.frames[0].outerImport.retrievedAt=at(31);},/OUTER_IMPORT/],
    [p=>{const k=Object.keys(p.manifest.frames[1].callers.requests)[0]!;p.manifest.frames[1].callers.requests[k].url+='?x';},/REQUEST_BINDING/],
    [p=>{p.manifest.frames[1].evidence.find((e:any)=>e.id==='page-0').availableAt=at(1);},/EVIDENCE/]];
  for(const [mutate,re] of cases){const p=structuredClone(good) as any;mutate(p);assert.throws(()=>run(p),re);}
});
test('unclear, rejected, failed or absent classification never yields a closed or empty frame', async()=>{
  const s=async(b:Promise<Built>)=>{const r=await only(b);return [r.status,r.code];};
  assert.deepEqual(await s(recorded([{h:'alpha',seq:1,event:'UNCLEAR'}])),['UNCLOSED','HISTORICAL_EVENT_UNCLEAR']);
  assert.deepEqual(await s(recorded([{h:'alpha',seq:1,binding:'UNCLEAR',event:'UNCLEAR'}])),['UNCLOSED','HISTORICAL_BINDING_UNRESOLVED']);
  assert.deepEqual(await s(recorded([{h:'alpha',seq:1}],false)),['SOURCE_UNAVAILABLE','RECORDED_CLASSIFICATION_ABSENT']);
  assert.deepEqual(await s(hosted([{h:'alpha',seq:1,accept:false}])),['UNCLOSED','HISTORICAL_CLASSIFICATION_REJECTED']);
  assert.deepEqual(await s(hosted([{h:'alpha',seq:1,badCite:true}])),['UNCLOSED','CLASSIFICATION_FAILED']);
});
test('an exact closed empty frame needs positive exclusions; an unavailable official body blocks', async()=>{
  const r=await only(recorded([{h:'alpha',seq:1,binding:'UNRELATED',event:'NEWS'},{h:'beta',seq:2,event:'WARNING'}]));
  assert.equal(r.status,'CLOSED');assert.deepEqual(r.frame.events,[]);assert.deepEqual(r.frame.universe.map((u:any)=>u.reason),['UNRELATED','NON_FORWARD_CALL','NOT_POST']);
  const m=await only(hosted([{h:'alpha',seq:1},{h:'beta',seq:2,status:404}]));
  assert.deepEqual([m.status,m.code,m.details],['UNCLOSED','SOURCE_BODY_INCOMPLETE',['CALLER_OFFICIAL_NOT_FOUND:page-1']]);
});
test('edited posts qualify only as the current revision at retrieval; stale revisions block', async()=>{
  const e=await only(hosted([{h:'alpha',seq:1,edit:'EDITED'}]));
  assert.equal(e.status,'CLOSED');assert.equal(e.frame.events[0].edit.state,'CURRENT_REVISION_OF_EDITED');assert.equal(e.frame.events[0].edit.predecessors.length,1);assert.equal(e.frame.events[0].textBasis,'CURRENT_REVISION_AT_RETRIEVAL');
  const s=await only(recorded([{h:'alpha',seq:1,edit:'STALE'}]));assert.deepEqual([s.status,s.code],['UNCLOSED','SOURCE_BODY_INCOMPLETE']);
});
test('the file importer reads one regular file and never follows links', async()=>{
  const dir=mkdtempSync(join(tmpdir(),'s20-')),file=join(dir,'frames.json'),link=join(dir,'link.json');
  writeFileSync(file,JSON.stringify(pack(await recorded(OK))));symlinkSync(file,link);
  assert.equal(loadS20SourceFrames(file,at(60)).frames[0]!.result.status,'CLOSED');
  assert.throws(()=>loadS20SourceFrames(link,at(60)),/S20_SOURCE_FILE_OPEN/);
});

// Adaptation regressions: source-frame payload only; no actual corpus or recurrence computation.
test('both formats retain full qualified current body text and hash, not merely citation snippets',async()=>{
  const p=pack(await recorded(OK),await hosted(OK)),out=run(p);
  for(const f of out.frames){const r=f.result as any;assert.equal(r.status,'CLOSED');
    for(const e of r.frame.events){const expected=`Buy now ${f.token.address} ${e.handleAtRetrieval}`;assert.equal(e.text,expected);assert.equal(e.textSha256,sha(expected));assert.deepEqual(e.bodySource,{provider:'fxtwitter',field:'tweet.text',trust:'THIRD_PARTY_PROVIDER_REPORTED'});}}
});
test('one corroborated native account may have multiple display handles; display aliases do not create different identities',async()=>{
  for(const build of [recorded,hosted]){const r=await only(build([{h:'alpha',seq:1,syn:'777',fx:'777'},{h:'renamed',seq:2,syn:'777',fx:'777'}]));assert.equal(r.status,'CLOSED');assert.deepEqual(r.frame.events.map((e:any)=>e.nativeUserId),['777','777']);assert.deepEqual(r.frame.events.map((e:any)=>e.handleAtRetrieval),['alpha','renamed']);}
});
test('nested raw-source lone surrogates fail UTF8 even after all outer hashes and sizes are recomputed',async()=>{
  const p=pack(await hosted(OK)) as any,f=p.manifest.frames[0],key=f.sources['page-0'].key;
  p.rawSources[key]+='\ud800';const value=p.rawSources[key],h=sha(value);f.sources['page-0'].sha256=h;f.sources['page-0'].bytes=Buffer.byteLength(value);f.evidence.find((e:any)=>e.id==='page-0').contentHash=h;assert.throws(()=>run(p),/SOURCE_UTF8/);
});

/** Genuine retained sources. Original hosted envelopes remain opaque to this test; the existing decoder reads final qualified fields. */
test('genuine original C5 and Parasite provided samples rederive CLOSED source frames with original clocks',()=>{
  const compressed=readFileSync(join(process.cwd(),'tests/fixtures/s20-provided-call-samples.json.gz'));
  const bytes=gunzipSync(compressed,{maxOutputLength:S20_FILE_BYTES});
  assert.equal(createHash('sha256').update(bytes).digest('hex'),'b1c52971a353ae4a730a63dbb86cbd6a971dfc351182c662aaac4173f041fc41');
  const raw=bytes.toString('utf8'),p=JSON.parse(raw),out=decodeS20SourceFrames(raw,p.manifest.packagedAt);
  assert.deepEqual(out.frames.map(f=>[f.frameId,f.format]),[['c5-original-provided-call-sample','RECORDED_CALLER_CAPTURE_V2'],['parasite-original-provided-call-sample','HOSTED_CALLER_PROOF_V23']]);
  assert.equal(out.comparability.sharedIdentitiesComputed,false);
  for(const [i,f]of out.frames.entries()){
    assert.equal(f.result.status,'CLOSED');if(f.result.status!=='CLOSED')continue;
    assert.equal(f.result.frame.universe.length,[10,14][i]);assert.equal(f.result.frame.events.length,[3,7][i]);
    assert.equal((f.result.frame.clocks as any).originalCutoff,p.manifest.frames[i].originalCutoff);
    assert.equal((f.result.frame.clocks as any).packagedAt,p.manifest.packagedAt);
    assert.equal(f.result.frame.closure&& (f.result.frame.closure as any).platformExhaustive,false);
    for(const e of f.result.frame.events){assert.match(e.nativeUserId as string,/^[1-9][0-9]{0,19}$/);assert.equal(e.textSha256,sha(e.text as string));assert.equal('authorId'in e,false);}
  }
});

function replaceRecordedCapture(p:any,capture:any):void{
  const f=p.manifest.frames[0],raw=JSON.stringify(capture),hash=sha(raw);p.rawSources[f.capture.key]=raw;f.capture.sha256=hash;f.capture.bytes=Buffer.byteLength(raw);f.outerImport.contentHash=hash;
}
test('a missing selected classification stays unclosed after all source hashes and canonical review prompts are rebound',async()=>{
  const p=pack(await recorded(OK))as any,capture=JSON.parse(p.rawSources['c5-capture']);
  const context=decodeRecordedCallerCapture(JSON.stringify({...capture,qualification:null}));
  const q=capture.qualification,proposal=JSON.parse(q.proposal.response);proposal.sources.pop();
  q.proposal.response=JSON.stringify(proposal);q.proposal.execution.responseSha256=sha(q.proposal.response);
  q.review.prompt=recordedCallerReviewPrompt(context,q.proposal.response);q.review.execution.promptSha256=sha(q.review.prompt);
  replaceRecordedCapture(p,capture);
  const r=run(p).frames[0]!.result;assert.equal(r.status,'UNCLOSED');assert.equal(r.code,'HISTORICAL_CLASSIFICATION_UNAVAILABLE');
});
test('dropping a provided seed member cannot shrink a closed universe even after outer hashes are rebound',async()=>{
  const p=pack(await recorded(OK))as any,capture=JSON.parse(p.rawSources['c5-capture']);
  capture.seed.evidence=capture.seed.evidence.filter((e:any)=>e.id!=='page-0');delete capture.seed.rawArtifacts['page-0'];
  replaceRecordedCapture(p,capture);assert.throws(()=>run(p),/S20_SOURCE_RECORDED:RECORDED_CALLER_SEED_MEMBERSHIP/);
});

test('nested recorded raw sources must have real UTF8 preimages even when their outer hashes are rebound',async()=>{
  const p=pack(await recorded(OK))as any,capture=JSON.parse(p.rawSources['c5-capture']);
  capture.seed.rawArtifacts['page-0']+='\ud800';
  capture.seed.evidence.find((e:any)=>e.id==='page-0').contentHash=sha(capture.seed.rawArtifacts['page-0']);
  replaceRecordedCapture(p,capture);assert.throws(()=>run(p),/S20_SOURCE_SOURCE_UTF8/);
});
