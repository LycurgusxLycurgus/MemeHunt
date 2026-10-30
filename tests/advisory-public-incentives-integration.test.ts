import {decodeExecutorSocialBodies} from '../src/providers/executor-social-bodies.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {collectLiveToken} from '../src/app/live.js';
import {reconstructAdvisory} from '../src/app/advisory.js';
import {starterProfile} from '../src/app/config.js';
import {Service} from '../src/app/service.js';
import {runCli} from '../src/cli.js';
import {deriveExecutorSemanticMetrics,qualifyExecutorSemantic,type SemanticExecutor} from '../src/providers/executor-semantic.js';
import {a29LiveFetcher} from './a29-fixtures.js';

// Constructed offline transport and model answers. No model/network observation is claimed.
const MINT='3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump',token={chain:'solana' as const,address:MINT};
const AT='2026-10-20T12:00:00.000Z',POST='https://x.com/alpha/status/12345',PAGE='https://project.example/';
const text=`A historical crypto project announcement naming ${MINT}.`;
const json=(value:unknown)=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
type Bundle=Awaited<ReturnType<typeof collectLiveToken>>;
const proofOf=(b:Bundle)=>JSON.parse(b.rawArtifacts['advisory-derivation']!);
const metric=(b:Bundle,id='S08')=>b.details!.advisory!.metrics.find(m=>m.id===id)!;
const others=(b:Bundle)=>b.details!.advisory!.metrics.filter(m=>m.id!=='S08');
const stamp=(b:Bundle,p:unknown)=>{const raw=JSON.stringify(p);b.rawArtifacts['advisory-derivation']=raw;b.evidence.find(e=>e.id==='advisory-derivation')!.contentHash=sha(raw);};
function fixture(failedSocial=false,current=false){
 let tick=0,executions=0,nativeRead=false;
 const nativeAt='2026-10-20T07:00:37.000Z',nativeBody=`I hold ${MINT}.`,nativeId=String(((BigInt(Date.parse(nativeAt))-1288834974657n)<<22n)+1n);
 const postUrl=current?`https://x.com/alpha/status/${nativeId}`:POST;
 const now=()=>current?(nativeRead?'2026-10-20T12:00:33.000Z':AT):new Date(Date.parse(AT)+tick++).toISOString(),base=a29LiveFetcher(MINT,AT);
 const fetcher:typeof fetch=async(input,init)=>{
  const url=String(input);
  if(url.startsWith('https://api.search.tinyfish.ai/'))return json({query:new URL(url).searchParams.get('query'),results:[{url:postUrl},{url:PAGE}],total_results:2,page:0});
  if(current&&['publish.twitter.com','cdn.syndication.twimg.com','api.fxtwitter.com'].includes(new URL(url).host)){
   nativeRead=true;
   if(url.startsWith('https://publish.twitter.com/'))return json({url:postUrl,author_name:'ALPHA',author_url:'https://twitter.com/ALPHA',html:'<blockquote class=twitter-tweet><p>synthetic</p></blockquote>',type:'rich',version:'1.0'});
   if(url.startsWith('https://cdn.syndication.twimg.com/'))return json({__typename:'Tweet',id_str:nativeId,created_at:nativeAt,display_text_range:[0,nativeBody.length],entities:{},text:nativeBody,user:{screen_name:'ALPHA'},edit_control:{edit_tweet_ids:[nativeId],editable_until_msecs:String(Date.parse(nativeAt)+3600000),edits_remaining:'5',is_edit_eligible:true},isEdited:false,isStaleEdit:false});
   return json({code:200,message:'OK',tweet:{url:postUrl,id:nativeId,text:nativeBody,raw_text:{text:nativeBody,display_text_range:[0,Array.from(nativeBody).length],facets:[]},author:{screen_name:'ALPHA',followers:1},created_at:'synthetic',created_timestamp:Date.parse(nativeAt)/1000,is_note_tweet:false,replying_to:null,replying_to_status:null,reposted_by:null}});
  }
  if(url.startsWith('https://api.fetch.tinyfish.ai/'))return json({results:(JSON.parse(String(init?.body)).urls as string[]).map(u=>({url:u,final_url:u,text:u===PAGE?`We are the project team for ${MINT}. This is our project website.`:current?`alpha on X: ${nativeBody} / X`:text,...(u===postUrl?{published_date:current?'2026-10-20T07:00:00.000Z':'2026-10-18T12:00:00.000Z'}:{})})),errors:[]});
  return base(input,init);
 };
 const semanticExecutor:SemanticExecutor=async call=>{
  if(failedSocial&&call.protocol.startsWith('executor-social'))throw Error('constructed social failure');
  const c=JSON.parse(call.packet).canonical,first=c.sources[0],span=(s:any)=>s.spans[0].id,citation={sourceId:first.id,spanId:span(first)};
  const assessment={verdict:'CONTRADICTED',rationale:'This constructed historical sample does not establish current public support.',citations:[citation]};
  let response:unknown;
  if(call.protocol.startsWith('executor-social')){
   if(call.stage==='proposal')response={identityAssessment:assessment,integrityAssessment:assessment,participationAssessment:assessment,communityBreadthAssessment:assessment,posts:c.requiredPostIds.map((id:string)=>{const s=c.sources.find((s:any)=>s.id===id);return{sourceId:id,body:{firstLineId:(current?s.lines.find((l:any)=>l.text===nativeBody):s.lines[0]).id,lastLineId:(current?s.lines.find((l:any)=>l.text===nativeBody):s.lines.at(-1)).id},role:'ORIGINAL',binding:'EXACT_CONTRACT',bindingProof:[],parentSourceId:null,origin:null,community:null,campaign:null,metrics:{likes:null,replies:null,reposts:null}};}),identities:[],accounts:[]};
   else response={decisions:Object.fromEntries(c.requiredDecisionIds.map((id:string)=>[id,{accepted:true,rationale:'The constructed record matches the supplied source.'}])),sources:c.sources.map((s:any)=>({sourceId:s.id,complete:true,rationale:'The complete constructed source was inspected.'})),pairs:Object.fromEntries((c.pairs??[]).map((p:any)=>[p.id,{relation:'DISTINCT_COMMENTARY',rationale:'Distinct constructed commentary.'}]))};
  }else if(call.stage==='proposal')response={sources:c.sources.map((s:any)=>({id:s.id,binding:'EXACT_CONTRACT',event:'OTHER',category:'CRYPTO_CALLER',topic:'OTHER',artifact:'NONE',theme:null,paidDisclosure:'NOT_OBSERVED',incentives:s.url===PAGE?['AFFILIATION']:s.kind==='POST'&&current?['PUBLIC_HOLDINGS']:[],citations:[{sourceId:s.id,spanId:span(s)}],rationale:'Constructed historical project context naming the literal contract.'})),persistence:null};
  else response={sources:c.sources.map((s:any)=>({id:s.id,complete:true,accepted:true})),persistence:false};
  return{response:JSON.stringify(response),executionId:`constructed-empty:${++executions}`,modelId:null,modelIdSource:'UNREPORTED',tools:'NONE',freshSession:true};
 };
 return{fetcher,semanticExecutor,now};
}
async function collect(enabled=true,failedSocial=false){const f=fixture(failedSocial);return collectLiveToken(token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,tinyfishKey:'constructed',...f,...(enabled?{s08PublicIncentives:true}:{})});}
let pending:Promise<Bundle>|undefined;
const live=()=>pending??=collect();

test('explicit62 enumerates accepted PAGE affiliation with observed time and leaves ordinary45 other49 exact',async()=>{
 const b=await live(),p=proofOf(b),d=metric(b).data as any;
 assert.equal(p.method,'advisory-provenance-v62');assert.equal(b.details!.advisory!.method,'advisory-measurements-v61');assert.equal(metric(b).quality,'KNOWN');assert.equal(d.method,'observed-public-source-incentives-v1');
 assert.equal(d.disclosures.length,1);const row=d.disclosures[0];assert.equal(row.sourceKind,'PAGE');assert.equal(row.url,PAGE);assert.deepEqual(row.token,token);assert.deepEqual(row.incentives,['AFFILIATION']);assert.equal(row.publishedAt,null);assert.equal(row.authorId,null);assert.equal(d.hiddenCompensation,null);
 const c=JSON.parse(b.rawArtifacts['advisory-executor-capture']!),source=c.read.sources.find((s:any)=>s.id===row.sourceId);assert.equal(row.observedAt,source.availableAt);assert.ok(row.citations.every((citation:any)=>citation.sourceId===source.id&&source.text.includes(citation.quote)));
 assert.equal(d.currentPostMeasurement.quality,'KNOWN');assert.deepEqual(d.currentPostMeasurement.incentives,[]);
 const old=reconstructAdvisory(b.token,b.cutoff,b.details!.baseline,b.evidence,b.rawArtifacts,{...p,method:'advisory-provenance-v45'},b.thesis??null,b.features);
 assert.equal(old.metrics.find(m=>m.id==='S08')!.quality,'KNOWN');assert.deepEqual((old.metrics.find(m=>m.id==='S08')!.data as any).incentives,[]);assert.deepEqual(old.metrics.filter(m=>m.id!=='S08'),others(b));
 assert.deepEqual(reconstructAdvisory(b.token,b.cutoff,b.details!.baseline,b.evidence,b.rawArtifacts,p,b.thesis??null,b.features),b.details!.advisory);
 const defaultBundle=await collect(false);assert.equal(proofOf(defaultBundle).method,'advisory-provenance-v45');assert.deepEqual(defaultBundle.details!.advisory,old);assert.deepEqual(defaultBundle.features,b.features);assert.deepEqual(defaultBundle.details!.baseline,b.details!.baseline);
 const prior61=reconstructAdvisory(b.token,b.cutoff,b.details!.baseline,b.evidence,b.rawArtifacts,{...p,method:'advisory-provenance-v61'},b.thesis??null,b.features);assert.deepEqual(prior61.metrics.filter(m=>m.id!=='A22'),old.metrics.filter(m=>m.id!=='A22'));
});

test('explicit62 never falls back to narrow KNOWN when broader inventory fails',async()=>{
 const b=await live(),c=JSON.parse(b.rawArtifacts['advisory-executor-capture']!),acquisition=JSON.parse(b.rawArtifacts['advisory-executor-acquisition']!),paid=(metric(b,'A22').data as any).dex;
 const read=structuredClone(c.read);read.identityComplete=false;const source=structuredClone(acquisition),scope=JSON.parse(source.social['social-acquisition-scope']);scope.read.identityComplete=false;source.social['social-acquisition-scope']=JSON.stringify(scope);
 let at=Date.parse(b.cutoff)+1;const f=fixture(),qualified=await qualifyExecutorSemantic(read,token,f.semanticExecutor,()=>new Date(at++).toISOString(),new AbortController().signal,{wire:'v3',bodyBySourceId:c.bodyBySourceId});
 const cutoff=new Date(at).toISOString(),old=deriveExecutorSemanticMetrics(qualified.capture,token,cutoff,['advisory-executor-capture'],paid),current=deriveExecutorSemanticMetrics(qualified.capture,token,cutoff,['advisory-executor-capture'],paid,{method:'public-source-incentives-v1',acquisition:source});
 assert.equal(old.find(m=>m.id==='S08')!.quality,'KNOWN');const m=current.find(m=>m.id==='S08')!;assert.equal(m.quality,'MISSING');assert.equal((m.data as any).disclosures,null);assert.equal((m.data as any).currentPostMeasurement.quality,'KNOWN');assert.deepEqual(current.filter(m=>m.id!=='S08'),old.filter(m=>m.id!=='S08'));
 for(const [label,mutate]of [
  ['whole rejection',(x:any)=>{x.stages.advisoryReview.response=JSON.stringify({...JSON.parse(x.stages.advisoryReview.response),sources:JSON.parse(x.stages.advisoryReview.response).sources.map((s:any)=>({...s,accepted:s.id!==c.read.identitySourceIds[0]}))});x.stages.advisoryReview.receipt.responseSha256=sha(x.stages.advisoryReview.response);}],
 ] as const){const changed=structuredClone(c);mutate(changed);const rows=deriveExecutorSemanticMetrics(JSON.stringify(changed),token,b.cutoff,['advisory-executor-capture'],paid,{method:'public-source-incentives-v1',acquisition});assert.equal(rows.find(m=>m.id==='S08')!.quality,'MISSING',label);assert.equal((rows.find(m=>m.id==='S08')!.data as any).disclosures,null);}
 const missing=deriveExecutorSemanticMetrics(JSON.stringify(c),token,new Date(Date.parse(b.cutoff)+900001).toISOString(),['advisory-executor-capture'],paid,{method:'public-source-incentives-v1',acquisition});assert.equal(missing.find(m=>m.id==='S08')!.quality,'MISSING');
});

test('62 persistence reopens and keyless network-denied replay retains policy59',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'s08-public-source-'));try{const b=await live(),file=join(dir,'live.sqlite');let saved;let s=new Service(file);
  try{saved=s.analyzeLive(b);assert.equal(s.analyzeLive(b).id,saved.id);assert.deepEqual(s.replay(saved.id),saved);}finally{s.close();}
  s=new Service(file);try{assert.deepEqual(s.show(saved.id),saved);assert.deepEqual(s.replay(saved.id),saved);}finally{s.close();}
  const db=new DatabaseSync(file);try{assert.equal(JSON.parse(db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(saved.id)!.semantic as string).policyVersion,'research-screen-advisory-v59');}finally{db.close();}
  let out='',err='',reads=0;assert.equal(await runCli(['replay',saved.id,'--db',file,'--json'],{env:{},isInteractive:false,fetcher:async()=>{reads++;throw Error('NETWORK_DENIED');},stdout:x=>out+=x,stderr:x=>err+=x}),0,err);assert.equal(reads,0);assert.deepEqual(JSON.parse(out),saved);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('normal explicit CLI selects62 with a positive public-source disclosure',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'s08-public-cli-'));try{const f=fixture();let out='',err='';
  assert.equal(await runCli(['analyze',MINT,'--chain','solana','--partial','--advisory','--advisory-executor','--s08-public-incentives','--db',join(dir,'live.sqlite'),'--config',join(dir,'config.json'),'--json'],{env:{TINYFISH_API_KEY:'constructed'},isInteractive:false,...f,stdout:x=>out+=x,stderr:x=>err+=x}),0,err);
  const saved=JSON.parse(out);assert.equal(saved.details.advisory.method,'advisory-measurements-v61');assert.equal(saved.details.advisory.metrics.find((m:any)=>m.id==='S08').data.disclosures.length,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('62 rejects source/capture/proof tampering instead of trusting cached public disclosures',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'s08-public-invalid-'));try{const b=await live(),s=new Service(join(dir,'live.sqlite'));try{
  const mutations:Array<[string,(x:Bundle)=>void]>=[
   ['missing executor',x=>{const p=proofOf(x);p.executorSemantic=null;stamp(x,p);}],
   ['missing bodies',x=>{const p=proofOf(x);delete p.executorSemantic.bodyCaptureId;stamp(x,p);}],
   ['special descriptor',x=>{const p=proofOf(x);p.a29={requests:{},artifactIds:{},label:'forbidden'};stamp(x,p);}],
   ['cached publication',x=>{(metric(x).data as any).disclosures[0].publishedAt=AT;}],
   ['cached author',x=>{(metric(x).data as any).disclosures[0].authorId='invented';}],
   ['cached fee',x=>{(metric(x).data as any).disclosures[0].incentives=['CREATOR_FEE'];}],
   ['source metadata',x=>{const id=proofOf(x).executorSemantic.sourceIds[0];x.evidence.find(e=>e.id===id)!.scope.publishedAt=AT;}],
   ['source body',x=>{const id=proofOf(x).executorSemantic.sourceIds[0];x.rawArtifacts[id]+=' altered';}],
  ];for(const[label,mutate]of mutations){const x=structuredClone(b);mutate(x);assert.throws(()=>s.analyzeLive(x),Error,label);}
 }finally{s.close();}}finally{rmSync(dir,{recursive:true,force:true});}
});

test('public incentive modes reject competing profiles before reads',async()=>{
 for(const flags of [[],['--advisory-executor'],['--advisory','--advisory-executor','--o28-expanded'],['--advisory','--advisory-executor','--a22-empty-current-posts'],['--advisory','--advisory-executor','--a30-fx-capture','missing'],['--advisory','--advisory-executor','--full']]){
  let reads=0,err='';const dir=mkdtempSync(join(tmpdir(),'s08-public-mode-'));try{const code=await runCli(['analyze',MINT,'--chain','solana','--partial','--s08-public-incentives',...flags,'--db',join(dir,'live.sqlite'),'--config',join(dir,'config.json'),'--json'],{env:{},isInteractive:false,fetcher:async()=>{reads++;throw Error('NO_READ');},stdout:()=>{},stderr:x=>err+=x});assert.notEqual(code,0);assert.equal(reads,0);assert.match(err,/S08_PUBLIC_INCENTIVES_REQUIRED|ANALYSIS_MODES_CONFLICT/);}finally{rmSync(dir,{recursive:true,force:true});}
 }
 await assert.rejects(collectLiveToken(token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,s08PublicIncentives:true,fetcher:async()=>{throw Error('NO_READ');}}),/S08_PUBLIC_INCENTIVES_REQUIRED/);
});

test('62 current POST expansion preserves refined clocks and PAGE disclosure through real collection/body replay and CLI',async()=>{
 const f=fixture(false,true),b=await collectLiveToken(token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,tinyfishKey:'constructed',s08PublicIncentives:true,...f}),p=proofOf(b),d=metric(b).data as any;
 const bodyRaw=b.rawArtifacts[p.executorSemantic.bodyCaptureId]!,bodies=decodeExecutorSocialBodies(bodyRaw,token,b.cutoff),original=bodies.originalRead.sources.find(s=>s.kind==='POST')!,expanded=bodies.read.sources.find(s=>s.id===original.id)!;
 assert.equal(original.publishedAt,'2026-10-20T07:00:00.000Z');assert.equal(original.availableAt,AT);assert.equal(expanded.publishedAt,'2026-10-20T07:00:37.000Z');assert.equal(expanded.availableAt,'2026-10-20T12:00:33.000Z');assert.notEqual(expanded.text,original.text);assert.ok(expanded.text.includes('[[PROVIDER_TRUST'));
 assert.equal(metric(b).quality,'KNOWN');assert.equal(d.primarySourceAcquisition.complete,true);assert.equal(d.currentPostMeasurement.quality,'KNOWN');assert.equal(d.currentPostMeasurement.incentives.length,1);
 const post=d.disclosures.find((r:any)=>r.sourceKind==='POST'),page=d.disclosures.find((r:any)=>r.url===PAGE);assert.deepEqual(post.incentives,['PUBLIC_HOLDINGS']);assert.equal(post.publishedAt,expanded.publishedAt);assert.equal(post.observedAt,expanded.availableAt);assert.equal(page.publishedAt,null);assert.equal(page.authorId,null);assert.equal(page.observedAt,AT);assert.deepEqual(page.incentives,['AFFILIATION']);
 const acquisition=JSON.parse(b.rawArtifacts[p.executorSemantic.acquisitionId]!),scope=JSON.parse(acquisition.social['social-acquisition-scope']);assert.deepEqual(scope.read.sources.find((s:any)=>s.id===original.id),original,'primary acquisition retains the original coarse publication and rendered body');
 const raw=b.rawArtifacts[p.executorSemantic.captureId]!,paid=(metric(b,'A22').data as any).dex;
 const missingContext=deriveExecutorSemanticMetrics(raw,token,b.cutoff,['advisory-executor-capture'],paid,{method:'public-source-incentives-v1',acquisition});assert.equal(missingContext.find(m=>m.id==='S08')!.quality,'MISSING');
 const old=reconstructAdvisory(b.token,b.cutoff,b.details!.baseline,b.evidence,b.rawArtifacts,{...p,method:'advisory-provenance-v45'},b.thesis??null,b.features);assert.deepEqual(old.metrics.filter(m=>m.id!=='S08'),others(b));assert.deepEqual(reconstructAdvisory(b.token,b.cutoff,b.details!.baseline,b.evidence,b.rawArtifacts,p,b.thesis??null,b.features),b.details!.advisory);
 const dir=mkdtempSync(join(tmpdir(),'s08-current-expanded-'));try{
  const service=new Service(join(dir,'tamper.sqlite'));try{
   for(const [label,mutate]of [
    ['expanded metadata',(x:Bundle)=>{const id=p.executorSemantic.sourceIds.find((id:string)=>x.evidence.find(e=>e.id===id)!.scope.kind==='POST');x.evidence.find(e=>e.id===id)!.scope.publishedAt=original.publishedAt;}],
    ['expanded body',(x:Bundle)=>{const id=p.executorSemantic.sourceIds.find((id:string)=>x.evidence.find(e=>e.id===id)!.scope.kind==='POST');x.rawArtifacts[id]+=' altered';}],
    ['body original metadata',(x:Bundle)=>{const id=p.executorSemantic.bodyCaptureId;const altered=JSON.parse(x.rawArtifacts[id]!);altered.original.sources[0].availableAt=expanded.availableAt;x.rawArtifacts[id]=JSON.stringify(altered);x.evidence.find(e=>e.id===id)!.contentHash=sha(x.rawArtifacts[id]!);}],
   ] as Array<[string,(x:Bundle)=>void]>){const x=structuredClone(b);mutate(x);assert.throws(()=>service.analyzeLive(x),Error,label);}
  }finally{service.close();}
  const cli=fixture(false,true);let out='',err='';assert.equal(await runCli(['analyze',MINT,'--chain','solana','--partial','--advisory','--advisory-executor','--s08-public-incentives','--db',join(dir,'cli.sqlite'),'--config',join(dir,'config.json'),'--json'],{env:{TINYFISH_API_KEY:'constructed'},isInteractive:false,...cli,stdout:x=>out+=x,stderr:x=>err+=x}),0,err);
  const saved=JSON.parse(out),row=saved.details.advisory.metrics.find((m:any)=>m.id==='S08');assert.equal(row.quality,'KNOWN');assert.equal(row.data.disclosures.find((r:any)=>r.sourceKind==='POST').observedAt,expanded.availableAt);assert.equal(row.data.disclosures.find((r:any)=>r.url===PAGE).publishedAt,null);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
