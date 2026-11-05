import {assertEntryCliSnapshot} from './entry-cli-snapshot.js';
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
import {deriveExecutorSemanticMetrics,type SemanticExecutor} from '../src/providers/executor-semantic.js';
import {a29LiveFetcher} from './a29-fixtures.js';

// Constructed offline transport and model answers. No model/network observation is claimed.
const MINT='3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump',token={chain:'solana' as const,address:MINT};
const AT='2026-10-20T12:00:00.000Z',POST='https://x.com/alpha/status/12345',PAGE='https://project.example/';
const text=`A historical crypto project announcement naming ${MINT}.`;
const json=(value:unknown)=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
type Bundle=Awaited<ReturnType<typeof collectLiveToken>>;
const proofOf=(b:Bundle)=>JSON.parse(b.rawArtifacts['advisory-derivation']!);
const metric=(b:Bundle,id='A22')=>b.details!.advisory!.metrics.find(m=>m.id===id)!;
const others=(b:Bundle)=>b.details!.advisory!.metrics.filter(m=>m.id!=='A22');
const stamp=(b:Bundle,p:unknown)=>{const raw=JSON.stringify(p);b.rawArtifacts['advisory-derivation']=raw;b.evidence.find(e=>e.id==='advisory-derivation')!.contentHash=sha(raw);};
function fixture(failedSocial=false){
 let tick=0,executions=0;
 const now=()=>new Date(Date.parse(AT)+tick++).toISOString(),base=a29LiveFetcher(MINT,AT);
 const fetcher:typeof fetch=async(input,init)=>{
  const url=String(input);
  if(url.startsWith('https://api.search.tinyfish.ai/'))return json({query:new URL(url).searchParams.get('query'),results:[{url:POST},{url:PAGE}],total_results:2,page:0});
  if(url.startsWith('https://api.fetch.tinyfish.ai/'))return json({results:(JSON.parse(String(init?.body)).urls as string[]).map(u=>({url:u,final_url:u,text,...(u===POST?{published_date:'2026-10-18T12:00:00.000Z'}:{})})),errors:[]});
  return base(input,init);
 };
 const semanticExecutor:SemanticExecutor=async call=>{
  if(failedSocial&&call.protocol.startsWith('executor-social'))throw Error('constructed social failure');
  const c=JSON.parse(call.packet).canonical,first=c.sources[0],span=(s:any)=>s.spans[0].id,citation={sourceId:first.id,spanId:span(first)};
  const assessment={verdict:'CONTRADICTED',rationale:'This constructed historical sample does not establish current public support.',citations:[citation]};
  let response:unknown;
  if(call.protocol.startsWith('executor-social')){
   if(call.stage==='proposal')response={identityAssessment:assessment,integrityAssessment:assessment,participationAssessment:assessment,communityBreadthAssessment:assessment,posts:c.requiredPostIds.map((id:string)=>{const s=c.sources.find((s:any)=>s.id===id);return{sourceId:id,body:{firstLineId:s.lines[0].id,lastLineId:s.lines.at(-1).id},role:'ORIGINAL',binding:'EXACT_CONTRACT',bindingProof:[],parentSourceId:null,origin:null,community:null,campaign:null,metrics:{likes:null,replies:null,reposts:null}};}),identities:[],accounts:[]};
   else response={decisions:Object.fromEntries(c.requiredDecisionIds.map((id:string)=>[id,{accepted:true,rationale:'The constructed record matches the supplied source.'}])),sources:c.sources.map((s:any)=>({sourceId:s.id,complete:true,rationale:'The complete constructed source was inspected.'})),pairs:Object.fromEntries((c.pairs??[]).map((p:any)=>[p.id,{relation:'DISTINCT_COMMENTARY',rationale:'Distinct constructed commentary.'}]))};
  }else if(call.stage==='proposal')response={sources:c.sources.map((s:any)=>({id:s.id,binding:'EXACT_CONTRACT',event:'OTHER',category:'CRYPTO_CALLER',topic:'OTHER',artifact:'NONE',theme:null,paidDisclosure:'NOT_OBSERVED',incentives:[],citations:[{sourceId:s.id,spanId:span(s)}],rationale:'Constructed historical project context naming the literal contract.'})),persistence:null};
  else response={sources:c.sources.map((s:any)=>({id:s.id,complete:true,accepted:s.kind!=='PAGE'})),persistence:false};
  return{response:JSON.stringify(response),executionId:`constructed-empty:${++executions}`,modelId:null,modelIdSource:'UNREPORTED',tools:'NONE',freshSession:true};
 };
 return{fetcher,semanticExecutor,now};
}
async function collect(enabled=true,failedSocial=false){const f=fixture(failedSocial);return collectLiveToken(token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,tinyfishKey:'constructed',...f,...(enabled?{a22EmptyCurrentPosts:true}:{})});}
let pending:Promise<Bundle>|undefined;
const live=()=>pending??=collect();

test('explicit61 identifies only empty current A22 and preserves rejected website and ordinary45 other49',async()=>{
 const b=await live(),p=proofOf(b),d=metric(b).data as any;
 assert.equal(p.method,'advisory-provenance-v61');assert.equal(b.details!.advisory!.method,'advisory-measurements-v60');
 assert.equal(metric(b).quality,'KNOWN');assert.equal(d.method,'advisory-empty-current-posts-v1');assert.deepEqual(d.disclosedPosts,[]);assert.equal(d.hiddenPayments,null);assert.equal(d.underlyingAdvisoryCorpusAccepted,false);
 const capture=JSON.parse(b.rawArtifacts['advisory-executor-capture']!),review=JSON.parse(capture.stages.advisoryReview.response);
 assert.ok(review.sources.some((s:any)=>s.accepted===false));assert.equal(capture.read.sources.filter((s:any)=>s.kind==='POST').length,1);
 const oldProof={...p,method:'advisory-provenance-v45'},old=reconstructAdvisory(b.token,b.cutoff,b.details!.baseline,b.evidence,b.rawArtifacts,oldProof,b.thesis??null,b.features);
 assert.equal(old.metrics.find(m=>m.id==='A22')!.quality,'MISSING');assert.deepEqual(old.metrics.filter(m=>m.id!=='A22'),others(b));
 assert.deepEqual(reconstructAdvisory(b.token,b.cutoff,b.details!.baseline,b.evidence,b.rawArtifacts,p,b.thesis??null,b.features),b.details!.advisory);
 const defaultBundle=await collect(false);assert.equal(proofOf(defaultBundle).method,'advisory-provenance-v45');assert.deepEqual(defaultBundle.details!.advisory,old);assert.deepEqual(defaultBundle.features,b.features);assert.deepEqual(defaultBundle.details!.baseline,b.details!.baseline);
});

test('61 keeps failed SOCIAL and invalid paid evidence missing rather than accepting cached zero',async()=>{
 const failed=await collect(true,true);assert.notEqual(metric(failed).quality,'KNOWN');
 const b=await live(),raw=b.rawArtifacts['advisory-executor-capture']!,acquisition=JSON.parse(b.rawArtifacts['advisory-executor-acquisition']!),paid=(metric(b).data as any).dex;
 const call=(value:any,at=b.cutoff,source=acquisition)=>deriveExecutorSemanticMetrics(raw,token,at,['advisory-executor-capture'],value,{method:'empty-current-posts-v1',acquisition:source});
 const a22=(rows:ReturnType<typeof call>)=>rows.find(m=>m.id==='A22')!;
 for(const value of [null,{...paid,quality:'MISSING'},{...paid,token:{...token,address:'foreign'}},{...paid,availableAt:new Date(Date.parse(b.cutoff)+1).toISOString()},{...paid,availableAt:new Date(Date.parse(b.cutoff)-900001).toISOString()}])assert.notEqual(a22(call(value)).quality,'KNOWN');
 assert.notEqual(a22(call(paid,new Date(Date.parse(b.cutoff)+900001).toISOString())).quality,'KNOWN');
 assert.notEqual(a22(call(paid,b.cutoff,{})).quality,'KNOWN');
 const altered=structuredClone(acquisition),scope=JSON.parse(altered.social['social-acquisition-scope']);scope.read.targetPostIds=[];altered.social['social-acquisition-scope']=JSON.stringify(scope);assert.notEqual(a22(call(paid,b.cutoff,altered)).quality,'KNOWN');
 assert.equal(deriveExecutorSemanticMetrics(raw,token,b.cutoff,['advisory-executor-capture'],paid).find(m=>m.id==='A22')!.quality,'MISSING');
});

test('61 persists, reopens, replays keylessly and records policy58',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'a22-empty-current-'));try{
  const b=await live(),file=join(dir,'live.sqlite');let saved;let s=new Service(file);
  try{saved=s.analyzeLive(b);assert.equal(s.analyzeLive(b).id,saved.id);assert.deepEqual(s.replay(saved.id),saved);}finally{s.close();}
  s=new Service(file);try{assert.deepEqual(s.show(saved.id),saved);assert.deepEqual(s.replay(saved.id),saved);}finally{s.close();}
  const db=new DatabaseSync(file);try{assert.equal(JSON.parse(db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(saved.id)!.semantic as string).policyVersion,'research-screen-advisory-v58');}finally{db.close();}
  let out='',err='',reads=0;assert.equal(await runCli(['replay',saved.id,'--db',file,'--json'],{env:{},isInteractive:false,fetcher:async()=>{reads++;throw Error('NETWORK_DENIED');},stdout:x=>out+=x,stderr:x=>err+=x}),0,err);assert.equal(reads,0);assertEntryCliSnapshot(JSON.parse(out),saved);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('normal explicit CLI selects61 and persists a reconstructed empty-current A22',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'a22-empty-cli-'));try{
  const f=fixture();let out='',err='';
  assert.equal(await runCli(['analyze',MINT,'--chain','solana','--partial','--advisory','--advisory-executor','--a22-empty-current-posts','--db',join(dir,'live.sqlite'),'--config',join(dir,'config.json'),'--json'],{env:{TINYFISH_API_KEY:'constructed'},isInteractive:false,...f,stdout:x=>out+=x,stderr:x=>err+=x}),0,err);
  const saved=JSON.parse(out);assert.equal(saved.details.advisory.method,'advisory-measurements-v60');assert.equal(saved.details.advisory.metrics.find((m:any)=>m.id==='A22').quality,'KNOWN');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('61 rejects missing executor/body, special descriptors and cached metric mutations',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'a22-empty-invalid-'));try{const b=await live(),s=new Service(join(dir,'live.sqlite'));try{
  const mutations:Array<[string,(x:Bundle)=>void]>=[
   ['missing executor',x=>{const p=proofOf(x);p.executorSemantic=null;stamp(x,p);}],
   ['missing bodies',x=>{const p=proofOf(x);delete p.executorSemantic.bodyCaptureId;stamp(x,p);}],
   ['special import',x=>{const p=proofOf(x);p.a29={requests:{},artifactIds:{},label:'forbidden'};stamp(x,p);}],
   ['cached disclosure',x=>{(metric(x).data as any).disclosedPosts=['invented'];}],
   ['source date',x=>{const id=proofOf(x).executorSemantic.sourceIds[0];x.evidence.find(e=>e.id===id)!.scope.publishedAt=AT;}],
   ['source body',x=>{const id=proofOf(x).executorSemantic.sourceIds[0];x.rawArtifacts[id]+=' altered';}],
  ];
  for(const[label,mutate]of mutations){const x=structuredClone(b);mutate(x);assert.throws(()=>s.analyzeLive(x),Error,label);}
 }finally{s.close();}}finally{rmSync(dir,{recursive:true,force:true});}
});

test('CLI and direct live validation reject incompatible empty-current modes before reads',async()=>{
 for(const flags of [[],['--advisory-executor'],['--advisory','--advisory-executor','--o28-expanded'],['--advisory','--advisory-executor','--a30-fx-capture','missing'],['--advisory','--advisory-executor','--full']]){
  let reads=0,err='';const dir=mkdtempSync(join(tmpdir(),'a22-empty-mode-'));try{const code=await runCli(['analyze',MINT,'--chain','solana','--partial','--a22-empty-current-posts',...flags,'--db',join(dir,'live.sqlite'),'--config',join(dir,'config.json'),'--json'],{env:{},isInteractive:false,fetcher:async()=>{reads++;throw Error('NO_READ');},stdout:()=>{},stderr:x=>err+=x});assert.notEqual(code,0);assert.equal(reads,0);assert.match(err,/A22_EMPTY_CURRENT_POSTS_REQUIRED|ANALYSIS_MODES_CONFLICT|FULL.*PARTIAL|PARTIAL.*FULL/);}finally{rmSync(dir,{recursive:true,force:true});}
 }
 await assert.rejects(collectLiveToken(token,{profile:starterProfile(),semanticEnabled:false,advisoryEnabled:true,a22EmptyCurrentPosts:true,fetcher:async()=>{throw Error('NO_READ');}}),/A22_EMPTY_CURRENT_POSTS_REQUIRED/);
});
